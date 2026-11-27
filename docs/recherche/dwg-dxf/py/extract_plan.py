"""Pragmatic floor-plan extractor for architects' DXF files (ezdxf + shapely).

Pipeline
  1. load (ezdxf.readfile, fallback ezdxf.recover)                      -> model space only
  2. layer auto-mapping (FR / DE / EN / AIA name heuristics, xref prefixes stripped; content-based fallback for walls)
  3. unit detection (header $INSUNITS cross-checked with door-swing radii, text hints, later with stated room areas)
  4. wall linework -> endpoint clustering -> free-end closing (missing jambs) -> noding -> polygonize => wall solids
  5. jamb pairing: two facing wall ends of equal thickness = an opening -> bridge quads
  6. union(wall solids + bridges): exterior ring = building outline, holes = rooms
  7. labels (TEXT / MTEXT / ATTRIB) -> room names + stated areas; openings classified with door/window layers + inserts
  8. north arrow -> facade orientation of each exterior opening and each outline edge; heated gross outline

usage: python -I extract_plan.py file.dxf [--json out.json] [--png out.png] [--wall-layer NAME ...] [--units-per-m N] [-q]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict

import ezdxf
import numpy as np
import shapely
from ezdxf import path as ezpath
from ezdxf import recover
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import polygonize_full, unary_union
from shapely.strtree import STRtree

# ----------------------------------------------------------------------------------------------------------------------
# 2. layer mapping
# ----------------------------------------------------------------------------------------------------------------------
B, E = r"(?<![a-z])", r"(?![a-z])"
LAYER_RULES = [  # first match wins
    ("hatch", B + r"(hach\w*|hatch\w*|schraff\w*|patt|poche|rempl\w*|fuell\w*|fill)" + E),
    ("dim", B + r"(cot|cote|cotes|cotation\w*|dim|dims|dimension\w*|bemass\w*|bemas\w*|masskette\w*|masse|mass)" + E),
    ("frame", B + r"(cartouche|cadre|ttlb|title\w*|plankopf|rahmen|border|blatt|sheet|viewport|view port|defpoints)" + E),
    ("foundation", B + r"(stem|found\w*|fondation\w*|footer\w*|footing\w*|fundament\w*|semelle\w*|slab|dalle)" + E),
    ("roof", B + r"(roof\w*|toit\w*|toiture|dach\w*|truss|overhang|charpente|joist\w*|beam\w*|header)" + E),
    ("stair", B + r"(escal\w*|stair\w*|strs|trepp\w*)" + E),
    ("axis", B + r"(axe|axes|axis|achs\w*|grid|raster|trame)" + E),
    ("furniture", B + r"(mobil\w*|meubl\w*|furn\w*|moeb\w*|mobel\w*|sanit\w*|equip\w*|fixt\w*|fixture\w*|case|casework|appareil\w*|einricht\w*)" + E),
    ("door", B + r"(porte|portes|door|doors|tuer|tueren|tur|ture|turen)" + E),
    ("window", B + r"(fen|fenetre\w*|fenster\w*|window\w*|wind|glaz\w*|vitr\w*|baie\w*|chassis|menuis\w*|opening\w*|ouverture\w*|oeffnung\w*)" + E),
    ("wall", B + r"(mur|murs|wall|walls|wand|wande|waende|mauer\w*|maconn\w*|voile|voiles|paroi\w*|cloison\w*|trennwand\w*|aussenwand\w*|innenwand\w*|rohbau|gros ?oeuvre|porteur\w*)" + E),
    ("text", B + r"(texte?s?|txt|text\w*|room\w*|raum\w*|piece\w*|local|locaux|iden|area\w*|surface\w*|flaeche\w*|flache\w*|beschrift\w*|label\w*|nom|noms|note|notes|anno\w*)" + E),
    ("symbol", B + r"(symb\w*|nord|north|legend\w*)" + E),
]
LAYER_RULES = [(c, re.compile(p)) for c, p in LAYER_RULES]


def norm_name(s: str) -> str:
    s = s.split("|")[-1]  # attached xref: "xrefname|layer"
    s = re.sub(r"^.*\$\d+\$", "", s)  # bound xref: "xrefname$0$layer"
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[_\-./]+", " ", s)


def classify_layer(name: str):
    n = norm_name(name)
    for cat, rx in LAYER_RULES:
        if rx.search(n):
            return cat
    return None


# ----------------------------------------------------------------------------------------------------------------------
# text helpers
# ----------------------------------------------------------------------------------------------------------------------
AREA_RE = re.compile(r"(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:m\s?²|m2|m\^2|qm|㎡|m\s?²)", re.I)
IMPERIAL_RE = re.compile(r"\d+\s*'\s*(\d+\s*\"?)?\s*x\s*\d+\s*'")
ROOM_WORDS = ("sejour salon cuisine hall wc buanderie garage chambre bureau bain sdb sde douche degagement couloir cave cellier "
              "grenier combles terrasse balcon entree living wohn kuche kueche diele flur schlaf kinder bad buro buero keller "
              "speicher abstell technik heizung wasch gast ess zimmer room kitchen bath bed dining closet pantry entry util "
              "master porch deck toil clo local chaufferie dressing rangement vestiaire palier treppenhaus").split()
UNHEATED_WORDS = ("garage carport cave keller grenier speicher dachboden terrasse balcon balkon porch deck abri remise loggia "
                  "veranda vide exterieur aussen").split()
FLOOR_RULES = [
    (-1, r"sous.?sol|kellergeschoss|untergeschoss|\bkg\b|\bug\b|basement"),
    (0, r"rez|\brdc\b|erdgeschoss|\beg\b|ground"),
    (1, r"etage|obergeschoss|\bog\b|1er|first floor|upper"),
    (9, r"combles|dachgeschoss|\bdg\b|attic"),
]


def strip_accents(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def has_word(text, words):
    """True if any token of text STARTS with one of the keywords ('esszimmer' matches 'ess', 'access' does not)"""
    toks = re.findall(r"[a-z]+", strip_accents(text))
    return any(t.startswith(w) for t in toks for w in words)


# ----------------------------------------------------------------------------------------------------------------------
# 1. loading + flattening
# ----------------------------------------------------------------------------------------------------------------------
def load(path):
    try:
        return ezdxf.readfile(path), "readfile"
    except Exception as e:  # noqa
        doc, auditor = recover.readfile(path)
        return doc, f"recover ({type(e).__name__}; {len(auditor.errors)} errors)"


def flatten(entities, layer_ctx=None, depth=0, top=None, max_depth=4, inserts=None):
    """yield (entity, effective_layer, top_level_insert). Entities on layer '0' inside a block inherit the INSERT layer.
    Every INSERT met on the way (any nesting depth, already transformed to WCS) is appended to `inserts`."""
    for e in entities:
        t = e.dxftype()
        try:
            layer = e.dxf.layer
        except Exception:
            continue
        if layer == "0" and layer_ctx is not None:
            layer = layer_ctx
        if t == "INSERT":
            if inserts is not None:
                inserts.append((e, layer))
            if depth >= max_depth:
                continue
            try:
                subs = list(e.virtual_entities())
            except Exception:
                continue
            yield from flatten(subs, layer, depth + 1, top if top is not None else e, max_depth, inserts)
        elif t == "MLINE":
            try:
                yield from flatten(list(e.virtual_entities()), layer, depth + 1, top, max_depth, inserts)
            except Exception:
                continue
        else:
            yield e, layer, top


def entity_segments(e, sag):
    """straight 2D segments of a LINE / polyline / arc"""
    t = e.dxftype()
    if t == "LINE":
        a, b = e.dxf.start, e.dxf.end
        return [((a.x, a.y), (b.x, b.y))]
    if t in ("LWPOLYLINE", "POLYLINE", "ARC", "ELLIPSE", "SPLINE", "CIRCLE"):
        try:
            p = ezpath.make_path(e)
            pts = [(v.x, v.y) for v in p.flattening(sag)]
        except Exception:
            return []
        return [(a, b) for a, b in zip(pts[:-1], pts[1:]) if a != b]
    return []


def text_fragment(e):
    t = e.dxftype()
    try:
        if t == "MTEXT":
            s = e.plain_text()
            h = e.dxf.char_height
            p = e.dxf.insert
            lines = s.split("\n")
            w = 0.6 * h * max(len(x) for x in lines) if lines else 0
            hh = 1.6 * h * len(lines)
            ap = e.dxf.get("attachment_point", 1)
            cx = p.x + {1: w / 2, 2: 0, 0: -w / 2}[ap % 3]
            cy = p.y + {0: -hh / 2, 1: 0, 2: hh / 2}[(ap - 1) // 3]
            return s, h, (cx, cy)
        if t in ("TEXT", "ATTRIB"):
            s = e.plain_text()
            h = e.dxf.height
            if e.dxf.get("halign", 0) or e.dxf.get("valign", 0):
                p = e.dxf.get("align_point", e.dxf.insert)
                return s, h, (p.x, p.y)
            p = e.dxf.insert
            rot = math.radians(e.dxf.get("rotation", 0))
            dx = 0.3 * h * len(s)
            return s, h, (p.x + dx * math.cos(rot) - 0.5 * h * math.sin(rot), p.y + dx * math.sin(rot) + 0.5 * h * math.cos(rot))
    except Exception:
        return None
    return None


# ----------------------------------------------------------------------------------------------------------------------
# 4. noding / polygonizing
# ----------------------------------------------------------------------------------------------------------------------
class UF:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, a):
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def cluster_endpoints(segs, tol):
    """merge endpoints closer than tol (fixes tiny gaps / sloppy snaps); returns new segment list"""
    if not segs:
        return []
    pts = np.array([p for s in segs for p in s], dtype=float)
    geoms = shapely.points(pts)
    tree = STRtree(geoms)
    ia, ib = tree.query(geoms, predicate="dwithin", distance=tol)
    uf = UF(len(pts))
    for a, b in zip(ia, ib):
        if a < b:
            uf.union(int(a), int(b))
    roots = np.array([uf.find(i) for i in range(len(pts))])
    sums = defaultdict(lambda: [0.0, 0.0, 0])
    for r, (x, y) in zip(roots, pts):
        s = sums[r]
        s[0] += x; s[1] += y; s[2] += 1
    new = np.array([[sums[r][0] / sums[r][2], sums[r][1] / sums[r][2]] for r in roots])
    out, seen = [], set()
    for i in range(0, len(new), 2):
        a, b = tuple(new[i]), tuple(new[i + 1])
        if a == b:
            continue
        k = (a, b) if a < b else (b, a)
        if k in seen:
            continue
        seen.add(k)
        out.append((a, b))
    return out


def polygonize(segs, tol, grid):
    """extend free ends by tol (heals undershoots), node with a precision grid, polygonize"""
    deg = Counter(p for s in segs for p in s)
    lines = []
    for a, b in segs:
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dy)
        if ln == 0:
            continue
        ux, uy = dx / ln, dy / ln
        if deg[a] == 1:
            a = (a[0] - ux * tol, a[1] - uy * tol)
        if deg[b] == 1:
            b = (b[0] + ux * tol, b[1] + uy * tol)
        lines.append(LineString([a, b]))
    if not lines:
        return [], []
    merged = shapely.unary_union(lines, grid_size=grid)
    polys, dangles, cuts, invalid = polygonize_full(merged)
    dang = [d for d in dangles.geoms if d.length > 3 * tol]
    return list(polys.geoms), dang


def heal_free_ends(segs, tol, max_ext, merge_dist):
    """Gaps larger than the snapping tolerance: (1) a free line end is extended along its own direction (ray cast, at most
    max_ext) until it meets another wall line; (2) two free ends closer than merge_dist are merged. Returns (segs, n_fixed)."""
    if not segs:
        return segs, 0
    deg = Counter(p for s in segs for p in s)
    lines = [LineString(s) for s in segs]
    tree = STRtree(lines)
    free = {}  # point -> (segment index, which end)
    for i, (a, b) in enumerate(segs):
        for k, p in enumerate((a, b)):
            if deg[p] != 1:
                continue
            near = tree.query(Point(p), predicate="dwithin", distance=tol * 0.5)
            if any(j != i for j in near):
                continue  # T junction: the end lies on another line
            free[p] = (i, k)
    if not free:
        return segs, 0
    segs = [list(s) for s in segs]
    fixed = 0
    fpts = list(free)
    ftree = STRtree(shapely.points(np.array(fpts)))
    done = set()
    for p, (i, k) in free.items():
        if p in done:
            continue
        a, b = segs[i]
        o = a if k == 1 else b  # the other end
        dx, dy = p[0] - o[0], p[1] - o[1]
        ln = math.hypot(dx, dy)
        if ln == 0:
            continue
        ux, uy = dx / ln, dy / ln
        ray = LineString([p, (p[0] + ux * max_ext, p[1] + uy * max_ext)])
        best = None
        for j in tree.query(ray, predicate="intersects"):
            if j == i:
                continue
            d = Point(p).distance(ray.intersection(lines[j]))
            if best is None or d < best:
                best = d
        if best is not None:
            segs[i][k] = (p[0] + ux * (best + tol * 0.5), p[1] + uy * (best + tol * 0.5))
            fixed += 1
            done.add(p)
            continue
        for j in ftree.query(Point(p), predicate="dwithin", distance=merge_dist):
            q = fpts[int(j)]
            if q == p or q in done:
                continue
            i2, k2 = free[q]
            o2 = segs[i2][0] if k2 == 1 else segs[i2][1]
            vx, vy = q[0] - o2[0], q[1] - o2[1]
            den = ux * vy - uy * vx
            m = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
            if abs(den) > 0.2 * math.hypot(vx, vy):  # not parallel: rebuild the corner = intersection of both lines
                tpar = ((q[0] - p[0]) * vy - (q[1] - p[1]) * vx) / den
                c = (p[0] + ux * tpar, p[1] + uy * tpar)
                if math.hypot(c[0] - p[0], c[1] - p[1]) <= 2 * merge_dist and math.hypot(c[0] - q[0], c[1] - q[1]) <= 2 * merge_dist:
                    m = c
            segs[i][k] = m
            segs[i2][k2] = m
            done.add(p); done.add(q)
            fixed += 1
            break
    return [tuple(s) for s in segs], fixed


def close_free_ends(segs, dangles, tmin, tmax, tol):
    """walls drawn WITHOUT jamb lines: connect two free ends of parallel lines that stop at the same place (distance = wall
    thickness, connection perpendicular to both lines). Returns extra segments."""
    ends = []  # (point, outward unit direction)
    node_deg = Counter(p for s in segs for p in s)
    for a, b in segs:
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dy)
        if ln < tol:
            continue
        if node_deg[a] == 1:
            ends.append((a, (-dx / ln, -dy / ln)))
        if node_deg[b] == 1:
            ends.append((b, (dx / ln, dy / ln)))
    if len(ends) < 2:
        return []
    # an end is only "free" if it does not touch another segment's interior (T junction)
    seg_lines = [LineString(s) for s in segs]
    tree = STRtree(seg_lines)
    free = []
    for p, d in ends:
        pt = Point(p)
        near = tree.query(pt, predicate="dwithin", distance=tol)
        touching = sum(1 for i in near if p not in segs[i])
        if touching == 0:
            free.append((p, d))
    if len(free) < 2:
        return []
    pts = shapely.points(np.array([p for p, _ in free]))
    ptree = STRtree(pts)
    ia, ib = ptree.query(pts, predicate="dwithin", distance=tmax)
    best = {}
    for a, b in zip(ia, ib):
        if a >= b:
            continue
        (p, dp), (q, dq) = free[a], free[b]
        vx, vy = q[0] - p[0], q[1] - p[1]
        dist = math.hypot(vx, vy)
        if dist < tmin:
            continue
        if dp[0] * dq[0] + dp[1] * dq[1] < 0.98:  # both lines must run in the same direction
            continue
        if abs(vx * dp[0] + vy * dp[1]) > max(tol, 0.03 * dist):  # connection must be perpendicular
            continue
        for i, j in ((a, b), (b, a)):
            if i not in best or dist < best[i][0]:
                best[i] = (dist, j)
    extra = []
    for i, (dist, j) in best.items():
        if i < j and best.get(j, (None, None))[1] == i:
            extra.append((free[i][0], free[j][0]))
    return extra


# ----------------------------------------------------------------------------------------------------------------------
# 5. jamb pairing
# ----------------------------------------------------------------------------------------------------------------------
def jamb_edges(W, jmin, jmax):
    """short edges of the wall solids with convex corners at both ends = wall ends (jambs)"""
    out = []
    polys = list(W.geoms) if isinstance(W, MultiPolygon) else [W]
    for poly in polys:
        poly = orient(poly, 1.0)
        for ring in [poly.exterior, *poly.interiors]:
            c = list(ring.coords)[:-1]
            n = len(c)
            if n < 4:
                continue
            for i in range(n):
                p0, p1, p2, p3 = c[i - 1], c[i], c[(i + 1) % n], c[(i + 2) % n]
                ex, ey = p2[0] - p1[0], p2[1] - p1[1]
                ln = math.hypot(ex, ey)
                if not (jmin <= ln <= jmax):
                    continue
                c1 = (p1[0] - p0[0]) * ey - (p1[1] - p0[1]) * ex  # turn at p1
                c2 = ex * (p3[1] - p2[1]) - ey * (p3[0] - p2[0])  # turn at p2
                if c1 <= 0 or c2 <= 0:  # material is on the left: both turns must be left turns
                    continue
                nx, ny = ey / ln, -ex / ln  # outward normal (right of travel direction)
                out.append({"a": p1, "b": p2, "len": ln, "mid": ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2), "n": (nx, ny)})
    return out


def pair_jambs(jambs, W, gmin, gmax, tol):
    if len(jambs) < 2:
        return [], list(range(len(jambs)))
    mids = shapely.points(np.array([j["mid"] for j in jambs]))
    tree = STRtree(mids)
    ia, ib = tree.query(mids, predicate="dwithin", distance=gmax + tol)
    cand = defaultdict(list)
    shapely.prepare(W)
    for a, b in zip(ia, ib):
        if a == b:
            continue
        ja, jb = jambs[a], jambs[b]
        if ja["n"][0] * jb["n"][0] + ja["n"][1] * jb["n"][1] > -0.95:
            continue
        if abs(ja["len"] - jb["len"]) > max(4 * tol, 0.10 * ja["len"]):
            continue
        vx, vy = jb["mid"][0] - ja["mid"][0], jb["mid"][1] - ja["mid"][1]
        along = vx * ja["n"][0] + vy * ja["n"][1]
        lateral = abs(vx * ja["n"][1] - vy * ja["n"][0])
        if not (gmin <= along <= gmax) or lateral > 4 * tol:
            continue
        cand[a].append((along, int(b)))
    pairs, used = [], set()
    for a in sorted(cand):
        cand[a].sort()
    for a in sorted(cand):
        if a in used:
            continue
        for along, b in cand[a]:
            if b in used:
                continue
            if not cand[b] or cand[b][0][1] != a:
                # allow if a is among b's candidates and b's nearer candidates are used
                nearer = [x for x in cand[b] if x[1] not in used]
                if not nearer or nearer[0][1] != a:
                    continue
            ja, jb = jambs[a], jambs[b]
            quad = Polygon([ja["a"], ja["b"], jb["a"], jb["b"]])
            if not quad.is_valid:
                quad = Polygon([ja["a"], ja["b"], jb["b"], jb["a"]])
            if not quad.is_valid or quad.area <= 0:
                continue
            if W.intersection(quad.buffer(-tol)).area > 0.02 * quad.area:
                continue
            pairs.append({"quad": quad, "width": along, "thick": (ja["len"] + jb["len"]) / 2,
                          "centre": ((ja["mid"][0] + jb["mid"][0]) / 2, (ja["mid"][1] + jb["mid"][1]) / 2),
                          "dir": ja["n"]})
            used.add(a); used.add(b)
            break
    free = [i for i in range(len(jambs)) if i not in used]
    return pairs, free


# ----------------------------------------------------------------------------------------------------------------------
# main analysis
# ----------------------------------------------------------------------------------------------------------------------
UNIT_NAMES = {1000: "mm", 100: "cm", 1: "m", 39.3701: "inch", 3.28084: "foot"}
INSUNITS = {1: 39.3701, 2: 3.28084, 4: 1000, 5: 100, 6: 1}
SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def sector(az):
    return SECTORS[int(((az + 22.5) % 360) // 45)]


def analyse(path, wall_layers=None, units_per_m=None, verbose=True, _rerun=False):
    t0 = time.perf_counter()
    res = {"file": path, "warnings": [], "timing_ms": {}}
    warn = res["warnings"].append
    doc, mode = load(path)
    msp = doc.modelspace()
    res["load"] = {"mode": mode, "dxf_version": doc.dxfversion, "modelspace_entities": len(msp),
                   "layouts": doc.layout_names(), "xrefs": [b.name for b in doc.blocks if b.block is not None and (b.block.dxf.get("flags", 0) & 4)]}
    if res["load"]["xrefs"]:
        warn(f"drawing references external files (xrefs) that are NOT in this file: {res['load']['xrefs']}")
    res["timing_ms"]["load"] = round((time.perf_counter() - t0) * 1000)

    # ---- flatten once
    t1 = time.perf_counter()
    all_inserts = []
    flat = list(flatten(msp, inserts=all_inserts))
    per_layer = defaultdict(Counter)
    for e, layer, top in flat:
        per_layer[layer][e.dxftype()] += 1
    top_inserts = [e for e, _l in all_inserts]
    insert_layer = {id(e): l for e, l in all_inserts}
    for ins, l in all_inserts:
        per_layer[l]["INSERT"] += 1
    res["timing_ms"]["flatten"] = round((time.perf_counter() - t1) * 1000)

    # ---- layer mapping
    cats = defaultdict(list)
    for name in per_layer:
        c = classify_layer(name)
        if c:
            cats[c].append(name)
    layer_source = "name heuristics"
    if wall_layers:
        cats["wall"] = list(wall_layers)
        layer_source = "user supplied wall layer"

    # ---- units (provisional)
    evidence = []
    hdr = doc.header.get("$INSUNITS", 0)
    if hdr in INSUNITS:
        evidence.append(("header $INSUNITS=%d" % hdr, INSUNITS[hdr]))
    # door swings: radius of ARCs with ~90 deg sweep (on door layers if known, else anywhere)
    radii = []
    door_layers = set(cats.get("door", []))
    for e, layer, top in flat:
        if e.dxftype() == "ARC" and (not door_layers or layer in door_layers or layer in cats.get("window", [])):
            sweep = (e.dxf.end_angle - e.dxf.start_angle) % 360
            if 80 <= sweep <= 100:
                radii.append(e.dxf.radius)
    if len(radii) >= 2:
        r = float(np.median(radii))
        for upm, lo, hi in ((1000, 550, 1150), (100, 55, 115), (1, 0.55, 1.15), (39.3701, 22, 42), (3.28084, 1.9, 3.5)):
            if lo <= r <= hi:
                evidence.append((f"median door-swing radius {r:.4g} (n={len(radii)}) ~ 0.6-1.1 m door", upm))
    texts_raw = []
    for e, layer, top in flat:
        if e.dxftype() in ("TEXT", "MTEXT"):
            f = text_fragment(e)
            if f and f[0].strip():
                texts_raw.append((f[0].strip(), f[1], f[2], layer))
    for ins in top_inserts:
        for a in getattr(ins, "attribs", []):
            f = text_fragment(a)
            if f and f[0].strip() and not a.is_invisible:
                texts_raw.append((f[0].strip(), f[1], f[2], insert_layer[id(ins)]))
    n_imp = sum(1 for s, *_ in texts_raw if IMPERIAL_RE.search(s))
    if n_imp >= 3:
        evidence.append((f"{n_imp} texts in feet-inch notation (e.g. 13'8 x 14')", 39.3701))
    if units_per_m is None:
        votes = Counter()
        for why, upm in evidence:
            votes[upm] += 2 if why.startswith(("median", "stated")) or "feet-inch" in why else 1
        if votes:
            units_per_m = votes.most_common(1)[0][0]
            if len(votes) > 1:
                warn(f"unit evidence is contradictory: {evidence} -> using {UNIT_NAMES.get(units_per_m, units_per_m)}")
        else:
            units_per_m = 100
            warn("no unit information at all ($INSUNITS=0, no door swings): assumed centimetres - the user must confirm")
    u = units_per_m
    res["units"] = {"header_insunits": hdr, "units_per_m": u, "unit": UNIT_NAMES.get(u, str(u)), "evidence": evidence,
                    "measurement": doc.header.get("$MEASUREMENT")}

    tol = 0.01 * u  # 1 cm snapping tolerance
    grid = 0.0005 * u  # 0.5 mm precision grid

    # ---- wall layer fallback: content based (parallel line pairs at wall-thickness distance)
    if not cats.get("wall"):
        scores = []
        for name, cnt in per_layer.items():
            if cnt["LINE"] + cnt["LWPOLYLINE"] < 8 or classify_layer(name) in ("dim", "frame", "hatch", "axis", "stair", "furniture", "text"):
                continue
            segs = [s for e, layer, top in flat if layer == name for s in entity_segments(e, 0.01 * u)]
            sc = parallel_pair_score(segs, u)
            scores.append((sc[0], sc[1], name))
        scores.sort(reverse=True)
        res["wall_layer_scores"] = [(round(a / u, 1), round(b, 2), n) for a, b, n in scores[:6]]
        if scores and scores[0][0] > 10 * u and scores[0][1] > 0.4:
            cats["wall"] = [scores[0][2]]
            for a, b, n in scores[1:]:
                if a > 0.5 * scores[0][0] and b > 0.5:
                    cats["wall"].append(n)
            layer_source = "content heuristic (parallel line pairs)"
            warn(f"no layer name looks like a wall layer; guessed {cats['wall']} from parallel double lines - user must confirm")
        else:
            warn("could not identify any wall layer - user must pick it")
    res["layers"] = {"mapping": {k: v for k, v in cats.items()}, "source": layer_source,
                     "unmapped": sorted(n for n in per_layer if classify_layer(n) is None and n not in cats.get("wall", [])),
                     "content": {n: dict(c) for n, c in per_layer.items()}}

    # ---- wall segments
    t2 = time.perf_counter()
    wall_set = set(cats.get("wall", []))
    segs = [s for e, layer, top in flat if layer in wall_set and e.dxftype() != "HATCH" for s in entity_segments(e, 0.01 * u)]
    n_raw = len(segs)
    segs = cluster_endpoints(segs, tol)
    polys, dangles = polygonize(segs, tol, grid)
    # (i) gaps beyond the snapping tolerance
    segs_h, n_healed = heal_free_ends(segs, tol, 0.06 * u, 0.04 * u)
    if n_healed:
        segs_h = cluster_endpoints(segs_h, tol)
        polys_h, dangles_h = polygonize(segs_h, tol, grid)
        if len(polys_h) > len(polys) or len(dangles_h) < len(dangles):
            segs, polys, dangles = segs_h, polys_h, dangles_h
            warn(f"{n_healed} wall line end(s) stopped up to 6 cm short of the next wall line and were extended / merged")
    # (ii) walls drawn without jamb lines + (iii) stray lines on layer "0" whose two ends sit on wall nodes
    def build(seg_list):
        sg = cluster_endpoints(seg_list, tol)
        pl, dg = polygonize(sg, tol, grid)
        ex = close_free_ends(sg, dg, 0.04 * u, 0.70 * u, tol)
        if ex:
            sg2 = cluster_endpoints(sg + ex, tol)
            pl2, dg2 = polygonize(sg2, tol, grid)
            if len(pl2) > len(pl):
                return sg2, pl2, dg2, len(ex)
        return sg, pl, dg, 0

    segs, polys, dangles, n_jambs_added = build(segs)
    nodes = list({p for s in segs for p in s})
    if nodes and "0" not in wall_set:
        ntree = STRtree(shapely.points(np.array(nodes)))
        cand = []
        for e, layer, top in flat:
            if layer == "0" and e.dxftype() == "LINE":
                (a, b), = entity_segments(e, tol) or [((0, 0), (0, 0))]
                if a != b and len(ntree.query(Point(a), predicate="dwithin", distance=tol)) and len(ntree.query(Point(b), predicate="dwithin", distance=tol)):
                    cand.append((a, b))
        if cand:
            segs_a, polys_a, dangles_a, nj = build(segs + cand)
            if len(polys_a) > len(polys):
                warn(f"{len(cand)} line(s) on layer '0' connect wall nodes and close {len(polys_a) - len(polys)} more wall face(s): adopted as wall lines")
                segs, polys, dangles, n_jambs_added = segs_a, polys_a, dangles_a, max(nj, n_jambs_added)
    if n_jambs_added:
        warn(f"{n_jambs_added} wall ends had no jamb line; closed them automatically (pairs of free ends at wall-thickness distance)")
    res["timing_ms"]["polygonize"] = round((time.perf_counter() - t2) * 1000)

    # ---- wall solids: thin faces (max inscribed circle radius <= 0.36 m)
    t3 = time.perf_counter()
    label_pts = [Point(p) for s, h, p, layer in texts_raw if has_word(s, ROOM_WORDS)]
    ltree = STRtree(label_pts) if label_pts else None
    solids, closed_faces = [], []
    for p in polys:
        if p.area < (0.02 * u) ** 2:
            continue
        r = shapely.maximum_inscribed_circle(p, tolerance=0.01 * u).length
        has_label = bool(ltree is not None and len(ltree.query(p, predicate="contains")))
        if r <= 0.36 * u and not has_label:
            solids.append(p)
        else:
            closed_faces.append(p)
    W = unary_union(solids) if solids else Polygon()
    if not W.is_empty:
        W = W.buffer(grid, join_style=2).buffer(-grid, join_style=2).simplify(grid)
    jambs = jamb_edges(W, 0.04 * u, 0.70 * u) if not W.is_empty else []
    bridges, free_jambs = pair_jambs(jambs, W, 0.35 * u, 5.5 * u, tol) if jambs else ([], [])
    res["stats"] = {"wall_segments_raw": n_raw, "wall_segments_clustered": len(segs), "faces": len(polys),
                    "wall_solids": len(solids), "closed_non_wall_faces": len(closed_faces), "dangling_lines": len(dangles),
                    "jambs": len(jambs), "bridges": len(bridges), "unpaired_jambs": len(free_jambs)}
    res["timing_ms"]["walls"] = round((time.perf_counter() - t3) * 1000)
    res["unpaired_jambs"] = [[round(jambs[i]["mid"][0], 1), round(jambs[i]["mid"][1], 1)] for i in free_jambs[:40]]

    # ---- north arrow
    north_bearing, north_info = 0.0, {"found": False, "assumption": "north = +Y of the drawing (no north arrow found)"}
    for ins in top_inserts:
        nm = strip_accents(ins.dxf.name)
        if re.search(r"nord|north|norden|kompass|boussole|compass|n.?pfeil", nm):
            north_bearing = (-ins.dxf.get("rotation", 0.0)) % 360
            north_info = {"found": True, "block": ins.dxf.name, "insert_rotation": ins.dxf.get("rotation", 0.0),
                          "north_bearing_cw_from_plusY": round(north_bearing, 2),
                          "assumption": "arrow points to +Y inside its block definition"}
            break
    if not north_info["found"]:
        warn("no north arrow block found: orientations assume north = top of the drawing - user must confirm")
    res["north"] = north_info

    # ---- building components
    t4 = time.perf_counter()
    C = unary_union([W] + [b["quad"].buffer(grid, join_style=2) for b in bridges]) if not W.is_empty else Polygon()
    if not C.is_empty:
        C = C.buffer(grid, join_style=2).buffer(-grid, join_style=2)
    comps = list(C.geoms) if isinstance(C, MultiPolygon) else ([C] if not C.is_empty else [])
    plans = []
    # opening evidence
    win_layers, door_layers = set(cats.get("window", [])), set(cats.get("door", []))
    ev_geoms, ev_meta = [], []
    for ins in top_inserts:
        il = insert_layer[id(ins)]
        cat = "window" if il in win_layers else "door" if il in door_layers else None
        nm = strip_accents(ins.dxf.name)
        if cat is None:
            cat = classify_layer(ins.dxf.name)
            if cat not in ("window", "door"):
                continue
        try:
            pts = []
            for v in ins.virtual_entities():
                for a, b in entity_segments(v, 0.02 * u):
                    pts += [a, b]
            g = shapely.MultiPoint(pts).minimum_rotated_rectangle if len(pts) >= 3 else Point(ins.dxf.insert.x, ins.dxf.insert.y)
        except Exception:
            g = Point(ins.dxf.insert.x, ins.dxf.insert.y)
        ev_geoms.append(g)
        radius = None
        try:
            rr = [v.dxf.radius for v in ins.virtual_entities() if v.dxftype() == "ARC"]
            radius = max(rr) if rr else None
        except Exception:
            pass
        ev_meta.append({"cat": cat, "block": ins.dxf.name, "attribs": {a.dxf.tag: a.dxf.text for a in ins.attribs},
                        "used": False, "geom": g, "arc_radius": radius})
    for e, layer, top in flat:
        if top is None and (layer in win_layers or layer in door_layers) and e.dxftype() in ("LINE", "ARC", "LWPOLYLINE"):
            ss = entity_segments(e, 0.02 * u)
            if ss:
                ev_geoms.append(LineString([ss[0][0]] + [s[1] for s in ss]))
                cat = "window" if layer in win_layers else "door"
                if e.dxftype() == "ARC" and 80 <= (e.dxf.end_angle - e.dxf.start_angle) % 360 <= 100 and 0.5 * u <= e.dxf.radius <= 1.25 * u:
                    cat = "door"  # a quarter-circle swing is a door even on a mixed "openings" layer
                ev_meta.append({"cat": cat, "block": None, "attribs": {}, "used": False, "kind": e.dxftype(), "geom": ev_geoms[-1]})
    etree = STRtree(ev_geoms) if ev_geoms else None

    text_pts = [Point(p) for s, h, p, layer in texts_raw]
    ttree = STRtree(text_pts) if text_pts else None

    for comp in sorted(comps, key=lambda g: -Polygon(g.exterior).area):
        outline = Polygon(comp.exterior)
        if outline.area < 9 * u * u:
            continue
        plan = {"bbox": [round(v, 2) for v in outline.bounds], "outline_area_m2": round(outline.area / u / u, 3),
                "outline_perimeter_m": round(outline.length / u, 3), "wall_area_m2": round(comp.area / u / u, 3)}
        # rooms = holes
        rooms = []
        for ring in comp.interiors:
            rp = Polygon(ring)
            if rp.area < 0.3 * u * u:
                continue
            frags = []
            if ttree is not None:
                for i in ttree.query(rp, predicate="contains"):
                    frags.append(texts_raw[int(i)])
            name, stated, extra_names = pick_label(frags, rp)
            nn = strip_accents(name or "")
            rooms.append({"name": name, "stated_area_m2": stated, "area_m2": round(rp.area / u / u, 3),
                          "perimeter_m": round(rp.length / u, 3), "other_labels": extra_names,
                          "heated_guess": not has_word(nn, UNHEATED_WORDS),
                          "centroid": [round(rp.centroid.x, 1), round(rp.centroid.y, 1)], "_poly": rp})
        for r in rooms:
            if r["stated_area_m2"] and abs(r["stated_area_m2"] - r["area_m2"]) > max(0.3, 0.03 * r["area_m2"]):
                warn(f"room '{r['name']}': label says {r['stated_area_m2']} m2 but geometry gives {r['area_m2']} m2")
            n_names = 1 + len([x for x in r["other_labels"] if has_word(x, ROOM_WORDS)])
            if r["name"] and n_names >= 2:
                warn(f"region '{r['name']}' contains {n_names} room labels {[r['name']] + r['other_labels']}: rooms are probably merged (a door/opening was not closed)")
        plan["rooms"] = rooms
        # openings
        ops = []
        for b in bridges:
            if not comp.buffer(tol).contains(b["quad"].centroid):
                continue
            q = b["quad"]
            cx, cy = b["centre"]
            ext = outline.exterior.distance(Point(cx, cy)) <= b["thick"] / 2 + 2 * tol
            typ, meta = "opening", None
            if etree is not None:
                hits = [int(i) for i in etree.query(q.buffer(0.12 * u), predicate="intersects")]
                hits.sort(key=lambda i: (ev_meta[i]["block"] is None, ev_meta[i]["cat"] != "door", ev_geoms[i].distance(Point(cx, cy))))
                for i in hits:
                    meta = ev_meta[i]
                    typ = meta["cat"]
                    meta["used"] = True
                    break
                for i in hits:
                    ev_meta[i]["used"] = True
            adj = [r["name"] or "?" for r in rooms if r["_poly"].distance(q) <= 2 * tol]
            o = {"type": typ, "width_m": round(b["width"] / u, 3), "wall_thickness_m": round(b["thick"] / u, 3),
                 "exterior": bool(ext), "centre": [round(cx, 1), round(cy, 1)], "rooms": adj,
                 "block": meta and meta["block"], "attribs": (meta and meta["attribs"]) or {}}
            if meta and meta["block"]:
                m = re.search(r"(\d+[.,]\d+)\s*[x/]\s*(\d+[.,]\d+)", meta["block"])
                if m:
                    o["size_from_block_name_m"] = [float(m.group(1).replace(",", ".")), float(m.group(2).replace(",", "."))]
            if ext:
                d = b["dir"]
                nx, ny = -d[1], d[0]
                if outline.contains(Point(cx + nx * (b["thick"] / 2 + 5 * tol), cy + ny * (b["thick"] / 2 + 5 * tol))):
                    nx, ny = -nx, -ny
                bearing = math.degrees(math.atan2(nx, ny)) % 360
                az = (bearing - north_bearing) % 360
                o["azimuth_deg"] = round(az, 1)
                o["orientation"] = sector(az)
            ops.append(o)
        # fallback: block inserts lying on this plan but not matched to a wall gap (walls drawn through the opening)
        cbuf = comp.buffer(0.15 * u)
        for meta in ev_meta:
            if meta["used"] or not meta["block"] or not cbuf.intersects(meta["geom"]):
                continue
            g = meta["geom"]
            c0 = g.centroid
            near = outline.exterior.interpolate(outline.exterior.project(c0))
            ext = c0.distance(near) <= 0.45 * u
            # wall direction = direction of the nearest outline / wall edge
            ring = outline.exterior if ext else min([Polygon(r).exterior for r in comp.interiors] or [outline.exterior], key=lambda r: r.distance(c0))
            s0 = ring.project(c0)
            pa, pb = ring.interpolate(max(0, s0 - tol)), ring.interpolate(min(ring.length, s0 + tol))
            dx, dy = pb.x - pa.x, pb.y - pa.y
            ln = math.hypot(dx, dy) or 1.0
            dx, dy = dx / ln, dy / ln
            if meta["cat"] == "door" and meta.get("arc_radius"):
                width = meta["arc_radius"]
            elif g.geom_type == "Polygon":
                xs = [(x - c0.x) * dx + (y - c0.y) * dy for x, y in g.exterior.coords]
                width = max(xs) - min(xs)
            else:
                width = 0.0
            o = {"type": meta["cat"], "width_m": round(width / u, 3), "wall_thickness_m": None, "exterior": bool(ext),
                 "centre": [round(c0.x, 1), round(c0.y, 1)], "rooms": [r["name"] or "?" for r in rooms if r["_poly"].distance(g) <= 0.5 * u],
                 "block": meta["block"], "attribs": meta["attribs"], "source": "block insert only (wall not interrupted)"}
            m = re.search(r"(\d+[.,]\d+)\s*[x/]\s*(\d+[.,]\d+)", meta["block"])
            if m:
                o["size_from_block_name_m"] = [float(m.group(1).replace(",", ".")), float(m.group(2).replace(",", "."))]
            if ext:
                nx, ny = -dy, dx
                if outline.contains(Point(c0.x + nx * 0.6 * u, c0.y + ny * 0.6 * u)):
                    nx, ny = -nx, -ny
                az = (math.degrees(math.atan2(nx, ny)) % 360 - north_bearing) % 360
                o["azimuth_deg"], o["orientation"] = round(az, 1), sector(az)
            meta["used"] = True
            ops.append(o)
        plan["openings"] = ops
        # heated gross outline
        heated = [r["_poly"] for r in rooms if r["heated_guess"]]
        unheated = [r["_poly"] for r in rooms if not r["heated_guess"]]
        if heated:
            G = unary_union(heated).buffer(0.70 * u, join_style=2).intersection(outline)
            if unheated:
                G = G.difference(unary_union(unheated))
            G = G.buffer(-0.25 * u, join_style=2).buffer(0.25 * u, join_style=2).simplify(tol)
            if isinstance(G, MultiPolygon):
                G = max(G.geoms, key=lambda g: g.area)
            Gx = Polygon(G.exterior)
            plan["heated_gross_area_m2"] = round(Gx.area / u / u, 3)
            plan["heated_gross_perimeter_m"] = round(Gx.length / u, 3)
            plan["heated_net_area_m2"] = round(sum(p.area for p in heated) / u / u, 3)
            fac = defaultdict(float)
            adjacent_unheated = 0.0
            obuf = outline.exterior.buffer(3 * tol)
            cc = list(orient(Gx, 1.0).exterior.coords)
            for a, b2 in zip(cc[:-1], cc[1:]):
                seg = LineString([a, b2])
                ln = seg.length
                on_out = seg.intersection(obuf).length
                dx, dy = b2[0] - a[0], b2[1] - a[1]
                bearing = math.degrees(math.atan2(dy, -dx)) % 360  # outward normal of a CCW ring = (dy, -dx)
                az = (bearing - north_bearing) % 360
                fac[sector(az)] += on_out / u
                adjacent_unheated += (ln - on_out) / u
            plan["facade_length_m_by_orientation"] = {k: round(v, 2) for k, v in fac.items() if v > 0.01}
            plan["heated_perimeter_against_unheated_m"] = round(adjacent_unheated, 2)
            plan["_heated_poly"] = Gx
        # title
        plan["title"], plan["floor_guess"] = pick_title(texts_raw, outline, u)
        plan["_outline"], plan["_comp"] = outline, comp
        plans.append(plan)
    res["plans"] = plans
    res["timing_ms"]["rooms"] = round((time.perf_counter() - t4) * 1000)
    unused = [m for m in ev_meta if not m["used"] and m["block"]]
    if unused:
        c = Counter(m["block"] for m in unused)
        warn(f"{len(unused)} door/window block insert(s) were not matched to a gap in the walls: {dict(c.most_common(6))}")
    res["unmatched_opening_inserts"] = len(unused)

    # ---- unit cross-check with stated areas
    ratios = [r["area_m2"] / r["stated_area_m2"] for p in plans for r in p["rooms"] if r["stated_area_m2"]]
    if ratios:
        med = float(np.median(ratios))
        res["units"]["stated_area_check"] = {"n": len(ratios), "median_ratio_geometry_over_label": round(med, 4)}
        if not (0.8 <= med <= 1.25) and not _rerun:
            fix = u * math.sqrt(med)
            best = min(UNIT_NAMES, key=lambda k: abs(math.log(k / fix)))
            if abs(math.log(best / fix)) < 0.15 and best != u:
                r2 = analyse(path, wall_layers, best, verbose, True)
                r2["warnings"].insert(0, f"units corrected from {UNIT_NAMES.get(u, u)} to {UNIT_NAMES[best]} using stated room areas")
                return r2
            warn(f"stated room areas disagree with geometry (median ratio {med:.3f}) - check units / scale")
    res["timing_ms"]["total"] = round((time.perf_counter() - t0) * 1000)
    res["_W"], res["_bridges"], res["_dangles"], res["_texts"] = W, bridges, dangles, texts_raw
    return res


def parallel_pair_score(segs, u):
    """(matched length, matched share) of segments having a parallel partner 5..65 cm away overlapping >= 50 %"""
    segs = [s for s in segs if math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) >= 0.3 * u]
    if len(segs) < 4:
        return (0.0, 0.0)
    lines = [LineString(s) for s in segs]
    tree = STRtree(lines)
    total = sum(l.length for l in lines)
    matched = 0.0
    for i, (a, b) in enumerate(segs):
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dy)
        ux, uy = dx / ln, dy / ln
        ok = False
        for j in tree.query(lines[i], predicate="dwithin", distance=0.65 * u):
            if j == i:
                continue
            c, d = segs[j]
            ex, ey = d[0] - c[0], d[1] - c[1]
            l2 = math.hypot(ex, ey)
            if abs(ux * ey - uy * ex) / l2 > 0.02:
                continue
            dist = abs((c[0] - a[0]) * uy - (c[1] - a[1]) * ux)
            if not (0.05 * u <= dist <= 0.65 * u):
                continue
            t1, t2 = sorted((((c[0] - a[0]) * ux + (c[1] - a[1]) * uy), ((d[0] - a[0]) * ux + (d[1] - a[1]) * uy)))
            ov = min(ln, t2) - max(0, t1)
            if ov >= 0.5 * min(ln, l2):
                ok = True
                break
        if ok:
            matched += ln
    return (matched, matched / total if total else 0.0)


def pick_label(frags, poly):
    """frags: [(text, height, (x, y), layer)] inside a room polygon -> (name, stated area, other names)"""
    names, areas = [], []
    c = poly.centroid
    for s, h, p, layer in frags:
        for part in re.split(r"[\n\r]+", s):
            part = part.strip()
            if not part:
                continue
            m = AREA_RE.search(part)
            if m:
                areas.append((math.hypot(p[0] - c.x, p[1] - c.y), float(m.group(1).replace(",", "."))))
                part = (part[:m.start()] + " " + part[m.end():]).strip()
                part = re.sub(r"(?i)\b(s|surface|flaeche|fläche|wfl|nf|ca)\s*[=:.]?\s*$", "", part).strip(" =:-")
            if len(re.findall(r"[^\W\d_]", part)) >= 2 and not re.fullmatch(r"[\d\s.,x'\"/-]+", part):
                known = has_word(part, ROOM_WORDS)
                names.append((not known, -h, math.hypot(p[0] - c.x, p[1] - c.y), part))
    names.sort()
    areas.sort()
    name = names[0][3] if names else None
    return name, (areas[0][1] if areas else None), [n[3] for n in names[1:6]]


def pick_title(texts, outline, u):
    best = (None, None, 1e99)
    x0, y0, x1, y1 = outline.bounds
    hmed = float(np.median([t[1] for t in texts])) if texts else 0.0
    for s, h, p, layer in texts:
        n = strip_accents(s)
        if len(n) > 45 or h < hmed:
            continue
        for lvl, rx in FLOOR_RULES:
            if re.search(rx, n):
                if x0 - 3 * u <= p[0] <= x1 + 3 * u:
                    d = outline.distance(Point(p))
                    if d < best[2] and d < 8 * u:
                        best = (s, lvl, d)
                break
    return best[0], best[1]


def to_json(res):
    def clean(o):
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items() if not str(k).startswith("_")}
        if isinstance(o, (list, tuple)):
            return [clean(v) for v in o]
        if isinstance(o, (np.floating, np.integer)):
            return o.item()
        return o
    return clean(res)


def draw_png(res, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(15, 10))
    W = res["_W"]
    for g in (W.geoms if isinstance(W, MultiPolygon) else [W]):
        if g.is_empty:
            continue
        ax.fill(*g.exterior.xy, color="#444444", zorder=2)
        for h in g.interiors:
            ax.fill(*h.xy, color="white", zorder=2)
    cmap = plt.get_cmap("tab20")
    k = 0
    for plan in res["plans"]:
        for r in plan["rooms"]:
            ax.fill(*r["_poly"].exterior.xy, color=cmap(k % 20), alpha=0.55, zorder=1)
            k += 1
            c = r["_poly"].representative_point()
            ax.text(c.x, c.y, f"{r['name'] or '?'}\n{r['area_m2']:.2f} m²" + ("" if r["heated_guess"] else "\n(unheated?)"), ha="center", va="center", fontsize=7, zorder=5)
        ax.plot(*plan["_outline"].exterior.xy, color="red", lw=1.2, zorder=4)
        if "_heated_poly" in plan:
            ax.plot(*plan["_heated_poly"].exterior.xy, color="green", lw=2, ls="--", zorder=4)
        for o in plan["openings"]:
            col = {"window": "#1f77ff", "door": "#ff7f0e"}.get(o["type"], "#aa00aa")
            ax.plot(*o["centre"], marker="s" if o["exterior"] else "o", color=col, ms=6, zorder=6)
            ax.text(o["centre"][0], o["centre"][1], f" {o['type'][0].upper()} {o['width_m']:.2f}" + (f" {o.get('orientation', '')}" if o["exterior"] else ""), fontsize=6, color=col, zorder=6)
    for b in res["_bridges"]:
        ax.fill(*b["quad"].exterior.xy, color="#99ccff", zorder=3)
    for d in res["_dangles"][:2000]:
        ax.plot(*d.xy, color="magenta", lw=0.8, zorder=3)
    for x, y in res.get("unpaired_jambs", []):
        ax.plot(x, y, marker="x", color="red", ms=7, zorder=7)
    ax.set_aspect("equal")
    ax.set_title(f"{res['file'].split('/')[-1]} | unit={res['units']['unit']} | red=outline, green dashed=heated gross, blue=bridged openings, magenta=dangling, x=free wall end", fontsize=8)
    fig.savefig(out, dpi=110, bbox_inches="tight")
    plt.close(fig)


def report(res):
    print(f"\n================ {res['file']}")
    print(f"load: {res['load']['mode']} {res['load']['dxf_version']} entities={res['load']['modelspace_entities']} timing={res['timing_ms']}")
    un = res["units"]
    print(f"units: {un['unit']} ({un['units_per_m']} per m)  evidence={un['evidence']}  area-check={un.get('stated_area_check')}")
    print(f"layers ({res['layers']['source']}): {res['layers']['mapping']}")
    print(f"unmapped layers: {res['layers']['unmapped'][:15]}")
    print(f"stats: {res['stats']}")
    print(f"north: {res['north']}")
    for i, p in enumerate(res["plans"]):
        print(f"--- plan {i}: title={p['title']!r} floor={p['floor_guess']} outline={p['outline_area_m2']} m2 / {p['outline_perimeter_m']} m; "
              f"heated gross={p.get('heated_gross_area_m2')} m2 / {p.get('heated_gross_perimeter_m')} m; heated net={p.get('heated_net_area_m2')} m2")
        print(f"    facades (m): {p.get('facade_length_m_by_orientation')}  against unheated: {p.get('heated_perimeter_against_unheated_m')} m")
        for r in p["rooms"]:
            print(f"    room {str(r['name']):22} geom={r['area_m2']:8.2f} m2  label={r['stated_area_m2']}  heated?={r['heated_guess']}  others={r['other_labels'][:3]}")
        for o in p["openings"]:
            print(f"    {o['type']:7} w={o['width_m']:.2f} t={(o['wall_thickness_m'] or 0):.2f} ext={o['exterior']!s:5} {o.get('orientation', ''):2} az={o.get('azimuth_deg', '')!s:6} rooms={o['rooms']} block={o['block']} {o['attribs'] or ''} {o.get('size_from_block_name_m', '')}")
    for w in res["warnings"]:
        print("  WARNING:", w)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json")
    ap.add_argument("--png")
    ap.add_argument("--wall-layer", action="append")
    ap.add_argument("--units-per-m", type=float)
    ap.add_argument("-q", action="store_true")
    a = ap.parse_args()
    for f in a.files:
        r = analyse(f, a.wall_layer, a.units_per_m)
        if not a.q:
            report(r)
        if a.png:
            draw_png(r, a.png)
        if a.json:
            with open(a.json, "w", encoding="utf-8") as fh:
                json.dump(to_json(r), fh, indent=1, ensure_ascii=False)
