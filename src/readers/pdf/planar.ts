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
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import BufferParameters from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js';
import DistanceOp from 'jsts/org/locationtech/jts/operation/distance/DistanceOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import DouglasPeuckerSimplifier from 'jsts/org/locationtech/jts/simplify/DouglasPeuckerSimplifier.js';
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
/**
 * Fabrique à précision fixe (millième de point) pour les tampons de la fermeture : en flottants, jsts rogne parfois
 * un angle du contour et invente un triangle à côté (rectangle de 567 × 454 pt, rayon 73,69 pt : mesuré). Avec
 * une précision fixe, BufferOp arrondit les nœuds sur une grille et le résultat est juste.
 */
const fixedFactory = new GeometryFactory(new PrecisionModel(1000));

function ringCoords(ring: readonly Vec2[]): Coordinate[] {
  const out: Coordinate[] = [];
  for (const p of ring) out.push(new Coordinate(p.x, p.y));
  const first = ring[0]!;
  out.push(new Coordinate(first.x, first.y));
  return out;
}

function toJPolygon(ring: readonly Vec2[], f: typeof factory = factory): JGeom {
  return f.createPolygon(f.createLinearRing(ringCoords(ring)), []) as JGeom;
}

function toJLines(segs: readonly Seg[], f: typeof factory = factory): JGeom {
  const lines: unknown[] = [];
  for (const s of segs) {
    if (s.ax === s.bx && s.ay === s.by) continue;
    lines.push(f.createLineString([new Coordinate(s.ax, s.ay), new Coordinate(s.bx, s.by)]));
  }
  return f.createMultiLineString(lines) as unknown as JGeom;
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
 * Traits horizontaux ou verticaux portés par la même droite (à 1e-3 pt près) et qui se recouvrent ou se touchent :
 * fondus en un seul. Le tampon de l'ensemble ne change pas (même réunion de points), mais il se calcule sur bien
 * moins de traits (un mur hachuré exporté en milliers de petits morceaux). Les traits obliques restent tels quels.
 */
export function mergeAxisSegments(segs: readonly Seg[]): Seg[] {
  const out: Seg[] = [];
  const rows = new Map<string, [number, number][]>();
  for (const s of segs) {
    const h = Math.abs(s.ay - s.by) < 1e-6;
    const v = Math.abs(s.ax - s.bx) < 1e-6;
    if (h === v) {
      out.push(s);
      continue;
    }
    const at = h ? s.ay : s.ax;
    const key = `${h ? 'h' : 'v'}${Math.round(at * 1000)}`;
    const lo = h ? Math.min(s.ax, s.bx) : Math.min(s.ay, s.by);
    const hi = h ? Math.max(s.ax, s.bx) : Math.max(s.ay, s.by);
    const row = rows.get(key);
    if (row) row.push([lo, hi]);
    else rows.set(key, [[lo, hi]]);
  }
  for (const [key, row] of rows) {
    const h = key[0] === 'h';
    const at = Number(key.slice(1)) / 1000;
    row.sort((p, q) => p[0] - q[0]);
    let [lo, hi] = row[0]!;
    const push = (a: number, b: number): void => {
      out.push(h ? { ax: a, ay: at, bx: b, by: at } : { ax: at, ay: a, bx: at, by: b });
    };
    for (let i = 1; i < row.length; i++) {
      const [a, b] = row[i]!;
      if (a <= hi + 1e-6) hi = Math.max(hi, b);
      else {
        push(lo, hi);
        lo = a;
        hi = b;
      }
    }
    push(lo, hi);
  }
  return out;
}

/**
 * « Fermeture » robuste : on épaissit les traits de r (bouts carrés, angles vifs), on garde le bord EXTÉRIEUR
 * de chaque tache, puis on rétrécit de r. Les ouvertures plus étroites que 2r se referment et les extrémités mal
 * accrochées ne gênent pas ; en contrepartie les renfoncements plus étroits que 2r sont comblés.
 * Renvoie les contours extérieurs (anneaux simples) dont l'aire dépasse `minArea`, du plus grand au plus petit.
 */
export function closeOutline(segs: readonly Seg[], r: number, minArea: number): Vec2[][] {
  if (segs.length === 0 || !(r > 0)) return [];
  try {
    const dilated = jBuffer(toJLines(mergeAxisSegments(segs), fixedFactory), r, true);
    const rings: Vec2[][] = [];
    for (const blob of polysFromJ(dilated)) {
      const eroded = jBuffer(toJPolygon(blob.outer, fixedFactory), -r, false);
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

// ───────────────────────────── Polygones avec trous (lecture des planches) ─────────────────────────────
//
// Opérations booléennes et tampons sur des `Poly` (anneau extérieur + trous), en précision fixe (millième de
// point) : les remplissages et les hachures d'une planche se touchent à quelques millièmes près, et jsts en
// flottants y voit parfois une topologie invalide. Chaque opération rattrape les exceptions de jsts : en cas
// d'échec, elle renvoie un résultat vide (ou le premier opérande, pour une différence) plutôt que de casser la lecture.

function polyToJ(p: Poly, f: typeof factory = fixedFactory): JGeom {
  const shell = f.createLinearRing(ringCoords(p.outer));
  const holes = p.holes.filter((h) => h.length >= 3).map((h) => f.createLinearRing(ringCoords(h)));
  return f.createPolygon(shell, holes) as JGeom;
}

/** Union d'une collection de polygones (rend les polygones valides : `buffer(0)` des anneaux auto-sécants). */
function jUnion(ps: readonly Poly[]): JGeom | null {
  if (ps.length === 0) return null;
  const parts: unknown[] = [];
  for (const p of ps) {
    if (p.outer.length < 3) continue;
    try {
      parts.push(jBuffer(polyToJ(p), 0, false));
    } catch {
      // anneau dégénéré : ignoré
    }
  }
  if (parts.length === 0) return null;
  return UnaryUnionOp.union(fixedFactory.createGeometryCollection(parts)) as JGeom;
}

/** Union de polygones (trous conservés). */
export function unionPolys(ps: readonly Poly[]): Poly[] {
  try {
    return polysFromJ(jUnion(ps));
  } catch {
    return [];
  }
}

/** Tampon de `d` (négatif : érosion) de l'union des polygones, angles vifs. */
export function bufferPolys(ps: readonly Poly[], d: number): Poly[] {
  try {
    const u = jUnion(ps);
    if (!u) return [];
    return polysFromJ(jBuffer(u, d, false));
  } catch {
    return [];
  }
}

/** Fermeture morphologique (tampon +r puis −r) : soude les pièces distantes de moins de 2r. */
export function closePolys(ps: readonly Poly[], r: number): Poly[] {
  try {
    const u = jUnion(ps);
    if (!u) return [];
    return polysFromJ(jBuffer(jBuffer(u, r, false), -r, false));
  } catch {
    return [];
  }
}

/** a − b. En cas d'échec de jsts, renvoie `a` inchangé. */
export function differencePolys(a: readonly Poly[], b: readonly Poly[]): Poly[] {
  try {
    const ja = jUnion(a);
    if (!ja) return [];
    const jb = jUnion(b);
    if (!jb) return polysFromJ(ja);
    return polysFromJ(OverlayOp.difference(ja, jb) as JGeom);
  } catch {
    return a.map((p) => ({ outer: p.outer.slice(), holes: p.holes.map((h) => h.slice()) }));
  }
}

/** a ∩ b. */
export function intersectPolys(a: readonly Poly[], b: readonly Poly[]): Poly[] {
  try {
    // Seuls comptent les polygones qui touchent la boîte de l'autre groupe : résultat identique, unions bien
    // plus petites (un pont de porte face aux dizaines de bandes d'isolant d'un niveau).
    const boxOf = (ps: readonly Poly[]): [number, number, number, number] => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of ps) for (const q of p.outer) {
        if (q.x < x0) x0 = q.x;
        if (q.y < y0) y0 = q.y;
        if (q.x > x1) x1 = q.x;
        if (q.y > y1) y1 = q.y;
      }
      return [x0, y0, x1, y1];
    };
    const near = (ps: readonly Poly[], o: [number, number, number, number]): Poly[] =>
      ps.filter((p) => {
        const [x0, y0, x1, y1] = boxOf([p]);
        return x0 <= o[2] && x1 >= o[0] && y0 <= o[3] && y1 >= o[1];
      });
    const a2 = near(a, boxOf(b));
    const b2 = near(b, boxOf(a2));
    const ja = jUnion(a2);
    const jb = jUnion(b2);
    if (!ja || !jb) return [];
    return polysFromJ(OverlayOp.intersection(ja, jb) as JGeom);
  } catch {
    return [];
  }
}

/** Vrai si les deux polygones sont à moins de `d` l'un de l'autre (0 = se touchent ou se recouvrent). */
export function polysWithinDistance(a: Poly, b: Poly, d: number): boolean {
  try {
    return DistanceOp.isWithinDistance(polyToJ(a), polyToJ(b), d);
  } catch {
    return false;
  }
}

/** Distance entre deux polygones (0 s'ils se touchent). Infinity en cas d'échec. */
export function polysDistance(a: Poly, b: Poly): number {
  try {
    return Number(DistanceOp.distance(polyToJ(a), polyToJ(b)));
  } catch {
    return Infinity;
  }
}

/** Simplification de Douglas-Peucker d'un polygone (trous compris) ; renvoie le polygone tel quel en cas d'échec. */
export function simplifyPoly(p: Poly, tol: number): Poly {
  try {
    const out = polysFromJ(DouglasPeuckerSimplifier.simplify(polyToJ(p), tol) as JGeom);
    out.sort((x, y) => polyArea(y) - polyArea(x));
    return out[0] ?? p;
  } catch {
    return p;
  }
}

/** Sous-tracés d'un remplissage → polygones (règle pair-impair : un anneau contenu dans un autre en est un trou). */
export function ringsToPolys(rings: readonly (readonly [number, number][])[]): Poly[] {
  const rs: Vec2[][] = [];
  for (const r of rings) {
    const pts = r.map(([x, y]) => ({ x, y }));
    if (pts.length > 3) {
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      if (a.x === b.x && a.y === b.y) pts.pop();
    }
    if (pts.length >= 3 && ringArea(pts) > 0) rs.push(pts);
  }
  rs.sort((a, b) => ringArea(b) - ringArea(a));
  const out: Poly[] = [];
  for (const r of rs) {
    const p0 = r[0]!;
    const host = out.find((p) => pointInRing(p0.x, p0.y, p.outer) && !p.holes.some((h) => pointInRing(p0.x, p0.y, h)));
    if (host) host.holes.push(r);
    else out.push({ outer: r, holes: [] });
  }
  return out;
}
