/**
 * Dossier : une valeur LUE dans le cartouche et jamais confirmée porte « lu » (avec sa confiance), « vous » seulement
 * après confirmation ou saisie ; le bloc des hypothèses ne contient que de vraies hypothèses (valeur d'usage, lecture
 * peu sûre avec sa raison), jamais une valeur brute d'énumération. Planches synthétiques uniquement.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Dossier } from '../../src/core/cpe';
import type { PlanDocument, Project } from '../../src/core/types';
import { applyDoubtAnswer, buildAutoProject, collectDoubts, createEmptyProject, DOUBT_CONFIRM, DOUBT_UNKNOWN } from '../../src/engine';
import { buildDossier } from '../../src/export';
import { documentFromTruth, readPlancheTruth, type Truth } from '../engine/auto-planche';

let truth: Truth;
beforeAll(async () => {
  truth = await readPlancheTruth('planche_A1_archicad');
});

const setup = (lang: 'fr' | 'de' = 'fr'): { doc: PlanDocument; project: Project } => {
  const doc = documentFromTruth(truth);
  return { doc, project: buildAutoProject(doc, createEmptyProject(lang), lang).project };
};
const general = (d: Dossier, key: string) => d.sections.find((s) => s.key === 'general')!.fields.find((f) => f.key === key)!.value;

describe('dossier : provenance des réponses du questionnaire', () => {
  it('valeurs du cartouche jamais confirmées : « lu » avec la confiance de la lecture', () => {
    const { doc, project } = setup();
    const d = buildDossier(project, doc.sheets, 'fr', { reading: doc.reading! });
    for (const key of ['designation', 'street', 'postcodeLocality', 'buildingType', 'occasion', 'yearBuilt', 'dwellings', 'attachment']) {
      const v = general(d, key);
      expect(v.text, key).not.toBe('');
      expect(v.from, key).toBe('plan');
      expect(v.confidence, key).toBeGreaterThan(0);
      expect(v.confidence, key).toBeLessThanOrEqual(1);
    }
  });

  it('après confirmation ou saisie : « vous »', () => {
    const { doc, project } = setup();
    // La carte « adresse » telle qu'elle se pose sans cartouche, appliquée au projet lu.
    const bare = documentFromTruth(truth, { noTitleBlock: true });
    const q = collectDoubts(bare.reading, buildAutoProject(bare, createEmptyProject('fr'), 'fr').project, bare.sheets, 'fr').find((x) => x.id === 'identity');
    expect(q).toBeDefined();
    const next = applyDoubtAnswer(project, q!, '7, rue des Essais, L-0000 Exempleville', 'fr');
    const d = buildDossier(next, doc.sheets, 'fr');
    expect(general(d, 'street').from).toBe('user');
    expect(general(d, 'postcodeLocality').from).toBe('user');
    // Le titre, jamais confirmé, reste « lu ».
    expect(general(d, 'designation').from).toBe('plan');
  });
});

describe('dossier : hypothèses à confirmer', () => {
  it('une valeur lue avec une confiance suffisante n’y figure pas ; aucune valeur brute', () => {
    const { doc, project } = setup();
    for (const lang of ['fr', 'de'] as const) {
      const d = buildDossier(project, doc.sheets, lang, { reading: doc.reading! });
      const keys = d.assumptions.map((x) => x.key);
      for (const k of ['street', 'projectName', 'locality', 'postcode', 'yearBuilt', 'buildingType', 'occasion']) expect(keys, k).not.toContain(`proposed:${k}`);
      for (const a of d.assumptions) expect(a.text, a.key).not.toMatch(/one-side|heat-pump|balanced-hr|with-heating|floor-heating|\bEFH\b|\bnew\b/);
    }
  });

  it('une lecture fragile y figure avec sa raison ; « je ne sais pas » y figure comme hypothèse', () => {
    const { doc, project } = setup();
    const weak: Project = { ...project, answers: { ...project.answers, proposed: { ...project.answers.proposed, attachment: { confidence: 0.4, source: 'plans' } } } };
    const d = buildDossier(weak, doc.sheets, 'fr');
    const a = d.assumptions.find((x) => x.key === 'proposed:attachment')!;
    expect(a).toBeDefined();
    expect(a.text).toContain('Accolé d’un côté');
    expect(a.source).toContain('40 %');
    const vent = collectDoubts(doc.reading, project, doc.sheets, 'fr').find((x) => x.id === 'ventilation')!;
    const unknown = applyDoubtAnswer(project, vent, DOUBT_UNKNOWN, 'fr');
    const d2 = buildDossier(unknown, doc.sheets, 'de');
    const v = d2.assumptions.find((x) => x.key === 'proposed:ventilation')!;
    expect(v).toBeDefined();
    expect(v.text).not.toMatch(/balanced-hr/);
    expect(d2.sections.find((s) => s.key === 'ventilation')!.fields.find((f) => f.key === 'kind')!.value).toMatchObject({ from: 'default', confidence: 0 });
    // Confirmée : plus une hypothèse, et « vous ».
    const confirmed = applyDoubtAnswer(project, vent, DOUBT_CONFIRM, 'fr');
    const d3 = buildDossier(confirmed, doc.sheets, 'fr');
    expect(d3.assumptions.map((x) => x.key)).not.toContain('proposed:ventilation');
    expect(d3.sections.find((s) => s.key === 'ventilation')!.fields.find((f) => f.key === 'kind')!.value.from).toBe('user');
  });
});
