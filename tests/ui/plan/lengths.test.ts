/**
 * Longueur exacte d'un côté (ux-04) : le premier sommet du côté reste en place, le suivant glisse le long du côté ;
 * dans un contour fermé le mur d'après glisse avec lui pour que les angles tiennent. Arêtes et ouvertures restent
 * attachées.
 */
import { describe, expect, it } from 'vitest';
import { edgeLength, polygonArea } from '../../../src/core/geometry';
import type { Opening, Storey, Vec2 } from '../../../src/core/types';
import { resizeSide, setEdgeLength } from '../../../src/ui/plan/outlineOps';
import { isRightAngle } from '../../../src/ui/plan/snapping';
import { parseSideLength } from '../../../src/ui/plan/tools/OutlineTool';

/** Rectangle 10 × 8 (sens horaire à l'écran) : côtés 0 = haut, 1 = droite, 2 = bas, 3 = gauche. */
const RECT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 8 },
  { x: 0, y: 8 },
];

/** Maison en L : 13,5 × 8,5 avec une encoche en bas à droite. */
const L_SHAPE: Vec2[] = [
  { x: 0, y: 0 },
  { x: 13.5, y: 0 },
  { x: 13.5, y: 5 },
  { x: 8, y: 5 },
  { x: 8, y: 8.5 },
  { x: 0, y: 8.5 },
];

function close(a: Vec2, b: Vec2): void {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
}

function allRightAngles(points: readonly Vec2[]): boolean {
  const n = points.length;
  return points.every((p, i) => isRightAngle(points[(i - 1 + n) % n]!, p, points[(i + 1) % n]!));
}

function storey(outline: Vec2[], partial: Partial<Storey> = {}): Storey {
  return {
    id: 's1',
    name: 'Rez-de-chaussée',
    sheetId: null,
    outline: outline.map((p) => ({ ...p })),
    edges: outline.map(() => ({ boundary: 'outside', constructionId: null })),
    metresPerUnit: { value: 1, from: 'user' },
    grossHeight: { value: 2.8, from: 'default' },
    clearHeight: { value: 2.5, from: 'default' },
    openings: [],
    rooms: [],
    netAreaOverride: null,
    ...partial,
  };
}

describe('resizeSide — contour fermé', () => {
  it('rectangle : le sommet suivant glisse le long du côté et le côté d’après le suit — tout reste d’équerre', () => {
    const out = resizeSide(RECT, 0, 9.24, true)!;
    close(out[0]!, { x: 0, y: 0 });
    close(out[1]!, { x: 9.24, y: 0 });
    close(out[2]!, { x: 9.24, y: 8 });
    close(out[3]!, { x: 0, y: 8 });
    expect(allRightAngles(out)).toBe(true);
    expect(edgeLength(out, 2)).toBeCloseTo(9.24, 9);
  });

  it('deux saisies suffisent pour une maison de 9,24 × 11,37 m tracée « à peu près »', () => {
    const first = resizeSide(RECT, 0, 9.24, true)!;
    const second = resizeSide(first, 1, 11.37, true)!;
    expect(second.map((p) => [Number(p.x.toFixed(9)), Number(p.y.toFixed(9))])).toEqual([
      [0, 0],
      [9.24, 0],
      [9.24, 11.37],
      [0, 11.37],
    ]);
    expect(polygonArea(second)).toBeCloseTo(9.24 * 11.37, 9);
  });

  it('le premier sommet du côté ne bouge jamais, quel que soit le côté', () => {
    for (let i = 0; i < 4; i++) {
      const out = resizeSide(RECT, i, 3.3, true)!;
      close(out[i]!, RECT[i]!);
      expect(edgeLength(out, i)).toBeCloseTo(3.3, 9);
      expect(allRightAngles(out)).toBe(true);
    }
  });

  it('maison en L : seuls le sommet suivant et le bout du mur d’après bougent', () => {
    const out = resizeSide(L_SHAPE, 0, 12, true)!;
    close(out[1]!, { x: 12, y: 0 });
    close(out[2]!, { x: 12, y: 5 });
    for (const i of [0, 3, 4, 5]) close(out[i]!, L_SHAPE[i]!);
    expect(allRightAngles(out)).toBe(true);
    expect(edgeLength(out, 2)).toBeCloseTo(4, 9);
  });

  it('mur coupé en deux (sommet aligné) : les deux moitiés glissent ensemble, proportions gardées', () => {
    // Le mur de droite est coupé à mi-hauteur (extérieur en haut, mitoyen en bas).
    const split: Vec2[] = [RECT[0]!, RECT[1]!, { x: 10, y: 4 }, RECT[2]!, RECT[3]!];
    const out = resizeSide(split, 0, 12, true)!;
    close(out[1]!, { x: 12, y: 0 });
    close(out[2]!, { x: 12, y: 4 });
    close(out[3]!, { x: 12, y: 8 });
    close(out[4]!, { x: 0, y: 8 });
  });

  it('sommet aligné sur son propre mur : il glisse seul, et ne dépasse pas le sommet suivant', () => {
    const split: Vec2[] = [RECT[0]!, { x: 4, y: 0 }, RECT[1]!, RECT[2]!, RECT[3]!];
    const out = resizeSide(split, 0, 6.5, true)!;
    close(out[1]!, { x: 6.5, y: 0 });
    for (const i of [0, 2, 3, 4]) close(out[i]!, split[i]!);
    expect(resizeSide(split, 0, 10, true)).toBeNull();
    expect(resizeSide(split, 0, 12, true)).toBeNull();
  });

  it('trapèze : le côté suivant reste parallèle à lui-même, son bout suit la droite du côté d’après', () => {
    const trapeze: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 6 },
      { x: 0, y: 10 },
    ];
    const out = resizeSide(trapeze, 0, 5, true)!;
    close(out[1]!, { x: 5, y: 0 });
    // (5, y) sur la droite (0,10) → (10,6) : y = 10 − 0,4 × 5.
    close(out[2]!, { x: 5, y: 8 });
    close(out[3]!, { x: 0, y: 10 });
  });

  it('triangle : pas de côté à faire glisser, seul le sommet bouge', () => {
    const tri: Vec2[] = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 0, y: 4 },
    ];
    const out = resizeSide(tri, 0, 9, true)!;
    close(out[1]!, { x: 9, y: 0 });
    close(out[2]!, { x: 0, y: 4 });
  });

  it('refuse ce qui replierait le contour ou n’a pas de sens', () => {
    // Raccourcir le haut de ce trapèze au-delà du point de croisement inverserait le côté de droite.
    const narrow: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 4, y: 6 },
      { x: 0, y: 6 },
    ];
    expect(resizeSide(narrow, 0, 3, true)).toBeNull();
    expect(resizeSide(narrow, 0, 8, true)).not.toBeNull();
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) expect(resizeSide(RECT, 0, bad, true)).toBeNull();
    expect(resizeSide(RECT, 4, 5, true)).toBeNull();
    expect(resizeSide(RECT, -1, 5, true)).toBeNull();
    expect(resizeSide(RECT.slice(0, 2), 0, 5, true)).toBeNull();
    expect(resizeSide([RECT[0]!, RECT[0]!, RECT[2]!, RECT[3]!], 0, 5, true)).toBeNull();
  });

  it('ne modifie pas le tableau reçu', () => {
    const before = JSON.stringify(RECT);
    resizeSide(RECT, 0, 9.24, true);
    expect(JSON.stringify(RECT)).toBe(before);
  });
});

describe('resizeSide — tracé ouvert', () => {
  it('le point suivant glisse, la suite du tracé est décalée d’autant', () => {
    const path: Vec2[] = [
      { x: 0, y: 0 },
      { x: 9, y: 0 },
      { x: 9, y: 11 },
    ];
    const out = resizeSide(path, 0, 9.24, false)!;
    close(out[1]!, { x: 9.24, y: 0 });
    close(out[2]!, { x: 9.24, y: 11 });
    const last = resizeSide(out, 1, 11.37, false)!;
    close(last[2]!, { x: 9.24, y: 11.37 });
    // Pas de côté de fermeture dans un tracé ouvert.
    expect(resizeSide(path, 2, 5, false)).toBeNull();
  });
});

describe('setEdgeLength', () => {
  const opening = (id: string, edgeIndex: number, position: number): Opening => ({
    id,
    edgeIndex,
    kind: 'window',
    width: 1.2,
    height: 1.35,
    count: 1,
    position,
    windowTypeId: null,
    from: 'plan',
  });

  it('les façades gardent ce qu’il y a derrière elles et leurs ouvertures', () => {
    const base = storey(RECT, {
      edges: [
        { boundary: 'outside', constructionId: 'mur-1' },
        { boundary: 'heated', constructionId: null },
        { boundary: 'ground', constructionId: null },
        { boundary: 'unheated', constructionId: null },
      ],
      openings: [opening('s1-o1', 0, 0.25), opening('s1-o2', 1, 0.5), opening('s1-o3', 2, 0.8)],
    });
    const next = setEdgeLength(base, 0, 9.24);
    expect(next).not.toBe(base);
    expect(next.edges).toEqual(base.edges);
    expect(next.openings).toEqual(base.openings);
    expect(next.outline).toHaveLength(4);
    expect(edgeLength(next.outline, 0)).toBeCloseTo(9.24, 9);
    // L'étage d'origine n'est pas modifié.
    expect(base.outline[1]).toEqual({ x: 10, y: 0 });
  });

  it('sur une feuille à l’échelle, les mètres saisis sont convertis en unités de feuille', () => {
    const cm = storey(
      RECT.map((p) => ({ x: p.x * 100, y: p.y * 100 })),
      { metresPerUnit: { value: 0.01, from: 'plan' } },
    );
    const next = setEdgeLength(cm, 0, 9.24);
    expect(next.outline[1]!.x).toBeCloseTo(924, 9);
    expect(next.outline[2]!.x).toBeCloseTo(924, 9);
    expect(edgeLength(next.outline, 0) * 0.01).toBeCloseTo(9.24, 9);
  });

  it('longueur impossible ou échelle inutilisable : l’étage est rendu tel quel', () => {
    const base = storey(RECT);
    expect(setEdgeLength(base, 0, 0)).toBe(base);
    expect(setEdgeLength(base, 9, 5)).toBe(base);
    const noScale = storey(RECT, { metresPerUnit: { value: 0, from: 'estimate' } });
    expect(setEdgeLength(noScale, 0, 5)).toBe(noScale);
  });
});

describe('parseSideLength', () => {
  it('accepte la virgule, le point et les unités ; refuse le reste', () => {
    expect(parseSideLength('9,24')).toBeCloseTo(9.24, 12);
    expect(parseSideLength('9.24')).toBeCloseTo(9.24, 12);
    expect(parseSideLength(' 11,37 m ')).toBeCloseTo(11.37, 12);
    expect(parseSideLength('924 cm')).toBeCloseTo(9.24, 12);
    for (const bad of ['', 'abc', '0', '-3', '9,2,4', '0,001', '5000']) expect(parseSideLength(bad)).toBeNull();
  });
});
