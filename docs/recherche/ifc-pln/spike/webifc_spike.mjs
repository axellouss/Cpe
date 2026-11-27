// web-ifc spike: what can be read from an IFC file with the browser-capable WASM parser,
// and a dependency-free (raster based) version of the facade / window / volume first cut.
//
//   node webifc_spike.mjs <file.ifc> [--json out.json] [--cell 0.025]
//
// Nothing here needs Node specific APIs except fs + perf_hooks, so the same code runs in a browser / web worker.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebIFC = require('web-ifc');

const args = process.argv.slice(2);
let cell = 0.025, jsonOut = null;
for (let i = args.length - 1; i >= 0; i--) {
  if (args[i] === '--cell') { cell = parseFloat(args[i + 1]); args.splice(i, 2); }
  else if (args[i] === '--json') { jsonOut = args[i + 1]; args.splice(i, 2); }
}
const file = args[0];
const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const sector = az => SECTORS[Math.floor((((az + 22.5) % 360) + 360) % 360 / 45)];
const r = (x, n = 2) => (x === null || x === undefined || !isFinite(x)) ? null : Math.round(x * 10 ** n) / 10 ** n;
const val = a => (a === null || a === undefined) ? null : (a.value !== undefined ? a.value : a);
const T = {};
const R = { file: path.basename(file) };

// ------------------------------------------------------------------ load
let t = performance.now();
const api = new WebIFC.IfcAPI();
await api.Init();
T.wasm_init_ms = r(performance.now() - t, 1);
api.SetLogLevel(WebIFC.LogLevel ? WebIFC.LogLevel.LOG_LEVEL_OFF : 6);
const data = new Uint8Array(fs.readFileSync(file));
R.file_mb = r(data.length / 1e6, 2);
t = performance.now();
const m = api.OpenModel(data, { COORDINATE_TO_ORIGIN: false });
T.open_model_ms = r(performance.now() - t, 1);
R.schema = api.GetModelSchema(m);
R.web_ifc_version = api.GetVersion();

const ids = (type, inherited = true) => { const v = api.GetLineIDsWithType(m, type, inherited); const out = []; for (let i = 0; i < v.size(); i++) out.push(v.get(i)); return out; };
const line = id => api.GetLine(m, id);
const ref = a => (a && a.value !== undefined) ? a.value : null;
const tname = code => String(api.GetNameFromTypeCode(code)).toUpperCase();   // 0.0.81 returns mixed case ('IfcWall')
const typeName = id => tname(api.GetLineType(m, id));

// ------------------------------------------------------------------ units, north
t = performance.now();
let scale = 1; const units = {};
for (const id of ids(WebIFC.IFCUNITASSIGNMENT)) {
  for (const u of line(id).Units) {
    const ul = line(ref(u));
    if (!ul || !ul.UnitType) continue;
    const ut = val(ul.UnitType);
    if (ul.Prefix !== undefined || ul.Name) units[ut] = (val(ul.Prefix) || '') + (val(ul.Name) || '');
    if (ut === 'LENGTHUNIT') {
      if (tname(ul.type) === 'IFCSIUNIT') scale = ({ MILLI: 1e-3, CENTI: 1e-2, DECI: 1e-1 })[val(ul.Prefix)] || 1;
      else if (ul.ConversionFactor) { const mw = line(ref(ul.ConversionFactor)); scale = val(mw.ValueComponent); }  // e.g. FOOT 0.3048
    }
  }
}
R.units = units; R.length_unit_to_m = scale;
let north = null;
for (const id of ids(WebIFC.IFCGEOMETRICREPRESENTATIONCONTEXT, false)) {
  const c = line(id);
  if (c.TrueNorth) { const d = line(ref(c.TrueNorth)).DirectionRatios.map(val); if (!north || val(c.ContextType) === 'Model') north = d; }
}
R.true_north_present = !!north;
const northBearing = north ? Math.atan2(north[0], north[1]) * 180 / Math.PI : 0;
R.true_north_deg_clockwise_from_plusY = r(northBearing);
const azimuth = (nx, ny) => (((Math.atan2(nx, ny) * 180 / Math.PI - northBearing) % 360) + 360) % 360;

// ------------------------------------------------------------------ relationship indexes (one pass each)
const psetsOf = new Map();      // element -> [pset/qto ids]
for (const id of ids(WebIFC.IFCRELDEFINESBYPROPERTIES)) {
  const l = line(id); const p = ref(l.RelatingPropertyDefinition);
  for (const o of l.RelatedObjects) { const k = ref(o); if (!psetsOf.has(k)) psetsOf.set(k, []); psetsOf.get(k).push(p); }
}
const containerOf = new Map();
for (const id of ids(WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
  const l = line(id); for (const o of l.RelatedElements) containerOf.set(ref(o), ref(l.RelatingStructure));
}
const parentOf = new Map();
for (const id of ids(WebIFC.IFCRELAGGREGATES)) {
  const l = line(id); for (const o of l.RelatedObjects) parentOf.set(ref(o), ref(l.RelatingObject));
}
const hostOfOpening = new Map(), openingOfFiller = new Map();
for (const id of ids(WebIFC.IFCRELVOIDSELEMENT)) { const l = line(id); hostOfOpening.set(ref(l.RelatedOpeningElement), ref(l.RelatingBuildingElement)); }
for (const id of ids(WebIFC.IFCRELFILLSELEMENT)) { const l = line(id); openingOfFiller.set(ref(l.RelatedBuildingElement), ref(l.RelatingOpeningElement)); }
const materialOf = new Map();
for (const id of ids(WebIFC.IFCRELASSOCIATESMATERIAL)) { const l = line(id); for (const o of l.RelatedObjects) materialOf.set(ref(o), ref(l.RelatingMaterial)); }

function props(elId) {   // {psetName: {prop: value}}
  const out = {};
  for (const pid of psetsOf.get(elId) || []) {
    const ps = line(pid); const name = val(ps.Name); const o = {};
    for (const p of ps.HasProperties || ps.Quantities || []) {
      const pl = line(ref(p)); if (!pl) continue;
      let v = pl.NominalValue ?? pl.AreaValue ?? pl.LengthValue ?? pl.VolumeValue ?? pl.CountValue ?? pl.WeightValue ?? null;
      o[val(pl.Name)] = val(v);
    }
    out[name] = o;
  }
  return out;
}
const storeyOf = id => { let c = containerOf.get(id); let p = id; let guard = 0; while (c === undefined && parentOf.has(p) && guard++ < 10) { p = parentOf.get(p); if (typeName(p) === 'IFCBUILDINGSTOREY') return p; c = containerOf.get(p); } return c; };

// ------------------------------------------------------------------ semantic inventory
const storeys = ids(WebIFC.IFCBUILDINGSTOREY).map(id => { const l = line(id); return { id, name: val(l.Name), z: (val(l.Elevation) || 0) * scale }; }).sort((a, b) => a.z - b.z);
const wallIds = ids(WebIFC.IFCWALL, true), slabIds = ids(WebIFC.IFCSLAB, true), roofIds = ids(WebIFC.IFCROOF, true);
const spaceIds = ids(WebIFC.IFCSPACE, true), winIds = ids(WebIFC.IFCWINDOW, true), doorIds = ids(WebIFC.IFCDOOR, true);
R.counts = { storeys: storeys.length, walls: wallIds.length, slabs: slabIds.length, roofs: roofIds.length, spaces: spaceIds.length, windows: winIds.length, doors: doorIds.length,
  space_boundaries: ids(WebIFC.IFCRELSPACEBOUNDARY, true).length, material_layer_sets: ids(WebIFC.IFCMATERIALLAYERSET).length };
const isBool = v => v === true || v === 'T' || v === '.T.' ? true : (v === false || v === 'F' || v === '.F.' ? false : null);
const wallExt = {};
const wallInfo = new Map();
for (const id of wallIds) {
  const p = props(id); const e = p.Pset_WallCommon ? isBool(p.Pset_WallCommon.IsExternal) : null;
  wallExt[`IsExternal=${e}`] = (wallExt[`IsExternal=${e}`] || 0) + 1;
  wallInfo.set(id, { pset: e, u: p.Pset_WallCommon ? p.Pset_WallCommon.ThermalTransmittance ?? null : null, q: p.BaseQuantities || p.Qto_WallBaseQuantities || null });
}
R.walls_IsExternal = wallExt;
R.walls_with_U = [...wallInfo.values()].filter(w => w.u !== null).length;
R.walls_with_base_quantities = [...wallInfo.values()].filter(w => w.q).length;
// material layers
function layersOf(elId) {
  let mid = materialOf.get(elId); if (!mid) return null;
  let ml = line(mid); let tn = tname(ml.type);
  if (tn === 'IFCMATERIALLAYERSETUSAGE') { ml = line(ref(ml.ForLayerSet)); tn = 'IFCMATERIALLAYERSET'; }
  if (tn !== 'IFCMATERIALLAYERSET') return { kind: tn, layers: [] };
  return { kind: tn, name: val(ml.LayerSetName), layers: ml.MaterialLayers.map(x => { const l = line(ref(x)); const mat = l.Material ? line(ref(l.Material)) : null; return { material: mat ? val(mat.Name) : null, thickness_m: r(val(l.LayerThickness) * scale, 4) }; }) };
}
R.walls_with_layerset = wallIds.filter(id => { const l = layersOf(id); return l && l.kind === 'IFCMATERIALLAYERSET'; }).length;
R.example_wall_layers = wallIds.slice(0, 2).map(id => layersOf(id));
R.slabs_by_type = {};
const slabKind = new Map();
for (const id of slabIds) { const l = line(id); let k = val(l.PredefinedType) || 'NOTDEFINED'; if (parentOf.has(id) && typeName(parentOf.get(id)) === 'IFCROOF') k = 'ROOF'; slabKind.set(id, k); R.slabs_by_type[val(l.PredefinedType)] = (R.slabs_by_type[val(l.PredefinedType)] || 0) + 1; }
const spaces = spaceIds.map(id => {
  const l = line(id); const p = props(id); const q = p.BaseQuantities || p.Qto_SpaceBaseQuantities || {};
  let st = parentOf.get(id); if (st === undefined) st = containerOf.get(id);
  return { id, name: val(l.Name), long_name: val(l.LongName), storey: st, net_floor_area: q.NetFloorArea ?? null, gross_floor_area: q.GrossFloorArea ?? null, height: q.Height ?? q.FinishCeilingHeight ?? null, net_volume: q.NetVolume ?? q.GrossVolume ?? null };
});
R.spaces_with_area_qto = spaces.filter(s => s.net_floor_area !== null || s.gross_floor_area !== null).length;
R.sum_space_net_floor_area = r(spaces.reduce((a, s) => a + ((s.net_floor_area ?? s.gross_floor_area ?? 0)), 0) * (units.AREAUNIT === 'SQUARE_METRE' ? 1 : scale * scale));
const openings = [...winIds.map(id => [id, 'IfcWindow']), ...doorIds.map(id => [id, 'IfcDoor'])].map(([id, cls]) => {
  const l = line(id); const p = props(id); const common = p[`Pset_${cls.slice(3)}Common`] || {};
  const op = openingOfFiller.get(id); const host = op !== undefined ? hostOfOpening.get(op) : undefined;
  const w = val(l.OverallWidth), h = val(l.OverallHeight);
  return { id, cls, name: val(l.Name), area_overall: (w && h) ? w * h * scale * scale : null, host, host_class: host !== undefined ? typeName(host) : null,
    pset_IsExternal: isBool(common.IsExternal), U: common.ThermalTransmittance ?? null, storey: storeyOf(id) };
});
R.windows = { n: winIds.length, with_dims: openings.filter(o => o.cls === 'IfcWindow' && o.area_overall).length, with_host: openings.filter(o => o.cls === 'IfcWindow' && o.host !== undefined).length, with_U: openings.filter(o => o.cls === 'IfcWindow' && o.U !== null).length };
const sbIds = ids(WebIFC.IFCRELSPACEBOUNDARY, true);
if (sbIds.length) { const c = {}; for (const id of sbIds) { const l = line(id); const k = `${val(l.Name)}|${val(l.InternalOrExternalBoundary)}`; c[k] = (c[k] || 0) + 1; } R.space_boundaries = c; }
T.semantic_ms = r(performance.now() - t, 1);

// ------------------------------------------------------------------ geometry (Z-up metres)
t = performance.now();
const meshes = new Map(); // expressID -> Float64Array of triangle soup [x,y,z]*3 per tri
let nTri = 0;
function collect(mesh) {
  const parts = [];
  for (let i = 0; i < mesh.geometries.size(); i++) {
    const pg = mesh.geometries.get(i); const g = api.GetGeometry(m, pg.geometryExpressID);
    const v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
    const ix = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
    const M = pg.flatTransformation; const out = new Float64Array(ix.length * 3);
    for (let k = 0; k < ix.length; k++) {
      const o = ix[k] * 6; const x = v[o], y = v[o + 1], z = v[o + 2];
      const X = M[0] * x + M[4] * y + M[8] * z + M[12], Y = M[1] * x + M[5] * y + M[9] * z + M[13], Z = M[2] * x + M[6] * y + M[10] * z + M[14];
      out[k * 3] = X; out[k * 3 + 1] = -Z; out[k * 3 + 2] = Y;   // web-ifc is Y-up -> back to IFC Z-up
    }
    parts.push(out); nTri += ix.length / 3; g.delete();
  }
  let len = 0; for (const p of parts) len += p.length; const all = new Float64Array(len); let off = 0; for (const p of parts) { all.set(p, off); off += p.length; }
  if (len) meshes.set(mesh.expressID, all);
}
const want = [WebIFC.IFCWALL, WebIFC.IFCWALLSTANDARDCASE, WebIFC.IFCSLAB, WebIFC.IFCROOF, WebIFC.IFCSPACE, WebIFC.IFCWINDOW, WebIFC.IFCDOOR];
if (WebIFC.IFCWALLELEMENTEDCASE) want.push(WebIFC.IFCWALLELEMENTEDCASE);
api.StreamAllMeshesWithTypes(m, want, collect);
T.geometry_ms = r(performance.now() - t, 1);
R.geometry = { meshes: meshes.size, triangles: nTri, walls: wallIds.filter(i => meshes.has(i)).length, slabs: slabIds.filter(i => meshes.has(i)).length, spaces: spaceIds.filter(i => meshes.has(i)).length, windows: winIds.filter(i => meshes.has(i)).length, doors: doorIds.filter(i => meshes.has(i)).length };

// ------------------------------------------------------------------ raster helpers
t = performance.now();
let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
for (const id of [...wallIds, ...spaceIds]) { const a = meshes.get(id); if (!a) continue; for (let i = 0; i < a.length; i += 3) { if (a[i] < minx) minx = a[i]; if (a[i] > maxx) maxx = a[i]; if (a[i + 1] < miny) miny = a[i + 1]; if (a[i + 1] > maxy) maxy = a[i + 1]; } }
const PAD = 1.0; minx -= PAD; miny -= PAD; maxx += PAD; maxy += PAD;
// keep the grid below ~6 M cells: coarsen the cell for large sites
if ((maxx - minx) * (maxy - miny) / (cell * cell) > 6e6) cell = Math.sqrt((maxx - minx) * (maxy - miny) / 6e6);
const nx = Math.ceil((maxx - minx) / cell), ny = Math.ceil((maxy - miny) / cell);
R.grid = { cell_m: cell, nx, ny, cells: nx * ny };
function rasterTris(a, fn) {  // calls fn(cellIndex, z) for each cell centre covered by each triangle
  for (let i = 0; i < a.length; i += 9) {
    const x0 = a[i], y0 = a[i + 1], z0 = a[i + 2], x1 = a[i + 3], y1 = a[i + 4], z1 = a[i + 5], x2 = a[i + 6], y2 = a[i + 7], z2 = a[i + 8];
    const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2); if (Math.abs(d) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor((Math.min(x0, x1, x2) - minx) / cell)), i1 = Math.min(nx - 1, Math.floor((Math.max(x0, x1, x2) - minx) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(y0, y1, y2) - miny) / cell)), j1 = Math.min(ny - 1, Math.floor((Math.max(y0, y1, y2) - miny) / cell));
    for (let ii = i0; ii <= i1; ii++) { const X = minx + (ii + 0.5) * cell;
      for (let jj = j0; jj <= j1; jj++) { const Y = miny + (jj + 0.5) * cell;
        const l1 = ((y1 - y2) * (X - x2) + (x2 - x1) * (Y - y2)) / d, l2 = ((y2 - y0) * (X - x2) + (x0 - x2) * (Y - y2)) / d, l3 = 1 - l1 - l2;
        if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) fn(ii * ny + jj, l1 * z0 + l2 * z1 + l3 * z2);
      } }
  }
}
function morph(src, k, dilate) {  // square structuring element, separable
  let a = src; for (const axis of [0, 1]) { const b = new Uint8Array(a.length);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) { let v = dilate ? 0 : 1;
      for (let s = -k; s <= k; s++) { const ii = axis === 0 ? i + s : i, jj = axis === 1 ? j + s : j; const inb = ii >= 0 && ii < nx && jj >= 0 && jj < ny; const c = inb ? a[ii * ny + jj] : 0; if (dilate) { if (c) { v = 1; break; } } else { if (!c) { v = 0; break; } } }
      b[i * ny + j] = v; }
    a = b; }
  return a;
}
function footprintMask(elIds) {
  const occ = new Uint8Array(nx * ny);
  for (const id of elIds) { const a = meshes.get(id); if (a) rasterTris(a, c => { occ[c] = 1; }); }
  const k = Math.ceil(0.06 / cell);
  const dil = morph(occ, k, true);
  // flood fill the outside from the border
  // BFS with a typed-array queue; every cell is enqueued at most once (a plain JS array overflowed on a 30 M cell grid)
  const out = new Uint8Array(nx * ny); const queue = new Int32Array(nx * ny); let qh = 0, qt = 0;
  const push = c => { if (!out[c] && !dil[c]) { out[c] = 1; queue[qt++] = c; } };
  for (let i = 0; i < nx; i++) { push(i * ny); push(i * ny + ny - 1); } for (let j = 0; j < ny; j++) { push(j); push((nx - 1) * ny + j); }
  while (qh < qt) { const c = queue[qh++]; const i = (c / ny) | 0, j = c % ny; if (i > 0) push(c - ny); if (i < nx - 1) push(c + ny); if (j > 0) push(c - 1); if (j < ny - 1) push(c + 1); }
  const inside = new Uint8Array(nx * ny); for (let c = 0; c < inside.length; c++) inside[c] = out[c] ? 0 : 1;
  return morph(inside, k, false);
}
const inMask = (mask, x, y) => { const i = Math.floor((x - minx) / cell), j = Math.floor((y - miny) / cell); return i >= 0 && i < nx && j >= 0 && j < ny && mask[i * ny + j] === 1; };

// ------------------------------------------------------------------ per storey footprint + facade
const byStorey = new Map(storeys.map(s => [s.id, { walls: [], spaces: [], floors: [], roofs: [] }]));
for (const id of wallIds) { const s = storeyOf(id); if (byStorey.has(s) && meshes.has(id)) byStorey.get(s).walls.push(id); }
for (const sp of spaces) { if (byStorey.has(sp.storey) && meshes.has(sp.id)) byStorey.get(sp.storey).spaces.push(sp.id); }
for (const id of slabIds) { const s = storeyOf(id); if (byStorey.has(s) && meshes.has(id)) (slabKind.get(id) === 'ROOF' ? byStorey.get(s).roofs : byStorey.get(s).floors).push(id); }
const wallExtNormals = new Map(); const geoExt = new Set();
const facadeNet = {}; const masks = new Map();
for (const s of storeys) {
  const b = byStorey.get(s.id); if (!b.walls.length && !b.spaces.length) continue;
  const mask = footprintMask([...b.walls, ...b.spaces]); let cnt = 0; for (let c = 0; c < mask.length; c++) cnt += mask[c];
  s.footprint_area = cnt * cell * cell; if (s.footprint_area < 4) continue; masks.set(s.id, mask); s.facade_net = {};
  for (const id of b.walls) {
    const a = meshes.get(id); const acc = new Map(); let tot = 0;
    for (let i = 0; i < a.length; i += 9) {
      const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = a[i + 5] - a[i + 2], vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = a[i + 8] - a[i + 2];
      let nx_ = uy * vz - uz * vy, ny_ = uz * vx - ux * vz, nz_ = ux * vy - uy * vx; const l = Math.hypot(nx_, ny_, nz_); if (l < 1e-9) continue; const area = l / 2;
      if (Math.abs(nz_ / l) > 0.2) continue; const hl = Math.hypot(nx_, ny_); let hx = nx_ / hl, hy = ny_ / hl;
      const cx = (a[i] + a[i + 3] + a[i + 6]) / 3, cy = (a[i + 1] + a[i + 4] + a[i + 7]) / 3, cz = (a[i + 2] + a[i + 5] + a[i + 8]) / 3;
      const f = inMask(mask, cx + 0.10 * hx, cy + 0.10 * hy), bk = inMask(mask, cx - 0.10 * hx, cy - 0.10 * hy);
      if (f === bk) continue; if (f) { hx = -hx; hy = -hy; }
      if (inMask(mask, cx + (0.03 + cell) * hx, cy + (0.03 + cell) * hy)) continue;   // face must lie on the outline
      const sec = sector(azimuth(hx, hy)); s.facade_net[sec] = (s.facade_net[sec] || 0) + area; facadeNet[sec] = (facadeNet[sec] || 0) + area; tot += area;
      const key = `${hx.toFixed(2)},${hy.toFixed(2)}`; const e = acc.get(key) || { hx, hy, area: 0, cx: 0, cy: 0 }; e.area += area; e.cx += cx * area; e.cy += cy * area; acc.set(key, e);
    }
    if (tot > 0.5) { geoExt.add(id); wallExtNormals.set(id, [...acc.values()].map(e => ({ ...e, cx: e.cx / e.area, cy: e.cy / e.area }))); }
  }
}
const cmp = {}; for (const id of wallIds) { if (!meshes.has(id)) continue; const k = `pset=${wallInfo.get(id).pset}|geometry=${geoExt.has(id) ? 'EXT' : 'INT'}`; cmp[k] = (cmp[k] || 0) + 1; }
R.IsExternal_pset_vs_geometry = cmp;
T.footprint_facade_ms = r(performance.now() - t, 1);

// ------------------------------------------------------------------ windows by orientation (host wall exterior face)
t = performance.now();
const winBy = {}, doorBy = {};
for (const o of openings) {
  const a = meshes.get(o.id); const cl = o.host !== undefined ? wallExtNormals.get(o.host) : null;
  if (!a) { o.exterior = null; continue; }
  let cx = 0, cy = 0, n = 0; for (let i = 0; i < a.length; i += 3) { cx += a[i]; cy += a[i + 1]; n++; } cx /= n; cy /= n;
  if (!cl) { o.exterior = o.host_class === 'IFCROOF' || o.host_class === 'IFCSLAB' ? true : false; if (o.exterior) o.orientation = 'ROOF'; }
  else {
    let best = null; for (const e of cl) { if (e.area < 0.3) continue; const d = Math.abs((cx - e.cx) * e.hx + (cy - e.cy) * e.hy); if (d < 0.8 && (!best || d < best.d - 0.05 || (Math.abs(d - best.d) <= 0.05 && e.area > best.e.area))) best = { d, e }; }
    if (best) { o.exterior = true; o.azimuth = r(azimuth(best.e.hx, best.e.hy), 1); o.orientation = sector(o.azimuth); } else o.exterior = false;
  }
  if (o.exterior && o.area_overall) { const tgt = o.cls === 'IfcWindow' ? winBy : doorBy; tgt[o.orientation] = (tgt[o.orientation] || 0) + o.area_overall; }
}
T.openings_ms = r(performance.now() - t, 1);

// ------------------------------------------------------------------ gross volume (height field)
t = performance.now();
const ztop = new Float32Array(nx * ny).fill(-Infinity), zbot = new Float32Array(nx * ny).fill(Infinity);
for (const id of [...wallIds, ...slabIds, ...roofIds]) { const a = meshes.get(id); if (a) rasterTris(a, (c, z) => { if (z > ztop[c]) ztop[c] = z; if (z < zbot[c]) zbot[c] = z; }); }
const real = storeys.filter(s => masks.has(s.id));
real.forEach((s, k) => {
  const mask = masks.get(s.id); const zlo = k === 0 ? -Infinity : s.z, zhi = k === real.length - 1 ? Infinity : real[k + 1].z; let v = 0;
  for (let c = 0; c < mask.length; c++) if (mask[c] && ztop[c] > -Infinity) { const h = Math.min(ztop[c], zhi) - Math.max(zbot[c], zlo); if (h > 0) v += h; }
  s.gross_volume = v * cell * cell;
});
T.volume_ms = r(performance.now() - t, 1);

R.storeys = storeys.map(s => ({ name: s.name, elevation_m: r(s.z, 3), gross_footprint_area_ext_dims_m2: r(s.footprint_area), gross_volume_ext_dims_m3: r(s.gross_volume), wall_net_of_openings_by_orientation_m2: s.facade_net ? Object.fromEntries(SECTORS.filter(k => s.facade_net[k] > 0.01).map(k => [k, r(s.facade_net[k])])) : null }));
R.totals = {
  gross_floor_area_ext_dims_m2: r(real.reduce((a, s) => a + s.footprint_area, 0)), gross_volume_ext_dims_m3: r(real.reduce((a, s) => a + (s.gross_volume || 0), 0)),
  wall_net_of_openings_by_orientation_m2: Object.fromEntries(SECTORS.filter(k => facadeNet[k] > 0.01).map(k => [k, r(facadeNet[k])])),
  window_area_by_orientation_m2: Object.fromEntries(Object.entries(winBy).sort().map(([k, v]) => [k, r(v)])), window_area_total_m2: r(Object.values(winBy).reduce((a, b) => a + b, 0)),
  ext_door_area_by_orientation_m2: Object.fromEntries(Object.entries(doorBy).sort().map(([k, v]) => [k, r(v)])),
};
R.timing_ms = T; R.rss_mb = r(process.memoryUsage().rss / 1e6, 0);
api.CloseModel(m);
console.log(JSON.stringify(R, null, 1));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(R, null, 1));
