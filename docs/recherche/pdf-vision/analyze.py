#!/usr/bin/env python
"""analyze.py - plan understanding on top of the IR produced by extract_py.py / extract_pdfjs.mjs.

  scale_from_text      title-block / view-label scale ("Échelle 1:100", "Maßstab 1:50", "Ech. 1/50e" ...)
  parse_rooms          FR/DE room vocabulary + area labels (comma or dot decimals, m², m2, qm)
  calibrate_dims       self-calibration: dimension texts vs measured dimension-line intervals
  wall_faces           wall line class -> gap bridging -> polygonize -> rooms / outline
  calibrate_areas      second, unit-free calibration: room label area vs measured room polygon
  heated_outline       heated footprint in external dimensions from room classification
  north_from_arrow     "N" label + nearest circle
  levels_from_section  "+2,80" level marks, "HSP 2,50 m"

Usage: analyze.py <ir.json> [truth.json]  -> prints a report, returns dict
"""
import json
import math
import re
import statistics as st
import sys
import unicodedata
from collections import defaultdict

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, unary_union

PT_M = 0.0254 / 72  # metres of paper per point
STD_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000, 2000, 2500, 5000]


def norm(s):
    s = unicodedata.normalize("NFKD", s.replace("ß", "ss")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", s).strip()


# ----------------------------------------------------------------------------- scale text
SCALE_RE = re.compile(
    r"(?<![\d/.:,])(?:(?P<kw>[ée]chelle|[ée]ch\.?|ma(?:ß|ss?)stab|mst\.?|scale|m\.?)\s*[:=]?\s*)?"
    r"1\s*[:/]\s*(?P<den>\d{1,5})(?:\s*(?:e|ème|eme))?(?![\d/:,]|\.\d)", re.I)


def scale_from_text(texts):
    """Return [{den, kw(bool), text, cx, cy, size}] ; keyword-prefixed and standard denominators first."""
    out = []
    for t in texts:
        for m in SCALE_RE.finditer(t["s"]):
            den = int(m.group("den"))
            if den not in STD_SCALES:
                continue
            out.append({"den": den, "kw": bool(m.group("kw")), "text": t["s"], "cx": t["cx"], "cy": t["cy"],
                        "size": t["size"]})
    out.sort(key=lambda c: (-c["kw"], -c["size"]))
    return out


# ----------------------------------------------------------------------------- rooms
AREA_RE = re.compile(r"(?<![\d.,])(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:m\s?[²2]|m\^2|qm|㎡)(?![a-z0-9])", re.I)

# canonical type -> (class, [patterns on normalised text])   class: H heated, U unheated, A ambiguous, X exterior
VOCAB = {
    "living":   ("H", r"sejour|salon|living|salle a manger|s\.?a\.?m\b|wohnzimmer|wohnen|wohnraum|esszimmer|essen|stuff"),
    "kitchen":  ("H", r"cuisine|kitchenette|kuche|kochen|kichen"),
    "bedroom":  ("H", r"chambre|ch\.? ?\d|schlafzimmer|schlafen|kinderzimmer|kind\b|zimmer|gastezimmer|gast\b|eltern|schlofkummer"),
    "office":   ("H", r"bureau|buro|arbeitszimmer|arbeiten"),
    "bath":     ("H", r"salle de bains?|sdb|s\.d\.b|salle d'eau|sde\b|douche|\bbad\b|badezimmer|dusche|buedzemmer"),
    "wc":       ("H", r"\bwc\b|toilettes?|gaste-?wc"),
    "circ":     ("H", r"hall|entree|degagement|dgt\b|couloir|palier|\bsas\b|flur|diele|eingang|windfang|galerie|gank"),
    "dressing": ("H", r"dressing|ankleide|garde-?robe"),
    "garage":   ("U", r"garage|carport|car-port|abri|remise|schuppen|stellplatz"),
    "cellar":   ("U", r"\bcave\b|keller|kellerraum|vide sanitaire|kriechkeller|\blager\b|sous-sol"),
    "attic":    ("U", r"grenier|combles?|speicher|dachboden|spitzboden"),
    "laundry":  ("A", r"buanderie|waschkuche|waschen|hwr\b|hauswirtschaft"),
    "tech":     ("A", r"local technique|technique|technik|heizung|chaufferie|chauffage|heizraum|hausanschluss"),
    "storage":  ("A", r"debarras|rangement|cellier|abstellraum|abstell\b|vorrat|reserve"),
    "hobby":    ("A", r"atelier|werkstatt|hobby|bricolage|fitness|veranda|wintergarten|jardin d'hiver"),
    "stairs":   ("A", r"cage d'escalier|escalier|treppenhaus|treppe"),
    "outside":  ("X", r"terrasse|balcon|balkon|loggia|jardin|garten|\bcour\b|\bhof\b|pergola"),
}
NEG_RE = re.compile(r"non[- ]chauff|unbeheizt|nicht beheizt|kalt|non amenag|nicht ausgebaut")
VOCAB_C = {k: (c, re.compile(p)) for k, (c, p) in VOCAB.items()}


def classify_room(name):
    n = norm(name)
    cls, typ = None, None
    for part in re.split(r"\s*/\s*", n) + [n]:
        for k, (c, rx) in VOCAB_C.items():
            if rx.search(part):
                typ, cls = k, c
                break
        if typ:
            break
    if NEG_RE.search(n):
        cls = "U"
    return typ, cls


def parse_rooms(texts):
    """-> [{name, type, cls, area_m2|None, x, y}] ; pairs each room-name token with the area token just below it."""
    names, areas = [], []
    for t in texts:
        if abs(t["angle"]) > 1:
            continue
        m = AREA_RE.search(t["s"])
        if m:
            areas.append({"a": float(m.group(1).replace(",", ".")), "t": t, "used": False})
            rest = AREA_RE.sub("", t["s"]).strip(" :=-")
            typ, cls = classify_room(rest) if rest else (None, None)
            if typ:  # "Séjour 32,45 m²" in a single run
                names.append({"name": rest, "type": typ, "cls": cls, "t": t, "area": areas[-1]["a"]})
                areas[-1]["used"] = True
            continue
        typ, cls = classify_room(t["s"])
        if typ:
            names.append({"name": t["s"].strip(), "type": typ, "cls": cls, "t": t, "area": None})
    for n in names:
        if n["area"] is not None:
            continue
        best = None
        for a in areas:
            if a["used"]:
                continue
            dy = a["t"]["cy"] - n["t"]["cy"]
            dx = abs(a["t"]["cx"] - n["t"]["cx"])
            if -0.5 * n["t"]["size"] < dy < 3.0 * n["t"]["size"] and dx < max(40, 0.6 * (n["t"]["x1"] - n["t"]["x0"]) + 20):
                d = math.hypot(dx, dy)
                if best is None or d < best[0]:
                    best = (d, a)
        if best:
            best[1]["used"] = True
            n["area"] = best[1]["a"]
    return [{"name": n["name"], "type": n["type"], "cls": n["cls"], "area_m2": n["area"],
             "x": n["t"]["cx"], "y": n["t"]["cy"]} for n in names], [a for a in areas if not a["used"]]


# ----------------------------------------------------------------------------- dimensions
NUM_RE = re.compile(r"^\d{1,5}(?:[.,]\d{1,3})?$")


def dimension_tokens(texts):
    """Numeric tokens; German superscript half-centimetres ("11" + small raised "5") are merged.
    -> [{val (as written), dec (has decimal sep), sup (bool), cx, cy, angle, size}]"""
    toks = [t for t in texts if NUM_RE.match(t["s"].strip())]
    sizes = [t["size"] for t in toks]
    if not sizes:
        return []
    main = st.median(sizes)
    sups = [t for t in toks if t["size"] < 0.8 * main and t["s"].strip() == "5"]
    out = []
    used = set()
    for t in toks:
        if t["size"] < 0.8 * main:
            continue
        s = t["s"].strip()
        sup = False
        for i, u in enumerate(sups):
            if i in used or round(u["angle"]) != round(t["angle"]):
                continue
            if abs(round(t["angle"])) < 1:  # horizontal: sup is right after, raised
                ok = -1 < u["x0"] - t["x1"] < 0.6 * t["size"] and t["y0"] - 0.6 * t["size"] < u["cy"] < t["cy"]
            else:  # 90 deg: reading goes upwards (y decreasing), raised = towards -x
                ok = -1 < t["y0"] - u["y1"] < 0.6 * t["size"] and t["x0"] - 0.6 * t["size"] < u["cx"] < t["cx"]
            if ok:
                used.add(i)
                sup = True
                break
        out.append({"s": s, "dec": ("," in s or "." in s), "sup": sup, "val": float(s.replace(",", ".")),
                    "cx": t["cx"], "cy": t["cy"], "angle": t["angle"], "size": t["size"],
                    "x0": t["x0"], "y0": t["y0"], "x1": t["x1"], "y1": t["y1"]})
    return out


def merged_lines(segs, max_w, tol=0.4):
    """Merge collinear touching/overlapping thin straight segments. -> [(theta_deg, rho, a0, a1)]"""
    groups = defaultdict(list)
    for s in segs:
        if s["kind"] != "l" or not s["stroke"] or s["w"] > max_w or s.get("dash"):
            continue
        dx, dy = s["x1"] - s["x0"], s["y1"] - s["y0"]
        L = math.hypot(dx, dy)
        if L < 0.2:
            continue
        th = math.degrees(math.atan2(dy, dx)) % 180.0
        if th > 179.75:
            th = 0.0
        thq = round(th * 2) / 2
        t = math.radians(thq)
        ux, uy = math.cos(t), math.sin(t)
        rho = -uy * s["x0"] + ux * s["y0"]
        a0, a1 = sorted((ux * s["x0"] + uy * s["y0"], ux * s["x1"] + uy * s["y1"]))
        groups[(thq, round(rho / tol))].append((a0, a1, rho))
    out = []
    for (thq, _), ivs in groups.items():
        ivs.sort()
        cur = list(ivs[0])
        for a0, a1, rho in ivs[1:]:
            if a0 <= cur[1] + tol:
                cur[1] = max(cur[1], a1)
            else:
                out.append((thq, cur[2], cur[0], cur[1]))
                cur = [a0, a1, rho]
        out.append((thq, cur[2], cur[0], cur[1]))
    return out


def calibrate_dims(page, declared_den=None, verbose=False):
    """Self-calibration from dimension chains.
    1. dimension lines = thin merged lines carrying >= 2 short segments that CROSS them symmetrically (ticks /
       extension lines); 2. consecutive crossings = intervals; 3. numeric text parallel + centred on interval;
       4. per-interval scale under each unit hypothesis; robust consensus."""
    segs = page["segs"]
    widths = sorted({round(s["w"], 2) for s in segs if s["stroke"]})
    thin_max = widths[min(2, len(widths) - 1)] + 0.01 if widths else 1
    lines = [l for l in merged_lines(segs, thin_max) if l[3] - l[2] > 8]
    shorts = []
    for s in segs:
        if s["kind"] != "l" or not s["stroke"]:
            continue
        L = math.hypot(s["x1"] - s["x0"], s["y1"] - s["y0"])
        if 1.0 < L < 16:
            shorts.append(((s["x0"] + s["x1"]) / 2, (s["y0"] + s["y1"]) / 2,
                           math.degrees(math.atan2(s["y1"] - s["y0"], s["x1"] - s["x0"])) % 180))
    toks = dimension_tokens(page["texts"])
    obs = []
    used_tok = set()
    for thq, rho, a0, a1 in lines:
        t = math.radians(thq)
        ux, uy = math.cos(t), math.sin(t)
        br = []
        for mx, my, sth in shorts:
            d = abs(-uy * mx + ux * my - rho)
            a = ux * mx + uy * my
            dth = abs((sth - thq + 90) % 180 - 90)
            if d < 0.35 and a0 - 0.5 <= a <= a1 + 0.5 and dth > 20:
                br.append(a)
        if len(br) < 2:
            continue
        br.sort()
        bps = [br[0]]
        for b in br[1:]:
            if b - bps[-1] > 0.6:
                bps.append(b)
        if len(bps) < 2:
            continue
        for b0, b1 in zip(bps[:-1], bps[1:]):
            L = b1 - b0
            best = None
            for i, k in enumerate(toks):
                if i in used_tok:
                    continue
                if abs((k["angle"] - (180 - thq if thq else 0) + 90) % 180 - 90) > 5 and abs((k["angle"] + thq + 90) % 180 - 90) > 5:
                    continue
                a = ux * k["cx"] + uy * k["cy"]
                d = abs(-uy * k["cx"] + ux * k["cy"] - rho)
                if d > 3.2 * k["size"]:
                    continue
                if not (b0 - 0.25 * k["size"] <= a <= b1 + 0.25 * k["size"]):
                    continue
                score = d + 0.5 * abs(a - (b0 + b1) / 2)
                if best is None or score < best[0]:
                    best = (score, i)
            if best:
                used_tok.add(best[1])
                k = toks[best[1]]
                obs.append({"tok": k, "len_pt": L})
    if not obs:
        return {"n": 0}

    def den_for(o, int_unit):
        k = o["tok"]
        v = k["val"]
        if k["dec"]:
            m = v + (0.005 if k["sup"] else 0)       # decimals are metres (DIN 1356 / usual FR practice)
        else:
            m = (v + (0.5 if k["sup"] else 0)) * int_unit
        return m / (o["len_pt"] * PT_M)

    res = {}
    for name, u in (("mm", 0.001), ("cm", 0.01), ("m", 1.0)):
        dens = [den_for(o, u) for o in obs]
        med = st.median(dens)
        inl = [d for d in dens if abs(d / med - 1) < 0.02]
        res[name] = {"median_den": med, "inliers": len(inl), "n": len(dens),
                     "spread_pct": 100 * (max(inl) - min(inl)) / med if inl else None,
                     "mean_inlier_den": sum(inl) / len(inl)}
    n_int = sum(1 for o in obs if not o["tok"]["dec"])

    def score(name):  # prefer many inliers, then closeness to a standard / declared scale
        r = res[name]
        ref = [declared_den] if declared_den else STD_SCALES
        close = min(abs(math.log(r["median_den"] / s)) for s in ref)
        return (-r["inliers"], close)

    best_unit = min(res, key=score)
    r = res[best_unit]
    out = {"n": len(obs), "n_integer_tokens": n_int, "unit_for_integers": best_unit, "den": r["mean_inlier_den"],
           "inliers": r["inliers"], "spread_pct": r["spread_pct"], "per_unit": res, "obs": obs}
    return out


# ----------------------------------------------------------------------------- walls / faces
def wall_class(page):
    """Heuristic: frame = heaviest stroke class whose segments hug the page border; walls = heaviest remaining
    class that carries a significant share of the stroked length."""
    W, H = page["width"], page["height"]
    by_w = defaultdict(float)
    frame_w = set()
    for s in page["segs"]:
        if not s["stroke"] or s["kind"] != "l":
            continue
        L = math.hypot(s["x1"] - s["x0"], s["y1"] - s["y0"])
        w = round(s["w"], 2)
        by_w[w] += L
        if L > 0.6 * min(W, H) and (min(s["x0"], s["x1"]) < 0.06 * W or max(s["x0"], s["x1"]) > 0.94 * W
                                    or min(s["y0"], s["y1"]) < 0.06 * H or max(s["y0"], s["y1"]) > 0.94 * H):
            frame_w.add(w)
    total = sum(by_w.values())
    cands = [w for w in sorted(by_w, reverse=True) if w not in frame_w and by_w[w] > 0.04 * total]
    return (cands[0] if cands else None), sorted(by_w.items()), frame_w


def wall_faces(page, m_per_pt, max_gap_m=3.0, pair_check=True, ext=0.5):
    """Wall-class segments -> bridge collinear gaps (doors/windows) -> polygonize.
    Returns (faces [Polygon], bridged_count, wall_width)."""
    ww, classes, frame_w = wall_class(page)
    if ww is None:
        # FALLBACK (no usable line-weight hierarchy, e.g. hairline PDFs): take every straight, non-dashed stroke
        # that is not part of the sheet frame. Furniture / stairs / windows then create extra faces: results
        # must be cross-checked against area labels and confirmed by the user.
        W, H = page["width"], page["height"]
        def is_frame(s):
            L = math.hypot(s["x1"] - s["x0"], s["y1"] - s["y0"])
            return L > 0.6 * min(W, H) and (min(s["x0"], s["x1"]) < 0.06 * W or max(s["x0"], s["x1"]) > 0.94 * W
                                            or min(s["y0"], s["y1"]) < 0.06 * H or max(s["y0"], s["y1"]) > 0.94 * H)
        segs = [s for s in page["segs"] if s["stroke"] and s["kind"] == "l" and not s.get("dash") and not is_frame(s)]
        ww = "ALL"
    else:
        segs = [s for s in page["segs"] if s["stroke"] and s["kind"] == "l" and abs(round(s["w"], 2) - ww) < 0.011]
    lines = []
    per_theta = defaultdict(list)
    for s in segs:
        dx, dy = s["x1"] - s["x0"], s["y1"] - s["y0"]
        L = math.hypot(dx, dy)
        if L < 0.05:
            continue
        # extend every segment by `ext` pt at both ends: sloppy snapping (gaps < ext) still closes into faces,
        # the overshoots are dangles that polygonize() ignores.
        ex, ey = dx / L * ext, dy / L * ext
        lines.append(LineString([(s["x0"] - ex, s["y0"] - ey), (s["x1"] + ex, s["y1"] + ey)]))
        if L < 0.2:  # NB: even 1 pt wall stubs between a door and a T-junction matter for the twin test
            continue
        th = math.degrees(math.atan2(dy, dx)) % 180.0
        thq = round(th) % 180
        t = math.radians(thq)
        ux, uy = math.cos(t), math.sin(t)
        rho = -uy * (s["x0"] + s["x1"]) / 2 + ux * (s["y0"] + s["y1"]) / 2
        a0, a1 = sorted((ux * s["x0"] + uy * s["y0"], ux * s["x1"] + uy * s["y1"]))
        per_theta[thq].append((rho, a0, a1))
    groups = {}
    gid = 0
    for thq, lst in per_theta.items():  # cluster collinear segments: sort by rho, split when the gap > 0.6 pt
        lst.sort()
        cur = [lst[0]]
        for it in lst[1:]:
            if it[0] - cur[-1][0] > 0.6:
                groups[(thq, gid)] = [(a0, a1, r) for r, a0, a1 in cur]
                gid += 1
                cur = []
            cur.append(it)
        groups[(thq, gid)] = [(a0, a1, r) for r, a0, a1 in cur]
        gid += 1
    gap_pt = max_gap_m / m_per_pt
    cands = []
    for (thq, _), ivs in groups.items():
        ivs.sort()
        end, rho = ivs[0][1], ivs[0][2]
        for a0, a1, r in ivs[1:]:
            if 1.0 < a0 - end < gap_pt:
                cands.append((thq, (rho + r) / 2, end, a0))
            if a1 > end:
                end, rho = a1, r
    # An opening interrupts BOTH faces of a wall: keep a bridge only if a twin bridge exists with the same
    # extent at one wall thickness (4 cm .. 70 cm) distance.  (Without this test, collinear door/window jambs
    # of different walls get connected and cut rooms in two - measured on the FR fixture.)
    tmin, tmax = 0.04 / m_per_pt, 0.70 / m_per_pt
    bridged = 0
    for i, (thq, rho, a0, a1) in enumerate(cands):
        if not pair_check:
            ok = True
        else:
            ok = any(j != i and c[0] == thq and tmin < abs(c[1] - rho) < tmax and abs(c[2] - a0) < 1.5 and abs(c[3] - a1) < 1.5
                     for j, c in enumerate(cands))
        if ok:
            t = math.radians(thq)
            ux, uy = math.cos(t), math.sin(t)
            lines.append(LineString([(ux * (a0 - ext) - uy * rho, uy * (a0 - ext) + ux * rho), (ux * (a1 + ext) - uy * rho, uy * (a1 + ext) + ux * rho)]))
            bridged += 1
    # snap to a 0.05 pt grid so that float32 (pdf.js) and float64 backends node identically
    merged = unary_union([LineString([(round(x * 20) / 20, round(y * 20) / 20) for x, y in l.coords]) for l in lines])
    faces = [f for f in polygonize(merged) if f.area > 1.0]
    return faces, bridged, ww


def outline_by_closing(page, m_per_pt, r_m=1.3):
    """Topology-free outline: buffer wall-class segments by r, take the exterior, shrink by r (mitred).
    Tolerant to unsnapped endpoints; fills openings up to 2r wide - and also notches/recesses up to 2r wide."""
    ww, _, _ = wall_class(page)
    if ww is None:
        return []
    segs = [s for s in page["segs"] if s["stroke"] and s["kind"] == "l" and abs(round(s["w"], 2) - ww) < 0.011]
    r = r_m / m_per_pt
    u = unary_union([LineString([(s["x0"], s["y0"]), (s["x1"], s["y1"])]) for s in segs
                     if math.hypot(s["x1"] - s["x0"], s["y1"] - s["y0"]) > 0.05]).buffer(r, join_style=2, cap_style=3)
    comps = list(u.geoms) if u.geom_type == "MultiPolygon" else [u]
    out = []
    for c in comps:
        p = Polygon(c.exterior).buffer(-r, join_style=2)
        for q in (p.geoms if p.geom_type == "MultiPolygon" else [p]):
            if q.area > 400:
                out.append(q)
    return out


def view_components(faces):
    """Group faces into views (plan RDC, plan Etage, section...) = connected components of the union."""
    if not faces:
        return []
    u = unary_union([f.buffer(0.05) for f in faces]).buffer(-0.05)
    comps = list(u.geoms) if u.geom_type == "MultiPolygon" else [u]
    return [Polygon(c.exterior) for c in comps if c.area > 400]


def calibrate_areas(rooms, faces):
    """Unit-free calibration: sqrt(label m² / polygon pt²) for every labelled room whose face is found."""
    obs = []
    for r in rooms:
        pt = Point(r["x"], r["y"])
        cont = [f for f in faces if f.contains(pt)]
        if not cont:
            r["face"] = None
            continue
        f = min(cont, key=lambda f: f.area)
        r["face"] = f
        if r["area_m2"]:
            obs.append(math.sqrt(r["area_m2"] / f.area) / PT_M)
    if not obs:
        return {"n": 0}
    med = st.median(obs)
    inl = [o for o in obs if abs(o / med - 1) < 0.02]
    if not inl:  # labels and polygons disagree everywhere -> unusable, flag it
        return {"n": len(obs), "den": med, "inliers": 0, "spread_pct": float("nan")}
    return {"n": len(obs), "den": sum(inl) / len(inl), "inliers": len(inl),
            "spread_pct": 100 * (max(inl) - min(inl)) / med}


def heated_outline(view_poly, rooms_in_view, faces, m_per_pt, grow_m=0.62):
    """Heated footprint in EXTERNAL dimensions: heated room faces grown by one wall thickness, clipped to the
    building outline and to everything that is not an unheated room."""
    hot = [r["face"] for r in rooms_in_view if r.get("face") is not None and r["cls"] in ("H", "A")]
    cold = [r["face"] for r in rooms_in_view if r.get("face") is not None and r["cls"] in ("U", "X")]
    if not hot:
        return None
    g = grow_m / m_per_pt
    grown = unary_union(hot).buffer(g, join_style=2)
    res = grown.intersection(view_poly)
    if cold:
        res = res.difference(unary_union(cold))
    # remove thin spurs of annex walls (opening with half a thin-wall thickness)
    e = 0.14 / m_per_pt
    res = res.buffer(-e, join_style=2).buffer(e, join_style=2)
    return res


# ----------------------------------------------------------------------------- north, levels
def north_from_arrow(page):
    ns = [t for t in page["texts"] if t["s"].strip() in ("N", "NORD", "Nord", "Norden")]
    if not ns:
        return None
    # circles = paths made only of curve segments
    paths = defaultdict(list)
    for s in page["segs"]:
        paths[s["pid"]].append(s)
    circles = []
    for pid, ss in paths.items():
        if all(s["kind"] == "c" for s in ss) and len(ss) >= 16:
            xs = [s["x0"] for s in ss]
            ys = [s["y0"] for s in ss]
            w, h = max(xs) - min(xs), max(ys) - min(ys)
            if w > 5 and abs(w - h) < 0.1 * w:
                circles.append(((max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2, w / 2))
    best = None
    for n in ns:
        for cx, cy, r in circles:
            d = math.hypot(n["cx"] - cx, n["cy"] - cy)
            if d < 4 * r and (best is None or d < best[0]):
                best = (d, n, cx, cy)
    if not best:
        return None
    _, n, cx, cy = best
    return round(math.degrees(math.atan2(n["cx"] - cx, -(n["cy"] - cy))), 1)  # clockwise from page-up


LEVEL_RE = re.compile(r"^\s*([+\-±−])\s?(\d{1,2}[.,]\d{2})\s*$")
HSP_RE = re.compile(r"(?i)\b(hsp|h\.s\.p\.?|hauteur sous plafond|rh|lrh|lichte\s+(?:raum)?h[öo]he|lh)\s*[:=]?\s*(\d[.,]\d{1,2})\s*m?\b")


def levels_from_section(texts):
    lv = []
    for t in texts:
        m = LEVEL_RE.match(t["s"])
        if m:
            v = float(m.group(2).replace(",", "."))
            lv.append(-v if m.group(1) in "-−" else v)
    lv = sorted(set(lv))
    hsp = [float(m.group(2).replace(",", ".")) for t in texts for m in HSP_RE.finditer(t["s"])]
    return {"levels": lv, "storey_heights": [round(b - a, 3) for a, b in zip(lv[:-1], lv[1:])], "clear_heights": hsp}


# ----------------------------------------------------------------------------- page orientation
def normalize_rotation(page):
    """If most text is not upright (sheet stored sideways), rotate the whole IR by a multiple of 90 degrees so that
    the dominant reading direction becomes left-to-right. Returns (page, applied_ccw_deg)."""
    from collections import Counter
    c = Counter()
    for t in page["texts"]:
        c[int(round(t["angle"] / 90.0)) % 4 * 90] += len(t["s"])
    if not c:
        return page, 0
    dom = c.most_common(1)[0][0]  # dominant text angle (ccw, y-up convention)
    if dom == 0:
        return page, 0
    W, H = page["width"], page["height"]
    # rotate the display by -dom (ccw) => clockwise by dom.  Mapping of top-left coords:
    def f(x, y):
        if dom == 90:    # text reads bottom-to-top -> rotate page clockwise 90
            return H - y, x
        if dom == 180:
            return W - x, H - y
        return y, W - x  # dom == 270 (-90): text reads top-to-bottom -> rotate counter-clockwise 90
    out = {"width": H if dom in (90, 270) else W, "height": W if dom in (90, 270) else H, "texts": [], "segs": []}
    for t in page["texts"]:
        (xa, ya), (xb, yb) = f(t["x0"], t["y0"]), f(t["x1"], t["y1"])
        n = dict(t)
        n.update({"x0": min(xa, xb), "x1": max(xa, xb), "y0": min(ya, yb), "y1": max(ya, yb),
                  "cx": (xa + xb) / 2, "cy": (ya + yb) / 2, "angle": ((t["angle"] - dom + 180) % 360) - 180})
        out["texts"].append(n)
    for s_ in page["segs"]:
        (xa, ya), (xb, yb) = f(s_["x0"], s_["y0"]), f(s_["x1"], s_["y1"])
        n = dict(s_)
        n.update({"x0": xa, "y0": ya, "x1": xb, "y1": yb})
        out["segs"].append(n)
    return out, dom


# ----------------------------------------------------------------------------- driver
def analyze_page(page, truth_page=None, truth=None, verbose=True, label=""):
    rep = {}
    P = print if verbose else (lambda *a, **k: None)
    page, rot = normalize_rotation(page)
    rep["rotated_by"] = rot
    if rot:
        P(f"  sheet stored sideways: IR rotated so that text is upright (dominant text angle was {rot} deg)")
    sc = scale_from_text(page["texts"])
    declared = sc[0]["den"] if sc else None
    rep["declared_scale"] = declared
    P(f"  declared scale (text): {[(c['den'], c['kw'], c['text'][:28]) for c in sc]}")
    cd = calibrate_dims(page, declared)
    rep["dims"] = {k: v for k, v in cd.items() if k not in ("obs", "per_unit")}
    if cd["n"]:
        P(f"  dimension self-calibration: {cd['n']} text<->interval pairs, integers read as {cd['unit_for_integers']}, "
          f"{cd['inliers']} inliers -> 1:{cd['den']:.2f}  (inlier spread {cd['spread_pct']:.3f} %)")
        P("     per unit hypothesis: " + ", ".join(f"{u}: 1:{r['median_den']:.1f} ({r['inliers']}/{r['n']})" for u, r in cd["per_unit"].items()))
    den = cd["den"] if cd.get("n") else declared
    rep["rooms"], rep["views"], rep["levels"], rep["north"] = [], [], levels_from_section(page["texts"]), None
    if den is None:
        P("  no scale available -> ask the user for ONE known length (vector snapping keeps it exact)")
        return rep
    m_per_pt = den * PT_M
    rooms, loose_areas = parse_rooms(page["texts"])
    faces, bridged, ww = wall_faces(page, m_per_pt)
    P(f"  wall stroke class: {ww} pt ; {bridged} opening gaps bridged ; {len(faces)} faces")
    ca = calibrate_areas(rooms, faces)
    rep["areas_cal"] = ca
    if ca["n"]:
        P(f"  area-label self-calibration: {ca['n']} rooms, {ca['inliers']} inliers -> 1:{ca['den']:.2f} (spread {ca['spread_pct']:.3f} %)")
    views = view_components(faces)
    rep["rooms"] = []
    for r in rooms:
        meas = r["face"].area * m_per_pt ** 2 if r.get("face") is not None else None
        rep["rooms"].append({"name": r["name"], "type": r["type"], "cls": r["cls"], "label_m2": r["area_m2"], "measured_m2": meas})
    P(f"  rooms: " + "; ".join(f"{r['name']}[{r['cls']}] label={r['label_m2']} meas={r['measured_m2'] and round(r['measured_m2'], 2)}" for r in rep["rooms"]))
    rep["views"] = []
    for vp in views:
        inside = [r for r in rooms if vp.contains(Point(r["x"], r["y"]))]
        area = vp.area * m_per_pt ** 2
        ho = heated_outline(vp, inside, faces, m_per_pt)
        rep["views"].append({"outline_m2": area, "n_rooms": len(inside), "heated_outline_m2": ho.area * m_per_pt ** 2 if ho is not None else None,
                             "poly": vp, "bbox": vp.bounds})
        P(f"  view bbox={tuple(round(b) for b in vp.bounds)} rooms={len(inside)} outline={area:.2f} m²"
          + (f" heated outline={ho.area * m_per_pt ** 2:.2f} m²" if ho is not None else ""))
    rep["closing"] = [{"poly": q, "outline_m2": q.area * m_per_pt ** 2} for q in outline_by_closing(page, m_per_pt)]
    rep["north"] = north_from_arrow(page)
    rep["levels"] = levels_from_section(page["texts"])
    P(f"  north arrow: {rep['north']} deg cw from page-up ; levels: {rep['levels']}")
    return rep


def evaluate(rep, tp, truth):
    """Compare a page report with ground truth; returns list of (metric, value) rows."""
    rows = []
    rows.append(("declared scale ok", rep.get("declared_scale") == truth["scale_den"]))
    if rep.get("dims", {}).get("n"):
        rows.append(("dim-calibrated scale error %", round(100 * (rep["dims"]["den"] / truth["scale_den"] - 1), 4)))
        ntrue = sum(len(v.get("dims", [])) for v in tp["views"])
        rows.append(("dimension texts matched", f"{rep['dims']['n']}/{ntrue} (inliers {rep['dims']['inliers']})"))
    if rep.get("areas_cal", {}).get("n"):
        rows.append(("area-calibrated scale error %", round(100 * (rep["areas_cal"]["den"] / truth["scale_den"] - 1), 4)))
    troom = [r for v in tp["views"] for r in v.get("rooms", [])]
    found = 0
    amb = 0
    cls_ok = 0
    area_err = []
    lab_ok = 0
    for tr in troom:
        m = [r for r in rep.get("rooms", []) if r["name"] == tr["name"]]
        # same name can appear twice (Flur) - match by measured area closeness
        if not m:
            continue
        found += 1
        r = min(m, key=lambda r: abs((r["measured_m2"] or 0) - tr["area_true_m2"]))
        want = "H" if tr["heated_true"] else "U"
        cls_ok += (r["cls"] == want)
        amb += (r["cls"] == "A")
        if r["measured_m2"]:
            area_err.append(100 * (r["measured_m2"] / tr["area_true_m2"] - 1))
        if tr["area_label"] is None or (r["label_m2"] is not None and abs(r["label_m2"] - round(tr["area_true_m2"], 2)) < 0.006):
            lab_ok += 1
    if troom:
        rows.append(("room names found", f"{found}/{len(troom)}"))
        rows.append(("area labels parsed", f"{lab_ok}/{len(troom)}"))
        rows.append(("heated/unheated: confident+correct / ambiguous (ask user) / wrong", f"{cls_ok}/{amb}/{len(troom) - cls_ok - amb}"))
        if area_err:
            rows.append(("room polygon area error % (max abs)", round(max(abs(e) for e in area_err), 3)))
            rows.append(("room polygons measured", f"{len(area_err)}/{len(troom)}"))
    for tv in tp["views"]:
        if "outline_area_m2" not in tv:
            continue
        # match by bbox overlap of outline
        tpoly = Polygon(tv["outline_pt"])
        best = max(rep.get("views", []), key=lambda v: v["poly"].intersection(tpoly).area, default=None)
        if best is None or best["poly"].intersection(tpoly).area == 0:
            rows.append((f"outline {tv['view']}", "NOT FOUND"))
            continue
        iou = best["poly"].intersection(tpoly).area / best["poly"].union(tpoly).area
        rows.append((f"outline {tv['view']}: m² det/true, err %, IoU",
                     f"{best['outline_m2']:.2f}/{tv['outline_area_m2']:.2f}, {100 * (best['outline_m2'] / tv['outline_area_m2'] - 1):+.3f}, {iou:.4f}"))
        bc = max(rep.get("closing", []), key=lambda v: v["poly"].intersection(tpoly).area, default=None)
        if bc is not None and bc["poly"].intersection(tpoly).area > 0:
            rows.append((f"outline(closing r=1.3m) {tv['view']}: err %, IoU",
                         f"{100 * (bc['outline_m2'] / tv['outline_area_m2'] - 1):+.3f}, {bc['poly'].intersection(tpoly).area / bc['poly'].union(tpoly).area:.4f}"))
        if best.get("heated_outline_m2"):
            rows.append((f"heated outline {tv['view']}: det/true, err %",
                         f"{best['heated_outline_m2']:.2f}/{tv['heated_outline_area_m2']:.2f}, {100 * (best['heated_outline_m2'] / tv['heated_outline_area_m2'] - 1):+.3f}"))
    if any("levels_m" in v for v in tp["views"]):
        tv = [v for v in tp["views"] if "levels_m" in v][0]
        rows.append(("section levels ok", rep["levels"]["levels"] == tv["levels_m"]))
        rows.append(("clear heights found", rep["levels"]["clear_heights"]))
    return rows


if __name__ == "__main__":
    ir = json.load(open(sys.argv[1]))
    truth = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else None
    print(f"=== {ir['file']} via {ir['backend']} (extraction {ir['seconds']} s)")
    north_done = False
    for i, page in enumerate(ir["pages"]):
        print(f"- page {i + 1}")
        rep = analyze_page(page)
        if truth:
            rows = evaluate(rep, truth["pages"][i], truth)
            if rep.get("north") is not None:
                rows.append(("north error deg", round(rep["north"] - truth["north_cw_from_up_deg"], 2)))
            for k, v in rows:
                print(f"    EVAL {k}: {v}")
