/**
 * Appels protégés au moteur et à l'export. Les autres modules peuvent lever une erreur (cas non prévu, module
 * incomplet) : l'interface doit alors le dire gentiment et rester utilisable, jamais s'effondrer.
 * Les résultats sont mémorisés pour le dernier (projet, langue) : plusieurs composants les demandent à chaque rendu.
 */
import type { Lang, LuxeebSheets, Project, Storey } from '../../core/types';
import { deriveSheets, storeyMetrics } from '../../engine';
import type { StoreyMetrics } from '../../engine';
import { buildGuide } from '../../export';
import type { GuideSection } from '../../export';

export interface Derived {
  sheets: LuxeebSheets | null;
  /** Message technique de l'erreur, s'il y en a une (affiché en petit, pour le support). */
  error: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let lastDerived: { project: Project; lang: Lang; result: Derived } | null = null;

/** Tableaux LuxEeB-Tool, totaux et contrôles ; `sheets` null si le moteur a échoué. */
export function derive(project: Project, lang: Lang): Derived {
  if (lastDerived && lastDerived.project === project && lastDerived.lang === lang) return lastDerived.result;
  let result: Derived;
  try {
    result = { sheets: deriveSheets(project, lang), error: null };
  } catch (error) {
    result = { sheets: null, error: messageOf(error) };
  }
  lastDerived = { project, lang, result };
  return result;
}

export interface Guide {
  sections: GuideSection[] | null;
  error: string | null;
}

let lastGuide: { sheets: LuxeebSheets; project: Project; lang: Lang; result: Guide } | null = null;

/** Guide de saisie, dans l'ordre de LuxEeB-Tool ; `sections` null si l'export a échoué. */
export function guide(sheets: LuxeebSheets, project: Project, lang: Lang): Guide {
  if (lastGuide && lastGuide.sheets === sheets && lastGuide.project === project && lastGuide.lang === lang) return lastGuide.result;
  let result: Guide;
  try {
    result = { sections: buildGuide(sheets, project, lang), error: null };
  } catch (error) {
    result = { sections: null, error: messageOf(error) };
  }
  lastGuide = { sheets, project, lang, result };
  return result;
}

/** Mesures d'un étage ; null si le moteur a échoué. */
export function safeStoreyMetrics(storey: Storey): StoreyMetrics | null {
  try {
    return storeyMetrics(storey);
  } catch {
    return null;
  }
}

/** Vide les mémoires (tests). */
export function resetComputeCache(): void {
  lastDerived = null;
  lastGuide = null;
}
