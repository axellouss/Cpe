/**
 * Cotes de niveau et synthèse : rôles, contrôle « relatif + référence = altitude », niveaux finis, hauteurs d'étage,
 * sommet, égout, hauteurs libres, hauteur brute. Cotes inventées.
 */
import { describe, expect, it } from 'vitest';
import type { ReadComposition } from '../../src/core/reading';
import { clearHeights, grossHeightEstimate, levelMarks, levelRole, parseLevelText, readLevels, summarizeLevels } from '../../src/semantics/levels';
import { box, lines, mk, sup, view } from './lines';

describe('parseLevelText', () => {
  it('lit le relatif, l’altitude, le préfixe et la mention', () => {
    expect(parseLevelText('+0,20=+312,45')).toEqual({ rel: 0.2, abs: 312.45, prefix: null, suffix: null });
    expect(parseLevelText('±0,00=+312,25 axe rue')).toEqual({ rel: 0, abs: 312.25, prefix: null, suffix: 'axe rue' });
    expect(parseLevelText('+6,40=+318,65 (acrotère)')).toMatchObject({ rel: 6.4, suffix: 'acrotère' });
    expect(parseLevelText('OKFF KG -2,40')).toMatchObject({ rel: -2.4, prefix: 'OKFF KG' });
    expect(parseLevelText('First +7,85')).toMatchObject({ rel: 7.85, prefix: 'First' });
    expect(parseLevelText('NF 2,875')).toMatchObject({ rel: 2.875, prefix: 'NF' });
    expect(parseLevelText('+2,87⁵=+300,87⁵')).toMatchObject({ rel: 2.875, abs: 300.875 });
    expect(parseLevelText('+311,95')).toEqual({ rel: null, abs: 311.95, prefix: null, suffix: null });
  });
  it('refuse une cote de longueur, une allège, une hauteur libre', () => {
    expect(parseLevelText('2,15')).toBeNull();
    expect(parseLevelText('ALL. 0,90')).toBeNull();
    expect(parseLevelText('HSP 2,50')).toBeNull();
    expect(parseLevelText('S: 12,40 m²')).toBeNull();
  });
});

describe('levelRole', () => {
  it('reconnaît les rôles en français et en allemand', () => {
    expect(levelRole('NF')).toBe('finished-floor');
    expect(levelRole('OKFF EG')).toBe('finished-floor');
    expect(levelRole('acrotère')).toBe('top');
    expect(levelRole('Attika')).toBe('top');
    expect(levelRole('Faîtage')).toBe('ridge');
    expect(levelRole('Traufe')).toBe('eaves');
    expect(levelRole('TN')).toBe('terrain');
    expect(levelRole('axe rue')).toBe('reference');
    expect(levelRole('Gabarit max')).toBe('regulatory');
    expect(levelRole(null)).toBe('unknown');
  });
});

describe('levelMarks et summarizeLevels', () => {
  const coupe = view('coupe', 'section', box(0, 0, 400, 400));
  const facade = view('facade', 'elevation', box(500, 0, 900, 400));
  const toit = view('toit', 'roof-plan', box(1000, 0, 1400, 400));
  const views = [coupe, facade, toit];

  /** Une coupe et une façade avec « NF » au-dessus des cotes, l'acrotère sans mention, le ±0,00. */
  function sheet(): ReturnType<typeof mk>[] {
    const out: ReturnType<typeof mk>[] = [];
    for (const x of [50, 550]) {
      out.push(mk('NF', x + 8, 290), mk('+0,25=+300,25', x, 297), mk('NF', x + 8, 200));
      const n1 = mk('+3,02', x, 207);
      out.push(n1, sup(n1, '5'));
      const a1 = mk('=+303,02', n1.x1 + 2, 207);
      out.push(a1, sup(a1, '5'), mk('+6,30=+306,30', x, 120));
    }
    out.push(mk('±0,00=+300,00 axe rue', 50, 330), mk('+6,30=+306,30 (acrotère)', 1050, 100), mk('Gabarit max +9,00', 50, 60), mk('HSP 2,55', 150, 250), mk('Clôture h max 1,20', 150, 340));
    return out;
  }

  it('relit les niveaux finis, l’exposant ⁵ et le sommet, recoupés par l’altitude', () => {
    const { levels, doubts } = readLevels(lines(sheet()), views);
    expect(levels!.referenceAbs).toBe(300);
    expect(levels!.floors.map((f) => f.rel)).toEqual([0.25, 3.025]);
    expect(levels!.floors[1]!.viewIds.sort()).toEqual(['coupe', 'facade']);
    expect(levels!.floors[1]!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(levels!.storeyHeights).toEqual([2.775]);
    expect(levels!.top).toEqual({ rel: 6.3, role: 'top', confidence: expect.any(Number) as unknown });
    expect(levels!.top!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(levels!.checks.failed).toBe(0);
    expect(levels!.checks.checked).toBeGreaterThanOrEqual(6);
    expect(levels!.clearHeights).toEqual([2.55]);
    expect(doubts).toEqual([]);
    // Le gabarit réglementaire est lu comme tel, jamais pris pour le sommet.
    expect(levels!.marks.find((m) => m.rel === 9)!.role).toBe('regulatory');
  });

  it('compte un contrôle raté quand l’altitude ne concorde pas', () => {
    const { levels } = readLevels(lines([mk('±0,00=+300,00', 50, 100), mk('NF', 58, 200), mk('+3,00=+303,10', 50, 207), mk('NF', 58, 300), mk('+0,20=+300,20', 50, 307)]), views);
    expect(levels!.checks).toEqual({ checked: 3, failed: 1 });
  });

  it('une altitude écrite qui contredit la référence : la question dit la contradiction (pas « sans altitude »)', () => {
    const { levels, doubts } = readLevels(lines([mk('±0,00=+300,00', 50, 100), mk('NF', 58, 300), mk('+0,20=+300,90', 50, 307)]), views);
    expect(levels!.checks).toEqual({ checked: 2, failed: 1 });
    const d = doubts.find((x) => x.value === 0.2)!;
    expect(d.text).toMatch(/300,20.*300,90/);
    expect(d.text).not.toMatch(/sans altitude/);
    expect(levels!.floors.find((f) => f.rel === 0.2)!.confidence).toBeLessThanOrEqual(0.5);
    const de = readLevels(lines([mk('±0,00=+300,00', 50, 100), mk('OKFF +0,20=+300,90', 50, 307)]), views, 'de').doubts;
    expect(de.find((x) => x.value === 0.2)!.text).toMatch(/Bezugshöhe/);
  });

  it('déduit la référence d’au moins deux cotes concordantes quand le ±0,00 n’est pas écrit', () => {
    const { levels } = readLevels(lines([mk('NF', 58, 200), mk('+3,00=+303,00', 50, 207), mk('NF', 58, 300), mk('+0,20=+300,20', 50, 307)]), views);
    expect(levels!.referenceAbs).toBe(300);
    expect(levels!.checks).toEqual({ checked: 2, failed: 0 });
  });

  it('un niveau fini lu une seule fois, sans altitude : à confirmer', () => {
    const { levels, doubts } = readLevels(lines([mk('OKFF +2,75', 50, 100)]), views);
    expect(levels!.floors[0]!.confidence).toBeLessThan(0.65);
    expect(doubts[0]!.text).toMatch(/une seule fois/);
  });

  it('toiture à deux pans : faîtage et égout en allemand', () => {
    const { levels } = readLevels(lines([mk('First +7,85', 50, 50), mk('Traufe +5,60', 50, 120), mk('OKFF', 58, 200), mk('+2,75', 50, 207), mk('OKFF', 58, 300), mk('±0,00', 50, 307)]), views);
    expect(levels!.top).toMatchObject({ rel: 7.85, role: 'ridge' });
    expect(levels!.eaves).toBe(5.6);
    expect(levels!.storeyHeights).toEqual([2.75]);
  });

  it('repli sans mention « niveau fini » : les cotes des plans d’étage, à confirmer', () => {
    const rdc = view('rdc', 'floor-plan', box(0, 0, 400, 400), { storeyRank: 0 });
    const et = view('et', 'floor-plan', box(500, 0, 900, 400), { storeyRank: 1 });
    const marks = levelMarks(lines([mk('+0,20=+312,45', 100, 100), mk('+3,10=+315,35', 600, 100)]), [rdc, et]);
    const { levels, doubts } = summarizeLevels(marks, [rdc, et], 'de');
    expect(levels.floors.map((f) => f.rel)).toEqual([0.2, 3.1]);
    expect(levels.floors.every((f) => f.confidence <= 0.5)).toBe(true);
    expect(doubts.some((d) => d.topic === 'floors-unlabelled' && /Fertigfußboden/.test(d.text))).toBe(true);
  });

  it('rien d’écrit : pas de niveaux', () => {
    expect(readLevels(lines([mk('Séjour', 0, 10)]), views).levels).toBeNull();
  });
});

describe('clearHeights', () => {
  it('lit HSP, lichte Raumhöhe, h = ; ignore murets et maxima', () => {
    expect(clearHeights(lines([mk('HSP 2,50', 0, 10), mk('lichte Raumhöhe 2,55 m', 0, 30), mk('h = 2,60', 0, 50), mk('Clôture h max 1,20', 0, 70), mk('HSP 9,50', 0, 90)]))).toEqual([2.5, 2.55, 2.6]);
  });
});

describe('grossHeightEstimate', () => {
  const comp = (element: ReadComposition['element'], layers: [string, number][]): ReadComposition => ({
    id: element,
    element,
    layers: layers.map(([material, t]) => ({ raw: '', label: '', material: material as never, thicknessCm: t, counted: true })),
    occurrences: [],
    confidence: 0.9,
  });
  it('donne la hauteur par les compositions et par l’acrotère, avec une question si elles divergent', () => {
    const { levels } = readLevels(lines([mk('NF', 8, 200), mk('+3,00', 0, 207), mk('NF', 8, 300), mk('+0,20', 0, 307), mk('+6,20 (acrotère)', 0, 100)]), []);
    const comps = [
      comp('floor-on-ground', [['revetement-sol', 2], ['chape', 8], ['pur', 10], ['beton-arme', 30]]),
      comp('intermediate-floor', [['revetement-sol', 2], ['chape', 8], ['beton-arme', 20]]),
      comp('roof', [['enduit-platre', 1], ['beton-arme', 22], ['pir', 20]]),
    ];
    const g = grossHeightEstimate(levels, comps);
    // bas = 0,20 − 0,50 ; haut = 3,00 + 2,80 − 0,10 + 0,20
    expect(g.fromLayers).toBeCloseTo(6.2, 6);
    expect(g.fromTop).toBeCloseTo(6.0, 6);
    expect(g.doubt).toBeNull();
    expect(grossHeightEstimate(null, comps).doubt).toMatch(/Niveaux finis/);
  });
});
