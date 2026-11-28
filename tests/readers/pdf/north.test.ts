/**
 * Flèche du nord : cercle + forme pleine décentrée, par les remplissages de l'extraction (RawPage.fills) ou par les
 * traits marqués `fill` regroupés par tracé ; repli sans cercle ; marge au secteur. Symboles inventés.
 */
import { describe, expect, it } from 'vitest';
import type { FillArea, RawPage, RawSeg } from '../../../src/readers/pdf/raw';
import { filledPolygons, fitCircle, readNorth, readNorthDetailed, sectorMargin, sectorOf, sideAzimuth } from '../../../src/readers/pdf/north';
import { mk } from '../../semantics/lines';
import { page, seg } from './helpers';

type Pt = [number, number];
const C: Pt = [500, 300];
const R = 20;

/** Cercle tracé en 32 petits traits (comme une courbe discrétisée par l'extraction). */
function circle(c: Pt = C, r = R): RawSeg[] {
  const out: RawSeg[] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * 2 * Math.PI;
    const b = ((i + 1) / 32) * 2 * Math.PI;
    out.push(seg(c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[0] + r * Math.cos(b), c[1] + r * Math.sin(b), 0.5, { curve: true, pid: 1 }));
  }
  return out;
}

/** Direction sur la feuille d'un angle horaire depuis le haut. */
function dirOf(cwFromUp: number): Pt {
  const a = (cwFromUp * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}

/** Triangle plein dont la pointe (à 1,15 r, hors du cercle) regarde le nord. */
function triangle(cwFromUp: number): Pt[] {
  const d = dirOf(cwFromUp);
  const n: Pt = [-d[1], d[0]];
  const base: Pt = [C[0] + d[0] * R * 0.45, C[1] + d[1] * R * 0.45];
  return [[C[0] + d[0] * R * 1.15, C[1] + d[1] * R * 1.15], [base[0] + n[0] * R * 0.28, base[1] + n[1] * R * 0.28], [base[0] - n[0] * R * 0.28, base[1] - n[1] * R * 0.28]];
}

/** Demi-barre pleine : un rectangle mince du centre vers le nord (forme allongée). */
function halfBar(cwFromUp: number): Pt[] {
  const d = dirOf(cwFromUp);
  const n: Pt = [-d[1] * 1.2, d[0] * 1.2];
  const tip: Pt = [C[0] + d[0] * R * 0.95, C[1] + d[1] * R * 0.95];
  return [[C[0] + n[0], C[1] + n[1]], [tip[0] + n[0], tip[1] + n[1]], [tip[0] - n[0], tip[1] - n[1]], [C[0] - n[0], C[1] - n[1]]];
}

function asFillSegs(poly: readonly Pt[], pid: number): RawSeg[] {
  return poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length]!;
    return { ...seg(p[0], p[1], q[0], q[1], 0), stroke: false, fill: true, pid };
  });
}

function asFill(poly: readonly Pt[]): FillArea {
  return { rings: [poly.map((p) => [p[0], p[1]] as [number, number])], bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, color: 0, alpha: 1, clip: 0, stroked: false, area: 0 };
}

function northPage(segs: RawSeg[], fills: FillArea[] = [], label = 'NORD'): RawPage {
  const p = page(segs, [mk(label, C[0] - 10, C[1] - R - 6, 7)]);
  p.fills = fills;
  return p;
}

describe('secteurs', () => {
  it('8 secteurs de 45°, marge à la limite la plus proche', () => {
    expect(sectorOf(0)).toBe('N');
    expect(sectorOf(95)).toBe('E');
    expect(sectorOf(250)).toBe('W');
    expect(sectorMargin(0)).toBe(22.5);
    expect(sectorMargin(250)).toBeCloseTo(2.5, 6);
    expect(sideAzimuth(250, 'right')).toBe(340);
  });
  it('fitCircle retrouve centre et rayon', () => {
    const pts = circle().map((s) => [s.x0, s.y0] as Pt);
    const f = fitCircle(pts)!;
    expect(f.cx).toBeCloseTo(C[0], 6);
    expect(f.r).toBeCloseTo(R, 6);
  });
});

describe('readNorth', () => {
  it('triangle plein reconstitué depuis les traits « fill » : nord à 30° à droite du haut → haut = 330°', () => {
    const p = northPage([...circle(), ...asFillSegs(triangle(30), 7)]);
    expect(p.fills).toEqual([]);
    const r = readNorthDetailed(p)!;
    expect(r.north.sheetUpAzimuth).toBeCloseTo(330, 0);
    expect(r.north.marginDeg).toBeCloseTo(7.5, 0);
    expect(r.north.confidence).toBeGreaterThanOrEqual(0.85);
    expect(r.doubt).toBeNull();
    expect(r.north.evidence.map((e) => e.source)).toEqual(['north-label', 'north-circle', 'north-filled-shape']);
  });

  it('les mêmes formes fournies en RawPage.fills donnent la même lecture', () => {
    const viaFills = readNorth(northPage(circle(), [asFill(triangle(30))]))!;
    expect(viaFills.sheetUpAzimuth).toBeCloseTo(330, 0);
  });

  it('anneau fermé (premier point répété) : les remplissages et les traits donnent exactement le même azimut', () => {
    for (const [shape, pid] of [[triangle(30), 4], [halfBar(100), 5], [halfBar(212), 6]] as const) {
      const closed = [...shape, shape[0]!];
      const viaFills = readNorth(northPage(circle(), [asFill(closed)]))!;
      const viaSegs = readNorth(northPage([...circle(), ...asFillSegs(shape, pid)]))!;
      expect(viaFills.sheetUpAzimuth).toBeCloseTo(viaSegs.sheetUpAzimuth, 6);
      expect(viaFills.marginDeg).toBeCloseTo(viaSegs.marginDeg, 6);
    }
  });

  it('demi-barre allongée (axe principal), nord vers la droite et un peu vers le bas', () => {
    const n = readNorth(northPage([...circle(), ...asFillSegs(halfBar(100), 3)]))!;
    expect(n.sheetUpAzimuth).toBeCloseTo(260, 0);
  });

  it('près d’une limite de secteur : confiance basse et question', () => {
    const r = readNorthDetailed(northPage([...circle(), ...asFillSegs(triangle(110), 3)]), { lang: 'de' })!;
    expect(r.north.sheetUpAzimuth).toBeCloseTo(250, 0);
    expect(r.north.confidence).toBeLessThan(0.65);
    expect(r.doubt).toMatch(/Sektorgrenze/);
  });

  it('un diamètre plein symétrique ne donne pas de sens', () => {
    const bar: Pt[] = [[C[0] - 1, C[1] - R], [C[0] + 1, C[1] - R], [C[0] + 1, C[1] + R], [C[0] - 1, C[1] + R]];
    expect(readNorth(northPage([...circle(), ...asFillSegs(bar, 3)]))).toBeNull();
  });

  it('repli : flèche pleine sans cercle, orientée vers le mot « NORD »', () => {
    const arrow: Pt[] = [[C[0], C[1] - 14], [C[0] + 3, C[1] + 6], [C[0] - 3, C[1] + 6]];
    const r = readNorthDetailed(northPage(asFillSegs(arrow, 3)))!;
    expect(r.north.sheetUpAzimuth).toBeCloseTo(0, 0);
    expect(r.north.confidence).toBe(0.5);
    expect(r.doubt).toMatch(/sans cercle/);
  });

  it('pas de texte « nord » : rien', () => {
    expect(readNorth(northPage([...circle(), ...asFillSegs(triangle(30), 3)], [], 'NOTE'))).toBeNull();
  });

  it('filledPolygons coupe un tracé en anneaux à chaque discontinuité', () => {
    const a = asFillSegs([[0, 0], [10, 0], [10, 10]], 5);
    const b = asFillSegs([[50, 50], [60, 50], [60, 60], [50, 60]], 5);
    expect(filledPolygons({ fills: [], segs: [...a, ...b] }).map((r) => r.length)).toEqual([3, 4]);
  });
});
