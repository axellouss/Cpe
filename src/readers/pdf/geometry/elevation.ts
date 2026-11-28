/**
 * Façades dessinées : baies (rectangles à l'échelle) et rattachement d'une façade nommée à un côté du plan.
 *
 * Baies : les remplissages de la façade forment des rectangles emboîtés (cadre → vitrage, vantail → vitrage,
 * entourage → fenêtre + allège). On construit l'arbre de contenance et l'on garde comme baie le rectangle le plus
 * extérieur, sauf un entourage « lâche » qui contient lui-même un cadre vitré : c'est alors ses enfants qui sont
 * les baies. Une baie doit porter un vitrage (un rectangle intérieur) ou être une porte pleine posée au pied de la
 * façade (1,8 à 2,6 m de haut). Au pied et assez haute : porte-fenêtre si le vitrage couvre au moins la moitié,
 * sinon porte (porte de garage au-delà de 1,6 m de large). Aucune couleur n'est supposée.
 *
 * Côté du plan : pour chaque direction de façade du plan, les baies du plan sont projetées sur l'axe gauche → droite
 * vu de l'extérieur, niveau par niveau, et comparées aux baies de la façade (recouvrement 1D, miroir compris). La
 * longueur de la façade doit égaler l'étendue du côté à 3 % près. Recoupements : la flèche du nord (façade nommée
 * par son orientation) et le nom « avant » (côté de la porte d'entrée ou de garage).
 */
import type { Vec2 } from '../../../core/types';
import type { ElevationSide, ReadElevationBay } from '../../../core/reading';
import type { RawBox } from '../raw';
import type { ViewInput } from './types';
import { angleGap, boxContains, boxesBox, boxH, boxW, round, sheetAzimuth } from './util';

export interface ElevationBay extends ReadElevationBay {
  /** Abscisse depuis le bord gauche de la façade et hauteur depuis son pied (m). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface ElevationRead {
  widthM: number;
  heightM: number;
  silhouette: RawBox;
  bays: ElevationBay[];
}

interface Node {
  b: RawBox;
  area: number;
  color: number;
  alpha: number;
  parent: Node | null;
  children: Node[];
}

function margins(outer: RawBox, inner: RawBox): number {
  return Math.max(inner.minX - outer.minX, inner.minY - outer.minY, outer.maxX - inner.maxX, outer.maxY - inner.maxY);
}

/** Un remplissage translucide (ombre, végétation, teinte) n'est une vitre que posé dans un cadre opaque. */
const TRANSLUCENT = 0.6;

/** Un enfant « vitre » se distingue de son cadre (autre teinte ou autre opacité) ; un panneau de même teinte n'en est pas. */
function differs(a: Node, b: Node): boolean {
  return a.color !== b.color || Math.abs(a.alpha - b.alpha) > 0.1;
}

/** Aire vitrée d'un nœud : feuilles de l'arbre qui se distinguent de leur parent. */
function glazedArea(n: Node): number {
  let s = 0;
  for (const c of n.children) {
    if (c.children.length > 0) s += glazedArea(c);
    else if (differs(c, n)) s += c.area;
  }
  return s;
}

export function elevationBays(v: ViewInput, mpp: number): ElevationRead | null {
  const tall = v.fills.filter((f) => boxH(f.bbox) * mpp > 3 && boxW(f.bbox) * mpp > 1 && boxW(f.bbox) * mpp < 40);
  const sil = boxesBox(tall.map((f) => f.bbox));
  if (!sil) return null;
  const silW = boxW(sil);
  const tol = 0.02 / mpp;
  const nodes: Node[] = [];
  for (const f of v.fills) {
    const b = f.bbox;
    const w = boxW(b) * mpp;
    const h = boxH(b) * mpp;
    if (w < 0.25 || h < 0.25 || w > 6.5 || h > 4.5) continue;
    if (boxW(b) > 0.9 * silW) continue;
    if (!boxContains(sil, b, 0.1 / mpp)) continue;
    if (nodes.some((n) => Math.abs(n.b.minX - b.minX) < tol && Math.abs(n.b.minY - b.minY) < tol && Math.abs(n.b.maxX - b.maxX) < tol && Math.abs(n.b.maxY - b.maxY) < tol)) continue;
    nodes.push({ b, area: boxW(b) * boxH(b), color: f.color, alpha: f.alpha, parent: null, children: [] });
  }
  nodes.sort((a, b) => b.area - a.area);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    for (let j = i - 1; j >= 0; j--) {
      const p = nodes[j]!;
      if (p.area > n.area && boxContains(p.b, n.b, 0.3)) {
        if (!n.parent || p.area < n.parent.area) n.parent = p;
      }
    }
    n.parent?.children.push(n);
  }
  const foot = sil.maxY;
  const tight = 0.15 / mpp;
  // Baies : racines, en descendant à travers les entourages lâches.
  const bays: Node[] = [];
  const seen = new Set<Node>();
  const visit = (n: Node): void => {
    if (seen.has(n)) return;
    seen.add(n);
    // Remplissage translucide hors de tout cadre (ombre portée, haie, auvent teinté) : ce n'est pas une baie, mais
    // il peut recouvrir des baies (porte d'entrée sous un auvent).
    if (!n.parent && n.alpha < TRANSLUCENT) {
      for (const c of n.children) {
        c.parent = null;
        visit(c);
      }
      return;
    }
    const surround = n.children.some((c) => c.children.length > 0 && margins(n.b, c.b) > tight && boxH(c.b) < 0.9 * boxH(n.b));
    if (surround) {
      for (const c of n.children) visit(c);
      return;
    }
    bays.push(n);
  };
  for (const n of nodes) if (!n.parent) visit(n);
  type Bay = { b: RawBox; parts: number; glazed: number };
  let list: Bay[] = [];
  for (const n of bays) {
    const footM = (foot - n.b.maxY) * mpp;
    const h = boxH(n.b) * mpp;
    const atFoot = footM <= 0.35 && h >= 1.8 && h <= 2.6;
    if (n.children.length === 0 && !atFoot) continue;
    const glazedKids = n.children.filter((c) => c.children.length > 0).length;
    list.push({ b: n.b, parts: Math.max(1, glazedKids), glazed: n.children.length ? glazedArea(n) / n.area : 0 });
  }
  // Vantaux jointifs (même haut, même bas, écart ≤ 0,1 m) fusionnés.
  list.sort((a, b) => a.b.minX - b.b.minX);
  const merged: Bay[] = [];
  for (const x of list) {
    const l = merged.find(
      (m) => Math.abs(m.b.minY - x.b.minY) * mpp < 0.1 && Math.abs(m.b.maxY - x.b.maxY) * mpp < 0.1 && Math.abs(x.b.minX - m.b.maxX) * mpp < 0.1,
    );
    if (l) {
      const aw = boxW(l.b) * boxH(l.b);
      const bw = boxW(x.b) * boxH(x.b);
      l.glazed = (l.glazed * aw + x.glazed * bw) / (aw + bw);
      l.b = { minX: l.b.minX, minY: Math.min(l.b.minY, x.b.minY), maxX: Math.max(l.b.maxX, x.b.maxX), maxY: Math.max(l.b.maxY, x.b.maxY) };
      l.parts += x.parts;
    } else merged.push({ ...x, b: { ...x.b } });
  }
  list = merged.filter((m) => !merged.some((o) => o !== m && boxContains(o.b, m.b, 0.3) && margins(o.b, m.b) <= tight));
  const out: ElevationBay[] = list.map((m) => {
    const w = boxW(m.b) * mpp;
    const h = boxH(m.b) * mpp;
    const y0 = (foot - m.b.maxY) * mpp;
    let kind: ReadElevationBay['kind'] = 'window';
    if (y0 <= 0.35 && h >= 1.8 && m.glazed < 0.5) kind = w > 1.6 ? 'wide-door' : 'door';
    return {
      box: { minX: m.b.minX, minY: m.b.minY, maxX: m.b.maxX, maxY: m.b.maxY },
      widthM: round(w, 3),
      heightM: round(h, 3),
      kind,
      parts: m.parts,
      x0: (m.b.minX - sil.minX) * mpp,
      x1: (m.b.maxX - sil.minX) * mpp,
      y0,
      y1: (foot - m.b.minY) * mpp,
    };
  });
  out.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return { widthM: silW * mpp, heightM: boxH(sil) * mpp, silhouette: sil, bays: out };
}

// ───────────────────────────── Rattachement à un côté du plan ─────────────────────────────

/** Baie du plan vue par le rattachement : centre (uf), largeur, normale extérieure de son mur, rang du niveau. */
export interface SideBay {
  centre: Vec2;
  widthM: number;
  n: Vec2;
  rank: number;
  heightM: number | null;
  entrance: boolean;
  garage: boolean;
  /** Repère de la baie dans la lecture (pour renvoyer une hauteur recoupée). */
  ref: { sheetId: string; index: number };
}

export interface PlanForSides {
  ring: Vec2[];
  rank: number;
  bays: SideBay[];
  mpp: number;
}

export interface SideGroup {
  n: Vec2;
  deg: number;
  /** Étendue du bâtiment le long de l'axe gauche → droite vu de l'extérieur (uf, repère du plan de référence). */
  uMin: number;
  lengthM: number;
}

/** Directions de façade du plan : normales extérieures des arêtes (≥ 1 m), regroupées à 10° près. */
export function sideGroups(ring: readonly Vec2[], mpp: number): SideGroup[] {
  const groups: { deg: number; len: number; n: Vec2 }[] = [];
  const area = ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    return s + p.x * q.y - q.x * p.y;
  }, 0);
  const sgn = area > 0 ? 1 : -1; // y vers le bas : aire > 0 ⇔ sens horaire à l'écran
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L * mpp < 1) continue;
    // Normale extérieure d'un anneau orienté : (dy, −dx) pour un anneau d'aire positive dans ce repère.
    const n = { x: (sgn * (b.y - a.y)) / L, y: (-sgn * (b.x - a.x)) / L };
    const deg = sheetAzimuth(n);
    const g = groups.find((x) => angleGap(x.deg, deg) < 10);
    if (g) g.len += L;
    else groups.push({ deg, len: L, n });
  }
  return groups.map((g) => {
    const u = { x: g.n.y, y: -g.n.x };
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of ring) {
      const t = p.x * u.x + p.y * u.y;
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    return { n: g.n, deg: g.deg, uMin: lo, lengthM: (hi - lo) * mpp };
  });
}

type Interval = [number, number];

function mergeIv(xs: Interval[]): Interval[] {
  const s = xs.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const x of s) {
    const l = out[out.length - 1];
    if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

function ivLength(xs: Interval[]): number {
  return xs.reduce((s, x) => s + x[1] - x[0], 0);
}

function ivIntersection(a: Interval[], b: Interval[]): number {
  let s = 0;
  for (const x of a) for (const y of b) s += Math.max(0, Math.min(x[1], y[1]) - Math.max(x[0], y[0]));
  return s;
}

/** Groupes de baies de façade par niveau : coupure là où les pieds s'écartent de plus de 1,2 m. */
export function levelClusters(bays: readonly ElevationBay[]): number[] {
  const order = bays.map((b, i) => ({ y: b.y0, i })).sort((a, b) => a.y - b.y);
  const cl = new Array<number>(bays.length).fill(0);
  let k = 0;
  for (let j = 0; j < order.length; j++) {
    if (j > 0 && order[j]!.y - order[j - 1]!.y > 1.2) k++;
    cl[order[j]!.i] = k;
  }
  return cl;
}

export interface SideMatch {
  group: SideGroup;
  score: number;
  margin: number;
  mirrored: boolean;
  /** Rang du niveau du plan attribué à chaque groupe de baies de la façade (même ordre que levelClusters). */
  levelOf: number[];
}

function planIntervals(plans: readonly PlanForSides[], g: SideGroup): Map<number, Interval[]> {
  const out = new Map<number, Interval[]>();
  const u = { x: g.n.y, y: -g.n.x };
  for (const p of plans) {
    for (const b of p.bays) {
      if (angleGap(sheetAzimuth(b.n), g.deg) > 10) continue;
      const t = (b.centre.x * u.x + b.centre.y * u.y - g.uMin) * p.mpp;
      const list = out.get(p.rank) ?? [];
      list.push([t - b.widthM / 2, t + b.widthM / 2]);
      out.set(p.rank, list);
    }
  }
  return out;
}

/** Score d'une façade sur un côté : recouvrement des baies niveau par niveau (meilleur calage des niveaux). */
function scoreSide(bays: readonly ElevationBay[], cl: readonly number[], plan: Map<number, Interval[]>, ranks: readonly number[], L: number, mirror: boolean): { score: number; levelOf: number[] } {
  const nCl = cl.length ? Math.max(...cl) + 1 : 0;
  const facade: Interval[][] = Array.from({ length: nCl }, () => []);
  bays.forEach((b, i) => facade[cl[i]!]!.push(mirror ? [L - b.x1, L - b.x0] : [b.x0, b.x1]));
  let best = { score: 0, levelOf: Array.from({ length: nCl }, (_, k) => ranks[k] ?? k) };
  const offsets = Math.max(1, ranks.length - nCl + 1);
  for (let off = 0; off < offsets; off++) {
    let I = 0;
    let U = 0;
    const levelOf: number[] = [];
    for (let k = 0; k < nCl; k++) {
      const rank = ranks[off + k];
      const f = mergeIv(facade[k]!);
      const p = rank === undefined ? [] : mergeIv(plan.get(rank) ?? []);
      levelOf.push(rank ?? k);
      const inter = ivIntersection(f, p);
      I += inter;
      U += ivLength(f) + ivLength(p) - inter;
    }
    // Niveaux du plan non vus en façade (au-dessus ou en dessous) : leurs baies comptent dans l'union.
    const s = U > 0 ? I / U : 0;
    if (s > best.score) best = { score: s, levelOf };
  }
  return best;
}

export function matchElevationToSides(bays: readonly ElevationBay[], widthM: number, plans: readonly PlanForSides[], groups: readonly SideGroup[]): SideMatch[] {
  const cl = levelClusters(bays);
  const ranks = [...new Set(plans.filter((p) => p.bays.length > 0).map((p) => p.rank))].sort((a, b) => a - b);
  const scored: { group: SideGroup; score: number; mirrored: boolean; levelOf: number[] }[] = [];
  for (const g of groups) {
    if (Math.abs(g.lengthM / widthM - 1) > 0.03) continue;
    const plan = planIntervals(plans, g);
    for (const mirror of [false, true]) {
      const s = scoreSide(bays, cl, plan, ranks, g.lengthM, mirror);
      scored.push({ group: g, score: s.score, mirrored: mirror, levelOf: s.levelOf });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s, i) => {
    const next = scored.slice(i + 1).find((o) => o.group !== s.group);
    return { ...s, margin: s.score - (next?.score ?? 0) };
  });
}

/** Azimut géographique de la normale d'une façade nommée par son orientation ; null pour avant / arrière / côté. */
export function namedAzimuth(sides: readonly ElevationSide[] | null): number | null {
  if (!sides) return null;
  for (const s of sides) {
    if (s === 'north') return 0;
    if (s === 'east') return 90;
    if (s === 'south') return 180;
    if (s === 'west') return 270;
  }
  return null;
}
