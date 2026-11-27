import { describe, expect, it } from 'vitest';
import type { Frame } from '../../../src/readers/ifc/model';
import { openingGeometry, probeExterior } from '../../../src/readers/ifc/openings';
import { labelPieces, makeGrid, rasterizeOccupancy } from '../../../src/readers/ifc/raster';

type P3 = [number, number, number];

/** Pavé quelconque défini par une origine et trois arêtes. */
function box(o: P3, u: P3, v: P3, w: P3): Float32Array {
  const p = (a: number, b: number, c: number): P3 => [o[0] + a * u[0] + b * v[0] + c * w[0], o[1] + a * u[1] + b * v[1] + c * w[1], o[2] + a * u[2] + b * v[2] + c * w[2]];
  const out: number[] = [];
  const quad = (a: P3, b: P3, c: P3, d: P3): void => {
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  quad(p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0));
  quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1));
  quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1));
  quad(p(0, 1, 0), p(1, 1, 0), p(1, 1, 1), p(0, 1, 1));
  quad(p(0, 0, 0), p(0, 1, 0), p(0, 1, 1), p(0, 0, 1));
  quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1));
  return new Float32Array(out);
}

const frame = (x: P3): Frame => ({ o: [0, 0, 0], x, y: [-x[1], x[0], 0], z: [0, 0, 1] });

describe('géométrie d’une ouverture', () => {
  it('baie large dans un mur mince : centre, direction, étendues', () => {
    // Baie de 1,20 m (selon x) × 0,30 m d'épaisseur de mur × 1,40 m de haut, allège à 0,90 m.
    const g = openingGeometry(box([2, 5, 0.9], [1.2, 0, 0], [0, 0.3, 0], [0, 0, 1.4]), frame([1, 0, 0]), 1.2)!;
    expect(g.cx).toBeCloseTo(2.6, 5);
    expect(g.cy).toBeCloseTo(5.15, 5);
    expect(Math.abs(g.dx)).toBeCloseTo(1, 6);
    expect(g.along).toBeCloseTo(1.2, 5);
    expect(g.depth).toBeCloseTo(0.3, 5);
    expect(g.zMin).toBeCloseTo(0.9, 5);
    expect(g.zMax).toBeCloseTo(2.3, 5);
    expect(g.tilted).toBe(false);
  });

  it('baie étroite dans un mur épais : l’axe du placement l’emporte sur la forme du pavé', () => {
    // Soupirail de 0,50 m dans un mur en pierre de 0,80 m : en plan, le pavé est plus « long » dans l'épaisseur.
    const g = openingGeometry(box([0, 0, 1], [0.5, 0, 0], [0, 0.8, 0], [0, 0, 0.4]), frame([1, 0, 0]), 0.5)!;
    expect(Math.abs(g.dx)).toBeCloseTo(1, 6);
    expect(g.along).toBeCloseTo(0.5, 5);
    expect(g.depth).toBeCloseTo(0.8, 5);
  });

  it('axe X du placement en travers du mur (vu dans des exports Revit) : rattrapé par la largeur déclarée', () => {
    const g = openingGeometry(box([0, 0, 0], [1.5, 0, 0], [0, 0.25, 0], [0, 0, 1.2]), frame([0, 1, 0]), 1.5)!;
    expect(Math.abs(g.dx)).toBeCloseTo(1, 6);
    expect(g.along).toBeCloseTo(1.5, 5);
  });

  it('mur tourné de 30°, sans placement : direction par l’axe principal', () => {
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const g = openingGeometry(box([4, 1, 0], [2 * c, 2 * s, 0], [-0.3 * s, 0.3 * c, 0], [0, 0, 2.1]), null, null)!;
    expect(Math.abs(g.dx * c + g.dy * s)).toBeCloseTo(1, 4);
    expect(g.along).toBeCloseTo(2, 4);
    expect(g.depth).toBeCloseTo(0.3, 4);
  });

  it('fenêtre de toit (pavé incliné à 40°) : signalée comme couchée', () => {
    const a = (40 * Math.PI) / 180;
    const g = openingGeometry(box([0, 0, 3], [0.8, 0, 0], [0, 1.2 * Math.cos(a), 1.2 * Math.sin(a)], [0, -0.3 * Math.sin(a), 0.3 * Math.cos(a)]), null, 0.8)!;
    expect(g.tilted).toBe(true);
  });
});

describe('test « ouverture extérieure »', () => {
  // Emprise pleine [0, 10] × [0, 8] : la façade sud est la droite y = 0.
  const grid = makeGrid({ minX: 0, minY: 0, maxX: 10, maxY: 8 }, 0.025, 1e7);
  const occ = new Uint8Array(grid.nx * grid.ny);
  rasterizeOccupancy(grid, new Float32Array([0, 0, 0, 10, 0, 0, 10, 8, 0, 0, 0, 0, 10, 8, 0, 0, 8, 0]), occ);
  const { labels } = labelPieces(grid, occ, 10);
  const window = (cx: number, cy: number, dx: number, dy: number) => ({ cx, cy, dx, dy, along: 1.2, depth: 0.3, zMin: 0.9, zMax: 2.3, tilted: false });

  it('fenêtre dans le mur de façade : extérieure, normale vers le dehors, point sur la façade', () => {
    const p = probeExterior(grid, labels, window(4, 0.15, 1, 0), 1);
    expect(p.exterior).toBe(true);
    expect(p.ny).toBeCloseTo(-1, 6);
    expect(Math.abs(p.fy)).toBeLessThan(0.03);
    expect(p.fx).toBeCloseTo(4, 6);
  });

  it('porte de cloison au milieu du bâtiment : intérieure', () => {
    expect(probeExterior(grid, labels, window(5, 4, 1, 0), 1).exterior).toBe(false);
  });

  it('porte de refend perpendiculaire à la façade, tout près d’elle : intérieure', () => {
    expect(probeExterior(grid, labels, window(5, 0.7, 0, 1), 1).exterior).toBe(false);
  });

  it('portail dans un mur isolé hors de l’emprise : pas une ouverture de l’enveloppe', () => {
    expect(probeExterior(grid, labels, window(5, -3, 1, 0), 1).exterior).toBe(false);
  });

  it('fenêtre en retrait dans un mur de 80 cm : trouvée en allongeant la sonde', () => {
    const deep = { ...window(4, 0.7, 1, 0), depth: 0.8 };
    expect(probeExterior(grid, labels, deep, 0.5).exterior).toBe(false);
    expect(probeExterior(grid, labels, deep, 1.0).exterior).toBe(true);
  });
});
