// Spike: the BROWSER-ONLY path proven in Node (no native code, no WASM, no server):
//   DWG or DXF bytes -> @node-projects/acad-ts (MIT) -> wall-layer linework -> JSTS (EPL/EDL) noding + polygonize -> wall solids
//   + room labels (TEXT/MTEXT), window/door INSERTs with ATTRIBs, $INSUNITS.
// usage: node t_browser_path.mjs <file.dwg|file.dxf> <wallLayerRegex> [unitsPerMetre]
import { readFileSync } from 'node:fs'
import { DwgReader, DxfReader } from '@node-projects/acad-ts'
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js'
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js'
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js'
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js'
import 'jsts/org/locationtech/jts/monkey.js' // adds .union/.buffer/... to geometries

const [file, layerRx, upmArg] = process.argv.slice(2)
const rx = new RegExp(layerRx, 'i')
const buf = readFileSync(file)
const t0 = performance.now()
const doc = /\.dxf$/i.test(file)
  ? DxfReader.readFromStream(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), () => {})
  : DwgReader.readFromStream(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {})
const tRead = performance.now() - t0
const upm = Number(upmArg) || { 4: 1000, 5: 100, 6: 1, 1: 39.3701 }[doc.header.insUnits] || 100
const grid = 0.0005 * upm // 0.5 mm
const snap = v => Math.round(v / grid) * grid

const segs = [], labels = [], inserts = []
for (const e of doc.modelSpace.entities) {
  const type = e.constructor.name
  const layer = e.layer?.name ?? ''
  if (rx.test(layer)) {
    if (type === 'Line') segs.push([[e.startPoint.x, e.startPoint.y], [e.endPoint.x, e.endPoint.y]])
    else if (type === 'LwPolyline') {
      const v = e.vertices.map(p => [p.location.x, p.location.y]) // NOTE: bulges ignored in this spike
      for (let i = 0; i + 1 < v.length; i++) segs.push([v[i], v[i + 1]])
      if (e.isClosed && v.length > 2) segs.push([v[v.length - 1], v[0]])
    }
  }
  if (type === 'TextEntity' || type === 'MText') labels.push({ layer, text: String(e.value ?? e.text ?? '').replace(/\\P/g, ' | ').replace(/\{\\f[^;]*;([^}]*)\}/g, '$1') })
  if (type === 'Insert') inserts.push({ layer, block: e.block?.name, x: e.insertPoint.x, y: e.insertPoint.y, rot: e.rotation, sx: e.xScale, sy: e.yScale, attribs: Object.fromEntries([...e.attributes].map(a => [a.tag, a.value])) })
}

const t1 = performance.now()
const gf = new GeometryFactory()
const lines = segs.filter(([a, b]) => a[0] !== b[0] || a[1] !== b[1]).map(([a, b]) => gf.createLineString([new Coordinate(snap(a[0]), snap(a[1])), new Coordinate(snap(b[0]), snap(b[1]))]))
const noded = UnaryUnionOp.union(gf.createGeometryCollection(lines)) // nodes all intersections
const pz = new Polygonizer()
pz.add(noded)
const polys = pz.getPolygons().toArray()
const dangles = pz.getDangles().toArray()
const tGeom = performance.now() - t1
let area = 0
for (const p of polys) area += p.getArea()
const u2 = upm * upm
console.log(JSON.stringify({
  file: file.split('/').pop(), version: doc.header.versionString, insUnits: doc.header.insUnits, unitsPerMetre: upm,
  read_ms: Math.round(tRead), geometry_ms: Math.round(tGeom),
  wallSegments: lines.length, faces: polys.length, dangles: dangles.length, wallSolidArea_m2: +(area / u2).toFixed(3),
  faceAreas_m2: polys.map(p => +(p.getArea() / u2).toFixed(2)).sort((a, b) => b - a).slice(0, 12),
  labels: labels.filter(l => /m²|m2|qm/i.test(l.text)).slice(0, 8).map(l => l.text),
  windowInserts: inserts.filter(i => /fen|glaz|wind/i.test(i.layer)).slice(0, 3),
  nInserts: inserts.length
}, null, 1))
