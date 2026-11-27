/**
 * Lecteur d'images (plan scanné ou photographié : PNG, JPEG, WebP, GIF, BMP).
 *
 * Une image ne contient ni traits ni texte exploitables : le lecteur rend UNE feuille dont l'unité est le pixel
 * (origine en haut à gauche, y vers le bas), sans échelle et sans proposition. L'utilisateur pose la règle sur
 * une cote connue puis trace le contour par-dessus l'image.
 *
 *  - Navigateur : l'image est DÉCODÉE une fois (comme l'éditeur la dessinera) : une image indécodable est refusée,
 *    et la taille de la feuille est celle de l'image décodée, orientation EXIF appliquée par le navigateur.
 *    Elle est ensuite exposée par une adresse d'objet (« blob: ») couvrant toute la feuille.
 *  - Node (tests) : pas d'image, mais l'étendue exacte, lue dans l'en-tête du fichier.
 *  - Partout : un JPEG ou un PNG qui s'arrête avant sa marque de fin est signalé (plan peut-être incomplet).
 * Rien n'est envoyé nulle part.
 */
import type { Lang, PlanDocument, PlanSheet } from '../../core/types';
import { guessStorey } from '../../semantics/labels';
import { msg } from './messages';
import { readImageInfo } from './size';
import type { ImageInfo } from './size';

export { IMAGE_MESSAGES } from './messages';
export { readImageInfo } from './size';
export type { ImageFormat, ImageInfo } from './size';

/** En dessous de cette résolution, un scan de plan est imprécis (texte de 6 pt ≈ 17 px à 200 dpi). */
export const MIN_SCAN_DPI = 200;
/** Grand côté (px) en dessous duquel une image sans résolution déclarée est jugée trop petite. */
const SMALL_IMAGE_PIXELS = 1600;
const HUGE_IMAGE_MEGAPIXELS = 60;

export class ImageReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageReadError';
  }
}

export interface ReadImageOptions {
  /** Langue des avertissements (français par défaut). */
  lang?: Lang;
}

function runsUnderNode(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof p?.versions?.node === 'string';
}

function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '');
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

interface DecodableImage {
  src: string;
  decode(): Promise<void>;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

interface BrowserGlobals {
  Image?: new () => DecodableImage;
  createImageBitmap?: (blob: Blob) => Promise<{ width: number; height: number; close?: () => void }>;
  URL?: { createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void };
  Blob?: typeof Blob;
}

/**
 * Décodage par le navigateur : taille de l'image telle qu'elle sera dessinée (orientation EXIF appliquée), ou
 * null si elle ne se décode pas (fichier abîmé, tronqué avant les pixels, format inconnu).
 * `undefined` : aucun moyen de décoder ici (on garde alors l'en-tête).
 * Élément <img> de préférence (c'est lui que l'éditeur dessine), sinon createImageBitmap (hors fil principal).
 */
async function decodedSize(blob: Blob, url: string | undefined): Promise<{ width: number; height: number } | null | undefined> {
  const g = globalThis as unknown as BrowserGlobals;
  if (typeof g.Image === 'function' && url !== undefined) {
    try {
      const img = new g.Image();
      img.src = url;
      await img.decode();
      return img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null;
    } catch {
      return null;
    }
  }
  if (typeof g.createImageBitmap === 'function') {
    try {
      const bitmap = await g.createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size.width > 0 && size.height > 0 ? size : null;
    } catch {
      return null;
    }
  }
  return undefined;
}

/**
 * Lit une image et renvoie aussi ce que son en-tête a appris (format, résolution déclarée).
 * Lève `ImageReadError` (message en clair) si l'image est illisible.
 */
export async function readImageDetailed(data: ArrayBuffer, fileName: string, options: ReadImageOptions = {}): Promise<{ doc: PlanDocument; info: ImageInfo | null }> {
  const lang: Lang = options.lang ?? 'fr';
  const info = readImageInfo(data);
  let width = info?.width ?? 0;
  let height = info?.height ?? 0;
  let url: string | undefined;

  if (!runsUnderNode()) {
    const g = globalThis as unknown as BrowserGlobals;
    if (typeof g.Blob === 'function' && typeof g.URL?.createObjectURL === 'function') {
      const extension = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? '').toLowerCase();
      const mime = info?.mime ?? MIME_BY_EXTENSION[extension] ?? '';
      const blob = new g.Blob([data], mime ? { type: mime } : {});
      const candidate = g.URL.createObjectURL(blob);
      // Décodée une fois, comme l'éditeur la dessinera ; aussi pour les formats que l'en-tête ne dit pas (AVIF…).
      const size = await decodedSize(blob, candidate);
      if (size === null) {
        g.URL.revokeObjectURL?.(candidate);
        throw new ImageReadError(msg(lang, info ? 'image.error.decode' : 'image.error.unreadable'));
      }
      // La taille du dessin fait foi : l'en-tête ignore certaines rotations que le navigateur applique.
      if (size) ({ width, height } = size);
      if (width > 0 && height > 0) url = candidate;
      else g.URL.revokeObjectURL?.(candidate);
    }
  }
  if (!(width > 0 && height > 0)) throw new ImageReadError(msg(lang, 'image.error.unreadable'));

  const warnings: string[] = [msg(lang, 'image.warn.scale')];
  if (info?.truncated) warnings.unshift(msg(lang, 'image.warn.truncated'));
  if (info?.dpi !== undefined && info.dpi < MIN_SCAN_DPI) warnings.push(msg(lang, 'image.warn.lowDpi', { dpi: info.dpi }));
  else if (info?.dpi === undefined && Math.max(width, height) < SMALL_IMAGE_PIXELS) warnings.push(msg(lang, 'image.warn.small', { width, height }));
  const megapixels = (width * height) / 1e6;
  if (megapixels > HUGE_IMAGE_MEGAPIXELS) warnings.push(msg(lang, 'image.warn.huge', { megapixels: Math.round(megapixels) }));

  const base = baseName(fileName);
  const storey = guessStorey(base.replace(/[_\-.]+/g, ' '));
  const sheet: PlanSheet = {
    id: 'image',
    name: storey ? storey[lang] : base || msg(lang, 'image.sheet.default'),
    bbox: { minX: 0, minY: 0, maxX: width, maxY: height },
    metresPerUnit: null,
    detected: { rooms: [], openings: [], notes: [] },
  };
  if (url !== undefined) sheet.image = { url, x: 0, y: 0, width, height };
  const doc: PlanDocument = { fileName, kind: 'image', sheets: [sheet], storeysAligned: false, warnings };
  return { doc, info };
}

/**
 * Lit une image de plan. L'adresse d'objet de l'image (`sheet.image.url`) vit tant que la page n'est pas
 * fermée ; `URL.revokeObjectURL` la libère quand le document est abandonné.
 */
export async function readImage(data: ArrayBuffer, fileName: string, options: ReadImageOptions = {}): Promise<PlanDocument> {
  return (await readImageDetailed(data, fileName, options)).doc;
}
