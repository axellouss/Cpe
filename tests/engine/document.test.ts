/**
 * Du plan lu au premier jet de bâtiment : createStorey (une feuille → un étage) et modelFromDocument
 * (un document → tous les étages chauffés, dans l'ordre, avec les hypothèses de départ marquées « par défaut »).
 */
import { describe, expect, it } from 'vitest';
import type { PlanDocument, PlanSheet } from '../../src/core/types';
import {
  basementSheetIds,
  createEmptyProject,
  createStorey,
  deriveSheets,
  isBasementSheetName,
  modelFromDocument,
  orderSheetsBottomUp,
  proposeTopClosure,
  rescaleStorey,
} from '../../src/engine';
import { brief, codes, rect, sheet } from './helpers';

const emptyModel = () => createEmptyProject('fr').model;

/** Rez-de-chaussée de 10 × 8 m dessiné en CENTIMÈTRES (1 unité = 1 cm), tel qu'un lecteur DXF le rendrait. */
function groundFloorSheet(): PlanSheet {
  return sheet('s1', 'Plan RDC', {
    metresPerUnit: { value: 0.01, from: 'plan', note: 'Unités du dessin : centimètres' },
    detected: {
      // Contour refermé par un point doublon, comme le font souvent les polylignes CAO
      outline: [...rect(1000, 800), { x: 0, y: 0 }],
      openings: [
        // Fenêtre dessinée dans l'épaisseur du mur nord (15 cm sous le nu extérieur), de x = 200 à 320 → 1,20 m
        { kind: 'window', a: { x: 200, y: 15 }, b: { x: 320, y: 15 } },
        // Porte dans le mur est, dimensions lues dans le nom du bloc
        { kind: 'door', a: { x: 980, y: 300 }, b: { x: 980, y: 390 }, width: 0.9, height: 2.1, exterior: true },
        // Symbole non reconnu dans le mur sud, de x = 400 à 600 → traité comme une fenêtre de 2,00 m
        { kind: 'unknown', a: { x: 400, y: 790 }, b: { x: 600, y: 790 } },
        // Porte intérieure : ignorée
        { kind: 'door', a: { x: 500, y: 300 }, b: { x: 500, y: 380 }, exterior: false },
        // Trait pris pour une fenêtre au milieu du séjour, à 4 m de toute façade : rejeté
        { kind: 'window', a: { x: 450, y: 400 }, b: { x: 550, y: 400 } },
      ],
      rooms: [
        { name: 'Séjour', statedArea: 32.45, measuredArea: 32.9, heatedGuess: 'yes', at: { x: 300, y: 300 } },
        { name: 'Cuisine', measuredArea: 11.2, heatedGuess: 'yes', polygon: rect(400, 280, 550, 30) },
        { name: 'Buanderie', statedArea: 6.5, heatedGuess: 'ask' },
        { name: 'Garage', heatedGuess: 'no' },
        { name: 'Hall', heatedGuess: 'yes' },
      ],
      storeyHeight: 2.95,
      notes: [],
    },
  });
}

describe('createStorey : une feuille → un étage proposé', () => {
  const source = groundFloorSheet();
  const s = createStorey(source, 'Rez-de-chaussée', emptyModel());

  it('reprend contour (sans le point doublon), échelle, et met toutes les façades « contre extérieur »', () => {
    expect(s).toMatchObject({ id: 'storey-1', name: 'Rez-de-chaussée', sheetId: 's1', netAreaOverride: null });
    expect(s.outline).toEqual(rect(1000, 800));
    expect(s.edges).toEqual(Array(4).fill({ boundary: 'outside', constructionId: null }));
    expect(s.metresPerUnit).toEqual({ value: 0.01, from: 'plan', note: 'Unités du dessin : centimètres' });
  });

  it('prend les hauteurs du plan quand elles existent, sinon 2,80 / 2,50 m « par défaut »', () => {
    expect(s.grossHeight).toEqual({ value: 2.95, from: 'plan' });
    expect(s.clearHeight).toEqual({ value: 2.5, from: 'default' });
    const bare = createStorey(sheet('x', 'Plan', { detected: { outline: rect(10, 8), rooms: [], openings: [], clearHeight: 2.42, notes: [] } }), 'Niveau', emptyModel());
    expect(bare.grossHeight).toEqual({ value: 2.8, from: 'default' });
    expect(bare.clearHeight).toEqual({ value: 2.42, from: 'plan' });
  });

  it('rattache les ouvertures extérieures à la façade la plus proche', () => {
    expect(s.openings.map((o) => [o.kind, o.edgeIndex, o.width, o.height, o.from])).toEqual([
      ['window', 0, 1.2, 1.35, 'default'], // largeur mesurée 120 cm ; hauteur inconnue → 1,35 m par défaut
      ['door', 1, 0.9, 2.1, 'plan'], // dimensions lues
      ['window', 2, 2, 1.35, 'default'], // genre inconnu → fenêtre
    ]);
    // Position du centre le long de l'arête : fenêtre nord à x = 260 sur 1000 ; porte est à y = 345 sur 800
    expect(s.openings[0]!.position).toBeCloseTo(0.26);
    expect(s.openings[1]!.position).toBeCloseTo(0.43125);
    expect(s.openings.every((o) => o.count === 1 && o.windowTypeId === null)).toBe(true);
    expect(new Set(s.openings.map((o) => o.id)).size).toBe(3);
  });

  it('une porte sans hauteur lue prend 2,10 m par défaut', () => {
    const src = groundFloorSheet();
    src.detected.openings = [{ kind: 'door', a: { x: 980, y: 300 }, b: { x: 980, y: 390 } }];
    expect(createStorey(src, 'RDC', emptyModel()).openings.map((o) => [o.kind, o.width, o.height, o.from])).toEqual([['door', 0.9, 2.1, 'default']]);
  });

  it('tolère 0,60 m d’écart au contour, ou 5 % de la longueur de la façade si elle est longue', () => {
    const at = (offsetCm: number, widthCm = 1000) => {
      const src = sheet('s', 'Plan', {
        metresPerUnit: { value: 0.01, from: 'plan' },
        detected: {
          outline: rect(widthCm, 800),
          rooms: [],
          notes: [],
          openings: [{ kind: 'window', a: { x: 200, y: offsetCm }, b: { x: 320, y: offsetCm } }],
        },
      });
      return createStorey(src, 'RDC', emptyModel()).openings.length;
    };
    expect(at(55)).toBe(1); // 0,55 m du nu extérieur : mur épais, accepté
    expect(at(70)).toBe(0); // 0,70 m > max(0,60 ; 5 % × 10 m = 0,50)
    expect(at(70, 3000)).toBe(1); // façade de 30 m : 5 % = 1,50 m
  });

  it('prend la surface écrite, sinon la surface mesurée ; propose le classement des pièces', () => {
    expect(s.rooms.map((r) => [r.name, r.area.value, r.area.from, r.heated, r.needsReview])).toEqual([
      ['Séjour', 32.45, 'plan', true, false], // la surface écrite prime sur la surface mesurée
      ['Cuisine', 11.2, 'plan', true, false],
      ['Buanderie', 6.5, 'plan', false, true], // ambiguë → à trancher, non comptée d'ici là
      ['Garage', 0, 'default', false, true], // surface inconnue → à revoir
      ['Hall', 0, 'default', true, true],
    ]);
    expect(s.rooms[0]!.at).toEqual({ x: 300, y: 300 });
    expect(s.rooms[1]!.polygon).toEqual(rect(400, 280, 550, 30));
  });

  it('donne un étage directement calculable', () => {
    const model = { ...emptyModel(), storeys: [s] };
    const d = deriveSheets({ version: 1, model, answers: createEmptyProject('fr').answers }, 'fr');
    expect(d.envelope.map(brief)).toEqual([
      'window N 1 × 1.20 × 1.35 Abzug',
      'wall N 1 × 10.00 × 2.95',
      'door E 1 × 0.90 × 2.10 Abzug',
      'wall E 1 × 8.00 × 2.95',
      'window S 1 × 2.00 × 1.35 Abzug',
      'wall S 1 × 10.00 × 2.95',
      'wall W 1 × 8.00 × 2.95',
      'ceiling H 1 × 10.00 × 8.00',
      'floor H 1 × 10.00 × 8.00',
    ]);
    // An provisoire = Séjour 32,45 + Cuisine 11,2 + Hall 0 = 43,65 m² ; 3 pièces restent à trancher
    expect(d.totals.an).toBe(43.65);
    expect(d.findings.find((f) => f.code === 'rooms.needReview')!.params.count).toBe(3);
    // Tout ce qui est « par défaut » est signalé : nord, toiture, plancher bas, hauteur libre
    expect(codes(d)).toEqual(expect.arrayContaining(['north.default', 'top.default', 'bottom.default', 'clearHeight.default']));
    expect(codes(d)).not.toContain('height.default'); // la hauteur d'étage vient du plan
    // Une fenêtre à hauteur par défaut rend sa ligne « à confirmer »
    expect(d.envelope[0]!.from).toBe('default');
  });

  it('feuille sans échelle : 1 unité = 1 m en « estimation », ce qui bloquera le calcul', () => {
    const src = groundFloorSheet();
    src.metresPerUnit = null;
    const unscaled = createStorey(src, 'RDC', emptyModel());
    expect(unscaled.metresPerUnit).toEqual({ value: 1, from: 'estimate' });
    const d = deriveSheets({ version: 1, model: { ...emptyModel(), storeys: [unscaled] }, answers: createEmptyProject('fr').answers }, 'fr');
    expect(d.findings.find((f) => f.code === 'scale.unconfirmed')!.severity).toBe('block');
  });

  it('feuille sans contour détecté, ou pas de feuille du tout : étage vide', () => {
    const noOutline = createStorey(sheet('s9', 'Scan'), 'Niveau', emptyModel());
    expect(noOutline).toMatchObject({ sheetId: 's9', outline: [], edges: [], openings: [], rooms: [] });
    const blank = createStorey(null, 'Étage', emptyModel());
    expect(blank).toMatchObject({ sheetId: null, name: 'Étage', outline: [], edges: [], openings: [], rooms: [], netAreaOverride: null });
    // Sans plan, l'expert trace directement en mètres : l'échelle est la sienne
    expect(blank.metresPerUnit).toEqual({ value: 1, from: 'user' });
    expect(blank.grossHeight).toEqual({ value: 2.8, from: 'default' });
    expect(blank.clearHeight).toEqual({ value: 2.5, from: 'default' });
  });

  it('donne un identifiant qui ne heurte aucun étage existant', () => {
    const model = emptyModel();
    model.storeys.push(createStorey(null, 'A', model));
    model.storeys.push(createStorey(null, 'B', model));
    model.storeys.shift(); // l'expert supprime le premier
    model.storeys.push(createStorey(null, 'C', model));
    expect(model.storeys.map((x) => x.id)).toEqual(['storey-2', 'storey-3']);
  });
});

describe('rescaleStorey : poser la règle après coup', () => {
  it('les largeurs mesurées avec une échelle inconnue suivent la nouvelle échelle ; les largeurs lues ou saisies ne bougent pas', () => {
    const src = groundFloorSheet();
    src.metresPerUnit = null; // échelle inconnue à la lecture : les 120 unités de la fenêtre deviennent « 120 m »
    const raw = createStorey(src, 'RDC', emptyModel());
    expect(raw.openings.map((o) => [o.width, o.from])).toEqual([
      [120, 'estimate'], // mesurée sur la feuille sans échelle : à remplacer
      [0.9, 'plan'], // lue dans le nom du bloc : indépendante de l'échelle
      [200, 'estimate'],
    ]);
    raw.openings[2] = { ...raw.openings[2]!, width: 1.8, from: 'user' }; // l'expert corrige la baie du sud à la main
    const fixed = rescaleStorey(raw, { value: 0.01, from: 'user' });
    expect(fixed.metresPerUnit).toEqual({ value: 0.01, from: 'user' });
    expect(fixed.openings.map((o) => [o.width, o.from])).toEqual([
      [1.2, 'default'], // 120 unités × 0,01 ; reste « à confirmer » (hauteur par défaut)
      [0.9, 'plan'],
      [1.8, 'user'],
    ]);
    expect(raw.openings[0]!.width).toBe(120); // l'étage d'origine n'est pas modifié
    expect(raw.metresPerUnit).toEqual({ value: 1, from: 'estimate' });
  });

  it('une échelle lue puis corrigée : largeurs mesurées et surfaces mesurées suivent, ce qui est écrit sur le plan ne bouge pas', () => {
    // Feuille dessinée en centimètres, que le lecteur a crue à 0,0108 m par unité (8 % de trop).
    const src = sheet('p', 'RDC', {
      metresPerUnit: { value: 0.0108, from: 'plan' },
    });
    src.detected = {
      notes: [],
      outline: rect(1000, 800),
      rooms: [
        // surface mesurée sur le polygone (800 × 500 unités → 46,66 m² à la mauvaise échelle)
        { name: 'Séjour', measuredArea: 46.656, heatedGuess: 'yes', polygon: rect(800, 500) },
        // surface ÉCRITE sur le plan : indépendante de l'échelle
        { name: 'Cuisine', statedArea: 9.75, measuredArea: 11.37, heatedGuess: 'yes', polygon: rect(650, 150) },
      ],
      openings: [
        // largeur donnée par le lecteur d'après le tracé (120 unités × 0,0108) : c'est une mesure
        { kind: 'window', a: { x: 100, y: 0 }, b: { x: 220, y: 0 }, width: 1.296, exterior: true },
        // largeur lue dans le nom du bloc (« P 90 ») alors que le tracé fait 100 unités : c'est un texte
        { kind: 'door', a: { x: 400, y: 0 }, b: { x: 500, y: 0 }, width: 0.9, exterior: true },
        // sans largeur : mesurée par le moteur
        { kind: 'window', a: { x: 600, y: 800 }, b: { x: 800, y: 800 }, exterior: true },
      ],
    };
    const raw = createStorey(src, 'RDC', emptyModel());
    expect(raw.openings.map((o) => o.width)).toEqual([1.296, 0.9, 2.16]);
    expect(raw.rooms.map((r) => r.area.value)).toEqual([46.656, 11.37]); // 9,75 écrit ≠ 11,37 mesuré → mesure retenue
    const fixed = rescaleStorey(raw, { value: 0.01, from: 'user' });
    expect(fixed.openings.map((o) => o.width)).toEqual([1.2, 0.9, 2]);
    // Séjour : 800 × 500 unités × 0,01² = 40,00 m² ; Cuisine : 650 × 150 × 0,01² = 9,75 m² — la surface écrite
    expect(fixed.rooms.map((r) => r.area.value)).toEqual([40, 9.75]);
    // Une largeur saisie par l'expert ne suit plus rien.
    const typed = { ...raw, openings: raw.openings.map((o, i) => (i === 0 ? { ...o, width: 1.25, from: 'user' as const } : o)) };
    expect(rescaleStorey(typed, { value: 0.01, from: 'user' }).openings[0]!.width).toBe(1.25);
    const typedRoom = { ...raw, rooms: raw.rooms.map((r, i) => (i === 0 ? { ...r, area: { value: 41, from: 'user' as const } } : r)) };
    expect(rescaleStorey(typedRoom, { value: 0.01, from: 'user' }).rooms[0]!.area.value).toBe(41);
  });

  it('une surface écrite sur le plan ne bouge pas quand on pose la règle, même si elle vaut presque l’aire du polygone', () => {
    const src = sheet('p', 'RDC', { metresPerUnit: { value: 0.01, from: 'plan' } });
    src.detected = {
      notes: [],
      outline: rect(1000, 800),
      openings: [],
      rooms: [
        // écrit 12,00 m², polygone de 12,20 m² (1,6 % d'écart) : c'est la surface ÉCRITE qui est retenue
        { name: 'Chambre', statedArea: 12, measuredArea: 12.2, heatedGuess: 'yes', polygon: rect(400, 305) },
        // rien d'écrit : surface mesurée
        { name: 'Bureau', measuredArea: 20, heatedGuess: 'yes', polygon: rect(500, 400) },
      ],
    };
    const raw = createStorey(src, 'RDC', emptyModel());
    expect(raw.rooms.map((r) => [r.area.value, r.sheetArea !== undefined])).toEqual([[12, false], [20, true]]);
    // La règle ne retombe jamais exactement sur l'ancienne échelle : ici +0,04 %, puis un facteur 2.
    const nudged = rescaleStorey(raw, { value: 10 / 999.6, from: 'user' });
    expect(nudged.rooms[0]!.area.value).toBe(12);
    expect(nudged.rooms[1]!.area.value).toBeCloseTo(20.02, 2);
    const doubled = rescaleStorey(raw, { value: 0.02, from: 'user' });
    expect(doubled.rooms.map((r) => r.area.value)).toEqual([12, 80]);
  });
});

describe('modelFromDocument : un document → premier jet de bâtiment', () => {
  const withOutline = (id: string, name: string, w: number, d: number, elevation?: number): PlanSheet =>
    sheet(id, name, {
      detected: elevation === undefined ? { outline: rect(w, d), rooms: [], openings: [], notes: [] } : { outline: rect(w, d), rooms: [], openings: [], notes: [], elevation },
    });
  const doc = (sheets: PlanSheet[], patch: Partial<PlanDocument> = {}): PlanDocument => ({
    fileName: 'maison.dxf',
    kind: 'dxf',
    sheets,
    storeysAligned: false,
    warnings: [],
    ...patch,
  });

  it('trie les niveaux reconnus du bas vers le haut, ignore les feuilles sans contour et sort le sous-sol du volume chauffé', () => {
    const model = modelFromDocument(
      doc([
        withOutline('a', 'Plan 1er étage', 10, 8),
        sheet('b', 'Coupe A-A'), // pas de contour
        withOutline('c', 'Plan sous-sol', 10, 8),
        withOutline('d', 'Combles aménagés', 10, 6),
        withOutline('e', 'Plan RDC 1:100', 10, 8),
      ]),
      'fr',
    );
    expect(model.storeys.map((s) => [s.id, s.name, s.sheetId])).toEqual([
      ['storey-1', 'Rez-de-chaussée', 'e'],
      ['storey-2', '1er étage', 'a'],
      ['storey-3', 'Combles', 'd'],
    ]);
    // Un sous-sol reconnu n'est pas compté chauffé : le RDC repose sur un local non chauffé (hypothèse à confirmer)
    expect(model.bottom).toEqual({ kind: 'above-unheated', constructionId: null, from: 'default' });
  });

  it('nomme les niveaux dans la langue demandée', () => {
    const sheets = [withOutline('a', 'Grundriss 1. OG', 10, 8), withOutline('e', 'Grundriss EG', 10, 8), withOutline('k', 'Kellergeschoss', 10, 8)];
    expect(modelFromDocument(doc(sheets), 'de').storeys.map((s) => s.name)).toEqual(['Erdgeschoss', '1. Obergeschoss']);
    expect(modelFromDocument(doc(sheets), 'fr').storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée', '1er étage']);
    expect(modelFromDocument(doc(sheets), 'de').constructions[0]!.name).toBe('Außenwand');
  });

  it('préfère les altitudes quand toutes les feuilles en ont (IFC)', () => {
    const model = modelFromDocument(
      doc([withOutline('h', 'Niveau haut', 10, 8, 5.6), withOutline('b', 'Niveau bas', 10, 8, 0), withOutline('m', 'Niveau milieu', 10, 8, 2.8)], {
        kind: 'ifc',
        storeysAligned: true,
        northAngle: { value: 50, from: 'plan', note: 'IFC TrueNorth' },
      }),
      'fr',
    );
    // Noms non reconnus → on garde ceux des feuilles
    expect(model.storeys.map((s) => s.name)).toEqual(['Niveau bas', 'Niveau milieu', 'Niveau haut']);
    expect(model.storeysAligned).toBe(true);
    expect(model.northAngle).toEqual({ value: 50, from: 'plan', note: 'IFC TrueNorth' });
    // Pas de sous-sol reconnu → dalle sur terre-plein par défaut
    expect(model.bottom).toEqual({ kind: 'slab-on-ground', constructionId: null, from: 'default' });
  });

  it("une feuille au nom inconnu ne fait pas perdre l'ordre des niveaux reconnus : elle se range au-dessus d'eux", () => {
    const model = modelFromDocument(doc([withOutline('a', '1er étage', 10, 8), withOutline('x', 'Feuille 3', 10, 8), withOutline('e', 'RDC', 10, 8)]), 'fr');
    expect(model.storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée', '1er étage', 'Feuille 3']);
    // Aucun nom reconnu : l'ordre du document.
    const unknown = modelFromDocument(doc([withOutline('a', 'Plan B', 10, 8), withOutline('b', 'Plan A', 10, 8)]), 'fr');
    expect(unknown.storeys.map((s) => s.name)).toEqual(['Plan B', 'Plan A']);
  });

  it('distingue deux feuilles qui porteraient le même nom de niveau', () => {
    // Deux feuilles reconnues comme « Étage » : on garde leurs propres noms, plus parlants
    const wings = modelFromDocument(doc([withOutline('a', 'Étage aile A', 10, 8), withOutline('b', 'Étage aile B', 10, 8)]), 'fr');
    expect(wings.storeys.map((s) => s.name)).toEqual(['Étage aile A', 'Étage aile B']);
    // Deux feuilles de même nom : numérotées
    const twins = modelFromDocument(doc([withOutline('a', 'Plan', 10, 8), withOutline('b', 'Plan', 10, 8)]), 'fr');
    expect(twins.storeys.map((s) => s.name)).toEqual(['Plan', 'Plan (2)']);
  });

  it('un rez-de-jardin est un niveau habité : il reste un étage chauffé, sous le rez-de-chaussée ; seul un sous-sol est écarté', () => {
    const model = modelFromDocument(doc([withOutline('e', 'Rez-de-chaussée', 10, 8), withOutline('j', 'Rez-de-jardin', 10, 8)]), 'fr');
    expect(model.storeys.map((s) => s.name)).toEqual(['Rez-de-jardin', 'Rez-de-chaussée']);
    expect(model.bottom.kind).toBe('slab-on-ground');
    const withCellar = modelFromDocument(doc([withOutline('k', 'Sous-sol', 10, 8), withOutline('e', 'Rez-de-chaussée', 10, 8)]), 'fr');
    expect(withCellar.storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée']);
    expect(withCellar.bottom.kind).toBe('above-unheated');
  });

  it('murs de hauteurs inégales au dernier niveau : toiture inclinée proposée sous des combles, jamais sous un étage plein', () => {
    // Combles façon FZK-Haus : 12 × 10 m, jambette 0,67 m, faîtage 3,39 m → pente = atan(2,72 / 5) ≈ 28,5°
    const attic = withOutline('c', 'Dachgeschoss', 12, 10);
    attic.detected.storeyHeight = 3.39;
    attic.detected.eavesHeight = 0.67;
    const ground = withOutline('e', 'Erdgeschoss', 12, 10);
    ground.detected.storeyHeight = 2.7;
    const model = modelFromDocument(doc([ground, attic]), 'fr');
    expect(model.top).toMatchObject({ kind: 'pitched-roof', shape: 'gable', pitchDeg: 29, kneeWallHeight: 0.67, from: 'estimate' });
    expect(model.storeys[0]!.grossHeight).toEqual({ value: 2.7, from: 'plan' });
    // La hauteur lue au faîtage n'est pas une hauteur d'étage : jamais présentée comme « lue sur le plan ».
    expect(model.storeys[1]!.grossHeight).toEqual({ value: 3.39, from: 'estimate' });

    // Étage plein dont seuls des acrotères ou des pignons dépassent : pas de toiture inclinée d'office.
    const full = withOutline('n', 'Level 2', 12, 10);
    full.detected.storeyHeight = 3.51;
    full.detected.eavesHeight = 2.6;
    full.detected.clearHeight = 2.3;
    const flat = modelFromDocument(doc([full]), 'fr');
    expect(flat.top).toMatchObject({ kind: 'attic-ceiling', from: 'default' });
    expect(flat.storeys[0]!.grossHeight).toEqual({ value: 2.6, from: 'estimate' });
    // … et la hauteur proposée ne passe jamais sous la hauteur libre.
    full.detected.clearHeight = 2.5;
    expect(modelFromDocument(doc([full]), 'fr').storeys[0]!.grossHeight).toEqual({ value: 3.51, from: 'estimate' });
  });

  it('un plan de toiture ou une feuille minuscule ne devient pas un étage', () => {
    const model = modelFromDocument(
      doc([withOutline('a', 'Level 1', 14, 10), withOutline('b', 'Level 2', 12, 10), withOutline('r', 'Roof Line', 2, 3), withOutline('t', 'Roof', 14, 10)]),
      'fr',
    );
    expect(model.storeys.map((s) => s.name)).toEqual(['Level 1', 'Level 2']);
    // « Dachgeschoss » reste un étage ; une petite maison seule reste un étage.
    expect(modelFromDocument(doc([withOutline('d', 'Dachgeschoss', 10, 8)]), 'de').storeys).toHaveLength(1);
    expect(modelFromDocument(doc([withOutline('x', 'Abri', 3, 3)]), 'fr').storeys).toHaveLength(1);
  });

  it('surface d’une pièce : écrite si elle concorde avec la mesure, mesurée (avec les deux en note) si elles divergent', () => {
    const s = withOutline('c', 'Combles', 12, 10);
    s.detected.rooms = [
      { name: 'Galerie', statedArea: 74.51, measuredArea: 94.05, heatedGuess: 'yes' },
      { name: 'Chambre', statedArea: 21.41, measuredArea: 22.07, heatedGuess: 'yes' },
      { name: 'Bureau', measuredArea: 12.984, heatedGuess: 'yes' },
      { name: 'Hall', statedArea: 8, heatedGuess: 'yes' },
    ];
    const rooms = createStorey(s, 'Combles', createEmptyProject('fr').model).rooms;
    expect(rooms.map((r) => r.area)).toEqual([
      { value: 94.05, from: 'plan', note: '74.51 / 94.05' },
      { value: 21.41, from: 'plan' },
      { value: 12.984, from: 'plan' },
      { value: 8, from: 'plan' },
    ]);
  });

  it('dernier niveau d’une maquette : la hauteur mesurée au sommet des murs n’est pas « lue sur le plan »', () => {
    // Murs de 2,60 m sous une dalle de toiture de 25 cm : de dalle à dalle il y a 2,85 m, pas 2,60.
    const top = withOutline('e', 'Étage', 8, 6);
    top.detected.storeyHeight = 2.6;
    top.detected.storeyHeightToWallTop = true;
    const ground = withOutline('r', 'Rez-de-chaussée', 8, 6);
    ground.detected.storeyHeight = 2.8;
    const model = modelFromDocument(doc([ground, top]), 'fr');
    expect(model.storeys[0]!.grossHeight).toEqual({ value: 2.8, from: 'plan' });
    expect(model.storeys[1]!.grossHeight).toEqual({ value: 2.6, from: 'estimate' });
    const sheets = deriveSheets({ ...createEmptyProject('fr'), model }, 'fr');
    expect(sheets.findings.filter((f) => f.code === 'height.default').map((f) => f.params.storey)).toEqual(['Étage']);
  });

  it('range des feuilles du bas vers le haut, sous-sol compris, et sait dire ce qu’est un sous-sol', () => {
    const levels = [
      withOutline('d', 'Dachgeschoss', 10, 8, 5.61),
      withOutline('k', 'Keller', 10, 8, -2.805),
      withOutline('o', 'Obergeschoss', 10, 8, 2.805),
      withOutline('e', 'Erdgeschoss', 10, 8, 0),
    ];
    expect(orderSheetsBottomUp(levels).map((s) => s.name)).toEqual(['Keller', 'Erdgeschoss', 'Obergeschoss', 'Dachgeschoss']);
    // Sans altitude : par le rang des noms.
    const named = ['Combles', 'Sous-sol', 'Rez-de-chaussée'].map((n, i) => withOutline(String(i), n, 10, 8));
    expect(orderSheetsBottomUp(named).map((s) => s.name)).toEqual(['Sous-sol', 'Rez-de-chaussée', 'Combles']);
    expect(isBasementSheetName('Keller')).toBe(true);
    expect(isBasementSheetName('Sous-sol')).toBe(true);
    expect(isBasementSheetName('Rez-de-jardin')).toBe(false);
    expect(isBasementSheetName('Plan 3')).toBe(false);
  });

  it('un niveau enterré d’une maquette est proposé non chauffé d’après son altitude, quel que soit son nom', () => {
    const levels = [
      withOutline('g', 'Level A', 30, 30, -2.5),
      withOutline('e', 'Level B', 20, 10, 0),
      withOutline('o', 'Level C', 20, 10, 3),
    ];
    expect([...basementSheetIds(levels)]).toEqual(['g']);
    const model = modelFromDocument(doc(levels), 'fr');
    expect(model.storeys.map((s) => s.name)).toEqual(['Level B', 'Level C']);
    expect(model.bottom.kind).toBe('above-unheated');
    // Altitudes absolues (NGF) : le zéro ne dit rien, on ne déduit rien de l'altitude.
    const absolute = [withOutline('a', 'Level A', 20, 10, 312.5), withOutline('b', 'Level B', 20, 10, 315.3)];
    expect(basementSheetIds(absolute).size).toBe(0);
    // Un demi-niveau à −1,20 m n'est pas tenu pour enterré.
    const split = [withOutline('a', 'Level A', 20, 10, -1.2), withOutline('b', 'Level B', 20, 10, 0)];
    expect(basementSheetIds(split).size).toBe(0);
    // Sans altitude : le nom seul.
    expect([...basementSheetIds([withOutline('k', 'Keller', 10, 8), withOutline('e', 'Erdgeschoss', 10, 8)])]).toEqual(['k']);
  });

  it('propose la fermeture haute d’après la feuille du dernier étage, ou rien', () => {
    const attic = withOutline('c', 'Dachgeschoss', 12, 10);
    attic.detected.storeyHeight = 3.39;
    attic.detected.eavesHeight = 0.67;
    const model = createEmptyProject('fr').model;
    const storey = createStorey(attic, 'Combles', model);
    expect(proposeTopClosure(attic, storey)).toMatchObject({ kind: 'pitched-roof', pitchDeg: 29, kneeWallHeight: 0.67, from: 'estimate' });
    expect(proposeTopClosure(withOutline('p', 'Étage', 12, 10), storey)).toBeNull();
    expect(proposeTopClosure(null, storey)).toBeNull();
  });

  it('pose les hypothèses de départ, toutes marquées « par défaut »', () => {
    const model = modelFromDocument(doc([withOutline('e', 'RDC', 10, 8)]), 'fr');
    expect(model.top).toEqual({
      kind: 'attic-ceiling',
      pitchDeg: 35,
      shape: 'gable',
      ridgeAngle: null,
      kneeWallHeight: 0,
      constructionId: null,
      from: 'default',
    });
    expect(model.northAngle).toEqual({ value: 0, from: 'default' });
    expect(model.storeysAligned).toBe(false);
    expect(model.manualRows).toEqual([]);
    expect(model.constructions.map((c) => [c.id, c.name, c.category, c.u])).toEqual([
      ['wall-outside', 'Mur extérieur', 'wall', null],
      ['wall-ground', 'Mur contre terre', 'wall', null],
      ['wall-unheated', 'Mur contre local non chauffé', 'wall', null],
      ['roof', 'Toiture', 'roof', null],
      ['ceiling-attic', 'Plancher haut sous grenier non chauffé', 'ceiling', null],
      ['floor-ground', 'Dalle sur terre-plein', 'floor', null],
      ['floor-unheated', 'Plancher sur cave non chauffée', 'floor', null],
      ['floor-outside', 'Plancher sur extérieur', 'floor', null],
      ['door', 'Porte opaque', 'door', null],
    ]);
    expect(model.windowTypes).toEqual([{ id: 'window-default', name: 'Fenêtre', uw: null, g: null }]);
  });

  it('document sans aucun contour exploitable : bâtiment sans étage (le calcul dira « tracez un étage »)', () => {
    const model = modelFromDocument(doc([sheet('a', 'Scan 1'), sheet('b', 'Scan 2')]), 'fr');
    expect(model.storeys).toEqual([]);
    const d = deriveSheets({ version: 1, model, answers: createEmptyProject('fr').answers }, 'fr');
    expect(d.findings).toEqual([{ code: 'model.noStorey', severity: 'block', params: {} }]);
  });
});

describe('projet vide', () => {
  it('createEmptyProject : aucun étage, réponses vides', () => {
    const p = createEmptyProject('de');
    expect(p.version).toBe(1);
    expect(p.model.storeys).toEqual([]);
    expect(p.model.windowTypes[0]!.name).toBe('Fenster');
    expect(p.answers).toMatchObject({ projectName: '', street: '', postcode: '', locality: '', buildingType: null, yearBuilt: null, n50: null });
    expect(Object.values(p.answers).every((v) => v === '' || v === null)).toBe(true);
  });
});
