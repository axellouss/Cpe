"""Score the extractor against fixture_truth.json, on the fixtures and on deliberately degraded variants of them.

Variants (made with ezdxf from fixture_rdc_cm.dxf / fixture_etage_mm.dxf):
  base          unchanged
  no_jambs      wall lines stop at the openings, the short jamb lines are deleted
  rotated17     whole drawing rotated by 17 degrees (nothing axis-aligned any more)
  anon_layers   all layers renamed to meaningless names (Calque1..n) -> no name heuristics possible
  exploded      every block insert exploded into plain lines/arcs (no INSERT, no attributes)
  walls_through wall faces drawn through the window openings (no gap in the wall at windows)
  one_block     the whole plan wrapped into ONE block inserted with scale 1 (typical bound xref)
  no_units      $INSUNITS = 0
  gaps_3cm      30 % of the wall line ends pulled back by 3 cm (beyond the 1 cm snapping tolerance)

usage: python test_variants.py <fixture_dir> <work_dir>
"""
import json
import math
import os
import random
import sys

import ezdxf
from ezdxf.math import Matrix44

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_plan as X  # noqa: E402


def score(res, truth):
    """returns dict of metrics"""
    t_rooms = {r["name"]: r for r in truth["rooms"]}
    rooms = [r for p in res["plans"] for r in p["rooms"]]
    found = {r["name"]: r for r in rooms if r["name"] in t_rooms}
    area_ok = sum(1 for n, r in found.items() if abs(r["area_m2"] - t_rooms[n]["area_m2"]) <= 0.02)
    ops = [o for p in res["plans"] for o in p["openings"]]
    t_win = sorted((w["width_cm"] / 100, X.sector(w["azimuth_deg"])) for w in truth["windows"])
    g_win = sorted((round(o["width_m"], 2), o.get("orientation")) for o in ops if o["type"] == "window" and o["exterior"])
    win_ok = len(_multiset_and(t_win, g_win))
    # windows found regardless of type classification (exterior opening with the right width + orientation)
    g_any = sorted((round(o["width_m"], 2), o.get("orientation")) for o in ops if o["exterior"])
    win_any = len(_multiset_and(t_win, g_any))
    t_doors = sorted(d["width_cm"] / 100 for d in truth["doors"])
    g_doors = sorted(round(o["width_m"], 2) for o in ops if o["type"] == "door")
    door_ok = len(_multiset_and(t_doors, g_doors))
    hg = [p.get("heated_gross_area_m2") for p in res["plans"]]
    t_hg = [f["heated_gross_m2"] for f in truth["floors"]]
    hg_ok = sum(1 for a in t_hg if any(b is not None and abs(a - b) <= 0.1 for b in hg))
    return {
        "unit": res["units"]["unit"],
        "wall_layers": res["layers"]["mapping"].get("wall"),
        "plans": f"{len(res['plans'])}/{len(truth['floors'])}",
        "rooms_named": f"{len(found)}/{len(t_rooms)}",
        "room_area_ok": f"{area_ok}/{len(t_rooms)}",
        "ext_windows_typed": f"{win_ok}/{len(t_win)}",
        "ext_openings_any": f"{win_any}/{len(t_win)}",
        "doors": f"{door_ok}/{len(t_doors)}",
        "heated_gross_ok": f"{hg_ok}/{len(t_hg)}",
        "warnings": len(res["warnings"]),
    }


def _multiset_and(a, b):
    b = list(b)
    out = []
    for x in a:
        if x in b:
            b.remove(x)
            out.append(x)
    return out


# ------------------------------------------------------------------ variants
def v_base(doc, meta):
    pass


def v_no_jambs(doc, meta):
    msp = doc.modelspace()
    wall = meta["wall_layer"]
    lim = 0.45 * meta["upm"]
    for e in list(msp.query(f'LINE LWPOLYLINE[layer=="{wall}"]')):
        if e.dxftype() == "LINE":
            a, b = e.dxf.start, e.dxf.end
        else:
            pts = e.get_points("xy")
            a, b = ezdxf.math.Vec3(pts[0]), ezdxf.math.Vec3(pts[-1])
        ln = (b - a).magnitude / meta["upm"] * 100
        if any(abs(ln - th) < 0.7 for th in (15, 24, 40)):
            msp.delete_entity(e)


def v_rotated(doc, meta):
    m = Matrix44.z_rotate(math.radians(17))
    for e in doc.modelspace():
        try:
            e.transform(m)
        except Exception:
            pass


def v_anon_layers(doc, meta):
    names = [l.dxf.name for l in doc.layers if l.dxf.name not in ("0", "Defpoints")]
    random.Random(4).shuffle(names)
    for i, n in enumerate(names):
        doc.layers.get(n).rename(f"Calque{i + 1}")


def v_exploded(doc, meta):
    msp = doc.modelspace()
    for ins in list(msp.query("INSERT")):
        layer = ins.dxf.layer
        for e in ins.explode():  # AutoCAD moves layer-0 block content to the layer of the exploded reference
            if e.dxf.layer == "0":
                e.dxf.layer = layer


def v_walls_through(doc, meta):
    """draw the two wall faces across every window opening (as if the wall had never been cut)"""
    msp = doc.modelspace()
    win = meta["window_layer"]
    wall = meta["wall_layer"]
    for ins in msp.query(f'INSERT[layer=="{win}"]'):
        pts = []
        for v in ins.virtual_entities():
            if v.dxftype() == "LWPOLYLINE":
                pts = [ezdxf.math.Vec3(p) for p in v.get_points("xy")]
        if len(pts) == 4:
            msp.add_line(pts[0], pts[1], dxfattribs={"layer": wall})
            msp.add_line(pts[2], pts[3], dxfattribs={"layer": wall})


def v_one_block(doc, meta):
    msp = doc.modelspace()
    blk = doc.blocks.new("XREF_PLAN$0$")
    for e in list(msp):
        msp.unlink_entity(e)
        blk.add_entity(e)
    msp.add_blockref("XREF_PLAN$0$", (0, 0))


def v_no_units(doc, meta):
    doc.header["$INSUNITS"] = 0


def v_gaps(doc, meta):
    rnd = random.Random(7)
    wall = meta["wall_layer"]
    g = 0.03 * meta["upm"]
    for e in doc.modelspace().query(f'LINE[layer=="{wall}"]'):
        if rnd.random() < 0.3:
            a, b = e.dxf.start, e.dxf.end
            d = (b - a)
            if d.magnitude > 10 * g:
                e.dxf.end = b - d.normalize(g)


VARIANTS = [("base", v_base), ("no_jambs", v_no_jambs), ("rotated17", v_rotated), ("anon_layers", v_anon_layers),
            ("exploded", v_exploded), ("walls_through", v_walls_through), ("one_block", v_one_block), ("no_units", v_no_units),
            ("gaps_3cm", v_gaps)]


def main(fixture_dir, work):
    os.makedirs(work, exist_ok=True)
    truth = json.load(open(os.path.join(fixture_dir, "fixture_truth.json"), encoding="utf-8"))["files"]
    metas = {"fixture_rdc_cm.dxf": {"wall_layer": "MUR", "window_layer": "FENETRE", "upm": 100},
             "fixture_etage_mm.dxf": {"wall_layer": "Wand", "window_layer": "Fenster", "upm": 1000}}
    rows = []
    for fname, meta in metas.items():
        for vname, fn in VARIANTS:
            doc = ezdxf.readfile(os.path.join(fixture_dir, fname))
            fn(doc, meta)
            out = os.path.join(work, fname.replace(".dxf", f"__{vname}.dxf"))
            doc.saveas(out)
            try:
                res = X.analyse(out)
                sc = score(res, truth[fname])
                if os.environ.get("PNG"):
                    X.draw_png(res, out.replace(".dxf", ".png"))
            except Exception as e:  # noqa
                sc = {"error": f"{type(e).__name__}: {e}"}
                res = {"warnings": []}
            rows.append((fname, vname, sc, res["warnings"]))
    # the two-storey file, base only
    res = X.analyse(os.path.join(fixture_dir, "fixture_2storeys_aia.dxf"))
    rows.append(("fixture_2storeys_aia.dxf", "base", score(res, truth["fixture_2storeys_aia.dxf"]), res["warnings"]))
    keys = ["unit", "plans", "rooms_named", "room_area_ok", "ext_windows_typed", "ext_openings_any", "doors", "heated_gross_ok", "warnings"]
    print("| file | variant | " + " | ".join(keys) + " | wall layer |")
    print("|---|---|" + "---|" * (len(keys) + 1))
    for fname, vname, sc, warns in rows:
        if "error" in sc:
            print(f"| {fname} | {vname} | ERROR {sc['error']} |")
            continue
        print(f"| {fname.replace('fixture_', '').replace('.dxf', '')} | {vname} | " + " | ".join(str(sc[k]) for k in keys) + f" | {sc['wall_layers']} |")
    if os.environ.get("WARN"):
        for fname, vname, sc, warns in rows:
            for w in warns:
                print(f"  [{fname} {vname}] {w}"[:260])


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
