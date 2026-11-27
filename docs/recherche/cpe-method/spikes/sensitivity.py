#!/usr/bin/env python3
"""
Spike 2 - which inputs matter? One-at-a-time sensitivity of the specific heating demand qH
to the kind of errors a plan-reading tool (or a wrong default) would make.

IMPORTANT - this is NOT the Luxembourg algorithm. LuxEeB uses a monthly balance with the Luxembourg
reference climate and its own tables (annex I ch. 5 of the RGD 2021), which I could not read in full.
As a stand-in I use the German EnEV-2002 simplified heating-period balance (recalled from memory):
    Qh = 66 * (HT + HV) - 0.95 * (Qs + Qi)                 [kWh/a]
    HT = sum(Fx*U*A) + dUwb * A_env                        [W/K]
    HV = 0.34 * n * 0.8 * Ve                               [W/K]
    Qs = sum(I_orient * 0.567 * g * A_window)              I: S 270, E/W 155, N 100 kWh/m2 per heating period
    Qi = 22 * An
Absolute kWh/m2a are therefore only indicative; the RANKING of the sensitivities is the result.
Class thresholds used for illustration: thermal-insulation class of single-family houses, RGD 2007
(22/43/69/86/130/170/230/295 kWh/m2a) - A and D limits corroborated by excerpts, the rest from memory.
"""
import copy, json, sys

I_SOL = {"S": 270.0, "E": 155.0, "W": 155.0, "N": 100.0}
ROT90 = {"S": "W", "W": "N", "N": "E", "E": "S"}
CLASSES = [(22, "A"), (43, "B"), (69, "C"), (86, "D"), (130, "E"), (170, "F"), (230, "G"), (295, "H")]

def klass(q):
    for lim, name in CLASSES:
        if q <= lim:
            return name
    return "I"

def qh(b):
    A_env = sum(e["A"] for e in b["opaque"]) + sum(w["A"] for w in b["windows"])
    HT = sum(e["Fx"] * e["U"] * e["A"] for e in b["opaque"]) + sum(w["U"] * w["A"] for w in b["windows"]) + b["dUwb"] * A_env
    HV = 0.34 * b["n"] * 0.8 * b["Ve"]
    Qs = sum(I_SOL[w["o"]] * 0.567 * w["g"] * w["A"] for w in b["windows"])
    Qi = 22.0 * b["An"]
    Q = 66.0 * (HT + HV) - 0.95 * (Qs + Qi)
    return Q / b["An"], HT, HV, A_env

def house(u_wall, u_top, u_cellar, u_win, g, n=0.7, duwb=0.10):
    """detached house 10 x 9 m outside, 2 heated storeys of 2.8 m, unheated attic above, unheated cellar below"""
    L, W, H = 10.0, 9.0, 5.6
    win = {"S": 12.0, "E": 6.0, "W": 6.0, "N": 6.0}
    door = 2.0
    wall = 2 * (L + W) * H - sum(win.values()) - door
    return {
        "An": 0.80 * 2 * L * W,          # net conditioned floor area ~ 80 % of gross
        "Ve": L * W * H,
        "n": n, "dUwb": duwb,
        "opaque": [
            {"name": "wall", "A": wall, "U": u_wall, "Fx": 1.0},
            {"name": "door", "A": door, "U": 3.5, "Fx": 1.0},
            {"name": "top_ceiling", "A": L * W, "U": u_top, "Fx": 0.8},
            {"name": "cellar_ceiling", "A": L * W, "U": u_cellar, "Fx": 0.6},
        ],
        "windows": [{"o": o, "A": a, "U": u_win, "g": g} for o, a in win.items()],
    }

def el(b, name):
    return next(e for e in b["opaque"] if e["name"] == name)

def variants(base):
    """(label, what kind of mistake it represents, mutated building)"""
    out = []
    def add(label, kind, fn):
        b = copy.deepcopy(base); fn(b); out.append((label, kind, b))
    # --- geometry mistakes a plan reader could make
    add("storey height +10 % (2.80 -> 3.08 m)", "geometry", lambda b: (el(b, "wall").__setitem__("A", el(b, "wall")["A"] + 0.1 * 2 * 19 * 5.6), b.__setitem__("Ve", b["Ve"] * 1.1)))
    add("footprint +5 % each side (scale error)", "geometry", lambda b: ([e.__setitem__("A", e["A"] * (1.05 if e["name"] == "wall" else 1.1025 if "ceiling" in e["name"] else 1)) for e in b["opaque"]], b.__setitem__("Ve", b["Ve"] * 1.1025), b.__setitem__("An", b["An"] * 1.1025)))
    add("An from GROSS dimensions (+18 %)", "geometry", lambda b: b.__setitem__("An", b["An"] * 1.18))
    add("An -5 % (one room wrongly excluded)", "geometry", lambda b: b.__setitem__("An", b["An"] * 0.95))
    add("window area +20 % (frame vs rough opening)", "geometry", lambda b: ([w.__setitem__("A", w["A"] * 1.2) for w in b["windows"]], el(b, "wall").__setitem__("A", el(b, "wall")["A"] - 6.0)))
    add("window area -20 %", "geometry", lambda b: ([w.__setitem__("A", w["A"] * 0.8) for w in b["windows"]], el(b, "wall").__setitem__("A", el(b, "wall")["A"] + 6.0)))
    add("north arrow wrong by 90 deg", "geometry", lambda b: [w.__setitem__("o", ROT90[w["o"]]) for w in b["windows"]])
    add("north arrow wrong by 180 deg", "geometry", lambda b: [w.__setitem__("o", ROT90[ROT90[w["o"]]]) for w in b["windows"]])
    # --- boundary-condition mistakes
    add("cellar ceiling treated as outside air (Fx 1.0)", "boundary", lambda b: el(b, "cellar_ceiling").__setitem__("Fx", 1.0))
    add("attic treated as heated (top ceiling dropped)", "boundary", lambda b: el(b, "top_ceiling").__setitem__("Fx", 0.0))
    add("one 9 m gable wall is a heated neighbour (Fx 0)", "boundary", lambda b: (el(b, "wall").__setitem__("A", el(b, "wall")["A"] - 9 * 5.6),))
    # --- wrong defaults (things plans do not tell)
    add("wall U one age class older", "default", lambda b: el(b, "wall").__setitem__("U", {1.0: 1.4, 0.5: 0.6}[el(b, "wall")["U"]]))
    add("wall U one age class newer", "default", lambda b: el(b, "wall").__setitem__("U", {1.0: 0.8, 0.5: 0.4}[el(b, "wall")["U"]]))
    add("unnoticed retrofit: +8 cm wall insulation", "default", lambda b: el(b, "wall").__setitem__("U", 1 / (1 / el(b, "wall")["U"] + 0.08 / 0.04)))
    add("unnoticed retrofit: +12 cm top-ceiling insulation", "default", lambda b: el(b, "top_ceiling").__setitem__("U", 1 / (1 / el(b, "top_ceiling")["U"] + 0.12 / 0.04)))
    add("windows replaced (Uw -> 1.3, g 0.6) not noticed", "default", lambda b: [w.update({"U": 1.3, "g": 0.6}) for w in b["windows"]])
    add("window g -20 % (wrong glazing type / shading ignored)", "default", lambda b: [w.__setitem__("g", w["g"] * 0.8) for w in b["windows"]])
    add("thermal bridges 0.10 -> 0.05", "default", lambda b: b.__setitem__("dUwb", 0.05))
    add("thermal bridges 0.10 -> 0.15", "default", lambda b: b.__setitem__("dUwb", 0.15))
    add("air change 0.7 -> 1.0 1/h (leaky)", "default", lambda b: b.__setitem__("n", 1.0))
    add("air change 0.7 -> 0.6 1/h (tested)", "default", lambda b: b.__setitem__("n", 0.6))
    return out

def run(title, base):
    q0, HT, HV, A_env = qh(base)
    rows = []
    print(f"\n=== {title}")
    print(f"    An={base['An']:.0f} m2  Ve={base['Ve']:.0f} m3  A={A_env:.0f} m2  A/Ve={A_env/base['Ve']:.2f}  HT={HT:.0f} W/K  HV={HV:.0f} W/K")
    print(f"    baseline qH = {q0:.1f} kWh/m2a  -> class {klass(q0)}")
    for label, kind, b in variants(base):
        q = qh(b)[0]
        rows.append({"label": label, "kind": kind, "qH": round(q, 1), "delta_pct": round(100 * (q - q0) / q0, 1), "class": klass(q)})
    rows.sort(key=lambda r: -abs(r["delta_pct"]))
    print(f"    {'mistake':58s} {'kind':9s} {'qH':>7s} {'delta':>8s}  class")
    for r in rows:
        flag = "  <-- class changes" if r["class"] != klass(q0) else ""
        print(f"    {r['label']:58s} {r['kind']:9s} {r['qH']:7.1f} {r['delta_pct']:+7.1f}%  {r['class']}{flag}")
    return {"title": title, "baseline_qH": round(q0, 1), "baseline_class": klass(q0), "rows": rows}

res = [
    run("1970s detached house, typology defaults (wall 1.0, top ceiling 0.6, cellar 1.0, windows 2.7/0.75)", house(1.0, 0.6, 1.0, 2.7, 0.75)),
    run("post-1995 detached house, typology defaults (wall 0.5, top ceiling 0.3, cellar 0.6, windows 1.8/0.60)", house(0.5, 0.3, 0.6, 1.8, 0.60)),
]
path = sys.argv[1] if len(sys.argv) > 1 else "sensitivity.json"
json.dump(res, open(path, "w"), indent=1)
print(f"\nwrote {path}")
