// web-ifc: read material layers + Pset_MaterialThermal and compute U (same maths as uvalue_demo.py)
import fs from 'node:fs'; import { createRequire } from 'node:module';
const WebIFC = createRequire(import.meta.url)('web-ifc');
const api = new WebIFC.IfcAPI(); await api.Init();
const m = api.OpenModel(new Uint8Array(fs.readFileSync(process.argv[2])));
const ids = t => { const v = api.GetLineIDsWithType(m, t, true); return Array.from({ length: v.size() }, (_, i) => v.get(i)); };
const val = a => (a == null) ? null : (a.value !== undefined ? a.value : a);
const up = c => String(api.GetNameFromTypeCode(c)).toUpperCase();
let scale = 1;
for (const id of ids(WebIFC.IFCSIUNIT)) { const u = api.GetLine(m, id); if (val(u.UnitType) === 'LENGTHUNIT') scale = ({ MILLI: 1e-3, CENTI: 1e-2 })[val(u.Prefix)] || 1; }
const lambda = new Map();   // material id -> conductivity
for (const id of ids(WebIFC.IFCMATERIALPROPERTIES)) {
  const mp = api.GetLine(m, id);
  for (const p of mp.Properties || []) { const pl = api.GetLine(m, p.value); if (val(pl.Name) === 'ThermalConductivity') lambda.set(mp.Material.value, val(pl.NominalValue)); }
}
const matOf = new Map();
for (const id of ids(WebIFC.IFCRELASSOCIATESMATERIAL)) { const l = api.GetLine(m, id); for (const o of l.RelatedObjects) matOf.set(o.value, l.RelatingMaterial.value); }
const seen = new Set();
for (const w of ids(WebIFC.IFCWALL)) {
  let ml = api.GetLine(m, matOf.get(w)); if (!ml) continue;
  if (up(ml.type) === 'IFCMATERIALLAYERSETUSAGE') ml = api.GetLine(m, ml.ForLayerSet.value);
  if (up(ml.type) !== 'IFCMATERIALLAYERSET') continue;
  let R = 0.13 + 0.04, ok = true; const layers = [];
  for (const lr of ml.MaterialLayers) { const l = api.GetLine(m, lr.value); const d = val(l.LayerThickness) * scale; const k = lambda.get(l.Material.value); layers.push([val(api.GetLine(m, l.Material.value).Name), +d.toFixed(4), k ?? null]); if (!k) ok = false; else R += d / k; }
  const key = JSON.stringify(layers); if (seen.has(key)) continue; seen.add(key);
  console.log(JSON.stringify({ wall: val(api.GetLine(m, w).Name), layers, U_from_layers: ok ? +(1 / R).toFixed(4) : null }));
}
