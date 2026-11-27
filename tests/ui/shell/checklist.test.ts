/**
 * Liste guidée du plan et indicateurs de la barre du haut : états déduits du bâtiment et des validations de l'expert.
 */
import { describe, expect, it } from 'vitest';
import type { Project, Storey } from '../../../src/core/types';
import { createEmptyProject, createStorey } from '../../../src/engine';
import {
  allStoreysDone,
  centredScrollLeft,
  countDone,
  dropStoreyMarks,
  firstOpenStep,
  grossHeightUnused,
  HEIGHT_CHOICES,
  isRealSizeModel,
  markPlanStep,
  nextOpenStep,
  planSteps,
  revealScrollTop,
  sameScaleStoreyIds,
  STEP_TOOL,
  stepOfTool,
  storeySteps,
  unconfirmedSteps,
} from '../../../src/ui/shell/checklist';
import { toLoadedDocument } from '../../../src/ui/shell/documents';
import { computeMeters, meterSlots, percent, stepsDone } from '../../../src/ui/shell/meters';
import { confirmNorth, confirmScale, confirmStoreyHeight, setAnswers, setBottom, setNetArea, setStoreyHeight, setTop, updateRoom } from '../../../src/ui/shell/modelOps';
import { emptyMarks, PLAN_STEP_KEYS } from '../../../src/ui/shell/types';
import type { Marks } from '../../../src/ui/shell/types';
import { doc, rect, sheet } from './helpers';

function withStorey(source: ReturnType<typeof sheet> | null): { project: Project; storey: Storey } {
  const project = createEmptyProject('fr');
  const storey = createStorey(source, 'Rez-de-chaussée', project.model);
  project.model.storeys.push(storey);
  return { project, storey };
}

const states = (project: Project, storey: Storey, marks: Marks, source: ReturnType<typeof sheet> | null): Record<string, string> =>
  Object.fromEntries(planSteps(project, storey, marks, source).map((s) => [s.key, s.state]));

const stepOf = (project: Project, storey: Storey, key: string, marks: Marks = emptyMarks()) => planSteps(project, storey, marks, null).find((s) => s.key === key)!;

/** Valide tout ce qui se valide sur un étage : provenances du modèle et repères de l'expert. */
function confirmEverything(project: Project, marks: Marks): { project: Project; marks: Marks } {
  let p = confirmNorth(project);
  let m = marks;
  for (const s of project.model.storeys) {
    p = confirmStoreyHeight(confirmScale(p, s.id), s.id, 'gross');
    // Sans pièces lues, l'étape « pièces » se règle en saisissant la surface nette.
    if (s.rooms.length === 0 && s.netAreaOverride === null) p = setNetArea(p, s.id, 60);
    for (const key of ['outline', 'boundary', 'opening', 'rooms'] as const) m = markPlanStep(m, s.id, key);
  }
  return { project: p, marks: m };
}

describe('liste guidée du plan', () => {
  it('a sept étapes, dans l’ordre du guide ; la hauteur d’étage vient juste après le contour', () => {
    expect(PLAN_STEP_KEYS).toEqual(['scale', 'outline', 'height', 'boundary', 'opening', 'north', 'rooms']);
    const { project, storey } = withStorey(sheet('s1', 'RDC'));
    expect(planSteps(project, storey, emptyMarks(), null).map((s) => s.key)).toEqual([...PLAN_STEP_KEYS]);
  });

  it('ce que le lecteur a proposé est pré-coché « à confirmer » ; la hauteur d’étage, qu’aucun plan ne donne, reste à faire', () => {
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
      height: 'todo',
      boundary: 'toConfirm',
      opening: 'toConfirm',
      north: 'toConfirm',
      rooms: 'toConfirm',
    });
    expect(firstOpenStep(planSteps(project, storey, emptyMarks(), source))).toBe('scale');
    // Tout ce qui est proposé se valide d'un toucher ; une hauteur par défaut ne se « confirme » pas, elle se choisit.
    expect(planSteps(project, storey, emptyMarks(), source).filter((s) => !s.canConfirm).map((s) => s.key)).toEqual(['height']);
  });

  it('une feuille où rien n’a été lu : tout est à faire, les façades attendent le contour', () => {
    const source = sheet('s1', 'Scan', { outline: null, scale: null });
    const { project, storey } = withStorey(source);
    const steps = planSteps(project, storey, emptyMarks(), source);
    expect(Object.fromEntries(steps.map((s) => [s.key, s.state]))).toEqual({
      scale: 'todo',
      outline: 'todo',
      height: 'todo',
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
    expect(states(project, storey, emptyMarks(), null)).toMatchObject({ scale: 'done', outline: 'todo', height: 'todo', boundary: 'blocked', rooms: 'todo' });
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

    // Six étapes validées, hauteur d'étage encore par défaut : l'étage n'est PAS prêt.
    expect(countDone(planSteps(project, storey, marks, source))).toBe(6);
    expect(nextOpenStep(planSteps(project, storey, marks, source), 'rooms')).toBe('height');
    expect(allStoreysDone(project, marks)).toBe(false);

    project = setStoreyHeight(project, storey.id, 'gross', 2.6);
    refresh();
    const steps = planSteps(project, storey, marks, source);
    expect(countDone(steps)).toBe(7);
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
    expect(nextOpenStep(steps, 'scale')).toBe('height'); // le contour est fait : on le saute
    expect(nextOpenStep(steps, 'height')).toBe('boundary');
    expect(nextOpenStep(steps, 'rooms')).toBe('scale'); // on boucle
    expect(nextOpenStep(steps, null)).toBe('scale');
  });

  it('relie les outils de l’éditeur aux étapes ; la hauteur laisse le plan en simple consultation', () => {
    expect(stepOfTool('outline')).toBe('outline');
    expect(stepOfTool('rooms')).toBe('rooms');
    expect(stepOfTool('pan')).toBeNull();
    expect(STEP_TOOL.height).toBe('pan');
    for (const key of PLAN_STEP_KEYS) if (key !== 'height') expect(stepOfTool(STEP_TOOL[key])).toBe(key);
  });
});

describe('hauteur d’étage : une étape de la liste', () => {
  it('par défaut : à faire, à choisir parmi cinq valeurs ; choisie ou confirmée : faite', () => {
    let { project, storey } = withStorey(sheet('s1', 'RDC'));
    expect(storey.grossHeight).toEqual({ value: 2.8, from: 'default' });
    expect(stepOf(project, storey, 'height')).toMatchObject({ state: 'todo', canConfirm: false, status: { key: 'shell.plan.status.height.default', params: { height: 2.8 } } });
    expect(HEIGHT_CHOICES).toEqual([2.5, 2.6, 2.7, 2.8, 3]);

    project = setStoreyHeight(project, storey.id, 'gross', 2.6);
    storey = project.model.storeys[0]!;
    expect(stepOf(project, storey, 'height')).toMatchObject({ state: 'done', status: { key: 'shell.plan.status.height.user', params: { height: 2.6 } } });
  });

  it('lue sur une maquette ou une coupe : déjà faite ; lue sans certitude : à confirmer d’un toucher', () => {
    const read = withStorey(sheet('s1', 'RDC', { detected: { storeyHeight: 2.95 } }));
    expect(read.storey.grossHeight).toEqual({ value: 2.95, from: 'plan' });
    expect(stepOf(read.project, read.storey, 'height')).toMatchObject({ state: 'done', status: { key: 'shell.plan.status.height.plan' } });

    // Dernier niveau d'une maquette, mesuré jusqu'au sommet des murs seulement : estimation.
    const unsure = withStorey(sheet('s1', 'Combles', { detected: { storeyHeight: 2.4, storeyHeightToWallTop: true } }));
    expect(unsure.storey.grossHeight.from).toBe('estimate');
    expect(stepOf(unsure.project, unsure.storey, 'height')).toMatchObject({ state: 'toConfirm', canConfirm: true, status: { key: 'shell.plan.status.height.read' } });
    const confirmed = confirmStoreyHeight(unsure.project, unsure.storey.id, 'gross');
    expect(stepOf(confirmed, confirmed.model.storeys[0]!, 'height').state).toBe('done');
  });

  it('la hauteur libre, facultative, ne bloque rien', () => {
    let { project, storey } = withStorey(sheet('s1', 'RDC'));
    project = setStoreyHeight(project, storey.id, 'gross', 2.7);
    storey = project.model.storeys[0]!;
    expect(storey.clearHeight.from).toBe('default');
    expect(stepOf(project, storey, 'height').state).toBe('done');
    expect(meterSlots(project, emptyMarks()).some((s) => s.key.includes('clear'))).toBe(false);
  });

  it('dernier étage sous une toiture inclinée CONFIRMÉE : la hauteur ne sert pas, on ne la demande pas', () => {
    const project = createEmptyProject('fr');
    project.model.storeys.push(createStorey(sheet('a', 'RDC'), 'RDC', project.model));
    project.model.storeys.push(createStorey(sheet('b', 'Combles'), 'Combles', project.model));
    const [lower, upper] = project.model.storeys as [Storey, Storey];

    // Toiture encore supposée : on demande la hauteur partout.
    expect(grossHeightUnused(project, upper)).toBe(false);
    expect(stepOf(project, upper, 'height').state).toBe('todo');

    // Toit incliné choisi mais pas encore confirmé (pente, jambette) : on la demande toujours.
    const chosen = setTop(project, { kind: 'pitched-roof' }, false);
    expect(chosen.model.top.from).toBe('estimate');
    expect(stepOf(chosen, upper, 'height').state).toBe('todo');

    // Confirmé : rien à saisir pour le dernier étage, mais l'étage du dessous garde sa question.
    const pitched = setTop(project, { kind: 'pitched-roof' });
    expect(grossHeightUnused(pitched, upper)).toBe(true);
    expect(stepOf(pitched, upper, 'height')).toMatchObject({ state: 'done', status: { key: 'shell.plan.status.height.roof' } });
    expect(grossHeightUnused(pitched, lower)).toBe(false);
    expect(stepOf(pitched, lower, 'height').state).toBe('todo');

    // Retour à une toiture plate : la hauteur du dernier étage redevient à faire.
    expect(stepOf(setTop(pitched, { kind: 'flat-roof' }), upper, 'height').state).toBe('todo');
  });
});

describe('échelle : une fois par dessin, jamais pour une maquette', () => {
  it('une maquette IFC en vraie grandeur n’a pas d’échelle à confirmer', () => {
    const ifc = toLoadedDocument(doc('villa.ifc', [sheet('niveau-0', 'RDC', { scale: { value: 1, from: 'plan' } })], { kind: 'ifc', storeysAligned: true }));
    const project = createEmptyProject('fr');
    const storey = createStorey(ifc.doc.sheets[0]!, 'RDC', project.model);
    project.model.storeys.push(storey);

    expect(isRealSizeModel(storey, 'ifc')).toBe(true);
    const scale = storeySteps(project, storey, emptyMarks(), [ifc]).find((s) => s.key === 'scale')!;
    expect(scale).toMatchObject({ state: 'done', status: { key: 'shell.plan.status.scale.model' } });
    // Projet rouvert sans ses plans : le nom du fichier gardé dans l'identifiant de la feuille suffit.
    expect(storeySteps(project, storey, emptyMarks(), []).find((s) => s.key === 'scale')!.state).toBe('done');
    expect(isRealSizeModel({ ...storey, sheetId: 'villa.ifc (2)#niveau-0' })).toBe(true);
  });

  it('un dessin DXF, un PDF, ou une échelle qui n’est plus celle du fichier se confirment toujours', () => {
    const dxf = toLoadedDocument(doc('maison.dxf', [sheet('cad-1', 'RDC')]));
    const project = createEmptyProject('fr');
    const storey = createStorey(dxf.doc.sheets[0]!, 'RDC', project.model);
    project.model.storeys.push(storey);
    expect(isRealSizeModel(storey, 'dxf')).toBe(false);
    expect(isRealSizeModel(storey)).toBe(false);
    expect(storeySteps(project, storey, emptyMarks(), [dxf]).find((s) => s.key === 'scale')!.state).toBe('toConfirm');
    // Le nom ne fait pas foi quand le fichier est chargé et n'est pas une maquette.
    expect(isRealSizeModel({ ...storey, sheetId: 'faux.ifc#p1' }, 'pdf')).toBe(false);
    // Une échelle estimée, même sur un fichier IFC, reste à confirmer.
    expect(isRealSizeModel({ ...storey, sheetId: 'villa.ifc#n0', metresPerUnit: { value: 1, from: 'estimate' } }, 'ifc')).toBe(false);
    expect(isRealSizeModel({ ...storey, sheetId: null }, 'ifc')).toBe(false);
  });

  it('les étages d’un même fichier qui ont la même échelle se confirment ensemble', () => {
    const project = createEmptyProject('fr');
    const loaded = toLoadedDocument(doc('maison.dxf', [sheet('cad-1', 'RDC'), sheet('cad-2', 'Étage'), sheet('cad-3', 'Détail', { scale: { value: 0.001, from: 'plan' } })]));
    const other = toLoadedDocument(doc('annexe.dxf', [sheet('cad-1', 'Annexe')]));
    for (const s of [...loaded.doc.sheets, ...other.doc.sheets]) project.model.storeys.push(createStorey(s, s.name, project.model));
    project.model.storeys.push(createStorey(null, 'Grille', project.model));
    const [rdc, etage, detail, annexe, grid] = project.model.storeys as [Storey, Storey, Storey, Storey, Storey];

    // Même fichier, même valeur : oui. Autre valeur, autre fichier, grille vierge : non.
    expect(sameScaleStoreyIds(project, rdc.id)).toEqual([etage.id]);
    expect(sameScaleStoreyIds(project, detail.id)).toEqual([]);
    expect(sameScaleStoreyIds(project, annexe.id)).toEqual([]);
    expect(sameScaleStoreyIds(project, grid.id)).toEqual([]);
    expect(sameScaleStoreyIds(project, 'inconnu')).toEqual([]);

    // Une échelle déjà confirmée par l'expert n'est pas à reconfirmer.
    expect(sameScaleStoreyIds(confirmScale(project, etage.id), rdc.id)).toEqual([]);
  });
});

describe('jauges « complet » et « confirmé »', () => {
  it('partent de zéro et ne dépassent jamais 100 %', () => {
    const meters = computeMeters(createEmptyProject('fr'), emptyMarks());
    expect(meters.complete).toBe(0);
    expect(meters.confirmed).toBe(0);
    expect(percent(1.2)).toBe(100);
    expect(percent(-0.1)).toBe(0);
    expect(percent(0.526)).toBe(53);
    // « 100 % » seulement quand tout y est ; « 0 % » seulement quand il n'y a rien.
    expect(percent(0.996)).toBe(99);
    expect(percent(1)).toBe(100);
    expect(percent(0.002)).toBe(1);
    expect(percent(0)).toBe(0);
  });

  it('comptent les étapes de chaque étage, plus toiture et plancher bas', () => {
    const project = createEmptyProject('fr');
    project.model.storeys.push(createStorey(sheet('a', 'RDC'), 'RDC', project.model));
    const one = meterSlots(project, emptyMarks()).map((s) => s.key);
    const id = project.model.storeys[0]!.id;
    expect(one).toEqual([...PLAN_STEP_KEYS.map((k) => `${id}.${k}`), 'top', 'bottom']);
    project.model.storeys.push(createStorey(sheet('b', 'Étage', { outline: rect(800, 600) }), 'Étage', project.model));
    expect(meterSlots(project, emptyMarks()).length).toBe(one.length + PLAN_STEP_KEYS.length);
  });

  it('un plan tout juste lu : rien n’est confirmé, et les valeurs par défaut ne comptent pas comme renseignées', () => {
    const source = sheet('s1', 'RDC', {
      detected: {
        rooms: [{ name: 'Séjour', statedArea: 30, heatedGuess: 'yes' }],
        openings: [{ kind: 'window', a: { x: 100, y: 0 }, b: { x: 220, y: 0 }, exterior: true }],
      },
    });
    const { project } = withStorey(source);
    project.model.northAngle = { value: 20, from: 'plan' };
    const meters = computeMeters(project, emptyMarks());
    // Rien n'a été validé par l'expert : « confirmé » est à zéro, quoi que le lecteur ait proposé.
    expect(meters.confirmed).toBe(0);
    // « Complet » compte ce qui est proposé (6 étapes), pas la hauteur ni les fermetures par défaut.
    const slot = (key: string) => meters.slots.find((s) => s.key.endsWith(key))!;
    expect(slot('.height')).toMatchObject({ filled: false, confirmed: false });
    expect(slot('top')).toMatchObject({ filled: false, confirmed: false });
    expect(slot('bottom')).toMatchObject({ filled: false, confirmed: false });
    expect(slot('.scale')).toMatchObject({ filled: true, confirmed: false });
    expect(meters.complete).toBeCloseTo(6 / 9, 9);
    expect(percent(meters.complete)).toBeLessThan(100);
  });

  it('chaque validation de l’expert fait monter « confirmé », et elle seule', () => {
    const source = sheet('s1', 'RDC', { detected: { rooms: [{ name: 'Séjour', statedArea: 30, heatedGuess: 'yes' }] } });
    let { project, storey } = withStorey(source);
    let marks = emptyMarks();
    const confirmed = (): number => computeMeters(project, marks).confirmed;
    const seen: number[] = [confirmed()];
    const step = (): void => {
      seen.push(confirmed());
    };

    project = confirmScale(project, storey.id);
    step();
    marks = markPlanStep(marks, storey.id, 'outline');
    step();
    project = setStoreyHeight(project, storey.id, 'gross', 2.7);
    step();
    marks = markPlanStep(marks, storey.id, 'boundary');
    step();
    marks = markPlanStep(marks, storey.id, 'opening');
    step();
    project = confirmNorth(project);
    step();
    marks = markPlanStep(marks, storey.id, 'rooms');
    step();
    project = setBottom(setTop(project, { kind: 'flat-roof' }), 'slab-on-ground');
    step();

    expect(seen[0]).toBe(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!, `validation ${i}`).toBeGreaterThan(seen[i - 1]!);
    expect(seen[seen.length - 1]).toBe(1);
    expect(computeMeters(project, marks).complete).toBe(1);

    // Les notes de visite ne changent aucun chiffre : elles ne font pas bouger les jauges.
    const before = computeMeters(project, marks);
    const after = computeMeters(setAnswers(project, { occasion: 'existing', buildingType: 'EFH', dwellings: 1, yearBuilt: 1974 }), marks);
    expect(after.complete).toBe(before.complete);
    expect(after.confirmed).toBe(before.confirmed);
    storey = project.model.storeys[0]!;
    expect(storey.clearHeight.from).toBe('default'); // la hauteur libre, facultative, n'empêche pas les 100 %
  });

  it('une toiture inclinée choisie mais pas confirmée est renseignée, pas confirmée', () => {
    const { project } = withStorey(sheet('s1', 'RDC'));
    const chosen = setTop(project, { kind: 'pitched-roof' }, false);
    expect(meterSlots(chosen, emptyMarks()).find((s) => s.key === 'top')).toEqual({ key: 'top', filled: true, confirmed: false });
    expect(meterSlots(setTop(chosen, {}), emptyMarks()).find((s) => s.key === 'top')).toEqual({ key: 'top', filled: true, confirmed: true });
  });

  it('« confirmé » ne dépasse jamais « complet »', () => {
    const { project, storey } = withStorey(sheet('s1', 'RDC'));
    const marks = markPlanStep(emptyMarks(), storey.id, 'outline');
    for (const p of [project, confirmScale(project, storey.id), setTop(project, { kind: 'flat-roof' })]) {
      const m = computeMeters(p, marks);
      expect(m.confirmed).toBeLessThanOrEqual(m.complete);
    }
  });
});

describe('indicateur d’étapes de la barre du haut', () => {
  it('ne coche une étape que lorsque son travail est fait', () => {
    const empty = createEmptyProject('fr');
    expect(stepsDone(empty, emptyMarks())).toEqual({ home: false, read: false, plan: false, questions: false, result: false });

    const loaded = toLoadedDocument(doc('maison.dxf', [sheet('cad-1', 'RDC')]));
    const project = createEmptyProject('fr');
    project.model.storeys.push(createStorey(loaded.doc.sheets[0]!, 'RDC', project.model));
    // Plan lu et étage construit : accueil et lecture sont faits ; le plan et la question, non.
    expect(stepsDone(project, emptyMarks(), [loaded])).toEqual({ home: true, read: true, plan: false, questions: false, result: false });

    const all = confirmEverything(project, emptyMarks());
    expect(stepsDone(all.project, all.marks, [loaded]).plan).toBe(true);
    // Un seul repère manquant suffit à retirer la coche.
    const partial: Marks = { ...all.marks, plan: { [project.model.storeys[0]!.id]: { outline: true, boundary: true } } };
    expect(stepsDone(all.project, partial, [loaded]).plan).toBe(false);

    // La seule question indispensable : toiture ET plancher bas.
    expect(stepsDone(setTop(project, { kind: 'flat-roof' }), emptyMarks(), [loaded]).questions).toBe(false);
    expect(stepsDone(setBottom(setTop(project, { kind: 'flat-roof' }), 'slab-on-ground'), emptyMarks(), [loaded]).questions).toBe(true);
  });

  it('une grille vierge ne passe pas par la lecture : cette étape n’est pas cochée', () => {
    const { project } = withStorey(null);
    expect(stepsDone(project, emptyMarks())).toMatchObject({ home: true, read: false });
  });
});

describe('étapes jamais confirmées (rappel de la page de résultat)', () => {
  it('les donne étage par étage, dans l’ordre, et n’y met aucun étage en règle', () => {
    const project = createEmptyProject('fr');
    project.model.storeys.push(createStorey(sheet('a', 'RDC'), 'RDC', project.model));
    project.model.storeys.push(createStorey(sheet('b', 'Étage'), 'Étage', project.model));
    const [lower, upper] = project.model.storeys as [Storey, Storey];

    const nothing = unconfirmedSteps(project, emptyMarks());
    expect(nothing.map((e) => e.storey.id)).toEqual([lower.id, upper.id]);
    expect(nothing[0]!.steps.map((s) => s.key)).toEqual([...PLAN_STEP_KEYS]);

    // Le rez-de-chaussée entièrement validé disparaît de la liste ; l'étage garde ce qui lui manque.
    let p = confirmNorth(confirmStoreyHeight(confirmScale(project, lower.id), lower.id, 'gross'));
    p = setNetArea(p, lower.id, 60);
    let marks = emptyMarks();
    for (const key of ['outline', 'boundary', 'opening'] as const) marks = markPlanStep(marks, lower.id, key);
    const rest = unconfirmedSteps(p, marks);
    expect(rest.map((e) => e.storey.id)).toEqual([upper.id]);
    expect(rest[0]!.steps.map((s) => s.key)).toEqual(['scale', 'outline', 'height', 'boundary', 'opening', 'rooms']);

    const all = confirmEverything(setNetArea(p, upper.id, 55), marks);
    expect(unconfirmedSteps(all.project, all.marks)).toEqual([]);
  });
});

describe('défilement du guide', () => {
  it('centre l’étape active dans le bandeau horizontal, sans sortir des bornes', () => {
    const view = { width: 366, scrollWidth: 1090 };
    // Étape 3 du bandeau relevé sur téléphone (x = 317 à 555 dans le contenu) : hors champ avant, centrée après.
    const left = centredScrollLeft({ left: 304, width: 238 }, view);
    expect(left).toBe(304 + 119 - 183);
    expect(304 - left).toBeGreaterThanOrEqual(0);
    expect(304 + 238 - left).toBeLessThanOrEqual(view.width);
    // Première et dernière étapes : on ne défile ni avant le début ni après la fin.
    expect(centredScrollLeft({ left: 0, width: 111 }, view)).toBe(0);
    expect(centredScrollLeft({ left: 864, width: 226 }, view)).toBe(1090 - 366);
    // Bandeau qui tient en entier : rien à faire.
    expect(centredScrollLeft({ left: 120, width: 100 }, { width: 400, scrollWidth: 400 })).toBe(0);
  });

  it('montre l’explication de l’étape active sans faire sortir l’étape elle-même', () => {
    // Tout est visible : on ne bouge pas.
    expect(revealScrollTop(0, 580, 40, 560)).toBe(0);
    // L'explication dépasse en bas : on descend juste ce qu'il faut (marge comprise).
    expect(revealScrollTop(0, 580, 200, 640, 14)).toBe(74);
    // Explication trop longue pour tenir : l'étape active reste en haut, on ne la dépasse jamais.
    expect(revealScrollTop(0, 580, 100, 1200, 14)).toBe(86);
    // L'étape active est au-dessus de la zone visible : on remonte jusqu'à elle.
    expect(revealScrollTop(300, 580, 120, 500, 14)).toBe(106);
    expect(revealScrollTop(50, 580, 5, 300, 14)).toBe(0);
  });
});
