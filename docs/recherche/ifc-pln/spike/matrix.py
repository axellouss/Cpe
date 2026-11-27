"""Compact availability matrix from out/*.inventory.json"""
import json, glob, os, sys
rows = []
for p in sorted(glob.glob(os.path.join(sys.argv[1], "*.inventory.json"))):
    R = json.load(open(p))
    sp = R["spaces"]; w = R["walls"]; wi = R["windows_summary"]; d = R["doors_summary"]
    tn = [t for t in R["true_north"] if t["ratios"]]
    sb = R["space_boundaries"]
    rows.append({
        "file": R["file"][:28], "schema": R["schema"], "app": (R["applications"] or ["?"])[0][:28],
        "mvd": (R["mvd"] or [""])[0].replace("ViewDefinition ", "")[:60],
        "len_unit": R["units"]["LENGTHUNIT"], "to_m": R["length_unit_to_m"],
        "true_north_deg": tn[0]["north_is_deg_clockwise_from_plusY"] if tn else "MISSING",
        "site_latlon": (R["site"][0]["lat"][:2], R["site"][0]["lon"][:2]) if R["site"] and R["site"][0]["lat"] else None,
        "storeys": [(s["name"], s["elevation_m"]) for s in R["storeys"]],
        "spaces": len(sp), "sp_area": sum(1 for s in sp if s["area"] is not None), "sp_area_keys": sorted({s["area_key"] for s in sp if s["area_key"]}),
        "sp_height": sum(1 for s in sp if s["height"] is not None), "sp_vol": sum(1 for s in sp if s["volume"] is not None),
        "walls": len(w), "walls_IsExternal": R["walls_summary"], "walls_qto": R["walls_with_qto"], "walls_layerset": R["walls_with_layerset"], "walls_U": R["walls_with_u_value"],
        "windows": wi["n"], "win_dims": wi["with_overall_dims"], "win_host": wi["host_classes"], "win_IsExternal": wi["IsExternal"], "win_U": wi["with_ThermalTransmittance"], "win_glazfrac": wi["with_GlazingAreaFraction"], "win_g": wi["with_g_value"],
        "doors": d["n"], "door_IsExternal": d["IsExternal"], "door_U": d["with_ThermalTransmittance"],
        "slabs": R["slabs_by_type"], "slab_IsExternal": {str(k): sum(1 for s in R["slabs"] if s["is_external"] == k) for k in (True, False, None)},
        "slab_pitch": sum(1 for s in R["slabs"] if s["pitch_angle"] is not None),
        "roofs": [(r["type"], r["parts"], (r["pset_roofcommon"] or {}).get("IsExternal")) for r in R["roofs"]],
        "materials": R["materials_total"], "mat_lambda": len(R["materials_with_conductivity"]), "mat_lambda_nonzero": sum(1 for v in R["materials_with_conductivity"].values() if v),
        "layersets_with_U": sum(1 for l in R["layer_sets_unique"] if l["U_from_layers_wall_Rsi013_Rse004"]),
        "layersets": len(R["layer_sets_unique"]),
        "space_boundaries": sb.get("total"), "sb_level": sb.get("by_name"), "sb_desc": sb.get("by_description"), "sb_int_ext": sb.get("internal_external"), "sb_geom": sb.get("geometry_types"),
    })
for r in rows:
    print("\n### " + r["file"])
    for k, v in r.items():
        if k != "file":
            print(f"  {k:18s} {v}")
