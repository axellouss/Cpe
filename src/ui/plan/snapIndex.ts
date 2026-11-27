/**
 * Index spatial (grille régulière) des traits d'une feuille, pour l'accrochage et le dessin par zone visible.
 * Logique pure. Conçu pour 150 000 traits et plus : tableaux typés, structure « CSR » (début de case + éléments),
 * aucune allocation par requête hormis le résultat.
 *
 * Les traits sont ceux de `PlanSheet.segments` : [x1, y1, x2, y2, …] en unités de feuille.
 */
import type { BBox, Vec2 } from '../../core/types';

export interface SnapIndex {
  readonly segments: Float32Array;
  /** Nombre de traits. */
  readonly count: number;
  readonly bbox: BBox;
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** Pour la case c : ses traits sont cellItems[cellStart[c] .. cellStart[c + 1]). */
  readonly cellStart: Uint32Array;
  readonly cellItems: Uint32Array;
  /** Marquage anti-doublon des requêtes (un trait long occupe plusieurs cases). */
  readonly stamps: Uint32Array;
  stamp: number;
}

export interface IndexOptions {
  /** Nombre moyen de traits visé par case. */
  perCell?: number;
  /** Nombre maximal de cases par côté. */
  maxSide?: number;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Parcourt exactement les cases traversées par un trait (colonne par colonne). */
function forEachCellOfSegment(
  gx1: number,
  gy1: number,
  gx2: number,
  gy2: number,
  cols: number,
  rows: number,
  visit: (cell: number) => void,
): void {
  if (gx1 > gx2) {
    const tx = gx1;
    gx1 = gx2;
    gx2 = tx;
    const ty = gy1;
    gy1 = gy2;
    gy2 = ty;
  }
  const cxa = clampInt(Math.floor(gx1), 0, cols - 1);
  const cxb = clampInt(Math.floor(gx2), 0, cols - 1);
  const dx = gx2 - gx1;
  for (let cx = cxa; cx <= cxb; cx++) {
    let ya = gy1;
    let yb = gy2;
    if (cxa !== cxb && dx > 0) {
      const xs = Math.max(gx1, cx);
      const xe = Math.min(gx2, cx + 1);
      ya = gy1 + ((xs - gx1) / dx) * (gy2 - gy1);
      yb = gy1 + ((xe - gx1) / dx) * (gy2 - gy1);
    }
    const r0 = clampInt(Math.floor(Math.min(ya, yb)), 0, rows - 1);
    const r1 = clampInt(Math.floor(Math.max(ya, yb)), 0, rows - 1);
    for (let cy = r0; cy <= r1; cy++) visit(cy * cols + cx);
  }
}

export function buildSnapIndex(segments: Float32Array, options: IndexOptions = {}): SnapIndex {
  const count = Math.floor(segments.length / 4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count * 4; i += 2) {
    const x = segments[i]!;
    const y = segments[i + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  const perCell = options.perCell ?? 6;
  const maxSide = options.maxSide ?? 512;
  const wanted = Math.max(1, count / perCell);
  // Cases carrées : cellSize² × nombre de cases ≈ w × h.
  let cellSize = Math.sqrt((w * h) / wanted);
  cellSize = Math.max(cellSize, Math.max(w, h) / maxSide, 1e-9);
  const cols = clampInt(Math.ceil(w / cellSize), 1, maxSide);
  const rows = clampInt(Math.ceil(h / cellSize), 1, maxSide);

  const usable = (i: number): boolean => {
    const o = i * 4;
    return (
      Number.isFinite(segments[o]!) &&
      Number.isFinite(segments[o + 1]!) &&
      Number.isFinite(segments[o + 2]!) &&
      Number.isFinite(segments[o + 3]!)
    );
  };

  // Passe 1 : compter. Passe 2 : remplir.
  const counts = new Uint32Array(cols * rows + 1);
  for (let i = 0; i < count; i++) {
    if (!usable(i)) continue;
    const o = i * 4;
    forEachCellOfSegment(
      (segments[o]! - minX) / cellSize,
      (segments[o + 1]! - minY) / cellSize,
      (segments[o + 2]! - minX) / cellSize,
      (segments[o + 3]! - minY) / cellSize,
      cols,
      rows,
      (c) => {
        counts[c + 1] = counts[c + 1]! + 1;
      },
    );
  }
  for (let c = 0; c < cols * rows; c++) counts[c + 1] = counts[c + 1]! + counts[c]!;
  const cellStart = counts;
  const cellItems = new Uint32Array(cellStart[cols * rows]!);
  const cursor = cellStart.slice(0, cols * rows);
  for (let i = 0; i < count; i++) {
    if (!usable(i)) continue;
    const o = i * 4;
    forEachCellOfSegment(
      (segments[o]! - minX) / cellSize,
      (segments[o + 1]! - minY) / cellSize,
      (segments[o + 2]! - minX) / cellSize,
      (segments[o + 3]! - minY) / cellSize,
      cols,
      rows,
      (c) => {
        cellItems[cursor[c]!] = i;
        cursor[c] = cursor[c]! + 1;
      },
    );
  }

  return {
    segments,
    count,
    bbox: { minX, minY, maxX, maxY },
    cellSize,
    cols,
    rows,
    cellStart,
    cellItems,
    stamps: new Uint32Array(count),
    stamp: 0,
  };
}

function nextStamp(index: SnapIndex): number {
  index.stamp += 1;
  if (index.stamp >= 0xffffffff) {
    index.stamps.fill(0);
    index.stamp = 1;
  }
  return index.stamp;
}

/** Appelle `visit` une fois pour chaque trait dont une case touche le rectangle. */
export function forEachSegmentInBBox(index: SnapIndex, box: BBox, visit: (segment: number) => void): void {
  if (index.count === 0) return;
  const { bbox, cellSize, cols, rows } = index;
  if (box.maxX < bbox.minX || box.minX > bbox.maxX || box.maxY < bbox.minY || box.minY > bbox.maxY) return;
  const c0 = clampInt(Math.floor((box.minX - bbox.minX) / cellSize), 0, cols - 1);
  const c1 = clampInt(Math.floor((box.maxX - bbox.minX) / cellSize), 0, cols - 1);
  const r0 = clampInt(Math.floor((box.minY - bbox.minY) / cellSize), 0, rows - 1);
  const r1 = clampInt(Math.floor((box.maxY - bbox.minY) / cellSize), 0, rows - 1);
  const stamp = nextStamp(index);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = r * cols + c;
      const end = index.cellStart[cell + 1]!;
      for (let k = index.cellStart[cell]!; k < end; k++) {
        const s = index.cellItems[k]!;
        if (index.stamps[s] === stamp) continue;
        index.stamps[s] = stamp;
        visit(s);
      }
    }
  }
}

/** Part des cases de la grille couvertes par un rectangle (0..1) : sert à décider entre dessin complet et par zone. */
export function coverage(index: SnapIndex, box: BBox): number {
  const { bbox } = index;
  const w = Math.max(bbox.maxX - bbox.minX, 1e-9);
  const h = Math.max(bbox.maxY - bbox.minY, 1e-9);
  const ix = Math.max(0, Math.min(box.maxX, bbox.maxX) - Math.max(box.minX, bbox.minX));
  const iy = Math.max(0, Math.min(box.maxY, bbox.maxY) - Math.max(box.minY, bbox.minY));
  return (ix * iy) / (w * h);
}

export interface PointHit {
  point: Vec2;
  distance: number;
}

/** Extrémité de trait la plus proche de p dans le rayon donné. */
export function nearestEndpoint(index: SnapIndex, p: Vec2, radius: number): PointHit | null {
  let best: PointHit | null = null;
  let bestD2 = radius * radius;
  const seg = index.segments;
  forEachSegmentInBBox(index, { minX: p.x - radius, minY: p.y - radius, maxX: p.x + radius, maxY: p.y + radius }, (s) => {
    const o = s * 4;
    for (let e = 0; e < 2; e++) {
      const x = seg[o + e * 2]!;
      const y = seg[o + e * 2 + 1]!;
      const d2 = (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y);
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = { point: { x, y }, distance: Math.sqrt(d2) };
      }
    }
  });
  return best;
}

function closestOnSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): { x: number; y: number; d2: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = x1 + dx * t;
  const y = y1 + dy * t;
  return { x, y, d2: (px - x) * (px - x) + (py - y) * (py - y) };
}

export interface SegmentHit extends PointHit {
  segment: number;
}

/** Traits passant à moins de `radius` de p, du plus proche au plus lointain (au plus `limit`). */
export function segmentsNear(index: SnapIndex, p: Vec2, radius: number, limit = 48): SegmentHit[] {
  const hits: SegmentHit[] = [];
  const seg = index.segments;
  const r2 = radius * radius;
  forEachSegmentInBBox(index, { minX: p.x - radius, minY: p.y - radius, maxX: p.x + radius, maxY: p.y + radius }, (s) => {
    const o = s * 4;
    const c = closestOnSeg(p.x, p.y, seg[o]!, seg[o + 1]!, seg[o + 2]!, seg[o + 3]!);
    if (c.d2 <= r2) hits.push({ segment: s, point: { x: c.x, y: c.y }, distance: Math.sqrt(c.d2) });
  });
  hits.sort((a, b) => a.distance - b.distance);
  return hits.length > limit ? hits.slice(0, limit) : hits;
}

/** Point le plus proche de p SUR un trait (accrochage « sur la ligne »). */
export function nearestOnSegment(index: SnapIndex, p: Vec2, radius: number): SegmentHit | null {
  const hits = segmentsNear(index, p, radius, 1);
  return hits[0] ?? null;
}

/**
 * Intersection de deux segments, extrémités comprises (jonctions en T), avec une petite tolérance relative.
 * Renvoie null pour des segments parallèles ou disjoints.
 */
export function segmentIntersection(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): Vec2 | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  const scale = Math.hypot(rx, ry) * Math.hypot(sx, sy);
  if (scale === 0 || Math.abs(denom) < 1e-9 * scale) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  const tol = 1e-6;
  if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) return null;
  return { x: ax + rx * t, y: ay + ry * t };
}

export interface CrossingHits {
  /** Croisement le plus proche, quel qu'il soit. */
  crossing: PointHit | null;
  /**
   * « Jonction » la plus proche : croisement situé à l'extrémité d'au moins un des deux traits (angle de mur,
   * jonction en T). C'est le point qu'un dessinateur considère comme un coin, par opposition au bout libre
   * d'une hachure ou d'un tiret de cote.
   */
  junction: PointHit | null;
}

/** Croisements des traits du plan autour de p : le plus proche, et la jonction la plus proche. */
export function crossingsNear(index: SnapIndex, p: Vec2, radius: number, maxSegments = 48): CrossingHits {
  const near = segmentsNear(index, p, radius, maxSegments);
  const out: CrossingHits = { crossing: null, junction: null };
  if (near.length < 2) return out;
  const seg = index.segments;
  let bestCrossing = radius;
  let bestJunction = radius;
  for (let i = 0; i < near.length; i++) {
    const a = near[i]!.segment * 4;
    for (let j = i + 1; j < near.length; j++) {
      const b = near[j]!.segment * 4;
      const x = segmentIntersection(seg[a]!, seg[a + 1]!, seg[a + 2]!, seg[a + 3]!, seg[b]!, seg[b + 1]!, seg[b + 2]!, seg[b + 3]!);
      if (!x) continue;
      const d = Math.hypot(x.x - p.x, x.y - p.y);
      if (d > radius) continue;
      if (d <= bestCrossing) {
        bestCrossing = d;
        out.crossing = { point: x, distance: d };
      }
      if (d <= bestJunction) {
        // Tolérance : un millième de la longueur des deux traits (les lecteurs arrondissent en Float32).
        const tol = 1e-3 * (Math.hypot(seg[a + 2]! - seg[a]!, seg[a + 3]! - seg[a + 1]!) + Math.hypot(seg[b + 2]! - seg[b]!, seg[b + 3]! - seg[b + 1]!));
        const atEnd = (o: number): boolean =>
          Math.hypot(seg[o]! - x.x, seg[o + 1]! - x.y) <= tol || Math.hypot(seg[o + 2]! - x.x, seg[o + 3]! - x.y) <= tol;
        if (atEnd(a) || atEnd(b)) {
          bestJunction = d;
          out.junction = { point: x, distance: d };
        }
      }
    }
  }
  return out;
}

/** Intersection de traits du plan la plus proche de p dans le rayon donné. */
export function nearestIntersection(index: SnapIndex, p: Vec2, radius: number, maxSegments = 48): PointHit | null {
  return crossingsNear(index, p, radius, maxSegments).crossing;
}

export interface SnapCandidate extends PointHit {
  /**
   * junction : croisement situé à l'extrémité d'au moins un trait (coin de mur, jonction en T) ;
   * endpoint : bout libre d'un trait ; crossing : deux traits qui se croisent sans s'y arrêter.
   */
  kind: 'junction' | 'endpoint' | 'crossing';
}

/**
 * Tous les points remarquables des traits autour de p (dans le rayon), du plus proche au plus lointain.
 * L'appelant choisit : il peut préférer une jonction un peu plus lointaine à un bout libre tout proche.
 */
export function snapCandidates(index: SnapIndex, p: Vec2, radius: number, maxSegments = 48, limit = 64): SnapCandidate[] {
  const near = segmentsNear(index, p, radius, maxSegments);
  if (near.length === 0) return [];
  const seg = index.segments;
  const out: SnapCandidate[] = [];
  const merge = 1e-6 * Math.max(1, Math.abs(p.x), Math.abs(p.y));
  const add = (x: number, y: number, kind: SnapCandidate['kind']): void => {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d > radius) return;
    for (const c of out) {
      if (Math.abs(c.point.x - x) <= merge && Math.abs(c.point.y - y) <= merge) {
        // Même point vu deux fois : une extrémité qui est aussi un croisement est une jonction.
        if (c.kind !== kind) c.kind = 'junction';
        return;
      }
    }
    out.push({ point: { x, y }, distance: d, kind });
  };
  for (const hit of near) {
    const o = hit.segment * 4;
    add(seg[o]!, seg[o + 1]!, 'endpoint');
    add(seg[o + 2]!, seg[o + 3]!, 'endpoint');
  }
  for (let i = 0; i < near.length; i++) {
    const a = near[i]!.segment * 4;
    for (let j = i + 1; j < near.length; j++) {
      const b = near[j]!.segment * 4;
      const x = segmentIntersection(seg[a]!, seg[a + 1]!, seg[a + 2]!, seg[a + 3]!, seg[b]!, seg[b + 1]!, seg[b + 2]!, seg[b + 3]!);
      if (!x) continue;
      const tol = 1e-3 * (Math.hypot(seg[a + 2]! - seg[a]!, seg[a + 3]! - seg[a + 1]!) + Math.hypot(seg[b + 2]! - seg[b]!, seg[b + 3]! - seg[b + 1]!));
      const end = (o: number): Vec2 | null => {
        if (Math.hypot(seg[o]! - x.x, seg[o + 1]! - x.y) <= tol) return { x: seg[o]!, y: seg[o + 1]! };
        if (Math.hypot(seg[o + 2]! - x.x, seg[o + 3]! - x.y) <= tol) return { x: seg[o + 2]!, y: seg[o + 3]! };
        return null;
      };
      // Une jonction prend les coordonnées exactes de l'extrémité (pas celles, arrondies, du calcul d'intersection).
      const exact = end(a) ?? end(b);
      if (exact) add(exact.x, exact.y, 'junction');
      else add(x.x, x.y, 'crossing');
    }
  }
  // Deux extrémités confondues sans croisement calculable (traits colinéaires bout à bout) restent « endpoint ».
  out.sort((u, v) => u.distance - v.distance);
  return out.length > limit ? out.slice(0, limit) : out;
}

/**
 * Intersection d'une droite (point + direction unitaire) avec les traits voisins de p : sert à accrocher le curseur
 * à la fois sur un guide (angle droit, alignement) et sur un trait du plan.
 */
export function nearestLineCrossing(index: SnapIndex, origin: Vec2, dir: Vec2, p: Vec2, radius: number, maxSegments = 48): PointHit | null {
  const near = segmentsNear(index, p, radius, maxSegments);
  const seg = index.segments;
  let best: PointHit | null = null;
  let bestD = radius;
  for (const hit of near) {
    const o = hit.segment * 4;
    const cx = seg[o]!;
    const cy = seg[o + 1]!;
    const sx = seg[o + 2]! - cx;
    const sy = seg[o + 3]! - cy;
    const denom = dir.x * sy - dir.y * sx;
    const sl = Math.hypot(sx, sy);
    if (sl === 0 || Math.abs(denom) < 1e-6 * sl) continue; // parallèle au guide
    const u = ((cx - origin.x) * dir.y - (cy - origin.y) * dir.x) / denom;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    const x = cx + sx * u;
    const y = cy + sy * u;
    const d = Math.hypot(x - p.x, y - p.y);
    if (d <= bestD) {
      bestD = d;
      best = { point: { x, y }, distance: d };
    }
  }
  return best;
}
