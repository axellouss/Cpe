/**
 * Le parcours des questions : ordre, pertinence, états, « je ne sais pas », et ce que chaque réponse change.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '../../../src/core/types';
import { createEmptyProject } from '../../../src/engine';
import { setAnswers, setBottom, setTop } from '../../../src/ui/shell/modelOps';
import {
  CAN_SKIP,
  clearedAnswers,
  countedQuestions,
  firstOpenQuestion,
  hasAnyAnswer,
  isPlausibleYear,
  isQuestionComplete,
  isVisitNote,
  markQuestion,
  nextQuestion,
  periodLabel,
  periodOfYear,
  PERIODS,
  previousQuestion,
  QUESTION_ORDER,
  questionRank,
  questionStatus,
  relevantQuestions,
  REQUIRED_QUESTIONS,
  visitNoteRank,
} from '../../../src/ui/shell/questions';
import { selectMarks, selectProject } from '../../../src/ui/shell/store';
import { emptyMarks } from '../../../src/ui/shell/types';
import { testStore } from './helpers';

const empty = (): Project => createEmptyProject('fr');

describe('script des questions', () => {
  it('une seule question indispensable, posée en premier ; huit notes de visite facultatives ; l’identité en dernier et hors compte', () => {
    const project = setAnswers(empty(), { occasion: 'existing', buildingType: 'EFH', dwellings: 1 });
    expect(REQUIRED_QUESTIONS).toEqual(['closure']);
    expect(relevantQuestions(project)[0]).toBe('closure');
    expect(countedQuestions(project)).toHaveLength(9);
    const all = relevantQuestions(project);
    expect(all[all.length - 1]).toBe('identity');
    expect(countedQuestions(project)).not.toContain('identity');
    expect(questionRank('identity', project).rank).toBeNull();
    expect(questionRank('closure', project)).toEqual({ rank: 1, total: 9 });
    // Les notes de visite ont leur propre décompte ; la question indispensable et l'identité n'en font pas partie.
    expect(isVisitNote('closure')).toBe(false);
    expect(visitNoteRank('closure', project)).toBeNull();
    expect(visitNoteRank('context', project)).toEqual({ rank: 1, total: 8 });
    expect(visitNoteRank('solar', project)).toEqual({ rank: 8, total: 8 });
    expect(visitNoteRank('identity', project)).toBeNull();
  });

  it('pas de question sur l’isolation ajoutée après coup pour un bâtiment neuf', () => {
    const project = setAnswers(empty(), { occasion: 'new' });
    expect(relevantQuestions(project)).not.toContain('insulation');
    expect(countedQuestions(project)).toHaveLength(8);
    expect(nextQuestion('year', project)).toBe('windows');
    expect(previousQuestion('windows', project)).toBe('year');
  });

  it('avance et recule dans l’ordre, avec des bornes nettes', () => {
    const project = empty();
    expect(previousQuestion('closure', project)).toBeNull();
    expect(nextQuestion('closure', project)).toBe('context');
    expect(nextQuestion('context', project)).toBe('year');
    expect(nextQuestion('solar', project)).toBe('identity');
    expect(nextQuestion('identity', project)).toBeNull();
    let id = QUESTION_ORDER[0]!;
    const walked = [id];
    for (;;) {
      const next = nextQuestion(id, project);
      if (!next) break;
      walked.push(next);
      id = next;
    }
    expect(walked).toEqual([...QUESTION_ORDER]);
  });

  it('chaque écran sait s’il est complet', () => {
    let p = empty();
    expect(isQuestionComplete('context', p)).toBe(false);
    p = setAnswers(p, { occasion: 'existing', buildingType: 'MFH' });
    expect(isQuestionComplete('context', p)).toBe(false); // nombre de logements manquant
    expect(hasAnyAnswer('context', p)).toBe(true);
    p = setAnswers(p, { dwellings: 6 });
    expect(isQuestionComplete('context', p)).toBe(true);

    expect(isQuestionComplete('closure', p)).toBe(false);
    p = setTop(p, { kind: 'flat-roof' });
    expect(isQuestionComplete('closure', p)).toBe(false); // le plancher bas reste une hypothèse
    expect(hasAnyAnswer('closure', p)).toBe(true);
    p = setBottom(p, 'slab-on-ground');
    expect(isQuestionComplete('closure', p)).toBe(true);

    p = setAnswers(p, { insulationWallsCm: 12, insulationRoofCm: 0 });
    expect(isQuestionComplete('insulation', p)).toBe(false);
    p = setAnswers(p, { insulationFloorCm: 0 });
    expect(isQuestionComplete('insulation', p)).toBe(true);

    p = setAnswers(p, { heatGenerator: 'pellets' });
    expect(isQuestionComplete('heating', p)).toBe(false);
    p = setAnswers(p, { heatEmission: 'radiators' });
    expect(isQuestionComplete('heating', p)).toBe(true); // l'année de l'installation est facultative

    p = setAnswers(p, { solarThermal: false });
    expect(isQuestionComplete('solar', p)).toBe(false);
    p = setAnswers(p, { photovoltaic: true });
    expect(isQuestionComplete('solar', p)).toBe(true);

    expect(isQuestionComplete('identity', p)).toBe(false);
    expect(isQuestionComplete('identity', setAnswers(p, { projectName: '  Maison  ' }))).toBe(true);
  });

  it('distingue pas vue, incomplète, répondue et « je ne sais pas »', () => {
    let p = empty();
    let marks = emptyMarks();
    expect(questionStatus('year', p, marks)).toBe('open');
    marks = markQuestion(marks, 'year', 'skipped');
    expect(questionStatus('year', p, marks)).toBe('skipped');
    p = setAnswers(p, { yearBuilt: 1974 });
    expect(questionStatus('year', p, marks)).toBe('answered');

    expect(questionStatus('insulation', p, marks)).toBe('open');
    p = setAnswers(p, { insulationWallsCm: 8 });
    expect(questionStatus('insulation', p, marks)).toBe('partial');
    // Continuer avec des inconnues : la question est vue, mais reste incomplète.
    marks = markQuestion(marks, 'heating', 'answered');
    expect(questionStatus('heating', p, marks)).toBe('partial');
  });

  it('retrouve la première question pas encore vue', () => {
    let p = empty();
    let marks = emptyMarks();
    expect(firstOpenQuestion(p, marks)).toBe('closure');
    marks = markQuestion(marks, 'closure', 'answered');
    expect(firstOpenQuestion(p, marks)).toBe('context');
    p = setAnswers(p, { occasion: 'existing', buildingType: 'EFH', dwellings: 1 });
    marks = markQuestion(marks, 'year', 'skipped');
    expect(firstOpenQuestion(p, marks)).toBe('insulation');
    for (const id of countedQuestions(p)) marks = markQuestion(marks, id, 'skipped');
    expect(firstOpenQuestion(p, marks)).toBeNull();
  });

  it('« je ne sais pas » n’est offert que là où c’est une réponse honnête, et vide les bons champs', () => {
    // La question indispensable ne se passe pas ; toutes les notes de visite, si.
    expect(CAN_SKIP.closure).toBe(false);
    for (const id of ['context', 'year', 'insulation', 'windows', 'heating', 'hotWater', 'ventilation', 'solar'] as const) expect(CAN_SKIP[id]).toBe(true);
    expect(clearedAnswers('insulation')).toEqual({ insulationWallsCm: null, insulationRoofCm: null, insulationFloorCm: null });
    expect(clearedAnswers('ventilation')).toEqual({ ventilation: null, n50: null });
    expect(clearedAnswers('context')).toEqual({});
  });

  it('les périodes couvrent toutes les années sans trou ni recouvrement', () => {
    for (let year = 1700; year <= 2040; year++) {
      const hits = PERIODS.filter((p) => (p.from === null || year >= p.from) && (p.to === null || year <= p.to));
      expect(hits, `année ${year}`).toHaveLength(1);
    }
    for (const p of PERIODS) expect(periodOfYear(p.year)).toBe(p);
    expect(periodOfYear(null)).toBeNull();
    expect(periodLabel(PERIODS[0]!)).toBe('< 1919');
    expect(periodLabel(PERIODS[4]!)).toBe('1970–1979');
    expect(periodLabel(PERIODS[PERIODS.length - 1]!)).toBe('≥ 2017');
    expect(isPlausibleYear(1974, 2026)).toBe(true);
    expect(isPlausibleYear(19, 2026)).toBe(false);
    expect(isPlausibleYear(2040, 2026)).toBe(false);
    expect(isPlausibleYear(1974.5, 2026)).toBe(false);
  });
});

describe('parcours complet dans le magasin', () => {
  it('une maison existante se décrit en neuf écrans, puis l’identité, puis le résultat', () => {
    const { store } = testStore();
    const s = () => store.getState();
    s().startBlank();
    s().goTo('questions');
    const seen: string[] = [];
    const visit = (answer: () => void): void => {
      seen.push(s().question);
      answer();
      s().continueQuestion();
    };

    visit(() => {
      s().setTop({ kind: 'attic-ceiling' });
      s().setBottom('above-unheated');
    });
    visit(() => s().answer({ occasion: 'existing', buildingType: 'EFH', dwellings: 1 }));
    visit(() => s().answerYear(1975, true));
    visit(() => s().answer({ insulationWallsCm: 12, insulationRoofCm: 0, insulationFloorCm: 0 }));
    visit(() => s().answer({ windowGeneration: 'double-lowe' }));
    visit(() => s().answer({ heatGenerator: 'gas-condensing', heatGeneratorYear: 2012, heatEmission: 'radiators' }));
    visit(() => s().answer({ hotWater: 'with-heating' }));
    visit(() => s().answer({ ventilation: 'windows' }));
    visit(() => s().answer({ solarThermal: false, photovoltaic: false }));

    expect(seen).toEqual(['closure', 'context', 'year', 'insulation', 'windows', 'heating', 'hotWater', 'ventilation', 'solar']);
    expect(s().step).toBe('questions');
    expect(s().question).toBe('identity');
    s().continueQuestion(); // facultatif : « plus tard »
    expect(s().step).toBe('result');

    const project = selectProject(s());
    for (const id of countedQuestions(project)) expect(questionStatus(id, project, selectMarks(s())), id).toBe('answered');
    expect(project.model.top).toMatchObject({ kind: 'attic-ceiling', from: 'user' });
    expect(project.model.bottom).toMatchObject({ kind: 'above-unheated', from: 'user' });
    expect(selectMarks(s()).questions.identity).toBe('skipped');
  });

  it('« retour » remonte les questions puis revient au plan', () => {
    const { store } = testStore();
    const s = () => store.getState();
    s().startBlank();
    s().openQuestion('year');
    s().backQuestion();
    expect(s().question).toBe('context');
    s().backQuestion();
    expect(s().question).toBe('closure');
    s().backQuestion();
    expect(s().step).toBe('plan');
  });

  it('le résultat est accessible dès la question indispensable répondue ; les notes de visite restent ouvertes', () => {
    const { store } = testStore();
    const s = () => store.getState();
    s().startBlank();
    s().goTo('questions');
    expect(s().question).toBe('closure');
    s().setTop({ kind: 'flat-roof' });
    s().setBottom('slab-on-ground');
    s().finishQuestions();
    expect(s().step).toBe('result');
    const project = selectProject(s());
    expect(questionStatus('closure', project, selectMarks(s()))).toBe('answered');
    expect(questionStatus('context', project, selectMarks(s()))).toBe('open');
    // Revenir aux questions reprend à la première note de visite, sans rien exiger.
    s().goTo('questions');
    expect(s().question).toBe('context');
    s().finishQuestions();
    expect(s().step).toBe('result');
    expect(questionStatus('context', selectProject(s()), selectMarks(s()))).toBe('open');
  });

  it('choisir « neuf » après coup saute l’isolation, même si l’on y était', () => {
    const { store } = testStore();
    const s = () => store.getState();
    s().openQuestion('insulation');
    s().answer({ occasion: 'new' });
    s().goTo('questions');
    expect(s().question).toBe('closure'); // la question indispensable n'est pas encore répondue
    s().openQuestion('insulation'); // question hors parcours : ignorée
    expect(s().question).toBe('closure');
    expect(relevantQuestions(selectProject(s()))).not.toContain('insulation');
  });
});
