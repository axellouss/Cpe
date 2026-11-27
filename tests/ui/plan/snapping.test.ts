import { describe, expect, it } from 'vitest';
import { DEMO_INNER, DEMO_OUTLINE, demoSegments } from '../../../src/ui/plan/dev/demoSheet';
import { buildSnapIndex } from '../../../src/ui/plan/snapIndex';
import { dragGuides, isRightAngle, projectOnGuide, resolveSnap, snapToGrid, traceGuides } from '../../../src/ui/plan/snapping';
import type { SnapContext } from '../../../src/ui/plan/snapping';

const index = buildSnapIndex(demoSegments());

function ctx(partial: Partial<SnapContext>): SnapContext {
  return { index: null, radius: 10, vertices: [], guides: [], gridStep: null, enabled: true, ...partial };
}

describe('accrochage', () => {
  it('sans rien à proximité : point libre', () => {
    const r = resolveSnap({ x: 5, y: 5 }, ctx({}));
    expect(r).toEqual({ point: { x: 5, y: 5 }, kind: 'free', guides: [] });
  });

  it('accroche le coin EXTÉRIEUR du mur quand on clique près de lui', () => {
    const corner = DEMO_OUTLINE[1]!; // coin haut-droit, face extérieure
    const r = resolveSnap({ x: corner.x - 6, y: corner.y + 5 }, ctx({ index, radius: 18 }));
    expect(r.point).toEqual(corner);
    expect(r.kind).toBe('endpoint');
  });

  it('le coin intérieur n’est pris que si l’on clique plus près de lui (zoom nécessaire sur un mur de 40 cm)', () => {
    const outer = DEMO_OUTLINE[1]!;
    const inner = DEMO_INNER[1]!;
    const nearInner = resolveSnap({ x: inner.x + 4, y: inner.y - 3 }, ctx({ index, radius: 18 }));
    expect(nearInner.point).toEqual(inner);
    const nearOuter = resolveSnap({ x: outer.x - 4, y: outer.y + 3 }, ctx({ index, radius: 18 }));
    expect(nearOuter.point).toEqual(outer);
  });

  it('préfère une jonction de traits au bout libre d’un tiret de cote', () => {
    // Extrémité gauche de la cote 13,50 : la ligne de cote s'arrête au milieu d'un tiret vertical de ±14.
    const junction = { x: DEMO_OUTLINE[0]!.x, y: DEMO_OUTLINE[0]!.y - 110 };
    // Clic un peu plus près du bout libre du tiret (à 7,1) que de la jonction (à 8,1).
    const p = { x: junction.x + 4, y: junction.y - 7 };
    const r = resolveSnap(p, ctx({ index, radius: 17 }));
    expect(r.point).toEqual(junction);
  });

  it('… mais le bout libre gagne quand on clique franchement dessus', () => {
    const junction = { x: DEMO_OUTLINE[0]!.x, y: DEMO_OUTLINE[0]!.y - 110 };
    const r = resolveSnap({ x: junction.x + 1, y: junction.y - 13 }, ctx({ index, radius: 17 }));
    expect(r.point).toEqual({ x: junction.x, y: junction.y - 14 });
    expect(r.kind).toBe('endpoint');
  });

  it('un sommet existant est prioritaire à distance égale', () => {
    const vertex = { x: 103, y: 100 };
    const r = resolveSnap({ x: 101.5, y: 100 }, ctx({ index: buildSnapIndex(new Float32Array([0, 100, 100, 100])), vertices: [vertex] }));
    expect(r.kind).toBe('vertex');
    expect(r.point).toEqual(vertex);
  });

  it('point de fermeture : prioritaire, rayon élargi, actif même aimant coupé', () => {
    const first = { x: 50, y: 50 };
    const on = resolveSnap({ x: 61, y: 50 }, ctx({ closePoint: first, vertices: [{ x: 62, y: 50 }] }));
    expect(on.kind).toBe('close');
    expect(on.point).toEqual(first);
    const off = resolveSnap({ x: 52, y: 51 }, ctx({ closePoint: first, enabled: false }));
    expect(off.kind).toBe('close');
    expect(resolveSnap({ x: 80, y: 50 }, ctx({ closePoint: first })).kind).toBe('free');
  });

  it('aimant coupé : plus aucun accrochage aux traits', () => {
    const corner = DEMO_OUTLINE[1]!;
    const p = { x: corner.x - 3, y: corner.y + 2 };
    expect(resolveSnap(p, ctx({ index, radius: 18, enabled: false }))).toEqual({ point: p, kind: 'free', guides: [] });
  });

  it('guides de tracé : dans l’axe et d’équerre depuis le dernier point, alignement sur les points posés', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
    ];
    const guides = traceGuides(pts);
    // Depuis (100,60) : horizontale (équerre) et verticale (dans l'axe) ; depuis (0,0) et (100,0) : alignements.
    const kinds = guides.map((g) => g.kind).sort();
    expect(kinds.filter((k) => k === 'ortho')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'straight')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'align').length).toBeGreaterThanOrEqual(2);

    // Curseur presque à la verticale du premier point et presque à l'horizontale du dernier : coin d'équerre exact.
    const r = resolveSnap({ x: 3, y: 57 }, ctx({ guides, radius: 8 }));
    expect(r.kind).toBe('guide');
    expect(r.point.x).toBeCloseTo(0, 9);
    expect(r.point.y).toBeCloseTo(60, 9);
    expect(r.guides.some((g) => g.kind === 'ortho')).toBe(true);
    expect(r.guides.some((g) => g.kind === 'align')).toBe(true);
    expect(isRightAngle(pts[1]!, pts[2]!, r.point)).toBe(true);
  });

  it('premier trait : guides le long des axes de la feuille', () => {
    const guides = traceGuides([{ x: 10, y: 10 }]);
    expect(guides).toHaveLength(2);
    const r = resolveSnap({ x: 80, y: 12 }, ctx({ guides, radius: 5 }));
    expect(r.point).toEqual({ x: 80, y: 10 });
  });

  it('bâtiment tourné : les guides suivent la dernière arête, pas la feuille', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 80, y: 60 }; // arête à 36,87°
    const guides = traceGuides([a, b]);
    // Point attendu à angle droit : b + k·(−60, 80)/100.
    const r = resolveSnap({ x: 80 - 30 + 1.5, y: 60 + 40 + 1 }, ctx({ guides, radius: 6 }));
    expect(r.kind).toBe('guide');
    expect(isRightAngle(a, b, r.point, 0.01)).toBe(true);
  });

  it('un point remarquable situé sur un guide l’emporte sur un point plus proche hors guide', () => {
    // Deux extrémités candidates : A (200,100) sur le guide, à 8,5 du curseur ; B (204,112) hors guide, à 5,3.
    const seg = new Float32Array([200, 100, 260, 100, 204, 112, 204, 160]);
    const local = buildSnapIndex(seg);
    const guides = traceGuides([
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ]); // guide « dans l'axe » : y = 100
    const p = { x: 200, y: 108.5 };
    expect(resolveSnap(p, ctx({ index: local, radius: 12 })).point).toEqual({ x: 204, y: 112 });
    const r = resolveSnap(p, ctx({ index: local, guides, radius: 12 }));
    expect(r.point).toEqual({ x: 200, y: 100 });
    expect(r.guides.length).toBeGreaterThan(0);
  });

  it('guide + trait du plan : le point glisse sur le guide jusqu’au trait qu’il croise', () => {
    // Guide vertical x = 50 ; un trait horizontal y = 80 le croise.
    const local = buildSnapIndex(new Float32Array([0, 80, 200, 80]));
    const guides = [{ origin: { x: 50, y: 0 }, dir: { x: 0, y: 1 }, kind: 'ortho' as const }];
    const r = resolveSnap({ x: 52, y: 78 }, ctx({ index: local, guides, radius: 6 }));
    expect(r.kind).toBe('guide');
    expect(r.point).toEqual({ x: 50, y: 80 });
  });

  it('« sur un trait » quand il n’y a ni point remarquable ni guide', () => {
    const local = buildSnapIndex(new Float32Array([0, 0, 200, 0]));
    const r = resolveSnap({ x: 100, y: 3 }, ctx({ index: local, radius: 8 }));
    expect(r.kind).toBe('online');
    expect(r.point).toEqual({ x: 100, y: 0 });
    // Trop loin (au-delà de 60 % du rayon) : libre.
    expect(resolveSnap({ x: 100, y: 6 }, ctx({ index: local, radius: 8 })).kind).toBe('free');
  });

  it('feuille vierge : grille, et longueurs rondes le long d’un guide', () => {
    expect(snapToGrid({ x: 1.234, y: 5.678 }, 0.05)).toEqual({ x: 1.25, y: 5.7 });
    const free = resolveSnap({ x: 3.02, y: 7.49 }, ctx({ gridStep: 0.1, radius: 0.2 }));
    expect(free.kind).toBe('grid');
    expect(free.point.x).toBeCloseTo(3, 9);
    expect(free.point.y).toBeCloseTo(7.5, 9);
    const guides = traceGuides([
      { x: 0, y: 0 },
      { x: 4, y: 3 },
    ]);
    const r = resolveSnap({ x: 4 + 0.8 * 2.33 + 0.01, y: 3 + 0.6 * 2.33 }, ctx({ guides, gridStep: 0.1, radius: 0.2 }));
    expect(r.kind).toBe('guide');
    expect(Math.hypot(r.point.x - 4, r.point.y - 3)).toBeCloseTo(2.3, 9);
  });

  it('guides de déplacement d’un sommet : équerre avec les arêtes voisines', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    const guides = dragGuides(rect, 2);
    expect(guides.length).toBe(4);
    // Sommet 2 lâché un peu de travers : il revient au coin d'équerre défini par ses voisins.
    const r = resolveSnap({ x: 131, y: 49 }, ctx({ guides, radius: 5 }));
    expect(r.point.y).toBeCloseTo(50, 9);
    const corner = resolveSnap({ x: 98, y: 52 }, ctx({ guides, radius: 5 }));
    expect(corner.point.x).toBeCloseTo(100, 9);
    expect(corner.point.y).toBeCloseTo(50, 9);
    expect(dragGuides(rect.slice(0, 2), 0)).toEqual([]);
  });

  it('projection sur un guide et test d’angle droit', () => {
    expect(projectOnGuide({ x: 7, y: 9 }, { origin: { x: 0, y: 2 }, dir: { x: 1, y: 0 }, kind: 'align' })).toEqual({ x: 7, y: 2 });
    expect(isRightAngle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 7 })).toBe(true);
    expect(isRightAngle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10.3, y: 7 })).toBe(false);
    expect(isRightAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
  });
});
