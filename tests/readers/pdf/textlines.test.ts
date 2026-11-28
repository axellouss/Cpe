/**
 * Géométrie des textes d'une page : exposants, glyphes recollés, lignes, valeur des cotes, paires de cotes de baies.
 * Textes inventés.
 */
import { describe, expect, it } from 'vitest';
import { attachSuperscripts, buildLines, dimensionTokens, dimensionValue, mergeGlyphRuns, openingPairs, textLines } from '../../../src/readers/pdf/textlines';
import { box, lines, mk, split, sup, view } from '../../semantics/lines';

describe('attachSuperscripts', () => {
  it('rattache le ² d’une surface, le ⁵ du demi-centimètre et le « ER » de « 1ER »', () => {
    const area = mk('S: 3,41 m', 10, 20);
    const dim = mk('63', 60, 20);
    const title = mk('PLAN 1', 100, 40, 17);
    const tokens = attachSuperscripts([area, sup(area, '2'), dim, sup(dim, '5'), title, sup(title, 'ER'), mk('ÉTAGE', 100 + 0.5 * 17 * 6 + 0.66 * 17 + 5, 40, 17)]);
    const texts = tokens.map((k) => k.text).sort();
    expect(texts).toEqual(['63⁵', 'PLAN 1ER', 'S: 3,41 m²', 'ÉTAGE']);
    expect(tokens.find((k) => k.main === '63')!.sup).toBe('5');
    expect(buildLines(tokens).map((l) => l.text)).toContain('PLAN 1ER ÉTAGE');
  });

  it('vaut aussi pour une cote verticale (lue de bas en haut)', () => {
    const v = mk('4,12', 200, 300, 5, 90);
    const tokens = attachSuperscripts([v, sup(v, '5')]);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.text).toBe('4,12⁵');
    expect(dimensionTokens(tokens)[0]!.value).toBeCloseTo(4.125, 6);
  });

  it('ne prend pas pour exposant un texte de même corps ni un texte posé sur la ligne de base', () => {
    const a = mk('12', 10, 20);
    const sameSize = mk('5', a.x1 + 3, 20);
    const onBase = mk('5', a.x1, 20, 3.3);
    expect(attachSuperscripts([a, sameSize]).map((k) => k.text).sort()).toEqual(['12', '5']);
    expect(attachSuperscripts([a, onBase]).map((k) => k.text).sort()).toEqual(['12', '5']);
  });
});

describe('mergeGlyphRuns et buildLines', () => {
  const phrase = mk('24cm Béton armé', 10, 50);
  it('recolle un texte découpé par caractère ou par mot', () => {
    for (const mode of ['char', 'word'] as const) {
      const ls = lines(split(phrase, mode));
      expect(ls.map((l) => l.text), mode).toEqual(['24cm Béton armé']);
    }
  });

  it('recolle les chiffres d’une cote écrite glyphe par glyphe, exposant compris', () => {
    const d = mk('63', 10, 20);
    const tokens = attachSuperscripts([...split(d, 'char'), sup(d, '5')]);
    expect(tokens.map((k) => k.text)).toEqual(['63⁵']);
    expect(mergeGlyphRuns(tokens)).toHaveLength(1);
  });

  it('sépare deux étiquettes « S: … m² » écrites côte à côte', () => {
    const a = mk('S: 3,41 m²', 10, 20);
    const b = mk('S: 4,96 m²', a.x1 + 2, 20);
    expect(lines([a, b]).map((l) => l.text)).toEqual(['S: 3,41 m²', 'S: 4,96 m²']);
  });

  it('joint les morceaux d’une même ligne et pas ceux d’une ligne voisine', () => {
    const ls = lines([mk('Surface vitrée :', 10, 20), mk('6,20m²', 10 + 0.5 * 5 * 16 + 3, 20), mk('Surface séjour :', 10, 27)]);
    expect(ls.map((l) => l.text)).toEqual(['Surface vitrée : 6,20m²', 'Surface séjour :']);
    expect(ls[0]!.page).toBe(1);
  });

  it('porte le numéro de page demandé', () => {
    expect(textLines([mk('Hall', 0, 10)], 3).lines[0]!.page).toBe(3);
  });
});

describe('dimensionValue', () => {
  it('lit les mètres, les centimètres et le demi-centimètre en exposant', () => {
    expect(dimensionValue('1,26')).toBe(1.26);
    expect(dimensionValue('24')).toBe(0.24);
    expect(dimensionValue('63', '5')).toBeCloseTo(0.635, 6);
    expect(dimensionValue('36', '5')).toBeCloseTo(0.365, 6);
    expect(dimensionValue('1,87', '5')).toBeCloseTo(1.875, 6);
    expect(dimensionValue('4.12', '5')).toBeCloseTo(4.125, 6);
    // Le ⁵ est un demi-centimètre, pas une décimale de plus.
    expect(dimensionValue('1,2', '5')).toBeCloseTo(1.205, 6);
    expect(dimensionValue('2,5', '5')).toBeCloseTo(2.505, 6);
  });
  it('refuse ce qui n’est pas une cote', () => {
    expect(dimensionValue('A')).toBeNull();
    expect(dimensionValue('1/8')).toBeNull();
    expect(dimensionValue('12', '2')).toBeNull();
  });
});

describe('openingPairs', () => {
  const plan = view('plan', 'floor-plan', box(0, 0, 400, 400));
  const coupe = view('coupe', 'section', box(500, 0, 900, 400));
  const views = [plan, coupe];

  function pairsOf(texts: ReturnType<typeof mk>[]): ReturnType<typeof openingPairs> {
    const { tokens, lines: ls } = textLines(texts);
    return openingPairs(dimensionTokens(tokens), ls, views);
  }

  it('lit largeur au-dessus et hauteur dessous, et l’allège voisine', () => {
    const pairs = pairsOf([mk('1,26', 150, 95), mk('1,38', 150, 101), mk('ALL. 0,90', 150, 115, 4)]);
    expect(pairs).toEqual([{ width: 1.26, height: 1.38, sill: 0.9, viewId: 'plan', page: 1, at: expect.any(Object) as unknown }]);
  });

  it('lit une paire verticale avec demi-centimètres et une paire en centimètres entiers', () => {
    const w = mk('1,13', 90, 200, 5, 90);
    const h = mk('2,26', 96, 200, 5, 90);
    const cw = mk('60', 250, 60);
    const ch = mk('80', 250, 66);
    const pairs = pairsOf([w, sup(w, '5'), h, sup(h, '5'), cw, ch]).sort((a, b) => b.width - a.width);
    expect(pairs.map((p) => [p.width, p.height])).toEqual([[1.135, 2.265], [0.6, 0.8]]);
    expect(pairs[0]!.sill).toBeNull();
  });

  it('deux entiers superposés hors de toute vue ne font pas une baie ; avec une décimale, si', () => {
    expect(pairsOf([mk('120', 1500, 95), mk('135', 1500, 101)])).toEqual([]);
    expect(pairsOf([mk('1,20', 1500, 95), mk('1,35', 1500, 101)]).map((p) => [p.width, p.height, p.viewId])).toEqual([[1.2, 1.35, null]]);
    expect(pairsOf([mk('120', 150, 95), mk('135', 150, 101)]).map((p) => p.viewId)).toEqual(['plan']);
  });

  it('ignore les cotes superposées d’une coupe et les nombres trop écartés', () => {
    expect(pairsOf([mk('2,58', 600, 100), mk('2,90', 600, 106)])).toEqual([]);
    expect(pairsOf([mk('1,20', 150, 95), mk('1,25', 150, 115)])).toEqual([]);
  });
});
