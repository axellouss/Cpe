/**
 * Image de fond : la page PDF dessinée par pdf.js sur un canevas et exposée par une adresse d'objet (« blob: »).
 * Ainsi les scans incorporés et les aplats restent visibles sous les traits vectoriels.
 *
 * Navigateur uniquement. Aucune référence à `document` ni à `OffscreenCanvas` au chargement du module :
 * tout est testé à l'appel, et l'absence de canevas (Node) rend simplement `null`.
 */
import type { PDFPageProxy } from './pdfjs';

/** Échelle de rendu par défaut (2 = 144 dpi) et plafond du grand côté, en pixels. */
export const RENDER_SCALE = 2;
export const MAX_RENDER_PIXELS = 4000;

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

interface CanvasGlobals {
  document?: { createElement?: (tag: string) => unknown };
  OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas;
  URL?: { createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void };
}

function globals(): CanvasGlobals {
  return globalThis as unknown as CanvasGlobals;
}

/** Vrai si l'environnement sait fabriquer un canevas et une adresse d'objet. */
export function canRenderImages(): boolean {
  const g = globals();
  const hasCanvas = typeof g.document?.createElement === 'function' || typeof g.OffscreenCanvas === 'function';
  return hasCanvas && typeof g.URL?.createObjectURL === 'function';
}

function createCanvas(width: number, height: number): AnyCanvas | null {
  const g = globals();
  try {
    if (typeof g.document?.createElement === 'function') {
      const canvas = g.document.createElement('canvas') as HTMLCanvasElement;
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
    if (typeof g.OffscreenCanvas === 'function') return new g.OffscreenCanvas(width, height);
  } catch {
    // Canevas refusé (mémoire, taille) : pas d'image.
  }
  return null;
}

async function canvasBlob(canvas: AnyCanvas, type: string, quality: number): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export interface RenderedPage {
  canvas: AnyCanvas;
  /** Pixels par point de page. */
  scale: number;
  raster: boolean;
}

export interface RenderOptions {
  rotation: number;
  /** Page faite surtout d'une image (scan) : on vise la résolution propre de l'image. */
  raster: boolean;
  pixelsPerPoint: number;
}

/** Dessine la page entière. null si l'environnement ne le permet pas ou si le rendu échoue. */
export async function renderPage(page: PDFPageProxy, options: RenderOptions): Promise<RenderedPage | null> {
  if (!canRenderImages()) return null;
  const base = page.getViewport({ scale: 1, rotation: options.rotation });
  const longSide = Math.max(base.width, base.height);
  if (!(longSide > 0)) return null;
  // 2× par défaut ; un scan est rendu à sa résolution propre s'il est plus fin ; jamais plus de ~4000 px de long.
  const wanted = options.raster ? Math.max(RENDER_SCALE, options.pixelsPerPoint) : RENDER_SCALE;
  const scale = Math.min(wanted, MAX_RENDER_PIXELS / longSide);
  const viewport = page.getViewport({ scale, rotation: options.rotation });
  const canvas = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
  if (!canvas) return null;
  try {
    // pdf.js est typé pour un canevas de page ; un OffscreenCanvas (dans un worker) convient aussi.
    await page.render({ canvas: canvas as HTMLCanvasElement, viewport, background: '#ffffff' }).promise;
  } catch {
    return null;
  }
  return { canvas, scale, raster: options.raster };
}

export interface SheetImage {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Publie la page dessinée comme adresse d'objet ; l'image couvre le rectangle de la page (unités de feuille). */
export async function pageToObjectUrl(rendered: RenderedPage, pageWidth: number, pageHeight: number): Promise<SheetImage | null> {
  const g = globals();
  if (typeof g.URL?.createObjectURL !== 'function') return null;
  try {
    // Un scan pèse lourd en PNG : JPEG de bonne qualité ; un dessin au trait reste net en PNG.
    const blob = await canvasBlob(rendered.canvas, rendered.raster ? 'image/jpeg' : 'image/png', 0.9);
    if (!blob) return null;
    return { url: g.URL.createObjectURL(blob), x: 0, y: 0, width: pageWidth, height: pageHeight };
  } catch {
    return null;
  }
}
