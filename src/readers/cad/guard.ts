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
 * La DÉCOMPRESSION des DWG R2004 et suivants (`DwgLZ77AC18Decompressor`, qui lit le tampon directement, sans
 * lecteur de flux) est remplacée par une copie contrôlée du même algorithme (`guardedDecompressToDest`) : avec un
 * seul octet changé (hostile-files/flip-rdc.dwg de la revue), l'original recopie pendant des minutes des millions
 * d'octets au-delà de la zone à remplir. La copie ne recopie que la partie utile (mêmes octets produits), lève
 * `DwgGuardError` dès qu'elle lirait après la fin du fichier ou dépasserait le temps accordé, et refuse une
 * taille décompressée absurde avant de l'allouer. La carte des sections qu'elle produit est contrôlée avant
 * qu'acad-ts ne la parcoure (`checkSectionMap`).
 *
 * CE QUE ÇA NE COUVRE PAS. Une boucle d'acad-ts qui ne lit aucun flux d'octets et ne décompresse rien (tables
 * d'en-tête, décompression R2007 `DwgLZ77AC21Decompressor`, construction du document) n'est pas interrompue
 * ici. Dans le navigateur, le décodage tourne dans un worker que son chien de garde arrête (offthread.ts) ;
 * sous Node (tests) et en repli sans worker, rien ne l'arrête.
 *
 * Les erreurs levées pendant le décodage d'UN objet sont rattrapées par acad-ts (mode « failsafe ») : l'objet
 * est abandonné et la lecture continue. `disarmDwgGuard` dit combien de fois c'est arrivé : le dessin obtenu
 * est alors incomplet, et le lecteur le signale.
 */
import {
  DwgLZ77AC18Decompressor,
  DwgReader,
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

// ───────────────────────────── Décompression R2004+ ─────────────────────────────

/** Taille décompressée refusée d'emblée (octets) : au-delà de 64 fois le fichier et de 64 Mo, l'en-tête ment. */
function maxDecompressedSize(compressedLength: number): number {
  return Math.max(64 * 1_048_576, 64 * compressedLength);
}

/**
 * Copie contrôlée de `DwgLZ77AC18Decompressor.decompressToDest` (acad-ts 3.10.0, licence MIT) : mêmes octets
 * écrits, sur un flux sain comme sur un flux abîmé, mais en un temps borné.
 *
 * L'original recopie chaque séquence en entier, même la partie qui tombe au-delà de la zone à remplir (écritures
 * sans effet sur un Uint8Array). Des fichiers sains le font sur quelques dizaines de kilo-octets ; avec un octet
 * changé, une séquence annoncée de plusieurs millions d'octets se recopie ainsi, puis une autre… sans fin
 * apparente. Ici, seule la partie utile est recopiée : le résultat est identique, le travail borné par la taille
 * du flux et de la zone. Lire après la fin du fichier lève `DwgGuardError` (l'original finissait par lever une
 * erreur, après avoir travaillé sur des octets indéfinis).
 */
export function guardedDecompressToDest(src: Uint8Array, srcOffset: number, dst: Uint8Array): void {
  let srcPos = srcOffset;
  let dstPos = 0;
  if (!(srcPos < src.length)) return;
  /** Octet suivant du flux compressé : au-delà de la fin du fichier, le flux est abîmé. */
  const next = (): number => {
    if (!(srcPos < src.length)) overrun();
    return src[srcPos++]!;
  };
  /** Nombre étendu : chaque octet nul ajoute 0xFF (`_literalCount` et `_readCompressedBytes` d'acad-ts). */
  const extended = (added: number): number => {
    let value = 0;
    let last = next();
    while (last === 0) {
      value += 0xff;
      last = next();
    }
    return value + added + last;
  };
  const literalCount = (code: number): number => {
    const low = code & 0b1111;
    return low === 0 ? extended(0xf) : low;
  };
  const compressedCount = (opcode: number, validBits: number): number => {
    const count = opcode & validBits;
    return (count === 0 ? extended(validBits) : count) + 2;
  };
  /** Recopie `count` octets littéraux (la partie qui tient dans la zone) puis rend l'octet qui suit. */
  const copyLiterals = (count: number): number => {
    const useful = Math.min(count, dst.length - dstPos);
    for (let i = 0; i < useful; i++) dst[dstPos + i] = src[srcPos + i] ?? 0;
    srcPos += count;
    dstPos += count;
    return next();
  };

  let opcode1 = src[srcPos++]!;
  if ((opcode1 & 0xf0) === 0) opcode1 = copyLiterals(literalCount(opcode1) + 3);
  while (opcode1 !== 0x11) {
    if (!(srcPos < src.length)) overrun();
    if ((++ticks & 4095) === 0 || expired) checkBudget();
    let compOffset = 0;
    let compressedBytes = 0;
    if (opcode1 < 0x10 || opcode1 >= 0x40) {
      compressedBytes = (opcode1 >> 4) - 1;
      const opcode2 = next();
      compOffset = (((opcode1 >> 2) & 3) | (opcode2 << 2)) + 1;
    } else {
      const low = opcode1 < 0x20;
      compressedBytes = compressedCount(opcode1, low ? 0b0111 : 0b00011111);
      compOffset = low ? (opcode1 & 8) << 11 : 0;
      const firstByte = next();
      compOffset |= firstByte >> 2;
      compOffset |= next() << 6;
      compOffset += low ? 0x4000 : 1;
      opcode1 = firstByte;
    }
    // Copie depuis la sortie déjà produite, motif de `compOffset` octets répété (comme l'original : le motif est
    // lu AVANT d'écrire ; hors de la zone, un octet lu vaut 0 et une écriture est perdue).
    const position = dstPos;
    const useful = Math.max(0, Math.min(compressedBytes, dst.length - position));
    if (useful > 0) {
      const period = Math.min(compressedBytes, compOffset);
      const readStart = position - compOffset;
      const pattern = new Uint8Array(Math.min(period, useful));
      for (let i = 0; i < pattern.length; i++) pattern[i] = dst[readStart + i] ?? 0;
      for (let i = 0; i < useful; i++) dst[position + i] = pattern[i % compOffset]!;
    }
    dstPos = position + compressedBytes;
    let litCount = opcode1 & 3;
    if (litCount === 0) {
      opcode1 = next();
      if ((opcode1 & 0b11110000) === 0) litCount = literalCount(opcode1) + 3;
    }
    if (litCount > 0) opcode1 = copyLiterals(litCount);
  }
}

/** Pages au-delà desquelles une section décrite par la carte des sections n'est pas crédible. */
const MAX_SECTION_PAGES = 100_000;

/**
 * Nombre de décompressions faites depuis l'entrée dans `_readFileHeaderAC18` d'acad-ts (−1 hors de cette
 * méthode). La 1re y décompresse la carte des pages, la 2e la CARTE DES SECTIONS.
 */
let headerDecompressions = -1;

/**
 * Contrôle de la carte des sections d'un DWG R2004+ AVANT qu'acad-ts ne la parcoure. acad-ts y comble les pages
 * absentes par une boucle « tant que le compteur n'atteint pas le décalage annoncé, ajouter une page vide de la
 * taille annoncée » : une taille nulle ou négative, ou un décalage démesuré, la fait tourner sans fin — sans
 * aucune lecture de flux pour l'arrêter (un DWG 2004 réel dont cinq octets ont changé l'a montré). On refait ici
 * le même parcours, en comptant seulement : refus si une section demanderait une page de taille nulle, plus de
 * `MAX_SECTION_PAGES` pages ou plus d'octets que la taille décompressée crédible. Une carte qui se termine trop
 * tôt est laissée à acad-ts, qui lève alors sa propre erreur.
 */
export function checkSectionMap(map: Uint8Array, maxBytes: number): void {
  const view = new DataView(map.buffer, map.byteOffset, map.byteLength);
  let pos = 0;
  const fits = (n: number): boolean => pos + n <= map.byteLength;
  const int = (): number => {
    const v = view.getInt32(pos, true);
    pos += 4;
    return v;
  };
  const ulong = (): number => {
    const low = view.getUint32(pos, true);
    const high = view.getUint32(pos + 4, true);
    pos += 8;
    return high * 0x100000000 + low;
  };
  if (!fits(20)) return;
  const descriptions = int();
  pos += 16;
  for (let i = 0; i < descriptions; i++) {
    if (!fits(96)) return;
    const compressedSize = ulong();
    const pageCount = int();
    const pageSize = int();
    pos += 80; // inconnu, compression, identifiant, chiffrement, nom (64 octets)
    let counter = 0;
    let pages = 0;
    /** Pages vides qu'acad-ts ajoutera pour amener le compteur jusqu'à `target`. */
    const fill = (target: number): void => {
      if (!(counter < target)) return;
      if (!(pageSize > 0)) overrun();
      const added = Math.ceil((target - counter) / pageSize);
      pages += added;
      counter += added * pageSize;
    };
    for (let j = 0; j < pageCount; j++) {
      if (!fits(16)) return;
      pos += 8; // numéro de page, taille compressée
      fill(ulong());
      pages++;
      counter += pageSize;
      if (pages > MAX_SECTION_PAGES || !(counter <= maxBytes)) overrun();
    }
    // Taille de page nulle ou négative après les pages : acad-ts lève sa propre erreur.
    if (!(pageSize > 0)) return;
    fill(compressedSize);
    if (pages > MAX_SECTION_PAGES || !(counter <= maxBytes)) overrun();
  }
}

/** Remplace `decompress` : taille annoncée contrôlée AVANT l'allocation, puis décompression contrôlée. */
function guardedDecompress(compressed: Uint8Array, compressedOffset: number, decompressedSize: number): Uint8Array {
  const maxBytes = maxDecompressedSize(compressed.length);
  if (!(decompressedSize >= 0 && decompressedSize <= maxBytes)) overrun();
  const result = new Uint8Array(decompressedSize);
  guardedDecompressToDest(compressed, compressedOffset, result);
  if (headerDecompressions >= 0 && ++headerDecompressions === 2) checkSectionMap(result, maxBytes);
  return result;
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
  // acad-ts appelle ces deux méthodes statiques par le nom de la classe : les remplacer suffit.
  const lz = DwgLZ77AC18Decompressor as unknown as {
    decompress: typeof guardedDecompress;
    decompressToDest: typeof guardedDecompressToDest;
  };
  lz.decompress = guardedDecompress;
  lz.decompressToDest = guardedDecompressToDest;
  // Repère l'en-tête R2004+ pour que la 2e décompression (carte des sections) soit contrôlée (`checkSectionMap`).
  const reader = DwgReader.prototype as unknown as { _readFileHeaderAC18: (...args: unknown[]) => unknown };
  const readHeader = reader._readFileHeaderAC18;
  if (typeof readHeader === 'function') {
    reader._readFileHeaderAC18 = function (this: unknown, ...args: unknown[]): unknown {
      headerDecompressions = 0;
      try {
        return readHeader.apply(this, args);
      } finally {
        headerDecompressions = -1;
      }
    };
  }
}
