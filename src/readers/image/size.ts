/**
 * Dimensions d'une image lues dans son en-tête, sans la décoder (PNG, JPEG, GIF, BMP, WebP).
 * Sert sous Node (tests) et de secours dans le navigateur. Fonctions pures.
 *
 * Les dimensions rendues sont celles de l'image AFFICHÉE : un JPEG dont l'étiquette EXIF demande un quart de
 * tour (photo prise en tenant le téléphone debout) a largeur et hauteur échangées, comme le fait le navigateur.
 */

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp';

export interface ImageInfo {
  format: ImageFormat;
  /** Type MIME, pour fabriquer l'adresse d'objet. */
  mime: string;
  /** Dimensions affichées, en pixels. */
  width: number;
  height: number;
  /** Résolution déclarée dans le fichier (pixels par pouce), si elle y figure et paraît sérieuse. */
  dpi?: number;
}

const MIME: Readonly<Record<ImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
};

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = offset; i < offset + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Résolution crédible pour un plan scanné ; 72 et 96 dpi sont les valeurs par défaut des logiciels, pas une mesure. */
function plausibleDpi(dpi: number): number | undefined {
  if (!Number.isFinite(dpi) || dpi < 30 || dpi > 2400) return undefined;
  const r = Math.round(dpi);
  return r === 72 || r === 96 ? undefined : r;
}

function result(format: ImageFormat, width: number, height: number, dpi?: number): ImageInfo | null {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) return null;
  const info: ImageInfo = { format, mime: MIME[format], width, height };
  const d = dpi === undefined ? undefined : plausibleDpi(dpi);
  if (d !== undefined) info.dpi = d;
  return info;
}

function readPng(bytes: Uint8Array, view: DataView): ImageInfo | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  // Bloc pHYs (pixels par mètre), toujours placé avant les données d'image.
  let dpi: number | undefined;
  let p = 8;
  while (p + 12 <= bytes.length) {
    const length = view.getUint32(p);
    const type = ascii(bytes, p + 4, 4);
    if (type === 'pHYs' && length >= 9 && p + 17 <= bytes.length) {
      const perMetreX = view.getUint32(p + 8);
      const unit = bytes[p + 16];
      if (unit === 1 && perMetreX > 0) dpi = perMetreX * 0.0254;
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    p += 12 + length;
  }
  return result('png', width, height, dpi);
}

/** Orientation EXIF (1..8) et résolution lues dans un segment APP1 ; valeurs absentes = undefined. */
function readExif(view: DataView, start: number, length: number): { orientation?: number; dpi?: number } {
  const out: { orientation?: number; dpi?: number } = {};
  const end = start + length;
  // « Exif\0\0 » puis un en-tête TIFF.
  if (length < 14 || view.getUint32(start) !== 0x45786966) return out;
  const tiff = start + 6;
  const order = view.getUint16(tiff);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return out;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return out;
  const count = view.getUint16(ifd, little);
  let xRes: number | undefined;
  let unit = 2;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + 12 * i;
    if (entry + 12 > end) break;
    const tag = view.getUint16(entry, little);
    if (tag === 0x0112) out.orientation = view.getUint16(entry + 8, little);
    else if (tag === 0x0128) unit = view.getUint16(entry + 8, little);
    else if (tag === 0x011a) {
      const at = tiff + view.getUint32(entry + 8, little);
      if (at + 8 <= end) {
        const den = view.getUint32(at + 4, little);
        if (den > 0) xRes = view.getUint32(at, little) / den;
      }
    }
  }
  if (xRes !== undefined) out.dpi = unit === 3 ? xRes * 2.54 : xRes;
  return out;
}

function readJpeg(bytes: Uint8Array, view: DataView): ImageInfo | null {
  let p = 2;
  let dpi: number | undefined;
  let orientation = 1;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = bytes[p + 1]!;
    // Octets de remplissage et marqueurs sans longueur.
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = view.getUint16(p + 2);
    if (length < 2) break;
    const body = p + 4;
    if (marker === 0xe0 && length >= 14 && ascii(bytes, body, 4) === 'JFIF' && body + 12 <= bytes.length) {
      const units = bytes[body + 7];
      const density = view.getUint16(body + 8);
      if (units === 1) dpi = density;
      else if (units === 2) dpi = density * 2.54;
    } else if (marker === 0xe1 && body + length - 2 <= bytes.length) {
      const exif = readExif(view, body, length - 2);
      if (exif.orientation !== undefined) orientation = exif.orientation;
      if (exif.dpi !== undefined && dpi === undefined) dpi = exif.dpi;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // Début d'image (SOFn) : précision, hauteur, largeur.
      if (body + 5 > bytes.length) return null;
      const height = view.getUint16(body + 1);
      const width = view.getUint16(body + 3);
      const turned = orientation >= 5 && orientation <= 8;
      return result('jpeg', turned ? height : width, turned ? width : height, dpi);
    }
    p = body + length - 2;
  }
  return null;
}

function readGif(bytes: Uint8Array, view: DataView): ImageInfo | null {
  if (bytes.length < 10) return null;
  return result('gif', view.getUint16(6, true), view.getUint16(8, true));
}

function readBmp(bytes: Uint8Array, view: DataView): ImageInfo | null {
  if (bytes.length < 26) return null;
  const headerSize = view.getUint32(14, true);
  if (headerSize === 12) return result('bmp', view.getUint16(18, true), view.getUint16(20, true));
  const width = view.getInt32(18, true);
  const height = Math.abs(view.getInt32(22, true));
  const perMetre = bytes.length >= 42 ? view.getInt32(38, true) : 0;
  return result('bmp', width, height, perMetre > 0 ? perMetre * 0.0254 : undefined);
}

function readWebp(bytes: Uint8Array, view: DataView): ImageInfo | null {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return result('webp', width, height);
  }
  if (chunk === 'VP8 ') {
    // Image avec pertes : signature 9D 01 2A puis largeur et hauteur sur 14 bits.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return result('webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return result('webp', (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

/** Format et dimensions d'une image d'après ses premiers octets ; null si le format n'est pas reconnu. */
export function readImageInfo(data: ArrayBuffer | Uint8Array): ImageInfo | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return readPng(bytes, view);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes, view);
    if (ascii(bytes, 0, 3) === 'GIF') return readGif(bytes, view);
    if (ascii(bytes, 0, 2) === 'BM') return readBmp(bytes, view);
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return readWebp(bytes, view);
  } catch {
    // En-tête tronqué : format non reconnu.
  }
  return null;
}
