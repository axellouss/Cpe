import { describe, expect, it } from 'vitest';
import { polygonArea } from '../../../src/core/geometry';
import type { Vec2 } from '../../../src/core/types';
import { buildFootprint } from '../../../src/readers/ifc/footprint';
import { PointIndex, cleanOutline, simplifyRing } from '../../../src/readers/ifc/outline';
import {
  erodeMask,
  footprintMask,
  isInside,
  labelAt,
  labelPieces,
  makeGrid,
  rasterizeHeights,
  rasterizeOccupancy,
  removeThinArms,
  traceOuterBoundary,
} from '../../../src/readers/ifc/raster';

/** Rectangle horizontal [x0, x1] × [y0, y1] à la cote z, en deux triangles. */
function quad(x0: number, y0: number, x1: number, y1: number, z = 0): number[] {
  return [x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z];
}

/** Quadrilatère quelconque (4 sommets en plan) à la cote z. */
function quad4(p: Vec2[], z = 0): number[] {
  const [a, b, c, d] = p as [Vec2, Vec2, Vec2, Vec2];
  return [a.x, a.y, z, b.x, b.y, z, c.x, c.y, z, a.x, a.y, z, c.x, c.y, z, d.x, d.y, z];
}

function toRing(flat: number[]): Vec2[] {
  const ring: Vec2[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) ring.push({ x: flat[i]!, y: flat[i + 1]! });
  return ring;
}

function count(a: Uint8Array | Uint16Array): number {
  let n = 0;
  for (const v of a) if (v !== 0) n++;
  return n;
}

describe('trame d’occupation', () => {
  it('grossit la maille quand la grille dépasserait le plafond de cellules', () => {
    const g = makeGrid({ minX: 0, minY: 0, maxX: 98, maxY: 48 }, 0.025, 1_000_000);
    expect(g.nx * g.ny).toBeLessThanOrEqual(1_010_000);
    expect(g.cell).toBeGreaterThan(0.025);
    const small = makeGrid({ minX: 0, minY: 0, maxX: 10, maxY: 8 }, 0.025, 1_000_000);
    expect(small.cell).toBe(0.025);
    expect(small.minX).toBe(-1);
  });

  it('couvre exactement un rectangle aligné sur la trame, sans trou entre les deux triangles', () => {
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 4, maxY: 3 }, 0.05, 1e7);
    const occ = new Uint8Array(grid.nx * grid.ny);
    rasterizeOccupancy(grid, new Float32Array(quad(0, 0, 4, 3)), occ);
    expect(count(occ) * grid.cell * grid.cell).toBeCloseTo(12, 6);
  });

  it('mesure un triangle quelconque à mieux que 1 %', () => {
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 5, maxY: 4 }, 0.02, 1e7);
    const occ = new Uint8Array(grid.nx * grid.ny);
    rasterizeOccupancy(grid, new Float32Array([0.13, 0.21, 0, 4.87, 1.3, 0, 2.2, 3.71, 0]), occ);
    const exact = Math.abs((4.87 - 0.13) * (3.71 - 0.21) - (2.2 - 0.13) * (1.3 - 0.21)) / 2;
    expect(Math.abs(count(occ) * grid.cell * grid.cell - exact) / exact).toBeLessThan(0.01);
  });

  it('ignore les triangles verticaux (sans surface en plan)', () => {
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 2, maxY: 2 }, 0.05, 1e7);
    const occ = new Uint8Array(grid.nx * grid.ny);
    rasterizeOccupancy(grid, new Float32Array([0, 1, 0, 2, 1, 0, 2, 1, 3]), occ);
    expect(count(occ)).toBe(0);
  });

  it('champ de hauteurs : cote haute et cote basse par cellule', () => {
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 2, maxY: 2 }, 0.1, 1e7, 0.1);
    const n = grid.nx * grid.ny;
    const top = new Float32Array(n).fill(-Infinity);
    const bottom = new Float32Array(n).fill(Infinity);
    rasterizeHeights(grid, new Float32Array([...quad(0, 0, 2, 2, 0.5), ...quad(0, 0, 2, 2, 3)]), top, bottom);
    const c = Math.floor((1 - grid.minX) / grid.cell) * grid.ny + Math.floor((1 - grid.minY) / grid.cell);
    expect(top[c]).toBeCloseTo(3, 6);
    expect(bottom[c]).toBeCloseTo(0.5, 6);
  });
});

describe('emprise, morceaux et contour', () => {
  // Quatre murs de 0,30 m autour de [0, 6] × [0, 4], avec un interstice de 4 cm dans un angle.
  const walls = new Float32Array([
    ...quad(0, 0, 6, 0.3),
    ...quad(5.7, 0.34, 6, 4), // interstice de 4 cm avec le mur du bas
    ...quad(0, 3.7, 6, 4),
    ...quad(0, 0, 0.3, 4),
  ]);

  it('ferme les petits interstices et remplit l’intérieur', () => {
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 6, maxY: 4 }, 0.025, 1e7);
    const occ = new Uint8Array(grid.nx * grid.ny);
    rasterizeOccupancy(grid, walls, occ);
    const mask = footprintMask(grid, occ, 3);
    expect(count(mask) * grid.cell * grid.cell).toBeCloseTo(24, 1);
    const pieces = labelPieces(grid, mask, 100);
    expect(pieces.cells).toHaveLength(1);
    expect(isInside(grid, pieces.labels, 3, 2)).toBe(true);
    expect(isInside(grid, pieces.labels, 6.2, 2)).toBe(false);
  });

  it('laisse l’extérieur entrer par une vraie brèche (pas de remplissage abusif)', () => {
    const open = new Float32Array([...quad(0, 0, 6, 0.3), ...quad(0, 3.7, 6, 4), ...quad(0, 0, 0.3, 4)]); // sans mur à droite
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 6, maxY: 4 }, 0.025, 1e7);
    const occ = new Uint8Array(grid.nx * grid.ny);
    rasterizeOccupancy(grid, open, occ);
    const mask = footprintMask(grid, occ, 3);
    expect(count(mask) * grid.cell * grid.cell).toBeCloseTo(6 * 0.3 * 2 + 3.4 * 0.3, 1);
  });

  it('trie les morceaux par taille, écarte les miettes et les murs isolés sans « cœur »', () => {
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 20, maxY: 10 }, 0.05, 1e7);
    const occ = new Uint8Array(grid.nx * grid.ny);
    rasterizeOccupancy(grid, new Float32Array([
      ...quad(0, 0, 6, 4), // 24 m²
      ...quad(8, 0, 11, 3), // 9 m²
      ...quad(12, 0, 12.5, 0.5), // miette de 0,25 m²
      ...quad(0, 6, 20, 6.3), // mur de jardin : 6 m² mais 30 cm de large
    ]), occ);
    const mask = footprintMask(grid, occ, 1);
    const all = labelPieces(grid, mask, Math.ceil(4 / (grid.cell * grid.cell)));
    expect(all.cells.map((c) => Math.round(c * grid.cell * grid.cell))).toEqual([24, 9, 6]);
    const solid = labelPieces(grid, mask, Math.ceil(4 / (grid.cell * grid.cell)), erodeMask(grid, mask, Math.round(0.6 / grid.cell)));
    expect(solid.cells.map((c) => Math.round(c * grid.cell * grid.cell))).toEqual([24, 9]);
    expect(labelAt(grid, solid.labels, 3, 2)).toBe(1);
    expect(labelAt(grid, solid.labels, 9, 1)).toBe(2);
    expect(labelAt(grid, solid.labels, 10, 6.1)).toBe(0);
  });

  it('suit le contour extérieur d’un L en ignorant un trou intérieur', () => {
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 10, maxY: 8 }, 0.05, 1e7);
    const occ = new Uint8Array(grid.nx * grid.ny);
    // L = [0, 10] × [0, 5] ∪ [4, 10] × [5, 8], percé d'un patio [6, 8] × [1, 3].
    rasterizeOccupancy(grid, new Float32Array([
      ...quad(0, 0, 6, 5), ...quad(8, 0, 10, 5), ...quad(6, 0, 8, 1), ...quad(6, 3, 8, 5), ...quad(4, 5, 10, 8),
    ]), occ);
    const pieces = labelPieces(grid, occ, 10);
    expect(pieces.cells).toHaveLength(1);
    const ring = toRing(traceOuterBoundary(grid, pieces.labels, 1));
    expect(ring).toHaveLength(6);
    expect(polygonArea(ring)).toBeCloseTo(68, 6); // le patio n'est pas retranché
    // Sens trigonométrique dans le repère IFC (y vers le haut) : aire signée « mathématique » positive.
    let signed = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      signed += a.x * b.y - b.x * a.y;
    }
    expect(signed).toBeGreaterThan(0);
  });
});

describe('murs en saillie (« bras » minces)', () => {
  const armCells = (cell: number): number => Math.round(0.25 / cell);

  it('retire un mur de jardin accolé à la façade et un mur isolé, sans toucher au bâtiment', () => {
    const grid = makeGrid({ minX: 0, minY: -4, maxX: 12, maxY: 8 }, 0.025, 1e7);
    const mask = new Uint8Array(grid.nx * grid.ny);
    rasterizeOccupancy(grid, new Float32Array([
      ...quad(0, 0, 6, 4), // bâtiment : 24 m²
      ...quad(2, -3, 2.3, 0), // mur de jardin de 30 cm perpendiculaire à la façade sud
      ...quad(8, 0, 12, 0.24), // mur isolé
    ]), mask);
    const removed = removeThinArms(grid, mask, armCells(grid.cell));
    expect(removed * grid.cell * grid.cell).toBeCloseTo(0.9 + 0.96, 1);
    expect(count(mask) * grid.cell * grid.cell).toBeCloseTo(24, 6);
  });

  it('ne retire rien d’un bâtiment tourné : les angles saillants restent entiers', () => {
    const a = (30 * Math.PI) / 180;
    const corners = [[0, 0], [9, 0], [9, 7], [0, 7]].map(([x, y]) => ({ x: 5 + x! * Math.cos(a) - y! * Math.sin(a), y: 1 + x! * Math.sin(a) + y! * Math.cos(a) }));
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 14, maxY: 12 }, 0.025, 1e7);
    const mask = new Uint8Array(grid.nx * grid.ny);
    rasterizeOccupancy(grid, new Float32Array(quad4(corners)), mask);
    const before = count(mask);
    expect(removeThinArms(grid, mask, armCells(grid.cell))).toBe(0);
    expect(count(mask)).toBe(before);
  });

  it('bâtiment tourné avec un mur de jardin accolé : le mur est retiré en entier, le contour reste net', () => {
    const a = (30 * Math.PI) / 180;
    const rot = (x: number, y: number): Vec2 => ({ x: 5 + x * Math.cos(a) - y * Math.sin(a), y: 3 + x * Math.sin(a) + y * Math.cos(a) });
    const body = new Float32Array(quad4([rot(0, 0), rot(9, 0), rot(9, 7), rot(0, 7)]));
    const garden = new Float32Array(quad4([rot(4, -2.5), rot(4.3, -2.5), rot(4.3, 0.05), rot(4, 0.05)]));
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 14, maxY: 14 }, 0.025, 1e7);
    const settings = { closeCells: 3, spaceCloseCells: 10, armCells: armCells(grid.cell), coreCells: 24, minPieceCells: 6400 };
    // Le « bâtiment » est donné comme un local plein, le mur de jardin comme un mur.
    const footprint = buildFootprint(grid, [garden], [body], settings);
    expect([...footprint.detached]).toEqual([0]);
    expect(footprint.armCells * grid.cell * grid.cell).toBeGreaterThan(0.6);
    expect(footprint.pieces.cells).toHaveLength(1);
    const exact = new PointIndex(3 * grid.cell, grid.minX, grid.minY);
    exact.addSoup(body);
    const out = cleanOutline(toRing(traceOuterBoundary(grid, footprint.pieces.labels, 1)), grid.cell, exact);
    expect(out).toHaveLength(4);
    expect(polygonArea(out)).toBeCloseTo(63, 2);
  });

  it('pignon plus large que le volume : seule la partie qui dépasse est rognée', () => {
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 10, maxY: 6 }, 0.025, 1e7);
    const settings = { closeCells: 3, spaceCloseCells: 10, armCells: armCells(grid.cell), coreCells: 24, minPieceCells: 6400 };
    const room = new Float32Array(quad(2, 0.3, 8, 5.7));
    const gables = [new Float32Array(quad(0, 0, 10, 0.3)), new Float32Array(quad(0, 5.7, 10, 6))];
    const footprint = buildFootprint(grid, gables, [room], settings);
    expect(footprint.detached.size).toBe(0); // 60 % de chaque pignon borde le local : il reste un mur du volume
    let cells = 0;
    for (const v of footprint.pieces.labels) if (v === 1) cells++;
    expect(cells * grid.cell * grid.cell).toBeCloseTo(6 * 6, 1);
  });
});

describe('du contour en escalier au polygone', () => {
  const rotated = (angleDeg: number, w: number, h: number, ox: number, oy: number): Vec2[] => {
    const a = (angleDeg * Math.PI) / 180;
    return [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ].map((p) => ({ x: ox + p.x * Math.cos(a) - p.y * Math.sin(a), y: oy + p.x * Math.sin(a) + p.y * Math.cos(a) }));
  };

  it('garde les quatre coins d’un rectangle tracé point par point', () => {
    const ring: Vec2[] = [];
    for (let x = 0; x < 10; x += 0.5) ring.push({ x, y: 0 });
    for (let y = 0; y < 6; y += 0.5) ring.push({ x: 10, y });
    for (let x = 10; x > 0; x -= 0.5) ring.push({ x, y: 6 });
    for (let y = 6; y > 0; y -= 0.5) ring.push({ x: 0, y });
    const out = simplifyRing(ring, 0.01);
    expect(out).toHaveLength(4);
    expect(polygonArea(out)).toBeCloseTo(60, 9);
  });

  for (const angle of [0, 17, 25, 45, 63.4]) {
    it(`rectangle 9 × 7 tourné de ${angle}° : 4 sommets exacts après accrochage`, () => {
      const corners = rotated(angle, 9, 7, 3.137, 2.412);
      const grid = makeGrid({ minX: Math.min(...corners.map((p) => p.x)), minY: Math.min(...corners.map((p) => p.y)), maxX: Math.max(...corners.map((p) => p.x)), maxY: Math.max(...corners.map((p) => p.y)) }, 0.025, 1e7);
      const soup = new Float32Array(quad4(corners));
      const occ = new Uint8Array(grid.nx * grid.ny);
      rasterizeOccupancy(grid, soup, occ);
      const pieces = labelPieces(grid, occ, 10);
      const stair = toRing(traceOuterBoundary(grid, pieces.labels, 1));
      const exact = new PointIndex(3 * grid.cell, grid.minX, grid.minY);
      exact.addSoup(soup);
      const out = cleanOutline(stair, grid.cell, exact);
      expect(out).toHaveLength(4);
      expect(polygonArea(out)).toBeCloseTo(63, 3);
      for (const c of corners) {
        expect(Math.min(...out.map((p) => Math.hypot(p.x - c.x, p.y - c.y)))).toBeLessThan(1e-4);
      }
    });
  }

  it('sans sommets exacts, reste à moins de 2 % de la surface et ne garde que les vrais angles', () => {
    const corners = rotated(25, 9, 7, 3.137, 2.412);
    const grid = makeGrid({ minX: 0, minY: 0, maxX: 12, maxY: 13 }, 0.025, 1e7);
    const occ = new Uint8Array(grid.nx * grid.ny);
    rasterizeOccupancy(grid, new Float32Array(quad4(corners)), occ);
    const pieces = labelPieces(grid, occ, 10);
    const out = cleanOutline(toRing(traceOuterBoundary(grid, pieces.labels, 1)), grid.cell, null);
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(out.length).toBeLessThanOrEqual(8);
    expect(Math.abs(polygonArea(out) - 63) / 63).toBeLessThan(0.02);
  });
});
