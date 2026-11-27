import { describe, expect, it } from 'vitest';
import type { Opening, Vec2 } from '../../../src/core/types';
import { DEFAULT_SIZE, OPENING_LIMITS, QUICK_SIZES, checkOpening, isBlocking, openingMark, openingTotals } from '../../../src/ui/plan/openings';

const RECT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 1000, y: 0 },
  { x: 1000, y: 600 },
  { x: 0, y: 600 },
];

describe('ouvertures', () => {
  it('tailles rapides : croissantes, plausibles, et les valeurs par défaut en font partie', () => {
    for (const kind of ['window', 'door'] as const) {
      const { widths, heights } = QUICK_SIZES[kind];
      for (const list of [widths, heights]) {
        expect([...list].sort((a, b) => a - b)).toEqual([...list]);
        expect(new Set(list).size).toBe(list.length);
      }
      expect(widths).toContain(DEFAULT_SIZE[kind].width);
      expect(heights).toContain(DEFAULT_SIZE[kind].height);
      expect(checkOpening({ kind, width: DEFAULT_SIZE[kind].width, height: DEFAULT_SIZE[kind].height, count: 1 }, 10)).toEqual([]);
    }
  });

  it('contrôle : largeur, hauteur et nombre bloquent ; « plus large que la façade » avertit seulement', () => {
    expect(checkOpening({ kind: 'window', width: null, height: 1.35, count: 1 }, 5)).toEqual(['width']);
    expect(checkOpening({ kind: 'window', width: 1.2, height: null, count: 1 }, 5)).toEqual(['height']);
    expect(checkOpening({ kind: 'window', width: 0.05, height: 9, count: 0 }, 5)).toEqual(['width', 'height', 'count']);
    expect(checkOpening({ kind: 'window', width: 1.2, height: 1.35, count: 1.5 }, 5)).toEqual(['count']);
    expect(checkOpening({ kind: 'window', width: 1.2, height: 1.35, count: OPENING_LIMITS.maxCount + 1 }, null)).toEqual(['count']);
    // Une saisie « 120 » non convertie (120 m) est refusée.
    expect(isBlocking(checkOpening({ kind: 'window', width: 120, height: 1.35, count: 1 }, null))).toBe(true);

    const wide = checkOpening({ kind: 'window', width: 2, height: 1.35, count: 3 }, 5);
    expect(wide).toEqual(['widerThanEdge']);
    expect(isBlocking(wide)).toBe(false);
    expect(checkOpening({ kind: 'window', width: 2.5, height: 1.35, count: 2 }, 5)).toEqual([]);
    // Longueur de façade inconnue (échelle non confirmée) : pas d'avertissement possible.
    expect(checkOpening({ kind: 'window', width: 2, height: 1.35, count: 3 }, null)).toEqual([]);
  });

  it('marque à l’échelle, centrée sur la position, le long de l’arête', () => {
    // 1 unité = 1 cm : une fenêtre de 1,20 m fait 120 unités.
    const mark = openingMark(RECT, { edgeIndex: 0, position: 0.5, width: 1.2 }, 0.01)!;
    expect(mark.a).toEqual({ x: 440, y: 0 });
    expect(mark.b).toEqual({ x: 560, y: 0 });
    expect(mark.centre).toEqual({ x: 500, y: 0 });
    expect(mark.dir).toEqual({ x: 1, y: 0 });
    // Arête de droite (vers le bas).
    const side = openingMark(RECT, { edgeIndex: 1, position: 0.25, width: 1 }, 0.01)!;
    expect(side.centre).toEqual({ x: 1000, y: 150 });
    expect(side.a.y).toBeCloseTo(100, 9);
    expect(side.b.y).toBeCloseTo(200, 9);
  });

  it('marque ramenée dans l’arête ; jamais plus longue qu’elle', () => {
    const start = openingMark(RECT, { edgeIndex: 0, position: 0, width: 1.2 }, 0.01)!;
    expect(start.a).toEqual({ x: 0, y: 0 });
    expect(start.b).toEqual({ x: 120, y: 0 });
    const end = openingMark(RECT, { edgeIndex: 0, position: 1.7, width: 1.2 }, 0.01)!;
    expect(end.b).toEqual({ x: 1000, y: 0 });
    const huge = openingMark(RECT, { edgeIndex: 3, position: 0.5, width: 50 }, 0.01)!;
    expect(Math.hypot(huge.b.x - huge.a.x, huge.b.y - huge.a.y)).toBeCloseTo(600, 9);
  });

  it('marque impossible : arête inconnue ou dégénérée', () => {
    expect(openingMark(RECT, { edgeIndex: 9, position: 0.5, width: 1 }, 0.01)).toBeNull();
    expect(openingMark(RECT, { edgeIndex: -1, position: 0.5, width: 1 }, 0.01)).toBeNull();
    expect(openingMark([{ x: 1, y: 1 }, { x: 1, y: 1 }], { edgeIndex: 0, position: 0.5, width: 1 }, 0.01)).toBeNull();
    // Échelle nulle : marque réduite à un point, mais pas d'erreur.
    const dot = openingMark(RECT, { edgeIndex: 0, position: 0.5, width: 1 }, 0)!;
    expect(dot.a).toEqual(dot.b);
  });

  it('totaux par type : surface et nombre, « count » compris', () => {
    const base = { edgeIndex: 0, position: 0.5, windowTypeId: null, from: 'user' as const };
    const list: Opening[] = [
      { ...base, id: 'a', kind: 'window', width: 1.2, height: 1.35, count: 2 },
      { ...base, id: 'b', kind: 'window', width: 2, height: 2.1, count: 1 },
      { ...base, id: 'c', kind: 'door', width: 1, height: 2.1, count: 1 },
    ];
    const w = openingTotals(list, 'window');
    expect(w.count).toBe(3);
    expect(w.area).toBeCloseTo(2 * 1.2 * 1.35 + 4.2, 9);
    expect(openingTotals(list, 'door')).toEqual({ area: 2.1, count: 1 });
    expect(openingTotals([], 'door')).toEqual({ area: 0, count: 0 });
  });
});
