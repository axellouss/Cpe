/**
 * Téléphone (ux-07) : le plan garde l'écran. Place prise par l'interface, cadrage du contour dans la place libre,
 * cibles minimales des petites pièces. Et lisibilité de la légende des façades (ux-17).
 */
import { describe, expect, it } from 'vitest';
import type { Room, Vec2 } from '../../../src/core/types';
import type { PlanTool } from '../../../src/ui/plan';
import { hitRoom, roomMinTarget, roomTarget } from '../../../src/ui/plan/hitTest';
import { LENGTH_PILL } from '../../../src/ui/plan/labels';
import { COMPACT_MARGIN, fitViewInsets, fitViewMargins, hudInsets, sheetToScreen } from '../../../src/ui/plan/view';
import type { Insets, ScreenBox, View } from '../../../src/ui/plan/view';

// Feuille de styles de l'éditeur, lue sur le disque (sans dépendre des types de Node, absents du projet).
interface FsLike {
  readFileSync(path: string | URL): Uint8Array;
}
const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as FsLike;
const css = new TextDecoder().decode(fs.readFileSync(new URL('../../../src/ui/plan/plan-editor.css', import.meta.url)));

/** Zone de plan d'un téléphone 390 × 844 dans l'application. */
const PHONE = { width: 364, height: 338 };
/** Navigation (zoom, ajuster, flèches) : colonne en bas à droite. */
const NAV: ScreenBox = { left: 316, top: 170, right: 358, bottom: 332 };
/** Maison d'exemple : contour chauffé de 10 × 8 m dessiné en centimètres. */
const HOUSE = { minX: 300, minY: 200, maxX: 1300, maxY: 1000 };

/** Interface de chaque étape telle qu'elle se présente sur téléphone (boîtes relevées dans le navigateur). */
const HUD: Record<Exclude<PlanTool, 'pan'>, ScreenBox[]> = {
  scale: [{ left: 6, top: 6, right: 358, bottom: 71 }, { left: 6, top: 276, right: 310, bottom: 332 }, NAV],
  outline: [{ left: 6, top: 6, right: 288, bottom: 36 }, { left: 6, top: 40, right: 304, bottom: 80 }, { left: 6, top: 306, right: 310, bottom: 332 }, NAV],
  boundary: [{ left: 6, top: 6, right: 336, bottom: 36 }, { left: 6, top: 284, right: 310, bottom: 328 }, NAV],
  opening: [{ left: 6, top: 6, right: 326, bottom: 36 }, { left: 6, top: 306, right: 310, bottom: 332 }, NAV],
  north: [{ left: 6, top: 6, right: 258, bottom: 36 }, { left: 6, top: 250, right: 310, bottom: 332 }, NAV],
  rooms: [{ left: 6, top: 6, right: 347, bottom: 36 }, { left: 6, top: 257, right: 310, bottom: 301 }, { left: 6, top: 306, right: 310, bottom: 332 }, NAV],
};

describe('place prise par l’interface (hudInsets)', () => {
  it('chaque élément est rattaché au bord qu’il longe', () => {
    const insets = hudInsets(PHONE, HUD.outline)!;
    expect(insets).toEqual({ top: 84, right: 52, bottom: 36, left: 8 });
    // La boussole du téléphone (bandeau bas) compte en bas, pas à gauche.
    expect(hudInsets(PHONE, HUD.north)!.bottom).toBe(338 - 250 + 4);
    // Grand écran : boussole en carte à droite, sous le bandeau.
    const desktop = hudInsets({ width: 900, height: 600 }, [{ left: 656, top: 60, right: 892, bottom: 420 }])!;
    expect(desktop.right).toBe(900 - 656 + 4);
    expect(desktop.top).toBe(8);
  });

  it('rien de mesurable, ou plus de place pour le plan : null (on garde les marges par défaut)', () => {
    expect(hudInsets(PHONE, [])).toBeNull();
    expect(hudInsets(PHONE, [{ left: 0, top: 0, right: 0, bottom: 0 }])).toBeNull();
    expect(hudInsets({ width: 0, height: 0 }, HUD.outline)).toBeNull();
    // Un bandeau haut et un bandeau bas qui se rejoignent presque.
    expect(hudInsets(PHONE, [{ left: 0, top: 0, right: 364, bottom: 160 }, { left: 0, top: 200, right: 364, bottom: 338 }])).toBeNull();
  });
});

describe('cadrage du contour sur téléphone', () => {
  const corners = (view: View): { a: Vec2; b: Vec2 } => ({
    a: sheetToScreen(view, { x: HOUSE.minX, y: HOUSE.minY }),
    b: sheetToScreen(view, { x: HOUSE.maxX, y: HOUSE.maxY }),
  });

  it('à chaque étape, le contour occupe au moins 55 % de la largeur et aucun élément d’interface ne le recouvre', () => {
    for (const tool of Object.keys(HUD) as (keyof typeof HUD)[]) {
      const insets = hudInsets(PHONE, HUD[tool])!;
      const { a, b } = corners(fitViewMargins(HOUSE, PHONE, insets, COMPACT_MARGIN[tool]));
      expect((b.x - a.x) / PHONE.width, tool).toBeGreaterThanOrEqual(0.55);
      for (const box of HUD[tool]) {
        const overlaps = a.x < box.right && box.left < b.x && a.y < box.bottom && box.top < b.y;
        expect(overlaps, `${tool} : ${JSON.stringify(box)}`).toBe(false);
      }
      // La marge de l'outil reste libre autour du contour (étiquettes extérieures).
      expect(a.y - insets.top, tool).toBeGreaterThanOrEqual(COMPACT_MARGIN[tool].top - 1e-6);
      expect(PHONE.height - insets.bottom - b.y, tool).toBeGreaterThanOrEqual(COMPACT_MARGIN[tool].bottom - 1e-6);
      expect(a.x - insets.left, tool).toBeGreaterThanOrEqual(COMPACT_MARGIN[tool].x - 1e-6);
      expect(PHONE.width - insets.right - b.x, tool).toBeGreaterThanOrEqual(COMPACT_MARGIN[tool].x - 1e-6);
    }
  });

  it('avec les anciennes marges fixes (boussole de 250 px), le contour tombait à quelques pixels', () => {
    const before: Insets = { top: 96, right: 12, bottom: 250, left: 12 };
    const inflated = { minX: HOUSE.minX - 100, minY: HOUSE.minY - 100, maxX: HOUSE.maxX + 100, maxY: HOUSE.maxY + 100 };
    const { a, b } = corners(fitViewInsets(inflated, PHONE, before));
    expect((b.x - a.x) / PHONE.width).toBeLessThan(0.1);
  });

  it('fitViewMargins centre le rectangle dans la place libre, marges comprises', () => {
    const insets: Insets = { top: 40, right: 52, bottom: 36, left: 8 };
    const view = fitViewMargins(HOUSE, PHONE, insets, { x: 30, top: 28, bottom: 28 });
    const { a, b } = corners(view);
    expect((a.x + b.x) / 2).toBeCloseTo((8 + 364 - 52) / 2, 6);
    expect((a.y + b.y) / 2).toBeCloseTo((40 + 338 - 36) / 2, 6);
    // Marge plus grande en haut qu'en bas : le rectangle descend d'autant, sans changer de taille.
    const lower = corners(fitViewMargins(HOUSE, PHONE, insets, { x: 30, top: 36, bottom: 20 }));
    expect(lower.a.y - a.y).toBeCloseTo(8, 6);
    expect(lower.b.x - lower.a.x).toBeCloseTo(b.x - a.x, 6);
  });

  it('outil « contour » : la pastille du haut garde au moins 10 px sous les boutons de l’outil', () => {
    const insets = hudInsets(PHONE, HUD.outline)!;
    const { a } = corners(fitViewMargins(HOUSE, PHONE, insets, COMPACT_MARGIN.outline));
    const pillTop = a.y - LENGTH_PILL.gap - LENGTH_PILL.height;
    const buttonsBottom = 80;
    expect(pillTop - buttonsBottom).toBeGreaterThanOrEqual(10);
  });
});

describe('cibles des petites pièces', () => {
  const view: View = { scale: 0.2, tx: 0, ty: 0 };
  const room = (id: string, x: number, y: number, w: number, h: number): Room => ({
    id,
    name: id,
    area: { value: (w * h) / 10000, from: 'plan' },
    heated: true,
    needsReview: false,
    polygon: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  });
  // Séjour 106 × 150 px ; WC 27 × 38 px et buanderie 51 × 38 px côte à côte, au-dessus d'un hall 81 × 44 px.
  const sejour = room('sejour', 0, 0, 530, 750);
  const wc = room('wc', 530, 0, 135, 190);
  const buanderie = room('buanderie', 665, 0, 255, 190);
  const hall = room('hall', 530, 190, 405, 220);
  const rooms = [sejour, wc, buanderie, hall];
  const label = (r: Room): string => r.name;

  it('44 px au doigt, 24 px à la souris ou au stylet', () => {
    expect(roomMinTarget('touch')).toBe(44);
    expect(roomMinTarget('mouse')).toBe(24);
    expect(roomMinTarget('pen')).toBe(24);
  });

  it('la zone d’une petite pièce est agrandie jusqu’à la cible minimale, centrée sur elle', () => {
    const t = roomTarget(wc, view, 44)!;
    expect(t.width).toBe(44);
    expect(t.height).toBe(44);
    expect(t.enlarged).toBe(true);
    expect(t.x + t.width / 2).toBeCloseTo(119.5, 9);
    const big = roomTarget(sejour, view, 44)!;
    expect(big.enlarged).toBe(false);
    expect(big.width).toBeCloseTo(106, 9);
    expect(roomTarget({ polygon: undefined }, view, 44)).toBeNull();
  });

  it('un toucher juste à côté du WC, dans le séjour, désigne le WC ; sans cible minimale, le séjour', () => {
    const justLeft = { x: 100, y: 19 }; // 6 px à gauche du WC, dans le séjour
    expect(hitRoom(rooms, view, justLeft, label)).toBe('sejour');
    expect(hitRoom(rooms, view, justLeft, label, 44)).toBe('wc');
    // À la souris (24 px) le WC, déjà plus large que cela, n'est pas agrandi vers la gauche.
    expect(hitRoom(rooms, view, justLeft, label, 24)).toBe('sejour');
  });

  it('un toucher DANS une petite pièce la désigne toujours, même dans la marge d’une voisine', () => {
    // 3 px à l'intérieur de la buanderie, près du WC (dont la zone agrandie déborde ici).
    expect(hitRoom(rooms, view, { x: 136, y: 19 }, label, 44)).toBe('buanderie');
    expect(hitRoom(rooms, view, { x: 120, y: 19 }, label, 44)).toBe('wc');
    // Sous les deux, dans le hall (44 px de haut : pas agrandi) : la plus proche des deux petites pièces.
    expect(hitRoom(rooms, view, { x: 122, y: 40 }, label, 44)).toBe('wc');
    expect(hitRoom(rooms, view, { x: 160, y: 40 }, label, 44)).toBe('buanderie');
  });

  it('loin de toute petite pièce, rien ne change', () => {
    expect(hitRoom(rooms, view, { x: 50, y: 100 }, label, 44)).toBe('sejour');
    expect(hitRoom(rooms, view, { x: 150, y: 70 }, label, 44)).toBe('hall');
    expect(hitRoom(rooms, view, { x: 300, y: 300 }, label, 44)).toBeNull();
  });

  it('étiquette d’une pièce sans polygone : au moins 44 px de haut au doigt', () => {
    const tag: Room = { id: 'tag', name: 'Hall', area: { value: 2.25, from: 'plan' }, heated: true, needsReview: false, at: { x: 2000, y: 2000 } };
    // Étiquette dessinée : 26 px de haut, centrée en (400, 400).
    expect(hitRoom([tag], view, { x: 400, y: 418 }, label)).toBeNull();
    expect(hitRoom([tag], view, { x: 400, y: 418 }, label, 44)).toBe('tag');
    expect(hitRoom([tag], view, { x: 400, y: 425 }, label, 44)).toBeNull();
  });
});

describe('légende des façades (ux-17)', () => {
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };

  it('une entrée à 0 m n’est plus atténuée par transparence : texte en gris lisible', () => {
    const empty = rule('.p2c-plan__legend li.is-empty');
    expect(empty).not.toMatch(/opacity/);
    expect(empty).toMatch(/color:\s*var\(--_muted\)/);
  });

  it('le gris « muted » par défaut tient 4,5:1 sur la surface, en clair comme en sombre', () => {
    const luminance = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const tokens = (name: string): string[] => [...css.matchAll(new RegExp(`--_${name}: var\\(--p2c-${name}, (#[0-9a-f]{6})\\)`, 'g'))].map((m) => m[1]!);
    const muted = tokens('muted');
    const surface = tokens('surface');
    // Clair, sombre du système, sombre imposé par la page (data-theme) : ces deux derniers portent les mêmes valeurs.
    expect(muted).toHaveLength(3);
    expect(surface).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect(contrast(muted[i]!, surface[i]!), `${muted[i]} sur ${surface[i]}`).toBeGreaterThanOrEqual(4.5);
  });
});
