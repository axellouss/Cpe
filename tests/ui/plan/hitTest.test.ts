import { describe, expect, it } from 'vitest';
import type { Opening, Room, Vec2 } from '../../../src/core/types';
import { MIDPOINT_MIN_EDGE_PX, hitEdge, hitMidpoint, hitOpening, hitRadius, hitRoom, hitVertex, tagSize } from '../../../src/ui/plan/hitTest';
import { sheetToScreen } from '../../../src/ui/plan/view';
import type { View } from '../../../src/ui/plan/view';

/** Rectangle 10 × 6 m dessiné en cm, vu à 0,5 px par cm, décalé de (40, 30) px. */
const outline: Vec2[] = [
  { x: 0, y: 0 },
  { x: 1000, y: 0 },
  { x: 1000, y: 600 },
  { x: 0, y: 600 },
];
const view: View = { scale: 0.5, tx: 40, ty: 30 };
const at = (x: number, y: number): Vec2 => sheetToScreen(view, { x, y });

function opening(partial: Partial<Opening>): Opening {
  return { id: 'o1', edgeIndex: 0, kind: 'window', width: 1.2, height: 1.35, count: 1, position: 0.5, windowTypeId: null, from: 'user', ...partial };
}

describe('test de toucher', () => {
  it('rayon plus généreux au doigt qu’à la souris', () => {
    expect(hitRadius('touch')).toBeGreaterThan(hitRadius('pen'));
    expect(hitRadius('pen')).toBeGreaterThan(hitRadius('mouse'));
  });

  it('sommet : le plus proche dans le rayon, en pixels écran quel que soit le zoom', () => {
    const c = at(1000, 0);
    expect(hitVertex(outline, view, { x: c.x + 6, y: c.y - 5 }, 10)).toBe(1);
    expect(hitVertex(outline, view, { x: c.x + 9, y: c.y - 9 }, 10)).toBeNull();
    // Même écart en pixels avec un zoom dix fois plus fort : même réponse.
    const zoomed: View = { scale: 5, tx: 40, ty: 30 };
    const cz = sheetToScreen(zoomed, { x: 1000, y: 0 });
    expect(hitVertex(outline, zoomed, { x: cz.x + 6, y: cz.y - 5 }, 10)).toBe(1);
    expect(hitVertex([], view, c, 10)).toBeNull();
  });

  it('poignée de milieu : seulement sur les arêtes assez longues à l’écran', () => {
    const m = at(500, 0);
    expect(hitMidpoint(outline, view, { x: m.x + 3, y: m.y + 3 }, 10)).toBe(0);
    expect(hitMidpoint(outline, view, { x: m.x + 30, y: m.y }, 10)).toBeNull();
    // Vue très éloignée : l'arête de 1000 fait moins de MIDPOINT_MIN_EDGE_PX → plus de poignée.
    const far: View = { scale: (MIDPOINT_MIN_EDGE_PX - 1) / 1000, tx: 0, ty: 0 };
    expect(hitMidpoint(outline, far, sheetToScreen(far, { x: 500, y: 0 }), 10)).toBeNull();
  });

  it('arête : indice, position le long de l’arête et point projeté', () => {
    const p = at(1000, 150);
    const hit = hitEdge(outline, view, { x: p.x - 5, y: p.y }, 8);
    expect(hit?.index).toBe(1);
    expect(hit?.t).toBeCloseTo(0.25, 9);
    expect(hit?.point).toEqual({ x: 1000, y: 150 });
    expect(hitEdge(outline, view, { x: p.x - 20, y: p.y }, 8)).toBeNull();
    // L'arête de fermeture (dernier → premier sommet) compte aussi.
    const left = at(0, 300);
    expect(hitEdge(outline, view, { x: left.x + 2, y: left.y }, 8)?.index).toBe(3);
    expect(hitEdge(outline.slice(0, 1), view, p, 8)).toBeNull();
  });

  it('ouverture : sur sa marque à l’échelle, pas ailleurs sur l’arête', () => {
    // Fenêtre de 1,20 m centrée sur l'arête haute : marque de x = 440 à 560 (cm).
    const openings = [opening({}), opening({ id: 'o2', edgeIndex: 2, position: 0.1, width: 0.9, kind: 'door' })];
    const on = at(470, 0);
    expect(hitOpening(outline, openings, 0.01, view, { x: on.x, y: on.y + 4 }, 10)).toBe('o1');
    const off = at(300, 0);
    expect(hitOpening(outline, openings, 0.01, view, off, 10)).toBeNull();
    // Arête 2 parcourue de droite à gauche : position 0,1 → x = 900.
    const door = at(900, 600);
    expect(hitOpening(outline, openings, 0.01, view, { x: door.x + 3, y: door.y - 3 }, 10)).toBe('o2');
  });

  it('pièces : la plus petite sous le doigt, étiquettes au-dessus des polygones', () => {
    const rooms: Room[] = [
      { id: 'big', name: 'Séjour', area: { value: 40, from: 'plan' }, heated: true, needsReview: false, polygon: [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 600 }, { x: 0, y: 600 }] },
      { id: 'small', name: 'WC', area: { value: 2, from: 'plan' }, heated: true, needsReview: false, polygon: [{ x: 100, y: 100 }, { x: 250, y: 100 }, { x: 250, y: 250 }, { x: 100, y: 250 }] },
      { id: 'tag', name: 'Hall', area: { value: 3, from: 'plan' }, heated: true, needsReview: false, at: { x: 600, y: 300 } },
      { id: 'lost', name: 'Cave', area: { value: 9, from: 'plan' }, heated: false, needsReview: true },
    ];
    const label = (r: Room): string => `${r.name} · 3,00 m²`;
    expect(hitRoom(rooms, view, at(180, 180), label)).toBe('small');
    expect(hitRoom(rooms, view, at(400, 500), label)).toBe('big');
    // L'étiquette « Hall » est posée sur le séjour : c'est elle qui répond.
    const c = at(600, 300);
    const size = tagSize(label(rooms[2]!));
    expect(hitRoom(rooms, view, { x: c.x + size.width / 2 - 2, y: c.y }, label)).toBe('tag');
    expect(hitRoom(rooms, view, { x: c.x + size.width / 2 + 3, y: c.y }, label)).toBe('big');
    expect(hitRoom(rooms, view, at(950, 300), label)).toBeNull();
  });

  it('taille d’étiquette : croît avec le texte, jamais minuscule', () => {
    expect(tagSize('WC').width).toBeGreaterThanOrEqual(44);
    expect(tagSize('Salle de bains · 12,40 m²').width).toBeGreaterThan(tagSize('WC · 2 m²').width);
  });
});
