/**
 * Couche <canvas> de l'éditeur : fond matriciel, traits vectoriels (150 000 et plus), textes, grille métrique.
 *
 * Stratégie de performance :
 *  - un seul chemin par paquet de traits (jamais un nœud par trait) ;
 *  - zoom avant : on ne dessine que les traits des cases visibles de l'index spatial ;
 *  - plan lourd pendant un geste : on redessine l'instantané du dernier rendu complet, transformé (léger flou
 *    passager), puis un rendu net dès que la vue se stabilise.
 */
import type { PlanSheet } from '../../core/types';
import type { SnapIndex } from './snapIndex';
import { coverage, forEachSegmentInBBox } from './snapIndex';
import type { Size, View } from './view';
import { niceStep, visibleBBox } from './view';

export interface CanvasColors {
  background: string;
  paper: string;
  paperEdge: string;
  ink: string;
  magnet: string;
  grid: string;
  gridStrong: string;
}

/** Au-delà de ce nombre de traits visibles, un geste utilise l'instantané plutôt qu'un rendu complet. */
const HEAVY_SEGMENTS = 30000;
const CHUNK = 4000;
const MAX_TEXTS = 1500;

export class PlanCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private sheet: PlanSheet | null = null;
  private index: SnapIndex | null = null;
  private image: HTMLImageElement | null = null;
  private imageReady = false;
  private snapshot: HTMLCanvasElement | null = null;
  private snapshotView: View | null = null;
  private size: Size = { width: 0, height: 0 };
  private dpr = 1;
  /** Appelé quand le fond matriciel a fini de charger : l'appelant redessine. */
  onImageReady: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  setSheet(sheet: PlanSheet | null, index: SnapIndex | null): void {
    if (sheet === this.sheet && index === this.index) return;
    const url = sheet?.image?.url ?? null;
    const before = this.sheet;
    const previousUrl = before?.image?.url ?? null;
    // Un hôte peut recréer l'objet feuille à chaque rendu : l'instantané ne tombe que si le CONTENU dessiné change.
    const sameContent =
      !!sheet &&
      !!before &&
      sheet.segments === before.segments &&
      sheet.texts === before.texts &&
      url === previousUrl &&
      sheet.bbox.minX === before.bbox.minX &&
      sheet.bbox.minY === before.bbox.minY &&
      sheet.bbox.maxX === before.bbox.maxX &&
      sheet.bbox.maxY === before.bbox.maxY &&
      sheet.image?.x === before.image?.x &&
      sheet.image?.y === before.image?.y &&
      sheet.image?.width === before.image?.width &&
      sheet.image?.height === before.image?.height;
    this.sheet = sheet;
    this.index = index;
    if (!sameContent) this.snapshotView = null;
    if (url !== previousUrl) {
      this.image = null;
      this.imageReady = false;
      if (url) {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => {
          if (this.image !== img) return;
          this.imageReady = true;
          this.snapshotView = null;
          this.onImageReady?.();
        };
        img.src = url;
        this.image = img;
      }
    }
  }

  resize(size: Size, dpr: number): void {
    const w = Math.max(1, Math.round(size.width * dpr));
    const h = Math.max(1, Math.round(size.height * dpr));
    this.size = size;
    this.dpr = dpr;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.snapshotView = null;
    }
  }

  /** Nombre de traits que demanderait un rendu complet de cette vue (estimation). */
  private visibleEstimate(view: View): number {
    if (!this.index) return 0;
    return this.index.count * Math.min(1, coverage(this.index, visibleBBox(view, this.size)));
  }

  /**
   * Dessine la vue. `interactive` = un geste est en cours : un plan lourd est alors rendu à partir de l'instantané.
   * Renvoie vrai si un rendu net reste à faire (l'appelant rappelle `draw(..., false)` quand la vue se stabilise).
   */
  draw(view: View, colors: CanvasColors, interactive: boolean): boolean {
    const ctx = this.ctx;
    if (!ctx || this.size.width <= 0 || this.size.height <= 0) return false;
    const heavy = this.visibleEstimate(view) > HEAVY_SEGMENTS;
    if (interactive && heavy && this.snapshot && this.snapshotView) {
      this.drawFromSnapshot(ctx, view, colors);
      return true;
    }
    this.drawFull(ctx, view, colors);
    if (heavy) this.takeSnapshot(view);
    else this.snapshotView = null;
    return false;
  }

  private drawFromSnapshot(ctx: CanvasRenderingContext2D, view: View, colors: CanvasColors): void {
    const snap = this.snapshot!;
    const from = this.snapshotView!;
    const k = view.scale / from.scale;
    const ox = (view.tx - from.tx * k) * this.dpr;
    const oy = (view.ty - from.ty * k) * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(snap, 0, 0, snap.width, snap.height, ox, oy, snap.width * k, snap.height * k);
  }

  private takeSnapshot(view: View): void {
    if (typeof document === 'undefined') return;
    if (!this.snapshot) this.snapshot = document.createElement('canvas');
    const snap = this.snapshot;
    if (snap.width !== this.canvas.width || snap.height !== this.canvas.height) {
      snap.width = this.canvas.width;
      snap.height = this.canvas.height;
    }
    const sctx = snap.getContext('2d');
    if (!sctx) {
      this.snapshotView = null;
      return;
    }
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, snap.width, snap.height);
    sctx.drawImage(this.canvas, 0, 0);
    this.snapshotView = { ...view };
  }

  private drawFull(ctx: CanvasRenderingContext2D, view: View, colors: CanvasColors): void {
    const { width, height } = this.size;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    const sheet = this.sheet;
    if (!sheet) {
      this.drawGrid(ctx, view, colors);
      return;
    }

    const hasImage = !!(sheet.image && this.image && this.imageReady);
    if (!hasImage) this.drawPaper(ctx, view, colors, sheet);
    if (hasImage && sheet.image && this.image) {
      const im = sheet.image;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.image, im.x * view.scale + view.tx, im.y * view.scale + view.ty, im.width * view.scale, im.height * view.scale);
    }
    if (sheet.segments && sheet.segments.length >= 4) {
      // Sur un fond matriciel les traits sont déjà dans l'image : on ne montre qu'un voile des traits « aimantés ».
      ctx.strokeStyle = hasImage ? colors.magnet : colors.ink;
      ctx.globalAlpha = hasImage ? 0.3 : 0.92;
      ctx.lineWidth = 1;
      ctx.lineCap = 'butt';
      this.drawSegments(ctx, view, sheet.segments);
      ctx.globalAlpha = 1;
    }
    if (!hasImage && sheet.texts && sheet.texts.length > 0) this.drawTexts(ctx, view, colors, sheet);
  }

  private drawPaper(ctx: CanvasRenderingContext2D, view: View, colors: CanvasColors, sheet: PlanSheet): void {
    const b = sheet.bbox;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return;
    const m = Math.max(w, h) * 0.04;
    const x = (b.minX - m) * view.scale + view.tx;
    const y = (b.minY - m) * view.scale + view.ty;
    ctx.fillStyle = colors.paper;
    ctx.strokeStyle = colors.paperEdge;
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, (w + 2 * m) * view.scale, (h + 2 * m) * view.scale);
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round((w + 2 * m) * view.scale), Math.round((h + 2 * m) * view.scale));
  }

  private drawSegments(ctx: CanvasRenderingContext2D, view: View, seg: Float32Array): void {
    const { scale, tx, ty } = view;
    const count = Math.floor(seg.length / 4);
    const visible = visibleBBox(view, this.size);
    let inPath = 0;
    ctx.beginPath();
    const line = (i: number): void => {
      const o = i * 4;
      ctx.moveTo(seg[o]! * scale + tx, seg[o + 1]! * scale + ty);
      ctx.lineTo(seg[o + 2]! * scale + tx, seg[o + 3]! * scale + ty);
      if (++inPath >= CHUNK) {
        ctx.stroke();
        ctx.beginPath();
        inPath = 0;
      }
    };
    const index = this.index;
    if (index && index.segments === seg && coverage(index, visible) < 0.6) {
      forEachSegmentInBBox(index, visible, line);
    } else {
      const { minX, minY, maxX, maxY } = visible;
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        const x1 = seg[o]!;
        const y1 = seg[o + 1]!;
        const x2 = seg[o + 2]!;
        const y2 = seg[o + 3]!;
        // Rejet rapide des traits entièrement hors de l'écran.
        if ((x1 < minX && x2 < minX) || (x1 > maxX && x2 > maxX) || (y1 < minY && y2 < minY) || (y1 > maxY && y2 > maxY)) continue;
        line(i);
      }
    }
    if (inPath > 0) ctx.stroke();
  }

  private drawTexts(ctx: CanvasRenderingContext2D, view: View, colors: CanvasColors, sheet: PlanSheet): void {
    const texts = sheet.texts ?? [];
    const visible = visibleBBox(view, this.size);
    const fallbackHeight = Math.max(sheet.bbox.maxX - sheet.bbox.minX, sheet.bbox.maxY - sheet.bbox.minY) * 0.012;
    ctx.fillStyle = colors.ink;
    ctx.textBaseline = 'alphabetic';
    let drawn = 0;
    let lastPx = -1;
    for (const tx of texts) {
      if (drawn >= MAX_TEXTS) break;
      const h = tx.height && tx.height > 0 ? tx.height : fallbackHeight;
      const px = h * view.scale;
      if (px < 5) continue; // illisible à ce zoom
      if (tx.x > visible.maxX || tx.y < visible.minY - h || tx.y > visible.maxY + h) continue;
      const size = Math.min(px, 80);
      if (Math.abs(size - lastPx) > 0.25) {
        ctx.font = `${size.toFixed(1)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        lastPx = size;
      }
      ctx.fillText(tx.text, tx.x * view.scale + view.tx, tx.y * view.scale + view.ty);
      drawn++;
    }
  }

  /** Grille métrique de la feuille vierge (1 unité = 1 m). */
  private drawGrid(ctx: CanvasRenderingContext2D, view: View, colors: CanvasColors): void {
    const { width, height } = this.size;
    const visible = visibleBBox(view, this.size);
    const minor = niceStep(view.scale, 14);
    const major = minor * 5;
    const drawLines = (step: number, color: string): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x0 = Math.floor(visible.minX / step) * step;
      for (let x = x0; x <= visible.maxX; x += step) {
        const sx = Math.round(x * view.scale + view.tx) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, height);
      }
      const y0 = Math.floor(visible.minY / step) * step;
      for (let y = y0; y <= visible.maxY; y += step) {
        const sy = Math.round(y * view.scale + view.ty) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(width, sy);
      }
      ctx.stroke();
    };
    ctx.fillStyle = colors.paper;
    ctx.fillRect(0, 0, width, height);
    drawLines(minor, colors.grid);
    drawLines(major, colors.gridStrong);
  }

  dispose(): void {
    this.onImageReady = null;
    if (this.image) this.image.onload = null;
    this.image = null;
    this.snapshot = null;
    this.snapshotView = null;
  }
}
