/**
 * Placement des étiquettes autour du contour : pastilles des longueurs (ux-04 : on les touche pour saisir) et
 * dimensions des ouvertures qui ne se recouvrent plus (ux-07 c).
 */
import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../../src/core/types';
import {
  LENGTH_PILL,
  distanceToRect,
  hitLengthLabel,
  isSteep,
  layoutOpeningLabels,
  lengthLabels,
  rectsOverlap,
  textWidth,
} from '../../../src/ui/plan/labels';
import type { OpeningLabelInput, Rect } from '../../../src/ui/plan/labels';
import type { View } from '../../../src/ui/plan/view';

/** Rectangle 10 × 8 m, 20 px par mètre, coin haut gauche à (60, 90) : la maison d'exemple sur un téléphone. */
const RECT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 8 },
  { x: 0, y: 8 },
];
const view: View = { scale: 20, tx: 60, ty: 90 };
const HOUSE: Rect = { x: 60, y: 90, width: 200, height: 160 };

function anyOverlap(boxes: readonly Rect[]): boolean {
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (rectsOverlap(boxes[i]!, boxes[j]!)) return true;
  return false;
}

describe('pastilles des longueurs', () => {
  it('une par côté, à l’extérieur du contour, à l’écart de la poignée « + » du milieu', () => {
    const labels = lengthLabels(RECT, view, 1);
    expect(labels.map((l) => l.text)).toEqual(['10,00', '8,00', '10,00', '8,00']);
    expect(labels.map((l) => l.edge)).toEqual([0, 1, 2, 3]);
    for (const l of labels) {
      expect(rectsOverlap(l.box, HOUSE)).toBe(false);
      expect(l.metres).toBeCloseTo(l.edge % 2 === 0 ? 10 : 8, 9);
      expect(l.rotate).toBe(0);
    }
    // Haut : centrée sur le côté, bord bas à `gap` px du trait (la poignée « + » fait 6,5 px de rayon).
    const top = labels[0]!;
    expect(top.x).toBeCloseTo(160, 9);
    expect(top.box.y + top.box.height).toBeCloseTo(90 - LENGTH_PILL.gap, 9);
    expect(LENGTH_PILL.gap).toBeGreaterThan(7);
    // Droite : bord gauche à `gap` px du trait.
    expect(labels[1]!.box.x).toBeCloseTo(260 + LENGTH_PILL.gap, 9);
  });

  it('écran étroit : le texte suit les côtés raides, la pastille ne déborde plus sur les côtés', () => {
    const flat = lengthLabels(RECT, view, 1);
    const along = lengthLabels(RECT, view, 1, { along: true });
    expect(along[0]!.rotate).toBe(0);
    expect(along[1]!.rotate).toBe(-90);
    expect(along[3]!.rotate).toBe(-90);
    expect(along[1]!.box.width).toBe(LENGTH_PILL.height);
    expect(along[1]!.box.height).toBeGreaterThan(along[1]!.box.width);
    expect(along[1]!.box.x + along[1]!.box.width).toBeLessThan(flat[1]!.box.x + flat[1]!.box.width);
    // 30 px de marge suffisent de chaque côté (marge de cadrage de l'outil « contour » sur téléphone).
    expect(along[1]!.box.x + along[1]!.box.width - 260).toBeLessThanOrEqual(30);
    expect(60 - along[3]!.box.x).toBeLessThanOrEqual(30);
  });

  it('échelle supposée : « ≈ » ; mètres calculés avec l’échelle de la feuille ; côtés trop courts sans pastille', () => {
    expect(lengthLabels(RECT, view, 1, { approx: true })[0]!.text).toBe('≈ 10,00');
    const cm = RECT.map((p) => ({ x: p.x * 100, y: p.y * 100 }));
    expect(lengthLabels(cm, { scale: 0.2, tx: 60, ty: 90 }, 0.01).map((l) => l.text)).toEqual(['10,00', '8,00', '10,00', '8,00']);
    // Dézoom : 2 px par mètre → côtés de 20 et 16 px, sous le seuil de 44 px.
    expect(lengthLabels(RECT, { scale: 2, tx: 0, ty: 0 }, 1)).toEqual([]);
    expect(lengthLabels(RECT, { scale: 5, tx: 0, ty: 0 }, 1).map((l) => l.edge)).toEqual([0, 2]);
    expect(lengthLabels(RECT.slice(0, 2), view, 1)).toEqual([]);
  });

  it('tracé ouvert : pas de côté de fermeture', () => {
    const labels = lengthLabels(RECT.slice(0, 3), view, 1, { closed: false });
    expect(labels.map((l) => l.text)).toEqual(['10,00', '8,00']);
  });

  it('toucher : la pastille sous le doigt, ou la plus proche dans la tolérance', () => {
    const labels = lengthLabels(RECT, view, 1);
    const top = labels[0]!;
    expect(hitLengthLabel(labels, { x: top.x, y: top.y }, 0)).toEqual({ edge: 0, distance: 0 });
    const above = hitLengthLabel(labels, { x: top.x, y: top.box.y - 6 }, 10)!;
    expect(above.edge).toBe(0);
    expect(above.distance).toBeCloseTo(6, 9);
    expect(hitLengthLabel(labels, { x: top.x, y: top.box.y - 6 }, 4)).toBeNull();
    expect(hitLengthLabel(labels, { x: 160, y: 170 }, 10)).toBeNull();
  });

  it('outils de géométrie', () => {
    expect(distanceToRect({ x: 5, y: 5 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(0);
    expect(distanceToRect({ x: 13, y: 14 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(5);
    expect(isSteep({ x: 1, y: 0 })).toBe(true);
    expect(isSteep({ x: 0, y: -1 })).toBe(false);
    expect(textWidth('10,00', 11.5)).toBeGreaterThan(textWidth('8,00', 11.5));
    expect(textWidth('', 11.5)).toBe(0);
  });
});

describe('étiquettes des ouvertures', () => {
  /** Quatre fenêtres serrées sur la façade du haut (200 px), comme dans la maison d'exemple sur téléphone. */
  const top = (id: string, x: number, text: string, priority = false): OpeningLabelInput => ({ id, text, centre: { x, y: 90 }, normal: { x: 0, y: -1 }, priority });
  const crowded = [top('a', 90, '1,20 × 1,35'), top('b', 135, '0,60 × 0,75'), top('c', 170, '0,80 × 1,35'), top('d', 215, '1,20 × 1,35')];

  it('à leur place d’origine elles se recouvriraient ; placées, plus aucune ne recouvre une autre', () => {
    const naive = layoutOpeningLabels(crowded, { along: false, maxTries: 1 });
    // Une seule position permise : celles qui gêneraient sont omises plutôt que superposées.
    expect(naive.length).toBeLessThan(crowded.length);
    expect(anyOverlap(naive.map((p) => p.box))).toBe(false);

    const placed = layoutOpeningLabels(crowded, { along: false, maxTries: 5 });
    expect(placed.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(anyOverlap(placed.map((p) => p.box))).toBe(false);
    // La première reste à sa place, sans trait de rappel ; une étiquette déplacée en a un, et s'éloigne de la façade.
    expect(placed[0]!.leader).toBeNull();
    const moved = placed.filter((p) => p.leader !== null);
    expect(moved.length).toBeGreaterThan(0);
    for (const p of moved) expect(p.y).toBeLessThan(placed[0]!.y);
    // Toutes à l'extérieur de la maison.
    for (const p of placed) expect(rectsOverlap(p.box, HOUSE)).toBe(false);
  });

  it('faute de place, l’ouverture sélectionnée et celles « à confirmer » gardent leur étiquette', () => {
    const items = [top('a', 100, '1,20 × 1,35'), top('b', 110, '0,60 × 0,75'), top('c', 120, '1,00 × 2,10 ?', true)];
    const placed = layoutOpeningLabels(items, { along: false, maxTries: 1 });
    expect(placed.map((p) => p.id)).toContain('c');
    expect(placed.find((p) => p.id === 'c')!.leader).toBeNull();
    expect(placed.length).toBeLessThan(3);
  });

  it('écran étroit : sur une façade raide le texte suit le mur et tient dans 40 px', () => {
    const right: OpeningLabelInput = { id: 'r', text: '1,00 × 2,10 ?', centre: { x: 260, y: 170 }, normal: { x: 1, y: 0 }, priority: true };
    const [along] = layoutOpeningLabels([right], { along: true, maxTries: 2 });
    expect(along!.rotate).toBe(-90);
    expect(along!.anchor).toBe('middle');
    expect(along!.box.x).toBeGreaterThan(260);
    expect(along!.box.x + along!.box.width - 260).toBeLessThanOrEqual(40);
    expect(along!.box.height).toBeGreaterThan(along!.box.width);
    // Grand écran : texte horizontal, ancré du côté du mur.
    const [flat] = layoutOpeningLabels([right], { along: false, maxTries: 5 });
    expect(flat!.rotate).toBe(0);
    expect(flat!.anchor).toBe('start');
    expect(flat!.box.x).toBeGreaterThan(260);
  });

  it('façade raide, texte horizontal : deux ouvertures voisines se décalent le long du mur', () => {
    const a: OpeningLabelInput = { id: 'a', text: '1,20 × 1,35', centre: { x: 60, y: 150 }, normal: { x: -1, y: 0 }, priority: false };
    const b: OpeningLabelInput = { ...a, id: 'b', centre: { x: 60, y: 158 } };
    const placed = layoutOpeningLabels([a, b], { along: false, maxTries: 5 });
    expect(placed).toHaveLength(2);
    expect(anyOverlap(placed.map((p) => p.box))).toBe(false);
    expect(placed[0]!.anchor).toBe('end');
    expect(placed[1]!.leader).not.toBeNull();
    for (const p of placed) expect(p.box.x + p.box.width).toBeLessThanOrEqual(60);
  });

  it('deux rangées au plus sur téléphone (40 px de marge) pour la maison d’exemple', () => {
    const placed = layoutOpeningLabels(crowded, { along: true, maxTries: 2 });
    expect(anyOverlap(placed.map((p) => p.box))).toBe(false);
    for (const p of placed) expect(90 - p.box.y).toBeLessThanOrEqual(40);
    expect(placed.length).toBeGreaterThanOrEqual(3);
  });
});
