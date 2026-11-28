/**
 * Pré-calcul U / Uw. Cas de référence : les couches, dimensions et valeurs d'un CPE réel établi avec LuxEeB-Tool 6.25
 * (valeurs TECHNIQUES seulement : λ, épaisseurs, dimensions, U imprimés par l'outil ; aucun nom, aucune adresse).
 */
import { describe, expect, it } from 'vitest';
import type { ConstructionLayer, LuxeebElementType } from '../../src/core/cpe';
import type { Construction, Provenance } from '../../src/core/types';
import { computeU, computeUw, elementTypeOf, meanU, precalculatedU, precalculatedUw, proposeFensterTyp } from '../../src/engine/uvalue';

function layer(name: string, lambda: number | null, cm: number, from: Provenance = 'user'): ConstructionLayer {
  return { name, material: null, lambda: lambda === null ? null : { value: lambda, from }, thicknessCm: { value: cm, from: 'plan' } };
}

function element(type: LuxeebElementType, layers: ConstructionLayer[]): Pick<Construction, 'category' | 'luxeebType' | 'layers'> {
  return { category: 'wall', luxeebType: type, layers };
}

const floorTop = (concrete: number, eps: [string, number, number]): ConstructionLayer[] => [
  layer('Revêtement de sol', 1.0, 2),
  layer('Chape', 1.4, 6),
  layer('Mousse PU', 0.028, 9),
  layer('Dalle béton', 2.1, concrete),
  layer(eps[0], eps[1], eps[2]),
];

/** [type, couches, U imprimé par l'outil, épaisseur de l'élément imprimée (cm)] */
const REFERENCE: [string, LuxeebElementType, ConstructionLayer[], number, number][] = [
  ['radier', 'bodenplatte', floorTop(25, ['Jackodur', 0.036, 8]), 0.173, 50],
  ['dalle contre garage', 'kellerdecke', floorTop(22, ['EPS', 0.032, 8]), 0.161, 47],
  ['dalle contre extérieur', 'boden-aussen', floorTop(22, ['EPS', 0.032, 14]), 0.126, 53],
  ['toiture plate', 'dach', [layer('Enduit plâtre', 0.7, 1.5), layer('Dalle béton', 2.1, 22), layer('Isolant PIR', 0.022, 18), layer('Étanchéité', 0.17, 2)], 0.117, 43.5],
  ['façade', 'aussenwand', [layer('Enduit plâtre', 0.7, 1.5), layer('Bloc béton', 0.484, 24), layer('EPS', 0.032, 20), layer('Enduit de façade', 0.7, 1.5)], 0.144, 47],
  ['mur contre garage', 'wand-unbeheizt', [layer('Enduit plâtre', 0.7, 1.5), layer('Bloc béton', 0.484, 20), layer('EPS', 0.032, 12), layer('Enduit de façade', 0.7, 1.5)], 0.224, 35],
];

describe('computeU — les six éléments du CPE de référence', () => {
  it.each(REFERENCE)('%s', (_name, type, layers, uTool, thickness) => {
    const r = computeU(element(type, layers));
    expect(r.u).not.toBeNull();
    expect(Math.round(r.u! * 1000) / 1000).toBe(uTool);
    expect(r.thicknessCm).toBe(thickness);
    expect(r.resistancesObserved).toBe(true);
  });

  it('façade : R = 6,959 m²K/W comme la vérification faite à la main', () => {
    const r = computeU(element('aussenwand', REFERENCE[4]![2]));
    expect(r.rTotal).toBeCloseTo(6.959, 3);
    expect(r.rsi).toBe(0.13);
    expect(r.rse).toBe(0.04);
  });
});

describe('computeU — cas limites', () => {
  it('une couche sans λ empêche le calcul et est signalée', () => {
    const r = computeU(element('aussenwand', [layer('Béton', 2.1, 20), layer('Brique', null, 10)]));
    expect(r.u).toBeNull();
    expect(r.missingLambda).toEqual([1]);
    expect(r.confidence).toBe(0);
  });

  it('une couche sans épaisseur (film) ne compte pas', () => {
    const withFilm = computeU(element('bodenplatte', [...floorTop(25, ['Jackodur', 0.036, 8]), layer('Film PE', null, 0)]));
    expect(Math.round(withFilm.u! * 1000) / 1000).toBe(0.173);
    expect(withFilm.missingLambda).toEqual([]);
  });

  it('épaisseur inconnue : le calcul est bloqué, pas confondu avec un film', () => {
    const eps: ConstructionLayer = { ...layer('EPS', 0.032, 0), thicknessUnknown: true };
    const r = computeU(element('aussenwand', [layer('Béton', 2.1, 24), eps, layer('Enduit', 0.7, 2)]));
    expect(r.u).toBeNull();
    expect(r.missingThickness).toEqual([1]);
    expect(r.missingLambda).toEqual([]);
    expect(r.confidence).toBe(0);
    expect(precalculatedU(element('aussenwand', [layer('Béton', 2.1, 24), eps]))).toBeNull();
  });

  it('épaisseur non finie ou négative : calcul bloqué', () => {
    for (const cm of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
      const r = computeU(element('aussenwand', [layer('Béton', 2.1, 24), layer('EPS', 0.032, cm)]));
      expect(r.u).toBeNull();
      expect(r.missingThickness).toEqual([1]);
    }
  });

  it('sans couches : pas de U', () => {
    expect(computeU({ category: 'wall' }).u).toBeNull();
  });

  it('ΔU s’ajoute au résultat', () => {
    const base = computeU(element('aussenwand', REFERENCE[4]![2])).u!;
    expect(computeU({ ...element('aussenwand', REFERENCE[4]![2]), deltaU: 0.02 }).u!).toBeCloseTo(base + 0.02, 10);
  });

  it('Rsi / Rse non observés (mur contre terre, plancher sous comble) marqués à vérifier', () => {
    expect(computeU(element('kellerwand', [layer('Béton', 2.1, 25)])).resistancesObserved).toBe(false);
    expect(computeU(element('geschossdecke', [layer('Béton', 2.1, 20)])).resistancesObserved).toBe(false);
    expect(precalculatedU(element('kellerwand', [layer('Béton', 2.1, 25)]))!.doubt).toBeTruthy();
  });

  it('type déduit de la catégorie et du milieu quand il manque', () => {
    expect(elementTypeOf({ category: 'wall' }, 'unheated')).toBe('wand-unbeheizt');
    expect(elementTypeOf({ category: 'floor' })).toBe('bodenplatte');
    expect(elementTypeOf({ category: 'floor' }, 'unheated')).toBe('kellerdecke');
    expect(elementTypeOf({ category: 'roof' })).toBe('dach');
    expect(elementTypeOf({ category: 'door' }, 'unheated')).toBe('tuer-unbeheizt');
  });

  it('pré-calcul : une λ d’usage (hypothèse) rend la valeur « à confirmer »', () => {
    const hyp = REFERENCE[4]![2].map((l) => ({ ...l, lambda: l.lambda && { ...l.lambda, from: 'default' as const, confidence: 0 } }));
    const u = precalculatedU(element('aussenwand', hyp))!;
    expect(u.value).toBe(0.144);
    expect(u.from).toBe('default');
    expect(u.confidence).toBe(0);
    const sure = precalculatedU(element('aussenwand', REFERENCE[4]![2]))!;
    expect(sure.from).toBe('plan');
  });

  it('une porte se saisit par sa valeur propre : pas de calcul par couches', () => {
    expect(computeU({ category: 'door', layers: [layer('Bois', 0.13, 6)] }).u).toBeNull();
  });
});

describe('computeUw — les fenêtres du CPE de référence (cadre 0,112 ; Ug 0,50 ; Uf 1,00 ; Ψg 0,035)', () => {
  const W = (width: number, height: number, fensterTyp: 'einfach' | 'mehrfach', panes: number) =>
    computeUw({ width, height, frameWidth: 0.112, fensterTyp, panes }, 0.5, 1.0, 0.035);

  it.each([
    [0.94, 1.25, 'einfach', 1, 0.79, 0.73, 3.48, 63],
    [2.2, 1.25, 'mehrfach', 2, 0.75, 1.91, 7.83, 70],
    [1.01, 2.25, 'einfach', 1, 0.74, 1.59, 5.62, 70],
    [4.0, 2.25, 'mehrfach', 2, 0.65, 7.42, 15.43, 82],
  ] as const)('%s × %s %s', (w, h, typ, panes, uw, ag, lg, share) => {
    const r = W(w, h, typ, panes);
    expect(Math.round(r.uw * 100) / 100).toBe(uw);
    expect(Math.round(r.ag * 100) / 100).toBe(ag);
    expect(Math.round(r.lg * 100) / 100).toBe(lg);
    expect(Math.round(r.glassShare * 100)).toBe(share);
  });

  it('géométrie absurde (cadre plus large que la fenêtre) : pas de vitrage, pas de NaN', () => {
    const r = W(0.2, 0.2, 'einfach', 1);
    expect(r.ag).toBe(0);
    expect(r.uw).toBeCloseTo(1.0, 10);
  });

  it('einfach / mehrfach proposé par la largeur : juste pour les six fenêtres, mais signal faible', () => {
    for (const [w, typ] of [[0.94, 'einfach'], [2.2, 'mehrfach'], [1.01, 'einfach'], [4.0, 'mehrfach']] as const) {
      const p = proposeFensterTyp(w);
      expect(p.fensterTyp.value).toBe(typ);
      expect(p.fensterTyp.from).toBe('default');
      expect(p.fensterTyp.confidence).toBeLessThan(0.65);
    }
  });

  it('precalculatedUw : seulement si tout est connu, avec la provenance la plus faible', () => {
    const geometry = { width: 4, height: 2.25, frameWidth: { value: 0.112, from: 'default' as const }, fensterTyp: { value: 'mehrfach' as const, from: 'user' as const }, panes: 2 };
    const ok = precalculatedUw({ geometry, ug: { value: 0.5, from: 'user' }, uf: { value: 1, from: 'user' }, psiG: { value: 0.035, from: 'user' } })!;
    expect(ok.value).toBe(0.65);
    expect(ok.from).toBe('default');
    expect(precalculatedUw({ geometry, ug: { value: 0.5, from: 'user' }, uf: null, psiG: { value: 0.035, from: 'user' } })).toBeNull();
    expect(precalculatedUw({})).toBeNull();
  });
});

describe('meanU', () => {
  it('moyenne pondérée, null si une valeur manque', () => {
    expect(meanU([{ area: 10, u: 0.2 }, { area: 30, u: 0.1 }])).toBeCloseTo(0.125, 10);
    expect(meanU([{ area: 10, u: 0.2 }, { area: 5, u: null }])).toBeNull();
    expect(meanU([])).toBeNull();
  });
});
