import { describe, expect, it } from 'vitest';
import type { Opening, Room, Storey, Vec2 } from '../../../src/core/types';
import {
  BOUNDARY_CYCLE,
  addOpening,
  dedupeOutline,
  deleteVertex,
  insertVertex,
  isCollinear,
  moveVertex,
  nextBoundary,
  nextOpeningId,
  pointOnEdge,
  removeOpening,
  replaceOutline,
  roomsToReview,
  setBoundary,
  syncedEdges,
  toggleRoom,
  updateOpening,
} from '../../../src/ui/plan/outlineOps';

/** Rectangle 10 × 6 (sens horaire à l'écran) : arêtes 0 = haut, 1 = droite, 2 = bas, 3 = gauche. */
const RECT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 0, y: 6 },
];

function opening(id: string, edgeIndex: number, position: number, extra: Partial<Opening> = {}): Opening {
  return { id, edgeIndex, kind: 'window', width: 1.2, height: 1.35, count: 1, position, windowTypeId: null, from: 'plan', ...extra };
}

function storey(partial: Partial<Storey> = {}): Storey {
  return {
    id: 's1',
    name: 'Rez-de-chaussée',
    sheetId: null,
    outline: RECT.map((p) => ({ ...p })),
    edges: [
      { boundary: 'outside', constructionId: null },
      { boundary: 'heated', constructionId: 'wall-party' },
      { boundary: 'ground', constructionId: null },
      { boundary: 'unheated', constructionId: null },
    ],
    metresPerUnit: { value: 1, from: 'user' },
    grossHeight: { value: 2.8, from: 'default' },
    clearHeight: { value: 2.5, from: 'default' },
    openings: [],
    rooms: [],
    netAreaOverride: null,
    ...partial,
  };
}

/** Position absolue d'une ouverture sur le plan : sert à vérifier qu'elle ne « glisse » pas le long du mur. */
function where(s: Storey, id: string): Vec2 {
  const o = s.openings.find((x) => x.id === id)!;
  return pointOnEdge(s.outline, o.edgeIndex, o.position);
}

function frozen<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('édition du contour', () => {
  it('cycle des façades : extérieur → voisin chauffé → non chauffé → terre → extérieur', () => {
    expect(BOUNDARY_CYCLE).toEqual(['outside', 'heated', 'unheated', 'ground']);
    expect(nextBoundary('outside')).toBe('heated');
    expect(nextBoundary('heated')).toBe('unheated');
    expect(nextBoundary('unheated')).toBe('ground');
    expect(nextBoundary('ground')).toBe('outside');
  });

  it('syncedEdges complète ou tronque pour suivre le contour', () => {
    expect(syncedEdges({ outline: RECT, edges: [] })).toEqual(new Array(4).fill({ boundary: 'outside', constructionId: null }));
    const many = syncedEdges({ outline: RECT.slice(0, 3), edges: storey().edges });
    expect(many).toHaveLength(3);
    expect(many[1]!.boundary).toBe('heated');
  });

  it('déplacer un sommet : immuable, arêtes et ouvertures gardées telles quelles', () => {
    const s = storey({ openings: [opening('a', 1, 0.5)] });
    const before = frozen(s);
    const next = moveVertex(s, 2, { x: 12, y: 7 });
    expect(s).toEqual(before);
    expect(next.outline[2]).toEqual({ x: 12, y: 7 });
    expect(next.outline[0]).toBe(s.outline[0]);
    expect(next.edges).toEqual(s.edges);
    expect(next.openings).toBe(s.openings);
    expect(moveVertex(s, 9, { x: 0, y: 0 })).toBe(s);
  });

  it('insérer un sommet coupe l’arête : les deux moitiés sont le MÊME mur', () => {
    const s = storey({
      openings: [opening('left', 1, 0.25), opening('right', 1, 0.75), opening('top', 0, 0.5), opening('bottom', 2, 0.5), opening('west', 3, 0.1)],
    });
    const pos = Object.fromEntries(s.openings.map((o) => [o.id, where(s, o.id)]));
    const next = insertVertex(s, 1); // milieu de l'arête droite
    expect(next.outline).toHaveLength(5);
    expect(next.outline[2]).toEqual({ x: 10, y: 3 });
    expect(next.edges).toHaveLength(5);
    expect(next.edges[1]).toEqual({ boundary: 'heated', constructionId: 'wall-party' });
    expect(next.edges[2]).toEqual({ boundary: 'heated', constructionId: 'wall-party' });
    expect(next.edges[2]).not.toBe(next.edges[1]);
    expect(next.edges[3]!.boundary).toBe('ground');
    // Chaque ouverture reste exactement où elle était sur le plan.
    for (const o of next.openings) {
      const p = where(next, o.id);
      expect(p.x).toBeCloseTo(pos[o.id]!.x, 9);
      expect(p.y).toBeCloseTo(pos[o.id]!.y, 9);
    }
    expect(next.openings.map((o) => [o.id, o.edgeIndex])).toEqual([
      ['left', 1],
      ['right', 2],
      ['top', 0],
      ['bottom', 3],
      ['west', 4],
    ]);
    expect(s.outline).toHaveLength(4);
  });

  it('insérer à un point donné répartit les ouvertures selon ce point', () => {
    const s = storey({ openings: [opening('a', 0, 0.2), opening('b', 0, 0.9)] });
    const next = insertVertex(s, 0, { x: 4, y: 0.3 }); // projeté à t = 0,4
    expect(next.outline[1]).toEqual({ x: 4, y: 0.3 });
    const a = next.openings.find((o) => o.id === 'a')!;
    const b = next.openings.find((o) => o.id === 'b')!;
    expect(a.edgeIndex).toBe(0);
    expect(a.position).toBeCloseTo(0.5, 9);
    expect(b.edgeIndex).toBe(1);
    expect(b.position).toBeCloseTo((0.9 - 0.4) / 0.6, 9);
    expect(insertVertex(s, 7)).toBe(s);
  });

  it('supprimer un sommet d’angle : arête nouvelle = extérieur, ouvertures des deux arêtes disparues supprimées', () => {
    const s = storey({ openings: [opening('top', 0, 0.5), opening('right', 1, 0.5), opening('bottom', 2, 0.5), opening('left', 3, 0.5)] });
    const next = deleteVertex(s, 1); // coin haut-droit : les arêtes 0 et 1 fusionnent
    expect(next.outline).toEqual([RECT[0], RECT[2], RECT[3]]);
    expect(next.edges).toEqual([
      { boundary: 'outside', constructionId: null },
      { boundary: 'ground', constructionId: null },
      { boundary: 'unheated', constructionId: null },
    ]);
    expect(next.openings.map((o) => [o.id, o.edgeIndex])).toEqual([
      ['bottom', 1],
      ['left', 2],
    ]);
  });

  it('supprimer le sommet 0 : c’est la DERNIÈRE arête qui fusionne avec la première', () => {
    const s = storey({ openings: [opening('top', 0, 0.5), opening('right', 1, 0.3), opening('bottom', 2, 0.5), opening('left', 3, 0.5)] });
    const next = deleteVertex(s, 0);
    expect(next.outline).toEqual([RECT[1], RECT[2], RECT[3]]);
    // Anciennes arêtes 1 et 2 conservées (indices 0 et 1) ; la fusion 3 + 0 est la nouvelle arête 2.
    expect(next.edges.map((e) => e.boundary)).toEqual(['heated', 'ground', 'outside']);
    expect(next.openings.map((o) => [o.id, o.edgeIndex, o.position])).toEqual([
      ['right', 0, 0.3],
      ['bottom', 1, 0.5],
    ]);
  });

  it('supprimer un sommet ALIGNÉ : même mur, propriétés et ouvertures conservées à leur place', () => {
    const split = insertVertex(storey({ openings: [opening('a', 1, 0.25), opening('b', 1, 0.9)] }), 1, { x: 10, y: 4 });
    expect(split.outline).toHaveLength(5);
    const pos = { a: where(split, 'a'), b: where(split, 'b') };
    const merged = deleteVertex(split, 2);
    expect(merged.outline).toEqual(RECT);
    expect(merged.edges.map((e) => e.boundary)).toEqual(['outside', 'heated', 'ground', 'unheated']);
    expect(merged.edges[1]!.constructionId).toBe('wall-party');
    expect(merged.openings).toHaveLength(2);
    for (const id of ['a', 'b'] as const) {
      const o = merged.openings.find((x) => x.id === id)!;
      expect(o.edgeIndex).toBe(1);
      expect(where(merged, id).y).toBeCloseTo(pos[id].y, 9);
    }
    expect(isCollinear({ x: 0, y: 0 }, { x: 5, y: 0.01 }, { x: 10, y: 0 })).toBe(true);
    expect(isCollinear({ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 10, y: 0 })).toBe(false);
    expect(isCollinear({ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 10, y: 0 })).toBe(false);
  });

  it('sommet aligné entre deux façades différentes : la plus longue donne ses propriétés', () => {
    let s = insertVertex(storey(), 0, { x: 7, y: 0 }); // haut coupé en 7 + 3
    s = setBoundary(s, 1, 'unheated'); // le petit morceau donne sur un garage
    const merged = deleteVertex(s, 1);
    expect(merged.edges[0]!.boundary).toBe('outside');
  });

  it('il reste toujours au moins 3 sommets', () => {
    const tri = storey({ outline: RECT.slice(0, 3), edges: storey().edges.slice(0, 3) });
    expect(deleteVertex(tri, 1)).toBe(tri);
    expect(deleteVertex(storey(), -1)).toEqual(storey());
  });

  it('nouveau tracé : les arêtes retrouvées gardent propriétés et ouvertures, les autres sont neuves', () => {
    const s = storey({ openings: [opening('top', 0, 0.2), opening('right', 1, 0.5), opening('bottom', 2, 0.5), opening('left', 3, 0.4)] });
    // Même rectangle, mais le bas est remplacé par une avancée ; tracé en partant d'un autre sommet.
    const traced: Vec2[] = [RECT[1]!, RECT[2]!, { x: 5, y: 9 }, RECT[3]!, RECT[0]!];
    const next = replaceOutline(s, traced);
    expect(next.outline).toEqual(traced);
    expect(next.edges.map((e) => e.boundary)).toEqual(['heated', 'outside', 'outside', 'unheated', 'outside']);
    expect(next.edges[0]!.constructionId).toBe('wall-party');
    expect(next.openings.map((o) => [o.id, o.edgeIndex, o.position])).toEqual([
      ['top', 4, 0.2],
      ['right', 0, 0.5],
      ['left', 3, 0.4],
    ]);
  });

  it('nouveau tracé en sens inverse : mêmes murs, positions retournées', () => {
    const s = storey({ openings: [opening('top', 0, 0.2)] });
    const reversed = [...RECT].reverse();
    const next = replaceOutline(s, reversed);
    expect(next.edges.map((e) => e.boundary).sort()).toEqual(['ground', 'heated', 'outside', 'unheated']);
    const top = next.openings[0]!;
    expect(pointOnEdge(next.outline, top.edgeIndex, top.position).x).toBeCloseTo(2, 9);
    expect(pointOnEdge(next.outline, top.edgeIndex, top.position).y).toBeCloseTo(0, 9);
  });

  it('nouveau tracé : point de fermeture répété et doublons retirés, points alignés gardés', () => {
    const pts = [RECT[0]!, { x: 5, y: 0 }, { x: 5, y: 0 }, RECT[1]!, RECT[2]!, RECT[3]!, RECT[0]!];
    expect(dedupeOutline(pts)).toEqual([RECT[0], { x: 5, y: 0 }, RECT[1], RECT[2], RECT[3]]);
    const next = replaceOutline(storey({ outline: [], edges: [] }), pts);
    expect(next.outline).toHaveLength(5);
    expect(next.edges).toHaveLength(5);
    expect(next.edges.every((e) => e.boundary === 'outside' && e.constructionId === null)).toBe(true);
  });

  it('changer ce qu’il y a derrière une façade remet le type de mur par défaut', () => {
    const s = storey();
    const next = setBoundary(s, 1, 'ground');
    expect(next.edges[1]).toEqual({ boundary: 'ground', constructionId: null });
    expect(next.edges[0]).toBe(s.edges[0]);
    expect(s.edges[1]!.boundary).toBe('heated');
    expect(setBoundary(s, 1, 'heated')).toBe(s);
    expect(setBoundary(s, 8, 'ground')).toBe(s);
  });
});

describe('ouvertures et pièces', () => {
  it('ajout : identifiant libre, provenance « user », position bornée', () => {
    const s = storey({ openings: [opening('s1-o1', 0, 0.5), opening('s1-o7', 1, 0.5)] });
    expect(nextOpeningId(s)).toBe('s1-o8');
    const next = addOpening(s, { edgeIndex: 2, kind: 'door', width: 1, height: 2.1, count: 1, position: 1.4, windowTypeId: null });
    const added = next.openings[2]!;
    expect(added).toMatchObject({ id: 's1-o8', edgeIndex: 2, kind: 'door', from: 'user', position: 1 });
    expect(s.openings).toHaveLength(2);
    expect(nextOpeningId(storey())).toBe('s1-o1');
  });

  it('modification : l’ouverture devient confirmée, les autres ne bougent pas', () => {
    const s = storey({ openings: [opening('a', 0, 0.5, { from: 'estimate' }), opening('b', 1, 0.5)] });
    const next = updateOpening(s, 'a', { height: 1.5, count: 2 });
    expect(next.openings[0]).toMatchObject({ id: 'a', height: 1.5, count: 2, width: 1.2, from: 'user' });
    expect(next.openings[1]).toBe(s.openings[1]);
    expect(updateOpening(s, 'zz', { height: 2 })).toBe(s);
  });

  it('suppression', () => {
    const s = storey({ openings: [opening('a', 0, 0.5), opening('b', 1, 0.5)] });
    expect(removeOpening(s, 'a').openings.map((o) => o.id)).toEqual(['b']);
    expect(removeOpening(s, 'zz')).toBe(s);
  });

  it('pièces : un toucher bascule « comptée dans An » et lève le doute', () => {
    const rooms: Room[] = [
      { id: 'r1', name: 'Séjour', area: { value: 30, from: 'plan' }, heated: true, needsReview: false },
      { id: 'r2', name: 'Buanderie', area: { value: 6, from: 'plan' }, heated: false, needsReview: true },
    ];
    const s = storey({ rooms });
    expect(roomsToReview(s)).toBe(1);
    const once = toggleRoom(s, 'r2');
    expect(once.rooms[1]).toMatchObject({ heated: true, needsReview: false });
    expect(once.rooms[0]).toBe(rooms[0]);
    expect(roomsToReview(once)).toBe(0);
    expect(toggleRoom(once, 'r2').rooms[1]).toMatchObject({ heated: false, needsReview: false });
    expect(toggleRoom(s, 'nope')).toBe(s);
    expect(s.rooms[1]!.needsReview).toBe(true);
  });
});
