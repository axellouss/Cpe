#!/usr/bin/env python3
"""
Spike 1 - reverse-engineer the column logic of the official Luxembourg note
"U-Wert-Typologien fuer bestehende Gebaeude" (v1.1, 12.11.2007, Ministere de l'Economie /
Goblet Lavandier & Associes + IWU) from the few cells that WebSearch excerpts returned,
and test whether the German/IWU base table (which I only know from memory) is consistent with them.

What is PROVEN here (by arithmetic): the 9 values of the one fully quoted row follow
U(d) = 1 / (1/U0 + d/lambda) with lambda = 0.04 W/mK and d = 0,2,4,...,16 cm.
What is NOT proven: every other cell of the reconstructed table (see RECON below) - it is the
German "Bekanntmachung Datenaufnahme Wohngebaeudebestand" (BMVBS 2009, IWU-based) table recalled
from model memory. 5 independent cells of the Luxembourg PDF were available as excerpts and all 5 match.
"""
import json, itertools, sys

LAMBDA = 0.04  # W/mK - stated in the Luxembourg note (excerpt: "pauschal lambda = 0,04 W/(mK)")

def u_with_insulation(u0, d_cm, lam=LAMBDA):
    return 1.0 / (1.0 / u0 + (d_cm / 100.0) / lam)

# ---- A. the one row quoted verbatim by the search excerpt ------------------------------------
# "Dach - massive Konstruktion (insbes. Flachdaecher) - 1984 bis 1994 | 0,40 | 0,33 | 0,29 | 0,25 | 0,22 | 0,20 | 0,18 | 0,17 | 0,15"
quoted = [0.40, 0.33, 0.29, 0.25, 0.22, 0.20, 0.18, 0.17, 0.15]

def fit_columns(quoted):
    """find the insulation thickness (integer cm, 0..30) that reproduces each quoted cell after rounding to 2 decimals"""
    u0 = quoted[0]
    res = []
    for q in quoted:
        cands = [d for d in range(0, 31) if abs(round(u_with_insulation(u0, d), 2) - q) < 1e-9]
        res.append(cands)
    return res

cands = fit_columns(quoted)
print("A. candidates (cm of added insulation) per quoted column:")
for q, c in zip(quoted, cands):
    print(f"   U={q:.2f} -> d in {c}")
regular = list(range(0, 17, 2))
ok_regular = all(d in c for d, c in zip(regular, cands))
print(f"   regular grid 0,2,4,...,16 cm reproduces all 9 cells: {ok_regular}")
print("   recomputed row:", [f"{u_with_insulation(quoted[0], d):.2f}" for d in regular])

# ---- B. base table recalled from memory (German BMVBS 2009 / IWU) ----------------------------
AGE = ["<=1918", "1919-1948", "1949-1957", "1958-1968", "1969-1978", "1979-1983", "1984-1994", ">=1995"]
RECON = {  # U0 in W/m2K, NOT VERIFIED against the Luxembourg PDF except the cells listed in CHECKS
    ("roof", "massive (flat roofs)"):                 [2.1, 2.1, 2.1, 2.1, 0.6, 0.5, 0.4, 0.3],
    ("roof", "timber (pitched roofs)"):               [2.6, 1.4, 1.4, 1.4, 0.8, 0.5, 0.4, 0.3],
    ("top floor ceiling", "massive"):                 [2.1, 2.1, 2.1, 2.1, 0.6, 0.5, 0.4, 0.3],
    ("top floor ceiling", "timber joists"):           [1.0, 0.8, 0.8, 0.8, 0.6, 0.4, 0.3, 0.3],
    ("external wall", "massive (masonry, concrete)"): [1.7, 1.7, 1.4, 1.4, 1.0, 0.8, 0.6, 0.5],
    ("external wall", "timber (half-timber, prefab)"):[2.0, 2.0, 1.4, 1.4, 0.6, 0.5, 0.4, 0.4],
    ("to ground / unheated cellar", "massive"):       [1.2, 1.2, 1.5, 1.0, 1.0, 0.8, 0.6, 0.6],
    ("to ground / unheated cellar", "timber joists"): [1.0, 0.8, 0.8, 0.8, 0.6, 0.6, 0.4, 0.4],
}

# ---- C. cells of the Luxembourg PDF that came back in excerpts --------------------------------
# (element, construction, age class, column cm, value, where it came from)
CHECKS = [
    ("roof", "massive (flat roofs)", "1984-1994", 0, 0.40, "guichet PDF excerpt, full row"),
    ("external wall", "massive (masonry, concrete)", "<=1918", 2, 0.92, "guichet PDF excerpt: 0,92 (column not named; fits 2 cm)"),
    ("external wall", "massive (masonry, concrete)", ">=1995", 2, 0.40, "guichet PDF excerpt: 0,40 (column not named; fits 2 cm)"),
    ("external wall", "timber (half-timber, prefab)", ">=1995", 0, 0.40, "guichet PDF excerpt: 0,40"),
    ("external wall", "massive (masonry, concrete)", "<=1918", 0, 1.7, "uni.lu paper (Merzkirch/Hoos 2015): typology 1,7 for sand/limestone walls"),
    ("external wall", "massive (masonry, concrete)", "1958-1968", 0, 1.4, "uni.lu paper: typology 1,4 for hollow concrete block walls (1960s)"),
]
print("\nC. cross-check of the memory table against excerpt cells:")
allok = True
for el, con, age, d, val, src in CHECKS:
    u0 = RECON[(el, con)][AGE.index(age)]
    got = round(u_with_insulation(u0, d), 2)
    ok = abs(got - val) < 0.006
    allok &= ok
    print(f"   {'OK ' if ok else 'BAD'} {el:28s} {con:30s} {age:10s} d={d:2d}cm  table={got:.2f}  excerpt={val:.2f}   [{src}]")
print("   all excerpt cells consistent:", allok)

# ---- D. write the reconstructed table (with insulation columns) as JSON for the developers ----
out = {"_warning": "RECONSTRUCTED - base values recalled from the German BMVBS-2009/IWU table, only %d cells cross-checked "
                   "against excerpts of the Luxembourg PDF. Verify against typologie-bat-hab-existants.pdf before any use." % len(CHECKS),
       "lambda_W_mK": LAMBDA, "insulation_cm": regular, "age_classes": AGE, "rows": []}
for (el, con), vals in RECON.items():
    for age, u0 in zip(AGE, vals):
        out["rows"].append({"element": el, "construction": con, "age": age,
                            "U_by_insulation_cm": {str(d): round(u_with_insulation(u0, d), 2) for d in regular}})
path = sys.argv[1] if len(sys.argv) > 1 else "typology_reconstructed.json"
json.dump(out, open(path, "w"), indent=1)
print(f"\nD. wrote {len(out['rows'])} rows to {path}")

print("\nE. reconstructed base table (0 cm):")
print("   %-30s %-30s " % ("element", "construction") + " ".join(f"{a:>9s}" for a in AGE))
for (el, con), vals in RECON.items():
    print("   %-30s %-30s " % (el, con) + " ".join(f"{v:9.2f}" for v in vals))
