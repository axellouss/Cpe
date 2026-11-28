/**
 * Moteur de doutes : confiance par recoupement, catalogue, et nombre de questions selon la richesse de la lecture.
 * Lectures fabriquées à partir de la planche SYNTHÉTIQUE A1 (données inventées).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { knownKeys } from '../../src/i18n';
import type { PlanSheet } from '../../src/core/types';
import { createEmptyProject } from '../../src/engine';
import { DOUBT_CATALOG, answerUnknown, collectDoubts, evaluate, shouldAsk, strengthOf, type Signal } from '../../src/engine/doubts';
import { plancheA1, type CaseOptions, type PlancheCase } from './planche-case';
import { readTruth } from './planche-helpers';

let truth: Record<string, unknown>;
const make = (o: CaseOptions = {}): PlancheCase => plancheA1(truth, o);
const ids = (c: PlancheCase, lang: 'fr' | 'de' = 'fr') => collectDoubts(c.reading, c.project, c.sheets, lang).map((d) => d.id);

beforeAll(async () => {
  truth = await readTruth('planche_A1_archicad');
});

const s = (group: Signal['group'], strength: Signal['strength'], value: string): Signal => ({ group, strength, value, source: 'test' });

describe('evaluate — confiance par groupes indépendants', () => {
  it('deux signaux forts de groupes différents : recoupé (0,91)', () => {
    expect(evaluate([s('title-block', 'strong', 'a'), s('plan-text', 'strong', 'a')]).confidence).toBeCloseTo(0.91, 6);
  });
  it('deux signaux du MÊME groupe ne comptent qu’une fois', () => {
    expect(evaluate([s('title-block', 'strong', 'a'), s('title-block', 'strong', 'a')]).confidence).toBeCloseTo(0.7, 6);
  });
  it('un fort et un faible : 0,82 ; un faible : 0,40 ; une hypothèse : 0', () => {
    expect(evaluate([s('section', 'strong', 'a'), s('plan-text', 'weak', 'a')]).confidence).toBeCloseTo(0.82, 6);
    expect(evaluate([s('section', 'weak', 'a')]).confidence).toBeCloseTo(0.4, 6);
    expect(evaluate([s('tool-hypothesis', 'hypothesis', 'a')]).confidence).toBe(0);
    expect(evaluate([]).value).toBeNull();
  });
  it('contradiction forte : plafond 0,4 ; faible : 0,6', () => {
    expect(evaluate([s('title-block', 'strong', 'a'), s('plan-text', 'strong', 'a'), s('section', 'strong', 'b')]).confidence).toBe(0.4);
    expect(evaluate([s('title-block', 'strong', 'a'), s('plan-text', 'strong', 'a'), s('section', 'weak', 'b')]).confidence).toBe(0.6);
  });
  it('seuils par impact', () => {
    expect(shouldAsk('high', { confidence: 0.84 })).toBe(true);
    expect(shouldAsk('high', { confidence: 0.85 })).toBe(false);
    expect(shouldAsk('medium', { confidence: 0.7 })).toBe(false);
    expect(shouldAsk('low', { confidence: 0.3 })).toBe(true);
    expect(strengthOf(0.65)).toBe('strong');
    expect(strengthOf(0.3)).toBe('weak');
    expect(strengthOf(0)).toBe('hypothesis');
  });
});

describe('catalogue', () => {
  it('chaque question a sa donnée, sa formulation FR et DE, et des choix traduits', () => {
    const fr = new Set(knownKeys('fr'));
    const de = new Set(knownKeys('de'));
    for (const spec of DOUBT_CATALOG) {
      for (const key of [`doubt.${spec.id}.datum`, `doubt.${spec.id}.question`]) {
        expect(fr.has(key), key).toBe(true);
        expect(de.has(key), key).toBe(true);
      }
      for (const o of spec.options) {
        const ok = (set: Set<string>) => set.has(`doubt.${spec.id}.option.${o}`) || set.has(`doubt.option.${o}`);
        expect(ok(fr) && ok(de), `${spec.id}/${o}`).toBe(true);
      }
      expect(spec.skipWhen.length).toBeGreaterThan(0);
      expect(spec.trigger.length).toBeGreaterThan(0);
    }
    expect(new Set(DOUBT_CATALOG.map((d) => d.id)).size).toBe(DOUBT_CATALOG.length);
  });

  it('les questions FR et DE ont les mêmes clés', () => {
    const fr = knownKeys('fr').filter((k) => k.startsWith('doubt.'));
    const de = new Set(knownKeys('de').filter((k) => k.startsWith('doubt.')));
    expect(fr.filter((k) => !de.has(k))).toEqual([]);
  });
});

describe('collectDoubts — planche riche (A1 synthétique)', () => {
  it('5 à 7 questions : An, matériaux, menuiseries, ventilation, chauffage, ponts thermiques', () => {
    const found = ids(make());
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found.length).toBeLessThanOrEqual(7);
    expect(found).toEqual(expect.arrayContaining(['an-unlabelled', 'materials', 'windows', 'ventilation', 'heating', 'thermal-bridges']));
  });

  it('triées par impact, toutes à impact fort ici', () => {
    const doubts = collectDoubts(make().reading, make().project, make().sheets, 'fr');
    expect(doubts.every((d) => d.impact === 'high')).toBe(true);
  });

  it('escalier dans An : surface et effet chiffrés', () => {
    const c = make();
    const d = collectDoubts(c.reading, c.project, c.sheets, 'fr').find((x) => x.id === 'an-unlabelled')!;
    expect(d.question).toContain('10,2 m²'); // 2 × 5,096 m² d'escalier sans étiquette
    expect(d.effect).toMatch(/^\+10,2 m² d’An, soit \+\d+ %$/);
    expect(d.proposal).toEqual({ value: 'include', label: 'Oui, surface mesurée' });
  });

  it('matériaux : UNE question, couches douteuses en lignes, effet chiffré', () => {
    const c = make();
    const all = collectDoubts(c.reading, c.project, c.sheets, 'fr');
    const m = all.filter((x) => x.sheet === 'opaque');
    expect(m).toHaveLength(1);
    expect(m[0]!.grouped).toBe(true);
    expect(m[0]!.details.some((l) => /coulé ou en blocs/.test(l))).toBe(true);
    expect(m[0]!.details.some((l) => /isolant non écrit/.test(l))).toBe(true);
    expect(m[0]!.effect).toMatch(/U du mur \+\d+ %/);
  });

  it('chauffage : la PAC lue est proposée, à confirmer', () => {
    const c = make();
    const h = collectDoubts(c.reading, c.project, c.sheets, 'fr').find((x) => x.id === 'heating')!;
    expect(h.proposal?.value).toBe('heat-pump-air');
    expect(h.question).toContain('pompe à chaleur air/eau');
  });

  it('en allemand aussi', () => {
    const c = make();
    const de = collectDoubts(c.reading, c.project, c.sheets, 'de');
    expect(de.find((d) => d.id === 'ventilation')!.question).toBe('Welche Lüftung? Und welche Luftdichtheit?');
  });

  it('« je ne sais pas » garde la proposition, étiquetée hypothèse', () => {
    const c = make();
    const tb = collectDoubts(c.reading, c.project, c.sheets, 'fr').find((d) => d.id === 'thermal-bridges')!;
    expect(tb.proposal?.value).toBe('0.10');
    expect(answerUnknown(tb, 'fr')).toEqual({ value: '0.10', from: 'default', confidence: 0, source: expect.stringContaining('Hypothèse') });
  });

  it('une réponse donnée retire sa question', () => {
    const c = make();
    c.project.answers = { ...c.project.answers, thermalBridges: '0.03', thermalMass: 'heavy', ventilation: 'balanced-hr', ventilationFlow: 110, heatRecovery: 0.85, fanPower: 0.35, airtightness: 'class-a-with-ventilation' };
    const found = ids(c);
    expect(found).not.toContain('thermal-bridges');
    expect(found).not.toContain('ventilation');
  });
});

describe('collectDoubts — lectures dégradées et plan pauvre', () => {
  it('sans façades dessinées : accolement et type de preuve redeviennent douteux', () => {
    const rich = ids(make());
    const poor = ids(make({ noElevations: true }));
    expect(poor.length).toBeGreaterThan(rich.length);
    expect(poor).toContain('attached');
  });

  it('sans cartouche : davantage de questions (type de preuve, échelle, année, adresse…)', () => {
    const found = ids(make({ noTitleBlock: true }));
    expect(found.length).toBeGreaterThan(7);
    expect(found).toEqual(expect.arrayContaining(['occasion', 'year', 'identity']));
  });

  it('sans coupe : les hauteurs restent lues en plan, le plancher bas devient douteux', () => {
    const found = ids(make({ noSections: true }));
    expect(found).toContain('bottom');
  });

  it('sans compositions : la question matériaux liste les éléments à saisir', () => {
    const c = make({ noCompositions: true });
    const m = collectDoubts(c.reading, c.project, c.sheets, 'fr').find((d) => d.id === 'materials')!;
    expect(m.details.some((l) => l.startsWith('Mur extérieur : aucune composition lue'))).toBe(true);
  });

  it('plan pauvre (une feuille, rien de lu) : beaucoup plus de questions, aucune exception', () => {
    const sheet: PlanSheet = {
      id: 's',
      name: 'Plan',
      bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      metresPerUnit: null,
      detected: { rooms: [], openings: [], notes: [] },
    };
    const project = createEmptyProject('fr');
    const found = collectDoubts(undefined, project, [sheet], 'fr').map((d) => d.id);
    expect(found.length).toBeGreaterThanOrEqual(15);
    expect(found).toEqual(expect.arrayContaining(['occasion', 'attached', 'scale', 'top', 'bottom', 'openings', 'materials', 'windows', 'north']));
  });

  it('peu de textes lus : le signal « aucune mention d’existant » ne joue pas, le type de preuve est demandé', () => {
    const found = ids(make({ sparseTexts: true }));
    expect(found).toContain('occasion');
    expect(found.length).toBeLessThanOrEqual(7);
  });

  it('accolement : un rattachement façade ↔ plan peu sûr ne vaut pas signal fort', () => {
    expect(ids(make())).not.toContain('attached');
    const c = make();
    for (const e of c.reading.elevations) if (e.planSideDeg) e.planSideDeg = { ...e.planSideDeg, confidence: 0.1 };
    expect(ids(c)).toContain('attached');
  });

  it('accolement : seuls des choix attestés sont proposés', () => {
    const c = make({ noElevations: true });
    const d = collectDoubts(c.reading, c.project, c.sheets, 'de').find((x) => x.id === 'attached')!;
    expect(d.options.map((o) => o.value)).toEqual(['one-side', 'other']);
    expect(d.options.map((o) => o.label).join(' ')).not.toMatch(/Freistehend|Zweiseitig/);
  });

  it('échelle illisible (NaN) malgré une provenance « plan » : la question est posée', () => {
    const c = make();
    expect(ids(c)).not.toContain('scale');
    const sheets = c.sheets.map((sh) => ({ ...sh, metresPerUnit: { value: Number.NaN, from: 'plan' as const } }));
    let found: string[] = [];
    expect(() => (found = collectDoubts(c.reading, c.project, sheets, 'fr').map((d) => d.id))).not.toThrow();
    expect(found).toContain('scale');
  });

  it('bâtiment existant : aucune valeur de triple vitrage neuf proposée', () => {
    const c = make();
    c.project.answers = { ...c.project.answers, occasion: 'existing' };
    const w = collectDoubts(c.reading, c.project, c.sheets, 'fr').find((x) => x.id === 'windows')!;
    expect(w.proposal).toBeNull();
    expect(w.question).toContain('existantes');
    expect(w.details.join(' ')).not.toContain('0,50');
    const fresh = make();
    expect(collectDoubts(fresh.reading, fresh.project, fresh.sheets, 'fr').find((x) => x.id === 'windows')!.proposal?.value).toBe('triple-new');
  });

  it('An par repli (aucune surface sans étiquette identifiée) : ni escalier ni « ? m² » dans la question', () => {
    const c = make();
    const sheets = c.sheets.map((sh) => ({
      ...sh,
      detected: { ...sh.detected, unlabelledAreas: [], rooms: sh.detected.rooms.map((r, i) => (i === 0 ? r : { ...r, heatedGuess: 'no' as const })) },
    }));
    const d = collectDoubts(c.reading, c.project, sheets, 'fr').find((x) => x.id === 'an-unlabelled');
    expect(d).toBeDefined();
    expect(d!.question).not.toMatch(/escalier|\? m²/i);
    expect(d!.question).toMatch(/^Pièces étiquetées : \d+ m² sur \d+ m² de contour/);
  });

  it('aucune lecture du tout : pas d’erreur', () => {
    expect(() => collectDoubts(undefined, createEmptyProject('de'), [], 'de')).not.toThrow();
  });
});
