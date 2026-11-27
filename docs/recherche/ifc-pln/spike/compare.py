"""side-by-side: ifcopenshell (shapely footprints) vs web-ifc (raster footprints)"""
import json, os, sys
d = sys.argv[1]
names = ["AC20-FZK-Haus", "AC11-FZK-Haus-IFC", "AC9R1-Haus-G-H-Ver2-2x3", "AC11-Institute-Var-2-IFC", "Ifc2x3_Duplex_Architecture", "SampleHouse4", "Ifc4_Revit_ARC", "BasicHouse", "AdvancedProject"]
def g(o, *ks):
    for k in ks:
        if o is None: return None
        o = o.get(k)
    return o
for n in names:
    pe, pw = os.path.join(d, n + ".energy.json"), os.path.join(d, n + ".webifc.json")
    if not (os.path.exists(pe) and os.path.exists(pw)):
        print(f"\n## {n}: missing ({os.path.exists(pe)=}, {os.path.exists(pw)=})"); continue
    E, W = json.load(open(pe)), json.load(open(pw))
    print(f"\n## {n}  [{E['schema']}]  true north present: {E['true_north_present']}")
    print(f"  timing: ifcopenshell total {E['timing']['total_s']} s (tessellation {E['timing']['tessellation_s']} s) | web-ifc open {W['timing_ms']['open_model_ms']} ms, semantic {W['timing_ms']['semantic_ms']} ms, geometry {W['timing_ms']['geometry_ms']} ms, analysis {round(W['timing_ms']['footprint_facade_ms']+W['timing_ms']['openings_ms']+W['timing_ms']['volume_ms'],1)} ms, rss {W['rss_mb']} MB, file {W['file_mb']} MB, grid cell {round(W['grid']['cell_m'],3)} m")
    print(f"  IsExternal pset vs geometry  ifcopenshell: {E['IsExternal_pset_vs_geometry']}")
    print(f"                               web-ifc     : {W['IsExternal_pset_vs_geometry']}")
    print(f"  {'storey':22s} {'z':>7s} | {'footprint m2 (ios / wifc)':>26s} | {'gross vol m3 (ios / wifc)':>26s} | space area qto / geom")
    ws = {s['name']: s for s in W['storeys']}
    for s in E['storeys']:
        w = ws.get(s['name'], {})
        print(f"  {str(s['name'])[:22]:22s} {s['elevation_m']:7.2f} | {str(s['gross_footprint_area_ext_dims_m2']):>12s} / {str(w.get('gross_footprint_area_ext_dims_m2')):>11s} | {str(s['gross_volume_ext_dims_m3']):>12s} / {str(w.get('gross_volume_ext_dims_m3')):>11s} | {s['space_area_qto_m2']} / {s['space_area_from_geometry_m2']}")
    te, tw = E['totals'], W['totals']
    print(f"  totals: gross floor {te['gross_floor_area_ext_dims_m2']} / {tw['gross_floor_area_ext_dims_m2']} m2 ; gross volume {te['gross_volume_ext_dims_m3']} / {tw['gross_volume_ext_dims_m3']} m3 ; space area qto {te['heated_floor_area_from_space_qto_m2']} geom {te['floor_area_from_space_geometry_m2']}")
    print(f"  facade GROSS by orientation (ios, walls + slab edges): {te['facade_gross_by_orientation_m2']}  total {te['facade_gross_total_m2']}")
    print(f"  wall NET by orientation  ios : {te['wall_net_of_openings_by_orientation_m2']}")
    print(f"                           wifc: {tw['wall_net_of_openings_by_orientation_m2']}")
    print(f"  windows by orientation   ios : {te['window_area_by_orientation_m2']} total {te['window_area_total_m2']}")
    print(f"                           wifc: {tw['window_area_by_orientation_m2']} total {tw['window_area_total_m2']}")
    print(f"  ext doors                ios : {te['ext_door_area_by_orientation_m2']}")
    print(f"                           wifc: {tw['ext_door_area_by_orientation_m2']}")
    print(f"  roof (ios): {te['roof_by_slope_orientation_m2']}")
    print(f"  openings pset vs geometry (ios): {E['openings_IsExternal_pset_vs_geometry']}")
    if E.get('space_boundary_external_areas'):
        print(f"  space-boundary EXTERNAL areas by class (ios): {E['space_boundary_external_areas']['area_by_class']}")
