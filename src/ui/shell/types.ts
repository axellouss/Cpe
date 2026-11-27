/**
 * Types propres à l'application qui entoure l'éditeur de plan (écrans, repères d'avancement, documents chargés).
 * Le modèle du bâtiment lui-même vit dans src/core/types.ts.
 */
import type { Lang, PlanDocument, Project } from '../../core/types';
import type { ClosedFormat } from '../../readers';

/** Les cinq écrans, dans l'ordre du parcours. */
export type Step = 'home' | 'read' | 'plan' | 'questions' | 'result';
export const STEPS: readonly Step[] = ['home', 'read', 'plan', 'questions', 'result'];

/**
 * Étapes de la liste guidée de l'écran « Plan », dans l'ordre. « height » (hauteur d'étage brute) est la seule
 * qui ne se joue pas sur le plan : une vue en plan ne la donne pas, elle se choisit d'un toucher dans le guide.
 */
export type PlanStepKey = 'scale' | 'outline' | 'height' | 'boundary' | 'opening' | 'north' | 'rooms';
export const PLAN_STEP_KEYS: readonly PlanStepKey[] = ['scale', 'outline', 'height', 'boundary', 'opening', 'north', 'rooms'];

/** Écrans de questions, dans l'ordre. « identity » est facultatif et vient en dernier. */
export type QuestionId =
  | 'context'
  | 'year'
  | 'closure'
  | 'insulation'
  | 'windows'
  | 'heating'
  | 'hotWater'
  | 'ventilation'
  | 'solar'
  | 'identity';

export type ExpertTab = 'constructions' | 'windowTypes' | 'manual' | 'rooms' | 'storeys';
export const EXPERT_TABS: readonly ExpertTab[] = ['constructions', 'windowTypes', 'manual', 'rooms', 'storeys'];

/**
 * Repères d'avancement qui ne sont pas dans le modèle : ce que l'expert a validé d'un toucher.
 * Ils voyagent avec le projet dans l'historique (annuler les rétablit) et dans l'enregistrement automatique.
 */
export interface Marks {
  /** Étapes du plan validées, par identifiant d'étage. */
  plan: Record<string, Partial<Record<PlanStepKey, true>>>;
  /** Questions vues : répondue, ou passée par « je ne sais pas ». */
  questions: Partial<Record<QuestionId, 'answered' | 'skipped'>>;
  /** Vrai si l'année de construction vient d'une période (année approximative à préciser). */
  yearFromPeriod: boolean;
  /**
   * Lignes du résultat cochées « saisie dans LuxEeB-Tool » (clé de ligne → vrai). Elles appartiennent au projet :
   * un autre bâtiment repart sans coche, et le fichier de projet les emporte.
   */
  entered: Record<string, true>;
}

export function emptyMarks(): Marks {
  return { plan: {}, questions: {}, yearFromPeriod: false, entered: {} };
}

/** Ce que l'historique annule et rétablit d'un bloc. */
export interface Workspace {
  project: Project;
  marks: Marks;
}

/** Un fichier de plan lu, avec les adresses d'objets (blob:) à libérer quand on le retire. */
export interface LoadedDocument {
  /** Nom du fichier : sert aussi d'espace de noms aux identifiants de feuilles. */
  id: string;
  doc: PlanDocument;
  urls: string[];
  /** Empreinte du contenu lu : distingue le même fichier redéposé d'un AUTRE fichier qui porte le même nom. */
  signature?: string;
  /** Langue dans laquelle le lecteur a rédigé ses remarques (celle de l'interface au moment de la lecture). */
  readLang?: Lang;
}

/** Suivi de la lecture d'un fichier déposé. */
export interface ReadingItem {
  name: string;
  status: 'reading' | 'done' | 'error' | 'unsupported';
  message?: string;
}

/** Fichier d'un format fermé (Archicad, Revit…) : on explique comment l'exporter. */
export interface ClosedFile {
  format: ClosedFormat;
  fileName: string;
}

/** Message bref affiché en bas de l'écran. */
export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'ok' | 'warn';
}
