/**
 * Ouvertures (fenêtres, portes) : tailles courantes, valeurs par défaut, géométrie des marques sur les façades
 * et contrôles de saisie (logique pure).
 *
 * Rappel réglementaire : les dimensions sont celles de la BAIE BRUTE du gros œuvre (« Rohbaumaß »), en mètres.
 */
import type { Opening, Vec2 } from '../../core/types';

export type OpeningKind = Opening['kind'];

/** Tailles proposées en un toucher (m). Largeurs et hauteurs de baies usuelles au Luxembourg. */
export const QUICK_SIZES: Record<OpeningKind, { widths: readonly number[]; heights: readonly number[] }> = {
  window: {
    widths: [0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 2.0, 2.4],
    heights: [0.6, 1.0, 1.2, 1.35, 1.5, 2.1, 2.25],
  },
  door: {
    widths: [0.9, 1.0, 1.1, 1.2, 2.0],
    heights: [2.0, 2.1, 2.25, 2.4],
  },
};

export const DEFAULT_SIZE: Record<OpeningKind, { width: number; height: number }> = {
  window: { width: 1.2, height: 1.35 },
  door: { width: 1.0, height: 2.1 },
};

/** Bornes de plausibilité (m) : en dehors, la saisie est refusée. */
export const OPENING_LIMITS = { minWidth: 0.2, maxWidth: 12, minHeight: 0.2, maxHeight: 6, maxCount: 50 };

export interface OpeningValues {
  kind: OpeningKind;
  width: number | null;
  height: number | null;
  count: number;
}

export type OpeningIssue = 'width' | 'height' | 'count' | 'widerThanEdge';

/**
 * Contrôle d'une saisie. 'width' / 'height' / 'count' bloquent l'enregistrement ;
 * 'widerThanEdge' est un avertissement (la somme des largeurs dépasse la façade).
 */
export function checkOpening(values: OpeningValues, edgeLengthMetres: number | null): OpeningIssue[] {
  const issues: OpeningIssue[] = [];
  const { width, height, count } = values;
  if (width === null || !(width >= OPENING_LIMITS.minWidth && width <= OPENING_LIMITS.maxWidth)) issues.push('width');
  if (height === null || !(height >= OPENING_LIMITS.minHeight && height <= OPENING_LIMITS.maxHeight)) issues.push('height');
  if (!(Number.isInteger(count) && count >= 1 && count <= OPENING_LIMITS.maxCount)) issues.push('count');
  if (width !== null && edgeLengthMetres !== null && edgeLengthMetres > 0 && width * Math.max(1, count) > edgeLengthMetres + 1e-6) {
    issues.push('widerThanEdge');
  }
  return issues;
}

export function isBlocking(issues: readonly OpeningIssue[]): boolean {
  return issues.some((i) => i !== 'widerThanEdge');
}

export interface OpeningMark {
  /** Extrémités de la marque le long de l'arête (unités de feuille). */
  a: Vec2;
  b: Vec2;
  centre: Vec2;
  /** Direction unitaire de l'arête. */
  dir: Vec2;
}

/**
 * Marque d'une ouverture sur son arête : centrée sur `position`, longue de `width` (à l'échelle), ramenée
 * à l'intérieur de l'arête. Une largeur plus grande que l'arête donne une marque de toute l'arête.
 * null si l'arête n'existe pas ou est dégénérée.
 */
export function openingMark(outline: readonly Vec2[], opening: Pick<Opening, 'edgeIndex' | 'position' | 'width'>, metresPerUnit: number): OpeningMark | null {
  const n = outline.length;
  if (n < 2 || opening.edgeIndex < 0 || opening.edgeIndex >= n) return null;
  const p = outline[opening.edgeIndex]!;
  const q = outline[(opening.edgeIndex + 1) % n]!;
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  if (len < 1e-12) return null;
  const dir = { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
  const widthUnits = metresPerUnit > 0 ? opening.width / metresPerUnit : 0;
  const half = Math.min(widthUnits, len) / 2;
  let s = Math.min(1, Math.max(0, opening.position)) * len;
  s = Math.min(len - half, Math.max(half, s));
  const centre = { x: p.x + dir.x * s, y: p.y + dir.y * s };
  return {
    a: { x: centre.x - dir.x * half, y: centre.y - dir.y * half },
    b: { x: centre.x + dir.x * half, y: centre.y + dir.y * half },
    centre,
    dir,
  };
}

/** Surface totale (m²) et nombre des ouvertures d'un type. */
export function openingTotals(openings: readonly Opening[], kind: OpeningKind): { area: number; count: number } {
  let area = 0;
  let count = 0;
  for (const o of openings) {
    if (o.kind !== kind) continue;
    area += o.width * o.height * o.count;
    count += o.count;
  }
  return { area, count };
}
