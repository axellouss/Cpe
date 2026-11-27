/**
 * Opérations d'édition du contour d'un étage et tenue des arêtes / ouvertures / pièces (logique pure, immuable).
 *
 * Règles :
 *  - `storey.edges` a toujours la même longueur que `storey.outline` (arête i : outline[i] → outline[i+1]).
 *  - Une arête qui subsiste garde ses propriétés et ses ouvertures (« par identité »), même si ses extrémités bougent.
 *  - Une arête NOUVELLE (tracé, sommet supprimé hors alignement) donne sur l'extérieur : c'est l'hypothèse prudente.
 *  - Couper une arête (insérer un sommet) donne deux moitiés du MÊME mur : elles héritent toutes deux de ses
 *    propriétés et les ouvertures restent à leur place physique.
 *  - Les ouvertures portées par une arête qui disparaît sont supprimées.
 */
import type { Boundary, Opening, Room, Storey, StoreyEdge, Vec2 } from '../../core/types';

export const BOUNDARY_CYCLE: readonly Boundary[] = ['outside', 'heated', 'unheated', 'ground'];

export function nextBoundary(b: Boundary): Boundary {
  const i = BOUNDARY_CYCLE.indexOf(b);
  return BOUNDARY_CYCLE[(i + 1) % BOUNDARY_CYCLE.length]!;
}

export function newEdge(): StoreyEdge {
  return { boundary: 'outside', constructionId: null };
}

/** Arêtes alignées sur le contour : complète par des arêtes « extérieur » ou tronque si les longueurs diffèrent. */
export function syncedEdges(storey: Pick<Storey, 'outline' | 'edges'>): StoreyEdge[] {
  const out: StoreyEdge[] = [];
  for (let i = 0; i < storey.outline.length; i++) out.push(storey.edges[i] ?? newEdge());
  return out;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Paramètre (0..1) de la projection de p sur le segment [a, b]. */
function paramOn(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  return l2 < 1e-18 ? 0 : clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2);
}

/** Retire les points consécutifs confondus (y compris un point de fermeture répété). Les points alignés sont GARDÉS. */
export function dedupeOutline(points: readonly Vec2[], tol = 1e-9): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > tol) out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1 && dist(out[0]!, out[out.length - 1]!) <= tol) out.pop();
  return out;
}

/** Point de l'arête i au paramètre t. */
export function pointOnEdge(outline: readonly Vec2[], edgeIndex: number, t: number): Vec2 {
  const a = outline[edgeIndex]!;
  const b = outline[(edgeIndex + 1) % outline.length]!;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// ───────────────────────────── Sommets ─────────────────────────────

/** Déplace un sommet. Arêtes et ouvertures inchangées (les positions d'ouvertures sont relatives à l'arête). */
export function moveVertex(storey: Storey, index: number, to: Vec2): Storey {
  if (index < 0 || index >= storey.outline.length) return storey;
  const outline = storey.outline.map((p, i) => (i === index ? { x: to.x, y: to.y } : p));
  return { ...storey, outline, edges: syncedEdges(storey) };
}

/**
 * Insère un sommet sur l'arête `edgeIndex` (au milieu par défaut). Le nouveau sommet prend l'indice edgeIndex + 1.
 * Les deux moitiés héritent de l'arête coupée ; ses ouvertures sont réparties selon leur position.
 */
export function insertVertex(storey: Storey, edgeIndex: number, point?: Vec2): Storey {
  const n = storey.outline.length;
  if (n < 2 || edgeIndex < 0 || edgeIndex >= n) return storey;
  const a = storey.outline[edgeIndex]!;
  const b = storey.outline[(edgeIndex + 1) % n]!;
  const p = point ?? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const t = Math.min(0.999, Math.max(0.001, point ? paramOn(p, a, b) : 0.5));
  const edges = syncedEdges(storey);
  const parent = edges[edgeIndex]!;
  const outline = [...storey.outline.slice(0, edgeIndex + 1), { x: p.x, y: p.y }, ...storey.outline.slice(edgeIndex + 1)];
  const nextEdges = [...edges.slice(0, edgeIndex + 1), { ...parent }, ...edges.slice(edgeIndex + 1)];
  const openings = storey.openings.map((o): Opening => {
    if (o.edgeIndex > edgeIndex) return { ...o, edgeIndex: o.edgeIndex + 1 };
    if (o.edgeIndex < edgeIndex) return o;
    return o.position <= t
      ? { ...o, position: clamp01(o.position / t) }
      : { ...o, edgeIndex: edgeIndex + 1, position: clamp01((o.position - t) / (1 - t)) };
  });
  return { ...storey, outline, edges: nextEdges, openings };
}

/** Vrai si b est (presque) sur le segment [a, c] : supprimer b ne change pas le mur. */
export function isCollinear(a: Vec2, b: Vec2, c: Vec2, ratio = 0.005): boolean {
  const base = dist(a, c);
  if (base < 1e-12) return false;
  const h = Math.abs((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / base;
  const t = ((b.x - a.x) * (c.x - a.x) + (b.y - a.y) * (c.y - a.y)) / (base * base);
  return h <= ratio * base && t > 0 && t < 1;
}

/**
 * Supprime un sommet (il doit en rester au moins 3). Les deux arêtes voisines fusionnent :
 *  - sommet aligné (même mur) : l'arête fusionnée garde les propriétés du plus long morceau et toutes les ouvertures ;
 *  - sinon : c'est une arête nouvelle (extérieur) et les ouvertures des deux arêtes disparues sont supprimées.
 */
export function deleteVertex(storey: Storey, index: number): Storey {
  const n = storey.outline.length;
  if (n <= 3 || index < 0 || index >= n) return storey;
  const prevEdge = (index - 1 + n) % n;
  const a = storey.outline[prevEdge]!;
  const b = storey.outline[index]!;
  const c = storey.outline[(index + 1) % n]!;
  const edges = syncedEdges(storey);
  const collinear = isCollinear(a, b, c);
  const mergedIndex = prevEdge < index ? prevEdge : prevEdge - 1;

  const outline = storey.outline.filter((_, i) => i !== index);
  const nextEdges = edges.filter((_, i) => i !== index);
  if (collinear) {
    const keepPrev = dist(a, b) >= dist(b, c);
    nextEdges[mergedIndex] = { ...(keepPrev ? edges[prevEdge]! : edges[index]!) };
  } else {
    nextEdges[mergedIndex] = newEdge();
  }

  const openings: Opening[] = [];
  for (const o of storey.openings) {
    if (o.edgeIndex === prevEdge || o.edgeIndex === index) {
      if (!collinear) continue;
      const [p, q] = o.edgeIndex === prevEdge ? [a, b] : [b, c];
      const at = { x: p.x + (q.x - p.x) * o.position, y: p.y + (q.y - p.y) * o.position };
      openings.push({ ...o, edgeIndex: mergedIndex, position: paramOn(at, a, c) });
    } else {
      openings.push(o.edgeIndex > index ? { ...o, edgeIndex: o.edgeIndex - 1 } : o);
    }
  }
  return { ...storey, outline, edges: nextEdges, openings };
}

// ───────────────────────────── Longueur d'un côté ─────────────────────────────

/** Sinus de l'angle en dessous duquel deux directions sont « le même mur » (≈ 0,3°). */
const SAME_WALL = 0.005;

function cross2(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

function dot2(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * Donne au côté `index` (points[index] → point suivant) la longueur voulue, en unités de feuille.
 * Son premier sommet reste en place, le suivant GLISSE LE LONG DU CÔTÉ.
 *
 *  - Tracé ouvert (`closed` = faux) : tous les points suivants sont décalés d'autant — la suite du tracé garde
 *    ses directions et ses longueurs.
 *  - Contour fermé : pour que les angles tiennent (une maison reste d'équerre), le mur qui part du sommet déplacé
 *    glisse parallèlement à lui-même ; son autre bout suit la droite du côté d'après. Les sommets alignés sur ce
 *    mur (mur coupé en deux pour distinguer « extérieur » et « mitoyen ») glissent avec lui.
 *    Un triangle n'a pas de côté à faire glisser, et un sommet aligné sur son propre mur glisse seul.
 *
 * null si la longueur est illisible (≤ 0), le côté dégénéré, ou si le contour se replierait (côté voisin inversé).
 */
export function resizeSide(points: readonly Vec2[], index: number, length: number, closed: boolean): Vec2[] | null {
  const n = points.length;
  if (!(length > 0) || !Number.isFinite(length) || !Number.isInteger(index) || index < 0) return null;
  if (closed ? n < 3 || index >= n : index >= n - 1) return null;
  const at = (k: number): number => ((k % n) + n) % n;
  const a = points[index]!;
  const j = at(index + 1);
  const b = points[j]!;
  const len = dist(a, b);
  if (len < 1e-12) return null;
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const moved = { x: a.x + u.x * length, y: a.y + u.y * length };
  const delta = { x: moved.x - b.x, y: moved.y - b.y };
  const out = points.map((p) => ({ x: p.x, y: p.y }));
  out[j] = moved;

  if (!closed) {
    for (let k = j + 1; k < n; k++) out[k] = { x: points[k]!.x + delta.x, y: points[k]!.y + delta.y };
    return out;
  }
  if (n === 3) return out;

  // Le mur qui part du sommet déplacé.
  const c = points[at(j + 1)]!;
  const v = { x: c.x - b.x, y: c.y - b.y };
  const vl = Math.hypot(v.x, v.y);
  if (vl < 1e-12) return out;
  if (Math.abs(cross2(u, v)) <= SAME_WALL * vl) {
    // Sommet aligné sur son propre mur : il glisse seul, sans dépasser le sommet suivant.
    if (dot2(u, v) > 0 && dot2({ x: c.x - moved.x, y: c.y - moved.y }, u) <= 1e-9 * vl) return null;
    return out;
  }

  // Dernier sommet de ce mur (e) : on saute les sommets alignés. f = sommet d'après, qui ne bouge pas.
  let e = at(j + 1);
  while (at(e + 1) !== index) {
    const p = points[e]!;
    const q = points[at(e + 1)]!;
    const d = { x: q.x - p.x, y: q.y - p.y };
    const dl = Math.hypot(d.x, d.y);
    if (dl > 1e-12 && (Math.abs(cross2(v, d)) > SAME_WALL * vl * dl || dot2(v, d) < 0)) break;
    e = at(e + 1);
  }
  const end = points[e]!;
  const fixed = points[at(e + 1)]!;
  const w = { x: end.x - fixed.x, y: end.y - fixed.y };
  const wl = Math.hypot(w.x, w.y);
  const denom = cross2(w, v);
  // Pas de droite sur laquelle faire glisser le bout du mur : seul le sommet bouge.
  if (wl < 1e-12 || Math.abs(denom) <= 1e-9 * wl * vl) return out;

  // Nouveau bout du mur : intersection de la parallèle passant par le sommet déplacé et de la droite (fixed, end).
  const t = cross2({ x: moved.x - fixed.x, y: moved.y - fixed.y }, v) / denom;
  if (!(t > 1e-6)) return null;
  const newEnd = { x: fixed.x + w.x * t, y: fixed.y + w.y * t };
  const span = { x: newEnd.x - moved.x, y: newEnd.y - moved.y };
  if (!(dot2(span, v) > 1e-9 * vl * vl)) return null;
  const whole = dot2({ x: end.x - b.x, y: end.y - b.y }, v);
  for (let q = at(j + 1); q !== e; q = at(q + 1)) {
    const p = points[q]!;
    const s = whole > 0 ? dot2({ x: p.x - b.x, y: p.y - b.y }, v) / whole : 0;
    out[q] = { x: moved.x + span.x * s, y: moved.y + span.y * s };
  }
  out[e] = newEnd;
  return out;
}

/**
 * Longueur exacte (m) saisie pour le côté `edgeIndex` du contour (voir `resizeSide`). Les arêtes gardent leurs
 * propriétés et leurs ouvertures : aucune n'est créée ni supprimée, seules leurs extrémités bougent.
 * Renvoie l'étage inchangé si la longueur est impossible.
 */
export function setEdgeLength(storey: Storey, edgeIndex: number, metres: number): Storey {
  const mpu = storey.metresPerUnit.value;
  if (!(mpu > 0) || storey.outline.length < 3) return storey;
  const outline = resizeSide(storey.outline, edgeIndex, metres / mpu, true);
  return outline ? { ...storey, outline, edges: syncedEdges(storey) } : storey;
}

// ───────────────────────────── Contour entier ─────────────────────────────

/**
 * Remplace le contour (nouveau tracé). Une arête du nouveau contour qui relie les deux mêmes points qu'une ancienne
 * (dans un sens ou dans l'autre) est la même arête : elle garde propriétés et ouvertures. Les autres sont nouvelles.
 */
export function replaceOutline(storey: Storey, points: readonly Vec2[]): Storey {
  const outline = dedupeOutline(points);
  const old = storey.outline;
  const oldEdges = syncedEdges(storey);
  let extent = 0;
  for (const p of [...old, ...outline]) extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
  const tol = Math.max(extent * 1e-7, 1e-9);

  const used = new Array<boolean>(old.length).fill(false);
  /** Pour chaque ancienne arête : nouvelle arête correspondante et sens. */
  const mapping = new Map<number, { to: number; reversed: boolean }>();
  const edges: StoreyEdge[] = [];
  for (let j = 0; j < outline.length; j++) {
    const p = outline[j]!;
    const q = outline[(j + 1) % outline.length]!;
    let match: StoreyEdge | null = null;
    for (let k = 0; k < old.length && !match; k++) {
      if (used[k]) continue;
      const a = old[k]!;
      const b = old[(k + 1) % old.length]!;
      const same = dist(a, p) <= tol && dist(b, q) <= tol;
      const reversed = dist(a, q) <= tol && dist(b, p) <= tol;
      if (same || reversed) {
        used[k] = true;
        mapping.set(k, { to: j, reversed: !same });
        match = oldEdges[k]!;
      }
    }
    edges.push(match ? { ...match } : newEdge());
  }

  const openings: Opening[] = [];
  for (const o of storey.openings) {
    const m = mapping.get(o.edgeIndex);
    if (!m) continue;
    openings.push({ ...o, edgeIndex: m.to, position: m.reversed ? 1 - o.position : o.position });
  }
  return { ...storey, outline, edges, openings };
}

// ───────────────────────────── Arêtes ─────────────────────────────

/** Change ce qu'il y a derrière une façade. Le type de mur choisi ne vaut plus : retour au type par défaut. */
export function setBoundary(storey: Storey, edgeIndex: number, boundary: Boundary): Storey {
  const edges = syncedEdges(storey);
  const current = edges[edgeIndex];
  if (!current || current.boundary === boundary) return storey;
  edges[edgeIndex] = { boundary, constructionId: null };
  return { ...storey, edges };
}

// ───────────────────────────── Ouvertures ─────────────────────────────

/** Identifiant libre « <étage>-oN ». */
export function nextOpeningId(storey: Storey): string {
  let max = 0;
  const re = /-o(\d+)$/;
  for (const o of storey.openings) {
    const m = re.exec(o.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const taken = new Set(storey.openings.map((o) => o.id));
  let n = Math.max(max, storey.openings.length) + 1;
  while (taken.has(`${storey.id}-o${n}`)) n++;
  return `${storey.id}-o${n}`;
}

export type OpeningDraft = Omit<Opening, 'id' | 'from'>;

/** Ajoute une ouverture saisie par l'expert. */
export function addOpening(storey: Storey, draft: OpeningDraft): Storey {
  const opening: Opening = { ...draft, id: nextOpeningId(storey), position: clamp01(draft.position), from: 'user' };
  return { ...storey, openings: [...storey.openings, opening] };
}

/** Modifie une ouverture : l'expert l'a vue et validée, sa provenance devient 'user'. */
export function updateOpening(storey: Storey, id: string, patch: Partial<OpeningDraft>): Storey {
  if (!storey.openings.some((o) => o.id === id)) return storey;
  return {
    ...storey,
    openings: storey.openings.map((o): Opening => (o.id === id ? { ...o, ...patch, id: o.id, from: 'user' } : o)),
  };
}

export function removeOpening(storey: Storey, id: string): Storey {
  if (!storey.openings.some((o) => o.id === id)) return storey;
  return { ...storey, openings: storey.openings.filter((o) => o.id !== id) };
}

// ───────────────────────────── Pièces ─────────────────────────────

/** Bascule « comptée dans An » ; l'expert a tranché, la pièce n'est plus « à revoir ». */
export function toggleRoom(storey: Storey, roomId: string): Storey {
  if (!storey.rooms.some((r) => r.id === roomId)) return storey;
  return {
    ...storey,
    rooms: storey.rooms.map((r): Room => (r.id === roomId ? { ...r, heated: !r.heated, needsReview: false } : r)),
  };
}

export function roomsToReview(storey: Pick<Storey, 'rooms'>): number {
  return storey.rooms.filter((r) => r.needsReview).length;
}
