/**
 * Accrochage du curseur (logique pure) : extrémités et intersections des traits du plan, sommets existants,
 * guides d'angle droit / d'alignement, grille (feuille vierge).
 *
 * Ordre de priorité : point de fermeture → sommet existant ou jonction de traits → extrémité libre → croisement
 * → guides → « sur un trait » → grille.
 * Toutes les distances sont en unités de feuille ; l'appelant convertit son rayon en pixels avec l'échelle de la vue.
 */
import type { Vec2 } from '../../core/types';
import type { SnapIndex } from './snapIndex';
import { nearestLineCrossing, nearestOnSegment, snapCandidates } from './snapIndex';

export type SnapKind = 'close' | 'vertex' | 'endpoint' | 'intersection' | 'guide' | 'online' | 'grid' | 'free';

export type GuideKind =
  | 'straight' // prolonge l'arête précédente
  | 'ortho' // angle droit avec l'arête précédente (ou axe de la feuille pour le premier trait)
  | 'align'; // aligné avec un autre sommet

export interface GuideLine {
  /** Point par lequel passe le guide (un sommet). */
  origin: Vec2;
  /** Direction unitaire. */
  dir: Vec2;
  kind: GuideKind;
}

export interface SnapContext {
  index: SnapIndex | null;
  /** Rayon d'accrochage (unités de feuille). */
  radius: number;
  /** Sommets candidats (contour en cours, contour existant, autres étages). */
  vertices: readonly Vec2[];
  /** Premier point du tracé : y revenir ferme le contour. */
  closePoint?: Vec2 | null;
  guides: readonly GuideLine[];
  /** Pas de grille (feuille vierge) ; null = pas de grille. */
  gridStep: number | null;
  /** Faux = aimant coupé : seul le point de fermeture reste actif. */
  enabled: boolean;
}

export interface SnapResult {
  point: Vec2;
  kind: SnapKind;
  /** Guides sur lesquels le point retenu se trouve (à dessiner). */
  guides: GuideLine[];
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unit(v: Vec2): Vec2 | null {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-12 ? null : { x: v.x / l, y: v.y / l };
}

function perp(v: Vec2): Vec2 {
  return { x: -v.y, y: v.x };
}

/** Distance signée de p à la droite du guide. */
function offsetFromGuide(p: Vec2, g: GuideLine): number {
  return (p.x - g.origin.x) * g.dir.y - (p.y - g.origin.y) * g.dir.x;
}

export function projectOnGuide(p: Vec2, g: GuideLine): Vec2 {
  const t = (p.x - g.origin.x) * g.dir.x + (p.y - g.origin.y) * g.dir.y;
  return { x: g.origin.x + g.dir.x * t, y: g.origin.y + g.dir.y * t };
}

function guideIntersection(a: GuideLine, b: GuideLine): Vec2 | null {
  const denom = a.dir.x * b.dir.y - a.dir.y * b.dir.x;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((b.origin.x - a.origin.x) * b.dir.y - (b.origin.y - a.origin.y) * b.dir.x) / denom;
  return { x: a.origin.x + a.dir.x * t, y: a.origin.y + a.dir.y * t };
}

function sameLine(a: GuideLine, b: GuideLine, tol: number): boolean {
  const parallel = Math.abs(a.dir.x * b.dir.y - a.dir.y * b.dir.x) < 1e-6;
  return parallel && Math.abs(offsetFromGuide(b.origin, a)) < tol;
}

function pushGuide(list: GuideLine[], g: GuideLine, tol: number): void {
  if (!list.some((o) => sameLine(o, g, tol))) list.push(g);
}

const AXIS_X: Vec2 = { x: 1, y: 0 };

/** Facteur appliqué à la distance d'un point remarquable situé sur un guide actif (plus petit = plus attirant). */
const GUIDED_BONUS = 0.6;

/**
 * Guides pendant le tracé : dans l'axe et à angle droit de la dernière arête, depuis le dernier point ;
 * mêmes directions depuis les points déjà posés (pour refermer d'équerre). Premier trait : axes de la feuille.
 */
export function traceGuides(points: readonly Vec2[]): GuideLine[] {
  const n = points.length;
  if (n === 0) return [];
  const last = points[n - 1]!;
  const prev = n >= 2 ? points[n - 2]! : null;
  const d = (prev && unit({ x: last.x - prev.x, y: last.y - prev.y })) || AXIS_X;
  const tol = 1e-9;
  const guides: GuideLine[] = [];
  pushGuide(guides, { origin: last, dir: perp(d), kind: 'ortho' }, tol);
  pushGuide(guides, { origin: last, dir: d, kind: prev ? 'straight' : 'ortho' }, tol);
  // Les autres points posés, en commençant par le premier (celui qui ferme le contour).
  for (let i = 0; i < n - 1; i++) {
    const q = points[i]!;
    pushGuide(guides, { origin: q, dir: d, kind: 'align' }, tol);
    pushGuide(guides, { origin: q, dir: perp(d), kind: 'align' }, tol);
  }
  return guides;
}

/**
 * Guides pendant le déplacement du sommet i d'un contour fermé : garder d'équerre (ou dans l'axe) les arêtes
 * voisines, en s'appuyant sur les deux sommets voisins et la direction de leur autre arête.
 */
export function dragGuides(outline: readonly Vec2[], i: number): GuideLine[] {
  const n = outline.length;
  if (n < 3) return [];
  const at = (k: number): Vec2 => outline[((k % n) + n) % n]!;
  const guides: GuideLine[] = [];
  const tol = 1e-9;
  const add = (through: Vec2, from: Vec2): void => {
    const d = unit({ x: through.x - from.x, y: through.y - from.y });
    if (!d) return;
    pushGuide(guides, { origin: through, dir: perp(d), kind: 'ortho' }, tol);
    pushGuide(guides, { origin: through, dir: d, kind: 'straight' }, tol);
  };
  add(at(i - 1), at(i - 2));
  add(at(i + 1), at(i + 2));
  return guides;
}

/** Arrondit au pas de grille. */
export function snapToGrid(p: Vec2, step: number): Vec2 {
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

function onGuides(point: Vec2, guides: readonly GuideLine[], tol: number): GuideLine[] {
  return guides.filter((g) => Math.abs(offsetFromGuide(point, g)) <= tol);
}

/** Choisit le point d'accrochage pour la position p du curseur. */
export function resolveSnap(p: Vec2, ctx: SnapContext): SnapResult {
  const r = ctx.radius;
  const tiny = Math.max(r * 0.02, 1e-9);

  // 1. Fermeture du contour : toujours active, rayon un peu plus généreux.
  if (ctx.closePoint && dist(p, ctx.closePoint) <= r * 1.3) {
    return { point: { ...ctx.closePoint }, kind: 'close', guides: onGuides(ctx.closePoint, ctx.guides, tiny) };
  }
  if (!ctx.enabled) return { point: p, kind: 'free', guides: [] };

  // 2-4. Points remarquables : le plus proche gagne, avec une préférence pour les sommets existants et les
  // « jonctions » (coin de mur, jonction en T) sur les bouts libres (tiret de cote, hachure) et les simples croisements.
  let best: { point: Vec2; kind: SnapKind; score: number } | null = null;
  const consider = (point: Vec2, kind: SnapKind, weight: number): void => {
    const d = dist(p, point);
    if (d > r) return;
    // Un point remarquable qui tombe en plus sur un guide (d'équerre, aligné) est le coin recherché.
    const guided = ctx.guides.some((g) => Math.abs(offsetFromGuide(point, g)) <= tiny);
    const score = d * weight * (guided ? GUIDED_BONUS : 1);
    if (!best || score < best.score) best = { point, kind, score };
  };
  for (const v of ctx.vertices) consider(v, 'vertex', 0.75);
  if (ctx.index) {
    for (const c of snapCandidates(ctx.index, p, r)) {
      if (c.kind === 'junction') consider(c.point, 'endpoint', 0.75);
      else if (c.kind === 'endpoint') consider(c.point, 'endpoint', 1);
      else consider(c.point, 'intersection', 1.1);
    }
  }
  const found = best as { point: Vec2; kind: SnapKind; score: number } | null;
  if (found) {
    return { point: { ...found.point }, kind: found.kind, guides: onGuides(found.point, ctx.guides, tiny) };
  }

  // 5. Guides : croisement de deux guides, sinon projection sur le plus proche (puis croisement avec un trait du plan).
  const near = ctx.guides
    .map((g) => ({ g, off: Math.abs(offsetFromGuide(p, g)) }))
    .filter((c) => c.off <= r)
    .sort((a, b) => a.off - b.off);
  if (near.length > 0) {
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const x = guideIntersection(near[i]!.g, near[j]!.g);
        if (x && dist(x, p) <= r * 1.5) return { point: x, kind: 'guide', guides: onGuides(x, ctx.guides, tiny) };
      }
    }
    const g = near[0]!.g;
    let point = projectOnGuide(p, g);
    if (ctx.index) {
      const crossing = nearestLineCrossing(ctx.index, g.origin, g.dir, point, r);
      if (crossing) point = crossing.point;
    } else if (ctx.gridStep) {
      // Feuille vierge : longueur ronde le long du guide.
      const t = (point.x - g.origin.x) * g.dir.x + (point.y - g.origin.y) * g.dir.y;
      const rounded = Math.round(t / ctx.gridStep) * ctx.gridStep;
      point = { x: g.origin.x + g.dir.x * rounded, y: g.origin.y + g.dir.y * rounded };
    }
    return { point, kind: 'guide', guides: onGuides(point, ctx.guides, tiny) };
  }

  // 6. Sur un trait du plan.
  if (ctx.index) {
    const on = nearestOnSegment(ctx.index, p, r * 0.6);
    if (on) return { point: on.point, kind: 'online', guides: [] };
  }

  // 7. Grille.
  if (ctx.gridStep) return { point: snapToGrid(p, ctx.gridStep), kind: 'grid', guides: [] };
  return { point: p, kind: 'free', guides: [] };
}

/** Vrai si l'angle en `corner` entre (prev → corner) et (corner → next) est droit à `tolDeg` près. */
export function isRightAngle(prev: Vec2, corner: Vec2, next: Vec2, tolDeg = 0.5): boolean {
  const a = unit({ x: corner.x - prev.x, y: corner.y - prev.y });
  const b = unit({ x: next.x - corner.x, y: next.y - corner.y });
  if (!a || !b) return false;
  const cos = Math.abs(a.x * b.x + a.y * b.y);
  return cos <= Math.sin((tolDeg * Math.PI) / 180);
}
