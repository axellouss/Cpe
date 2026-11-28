/**
 * Moteur ↔ interface : ce que le moteur donne à l'interface pour chaque question (endroit de la planche, étage et
 * outil à ouvrir), la qualité des questions telles que l'utilisateur les lit, et ce que le moteur prend des lecteurs
 * quand ils savent mieux que lui (plancher au-dessus d'un local non chauffé, hauteurs libres par niveau).
 * Documents fabriqués depuis la vérité des quatre planches synthétiques (données inventées).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlanDocument } from '../../src/core/types';
import { buildAutoProject, collectDoubts, createEmptyProject, deriveSheets, MAX_AUTO_DOUBTS } from '../../src/engine';
import { isRoomName } from '../../src/engine/doubts';
import { documentFromTruth, PLANCHES, readPlancheTruth, type PlancheName } from './auto-planche';

const docs = new Map<PlancheName, PlanDocument>();
beforeAll(async () => {
  for (const name of PLANCHES) docs.set(name, documentFromTruth(await readPlancheTruth(name)));
});
const doc = (name: PlancheName): PlanDocument => structuredClone(docs.get(name)!);

/** Phrases à trous ou noms vides qu'une question ne doit jamais montrer. */
const HOLES = /\?\s*\?|«\s*»|„\s*“|,\s*,|\(\s*\)|:\s*\?|\bundefined\b|\bnull\b|\bNaN\b|\{[a-z]+\}/;

describe.each(PLANCHES)('%s — questions vues par l’utilisateur', (name) => {
  for (const lang of ['fr', 'de'] as const) {
    it(`${lang} : aucune phrase à trous, endroit et étage à corriger cohérents, au plus huit cartes quand la lecture suffit`, () => {
      const d = doc(name);
      const auto = buildAutoProject(d, createEmptyProject(lang), lang);
      const doubts = collectDoubts(d.reading, auto.project, d.sheets, lang);
      if (auto.sufficient) expect(doubts.length).toBeLessThanOrEqual(MAX_AUTO_DOUBTS);
      const storeys = auto.project.model.storeys;
      for (const q of doubts) {
        expect(q.question, q.id).not.toMatch(HOLES);
        for (const line of q.details) expect(line, q.id).not.toMatch(HOLES);
        if (q.where) {
          expect(q.where.page, q.id).toBeGreaterThanOrEqual(1);
          expect(q.where.box.maxX, q.id).toBeGreaterThan(q.where.box.minX);
          expect(q.where.box.maxY, q.id).toBeGreaterThan(q.where.box.minY);
        }
        if (q.fix) {
          const storey = storeys.find((s) => s.id === q.fix!.storeyId);
          expect(storey, q.id).toBeDefined();
          // L'étage à ouvrir est celui de la feuille où le doute a été vu, quand c'est un étage du volume chauffé.
          if (q.where?.sheetId && storeys.some((s) => s.sheetId === q.where!.sheetId)) expect(storey!.sheetId, q.id).toBe(q.where.sheetId);
        }
      }
      // Une seule question de surfaces sans étiquette pour tout le bâtiment, détaillée par niveau.
      const unlabelled = doubts.filter((q) => q.id === 'an-unlabelled');
      expect(unlabelled.length).toBeLessThanOrEqual(1);
      if (unlabelled[0] && storeys.length > 1) {
        expect(unlabelled[0].details.length).toBeGreaterThanOrEqual(1);
        expect(unlabelled[0].effect).toMatch(/An/);
        expect(unlabelled[0].where?.sheetId).toBeTruthy();
        expect(unlabelled[0].fix?.step).toBe('rooms');
      }
      // Ordre par impact.
      const rank = { high: 0, medium: 1, low: 2 } as const;
      const ranks = doubts.map((q) => rank[q.impact]);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    });
  }
});

describe('noms de pièces', () => {
  it('une annotation du plan, un nom vide ou une cote ne sont pas des pièces', () => {
    for (const bad of ['', '  ', 'Surface séjour', 'Composition mur garage', 'Coupe A-A', 'Aufbau Wand', 'x']) expect(isRoomName(bad), bad).toBe(false);
    for (const ok of ['Buanderie', 'Local technique', 'Abstellraum', 'Garage', 'Cellier']) expect(isRoomName(ok), ok).toBe(true);
  });

  it('« pièce chauffée ? » ne nomme que de vraies pièces ; sans nom lisible, la zone non chauffée est décrite sans trou', () => {
    const d = doc('planche_A1_archicad');
    const auto = buildAutoProject(d, createEmptyProject('fr'), 'fr');
    const plan = d.sheets.find((s) => !s.role || s.role === 'floor-plan')!;
    plan.detected.rooms.push({ ...plan.detected.rooms[0]!, name: 'Surface séjour', heatedGuess: 'ask', exterior: false, at: { x: 1e6, y: 1e6 } });
    plan.detected.rooms.push({ ...plan.detected.rooms[0]!, name: '', heatedGuess: 'ask', exterior: false, at: { x: 1e6, y: 1e6 } });
    plan.detected.rooms.push({ ...plan.detected.rooms[0]!, name: 'Buanderie', heatedGuess: 'ask', exterior: false, polygon: undefined, at: { x: 1e6, y: 1e6 } });
    const q = collectDoubts(d.reading, auto.project, d.sheets, 'fr').find((x) => x.id === 'room-heated')!;
    expect(q.question).toContain('Buanderie');
    expect(q.question).not.toMatch(/Surface séjour|«\s*,|,\s*,|,\s*»/);
    plan.detected.unheatedZones = [{ polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], names: ['', 'Composition mur garage'] } as never];
    const z = collectDoubts(d.reading, auto.project, d.sheets, 'fr').find((x) => x.id === 'unheated-zone');
    if (z) expect(z.question).not.toMatch(HOLES);
  });
});

describe('chauffage', () => {
  it('un générateur lu que l’outil ne sait pas nommer donne la question sans proposition, jamais « Chauffage : ? »', () => {
    const d = doc('planche_A1_archicad');
    d.reading!.systems = { ...(d.reading!.systems ?? { heatGenerator: null, hotWater: null, ventilation: null, photovoltaic: null, solarThermal: null }), heatGenerator: { value: 'inconnu' as never, confidence: 0.9, evidence: [] } } as never;
    d.reading!.equipment = [];
    const auto = buildAutoProject(d, createEmptyProject('fr'), 'fr');
    const q = collectDoubts(d.reading, { ...auto.project, answers: { ...auto.project.answers, heatGenerator: null } }, d.sheets, 'fr').find((x) => x.id === 'heating')!;
    expect(q.question).not.toMatch(/:\s*\?|\?\s*\?/);
  });
});

describe('ce que les lecteurs savent mieux que le moteur', () => {
  it('plancher au-dessus d’un local non chauffé : la surface mesurée par le lecteur remplace la différence de contours', () => {
    const d = doc('planche_A1_archicad');
    const before = buildAutoProject(d, createEmptyProject('fr'), 'fr');
    const upper = before.project.model.storeys[1]!;
    const lower = before.project.model.storeys[0]!;
    d.reading!.floorOverUnheated = [{ sheetId: upper.sheetId!, belowSheetId: lower.sheetId, areaM2: 17.25, confidence: 0.9 }];
    const after = buildAutoProject(d, createEmptyProject('fr'), 'fr');
    expect(after.project.model.storeys[1]!.floorOverUnheated).toMatchObject({ value: 17.25, from: 'plan' });
    const rows = deriveSheets(after.project, 'fr').envelope.filter((r) => r.kind === 'floor' && r.boundary === 'unheated' && r.storeyId === upper.id);
    expect(rows.reduce((a, r) => a + r.grossArea, 0)).toBeCloseTo(17.25, 2);
    // Une mesure peu sûre reste à confirmer.
    d.reading!.floorOverUnheated = [{ sheetId: upper.sheetId!, belowSheetId: lower.sheetId, areaM2: 17.25, confidence: 0.4 }];
    expect(buildAutoProject(d, createEmptyProject('fr'), 'fr').project.model.storeys[1]!.floorOverUnheated?.from).toBe('estimate');
  });

  it('sans mesure du lecteur, le repli (différence de contours) est inchangé', () => {
    const d = doc('planche_A1_archicad');
    delete d.reading!.floorOverUnheated;
    const auto = buildAutoProject(d, createEmptyProject('fr'), 'fr');
    expect(auto.project.model.storeys.every((s) => s.floorOverUnheated === undefined)).toBe(true);
  });

  it('hauteurs libres rattachées à leur niveau : une par étage, prises telles quelles', () => {
    for (const name of PLANCHES) {
      const d = doc(name);
      const floors = d.reading?.levels?.floors ?? [];
      if (floors.length === 0) continue;
      d.reading!.clearHeightsByFloor = floors.map((_, i) => ({ floorIndex: i, value: 2.4 + 0.05 * i, confidence: 0.9, viewId: null }));
      const auto = buildAutoProject(d, createEmptyProject('fr'), 'fr');
      const heights = auto.project.model.storeys.map((s) => s.clearHeight);
      const allowed = floors.map((_, i) => 2.4 + 0.05 * i);
      for (const h of heights) {
        expect(h.from, name).toBe('plan');
        expect(allowed.some((v) => Math.abs(v - h.value) < 1e-9), name).toBe(true);
      }
      if (heights.length > 1) expect(new Set(heights.map((h) => h.value)).size, name).toBe(heights.length);
    }
  });

  it('toiture plate lue par le lecteur : la question de la toiture ne se pose pas', () => {
    const d = doc('planche_sans_titres');
    d.reading!.roof = { flat: { value: true, confidence: 0.9, evidence: [] }, pitchDeg: null } as never;
    d.reading!.levels = d.reading!.levels ? { ...d.reading!.levels, top: { rel: 6, role: 'top', confidence: 0.9 } as never } : d.reading!.levels;
    const auto = buildAutoProject(d, createEmptyProject('fr'), 'fr');
    expect(auto.project.model.top.kind).toBe('flat-roof');
  });
});
