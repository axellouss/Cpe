import { describe, expect, it } from 'vitest';
import {
  buildSnapIndex,
  coverage,
  crossingsNear,
  forEachSegmentInBBox,
  nearestEndpoint,
  nearestIntersection,
  nearestLineCrossing,
  nearestOnSegment,
  segmentIntersection,
  segmentsNear,
  snapCandidates,
} from '../../../src/ui/plan/snapIndex';

/** Carré 0..100 + une diagonale + un trait isolé loin. */
function sample(): Float32Array {
  return new Float32Array([
    0, 0, 100, 0, // 0 haut
    100, 0, 100, 100, // 1 droite
    100, 100, 0, 100, // 2 bas
    0, 100, 0, 0, // 3 gauche
    0, 0, 100, 100, // 4 diagonale
    500, 500, 520, 500, // 5 isolé
  ]);
}

function collect(index: ReturnType<typeof buildSnapIndex>, box: { minX: number; minY: number; maxX: number; maxY: number }): number[] {
  const out: number[] = [];
  forEachSegmentInBBox(index, box, (i) => out.push(i));
  return out.sort((a, b) => a - b);
}

describe('index spatial des traits', () => {
  it('range chaque trait dans toutes les cases qu’il traverse (pas de trou sur une diagonale)', () => {
    const index = buildSnapIndex(sample(), { perCell: 0.05 }); // grille fine : la diagonale traverse beaucoup de cases
    expect(index.cols * index.rows).toBeGreaterThan(50);
    // Tout point de la diagonale doit retrouver le trait 4 par une requête minuscule.
    for (let t = 0; t <= 1.0001; t += 0.037) {
      const p = { x: 100 * t, y: 100 * t };
      const found = collect(index, { minX: p.x - 0.01, minY: p.y - 0.01, maxX: p.x + 0.01, maxY: p.y + 0.01 });
      expect(found).toContain(4);
    }
  });

  it('ne rend chaque trait qu’une fois, même s’il occupe plusieurs cases', () => {
    const index = buildSnapIndex(sample(), { perCell: 0.05 });
    const all = collect(index, { minX: -10, minY: -10, maxX: 600, maxY: 600 });
    expect(all).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('requête hors de l’étendue : rien', () => {
    const index = buildSnapIndex(sample());
    expect(collect(index, { minX: 1000, minY: 1000, maxX: 1100, maxY: 1100 })).toEqual([]);
  });

  it('ignore les traits non finis et supporte un tableau vide', () => {
    const empty = buildSnapIndex(new Float32Array());
    expect(empty.count).toBe(0);
    expect(nearestEndpoint(empty, { x: 0, y: 0 }, 10)).toBeNull();
    const dirty = buildSnapIndex(new Float32Array([0, 0, 10, 0, NaN, 0, 5, 5, 0, 10, 10, 10]));
    expect(collect(dirty, { minX: -1, minY: -1, maxX: 11, maxY: 11 })).toEqual([0, 2]);
  });

  it('extrémité la plus proche, dans le rayon seulement', () => {
    const index = buildSnapIndex(sample());
    const hit = nearestEndpoint(index, { x: 97, y: 4 }, 10);
    expect(hit?.point).toEqual({ x: 100, y: 0 });
    expect(hit?.distance).toBeCloseTo(5, 10);
    expect(nearestEndpoint(index, { x: 50, y: 30 }, 10)).toBeNull();
    expect(nearestEndpoint(index, { x: 505, y: 497 }, 10)?.point).toEqual({ x: 500, y: 500 });
  });

  it('point le plus proche sur un trait, et traits voisins triés par distance', () => {
    const index = buildSnapIndex(sample());
    const on = nearestOnSegment(index, { x: 40, y: 3 }, 5);
    expect(on?.segment).toBe(0);
    expect(on?.point).toEqual({ x: 40, y: 0 });
    const near = segmentsNear(index, { x: 3, y: 2 }, 6);
    expect(near.map((h) => h.segment)).toEqual([4, 0, 3]);
    expect(segmentsNear(index, { x: 3, y: 2 }, 6, 2)).toHaveLength(2);
  });

  it('intersection de deux segments : croisement, jonction en T, parallèles, disjoints', () => {
    expect(segmentIntersection(0, 0, 10, 10, 0, 10, 10, 0)).toEqual({ x: 5, y: 5 });
    // T : l'extrémité de l'un touche l'autre.
    expect(segmentIntersection(0, 0, 10, 0, 5, 0, 5, 8)).toEqual({ x: 5, y: 0 });
    expect(segmentIntersection(0, 0, 10, 0, 0, 1, 10, 1)).toBeNull();
    expect(segmentIntersection(0, 0, 10, 0, 20, -5, 20, 5)).toBeNull();
    expect(segmentIntersection(0, 0, 0, 0, 1, 1, 2, 2)).toBeNull();
  });

  it('croisement de traits le plus proche (les droites se croisent sans y avoir d’extrémité)', () => {
    const seg = new Float32Array([0, 50, 100, 50, 30, 0, 30, 100, 70, 0, 70, 100]);
    const index = buildSnapIndex(seg);
    expect(nearestIntersection(index, { x: 33, y: 46 }, 8)?.point).toEqual({ x: 30, y: 50 });
    expect(nearestIntersection(index, { x: 68, y: 52 }, 8)?.point).toEqual({ x: 70, y: 50 });
    expect(nearestIntersection(index, { x: 50, y: 20 }, 8)).toBeNull();
    // Un simple croisement n'est pas une « jonction » (aucune extrémité au point).
    expect(crossingsNear(index, { x: 33, y: 46 }, 8).junction).toBeNull();
  });

  it('jonction : angle de mur (deux extrémités) et jonction en T, distinguées d’un bout libre', () => {
    // Angle en (0,0), T en (50,0) (cloison qui arrive sur le mur), bout libre de la cloison en (50,40).
    const seg = new Float32Array([0, 0, 100, 0, 0, 0, 0, 80, 50, 0, 50, 40]);
    const index = buildSnapIndex(seg);
    expect(crossingsNear(index, { x: 3, y: 4 }, 10).junction?.point).toEqual({ x: 0, y: 0 });
    expect(crossingsNear(index, { x: 52, y: 5 }, 10).junction?.point).toEqual({ x: 50, y: 0 });
    expect(crossingsNear(index, { x: 51, y: 38 }, 5).junction).toBeNull();
  });

  it('candidats d’accrochage : chaque point une fois, classé jonction / bout libre / croisement, par distance', () => {
    // Angle de mur en (0,0) ; cloison en T sur le mur haut en (50,0), bout libre en (50,40) ;
    // un trait de cote croise la cloison en (50,20) sans s'y arrêter.
    const seg = new Float32Array([0, 0, 100, 0, 0, 0, 0, 80, 50, 0, 50, 40, 30, 20, 90, 20]);
    const index = buildSnapIndex(seg);
    const all = snapCandidates(index, { x: 45, y: 15 }, 60);
    const at = (x: number, y: number) => all.filter((c) => c.point.x === x && c.point.y === y);
    expect(at(0, 0).map((c) => c.kind)).toEqual(['junction']); // deux extrémités confondues = un seul candidat
    expect(at(50, 0).map((c) => c.kind)).toEqual(['junction']);
    expect(at(50, 40).map((c) => c.kind)).toEqual(['endpoint']);
    expect(at(30, 20).map((c) => c.kind)).toEqual(['endpoint']);
    expect(at(50, 20).map((c) => c.kind)).toEqual(['crossing']);
    const distances = all.map((c) => c.distance);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    expect(all[0]!.point).toEqual({ x: 50, y: 20 });
    // Rayon réduit : seuls les points réellement dans le rayon.
    expect(snapCandidates(index, { x: 49, y: 39 }, 3).map((c) => c.point)).toEqual([{ x: 50, y: 40 }]);
    expect(snapCandidates(index, { x: 500, y: 500 }, 5)).toEqual([]);
  });

  it('une jonction garde les coordonnées EXACTES de l’extrémité (pas celles, arrondies, de l’intersection)', () => {
    // Coordonnées « sales » comme en produisent les lecteurs (Float32).
    const seg = new Float32Array([0.1, 0.2, 733.3, 0.2, 733.3, 0.2, 733.3, 512.7]);
    const index = buildSnapIndex(seg);
    const j = snapCandidates(index, { x: 730, y: 3 }, 10).find((c) => c.kind === 'junction')!;
    expect(j.point.x).toBe(seg[2]);
    expect(j.point.y).toBe(seg[3]);
  });

  it('croisement d’un guide avec les traits voisins', () => {
    const index = buildSnapIndex(sample());
    // Guide horizontal y = 30 : coupe le bord gauche (0,30), la diagonale (30,30) et le bord droit (100,30).
    const dir = { x: 1, y: 0 };
    const origin = { x: -50, y: 30 };
    expect(nearestLineCrossing(index, origin, dir, { x: 27, y: 30 }, 8)?.point).toEqual({ x: 30, y: 30 });
    expect(nearestLineCrossing(index, origin, dir, { x: 96, y: 30 }, 8)?.point).toEqual({ x: 100, y: 30 });
    expect(nearestLineCrossing(index, origin, dir, { x: 60, y: 30 }, 8)).toBeNull();
    // Un trait parallèle au guide n'est pas un croisement.
    expect(nearestLineCrossing(index, { x: 0, y: 0 }, dir, { x: 50, y: 0 }, 5)).toBeNull();
  });

  it('couverture d’un rectangle visible', () => {
    const index = buildSnapIndex(new Float32Array([0, 0, 100, 0, 0, 0, 0, 100, 100, 100, 0, 100]));
    expect(coverage(index, { minX: -10, minY: -10, maxX: 200, maxY: 200 })).toBeCloseTo(1, 10);
    expect(coverage(index, { minX: 0, minY: 0, maxX: 50, maxY: 50 })).toBeCloseTo(0.25, 10);
    expect(coverage(index, { minX: 300, minY: 0, maxX: 400, maxY: 50 })).toBe(0);
  });

  it('tient la charge : 150 000 traits, mêmes résultats qu’une recherche exhaustive', () => {
    const n = 150000;
    const seg = new Float32Array(n * 4);
    let a = 12345;
    const rnd = (): number => {
      a = (a * 1664525 + 1013904223) >>> 0;
      return a / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      const x = rnd() * 5000;
      const y = rnd() * 3500;
      seg[i * 4] = x;
      seg[i * 4 + 1] = y;
      seg[i * 4 + 2] = x + (rnd() - 0.5) * 60;
      seg[i * 4 + 3] = y + (rnd() - 0.5) * 60;
    }
    const t0 = performance.now();
    const index = buildSnapIndex(seg);
    const buildMs = performance.now() - t0;
    expect(index.count).toBe(n);
    expect(index.cols).toBeLessThanOrEqual(512);
    expect(index.rows).toBeLessThanOrEqual(512);
    // Large marge pour une machine chargée ; l'ordre de grandeur réel est de quelques dizaines de ms.
    expect(buildMs).toBeLessThan(3000);

    for (let k = 0; k < 40; k++) {
      const p = { x: rnd() * 5000, y: rnd() * 3500 };
      const radius = 12;
      let best = Infinity;
      for (let i = 0; i < n * 4; i += 2) {
        const d = Math.hypot(seg[i]! - p.x, seg[i + 1]! - p.y);
        if (d < best) best = d;
      }
      const hit = nearestEndpoint(index, p, radius);
      if (best <= radius) expect(hit?.distance).toBeCloseTo(best, 4);
      else expect(hit).toBeNull();
    }
    const t1 = performance.now();
    for (let k = 0; k < 200; k++) {
      const p = { x: rnd() * 5000, y: rnd() * 3500 };
      nearestEndpoint(index, p, 12);
      crossingsNear(index, p, 12);
    }
    expect((performance.now() - t1) / 200).toBeLessThan(10); // ms par mouvement de souris
  });
});
