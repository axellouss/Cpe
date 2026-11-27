/**
 * Étages de contours différents : la partie du niveau bas qui n'est pas recouverte devient une toiture-terrasse,
 * la partie du niveau haut qui dépasse devient un plancher sur extérieur.
 *  - plans superposables (IFC : même repère) → vraie différence de polygones ;
 *  - plans non superposables (feuilles PDF/DWG séparées) → simple différence de surfaces, signalée à l'expert.
 */
import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../src/core/types';
import { deriveSheets } from '../../src/engine';
import { brief, codes, finding, project, rect, storey } from './helpers';

function twoStoreys(lower: Vec2[], upper: Vec2[], aligned: boolean) {
  return project([storey('rdc', 'RDC', lower, { netArea: 0.8 * 80 }), storey('etage', 'Étage', upper, { netArea: 40 })], {
    storeysAligned: aligned,
  });
}

const horizontal = (p: ReturnType<typeof twoStoreys>) =>
  deriveSheets(p, 'fr')
    .envelope.filter((r) => r.orientation === 'H')
    .map((r) => `${brief(r)} | ${r.boundary} | ${r.label}`);

describe('plans superposables (storeysAligned = true)', () => {
  it('étage en retrait : la bande découverte du RDC devient une toiture-terrasse', () => {
    // RDC 10 × 8 = 80 m² ; étage 10 × 6 = 60 m² calé sur la façade nord → 10 × 2 = 20 m² de RDC à ciel ouvert
    const p = twoStoreys(rect(10, 8), rect(10, 6), true);
    expect(horizontal(p)).toEqual([
      'roof H 1 × 10.00 × 6.00 | outside | Toiture plate (Étage)',
      'roof H 1 × 20.00 × 1.00 | outside | Toiture-terrasse au-dessus de RDC', // surface portée sur la longueur, largeur 1 m
      'floor H 1 × 10.00 × 8.00 | ground | Dalle sur terre-plein (RDC)',
    ]);
    const d = deriveSheets(p, 'fr');
    // Murs : N 2 × 10 = 20 m, E 8 + 6 = 14 m, S 20 m, O 14 m, tous de 2,80 m → 68 × 2,80 = 190,4 m²
    // A = 190,4 + 60 + 20 + 80 = 350,4 m² ; Ve = (80 + 60) × 2,80 = 392 m³
    expect(d.totals).toMatchObject({ envelopeArea: 350.4, ve: 392, grossFloorArea: 140 });
    expect(codes(d)).not.toContain('stepback.byAreas');
    expect(d.envelope.find((r) => r.id === 'roof:terrace:rdc')).toMatchObject({ constructionId: 'roof', storeyId: 'rdc', from: 'plan' });
  });

  it('étage décalé : terrasse d’un côté ET surplomb de l’autre', () => {
    // Étage 10 × 8 décalé de 2 m vers l'est et de 1 m vers le nord : recouvrement 8 × 7 = 56 m²
    // → 80 − 56 = 24 m² de RDC découverts, et 24 m² d'étage en porte-à-faux
    const p = twoStoreys(rect(10, 8), rect(10, 8, 2, -1), true);
    expect(horizontal(p)).toEqual([
      'roof H 1 × 10.00 × 8.00 | outside | Toiture plate (Étage)',
      'roof H 1 × 24.00 × 1.00 | outside | Toiture-terrasse au-dessus de RDC',
      'floor H 1 × 10.00 × 8.00 | ground | Dalle sur terre-plein (RDC)',
      'floor H 1 × 24.00 × 1.00 | outside | Plancher en surplomb de Étage (sur extérieur)',
    ]);
    const overhang = deriveSheets(p, 'fr').envelope.find((r) => r.id === 'floor:overhang:etage');
    expect(overhang).toMatchObject({ constructionId: 'floor-outside', elementName: 'Plancher sur extérieur', storeyId: 'etage' });
  });

  it('étage plus petit au milieu du RDC', () => {
    // Étage 6 × 4 = 24 m² entièrement posé sur le RDC → 80 − 24 = 56 m² de toiture-terrasse
    expect(horizontal(twoStoreys(rect(10, 8), rect(6, 4, 2, 2), true))[1]).toBe(
      'roof H 1 × 56.00 × 1.00 | outside | Toiture-terrasse au-dessus de RDC',
    );
  });

  it('RDC en L sous un étage rectangulaire : seule l’aile non recouverte devient terrasse', () => {
    // RDC en L : corps 12 × 6 = 72 m² + aile 6 × 4 = 24 m² ; l'étage 12 × 6 recouvre exactement le corps
    const L: Vec2[] = [
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(horizontal(twoStoreys(L, rect(12, 6), true))).toEqual([
      'roof H 1 × 12.00 × 6.00 | outside | Toiture plate (Étage)',
      'roof H 1 × 24.00 × 1.00 | outside | Toiture-terrasse au-dessus de RDC',
      // Dalle en L de 96 m² : forme non rectangulaire → surface sur la longueur, largeur 1 m (longueur × largeur exact)
      'floor H 1 × 96.00 × 1.00 | ground | Dalle sur terre-plein (RDC)',
    ]);
  });

  it('étages identiques, ou écart de tracé d’un centimètre : aucune ligne en plus', () => {
    expect(horizontal(twoStoreys(rect(10, 8), rect(10, 8), true))).toHaveLength(2);
    // Décalage de 1 cm : 2 bandes de moins de 0,1 m² → sous le seuil de 0,5 m²
    expect(horizontal(twoStoreys(rect(10, 8), rect(10, 8, 0.01, 0.01), true))).toHaveLength(2);
  });

  it('contour croisé (polygones inexploitables) : repli sur la différence de surfaces, et on le dit', () => {
    const bowtie: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 6 },
      { x: 10, y: 0 },
      { x: 0, y: 6 },
    ];
    const d = deriveSheets(twoStoreys(rect(10, 8), bowtie, true), 'fr');
    expect(codes(d)).toContain('storey.outlineInvalid');
    expect(codes(d)).toContain('stepback.byAreas');
  });
});

describe('plans non superposables (storeysAligned = false)', () => {
  it('étage plus petit : terrasse = différence des surfaces, avec un avertissement', () => {
    // L'étage est tracé sur une autre feuille, n'importe où : seules les surfaces sont comparables. 80 − 60 = 20 m²
    const p = twoStoreys(rect(10, 8), rect(10, 6, 500, 300), false);
    expect(horizontal(p)).toEqual([
      'roof H 1 × 10.00 × 6.00 | outside | Toiture plate (Étage)',
      'roof H 1 × 20.00 × 1.00 | outside | Toiture-terrasse au-dessus de RDC',
      'floor H 1 × 10.00 × 8.00 | ground | Dalle sur terre-plein (RDC)',
    ]);
    expect(finding(deriveSheets(p, 'fr'), 'stepback.byAreas')).toEqual({
      code: 'stepback.byAreas',
      severity: 'info',
      params: { lower: 'RDC', upper: 'Étage', area: '20,00' },
    });
  });

  it('étage plus grand : plancher en surplomb sur extérieur', () => {
    // 10 × 9,5 = 95 m² au-dessus de 80 m² → 15 m² en porte-à-faux
    const p = twoStoreys(rect(10, 8), rect(10, 9.5), false);
    expect(horizontal(p)).toEqual([
      'roof H 1 × 10.00 × 9.50 | outside | Toiture plate (Étage)',
      'floor H 1 × 10.00 × 8.00 | ground | Dalle sur terre-plein (RDC)',
      'floor H 1 × 15.00 × 1.00 | outside | Plancher en surplomb de Étage (sur extérieur)',
    ]);
  });

  it('LIMITE CONNUE : à surfaces égales, un décalage entre feuilles non superposables est invisible', () => {
    const p = twoStoreys(rect(10, 8), rect(10, 8, 2, -1), false);
    expect(horizontal(p)).toHaveLength(2);
    expect(codes(deriveSheets(p, 'fr'))).not.toContain('stepback.byAreas');
  });

  it('écart inférieur à 0,5 m² : ignoré', () => {
    // 10 × 7,96 = 79,6 m² → 0,4 m² d'écart
    expect(horizontal(twoStoreys(rect(10, 8), rect(10, 7.96), false))).toHaveLength(2);
  });
});

describe('trois niveaux', () => {
  it('compare chaque niveau à celui du dessus', () => {
    const p = project(
      [
        storey('rdc', 'RDC', rect(10, 8), { netArea: 64 }),
        storey('e1', '1er', rect(10, 8), { netArea: 64 }),
        storey('e2', '2e', rect(10, 5), { netArea: 40 }), // attique en retrait de 3 m
      ],
      { storeysAligned: true },
    );
    const d = deriveSheets(p, 'fr');
    expect(d.envelope.filter((r) => r.kind === 'roof').map((r) => `${brief(r)} | ${r.label}`)).toEqual([
      'roof H 1 × 10.00 × 5.00 | Toiture plate (2e)',
      'roof H 1 × 30.00 × 1.00 | Toiture-terrasse au-dessus de 1er',
    ]);
    // Nord : les trois niveaux ont un mur de 10 m → une ligne de 30 m ; Est : 8 + 8 + 5 = 21 m
    expect(d.envelope.filter((r) => r.kind === 'wall').map(brief)).toEqual([
      'wall N 1 × 30.00 × 2.80',
      'wall E 1 × 21.00 × 2.80',
      'wall S 1 × 30.00 × 2.80',
      'wall W 1 × 21.00 × 2.80',
    ]);
  });
});

describe('étage au-dessus d’un garage intégré, retiré du contour chauffé du niveau bas', () => {
  // Emprise 14 × 8 m ; garage intégré dans l'angle sud-est : 3,40 × 3,40 m au nu intérieur, murs de 40 cm
  // → le contour chauffé du RDC perd 3,80 × 3,80 = 14,44 m². L'étage (chambres) couvre toute l'emprise.
  const carved: Vec2[] = [
    { x: 0, y: 0 },
    { x: 14, y: 0 },
    { x: 14, y: 4.2 },
    { x: 10.2, y: 4.2 },
    { x: 10.2, y: 8 },
    { x: 0, y: 8 },
  ];
  const garage = {
    id: 'r-garage',
    name: 'Garage',
    area: { value: 11.56, from: 'plan' as const },
    heated: false,
    needsReview: false,
    polygon: [
      { x: 10.2, y: 4.2 },
      { x: 13.6, y: 4.2 },
      { x: 13.6, y: 7.6 },
      { x: 10.2, y: 7.6 },
    ],
  };
  const house = (aligned: boolean) =>
    project(
      [
        storey('rdc', 'RDC', carved, { netArea: 70, rooms: [garage], boundaries: { 2: 'unheated', 3: 'unheated' } }),
        storey('etage', 'Étage', rect(14, 8), { netArea: 90 }),
      ],
      { storeysAligned: aligned },
    );

  it('plans superposables : le plancher au-dessus du garage donne sur un local non chauffé, pas sur l’extérieur', () => {
    const d = deriveSheets(house(true), 'fr');
    const floors = d.envelope.filter((r) => r.kind === 'floor').map((r) => `${brief(r)} | ${r.boundary} | ${r.label}`);
    expect(floors).toEqual([
      'floor H 1 × 97.56 × 1.00 | ground | Dalle sur terre-plein (RDC)',
      'floor H 1 × 14.44 × 1.00 | unheated | Plancher de Étage au-dessus d’un local non chauffé (Garage)',
    ]);
    expect(d.envelope.find((r) => r.id === 'floor:overUnheated:etage')).toMatchObject({ constructionId: 'floor-unheated', from: 'plan' });
    expect(d.envelope.some((r) => r.id.startsWith('floor:overhang'))).toBe(false);
  });

  it('plans non superposables : même attribution, par les surfaces, et marquée comme estimation', () => {
    const d = deriveSheets(house(false), 'fr');
    const row = d.envelope.find((r) => r.id === 'floor:overUnheated:etage');
    expect(row).toMatchObject({ grossArea: 14.44, boundary: 'unheated', from: 'estimate' });
    expect(d.envelope.some((r) => r.id.startsWith('floor:overhang'))).toBe(false);
    expect(codes(d)).toContain('stepback.byAreas');
  });

  it('sans local non chauffé connu sous le surplomb, il reste un plancher sur l’extérieur', () => {
    const p = house(true);
    p.model.storeys[0]!.rooms = [];
    const d = deriveSheets(p, 'fr');
    expect(d.envelope.find((r) => r.id === 'floor:overhang:etage')).toMatchObject({ grossArea: 14.44, boundary: 'outside' });
  });
});
