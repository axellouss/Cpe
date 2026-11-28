/**
 * Bibliothèque de matériaux et composition lue → élément à couches. Compositions des planches SYNTHÉTIQUES.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReadComposition } from '../../src/core/reading';
import {
  MATERIAL_LIBRARY,
  USAGE_SOURCE,
  WINDOW_USAGE,
  confirmOfficeLambda,
  constructionFromComposition,
  doorHypothesis,
  dominantInsulation,
  doubtfulLayers,
  emptyOfficeLibrary,
  isEnvelopeComposition,
  lambdaFor,
  officeLibraryFromConstructions,
  sanitizeOfficeLibrary,
  windowTypeHypothesis,
  withUsageLambda,
} from '../../src/engine/materials';
import { readCompositionOf, readTruth, truthCompositions } from './planche-helpers';

let a1: ReadComposition[] = [];
let a2: ReadComposition[] = [];

beforeAll(async () => {
  a1 = truthCompositions(await readTruth('planche_A1_archicad')).map((c) => readCompositionOf(c));
  a2 = truthCompositions(await readTruth('planche_A2_de_titres_dessus')).map((c) => readCompositionOf(c));
});

const byElement = (list: ReadComposition[], element: string): ReadComposition => list.find((c) => c.element === element)!;

describe('λ proposées', () => {
  it('valeur d’usage : hypothèse étiquetée, source citée, jamais « lue »', () => {
    const l = lambdaFor('eps', 'fr')!;
    expect(l.value).toBe(0.032);
    expect(l.from).toBe('default');
    expect(l.confidence).toBe(0);
    expect(l.source).toBe(USAGE_SOURCE.fr);
    expect(l.source).toContain('hypothèse');
    expect(l.source).toContain('pas une valeur réglementaire');
    expect(lambdaFor('eps', 'de')!.source).toBe(USAGE_SOURCE.de);
  });

  it('pas de valeur d’usage connue : rien de proposé', () => {
    for (const k of ['brique', 'laine-minerale', 'bois', 'silico-calcaire', 'isolant', 'inconnu'] as const) {
      expect(lambdaFor(k, 'fr')).toBeNull();
      expect(MATERIAL_LIBRARY[k].lambda).toBeNull();
    }
  });

  it('bibliothèque du bureau : prioritaire, confirmée par l’utilisateur', () => {
    const office = confirmOfficeLambda(emptyOfficeLibrary(), 'eps', 0.035, '2026-01-10', 'EPS 035');
    const l = lambdaFor('eps', 'fr', office)!;
    expect(l).toMatchObject({ value: 0.035, from: 'user', confidence: 0.8 });
    expect(l.source).toContain('2026-01-10');
    // La structure d'origine n'est pas modifiée.
    expect(emptyOfficeLibrary().materials).toEqual({});
  });

  it('bibliothèque d’usage modifiable sans toucher à l’originale', () => {
    const lib = withUsageLambda(MATERIAL_LIBRARY, 'brique', 0.3);
    expect(lambdaFor('brique', 'fr', null, lib)!.value).toBe(0.3);
    expect(MATERIAL_LIBRARY.brique.lambda).toBeNull();
  });

  it('relit une bibliothèque du bureau sans confiance aveugle', () => {
    const lib = sanitizeOfficeLibrary({
      materials: {
        eps: { lambda: 0.033, confirmedAt: '2026-02-01' },
        pir: { lambda: -1, confirmedAt: 'x' },
        xps: 'n’importe quoi',
        plutonium: { lambda: 0.1, confirmedAt: 'x' },
        __proto__: { lambda: 0.1, confirmedAt: 'x' },
      },
    });
    expect(lib.materials).toEqual({ eps: { lambda: 0.033, confirmedAt: '2026-02-01' } });
    expect(sanitizeOfficeLibrary(null).materials).toEqual({});
  });
});

describe('constructionFromComposition — planche A1 (française)', () => {
  it('mur extérieur : trois couches, U pré-calculé, « béton » de mur douteux', () => {
    const c = constructionFromComposition(byElement(a1, 'external-wall'), { id: 'c1', lang: 'fr' });
    expect(c.category).toBe('wall');
    expect(c.luxeebType).toBe('aussenwand');
    expect(c.layers!.map((l) => [l.name, l.thicknessCm.value])).toEqual([
      ['Béton', 24],
      ['EPS', 18],
      ['Enduit de façade', 2],
    ]);
    expect(c.layers![0]!.doubt).toContain('coulé ou en blocs');
    expect(c.layers![1]!.doubt ?? null).toBeNull();
    // 1 / (0,13 + 0,24/2,1 + 0,18/0,032 + 0,02/0,7 + 0,04)
    const expected = 1 / (0.13 + 0.24 / 2.1 + 0.18 / 0.032 + 0.02 / 0.7 + 0.04);
    expect(c.u!.value).toBeCloseTo(expected, 3);
    expect(c.u!.from).toBe('default');
    expect(c.layers![1]!.planText).toBe('18cm Isolation type EPS');
  });

  it('dalle sur sol : film, béton de propreté, empierrement retirés', () => {
    const c = constructionFromComposition(byElement(a1, 'floor-on-ground'), { id: 'c2', lang: 'fr' });
    expect(c.luxeebType).toBe('bodenplatte');
    expect(c.layers!.map((l) => l.material)).toEqual(['revetement-sol', 'chape', 'pur', 'beton', 'xps']);
    expect(c.u).not.toBeNull();
  });

  it('toiture : couches de l’intérieur vers l’extérieur', () => {
    const c = constructionFromComposition(byElement(a1, 'roof'), { id: 'c3', lang: 'fr' });
    expect(c.layers!.map((l) => l.material)).toEqual(['enduit-platre', 'beton', 'pir', 'etancheite']);
    expect(c.luxeebType).toBe('dach');
  });

  it('dalle au-dessus du garage : isolant acoustique sans type → doute, repli sur l’isolant du projet', () => {
    const rc = byElement(a1, 'floor-to-unheated');
    const alone = constructionFromComposition(rc, { id: 'c4', lang: 'fr' });
    const generic = alone.layers!.find((l) => l.material === 'isolant')!;
    expect(generic.lambda).toBeNull();
    expect(generic.doubt).toContain('type d’isolant non écrit');
    expect(alone.u).toBeNull();
    const fallback = dominantInsulation(a1);
    expect(fallback).toBe('eps'); // 18 + 12 + 10 cm d'EPS contre 20 cm de PIR
    const withFallback = constructionFromComposition(rc, { id: 'c4', lang: 'fr', projectInsulation: fallback });
    const supposed = withFallback.layers!.find((l) => l.planText?.includes('acoustique'))!;
    expect(supposed.material).toBe('eps');
    expect(supposed.doubt).toContain('supposé');
    expect(withFallback.u).not.toBeNull();
  });

  it('dalle d’étage : hors enveloppe (pas de type LuxEeB, pas de U)', () => {
    const rc = byElement(a1, 'intermediate-floor');
    expect(isEnvelopeComposition(rc)).toBe(false);
    const c = constructionFromComposition(rc, { id: 'c5', lang: 'fr' });
    expect(c.luxeebType).toBeUndefined();
    expect(c.u).toBeNull();
  });

  it('couches douteuses regroupées pour UNE question', () => {
    const cs = a1.filter(isEnvelopeComposition).map((rc, i) => constructionFromComposition(rc, { id: `c${i}`, lang: 'fr' }));
    const doubtful = doubtfulLayers(cs);
    expect(doubtful.length).toBeGreaterThanOrEqual(3);
    expect(doubtful.every((d) => d.layer.doubt || d.layer.lambda === null)).toBe(true);
  });

  it('bibliothèque du bureau : les λ confirmées par l’utilisateur y passent', () => {
    const c = constructionFromComposition(byElement(a1, 'external-wall'), { id: 'c1', lang: 'fr' });
    c.layers![1]!.lambda = { value: 0.031, from: 'user' };
    const lib = officeLibraryFromConstructions(emptyOfficeLibrary(), [c], '2026-03-03');
    expect(lib.materials).toEqual({ eps: { lambda: 0.031, name: 'EPS', confirmedAt: '2026-03-03' } });
    const again = constructionFromComposition(byElement(a1, 'external-wall'), { id: 'c1', lang: 'fr', office: lib });
    expect(again.layers![1]!.lambda).toMatchObject({ value: 0.031, from: 'user', confidence: 0.8 });
  });
});

describe('constructionFromComposition — planche A2 (allemande)', () => {
  it('matériaux sans valeur d’usage : λ vide et doute, aucune valeur inventée', () => {
    const wall = constructionFromComposition(byElement(a2, 'external-wall'), { id: 'w', lang: 'de' });
    const ks = wall.layers!.find((l) => l.material === 'silico-calcaire')!;
    expect(ks.name).toBe('Kalksandstein');
    expect(ks.lambda).toBeNull();
    expect(ks.doubt).toContain('Materialdatenbank');
    expect(wall.u).toBeNull();
    const roof = constructionFromComposition(byElement(a2, 'roof'), { id: 'r', lang: 'de' });
    expect(roof.layers!.filter((l) => l.lambda === null).length).toBeGreaterThanOrEqual(2);
  });
});

describe('menuiseries : hypothèses d’usage', () => {
  it('type de fenêtre proposé : géométrie, valeurs d’usage étiquetées, Uw pré-calculé', () => {
    const w = windowTypeHypothesis('w1', 'AV 94*125 X2', 0.94, 1.25, 'fr');
    expect(w.geometry!.fensterTyp.value).toBe('einfach');
    expect(w.ug).toMatchObject({ value: WINDOW_USAGE.ug, from: 'default', confidence: 0 });
    expect(w.g!.source).toContain('hypothèse');
    expect(w.uw!.value).toBe(0.79);
    expect(w.uw!.from).toBe('default');
    expect(windowTypeHypothesis('w2', 'x', 4, 2.25, 'fr').uw!.value).toBe(0.65);
  });

  it('porte : valeur propre d’usage, type selon le milieu', () => {
    expect(doorHypothesis('d1', 'Porte d’entrée', false, 'fr')).toMatchObject({ category: 'door', ownValue: true, luxeebType: 'aussentuer', u: { value: 1.3, from: 'default' } });
    expect(doorHypothesis('d2', 'Porte vers garage', true, 'fr').luxeebType).toBe('tuer-unbeheizt');
  });
});

describe('constructionFromComposition — épaisseur illisible', () => {
  const rc: ReadComposition = {
    id: 'w',
    element: 'external-wall',
    layers: [
      { raw: '24cm Béton', label: 'Béton', material: 'beton-arme', thicknessCm: 24, counted: true },
      { raw: 'Isolation EPS', label: 'Isolation EPS', material: 'eps', thicknessCm: null, counted: true },
      { raw: '2cm Enduit', label: 'Enduit', material: 'enduit-facade', thicknessCm: 2, counted: true },
    ],
    occurrences: [],
    confidence: 0.9,
  };

  it('isolant sans épaisseur : pas de U pré-calculé, même avec les λ du bureau', () => {
    let office = emptyOfficeLibrary();
    office = confirmOfficeLambda(office, 'eps', 0.032, '2026-01-01');
    office = confirmOfficeLambda(office, 'beton-arme', 2.1, '2026-01-01');
    office = confirmOfficeLambda(office, 'enduit-facade', 0.7, '2026-01-01');
    const c = constructionFromComposition(rc, { id: 'x', lang: 'fr', office });
    expect(c.u).toBeNull();
    const eps = c.layers![1]!;
    expect(eps.thicknessUnknown).toBe(true);
    expect(eps.thicknessCm.confidence).toBe(0);
    expect(eps.doubt).toBeTruthy();
  });

  it('film compté sans épaisseur : sauté sans bloquer le calcul', () => {
    const withFilm: ReadComposition = {
      ...rc,
      layers: [rc.layers[0]!, { ...rc.layers[1]!, thicknessCm: 20 }, rc.layers[2]!, { raw: 'Film PE', label: 'Film PE', material: 'film', thicknessCm: null, counted: true }],
    };
    const c = constructionFromComposition(withFilm, { id: 'x', lang: 'de' });
    expect(c.layers![3]!.thicknessUnknown).toBeUndefined();
    expect(c.u).not.toBeNull();
  });
});
