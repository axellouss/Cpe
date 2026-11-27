/**
 * Garde-fous autour des flux d'octets qu'acad-ts lit dans un DWG.
 *
 * POURQUOI. Les lecteurs de flux d'acad-ts 3.10.0 ne contrôlent pas la fin du tampon : lire après la fin rend
 * `undefined`, pris pour 0, et certaines boucles n'en sortent jamais. `DwgHandleReader.read` (« while (true) »)
 * tourne ainsi sans fin sur un DWG tronqué ou dont un seul octet a changé : la page reste figée pour de bon.
 *
 * COMMENT. acad-ts crée tous ses lecteurs de flux à partir d'un registre public (`registerStreamReader`).
 * On y inscrit des sous-classes des siens qui lèvent `DwgGuardError` :
 *  - quand une lecture dépasse la fin du flux de plus de `OVERRUN_SLACK` octets. Un fichier sain dépasse d'au
 *    plus 5 octets (mesuré sur 21 fichiers, de AC1012 à AC1032) : la marge ne gêne donc aucun fichier valide ;
 *  - quand le temps accordé au décodage est écoulé (contrôlé toutes les 4 096 lectures, puis à chaque lecture).
 *
 * CE QUE ÇA NE COUVRE PAS. Une boucle d'acad-ts qui ne lit aucun flux d'octets (tables d'en-tête R2004+,
 * décompression, construction du document) n'est pas interrompue ici. Dans le navigateur, le décodage tourne
 * dans un worker que son chien de garde arrête (offthread.ts) ; sous Node (tests), rien ne l'arrête.
 *
 * Les erreurs levées pendant le décodage d'UN objet sont rattrapées par acad-ts (mode « failsafe ») : l'objet
 * est abandonné et la lecture continue. `disarmDwgGuard` dit combien de fois c'est arrivé : le dessin obtenu
 * est alors incomplet, et le lecteur le signale.
 */
import {
  DwgStreamReaderAC12,
  DwgStreamReaderAC15,
  DwgStreamReaderAC18,
  DwgStreamReaderAC21,
  DwgStreamReaderAC24,
  registerStreamReader,
} from '@node-projects/acad-ts';
import type { DwgStreamReaderBase } from '@node-projects/acad-ts';

/** Octets tolérés après la fin d'un flux avant de conclure à un fichier abîmé. */
export const OVERRUN_SLACK = 1024;

/** Lecture arrêtée par un garde-fou : 'overrun' = au-delà de la fin du flux ; 'budget' = temps écoulé. */
export class DwgGuardError extends Error {
  readonly kind: 'overrun' | 'budget';

  constructor(kind: 'overrun' | 'budget') {
    super(kind === 'overrun' ? 'DWG : lecture au-delà de la fin des données' : 'DWG : temps de décodage dépassé');
    this.name = 'DwgGuardError';
    this.kind = kind;
  }
}

// État du décodage en cours. acad-ts décode d'un trait (appel synchrone) : un seul décodage à la fois par fil.
let deadline = Infinity;
let expired = false;
let ticks = 0;
let overruns = 0;

/** À appeler juste avant `DwgReader.readFromStream` : `budgetMs` = temps accordé au décodage. */
export function armDwgGuard(budgetMs: number): void {
  deadline = Number.isFinite(budgetMs) ? Date.now() + Math.max(0, budgetMs) : Infinity;
  expired = false;
  ticks = 0;
  overruns = 0;
}

/** À appeler après le décodage (réussi ou non) : nombre de débordements et dépassement du temps accordé. */
export function disarmDwgGuard(): { overruns: number; expired: boolean } {
  const report = { overruns, expired };
  deadline = Infinity;
  expired = false;
  ticks = 0;
  overruns = 0;
  return report;
}

function overrun(): never {
  overruns++;
  throw new DwgGuardError('overrun');
}

function checkBudget(): void {
  if (!expired && Date.now() <= deadline) return;
  // Une fois le temps écoulé, TOUTE lecture échoue : les boucles qui rattrapent l'erreur objet par objet se vident.
  expired = true;
  throw new DwgGuardError('budget');
}

type StreamReaderClass = new (stream: Uint8Array, resetPosition: boolean) => DwgStreamReaderBase;

/** Sous-classe d'un lecteur de flux d'acad-ts dont chaque lecture élémentaire est contrôlée. */
function guarded(Base: StreamReaderClass): StreamReaderClass {
  return class extends Base {
    /** Octet suivant : toutes les lectures bit à bit et octet par octet passent par ici ou par `advanceByte`. */
    override readByte(): number {
      // `!(a < b)` et non `a >= b` : une position NaN (adresse calculée sur des données abîmées) est un débordement.
      if (!(this._position < this._stream.length + OVERRUN_SLACK)) overrun();
      if ((++ticks & 4095) === 0 || expired) checkBudget();
      return super.readByte();
    }

    override advanceByte(): void {
      if (!(this._position < this._stream.length + OVERRUN_SLACK)) overrun();
      if ((++ticks & 4095) === 0 || expired) checkBudget();
      super.advanceByte();
    }

    /** Bloc d'octets : refusé AVANT l'allocation si la longueur annoncée déborde du flux. */
    override readBytes(length: number): Uint8Array {
      if (!(length >= 0) || !(this._position + length <= this._stream.length + OVERRUN_SLACK)) overrun();
      if (expired) checkBudget();
      return super.readBytes(length);
    }
  };
}

let installed = false;

/**
 * Remplace les lecteurs de flux d'acad-ts par leurs versions contrôlées. Sans effet au second appel.
 * Tant que le garde-fou n'est pas armé, seule la fin de flux est contrôlée (pas de limite de temps).
 */
export function installDwgGuard(): void {
  if (installed) return;
  installed = true;
  registerStreamReader('AC12', guarded(DwgStreamReaderAC12));
  registerStreamReader('AC15', guarded(DwgStreamReaderAC15));
  registerStreamReader('AC18', guarded(DwgStreamReaderAC18));
  registerStreamReader('AC21', guarded(DwgStreamReaderAC21));
  registerStreamReader('AC24', guarded(DwgStreamReaderAC24));
}
