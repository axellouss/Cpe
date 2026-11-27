"""Variant of energy_quantities.py that does NOT trust IfcRelContainedInSpatialStructure:
the building is sliced into horizontal bands at the storey elevations and every wall contributes to each band
its geometry overlaps (Revit exports multi-storey walls attached to their base level only).

Usage: python -I energy_bands.py <file.ifc> [--min-band 1.8]
"""
import sys, os, json, math, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import shapely
from shapely.geometry import Polygon
from shapely.ops import unary_union
import ifcopenshell
import ifcopenshell.util.unit as uunit
from energy_quantities import tessellate, tri_props, projection_2d, fill_holes, sector, SECTORS, OFFSET, CLOSE_EPS, BOUNDARY_TOL, r


def clip_area_z(p, zlo, zhi):
    """area of triangle p[3,3] between two horizontal planes (Sutherland-Hodgman)"""
    poly = [p[0], p[1], p[2]]
    for z, keep_above in ((zlo, True), (zhi, False)):
        if not np.isfinite(z):
            continue
        out = []
        for i in range(len(poly)):
            a, b = poly[i], poly[(i + 1) % len(poly)]
            ina = (a[2] >= z) if keep_above else (a[2] <= z)
            inb = (b[2] >= z) if keep_above else (b[2] <= z)
            if ina:
                out.append(a)
            if ina != inb:
                t = (z - a[2]) / (b[2] - a[2])
                out.append(a + t * (b - a))
        poly = out
        if len(poly) < 3:
            return 0.0
    s = np.zeros(3)
    for i in range(1, len(poly) - 1):
        s += np.cross(poly[i] - poly[0], poly[i + 1] - poly[0])
    return 0.5 * float(np.linalg.norm(s))


def analyse(path, min_band=1.8):
    f = ifcopenshell.open(path)
    scale = uunit.calculate_unit_scale(f)
    north = (0.0, 1.0)
    for ctx in f.by_type("IfcGeometricRepresentationContext", include_subtypes=False):
        if ctx.TrueNorth is not None:
            north = tuple(float(x) for x in ctx.TrueNorth.DirectionRatios[:2])
    nb = math.degrees(math.atan2(north[0], north[1]))
    az = lambda nx, ny: (math.degrees(math.atan2(nx, ny)) - nb) % 360.0
    walls = list(f.by_type("IfcWall")); spaces = list(f.by_type("IfcSpace"))
    G = tessellate(f, walls, gross=True)
    GS = tessellate(f, spaces)
    zr = {i: (v[:, 2].min(), v[:, 2].max()) for i, (v, fc) in {**G, **GS}.items()}
    # bands from storey elevations; levels closer than min_band to the previous one are merged
    levels = sorted({round((s.Elevation or 0.0) * scale, 3) for s in f.by_type("IfcBuildingStorey")})
    zmax = max(z1 for i, (z0, z1) in zr.items() if i in G)
    zmin = min(z0 for i, (z0, z1) in zr.items() if i in G)
    cuts = []
    for z in levels:
        if z >= zmax - 1.0:
            continue
        if cuts and z - cuts[-1] < min_band:
            continue
        cuts.append(z)
    names = {round((s.Elevation or 0.0) * scale, 3): s.Name for s in f.by_type("IfcBuildingStorey")}
    out = collections.OrderedDict(file=os.path.basename(path), levels_in_file=len(levels), bands=[])
    tot = collections.defaultdict(float)
    for k, z in enumerate(cuts):
        zlo = -math.inf if k == 0 else z
        zhi = math.inf if k == len(cuts) - 1 else cuts[k + 1]
        lo_f, hi_f = max(zlo, zmin), min(zhi, zmax)
        need = min(1.0, 0.5 * (hi_f - lo_f))
        # a wall belongs to the band if it overlaps it by `need`, or by more than half of its own height
        # (knee walls of 0.5 m under a pitched roof were dropped by the first rule alone)
        def ov(i):
            return min(hi_f, zr[i][1]) - max(lo_f, zr[i][0])
        w_in = [i for i in G if ov(i) >= need or ov(i) > 0.5 * (zr[i][1] - zr[i][0])]
        s_in = [i for i in GS if min(hi_f, zr[i][1]) - max(lo_f, zr[i][0]) >= need]
        parts = [projection_2d(*G[i]) for i in w_in] + [projection_2d(*GS[i]) for i in s_in]
        parts = [p for p in parts if not p.is_empty]
        if not parts:
            continue
        u = fill_holes(unary_union(parts).buffer(CLOSE_EPS, join_style=2).buffer(-CLOSE_EPS, join_style=2))
        comps = [c for c in ([u] if u.geom_type == "Polygon" else list(u.geoms)) if c.area > 4.0]
        if not comps:
            continue
        foot = unary_union(comps)
        fac = collections.defaultdict(float)
        for i in w_in:
            v, fc = G[i]
            nn, area, cen, (a, b, c) = tri_props(v, fc)
            idx = np.nonzero((np.abs(nn[:, 2]) < 0.2) & (area > 1e-7))[0]
            if not len(idx):
                continue
            h = nn[idx, :2] / np.linalg.norm(nn[idx, :2], axis=1)[:, None]
            pf = cen[idx, :2] + OFFSET * h; pb = cen[idx, :2] - OFFSET * h
            i_f = shapely.contains_xy(foot, pf[:, 0], pf[:, 1]); i_b = shapely.contains_xy(foot, pb[:, 0], pb[:, 1])
            dist = shapely.distance(foot.boundary, shapely.points(cen[idx, 0], cen[idx, 1]))
            for j, t in enumerate(idx):
                if i_f[j] != i_b[j] and dist[j] < BOUNDARY_TOL:
                    sg = 1.0 if not i_f[j] else -1.0
                    ar = clip_area_z(np.array([a[t], b[t], c[t]]), zlo, zhi)
                    if ar > 0:
                        fac[sector(az(sg * h[j, 0], sg * h[j, 1]))] += ar
        for s_, a_ in fac.items():
            tot[s_] += a_
        out["bands"].append({"from_level": names.get(z), "z_from": r(lo_f), "z_to": r(hi_f), "walls": len(w_in), "spaces": len(s_in),
                             "footprint_components": len(comps), "gross_footprint_area_m2": r(foot.area), "largest_component_m2": r(max(c.area for c in comps)),
                             "facade_gross_by_orientation_m2": {s_: r(fac[s_]) for s_ in SECTORS if fac[s_] > 0.01}})
    out["facade_gross_by_orientation_m2"] = {s_: r(tot[s_]) for s_ in SECTORS if tot[s_] > 0.01}
    out["facade_gross_total_m2"] = r(sum(tot.values()))
    out["gross_floor_area_m2"] = r(sum(b["gross_footprint_area_m2"] for b in out["bands"]))
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    mb = 1.8
    if "--min-band" in args:
        i = args.index("--min-band"); mb = float(args[i + 1]); args = args[:i] + args[i + 2:]
    for p in args:
        R = analyse(p, mb)
        print(f"\n===== {R['file']}  (z-band slicing; {R['levels_in_file']} levels in file -> {len(R['bands'])} bands)")
        for b in R["bands"]:
            print("  ", json.dumps(b, ensure_ascii=False))
        print("   TOTAL facade gross:", R["facade_gross_by_orientation_m2"], "=", R["facade_gross_total_m2"], "m2 | gross floor area:", R["gross_floor_area_m2"], "m2")
