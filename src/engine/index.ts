/**
 * Moteur : du bâtiment confirmé par l'expert aux tableaux de saisie de LuxEeB-Tool.
 * API PUBLIQUE (contrat) — l'implémentation vit dans les autres fichiers de src/engine/.
 */
import type {
  BuildingModel,
  Construction,
  Lang,
  LuxeebSheets,
  PlanDocument,
  PlanSheet,
  Project,
  ProjectAnswers,
  Storey,
  WindowType,
} from '../core/types';

/** Mesures instantanées d'un étage, pour l'affichage en direct pendant le tracé. */
export interface StoreyMetrics {
  /** Surface brute du contour (m²). */
  grossArea: number;
  /** Périmètre du contour (m). */
  perimeter: number;
  /** Surface nette retenue pour An (m²) et sa provenance. */
  netArea: number;
  netAreaFrom: 'override' | 'rooms' | 'estimate';
  /** Volume brut de l'étage (m³), hors volume sous toiture. */
  grossVolume: number;
  /** Longueur de façade par arête (m), même ordre que storey.outline. */
  edgeLengths: number[];
}

/** Réponses vides. */
export function emptyAnswers(): ProjectAnswers {
  throw new Error('engine.emptyAnswers: pas encore implémenté');
}

/** Types d'éléments par défaut (un par catégorie et condition aux limites usuelle), noms dans la langue donnée. */
export function defaultConstructions(_lang: Lang): Construction[] {
  throw new Error('engine.defaultConstructions: pas encore implémenté');
}

export function defaultWindowTypes(_lang: Lang): WindowType[] {
  throw new Error('engine.defaultWindowTypes: pas encore implémenté');
}

/** Projet vide : aucun étage, toiture/plancher par défaut (marqués 'default'), types par défaut. */
export function createEmptyProject(_lang: Lang): Project {
  throw new Error('engine.createEmptyProject: pas encore implémenté');
}

/**
 * Nouvel étage à partir d'une feuille : reprend le contour, les pièces et les ouvertures PROPOSÉS par le lecteur
 * (provenance 'plan'), l'échelle de la feuille, et met des hauteurs par défaut (provenance 'default') si le plan
 * n'en donne pas. `sheet` null = étage vide sans plan (1 uf = 1 m).
 */
export function createStorey(_sheet: PlanSheet | null, _name: string, _model: BuildingModel): Storey {
  throw new Error('engine.createStorey: pas encore implémenté');
}

/**
 * Premier jet complet à partir d'un document lu : un étage par feuille qui a un contour proposé
 * (triés du bas vers le haut quand les noms/altitudes le permettent), nord du document s'il existe.
 */
export function modelFromDocument(_doc: PlanDocument, _lang: Lang): BuildingModel {
  throw new Error('engine.modelFromDocument: pas encore implémenté');
}

export function storeyMetrics(_storey: Storey): StoreyMetrics {
  throw new Error('engine.storeyMetrics: pas encore implémenté');
}

/** Calcule tous les tableaux LuxEeB-Tool, les totaux et les contrôles de plausibilité. Fonction pure. */
export function deriveSheets(_project: Project, _lang: Lang): LuxeebSheets {
  throw new Error('engine.deriveSheets: pas encore implémenté');
}
