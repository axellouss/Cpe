/**
 * Outils des tests de lecture de texte : textes de page INVENTÉS mis en page comme un export de CAO (boîte posée
 * sur la ligne de base), exposants, découpage par mot ou par caractère, vues.
 */
import type { ReadView, ViewKind } from '../../src/core/reading';
import type { BBox } from '../../src/core/types';
import type { RawText } from '../../src/readers/pdf/raw';
import { textLines, type TextLine } from '../../src/readers/pdf/textlines';

/**
 * Texte dont la ligne de base commence en (x, y). `angle` 0 : horizontal ; 90 : lu de bas en haut (la ligne de base
 * est alors le bord droit de la boîte et le texte monte depuis y).
 */
export function mk(s: string, x: number, y: number, size = 5, angle = 0): RawText {
  const w = 0.5 * size * s.length;
  if (angle === 90) return { s, x0: x - size, y0: y - w, x1: x, y1: y, cx: x - size / 2, cy: y - w / 2, bx: x, by: y, angle, size };
  return { s, x0: x, y0: y - size, x1: x + w, y1: y, cx: x + w / 2, cy: y - size / 2, bx: x, by: y, angle, size };
}

/** Exposant collé à la fin de `t` et relevé (corps 0,66). */
export function sup(t: RawText, s: string): RawText {
  const z = t.size * 0.66;
  if (t.angle === 90) return mk(s, t.x0 + z, t.y0, z, 90);
  return mk(s, t.x1, t.by - 0.35 * t.size, z, 0);
}

/** Pile de lignes écrites l'une sous l'autre (interligne 1,25 corps), à partir de (x, y). */
export function stack(rows: readonly string[], x: number, y: number, size = 5): RawText[] {
  return rows.map((s, i) => mk(s, x, y + i * 1.25 * size, size));
}

/** Découpe un texte horizontal en morceaux (mots ou caractères), placés proportionnellement au nombre de caractères. */
export function split(t: RawText, mode: 'word' | 'char'): RawText[] {
  if (Math.round(t.angle) !== 0 || t.s.length < 2) return [t];
  const w = (t.x1 - t.x0) / t.s.length;
  const pieces: { s: string; i: number }[] = [];
  if (mode === 'char') [...t.s].forEach((c, i) => c !== ' ' && pieces.push({ s: c, i }));
  else for (const m of t.s.matchAll(/\S+/g)) pieces.push({ s: m[0], i: m.index });
  return pieces.map((p) => {
    const x0 = t.x0 + p.i * w;
    const x1 = x0 + p.s.length * w;
    return { ...t, s: p.s, x0, x1, cx: (x0 + x1) / 2, bx: x0 };
  });
}

export function lines(texts: readonly RawText[], page = 1): TextLine[] {
  return textLines(texts, page).lines;
}

export function box(minX: number, minY: number, maxX: number, maxY: number): BBox {
  return { minX, minY, maxX, maxY };
}

export function view(id: string, kind: ViewKind, b: BBox, extra: Partial<ReadView> = {}): ReadView {
  return { id, page: 1, kind, title: null, titleBox: null, storeyRank: null, sides: null, box: b, buildingBox: null, sheetId: null, confidence: 1, sources: [], doubts: [], ...extra };
}
