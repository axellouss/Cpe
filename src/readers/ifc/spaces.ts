/**
 * Géométrie d'un local (IfcSpace) à partir de son maillage : contour du sol, surface au sol, surface « utile »
 * (hauteur libre ≥ 1,0 m, règle de la surface de référence An) et hauteur libre moyenne.
 *
 * La surface au sol est la somme EXACTE des triangles du sol ; la part sous faible hauteur (rampants) est
 * mesurée sur un champ de hauteurs tramé du volume. Un local prismatique (cas courant) ne passe pas par la trame.
 * Fonctions pures ; repère IFC (x à droite, y vers le haut, z vertical), mètres.
 */
import type { Vec2 } from '../../core/types';
import { PointIndex, cleanOutline, dropCollinear } from './outline';
import { labelPieces, makeGrid, rasterizeHeights, rasterizeOccupancy, traceOuterBoundary, type Grid } from './raster';

export interface RoomGeometry {
  zMin: number;
  zMax: number;
  /** Surface du sol en plan (m²). */
  floorArea: number;
  /** Part de cette surface où la hauteur libre atteint `minClearHeight` (m²). */
  usableArea: number;
  /** Hauteur libre moyenne sur la partie utile (m). */
  meanHeight: number;
  /** Vrai si le plafond n'est pas partout à la même hauteur (rampants, décrochements). */
  sloped: boolean;
  /** Contour du sol (le plus grand anneau), ou null s'il n'a pas pu être reconstitué. */
  polygon: Vec2[] | null;
  /** Point où poser l'étiquette. */
  at: Vec2;
}

const Z_TOL = 0.02;
const WELD = 2000; // 1 / 0,5 mm

function ringArea(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function insideRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Anneaux formés par les arêtes de bord (vues une seule fois) d'un ensemble de triangles plans. */
function boundaryRings(tris: readonly number[], soup: Float32Array): Vec2[][] {
  const vertexOf = new Map<number, number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const weld = (x: number, y: number): number => {
    const key = Math.round(x * WELD) * 33554432 + Math.round(y * WELD);
    let v = vertexOf.get(key);
    if (v === undefined) {
      v = xs.length;
      xs.push(x);
      ys.push(y);
      vertexOf.set(key, v);
    }
    return v;
  };
  const edgeCount = new Map<number, number>();
  const edges: [number, number][] = [];
  const BIG = 4194304;
  for (const t of tris) {
    const a = weld(soup[t]!, soup[t + 1]!);
    const b = weld(soup[t + 3]!, soup[t + 4]!);
    const c = weld(soup[t + 6]!, soup[t + 7]!);
    if (a === b || b === c || c === a) continue;
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      const key = Math.min(u, v) * BIG + Math.max(u, v);
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      edges.push([u, v]);
    }
  }
  const neighbours = new Map<number, number[]>();
  for (const [u, v] of edges) {
    if (edgeCount.get(Math.min(u, v) * BIG + Math.max(u, v)) !== 1) continue;
    (neighbours.get(u) ?? neighbours.set(u, []).get(u)!).push(v);
    (neighbours.get(v) ?? neighbours.set(v, []).get(v)!).push(u);
  }
  const used = new Set<number>();
  const rings: Vec2[][] = [];
  for (const start of neighbours.keys()) {
    for (const first of neighbours.get(start) ?? []) {
      if (used.has(Math.min(start, first) * BIG + Math.max(start, first))) continue;
      const ring: Vec2[] = [{ x: xs[start]!, y: ys[start]! }];
      let prev = start;
      let cur = first;
      used.add(Math.min(prev, cur) * BIG + Math.max(prev, cur));
      let closed = false;
      for (let guard = 0; guard < edges.length + 4; guard++) {
        if (cur === start) {
          closed = true;
          break;
        }
        ring.push({ x: xs[cur]!, y: ys[cur]! });
        let next = -1;
        for (const cand of neighbours.get(cur) ?? []) {
          if (cand === prev) continue;
          const key = Math.min(cur, cand) * BIG + Math.max(cur, cand);
          if (used.has(key)) continue;
          next = cand;
          used.add(key);
          break;
        }
        if (next < 0) break;
        prev = cur;
        cur = next;
      }
      if (closed && ring.length >= 3) rings.push(ring);
    }
  }
  return rings;
}

function localGrid(soup: Float32Array, maxCells: number): Grid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 2 < soup.length; i += 3) {
    const x = soup[i]!;
    const y = soup[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return makeGrid({ minX, minY, maxX, maxY }, 0.025, maxCells, 0.1);
}

/**
 * Mesure un local à partir de sa soupe de triangles ([x, y, z] × 3 par triangle). null si le maillage est vide.
 * @param minClearHeight hauteur libre minimale pour qu'une surface compte (1,0 m pour An)
 */
export function roomGeometry(soup: Float32Array, minClearHeight = 1.0): RoomGeometry | null {
  if (soup.length < 9) return null;
  let zMin = Infinity;
  let zMax = -Infinity;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i + 2 < soup.length; i += 3) {
    const z = soup[i + 2]!;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    sumX += soup[i]!;
    sumY += soup[i + 1]!;
  }
  const count = soup.length / 3;
  const height = zMax - zMin;

  // Tri des triangles : sol (horizontal, tout en bas), plafond plat (horizontal, tout en haut), vertical, autre.
  const floor: number[] = [];
  let floorArea = 0;
  let otherArea = 0;
  let totalArea = 0;
  let biggest = -1;
  let biggestArea = 0;
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const ux = soup[t + 3]! - soup[t]!;
    const uy = soup[t + 4]! - soup[t + 1]!;
    const uz = soup[t + 5]! - soup[t + 2]!;
    const vx = soup[t + 6]! - soup[t]!;
    const vy = soup[t + 7]! - soup[t + 1]!;
    const vz = soup[t + 8]! - soup[t + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) continue;
    const area = l / 2;
    totalArea += area;
    const vertical = Math.abs(nz) / l;
    const zc = (soup[t + 2]! + soup[t + 5]! + soup[t + 8]!) / 3;
    if (vertical > 0.999) {
      if (zc <= zMin + Z_TOL) {
        floor.push(t);
        const plan = Math.abs(nz) / 2;
        floorArea += plan;
        if (plan > biggestArea) {
          biggestArea = plan;
          biggest = t;
        }
      } else if (zc < zMax - Z_TOL) {
        otherArea += area; // palier, décrochement de plafond
      }
    } else if (vertical > 0.02) {
      otherArea += area; // rampant
    }
  }
  const prismatic = floorArea > 0.01 && otherArea <= 0.005 * totalArea;

  // Contour du sol.
  let polygon: Vec2[] | null = null;
  if (floor.length > 0) {
    const rings = boundaryRings(floor, soup);
    let best: Vec2[] | null = null;
    let bestArea = 0;
    let holes = 0;
    for (const r of rings) {
      const a = Math.abs(ringArea(r));
      if (a > bestArea) {
        if (best) holes += bestArea;
        best = r;
        bestArea = a;
      } else {
        holes += a;
      }
    }
    // Le plus grand anneau, diminué des autres (poteaux, trémies), doit redonner la surface des triangles.
    if (best && Math.abs(bestArea - holes - floorArea) <= 0.02 * floorArea + 0.05) {
      const cleaned = dropCollinear(best, 0.001);
      if (cleaned.length >= 3) polygon = cleaned;
    }
  }

  let usableArea = floorArea;
  let meanHeight = height;
  if (!prismatic || polygon === null) {
    const grid = localGrid(soup, 400_000);
    const n = grid.nx * grid.ny;
    if (!prismatic) {
      const top = new Float32Array(n).fill(-Infinity);
      const bottom = new Float32Array(n).fill(Infinity);
      rasterizeHeights(grid, soup, top, bottom);
      let covered = 0;
      let usable = 0;
      let sumH = 0;
      for (let c = 0; c < n; c++) {
        const tc = top[c]!;
        if (tc === -Infinity) continue;
        covered++;
        const h = tc - bottom[c]!;
        if (h >= minClearHeight) {
          usable++;
          sumH += h;
        }
      }
      if (floorArea <= 0.01) floorArea = covered * grid.cell * grid.cell;
      usableArea = covered > 0 ? (floorArea * usable) / covered : 0;
      meanHeight = usable > 0 ? sumH / usable : height;
    } else if (height < minClearHeight) {
      usableArea = 0;
    }
    if (polygon === null) {
      // Contour par la trame, raccroché aux sommets du maillage.
      const occ = new Uint8Array(n);
      rasterizeOccupancy(grid, soup, occ);
      const pieces = labelPieces(grid, occ, 4);
      if (pieces.cells.length > 0) {
        const stair = traceOuterBoundary(grid, pieces.labels, 1);
        const ring: Vec2[] = [];
        for (let i = 0; i + 1 < stair.length; i += 2) ring.push({ x: stair[i]!, y: stair[i + 1]! });
        const exact = new PointIndex(3 * grid.cell, grid.minX, grid.minY);
        exact.addSoup(soup);
        const cleaned = cleanOutline(ring, grid.cell, exact);
        if (cleaned.length >= 3) polygon = cleaned;
      }
    }
  } else if (height < minClearHeight) {
    usableArea = 0;
  }

  // Point d'étiquette : centre de gravité du contour s'il est dedans, sinon centre du plus grand triangle du sol.
  let at: Vec2 = { x: sumX / count, y: sumY / count };
  if (polygon) {
    const a = ringArea(polygon);
    if (Math.abs(a) > 1e-9) {
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i]!;
        const q = polygon[(i + 1) % polygon.length]!;
        const f = p.x * q.y - q.x * p.y;
        cx += (p.x + q.x) * f;
        cy += (p.y + q.y) * f;
      }
      const c = { x: cx / (6 * a), y: cy / (6 * a) };
      if (insideRing(c, polygon)) at = c;
      else if (biggest >= 0) {
        at = {
          x: (soup[biggest]! + soup[biggest + 3]! + soup[biggest + 6]!) / 3,
          y: (soup[biggest + 1]! + soup[biggest + 4]! + soup[biggest + 7]!) / 3,
        };
      }
    }
  }

  return { zMin, zMax, floorArea, usableArea, meanHeight, sloped: !prismatic, polygon, at };
}
