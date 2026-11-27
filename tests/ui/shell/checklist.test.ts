/**
 * Liste guidée du plan et jauges : états déduits du bâtiment et des validations de l'expert.
 */
import { describe, expect, it } from 'vitest';
import type { Project, Storey } from '../../../src/core/types';
import { createEmptyProject, createStorey } from '../../../src/engine';
import { allStoreysDone, countDone, dropStoreyMarks, firstOpenStep, markPlanStep, nextOpenStep, planSteps, stepOfTool } from '../../../src/ui/shell/checklist';
import { computeMeters, isConfirmed, meterSlots, percent } from '../../../src/ui/shell/meters';
import { confirmNorth, confirmScale, confirmStoreyHeight, setAnswers, setBottom, setNetArea, setTop, updateRoom } from '../../../src/ui/shell/modelOps';
import { emptyMarks } from '../../../src/ui/shell/types';
import type { Marks } from '../../../src/ui/shell/types';
import { rect, sheet } from './helpers';

function withStorey(source: ReturnType<typeof sheet> | null): { project: Project; storey: Storey } {
  const project = createEmptyProject('fr');
  const storey = createStorey(source, 'Rez-de-chaussée', project.model);
  project.model.storeys.push(storey);
  return { project, storey };
}

const states = (project: Project, storey: Storey, marks: Marks, source: ReturnType<typeof sheet> | null): Record<string, string> =>
  Object.fromEntries(planSteps(project, storey, marks, source).map((s) => [s.key, s.state]));

describe('liste guidée du plan', () => {
  it('ce que le lecteur a proposé est pré-coché « à confirmer »', () => {
    const source = sheet('s1', 'RDC', {
      detected: {
        rooms: [{ name: 'Séjour', statedArea: 30, heatedGuess: 'yes' }],
        openings: [{ kind: 'window', a: { x: 100, y: 0 }, b: { x: 220, y: 0 }, exterior: true }],
      },
    });
    const { project, storey } = withStorey(source);
    project.model.northAngle = { value: 20, from: 'plan' };
    expect(states(project, storey, emptyMarks(), source)).toEqual({
      scale: 'toConfirm',
      outline: 'toConfirm',
      boundary: 'toConfirm',
      opening: 'toConfirm',
      north: 'toConfirm',
      rooms: 'toConfirm',
    });
    expect(firstOpenStep(planSteps(project, storey, emptyMarks(), source))).toBe('scale');
    expect(planSteps(project, storey, emptyMarks(), source).every((s) => s.canConfirm)).toBe(true);
  });

  it('une feuille où rien n’a été lu : tout est à faire, les façades attendent le contour', () => {
    const source = sheet('s1', 'Scan', { outline: null, scale: null });
    const { project, storey } = withStorey(source);
    const steps = planSteps(project, storey, emptyMarks(), source);
    expect(Object.fromEntries(steps.map((s) => [s.key, s.state]))).toEqual({
      scale: 'todo',
      outline: 'todo',
      boundary: 'blocked',
      opening: 'blocked',
      north: 'todo',
      rooms: 'todo',
    });
    // Une échelle jamais lue ne se valide pas d'un toucher : il faut poser la règle.
    expect(steps.find((s) => s.key === 'scale')).toMatchObject({ canConfirm: false, status: { key: 'shell.plan.status.scale.unknown' } });
    // Un nord par défaut peut être validé (le nord est peut-être bien en haut).
    expect(steps.find((s) => s.key === 'north')?.canConfirm).toBe(true);
  });

  it('un indice d’échelle isolé reste « à faire » mais peut être validé', () => {
    const source = sheet('s1', 'RDC', { scale: { value: 0.0353, from: 'estimate', note: 'Échelle 1:100 du cartouche.' } });
    const { project, storey } = withStorey(source);
    const scale = planSteps(project, storey, emptyMarks(), source).find((s) => s.key === 'scale')!;
    expect(scale).toMatchObject({ state: 'todo', canConfirm: true, status: { key: 'shell.plan.status.scale.weak' } });
  });

  it('grille vierge : l’échelle est acquise, le reste à faire', () => {
    const { project, storey } = withStorey(null);
    expect(states(project, storey, emptyMarks(), null)).toMatchObject({ scale: 'done', outline: 'todo', boundary: 'blocked', rooms: 'todo' });
  });

  it('les validations de l’expert font passer les étapes à « fait »', () => {
    const source = sheet('s1', 'RDC', {
      detected: {
        rooms: [
          { name: 'Séjour', statedArea: 30, heatedGuess: 'yes' },
          { name: 'Cave', statedArea: 12, heatedGuess: 'ask' },
        ],
      },
    });
    let { project, storey } = withStorey(source);
    let marks = emptyMarks();
    const refresh = (): void => {
      storey = project.model.storeys[0]!;
    };

    // Échelle et nord : la validation est une provenance du modèle.
    project = confirmNorth(confirmScale(project, storey.id));
    refresh();
    expect(states(project, storey, marks, source)).toMatchObject({ scale: 'done', north: 'done' });

    // Contour, façades, ouvertures : repères de l'expert.
    marks = markPlanStep(markPlanStep(markPlanStep(marks, storey.id, 'outline'), storey.id, 'boundary'), storey.id, 'opening');
    expect(states(project, storey, marks, source)).toMatchObject({ outline: 'done', boundary: 'done', opening: 'done' });

    // Pièces : une pièce à trancher bloque la validation…
    const rooms = planSteps(project, storey, marks, source).find((s) => s.key === 'rooms')!;
    expect(rooms).toMatchObject({ state: 'todo', canConfirm: false, status: { params: { count: 1 } } });
    // … une fois tranchée, l'étape se confirme.
    project = updateRoom(project, storey.id, storey.rooms[1]!.id, { heated: false });
    refresh();
    expect(states(project, storey, marks, source).rooms).toBe('toConfirm');
    marks = markPlanStep(marks, storey.id, 'rooms');
    const steps = planSteps(project, storey, marks, source);
    expect(countDone(steps)).toBe(6);
    expect(nextOpenStep(steps, 'rooms')).toBeNull();
    expect(allStoreysDone(project, marks)).toBe(true);

    // Les repères d'un étage supprimé disparaissent avec lui.
    expect(dropStoreyMarks(marks, storey.id).plan).toEqual({});
    expect(markPlanStep(marks, storey.id, 'rooms')).toBe(marks);
  });

  it('sans pièces lues, saisir la surface nette règle l’étape « pièces »', () => {
    let { project, storey } = withStorey(sheet('s1', 'RDC'));
    expect(states(project, storey, emptyMarks(), null).rooms).toBe('todo');
    project = setNetArea(project, storey.id, 68.5);
    storey = project.model.storeys[0]!;
    expect(planSteps(project, storey, emptyMarks(), null).find((s) => s.key === 'rooms')).toMatchObject({ state: 'done', status: { params: { area: 68.5 } } });
  });

  it('passe à la prochaine étape ouverte, en bouclant', () => {
    const { project, storey } = withStorey(sheet('s1', 'RDC'));
    const marks = markPlanStep(emptyMarks(), storey.id, 'outline');
    const steps = planSteps(project, storey, marks, null);
    expect(nextOpenStep(steps, 'scale')).toBe('boundary'); // le contour est fait : on le saute
    expect(nextOpenStep(steps, 'rooms')).toBe('scale'); // on boucle
    expect(nextOpenStep(steps, null)).toBe('scale');
  });

  it('relie les outils de l’éditeur aux étapes', () => {
    expect(stepOfTool('outline')).toBe('outline');
    expect(stepOfTool('rooms')).toBe('rooms');
    expect(stepOfTool('pan')).toBeNull();
  });
});

describe('jauges « complet » et « confirmé »', () => {
  it('partent de zéro et ne dépassent jamais 100 %', () => {
    const meters = computeMeters(createEmptyProject('fr'));
    expect(meters.complete).toBe(0);
    expect(meters.confirmed).toBe(0);
    expect(percent(1.2)).toBe(100);
    expect(percent(-0.1)).toBe(0);
    expect(percent(0.526)).toBe(53);
  });

  it('le dépôt d’un plan remplit une bonne part avant toute question ; « confirmé » ignore défauts et estimations', () => {
    const source = sheet('s1', 'RDC', { detected: { rooms: [{ name: 'Séjour', statedArea: 30, heatedGuess: 'yes' }] } });
    const { project } = withStorey(source);
    const meters = computeMeters(project);
    expect(meters.complete).toBeGreaterThan(0.25);
    expect(meters.confirmed).toBeGreaterThan(0);
    expect(meters.confirmed).toBeLessThan(meters.complete);

    const slot = (key: string) => meterSlots(project).find((s) => s.key.endsWith(key))!;
    // Hauteurs et fermetures par défaut : renseignées, pas confirmées.
    expect(slot('.grossHeight')).toMatchObject({ filled: true, from: 'default' });
    expect(isConfirmed(slot('.grossHeight').from)).toBe(false);
    expect(slot('top')).toMatchObject({ filled: true, from: 'default' });
    // Échelle et contour lus sur le plan : confirmés au sens de la jauge.
    expect(isConfirmed(slot('.scale').from)).toBe(true);
    expect(slot('.netArea')).toMatchObject({ filled: true, from: 'plan' });
    // Aucune fenêtre encore.
    expect(slot('windows')).toMatchObject({ filled: false, from: null });
  });

  it('chaque confirmation et chaque réponse font monter les jauges', () => {
    let { project, storey } = withStorey(sheet('s1', 'RDC'));
    const before = computeMeters(project);
    // Sans pièces, la surface nette est une estimation (80 % du brut).
    expect(meterSlots(project).find((s) => s.key.endsWith('.netArea'))).toMatchObject({ filled: true, from: 'estimate' });

    project = confirmStoreyHeight(confirmStoreyHeight(project, storey.id, 'gross'), storey.id, 'clear');
    project = setBottom(setTop(project, { kind: 'flat-roof' }), 'slab-on-ground');
    project = setNetArea(project, storey.id, 60);
    const afterPlan = computeMeters(project);
    expect(afterPlan.confirmed).toBeGreaterThan(before.confirmed);
    expect(afterPlan.complete).toBe(before.complete); // rien de nouveau, seulement confirmé

    project = setAnswers(project, { occasion: 'existing', buildingType: 'EFH', dwellings: 1, yearBuilt: 1974 });
    const afterAnswers = computeMeters(project);
    expect(afterAnswers.complete).toBeGreaterThan(afterPlan.complete);
    expect(afterAnswers.confirmed).toBeGreaterThan(afterPlan.confirmed);
    expect(afterAnswers.confirmed).toBeLessThanOrEqual(afterAnswers.complete);
    storey = project.model.storeys[0]!;
    expect(storey.netAreaOverride).toEqual({ value: 60, from: 'user' });
  });

  it('un bâtiment neuf n’attend pas de réponse sur l’isolation ajoutée', () => {
    const existing = setAnswers(createEmptyProject('fr'), { occasion: 'existing' });
    const fresh = setAnswers(createEmptyProject('fr'), { occasion: 'new' });
    expect(meterSlots(existing).length - meterSlots(fresh).length).toBe(3);
  });

  it('une pièce encore à trancher rend la surface nette provisoire', () => {
    const source = sheet('s1', 'RDC', {
      detected: {
        rooms: [
          { name: 'Séjour', statedArea: 30, heatedGuess: 'yes' },
          { name: 'Cave', statedArea: 10, heatedGuess: 'ask' },
        ],
      },
    });
    const { project } = withStorey(source);
    expect(meterSlots(project).find((s) => s.key.endsWith('.netArea'))?.from).toBe('estimate');
  });

  it('plusieurs étages comptent chacun leurs valeurs', () => {
    const project = createEmptyProject('fr');
    project.model.storeys.push(createStorey(sheet('a', 'RDC'), 'RDC', project.model));
    const one = meterSlots(project).length;
    project.model.storeys.push(createStorey(sheet('b', 'Étage', { outline: rect(800, 600) }), 'Étage', project.model));
    expect(meterSlots(project).length).toBe(one + 5);
  });
});
