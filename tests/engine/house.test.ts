/**
 * Maison mitoyenne à deux niveaux : un voisin chauffé à l'est, un garage non chauffé accolé à l'ouest du
 * rez-de-chaussée, une cave non chauffée dessous, un grenier non chauffé dessus.
 */
import { describe, expect, it } from 'vitest';
import { deriveSheets } from '../../src/engine';
import { EAST, NORTH, WEST, brief, codes, doorAt, finding, project, rect, room, storey, windowAt } from './helpers';

/**
 * Chaque niveau : 9,00 m (est-ouest) × 10,00 m (nord-sud), hauteur d'étage brute 2,80 m, hauteur libre 2,50 m.
 *
 *              9,00 m
 *        ┌───── N ─────┐
 * garage │             │ voisin
 * (RDC)  O             E chauffé      10,00 m
 *        │             │ (mitoyen)
 *        └───── S ─────┘
 */
function house() {
  return project(
    [
      storey('rdc', 'Rez-de-chaussée', rect(9, 10), {
        boundaries: { [EAST]: 'heated', [WEST]: 'unheated' },
        openings: [
          windowAt(NORTH, 1.2, 1.35),
          doorAt(WEST, 0.9, 2.0), // porte vers le garage
          windowAt(EAST, 1.0, 1.0), // erreur de saisie : une fenêtre sur le mur mitoyen
        ],
        rooms: [room('Séjour', 38.5), room('Cuisine', 14.2), room('Hall', 9.3), room('Cellier', 6.0, false)],
      }),
      storey('etage', '1er étage', rect(9, 10), {
        boundaries: { [EAST]: 'heated' },
        openings: [windowAt(NORTH, 1.2, 1.35)],
        netArea: 70,
      }),
    ],
    {
      top: { kind: 'attic-ceiling', pitchDeg: 35, shape: 'gable', ridgeAngle: null, kneeWallHeight: 0, constructionId: null, from: 'user' },
      bottom: { kind: 'above-unheated', constructionId: null, from: 'user' },
    },
  );
}

describe('maison mitoyenne à deux niveaux avec garage accolé', () => {
  const sheets = deriveSheets(house(), 'fr');

  it('regroupe les murs identiques des deux niveaux et laisse le mitoyen chauffé hors tableau', () => {
    expect(sheets.envelope.map(brief)).toEqual([
      // Nord : 9 m au RDC + 9 m à l'étage, même type, même hauteur → UNE ligne de 18 m ; les 2 fenêtres identiques → « 2 × »
      'window N 2 × 1.20 × 1.35 Abzug',
      'wall N 1 × 18.00 × 2.80',
      // Est : mitoyen chauffé → aucune ligne
      // Sud : 9 + 9 = 18 m
      'wall S 1 × 18.00 × 2.80',
      // Ouest : d'abord contre l'extérieur (étage), puis contre le garage non chauffé (RDC) avec sa porte
      'wall W 1 × 10.00 × 2.80',
      'door W 1 × 0.90 × 2.00 Abzug',
      'wall W 1 × 10.00 × 2.80',
      // Plancher haut vers le grenier, puis plancher bas sur la cave : 10 × 9 = 90 m² chacun
      'ceiling H 1 × 10.00 × 9.00',
      'floor H 1 × 10.00 × 9.00',
    ]);
    expect(sheets.envelope.map((r) => r.boundary)).toEqual([
      'outside',
      'outside',
      'outside',
      'outside',
      'unheated',
      'unheated',
      'unheated',
      'unheated',
    ]);
  });

  it('nomme les lignes avec les niveaux concernés', () => {
    expect(sheets.envelope.map((r) => r.label)).toEqual([
      'Fenêtre 1,20 × 1,35 m – Nord (Rez-de-chaussée + 1er étage)',
      'Mur extérieur – Nord (Rez-de-chaussée + 1er étage)',
      'Mur extérieur – Sud (Rez-de-chaussée + 1er étage)',
      'Mur extérieur – Ouest (1er étage)',
      'Porte 0,90 × 2,00 m – Ouest (Rez-de-chaussée)',
      'Mur contre local non chauffé – Ouest (Rez-de-chaussée)',
      'Plancher haut vers grenier non chauffé (1er étage)',
      'Plancher sur cave ou local non chauffé (Rez-de-chaussée)',
    ]);
    // Une ligne qui couvre deux niveaux n'est rattachée à aucun en particulier
    expect(sheets.envelope.map((r) => r.storeyId)).toEqual([null, null, null, 'etage', 'rdc', 'rdc', 'etage', 'rdc']);
  });

  it('calcule surfaces et totaux', () => {
    // Mur N : 18 × 2,80 = 50,40 ; fenêtres 2 × 1,62 = 3,24 → net 47,16
    // Mur S : 50,40
    // Mur O extérieur : 10 × 2,80 = 28,00 ; mur O contre garage : 28,00 − porte 1,80 = 26,20
    // Plancher haut 90 ; plancher bas 90
    expect(sheets.envelope.map((r) => r.netArea)).toEqual([3.24, 47.16, 50.4, 28, 1.8, 26.2, 90, 90]);
    // A  = 50,40 + 50,40 + 28 + 28 + 90 + 90 = 336,80 m² (le mitoyen chauffé de 2 × 28 m² n'en fait pas partie)
    // Ve = 2 × 90 × 2,80 = 504 m³ → A/Ve = 0,668
    // An = RDC (38,5 + 14,2 + 9,3 ; le cellier non chauffé ne compte pas) 62,0 + étage 70,0 = 132,0 m²
    // Vn = 132 × 2,50 = 330 m³
    // Façade contre extérieur = 50,40 + 50,40 + 28 = 128,80 m² (le mur contre le garage n'est pas une façade extérieure)
    expect(sheets.totals).toMatchObject({
      envelopeArea: 336.8,
      ve: 504,
      aOverVe: 0.668,
      an: 132,
      vn: 330,
      grossFloorArea: 180,
      windowArea: 3.24,
      facadeArea: 128.8,
      anFrom: 'plan', // surfaces de pièces lues sur le plan (RDC) + saisie de l'expert (étage) → la plus faible
    });
  });

  it('donne une zone et un volume par niveau', () => {
    expect(sheets.zones.map((z) => [z.label, z.area, z.clearHeight, z.airVolume])).toEqual([
      ['Rez-de-chaussée', 62, 2.5, 155],
      ['1er étage', 70, 2.5, 175],
    ]);
    expect(sheets.volumes.map((v) => [v.label, v.area, v.height, v.volume])).toEqual([
      ['Rez-de-chaussée', 90, 2.8, 252],
      ['1er étage', 90, 2.8, 252],
    ]);
  });

  it('récapitule les types par milieu', () => {
    // Mur extérieur : 47,16 + 50,40 + 28,00 = 125,56 m²
    expect(sheets.constructions.map((c) => [c.constructionId, c.boundary, c.area])).toEqual([
      ['wall-outside', 'outside', 125.56],
      ['wall-unheated', 'unheated', 26.2],
      ['ceiling-attic', 'unheated', 90],
      ['floor-unheated', 'unheated', 90],
      ['door', 'unheated', 1.8],
    ]);
    // Pas de dalle sur terre-plein ici → pas de paramètres « contre terre »
    expect(sheets.constructions.every((c) => c.ground === undefined)).toBe(true);
  });

  it('signale le mitoyen exclu et la fenêtre posée dessus', () => {
    // 10 m au RDC + 10 m à l'étage
    expect(finding(sheets, 'neighbours.heatedExcluded')).toEqual({
      code: 'neighbours.heatedExcluded',
      severity: 'info',
      params: { length: '20,00' },
    });
    expect(finding(sheets, 'opening.onHeatedWall')).toEqual({
      code: 'opening.onHeatedWall',
      severity: 'warn',
      params: { storey: 'Rez-de-chaussée', storeyId: 'rdc', count: 1 },
    });
    // La fenêtre du mitoyen n'apparaît nulle part
    expect(sheets.totals.windowArea).toBe(3.24);
    // Les contrôles les plus graves viennent d'abord
    const severities = sheets.findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ['block', 'warn', 'info'].indexOf(a) - ['block', 'warn', 'info'].indexOf(b)));
    // « windows.share » : 3,24 m² de fenêtres pour 128,80 m² de façade = 2,5 % — le relevé de cet exemple est volontairement incomplet.
    expect(codes(sheets).sort()).toEqual(['neighbours.heatedExcluded', 'opening.onHeatedWall', 'uvalues.missing', 'windows.share']);
  });

  it('sépare les murs de hauteurs différentes', () => {
    const p = house();
    p.model.storeys[1]!.grossHeight = { value: 2.6, from: 'user' };
    const rows = deriveSheets(p, 'fr').envelope.filter((r) => r.kind === 'wall' && r.orientation === 'S');
    // Sud : 9 × 2,80 (RDC) puis 9 × 2,60 (étage) — le plus haut d'abord
    expect(rows.map(brief)).toEqual(['wall S 1 × 9.00 × 2.80', 'wall S 1 × 9.00 × 2.60']);
  });

  it("sépare les murs de types différents et respecte l'ordre des types de l'expert", () => {
    const p = house();
    p.model.constructions = [...p.model.constructions, { id: 'brique-ite', name: 'Brique + ITE 16 cm', category: 'wall', u: { value: 0.2, from: 'user' } }];
    p.model.storeys[1]!.edges[2] = { boundary: 'outside', constructionId: 'brique-ite' }; // façade sud de l'étage
    const d = deriveSheets(p, 'fr');
    const south = d.envelope.filter((r) => r.orientation === 'S');
    expect(south.map((r) => [r.elementName, r.length, r.storeyId])).toEqual([
      ['Mur extérieur', 9, 'rdc'],
      ['Brique + ITE 16 cm', 9, 'etage'],
    ]);
    expect(d.constructions.find((c) => c.constructionId === 'brique-ite')).toMatchObject({ area: 25.2, u: { value: 0.2, from: 'user' } });
  });

  it("distingue par le nom un même type utilisé contre deux milieux (deux éléments distincts dans LuxEeB-Tool)", () => {
    const p = house();
    // L'expert affecte le type « Mur extérieur » aussi au mur contre le garage
    p.model.storeys[0]!.edges[WEST] = { boundary: 'unheated', constructionId: 'wall-outside' };
    const d = deriveSheets(p, 'fr');
    expect(d.envelope.filter((r) => r.kind === 'wall').map((r) => r.elementName)).toEqual([
      'Mur extérieur (contre extérieur)',
      'Mur extérieur (contre extérieur)',
      'Mur extérieur (contre extérieur)',
      'Mur extérieur (contre non chauffé)',
    ]);
    expect(d.constructions.filter((c) => c.constructionId === 'wall-outside').map((c) => [c.name, c.boundary, c.area])).toEqual([
      ['Mur extérieur (contre extérieur)', 'outside', 125.56],
      ['Mur extérieur (contre non chauffé)', 'unheated', 26.2],
    ]);
  });
});

describe('dalle sur terre-plein et mitoyenneté (manuel LuxEeB-Tool, ch. 2.2.5)', () => {
  it('ne compte pas dans le périmètre P le côté au contact du voisin chauffé', () => {
    const p = house();
    p.model.bottom = { kind: 'slab-on-ground', constructionId: null, from: 'user' };
    const slab = deriveSheets(p, 'fr').constructions.find((c) => c.constructionId === 'floor-ground');
    // Périmètre du RDC 2 × (9 + 10) = 38 m, moins les 10 m mitoyens chauffés = 28 m ;
    // le côté contre le garage non chauffé compte.
    expect(slab).toMatchObject({ boundary: 'ground', area: 90, ground: { slabArea: 90, perimeter: 28 } });
  });

  it('plancher sur extérieur (pilotis, passage couvert)', () => {
    const p = house();
    p.model.bottom = { kind: 'above-outside', constructionId: null, from: 'user' };
    const floor = deriveSheets(p, 'fr').envelope.find((r) => r.kind === 'floor');
    expect(floor).toMatchObject({ boundary: 'outside', constructionId: 'floor-outside', label: 'Plancher sur extérieur (Rez-de-chaussée)', grossArea: 90 });
  });

  it("fonctionne même si l'expert a vidé sa liste de types : les types par défaut sont recréés à la volée", () => {
    const p = house();
    p.model.constructions = [];
    p.model.windowTypes = [];
    const d = deriveSheets(p, 'de');
    expect(d.envelope.map((r) => r.elementName)).toEqual([
      'Fenster',
      'Außenwand',
      'Außenwand',
      'Außenwand',
      'Tür (opak)',
      'Wand gegen unbeheizten Raum',
      'Oberste Geschossdecke (unbeheizter Dachboden)',
      'Kellerdecke (unbeheizter Keller)',
    ]);
    expect(p.model.constructions).toEqual([]); // le projet n'est pas complété en douce
  });

  it('range un mur enterré après les murs extérieurs de même orientation', () => {
    // Rez-de-jardin de 10 × 8 m adossé à la pente : au nord, 6 m contre terre puis 4 m à l'air libre
    const outline = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 8 },
      { x: 0, y: 8 },
    ];
    const p = project([storey('rdj', 'Rez-de-jardin', outline, { boundaries: { 0: 'ground' }, netArea: 60 })]);
    const north = deriveSheets(p, 'fr').envelope.filter((r) => r.orientation === 'N');
    expect(north.map((r) => [brief(r), r.boundary, r.elementName])).toEqual([
      ['wall N 1 × 4.00 × 2.80', 'outside', 'Mur extérieur'],
      ['wall N 1 × 6.00 × 2.80', 'ground', 'Mur contre terre'],
    ]);
  });
});
