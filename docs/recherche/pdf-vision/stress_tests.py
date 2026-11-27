#!/usr/bin/env python
"""stress_tests.py - degrade the IR of the fixtures to find where the heuristics break.
  A  hairline : every stroke gets the same width (Archicad 'hairline' PDF, some plot styles) -> no wall class
  B  no-dims  : dimension texts removed (pure presentation plan)        -> only area labels can calibrate
  C  no-areas : area labels removed                                      -> only dimensions can calibrate
  D  no-text  : no text at all (SHX fonts / text converted to curves)    -> nothing but the declared... nothing
  E  jitter   : endpoints perturbed by 0.15 pt (sloppy CAD snapping)     -> does polygonize still close rooms?
"""
import copy, json, random, re, sys
import analyze as A

def run(name, page, truth_page, truth):
    print(f"--- {name}")
    try:
        rep = A.analyze_page(page, verbose=False)
    except Exception as e:
        print("   CRASH", type(e).__name__, e); return
    rows = A.evaluate(rep, truth_page, truth)
    keep = ("declared", "dim-calibrated", "dimension texts", "area-calibrated", "room polygon", "room polygons", "outline", "heated outline")
    for k, v in rows:
        if k.startswith(keep): print(f"   {k}: {v}")
    if not rep.get("views"): print("   no faces / no views found")

for f in ["fr_A3_1-100", "de_A3_1-50"]:
    ir = json.load(open(f"ir/{f}.pymupdf.json")); truth = json.load(open(f"fixtures/{f}.truth.json"))
    page, tp = ir["pages"][0], truth["pages"][0]
    print(f"===== {f} page 1")
    run("baseline", page, tp, truth)
    p = copy.deepcopy(page)
    for s in p["segs"]:
        if s["stroke"]: s["w"] = 0.5
    run("A hairline (all strokes 0.5 pt)", p, tp, truth)
    p = copy.deepcopy(page); p["texts"] = [t for t in p["texts"] if not A.NUM_RE.match(t["s"].strip())]
    run("B no dimension texts", p, tp, truth)
    p = copy.deepcopy(page); p["texts"] = [t for t in p["texts"] if not A.AREA_RE.search(t["s"])]
    run("C no area labels", p, tp, truth)
    p = copy.deepcopy(page); p["texts"] = []
    run("D no text at all", p, tp, truth)
    random.seed(1)
    p = copy.deepcopy(page)
    for s in p["segs"]:
        for k in ("x0", "y0", "x1", "y1"): s[k] += random.uniform(-0.15, 0.15)
    run("E endpoint jitter +-0.15 pt (= +-5 mm real at 1:100)", p, tp, truth)
