/**
 * Liste guidée de l'écran « Plan » : pour un étage, l'état de chacune des étapes et l'outil de l'éditeur
 * qui lui correspond. Fonctions pures.
 *
 * États :
 *  - todo      : rien d'exploitable, l'expert doit agir ;
 *  - toConfirm : le lecteur a proposé quelque chose (ou une hypothèse par défaut tient) → « à confirmer » ;
 *  - done      : saisi ou validé par l'expert (ou rien à valider : grille vierge, maquette en vraie grandeur,
 *                hauteur lue sur une coupe, dernier étage sous une toiture inclinée confirmée) ;
 *  - blocked   : dépend d'une étape précédente (pas de façades sans contour).
 *
 * Ce sont ces états, et eux seuls, qui disent « confirmé » partout dans l'application : onglets d'étages, jauges
 * de la barre du haut, coche de l'étape « Plan », rappel des étapes non confirmées sur la page de résultat.
 */
import type { PlanSheet, Project, SourceKind, Storey } from '../../core/types';
import type { PlanTool } from '../plan';
import { fileNameOfSheetId, findSheet } from './documents';
import type { LoadedDocument, Marks, PlanStepKey } from './types';

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

/** Outil de l'éditeur montré pendant chaque étape. La hauteur ne se joue pas sur le plan : on le laisse simplement visible. */
export const STEP_TOOL: Record<PlanStepKey, PlanTool> = {
  scale: 'scale',
  outline: 'outline',
  height: 'pan',
  boundary: 'boundary',
  opening: 'opening',
  north: 'north',
  rooms: 'rooms',
};

const TOOL_STEP: Partial<Record<PlanTool, PlanStepKey>> = {
  scale: 'scale',
  outline: 'outline',
  boundary: 'boundary',
  opening: 'opening',
  north: 'north',
  rooms: 'rooms',
};

/** Étape que termine un outil de l'éditeur ; null pour « se déplacer », qui ne termine rien. */
export function stepOfTool(tool: PlanTool): PlanStepKey | null {
  return TOOL_STEP[tool] ?? null;
}

/**
 * Étapes dont la validation se fait SUR LE PLAN : l'éditeur y porte son propre bouton (« Le contour est bon »,
 * « Le nord est bon »). Le guide n'en affiche pas un second ; il renvoie vers celui du plan.
 */
export const CONFIRMED_ON_PLAN: Partial<Record<PlanStepKey, string>> = {
  outline: 'plan.outline.accept',
  north: 'plan.north.confirm',
};

/** Hauteurs d'étage brutes proposées d'un toucher (m). */
export const HEIGHT_CHOICES: readonly number[] = [2.5, 2.6, 2.7, 2.8, 3];

function isWeak(from: string): boolean {
  return from === 'default' || from === 'estimate';
}

/**
 * Maquette en vraie grandeur (IFC) : ses coordonnées SONT des mètres, il n'y a pas d'échelle à confirmer.
 * `kind` = nature du fichier quand il est chargé ; à défaut (projet rouvert sans ses plans), le nom du fichier
 * gardé dans l'identifiant de la feuille en tient lieu.
 */
export function isRealSizeModel(storey: Storey, kind: SourceKind | null = null): boolean {
  if (storey.sheetId === null || storey.metresPerUnit.from !== 'plan') return false;
  if (kind !== null) return kind === 'ifc';
  return /\.ifc(?: \(\d+\))?$/i.test(fileNameOfSheetId(storey.sheetId));
}

/**
 * Vrai si la hauteur d'étage brute de cet étage ne sert à rien : dernier étage sous une toiture inclinée CONFIRMÉE
 * (le moteur tire alors les hauteurs de murs et le volume de la pente et de la jambette).
 */
export function grossHeightUnused(project: Project, storey: Storey): boolean {
  const { top, storeys } = project.model;
  return top.kind === 'pitched-roof' && top.from === 'user' && storeys[storeys.length - 1]?.id === storey.id;
}

/**
 * Autres étages dont l'échelle est la même affaire que celle de `storeyId` : fond venu du même fichier, même
 * valeur, pas encore confirmée. Confirmer l'une les confirme toutes (un dessin n'a qu'une unité).
 */
export function sameScaleStoreyIds(project: Project, storeyId: string): string[] {
  const storey = project.model.storeys.find((s) => s.id === storeyId);
  if (!storey || storey.sheetId === null) return [];
  const file = fileNameOfSheetId(storey.sheetId);
  const value = storey.metresPerUnit.value;
  const same = (other: number): boolean => Number.isFinite(value) && Math.abs(other - value) <= Math.abs(value) * 1e-9;
  return project.model.storeys
    .filter((s) => s.id !== storeyId && s.sheetId !== null && fileNameOfSheetId(s.sheetId) === file && s.metresPerUnit.from !== 'user' && same(s.metresPerUnit.value))
    .map((s) => s.id);
}

/**
 * États des étapes pour un étage.
 * `sheet` = feuille de fond si elle est chargée (sert à savoir si une échelle a réellement été lue) ;
 * `kind`  = nature du fichier d'où elle vient, s'il est chargé.
 */
export function planSteps(project: Project, storey: Storey, marks: Marks, sheet: PlanSheet | null, kind: SourceKind | null = null): PlanStepInfo[] {
  const done = marks.plan[storey.id] ?? {};
  const hasOutline = storey.outline.length >= 3;
  const steps: PlanStepInfo[] = [];
  const add = (
    key: PlanStepKey,
    state: StepState,
    statusKey: string,
    params: Record<string, string | number> = {},
    canConfirm = state === 'toConfirm',
    tool: PlanTool = STEP_TOOL[key],
  ): void => {
    steps.push({ key, tool, state, status: { key: statusKey, params }, canConfirm });
  };

  // 1. Échelle
  const scale = storey.metresPerUnit;
  if (storey.sheetId === null) {
    add('scale', 'done', 'shell.plan.status.scale.grid');
  } else if (scale.from === 'user') {
    add('scale', 'done', 'shell.plan.status.scale.user', { value: scale.value });
  } else if (isRealSizeModel(storey, kind)) {
    // Rien à mesurer sur une maquette : l'étape rouverte montre le plan (outil de déplacement), pas la règle.
    add('scale', 'done', 'shell.plan.status.scale.model', {}, false, 'pan');
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

  // 3. Hauteur d'étage brute : la seule valeur géométrique qu'une vue en plan ne donne pas.
  const gross = storey.grossHeight;
  if (grossHeightUnused(project, storey)) {
    add('height', 'done', 'shell.plan.status.height.roof');
  } else if (gross.from === 'user') {
    add('height', 'done', 'shell.plan.status.height.user', { height: gross.value });
  } else if (gross.from === 'estimate') {
    // Lue, mais pas comme une hauteur de dalle à dalle (sommet des murs d'une maquette) : à valider.
    add('height', 'toConfirm', 'shell.plan.status.height.read', { height: gross.value });
  } else if (gross.from === 'default') {
    // Une valeur par défaut ne se « confirme » pas : l'expert choisit la hauteur (une pastille ou le champ).
    add('height', 'todo', 'shell.plan.status.height.default', { height: gross.value }, false);
  } else {
    // Lue sur le plan (maquette, coupe) : rien à valider.
    add('height', 'done', 'shell.plan.status.height.plan', { height: gross.value });
  }

  // 4. Ce qu'il y a derrière chaque façade
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

  // 5. Fenêtres et portes
  if (!hasOutline) {
    add('opening', 'blocked', 'shell.plan.status.needOutline');
  } else {
    const windows = storey.openings.filter((o) => o.kind === 'window').reduce((n, o) => n + o.count, 0);
    const doors = storey.openings.filter((o) => o.kind === 'door').reduce((n, o) => n + o.count, 0);
    if (storey.openings.length === 0) add('opening', done.opening ? 'done' : 'todo', 'shell.plan.status.opening.none', {}, true);
    else add('opening', done.opening ? 'done' : 'toConfirm', 'shell.plan.status.opening.some', { windows, doors });
  }

  // 6. Nord (commun à tout le bâtiment)
  const north = project.model.northAngle;
  const northParams = { angle: Math.round(north.value) };
  if (north.from === 'user') add('north', 'done', 'shell.plan.status.north.user', northParams);
  else if (!isWeak(north.from)) add('north', 'toConfirm', 'shell.plan.status.north.plan', northParams);
  else add('north', 'todo', north.from === 'estimate' ? 'shell.plan.status.north.weak' : 'shell.plan.status.north.default', northParams, true);

  // 7. Pièces chauffées (An)
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

/** Nature du fichier d'où vient une feuille, s'il est chargé. */
function kindOfSheet(documents: readonly LoadedDocument[], sheetId: string | null): SourceKind | null {
  if (sheetId === null) return null;
  return documents.find((d) => d.doc.sheets.some((s) => s.id === sheetId))?.doc.kind ?? null;
}

/** États des étapes d'un étage, le fond de plan étant cherché parmi les documents chargés. */
export function storeySteps(project: Project, storey: Storey, marks: Marks, documents: readonly LoadedDocument[]): PlanStepInfo[] {
  return planSteps(project, storey, marks, findSheet(documents, storey.sheetId), kindOfSheet(documents, storey.sheetId));
}

/** Vrai si l'étape reste à faire ou à confirmer (une étape bloquée attend, elle, une étape précédente). */
function isOpen(step: PlanStepInfo): boolean {
  return step.state === 'todo' || step.state === 'toConfirm';
}

/** Première étape encore ouverte après `current` (en bouclant) ; null si tout est fait. */
export function nextOpenStep(steps: readonly PlanStepInfo[], current: PlanStepKey | null): PlanStepKey | null {
  const start = current === null ? -1 : steps.findIndex((s) => s.key === current);
  for (let k = 1; k <= steps.length; k++) {
    const step = steps[(start + k + steps.length) % steps.length];
    if (step && isOpen(step)) return step.key;
  }
  return null;
}

/** Première étape ouverte en partant du début ; à défaut la première étape. */
export function firstOpenStep(steps: readonly PlanStepInfo[]): PlanStepKey {
  return steps.find(isOpen)?.key ?? 'scale';
}

export function countDone(steps: readonly PlanStepInfo[]): number {
  return steps.filter((s) => s.state === 'done').length;
}

/** Vrai si toutes les étapes de tous les étages sont faites. */
export function allStoreysDone(project: Project, marks: Marks, documents: readonly LoadedDocument[] = []): boolean {
  return (
    project.model.storeys.length > 0 &&
    project.model.storeys.every((s) => storeySteps(project, s, marks, documents).every((step) => step.state === 'done'))
  );
}

export interface UnconfirmedStorey {
  storey: Storey;
  /** Étapes qui ne sont pas « faites », dans l'ordre de la liste. */
  steps: PlanStepInfo[];
}

/**
 * Ce que l'expert n'a jamais validé sur le plan, étage par étage (aucun étage en règle n'y figure).
 * La page de résultat le rappelle : des valeurs proposées par le lecteur n'y passent pas pour confirmées.
 */
export function unconfirmedSteps(project: Project, marks: Marks, documents: readonly LoadedDocument[] = []): UnconfirmedStorey[] {
  // Le nord vaut pour tout le bâtiment : il n'est rappelé qu'une fois, au premier étage où il reste à valider.
  let northListed = false;
  return project.model.storeys
    .map((storey) => ({
      storey,
      steps: storeySteps(project, storey, marks, documents).filter((s) => {
        if (s.state === 'done') return false;
        if (s.key !== 'north') return true;
        if (northListed) return false;
        northListed = true;
        return true;
      }),
    }))
    .filter((entry) => entry.steps.length > 0);
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

// ───────────────────────────── Défilement du guide ─────────────────────────────

/**
 * Bandeau horizontal des étapes (écran étroit) : position de défilement qui centre l'étape active.
 * Positions mesurées dans le contenu du bandeau (px).
 */
export function centredScrollLeft(item: { left: number; width: number }, view: { width: number; scrollWidth: number }): number {
  const max = Math.max(0, view.scrollWidth - view.width);
  return Math.max(0, Math.min(max, item.left + item.width / 2 - view.width / 2));
}

/**
 * Colonne du guide (grand écran) : position de défilement qui montre le détail de l'étape active jusqu'en bas,
 * sans jamais faire sortir l'étape active elle-même par le haut. Positions mesurées dans le contenu (px) ;
 * `margin` = marge gardée au-dessus de l'étape et sous le détail (le bord haut de la colonne s'estompe sur 12 px).
 */
export function revealScrollTop(current: number, viewHeight: number, itemTop: number, detailBottom: number, margin = 14): number {
  let target = current;
  if (detailBottom + margin > target + viewHeight) target = detailBottom + margin - viewHeight;
  if (itemTop - margin < target) target = itemTop - margin;
  return Math.max(0, Math.round(target));
}
