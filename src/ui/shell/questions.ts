/**
 * Script des questions : ce que le plan ne peut pas dire. Un écran par question.
 *
 * UNE seule question est indispensable — ce qu'il y a au-dessus et en dessous du volume chauffé : c'est la seule
 * dont dépendent les valeurs calculées (enveloppe A, volume Ve). Elle vient en premier, et le résultat est
 * accessible aussitôt après. Les autres sont des NOTES DE VISITE facultatives : elles ne changent aucun chiffre et
 * sont simplement reprises en clair dans le guide de saisie, pour avoir tout le dossier au même endroit.
 * Fonctions pures : l'ordre, la pertinence et l'état de chaque question se déduisent du projet et des repères.
 */
import type { Project, ProjectAnswers } from '../../core/types';
import type { Marks, QuestionId } from './types';

/** Ordre des écrans : la question indispensable d'abord, puis les notes de visite. */
export const QUESTION_ORDER: readonly QuestionId[] = [
  'closure',
  'context',
  'year',
  'insulation',
  'windows',
  'heating',
  'hotWater',
  'ventilation',
  'solar',
  'identity',
];

/** Les questions dont dépendent les valeurs calculées : sans elles, pas de résultat fiable. */
export const REQUIRED_QUESTIONS: readonly QuestionId[] = ['closure'];

/** Questions hors du décompte « n sur N » (l'identité du projet, tout en bas). */
export const OPTIONAL_QUESTIONS: readonly QuestionId[] = ['identity'];

/** Vrai pour une note de visite : facultative, sans effet sur les valeurs calculées. */
export function isVisitNote(id: QuestionId): boolean {
  return !REQUIRED_QUESTIONS.includes(id);
}

/** Questions où « je ne sais pas » est une réponse acceptable (une valeur par défaut ou un champ vide en découle). */
export const CAN_SKIP: Record<QuestionId, boolean> = {
  context: true,
  year: true,
  closure: false,
  insulation: true,
  windows: true,
  heating: true,
  hotWater: true,
  ventilation: true,
  solar: true,
  identity: true,
};

/** Questions posées pour ce projet. L'isolation « ajoutée après coup » n'a pas de sens pour un bâtiment neuf. */
export function relevantQuestions(project: Project): QuestionId[] {
  return QUESTION_ORDER.filter((id) => !(id === 'insulation' && project.answers.occasion === 'new'));
}

/** Questions comptées (sans les facultatives). */
export function countedQuestions(project: Project): QuestionId[] {
  return relevantQuestions(project).filter((id) => !OPTIONAL_QUESTIONS.includes(id));
}

/** Vrai si tout ce que l'écran demande d'obligatoire est renseigné. */
export function isQuestionComplete(id: QuestionId, project: Project): boolean {
  const a = project.answers;
  switch (id) {
    case 'context':
      return a.occasion !== null && a.buildingType !== null && a.dwellings !== null;
    case 'year':
      return a.yearBuilt !== null;
    case 'closure':
      return project.model.top.from === 'user' && project.model.bottom.from === 'user';
    case 'insulation':
      return a.insulationWallsCm !== null && a.insulationRoofCm !== null && a.insulationFloorCm !== null;
    case 'windows':
      return a.windowGeneration !== null;
    case 'heating':
      return a.heatGenerator !== null && a.heatEmission !== null;
    case 'hotWater':
      return a.hotWater !== null;
    case 'ventilation':
      return a.ventilation !== null;
    case 'solar':
      return a.solarThermal !== null && a.photovoltaic !== null;
    case 'identity':
      return a.projectName.trim() !== '';
  }
}

/** Vrai si l'écran a au moins une réponse (même partielle). */
export function hasAnyAnswer(id: QuestionId, project: Project): boolean {
  const a = project.answers;
  switch (id) {
    case 'context':
      return a.occasion !== null || a.buildingType !== null || a.dwellings !== null;
    case 'year':
      return a.yearBuilt !== null;
    case 'closure':
      return project.model.top.from === 'user' || project.model.bottom.from === 'user';
    case 'insulation':
      return a.insulationWallsCm !== null || a.insulationRoofCm !== null || a.insulationFloorCm !== null;
    case 'windows':
      return a.windowGeneration !== null;
    case 'heating':
      return a.heatGenerator !== null || a.heatEmission !== null || a.heatGeneratorYear !== null;
    case 'hotWater':
      return a.hotWater !== null;
    case 'ventilation':
      return a.ventilation !== null || a.n50 !== null;
    case 'solar':
      return a.solarThermal !== null || a.photovoltaic !== null;
    case 'identity':
      return [a.projectName, a.street, a.postcode, a.locality].some((v) => v.trim() !== '');
  }
}

export type QuestionStatus = 'open' | 'partial' | 'answered' | 'skipped';

/**
 * État d'une question :
 *  - answered : complète ;
 *  - partial  : commencée, ou passée sur « continuer » avec des inconnues ;
 *  - skipped  : « je ne sais pas » ;
 *  - open     : pas encore vue.
 */
export function questionStatus(id: QuestionId, project: Project, marks: Marks): QuestionStatus {
  if (isQuestionComplete(id, project)) return 'answered';
  const mark = marks.questions[id];
  if (mark === 'skipped' && !hasAnyAnswer(id, project)) return 'skipped';
  if (hasAnyAnswer(id, project) || mark !== undefined) return 'partial';
  return 'open';
}

/** Première question pas encore vue ; null si toutes l'ont été. Les questions facultatives ne retiennent pas. */
export function firstOpenQuestion(project: Project, marks: Marks): QuestionId | null {
  return countedQuestions(project).find((id) => questionStatus(id, project, marks) === 'open') ?? null;
}

export function nextQuestion(id: QuestionId, project: Project): QuestionId | null {
  const list = relevantQuestions(project);
  const i = list.indexOf(id);
  return i < 0 ? (list[0] ?? null) : (list[i + 1] ?? null);
}

export function previousQuestion(id: QuestionId, project: Project): QuestionId | null {
  const list = relevantQuestions(project);
  const i = list.indexOf(id);
  return i <= 0 ? null : (list[i - 1] ?? null);
}

/** Rang (à partir de 1) et total pour « question n sur N » ; rank null pour une question facultative. */
export function questionRank(id: QuestionId, project: Project): { rank: number | null; total: number } {
  const counted = countedQuestions(project);
  const i = counted.indexOf(id);
  return { rank: i < 0 ? null : i + 1, total: counted.length };
}

/** Rang d'une note de visite parmi les notes comptées (« note n sur N ») ; null pour les autres questions. */
export function visitNoteRank(id: QuestionId, project: Project): { rank: number; total: number } | null {
  const notes = countedQuestions(project).filter(isVisitNote);
  const i = notes.indexOf(id);
  return i < 0 ? null : { rank: i + 1, total: notes.length };
}

export function markQuestion(marks: Marks, id: QuestionId, value: 'answered' | 'skipped'): Marks {
  if (marks.questions[id] === value) return marks;
  return { ...marks, questions: { ...marks.questions, [id]: value } };
}

/** Champs de réponses remis à « non renseigné » quand l'expert dit « je ne sais pas ». */
export function clearedAnswers(id: QuestionId): Partial<ProjectAnswers> {
  switch (id) {
    case 'year':
      return { yearBuilt: null };
    case 'insulation':
      return { insulationWallsCm: null, insulationRoofCm: null, insulationFloorCm: null };
    case 'windows':
      return { windowGeneration: null };
    case 'heating':
      return { heatGenerator: null, heatGeneratorYear: null, heatEmission: null };
    case 'hotWater':
      return { hotWater: null };
    case 'ventilation':
      return { ventilation: null, n50: null };
    case 'solar':
      return { solarThermal: null, photovoltaic: null };
    default:
      return {};
  }
}

// ───────────────────────────── Périodes de construction ─────────────────────────────

/**
 * Tranches proposées quand l'année exacte n'est pas connue. Ce sont de simples repères de l'outil (PAS les classes
 * d'âge officielles de la typologie des valeurs U) : choisir une tranche inscrit une année approximative,
 * signalée comme telle, que l'expert précisera.
 */
export interface Period {
  id: string;
  /** Première et dernière année de la tranche ; null = ouverte. */
  from: number | null;
  to: number | null;
  /** Année inscrite quand on choisit la tranche. */
  year: number;
}

export const PERIODS: readonly Period[] = [
  { id: 'p1', from: null, to: 1918, year: 1900 },
  { id: 'p2', from: 1919, to: 1944, year: 1930 },
  { id: 'p3', from: 1945, to: 1959, year: 1952 },
  { id: 'p4', from: 1960, to: 1969, year: 1965 },
  { id: 'p5', from: 1970, to: 1979, year: 1975 },
  { id: 'p6', from: 1980, to: 1994, year: 1987 },
  { id: 'p7', from: 1995, to: 2007, year: 2001 },
  { id: 'p8', from: 2008, to: 2016, year: 2012 },
  { id: 'p9', from: 2017, to: null, year: 2020 },
];

export function periodOfYear(year: number | null): Period | null {
  if (year === null || !Number.isFinite(year)) return null;
  return PERIODS.find((p) => (p.from === null || year >= p.from) && (p.to === null || year <= p.to)) ?? null;
}

export function periodLabel(period: Period): string {
  if (period.from === null) return `< ${(period.to ?? 0) + 1}`;
  if (period.to === null) return `≥ ${period.from}`;
  return `${period.from}–${period.to}`;
}

/** Année plausible pour une construction ou une installation. */
export function isPlausibleYear(year: number, now: number): boolean {
  return Number.isInteger(year) && year >= 1500 && year <= now + 3;
}
