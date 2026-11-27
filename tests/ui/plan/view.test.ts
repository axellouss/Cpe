import { describe, expect, it } from 'vitest';
import {
  clampScale,
  fitView,
  fitViewInsets,
  inflateBBox,
  isUsableBBox,
  niceStep,
  panBy,
  pinch,
  sameView,
  screenToSheet,
  sheetToScreen,
  unionBBox,
  visibleBBox,
  wheelZoomFactor,
  zoomAt,
} from '../../../src/ui/plan/view';

const size = { width: 800, height: 600 };

describe('transformation de vue', () => {
  it('écran ↔ feuille sont inverses, sans inversion de y', () => {
    const view = { scale: 2.5, tx: 40, ty: -30 };
    const p = { x: 12, y: 34 };
    const s = sheetToScreen(view, p);
    expect(s).toEqual({ x: 70, y: 55 });
    expect(screenToSheet(view, s)).toEqual(p);
    // y vers le bas des deux côtés : un point plus bas sur la feuille est plus bas à l'écran.
    expect(sheetToScreen(view, { x: 0, y: 10 }).y).toBeGreaterThan(sheetToScreen(view, { x: 0, y: 0 }).y);
  });

  it('fitView centre le rectangle et respecte la marge', () => {
    const view = fitView({ minX: 100, minY: 200, maxX: 300, maxY: 300 }, size, 20);
    // Largeur limitante : 760 px pour 200 unités.
    expect(view.scale).toBeCloseTo(3.8, 10);
    expect(sheetToScreen(view, { x: 200, y: 250 })).toEqual({ x: 400, y: 300 });
    const box = visibleBBox(view, size);
    expect(box.minX).toBeLessThan(100);
    expect(box.maxX).toBeGreaterThan(300);
  });

  it('fitView ne diverge pas sur un rectangle dégénéré', () => {
    const view = fitView({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, size);
    expect(Number.isFinite(view.scale)).toBe(true);
    expect(sheetToScreen(view, { x: 5, y: 5 })).toEqual({ x: 400, y: 300 });
  });

  it('fitViewInsets cadre dans la zone laissée libre par l’interface', () => {
    const insets = { top: 100, right: 50, bottom: 60, left: 10 };
    const view = fitViewInsets({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, size, insets, 0);
    const a = sheetToScreen(view, { x: 0, y: 0 });
    const b = sheetToScreen(view, { x: 100, y: 100 });
    expect(a.y).toBeCloseTo(100, 6);
    expect(b.y).toBeCloseTo(540, 6);
    // Centré horizontalement dans [10, 750].
    expect((a.x + b.x) / 2).toBeCloseTo(380, 6);
  });

  it('zoomAt garde fixe le point sous le curseur', () => {
    const view = { scale: 1.3, tx: 17, ty: 91 };
    const cursor = { x: 333, y: 222 };
    const before = screenToSheet(view, cursor);
    const zoomed = zoomAt(view, cursor, 1.75);
    const after = screenToSheet(zoomed, cursor);
    expect(zoomed.scale).toBeCloseTo(1.3 * 1.75, 12);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('zoomAt respecte les limites, et le point reste fixe même à la butée', () => {
    const view = { scale: 1, tx: 0, ty: 0 };
    const limits = { min: 0.5, max: 4 };
    const cursor = { x: 100, y: 50 };
    const z = zoomAt(view, cursor, 100, limits);
    expect(z.scale).toBe(4);
    expect(screenToSheet(z, cursor)).toEqual(screenToSheet(view, cursor));
    expect(zoomAt(view, cursor, 0.001, limits).scale).toBe(0.5);
    expect(clampScale(9, limits)).toBe(4);
  });

  it('panBy déplace sans changer l’échelle', () => {
    expect(panBy({ scale: 2, tx: 1, ty: 2 }, 10, -5)).toEqual({ scale: 2, tx: 11, ty: -3 });
  });

  it('pincement : le point de la feuille sous le centre des doigts suit le centre', () => {
    const view = { scale: 2, tx: 10, ty: 20 };
    const previous = { centre: { x: 200, y: 200 }, distance: 100 };
    const current = { centre: { x: 230, y: 190 }, distance: 150 };
    const anchored = screenToSheet(view, previous.centre);
    const next = pinch(view, previous, current);
    expect(next.scale).toBeCloseTo(3, 12);
    const now = sheetToScreen(next, anchored);
    expect(now.x).toBeCloseTo(230, 9);
    expect(now.y).toBeCloseTo(190, 9);
  });

  it('molette : vers le haut agrandit, vers le bas réduit, de façon symétrique et bornée', () => {
    const zin = wheelZoomFactor(-100, 0, false);
    const zout = wheelZoomFactor(100, 0, false);
    expect(zin).toBeGreaterThan(1);
    expect(zout).toBeLessThan(1);
    expect(zin * zout).toBeCloseTo(1, 12);
    // Mode « lignes » : plus fort qu'un pixel ; pincement au pavé tactile : amplifié.
    expect(wheelZoomFactor(-3, 1, false)).toBeGreaterThan(wheelZoomFactor(-3, 0, false));
    expect(wheelZoomFactor(-10, 0, true)).toBeGreaterThan(wheelZoomFactor(-10, 0, false));
    expect(wheelZoomFactor(-1e6, 0, false)).toBeLessThan(4);
  });

  it('rectangles : union, validité, marge', () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 5 };
    const b = { minX: -2, minY: 1, maxX: 4, maxY: 9 };
    expect(unionBBox(a, b)).toEqual({ minX: -2, minY: 0, maxX: 10, maxY: 9 });
    expect(unionBBox(null, b)).toBe(b);
    expect(unionBBox(a, null)).toBe(a);
    expect(isUsableBBox(a)).toBe(true);
    expect(isUsableBBox({ minX: 0, minY: 0, maxX: Infinity, maxY: 1 })).toBe(false);
    expect(isUsableBBox({ minX: 3, minY: 0, maxX: 1, maxY: 1 })).toBe(false);
    expect(isUsableBBox(null)).toBe(false);
    expect(inflateBBox(a, 0.1)).toEqual({ minX: -1, minY: -1, maxX: 11, maxY: 6 });
  });

  it('sameView tolère les arrondis mais pas un vrai déplacement', () => {
    const v = { scale: 1.5, tx: 100, ty: 50 };
    expect(sameView(v, { scale: 1.5001, tx: 100.4, ty: 49.2 })).toBe(true);
    expect(sameView(v, { scale: 1.5, tx: 110, ty: 50 })).toBe(false);
    expect(sameView(v, { scale: 1.7, tx: 100, ty: 50 })).toBe(false);
  });

  it('niceStep donne un pas rond d’au moins la taille demandée à l’écran', () => {
    for (const scale of [0.03, 0.4, 1, 7, 55, 900]) {
      const step = niceStep(scale, 14);
      expect(step * scale).toBeGreaterThanOrEqual(14 - 1e-9);
      expect(step * scale).toBeLessThan(14 * 2.6);
      const mantissa = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
      expect([1, 2, 5, 10].some((m) => Math.abs(m - mantissa) < 1e-6)).toBe(true);
    }
    expect(niceStep(50, 7)).toBeCloseTo(0.2, 12);
  });
});
