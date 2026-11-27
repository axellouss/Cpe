/**
 * Lecteur DWG + DXF (@node-projects/acad-ts pour le décodage, jsts pour la géométrie plane).
 *
 * Ce que le lecteur produit (voir PlanDocument dans core/types.ts) :
 *  - l'espace objet uniquement, blocs développés récursivement ;
 *  - une feuille par plan dessiné (plusieurs étages côte à côte → plusieurs feuilles) ;
 *  - l'unité du dessin, votée entre l'en-tête, les portes, les surfaces écrites et l'épaisseur des murs ;
 *  - par feuille : contour extérieur du bâtiment, pièces, ouvertures des murs extérieurs ;
 *  - la flèche du nord si un bloc la désigne.
 *
 * PIÈCES : toute face fermée par les murs à l'intérieur du contour est rendue avec sa surface mesurée, qu'elle
 * porte ou non un nom connu. Nom reconnu → proposition « chauffée / non chauffée » d'après le nom ; texte non
 * reconnu (« Kind 1 ») → ce texte comme nom, `heatedGuess: 'ask'` ; aucun texte → nom vide, `heatedGuess: 'ask'`.
 * Une note de la feuille dit combien de pièces n'ont pas de nom reconnu.
 *
 * ATTENTION : `detected.outline` est l'emprise de TOUT le bâtiment dessiné, annexes non chauffées comprises
 * (garage accolé…). Quand une pièce « probablement non chauffée » s'y trouve, une note de la feuille le dit :
 * c'est à l'expert de la retirer du contour de la zone chauffée.
 *
 * Repère des feuilles : x_feuille = x_CAO − x0 ; y_feuille = y0 − y_CAO (y inversé, origine au coin haut-gauche
 * du contenu de la feuille). Le décalage garde la précision des Float32Array sur les plans géoréférencés.
 *
 * Le lecteur PROPOSE : tout ce qui est deviné est signalé dans `warnings` et `detected.notes`.
 *
 * OÙ LA LECTURE TOURNE. Dans le navigateur, décodage et analyse se font dans un WORKER (cad.worker.ts) :
 * la page reste utilisable et un chien de garde arrête le worker si la lecture ne finit pas — un DWG tronqué
 * ou abîmé peut faire boucler acad-ts sans fin (voir offthread.ts et guard.ts). Le fichier donne alors le
 * message « illisible ou abîmé ». Sous Node (tests), et en repli si le worker ne démarre pas, la lecture se fait
 * dans le fil courant (read.ts), protégée par les seuls garde-fous de guard.ts.
 *
 * Organisation :
 *  - index.ts (ici)   aiguillage worker / fil courant ; ne charge ni acad-ts ni jsts ;
 *  - offthread.ts     dialogue avec le worker, chien de garde ; cad.worker.ts : le worker lui-même ;
 *  - read.ts          lecture complète dans le fil courant → PlanDocument ;
 *  - load.ts          décodage acad-ts → dessin mis à plat (raw.ts) ; guard.ts : garde-fous du décodage DWG ;
 *  - analyse.ts       murs, unité, contour, pièces (rooms.ts), ouvertures, nord ;
 *  - messages.ts      textes FR / DE.
 */
import type { Lang, PlanDocument } from '../../core/types';
import { t } from '../../i18n';
import type { CadRead, CadReadOptions } from './details';
import { watchdogMs } from './limits';
import './messages';
import { CadWorkerUnavailableError, readCadOffThread } from './offthread';
import type { CadWorkerPort, CadWorkerReply } from './offthread';

export type { CadRead, CadReadDetails, CadReadOptions } from './details';
export { MAX_DISPLAY_SEGMENTS, thinSegments } from './display';
export { decodeBudgetMs, watchdogMs } from './limits';

function runsUnderNode(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof p?.versions?.node === 'string';
}

/** Vrai dans un navigateur qui sait lancer un worker (jamais sous Node : les tests lisent dans le fil courant). */
function canUseWorker(): boolean {
  return typeof Worker === 'function' && !runsUnderNode();
}

/** Lance le worker de lecture et le présente comme un « port » (voir offthread.ts). */
function spawnCadWorker(): CadWorkerPort {
  const worker = new Worker(new URL('./cad.worker.ts', import.meta.url), { type: 'module' });
  const port: CadWorkerPort = {
    post: (request) => worker.postMessage(request),
    terminate: () => worker.terminate(),
    onReply: null,
    onCrash: null,
  };
  worker.onmessage = (event: MessageEvent<CadWorkerReply>) => port.onReply?.(event.data);
  worker.onerror = (event) => {
    event.preventDefault();
    port.onCrash?.();
  };
  worker.onmessageerror = () => port.onCrash?.();
  return port;
}

/** Comme `readCad`, avec en plus les détails de lecture (unité, calques de murs, décalage des feuilles, durées). */
export async function readCadDetailed(data: ArrayBuffer, fileName: string, kind: 'dwg' | 'dxf', options: CadReadOptions = {}): Promise<CadRead> {
  if (canUseWorker()) {
    const lang: Lang = options.lang ?? 'fr';
    try {
      return await readCadOffThread(
        spawnCadWorker,
        { data, fileName, kind, options },
        { timeoutMs: watchdogMs(data.byteLength), unreadableMessage: t(lang, `cad.error.unreadable.${kind}`) },
      );
    } catch (err) {
      // Worker jamais démarré (script bloqué, vieux navigateur…) : on lit dans le fil courant, garde-fous compris.
      if (!(err instanceof CadWorkerUnavailableError)) throw err;
    }
  }
  const { readCadInProcess } = await import('./read');
  return readCadInProcess(data, fileName, kind, options);
}

/**
 * Lit un fichier DWG ou DXF et renvoie des feuilles prêtes pour l'éditeur, avec les propositions du lecteur.
 * Lève une erreur (message dans la langue demandée) si le fichier est illisible, abîmé ou vide.
 */
export async function readCad(data: ArrayBuffer, fileName: string, kind: 'dwg' | 'dxf', options: CadReadOptions = {}): Promise<PlanDocument> {
  return (await readCadDetailed(data, fileName, kind, options)).doc;
}
