/**
 * Liste guidée de l'écran « Plan » : pour un étage, l'état de chacune des six étapes et l'outil de l'éditeur
 * qui lui correspond. Fonctions pures.
 *
 * États :
 *  - todo      : rien d'exploitable, l'expert doit agir ;
 *  - toConfirm : le lecteur a proposé quelque chose (ou une hypothèse par défaut tient) → « à confirmer » ;
 *  - done      : saisi ou validé par l'expert ;
 *  - blocked   : dépend d'une étape précédente (pas de façades sans contour).
 */
import type { PlanSheet, Project, Storey } from '../../core/types';
import type { PlanTool } from '../plan';
import type { Marks, PlanStepKey } from './types';
import { PLAN_STEP_KEYS } from './types';

export type StepState = 'todo' | 'toConfirm' | 'done' | 'blocked';

export interface PlanStepInfo {
  key: PlanStepKey;
  tool: PlanTool;
  state: StepState;
  /** Ligne d'état : clé de traduction et variables (nombres bruts, mis en forme à l'affichage). */
  status: { key: string; params: Record<string, string | number> };
  /** Vrai si l'expert peut valider d'un toucher ce qui est proposé. */
  canConfirm: boolean;
}

export const STEP_TOOL: Record<PlanStepKey, PlanTool> = {
  scale: 'scale',
  outline: 'outline',
  boundary: 'boundary',
  opening: 'opening',
  north: 'north',
  rooms: 'rooms',
};

export function stepOfTool(tool: PlanTool): PlanStepKey | null {
  return (PLAN_STEP_KEYS as readonly string[]).includes(tool) ? (tool as PlanStepKey) : null;
}

function isWeak(from: string): boolean {
  return from === 'default' || from === 'estimate';
}

/**
 * États des six étapes pour un étage.
 * `sheet` = feuille de fond si elle est chargée (sert à savoir si une échelle a réellement été lue).
 */
export function planSteps(project: Project, storey: Storey, marks: Marks, sheet: PlanSheet | null): PlanStepInfo[] {
  const done = marks.plan[storey.id] ?? {};
  const hasOutline = storey.outline.length >= 3;
  const steps: PlanStepInfo[] = [];
  const add = (key: PlanStepKey, state: StepState, statusKey: string, params: Record<string, string | number> = {}, canConfirm = state === 'toConfirm'): void => {
    steps.push({ key, tool: STEP_TOOL[key], state, status: { key: statusKey, params }, canConfirm });
  };

  // 1. Échelle
  const scale = storey.metresPerUnit;
  if (storey.sheetId === null) {
    add('scale', 'done', 'shell.plan.status.scale.grid');
  } else if (scale.from === 'user') {
    add('scale', 'done', 'shell.plan.status.scale.user', { value: scale.value });
  } else if (!isWeak(scale.from)) {
    add('scale', 'toConfirm', 'shell.plan.status.scale.plan', { value: scale.value });
  } else {
    // Sans échelle lue du tout (feuille chargée dont l'échelle est inconnue), il n'y a rien à valider d'un toucher.
    const nothingRead = sheet !== null && sheet.metresPerUnit === null;
    add('scale', 'todo', nothingRead ? 'shell.plan.status.scale.unknown' : 'shell.plan.status.scale.weak', { value: scale.value }, !nothingRead);
  }

  // 2. Contour chauffé
  if (!hasOutline) add('outline', 'todo', 'shell.plan.status.outline.none');
  else add('outline', done.outline ? 'done' : 'toConfirm', 'shell.plan.status.outline.some', { points: storey.outline.length });

  // 3. Ce qu'il y a derrière chaque façade
  if (!hasOutline) {
    add('boundary', 'blocked', 'shell.plan.status.needOutline');
  } else {
    const other = storey.edges.filter((e) => e.boundary !== 'outside').length;
    add(
      'boundary',
      done.boundary ? 'done' : 'toConfirm',
      other === 0 ? 'shell.plan.status.boundary.allOutside' : 'shell.plan.status.boundary.mixed',
      { other, total: storey.edges.length },
    );
  }

  // 4. Fenêtres et portes
  if (!hasOutline) {
    add('opening', 'blocked', 'shell.plan.status.needOutline');
  } else {
    const windows = storey.openings.filter((o) => o.kind === 'window').reduce((n, o) => n + o.count, 0);
    const doors = storey.openings.filter((o) => o.kind === 'door').reduce((n, o) => n + o.count, 0);
    if (storey.openings.length === 0) add('opening', done.opening ? 'done' : 'todo', 'shell.plan.status.opening.none', {}, true);
    else add('opening', done.opening ? 'done' : 'toConfirm', 'shell.plan.status.opening.some', { windows, doors });
  }

  // 5. Nord (commun à tout le bâtiment)
  const north = project.model.northAngle;
  const northParams = { angle: Math.round(north.value) };
  if (north.from === 'user') add('north', 'done', 'shell.plan.status.north.user', northParams);
  else if (!isWeak(north.from)) add('north', 'toConfirm', 'shell.plan.status.north.plan', northParams);
  else add('north', 'todo', north.from === 'estimate' ? 'shell.plan.status.north.weak' : 'shell.plan.status.north.default', northParams, true);

  // 6. Pièces chauffées (An)
  const toDecide = storey.rooms.filter((r) => r.needsReview).length;
  if (storey.netAreaOverride) {
    add('rooms', 'done', 'shell.plan.status.rooms.override', { area: storey.netAreaOverride.value });
  } else if (storey.rooms.length === 0) {
    add('rooms', 'todo', 'shell.plan.status.rooms.none', {}, false);
  } else if (toDecide > 0) {
    add('rooms', 'todo', 'shell.plan.status.rooms.toDecide', { count: toDecide }, false);
  } else {
    const heated = storey.rooms.filter((r) => r.heated).length;
    add('rooms', done.rooms ? 'done' : 'toConfirm', 'shell.plan.status.rooms.some', { heated, total: storey.rooms.length });
  }

  return steps;
}

/** Première étape encore ouverte après `current` (en bouclant) ; null si tout est fait. */
export function nextOpenStep(steps: readonly PlanStepInfo[], current: PlanStepKey | null): PlanStepKey | null {
  const start = current === null ? -1 : steps.findIndex((s) => s.key === current);
  for (let k = 1; k <= steps.length; k++) {
    const step = steps[(start + k + steps.length) % steps.length];
    if (step && (step.state === 'todo' || step.state === 'toConfirm')) return step.key;
  }
  return null;
}

/** Première étape ouverte en partant du début ; à défaut la première étape. */
export function firstOpenStep(steps: readonly PlanStepInfo[]): PlanStepKey {
  return steps.find((s) => s.state === 'todo' || s.state === 'toConfirm')?.key ?? 'scale';
}

export function countDone(steps: readonly PlanStepInfo[]): number {
  return steps.filter((s) => s.state === 'done').length;
}

/** Vrai si toutes les étapes de tous les étages sont faites. */
export function allStoreysDone(project: Project, marks: Marks): boolean {
  return (
    project.model.storeys.length > 0 &&
    project.model.storeys.every((s) => planSteps(project, s, marks, null).every((step) => step.state === 'done'))
  );
}

/** Marque une étape comme validée pour un étage. */
export function markPlanStep(marks: Marks, storeyId: string, key: PlanStepKey): Marks {
  if (marks.plan[storeyId]?.[key]) return marks;
  return { ...marks, plan: { ...marks.plan, [storeyId]: { ...marks.plan[storeyId], [key]: true } } };
}

/** Retire les repères d'un étage supprimé. */
export function dropStoreyMarks(marks: Marks, storeyId: string): Marks {
  if (!(storeyId in marks.plan)) return marks;
  const plan = { ...marks.plan };
  delete plan[storeyId];
  return { ...marks, plan };
}
