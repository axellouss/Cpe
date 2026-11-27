"""Build REALISTIC architectural floor-plan DXF fixtures with ezdxf (+ shapely for the wall linework).

Generated files (in <outdir>):
  fixture_rdc_cm.dxf        ground floor, drawing unit cm ($INSUNITS=5), French layers (MUR, FENETRE, PORTE ...), DXF R2010 (UTF-8)
  fixture_etage_mm.dxf      first floor, drawing unit mm ($INSUNITS=4), German layers (Wand, Fenster, Tuer ...), DXF R2000 (cp1252),
                            wall hatch, fixed-size window blocks without attributes
  fixture_2storeys_aia.dxf  both storeys side by side in ONE model space, $INSUNITS=0 (unitless, cm), AIA layers (A-WALL, A-GLAZ ...)
  fixture_truth.json        ground truth (rooms, areas, openings, orientations) used to score the extractor

Walls are drawn the way architects draw them: double lines (LINE / open LWPOLYLINE), interrupted at openings, with jamb lines.
Deliberate real-world defects: tiny endpoint gaps, an overshoot, duplicated line, split collinear lines, mirrored door blocks,
title-block frame around the drawing, furniture / stairs / axis layers, label variants (TEXT, MTEXT, two TEXTs, "m2", "qm").

usage: python make_fixture.py <outdir>
"""
import json
import math
import os
import sys

import ezdxf
from ezdxf import units
from ezdxf.enums import TextEntityAlignment
from shapely.geometry import box
from shapely.ops import unary_union

NORTH_ROT_DEG = -20.0  # rotation of the north-arrow insert (CCW positive): north points 20 deg clockwise from +Y

# ----------------------------------------------------------------------------------------------------------------------
# Plan definition, all numbers in cm, origin = outer SW corner of the house
# ----------------------------------------------------------------------------------------------------------------------
T_EXT = 40  # exterior wall thickness
T_GAR = 24  # garage wall thickness
T_INT = 15  # partition thickness

RDC = {
    "title": {"fr": "PLAN DU REZ-DE-CHAUSSEE", "de": "GRUNDRISS ERDGESCHOSS"},
    "footprints": [(0, 0, 1000, 800), (1000, 0, 1400, 400)],  # house + attached (unheated) garage
    # name key, x0, y0, x1, y1 (clear room rectangle between wall faces), heated?
    "rooms": [
        ("sejour", 40, 40, 555, 760, True),
        ("cuisine", 570, 40, 960, 330, True),
        ("hall", 570, 345, 960, 560, True),
        ("wc", 570, 575, 700, 760, True),
        ("buanderie", 715, 575, 960, 760, True),
        ("garage", 1000, 24, 1376, 376, False),
    ],
    # id, centre x, centre y, width, wall direction (h = wall runs along X, v = along Y), wall thickness, height, sill
    "windows": [
        ("F1", 300, 20, 240, "h", T_EXT, 215, 0),
        ("F2", 765, 20, 120, "h", T_EXT, 135, 90),
        ("F3", 20, 400, 160, "v", T_EXT, 135, 90),
        ("F4", 300, 780, 120, "h", T_EXT, 135, 90),
        ("F5", 635, 780, 60, "h", T_EXT, 75, 150),
        ("F6", 837, 780, 80, "h", T_EXT, 135, 90),
    ],
    # id, centre x, centre y, width, wall dir, thickness, mirrored?, kind
    "doors": [
        ("P1", 980, 480, 100, "v", T_EXT, False, "entree"),  # entrance door in the east facade (north of the garage)
        ("P2", 562.5, 450, 90, "v", T_INT, False, "int"),  # sejour <-> hall
        ("P3", 562.5, 185, 90, "v", T_INT, True, "int"),  # sejour <-> cuisine
        ("P4", 800, 337.5, 80, "h", T_INT, False, "int"),  # hall <-> cuisine
        ("P5", 635, 567.5, 70, "h", T_INT, True, "int"),  # hall <-> wc
        ("P6", 840, 567.5, 80, "h", T_INT, False, "int"),  # hall <-> buanderie
        ("P7", 980, 200, 90, "v", T_EXT, False, "int"),  # cuisine <-> garage (heated -> unheated)
    ],
    # plain openings drawn WITHOUT a block (garage sectional door drawn as a dashed line)
    "plain_openings": [("PG", 1188, 12, 250, "h", T_GAR)],
}

ETAGE = {
    "title": {"fr": "PLAN DE L'ETAGE", "de": "GRUNDRISS OBERGESCHOSS"},
    "footprints": [(0, 0, 1000, 800)],
    "rooms": [
        ("chambre1", 40, 40, 480, 400, True),
        ("chambre2", 495, 40, 960, 400, True),
        ("couloir", 40, 415, 960, 540, True),
        ("chambre3", 40, 555, 420, 760, True),
        ("bain", 435, 555, 700, 760, True),
        ("bureau", 715, 555, 960, 760, True),
    ],
    "windows": [
        ("F1", 260, 20, 140, "h", T_EXT, 135, 90),
        ("F2", 727, 20, 140, "h", T_EXT, 135, 90),
        ("F3", 980, 220, 100, "v", T_EXT, 135, 90),
        ("F4", 20, 477, 80, "v", T_EXT, 135, 90),
        ("F5", 230, 780, 120, "h", T_EXT, 135, 90),
        ("F6", 567, 780, 80, "h", T_EXT, 100, 125),
        ("F7", 837, 780, 100, "h", T_EXT, 135, 90),
    ],
    "doors": [
        ("P1", 260, 407.5, 80, "h", T_INT, False, "int"),
        ("P2", 727, 407.5, 80, "h", T_INT, True, "int"),
        ("P3", 230, 547.5, 80, "h", T_INT, False, "int"),
        ("P4", 567, 547.5, 70, "h", T_INT, True, "int"),
        ("P5", 837, 547.5, 80, "h", T_INT, False, "int"),
    ],
    "plain_openings": [],
}

NAMES = {
    "fr": {"sejour": "Séjour", "cuisine": "Cuisine", "hall": "Hall", "wc": "WC", "buanderie": "Buanderie", "garage": "Garage",
           "chambre1": "Chambre 1", "chambre2": "Chambre 2", "couloir": "Dégagement", "chambre3": "Chambre 3",
           "bain": "Salle de bain", "bureau": "Bureau"},
    "de": {"sejour": "Wohnzimmer", "cuisine": "Küche", "hall": "Diele", "wc": "WC", "buanderie": "Waschküche", "garage": "Garage",
           "chambre1": "Schlafzimmer 1", "chambre2": "Schlafzimmer 2", "couloir": "Flur", "chambre3": "Kinderzimmer",
           "bain": "Bad", "bureau": "Büro"},
}

LAYERS = {
    "fr": {"wall": "MUR", "window": "FENETRE", "door": "PORTE", "text": "TEXTE", "dim": "COTATION", "furn": "MOBILIER",
           "stair": "ESCALIER", "axis": "AXES", "frame": "CARTOUCHE", "hatch": "MUR-HACHURE", "north": "SYMBOLES"},
    "de": {"wall": "Wand", "window": "Fenster", "door": "Tuer", "text": "Text_Raum", "dim": "Bemassung", "furn": "Moebel",
           "stair": "Treppe", "axis": "Achsen", "frame": "Plankopf", "hatch": "Wand_Schraffur", "north": "Symbole"},
    "aia": {"wall": "A-WALL", "window": "A-GLAZ", "door": "A-DOOR", "text": "A-AREA-IDEN", "dim": "A-ANNO-DIMS",
            "furn": "A-FURN", "stair": "A-FLOR-STRS", "axis": "S-GRID", "frame": "A-ANNO-TTLB", "hatch": "A-WALL-PATT",
            "north": "A-ANNO-SYMB"},
}
COLORS = {"wall": 7, "window": 4, "door": 3, "text": 2, "dim": 1, "furn": 8, "stair": 9, "axis": 6, "frame": 7, "hatch": 8,
          "north": 7}


def fmt_area(a_m2, lang, style):
    s = f"{a_m2:.2f}".replace(".", ",")
    return {0: f"{s} m²", 1: f"{s} m2", 2: f"S = {s} m²", 3: f"{s} qm", 4: f"{s}m²"}[style]


def opening_rect(cx, cy, w, direction, t):
    if direction == "h":
        return box(cx - w / 2, cy - t / 2, cx + w / 2, cy + t / 2)
    return box(cx - t / 2, cy - w / 2, cx + t / 2, cy + w / 2)


def ring_segments(geom):
    """yield straight segments (p, q) of all boundary rings of a (multi)polygon, collinear vertices removed"""
    polys = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
    for poly in polys:
        for ring in [poly.exterior, *poly.interiors]:
            pts = list(ring.simplify(0).coords)
            for a, b in zip(pts[:-1], pts[1:]):
                yield a, b


def setup_doc(version, lang, insunits):
    doc = ezdxf.new(version, setup=True)
    doc.units = insunits
    doc.header["$MEASUREMENT"] = 1
    doc.header["$LUNITS"] = 2
    L = LAYERS[lang]
    for key, name in L.items():
        doc.layers.add(name, color=COLORS[key])
    if "DASHED" not in doc.linetypes:
        doc.linetypes.add("DASHED", pattern=[0.6, 0.5, -0.1])
    return doc, L


def define_blocks(doc, L, uf, lang, fixed_windows, plans):
    """uf = drawing units per cm"""
    th = 10 * uf
    # --- parametric unit window (width 100 cm x thickness 1 unit); scaled by xscale = w/100, yscale = wall thickness
    if not fixed_windows:
        b = doc.blocks.new("FENETRE")
        w = 100 * uf
        b.add_lwpolyline([(-w / 2, -0.5), (w / 2, -0.5), (w / 2, 0.5), (-w / 2, 0.5)], close=True, dxfattribs={"layer": "0"})
        b.add_line((-w / 2, -0.08), (w / 2, -0.08), dxfattribs={"layer": "0"})
        b.add_line((-w / 2, 0.08), (w / 2, 0.08), dxfattribs={"layer": "0"})
        for i, tag in enumerate(["REF", "LARG", "HAUT", "ALLEGE"]):
            b.add_attdef(tag, (0, 1.2 + i), dxfattribs={"height": 0.5, "layer": "0", "flags": 0 if tag == "REF" else 1})
    else:
        for plan in plans:
            for (wid, cx, cy, w, d, t, h, sill) in plan["windows"]:
                name = f"Fenster {w / 100:.2f}x{h / 100:.2f}".replace(".", ",")
                if name in doc.blocks:
                    continue
                b = doc.blocks.new(name)
                W, T = w * uf, t * uf
                b.add_lwpolyline([(-W / 2, -T / 2), (W / 2, -T / 2), (W / 2, T / 2), (-W / 2, T / 2)], close=True, dxfattribs={"layer": "0"})
                b.add_line((-W / 2, -2 * uf), (W / 2, -2 * uf), dxfattribs={"layer": "0"})
                b.add_line((-W / 2, 2 * uf), (W / 2, 2 * uf), dxfattribs={"layer": "0"})
    # --- doors: hinge at origin, opening along +X, leaf along +Y, quarter-circle swing; no threshold line (gap stays open!)
    prefix = "PORTE" if lang != "de" else "Tuer"
    for w in (70, 80, 90, 100):
        b = doc.blocks.new(f"{prefix}_{w}")
        W = w * uf
        b.add_line((0, 0), (0, W), dxfattribs={"layer": "0"})
        b.add_arc((0, 0), W, 0, 90, dxfattribs={"layer": "0"})
    # --- north arrow, pointing to +Y in block coordinates
    b = doc.blocks.new("NORD" if lang != "de" else "Nordpfeil")
    s = 60 * uf
    b.add_lwpolyline([(0, s), (-0.25 * s, 0), (0, 0.2 * s), (0.25 * s, 0)], close=True)
    b.add_circle((0, 0.4 * s), 0.65 * s)
    b.add_text("N", height=0.3 * s).set_placement((0, 1.15 * s), align=TextEntityAlignment.BOTTOM_CENTER)
    # --- furniture noise
    b = doc.blocks.new("LIT_160" if lang != "de" else "Bett_160")
    b.add_lwpolyline([(0, 0), (160 * uf, 0), (160 * uf, 200 * uf), (0, 200 * uf)], close=True)
    b.add_line((0, 160 * uf), (160 * uf, 160 * uf))
    return prefix


def draw_plan(doc, msp, plan, L, lang, uf, ox, oy, fixed_windows, door_prefix, label_styles, with_hatch, defects, truth_out,
              floor_id):
    """draw one storey; (ox, oy) = position of the plan origin in drawing units"""

    def P(x, y):
        return (ox + x * uf, oy + y * uf)

    foot = unary_union([box(*f) for f in plan["footprints"]])
    rooms = unary_union([box(r[1], r[2], r[3], r[4]) for r in plan["rooms"]])
    openings = [opening_rect(cx, cy, w, d, t) for (_, cx, cy, w, d, t, *_r) in plan["windows"]]
    openings += [opening_rect(cx, cy, w, d, t) for (_, cx, cy, w, d, t, *_r) in plan["doors"]]
    openings += [opening_rect(cx, cy, w, d, t) for (_, cx, cy, w, d, t) in plan["plain_openings"]]
    walls = foot.difference(rooms).difference(unary_union(openings))

    segs = list(ring_segments(walls))
    n_lines = 0
    # --- deliberate drafting defects (indices are stable because shapely output is deterministic)
    applied = []
    for i, (a, b) in enumerate(segs):
        layer = L["wall"]
        a2, b2 = a, b
        if defects:
            if i == 5:  # endpoint does not quite reach the corner (0.3 cm gap)
                dx, dy = b[0] - a[0], b[1] - a[1]
                ln = math.hypot(dx, dy)
                b2 = (b[0] - 0.3 * dx / ln, b[1] - 0.3 * dy / ln)
                applied.append(("gap_0.3cm", i))
            if i == 11:  # overshoot by 0.5 cm
                dx, dy = b[0] - a[0], b[1] - a[1]
                ln = math.hypot(dx, dy)
                b2 = (b[0] + 0.5 * dx / ln, b[1] + 0.5 * dy / ln)
                applied.append(("overshoot_0.5cm", i))
            if i == 17:  # duplicated line
                msp.add_line(P(*a), P(*b), dxfattribs={"layer": layer})
                applied.append(("duplicate", i))
            if i == 23:  # split into two collinear lines with a 0.05 cm offset at the joint
                mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
                msp.add_line(P(*a), P(mx, my), dxfattribs={"layer": layer})
                msp.add_line(P(mx + 0.05, my + 0.05), P(*b), dxfattribs={"layer": layer})
                applied.append(("split_collinear", i))
                n_lines += 2
                continue
            if i == 29:  # wall line drawn on layer "0" by mistake
                layer = "0"
                applied.append(("wrong_layer_0", i))
        if i % 7 == 3:  # some wall pieces are open LWPOLYLINEs instead of LINEs
            msp.add_lwpolyline([P(*a2), P(*b2)], dxfattribs={"layer": layer})
        else:
            msp.add_line(P(*a2), P(*b2), dxfattribs={"layer": layer})
        n_lines += 1

    # --- wall hatch (ANSI31) with polyline boundary paths
    if with_hatch:
        polys = walls.geoms if walls.geom_type == "MultiPolygon" else [walls]
        for poly in polys:
            h = msp.add_hatch(color=8, dxfattribs={"layer": L["hatch"]})
            h.set_pattern_fill("ANSI31", scale=20 * uf)
            h.paths.add_polyline_path([P(*c) for c in poly.exterior.coords[:-1]], is_closed=True, flags=1)
            for hole in poly.interiors:
                h.paths.add_polyline_path([P(*c) for c in hole.coords[:-1]], is_closed=True, flags=0)

    # --- windows
    for (wid, cx, cy, w, d, t, h, sill) in plan["windows"]:
        rot = 0 if d == "h" else 90
        if fixed_windows:
            name = f"Fenster {w / 100:.2f}x{h / 100:.2f}".replace(".", ",")
            msp.add_blockref(name, P(cx, cy), dxfattribs={"layer": L["window"], "rotation": rot})
        else:
            ref = msp.add_blockref("FENETRE", P(cx, cy), dxfattribs={"layer": L["window"], "rotation": rot, "xscale": w / 100.0, "yscale": t * uf})
            ref.add_auto_attribs({"REF": wid, "LARG": str(w), "HAUT": str(h), "ALLEGE": str(sill)})

    # --- doors (mirrored ones use a negative x scale)
    for (did, cx, cy, w, d, t, mirrored, kind) in plan["doors"]:
        if d == "h":
            hinge = (cx - w / 2, cy - t / 2) if not mirrored else (cx + w / 2, cy - t / 2)
            rot = 0
        else:
            hinge = (cx + t / 2, cy - w / 2) if not mirrored else (cx + t / 2, cy + w / 2)
            rot = 90
        attribs = {"layer": L["door"], "rotation": rot}
        if mirrored:
            attribs["xscale"] = -1
        msp.add_blockref(f"{door_prefix}_{w}", P(*hinge), dxfattribs=attribs)
        if kind == "entree":  # threshold lines on both wall faces
            r = opening_rect(cx, cy, w, d, t)
            x0, y0, x1, y1 = r.bounds
            if d == "v":
                msp.add_line(P(x1, y0), P(x1, y1), dxfattribs={"layer": L["door"]})
            else:
                msp.add_line(P(x0, y0), P(x1, y0), dxfattribs={"layer": L["door"]})

    # --- plain openings (garage door = one dashed line, no block)
    for (oid, cx, cy, w, d, t) in plan["plain_openings"]:
        msp.add_line(P(cx - w / 2, cy), P(cx + w / 2, cy), dxfattribs={"layer": L["door"], "linetype": "DASHED"})

    # --- room labels, several real-world notations
    th = 12 * uf
    for k, (key, x0, y0, x1, y1, heated) in enumerate(plan["rooms"]):
        area = (x1 - x0) * (y1 - y0) / 1e4
        name = NAMES[lang][key]
        style = label_styles[k % len(label_styles)]
        cxr, cyr = (x0 + x1) / 2, (y0 + y1) / 2
        stated = area
        if key == "cuisine":
            stated = area + 0.85  # label not updated after a design change: stated area differs from geometry
        if style == "text1":
            msp.add_text(f"{name} {fmt_area(stated, lang, 0)}", height=th, dxfattribs={"layer": L["text"]}).set_placement(P(cxr, cyr), align=TextEntityAlignment.MIDDLE_CENTER)
        elif style == "mtext2":
            m = msp.add_mtext(f"{name}\\P{fmt_area(stated, lang, 0)}", dxfattribs={"layer": L["text"], "char_height": th, "attachment_point": 5})
            m.set_location(P(cxr, cyr))
        elif style == "two_texts":
            msp.add_text(name, height=th, dxfattribs={"layer": L["text"]}).set_placement(P(cxr, cyr + 10), align=TextEntityAlignment.MIDDLE_CENTER)
            msp.add_text(fmt_area(stated, lang, 2 if lang != "de" else 3), height=th * 0.8, dxfattribs={"layer": L["text"]}).set_placement(P(cxr, cyr - 10), align=TextEntityAlignment.MIDDLE_CENTER)
        elif style == "mtext_fmt":  # inline formatting codes + m2
            m = msp.add_mtext("{\\fArial|b1|i0|c0|p34;" + name + "}\\P" + fmt_area(stated, lang, 1), dxfattribs={"layer": L["text"], "char_height": th, "attachment_point": 5})
            m.set_location(P(cxr, cyr))
        elif style == "name_only":
            msp.add_text(name, height=th, dxfattribs={"layer": L["text"]}).set_placement(P(cxr, cyr), align=TextEntityAlignment.MIDDLE_CENTER)
            stated = None
        truth_out["rooms"].append({"floor": floor_id, "key": key, "name": name, "area_m2": round(area, 4),
                                   "stated_m2": None if stated is None else round(stated, 2), "heated": heated,
                                   "centroid_cm": [cxr, cyr]})

    # --- dimensions: overall + chain along the south facade (opening edges)
    xs = sorted({0.0, 1000.0, *[c for (_, cx, cy, w, d, t, *_r) in plan["windows"] if d == "h" and cy < 100 for c in (cx - w / 2, cx + w / 2)]})
    ov = {"dimtxt": 10 * uf, "dimasz": 6 * uf, "dimexe": 5 * uf, "dimexo": 5 * uf, "dimgap": 3 * uf, "dimdec": 0, "dimtad": 1, "dimlfac": 1}
    for a, b in zip(xs[:-1], xs[1:]):
        msp.add_linear_dim(base=P(0, -80), p1=P(a, 0), p2=P(b, 0), dimstyle="EZDXF", override=ov, dxfattribs={"layer": L["dim"]}).render()
    msp.add_linear_dim(base=P(0, -130), p1=P(0, 0), p2=P(1000, 0), dimstyle="EZDXF", override=ov, dxfattribs={"layer": L["dim"]}).render()
    msp.add_linear_dim(base=P(-100, 0), p1=P(0, 0), p2=P(0, 800), angle=90, dimstyle="EZDXF", override=ov, dxfattribs={"layer": L["dim"]}).render()
    # one dimension with a manual text override that contradicts the geometry (classic "fudged" dimension)
    msp.add_linear_dim(base=P(0, 880), p1=P(0, 800), p2=P(1000, 800), text="10.00", dimstyle="EZDXF", override=ov, dxfattribs={"layer": L["dim"]}).render()

    # --- noise: furniture, stairs, axes
    key0 = plan["rooms"][0]
    msp.add_blockref("LIT_160" if lang != "de" else "Bett_160", P(key0[1] + 30, key0[2] + 30), dxfattribs={"layer": L["furn"]})
    msp.add_lwpolyline([P(key0[1] + 250, key0[2] + 300), P(key0[1] + 430, key0[2] + 300), P(key0[1] + 430, key0[2] + 390), P(key0[1] + 250, key0[2] + 390)], close=True, dxfattribs={"layer": L["furn"]})
    msp.add_circle(P(key0[1] + 340, key0[2] + 500), 45 * uf, dxfattribs={"layer": L["furn"]})
    sx0, sy0 = (key0[3] - 100, key0[2] + 20)
    for i in range(14):  # stair treads: 14 closed-looking strips that must NOT become rooms
        msp.add_line(P(sx0, sy0 + i * 25), P(sx0 + 95, sy0 + i * 25), dxfattribs={"layer": L["stair"]})
    msp.add_line(P(sx0, sy0), P(sx0, sy0 + 13 * 25), dxfattribs={"layer": L["stair"]})
    for xg in (20, 562.5, 980):
        msp.add_line(P(xg, -200), P(xg, 1000), dxfattribs={"layer": L["axis"], "linetype": "DASHED"})
    for yg in (20, 780):
        msp.add_line(P(-200, yg), P(1600, yg), dxfattribs={"layer": L["axis"], "linetype": "DASHED"})

    # --- title under the plan
    msp.add_text(plan["title"]["de" if lang == "de" else "fr"], height=25 * uf, dxfattribs={"layer": L["frame"]}).set_placement(P(0, -220), align=TextEntityAlignment.LEFT)
    msp.add_text("Echelle 1:50" if lang != "de" else "Maßstab 1:50", height=15 * uf, dxfattribs={"layer": L["frame"]}).set_placement(P(0, -260), align=TextEntityAlignment.LEFT)

    # --- ground truth for openings
    def wall_normal_out(cx, cy, d):
        # outward normal for openings in the exterior wall of the 1000 x 800 house
        if d == "h":
            return (0, -1) if cy < 400 else (0, 1)
        return (-1, 0) if cx < 500 else (1, 0)

    def azimuth(n):
        bearing = math.degrees(math.atan2(n[0], n[1])) % 360  # clockwise from +Y
        north_bearing = (-NORTH_ROT_DEG) % 360
        return (bearing - north_bearing) % 360

    for (wid, cx, cy, w, d, t, h, sill) in plan["windows"]:
        n = wall_normal_out(cx, cy, d)
        truth_out["windows"].append({"floor": floor_id, "id": wid, "width_cm": w, "height_cm": h, "centre_cm": [cx, cy],
                                     "azimuth_deg": round(azimuth(n), 1), "exterior": True})
    for (did, cx, cy, w, d, t, mirrored, kind) in plan["doors"]:
        ext = kind == "entree"
        rec = {"floor": floor_id, "id": did, "width_cm": w, "centre_cm": [cx, cy], "exterior": ext, "kind": kind}
        if ext:
            rec["azimuth_deg"] = round(azimuth(wall_normal_out(cx, cy, d)), 1)
        truth_out["doors"].append(rec)
    heated = unary_union([box(r[1], r[2], r[3], r[4]) for r in plan["rooms"] if r[5]])
    house = box(0, 0, 1000, 800)
    truth_out["floors"].append({"floor": floor_id, "footprint_all_m2": foot.area / 1e4, "footprint_all_perimeter_m": foot.length / 100,
                                "heated_gross_m2": house.area / 1e4, "heated_gross_perimeter_m": house.length / 100,
                                "heated_net_m2": round(heated.area / 1e4, 4), "wall_segments": n_lines, "defects": applied})


def add_frame_and_north(doc, msp, L, lang, uf, bounds, north_at):
    x0, y0, x1, y1 = bounds
    msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True, dxfattribs={"layer": L["frame"]})
    msp.add_lwpolyline([(x1 - 700 * uf, y0), (x1, y0), (x1, y0 + 220 * uf), (x1 - 700 * uf, y0 + 220 * uf)], close=True, dxfattribs={"layer": L["frame"]})
    msp.add_text("Maison unifamiliale - Projet TEST" if lang != "de" else "Einfamilienhaus - Projekt TEST", height=20 * uf, dxfattribs={"layer": L["frame"]}).set_placement((x1 - 680 * uf, y0 + 150 * uf))
    msp.add_blockref("NORD" if lang != "de" else "Nordpfeil", north_at, dxfattribs={"layer": L["north"], "rotation": NORTH_ROT_DEG})


def add_paperspace(doc, uf, view_center, name):
    """A3 landscape sheet in mm with one viewport at 1:50"""
    psp = doc.layouts.new(name)
    scale = 50.0
    paper_w, paper_h = 380.0, 250.0
    mm_per_unit = 10.0 / uf  # mm of real world per drawing unit
    view_height = paper_h * scale / mm_per_unit  # model units shown in the viewport height
    psp.add_viewport(center=(210, 148.5), size=(paper_w, paper_h), view_center_point=view_center, view_height=view_height)
    psp.add_text("1:50", height=5).set_placement((350, 15))


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    truth = {"north_bearing_deg_clockwise_from_plusY": (-NORTH_ROT_DEG) % 360, "files": {}}

    # ---- file 1: ground floor, cm, French, R2010
    t = {"rooms": [], "windows": [], "doors": [], "floors": []}
    doc, L = setup_doc("R2010", "fr", units.CM)
    msp = doc.modelspace()
    uf, ox, oy = 1.0, 12500.0, 8300.0
    pre = define_blocks(doc, L, uf, "fr", False, [RDC])
    draw_plan(doc, msp, RDC, L, "fr", uf, ox, oy, False, pre, ["text1", "mtext2", "two_texts", "mtext_fmt", "text1", "text1"], False, True, t, "RDC")
    add_frame_and_north(doc, msp, L, "fr", uf, (ox - 400, oy - 400, ox + 1900, oy + 1150), (ox + 1600, oy + 850))
    add_paperspace(doc, uf, (ox + 700, oy + 400), "A3 1-50")
    p = os.path.join(outdir, "fixture_rdc_cm.dxf")
    doc.saveas(p)
    truth["files"]["fixture_rdc_cm.dxf"] = {"unit": "cm", "units_per_m": 100, "origin": [ox, oy], **t}

    # ---- file 2: first floor, mm, German, R2000 (cp1252), hatch, fixed-size window blocks
    t = {"rooms": [], "windows": [], "doors": [], "floors": []}
    doc, L = setup_doc("R2000", "de", units.MM)
    msp = doc.modelspace()
    uf, ox, oy = 10.0, -35000.0, 120000.0
    pre = define_blocks(doc, L, uf, "de", True, [ETAGE])
    draw_plan(doc, msp, ETAGE, L, "de", uf, ox, oy, True, pre, ["mtext2", "text1", "two_texts", "text1", "two_texts", "name_only"], True, True, t, "ETAGE")
    add_frame_and_north(doc, msp, L, "de", uf, (ox - 4000, oy - 4000, ox + 15000, oy + 11500), (ox + 12500, oy + 8500))
    add_paperspace(doc, uf, (ox + 5000, oy + 4000), "A3 1-50")
    p = os.path.join(outdir, "fixture_etage_mm.dxf")
    doc.saveas(p)
    truth["files"]["fixture_etage_mm.dxf"] = {"unit": "mm", "units_per_m": 1000, "origin": [ox, oy], **t}

    # ---- file 3: both storeys in one model space, unitless ($INSUNITS=0) cm, AIA layers, no defects
    t = {"rooms": [], "windows": [], "doors": [], "floors": []}
    doc, L = setup_doc("R2013", "aia", units.CM)
    doc.header["$INSUNITS"] = 0
    msp = doc.modelspace()
    uf = 1.0
    pre = define_blocks(doc, L, uf, "aia", False, [RDC, ETAGE])
    draw_plan(doc, msp, RDC, L, "fr", uf, 0.0, 0.0, False, pre, ["text1", "mtext2", "two_texts", "text1", "text1", "text1"], False, False, t, "RDC")
    draw_plan(doc, msp, ETAGE, L, "fr", uf, 2200.0, 0.0, False, pre, ["mtext2", "text1", "text1", "two_texts", "text1", "text1"], False, False, t, "ETAGE")
    add_frame_and_north(doc, msp, L, "aia", uf, (-400, -400, 3700, 1150), (1650, 900))
    add_paperspace(doc, uf, (1600, 400), "A1 1-50")
    p = os.path.join(outdir, "fixture_2storeys_aia.dxf")
    doc.saveas(p)
    truth["files"]["fixture_2storeys_aia.dxf"] = {"unit": "cm (header says unitless)", "units_per_m": 100, "origins": {"RDC": [0, 0], "ETAGE": [2200, 0]}, **t}

    with open(os.path.join(outdir, "fixture_truth.json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, indent=1, ensure_ascii=False)
    for name in sorted(os.listdir(outdir)):
        print(name, os.path.getsize(os.path.join(outdir, name)), "bytes")


if __name__ == "__main__":
    main(sys.argv[1])
