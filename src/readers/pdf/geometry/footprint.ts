/**
 * Emprise d'un niveau : union des murs « à nous » et des pièces intérieures, joints soudés, trous remplis
 * (escalier, gaines), coupée sur la face d'un mur mitoyen, encoches de baies pontées, coins redressés.
 * Recoupée par les cotes hors tout écrites autour du bâtiment.
 */
import type { Vec2 } from '../../../core/types';
import {
  closeOutline,
  closePolys,
  intersectPolys,
  pointInPoly,
  polyArea,
  polysWithinDistance,
  simplifyPoly,
  unionPolys,
  type Poly,
  type Seg,
} from '../planar';
import type { RawText } from '../raw';
import { Grid } from './grid';
import type { OwnWalls } from './materials';
import { boxH, boxW, mergeCollinear, orthogonalize, polyBox, ringBox } from './util';

export interface PartyLine {
  axis: 'x' | 'y';
  at: number;
  /** Vrai si le bâtiment est du côté des coordonnées plus petites. */
  keepLess: boolean;
  span: [number, number];
  sources: string[];
}

export interface Footprint {
  /** Contour redressé (anneau simple, sens quelconque). */
  ring: Vec2[];
  poly: Poly;
  party: PartyLine[];
  widthM: number;
  depthM: number;
  areaM2: number;
  /** 'walls' : murs + pièces ; 'strokes' : traits épais refermés ; 'rooms' : pièces seules (repli faible). */
  basis: 'walls' | 'strokes' | 'rooms';
}

const BIG = 1e6;

function halfPlane(p: PartyLine): Poly {
  const a = p.at;
  const ring =
    p.axis === 'x'
      ? p.keepLess
        ? [{ x: -BIG, y: -BIG }, { x: a, y: -BIG }, { x: a, y: BIG }, { x: -BIG, y: BIG }]
        : [{ x: a, y: -BIG }, { x: BIG, y: -BIG }, { x: BIG, y: BIG }, { x: a, y: BIG }]
      : p.keepLess
        ? [{ x: -BIG, y: -BIG }, { x: BIG, y: -BIG }, { x: BIG, y: a }, { x: -BIG, y: a }]
        : [{ x: -BIG, y: a }, { x: BIG, y: a }, { x: BIG, y: BIG }, { x: -BIG, y: BIG }];
  return { outer: ring, holes: [] };
}

/** Maçonnerie étrangère accolée et élancée → ligne mitoyenne sur sa face côté logement. */
export function partyFromForeign(own: OwnWalls, rooms: readonly Poly[], mpp: number): PartyLine[] {
  const out: PartyLine[] = [];
  if (rooms.length === 0) return out;
  let cx = 0;
  let cy = 0;
  for (const r of rooms) {
    const b = polyBox(r);
    cx += (b.minX + b.maxX) / 2 / rooms.length;
    cy += (b.minY + b.maxY) / 2 / rooms.length;
  }
  const glue = 0.05 / mpp;
  for (const f of own.foreign) {
    const touches = own.masonry.some((m) => polysWithinDistance(m, f, glue)) || own.insulation.some((m) => polysWithinDistance(m, f, glue));
    if (!touches) continue;
    const b = polyBox(f);
    const w = boxW(b);
    const h = boxH(b);
    if (h * mpp < 2 && w * mpp < 2) continue;
    if (h > 3 * w) {
      const keepLess = cx < b.minX;
      out.push({ axis: 'x', at: keepLess ? b.minX : b.maxX, keepLess, span: [b.minY, b.maxY], sources: ['foreign-masonry'] });
    } else if (w > 3 * h) {
      const keepLess = cy < b.minY;
      out.push({ axis: 'y', at: keepLess ? b.minY : b.maxY, keepLess, span: [b.minX, b.maxX], sources: ['foreign-masonry'] });
    }
  }
  // Doublons (plusieurs morceaux du même mur voisin) : une ligne par face.
  const merged: PartyLine[] = [];
  for (const p of out) {
    const q = merged.find((m) => m.axis === p.axis && m.keepLess === p.keepLess && Math.abs(m.at - p.at) * mpp < 0.1);
    if (q) q.span = [Math.min(q.span[0], p.span[0]), Math.max(q.span[1], p.span[1])];
    else merged.push(p);
  }
  return merged;
}

/** Ponts sur les encoches peu profondes (baies, tableaux) : enveloppe orthoconvexe sur trame de 2 cm. */
function bridgeNotches(solid: Poly, mpp: number, maxDepthM: number): Poly {
  const res = 0.02 / mpp;
  const b = polyBox(solid);
  const g = new Grid(b.minX - 2 * res, b.minY - 2 * res, res, b.maxX + 2 * res, b.maxY + 2 * res);
  if (g.size > 4_000_000) return solid;
  const m = g.mask();
  g.fill(m, solid);
  const hull = g.orthoHull(m);
  const dist = g.chebyshev(hull);
  const maxC = Math.round(maxDepthM / 0.02);
  const bridge = g.mask();
  let any = false;
  for (let c = 0; c < hull.length; c++) {
    if (hull[c] && !m[c] && dist[c]! <= maxC) {
      bridge[c] = 1;
      any = true;
    }
  }
  if (!any) return solid;
  const add: Poly[] = [];
  for (const comp of g.components(bridge)) if (comp.length >= 4) add.push(...g.cellsToPolys(comp));
  if (add.length === 0) return solid;
  const u = closePolys([solid, ...add], res * 0.6);
  u.sort((x, y) => polyArea(y) - polyArea(x));
  return u[0] ? { outer: u[0].outer, holes: [] } : solid;
}

function finish(poly: Poly, mpp: number, party: PartyLine[], basis: Footprint['basis']): Footprint {
  const simp = simplifyPoly({ outer: poly.outer, holes: [] }, 0.05 / mpp);
  let ring = orthogonalize(mergeCollinear(simp.outer, 0.05 / mpp));
  if (ring.length < 3) ring = simp.outer;
  const b = ringBox(ring);
  const p: Poly = { outer: ring, holes: [] };
  return { ring, poly: p, party, widthM: boxW(b) * mpp, depthM: boxH(b) * mpp, areaM2: polyArea(p) * mpp * mpp, basis };
}

export function buildFootprint(
  rooms: readonly Poly[],
  own: OwnWalls,
  mpp: number,
  thickSegs: readonly Seg[],
  labelPoints: readonly Vec2[],
): Footprint | null {
  const weld = Math.min(2, Math.max(0.3, 0.02 / mpp));
  const party = partyFromForeign(own, rooms, mpp);
  let basis: Footprint['basis'] = 'walls';
  let comps: Poly[] = [];
  if (own.masonry.length + own.insulation.length > 0) {
    comps = closePolys([...own.masonry, ...own.insulation, ...rooms], weld);
  }
  if (comps.length === 0 && thickSegs.length > 0) {
    // Repli : traits épais refermés (rayon 0,3 m) ; on garde le contour qui contient le plus d'étiquettes.
    basis = 'strokes';
    const rings = closeOutline(thickSegs, 0.3 / mpp, 4 / (mpp * mpp));
    comps = rings.map((r) => ({ outer: r, holes: [] }));
    comps.sort((a, b) => labelPoints.filter((p) => pointInPoly(p.x, p.y, b)).length - labelPoints.filter((p) => pointInPoly(p.x, p.y, a)).length);
    if (comps[0] && !labelPoints.some((p) => pointInPoly(p.x, p.y, comps[0]!))) comps = [];
  }
  if (comps.length === 0 && rooms.length > 0) {
    basis = 'rooms';
    comps = closePolys(rooms, 0.3 / mpp);
  }
  if (comps.length === 0) return null;
  if (basis === 'walls') comps.sort((a, b) => polyArea(b) - polyArea(a));
  let main: Poly = { outer: comps[0]!.outer, holes: [] };
  for (const p of party) {
    const cut = intersectPolys([main], [halfPlane(p)]);
    cut.sort((a, b) => polyArea(b) - polyArea(a));
    if (cut[0]) main = { outer: cut[0].outer, holes: [] };
  }
  const bridged = basis === 'walls' ? bridgeNotches(main, mpp, 0.75) : main;
  return finish(bridged, mpp, party, basis);
}

/** Ajoute des lignes mitoyennes (trouvées après coup) et recoupe l'emprise. */
export function cutFootprint(fp: Footprint, extra: PartyLine[], mpp: number): Footprint {
  if (extra.length === 0) return fp;
  let main = fp.poly;
  for (const p of extra) {
    const cut = intersectPolys([main], [halfPlane(p)]);
    cut.sort((a, b) => polyArea(b) - polyArea(a));
    if (cut[0]) main = { outer: cut[0].outer, holes: [] };
  }
  return finish(main, mpp, [...fp.party, ...extra], fp.basis);
}

// ───────────────────────────── Cotes hors tout ─────────────────────────────

const OVERALL_RE = /^(\d{1,3})[,.](\d{2})$/;

/**
 * Cotes hors tout : nombre « 8,00 » écrit le long d'un côté (même orientation), hors du bâtiment à moins de 4 m,
 * égal à la largeur ou à la profondeur de l'emprise à ±1,5 %.
 */
export function overallDimensions(texts: readonly RawText[], fp: Footprint, mpp: number): { width: number | null; depth: number | null } {
  const b = ringBox(fp.ring);
  const max = 4 / mpp;
  let width: number | null = null;
  let depth: number | null = null;
  for (const t of texts) {
    const m = OVERALL_RE.exec(t.s.trim());
    if (!m) continue;
    const v = Number(`${m[1]}.${m[2]}`);
    const horiz = Math.abs(t.angle) < 3 || Math.abs(Math.abs(t.angle) - 180) < 3;
    const vert = Math.abs(Math.abs(t.angle) - 90) < 3;
    const outsideY = t.cy < b.minY ? b.minY - t.cy : t.cy > b.maxY ? t.cy - b.maxY : 0;
    const outsideX = t.cx < b.minX ? b.minX - t.cx : t.cx > b.maxX ? t.cx - b.maxX : 0;
    if (horiz && outsideY > 0 && outsideY < max && t.cx > b.minX && t.cx < b.maxX && Math.abs(v / fp.widthM - 1) <= 0.015) {
      if (width === null || Math.abs(v - fp.widthM) < Math.abs(width - fp.widthM)) width = v;
    }
    if (vert && outsideX > 0 && outsideX < max && t.cy > b.minY && t.cy < b.maxY && Math.abs(v / fp.depthM - 1) <= 0.015) {
      if (depth === null || Math.abs(v - fp.depthM) < Math.abs(depth - fp.depthM)) depth = v;
    }
  }
  return { width, depth };
}

/** Union de polygones (réexport pratique pour les autres fichiers du module). */
export function unionAll(ps: readonly Poly[]): Poly[] {
  return unionPolys(ps);
}
