/**
 * Fichier de projet : champs du parcours automatique (proposé ≠ confirmé, questions tranchées, alignement des
 * étages, emprise, sous-sol hors volume, baies et pièces enrichies). Aller-retour sans perte ; un fichier plus ancien
 * n'en reçoit aucun (rien n'est inventé à la migration).
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/core/types';
import { parseProject, ProjectFileError, serializeProject } from '../../src/export';
import { makeProject } from './fixtures';

function autoProject(): Project {
  const p = makeProject();
  const st = p.model.storeys[0]!;
  st.offset = { dx: -12.5, dy: 40, confidence: 0.7 };
  st.footprint = {
    outline: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ],
    openings: [{ kind: 'door', a: { x: 15, y: 10 }, b: { x: 18, y: 10 }, width: 3, height: 2.25 }],
  };
  const o = st.openings[0]!;
  o.sill = 0.9;
  o.constructionId = 'door-unheated';
  st.rooms.push({ id: 'r-esc', name: 'Surface sans étiquette', area: { value: 6.2, from: 'plan' }, heated: false, needsReview: false, unlabelled: true });
  const { offset: _offset, ...basement } = structuredClone(st);
  p.model.unheatedStoreys = [{ ...basement, id: 'b1', name: 'Sous-sol' }];
  p.model.facadeViews = [{ orientation: 'S', short: 'AV', title: 'FAÇADE AVANT', viewId: 'p1-elevation1', planSideDeg: 180 }];
  p.answers.occasion = 'new';
  p.answers.proposed = { occasion: { confidence: 0.7, source: 'cartouche' } };
  p.answers.resolvedDoubts = { 'an-unlabelled': 'user', north: 'unknown' };
  return p;
}

describe('champs du parcours automatique', () => {
  it('font un aller-retour sans perte', () => {
    const project = autoProject();
    const back = parseProject(serializeProject(project));
    expect(back).toEqual(project);
    expect(serializeProject(back)).toBe(serializeProject(project));
  });

  it('sont absents d’un fichier plus ancien : aucune réponse n’y devient « proposée »', () => {
    const plain = makeProject();
    const back = parseProject(JSON.stringify({ app: 'Plan2CPE', version: 1, model: plain.model, answers: plain.answers }));
    expect('proposed' in back.answers).toBe(false);
    expect('resolvedDoubts' in back.answers).toBe(false);
    expect('unheatedStoreys' in back.model).toBe(false);
    expect('offset' in back.model.storeys[0]!).toBe(false);
    expect('footprint' in back.model.storeys[0]!).toBe(false);
  });

  it('refusent une valeur invalide avec un message clair', () => {
    const project = autoProject();
    const json = JSON.parse(serializeProject(project));
    json.answers.resolvedDoubts.north = 'peut-être';
    expect(() => parseProject(JSON.stringify(json))).toThrow(ProjectFileError);
    const json2 = JSON.parse(serializeProject(project));
    json2.model.storeys[0].offset.dx = 'loin';
    expect(() => parseProject(JSON.stringify(json2))).toThrow(ProjectFileError);
  });

  it('ignorent une clé spéciale dans une table', () => {
    const json = JSON.parse(serializeProject(autoProject()));
    const text = JSON.stringify(json).replace('"resolvedDoubts":{', '"resolvedDoubts":{"__proto__":"user",');
    const back = parseProject(text);
    expect(Object.keys(back.answers.resolvedDoubts ?? {})).toEqual(['an-unlabelled', 'north']);
  });
});

describe('projet construit par le moteur automatique', () => {
  it('s’enregistre et se relit sans perte, réponses aux questions comprises', async () => {
    const { documentFromTruth, readPlancheTruth } = await import('../engine/auto-planche');
    const { applyDoubtAnswer, buildAutoProject, collectDoubts, createEmptyProject, DOUBT_UNKNOWN } = await import('../../src/engine');
    for (const name of ['planche_A1_archicad', 'planche_A2_de_titres_dessus'] as const) {
      const doc = documentFromTruth(await readPlancheTruth(name));
      let project = buildAutoProject(doc, createEmptyProject('fr'), 'fr').project;
      const doubts = collectDoubts(doc.reading, project, doc.sheets, 'fr');
      project = applyDoubtAnswer(project, doubts[0]!, doubts[0]!.proposal?.value ?? DOUBT_UNKNOWN, 'fr');
      project = applyDoubtAnswer(project, doubts[1]!, DOUBT_UNKNOWN, 'fr');
      const back = parseProject(serializeProject(project));
      expect(back).toEqual(project);
      expect(collectDoubts(doc.reading, back, doc.sheets, 'fr').map((d) => d.id)).toEqual(collectDoubts(doc.reading, project, doc.sheets, 'fr').map((d) => d.id));
    }
  });
});
