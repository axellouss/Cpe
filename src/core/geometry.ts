/**
 * Géométrie plane de base. Repère : x à droite, y vers le BAS (voir core/types.ts).
 * Toutes les fonctions sont pures et sans dépendance.
 */
import type { BBox, Orientation, Vec2 } from './types';
import { ORIENTATIONS } from './types';

export const EPS = 1e-9;

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normalize(a: Vec2): Vec2 {
  const l = length(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Ramène un angle en degrés dans [0, 360). */
export function normDeg(a: number): number {
  const r = a % 360;
  return r < 0 ? r + 360 : r;
}

export function degToRad(a: number): number {
  return (a * Math.PI) / 180;
}

export function radToDeg(a: number): number {
  return (a * 180) / Math.PI;
}

/** Arrondi à `digits` décimales (2 par défaut = centimètre pour des mètres). */
export function round(value: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round((value + Number.EPSILON) * k) / k;
}

// ───────────────────────────── Polygones ─────────────────────────────

/**
 * Aire signée (formule du lacet). Dans le repère y-vers-le-bas, une aire POSITIVE correspond à un polygone
 * parcouru dans le sens horaire à l'écran.
 */
export function signedArea(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function polygonArea(poly: readonly Vec2[]): number {
  return Math.abs(signedArea(poly));
}

export function polygonPerimeter(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += distance(poly[i]!, poly[(i + 1) % poly.length]!);
  return s;
}

export function edgeEnds(poly: readonly Vec2[], i: number): [Vec2, Vec2] {
  return [poly[i]!, poly[(i + 1) % poly.length]!];
}

export function edgeLength(poly: readonly Vec2[], i: number): number {
  const [a, b] = edgeEnds(poly, i);
  return distance(a, b);
}

/** Normale unitaire de l'arête i dirigée vers l'EXTÉRIEUR du polygone (quel que soit son sens de parcours). */
export function edgeOutwardNormal(poly: readonly Vec2[], i: number): Vec2 {
  const [a, b] = edgeEnds(poly, i);
  const d = normalize(sub(b, a));
  // Pour une aire signée positive (horaire à l'écran), l'extérieur est à gauche du sens de parcours : (dy, -dx).
  const n = { x: d.y, y: -d.x };
  return signedArea(poly) >= 0 ? n : { x: -n.x, y: -n.y };
}

export function centroid(poly: readonly Vec2[]): Vec2 {
  const a = signedArea(poly);
  if (Math.abs(a) < EPS) {
    // Polygone dégénéré : moyenne des sommets.
    let x = 0;
    let y = 0;
    for (const p of poly) {
      x += p.x;
      y += p.y;
    }
    const n = Math.max(1, poly.length);
    return { x: x / n, y: y / n };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function bboxOf(points: readonly Vec2[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    const crosses = a.y > p.y !== b.y > p.y;
    if (crosses && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Point du segment [a, b] le plus proche de p, avec son paramètre t ∈ [0, 1]. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; distance: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < EPS ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  const point = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { point, t, distance: distance(p, point) };
}

/** Indice de l'arête du polygone la plus proche de p. */
export function nearestEdge(p: Vec2, poly: readonly Vec2[]): { index: number; t: number; distance: number } | null {
  let best: { index: number; t: number; distance: number } | null = null;
  for (let i = 0; i < poly.length; i++) {
    const [a, b] = edgeEnds(poly, i);
    const c = closestOnSegment(p, a, b);
    if (!best || c.distance < best.distance) best = { index: i, t: c.t, distance: c.distance };
  }
  return best;
}

function segmentsProperlyIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  return d1 * d2 < -EPS && d3 * d4 < -EPS;
}

/** Vrai si deux arêtes non adjacentes du polygone se croisent. */
export function isSelfIntersecting(poly: readonly Vec2[]): boolean {
  const n = poly.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const [a, b] = edgeEnds(poly, i);
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const [c, d] = edgeEnds(poly, j);
      if (segmentsProperlyIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Supprime les sommets doublons et les sommets alignés (tolérance en unités du polygone). */
export function cleanPolygon(poly: readonly Vec2[], tol = 1e-6): Vec2[] {
  const dedup: Vec2[] = [];
  for (const p of poly) {
    const last = dedup[dedup.length - 1];
    if (!last || distance(last, p) > tol) dedup.push({ x: p.x, y: p.y });
  }
  while (dedup.length > 1 && distance(dedup[0]!, dedup[dedup.length - 1]!) <= tol) dedup.pop();
  if (dedup.length < 3) return dedup;
  const out: Vec2[] = [];
  const n = dedup.length;
  for (let i = 0; i < n; i++) {
    const prev = dedup[(i - 1 + n) % n]!;
    const cur = dedup[i]!;
    const next = dedup[(i + 1) % n]!;
    const area2 = Math.abs(cross(sub(cur, prev), sub(next, cur)));
    const base = distance(prev, next);
    // Distance de `cur` à la droite (prev, next).
    const h = base < EPS ? distance(prev, cur) : area2 / base;
    if (h > tol) out.push(cur);
  }
  return out.length >= 3 ? out : dedup;
}

export function scalePolygon(poly: readonly Vec2[], k: number): Vec2[] {
  return poly.map((p) => ({ x: p.x * k, y: p.y * k }));
}

/**
 * Étendue d'un polygone le long d'une direction (angle en degrés depuis +x, dans le repère de la feuille)
 * et perpendiculairement à celle-ci.
 */
export function extentAlong(poly: readonly Vec2[], angleDeg: number): { along: number; across: number } {
  const a = degToRad(angleDeg);
  const u = { x: Math.cos(a), y: Math.sin(a) };
  const v = { x: -u.y, y: u.x };
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of poly) {
    const pu = dot(p, u);
    const pv = dot(p, v);
    if (pu < minU) minU = pu;
    if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv;
    if (pv > maxV) maxV = pv;
  }
  if (!Number.isFinite(minU)) return { along: 0, across: 0 };
  return { along: maxU - minU, across: maxV - minV };
}

/** Angle (degrés depuis +x, dans [0, 180)) de la plus longue arête du polygone. */
export function longestEdgeAngle(poly: readonly Vec2[]): number {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < poly.length; i++) {
    const [a, b] = edgeEnds(poly, i);
    const l = distance(a, b);
    if (l > bestLen) {
      bestLen = l;
      best = radToDeg(Math.atan2(b.y - a.y, b.x - a.x));
    }
  }
  const r = best % 180;
  return r < 0 ? r + 180 : r;
}

// ───────────────────────────── Orientation ─────────────────────────────

/**
 * Azimut (0 = N, 90 = E) d'un vecteur du plan (repère y-vers-le-bas).
 * `northAngle` = azimut vers lequel pointe le haut de la feuille.
 */
export function azimuthOfVector(v: Vec2, northAngle: number): number {
  // Haut de la feuille = (0, -1). Angle horaire depuis le haut : atan2(x, -y).
  return normDeg(radToDeg(Math.atan2(v.x, -v.y)) + northAngle);
}

/** Secteur parmi les 8 de LuxEeB-Tool (N couvre [337,5° ; 22,5°[, etc.). */
export function sectorOfAzimuth(azimuth: number): Orientation {
  // Arrondi au millionième de degré : deux façades parallèles ne doivent pas tomber dans deux secteurs pour une
  // poussière numérique quand elles sont pile sur une limite (202,49999999999997 contre 202,5).
  const idx = Math.floor(normDeg(Math.round(azimuth * 1e6) / 1e6 + 22.5) / 45) % 8;
  return ORIENTATIONS[idx]!;
}

/** Azimut central d'un secteur. */
export function azimuthOfSector(o: Orientation): number {
  return ORIENTATIONS.indexOf(o) * 45;
}

/** Orientation de la façade portée par l'arête i (direction de sa normale extérieure). */
export function edgeAzimuth(poly: readonly Vec2[], i: number, northAngle: number): number {
  return azimuthOfVector(edgeOutwardNormal(poly, i), northAngle);
}

export function edgeOrientation(poly: readonly Vec2[], i: number, northAngle: number): Orientation {
  return sectorOfAzimuth(edgeAzimuth(poly, i, northAngle));
}

/**
 * Écart (degrés, 0..22,5) entre un azimut et la limite de secteur la plus proche.
 * Petit écart = orientation « à cheval » sur deux secteurs → à signaler à l'expert.
 */
export function marginToSectorBoundary(azimuth: number): number {
  const m = normDeg(azimuth + 22.5) % 45;
  return Math.min(m, 45 - m);
}
