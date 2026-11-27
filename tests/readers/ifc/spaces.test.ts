import { describe, expect, it } from 'vitest';
import { polygonArea } from '../../../src/core/geometry';
import { roomGeometry } from '../../../src/readers/ifc/spaces';

type P3 = [number, number, number];

/** Prisme droit : contour en plan (sens quelconque, convexe ou en L découpé en éventail valide), sol z0, plafond z1. */
function prism(outline: [number, number][], z0: number, z1: number, fan: number[][]): number[] {
  const out: number[] = [];
  const tri = (a: P3, b: P3, c: P3): void => {
    out.push(...a, ...b, ...c);
  };
  for (const [i, j, k] of fan as [number, number, number][]) {
    const a = outline[i]!;
    const b = outline[j]!;
    const c = outline[k]!;
    tri([a[0], a[1], z0], [c[0], c[1], z0], [b[0], b[1], z0]);
    tri([a[0], a[1], z1], [b[0], b[1], z1], [c[0], c[1], z1]);
  }
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    tri([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1]);
    tri([a[0], a[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]);
  }
  return out;
}

describe('géométrie d’un local', () => {
  it('pièce rectangulaire : surface exacte, contour à 4 sommets, hauteur libre', () => {
    const soup = new Float32Array(prism([[1, 2], [5, 2], [5, 5], [1, 5]], 0.1, 2.6, [[0, 1, 2], [0, 2, 3]]));
    const g = roomGeometry(soup)!;
    expect(g.floorArea).toBeCloseTo(12, 5);
    expect(g.usableArea).toBeCloseTo(12, 5);
    expect(g.meanHeight).toBeCloseTo(2.5, 5);
    expect(g.sloped).toBe(false);
    expect(g.polygon).toHaveLength(4);
    expect(polygonArea(g.polygon!)).toBeCloseTo(12, 5);
    expect(g.at.x).toBeCloseTo(3, 5);
    expect(g.at.y).toBeCloseTo(3.5, 5);
  });

  it('pièce en L : contour à 6 sommets et étiquette à l’intérieur', () => {
    // L = [0, 6] × [0, 2] ∪ [0, 2] × [2, 6] → 12 + 8 = 20 m²
    const outline: [number, number][] = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
    const soup = new Float32Array(prism(outline, 0, 2.5, [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]]));
    const g = roomGeometry(soup)!;
    expect(g.floorArea).toBeCloseTo(20, 5);
    expect(g.polygon).toHaveLength(6);
    expect(polygonArea(g.polygon!)).toBeCloseTo(20, 5);
    // Le point d'étiquette doit tomber dans le L (pas dans l'angle rentrant).
    expect(g.at.x <= 2 || g.at.y <= 2).toBe(true);
  });

  it('sous un rampant : seule la partie d’au moins 1,0 m de hauteur libre compte', () => {
    // Pièce 4 × 5 m ; le plafond monte de 0,50 m (x = 0) à 2,50 m (x = 4) : h ≥ 1,0 m pour x ≥ 1 → 3 × 5 = 15 m².
    const tri: number[] = [];
    const t = (a: P3, b: P3, c: P3): void => {
      tri.push(...a, ...b, ...c);
    };
    const f: P3[] = [[0, 0, 0], [4, 0, 0], [4, 5, 0], [0, 5, 0]];
    const c: P3[] = [[0, 0, 0.5], [4, 0, 2.5], [4, 5, 2.5], [0, 5, 0.5]];
    t(f[0]!, f[2]!, f[1]!);
    t(f[0]!, f[3]!, f[2]!);
    t(c[0]!, c[1]!, c[2]!);
    t(c[0]!, c[2]!, c[3]!);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      t(f[i]!, f[j]!, c[j]!);
      t(f[i]!, c[j]!, c[i]!);
    }
    const g = roomGeometry(new Float32Array(tri))!;
    expect(g.sloped).toBe(true);
    expect(g.floorArea).toBeCloseTo(20, 5);
    expect(g.usableArea).toBeGreaterThan(14.8);
    expect(g.usableArea).toBeLessThan(15.2);
    // Hauteur moyenne de la partie utile : de 1,0 m à 2,5 m → 1,75 m.
    expect(g.meanHeight).toBeGreaterThan(1.72);
    expect(g.meanHeight).toBeLessThan(1.78);
    expect(g.polygon).toHaveLength(4);
  });

  it('vide technique de 80 cm : aucune surface utile', () => {
    const soup = new Float32Array(prism([[0, 0], [3, 0], [3, 3], [0, 3]], 0, 0.8, [[0, 1, 2], [0, 2, 3]]));
    const g = roomGeometry(soup)!;
    expect(g.floorArea).toBeCloseTo(9, 5);
    expect(g.usableArea).toBe(0);
  });

  it('maillage vide : null', () => {
    expect(roomGeometry(new Float32Array(0))).toBeNull();
  });
});
