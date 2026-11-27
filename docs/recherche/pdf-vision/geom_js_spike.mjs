// geom_js_spike.mjs - can the geometry part (noding + polygonize + mitred buffer "closing") run in JS?
// Uses JSTS (JavaScript port of JTS, the library GEOS/shapely derive from). Input: IR from extract_pdfjs.mjs.
import fs from 'node:fs';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import BufferParameters from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js';

const ir = JSON.parse(fs.readFileSync(process.argv[2]));
const den = +process.argv[3], wallW = +process.argv[4];
const mPerPt = den * 0.0254 / 72;
const page = ir.pages[0];
const gf = new GeometryFactory();
const t0 = performance.now();
const lines = page.segs.filter(s => s.stroke && s.kind === 'l' && Math.abs(s.w - wallW) < 0.011 && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 0.05)
  .map(s => gf.createLineString([new Coordinate(s.x0, s.y0), new Coordinate(s.x1, s.y1)]));
const noded = UnaryUnionOp.union(gf.createGeometryCollection(lines));     // nodes all intersections
// (a) closing: buffer +r (mitre, square caps) -> exterior ring -> buffer -r
const r = 1.3 / mPerPt;
const bp = new BufferParameters(8, BufferParameters.CAP_SQUARE, BufferParameters.JOIN_MITRE, 5.0);
const grown = BufferOp.bufferOp(noded, r, bp);
const out = [];
for (let i = 0; i < grown.getNumGeometries(); i++) {
  const g = grown.getGeometryN(i);
  const shell = gf.createPolygon(g.getExteriorRing());
  const back = BufferOp.bufferOp(shell, -r, bp);
  if (back.getArea() > 400) out.push(back.getArea() * mPerPt ** 2);
}
// (b) polygonize the wall linework (without opening bridging: just to prove the operator exists and works)
const pz = new Polygonizer();
pz.add(noded);
const faces = pz.getPolygons();
console.log(`JSTS: ${lines.length} wall segments -> closing outlines (m²): ${out.map(a => a.toFixed(2)).join(', ')} | polygonize faces: ${faces.size()} | ${(performance.now() - t0).toFixed(0)} ms`);
