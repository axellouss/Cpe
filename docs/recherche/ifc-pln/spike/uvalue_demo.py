"""U-value from IfcMaterialLayerSet + Pset_MaterialThermal (IFC4) / IfcThermalMaterialProperties (IFC2x3).

None of the 10 real sample files carries a non-zero thermal conductivity, so the code path is proven on
 (1) the Archicad FZK-Haus with conductivities patched into the Pset_MaterialThermal that Archicad already wrote (as 0.0)
 (2) a wall authored from scratch with the ifcopenshell API (4 layers)
Usage: python -I uvalue_demo.py <AC20-FZK-Haus.ifc> <out_dir>
"""
import sys, os
import ifcopenshell, ifcopenshell.api
import ifcopenshell.util.element as uel
import ifcopenshell.util.unit as uunit

# EN ISO 6946 surface resistances [m2K/W] (Rsi, Rse) by heat-flow direction
RS = {"wall": (0.13, 0.04), "roof": (0.10, 0.04), "floor": (0.17, 0.04)}


def conductivity(f, material):
    for mp in getattr(material, "HasProperties", None) or []:          # IFC4
        for p in mp.Properties:
            if p.Name == "ThermalConductivity" and p.NominalValue is not None:
                return p.NominalValue.wrappedValue
    if f.schema == "IFC2X3":                                            # IFC2x3
        for tp in f.by_type("IfcThermalMaterialProperties"):
            if tp.Material == material and tp.ThermalConductivity:
                return tp.ThermalConductivity
    return None


def u_value(f, element, kind="wall"):
    """-> (U or None, layers, reason)"""
    scale = uunit.calculate_unit_scale(f)
    mat = uel.get_material(element, should_skip_usage=True)
    if mat is None or not mat.is_a("IfcMaterialLayerSet"):
        return None, [], "no IfcMaterialLayerSet"
    rsi, rse = RS[kind]
    R, layers, missing = rsi + rse, [], []
    for l in mat.MaterialLayers:
        d = l.LayerThickness * scale
        lam = conductivity(f, l.Material) if l.Material else None
        name = l.Material.Name if l.Material else None
        layers.append((name, round(d, 4), lam))
        if not lam or lam <= 0:      # Archicad writes 0.0 when the building material has no physical data
            missing.append(name)
        else:
            R += d / lam
    if missing:
        return None, layers, f"no conductivity for: {missing}"
    return 1.0 / R, layers, "ok (homogeneous layers only; no correction for studs, air gaps, fixings)"


def demo_patch(src, out_dir):
    f = ifcopenshell.open(src)
    lam = {"Leichtbeton": 0.21, "Stahlbeton": 2.3, "Solid": 0.13}
    n = 0
    for m in f.by_type("IfcMaterial"):
        for mp in m.HasProperties:
            for p in mp.Properties:
                if p.Name == "ThermalConductivity":
                    key = next((k for k in lam if m.Name.startswith(k)), None)
                    if key:
                        p.NominalValue = f.create_entity("IfcThermalConductivityMeasure", lam[key]); n += 1
    out = os.path.join(out_dir, "AC20-FZK-Haus_with_lambda.ifc")
    f.write(out)
    print(f"(1) patched {n} materials -> {out}")
    g = ifcopenshell.open(out)
    seen = set()
    for el, kind in [(w, "wall") for w in g.by_type("IfcWall")] + [(s, "roof" if s.PredefinedType == "ROOF" else "floor") for s in g.by_type("IfcSlab")]:
        u, layers, why = u_value(g, el, kind)
        key = (kind, tuple(layers))
        if key in seen:
            continue
        seen.add(key)
        declared = uel.get_psets(el).get(f"Pset_{el.is_a()[3:].replace('StandardCase','')}Common", {}).get("ThermalTransmittance")
        print(f"    {el.is_a():22s} {kind:5s} layers={layers}  U_from_layers={None if u is None else round(u,3)}  U_declared_in_pset={declared}  [{why}]")
    return out


def demo_author(out_dir):
    f = ifcopenshell.api.run("project.create_file", version="IFC4")
    ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="U-value demo")
    ifcopenshell.api.run("unit.assign_unit", f)       # default: millimetres
    wall = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWall", name="AW1 - exterior wall")
    ls = ifcopenshell.api.run("material.add_material_set", f, name="AW1", set_type="IfcMaterialLayerSet")
    spec = [("Exterior render", 15, 0.87), ("EPS 032", 160, 0.032), ("Clay block", 240, 0.45), ("Gypsum plaster", 15, 0.51)]
    for name, d_mm, lam in spec:
        m = ifcopenshell.api.run("material.add_material", f, name=name)
        layer = ifcopenshell.api.run("material.add_layer", f, layer_set=ls, material=m)
        ifcopenshell.api.run("material.edit_layer", f, layer=layer, attributes={"LayerThickness": d_mm})
        pset = ifcopenshell.api.run("pset.add_pset", f, product=m, name="Pset_MaterialThermal")
        ifcopenshell.api.run("pset.edit_pset", f, pset=pset, properties={"ThermalConductivity": lam})
    ifcopenshell.api.run("material.assign_material", f, products=[wall], material=ls)
    out = os.path.join(out_dir, "authored_wall_uvalue.ifc")
    f.write(out)
    g = ifcopenshell.open(out)
    u, layers, why = u_value(g, g.by_type("IfcWall")[0], "wall")
    hand = 1 / (0.13 + 0.015 / 0.87 + 0.160 / 0.032 + 0.240 / 0.45 + 0.015 / 0.51 + 0.04)
    print(f"(2) authored {out}\n    layers={layers}\n    U_from_layers={u:.4f}  hand calculation={hand:.4f}  [{why}]")
    return out


if __name__ == "__main__":
    os.makedirs(sys.argv[2], exist_ok=True)
    demo_patch(sys.argv[1], sys.argv[2])
    demo_author(sys.argv[2])
