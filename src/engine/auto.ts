/**
 * Bâtiment construit AUTOMATIQUEMENT à partir de la lecture d'une planche, et réponses aux questions de doute :
 * le contrat entre le moteur et l'interface du parcours « dépôt → lecture → doutes → dossier ».
 *
 * Principe : tout ce que la lecture donne avec assez de confiance entre dans le projet sans rien demander
 * (étages et contours chauffés, pièces, baies, hauteurs, toiture, parois et couches, identité du projet,
 * installations proposées) ; ce qui reste douteux devient une question (voir engine/doubts.ts). L'expert peut
 * toujours corriger sur le plan.
 */
import type { Lang, PlanDocument, Project } from '../core/types';
import type { Doubt } from './doubts';
import { modelFromDocument } from './storey';

export interface AutoBuild {
  project: Project;
  /**
   * Vrai si la lecture suffit pour le parcours « cartes de doute » : au moins un plan d'étage lu avec son contour
   * et une échelle sûre, une fermeture haute et basse proposées. Faux → parcours guidé sur le plan (repli).
   */
  sufficient: boolean;
  /** Feuilles retenues comme étages chauffés, du bas vers le haut (PlanSheet.id). */
  storeySheetIds: string[];
  /** Pourquoi la lecture ne suffit pas, ou ce qui a été écarté (phrases courtes, dans la langue demandée). */
  notes: string[];
}

/**
 * Construit le projet à partir d'un document lu. `base` fournit ce que l'utilisateur a déjà saisi (réponses,
 * bibliothèque du bureau) : une valeur confirmée par lui n'est jamais écrasée par la lecture.
 */
export function buildAutoProject(doc: PlanDocument, base: Project, lang: Lang): AutoBuild {
  const model = modelFromDocument(doc, lang);
  return {
    project: { ...base, model },
    sufficient: false,
    storeySheetIds: model.storeys.map((s) => s.sheetId).filter((id): id is string => id !== null),
    notes: [],
  };
}

/** Réponse spéciale « je ne sais pas » : la proposition est gardée, étiquetée hypothèse, et la question n'est plus posée. */
export const DOUBT_UNKNOWN = 'unknown';

/**
 * Applique la réponse à une question de doute : `value` est la valeur d'un des choix de `doubt.options`, une saisie
 * libre (nombre écrit avec une virgule ou un point) ou DOUBT_UNKNOWN. La question ne doit plus revenir ensuite
 * (collectDoubts la considère comme tranchée), sauf si la lecture change.
 */
export function applyDoubtAnswer(project: Project, doubt: Doubt, value: string, lang: Lang): Project {
  void doubt;
  void value;
  void lang;
  return project;
}
