#!/usr/bin/env python3
"""Input budget: where can each input of a first-pass residential CPE come from?

HONEST SCOPE
* The input list is my best reconstruction of what a LuxEeB-Tool calculation of an existing single-family house needs,
  built from (a) the data-entry procedure of the official manual as summarised in ../luxeeb-tool/NOTES.md
  (general data -> element types -> envelope surfaces by element and 8 orientations -> reference area and volume ->
  ventilation -> installations) and (b) general knowledge of DIN-V-4108-6 / 4701-10 style methods.
  It has NOT been checked field by field against the tool. Treat counts as orders of magnitude.
* "values" = how many numbers/choices the expert types for the demo house (2 heated storeys, 4 facades).

Run: python3 -I spikes/input_budget.py      (stdlib only; writes out/input_budget.json and out/input_budget.md)
"""
import json
import os
from collections import Counter, defaultdict

# source classes
PLAN_GEOM = "plan geometry"          # measured/computed from the drawing
PLAN_TEXT = "plan text"              # title block, labels, dimension texts
DEF_YEAR = "default by period"       # typical value for the construction period
DEF_FIXED = "fixed default"          # flat-rate value until the expert refines it
ASK = "question"                     # must be asked
LATER = "later / site visit"         # not needed for a first pass

Q = {
    "Q1": ("Occasion of the certificate (existing building / renovation / new build)",
           "Administrative context, not a property of the drawing."),
    "Q2": ("Construction period (pre-selected from the plan date, exact year optional)",
           "A plan date is only a hint (permit vs completion, later copies); nothing on a plan proves the build year."),
    "Q3": ("Is this the heated zone? (rooms coloured on the plan, tap to change)",
           "Plans label rooms but not whether cellar, attic, garage or veranda are heated today."),
    "Q4": ("What was renovated since construction? (windows / roof or top ceiling / facade / cellar ceiling, with year or cm)",
           "Original plans predate the works; retrofits are rarely redrawn."),
    "Q5": ("Heat generator and fuel, then age band",
           "Architectural plans do not describe the boiler; at best a room is labelled 'chaufferie / Heizraum'."),
    "Q6": ("Heat emission: radiators / floor heating / both (skippable)",
           "Emitters are rarely drawn; they set the system temperatures."),
    "Q7": ("Domestic hot water: by the heating / separate electric / heat-pump water heater",
           "Not on architectural plans."),
    "Q8": ("Ventilation: windows / exhaust / heat recovery; blower-door result if any",
           "Only shown on building-services plans; a test result is a document, not a drawing."),
    "Q9": ("Solar on the roof: none / PV (kWp) / thermal (m2) / both",
           "Usually installed after the plans were drawn."),
}

# (id, group, description, values typed for the demo house, source, question, note)
FIELDS = [
    ("address", "general", "Address of the building", 3, PLAN_TEXT, None, "title block; else one text field"),
    ("building_type", "general", "Single-family / multi-family, number of dwellings", 2, PLAN_GEOM, None, "count of dwelling units / kitchens; confirm card"),
    ("occasion", "general", "Type of certificate / occasion", 1, ASK, "Q1", ""),
    ("year", "general", "Year of construction", 1, ASK, "Q2", "pre-filled from plan date"),
    ("owner", "general", "Owner / client details", 3, LATER, None, "administrative; often in the title block"),
    ("An", "geometry", "Energy reference area An", 1, PLAN_GEOM, "Q3", "room areas inside the heated zone"),
    ("Ve", "geometry", "Heated gross volume Ve", 1, PLAN_GEOM, "Q3", "outline x storey heights (section needed)"),
    ("storey_heights", "geometry", "Storey heights / number of heated storeys", 3, PLAN_GEOM, None, "section drawing; else confirm card with default"),
    ("north", "geometry", "Orientation of the building", 1, PLAN_GEOM, None, "north arrow or site plan; confirm on a compass"),
    ("walls_ext", "envelope", "Exterior wall areas per orientation (gross dimensions)", 4, PLAN_GEOM, "Q3", "outline x height, per facade, 8 compass sectors"),
    ("walls_other", "envelope", "Walls to ground / to unheated rooms", 2, PLAN_GEOM, "Q3", "depends on the heated zone"),
    ("roof_top", "envelope", "Roof or top-floor ceiling area (and pitch)", 2, PLAN_GEOM, "Q3", "pitch only from section/elevation"),
    ("floor", "envelope", "Ground slab or cellar ceiling area", 1, PLAN_GEOM, "Q3", ""),
    ("windows", "envelope", "Window areas per orientation", 8, PLAN_GEOM, None, "width from plan; height from annotation (w/h) or elevation, else default"),
    ("door", "envelope", "Entrance door area", 1, PLAN_GEOM, None, ""),
    ("shading", "envelope", "Shading of windows (horizon, overhangs)", 4, DEF_FIXED, None, "standard value; refine on site"),
    ("U_wall", "constructions", "Wall build-up or U-value", 4, DEF_YEAR, "Q4", "wall thickness on the plan helps choose the type"),
    ("U_roof", "constructions", "Roof / top ceiling build-up or U-value", 4, DEF_YEAR, "Q4", ""),
    ("U_floor", "constructions", "Floor / cellar ceiling build-up or U-value", 4, DEF_YEAR, "Q4", ""),
    ("U_win", "constructions", "Window Uw and g-value", 3, DEF_YEAR, "Q4", "year of replacement if any"),
    ("U_door", "constructions", "Door U-value", 1, DEF_YEAR, None, ""),
    ("thermal_bridges", "constructions", "Thermal-bridge surcharge", 1, DEF_FIXED, None, "flat rate until detailed"),
    ("vent_system", "ventilation", "Ventilation system type", 1, ASK, "Q8", ""),
    ("hrv_eff", "ventilation", "Heat-recovery efficiency", 1, DEF_FIXED, "Q8", "only if heat recovery; product data later"),
    ("n50", "ventilation", "Airtightness (n50)", 1, DEF_FIXED, "Q8", "measured value if a test exists"),
    ("heat_gen", "systems", "Heat generator type and energy carrier", 2, ASK, "Q5", ""),
    ("heat_age", "systems", "Generator age / efficiency class", 1, ASK, "Q5", ""),
    ("gen_location", "systems", "Generator inside or outside the thermal envelope", 1, PLAN_TEXT, "Q3", "room label 'chaufferie/Heizraum' + heated zone"),
    ("distribution", "systems", "Distribution pipes (location, insulation)", 2, DEF_YEAR, None, ""),
    ("emission", "systems", "Emission system and system temperatures", 2, ASK, "Q6", "default by period if skipped"),
    ("control", "systems", "Room temperature control", 1, DEF_YEAR, None, ""),
    ("dhw_gen", "systems", "Hot-water generation", 1, ASK, "Q7", ""),
    ("dhw_storage", "systems", "Hot-water storage / circulation", 2, DEF_YEAR, None, ""),
    ("solar_thermal", "systems", "Solar thermal (area, use)", 2, ASK, "Q9", ""),
    ("pv", "systems", "Photovoltaics (kWp, orientation)", 2, ASK, "Q9", "orientation follows the roof side"),
    ("consumption", "existing building", "Measured consumption of the last years", 3, LATER, None, "owner's bills; not needed to compute"),
    ("recommendations", "existing building", "Modernisation recommendations", 3, LATER, None, "expert judgement; can be suggested from the weakest elements"),
    ("site_check", "existing building", "On-site verification, photos", 0, LATER, None, "the accredited expert stays responsible"),
]


def main():
    by_src_fields = Counter(f[4] for f in FIELDS)
    by_src_values = Counter()
    for f in FIELDS:
        by_src_values[f[4]] += f[3]
    total_values = sum(f[3] for f in FIELDS)
    # consistency checks
    for f in FIELDS:
        assert f[5] is None or f[5] in Q, f
        if f[4] == ASK:
            assert f[5] in Q, f"ask-field without question: {f[0]}"
    used = defaultdict(list)
    for f in FIELDS:
        if f[5]:
            used[f[5]].append(f[0])
    assert set(used) == set(Q), set(Q) - set(used)

    print(f"{len(FIELDS)} input groups, about {total_values} typed values for the demo house\n")
    print(f"{'source':<22}{'input groups':>14}{'typed values':>14}{'share of values':>18}")
    for src in (PLAN_GEOM, PLAN_TEXT, DEF_YEAR, DEF_FIXED, ASK, LATER):
        print(f"{src:<22}{by_src_fields[src]:>14}{by_src_values[src]:>14}{by_src_values[src] / total_values * 100:>17.0f}%")
    first_pass = total_values - by_src_values[LATER]
    auto = by_src_values[PLAN_GEOM] + by_src_values[PLAN_TEXT] + by_src_values[DEF_YEAR] + by_src_values[DEF_FIXED]
    print(f"\nFirst pass (without 'later'): {first_pass} values; {auto} ({auto / first_pass * 100:.0f} %) need no typing "
          f"if plan reading works; {by_src_values[ASK]} come from {len(Q)} questions.")
    print("\nQuestions and the inputs each one settles or unlocks:")
    for k in sorted(Q):
        print(f"  {k}: {Q[k][0]}\n      settles: {', '.join(used[k])}\n      why not from the plan: {Q[k][1]}")

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out")
    with open(os.path.join(out_dir, "input_budget.json"), "w", encoding="utf-8") as f:
        json.dump(dict(note="reconstructed input list, not verified against LuxEeB-Tool", questions=Q,
                       fields=[dict(id=a, group=b, description=c, values=d, source=e, question=g, note=h) for a, b, c, d, e, g, h in FIELDS],
                       by_source_values=by_src_values, total_values=total_values), f, indent=1, ensure_ascii=False)
    with open(os.path.join(out_dir, "input_budget.md"), "w", encoding="utf-8") as f:
        f.write("| group | input | values | source | question | note |\n|---|---|---|---|---|---|\n")
        for a, b, c, d, e, g, h in FIELDS:
            f.write(f"| {b} | {c} | {d} | {e} | {g or ''} | {h} |\n")


if __name__ == "__main__":
    main()
