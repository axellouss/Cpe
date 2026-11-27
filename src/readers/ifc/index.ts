/**
 * Lecteur IFC : une feuille par étage réel du modèle, avec contour extérieur, ouvertures, pièces et hauteurs proposés.
 * Tout se passe sur le poste de l'utilisateur (web-ifc en WebAssembly) ; rien n'est envoyé nulle part.
 *
 * Organisation :
 *  - analyse.ts       analyse pure, reçoit une instance web-ifc déjà initialisée et assemble le document ;
 *  - webifc.ts        seule frontière avec la bibliothèque (lignes STEP non typées, triangulation) ;
 *  - model.ts         lecture sémantique : unités, nord, niveaux, locaux, fenêtres et portes ;
 *  - bands.ts         choix des étages réels et découpe en tranches de hauteur ;
 *  - raster.ts, footprint.ts, outline.ts   emprise tramée, morceaux, contour raccroché aux sommets exacts ;
 *  - openings.ts, spaces.ts, north.ts      ouvertures, pièces, conversion du nord ;
 *  - messages.ts      textes FR / DE ;
 *  - init-browser.ts  initialisation dans le navigateur (WebAssembly mono-fil servi par Vite) ;
 *  - init-node.ts     initialisation sous Node (tests).
 */
import type { IfcAPI } from 'web-ifc';
import type { Lang, PlanDocument } from '../../core/types';
import { analyseIfc } from './analyse';

export { analyseIfc, type AnalyseOptions } from './analyse';
export { IFC_MESSAGES } from './messages';
export { northAngleFromTrueNorth } from './north';

function runsUnderNode(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof p?.versions?.node === 'string';
}

/** Instance web-ifc neuve, selon l'environnement. */
export async function createIfcApi(): Promise<IfcAPI> {
  const init = runsUnderNode() ? await import('./init-node') : await import('./init-browser');
  return init.createIfcApi();
}

/**
 * Lit un fichier IFC (STEP, .ifc). Lève une erreur si le fichier est illisible ; un modèle sans mur ni local
 * donne un document sans feuille, accompagné d'un avertissement.
 */
export async function readIfc(data: ArrayBuffer, fileName: string, options: { lang?: Lang } = {}): Promise<PlanDocument> {
  const api = await createIfcApi();
  try {
    return analyseIfc(api, new Uint8Array(data), fileName, options.lang ? { lang: options.lang } : {});
  } finally {
    // Une instance par fichier : la mémoire du WebAssembly ne se rend qu'en jetant l'instance.
    try {
      api.Dispose();
    } catch {
      // Sans conséquence.
    }
  }
}
