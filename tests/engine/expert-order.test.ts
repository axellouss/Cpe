/**
 * Ordre de saisie « expert » et relevé de bout en bout.
 *
 * Cas de référence : la géométrie d'une maison réelle jumelée (VALEURS TECHNIQUES seulement : emprise 8,00 × 11,00 m,
 * garage non chauffé 3,10 × 6,00 m dans l'emprise, niveaux, compositions, baies) et les lignes que l'expert a saisies
 * dans LuxEeB-Tool 6.25 pour ce bâtiment. Le relevé automatique doit sortir les MÊMES lignes, dans le MÊME ordre, avec
 * des surfaces à quelques % près. Écarts connus, expliqués :
 *  - convention de hauteur : on prend les cotes extérieures (dessous de l'isolant du sol → dessus de la toiture) ;
 *    l'expert a pris 6,0 m de façade et des longueurs un peu plus courtes que les cotes hors tout (7,8 / 10,4) ;
 *  - radier : 69,4 m² (contour chauffé) contre 68,8 saisis ;
 *  - mur contre garage : 9,10 × 3,00 contre 9,0 × 3,0.
 */
import { describe, expect, it } from 'vitest';
import type { ReadComposition, ReadLevels } from '../../src/core/reading';
import type { BuildingModel, EnvelopeRow, Opening, Project, Storey, Vec2 } from '../../src/core/types';
import { createEmptyProject, deriveSheets } from '../../src/engine';
import { envelopeHeights, facadeViewsFromReading, withExpertWindowTypes } from '../../src/engine/derive';
import { emptyReading } from '../../src/core/reading';

const GW = 3.1;
const GD = 6.0;
// Repère de la feuille (m) : haut = EST (nord à 90°), bas = ouest (façade avant), gauche = nord, droite = mitoyen.
const rdc: Vec2[] = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 11 - GD }, { x: 8 - GW, y: 11 - GD }, { x: 8 - GW, y: 11 }, { x: 0, y: 11 }];
const etage: Vec2[] = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 11 }, { x: 0, y: 11 }];
const garage: Vec2[] = [{ x: 8 - GW, y: 11 - GD }, { x: 8, y: 11 - GD }, { x: 8, y: 11 }, { x: 8 - GW, y: 11 }];

let n = 0;
const op = (edgeIndex: number, kind: 'window' | 'door', width: number, height: number, count = 1): Opening => ({
  id: `o${++n}`,
  edgeIndex,
  kind,
  width,
  height,
  count,
  position: 0.5,
  windowTypeId: null,
  from: 'plan',
});

function storey(id: string, name: string, outline: Vec2[], boundaries: ('outside' | 'heated' | 'unheated')[], height: number, openings: Opening[], extra: Partial<Storey> = {}): Storey {
  return {
    id,
    name,
    sheetId: null,
    outline,
    edges: boundaries.map((boundary) => ({ boundary, constructionId: null })),
    metresPerUnit: { value: 1, from: 'plan' },
    grossHeight: { value: height, from: 'plan' },
    clearHeight: { value: 2.5, from: 'plan' },
    openings,
    rooms: [],
    netAreaOverride: null,
    ...extra,
  };
}

/** Niveaux et compositions tels que la planche les écrit (épaisseurs comptées jusqu'au dessous du dernier isolant). */
const levels: ReadLevels = {
  referenceAbs: null,
  floors: [
    { rel: 0.23, abs: null, label: 'NF', viewIds: [], confidence: 0.9 },
    { rel: 3.145, abs: null, label: 'NF', viewIds: [], confidence: 0.9 },
  ],
  storeyHeights: [2.915],
  top: { rel: 6.37, role: 'top', confidence: 0.9 },
  eaves: null,
  clearHeights: [2.5],
  marks: [],
  checks: { checked: 0, failed: 0 },
};
const comp = (element: ReadComposition['element'], cms: number[]): ReadComposition => ({
  id: element,
  element,
  layers: cms.map((c) => ({ raw: `${c}cm`, label: '', material: 'beton', thicknessCm: c, counted: true })),
  occurrences: [],
  confidence: 0.9,
});
const compositions = [comp('floor-on-ground', [2, 8, 9, 30, 8]), comp('floor-to-unheated', [2, 8, 6, 24, 8]), comp('roof', [1.5, 24, 18]), comp('external-wall', [1.5, 24, 20, 2])];

function referenceProject(): Project {
  const h = envelopeHeights(levels, compositions, 2, 'external')!;
  const p = createEmptyProject('fr');
  const model: BuildingModel = {
    ...p.model,
    northAngle: { value: 90, from: 'plan' },
    storeysAligned: true,
    top: { ...p.model.top, kind: 'flat-roof', from: 'plan' },
    bottom: { kind: 'slab-on-ground', constructionId: null, from: 'plan' },
    envelopeOrder: 'expert',
    heightConvention: 'external',
    facadeViews: [
      { orientation: 'W', short: 'AV', title: 'FAÇADE AVANT' },
      { orientation: 'E', short: 'ARR', title: 'FAÇADE ARRIÈRE' },
      { orientation: 'N', short: 'GAU', title: 'FAÇADE LATÉRALE' },
    ],
    storeys: [
      // Arêtes du rez : 0 est, 1 mitoyen, 2-3 garage, 4 ouest, 5 nord.
      storey('s0', 'Rez-de-chaussée', rdc, ['outside', 'heated', 'unheated', 'unheated', 'outside', 'outside'], h.heights[0]!.value, [
        op(4, 'door', 1.0, 2.2),
        op(4, 'window', 0.94, 1.25, 2),
        op(0, 'window', 1.01, 2.25),
        op(0, 'window', 4.0, 2.25),
        op(5, 'window', 1.01, 2.25),
        op(2, 'door', 1.0, 2.2),
      ], {
        rooms: [{ id: 'g', name: 'Garage', area: { value: 16.07, from: 'plan' }, heated: false, needsReview: false, polygon: garage }],
        netAreaOverride: { value: 53.5, from: 'user' },
      }),
      // Arêtes de l'étage : 0 est, 1 mitoyen, 2 ouest, 3 nord.
      storey('s1', '1er étage', etage, ['outside', 'heated', 'outside', 'outside'], h.heights[1]!.value, [
        op(2, 'window', 2.2, 1.25),
        op(0, 'window', 1.01, 2.25),
        op(0, 'window', 2.2, 1.25),
        op(3, 'window', 1.01, 2.25),
      ], { netAreaOverride: { value: 64.9, from: 'user' } }),
    ],
  };
  return { ...p, model: withExpertWindowTypes(model, 'fr') };
}

/** Lignes saisies par l'expert : [genre, nom, nombre, surface brute, surface nette]. */
const EXPERT: [EnvelopeRow['kind'], string, number, number, number][] = [
  ['floor', 'Radier', 1, 68.8, 68.8],
  ['floor', 'Dalle contre garage', 1, 18.6, 18.6],
  ['roof', 'Toiture plate', 1, 88.0, 88.0],
  ['door', 'Porte d’entrée', 1, 2.2, 2.2],
  ['window', 'AV 94*125 X2', 2, 2.35, 2.35],
  ['window', 'AV 220*125', 1, 2.75, 2.75],
  ['wall', 'Façade', 1, 38.8, 31.5],
  ['window', 'ARR 101*225 X2', 2, 4.54, 4.54],
  ['window', 'ARR 400*225', 1, 9.0, 9.0],
  ['window', 'ARR 220*125', 1, 2.75, 2.75],
  ['wall', 'Façade', 1, 46.8, 30.5],
  ['window', 'GAU 101*225 X2', 2, 4.54, 4.54],
  ['wall', 'Façade', 1, 62.4, 57.8],
  ['door', 'Porte vers local non chauffé', 1, 2.2, 2.2],
  ['wall', 'Mur contre garage', 1, 27.0, 24.7],
];

describe('hauteurs d’enveloppe tirées des niveaux et compositions', () => {
  it('cotes extérieures : −0,34 → 2,665 → 6,08', () => {
    const h = envelopeHeights(levels, compositions, 2, 'external')!;
    expect(h.convention).toBe('external');
    expect(h.bottom).toBeCloseTo(-0.34, 6);
    expect(h.top).toBeCloseTo(6.08, 6);
    expect(h.heights.map((x) => x.value)).toEqual([3.005, 3.415]);
    expect(h.heights[0]!.from).toBe('plan');
  });

  it('de niveau fini à niveau fini, puis l’acrotère', () => {
    const h = envelopeHeights(levels, compositions, 2, 'levels')!;
    expect(h.heights.map((x) => x.value)).toEqual([2.915, 3.225]);
  });

  it('repli sur les niveaux quand la coupe ne donne pas la hauteur libre', () => {
    const h = envelopeHeights({ ...levels, clearHeights: [] }, compositions, 2, 'external')!;
    expect(h.convention).toBe('levels');
  });

  it('couche comptée sans épaisseur : pas de cote extérieure raccourcie, repli sur les niveaux', () => {
    const broken = compositions.map((c) =>
      c.element === 'roof' ? { ...c, layers: c.layers.map((l, i) => (i === 1 ? { ...l, thicknessCm: null } : l)) } : c,
    );
    const h = envelopeHeights(levels, broken, 2, 'external')!;
    expect(h.convention).toBe('levels');
    expect(h.heights.map((x) => x.value)).toEqual([2.915, 3.225]);
  });

    it('rien d’inventé quand les niveaux manquent', () => {
    expect(envelopeHeights(null, compositions, 2)).toBeNull();
    expect(envelopeHeights({ ...levels, floors: levels.floors.slice(0, 1) }, compositions, 2)).toBeNull();
    expect(envelopeHeights({ ...levels, clearHeights: [], top: null }, compositions, 2)).toBeNull();
  });
});

describe('relevé « expert » de bout en bout, face aux lignes de l’expert', () => {
  const sheets = deriveSheets(referenceProject(), 'fr');
  const rows = sheets.envelope;

  it('mêmes lignes, même ordre, même regroupement', () => {
    expect(rows.map((r) => r.kind)).toEqual(EXPERT.map((e) => e[0]));
    expect(rows.map((r) => r.count)).toEqual(EXPERT.map((e) => e[2]));
    expect(rows.map((r) => r.deduct)).toEqual(EXPERT.map((e) => e[0] === 'window' || e[0] === 'door'));
  });

  it('fenêtres nommées comme l’expert', () => {
    const named = rows.filter((r) => r.kind === 'window' || r.kind === 'door').map((r) => r.label);
    expect(named).toEqual(EXPERT.filter((e) => e[0] === 'window' || e[0] === 'door').map((e) => e[1]));
    // Le type de fenêtre porte le même nom (c'est lui qu'on choisit dans la liste « Bauteil »).
    expect(rows.find((r) => r.label === 'ARR 400*225')!.elementName).toBe('ARR 400*225');
  });

  it('orientations : avant = ouest, arrière = est, latérale = nord, mitoyen exclu', () => {
    const walls = rows.filter((r) => r.kind === 'wall');
    expect(walls.slice(0, 3).map((r) => r.orientation)).toEqual(['W', 'E', 'N']);
    expect(walls[3]!.boundary).toBe('unheated');
    expect(rows.some((r) => r.boundary === 'heated')).toBe(false);
  });

  it('façades sur plusieurs étages saisies en surface, mur contre garage en longueur × hauteur', () => {
    const walls = rows.filter((r) => r.kind === 'wall');
    expect(walls.slice(0, 3).every((r) => r.entry === 'area')).toBe(true);
    expect(walls[3]!.entry).toBeUndefined();
    expect(walls[3]!.length).toBe(9.1);
    expect(walls[3]!.width).toBeCloseTo(3.0, 1);
    // Planchers de forme quelconque : la surface seule, comme l'expert ; la toiture rectangulaire en 11 × 8.
    expect(rows.slice(0, 2).map((r) => [r.entry, r.length, r.width])).toEqual([['area', 1, 69.4], ['area', 1, 18.6]]);
    expect([rows[2]!.length, rows[2]!.width, rows[2]!.entry]).toEqual([11, 8, undefined]);
  });

  it('surfaces ligne à ligne : ouvertures exactes, parois dans l’écart expliqué', () => {
    rows.forEach((r, i) => {
      const [kind, , , gross, net] = EXPERT[i]!;
      if (kind === 'window' || kind === 'door') {
        expect(r.grossArea).toBeCloseTo(gross, 2);
        return;
      }
      // Parois : convention de hauteur (cotes extérieures) et longueurs hors tout ; au plus +16 % sur une façade.
      const tol = kind === 'wall' ? 0.16 : 0.01;
      expect(Math.abs(r.grossArea - gross) / gross).toBeLessThanOrEqual(tol);
      expect(r.netArea).toBeGreaterThan(0);
      expect(Math.abs(r.netArea - net) / net).toBeLessThanOrEqual(kind === 'wall' ? 0.16 : 0.01);
    });
  });

  it('totaux à quelques % de ceux de l’outil : A +4,9 %, Ve +3,3 %, fenêtres exactes', () => {
    const A = 350.3;
    const VE = 493;
    expect(sheets.totals.envelopeArea).toBeCloseTo(367.4, 0);
    expect((sheets.totals.envelopeArea - A) / A).toBeLessThan(0.05);
    // Hauteurs saisies au cm (3,005 → 3,01 ; 3,415 → 3,42) : 509,9 au lieu de 509,1.
    expect(Math.abs(sheets.totals.ve - 509.1)).toBeLessThan(1);
    expect((sheets.totals.ve - VE) / VE).toBeLessThan(0.04);
    expect(sheets.totals.windowArea).toBeCloseTo(25.94, 2);
  });

  it('sans l’ordre « expert », le même modèle garde l’ordre historique', () => {
    const p = referenceProject();
    delete p.model.envelopeOrder;
    const legacy = deriveSheets(p, 'fr').envelope;
    // Ordre historique : les murs par orientation d'abord, les planchers à la fin.
    expect(legacy.find((r) => !r.deduct)!.kind).toBe('wall');
    expect(legacy[legacy.length - 1]!.kind).toBe('floor');
    expect(legacy.some((r) => r.entry === 'area')).toBe(false);
  });
});

describe('façades dessinées lues → ordre et noms courts', () => {
  it('orientation par le côté du plan et le nord ; avant, arrière, puis les autres', () => {
    const reading = emptyReading();
    reading.north = { sheetUpAzimuth: 90, marginDeg: 45, confidence: 0.9, evidence: [], page: 1, box: null };
    const view = (id: string, title: string) => ({ id, page: 1, kind: 'elevation' as const, title, titleBox: null, storeyRank: null, sides: null, box: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, buildingBox: null, sheetId: null, confidence: 0.9, sources: [], doubts: [] });
    reading.views = [view('e1', 'FAÇADE LATÉRALE'), view('e2', 'FAÇADE AVANT'), view('e3', 'FAÇADE ARRIÈRE')];
    const side = (deg: number) => ({ value: deg, confidence: 0.8, evidence: [] });
    reading.elevations = [
      { viewId: 'e1', sides: ['left'], widthM: 11, heightM: 6.4, bays: [], planSideDeg: side(270) },
      { viewId: 'e2', sides: ['front'], widthM: 8, heightM: 6.4, bays: [], planSideDeg: side(180) },
      { viewId: 'e3', sides: ['back'], widthM: 8, heightM: 6.4, bays: [], planSideDeg: side(0) },
    ];
    expect(facadeViewsFromReading(reading, 'fr')).toEqual([
      { orientation: 'W', short: 'AV', title: 'FAÇADE AVANT', viewId: 'e2' },
      { orientation: 'E', short: 'ARR', title: 'FAÇADE ARRIÈRE', viewId: 'e3' },
      { orientation: 'N', short: 'GAU', title: 'FAÇADE LATÉRALE', viewId: 'e1' },
    ]);
    expect(facadeViewsFromReading(reading, 'de').map((f) => f.short)).toEqual(['VO', 'RÜ', 'LI']);
    reading.north = null;
    expect(facadeViewsFromReading(reading, 'fr')).toEqual([]);
  });
});
