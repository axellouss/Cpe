// @vitest-environment jsdom
/**
 * L'éditeur entier sur un téléphone simulé (ux-07) : la mise en page n'existe pas dans jsdom, on lui fournit donc
 * les tailles — zone de plan de 364 × 338 px, et pour chaque élément d'interface la boîte relevée dans un vrai
 * navigateur. On vérifie le câblage : mesure de l'interface → cadrage du contour → recadrage au changement d'outil,
 * tant que l'utilisateur n'a pas bougé la vue.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Storey, Vec2 } from '../../../src/core/types';
import { createEmptyProject, createStorey } from '../../../src/engine';
import { PlanEditor } from '../../../src/ui/plan';
import type { PlanTool } from '../../../src/ui/plan';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const model = createEmptyProject('fr').model;
const PHONE = { width: 364, height: 338 };

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Boîtes de l'interface par classe, telles qu'un téléphone les dessine (px dans la zone de plan). */
const LAYOUT: Record<string, Box> = {
  'p2c-plan__hint': { left: 6, top: 6, right: 300, bottom: 36 },
  'p2c-plan__actions': { left: 6, top: 40, right: 304, bottom: 80 },
  'p2c-plan__legend': { left: 6, top: 284, right: 310, bottom: 328 },
  'p2c-plan__status': { left: 6, top: 306, right: 310, bottom: 332 },
  'p2c-plan__nav': { left: 316, top: 170, right: 358, bottom: 332 },
  'p2c-plan__compass': { left: 6, top: 250, right: 310, bottom: 332 },
};

function boxOf(el: Element): Box | null {
  if (el.classList.contains('p2c-plan')) return { left: 0, top: 0, right: PHONE.width, bottom: PHONE.height };
  // Dans l'outil « façades », la légende est au-dessus de la rangée de compteurs (vide sur téléphone).
  if (el.classList.contains('p2c-plan__status') && el.closest('.p2c-plan')?.getAttribute('data-tool') !== 'outline') return null;
  for (const [cls, box] of Object.entries(LAYOUT)) if (el.classList.contains(cls)) return box;
  return null;
}

const saved: { rect?: PropertyDescriptor; width?: PropertyDescriptor; height?: PropertyDescriptor; media?: typeof window.matchMedia; context?: PropertyDescriptor } = {};

beforeEach(() => {
  saved.rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  saved.width = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  saved.height = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  saved.context = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
  saved.media = window.matchMedia;
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      const b = boxOf(this) ?? { left: 0, top: 0, right: 0, bottom: 0 };
      return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b };
    },
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) {
      return this.classList.contains('p2c-plan') ? PHONE.width : 0;
    },
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      return this.classList.contains('p2c-plan') ? PHONE.height : 0;
    },
  });
  // Pas de <canvas> dans jsdom : l'éditeur sait s'en passer.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => null });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  if (saved.rect) Object.defineProperty(Element.prototype, 'getBoundingClientRect', saved.rect);
  if (saved.width) Object.defineProperty(Element.prototype, 'clientWidth', saved.width);
  if (saved.height) Object.defineProperty(Element.prototype, 'clientHeight', saved.height);
  if (saved.context) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', saved.context);
  if (saved.media) window.matchMedia = saved.media;
});

/** Maison de 10 × 8 m sur la grille vierge. */
const RECT: Vec2[] = [
  { x: 3, y: 2 },
  { x: 13, y: 2 },
  { x: 13, y: 10 },
  { x: 3, y: 10 },
];
const house: Storey = {
  ...createStorey(null, 'Rez-de-chaussée', model),
  outline: RECT,
  edges: RECT.map(() => ({ boundary: 'outside' as const, constructionId: null })),
};

async function show(tool: PlanTool, storey: Storey = house): Promise<void> {
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(
      <PlanEditor
        sheet={null}
        storey={storey}
        northAngle={0}
        tool={tool}
        lang="fr"
        constructions={model.constructions}
        windowTypes={model.windowTypes}
        onStoreyChange={() => undefined}
        onNorthChange={() => undefined}
      />,
    );
  });
}

/** Emprise du contour dessiné (lignes des arêtes du calque de l'outil). */
function outlineBox(): Box {
  const lines = Array.from(document.querySelectorAll<SVGLineElement>('svg.p2c-plan__overlay line[data-edge]'));
  expect(lines.length).toBeGreaterThanOrEqual(4);
  const xs = lines.flatMap((l) => [Number(l.getAttribute('x1')), Number(l.getAttribute('x2'))]);
  const ys = lines.flatMap((l) => [Number(l.getAttribute('y1')), Number(l.getAttribute('y2'))]);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function hudBoxes(): Box[] {
  const out: Box[] = [];
  for (const el of document.querySelectorAll('.p2c-plan__top > *, .p2c-plan__bottom > *, .p2c-plan__nav, .p2c-plan__compass')) {
    const b = boxOf(el);
    if (b) out.push(b);
  }
  return out;
}

const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('éditeur sur téléphone : le contour garde l’écran', () => {
  it('se présente en mode téléphone', async () => {
    await show('north');
    expect(document.querySelector('[data-testid="plan-editor"]')!.classList.contains('is-compact')).toBe(true);
    expect(document.querySelector('[data-testid="plan-compass"]')).not.toBeNull();
  });

  it('à chaque étape, le contour occupe au moins 55 % de la largeur et aucun élément d’interface ne le recouvre', async () => {
    for (const tool of ['outline', 'boundary', 'opening', 'north', 'rooms', 'scale'] as PlanTool[]) {
      await show(tool);
      const box = outlineBox();
      expect((box.right - box.left) / PHONE.width, tool).toBeGreaterThanOrEqual(0.55);
      const hud = hudBoxes();
      expect(hud.length, tool).toBeGreaterThanOrEqual(2);
      for (const b of hud) expect(overlaps(box, b), `${tool} : ${JSON.stringify(b)}`).toBe(false);
      // Et il reste entièrement dans la zone de plan.
      expect(box.left).toBeGreaterThan(0);
      expect(box.top).toBeGreaterThan(0);
      expect(box.right).toBeLessThan(PHONE.width);
      expect(box.bottom).toBeLessThan(PHONE.height);
    }
  });

  it('étape « nord » : le contour n’est plus réduit à quelques pixels par la boussole', async () => {
    await show('north');
    const box = outlineBox();
    // Avant : 16 × 13 px. La boussole (bandeau bas de 82 px) laisse maintenant le plan au contour.
    expect(box.right - box.left).toBeGreaterThan(190);
    expect(box.bottom - box.top).toBeGreaterThan(150);
    expect(box.bottom).toBeLessThan(LAYOUT['p2c-plan__compass']!.top);
  });

  it('la vue suit le changement d’outil ; un zoom à la main vaut pour l’étape en cours, la suivante repart cadrée', async () => {
    await show('outline');
    const outline = outlineBox();
    await show('north');
    const north = outlineBox();
    // L'interface n'est pas la même (boutons en haut pour le contour, boussole en bas pour le nord) : le cadrage suit.
    expect(north.top).toBeLessThan(outline.top - 10);
    // Zoom avant au bouton : la vue devient celle de l'utilisateur.
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="plan-zoom-in"]')!.click();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    const zoomed = outlineBox();
    expect(zoomed.right - zoomed.left).toBeGreaterThan((north.right - north.left) * 1.3);
    // Sur un téléphone, l'étape suivante repart d'un plan cadré : sinon les façades resteraient hors de l'écran,
    // sous une interface qui n'est plus la même (constat de la contre-vérification).
    await show('boundary');
    const next = outlineBox();
    expect(next).not.toEqual(zoomed);
    expect((next.right - next.left) / PHONE.width).toBeGreaterThanOrEqual(0.55);
    expect(next.left).toBeGreaterThanOrEqual(0);
    expect(next.right).toBeLessThanOrEqual(PHONE.width);
    for (const b of hudBoxes()) expect(overlaps(next, b)).toBe(false);
    // Dans l'étape, le zoom fait à la main est gardé ; « Ajuster » rend la main au cadrage automatique.
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="plan-zoom-in"]')!.click();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(outlineBox().right - outlineBox().left).toBeGreaterThan((next.right - next.left) * 1.3);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="plan-fit"]')!.click();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    const fitted = outlineBox();
    expect((fitted.right - fitted.left) / PHONE.width).toBeGreaterThanOrEqual(0.55);
    for (const b of hudBoxes()) expect(overlaps(fitted, b)).toBe(false);
  });

  it('outil « pièces » : une pièce dessinée juste à côté du contour (garage) reste à l’écran', async () => {
    const garage = {
      id: 'g',
      name: 'Garage',
      area: { value: 13.2, from: 'plan' as const },
      heated: false,
      needsReview: false,
      polygon: [
        { x: 13, y: 5 },
        { x: 16.5, y: 5 },
        { x: 16.5, y: 9 },
        { x: 13, y: 9 },
      ],
    };
    await show('rooms', { ...house, rooms: [garage] });
    const shape = document.querySelector<SVGPolygonElement>('.p2c-plan__room-shape')!;
    const xs = shape.getAttribute('points')!.trim().split(/\s+/).map((p) => Number(p.split(',')[0]));
    // Entièrement à gauche de la colonne de navigation.
    expect(Math.max(...xs)).toBeLessThan(LAYOUT['p2c-plan__nav']!.left);
    const box = outlineBox();
    expect((box.right - box.left) / PHONE.width).toBeGreaterThanOrEqual(0.55);
  });
});
