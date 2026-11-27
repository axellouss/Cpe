"""Inventory of what an IFC file really contains for an energy-certificate pre-fill.

Usage:  python -I inspect_ifc.py <file.ifc> [--json out.json]

Semantic data only (no geometry kernel) - see energy_quantities.py for geometry.
"""
import sys, json, math, time, collections
import ifcopenshell
import ifcopenshell.util.unit as uunit
import ifcopenshell.util.element as uel
import ifcopenshell.util.placement as uplace
import ifcopenshell.util.geolocation as ugeo


def r(x, n=3):
    return None if x is None else round(float(x), n)


def psets_of(el, qtos=False):
    try:
        return uel.get_psets(el, psets_only=not qtos, qtos_only=qtos)
    except Exception as e:  # malformed files
        return {"__error__": str(e)}


def find_prop(el, names, include_type=True):
    """search all psets (occurrence + type) for a property name (case-insensitive)."""
    names = [n.lower() for n in names]
    out = {}
    for pset, props in uel.get_psets(el).items():
        for k, v in props.items():
            if k.lower() in names and v is not None:
                out[f"{pset}.{k}"] = v
    return out


def layer_set_of(el):
    """return list of (material name, thickness in file units) or None"""
    mat = uel.get_material(el, should_skip_usage=True)
    if mat is None:
        return None, None
    if mat.is_a("IfcMaterialLayerSet"):
        return "IfcMaterialLayerSet", [(l.Material.Name if l.Material else None, l.LayerThickness) for l in mat.MaterialLayers]
    if mat.is_a("IfcMaterialConstituentSet"):
        return "IfcMaterialConstituentSet", [(c.Material.Name if c.Material else None, None) for c in (mat.MaterialConstituents or [])]
    if mat.is_a("IfcMaterialList"):
        return "IfcMaterialList", [(m.Name, None) for m in mat.Materials]
    if mat.is_a("IfcMaterial"):
        return "IfcMaterial", [(mat.Name, None)]
    return mat.is_a(), []


def material_thermal(f, material):
    """thermal conductivity of an IfcMaterial, any schema. W/mK or None"""
    if material is None:
        return None
    # IFC4: IfcMaterialProperties (Pset_MaterialThermal) via HasProperties
    for mp in getattr(material, "HasProperties", None) or []:
        for p in getattr(mp, "Properties", None) or []:
            if p.Name == "ThermalConductivity" and getattr(p, "NominalValue", None) is not None:
                return p.NominalValue.wrappedValue
    # IFC2x3: IfcThermalMaterialProperties
    if f.schema == "IFC2X3":
        for tp in f.by_type("IfcThermalMaterialProperties"):
            if tp.Material == material and tp.ThermalConductivity is not None:
                return tp.ThermalConductivity
        for ep in f.by_type("IfcExtendedMaterialProperties"):
            if ep.Material == material:
                for p in ep.ExtendedProperties or []:
                    if "conductivity" in (p.Name or "").lower() and getattr(p, "NominalValue", None) is not None:
                        return p.NominalValue.wrappedValue
    return None


def main(path, json_out=None):
    t0 = time.perf_counter()
    f = ifcopenshell.open(path)
    t_open = time.perf_counter() - t0
    R = collections.OrderedDict()
    R["file"] = path.split("/")[-1]
    R["schema"] = f.schema
    R["open_seconds"] = r(t_open)
    hdr = f.header
    R["mvd"] = list(hdr.file_description.description)[:1]
    R["originating_system"] = hdr.file_name.originating_system
    R["preprocessor"] = hdr.file_name.preprocessor_version
    apps = f.by_type("IfcApplication")
    R["applications"] = [f"{a.ApplicationFullName} {a.Version}" for a in apps]

    # ---- units
    scale = uunit.calculate_unit_scale(f)  # file length unit -> metres
    R["length_unit_to_m"] = scale
    units = {}
    for ua in f.by_type("IfcUnitAssignment"):
        for u in ua.Units:
            if u.is_a("IfcSIUnit"):
                units[u.UnitType] = (u.Prefix or "") + u.Name
            elif u.is_a("IfcConversionBasedUnit"):
                units[u.UnitType] = u.Name
    R["units"] = {k: units.get(k) for k in ("LENGTHUNIT", "AREAUNIT", "VOLUMEUNIT", "PLANEANGLEUNIT")}
    try:
        area_scale = uunit.calculate_unit_scale(f, "AREAUNIT")
        vol_scale = uunit.calculate_unit_scale(f, "VOLUMEUNIT")
    except Exception:
        area_scale, vol_scale = scale ** 2, scale ** 3
    R["area_unit_to_m2"] = area_scale
    R["volume_unit_to_m3"] = vol_scale

    # ---- north / georef
    tn = []
    for ctx in f.by_type("IfcGeometricRepresentationContext", include_subtypes=False):
        if ctx.TrueNorth is not None:
            dr = ctx.TrueNorth.DirectionRatios
            # angle of true north measured from +Y axis, clockwise positive (compass style)
            ang = math.degrees(math.atan2(dr[0], dr[1]))
            tn.append({"context": ctx.ContextType, "ratios": [r(x, 6) for x in dr], "north_is_deg_clockwise_from_plusY": r(ang, 2)})
        else:
            tn.append({"context": ctx.ContextType, "ratios": None})
    R["true_north"] = tn
    sites = f.by_type("IfcSite")
    R["site"] = [{"name": s.Name, "lat": list(s.RefLatitude) if s.RefLatitude else None, "lon": list(s.RefLongitude) if s.RefLongitude else None,
                  "elevation": s.RefElevation} for s in sites]
    R["map_conversion"] = len(f.by_type("IfcMapConversion")) if f.schema != "IFC2X3" else "n/a (IFC2x3)"
    bld = f.by_type("IfcBuilding")
    R["buildings"] = [{"name": b.Name, "address": (b.BuildingAddress.Town if b.BuildingAddress else None)} for b in bld]

    # ---- storeys
    st = []
    for s in sorted(f.by_type("IfcBuildingStorey"), key=lambda s: (s.Elevation or 0)):
        try:
            z = uplace.get_storey_elevation(s)
        except Exception:
            z = s.Elevation
        contained = [e for rel in s.ContainsElements for e in rel.RelatedElements]
        spaces = [o for rel in s.IsDecomposedBy for o in rel.RelatedObjects if o.is_a("IfcSpace")]
        st.append({"name": s.Name, "elevation_attr": r(s.Elevation), "elevation_m": r((z or 0) * scale), "n_elements": len(contained), "n_spaces": len(spaces)})
    R["storeys"] = st

    # ---- entity counts
    types = ["IfcSpace", "IfcZone", "IfcWall", "IfcWallStandardCase", "IfcCurtainWall", "IfcWindow", "IfcDoor", "IfcSlab", "IfcRoof", "IfcCovering",
             "IfcOpeningElement", "IfcColumn", "IfcBeam", "IfcStair", "IfcPlate", "IfcMember", "IfcBuildingElementProxy",
             "IfcRelSpaceBoundary", "IfcMaterialLayerSet", "IfcMaterialLayerSetUsage", "IfcMaterial", "IfcElementQuantity"]
    R["counts"] = {t: len(f.by_type(t)) for t in types}
    R["counts"]["IfcWall(excl. StandardCase)"] = len(f.by_type("IfcWall", include_subtypes=False))

    # ---- spaces
    sp = []
    for s in f.by_type("IfcSpace"):
        q = psets_of(s, qtos=True)
        flat = {}
        for qn, qv in q.items():
            for k, v in (qv.items() if isinstance(qv, dict) else []):
                if k != "id":
                    flat[f"{qn}.{k}"] = v
        def pick(*keys):
            for k, v in flat.items():
                if k.split(".")[-1] in keys and isinstance(v, (int, float)):
                    return k, v
            return None, None
        ka, a = pick("NetFloorArea", "GrossFloorArea", "Area")
        kh, h = pick("Height", "FinishCeilingHeight", "ClearHeight", "NetHeight")
        kv, v = pick("NetVolume", "GrossVolume", "Volume")
        storey = uel.get_container(s) or (s.Decomposes[0].RelatingObject if s.Decomposes else None)
        ps = psets_of(s)
        sp.append({"name": s.Name, "long_name": s.LongName, "storey": storey.Name if storey else None,
                   "interior_or_exterior": getattr(s, "InteriorOrExteriorSpace", None) or getattr(s, "PredefinedType", None),
                   "area_key": ka, "area": r(a), "height_key": kh, "height": r(h), "volume_key": kv, "volume": r(v),
                   "qto_sets": list(q.keys()), "psets": list(ps.keys()), "has_geometry": s.Representation is not None})
    R["spaces"] = sp

    # ---- walls
    walls = f.by_type("IfcWall")
    wsum = collections.Counter()
    wall_rows = []
    for w in walls:
        ps = psets_of(w)
        common = ps.get("Pset_WallCommon", {})
        ext = common.get("IsExternal")
        wsum[f"IsExternal={ext}"] += 1
        q = psets_of(w, qtos=True)
        qflat = {k: v for qv in q.values() if isinstance(qv, dict) for k, v in qv.items() if k != "id"}
        kind, layers = layer_set_of(w)
        wall_rows.append({"id": w.id(), "name": w.Name, "class": w.is_a(), "is_external": ext, "load_bearing": common.get("LoadBearing"),
                          "u_value_pset": common.get("ThermalTransmittance"),
                          "qto_keys": sorted(qflat.keys()), "gross_side_area": r(qflat.get("GrossSideArea")), "net_side_area": r(qflat.get("NetSideArea")),
                          "length": r(qflat.get("Length")), "height": r(qflat.get("Height")), "width": r(qflat.get("Width")),
                          "material_kind": kind, "layers": layers, "n_openings": len(w.HasOpenings)})
    R["walls_summary"] = dict(wsum)
    R["walls_with_pset_wallcommon"] = sum(1 for w in walls if "Pset_WallCommon" in psets_of(w))
    R["walls_with_qto"] = sum(1 for x in wall_rows if x["qto_keys"])
    R["walls_with_layerset"] = sum(1 for x in wall_rows if x["material_kind"] == "IfcMaterialLayerSet")
    R["walls_with_u_value"] = sum(1 for x in wall_rows if x["u_value_pset"] is not None)
    R["walls"] = wall_rows

    # ---- windows / doors
    def opening_rows(cls):
        rows = []
        for w in f.by_type(cls):
            ps = psets_of(w)
            common = ps.get(f"Pset_{cls[3:]}Common", {})
            host = None
            for rel in getattr(w, "FillsVoids", []) or []:
                op = rel.RelatingOpeningElement
                for rv in op.VoidsElements:
                    host = rv.RelatingBuildingElement
            q = psets_of(w, qtos=True)
            qflat = {k: v for qv in q.values() if isinstance(qv, dict) for k, v in qv.items() if k != "id"}
            thermal = find_prop(w, ["ThermalTransmittance", "GlazingAreaFraction", "SolarHeatGainTransmittance", "TotalSolarEnergyTransmittance", "SolarTransmittance", "VisibleLightTransmittance", "Heat Transfer Coefficient (U)", "Solar Heat Gain Coefficient"])
            rows.append({"id": w.id(), "name": w.Name, "overall_w": r(w.OverallWidth), "overall_h": r(w.OverallHeight),
                         "is_external": common.get("IsExternal"), "host": f"{host.is_a()}#{host.id()}" if host else None,
                         "host_is_external": (psets_of(host).get("Pset_WallCommon", {}).get("IsExternal") if host and host.is_a("IfcWall") else None),
                         "container": (uel.get_container(w).Name if uel.get_container(w) else None),
                         "thermal_props": thermal, "qto_keys": sorted(qflat.keys()), "qto_area": r(qflat.get("Area")),
                         "psets": list(ps.keys())})
        return rows
    R["windows"] = opening_rows("IfcWindow")
    R["doors"] = opening_rows("IfcDoor")
    for cls in ("windows", "doors"):
        rows = R[cls]
        R[cls + "_summary"] = {
            "n": len(rows),
            "with_overall_dims": sum(1 for x in rows if x["overall_w"] and x["overall_h"]),
            "with_host": sum(1 for x in rows if x["host"]),
            "host_classes": dict(collections.Counter((x["host"] or "None").split("#")[0] for x in rows)),
            "IsExternal": dict(collections.Counter(str(x["is_external"]) for x in rows)),
            "with_ThermalTransmittance": sum(1 for x in rows if any("ThermalTransmittance" in k or "Heat Transfer" in k for k in x["thermal_props"])),
            "with_GlazingAreaFraction": sum(1 for x in rows if any("GlazingAreaFraction" in k for k in x["thermal_props"])),
            "with_g_value": sum(1 for x in rows if any("Solar" in k for k in x["thermal_props"])),
        }

    # ---- slabs / roofs
    slabs = []
    for s in f.by_type("IfcSlab"):
        ps = psets_of(s)
        common = ps.get("Pset_SlabCommon", {})
        q = psets_of(s, qtos=True)
        qflat = {k: v for qv in q.values() if isinstance(qv, dict) for k, v in qv.items() if k != "id"}
        kind, layers = layer_set_of(s)
        cont = uel.get_container(s)
        agg = uel.get_aggregate(s)
        slabs.append({"id": s.id(), "name": s.Name, "predefined_type": s.PredefinedType, "is_external": common.get("IsExternal"),
                      "pitch_angle": common.get("PitchAngle"), "u_value_pset": common.get("ThermalTransmittance"),
                      "container": cont.Name if cont else None, "aggregate": agg.is_a() if agg else None,
                      "qto_keys": sorted(qflat.keys()), "gross_area": r(qflat.get("GrossArea")), "net_area": r(qflat.get("NetArea")),
                      "material_kind": kind, "layers": layers})
    R["slabs"] = slabs
    R["slabs_by_type"] = dict(collections.Counter(str(s["predefined_type"]) for s in slabs))
    roofs = []
    for ro in f.by_type("IfcRoof"):
        ps = psets_of(ro)
        parts = [o for rel in ro.IsDecomposedBy for o in rel.RelatedObjects]
        kind, layers = layer_set_of(ro)
        roofs.append({"id": ro.id(), "name": ro.Name, "type": getattr(ro, "PredefinedType", None) or getattr(ro, "ShapeType", None),
                      "has_own_geometry": ro.Representation is not None, "parts": dict(collections.Counter(p.is_a() for p in parts)),
                      "pset_roofcommon": ps.get("Pset_RoofCommon"), "material_kind": kind, "layers": layers})
    R["roofs"] = roofs

    # ---- materials & thermal
    mats = f.by_type("IfcMaterial")
    lam = {m.Name: material_thermal(f, m) for m in mats}
    R["materials_total"] = len(mats)
    R["materials_with_conductivity"] = {k: v for k, v in lam.items() if v is not None}
    lsets = []
    seen = set()
    for ls in f.by_type("IfcMaterialLayerSet"):
        key = (ls.LayerSetName, tuple((l.Material.Name if l.Material else None, l.LayerThickness) for l in ls.MaterialLayers))
        if key in seen:
            continue
        seen.add(key)
        layers = []
        Rsum, complete = 0.0, True
        for l in ls.MaterialLayers:
            name = l.Material.Name if l.Material else None
            d = l.LayerThickness * scale
            k = lam.get(name)
            if k and d > 0:
                Rsum += d / k
            elif d > 0:
                complete = False
            layers.append({"material": name, "thickness_m": r(d, 4), "lambda": k})
        # EN ISO 6946 wall: Rsi 0.13 + Rse 0.04
        u = 1.0 / (0.13 + Rsum + 0.04) if complete and Rsum > 0 else None
        lsets.append({"name": ls.LayerSetName, "layers": layers, "total_thickness_m": r(sum(l["thickness_m"] for l in layers), 4), "U_from_layers_wall_Rsi013_Rse004": r(u, 3)})
    R["layer_sets_unique"] = lsets

    # ---- space boundaries
    sb = f.by_type("IfcRelSpaceBoundary")
    sbs = {"total": len(sb)}
    if sb:
        sbs["by_class"] = dict(collections.Counter(b.is_a() for b in sb))
        sbs["by_name"] = dict(collections.Counter(str(b.Name) for b in sb))
        sbs["by_description"] = dict(collections.Counter(str(b.Description) for b in sb))
        sbs["internal_external"] = dict(collections.Counter(str(b.InternalOrExternalBoundary) for b in sb))
        sbs["physical_virtual"] = dict(collections.Counter(str(b.PhysicalOrVirtualBoundary) for b in sb))
        sbs["with_geometry"] = sum(1 for b in sb if b.ConnectionGeometry is not None)
        sbs["element_classes"] = dict(collections.Counter(b.RelatedBuildingElement.is_a() if b.RelatedBuildingElement else "None" for b in sb))
        geomtypes = collections.Counter()
        for b in sb:
            cg = b.ConnectionGeometry
            if cg is not None and cg.is_a("IfcConnectionSurfaceGeometry"):
                geomtypes[cg.SurfaceOnRelatingElement.is_a()] += 1
        sbs["geometry_types"] = dict(geomtypes)
    R["space_boundaries"] = sbs

    if json_out:
        with open(json_out, "w") as fh:
            json.dump(R, fh, indent=1, default=str)
    return R


def brief(R):
    print(f"\n===== {R['file']}  [{R['schema']}]  open {R['open_seconds']}s")
    print("MVD:", R["mvd"], "| app:", R["applications"])
    print("units:", R["units"], "| length->m:", R["length_unit_to_m"])
    print("true north:", R["true_north"])
    print("site:", R["site"], "| IfcMapConversion:", R["map_conversion"])
    print("storeys:")
    for s in R["storeys"]:
        print("   ", s)
    print("counts:", {k: v for k, v in R["counts"].items() if v})
    sp = R["spaces"]
    print(f"spaces: {len(sp)}; with area qty: {sum(1 for s in sp if s['area'] is not None)}; with height: {sum(1 for s in sp if s['height'] is not None)}; with volume: {sum(1 for s in sp if s['volume'] is not None)}; with geometry: {sum(1 for s in sp if s['has_geometry'])}")
    for s in sp[:6]:
        print("   ", {k: s[k] for k in ("name", "long_name", "storey", "area_key", "area", "height", "volume")})
    print("walls:", R["walls_summary"], "| with Pset_WallCommon:", R["walls_with_pset_wallcommon"], "| with Qto:", R["walls_with_qto"], "| with layer set:", R["walls_with_layerset"], "| with U:", R["walls_with_u_value"])
    for w in R["walls"][:3]:
        print("   ", {k: w[k] for k in ("name", "class", "is_external", "gross_side_area", "net_side_area", "length", "height", "width", "layers")})
    print("windows:", R["windows_summary"])
    for w in R["windows"][:3]:
        print("   ", {k: w[k] for k in ("name", "overall_w", "overall_h", "is_external", "host", "host_is_external", "thermal_props", "qto_area")})
    print("doors:", R["doors_summary"])
    print("slabs by PredefinedType:", R["slabs_by_type"])
    for s in R["slabs"][:6]:
        print("   ", {k: s[k] for k in ("name", "predefined_type", "is_external", "pitch_angle", "container", "aggregate", "gross_area", "net_area", "layers")})
    print("roofs:", R["roofs"])
    print("materials:", R["materials_total"], "| with conductivity:", R["materials_with_conductivity"])
    for ls in R["layer_sets_unique"][:8]:
        print("   LS", ls)
    print("space boundaries:", R["space_boundaries"])


if __name__ == "__main__":
    import os
    args = sys.argv[1:]
    out_dir = os.environ.get("OUT_DIR")
    for p in args:
        out = os.path.join(out_dir, os.path.basename(p) + ".inventory.json") if out_dir else None
        brief(main(p, out))
