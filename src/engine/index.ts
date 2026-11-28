/**
 * Moteur : du bâtiment confirmé par l'expert aux tableaux de saisie de LuxEeB-Tool.
 * API PUBLIQUE (contrat) — l'implémentation vit dans les autres fichiers de src/engine/.
 *
 * Importer ce module enregistre aussi les textes du moteur (« finding.<code> », noms par défaut) dans src/i18n.
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
import * as defaults from './defaults';
import * as derive from './derive';
import './messages';
import { ridgeChoices, type RidgeChoice } from './roof';
import * as storeys from './storey';

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
  return defaults.emptyAnswers();
}

/** Types d'éléments par défaut (un par catégorie et condition aux limites usuelle), noms dans la langue donnée. */
export function defaultConstructions(lang: Lang): Construction[] {
  return defaults.defaultConstructions(lang);
}

export function defaultWindowTypes(lang: Lang): WindowType[] {
  return defaults.defaultWindowTypes(lang);
}

/** Projet vide : aucun étage, toiture/plancher par défaut (marqués 'default'), types par défaut. */
export function createEmptyProject(lang: Lang): Project {
  return defaults.createEmptyProject(lang);
}

/**
 * Nouvel étage à partir d'une feuille : reprend le contour, les pièces et les ouvertures PROPOSÉS par le lecteur
 * (provenance 'plan'), l'échelle de la feuille, et met des hauteurs par défaut (provenance 'default') si le plan
 * n'en donne pas. `sheet` null = étage vide sans plan (1 uf = 1 m).
 */
export function createStorey(sheet: PlanSheet | null, name: string, model: BuildingModel): Storey {
  return storeys.createStorey(sheet, name, model);
}

/**
 * Premier jet complet à partir d'un document lu : un étage par feuille qui a un contour proposé
 * (triés du bas vers le haut quand les noms/altitudes le permettent), nord du document s'il existe.
 */
export function modelFromDocument(doc: PlanDocument, lang: Lang): BuildingModel {
  return storeys.modelFromDocument(doc, lang);
}

export function storeyMetrics(storey: Storey): StoreyMetrics {
  return storeys.storeyMetrics(storey);
}

/** Calcule tous les tableaux LuxEeB-Tool, les totaux et les contrôles de plausibilité. Fonction pure. */
export function deriveSheets(project: Project, lang: Lang): LuxeebSheets {
  return derive.deriveSheets(project, lang);
}

// ───────────────────────────── Compléments (hors contrat initial) ─────────────────────────────

export { basementSheetIds, isBasementSheetName, orderSheetsBottomUp, proposeTopClosure, rescaleStorey, restoreFootprint, roomsOutsideOutline, pickRoomArea } from './storey';
export { DEFAULT_CONSTRUCTION_IDS, DEFAULT_WINDOW_TYPE_ID } from './defaults';
export { FINDING_CODES, findingText, type FindingCode } from './messages';
export { weakest } from './provenance';
// Dossier CPE : ordre « expert », hauteurs d'enveloppe, pré-calcul U / Uw, matériaux, doutes.
export { envelopeHeights, facadeViewsFromReading, withExpertWindowTypes, type EnvelopeHeights } from './derive';
export { computeU, computeUw, precalculatedU, precalculatedUw, proposeFensterTyp, type UResult, type UwResult } from './uvalue';
export {
  MATERIAL_LIBRARY,
  constructionFromComposition,
  confirmOfficeLambda,
  doorHypothesis,
  emptyOfficeLibrary,
  lambdaFor,
  sanitizeOfficeLibrary,
  windowTypeHypothesis,
  type OfficeLibrary,
} from './materials';
export { DOUBT_CATALOG, OFF_PLAN_DOUBTS, answerUnknown, collectDoubts, confirmedAnswers, evaluate, isPlanDoubt, type Doubt, type DoubtId, type DoubtPart, type Signal } from './doubts';
export {
  carryOverFromPrevious,
  excludeRoomFromOutline,
  proposeHeatedOutline,
  unheatedRoomsInsideOutline,
  type CarryOver,
  type HeatedOutlineProposal,
} from './heatedOutline';

/**
 * Sens de faîtage possibles pour la toiture inclinée du dernier étage, avec l'orientation des pans de chacun.
 * Vide pour un toit à croupes ou tant qu'aucun étage n'a de contour.
 */
export function roofRidgeChoices(model: BuildingModel): RidgeChoice[] {
  const storey = model.storeys[model.storeys.length - 1];
  const scale = storey?.metresPerUnit.value ?? 0;
  if (!storey || storey.outline.length < 3 || !(scale > 0)) return [];
  const poly = storey.outline.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  return ridgeChoices(poly, model.top, model.northAngle.value, poly.map((_, i) => storey.edges[i]?.boundary));
}
export type { RidgeChoice } from './roof';
export { applyDoubtAnswer, buildAutoProject, DOUBT_CONFIRM, DOUBT_UNKNOWN, MAX_AUTO_DOUBTS, type AutoBuild } from './auto';
