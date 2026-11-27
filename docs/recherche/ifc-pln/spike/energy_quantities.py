"""First cut of the quantities an energy certificate needs, computed from IFC GEOMETRY
(does not trust Pset IsExternal / base quantities; reports them side by side instead).

Usage: python -I energy_quantities.py <file.ifc> [--json out.json] [--grid 0.05]

Method (all in metres, world coordinates, Z up):
 1. tessellate walls / slabs / roofs / spaces / windows / doors with ifcopenshell.geom
    (walls+slabs twice: with and without opening subtraction => net and gross)
 2. per storey: FOOTPRINT (external dimensions) = union of the 2D projections of walls, floor slabs and
    spaces of that storey, small gaps closed, holes filled  (shapely)
 3. FACADE: every vertical triangle of a wall/floor-slab for which a point 10 cm in front lies OUTSIDE the
    footprint and a point 10 cm behind lies INSIDE => exterior face, outward normal known => compass azimuth
    using IfcGeometricRepresentationContext.TrueNorth
 4. WINDOWS/DOORS: area = OverallWidth x OverallHeight, plane normal by PCA of the mesh, exterior + sign by the
    same in/out test => orientation
 5. ROOF: upward triangles of ROOF slabs / IfcRoof geometry clipped to the footprint, slope from normal
 6. GROSS VOLUME: height field (max Z / min Z of the envelope meshes on a grid), clipped per storey band and
    masked by the storey footprint
 7. FLOOR AREA: IfcSpace quantities vs. area recomputed from the space geometry
 8. if IfcRelSpaceBoundary exist: areas of EXTERNAL boundaries by element class + orientation (inner dimensions)
"""
import sys, json, math, time, collections, multiprocessing
import numpy as np
import ifcopenshell, ifcopenshell.geom
import ifcopenshell.util.unit as uunit
import ifcopenshell.util.element as uel
import ifcopenshell.util.placement as uplace
import shapely
from shapely.geometry import Polygon, MultiPolygon, Point
from shapely.ops import unary_union

SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
OFFSET = 0.10      # m, in/out probe distance for wall faces
CLOSE_EPS = 0.06   # m, gap closing of footprints
FOOTPRINT_WITH_SLABS = False
BOUNDARY_TOL = 0.03  # m, a facade face must lie this close to the footprint outline


def sector(az):
    return SECTORS[int(((az + 22.5) % 360) // 45)]


def r(x, n=2):
    return None if x is None else round(float(x), n)


def tessellate(f, elements, gross=False):
    """-> {id: (verts[n,3], faces[m,3])} in metres, world coords"""
    out = {}
    if not elements:
        return out
    s = ifcopenshell.geom.settings()
    s.set("use-world-coords", True)
    if gross:
        s.set("disable-opening-subtractions", True)
    it = ifcopenshell.geom.iterator(s, f, multiprocessing.cpu_count(), include=elements)
    if not it.initialize():
        return out
    while True:
        sh = it.get()
        v = np.array(sh.geometry.verts, dtype=float).reshape(-1, 3)
        fc = np.array(sh.geometry.faces, dtype=int).reshape(-1, 3)
        if len(fc):
            out[sh.id] = (v, fc)
        if not it.next():
            break
    return out


def tri_props(v, fc):
    a, b, c = v[fc[:, 0]], v[fc[:, 1]], v[fc[:, 2]]
    n = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(n, axis=1)
    ok = area > 1e-9
    nn = np.zeros_like(n)
    nn[ok] = n[ok] / (2 * area[ok, None])
    cen = (a + b + c) / 3.0
    return nn, area, cen, (a, b, c)


def mesh_volume(v, fc):
    a, b, c = v[fc[:, 0]], v[fc[:, 1]], v[fc[:, 2]]
    return abs(float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6.0)


def projection_2d(v, fc, min_area=1e-6):
    """2D footprint polygon (union of projected triangles)"""
    tris = []
    for t in fc:
        p = v[t][:, :2]
        ar = 0.5 * abs((p[1, 0] - p[0, 0]) * (p[2, 1] - p[0, 1]) - (p[2, 0] - p[0, 0]) * (p[1, 1] - p[0, 1]))
        if ar > min_area:
            tris.append(Polygon(p))
    if not tris:
        return Polygon()
    return unary_union(tris)


def fill_holes(g):
    if g.is_empty:
        return g
    polys = [g] if g.geom_type == "Polygon" else [p for p in g.geoms if p.geom_type == "Polygon"]
    return unary_union([Polygon(p.exterior) for p in polys])


def clear_height_areas(v, fc, grid=0.05, thresholds=(1.0, 1.5, 2.0)):
    """floor area of a space mesh where the clear height (top - bottom of the space solid) >= threshold"""
    minx, miny = v[:, 0].min(), v[:, 1].min()
    nx_ = int(math.ceil((v[:, 0].max() - minx) / grid)) + 1
    ny_ = int(math.ceil((v[:, 1].max() - miny) / grid)) + 1
    xs = minx + (np.arange(nx_) + 0.5) * grid
    ys = miny + (np.arange(ny_) + 0.5) * grid
    ztop = np.full((nx_, ny_), -np.inf); zbot = np.full((nx_, ny_), np.inf)
    raster_tris(v, fc, xs, ys, minx, miny, grid, ztop, zbot)
    ok = np.isfinite(ztop) & np.isfinite(zbot)
    h = np.where(ok, ztop - zbot, 0.0)
    out = {"raster_area": r(ok.sum() * grid * grid)}
    for th in thresholds:
        out[f"area_h>={th}m"] = r((h >= th).sum() * grid * grid)
    return out


def raster_tris(v, fc, xs, ys, minx, miny, grid, ztop, zbot):
    nx_, ny_ = ztop.shape
    n = 0
    for tri in fc:
        p = v[tri]
        i0 = max(0, int((p[:, 0].min() - minx) / grid)); i1 = min(nx_ - 1, int((p[:, 0].max() - minx) / grid))
        j0 = max(0, int((p[:, 1].min() - miny) / grid)); j1 = min(ny_ - 1, int((p[:, 1].max() - miny) / grid))
        if i1 < i0 or j1 < j0:
            continue
        d = (p[1, 1] - p[2, 1]) * (p[0, 0] - p[2, 0]) + (p[2, 0] - p[1, 0]) * (p[0, 1] - p[2, 1])
        if abs(d) < 1e-12:
            continue  # vertical triangle: no XY extent
        X, Y = np.meshgrid(xs[i0:i1 + 1], ys[j0:j1 + 1], indexing="ij")
        l1 = ((p[1, 1] - p[2, 1]) * (X - p[2, 0]) + (p[2, 0] - p[1, 0]) * (Y - p[2, 1])) / d
        l2 = ((p[2, 1] - p[0, 1]) * (X - p[2, 0]) + (p[0, 0] - p[2, 0]) * (Y - p[2, 1])) / d
        l3 = 1 - l1 - l2
        m = (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9)
        if not m.any():
            continue
        Z = l1 * p[0, 2] + l2 * p[1, 2] + l3 * p[2, 2]
        sub_t = ztop[i0:i1 + 1, j0:j1 + 1]; sub_b = zbot[i0:i1 + 1, j0:j1 + 1]
        sub_t[m] = np.maximum(sub_t[m], Z[m]); sub_b[m] = np.minimum(sub_b[m], Z[m])
        n += 1
    return n


def storey_of(el):
    c = uel.get_container(el)
    if c is None:
        agg = uel.get_aggregate(el)
        while agg is not None and c is None:
            if agg.is_a("IfcBuildingStorey"):
                c = agg
                break
            c = uel.get_container(agg)
            agg = uel.get_aggregate(agg)
    if c is None and el.is_a("IfcSpace") and el.Decomposes:
        c = el.Decomposes[0].RelatingObject
    return c if (c is not None and c.is_a("IfcBuildingStorey")) else None


def analyse(path, grid=0.05, verbose=True):
    T = collections.OrderedDict()
    t0 = time.perf_counter()
    f = ifcopenshell.open(path)
    scale = uunit.calculate_unit_scale(f)
    R = collections.OrderedDict(file=path.split("/")[-1], schema=f.schema, length_unit_to_m=scale)

    # ---------- north
    north_xy = None
    for ctx in f.by_type("IfcGeometricRepresentationContext", include_subtypes=False):
        if ctx.TrueNorth is not None and (ctx.ContextType in ("Model", "Design", None) or north_xy is None):
            dr = ctx.TrueNorth.DirectionRatios
            north_xy = (float(dr[0]), float(dr[1]))
    R["true_north_present"] = north_xy is not None
    if north_xy is None:
        north_xy = (0.0, 1.0)
    north_bearing = math.degrees(math.atan2(north_xy[0], north_xy[1]))  # clockwise from +Y
    R["true_north_deg_clockwise_from_plusY"] = r(north_bearing)

    def azimuth(nx, ny):
        return (math.degrees(math.atan2(nx, ny)) - north_bearing) % 360.0

    # ---------- elements
    walls = list(f.by_type("IfcWall"))
    slabs = list(f.by_type("IfcSlab"))
    roofs = [x for x in f.by_type("IfcRoof") if x.Representation is not None]
    spaces = list(f.by_type("IfcSpace"))
    windows = list(f.by_type("IfcWindow"))
    doors = list(f.by_type("IfcDoor"))
    cw_parts = []
    for cw in f.by_type("IfcCurtainWall"):
        cw_parts += [o for rel in cw.IsDecomposedBy for o in rel.RelatedObjects if o.Representation is not None]
        if cw.Representation is not None:
            cw_parts.append(cw)

    def slab_kind(s):
        agg = uel.get_aggregate(s)
        if (agg is not None and agg.is_a("IfcRoof")) or s.PredefinedType == "ROOF":
            return "ROOF"
        return s.PredefinedType or "NOTDEFINED"
    kinds = {s.id(): slab_kind(s) for s in slabs}
    roof_like = [s for s in slabs if kinds[s.id()] == "ROOF"] + roofs
    floor_like = [s for s in slabs if kinds[s.id()] in ("FLOOR", "BASESLAB", "NOTDEFINED", "USERDEFINED")]

    t = time.perf_counter()
    G_gross = tessellate(f, walls + slabs + roofs + cw_parts, gross=True)
    G_net = tessellate(f, walls, gross=False)
    G_other = tessellate(f, spaces + windows + doors)
    T["tessellation_s"] = r(time.perf_counter() - t)
    R["tessellated"] = {"gross(walls+slabs+roofs)": len(G_gross), "net(walls)": len(G_net), "spaces+windows+doors": len(G_other),
                        "failed": (len(walls + slabs + roofs + cw_parts) - len(G_gross)) + (len(spaces + windows + doors) - len(G_other))}

    # ---------- storeys
    storeys = sorted(f.by_type("IfcBuildingStorey"), key=lambda s: (s.Elevation or 0.0))
    st_info = collections.OrderedDict()
    for s in storeys:
        try:
            z = uplace.get_storey_elevation(s) * scale
        except Exception:
            z = (s.Elevation or 0.0) * scale
        st_info[s.id()] = {"name": s.Name, "z": z, "walls": [], "floors": [], "spaces": [], "roofs": []}
    for w in walls + cw_parts:
        st = storey_of(w)
        if st and w.id() in G_gross:
            st_info[st.id()]["walls"].append(w.id())
    for s in floor_like:
        st = storey_of(s)
        if st and s.id() in G_gross:
            st_info[st.id()]["floors"].append(s.id())
    for s in roof_like:
        st = storey_of(s)
        if st and s.id() in G_gross:
            st_info[st.id()]["roofs"].append(s.id())
    for s in spaces:
        st = storey_of(s)
        if st and s.id() in G_other:
            st_info[st.id()]["spaces"].append(s.id())

    # ---------- footprints (external dimensions)
    t = time.perf_counter()
    proj_cache = {}

    def proj(i):
        if i not in proj_cache:
            v, fc = G_gross.get(i) or G_other.get(i)
            proj_cache[i] = projection_2d(v, fc)
        return proj_cache[i]

    foot = {}
    for sid, info in st_info.items():
        parts = [proj(i) for i in info["walls"] + info["spaces"]]
        # floor slabs are NOT used when walls/spaces exist: porches, terraces and balconies would inflate the
        # footprint (seen on the Revit Duplex sample: +51 m2 on level 1 and the N/S facades were lost)
        if FOOTPRINT_WITH_SLABS and (info["walls"] or info["spaces"]):
            parts += [proj(i) for i in info["floors"]]
        parts = [p for p in parts if not p.is_empty]
        if not parts:
            foot[sid] = Polygon()
            continue
        u = unary_union(parts).buffer(CLOSE_EPS, join_style=2).buffer(-CLOSE_EPS, join_style=2)
        u = fill_holes(u)
        # keep significant components
        comps = [u] if u.geom_type == "Polygon" else list(u.geoms)
        comps = [c for c in comps if c.area > 4.0]
        if info["spaces"]:
            sp_union = unary_union([proj(i) for i in info["spaces"]])
            comps = [c for c in comps if c.intersects(sp_union)]
        foot[sid] = unary_union(comps) if comps else Polygon()
    T["footprints_s"] = r(time.perf_counter() - t)

    # a storey is "real" if it has a footprint
    real = [sid for sid in st_info if foot[sid].area > 4.0]
    for sid in st_info:
        st_info[sid]["footprint_area"] = foot[sid].area
        st_info[sid]["footprint_perimeter"] = foot[sid].length
    zs = [st_info[sid]["z"] for sid in real]

    # ---------- facade: exterior vertical triangles of walls and floor-slab edges
    t = time.perf_counter()
    facade = collections.defaultdict(float)          # (storey, sector) -> gross area
    facade_net = collections.defaultdict(float)
    facade_by_wall = {}
    slab_edge = collections.defaultdict(float)
    geo_external_walls = {}
    wall_ext_normals = {}

    def exterior_tris(v, fc, poly):
        nn, area, cen, _ = tri_props(v, fc)
        vert = (np.abs(nn[:, 2]) < 0.2) & (area > 1e-7)
        res = []
        if not vert.any() or poly.is_empty:
            return res
        idx = np.nonzero(vert)[0]
        h = nn[idx, :2]
        h = h / np.linalg.norm(h, axis=1)[:, None]
        pf = cen[idx, :2] + OFFSET * h
        pb = cen[idx, :2] - OFFSET * h
        inside_f = shapely.contains_xy(poly, pf[:, 0], pf[:, 1])
        inside_b = shapely.contains_xy(poly, pb[:, 0], pb[:, 1])
        # the face itself must lie on the footprint outline (tolerance BOUNDARY_TOL), otherwise a slab that is
        # recessed by exactly OFFSET behind the facade would be picked up
        dist = shapely.distance(poly.boundary, shapely.points(cen[idx, 0], cen[idx, 1]))
        for k, i in enumerate(idx):
            if inside_f[k] != inside_b[k] and dist[k] < BOUNDARY_TOL:
                sgn = 1.0 if not inside_f[k] else -1.0   # outward = towards the outside probe
                res.append((i, area[i], sgn * h[k, 0], sgn * h[k, 1]))
        return res

    for sid in real:
        poly = foot[sid]
        for wid in st_info[sid]["walls"]:
            v, fc = G_gross[wid]
            ext = exterior_tris(v, fc, poly)
            g = collections.defaultdict(float)
            for _, a, nx, ny in ext:
                g[sector(azimuth(nx, ny))] += a
            n = collections.defaultdict(float)
            if wid in G_net:
                for _, a, nx, ny in exterior_tris(*G_net[wid], poly):
                    n[sector(azimuth(nx, ny))] += a
            tot = sum(g.values())
            if tot > 0.5:
                geo_external_walls[wid] = tot
                nacc = collections.defaultdict(float)
                for _, a, nx, ny in ext:
                    nacc[(round(nx, 2), round(ny, 2))] += a
                wall_ext_normals[wid] = nacc
                facade_by_wall[wid] = {"gross": dict(g), "net": dict(n)}
                for k2, a in g.items():
                    facade[(sid, k2)] += a
                for k2, a in n.items():
                    facade_net[(sid, k2)] += a
        for fid in st_info[sid]["floors"]:
            v, fc = G_gross[fid]
            for _, a, nx, ny in exterior_tris(v, fc, poly):
                slab_edge[(sid, sector(azimuth(nx, ny)))] += a
    T["facade_s"] = r(time.perf_counter() - t)

    # compare geometric exterior test with Pset_WallCommon.IsExternal
    cmp = collections.Counter()
    for w in walls:
        if w.id() not in G_gross:
            continue
        pe = uel.get_psets(w).get("Pset_WallCommon", {}).get("IsExternal")
        ge = w.id() in geo_external_walls
        cmp[f"pset={pe}|geometry={'EXT' if ge else 'INT'}"] += 1
    R["IsExternal_pset_vs_geometry"] = dict(cmp)

    # ---------- windows / doors
    t = time.perf_counter()
    openings = []
    all_foot = unary_union([foot[sid] for sid in real]) if real else Polygon()
    for el in windows + doors:
        ow, oh = el.OverallWidth, el.OverallHeight
        area_attr = (ow * scale) * (oh * scale) if ow and oh else None
        row = {"id": el.id(), "class": el.is_a(), "name": el.Name, "area_overall": r(area_attr, 3)}
        st = storey_of(el)
        row["storey"] = st.Name if st else None
        host = None
        for rel in el.FillsVoids or []:
            for rv in rel.RelatingOpeningElement.VoidsElements:
                host = rv.RelatingBuildingElement
        row["host"] = host.is_a() if host else None
        row["pset_IsExternal"] = uel.get_psets(el).get(f"Pset_{el.is_a()[3:]}Common", {}).get("IsExternal")
        if el.id() in G_other:
            v, _ = G_other[el.id()]
            c = v.mean(axis=0)
            # plane normal = direction of least extent (PCA)
            w_, vec = np.linalg.eigh(np.cov((v - c).T))
            n = vec[:, 0]
            ext3 = v.max(0) - v.min(0)
            row["bbox_area"] = r(float(np.sort(np.ptp((v - c) @ vec, axis=0))[1:].prod()), 3)
            # silhouette: mesh projected onto the window plane (detects round / arched / triangular windows)
            uv = (v - c) @ vec[:, 1:]
            fcw = G_other[el.id()][1]
            def _a2(t_):
                e1 = uv[t_[1]] - uv[t_[0]]; e2 = uv[t_[2]] - uv[t_[0]]
                return abs(e1[0] * e2[1] - e1[1] * e2[0])
            sil = unary_union([Polygon(uv[t_]) for t_ in fcw if _a2(t_) > 1e-7])
            row["silhouette_area"] = r(sil.area, 3)
            poly = foot.get(st.id()) if st is not None and st.id() in foot and foot[st.id()].area > 4 else all_foot
            if abs(n[2]) > 0.5:
                row["exterior"] = True
                row["orientation"] = "ROOF/HORIZONTAL"
                row["slope_deg"] = r(math.degrees(math.acos(abs(n[2]))), 1)
                if abs(n[2]) < 0.999:
                    sg = 1.0 if n[2] > 0 else -1.0
                    row["azimuth"] = r(azimuth(sg * n[0], sg * n[1]), 1)
                    row["orientation"] = "ROOF-" + sector(row["azimuth"])
            else:
                h = n[:2] / np.linalg.norm(n[:2])
                D = 0.6
                o1 = not poly.contains(Point(c[0] + D * h[0], c[1] + D * h[1]))
                o2 = not poly.contains(Point(c[0] - D * h[0], c[1] - D * h[1]))
                if o1 != o2:
                    sg = 1.0 if o1 else -1.0
                    hx, hy = sg * h[0], sg * h[1]
                    row["normal_source"] = "pca"
                    # snap to the exterior face normal of the host wall (door leaves drawn open disturb the PCA)
                    if host is not None and host.id() in wall_ext_normals:
                        best = max(wall_ext_normals[host.id()].items(), key=lambda kv: (kv[0][0] * hx + kv[0][1] * hy > 0.9, kv[1]))
                        if best[0][0] * hx + best[0][1] * hy > 0.9:
                            hx, hy = best[0]
                            row["normal_source"] = "host-wall"
                    row["exterior"] = True
                    row["azimuth"] = r(azimuth(hx, hy), 1)
                    row["orientation"] = sector(row["azimuth"])
                else:
                    row["exterior"] = False if not (o1 and o2) else None  # None: outside the footprint on both sides
        else:
            row["exterior"] = None
            row["note"] = "no geometry"
        openings.append(row)
    T["openings_s"] = r(time.perf_counter() - t)

    win_by_or = collections.defaultdict(float)
    door_by_or = collections.defaultdict(float)
    for o in openings:
        if o.get("exterior") and o["area_overall"]:
            (win_by_or if o["class"] == "IfcWindow" else door_by_or)[o["orientation"]] += o["area_overall"]
    cmpw = collections.Counter(f"{o['class']}: pset={o['pset_IsExternal']}|geometry={'EXT' if o.get('exterior') else ('INT' if o.get('exterior') is False else '?')}" for o in openings)
    R["openings_IsExternal_pset_vs_geometry"] = dict(cmpw)

    # ---------- roofs
    t = time.perf_counter()
    roof_rows = collections.defaultdict(lambda: [0.0, 0.0])  # (slope, sector) -> [area within footprint, total incl. overhang]
    top_fp = all_foot
    for el in roof_like:
        if el.id() not in G_gross:
            continue
        v, fc = G_gross[el.id()]
        nn, area, cen, (a, b, c) = tri_props(v, fc)
        zmid = (v[:, 2].min() + v[:, 2].max()) / 2
        # top surface only: upward triangles; for a slab of constant thickness the top has the higher plane offset
        up = np.nonzero(nn[:, 2] > 0.05)[0]
        for i in up:
            slope = math.degrees(math.acos(min(1.0, nn[i, 2])))
            key_or = "HORIZONTAL" if slope < 5 else sector(azimuth(nn[i, 0], nn[i, 1]))
            tri2 = Polygon([a[i, :2], b[i, :2], c[i, :2]])
            inside = tri2.intersection(top_fp).area / nn[i, 2] if tri2.is_valid and not top_fp.is_empty else 0.0
            key = (int(round(slope / 1.0)), key_or)
            roof_rows[key][0] += inside
            roof_rows[key][1] += area[i]
    T["roof_s"] = r(time.perf_counter() - t)

    # ---------- spaces
    sp_rows = []
    for s in spaces:
        q = uel.get_psets(s, qtos_only=True)
        flat = {k: v for qv in q.values() for k, v in qv.items() if k != "id" and isinstance(v, (int, float))}
        qa = next((flat[k] for k in ("NetFloorArea", "GrossFloorArea") if k in flat), None)
        qv = next((flat[k] for k in ("NetVolume", "GrossVolume") if k in flat), None)
        st = storey_of(s)
        row = {"name": s.Name, "long_name": s.LongName, "storey": st.Name if st else None, "qto_area": r(qa), "qto_volume": r(qv)}
        if s.id() in G_other:
            v, fc = G_other[s.id()]
            nn, area, cen, _ = tri_props(v, fc)
            row["geom_floor_area"] = r(area[nn[:, 2] < -0.99].sum())
            row["geom_proj_area"] = r(proj(s.id()).area)
            row["geom_height"] = r(v[:, 2].max() - v[:, 2].min())
            row["geom_volume"] = r(mesh_volume(v, fc))
            ch = clear_height_areas(v, fc)
            row.update(ch)
        sp_rows.append(row)
    R["spaces"] = sp_rows

    # ---------- gross volume by height field
    t = time.perf_counter()
    vol = {}
    if real:
        minx, miny, maxx, maxy = all_foot.bounds
        nx_ = int(math.ceil((maxx - minx) / grid)) + 1
        ny_ = int(math.ceil((maxy - miny) / grid)) + 1
        ztop = np.full((nx_, ny_), -np.inf)
        zbot = np.full((nx_, ny_), np.inf)
        xs = minx + (np.arange(nx_) + 0.5) * grid
        ys = miny + (np.arange(ny_) + 0.5) * grid
        env_ids = [i for sid in st_info for i in st_info[sid]["walls"] + st_info[sid]["floors"] + st_info[sid]["roofs"]]
        env_ids += [e.id() for e in roof_like if e.id() in G_gross]
        ntri = 0
        for i in set(env_ids):
            v, fc = G_gross[i]
            ntri += raster_tris(v, fc, xs, ys, minx, miny, grid, ztop, zbot)
        XX, YY = np.meshgrid(xs, ys, indexing="ij")
        for k, sid in enumerate(real):
            mask = shapely.contains_xy(foot[sid], XX.ravel(), YY.ravel()).reshape(nx_, ny_)
            zlo = -np.inf if k == 0 else st_info[sid]["z"]
            zhi = np.inf if k == len(real) - 1 else st_info[real[k + 1]]["z"]
            valid = mask & np.isfinite(ztop) & np.isfinite(zbot)
            h = np.clip(np.minimum(ztop, zhi) - np.maximum(zbot, zlo), 0, None)
            vol[sid] = float((h[valid]).sum() * grid * grid)
            st_info[sid]["raster_area"] = float(valid.sum() * grid * grid)
            st_info[sid]["mean_height"] = vol[sid] / st_info[sid]["raster_area"] if st_info[sid]["raster_area"] else None
        R["height_field"] = {"grid_m": grid, "cells": nx_ * ny_, "triangles_rasterised": ntri}
    T["volume_s"] = r(time.perf_counter() - t)

    # ---------- space boundaries
    sb_res = None
    sbs = f.by_type("IfcRelSpaceBoundary")
    if sbs:
        acc = collections.defaultdict(float)
        n_ok = n_fail = 0
        for b in sbs:
            if b.InternalOrExternalBoundary not in ("EXTERNAL", "EXTERNAL_EARTH", "EXTERNAL_WATER", "EXTERNAL_FIRE") or b.PhysicalOrVirtualBoundary == "VIRTUAL":
                continue
            cg = b.ConnectionGeometry
            if cg is None or not cg.is_a("IfcConnectionSurfaceGeometry"):
                n_fail += 1
                continue
            surf = cg.SurfaceOnRelatingElement
            try:
                M = uplace.get_local_placement(b.RelatingSpace.ObjectPlacement)
                if surf.is_a("IfcCurveBoundedPlane"):
                    P = uplace.get_axis2placement(surf.BasisSurface.Position)
                    ob = surf.OuterBoundary
                    pts = None
                    if ob.is_a("IfcPolyline"):
                        pts = [list(p.Coordinates)[:2] for p in ob.Points]
                    elif ob.is_a("IfcCompositeCurve"):
                        pts = []
                        for seg in ob.Segments:
                            pc = seg.ParentCurve
                            if pc.is_a("IfcPolyline"):
                                pts += [list(p.Coordinates)[:2] for p in pc.Points]
                    elif ob.is_a("IfcIndexedPolyCurve"):
                        pts = [list(p)[:2] for p in ob.Points.CoordList]
                    if not pts:
                        n_fail += 1
                        continue
                    poly = Polygon(pts)
                    a = poly.area
                    for ib in surf.InnerBoundaries or []:
                        if ib.is_a("IfcPolyline"):
                            a -= Polygon([list(p.Coordinates)[:2] for p in ib.Points]).area
                    a *= scale * scale
                    nrm = (M @ P)[:3, 2]
                elif surf.is_a("IfcSurfaceOfLinearExtrusion"):
                    # Revit 1st level: profile (polyline) swept along direction * depth
                    P = uplace.get_axis2placement(surf.Position) if surf.Position else np.eye(4)
                    prof = surf.SweptCurve.Curve
                    pts = np.array([list(p.Coordinates) + [0.0] * (3 - len(p.Coordinates)) for p in prof.Points])
                    length = np.linalg.norm(np.diff(pts, axis=0), axis=1).sum()
                    d = np.array(surf.ExtrudedDirection.DirectionRatios, dtype=float)
                    a = length * surf.Depth * scale * scale
                    seg = pts[-1] - pts[0]
                    nloc = np.cross(seg, d)
                    nloc = nloc / (np.linalg.norm(nloc) or 1)
                    nrm = (M @ P)[:3, :3] @ nloc
                    ext_centre = ((M @ P) @ np.append(pts.mean(axis=0) + 0.5 * surf.Depth * d / (np.linalg.norm(d) or 1), 1.0))[:3] * scale
                else:
                    n_fail += 1
                    continue
            except Exception:
                n_fail += 1
                continue
            n_ok += 1
            el = b.RelatedBuildingElement
            cls = el.is_a() if el is not None else "None"
            if el is not None and el.is_a("IfcSlab"):
                cls = "IfcSlab/" + kinds.get(el.id(), "?")
            if abs(nrm[2]) > 0.98:
                o = "HORIZONTAL"
            else:
                # sign of the normal of a space boundary is not reliable -> orient away from the space centroid
                o = "?"
                sid_ = b.RelatingSpace.id()
                if sid_ in G_other:
                    sc = G_other[sid_][0].mean(axis=0)
                    Pw = M @ P
                    origin = Pw[:3, 3] * scale
                    centre = origin + (Pw[:3, 0] * np.mean([p[0] for p in pts]) + Pw[:3, 1] * np.mean([p[1] for p in pts])) * scale if surf.is_a("IfcCurveBoundedPlane") else ext_centre
                    if np.dot(nrm, centre - sc) < 0:
                        nrm = -nrm
                    o = sector(azimuth(nrm[0], nrm[1])) if abs(nrm[2]) < 0.2 else "SLOPED-" + sector(azimuth(nrm[0], nrm[1]))
            acc[(cls, o)] += a
        sb_res = {"external_physical_ok": n_ok, "unreadable": n_fail,
                  "area_by_class_orientation": {f"{k[0]}|{k[1]}": r(v) for k, v in sorted(acc.items())},
                  "area_by_class": {k: r(sum(v for (c, _), v in acc.items() if c == k)) for k in sorted({c for c, _ in acc})}}
    R["space_boundary_external_areas"] = sb_res

    # ---------- assemble report
    R["storeys"] = []
    for sid, info in st_info.items():
        sp_q = [x["qto_area"] for x in sp_rows if x["storey"] == info["name"] and x["qto_area"] is not None]
        sp_g = [x.get("geom_floor_area") for x in sp_rows if x["storey"] == info["name"] and x.get("geom_floor_area") is not None]
        R["storeys"].append({
            "name": info["name"], "elevation_m": r(info["z"], 3), "real": sid in real,
            "n_walls": len(info["walls"]), "n_spaces": len(info["spaces"]),
            "gross_footprint_area_ext_dims_m2": r(info["footprint_area"]), "footprint_perimeter_m": r(info["footprint_perimeter"]),
            "space_area_qto_m2": r(sum(sp_q)) if sp_q else None, "space_area_from_geometry_m2": r(sum(sp_g)) if sp_g else None,
            "gross_volume_ext_dims_m3": r(vol.get(sid)), "mean_gross_height_m": r(info.get("mean_height")),
            "facade_gross_by_orientation_m2": {s_: r(facade[(sid, s_)] + slab_edge[(sid, s_)]) for s_ in SECTORS if facade[(sid, s_)] + slab_edge[(sid, s_)] > 0.01},
            "of_which_slab_edge_m2": r(sum(slab_edge[(sid, s_)] for s_ in SECTORS)),
            "wall_net_of_openings_by_orientation_m2": {s_: r(facade_net[(sid, s_)]) for s_ in SECTORS if facade_net[(sid, s_)] > 0.01},
        })
    tot_gross = collections.defaultdict(float)
    tot_net = collections.defaultdict(float)
    for (sid, s_), a in list(facade.items()) + list(slab_edge.items()):
        tot_gross[s_] += a
    for (sid, s_), a in facade_net.items():
        tot_net[s_] += a
    R["totals"] = collections.OrderedDict()
    R["totals"]["heated_floor_area_from_space_qto_m2"] = r(sum(x["qto_area"] for x in sp_rows if x["qto_area"] is not None)) if any(x["qto_area"] is not None for x in sp_rows) else None
    R["totals"]["floor_area_from_space_geometry_m2"] = r(sum(x.get("geom_floor_area") or 0 for x in sp_rows)) if sp_rows else None
    R["totals"]["gross_floor_area_ext_dims_m2"] = r(sum(st_info[sid]["footprint_area"] for sid in real))
    R["totals"]["gross_volume_ext_dims_m3"] = r(sum(vol.values())) if vol else None
    R["totals"]["facade_gross_by_orientation_m2"] = {s_: r(tot_gross[s_]) for s_ in SECTORS if tot_gross[s_] > 0.01}
    R["totals"]["facade_gross_total_m2"] = r(sum(tot_gross.values()))
    R["totals"]["wall_net_of_openings_by_orientation_m2"] = {s_: r(tot_net[s_]) for s_ in SECTORS if tot_net[s_] > 0.01}
    R["totals"]["window_area_by_orientation_m2"] = {k: r(v) for k, v in sorted(win_by_or.items())}
    R["totals"]["window_area_total_m2"] = r(sum(win_by_or.values()))
    R["totals"]["ext_door_area_by_orientation_m2"] = {k: r(v) for k, v in sorted(door_by_or.items())}
    R["totals"]["roof_by_slope_orientation_m2"] = [{"slope_deg": k[0], "orientation": k[1], "area_within_footprint": r(v[0]), "area_total_incl_overhang": r(v[1])}
                                                    for k, v in sorted(roof_rows.items()) if v[1] > 0.05]
    R["totals"]["roof_area_within_footprint_m2"] = r(sum(v[0] for v in roof_rows.values()))
    if real:
        R["totals"]["ground_floor_area_ext_dims_m2"] = r(st_info[real[0]]["footprint_area"])
    R["openings"] = openings
    R["n_geometric_external_walls"] = len(geo_external_walls)
    T["total_s"] = r(time.perf_counter() - t0)
    R["timing"] = T
    return R


def brief(R):
    print(f"\n===== {R['file']} [{R['schema']}]  unit->m {R['length_unit_to_m']}  true north present: {R['true_north_present']} ({R['true_north_deg_clockwise_from_plusY']} deg cw from +Y)")
    print("tessellated:", R["tessellated"], "| timing:", dict(R["timing"]))
    for s in R["storeys"]:
        print("  storey", json.dumps(s, ensure_ascii=False))
    print("  IsExternal pset vs geometry (walls):", R["IsExternal_pset_vs_geometry"])
    print("  IsExternal pset vs geometry (openings):", R["openings_IsExternal_pset_vs_geometry"])
    for k, v in R["totals"].items():
        print(f"  {k}: {json.dumps(v, ensure_ascii=False)}")
    if R.get("height_field"):
        print("  height field:", R["height_field"])
    if R["space_boundary_external_areas"]:
        print("  space boundaries (EXTERNAL, physical):", json.dumps(R["space_boundary_external_areas"], ensure_ascii=False))
    for s in R["spaces"][:30]:
        print("   space", json.dumps(s, ensure_ascii=False))


if __name__ == "__main__":
    args = sys.argv[1:]
    grid = 0.05
    jo = None
    if "--grid" in args:
        i = args.index("--grid"); grid = float(args[i + 1]); args = args[:i] + args[i + 2:]
    if "--json" in args:
        i = args.index("--json"); jo = args[i + 1]; args = args[:i] + args[i + 2:]
    for p in args:
        R = analyse(p, grid)
        brief(R)
        if jo:
            with open(jo, "w") as fh:
                json.dump(R, fh, indent=1, default=str)
