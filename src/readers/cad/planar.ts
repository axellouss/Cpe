/**
 * Noyau de géométrie plane du lecteur CAO — SEUL fichier du lecteur qui touche à jsts.
 * jsts est typé en `any` : on l'isole ici derrière des fonctions typées (polygones = listes de Vec2).
 *
 * Toutes les coordonnées sont dans le repère d'ANALYSE du lecteur (repère CAO décalé, y vers le haut).
 */
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import BufferParameters from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import type { Vec2 } from '../../core/types';

/** Segment de droite. */
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

/** Ce dont on a besoin d'une géométrie jsts. */
interface JGeom {
  getNumGeometries(): number;
  getGeometryN(i: number): JGeom;
  getGeometryType(): string;
  getArea(): number;
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

function toJPolygon(poly: Poly): JGeom {
  const shell = factory.createLinearRing(ringCoords(poly.outer));
  const holes = poly.holes.filter((h) => h.length >= 3).map((h) => factory.createLinearRing(ringCoords(h)));
  return factory.createPolygon(shell, holes) as JGeom;
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

function mitreParams(squareCaps: boolean): BufferParameters {
  const p = new BufferParameters();
  p.setJoinStyle(BufferParameters.JOIN_MITRE);
  p.setMitreLimit(5);
  if (squareCaps) p.setEndCapStyle(BufferParameters.CAP_SQUARE);
  return p;
}

function jBuffer(geom: JGeom, distance: number, squareCaps = false): JGeom {
  return BufferOp.bufferOp(geom, distance, mitreParams(squareCaps)) as JGeom;
}

function jCollection(polys: readonly Poly[]): JGeom {
  return factory.createGeometryCollection(polys.map(toJPolygon)) as unknown as JGeom;
}

function jUnion(geom: JGeom): JGeom {
  try {
    return UnaryUnionOp.union(geom) as JGeom;
  } catch {
    // Cas dégénéré (TopologyException) : un tampon nul dissout aussi les recouvrements.
    return BufferOp.bufferOp(geom, 0) as JGeom;
  }
}

// ───────────────────────────── Fonctions pures (sans jsts) ─────────────────────────────

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

export function ringPerimeter(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function ringBox(ring: readonly Vec2[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
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

/** Distance d'un point à un segment. */
export function pointSegDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 < 1e-18 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Distance d'un point au bord d'un anneau. */
export function pointRingDistance(x: number, y: number, ring: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const d = pointSegDistance(x, y, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return best;
}

/** Simplification de Douglas-Peucker d'un anneau fermé (tolérance en unités du dessin). */
export function simplifyRing(ring: readonly Vec2[], tol: number): Vec2[] {
  const n = ring.length;
  if (n <= 4) return ring.map((p) => ({ x: p.x, y: p.y }));
  // Deux ancres : le point le plus à gauche et le point qui en est le plus éloigné.
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
    let worst = -1;
    let worstD = tol;
    for (let i = (from + 1) % n; i !== to; i = (i + 1) % n) {
      const d = pointSegDistance(ring[i]!.x, ring[i]!.y, a.x, a.y, b.x, b.y);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([from, worst], [worst, to]);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push({ x: ring[i]!.x, y: ring[i]!.y });
  return out;
}

// ───────────────────────────── Opérations ─────────────────────────────

/**
 * Découpe les segments à leurs intersections puis reconstruit les faces fermées.
 * `grid` = grille de précision (les coordonnées y sont arrondies avant le calcul).
 */
export function polygonizeSegments(segs: readonly Seg[], grid: number): { faces: Poly[]; dangles: Seg[] } {
  const snap = (v: number): number => Math.round(v / grid) * grid;
  const snapped: Seg[] = [];
  for (const s of segs) {
    const t = { ax: snap(s.ax), ay: snap(s.ay), bx: snap(s.bx), by: snap(s.by) };
    if (t.ax !== t.bx || t.ay !== t.by) snapped.push(t);
  }
  if (snapped.length === 0) return { faces: [], dangles: [] };
  try {
    const noded = UnaryUnionOp.union(toJLines(snapped)) as JGeom;
    const pz = new Polygonizer();
    pz.add(noded);
    const faces: Poly[] = [];
    for (const g of (pz.getPolygons() as unknown as JCollection).toArray()) polysFromJ(g, faces);
    const dangles: Seg[] = [];
    for (const d of (pz.getDangles() as unknown as JCollection).toArray()) {
      const cs = d.getCoordinates();
      for (let i = 0; i + 1 < cs.length; i++) dangles.push({ ax: cs[i]!.x, ay: cs[i]!.y, bx: cs[i + 1]!.x, by: cs[i + 1]!.y });
    }
    return { faces, dangles };
  } catch {
    return { faces: [], dangles: [] };
  }
}

/** Réunion de polygones (les recouvrements et contacts sont dissous). */
export function unionPolys(polys: readonly Poly[]): Poly[] {
  if (polys.length === 0) return [];
  try {
    return polysFromJ(jUnion(jCollection(polys)));
  } catch {
    return polys.map((p) => ({ outer: p.outer, holes: p.holes }));
  }
}

/** Tampon à angles vifs (onglet) : positif = dilatation, négatif = érosion. */
export function bufferPolys(polys: readonly Poly[], distance: number): Poly[] {
  if (polys.length === 0) return [];
  try {
    return polysFromJ(jBuffer(jCollection(polys), distance));
  } catch {
    return [];
  }
}

/** Vrai si le plus grand cercle inscrit dans le polygone a un rayon ≤ r (le polygone disparaît à l'érosion). */
export function isThinnerThan(poly: Poly, r: number): boolean {
  try {
    return jBuffer(toJPolygon(poly), -r).isEmpty();
  } catch {
    return false;
  }
}

/**
 * « Fermeture » robuste : on épaissit traits et polygones de r (bouts carrés, angles vifs), on garde le bord
 * EXTÉRIEUR de chaque tache puis on rétrécit de r. Les ouvertures plus étroites que 2r se referment, les extrémités
 * mal accrochées ne gênent pas ; en contrepartie les renfoncements plus étroits que 2r sont comblés.
 * Renvoie les contours extérieurs (anneaux simples), du plus grand au plus petit.
 */
export function closeOutline(segs: readonly Seg[], polys: readonly Poly[], r: number): Vec2[][] {
  if (segs.length === 0 && polys.length === 0) return [];
  try {
    const parts: JGeom[] = [];
    if (segs.length > 0) parts.push(jBuffer(toJLines(segs), r, true));
    if (polys.length > 0) parts.push(jBuffer(jCollection(polys), r));
    const dilated = parts.length === 1 ? parts[0]! : jUnion(factory.createGeometryCollection(parts) as unknown as JGeom);
    // Bords extérieurs seulement : l'intérieur du bâtiment est rempli.
    const shells = polysFromJ(dilated).map((p): Poly => ({ outer: p.outer, holes: [] }));
    if (shells.length === 0) return [];
    const filled = shells.length === 1 ? toJPolygon(shells[0]!) : jUnion(jCollection(shells));
    const eroded = polysFromJ(jBuffer(filled, -r));
    const rings = eroded.map((p) => p.outer).filter((ring) => ring.length >= 3);
    rings.sort((a, b) => ringArea(b) - ringArea(a));
    return rings;
  } catch {
    return [];
  }
}

/** Ensemble de polygones interrogeable : aire commune avec un petit polygone. */
export class PolySet {
  private readonly geoms: JGeom[];
  private readonly boxes: Box[];

  constructor(public readonly polys: readonly Poly[]) {
    this.geoms = polys.map(toJPolygon);
    this.boxes = polys.map((p) => ringBox(p.outer));
  }

  /** Aire de l'intersection entre l'ensemble et le polygone convexe `ring` ; NaN si le calcul échoue. */
  intersectionArea(ring: readonly Vec2[]): number {
    if (ring.length < 3) return 0;
    const box = ringBox(ring);
    let probe: JGeom | null = null;
    let total = 0;
    for (let i = 0; i < this.geoms.length; i++) {
      const b = this.boxes[i]!;
      if (b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY) continue;
      try {
        probe ??= toJPolygon({ outer: [...ring], holes: [] });
        total += (OverlayOp.intersection(this.geoms[i], probe) as JGeom).getArea();
      } catch {
        return Number.NaN;
      }
    }
    return total;
  }
}
