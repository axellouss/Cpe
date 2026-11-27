/**
 * Lecteur d'images. Sous Node (ces tests), pas d'image de fond : seule l'étendue, lue dans l'en-tête du fichier.
 * Les scans d'essai sont dans tests/fixtures/pdf (ils dérivent du plan PDF fr_A3_1-100, voir LISEZMOI.txt) ;
 * les autres en-têtes sont fabriqués octet par octet.
 */
import { describe, expect, it } from 'vitest';
import { ImageReadError, readImage, readImageDetailed, readImageInfo } from '../../../src/readers/image';

// ── Accès disque sous Node, sans dépendre des types de Node (absents du projet) ──
interface FsLike {
  readFileSync(path: string | URL): Uint8Array;
}
const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as FsLike;
const FIXTURE_DIR = new URL('../../fixtures/pdf/', import.meta.url);

function fixtureBytes(name: string): ArrayBuffer {
  const buf = fs.readFileSync(new URL(name, FIXTURE_DIR));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function buffer(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

const u16be = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];
const u32be = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u16le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u32le = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const chars = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** PNG minimal : signature, IHDR et, si demandé, un bloc pHYs (pixels par mètre). */
function png(width: number, height: number, dpi?: number): ArrayBuffer {
  const bytes = [0x89, ...chars('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...chars('IHDR'), ...u32be(width), ...u32be(height), 8, 0, 0, 0, 0, 0, 0, 0, 0];
  if (dpi !== undefined) {
    const perMetre = Math.round(dpi / 0.0254);
    bytes.push(...u32be(9), ...chars('pHYs'), ...u32be(perMetre), ...u32be(perMetre), 1, 0, 0, 0, 0);
  }
  bytes.push(...u32be(0), ...chars('IDAT'), 0, 0, 0, 0);
  return buffer(bytes);
}

/** JPEG minimal : SOI, éventuellement JFIF (densité) et EXIF (orientation), puis SOFn. */
function jpeg(width: number, height: number, options: { dpi?: number; orientation?: number; progressive?: boolean } = {}): ArrayBuffer {
  const bytes = [0xff, 0xd8];
  if (options.dpi !== undefined) bytes.push(0xff, 0xe0, ...u16be(16), ...chars('JFIF'), 0, 1, 1, 1, ...u16be(options.dpi), ...u16be(options.dpi), 0, 0);
  if (options.orientation !== undefined) {
    // TIFF petit-boutiste, un seul champ : Orientation (0x0112), type SHORT.
    const tiff = [...chars('II'), ...u16le(42), ...u32le(8), ...u16le(1), ...u16le(0x0112), ...u16le(3), ...u32le(1), ...u16le(options.orientation), 0, 0, ...u32le(0)];
    const body = [...chars('Exif'), 0, 0, ...tiff];
    bytes.push(0xff, 0xe1, ...u16be(body.length + 2), ...body);
  }
  // Une table de Huffman (marqueur C4) avant le SOF : elle ne doit pas être prise pour lui.
  bytes.push(0xff, 0xc4, ...u16be(4), 0, 0);
  bytes.push(0xff, options.progressive ? 0xc2 : 0xc0, ...u16be(11), 8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0);
  bytes.push(0xff, 0xd9);
  return buffer(bytes);
}

describe('en-têtes d’images', () => {
  it('PNG : dimensions et résolution déclarée', () => {
    expect(readImageInfo(png(3308, 2339, 200))).toEqual({ format: 'png', mime: 'image/png', width: 3308, height: 2339, dpi: 200 });
    expect(readImageInfo(png(800, 600))).toEqual({ format: 'png', mime: 'image/png', width: 800, height: 600 });
    // 72 et 96 dpi sont les valeurs par défaut des logiciels, pas une résolution de scan.
    expect(readImageInfo(png(800, 600, 96))!.dpi).toBeUndefined();
    expect(readImageInfo(png(800, 600, 72))!.dpi).toBeUndefined();
  });

  it('JPEG : dimensions du SOF, densité JFIF, JPEG progressif', () => {
    expect(readImageInfo(jpeg(2480, 3508, { dpi: 300 }))).toEqual({ format: 'jpeg', mime: 'image/jpeg', width: 2480, height: 3508, dpi: 300 });
    expect(readImageInfo(jpeg(640, 480, { progressive: true }))).toEqual({ format: 'jpeg', mime: 'image/jpeg', width: 640, height: 480 });
  });

  it('JPEG tourné par son étiquette EXIF (photo de téléphone) : dimensions telles qu’affichées', () => {
    const upright = readImageInfo(jpeg(4000, 3000, { orientation: 1 }))!;
    expect([upright.width, upright.height]).toEqual([4000, 3000]);
    for (const orientation of [5, 6, 7, 8]) {
      const turned = readImageInfo(jpeg(4000, 3000, { orientation }))!;
      expect([turned.width, turned.height]).toEqual([3000, 4000]);
    }
    const flipped = readImageInfo(jpeg(4000, 3000, { orientation: 3 }))!;
    expect([flipped.width, flipped.height]).toEqual([4000, 3000]);
  });

  it('GIF, BMP et WebP', () => {
    expect(readImageInfo(buffer([...chars('GIF89a'), ...u16le(1024), ...u16le(768), 0, 0, 0]))).toMatchObject({ format: 'gif', width: 1024, height: 768 });
    const bmp = [...chars('BM'), ...u32le(0), ...u32le(0), ...u32le(54), ...u32le(40), ...u32le(1200), ...u32le(0xffffffff - 899), ...u16le(1), ...u16le(24), ...u32le(0), ...u32le(0), ...u32le(7874), ...u32le(7874), ...u32le(0), ...u32le(0)];
    // Hauteur négative = image stockée de haut en bas ; 7874 pixels par mètre = 200 dpi.
    expect(readImageInfo(buffer(bmp))).toEqual({ format: 'bmp', mime: 'image/bmp', width: 1200, height: 900, dpi: 200 });
    const riff = (chunk: string, payload: number[]): ArrayBuffer => buffer([...chars('RIFF'), ...u32le(0), ...chars('WEBP'), ...chars(chunk), ...u32le(payload.length), ...payload]);
    // VP8X : drapeaux (4 octets) puis largeur − 1 et hauteur − 1 sur 24 bits.
    expect(readImageInfo(riff('VP8X', [0, 0, 0, 0, 0xcf, 0x07, 0, 0xe7, 0x03, 0]))).toMatchObject({ format: 'webp', width: 2000, height: 1000 });
    expect(readImageInfo(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(640), ...u16le(480), 0, 0]))).toMatchObject({ format: 'webp', width: 640, height: 480 });
    expect(readImageInfo(riff('VP8L', [0x2f, ...u32le((799 << 14) | 1199), 0, 0, 0, 0, 0]))).toMatchObject({ format: 'webp', width: 1200, height: 800 });
  });

  it('octets quelconques ou en-tête tronqué : format non reconnu', () => {
    expect(readImageInfo(buffer(chars('%PDF-1.7 pas une image')))).toBeNull();
    expect(readImageInfo(buffer([0x89, ...chars('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBeNull();
    expect(readImageInfo(buffer([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8]))).toBeNull();
    expect(readImageInfo(buffer([]))).toBeNull();
  });
});

describe('readImage', () => {
  it('scan PNG de l’essai : une feuille en pixels, sans échelle, avec la consigne de poser la règle', async () => {
    const doc = await readImage(fixtureBytes('scan_fr_100dpi_bilevel.png'), 'scan_fr_100dpi_bilevel.png');
    expect(doc.kind).toBe('image');
    expect(doc.fileName).toBe('scan_fr_100dpi_bilevel.png');
    expect(doc.storeysAligned).toBe(false);
    expect(doc.northAngle).toBeUndefined();
    expect(doc.sheets).toHaveLength(1);
    const sheet = doc.sheets[0]!;
    expect(sheet.bbox).toEqual({ minX: 0, minY: 0, maxX: 1654, maxY: 1170 });
    expect(sheet.metresPerUnit).toBeNull();
    expect(sheet.detected).toEqual({ rooms: [], openings: [], notes: [] });
    expect(sheet.segments).toBeUndefined();
    expect(sheet.texts).toBeUndefined();
    // Sous Node : pas d'adresse d'objet, donc pas d'image.
    expect(sheet.image).toBeUndefined();
    expect(sheet.name).toBe('scan_fr_100dpi_bilevel');
    expect(doc.warnings[0]).toMatch(/posez la règle/);
    expect(doc.warnings[0]).toMatch(/200 dpi/);
    // Le fichier déclare 100 dpi : avertissement explicite.
    expect(doc.warnings.some((w) => /100 dpi seulement/.test(w))).toBe(true);
  });

  it('scan JPEG de l’essai : mêmes dimensions, résolution lue dans l’en-tête JFIF', async () => {
    const { doc, info } = await readImageDetailed(fixtureBytes('scan_fr_100dpi.jpg'), 'scan_fr_100dpi.jpg');
    expect(info).toEqual({ format: 'jpeg', mime: 'image/jpeg', width: 1654, height: 1170, dpi: 100 });
    expect(doc.sheets[0]!.bbox).toEqual({ minX: 0, minY: 0, maxX: 1654, maxY: 1170 });
    expect(doc.warnings).toHaveLength(2);
  });

  it('scan à 300 dpi : seule la consigne générale', async () => {
    const doc = await readImage(png(4961, 3508, 300), 'plan.png');
    expect(doc.sheets[0]!.bbox).toEqual({ minX: 0, minY: 0, maxX: 4961, maxY: 3508 });
    expect(doc.warnings).toHaveLength(1);
  });

  it('petite image sans résolution déclarée : prévient que les traits seront difficiles à viser', async () => {
    const doc = await readImage(png(1024, 768), 'capture.png');
    expect(doc.warnings).toHaveLength(2);
    expect(doc.warnings[1]).toMatch(/1024 × 768 px/);
  });

  it('très grande image : prévient que l’affichage peut être lent', async () => {
    const doc = await readImage(png(14043, 9933, 600), 'A1_600dpi.png');
    expect(doc.warnings.some((w) => /139 mégapixels/.test(w))).toBe(true);
  });

  it('nomme la feuille d’après le niveau cité dans le nom du fichier', async () => {
    expect((await readImage(png(3000, 2000, 300), 'Maison_Dupont_RDC.png')).sheets[0]!.name).toBe('Rez-de-chaussée');
    expect((await readImage(png(3000, 2000, 300), 'plans/1er-etage.jpg')).sheets[0]!.name).toBe('1er étage');
    expect((await readImage(png(3000, 2000, 300), 'IMG_2041.png')).sheets[0]!.name).toBe('IMG_2041');
  });

  it('photo tenue debout : la feuille a les dimensions affichées', async () => {
    const doc = await readImage(jpeg(4000, 3000, { orientation: 6 }), 'photo.jpg');
    expect(doc.sheets[0]!.bbox).toEqual({ minX: 0, minY: 0, maxX: 3000, maxY: 4000 });
  });

  it('fichier qui n’est pas une image : erreur claire, en français', async () => {
    await expect(readImage(buffer(chars('ceci n’est pas une image')), 'faux.png')).rejects.toBeInstanceOf(ImageReadError);
    await expect(readImage(buffer(chars('ceci n’est pas une image')), 'faux.png')).rejects.toThrow(/illisible/);
  });

  it('textes en allemand sur demande', async () => {
    const { doc } = await readImageDetailed(fixtureBytes('scan_fr_100dpi.jpg'), 'EG.jpg', { lang: 'de' });
    expect(doc.sheets[0]!.name).toBe('Erdgeschoss');
    expect(doc.warnings[0]).toMatch(/Lineal/);
    expect(doc.warnings[1]).toMatch(/100 dpi/);
  });
});
