import { describe, expect, it } from 'vitest';
import { polygonArea, edgeEnds } from '../../src/core/geometry';
import type { DetectedRoom, Vec2 } from '../../src/core/types';
import {
  carryOverFromPrevious,
  excludeRoomFromOutline,
  proposeHeatedOutline,
  remapOpenings,
  unheatedRoomsInsideOutline,
} from '../../src/engine/heatedOutline';
import { createEmptyProject, createStorey, deriveSheets, restoreFootprint, roomsOutsideOutline } from '../../src/engine';
import type { Storey } from '../../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (name: string, guess: 'yes' | 'no' | 'ask', polygon: Vec2[]): DetectedRoom => ({ name, polygon, heatedGuess: guess });

describe('proposeHeatedOutline', () => {
  // Maison de démonstration, dessinée en centimètres : corps 10 × 8 m, garage 4 × 4 m accolé à droite en bas.
  // Le garage n'a de murs propres (24 cm) que sur trois côtés : il s'adosse au mur est de la maison.
  const DEMO_OUTLINE: Vec2[] = [
    { x: 200, y: 1000 },
    { x: 200, y: 200 },
    { x: 1200, y: 200 },
    { x: 1200, y: 600 },
    { x: 1600, y: 600 },
    { x: 1600, y: 1000 },
  ];
  const DEMO_ROOMS: DetectedRoom[] = [
    room('Séjour', 'yes', rect(240, 240, 755, 960)),
    room('Cuisine', 'yes', rect(770, 670, 1160, 960)),
    room('Hall', 'yes', rect(770, 440, 1160, 655)),
    room('WC', 'yes', rect(770, 240, 900, 425)),
    room('Buanderie', 'ask', rect(915, 240, 1160, 425)),
    room('Garage', 'no', rect(1200, 624, 1576, 976)),
  ];

  it('maison de démonstration : garage accolé retiré, mur de refend marqué', () => {
    const p = proposeHeatedOutline(DEMO_OUTLINE, DEMO_ROOMS, 0.01);
    expect(p).not.toBeNull();
    // 96 m² d'emprise − 4 × 4 m de garage (murs compris) = 80 m²
    expect(polygonArea(p!.outline) * 1e-4).toBeCloseTo(80, 2);
    expect(p!.removed.map((r) => r.name)).toEqual(['Garage']);
    expect(p!.removed[0]!.footprint).toBeCloseTo(16, 2);
    expect(p!.kept).toEqual([]);
    const lengths = (kind: string): number[] =>
      p!.outline
        .map((_, i) => {
          const [a, b] = edgeEnds(p!.outline, i);
          return { kind: p!.boundaries[i], len: Math.hypot(b.x - a.x, b.y - a.y) * 0.01 };
        })
        .filter((e) => e.kind === kind)
        .map((e) => Math.round(e.len * 100) / 100)
        .sort((x, y) => x - y);
    // Le mur est (8 m) est coupé en deux : 4 m de façade, 4 m contre le garage.
    expect(lengths('unheated')).toEqual([4]);
    expect(lengths('outside')).toEqual([4, 8, 10, 10]);
  });

  it('createStorey : le contour proposé est le contour chauffé ; la porte du garage ne suit pas', () => {
    const model = createEmptyProject('fr').model;
    const sheet = {
      id: 'p1',
      name: 'Rez-de-chaussée',
      bbox: { minX: 0, minY: 0, maxX: 1800, maxY: 1200 },
      metresPerUnit: { value: 0.01, from: 'plan' as const },
      detected: {
        outline: DEMO_OUTLINE,
        rooms: DEMO_ROOMS.map((r) => ({ ...r, statedArea: 10 })),
        openings: [
          { kind: 'door' as const, a: { x: 1513, y: 1000 }, b: { x: 1263, y: 1000 }, width: 2.5, exterior: true }, // porte du garage
          { kind: 'window' as const, a: { x: 620, y: 1000 }, b: { x: 380, y: 1000 }, width: 2.4, exterior: true }, // baie du séjour
          { kind: 'door' as const, a: { x: 1200, y: 570 }, b: { x: 1200, y: 470 }, width: 1, exterior: true }, // porte d'entrée, façade est
        ],
        notes: [],
      },
    };
    const storey = createStorey(sheet, 'Rez-de-chaussée', model);
    expect(polygonArea(storey.outline) * 1e-4).toBeCloseTo(80, 2);
    expect(storey.edges.filter((e) => e.boundary === 'unheated')).toHaveLength(1);
    expect(storey.edges).toHaveLength(storey.outline.length);
    expect(storey.openings.map((o) => o.width).sort()).toEqual([1, 2.4]);
    for (const o of storey.openings) expect(storey.edges[o.edgeIndex]!.boundary).toBe('outside');
    // Le garage reste visible comme pièce non comptée dans An, et n'est plus à l'intérieur du contour.
    expect(storey.rooms.find((r) => r.name === 'Garage')).toMatchObject({ heated: false, needsReview: false });
    expect(unheatedRoomsInsideOutline(storey)).toEqual([]);
    const sheets = deriveSheets({ version: 1, model: { ...model, storeys: [storey] }, answers: createEmptyProject('fr').answers }, 'fr');
    expect(sheets.findings.map((f) => f.code)).not.toContain('outline.containsUnheated');
    // Sans échelle lue, les seuils (en mètres) n'ont pas de sens : l'emprise est gardée telle quelle.
    const noScale = createStorey({ ...sheet, metresPerUnit: null }, 'RDC', model);
    expect(noScale.outline).toHaveLength(6);

    // L'expert juge que le garage EST dans l'enveloppe : toute l'emprise revient, avec la porte du garage.
    expect(roomsOutsideOutline(storey, sheet).map((r) => r.name)).toEqual(['Garage']);
    const edited: Storey = {
      ...storey,
      edges: storey.edges.map((e) => (e.boundary === 'outside' ? { ...e, constructionId: 'mur-brique' } : e)),
      openings: storey.openings.map((o) => (o.width === 2.4 ? { ...o, height: 2.2, from: 'user' } : o)),
    };
    const restored = restoreFootprint(edited, sheet)!;
    expect(polygonArea(restored.outline) * 1e-4).toBeCloseTo(96, 2);
    expect(restored.edges).toHaveLength(6);
    expect(roomsOutsideOutline(restored, sheet)).toEqual([]);
    // Les façades déjà présentes gardent leur type de mur ; les murs du garage arrivent avec le type par défaut.
    expect(restored.edges.filter((e) => e.constructionId === 'mur-brique')).toHaveLength(4);
    expect(restored.edges.every((e) => e.boundary === 'outside')).toBe(true);
    // La baie corrigée par l'expert garde sa correction ; la porte du garage revient.
    expect(restored.openings.map((o) => o.width).sort()).toEqual([1, 2.4, 2.5]);
    expect(restored.openings.find((o) => o.width === 2.4)).toMatchObject({ height: 2.2, from: 'user' });
    expect(new Set(restored.openings.map((o) => o.id)).size).toBe(3);
    // Le garage est de nouveau dans le contour sans être compté dans An : l'expert doit trancher.
    expect(unheatedRoomsInsideOutline(restored).map((r) => r.name)).toEqual(['Garage']);
    // Et retour : le retrait à la demande redonne le contour chauffé.
    const garage = restored.rooms.find((r) => r.name === 'Garage')!;
    const again = excludeRoomFromOutline(restored, garage.id)!;
    expect(polygonArea(again.outline) * 1e-4).toBeCloseTo(80, 2);
    expect(again.openings.map((o) => o.width).sort()).toEqual([1, 2.4]);
    expect(restoreFootprint(storey, null)).toBeNull();
  });

  it('étage sans local non chauffé : rien à proposer', () => {
    const rooms = [room('Chambre 1', 'yes', rect(145, 600, 585, 960)), room('Bureau', 'yes', rect(820, 240, 1065, 445))];
    expect(proposeHeatedOutline(rect(105, 200, 1105, 1000), rooms, 0.01)).toBeNull();
  });

  it('garage intégré dans un angle du rectangle (deux faces intérieures)', () => {
    // Maison 12 × 9 m en mètres, murs de 0,40 ; garage intérieur 3,5 × 5 dans l'angle bas-droit.
    const outline = rect(0, 0, 12, 9);
    const rooms = [
      room('Séjour', 'yes', rect(0.4, 0.4, 7.9, 8.6)),
      room('Cuisine', 'yes', rect(8.1, 0.4, 11.6, 3.4)),
      room('Garage', 'no', rect(8.1, 3.6, 11.6, 8.6)),
    ];
    const p = proposeHeatedOutline(outline, rooms, 1);
    expect(p).not.toBeNull();
    // Emprise retirée : garage 3,5 × 5 + murs extérieurs (0,4) à droite et en bas → (3,5+0,4) × (5+0,4) = 21,06
    expect(polygonArea(p!.outline)).toBeCloseTo(108 - 21.06, 1);
    expect(p!.boundaries.filter((b) => b === 'unheated').length).toBe(2);
  });

  it('garage au cœur du bâtiment : gardée, rien de retiré', () => {
    const outline = rect(0, 0, 12, 9);
    const rooms = [
      room('Séjour', 'yes', rect(0.4, 0.4, 5, 8.6)),
      room('Garage', 'no', rect(5.2, 3, 7, 6)),
      room('Chambre', 'yes', rect(7.2, 0.4, 11.6, 8.6)),
    ];
    const p = proposeHeatedOutline(outline, rooms, 1);
    expect(p?.removed).toEqual([]);
    expect(p?.kept).toEqual(['Garage']);
    expect(p?.outline).toEqual(outline);
  });

  it('terrasse hors du contour : ignorée', () => {
    const outline = rect(0, 0, 10, 8);
    const rooms = [room('Séjour', 'yes', rect(0.4, 0.4, 9.6, 7.6)), room('Terrasse', 'no', rect(10.5, 2, 14, 6))];
    expect(proposeHeatedOutline(outline, rooms, 1)).toBeNull();
  });

  it('sans échelle : rien', () => {
    const outline = rect(0, 0, 10, 8);
    expect(proposeHeatedOutline(outline, [room('Garage', 'no', rect(6, 4, 9.7, 7.7))], null)).toBeNull();
  });

  it('garage accolé, maison tournée de 17° et dessinée en millimètres', () => {
    const rot = (p: Vec2): Vec2 => {
      const a = (17 * Math.PI) / 180;
      return { x: (p.x * Math.cos(a) - p.y * Math.sin(a)) * 1000, y: (p.x * Math.sin(a) + p.y * Math.cos(a)) * 1000 };
    };
    const outline = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 14, y: 4 },
      { x: 14, y: 8 },
      { x: 0, y: 8 },
    ].map(rot);
    const rooms = [
      room('Wohnzimmer', 'yes', rect(0.365, 0.365, 9.635, 7.635).map(rot)),
      room('Garage', 'no', rect(10, 4.24, 13.76, 7.76).map(rot)),
    ];
    const p = proposeHeatedOutline(outline, rooms, 0.001);
    expect(p).not.toBeNull();
    expect(polygonArea(p!.outline) * 1e-6).toBeCloseTo(80, 1);
    expect(p!.outline.length).toBe(5);
  });

  it('seul local connu = le garage (aucune pièce chauffée lue) : retrait quand même, sans protection', () => {
    const outline = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 14, y: 4 },
      { x: 14, y: 8 },
      { x: 0, y: 8 },
    ];
    const p = proposeHeatedOutline(outline, [room('Garage', 'no', rect(10, 4.24, 13.76, 7.76))], 1);
    expect(p).not.toBeNull();
    expect(polygonArea(p!.outline)).toBeGreaterThan(79.5);
    expect(polygonArea(p!.outline)).toBeLessThan(80.5);
  });

  it('retrait à la demande : arêtes, types de mur et ouvertures suivent ; la porte du garage disparaît', () => {
    // Emprise en L (mètres) : maison 10 × 8 + garage 4 × 4 accolé à droite en bas.
    const outline = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 14, y: 4 },
      { x: 14, y: 8 },
      { x: 0, y: 8 },
    ];
    const storey: Storey = {
      id: 's1',
      name: 'RDC',
      sheetId: null,
      outline,
      edges: [
        { boundary: 'outside', constructionId: 'mur-nord' },
        { boundary: 'outside', constructionId: null },
        { boundary: 'outside', constructionId: null },
        { boundary: 'outside', constructionId: null },
        { boundary: 'outside', constructionId: 'mur-sud' },
        { boundary: 'heated', constructionId: null },
      ],
      metresPerUnit: { value: 1, from: 'user' },
      grossHeight: { value: 2.8, from: 'user' },
      clearHeight: { value: 2.5, from: 'user' },
      openings: [
        { id: 'o1', edgeIndex: 0, kind: 'window', width: 1.2, height: 1.35, count: 1, position: 0.3, windowTypeId: null, from: 'plan' },
        // fenêtre sud de la maison : x = 14 - 0,75 × 14 = 3,5 sur l'arête 4 (14,8) → (0,8)
        { id: 'o2', edgeIndex: 4, kind: 'window', width: 2.4, height: 1.35, count: 1, position: 0.75, windowTypeId: null, from: 'plan' },
        // porte du garage : x = 14 - 0,15 × 14 = 11,9 sur la même arête
        { id: 'o3', edgeIndex: 4, kind: 'door', width: 2.5, height: 2.1, count: 1, position: 0.15, windowTypeId: null, from: 'plan' },
        { id: 'o4', edgeIndex: 5, kind: 'window', width: 1, height: 1.35, count: 1, position: 0.5, windowTypeId: null, from: 'plan' },
      ],
      rooms: [
        { id: 'r1', name: 'Séjour', area: { value: 60, from: 'plan' }, heated: true, needsReview: false, polygon: rect(0.4, 0.4, 9.6, 7.6) },
        { id: 'r2', name: 'Atelier', area: { value: 13, from: 'plan' }, heated: false, needsReview: true, polygon: rect(10, 4.24, 13.76, 7.76) },
      ],
      netAreaOverride: null,
    };
    expect(unheatedRoomsInsideOutline(storey)).toEqual([]); // pas encore tranché
    const next = excludeRoomFromOutline(storey, 'r2');
    expect(next).not.toBeNull();
    expect(polygonArea(next!.outline)).toBeCloseTo(80, 1);
    expect(next!.outline.length).toBe(next!.edges.length);
    const byBoundary = next!.edges.map((e) => `${e.boundary}:${e.constructionId ?? '-'}`).sort();
    expect(byBoundary).toEqual(['heated:-', 'outside:-', 'outside:mur-nord', 'outside:mur-sud', 'unheated:-'].sort());
    expect(next!.openings.map((o) => o.id)).toEqual(['o1', 'o2', 'o4']);
    const o2 = next!.openings.find((o) => o.id === 'o2')!;
    const [a, b] = edgeEnds(next!.outline, o2.edgeIndex);
    expect(a.x + (b.x - a.x) * o2.position).toBeCloseTo(3.5, 2);
    expect(next!.edges[o2.edgeIndex]!.constructionId).toBe('mur-sud');
    expect(next!.rooms.find((r) => r.id === 'r2')).toMatchObject({ heated: false, needsReview: false });
    expect(unheatedRoomsInsideOutline(next!)).toEqual([]); // le local est maintenant hors du contour
    // un local tranché non chauffé resté dans le contour est signalé
    const flagged = { ...storey, rooms: storey.rooms.map((r) => (r.id === 'r2' ? { ...r, needsReview: false } : r)) };
    expect(unheatedRoomsInsideOutline(flagged).map((r) => r.name)).toEqual(['Atelier']);
    // local sans polygone ou inconnu : null
    expect(excludeRoomFromOutline(storey, 'nope')).toBeNull();
    expect(remapOpenings(storey.openings, outline, outline, [0, 1, 2, 3, 4, 5], 0.02).length).toBe(4);
  });

  it('chaufferie contre la façade : laissée dans le contour (peut être dans l\u2019enveloppe), signalée dans kept', () => {
    const outline = rect(0, 0, 12, 9);
    const rooms = [
      room('Séjour', 'yes', rect(0.4, 0.4, 7.9, 8.6)),
      room('Chaufferie', 'no', rect(8.1, 3.6, 11.6, 8.6)),
      room('Garage', 'no', rect(8.1, 0.4, 11.6, 3.4)),
    ];
    const p = proposeHeatedOutline(outline, rooms, 1);
    expect(p?.removed.map((r) => r.name)).toEqual(['Garage']);
    expect(p?.kept).toEqual(['Chaufferie']);
  });
});

describe('contour retracé : rien ne se perd en silence', () => {
  const base = (): Storey => ({
    id: 's1',
    name: 'RDC',
    sheetId: null,
    outline: rect(0, 0, 10, 8),
    // haut : extérieur · droite : mitoyen chauffé · bas : extérieur (type « brique ») · gauche : contre terre
    edges: [
      { boundary: 'outside', constructionId: null },
      { boundary: 'heated', constructionId: null },
      { boundary: 'outside', constructionId: 'brique' },
      { boundary: 'ground', constructionId: null },
    ],
    metresPerUnit: { value: 1, from: 'user' },
    grossHeight: { value: 2.8, from: 'user' },
    clearHeight: { value: 2.5, from: 'user' },
    openings: [
      { id: 'o1', edgeIndex: 0, kind: 'window', width: 1.2, height: 1.35, count: 1, position: 0.3, windowTypeId: null, from: 'plan' },
      { id: 'o2', edgeIndex: 2, kind: 'door', width: 1, height: 2.1, count: 1, position: 0.5, windowTypeId: null, from: 'user' },
    ],
    rooms: [],
    netAreaOverride: null,
  });
  /** Ce que rend l'éditeur après « Retracer » : nouveau contour, façades remises à zéro, ouvertures retirées. */
  const retraced = (outline: Vec2[]): Storey => ({
    ...base(),
    outline,
    edges: outline.map(() => ({ boundary: 'outside' as const, constructionId: null })),
    openings: [],
  });

  it('le même rectangle redessiné à 3 cm près garde ses façades et ses ouvertures', () => {
    const r = carryOverFromPrevious(base(), retraced(rect(0.03, 0.02, 10.03, 8.02)));
    expect(r.lostOpenings).toBe(0);
    expect(r.lostBoundaries).toBe(0);
    expect(r.storey.edges.map((e) => `${e.boundary}:${e.constructionId ?? '-'}`)).toEqual(['outside:-', 'heated:-', 'outside:brique', 'ground:-']);
    expect(r.storey.openings.map((o) => [o.id, o.edgeIndex])).toEqual([['o1', 0], ['o2', 2]]);
    expect(r.storey.openings[0]!.position).toBeCloseTo(0.297, 2);
  });

  it('un mur réellement déplacé perd son réglage et ses ouvertures, et le compte est rendu', () => {
    // La façade du bas recule de 2 m (8 → 6) : sa porte et son type de mur n'ont plus de mur.
    const r = carryOverFromPrevious(base(), retraced(rect(0, 0, 10, 6)));
    expect(r.lostOpenings).toBe(1);
    expect(r.lostBoundaries).toBe(1);
    expect(r.storey.openings.map((o) => o.id)).toEqual(['o1']);
    // Les deux murs latéraux, raccourcis mais restés en place, gardent leur réglage.
    expect(r.storey.edges.map((e) => e.boundary)).toEqual(['outside', 'heated', 'outside', 'ground']);
    expect(r.storey.edges[2]!.constructionId).toBeNull();
  });

  it('ne touche à rien quand le contour n’a pas changé, ni à ce que l’éditeur a déjà conservé', () => {
    const same = base();
    expect(carryOverFromPrevious(same, { ...same, name: 'autre' }).storey.name).toBe('autre');
    // Sommet glissé : l'éditeur garde arêtes et ouvertures ; rien n'est dupliqué.
    const dragged: Storey = { ...base(), outline: [{ x: 0, y: 0 }, { x: 10.5, y: 0 }, { x: 10.5, y: 8 }, { x: 0, y: 8 }] };
    const r = carryOverFromPrevious(base(), dragged);
    expect(r.storey.openings).toHaveLength(2);
    expect(r.storey.edges.map((e) => e.boundary)).toEqual(['outside', 'heated', 'outside', 'ground']);
    expect(r.lostOpenings + r.lostBoundaries).toBe(0);
  });
});
