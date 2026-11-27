#!/usr/bin/env python3
"""
Spike 3 - the energy reference area An ("surface de reference energetique" / "Energiebezugsflaeche")
as a rule engine over a room schedule (what IFC spaces, labelled DWG rooms or OCR'd PDF room stamps give).

Rules implemented and where they come from (see NOTES.md section 2):
  R1 net floor area, measured between inner faces of walls          [official excerpts: annex 5.1.2, OAI FC04, control recap]
  R2 only rooms inside the thermal + airtight envelope              [official excerpt, annex I 5.1.2 RGD 2021 draft/consolidated]
  R3 only CONDITIONED rooms = standard use needs heating/cooling;
     a radiator alone does not make a room count; an unconditioned
     room inside the envelope is NOT counted                         [official excerpts]
  R4 rooms with varying height: only the part with height > 1.0 m   [official excerpt]
  R5 boiler room, garage -> never (use needs no conditioning)       [official excerpt: control recap]
  R6 stairwells/corridors count if not in contact with outside air  [official excerpt of "Tableau 8", truncated -> medium confidence]
  R7 bin rooms, shafts, fuel storage -> never                       [excerpt of the 2026 aid law, not the CPE annex -> medium]
Everything else in ROOM_KEYWORDS (cellar, laundry, hobby room ...) is MY default guess to be confirmed by the user.
"""
import math, re, json, sys

# keyword -> (default decision, confidence, note).  FR + DE + LU-typical plan labels.
ROOM_KEYWORDS = [   # ORDER MATTERS (found by running): "Waschkueche" must hit laundry before "kueche"; "Chambre 1 (combles)" must hit habitable before "combles"
    (r"garage|carport|parking|stellplatz", ("exclude", "high", "R5")),
    (r"chaufferie|heiz|chaudi[èe]re|technique|technik|local tech|hausanschluss", ("exclude", "high", "R5 boiler/plant room")),
    (r"poubelle|m[üu]ll|gaine|schacht|citerne|tank|pellet|combustible|brennstoff", ("exclude", "medium", "R7")),
    (r"terrasse|balcon|balkon|loggia|v[ée]randa|wintergarten|jardin d'hiver", ("exclude", "medium", "outside / unheated buffer space")),
    (r"buanderie|wasch|laundry|hobby|loisir|fitness|atelier|werkstatt", ("ask", "low", "depends on heating and envelope position")),
    (r"s[ée]jour|salon|living|wohn|stube|salle [àa] manger|\bess|chambre|schlaf|zimmer|bureau|b[üu]ro|cuisine|k[üu]che|kitchen|sdb|salle de bain|bad|douche|dusch|wc|toilet", ("count", "high", "habitable room")),
    (r"cave|keller|cellier|vorrat|abstell|d[ée]barras|rangement|lager|grenier|speicher|combles|dachboden", ("ask", "low", "storage/cellar/attic: counts only if conditioned and inside the envelope")),
    (r"hall|entr[ée]e|couloir|flur|diele|d[ée]gagement|palier|escalier|treppe|cage", ("count", "medium", "circulation: counts unless open to outside air (R6)")),
]

def classify(label):
    for pat, res in ROOM_KEYWORDS:
        if re.search(pat, label.lower()):
            return res
    return ("ask", "low", "unknown label")

def area_above_height(width, depth, knee_wall, pitch_deg, h_min=1.0, ridge_cap=None):
    """Room under ONE roof slope: floor is width (perpendicular to eaves) x depth.
    Clear height at distance x from the eaves wall: h(x) = knee_wall + x*tan(pitch) (optionally capped by a flat ceiling).
    Returns (floor area with clear height > h_min, full floor area)."""
    t = math.tan(math.radians(pitch_deg))
    x0 = 0.0 if knee_wall > h_min else min(width, (h_min - knee_wall) / t)
    return (width - x0) * depth, width * depth

def an_from_rooms(rooms):
    total, asked, log = 0.0, [], []
    for r in rooms:
        dec, conf, note = classify(r["label"])
        a = r.get("area_h_gt_1m", r["net_area"])            # R4
        if not r.get("inside_envelope", True):                # R2
            dec, note = "exclude", "outside thermal envelope (R2)"
        elif r.get("conditioned") is False:                   # R3
            dec, note = "exclude", "not conditioned (R3)"
        elif r.get("conditioned") is True and dec == "ask":
            dec, note = "count", "user/plan says conditioned"
        if dec == "count":
            total += a
        elif dec == "ask":
            asked.append(r["label"])
        log.append((r["label"], r["net_area"], a, dec, conf, note))
    return total, asked, log

if __name__ == "__main__":
    # toy single-family house: basement, ground floor, attic floor under a 40 deg roof with 0.6 m knee wall
    att, att_full = area_above_height(width=4.5, depth=4.0, knee_wall=0.6, pitch_deg=40)
    rooms = [
        {"label": "Garage", "net_area": 18.0},
        {"label": "Chaufferie", "net_area": 6.0},
        {"label": "Cave", "net_area": 14.0},
        {"label": "Buanderie", "net_area": 8.0},
        {"label": "Hobbyraum", "net_area": 16.0, "conditioned": True},
        {"label": "Escalier sous-sol", "net_area": 4.0, "inside_envelope": False},
        {"label": "Hall d'entrée", "net_area": 9.0},
        {"label": "Séjour / salle à manger", "net_area": 38.0},
        {"label": "Cuisine", "net_area": 12.0},
        {"label": "WC", "net_area": 2.0},
        {"label": "Escalier", "net_area": 4.5},
        {"label": "Chambre 1 (combles)", "net_area": att_full, "area_h_gt_1m": att},
        {"label": "Chambre 2 (combles)", "net_area": att_full, "area_h_gt_1m": att},
        {"label": "Salle de bain", "net_area": 7.0},
        {"label": "Palier", "net_area": 5.0},
        {"label": "Grenier", "net_area": 20.0, "conditioned": False},
    ]
    total, asked, log = an_from_rooms(rooms)
    print(f"attic bedroom: {att_full:.2f} m2 floor, {att:.2f} m2 with clear height > 1.0 m ({100*att/att_full:.0f} %)")
    print(f"{'room':28s} {'net':>6s} {'used':>6s}  decision conf    note")
    for lab, n, a, dec, conf, note in log:
        print(f"{lab:28s} {n:6.1f} {a:6.1f}  {dec:8s} {conf:6s}  {note}")
    net_all = sum(r["net_area"] for r in rooms)
    print(f"\nAn (automatic part)      = {total:.1f} m2")
    print(f"rooms the wizard must ask about ({len(asked)}): {asked}")
    lo, hi = total, total + sum(r['net_area'] for r in rooms if r['label'] in asked)
    print(f"An range before the user answers: {lo:.1f} .. {hi:.1f} m2  (+{100*(hi-lo)/lo:.0f} %)")
    print(f"sum of ALL net room areas = {net_all:.1f} m2 -> naive 'sum every room' error: +{100*(net_all-total)/total:.0f} %")
    # label classifier self-test on FR/DE labels
    tests = {"Wohnzimmer": "count", "Schlafzimmer": "count", "Küche": "count", "Flur": "count", "Treppenhaus": "count",
             "Heizraum": "exclude", "Garage": "exclude", "Keller": "ask", "Waschküche": "ask", "Abstellraum": "ask",
             "Local poubelles": "exclude", "Débarras": "ask", "Bureau": "count", "Terrasse": "exclude", "Technikraum": "exclude",
             "Salle de douche": "count", "Dégagement": "count", "Speicher": "ask", "Pelletlager": "exclude"}
    bad = {k: (classify(k)[0], v) for k, v in tests.items() if classify(k)[0] != v}
    print(f"\nlabel classifier self-test: {len(tests) - len(bad)}/{len(tests)} as expected; mismatches: {bad}")
