/**
 * Point d'entrée unique des lecteurs de plans. Chaque lecteur est chargé à la demande
 * (les bibliothèques IFC / DWG / PDF sont lourdes) et tourne entièrement dans le navigateur :
 * le fichier ne quitte jamais le poste de l'utilisateur.
 */
import type { PlanDocument, SourceKind } from '../core/types';

/** Formats propriétaires qu'aucun outil tiers ne sait lire : on explique comment exporter. */
export type ClosedFormat = 'pln' | 'rvt' | 'skp' | 'other';

export class UnsupportedFormatError extends Error {
  constructor(
    public readonly format: ClosedFormat,
    public readonly fileName: string,
  ) {
    super(`Format non lisible : ${fileName}`);
    this.name = 'UnsupportedFormatError';
  }
}

export type ReadableKind = Exclude<SourceKind, 'manual'>;

/** Détermine le type de fichier d'après son extension puis ses premiers octets. */
export function sniffKind(fileName: string, head: Uint8Array): ReadableKind | ClosedFormat {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? '').toLowerCase();
  const ascii = String.fromCharCode(...head.subarray(0, 16));
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (ascii.startsWith('ISO-10303-21')) return 'ifc';
  if (/^AC10\d\d/.test(ascii)) return 'dwg';
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'image';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (ext === 'ifc') return 'ifc';
  if (ext === 'dwg') return 'dwg';
  if (ext === 'dxf') return 'dxf';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
  if (['pln', 'pla', 'tpl', 'bpn', 'mod'].includes(ext)) return 'pln';
  if (['rvt', 'rfa'].includes(ext)) return 'rvt';
  if (ext === 'skp') return 'skp';
  return 'other';
}

export interface FileLike {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Lit un fichier de plan et renvoie des feuilles prêtes pour l'éditeur, avec les propositions du lecteur
 * (échelle, contour, pièces, ouvertures). Lève `UnsupportedFormatError` pour PLN, RVT, etc.
 */
export async function readPlanFile(file: FileLike): Promise<PlanDocument> {
  const data = await file.arrayBuffer();
  const kind = sniffKind(file.name, new Uint8Array(data, 0, Math.min(32, data.byteLength)));
  switch (kind) {
    case 'ifc': {
      const { readIfc } = await import('./ifc');
      return readIfc(data, file.name);
    }
    case 'dwg':
    case 'dxf': {
      const { readCad } = await import('./cad');
      return readCad(data, file.name, kind);
    }
    case 'pdf': {
      const { readPdf } = await import('./pdf');
      return readPdf(data, file.name);
    }
    case 'image': {
      const { readImage } = await import('./image');
      return readImage(data, file.name);
    }
    default:
      throw new UnsupportedFormatError(kind, file.name);
  }
}
