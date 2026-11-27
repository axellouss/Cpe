/**
 * Proposition de « contour chauffé » à partir de l'emprise lue sur le plan.
 *
 * Les lecteurs renvoient l'emprise de TOUT le bâtiment dessiné, annexes non chauffées comprises (garage accolé…).
 * Or l'enveloppe thermique s'arrête au mur qui sépare la zone chauffée du local non chauffé : laisser le garage
 * dans le contour fausse A, Ve et les façades de 15 à 50 %. Cette fonction retire du contour les locaux que leur
 * NOM désigne comme non chauffés (heatedGuess = 'no') quand ils touchent l'extérieur, et marque les nouvelles
 * arêtes « contre un local non chauffé ».
 *
 * Géométrie : on retire le local (faces intérieures) et, pour chacune de ses faces qui longe l'extérieur, la bande
 * de mur comprise entre cette face et le contour. Le mur qui sépare le local de la zone chauffée n'est pas touché :
 * il reste du côté chauffé, comme le veulent les dimensions extérieures.
 *
 * Elle ne retire rien dans le doute : si le résultat n'est pas sain (trou, morceaux, surface incohérente, pièce
 * chauffée emportée), le local reste dans le contour et figure dans `kept` — l'expert est averti par un constat.
 */
import {
  centroid,
  closestOnSegment,
  edgeEnds,
  edgeOutwardNormal,
  isSelfIntersecting,
  pointInPolygon,
  polygonArea,
  polygonPerimeter,
} from '../core/geometry';
import type { Boundary, DetectedRoom, Opening, Room, Storey, StoreyEdge, Vec2 } from '../core/types';
import { isOutsideEnvelopeName } from '../semantics/labels';
import { subtractRegions } from './polygonOps';

/** Au-delà, ce qui sépare la face du local du contour n'est plus un mur : la face n'est pas « contre l'extérieur ». */
const MAX_WALL_M = 0.65;
/** Marge ajoutée à l'épaisseur mesurée pour franchir la face extérieure. */
const REACH_MARGIN_M = 0.01;
/** Pas d'échantillonnage le long des faces du local. */
const SAMPLE_STEP_M = 0.1;
/** Bavures plus étroites que 2 × cette valeur : supprimées. */
const CLEAN_M = 0.015;
/** Tolérance pour dire qu'une arête du résultat longe l'ancien contour. */
export const ON_OUTLINE_TOL_M = 0.02;

export interface HeatedOutlineProposal {
  /** Contour proposé, en unités de la feuille. */
  outline: Vec2[];
  /** Ce qu'il y a derrière chaque arête : 'outside' (ancien contour) ou 'unheated' (mur vers le local retiré). */
  boundaries: Boundary[];
  /** Pour chaque arête : indice de l'arête de l'emprise qu'elle longe, ou -1 (mur mis à nu). */
  sources: number[];
  /** Locaux retirés du contour, avec la surface d'emprise retirée (m², murs extérieurs compris). */
  removed: { name: string; footprint: number }[];
  /** Locaux non chauffés d'après leur nom, restés DANS le contour (au cœur du bâtiment, ou retrait douteux). */
  kept: string[];
}

/** Distance à parcourir depuis `s` dans la direction unitaire `n` pour toucher le contour (Infinity si jamais). */
function rayToOutline(s: Vec2, n: Vec2, outline: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const [p, q] = edgeEnds(outline, i);
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const det = n.x * -ey + n.y * ex;
    if (Math.abs(det) < 1e-12) continue; // parallèle
    const wx = p.x - s.x;
    const wy = p.y - s.y;
    const u = (wx * -ey + wy * ex) / det;
    const v = (n.x * wy - n.y * wx) / det;
    if (u > 1e-9 && v >= -1e-9 && v <= 1 + 1e-9 && u < best) best = u;
  }
  return best;
}

interface Run {
  t0: number;
  t1: number;
  reach: number;
}

/** Portions de la face [a, b] (normale sortante n) séparées du contour par moins de `maxWall`. */
function exteriorRuns(a: Vec2, b: Vec2, n: Vec2, outline: readonly Vec2[], maxWall: number, step: number): Run[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len <= 1e-9) return [];
  const at = (t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const dist = (t: number): number => rayToOutline(at(t), n, outline);
  const count = Math.max(2, Math.ceil(len / step));
  const ts: number[] = [];
  for (let k = 0; k <= count; k++) ts.push(k / count);
  // Les extrémités exactes tombent sur les coins : on les décale d'un cheveu vers l'intérieur de la face.
  const eps = Math.min(0.25 / count, 1e-3);
  const sample = ts.map((t) => dist(Math.min(1 - eps, Math.max(eps, t))));
  const near = sample.map((d) => d <= maxWall);
  const refine = (tNear: number, tFar: number): number => {
    let lo = tNear;
    let hi = tFar;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (dist(mid) <= maxWall) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const runs: Run[] = [];
  let k = 0;
  while (k <= count) {
    if (!near[k]) {
      k++;
      continue;
    }
    let j = k;
    let reach = sample[k]!;
    while (j + 1 <= count && near[j + 1]) {
      j++;
      reach = Math.max(reach, sample[j]!);
    }
    const t0 = k === 0 ? 0 : refine(ts[k]!, ts[k - 1]!);
    const t1 = j === count ? 1 : refine(ts[j]!, ts[j + 1]!);
    if ((t1 - t0) * len > step / 2) runs.push({ t0, t1, reach });
    k = j + 1;
  }
  return runs;
}

/** Bandes de mur à retirer avec le local : une par portion de face contre l'extérieur, plus les coins sortants. */
function wallStrips(room: readonly Vec2[], outline: readonly Vec2[], maxWall: number, step: number, margin: number): { strips: Vec2[][]; reach: number } {
  const n = room.length;
  const perEdge: Run[][] = [];
  const normals: Vec2[] = [];
  let reach = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = edgeEnds(room, i);
    const normal = edgeOutwardNormal(room, i);
    normals.push(normal);
    const runs = exteriorRuns(a, b, normal, outline, maxWall, step);
    perEdge.push(runs);
    for (const r of runs) reach = Math.max(reach, r.reach);
  }
  if (reach === 0) return { strips: [], reach: 0 };
  const depth = reach + margin;
  const strips: Vec2[][] = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = edgeEnds(room, i);
    const nv = normals[i]!;
    for (const r of perEdge[i]!) {
      const p0 = { x: a.x + (b.x - a.x) * r.t0, y: a.y + (b.y - a.y) * r.t0 };
      const p1 = { x: a.x + (b.x - a.x) * r.t1, y: a.y + (b.y - a.y) * r.t1 };
      strips.push([p0, p1, { x: p1.x + nv.x * depth, y: p1.y + nv.y * depth }, { x: p0.x + nv.x * depth, y: p0.y + nv.y * depth }]);
    }
    // Coin sortant entre cette face et la suivante, si les deux y longent l'extérieur.
    const j = (i + 1) % n;
    const endsHere = perEdge[i]!.some((r) => r.t1 >= 1 - 1e-9);
    const startsNext = perEdge[j]!.some((r) => r.t0 <= 1e-9);
    if (endsHere && startsNext) {
      const m = normals[j]!;
      const dot = nv.x * m.x + nv.y * m.y;
      const cross = nv.x * m.y - nv.y * m.x;
      if (Math.abs(cross) > 1e-6 && 1 + dot > 0.2) {
        const k = depth / (1 + dot);
        strips.push([
          b,
          { x: b.x + nv.x * depth, y: b.y + nv.y * depth },
          { x: b.x + (nv.x + m.x) * k, y: b.y + (nv.y + m.y) * k },
          { x: b.x + m.x * depth, y: b.y + m.y * depth },
        ]);
      }
    }
  }
  return { strips, reach: depth };
}

function onSegment(a: Vec2, b: Vec2, c: Vec2, tol: number): boolean {
  const cl = closestOnSegment(b, a, c);
  return cl.distance <= tol && cl.t > 0 && cl.t < 1;
}

/** Arête du nouveau contour : `source` = indice de l'arête de l'ancien contour qu'elle longe, ou -1 (mur mis à nu). */
interface Traced {
  outline: Vec2[];
  sources: number[];
}

/** Supprime les sommets confondus, puis fusionne les arêtes alignées issues de la MÊME arête d'origine. */
function tidy(points: Vec2[], sources: number[], tol: number): Traced {
  let pts = points;
  let src = sources;
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const prev = (i - 1 + pts.length) % pts.length;
      const next = (i + 1) % pts.length;
      const a = pts[prev]!;
      const b = pts[i]!;
      const c = pts[next]!;
      const zero = Math.hypot(b.x - c.x, b.y - c.y) <= tol;
      // src[prev] = arête (prev → i), src[i] = arête (i → next)
      const mergeable = src[prev] === src[i] && onSegment(a, b, c, tol);
      if (zero || mergeable) {
        // En retirant le sommet i, l'arête (prev → i) absorbe l'arête (i → next) : c'est src[i] qui disparaît.
        pts = pts.filter((_, k) => k !== i);
        src = src.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return { outline: pts, sources: src };
}

interface Stretch {
  lo: number;
  hi: number;
  source: number;
}

/**
 * Portions de l'arête [a, b] qui longent l'ancien contour, en paramètres t ∈ [0, 1], avec l'arête d'origine.
 * Une arête du résultat peut n'être sur l'ancien contour que sur une partie de sa longueur (façade prolongée
 * par le mur de refend vers le garage) : il faut alors la couper.
 */
function stretchesOnOutline(a: Vec2, b: Vec2, outline: readonly Vec2[], tol: number): Stretch[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len <= tol) return [];
  const ux = dx / len;
  const uy = dy / len;
  const found: Stretch[] = [];
  for (let i = 0; i < outline.length; i++) {
    const [p, q] = edgeEnds(outline, i);
    const offP = Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
    const offQ = Math.abs((q.x - a.x) * uy - (q.y - a.y) * ux);
    if (offP > tol || offQ > tol) continue; // pas alignée avec [a, b]
    const tp = ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
    const tq = ((q.x - a.x) * ux + (q.y - a.y) * uy) / len;
    const lo = Math.max(0, Math.min(tp, tq));
    const hi = Math.min(1, Math.max(tp, tq));
    if ((hi - lo) * len > tol) found.push({ lo, hi, source: i });
  }
  found.sort((x, y) => x.lo - y.lo);
  // Deux arêtes d'origine ne se recouvrent pas : on rogne les chevauchements dus à la tolérance.
  const clean: Stretch[] = [];
  for (const s of found) {
    const last = clean[clean.length - 1];
    const lo = last ? Math.max(s.lo, last.hi) : s.lo;
    if ((s.hi - lo) * len > tol) clean.push({ lo, hi: s.hi, source: s.source });
  }
  return clean;
}

/** Coupe chaque arête là où elle quitte l'ancien contour (ou change d'arête d'origine). */
function trace(points: readonly Vec2[], outline: readonly Vec2[], tol: number): Traced {
  const outPts: Vec2[] = [];
  const outSrc: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const [a, b] = edgeEnds(points, i);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= 1e-12) continue;
    const stretches = stretchesOnOutline(a, b, outline, tol);
    const cuts = [0];
    for (const s of stretches) {
      if (s.lo * len > tol) cuts.push(s.lo);
      if ((1 - s.hi) * len > tol) cuts.push(s.hi);
    }
    cuts.sort((x, y) => x - y);
    for (let c = 0; c < cuts.length; c++) {
      const t0 = cuts[c]!;
      const t1 = c + 1 < cuts.length ? cuts[c + 1]! : 1;
      if ((t1 - t0) * len <= tol / 4) continue;
      const mid = (t0 + t1) / 2;
      const on = stretches.find((s) => mid >= s.lo && mid <= s.hi);
      outPts.push({ x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 });
      outSrc.push(on ? on.source : -1);
    }
  }
  return { outline: outPts, sources: outSrc };
}

interface Carved extends Traced {
  removed: { name: string; footprint: number }[];
  kept: string[];
}

/**
 * Retire du contour chaque local de `targets` (polygone des faces intérieures) avec ses murs extérieurs.
 * `keep` : polygones des locaux qui doivent rester dans le contour (garde-fou).
 */
function carve(
  outline: readonly Vec2[],
  targets: readonly { name: string; polygon: readonly Vec2[] }[],
  keep: readonly (readonly Vec2[])[],
  scale: number,
): Carved | null {
  if (outline.length < 3 || !(scale > 0) || isSelfIntersecting(outline)) return null;
  let current: Vec2[] = outline.map((p) => ({ x: p.x, y: p.y }));
  const removed: { name: string; footprint: number }[] = [];
  const kept: string[] = [];

  for (const target of targets) {
    const poly = target.polygon;
    if (poly.length < 3 || !pointInPolygon(centroid(poly), current)) continue;
    const { strips, reach } = wallStrips(poly, current, MAX_WALL_M / scale, SAMPLE_STEP_M / scale, REACH_MARGIN_M / scale);
    if (strips.length === 0) {
      kept.push(target.name); // au cœur du bâtiment : le retirer creuserait un trou
      continue;
    }
    const left = subtractRegions(current, [poly, ...strips], CLEAN_M / scale);
    const main = left?.[0];
    const before = polygonArea(current);
    const roomArea = polygonArea(poly);
    const crumbs = (left ?? []).slice(1).reduce((s, p) => s + p.area, 0);
    const taken = main ? before - main.area - crumbs : 0;
    const sane =
      !!main &&
      main.holes === 0 &&
      main.outer.length >= 3 &&
      !isSelfIntersecting(main.outer) &&
      crumbs <= 0.005 * main.area &&
      taken >= 0.9 * roomArea &&
      taken <= roomArea + polygonPerimeter(poly) * reach + 4 * reach * reach &&
      keep.every((k) => pointInPolygon(centroid(k), main.outer));
    if (!sane) {
      kept.push(target.name);
      continue;
    }
    current = main.outer;
    removed.push({ name: target.name, footprint: (before - main.area) * scale * scale });
  }
  if (removed.length === 0) return kept.length > 0 ? { outline: [], sources: [], removed, kept } : null;

  const tol = ON_OUTLINE_TOL_M / scale;
  const traced = trace(current, outline, tol);
  const tidied = tidy(traced.outline, traced.sources, tol / 4);
  return { ...tidied, removed, kept };
}

/**
 * Contour chauffé proposé pour une feuille lue : l'emprise privée des locaux que leur nom désigne comme non
 * chauffés et qui touchent l'extérieur. Renvoie null s'il n'y a rien à retirer (ou pas d'échelle : les seuils
 * sont en mètres). `kept` peut être non vide alors que rien n'a été retiré : `outline` vaut alors l'emprise.
 */
export function proposeHeatedOutline(
  outline: readonly Vec2[],
  rooms: readonly DetectedRoom[],
  metresPerUnit: number | null | undefined,
): HeatedOutlineProposal | null {
  if (outline.length < 3 || !metresPerUnit || !(metresPerUnit > 0)) return null;
  const withPolygon = rooms.filter((r) => r.polygon && r.polygon.length >= 3);
  const inside = withPolygon.filter((r) => r.heatedGuess === 'no' && pointInPolygon(centroid(r.polygon!), outline));
  if (inside.length === 0) return null;
  // Seuls les locaux hors enveloppe PAR NATURE (garage, abri…) sont retirés d'office. Une chaufferie ou un local
  // technique peut être dans l'enveloppe isolée : il reste dans le contour, et c'est l'expert qui tranche.
  const targets = inside.filter((r) => isOutsideEnvelopeName(r.name)).map((r) => ({ name: r.name, polygon: r.polygon! }));
  const undecided = inside.filter((r) => !isOutsideEnvelopeName(r.name)).map((r) => r.name);
  const keep = withPolygon.filter((r) => r.heatedGuess !== 'no').map((r) => r.polygon!);
  const carved = targets.length > 0 ? carve(outline, targets, keep, metresPerUnit) : null;
  if (!carved || carved.removed.length === 0) {
    const kept = [...(carved?.kept ?? targets.map((t) => t.name)), ...undecided];
    return {
      outline: outline.map((p) => ({ x: p.x, y: p.y })),
      boundaries: outline.map((): Boundary => 'outside'),
      sources: outline.map((_, i) => i),
      removed: [],
      kept,
    };
  }
  return {
    outline: carved.outline,
    boundaries: carved.sources.map((s): Boundary => (s < 0 ? 'unheated' : 'outside')),
    sources: carved.sources,
    removed: carved.removed,
    kept: [...carved.kept, ...undecided],
  };
}

/**
 * Reporte des ouvertures posées sur un ancien contour vers le nouveau : chacune suit l'arête d'origine qui la
 * portait ; celles dont le mur a disparu (porte du garage retiré) sont abandonnées.
 */
export function remapOpenings(
  openings: readonly Opening[],
  oldOutline: readonly Vec2[],
  newOutline: readonly Vec2[],
  sources: readonly number[],
  tol: number,
): Opening[] {
  const out: Opening[] = [];
  for (const o of openings) {
    if (o.edgeIndex < 0 || o.edgeIndex >= oldOutline.length) continue;
    const [a, b] = edgeEnds(oldOutline, o.edgeIndex);
    const at = { x: a.x + (b.x - a.x) * o.position, y: a.y + (b.y - a.y) * o.position };
    let best: { index: number; t: number; distance: number } | null = null;
    for (let j = 0; j < newOutline.length; j++) {
      if (sources[j] !== o.edgeIndex) continue;
      const [p, q] = edgeEnds(newOutline, j);
      const cl = closestOnSegment(at, p, q);
      if (cl.distance <= tol && (!best || cl.distance < best.distance)) best = { index: j, t: cl.t, distance: cl.distance };
    }
    if (best) out.push({ ...o, edgeIndex: best.index, position: best.t });
  }
  return out;
}

/**
 * Retire d'un étage le local `roomId` (qui doit avoir un polygone) : nouveau contour, arêtes d'origine conservées
 * avec leur nature et leur type de mur, mur mis à nu marqué « contre un local non chauffé », ouvertures reportées
 * (celles du local retiré disparaissent), local marqué non chauffé et tranché. Renvoie null si le retrait n'est
 * pas possible proprement (local au cœur du bâtiment, sans polygone, résultat douteux).
 */
export function excludeRoomFromOutline(storey: Storey, roomId: string): Storey | null {
  const room = storey.rooms.find((r) => r.id === roomId);
  const scale = storey.metresPerUnit.value;
  if (!room || !room.polygon || room.polygon.length < 3 || storey.outline.length < 3 || !(scale > 0)) return null;
  const keep = storey.rooms
    .filter((r) => r.id !== roomId && r.polygon && r.polygon.length >= 3 && (r.heated || r.needsReview))
    .map((r) => r.polygon!);
  const carved = carve(storey.outline, [{ name: room.name, polygon: room.polygon }], keep, scale);
  if (!carved || carved.removed.length === 0) return null;
  const edges: StoreyEdge[] = carved.sources.map((s) => {
    const old = s >= 0 ? storey.edges[s] : undefined;
    return old ? { ...old } : { boundary: 'unheated', constructionId: null };
  });
  return {
    ...storey,
    outline: carved.outline,
    edges,
    openings: remapOpenings(storey.openings, storey.outline, carved.outline, carved.sources, ON_OUTLINE_TOL_M / scale),
    rooms: storey.rooms.map((r) => (r.id === roomId ? { ...r, heated: false, needsReview: false } : r)),
  };
}

/** Où se trouve un local sur la feuille : centre de son polygone, à défaut la position de son étiquette. */
export function roomAnchor(room: Pick<Room, 'polygon' | 'at'>): Vec2 | null {
  if (room.polygon && room.polygon.length >= 3) return centroid(room.polygon);
  return room.at ?? null;
}

/**
 * Locaux non comptés dans An (tranchés) qui se trouvent à l'intérieur du contour de l'étage. Un local connu par sa
 * seule étiquette (polygone non fermé sur le plan) compte aussi : on ne peut pas le retirer d'office, mais il faut
 * le signaler.
 */
export function unheatedRoomsInsideOutline(storey: Storey): Room[] {
  if (storey.outline.length < 3) return [];
  return storey.rooms.filter((r) => {
    if (r.heated || r.needsReview) return false;
    const anchor = roomAnchor(r);
    return anchor !== null && pointInPolygon(anchor, storey.outline);
  });
}

/**
 * Locaux non comptés dans An (tranchés), dessinés avec leur polygone, qui se trouvent HORS du contour de l'étage :
 * ceux que le contour chauffé a laissés dehors (garage accolé ou intégré). Le plancher d'un étage supérieur qui
 * les couvre donne sur un local non chauffé.
 */
export function unheatedRoomsBeside(storey: Storey): Room[] {
  if (storey.outline.length < 3) return [];
  return storey.rooms.filter(
    (r) => !r.heated && !r.needsReview && r.polygon && r.polygon.length >= 3 && !pointInPolygon(centroid(r.polygon), storey.outline),
  );
}

// ───────────────────────────── Contour retracé : ne rien perdre en silence ─────────────────────────────

/** Deux murs tracés à moins de cela l'un de l'autre sont le même mur (m). */
const SAME_WALL_TOL_M = 0.1;

export interface CarryOver {
  storey: Storey;
  /** Ouvertures de l'ancien contour qui n'ont trouvé aucun mur dans le nouveau. */
  lostOpenings: number;
  /** Façades qui portaient un réglage (mitoyen, terre, local non chauffé, type de mur) et n'ont pas de suite. */
  lostBoundaries: number;
}

function sameOutline(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  return a.length === b.length && a.every((p, i) => p.x === b[i]!.x && p.y === b[i]!.y);
}

function isPlainEdge(e: StoreyEdge | undefined): boolean {
  return !e || (e.boundary === 'outside' && e.constructionId === null);
}

/**
 * Après un contour RETRACÉ ou un sommet supprimé, l'éditeur ne reconnaît une façade que si ses deux extrémités
 * n'ont pas bougé : un mur redessiné à 3 cm près perdait son réglage (mitoyen, contre terre…) et ses fenêtres.
 * Cette fonction reprend, pour chaque arête du nouveau contour encore « par défaut », le réglage de l'ancienne
 * arête qu'elle recouvre (même droite à 10 cm près, sur plus de la moitié de sa longueur), et repose sur le
 * nouveau contour les ouvertures de l'ancien qui n'y figurent plus. Elle compte ce qui reste perdu, pour que
 * l'application le DISE au lieu de laisser les étapes cochées.
 */
export function carryOverFromPrevious(previous: Storey, next: Storey): CarryOver {
  const scale = next.metresPerUnit.value;
  if (previous.outline.length < 3 || next.outline.length < 3 || !(scale > 0) || sameOutline(previous.outline, next.outline)) {
    return { storey: next, lostOpenings: 0, lostBoundaries: 0 };
  }
  const tol = SAME_WALL_TOL_M / scale;

  // Arête d'origine recouverte par chaque nouvelle arête (ou -1).
  const sourceOf: number[] = next.outline.map((_, j) => {
    const [a, b] = edgeEnds(next.outline, j);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let best = -1;
    let bestCover = 0;
    for (const s of stretchesOnOutline(a, b, previous.outline, tol)) {
      const cover = (s.hi - s.lo) * len;
      if (cover > bestCover) {
        bestCover = cover;
        best = s.source;
      }
    }
    return bestCover > 0.5 * len ? best : -1;
  });

  const edges: StoreyEdge[] = next.outline.map((_, j) => {
    const mine = next.edges[j];
    const old = sourceOf[j]! >= 0 ? previous.edges[sourceOf[j]!] : undefined;
    // Un réglage posé sur le nouveau contour prime ; sinon on reprend celui de l'ancien mur.
    return !isPlainEdge(mine) || !old ? (mine ? { ...mine } : { boundary: 'outside', constructionId: null }) : { ...old };
  });

  const kept = new Set(next.openings.map((o) => o.id));
  const openings: Opening[] = next.openings.map((o) => ({ ...o }));
  let lostOpenings = 0;
  for (const o of previous.openings) {
    if (kept.has(o.id)) continue;
    if (o.edgeIndex < 0 || o.edgeIndex >= previous.outline.length) continue;
    const [a, b] = edgeEnds(previous.outline, o.edgeIndex);
    const at = { x: a.x + (b.x - a.x) * o.position, y: a.y + (b.y - a.y) * o.position };
    let best: { index: number; t: number; distance: number } | null = null;
    for (let j = 0; j < next.outline.length; j++) {
      const [p, q] = edgeEnds(next.outline, j);
      const cl = closestOnSegment(at, p, q);
      if (cl.distance <= tol && (!best || cl.distance < best.distance)) best = { index: j, t: cl.t, distance: cl.distance };
    }
    if (best) openings.push({ ...o, edgeIndex: best.index, position: best.t });
    else lostOpenings += 1;
  }

  // Réglages perdus : façades réglées avant, moins celles qui le sont encore (reprises ici ou gardées par l'éditeur).
  const settled = (list: readonly StoreyEdge[]): number => list.filter((e) => !isPlainEdge(e)).length;
  const lostBoundaries = Math.max(0, settled(previous.edges) - settled(edges));
  return { storey: { ...next, edges, openings }, lostOpenings, lostBoundaries };
}
