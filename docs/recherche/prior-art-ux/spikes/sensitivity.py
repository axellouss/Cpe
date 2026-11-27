#!/usr/bin/env python3
"""Which unknowns are worth a question?  One-at-a-time sensitivity of a heating-demand PROXY model.

HONEST SCOPE
* This is NOT the Luxembourg method (RGD 2021 / LuxEeB-Tool use a monthly balance with Luxembourg climate data).
  It is the German EnEV 2002-2013 "simplified heating-period method" for residential buildings, written down
  from memory (constants 66 kKh/a, 0.95, 0.567, 22 kWh/m2, solar 270/155/100 kWh/m2, Fx factors 0.8 / 0.6):
      Qh = 66 * (HT + HV) - 0.95 * (Qs + Qi)
  Good enough to RANK inputs by influence; the absolute kWh are not CPE values.
* U-values per construction period and the system factors are ILLUSTRATIVE placeholders.
* The house is the same demo house as prototype/wizard.html (10.24 m x 9.24 m, two heated storeys, 1969-1983).

Run:  python3 -I spikes/sensitivity.py            (stdlib only; writes out/sensitivity.json and prints a table)
"""
import copy
import json
import math
import os

SOLAR = {"S": 270.0, "E": 155.0, "W": 155.0, "N": 100.0, "SE": 270.0, "SW": 270.0, "NE": 100.0, "NW": 100.0}
SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
PERIODS = {  # illustrative placeholders, same numbers as the prototype
    "p3": dict(wall=1.4, top=0.9, floor=1.0, win=2.8), "p4": dict(wall=1.0, top=0.6, floor=0.8, win=2.8),
    "p5": dict(wall=0.6, top=0.4, floor=0.6, win=2.6),
}
LAMBDA = 0.035


def add_insulation(u, cm):
    return 1.0 / (1.0 / u + (cm / 100.0) / LAMBDA)


BASE = dict(
    w=10.24, d=9.24, storey_h=2.80, storeys=2, cellar_h=2.45, cellar_heated=False,
    north_deg=20.0,                       # azimuth the plan's top side faces
    windows=[("bottom", 1.26, 1.385, 6), ("top", 1.01, 1.26, 4), ("left", 1.26, 1.385, 2), ("right", 1.01, 1.26, 3)],
    door_area=1.01 * 2.135, win_scale=1.0, lin_scale=1.0,
    U=dict(PERIODS["p4"]), U_door=3.0, g=0.75, dUwb=0.10, hv_factor=0.19, hv_reduction=1.0,
)
SIDE_AZ = {"top": 0.0, "right": 90.0, "bottom": 180.0, "left": 270.0}


def sector(az):
    return SECTORS[int(round((az % 360) / 45.0)) % 8]


def model(p):
    w, d = p["w"] * p["lin_scale"], p["d"] * p["lin_scale"]
    fp = w * d
    h = p["storey_h"] * p["storeys"] + (p["cellar_h"] if p["cellar_heated"] else 0.0)
    h_above = p["storey_h"] * p["storeys"]
    ve = fp * h
    perim = 2 * (w + d)
    wall_gross = perim * h_above
    win = {}
    for side, ww, hh, n in p["windows"]:
        s = sector(p["north_deg"] + SIDE_AZ[side])
        win[s] = win.get(s, 0.0) + ww * hh * n * p["win_scale"] * p["lin_scale"] ** 2
    a_win = sum(win.values())
    a_wall = wall_gross - a_win - p["door_area"]
    U = p["U"]
    parts = [(a_wall, U["wall"], 1.0), (a_win, U["win"], 1.0), (p["door_area"], p["U_door"], 1.0), (fp, U["top"], 0.8)]
    if p["cellar_heated"]:
        parts += [(perim * p["cellar_h"], U["wall"], 0.6), (fp, U["floor"], 0.6)]      # cellar walls + slab against ground
    else:
        parts += [(fp, U["floor"], 0.6)]                                                 # ceiling of the unheated cellar
    a_env = sum(a for a, _, _ in parts)
    ht = sum(a * u * fx for a, u, fx in parts) + p["dUwb"] * a_env
    hv = p["hv_factor"] * ve * p["hv_reduction"]
    qs = sum(SOLAR[s] * 0.567 * p["g"] * a for s, a in win.items())
    qi = 22.0 * 0.32 * ve
    qh = 66.0 * (ht + hv) - 0.95 * (qs + qi)
    return dict(qh=qh, ht=ht, hv=hv, qs=qs, qi=qi, ve=ve, a_env=a_env, a_win=a_win, a_wall=a_wall)


def variant(**changes):
    p = copy.deepcopy(BASE)
    for k, v in changes.items():
        if k == "U":
            p["U"].update(v)
        else:
            p[k] = v
    return p


def main():
    base = model(BASE)
    q0 = base["qh"]
    U4 = PERIODS["p4"]
    cases = [
        # (label, what would have told us, [variants])
        ("Heated zone: cellar heated or not", "question 3 (tap the plan)", [variant(cellar_heated=True)]),
        ("Construction period one class off", "question 2", [variant(U=PERIODS["p3"]), variant(U=PERIODS["p5"])]),
        ("Facade insulated later (12 cm) but not known", "question 4", [variant(U=dict(wall=add_insulation(U4["wall"], 12)))]),
        ("Windows replaced (Uw 2.8 -> 1.3) but not known", "question 4", [variant(U=dict(win=1.3), g=0.6)]),
        ("Top ceiling insulated later (16 cm) but not known", "question 4", [variant(U=dict(top=add_insulation(U4["top"], 16)))]),
        ("Cellar ceiling insulated later (8 cm) but not known", "question 4", [variant(U=dict(floor=add_insulation(U4["floor"], 8)))]),
        ("Storey height 2.80 m read as 2.60 / 3.00 (no section)", "plan section or confirm card", [variant(storey_h=2.6), variant(storey_h=3.0)]),
        ("Plan scale wrong by 2 % (linear)", "one known dimension", [variant(lin_scale=0.98), variant(lin_scale=1.02)]),
        ("Plan scale wrong by 41 % (A3 sheet printed on A4)", "one known dimension", [variant(lin_scale=1 / 1.414)]),
        ("Window areas off by 20 % (heights not on the plan)", "elevations or default sill/lintel", [variant(win_scale=0.8), variant(win_scale=1.2)]),
        ("Ventilation: heat recovery present but not known (HV halved, illustrative)", "question 8", [variant(hv_reduction=0.5)]),
        ("Airtightness test available (0.19 -> 0.163 Ve)", "question 8", [variant(hv_factor=0.163)]),
        ("Thermal-bridge surcharge 0.10 vs 0.05", "expert mode", [variant(dUwb=0.05)]),
        ("North wrong by 45 deg", "north arrow / map", [variant(north_deg=65.0), variant(north_deg=-25.0)]),
        ("North wrong by 90 deg", "north arrow / map", [variant(north_deg=110.0), variant(north_deg=-70.0)]),
        ("North wrong by 180 deg (worst case)", "north arrow / map", [variant(north_deg=200.0)]),
    ]
    rows = []
    for label, source, vs in cases:
        deltas = [(model(v)["qh"] - q0) / q0 * 100.0 for v in vs]
        rows.append(dict(label=label, source=source, min=min(deltas + [0.0]), max=max(deltas + [0.0]), span=max(abs(x) for x in deltas)))
    rows.sort(key=lambda r: -r["span"])

    # heating system: effect on (illustrative) primary energy for the SAME heat demand
    systems = [  # name, seasonal efficiency or SPF, illustrative primary-energy factor
        ("old oil boiler", 0.70, 1.1), ("low-temperature gas/oil", 0.85, 1.1), ("gas condensing", 0.95, 1.1),
        ("air/water heat pump (SPF 3.0)", 3.0, 1.8), ("pellets", 0.80, 0.2),
    ]
    ref = q0 / 0.85 * 1.1
    sysrows = [dict(system=n, primary_kwh=q0 / eta * fp, vs_low_temp_pct=(q0 / eta * fp - ref) / ref * 100.0) for n, eta, fp in systems]

    print(f"Baseline demo house: Qh = {q0:,.0f} kWh/a  (HT {base['ht']:.0f} W/K, HV {base['hv']:.0f} W/K, solar {base['qs']:,.0f}, internal {base['qi']:,.0f} kWh/a, "
          f"Ve {base['ve']:.0f} m3, envelope {base['a_env']:.0f} m2, windows {base['a_win']:.1f} m2)")
    print("\nEffect on the heating demand Qh of getting ONE input wrong (proxy model, sorted by size):")
    print(f"{'unknown / error':<72} {'change of Qh':>16}   told by")
    for r in rows:
        rng = f"{r['min']:+.1f} .. {r['max']:+.1f} %" if r["min"] < 0 < r["max"] else f"{(r['min'] if r['min'] < 0 else r['max']):+.1f} %"
        print(f"{r['label']:<72} {rng:>16}   {r['source']}")
    print("\nSame heat demand, different heat generator (illustrative efficiencies and primary-energy factors):")
    for s in sysrows:
        print(f"  {s['system']:<32} primary {s['primary_kwh']:>8,.0f} kWh/a   {s['vs_low_temp_pct']:+6.0f} % vs low-temperature boiler")

    # second baseline: a well-insulated recent house with large south glazing - orientation weighs more there
    modern = dict(U=dict(wall=0.17, top=0.13, floor=0.25, win=0.9), g=0.5, dUwb=0.05, hv_factor=0.163, hv_reduction=0.5,
                  windows=[("bottom", 2.5, 2.2, 4), ("top", 1.0, 1.2, 3), ("left", 1.2, 1.4, 2), ("right", 1.2, 1.4, 2)], north_deg=0.0)
    qm = model(variant(**modern))["qh"]
    mrows = []
    for lab, deg in (("45", 45.0), ("90", 90.0), ("180", 180.0)):
        mrows.append(dict(label=f"North wrong by {lab} deg", pct=(model(variant(**dict(modern, north_deg=deg)))["qh"] - qm) / qm * 100.0))
    mrows.append(dict(label="Plan scale wrong by 2 % (linear)", pct=(model(variant(**dict(modern, lin_scale=1.02)))["qh"] - qm) / qm * 100.0))
    print(f"\nRecent well-insulated variant (illustrative, 22 m2 south glazing): Qh = {qm:,.0f} kWh/a")
    for r in mrows:
        print(f"  {r['label']:<40} {r['pct']:+6.1f} %")

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out", "sensitivity.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(dict(note="proxy model (EnEV simplified heating-period method from memory), illustrative U-values; ranking only",
                       baseline=base, envelope=rows, systems=sysrows, modern_qh=qm, modern=mrows), f, indent=1)


if __name__ == "__main__":
    main()
