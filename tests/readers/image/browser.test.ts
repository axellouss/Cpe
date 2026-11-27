/**
 * Lecteur d'images, chemin « navigateur » simulé sous Node : on masque `process.versions.node` le temps d'une
 * lecture et l'on fournit un faux élément <img> dont le décodage réussit (taille choisie) ou échoue.
 * La vérification dans un vrai Chromium est faite à part (Playwright) ; ici on fige le contrat.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ImageReadError, readImage } from '../../../src/readers/image';

interface ProcessLike {
  versions: Record<string, string | undefined>;
}
const proc = (globalThis as unknown as { process: ProcessLike }).process;

const u32be = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const chars = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
/** PNG minimal (IHDR, IDAT, IEND), sans pixels décodables : seul le faux décodeur décide. */
function png(width: number, height: number): ArrayBuffer {
  const bytes = [0x89, ...chars('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...chars('IHDR'), ...u32be(width), ...u32be(height), 8, 0, 0, 0, 0, 0, 0, 0, 0];
  bytes.push(...u32be(0), ...chars('IDAT'), 0, 0, 0, 0, ...u32be(0), ...chars('IEND'), 0, 0, 0, 0);
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

let restore: (() => void) | null = null;

/** Fait passer le lecteur pour du code de navigateur ; `decoded` = taille rendue par <img>, null = échec. */
function simulateBrowser(decoded: { width: number; height: number } | null): { created: string[]; revoked: string[]; decodes: number } {
  const state = { created: [] as string[], revoked: [] as string[], decodes: 0 };
  const g = globalThis as unknown as Record<string, unknown>;
  const urlObject = URL as unknown as Record<string, unknown>;
  const saved = { versions: Object.getOwnPropertyDescriptor(proc, 'versions')!, Image: g.Image, create: urlObject.createObjectURL, revoke: urlObject.revokeObjectURL };
  Object.defineProperty(proc, 'versions', { value: { ...proc.versions, node: undefined }, configurable: true });
  g.Image = class {
    src = '';
    naturalWidth = 0;
    naturalHeight = 0;
    decode(): Promise<void> {
      state.decodes++;
      if (!decoded) return Promise.reject(new Error('EncodingError: The source image cannot be decoded.'));
      this.naturalWidth = decoded.width;
      this.naturalHeight = decoded.height;
      return Promise.resolve();
    }
  };
  urlObject.createObjectURL = () => {
    const url = `blob:essai/${state.created.length}`;
    state.created.push(url);
    return url;
  };
  urlObject.revokeObjectURL = (url: string) => {
    state.revoked.push(url);
  };
  restore = () => {
    Object.defineProperty(proc, 'versions', saved.versions);
    g.Image = saved.Image;
    urlObject.createObjectURL = saved.create;
    urlObject.revokeObjectURL = saved.revoke;
  };
  return state;
}

afterEach(() => {
  restore?.();
  restore = null;
});

describe('lecteur d’images dans le navigateur', () => {
  it('taille de la feuille = taille de l’image décodée (orientation appliquée par le navigateur)', async () => {
    // L'en-tête dit 1600 × 1000, le navigateur dessine 1000 × 1600 (orientation EXIF qu'il applique).
    const state = simulateBrowser({ width: 1000, height: 1600 });
    const doc = await readImage(png(1600, 1000), 'plan.png');
    restore?.();
    const sheet = doc.sheets[0]!;
    expect(sheet.bbox).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 1600 });
    expect(sheet.image).toEqual({ url: 'blob:essai/0', x: 0, y: 0, width: 1000, height: 1600 });
    // Décodée une seule fois.
    expect(state.decodes).toBe(1);
    expect(state.revoked).toEqual([]);
  });

  it('image qui ne se décode pas : refus localisé, adresse d’objet libérée, aucune feuille vide', async () => {
    const state = simulateBrowser(null);
    const fr = readImage(png(1600, 1000), 'plan.png');
    await expect(fr).rejects.toBeInstanceOf(ImageReadError);
    await expect(readImage(png(1600, 1000), 'plan.png')).rejects.toThrow(/abîmée ou incomplète/);
    await expect(readImage(png(1600, 1000), 'plan.png', { lang: 'de' })).rejects.toThrow(/beschädigt oder unvollständig/);
    restore?.();
    expect(state.revoked).toEqual(state.created);
    expect(state.created).toHaveLength(3);
  });

  it('format que l’en-tête ne connaît pas mais que le navigateur décode (AVIF…) : accepté', async () => {
    simulateBrowser({ width: 640, height: 480 });
    const doc = await readImage(new Uint8Array(64).buffer as ArrayBuffer, 'plan.avif');
    restore?.();
    expect(doc.sheets[0]!.bbox).toEqual({ minX: 0, minY: 0, maxX: 640, maxY: 480 });
  });

  it('format inconnu que le navigateur ne décode pas : « illisible »', async () => {
    simulateBrowser(null);
    const read = readImage(new Uint8Array(64).buffer as ArrayBuffer, 'plan.avif');
    await expect(read).rejects.toThrow(/illisible/);
  });
});
