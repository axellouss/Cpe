/**
 * Lecture d'un DWG / DXF HORS du fil principal, sous la surveillance d'un chien de garde.
 *
 * POURQUOI. Le décodage (acad-ts) et l'analyse sont des appels synchrones : sur le fil principal ils figent la
 * page, et un DWG abîmé peut faire boucler le décodeur sans fin. Dans un worker, la page reste utilisable et le
 * fil principal peut ARRÊTER le travail : passé le délai, le worker est terminé et la lecture échoue avec le
 * message « fichier illisible ».
 *
 * Ce module ne connaît pas `Worker` : il parle à un « port » (`CadWorkerPort`) que index.ts branche sur le vrai
 * worker et que les tests remplacent par un faux. Il n'importe ni le décodeur ni l'analyse.
 */
import type { PlanDocument } from '../../core/types';
import type { CadRead, CadReadDetails, CadReadOptions } from './details';

/** Demande envoyée au worker. Le tampon est COPIÉ par l'envoi : celui de l'appelant reste utilisable. */
export interface CadWorkerRequest {
  data: ArrayBuffer;
  fileName: string;
  kind: 'dwg' | 'dxf';
  options: CadReadOptions;
}

/**
 * Réponses du worker :
 *  - 'started' dès la réception de la demande (le module du worker est donc chargé et en état de marche) ;
 *  - 'done' avec le résultat ;
 *  - 'failed' avec le message d'erreur, déjà rédigé dans la langue demandée.
 */
export type CadWorkerReply = { type: 'started' } | { type: 'done'; doc: PlanDocument; details: CadReadDetails } | { type: 'failed'; message: string };

/** Ce que le fil principal attend d'un worker de lecture. */
export interface CadWorkerPort {
  post(request: CadWorkerRequest): void;
  /** Arrête le worker pour de bon, même au milieu d'un calcul. */
  terminate(): void;
  onReply: ((reply: CadWorkerReply) => void) | null;
  /** Le worker n'a pas pu être chargé, ou s'est arrêté sur une erreur non rattrapée. */
  onCrash: (() => void) | null;
}

/** Le worker n'a jamais démarré (script introuvable, politique de sécurité…) : l'appelant peut lire sans lui. */
export class CadWorkerUnavailableError extends Error {
  constructor() {
    super('worker de lecture DWG / DXF indisponible');
    this.name = 'CadWorkerUnavailableError';
  }
}

export interface OffThreadOptions {
  /** Délai du chien de garde (ms) : au-delà, le worker est arrêté. */
  timeoutMs: number;
  /** Message de l'erreur levée quand le worker est arrêté ou tombe en cours de lecture (déjà traduit). */
  unreadableMessage: string;
}

/**
 * Fait lire le fichier par un worker neuf et l'arrête dans tous les cas (résultat, erreur, délai dépassé).
 * Lève `CadWorkerUnavailableError` si le worker n'a jamais démarré, une `Error` au message traduit sinon.
 */
export function readCadOffThread(createPort: () => CadWorkerPort, request: CadWorkerRequest, options: OffThreadOptions): Promise<CadRead> {
  return new Promise<CadRead>((resolve, reject) => {
    let port: CadWorkerPort;
    try {
      port = createPort();
    } catch {
      reject(new CadWorkerUnavailableError());
      return;
    }
    let started = false;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.onReply = null;
      port.onCrash = null;
      try {
        port.terminate();
      } catch {
        // Déjà arrêté : rien à faire.
      }
      settle();
    };
    // Sans réponse 'started', le worker n'a jamais tourné : ce n'est pas le fichier qui est en cause.
    const stopped = (): Error => (started ? new Error(options.unreadableMessage) : new CadWorkerUnavailableError());
    const timer = setTimeout(() => finish(() => reject(stopped())), Math.max(0, options.timeoutMs));

    port.onReply = (reply) => {
      if (reply.type === 'started') started = true;
      else if (reply.type === 'done') finish(() => resolve({ doc: reply.doc, details: reply.details }));
      else finish(() => reject(new Error(reply.message)));
    };
    port.onCrash = () => finish(() => reject(stopped()));
    try {
      port.post(request);
    } catch {
      finish(() => reject(new CadWorkerUnavailableError()));
    }
  });
}
