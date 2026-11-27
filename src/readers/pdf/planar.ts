/**
 * Géométrie plane du lecteur PDF — SEUL fichier du lecteur qui touche à jsts (typé en `any` : on l'isole
 * derrière des fonctions typées). Les deux opérations ont été validées sur les plans d'essai
 * (voir geom_js_spike.mjs dans les notes de recherche) :
 *  - « fermeture » par tampon : contour extérieur robuste, sans topologie ;
 *  - découpe + reconstruction des faces fermées (pièces).
 *
 * Coordonnées : unités de feuille (points PDF, y vers le bas).
 */
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import BufferParameters from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import type { Vec2 } from '../../core/types';

export interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** Polygone avec trous. Les anneaux ne répètent PAS leur premier point. */
export interface Poly {
  outer: Vec2[];
  holes: Vec2[][];
}

// ───────────────────────────── Frontière jsts ─────────────────────────────

interface JCoord {
  x: number;
  y: number;
}

interface JGeom {
  getNumGeometries(): number;
  getGeometryN(i: number): JGeom;
  getGeometryType(): string;
  isEmpty(): boolean;
  getExteriorRing(): JGeom;
  getNumInteriorRing(): number;
  getInteriorRingN(i: number): JGeom;
  getCoordinates(): JCoord[];
}

interface JCollection {
  toArray(): JGeom[];
}

const factory = new GeometryFactory();

function ringCoords(ring: readonly Vec2[]): Coordinate[] {
  const out: Coordinate[] = [];
  for (const p of ring) out.push(new Coordinate(p.x, p.y));
  const first = ring[0]!;
  out.push(new Coordinate(first.x, first.y));
  return out;
}

function toJPolygon(ring: readonly Vec2[]): JGeom {
  return factory.createPolygon(factory.createLinearRing(ringCoords(ring)), []) as JGeom;
}

function toJLines(segs: readonly Seg[]): JGeom {
  const lines: unknown[] = [];
  for (const s of segs) {
    if (s.ax === s.bx && s.ay === s.by) continue;
    lines.push(factory.createLineString([new Coordinate(s.ax, s.ay), new Coordinate(s.bx, s.by)]));
  }
  return factory.createMultiLineString(lines) as unknown as JGeom;
}

function ringFromJ(ring: JGeom): Vec2[] {
  const cs = ring.getCoordinates();
  const out: Vec2[] = [];
  for (let i = 0; i < cs.length - 1; i++) out.push({ x: cs[i]!.x, y: cs[i]!.y });
  return out;
}

function polysFromJ(geom: JGeom | null | undefined, out: Poly[] = []): Poly[] {
  if (!geom || geom.isEmpty()) return out;
  const type = geom.getGeometryType();
  if (type === 'Polygon') {
    const outer = ringFromJ(geom.getExteriorRing());
    if (outer.length >= 3) {
      const holes: Vec2[][] = [];
      for (let i = 0; i < geom.getNumInteriorRing(); i++) {
        const h = ringFromJ(geom.getInteriorRingN(i));
        if (h.length >= 3) holes.push(h);
      }
      out.push({ outer, holes });
    }
  } else if (type === 'MultiPolygon' || type === 'GeometryCollection') {
    for (let i = 0; i < geom.getNumGeometries(); i++) polysFromJ(geom.getGeometryN(i), out);
  }
  return out;
}

/** Tampon à angles vifs (onglet) ; bouts carrés pour les traits. */
function jBuffer(geom: JGeom, distance: number, squareCaps: boolean): JGeom {
  const p = new BufferParameters();
  p.setJoinStyle(BufferParameters.JOIN_MITRE);
  p.setMitreLimit(5);
  if (squareCaps) p.setEndCapStyle(BufferParameters.CAP_SQUARE);
  return BufferOp.bufferOp(geom, distance, p) as JGeom;
}

// ───────────────────────────── Fonctions pures ─────────────────────────────

export function ringSignedArea(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function ringArea(ring: readonly Vec2[]): number {
  return Math.abs(ringSignedArea(ring));
}

export function polyArea(poly: Poly): number {
  let a = ringArea(poly.outer);
  for (const h of poly.holes) a -= ringArea(h);
  return a;
}

export function pointInRing(x: number, y: number, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInPoly(x: number, y: number, poly: Poly): boolean {
  if (!pointInRing(x, y, poly.outer)) return false;
  for (const h of poly.holes) if (pointInRing(x, y, h)) return false;
  return true;
}

/** Distance d'un point au bord d'un anneau. */
export function pointRingDistance(x: number, y: number, ring: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 < 1e-18 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / l2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/** Simplification de Douglas-Peucker d'un anneau fermé (tolérance en unités de feuille). */
export function simplifyRing(ring: readonly Vec2[], tol: number): Vec2[] {
  const n = ring.length;
  if (n <= 4 || !(tol > 0)) return ring.map((p) => ({ x: p.x, y: p.y }));
  // Deux ancres sûres : le point le plus à gauche et le point qui en est le plus éloigné.
  let i0 = 0;
  for (let i = 1; i < n; i++) if (ring[i]!.x < ring[i0]!.x || (ring[i]!.x === ring[i0]!.x && ring[i]!.y < ring[i0]!.y)) i0 = i;
  let i1 = i0;
  let far = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(ring[i]!.x - ring[i0]!.x, ring[i]!.y - ring[i0]!.y);
    if (d > far) {
      far = d;
      i1 = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[i0] = 1;
  keep[i1] = 1;
  const stack: [number, number][] = [
    [i0, i1],
    [i1, i0],
  ];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    const a = ring[from]!;
    const b = ring[to]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = tol;
    for (let i = (from + 1) % n; i !== to; i = (i + 1) % n) {
      const p = ring[i]!;
      let t = l2 < 1e-18 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) stack.push([from, worst], [worst, to]);
    if (worst >= 0) keep[worst] = 1;
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push({ x: ring[i]!.x, y: ring[i]!.y });
  return out.length >= 3 ? out : ring.map((p) => ({ x: p.x, y: p.y }));
}

// ───────────────────────────── Opérations ─────────────────────────────

/**
 * « Fermeture » robuste : on épaissit les traits de r (bouts carrés, angles vifs), on garde le bord EXTÉRIEUR
 * de chaque tache, puis on rétrécit de r. Les ouvertures plus étroites que 2r se referment et les extrémités mal
 * accrochées ne gênent pas ; en contrepartie les renfoncements plus étroits que 2r sont comblés.
 * Renvoie les contours extérieurs (anneaux simples) dont l'aire dépasse `minArea`, du plus grand au plus petit.
 */
export function closeOutline(segs: readonly Seg[], r: number, minArea: number): Vec2[][] {
  if (segs.length === 0 || !(r > 0)) return [];
  try {
    const dilated = jBuffer(toJLines(segs), r, true);
    const rings: Vec2[][] = [];
    for (const blob of polysFromJ(dilated)) {
      const eroded = jBuffer(toJPolygon(blob.outer), -r, false);
      for (const p of polysFromJ(eroded)) if (ringArea(p.outer) > minArea) rings.push(p.outer);
    }
    rings.sort((a, b) => ringArea(b) - ringArea(a));
    return rings;
  } catch {
    return [];
  }
}

/**
 * Découpe les segments à leurs intersections puis reconstruit les faces fermées.
 * `grid` = grille de précision : les coordonnées y sont arrondies avant le calcul, pour que les flottants
 * simple précision de pdf.js se raccordent exactement.
 */
export function polygonizeSegments(segs: readonly Seg[], grid: number): Poly[] {
  const snap = (v: number): number => Math.round(v / grid) * grid;
  const snapped: Seg[] = [];
  for (const s of segs) {
    const t = { ax: snap(s.ax), ay: snap(s.ay), bx: snap(s.bx), by: snap(s.by) };
    if (t.ax !== t.bx || t.ay !== t.by) snapped.push(t);
  }
  if (snapped.length === 0) return [];
  try {
    const noded = UnaryUnionOp.union(toJLines(snapped)) as JGeom;
    const pz = new Polygonizer();
    pz.add(noded);
    const faces: Poly[] = [];
    for (const g of (pz.getPolygons() as unknown as JCollection).toArray()) polysFromJ(g, faces);
    return faces;
  } catch {
    return [];
  }
}
