// @vitest-environment jsdom
/**
 * Gestes des outils dans un navigateur simulé : l'outil est monté avec un contexte qui joue l'éditeur (le
 * contrôleur reçoit les touchers et les touches, `commit` met l'étage à jour comme le shell).
 *  - ux-18 : le premier toucher sur une façade ne change rien ; le choix se fait dans la bulle.
 *  - ux-04 : longueurs exactes — tapées pendant le tracé, saisies dans une pastille en correction.
 *  - ux-07 : cibles des petites pièces, étiquettes d'ouvertures et boussole sur téléphone.
 */
import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lang, Opening, PlanSheet, Room, Storey, Vec2 } from '../../../src/core/types';
import { createEmptyProject, createStorey } from '../../../src/engine';
import { t } from '../../../src/i18n';
import { demoSheet } from '../../../src/ui/plan/dev/demoSheet';
import { lengthLabels } from '../../../src/ui/plan/labels';
import '../../../src/ui/plan/messages';
import type { PointerInfo, ToolContext, ToolController } from '../../../src/ui/plan/toolTypes';
import { BoundaryTool } from '../../../src/ui/plan/tools/BoundaryTool';
import { NorthTool } from '../../../src/ui/plan/tools/NorthTool';
import { OpeningTool } from '../../../src/ui/plan/tools/OpeningTool';
import { OutlineTool } from '../../../src/ui/plan/tools/OutlineTool';
import { RoomsTool } from '../../../src/ui/plan/tools/RoomsTool';
import { fitView, screenToSheet, sheetToScreen } from '../../../src/ui/plan/view';
import type { View } from '../../../src/ui/plan/view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const model = createEmptyProject('fr').model;

/** Rectangle 10 × 8 m sur la grille vierge (1 unité = 1 m) : côtés 0 = haut, 1 = droite, 2 = bas, 3 = gauche. */
const RECT: Vec2[] = [
  { x: 2, y: 2 },
  { x: 12, y: 2 },
  { x: 12, y: 10 },
  { x: 2, y: 10 },
];
/** 20 px par mètre, sans décalage : le point (x, y) m est à l'écran en (20x, 20y). */
const VIEW: View = { scale: 20, tx: 0, ty: 0 };

function blankStorey(partial: Partial<Storey> = {}): Storey {
  return { ...createStorey(null, 'Rez-de-chaussée', model), ...partial };
}

function rectStorey(partial: Partial<Storey> = {}): Storey {
  return blankStorey({ outline: RECT.map((p) => ({ ...p })), edges: RECT.map(() => ({ boundary: 'outside' as const, constructionId: null })), ...partial });
}

interface Harness {
  root: Root;
  container: HTMLElement;
  controller: { current: ToolController | null };
  commits: Storey[];
  done: { count: number };
  /** Demandes de recadrage faites à l'éditeur (saisie qui change la taille du contour). */
  reframes: { count: number };
  storey(): Storey;
}

interface Options {
  storey: Storey;
  sheet?: PlanSheet | null;
  view?: View;
  size?: { width: number; height: number };
  lang?: Lang;
  compact?: boolean;
  coarse?: boolean;
  magnet?: boolean;
}

let mounted: Harness | null = null;

async function mount(Tool: (props: { ctx: ToolContext }) => ReactElement, options: Options): Promise<Harness> {
  const controller: { current: ToolController | null } = { current: null };
  const commits: Storey[] = [];
  const done = { count: 0 };
  const reframes = { count: 0 };
  let latest = options.storey;
  const size = options.size ?? { width: 900, height: 600 };
  const lang = options.lang ?? 'fr';
  function Host() {
    const [storey, setStorey] = useState(options.storey);
    latest = storey;
    const ctx: ToolContext = {
      view: options.view ?? VIEW,
      size,
      sheet: options.sheet ?? null,
      index: null,
      storey,
      ghostStoreys: [],
      northAngle: 0,
      lang,
      tr: (key, params) => t(lang, key, params),
      windowTypes: model.windowTypes,
      compact: options.compact ?? false,
      magnet: options.magnet ?? true,
      setMagnet: () => undefined,
      commit: (next) => {
        commits.push(next);
        setStorey(next);
      },
      done: () => {
        done.count += 1;
      },
      changeNorth: () => undefined,
      coarse: options.coarse ?? false,
      aim: () => undefined,
      cover: () => undefined,
      reframe: () => {
        reframes.count += 1;
      },
      controller,
      focusSurface: () => undefined,
    };
    return <Tool ctx={ctx} />;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Host />);
  });
  mounted = { root, container, controller, commits, done, reframes, storey: () => latest };
  return mounted;
}

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
});

const pointer = (screen: Vec2, pointerType = 'mouse', view: View = VIEW): PointerInfo => ({ screen, sheet: screenToSheet(view, screen), pointerType, altKey: false, shiftKey: false });
const q = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector));
const keyInfo = (key: string) => ({ key, shiftKey: false, altKey: false, ctrlKey: false, repeat: false });

async function tap(h: Harness, screen: Vec2, pointerType = 'mouse', view: View = VIEW): Promise<void> {
  await act(async () => h.controller.current?.tap?.(pointer(screen, pointerType, view)));
}
async function hover(h: Harness, screen: Vec2, view: View = VIEW): Promise<void> {
  await act(async () => h.controller.current?.hover?.(pointer(screen, 'mouse', view)));
}
/** Touche reçue par la zone de plan ; renvoie vrai si l'outil l'a prise. */
async function press(h: Harness, key: string): Promise<boolean> {
  let handled = false;
  await act(async () => {
    handled = h.controller.current?.key?.(keyInfo(key)) ?? false;
  });
  return handled;
}
async function typeKeys(h: Harness, text: string): Promise<boolean[]> {
  const out: boolean[] = [];
  for (const ch of text) out.push(await press(h, ch));
  return out;
}
async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('élément introuvable');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}
async function keydown(el: Element | null, key: string): Promise<void> {
  if (!el) throw new Error('élément introuvable');
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}
async function fill(el: HTMLInputElement | null, value: string): Promise<void> {
  if (!el) throw new Error('champ introuvable');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const pillTexts = (): string[] => all<SVGGElement>('.p2c-plan__len').map((g) => g.textContent ?? '');
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const rounded = (pts: readonly Vec2[]): number[][] => pts.map((p) => [Number(p.x.toFixed(6)), Number(p.y.toFixed(6))]);

// ───────────────────────────── ux-18 : façades ─────────────────────────────

describe('façades : désigner, puis choisir', () => {
  const topEdge = sheetToScreen(VIEW, mid(RECT[0]!, RECT[1]!));

  it('le premier toucher sur une façade ne modifie rien : il ouvre les quatre choix, l’actuel marqué', async () => {
    const h = await mount(BoundaryTool, { storey: rectStorey() });
    await tap(h, topEdge, 'touch');
    expect(h.commits).toHaveLength(0);
    expect(h.storey().edges.map((e) => e.boundary)).toEqual(['outside', 'outside', 'outside', 'outside']);
    expect(q('[data-testid="plan-boundary-popover"]')).not.toBeNull();
    const choices = all<HTMLButtonElement>('[data-testid="plan-boundary-choices"] button');
    expect(choices.map((b) => b.dataset.value)).toEqual(['outside', 'heated', 'unheated', 'ground']);
    expect(choices.map((b) => b.getAttribute('aria-current'))).toEqual(['true', null, null, null]);
    // Le choix actuel n'est pas signalé par la seule couleur : coche et texte lu.
    expect(choices[0]!.textContent).toContain('✓');
    expect(choices[0]!.textContent).toContain('choix actuel');
    // La façade désignée est mise en évidence.
    expect(q<SVGLineElement>('line[data-edge="0"]')!.classList.contains('is-hot')).toBe(true);
  });

  it('la façade change quand on touche un choix — une seule émission — et la bulle se referme', async () => {
    const h = await mount(BoundaryTool, { storey: rectStorey() });
    await tap(h, topEdge, 'touch');
    await click(q('[data-testid="plan-boundary-choices"] button[data-value="heated"]'));
    expect(h.commits).toHaveLength(1);
    expect(h.storey().edges.map((e) => e.boundary)).toEqual(['heated', 'outside', 'outside', 'outside']);
    expect(q('[data-testid="plan-boundary-popover"]')).toBeNull();
    // Rouvrir : le nouveau choix est marqué ; toucher le choix déjà actuel ne réémet rien.
    await tap(h, topEdge, 'touch');
    expect(q('[data-testid="plan-boundary-choices"] button[aria-current="true"]')!.getAttribute('data-value')).toBe('heated');
    await click(q('[data-testid="plan-boundary-choices"] button[data-value="heated"]'));
    expect(h.commits).toHaveLength(1);
    expect(q('[data-testid="plan-boundary-popover"]')).toBeNull();
  });

  it('regarder sans modifier : toucher, puis Échap ou toucher à côté', async () => {
    const h = await mount(BoundaryTool, { storey: rectStorey() });
    await tap(h, topEdge);
    expect(await press(h, 'Escape')).toBe(true);
    expect(q('[data-testid="plan-boundary-popover"]')).toBeNull();
    await tap(h, topEdge);
    await tap(h, { x: 600, y: 500 });
    expect(q('[data-testid="plan-boundary-popover"]')).toBeNull();
    // Plusieurs touchers de suite sur la même façade : toujours rien (l'ancien outil la faisait tourner à chaque fois).
    for (let i = 0; i < 3; i++) await tap(h, topEdge);
    expect(h.commits).toHaveLength(0);
  });

  it('au clavier : Entrée sur la façade ouvre les choix, les flèches se promènent sans rien changer, Entrée choisit', async () => {
    const h = await mount(BoundaryTool, { storey: rectStorey() });
    const line = q<SVGLineElement>('line[data-edge="1"]')!;
    expect(line.getAttribute('role')).toBe('button');
    expect(line.getAttribute('aria-label')).toContain('Extérieur');
    await act(async () => line.focus());
    await keydown(line, 'Enter');
    expect(h.commits).toHaveLength(0);
    const choices = all<HTMLButtonElement>('[data-testid="plan-boundary-choices"] button');
    expect(document.activeElement).toBe(choices[0]);
    await keydown(document.activeElement, 'ArrowDown');
    await keydown(document.activeElement, 'ArrowDown');
    expect(document.activeElement).toBe(choices[2]);
    await keydown(document.activeElement, 'ArrowUp');
    expect(document.activeElement).toBe(choices[1]);
    expect(h.commits).toHaveLength(0);
    // Entrée sur un bouton = clic.
    await click(document.activeElement);
    expect(h.commits).toHaveLength(1);
    expect(h.storey().edges[1]!.boundary).toBe('heated');
    // Le clavier revient sur la façade : on enchaîne avec Tab.
    expect(document.activeElement).toBe(q('line[data-edge="1"]'));
  });

  it('légende : les quatre états restent listés, ceux à 0 m marqués « is-empty » (texte lisible, voir compact.test)', async () => {
    await mount(BoundaryTool, { storey: rectStorey() });
    const items = all<HTMLLIElement>('[data-testid="plan-boundary-legend"] li');
    expect(items).toHaveLength(4);
    expect(items.map((li) => li.classList.contains('is-empty'))).toEqual([false, true, true, true]);
    expect(items[1]!.textContent).toContain('0,00 m');
  });
});

// ───────────────────────────── ux-04 : longueurs exactes ─────────────────────────────

describe('contour sur la grille vierge : longueurs tapées pendant le tracé', () => {
  it('chiffres + Entrée : le côté prend la longueur tapée dans la direction pointée ; une flèche donne la direction', async () => {
    const h = await mount(OutlineTool, { storey: blankStorey() });
    // Sans point posé, « 0 » reste le raccourci « ajuster » de l'éditeur.
    expect(await press(h, '0')).toBe(false);
    await tap(h, { x: 100, y: 100 }); // (5, 5) m
    await hover(h, { x: 220, y: 103 }); // vers la droite (accrochage : angle droit, grille)
    expect(await typeKeys(h, '9,24')).toEqual([true, true, true, true]);
    expect(q('.p2c-plan__label--typed')!.textContent).toContain('9,24 m');
    expect(await press(h, 'Enter')).toBe(true);
    expect(all('circle.p2c-plan__vertex')).toHaveLength(2);
    expect(q('.p2c-plan__label--typed')).toBeNull();
    // Le point décimal vaut la virgule ; la flèche pose le point sans la souris.
    await typeKeys(h, '11.37');
    expect(await press(h, 'ArrowDown')).toBe(true);
    await typeKeys(h, '9,24');
    await press(h, 'ArrowLeft');
    expect(all('circle.p2c-plan__vertex')).toHaveLength(4);
    expect(pillTexts()).toEqual(['9,24', '11,37', '9,24']);
    expect(h.commits).toHaveLength(0);
    // Entrée sans chiffres : fermer le contour.
    await press(h, 'Enter');
    expect(h.commits).toHaveLength(1);
    expect(h.done.count).toBe(1);
    expect(rounded(h.storey().outline)).toEqual([
      [5, 5],
      [14.24, 5],
      [14.24, 16.37],
      [5, 16.37],
    ]);
  });

  it('Retour arrière corrige la saisie avant de retirer un point ; Échap l’efface', async () => {
    const h = await mount(OutlineTool, { storey: blankStorey() });
    await tap(h, { x: 100, y: 100 });
    await hover(h, { x: 220, y: 100 });
    await typeKeys(h, '99');
    await press(h, 'Backspace');
    expect(q('.p2c-plan__label--typed')!.textContent).toContain('9 m');
    expect(all('circle.p2c-plan__vertex')).toHaveLength(1);
    await press(h, 'Escape');
    expect(q('.p2c-plan__label--typed')).toBeNull();
    expect(all('circle.p2c-plan__vertex')).toHaveLength(1);
    // Saisie vide : Échap retire le dernier point, comme avant.
    await press(h, 'Escape');
    expect(all('circle.p2c-plan__vertex')).toHaveLength(0);
  });

  it('une longueur est tapée : le clic ne donne que la direction', async () => {
    const h = await mount(OutlineTool, { storey: blankStorey() });
    await tap(h, { x: 100, y: 100 });
    await typeKeys(h, '7,5');
    await tap(h, { x: 100, y: 300 }); // vers le bas, 10 m plus loin : la longueur tapée l'emporte
    await typeKeys(h, '4');
    await press(h, 'ArrowRight');
    await press(h, 'Enter');
    expect(rounded(h.storey().outline)).toEqual([
      [5, 5],
      [5, 12.5],
      [9, 12.5],
    ]);
  });

  it('sans souris : Entrée pose le premier point au centre de la vue, sur la grille', async () => {
    const h = await mount(OutlineTool, { storey: blankStorey() });
    expect(await press(h, 'Enter')).toBe(true);
    expect(all('circle.p2c-plan__vertex')).toHaveLength(1);
    await typeKeys(h, '10');
    await press(h, 'ArrowRight');
    await typeKeys(h, '8');
    await press(h, 'ArrowDown');
    await press(h, 'Enter');
    // Centre de 900 × 600 px à 20 px/m : (22,5 ; 15) m, déjà sur la grille de 0,5 m.
    expect(rounded(h.storey().outline)).toEqual([
      [22.5, 15],
      [32.5, 15],
      [32.5, 23],
    ]);
  });

  it('« dernier côté » : un bouton ouvre un champ (clavier du téléphone) ; le dernier point glisse le long du côté', async () => {
    const h = await mount(OutlineTool, { storey: blankStorey(), compact: true, coarse: true, size: { width: 364, height: 338 } });
    expect(q('[data-testid="plan-trace-last-length"]')).toBeNull();
    await tap(h, { x: 60, y: 120 }, 'touch');
    await tap(h, { x: 240, y: 120 }, 'touch');
    const button = q<HTMLButtonElement>('[data-testid="plan-trace-last-length"]')!;
    expect(button.textContent).toContain('9,00');
    expect(button.getAttribute('aria-label')).toContain('9,00 m');
    await click(button);
    const input = q<HTMLInputElement>('[data-testid="plan-length-input"]')!;
    expect(input.value).toBe('9,00');
    expect(input.getAttribute('inputmode')).toBe('decimal');
    await fill(input, '9,24');
    expect(pillTexts()).toEqual(['9,24']); // aperçu en direct
    await click(q('[data-testid="plan-length-apply"]'));
    expect(q('[data-testid="plan-length-popover"]')).toBeNull();
    expect(button.isConnected ? q('[data-testid="plan-trace-last-length"]')!.textContent : '').toContain('9,24');
    await tap(h, { x: 240, y: 280 }, 'touch');
    await click(q('[data-testid="plan-trace-close"]'));
    expect(rounded(h.storey().outline)[1]).toEqual([12.24, 6]);
  });

  it('feuille à l’échelle (1 unité = 1 cm) : les mètres tapés sont convertis', async () => {
    const sheet = demoSheet();
    const empty: Storey = { ...createStorey(sheet, 'RDC', model), outline: [], edges: [], openings: [] };
    const view = fitView(sheet.bbox, { width: 900, height: 600 });
    const h = await mount(OutlineTool, { storey: empty, sheet, view, magnet: false });
    await click(q('[data-testid="plan-outline-trace"]')); // « Tracer moi-même »
    await tap(h, { x: 300, y: 200 }, 'mouse', view);
    await typeKeys(h, '9,24');
    await press(h, 'ArrowRight');
    await typeKeys(h, '5');
    await press(h, 'ArrowDown');
    await press(h, 'Enter');
    const out = h.storey().outline;
    expect(out[1]!.x - out[0]!.x).toBeCloseTo(924, 6);
    expect(out[2]!.y - out[1]!.y).toBeCloseTo(500, 6);
  });

  it('échelle seulement supposée : pas de saisie de longueur (il faut d’abord poser la règle)', async () => {
    const guess = demoSheet({ scaleKnown: false, withOutline: false });
    const storey = createStorey(guess, 'RDC', model);
    expect(storey.metresPerUnit.from).toBe('estimate');
    const view = fitView(guess.bbox, { width: 900, height: 600 });
    const h = await mount(OutlineTool, { storey, sheet: guess, view, magnet: false });
    await tap(h, { x: 300, y: 200 }, 'mouse', view);
    expect(await press(h, '9')).toBe(false);
    expect(q('.p2c-plan__label--typed')).toBeNull();
  });
});

describe('contour en correction : pastilles des longueurs', () => {
  const opening: Opening = { id: 's-o1', edgeIndex: 0, kind: 'window', width: 1.2, height: 1.35, count: 1, position: 0.25, windowTypeId: null, from: 'plan' };
  const dressed = (): Storey =>
    rectStorey({
      edges: [
        { boundary: 'outside', constructionId: null },
        { boundary: 'heated', constructionId: null },
        { boundary: 'ground', constructionId: null },
        { boundary: 'outside', constructionId: null },
      ],
      openings: [opening],
    });
  const pillCentre = (edge: number): Vec2 => {
    const l = lengthLabels(RECT, VIEW, 1).find((x) => x.edge === edge)!;
    return { x: l.x, y: l.y };
  };

  it('chaque longueur est un bouton nommé, atteignable au clavier', async () => {
    await mount(OutlineTool, { storey: dressed() });
    const pills = all<SVGGElement>('.p2c-plan__len');
    expect(pills.map((g) => g.textContent)).toEqual(['10,00', '8,00', '10,00', '8,00']);
    for (const g of pills) {
      expect(g.getAttribute('role')).toBe('button');
      expect(g.getAttribute('tabindex')).toBe('0');
    }
    expect(pills[0]!.getAttribute('aria-label')).toBe('Côté 1 : 10,00 m. Entrée pour saisir la longueur exacte.');
  });

  it('au clavier : Entrée ouvre la saisie, l’aperçu suit la frappe, Entrée applique — façades et ouvertures gardées', async () => {
    const h = await mount(OutlineTool, { storey: dressed() });
    const pill = q<SVGGElement>('.p2c-plan__len[data-length-edge="0"]')!;
    await act(async () => pill.focus());
    await keydown(pill, 'Enter');
    const input = q<HTMLInputElement>('[data-testid="plan-length-input"]')!;
    expect(input.value).toBe('10,00');
    expect(document.activeElement).toBe(input);
    await fill(input, '9,24');
    // Aperçu : le côté d'en face suit (les angles sont conservés), rien n'est encore émis.
    expect(pillTexts()).toEqual(['9,24', '8,00', '9,24', '8,00']);
    expect(h.commits).toHaveLength(0);
    expect(h.reframes.count).toBe(0);
    await click(q('[data-testid="plan-length-apply"]'));
    expect(h.commits).toHaveLength(1);
    // La taille du contour a changé par une saisie : l'éditeur est prié de recadrer la vue (si elle est automatique).
    expect(h.reframes.count).toBe(1);
    const next = h.storey();
    expect(rounded(next.outline)).toEqual([
      [2, 2],
      [11.24, 2],
      [11.24, 10],
      [2, 10],
    ]);
    expect(next.edges.map((e) => e.boundary)).toEqual(['outside', 'heated', 'ground', 'outside']);
    expect(next.openings).toEqual([opening]);
    expect(q('[data-testid="plan-length-popover"]')).toBeNull();
    // Le clavier revient sur la pastille : Tab mène à la longueur suivante.
    expect(document.activeElement).toBe(q('.p2c-plan__len[data-length-edge="0"]'));
  });

  it('au doigt : toucher la pastille ouvre la saisie ; toucher le « + » du milieu ajoute toujours un sommet', async () => {
    const h = await mount(OutlineTool, { storey: dressed(), coarse: true });
    await tap(h, pillCentre(1), 'touch');
    expect(q('[data-testid="plan-length-popover"]')).not.toBeNull();
    expect(q<HTMLInputElement>('[data-testid="plan-length-input"]')!.value).toBe('8,00');
    expect(h.commits).toHaveLength(0);
    // Toucher à côté : la saisie se referme, rien d'autre ne se passe.
    await tap(h, { x: 600, y: 500 }, 'touch');
    expect(q('[data-testid="plan-length-popover"]')).toBeNull();
    expect(h.commits).toHaveLength(0);
    // Le « + » du côté du haut (milieu du trait).
    await tap(h, sheetToScreen(VIEW, mid(RECT[0]!, RECT[1]!)), 'touch');
    expect(q('[data-testid="plan-length-popover"]')).toBeNull();
    expect(h.commits).toHaveLength(1);
    expect(h.storey().outline).toHaveLength(5);
  });

  it('saisie illisible ou qui replierait le contour : bouton inactif, message, rien n’est émis', async () => {
    const h = await mount(OutlineTool, { storey: dressed() });
    await tap(h, pillCentre(0));
    const input = q<HTMLInputElement>('[data-testid="plan-length-input"]')!;
    await fill(input, 'abc');
    expect(q<HTMLButtonElement>('[data-testid="plan-length-apply"]')!.disabled).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(q('[data-testid="plan-length-popover"] [role="alert"]')!.textContent).toContain('longueur en mètres');
    await fill(input, '12,5');
    expect(q<HTMLButtonElement>('[data-testid="plan-length-apply"]')!.disabled).toBe(false);
    expect(await press(h, 'Escape')).toBe(true);
    expect(q('[data-testid="plan-length-popover"]')).toBeNull();
    expect(h.commits).toHaveLength(0);
  });

  it('échelle supposée : les longueurs restent affichées (« ≈ ») mais ne se saisissent pas', async () => {
    const h = await mount(OutlineTool, { storey: rectStorey({ metresPerUnit: { value: 1, from: 'estimate' } }) });
    const pills = all<SVGGElement>('.p2c-plan__len');
    expect(pills.map((g) => g.textContent)).toEqual(['≈ 10,00', '≈ 8,00', '≈ 10,00', '≈ 8,00']);
    for (const g of pills) expect(g.getAttribute('role')).toBeNull();
    await tap(h, pillCentre(0));
    expect(q('[data-testid="plan-length-popover"]')).toBeNull();
  });

  it('en allemand aussi', async () => {
    await mount(OutlineTool, { storey: dressed(), lang: 'de' });
    const pill = q<SVGGElement>('.p2c-plan__len[data-length-edge="2"]')!;
    expect(pill.getAttribute('aria-label')).toBe('Seite 3: 10,00 m. Eingabe, um die genaue Länge einzugeben.');
    await keydown(pill, 'Enter');
    expect(q('[data-testid="plan-length-popover"]')!.textContent).toContain('Länge von Seite 3');
    expect(q('[data-testid="plan-length-apply"]')!.textContent).toBe('Übernehmen');
  });
});

// ───────────────────────────── ux-07 : téléphone ─────────────────────────────

describe('téléphone : pièces, ouvertures, boussole', () => {
  const PHONE = { width: 364, height: 338 };

  it('pièces : un toucher au doigt juste à côté d’un WC de 27 px le bascule ; chaque pièce expose une cible ≥ 44 px', async () => {
    const room = (id: string, x: number, y: number, w: number, h: number): Room => ({
      id,
      name: id,
      area: { value: w * h, from: 'plan' },
      heated: true,
      needsReview: false,
      polygon: [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
    });
    // À 20 px/m : séjour 106 × 150 px, WC 27 × 38 px.
    const storey = rectStorey({ rooms: [room('sejour', 2, 2, 5.3, 7.5), room('wc', 7.3, 2, 1.35, 1.9)] });
    const h = await mount(RoomsTool, { storey, compact: true, coarse: true, size: PHONE });
    const targets = all<SVGRectElement>('.p2c-plan__room-hit').map((r) => ({ w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height')) }));
    expect(targets).toHaveLength(2);
    for (const target of targets) {
      expect(target.w).toBeGreaterThanOrEqual(44);
      expect(target.h).toBeGreaterThanOrEqual(44);
    }
    // 6 px à gauche du WC (x = 146 px), dans le séjour.
    await tap(h, { x: 140, y: 59 }, 'touch');
    expect(h.commits).toHaveLength(1);
    expect(h.storey().rooms.map((r) => r.heated)).toEqual([true, false]);
    // À la souris, la même position reste le séjour.
    await tap(h, { x: 140, y: 59 }, 'mouse');
    expect(h.storey().rooms.map((r) => r.heated)).toEqual([false, false]);
  });

  it('ouvertures : sur téléphone le texte suit les façades raides ; sur grand écran il reste horizontal', () => {
    const side: Opening = { id: 's-o9', edgeIndex: 1, kind: 'door', width: 1, height: 2.1, count: 1, position: 0.5, windowTypeId: null, from: 'default' };
    const storey = rectStorey({ openings: [side] });
    const ctxOf = (compact: boolean): ToolContext => ({
      view: VIEW,
      size: compact ? PHONE : { width: 900, height: 600 },
      sheet: null,
      index: null,
      storey,
      ghostStoreys: [],
      northAngle: 0,
      lang: 'fr',
      tr: (key, params) => t('fr', key, params),
      windowTypes: model.windowTypes,
      compact,
      magnet: true,
      setMagnet: () => undefined,
      commit: () => undefined,
      done: () => undefined,
      changeNorth: () => undefined,
      coarse: compact,
      aim: () => undefined,
      cover: () => undefined,
      reframe: () => undefined,
      controller: { current: null },
      focusSurface: () => undefined,
    });
    const phone = renderToString(<OpeningTool ctx={ctxOf(true)} />);
    const desktop = renderToString(<OpeningTool ctx={ctxOf(false)} />);
    const label = /<text[^>]*p2c-plan__label--opening[^>]*>/;
    expect(phone.match(label)![0]).toContain('transform="rotate(-90');
    expect(desktop.match(label)![0]).not.toContain('transform=');
    expect(phone).toContain('Touchez une façade pour y poser une ouverture.');
    expect(desktop).toContain('Touchez une façade pour y poser une fenêtre ou une porte.');
    // Rappel de surface masqué sur téléphone (classe « secondary ») dans les outils qui ne la modifient pas.
    const boundary = renderToString(<BoundaryTool ctx={ctxOf(true)} />);
    expect(boundary).toMatch(/p2c-plan__counter--secondary[^>]*data-testid="plan-counter-area"/);
  });

  it('boussole : consigne courte, secteur au-dessus de l’azimut le long des façades raides', async () => {
    await mount(NorthTool, { storey: rectStorey(), compact: true, coarse: true, size: PHONE });
    expect(q('.p2c-plan__hint')!.textContent).toBe('Tournez l’aiguille vers le nord du plan.');
    const facades = all<SVGTextElement>('.p2c-plan__label--facade');
    expect(facades).toHaveLength(4);
    // Haut (N) et bas (S) sur une ligne ; droite (E) et gauche (W) sur deux lignes ancrées au même x.
    const stacked = facades.filter((f) => f.querySelectorAll('tspan[x]').length === 2);
    expect(stacked.map((f) => f.querySelector('tspan')!.textContent).sort()).toEqual(['E', 'W']);
    const spans = (f: SVGTextElement): string => Array.from(f.querySelectorAll('tspan'), (s) => s.textContent).join(' ');
    expect(facades.map(spans).sort()).toEqual(['E 90°', 'N 0°', 'S 180°', 'W 270°']);
    // Toutes les commandes restent là : rose, quatre rotations, champ d'azimut nommé, validation.
    expect(q('[data-testid="plan-rose"]')!.getAttribute('role')).toBe('slider');
    for (const id of ['plan-north-l45', 'plan-north-l5', 'plan-north-r5', 'plan-north-r45', 'plan-north-input', 'plan-north-ok']) {
      expect(q(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    expect(q('[data-testid="plan-north-input"]')!.closest('label')!.textContent).toContain('Azimut du haut du plan');
  });
});
