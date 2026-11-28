/**
 * Types propres à l'application qui entoure l'éditeur de plan (écrans, repères d'avancement, documents chargés).
 * Le modèle du bâtiment lui-même vit dans src/core/types.ts.
 */
import type { Lang, PlanDocument, Project } from '../../core/types';
import type { ClosedFormat } from '../../readers';

/**
 * Les écrans. Parcours GUIDÉ (repli, et seul parcours des fichiers DWG, DXF, IFC et images) : les cinq de `STEPS`.
 * Parcours AUTOMATIQUE (planche PDF bien lue) : accueil (lecture), « Voici ce que j'ai lu » (`overview`), questions
 * de doute (`doubts`), dossier (`dossier`) ; l'éditeur de plan (`plan`) n'y sert qu'à « corriger sur le plan ».
 */
export type GuidedStep = 'home' | 'read' | 'plan' | 'questions' | 'result';
export type Step = GuidedStep | 'overview' | 'doubts' | 'dossier';
export const STEPS: readonly GuidedStep[] = ['home', 'read', 'plan', 'questions', 'result'];
/** Indicateur du parcours automatique : Lecture, Lu, Doutes, Dossier. */
export const AUTO_STEPS: readonly Step[] = ['home', 'overview', 'doubts', 'dossier'];
/** Tous les écrans (relecture prudente d'une position enregistrée). */
export const ALL_STEPS: readonly Step[] = [...STEPS, 'overview', 'doubts', 'dossier'];

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
  /**
   * Parcours du projet : 'auto' quand le bâtiment vient de la lecture automatique d'une planche (cartes de doute).
   * Absent = parcours guidé (projets enregistrés avant ce parcours compris).
   */
  flow?: 'auto';
  /**
   * Réponses aux questions de doute, par identifiant de doute (engine/doubts `DoubtId`). `stamp` est l'empreinte de
   * la question au moment de la réponse : si la relecture ou une correction la change, la question revient.
   */
  doubts?: Record<string, DoubtMark>;
}

export interface DoubtMark {
  value: string;
  stamp: string;
  via: 'card' | 'confirmAll';
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
  /** Vrai si le fichier d'origine est encore sous la main : il peut être relu d'un geste (dans une autre langue). */
  rereadable?: boolean;
}

/** Étapes de la lecture d'une planche montrées pendant qu'elle se fait (celles du lecteur, puis les questions). */
export type ReadingStageKey = 'open' | 'views' | 'rooms' | 'envelope' | 'layers' | 'check' | 'doubts';
export const READING_STAGES: readonly ReadingStageKey[] = ['open', 'views', 'rooms', 'envelope', 'layers', 'check', 'doubts'];

export interface ReadingStage {
  key: ReadingStageKey;
  status: 'pending' | 'running' | 'done' | 'skipped';
  /** Ce qui a été trouvé, en phrase courte (clé de traduction + paramètres). */
  detail?: { key: string; params: Record<string, string | number> };
}

/** Retour de « corriger sur le plan » : l'écran d'origine et ce que l'on corrige. */
export interface FixReturn {
  step: Step;
  /** Ce que l'on corrige (clé de traduction de la donnée), pour le bandeau « Vous corrigez : … ». */
  what: string;
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
