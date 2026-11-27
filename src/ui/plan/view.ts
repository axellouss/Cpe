/**
 * Transformation de vue de l'éditeur de plan (logique pure, sans DOM).
 *
 * Écran = feuille × scale + (tx, ty). La feuille est en y-vers-le-bas comme l'écran : aucune inversion.
 * Toutes les longueurs « écran » sont en pixels CSS.
 */
import type { BBox, Vec2 } from '../../core/types';

export interface View {
  /** Pixels CSS par unité de feuille. */
  scale: number;
  tx: number;
  ty: number;
}

export interface Size {
  width: number;
  height: number;
}

export const IDENTITY_VIEW: View = { scale: 1, tx: 0, ty: 0 };

export function sheetToScreen(view: View, p: Vec2): Vec2 {
  return { x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty };
}

export function screenToSheet(view: View, p: Vec2): Vec2 {
  return { x: (p.x - view.tx) / view.scale, y: (p.y - view.ty) / view.scale };
}

/** Rectangle de la feuille visible à l'écran. */
export function visibleBBox(view: View, size: Size): BBox {
  const a = screenToSheet(view, { x: 0, y: 0 });
  const b = screenToSheet(view, { x: size.width, y: size.height });
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

export function unionBBox(a: BBox | null, b: BBox | null): BBox | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function isUsableBBox(b: BBox | null | undefined): b is BBox {
  return (
    !!b &&
    Number.isFinite(b.minX) &&
    Number.isFinite(b.minY) &&
    Number.isFinite(b.maxX) &&
    Number.isFinite(b.maxY) &&
    b.maxX >= b.minX &&
    b.maxY >= b.minY
  );
}

/** Agrandit un rectangle d'une fraction de sa plus grande dimension (marge autour d'un contour). */
export function inflateBBox(b: BBox, ratio: number): BBox {
  const m = Math.max(b.maxX - b.minX, b.maxY - b.minY) * ratio;
  return { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
}

/**
 * Vue qui montre tout le rectangle, centré, avec une marge en pixels.
 * Un rectangle dégénéré (point, ligne) reçoit une étendue minimale pour éviter un zoom infini.
 */
export function fitView(bbox: BBox, size: Size, padding = 24): View {
  const w = Math.max(bbox.maxX - bbox.minX, 1e-9);
  const h = Math.max(bbox.maxY - bbox.minY, 1e-9);
  const availW = Math.max(size.width - 2 * padding, 16);
  const availH = Math.max(size.height - 2 * padding, 16);
  const scale = Math.min(availW / w, availH / h);
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  return { scale, tx: size.width / 2 - cx * scale, ty: size.height / 2 - cy * scale };
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Comme `fitView`, mais dans la partie de l'écran laissée libre par l'interface (bandeaux, boutons). */
export function fitViewInsets(bbox: BBox, size: Size, insets: Insets, padding = 16): View {
  const inner: Size = {
    width: Math.max(size.width - insets.left - insets.right, 48),
    height: Math.max(size.height - insets.top - insets.bottom, 48),
  };
  const v = fitView(bbox, inner, padding);
  return { scale: v.scale, tx: v.tx + insets.left, ty: v.ty + insets.top };
}

export interface ZoomLimits {
  min: number;
  max: number;
}

export function clampScale(scale: number, limits: ZoomLimits): number {
  return Math.min(limits.max, Math.max(limits.min, scale));
}

/** Zoom d'un facteur autour d'un point de l'écran : le point de la feuille sous le curseur ne bouge pas. */
export function zoomAt(view: View, screenPoint: Vec2, factor: number, limits?: ZoomLimits): View {
  let scale = view.scale * factor;
  if (limits) scale = clampScale(scale, limits);
  if (!Number.isFinite(scale) || scale <= 0) return view;
  const k = scale / view.scale;
  return {
    scale,
    tx: screenPoint.x - (screenPoint.x - view.tx) * k,
    ty: screenPoint.y - (screenPoint.y - view.ty) * k,
  };
}

export function panBy(view: View, dx: number, dy: number): View {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy };
}

/**
 * Pincement à deux doigts : l'ancien couple de points (centre, écart) devient le nouveau.
 * Combine zoom autour du centre et déplacement du centre.
 */
export function pinch(
  view: View,
  previous: { centre: Vec2; distance: number },
  current: { centre: Vec2; distance: number },
  limits?: ZoomLimits,
): View {
  const factor = previous.distance > 1 ? current.distance / previous.distance : 1;
  const zoomed = zoomAt(view, previous.centre, factor, limits);
  return panBy(zoomed, current.centre.x - previous.centre.x, current.centre.y - previous.centre.y);
}

/** Facteur de zoom pour un événement molette (deltaMode 0 = pixels, 1 = lignes, 2 = pages). */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pinchGesture: boolean): number {
  const pixels = deltaMode === 1 ? deltaY * 32 : deltaMode === 2 ? deltaY * 400 : deltaY;
  // Le pincement au pavé tactile arrive comme une molette + Ctrl avec de petits deltas : on l'amplifie.
  const speed = pinchGesture ? 0.01 : 0.0018;
  const clamped = Math.max(-600, Math.min(600, pixels));
  return Math.exp(-clamped * speed);
}

/** Vrai si deux vues sont pratiquement identiques (pour l'alternance du bouton « ajuster »). */
export function sameView(a: View, b: View, tolPx = 1.5): boolean {
  return Math.abs(a.scale / b.scale - 1) < 0.01 && Math.abs(a.tx - b.tx) < tolPx && Math.abs(a.ty - b.ty) < tolPx;
}

/**
 * Pas de grille « rond » (1, 2, 5 × 10^n unités) tel que deux lignes soient espacées d'au moins `minPx` à l'écran.
 */
export function niceStep(scale: number, minPx: number): number {
  const raw = minPx / scale;
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}
