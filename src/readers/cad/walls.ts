/**
 * Des traits de murs aux murs « pleins » — portage de l'extracteur de référence (notes de recherche DWG/DXF, § 5) :
 *
 *  1. regroupement des extrémités (1 cm) ;
 *  2. réparation des bouts libres : prolongement jusqu'au trait voisin (≤ 6 cm) ou fusion de deux bouts proches ;
 *  3. murs dessinés sans tableaux : deux bouts libres parallèles distants d'une épaisseur de mur sont reliés ;
 *  4. traits égarés sur le calque « 0 » adoptés s'ils ferment davantage de faces ;
 *  5. découpe + faces fermées ; les faces MINCES (cercle inscrit ≤ 36 cm) sont des murs pleins ;
 *  6. tableaux : petite arête d'un mur plein à coins saillants. Deux tableaux qui se font face, de même longueur,
 *     alignés et sans mur entre eux = une OUVERTURE ; le rectangle entre eux est le « pont » ;
 *  7. murs + ponts réunis : chaque composante connexe est un plan, ses trous sont les pièces.
 *
 * Tout est exprimé en unités du dessin ; `u` = unités par mètre.
 */
import type { Vec2 } from '../../core/types';
import {
  PolySet,
  bufferPolys,
  isThinnerThan,
  pointInRing,
  pointSegDistance,
  polyArea,
  polygonizeSegments,
  ringArea,
  ringPerimeter,
  ringSignedArea,
  simplifyRing,
  unionPolys,
} from './planar';
import type { Poly, Seg } from './planar';
import { PointGrid, SegGrid } from './spatial';

export interface Bridge {
  /** Rectangle de l'ouverture, entre les deux tableaux. */
  quad: Vec2[];
  /** Largeur de l'ouverture (distance entre tableaux). */
  width: number;
  /** Épaisseur du mur. */
  thick: number;
  cx: number;
  cy: number;
  /** Direction du mur (d'un tableau vers l'autre), vecteur unitaire. */
  dirX: number;
  dirY: number;
}

export interface WallModel {
  /** Traits de murs après réparation. */
  segs: Seg[];
  /** Murs pleins (réunis). */
  solids: Poly[];
  bridges: Bridge[];
  /** Milieux des tableaux restés sans vis-à-vis (murs non refermés). */
  freeJambs: Vec2[];
  /** Murs + ponts réunis : les trous sont les pièces. */
  comps: Poly[];
  faces: number;
  dangles: number;
  healed: number;
  jambsAdded: number;
  layer0Adopted: number;
}

const key = (x: number, y: number): string => `${x},${y}`;

function degrees(segs: readonly Seg[]): Map<string, number> {
  const deg = new Map<string, number>();
  for (const s of segs) {
    const ka = key(s.ax, s.ay);
    const kb = key(s.bx, s.by);
    deg.set(ka, (deg.get(ka) ?? 0) + 1);
    deg.set(kb, (deg.get(kb) ?? 0) + 1);
  }
  return deg;
}

/** Fusionne les extrémités distantes de moins de `tol` ; supprime les segments nuls et les doublons. */
export function clusterEndpoints(segs: readonly Seg[], tol: number): Seg[] {
  const n = segs.length * 2;
  if (n === 0) return [];
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    px[2 * i] = s.ax;
    py[2 * i] = s.ay;
    px[2 * i + 1] = s.bx;
    py[2 * i + 1] = s.by;
  }
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const grid = new PointGrid(tol);
  for (let i = 0; i < n; i++) {
    const x = px[i]!;
    const y = py[i]!;
    grid.near(x, y, tol, (j) => {
      if (Math.hypot(px[j]! - x, py[j]! - y) <= tol) {
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) parent[rb] = ra;
      }
    });
    grid.add(x, y, i);
  }
  const sumX = new Float64Array(n);
  const sumY = new Float64Array(n);
  const cnt = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    sumX[r] = sumX[r]! + px[i]!;
    sumY[r] = sumY[r]! + py[i]!;
    cnt[r] = cnt[r]! + 1;
  }
  const out: Seg[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    const ra = find(2 * i);
    const rb = find(2 * i + 1);
    if (ra === rb) continue;
    const ax = sumX[ra]! / cnt[ra]!;
    const ay = sumY[ra]! / cnt[ra]!;
    const bx = sumX[rb]! / cnt[rb]!;
    const by = sumY[rb]! / cnt[rb]!;
    const k = ra < rb ? `${ra}|${rb}` : `${rb}|${ra}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ax, ay, bx, by });
  }
  return out;
}

function buildSegGrid(segs: readonly Seg[], cell: number): SegGrid {
  const grid = new SegGrid(cell);
  for (let i = 0; i < segs.length; i++) grid.add(i, segs[i]!);
  return grid;
}

/** Prolonge les bouts libres de `tol`, découpe aux intersections et reconstruit les faces. */
function polygonizeWalls(segs: readonly Seg[], tol: number, grid: number): { faces: Poly[]; dangles: number } {
  const deg = degrees(segs);
  const lines: Seg[] = [];
  for (const s of segs) {
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const ux = dx / len;
    const uy = dy / len;
    const t: Seg = { ax: s.ax, ay: s.ay, bx: s.bx, by: s.by };
    if (deg.get(key(s.ax, s.ay)) === 1) {
      t.ax -= ux * tol;
      t.ay -= uy * tol;
    }
    if (deg.get(key(s.bx, s.by)) === 1) {
      t.bx += ux * tol;
      t.by += uy * tol;
    }
    lines.push(t);
  }
  const res = polygonizeSegments(lines, grid);
  let dangles = 0;
  for (const d of res.dangles) if (Math.hypot(d.bx - d.ax, d.by - d.ay) > 3 * tol) dangles++;
  return { faces: res.faces, dangles };
}

/** Distance le long du rayon (p, u) jusqu'au segment s ; null s'il ne le coupe pas avant `maxT`. */
function rayHit(px: number, py: number, ux: number, uy: number, maxT: number, s: Seg, tol: number): number | null {
  const vx = s.bx - s.ax;
  const vy = s.by - s.ay;
  const den = ux * vy - uy * vx;
  const wx = s.ax - px;
  const wy = s.ay - py;
  const len = Math.hypot(vx, vy);
  if (len === 0) return null;
  if (Math.abs(den) < 1e-9 * len) {
    // Parallèles : seul un segment colinéaire peut être « touché » (par son extrémité la plus proche).
    if (Math.abs(wx * uy - wy * ux) > tol * 0.5) return null;
    const t1 = wx * ux + wy * uy;
    const t2 = (s.bx - px) * ux + (s.by - py) * uy;
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    if (hi < 0 || lo > maxT) return null;
    return Math.max(0, lo);
  }
  const t = (wx * vy - wy * vx) / den;
  const k = (wx * uy - wy * ux) / den;
  if (t < 0 || t > maxT || k < 0 || k > 1) return null;
  return t;
}

/**
 * Écarts plus grands que la tolérance d'accrochage : (1) un bout libre est prolongé dans sa direction jusqu'au
 * prochain trait de mur (au plus `maxExt`) ; (2) deux bouts libres plus proches que `mergeDist` sont fusionnés
 * (le coin est reconstruit à l'intersection des deux droites).
 */
function healFreeEnds(segs: readonly Seg[], tol: number, maxExt: number, mergeDist: number): { segs: Seg[]; fixed: number } {
  if (segs.length === 0) return { segs: [], fixed: 0 };
  const deg = degrees(segs);
  const index = buildSegGrid(segs, Math.max(maxExt * 4, tol * 10));
  interface FreeEnd {
    x: number;
    y: number;
    seg: number;
    end: 0 | 1;
  }
  const free: FreeEnd[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    for (const end of [0, 1] as const) {
      const x = end === 0 ? s.ax : s.bx;
      const y = end === 0 ? s.ay : s.by;
      if (deg.get(key(x, y)) !== 1) continue;
      const r = tol * 0.5;
      let touching = false;
      for (const j of index.query(x - r, y - r, x + r, y + r)) {
        if (j === i) continue;
        const o = segs[j]!;
        if (pointSegDistance(x, y, o.ax, o.ay, o.bx, o.by) <= r) {
          touching = true;
          break;
        }
      }
      if (touching) continue; // jonction en T : le bout repose sur un autre trait
      free.push({ x, y, seg: i, end });
    }
  }
  if (free.length === 0) return { segs: [...segs], fixed: 0 };

  const work = segs.map((s) => ({ ...s }));
  const freeGrid = new PointGrid(Math.max(mergeDist, tol));
  free.forEach((f, i) => freeGrid.add(f.x, f.y, i));
  const done = new Uint8Array(free.length);
  let fixed = 0;
  const setEnd = (f: FreeEnd, x: number, y: number): void => {
    const s = work[f.seg]!;
    if (f.end === 0) {
      s.ax = x;
      s.ay = y;
    } else {
      s.bx = x;
      s.by = y;
    }
  };
  const otherEnd = (f: FreeEnd): [number, number] => {
    const s = work[f.seg]!;
    return f.end === 0 ? [s.bx, s.by] : [s.ax, s.ay];
  };

  for (let fi = 0; fi < free.length; fi++) {
    if (done[fi]) continue;
    const f = free[fi]!;
    const [ox, oy] = otherEnd(f);
    const dx = f.x - ox;
    const dy = f.y - oy;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const ux = dx / len;
    const uy = dy / len;
    const ex = f.x + ux * maxExt;
    const ey = f.y + uy * maxExt;
    let best: number | null = null;
    for (const j of index.query(Math.min(f.x, ex) - tol, Math.min(f.y, ey) - tol, Math.max(f.x, ex) + tol, Math.max(f.y, ey) + tol)) {
      if (j === f.seg) continue;
      const t = rayHit(f.x, f.y, ux, uy, maxExt, segs[j]!, tol);
      if (t !== null && (best === null || t < best)) best = t;
    }
    if (best !== null) {
      setEnd(f, f.x + ux * (best + tol * 0.5), f.y + uy * (best + tol * 0.5));
      fixed++;
      done[fi] = 1;
      continue;
    }
    let partner = -1;
    freeGrid.near(f.x, f.y, mergeDist, (qi) => {
      if (partner >= 0 || qi === fi || done[qi]) return;
      const q = free[qi]!;
      if (Math.hypot(q.x - f.x, q.y - f.y) <= mergeDist) partner = qi;
    });
    if (partner >= 0) {
      const q = free[partner]!;
      const [o2x, o2y] = otherEnd(q);
      const vx = q.x - o2x;
      const vy = q.y - o2y;
      const den = ux * vy - uy * vx;
      let mx = (f.x + q.x) / 2;
      let my = (f.y + q.y) / 2;
      if (Math.abs(den) > 0.2 * Math.hypot(vx, vy)) {
        // Pas parallèles : le coin est l'intersection des deux droites.
        const t = ((q.x - f.x) * vy - (q.y - f.y) * vx) / den;
        const cx = f.x + ux * t;
        const cy = f.y + uy * t;
        if (Math.hypot(cx - f.x, cy - f.y) <= 2 * mergeDist && Math.hypot(cx - q.x, cy - q.y) <= 2 * mergeDist) {
          mx = cx;
          my = cy;
        }
      }
      setEnd(f, mx, my);
      setEnd(q, mx, my);
      done[fi] = 1;
      done[partner] = 1;
      fixed++;
    }
  }
  return { segs: work, fixed };
}

/**
 * Murs dessinés SANS tableaux : relie deux bouts libres de traits parallèles qui s'arrêtent au même endroit
 * (distance = épaisseur de mur, liaison perpendiculaire aux deux traits). Renvoie les segments à ajouter.
 */
function closeFreeEnds(segs: readonly Seg[], tmin: number, tmax: number, tol: number): Seg[] {
  const deg = degrees(segs);
  interface End {
    x: number;
    y: number;
    dx: number;
    dy: number;
  }
  const ends: End[] = [];
  for (const s of segs) {
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const len = Math.hypot(dx, dy);
    if (len < tol) continue;
    if (deg.get(key(s.ax, s.ay)) === 1) ends.push({ x: s.ax, y: s.ay, dx: -dx / len, dy: -dy / len });
    if (deg.get(key(s.bx, s.by)) === 1) ends.push({ x: s.bx, y: s.by, dx: dx / len, dy: dy / len });
  }
  if (ends.length < 2) return [];
  const index = buildSegGrid(segs, Math.max(tmax, tol * 10));
  const free: End[] = [];
  for (const e of ends) {
    let touching = false;
    for (const j of index.query(e.x - tol, e.y - tol, e.x + tol, e.y + tol)) {
      const o = segs[j]!;
      if ((o.ax === e.x && o.ay === e.y) || (o.bx === e.x && o.by === e.y)) continue;
      if (pointSegDistance(e.x, e.y, o.ax, o.ay, o.bx, o.by) <= tol) {
        touching = true;
        break;
      }
    }
    if (!touching) free.push(e);
  }
  if (free.length < 2) return [];
  const grid = new PointGrid(tmax);
  free.forEach((f, i) => grid.add(f.x, f.y, i));
  const bestDist = new Float64Array(free.length).fill(Infinity);
  const bestIdx = new Int32Array(free.length).fill(-1);
  for (let a = 0; a < free.length; a++) {
    const p = free[a]!;
    grid.near(p.x, p.y, tmax, (b) => {
      if (b <= a) return;
      const q = free[b]!;
      const vx = q.x - p.x;
      const vy = q.y - p.y;
      const dist = Math.hypot(vx, vy);
      if (dist < tmin || dist > tmax) return;
      if (p.dx * q.dx + p.dy * q.dy < 0.98) return; // les deux traits vont dans le même sens
      if (Math.abs(vx * p.dx + vy * p.dy) > Math.max(tol, 0.03 * dist)) return; // liaison perpendiculaire
      if (dist < bestDist[a]!) {
        bestDist[a] = dist;
        bestIdx[a] = b;
      }
      if (dist < bestDist[b]!) {
        bestDist[b] = dist;
        bestIdx[b] = a;
      }
    });
  }
  const extra: Seg[] = [];
  for (let i = 0; i < free.length; i++) {
    const j = bestIdx[i]!;
    if (j > i && bestIdx[j] === i) extra.push({ ax: free[i]!.x, ay: free[i]!.y, bx: free[j]!.x, by: free[j]!.y });
  }
  return extra;
}

interface Jamb {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  len: number;
  mx: number;
  my: number;
  nx: number;
  ny: number;
}

/** Tableaux = petites arêtes des murs pleins dont les deux coins sont saillants (bouts de murs). */
function jambEdges(solids: readonly Poly[], jmin: number, jmax: number): Jamb[] {
  const out: Jamb[] = [];
  for (const poly of solids) {
    const rings: Vec2[][] = [];
    // Matière à GAUCHE du sens de parcours : extérieur en sens trigonométrique, trous en sens horaire.
    rings.push(ringSignedArea(poly.outer) >= 0 ? poly.outer : [...poly.outer].reverse());
    for (const h of poly.holes) rings.push(ringSignedArea(h) <= 0 ? h : [...h].reverse());
    for (const c of rings) {
      const n = c.length;
      if (n < 4) continue;
      for (let i = 0; i < n; i++) {
        const p0 = c[(i - 1 + n) % n]!;
        const p1 = c[i]!;
        const p2 = c[(i + 1) % n]!;
        const p3 = c[(i + 2) % n]!;
        const ex = p2.x - p1.x;
        const ey = p2.y - p1.y;
        const len = Math.hypot(ex, ey);
        if (len < jmin || len > jmax) continue;
        const c1 = (p1.x - p0.x) * ey - (p1.y - p0.y) * ex;
        const c2 = ex * (p3.y - p2.y) - ey * (p3.x - p2.x);
        if (c1 <= 0 || c2 <= 0) continue;
        out.push({ ax: p1.x, ay: p1.y, bx: p2.x, by: p2.y, len, mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2, nx: ey / len, ny: -ex / len });
      }
    }
  }
  return out;
}

/** Rétrécit un quadrilatère convexe de d (chaque côté déplacé vers l'intérieur). */
function insetConvex(quad: readonly Vec2[], d: number): Vec2[] {
  const n = quad.length;
  const sign = ringSignedArea(quad) >= 0 ? 1 : -1;
  const lines: { px: number; py: number; ux: number; uy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % n]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    // Normale intérieure : à gauche pour un anneau en sens trigonométrique.
    lines.push({ px: a.x - uy * d * sign, py: a.y + ux * d * sign, ux, uy });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i - 1 + n) % n]!;
    const l2 = lines[i]!;
    const den = l1.ux * l2.uy - l1.uy * l2.ux;
    if (Math.abs(den) < 1e-12) return [];
    const t = ((l2.px - l1.px) * l2.uy - (l2.py - l1.py) * l2.ux) / den;
    out.push({ x: l1.px + l1.ux * t, y: l1.py + l1.uy * t });
  }
  // Un quadrilatère trop mince se retourne : rien à tester.
  return ringSignedArea(out) * sign > 0 ? out : [];
}

function isConvexQuad(q: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-12) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

function pairJambs(jambs: readonly Jamb[], solids: readonly Poly[], gmin: number, gmax: number, tol: number): { bridges: Bridge[]; free: number[] } {
  if (jambs.length < 2) return { bridges: [], free: jambs.map((_j, i) => i) };
  const grid = new PointGrid(gmax + tol);
  jambs.forEach((j, i) => grid.add(j.mx, j.my, i));
  const cand: { along: number; b: number }[][] = jambs.map(() => []);
  for (let a = 0; a < jambs.length; a++) {
    const ja = jambs[a]!;
    grid.near(ja.mx, ja.my, gmax + tol, (b) => {
      if (a === b) return;
      const jb = jambs[b]!;
      if (ja.nx * jb.nx + ja.ny * jb.ny > -0.95) return;
      if (Math.abs(ja.len - jb.len) > Math.max(4 * tol, 0.1 * ja.len)) return;
      const vx = jb.mx - ja.mx;
      const vy = jb.my - ja.my;
      const along = vx * ja.nx + vy * ja.ny;
      const lateral = Math.abs(vx * ja.ny - vy * ja.nx);
      if (along < gmin || along > gmax || lateral > 4 * tol) return;
      cand[a]!.push({ along, b });
    });
    cand[a]!.sort((p, q) => p.along - q.along || p.b - q.b);
  }
  const set = new PolySet(solids);
  const used = new Uint8Array(jambs.length);
  const bridges: Bridge[] = [];
  for (let a = 0; a < jambs.length; a++) {
    if (used[a]) continue;
    for (const { along, b } of cand[a]!) {
      if (used[b]) continue;
      // b doit lui aussi préférer a (parmi ses vis-à-vis encore libres).
      const nearer = cand[b]!.find((x) => !used[x.b]);
      if (!nearer || nearer.b !== a) continue;
      const ja = jambs[a]!;
      const jb = jambs[b]!;
      let quad: Vec2[] = [
        { x: ja.ax, y: ja.ay },
        { x: ja.bx, y: ja.by },
        { x: jb.ax, y: jb.ay },
        { x: jb.bx, y: jb.by },
      ];
      if (!isConvexQuad(quad)) quad = [quad[0]!, quad[1]!, quad[3]!, quad[2]!];
      const area = ringArea(quad);
      if (!isConvexQuad(quad) || area <= 0) continue;
      const inner = insetConvex(quad, tol);
      if (inner.length >= 3) {
        const blocked = set.intersectionArea(inner);
        if (!(blocked <= 0.02 * area)) continue; // un mur traverse l'intervalle (ou calcul impossible)
      }
      bridges.push({
        quad,
        width: along,
        thick: (ja.len + jb.len) / 2,
        cx: (ja.mx + jb.mx) / 2,
        cy: (ja.my + jb.my) / 2,
        dirX: ja.nx,
        dirY: ja.ny,
      });
      used[a] = 1;
      used[b] = 1;
      break;
    }
  }
  const free: number[] = [];
  for (let i = 0; i < jambs.length; i++) if (!used[i]) free.push(i);
  return { bridges, free };
}

function pointInPoly(x: number, y: number, poly: Poly): boolean {
  if (!pointInRing(x, y, poly.outer)) return false;
  for (const h of poly.holes) if (pointInRing(x, y, h)) return false;
  return true;
}

function simplifyPoly(poly: Poly, tol: number): Poly {
  return {
    outer: simplifyRing(poly.outer, tol),
    holes: poly.holes.map((h) => simplifyRing(h, tol)).filter((h) => h.length >= 3),
  };
}

/**
 * Construit le modèle de murs à partir des traits des calques de murs.
 *  - `layer0` : traits du calque « 0 » (candidats à l'adoption) ;
 *  - `labels` : positions des noms de pièces (une face qui en contient un n'est pas un mur, même mince).
 */
export function buildWalls(wallSegs: readonly Seg[], layer0: readonly Seg[], labels: readonly Vec2[], u: number): WallModel {
  const tol = 0.01 * u;
  const grid = 0.0005 * u;

  let segs = clusterEndpoints(wallSegs, tol);
  let { faces, dangles } = polygonizeWalls(segs, tol, grid);
  let healed = 0;

  // (i) écarts au-delà de la tolérance d'accrochage
  const heal = healFreeEnds(segs, tol, 0.06 * u, 0.04 * u);
  if (heal.fixed > 0) {
    const segsH = clusterEndpoints(heal.segs, tol);
    const resH = polygonizeWalls(segsH, tol, grid);
    if (resH.faces.length > faces.length || resH.dangles < dangles) {
      segs = segsH;
      faces = resH.faces;
      dangles = resH.dangles;
      healed = heal.fixed;
    }
  }

  // (ii) murs sans tableaux
  const build = (list: readonly Seg[]): { segs: Seg[]; faces: Poly[]; dangles: number; added: number } => {
    const sg = clusterEndpoints(list, tol);
    const base = polygonizeWalls(sg, tol, grid);
    const extra = closeFreeEnds(sg, 0.04 * u, 0.7 * u, tol);
    if (extra.length > 0) {
      const sg2 = clusterEndpoints([...sg, ...extra], tol);
      const res2 = polygonizeWalls(sg2, tol, grid);
      if (res2.faces.length > base.faces.length) return { segs: sg2, faces: res2.faces, dangles: res2.dangles, added: extra.length };
    }
    return { segs: sg, faces: base.faces, dangles: base.dangles, added: 0 };
  };
  let built = build(segs);
  let jambsAdded = built.added;

  // (iii) traits égarés sur le calque « 0 » dont les deux bouts tombent sur des nœuds de murs
  let layer0Adopted = 0;
  if (layer0.length > 0 && built.segs.length > 0) {
    const nodeSet = new Set<string>();
    for (const s of built.segs) {
      nodeSet.add(key(s.ax, s.ay));
      nodeSet.add(key(s.bx, s.by));
    }
    const nodeList = [...nodeSet].map((k) => k.split(',').map(Number) as [number, number]);
    const nodeGrid = new PointGrid(tol * 4);
    nodeList.forEach((p, i) => nodeGrid.add(p[0], p[1], i));
    const onNode = (x: number, y: number): boolean => {
      let hit = false;
      nodeGrid.near(x, y, tol, (i) => {
        if (!hit && Math.hypot(nodeList[i]![0] - x, nodeList[i]![1] - y) <= tol) hit = true;
      });
      return hit;
    };
    const candidates = layer0.filter((s) => (s.ax !== s.bx || s.ay !== s.by) && onNode(s.ax, s.ay) && onNode(s.bx, s.by));
    if (candidates.length > 0 && candidates.length <= 2000) {
      const adopted = build([...built.segs, ...candidates]);
      if (adopted.faces.length > built.faces.length) {
        layer0Adopted = candidates.length;
        jambsAdded = Math.max(jambsAdded, adopted.added);
        built = adopted;
      }
    }
  }
  segs = built.segs;
  faces = built.faces;
  dangles = built.dangles;

  // Murs pleins : faces minces sans nom de pièce.
  const minArea = (0.02 * u) ** 2;
  const thin = 0.36 * u;
  const solidFaces: Poly[] = [];
  for (const f of faces) {
    const area = polyArea(f);
    if (area < minArea) continue;
    let perimeter = ringPerimeter(f.outer);
    for (const h of f.holes) perimeter += ringPerimeter(h);
    // Le rayon inscrit vaut au moins aire / périmètre : au-delà de 36 cm ce n'est pas un mur.
    if (area / perimeter > thin) continue;
    if (labels.some((p) => pointInPoly(p.x, p.y, f))) continue;
    if (isThinnerThan(f, thin)) solidFaces.push(f);
  }
  let solids = unionPolys(solidFaces);
  if (solids.length > 0) {
    const merged = bufferPolys(bufferPolys(solids, grid), -grid);
    if (merged.length > 0) solids = merged;
    solids = solids.map((p) => simplifyPoly(p, grid)).filter((p) => p.outer.length >= 3);
  }

  const jambs = jambEdges(solids, 0.04 * u, 0.7 * u);
  const paired = pairJambs(jambs, solids, 0.35 * u, 5.5 * u, tol);

  let comps: Poly[] = [];
  if (solids.length > 0) {
    const all: Poly[] = [...solids, ...paired.bridges.map((b): Poly => ({ outer: b.quad, holes: [] }))];
    comps = unionPolys(all);
    const merged = bufferPolys(bufferPolys(comps, grid), -grid);
    if (merged.length > 0) comps = merged;
    comps = comps.map((p) => simplifyPoly(p, grid)).filter((p) => p.outer.length >= 3);
  }

  return {
    segs,
    solids,
    bridges: paired.bridges,
    freeJambs: paired.free.map((i) => ({ x: jambs[i]!.mx, y: jambs[i]!.my })),
    comps,
    faces: faces.length,
    dangles,
    healed,
    jambsAdded,
    layer0Adopted,
  };
}

/**
 * Indice « murs en double trait » : longueur (et part) des segments ayant un jumeau parallèle distant de 5 à 65 cm
 * et qui les recouvre à 50 % au moins. Sert à deviner le calque des murs et l'unité du dessin.
 */
export function parallelPairScore(input: readonly Seg[], u: number): { matched: number; share: number } {
  const segs = input.filter((s) => Math.hypot(s.bx - s.ax, s.by - s.ay) >= 0.3 * u);
  if (segs.length < 4) return { matched: 0, share: 0 };
  const reach = 0.65 * u;
  // Maille à l'échelle des traits (et non de l'épaisseur cherchée) : l'hypothèse d'unité peut être fausse d'un facteur 1000.
  let sum = 0;
  for (const s of segs) sum += Math.hypot(s.bx - s.ax, s.by - s.ay);
  const index = buildSegGrid(segs, Math.max(reach * 2, sum / segs.length / 2, 1e-9));
  let total = 0;
  let matched = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const len = Math.hypot(dx, dy);
    total += len;
    const ux = dx / len;
    const uy = dy / len;
    let ok = false;
    for (const j of index.query(Math.min(s.ax, s.bx) - reach, Math.min(s.ay, s.by) - reach, Math.max(s.ax, s.bx) + reach, Math.max(s.ay, s.by) + reach)) {
      if (j === i) continue;
      const o = segs[j]!;
      const ex = o.bx - o.ax;
      const ey = o.by - o.ay;
      const l2 = Math.hypot(ex, ey);
      if (Math.abs(ux * ey - uy * ex) / l2 > 0.02) continue;
      const dist = Math.abs((o.ax - s.ax) * uy - (o.ay - s.ay) * ux);
      if (dist < 0.05 * u || dist > reach) continue;
      const t1 = (o.ax - s.ax) * ux + (o.ay - s.ay) * uy;
      const t2 = (o.bx - s.ax) * ux + (o.by - s.ay) * uy;
      const overlap = Math.min(len, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
      if (overlap >= 0.5 * Math.min(len, l2)) {
        ok = true;
        break;
      }
    }
    if (ok) matched += len;
  }
  return { matched, share: total > 0 ? matched / total : 0 };
}
