// @vitest-environment jsdom
/**
 * Parcours du plan, vu par l'expert : ce que disent les jauges et l'indicateur d'étapes, la hauteur d'étage comme
 * étape du guide, l'échelle confirmée une fois par dessin, une seule commande de validation par étape, le rappel
 * des étapes non confirmées sur la page de résultat, et le bandeau des étapes qui suit l'étape active.
 * L'éditeur de plan (canvas) est remplacé par un bouchon ; les lecteurs sont simulés ; le moteur est le vrai.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDocument } from '../../../src/core/types';
import { App } from '../../../src/ui/shell';
import { currentStorey, selectMarks, selectProject } from '../../../src/ui/shell/store';
import { doc, houseDoc, sheet, testStore } from './helpers';
import type { TestStore } from './helpers';

const readers = vi.hoisted(() => {
  class UnsupportedFormatError extends Error {
    constructor(
      public readonly format: string,
      public readonly fileName: string,
    ) {
      super(`Format non lisible : ${fileName}`);
    }
  }
  return { UnsupportedFormatError, documents: new Map<string, unknown>() };
});

vi.mock('../../../src/readers', () => ({
  UnsupportedFormatError: readers.UnsupportedFormatError,
  readPlanFile: async (f: { name: string }) => {
    const found = readers.documents.get(f.name);
    if (!found) throw new Error('lecture impossible');
    return found;
  },
}));

// Bouchon de l'éditeur de plan : il montre l'outil reçu et joue « terminer l'outil » (le bouton que l'éditeur porte).
vi.mock('../../../src/ui/plan', async () => {
  const React = await import('react');
  type Props = import('../../../src/ui/plan').PlanEditorProps;
  const PlanEditor = (props: Props) =>
    React.createElement(
      'div',
      { 'data-testid': 'stub-editor', 'data-tool': props.tool },
      React.createElement('button', { type: 'button', 'data-testid': 'stub-done', onClick: () => props.onToolDone?.(props.tool) }, 'terminer'),
    );
  return { PlanEditor };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted extends TestStore {
  container: HTMLElement;
  root: Root;
}

let mounted: Mounted | null = null;

async function mount(test: TestStore = testStore()): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<App store={test.store} />);
  });
  mounted = { ...test, container, root };
  return mounted;
}

const q = (testId: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`élément introuvable : ${testId}`);
  return el;
};
const all = (testId: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
const has = (testId: string): boolean => document.querySelector(`[data-testid="${testId}"]`) !== null;

async function click(target: HTMLElement | string): Promise<void> {
  const el = typeof target === 'string' ? q(target) : target;
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function type(testId: string, value: string): Promise<void> {
  const el = q(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    el.focus();
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    el.blur();
  });
}

/** Dépose un document simulé et accepte la lecture : on arrive sur le plan. */
async function openPlan(document: PlanDocument): Promise<Mounted> {
  readers.documents.set(document.fileName, document);
  const m = await mount();
  await act(async () => {
    await m.store.getState().ingestFiles([{ name: document.fileName, arrayBuffer: async () => new ArrayBuffer(4) }]);
  });
  await click('accept-read');
  return m;
}

const meter = (tone: 'complete' | 'confirmed'): number => Number(document.querySelector(`.meter--${tone} [role="progressbar"]`)?.getAttribute('aria-valuenow'));
const stepWork = (step: string): string | null => q(`step-${step}`).closest('li')?.getAttribute('data-work') ?? null;
const stepHasCheck = (step: string): boolean => q(`step-${step}`).querySelector('.steps__num svg') !== null;
const tabProgress = (): string[] => all('storey-tab').map((t) => (t.querySelector('.tabs__progress svg') ? 'coche' : (t.querySelector('.tabs__progress')?.textContent ?? '')));
const stepState = (key: string): string | null => q(`plan-step-${key}`).getAttribute('data-state');

beforeEach(() => {
  readers.documents.clear();
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = (() => undefined) as typeof window.scrollTo;
});

afterEach(async () => {
  if (mounted) {
    const { root, container, store } = mounted;
    await act(async () => {
      root.unmount();
    });
    container.remove();
    store.getState().dispose();
    mounted = null;
  }
  document.body.innerHTML = '';
});

describe('jauges et indicateur d’étapes : ce que l’expert a réellement validé', () => {
  it('rien n’est « confirmé » ni « complet à 100 % » tant que rien n’est validé ; chaque validation fait monter « confirmé »', async () => {
    const m = await openPlan(houseDoc());
    expect(tabProgress()).toEqual(['0/7', '0/7']);
    expect(meter('confirmed')).toBe(0);
    expect(meter('complete')).toBeGreaterThan(0);
    expect(meter('complete')).toBeLessThan(100); // hauteurs, toiture et plancher bas ne sont que des valeurs par défaut

    let last = meter('confirmed');
    const rises = (): void => {
      expect(meter('confirmed')).toBeGreaterThan(last);
      last = meter('confirmed');
    };
    await click('plan-confirm-scale');
    rises();
    await click('stub-done'); // « Le contour est bon », sur le plan
    rises();
    await click(all('height-chip')[1]!);
    rises();
    await click('plan-confirm-boundary');
    rises();
    await click('plan-confirm-opening');
    rises();
    await click('stub-done'); // « Le nord est bon », sur le plan
    rises();
    expect(selectMarks(m.store.getState()).plan[currentStorey(m.store.getState())!.id]).toEqual({ outline: true, boundary: true, opening: true });
    expect(meter('confirmed')).toBeLessThanOrEqual(meter('complete'));
  });

  it('l’indicateur d’étapes ne coche pas un plan traversé sans rien valider, et le signale « à compléter »', async () => {
    await openPlan(houseDoc());
    // Accueil et lecture sont faits ; le plan est l'étape courante.
    expect([stepHasCheck('home'), stepHasCheck('read'), stepHasCheck('plan')]).toEqual([true, true, false]);

    await click('to-questions');
    expect(has('question-closure')).toBe(true);
    expect(stepHasCheck('plan')).toBe(false);
    expect(stepWork('plan')).toBe('pending');
    expect(q('step-plan').textContent).toContain('reste à compléter');
    expect(q('step-plan').getAttribute('title')).toContain('reste à compléter');

    // La question indispensable répondue est cochée ; le plan, toujours pas.
    await click(q('q-top').querySelector<HTMLElement>('[data-value="flat-roof"]')!);
    await click(q('q-bottom').querySelector<HTMLElement>('[data-value="slab-on-ground"]')!);
    await click('q-continue');
    expect(has('guide-section')).toBe(true);
    expect(stepWork('questions')).toBe('done');
    expect(stepHasCheck('questions')).toBe(true);
    expect(stepHasCheck('plan')).toBe(false);
    expect(meter('confirmed')).toBeLessThan(30); // 2 réponses sur 16 cases
    expect(meter('complete')).toBeLessThan(100);
  });

  it('un étage n’est « prêt » (coche de l’onglet, coche du plan) qu’une fois ses sept étapes faites, hauteur comprise', async () => {
    const m = await mount();
    await click('start-blank');
    const state = m.store.getState();
    const storey = currentStorey(state)!;
    const outline = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 8 },
      { x: 0, y: 8 },
    ];
    await act(async () => {
      state.storeyChanged({ ...storey, outline, edges: outline.map(() => ({ boundary: 'outside' as const, constructionId: null })) });
      state.updateProject((p) => ({ ...p, model: { ...p.model, storeys: p.model.storeys.map((s) => ({ ...s, netAreaOverride: { value: 60, from: 'user' as const } })) } }));
      for (const key of ['outline', 'boundary', 'opening', 'north'] as const) m.store.getState().confirmPlanStep(key);
    });
    // Six étapes faites, hauteur encore par défaut : pas de coche, et le guide y ramène.
    expect(tabProgress()).toEqual(['6/7']);
    expect(document.body.textContent).not.toContain('« Rez-de-chaussée » est prêt.');
    expect(stepState('height')).toBe('todo');
    await click('step-result');
    expect(stepHasCheck('plan')).toBe(false);
    await click('step-plan');
    expect(m.store.getState().planStep).toBe('height');

    await click(all('height-chip')[0]!);
    expect(currentStorey(m.store.getState())?.grossHeight).toEqual({ value: 2.5, from: 'user' });
    expect(tabProgress()).toEqual(['coche']);
    expect(document.body.textContent).toContain('« Rez-de-chaussée » est prêt.');
    await click('step-result');
    expect(stepHasCheck('plan')).toBe(true);
  });
});

describe('hauteur d’étage dans le guide', () => {
  it('se choisit d’une pastille ou se saisit ; la hauteur libre reste facultative dans le panneau', async () => {
    const m = await openPlan(houseDoc());
    await click('plan-step-button-height');
    expect(q('stub-editor').getAttribute('data-tool')).toBe('pan');
    expect(q('plan-step-detail').textContent).toContain('Une vue en plan ne la montre pas');
    // Valeur par défaut : aucune pastille n'est « retenue », et aucun bouton ne propose de la confirmer telle quelle.
    expect(all('height-chip').map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'false', 'false']);
    expect(has('plan-confirm-height')).toBe(false);
    expect(has('height-confirm-gross')).toBe(false);
    expect(has('height-confirm-clear')).toBe(true);

    // Une valeur hors pastilles.
    await type('height-exact', '2,65');
    expect(currentStorey(m.store.getState())?.grossHeight).toEqual({ value: 2.65, from: 'user' });
    expect(stepState('height')).toBe('done');
    expect(m.store.getState().planStep).not.toBe('height'); // le guide est passé à la suite

    // Retour sur l'étape : la valeur saisie est rappelée ; une pastille la remplace d'un toucher ; un seul « annuler » la rétablit.
    await click('plan-step-button-height');
    expect(q('plan-step-detail').textContent).toContain('2,65 m, confirmée par vous');
    expect((q('height-exact') as HTMLInputElement).value).toBe('2,65');
    await click(all('height-chip')[4]!);
    expect(currentStorey(m.store.getState())?.grossHeight).toEqual({ value: 3, from: 'user' });
    await click('plan-step-button-height');
    expect(all('height-chip').map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'false', 'true']);
    await click('undo');
    expect(currentStorey(m.store.getState())?.grossHeight).toEqual({ value: 2.65, from: 'user' });
    // La hauteur libre n'a pas été touchée et ne bloque rien.
    expect(currentStorey(m.store.getState())?.clearHeight.from).toBe('default');
  });

  it('sous une toiture inclinée confirmée, le panneau du dernier étage ne propose ni hauteur brute ni volume calculé avec elle', async () => {
    const m = await openPlan(houseDoc());
    const [ground, upper] = selectProject(m.store.getState()).model.storeys;
    await act(async () => {
      m.store.getState().setTop({ kind: 'pitched-roof' }, undefined, true);
      m.store.getState().selectStorey(upper!.id);
    });
    expect(has('height-under-roof')).toBe(true);
    expect(q('height-under-roof').textContent).toContain('rien à saisir');
    expect(document.querySelector('.panel')?.textContent).not.toContain('Volume brut');
    // Les autres étages gardent leur hauteur brute et leur volume.
    await act(async () => {
      m.store.getState().selectStorey(ground!.id);
    });
    expect(has('height-under-roof')).toBe(false);
    expect(document.querySelector('.panel')?.textContent).toContain('Volume brut');
  });

  it('n’est pas demandée au dernier étage sous une toiture inclinée confirmée', async () => {
    const m = await openPlan(houseDoc());
    await act(async () => {
      m.store.getState().setTop({ kind: 'pitched-roof' });
    });
    const [lower, upper] = selectProject(m.store.getState()).model.storeys;
    await act(async () => {
      m.store.getState().selectStorey(upper!.id);
      m.store.getState().selectPlanStep('height');
    });
    expect(stepState('height')).toBe('done');
    expect(q('plan-step-detail').textContent).toContain('Rien à saisir ici');
    expect(has('height-pick')).toBe(false);
    // L'étage du dessous, lui, la demande toujours.
    await act(async () => {
      m.store.getState().selectStorey(lower!.id);
      m.store.getState().selectPlanStep('height');
    });
    expect(stepState('height')).toBe('todo');
    expect(has('height-pick')).toBe(true);
  });
});

describe('échelle : confirmée une fois par dessin', () => {
  it('valider l’échelle d’un étage la valide pour les étages du même fichier ; « annuler » les rétablit ensemble', async () => {
    const m = await openPlan(houseDoc());
    const scales = (): string[] => selectProject(m.store.getState()).model.storeys.map((s) => s.metresPerUnit.from);
    expect(scales()).toEqual(['plan', 'plan']);
    await click('plan-confirm-scale');
    expect(scales()).toEqual(['user', 'user']);
    expect(tabProgress()).toEqual(['1/7', '1/7']);
    // L'autre étage ne redemande pas l'échelle : il s'ouvre sur le contour.
    await click(all('storey-tab')[1]!);
    expect(stepState('scale')).toBe('done');
    expect(m.store.getState().planStep).toBe('outline');
    await click('undo');
    expect(scales()).toEqual(['plan', 'plan']);
  });

  it('deux fichiers différents gardent chacun leur confirmation', async () => {
    readers.documents.set('rdc.dxf', doc('rdc.dxf', [sheet('cad-1', 'Rez-de-chaussée')]));
    readers.documents.set('etage.dxf', doc('etage.dxf', [sheet('cad-1', 'Étage')]));
    const m = await mount();
    await act(async () => {
      await m.store.getState().ingestFiles([
        { name: 'rdc.dxf', arrayBuffer: async () => new ArrayBuffer(4) },
        { name: 'etage.dxf', arrayBuffer: async () => new ArrayBuffer(4) },
      ]);
    });
    await click('accept-read');
    await click('plan-confirm-scale');
    expect(selectProject(m.store.getState()).model.storeys.map((s) => s.metresPerUnit.from).sort()).toEqual(['plan', 'user']);
  });

  it('une maquette IFC ne demande aucune confirmation d’échelle', async () => {
    const model = doc(
      'villa.ifc',
      [sheet('niveau-0', 'Rez-de-chaussée', { scale: { value: 1, from: 'plan' } }), sheet('niveau-1', 'Étage', { scale: { value: 1, from: 'plan' } })],
      { kind: 'ifc', storeysAligned: true },
    );
    const m = await openPlan(model);
    expect(stepState('scale')).toBe('done');
    expect(m.store.getState().planStep).toBe('outline');
    expect(has('plan-confirm-scale')).toBe(false);
    await click('plan-step-button-scale');
    expect(q('plan-step-detail').textContent).toContain('Maquette en vraie grandeur');
    expect(has('plan-confirm-scale')).toBe(false);
    // L'étape rouverte ne tend pas la règle : le plan se regarde, et l'explication ne demande rien.
    expect(q('stub-editor').getAttribute('data-tool')).toBe('pan');
    expect(q('plan-step-detail').textContent).toContain('ni règle à poser ni échelle à confirmer');
    expect(q('plan-step-detail').textContent).not.toContain('Posez la règle');
    // L'échelle reste « lue sur le plan » dans le modèle : rien n'a été confirmé à la place de l'expert.
    expect(selectProject(m.store.getState()).model.storeys.map((s) => s.metresPerUnit.from)).toEqual(['plan', 'plan']);
  });
});

describe('guide : commandes toujours au même endroit, une seule validation par étape', () => {
  it('range les commandes de l’étape active et la suite du parcours dans la barre du bas, hors de la zone qui défile', async () => {
    await openPlan(houseDoc());
    const bar = q('plan-guide-bar');
    const scroll = q('plan-guide-scroll');
    expect(bar.contains(q('plan-confirm-scale'))).toBe(true);
    expect(bar.contains(q('plan-next-step'))).toBe(true);
    expect(bar.contains(q('to-questions'))).toBe(true);
    expect(scroll.contains(q('plan-step-detail'))).toBe(true);
    expect(scroll.querySelector('[data-testid^="plan-confirm-"]')).toBeNull();
    expect(q('plan-step-detail').querySelector('.btn--primary')).toBeNull();
  });

  it('contour et nord se valident sur le plan : le guide y renvoie au lieu de doubler le bouton', async () => {
    const m = await openPlan(houseDoc());
    await click('plan-step-button-outline');
    expect(stepState('outline')).toBe('toConfirm');
    expect(has('plan-confirm-outline')).toBe(false);
    expect(q('plan-confirm-on-plan').textContent).toContain('sur le plan');
    await click('stub-done');
    expect(stepState('outline')).toBe('done');

    await click('plan-step-button-north');
    expect(has('plan-confirm-north')).toBe(false);
    expect(has('plan-confirm-on-plan')).toBe(true);
    await click('stub-done');
    expect(selectProject(m.store.getState()).model.northAngle.from).toBe('user');

    // Les étapes sans bouton sur le plan gardent celui du guide — et lui seul.
    await click('plan-step-button-boundary');
    expect(all('plan-confirm-boundary')).toHaveLength(1);
    expect(has('plan-confirm-on-plan')).toBe(false);
  });
});

describe('page de résultat : étapes du plan jamais confirmées', () => {
  it('les rappelle étage par étage avec un bouton qui y ramène, et se tait quand tout est validé', async () => {
    const m = await openPlan(houseDoc());
    await click('plan-confirm-scale'); // vaut pour les deux étages
    await click('step-result');
    const block = q('unconfirmed');
    // 6 étapes au rez-de-chaussée, 5 à l'étage : le nord vaut pour tout le bâtiment, il n'est rappelé qu'une fois.
    expect(block.textContent).toContain('Étapes du plan non confirmées : 11');
    const rows = all('unconfirmed-storey');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Rez-de-chaussée');
    expect(rows[0]!.textContent).toContain('Contour chauffé · Hauteur d’étage · Derrière chaque façade · Fenêtres et portes · Nord · Pièces chauffées (An)');
    expect(rows[0]!.textContent).not.toContain('Échelle');
    expect(rows[1]!.textContent).toContain('Contour chauffé · Hauteur d’étage · Derrière chaque façade · Fenêtres et portes · Pièces chauffées (An)');
    expect(rows[1]!.textContent).not.toContain('Nord');
    expect(all('unconfirmed-jump')[1]!.getAttribute('aria-label')).toBe('Confirmer sur le plan : Étage');

    // Le bouton ouvre le bon étage, sur sa première étape encore ouverte.
    const upper = selectProject(m.store.getState()).model.storeys[1]!;
    await click(all('unconfirmed-jump')[1]!);
    expect(m.store.getState()).toMatchObject({ step: 'plan', storeyId: upper.id, planStep: 'outline' });
    expect(q('stub-editor').getAttribute('data-tool')).toBe('outline');

    // Tout valider : le rappel disparaît.
    await act(async () => {
      const s = m.store.getState();
      for (const storey of selectProject(s).model.storeys) {
        s.selectStorey(storey.id);
        s.updateProject((p) => ({ ...p, model: { ...p.model, storeys: p.model.storeys.map((x) => (x.id === storey.id ? { ...x, netAreaOverride: { value: 50, from: 'user' as const } } : x)) } }));
        for (const key of ['outline', 'height', 'boundary', 'opening', 'north'] as const) m.store.getState().confirmPlanStep(key);
      }
    });
    await click('step-result');
    expect(has('unconfirmed')).toBe(false);
    expect(stepHasCheck('plan')).toBe(true);
  });
});

describe('bandeau des étapes sur écran étroit', () => {
  it('amène l’étape active au centre du bandeau à chaque changement d’étape', async () => {
    // Géométrie d'un téléphone : bandeau de 366 px, sept pastilles de 170 px espacées de 6 px.
    const calls: { el: Element; left: number | undefined }[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const original = {
      scrollTo: Object.getOwnPropertyDescriptor(proto, 'scrollTo'),
      scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth'),
      clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
      rect: Element.prototype.getBoundingClientRect,
    };
    const isRow = (el: Element): boolean => el.classList.contains('checklist');
    Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get(this: Element) { return isRow(this) ? 7 * 176 - 6 : 0; } });
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get(this: Element) { return isRow(this) ? 366 : 0; } });
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const box = (left: number, width: number): DOMRect => ({ left, right: left + width, width, top: 0, bottom: 44, height: 44, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
      if (isRow(this)) return box(12, 366);
      if (this.classList.contains('checklist__item')) return box(12 + Array.from(this.parentElement!.children).indexOf(this) * 176, 170);
      return box(0, 0);
    };
    Object.defineProperty(proto, 'scrollTo', {
      configurable: true,
      value(this: Element, options?: ScrollToOptions) {
        calls.push({ el: this, left: options?.left });
      },
    });

    try {
      await openPlan(houseDoc());
      const row = document.querySelector('.checklist')!;
      const lastLeft = (): number | undefined => calls.filter((c) => c.el === row).at(-1)?.left;
      // Première étape : au début du bandeau.
      expect(lastLeft()).toBe(0);
      // Après la validation, l'étape 2 puis l'étape 3 (qui commençait hors champ) sont centrées.
      await click('plan-confirm-scale');
      expect(lastLeft()).toBe(176 + 85 - 183);
      await click('stub-done');
      expect(q('plan-step-height').className).toContain('is-active');
      expect(lastLeft()).toBe(2 * 176 + 85 - 183);
      // Toucher directement la dernière étape : on va au bout, pas plus loin.
      await click('plan-step-button-rooms');
      expect(lastLeft()).toBe(7 * 176 - 6 - 366);
    } finally {
      for (const [name, descriptor] of [['scrollWidth', original.scrollWidth], ['clientWidth', original.clientWidth]] as const) {
        if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
      }
      if (original.scrollTo) Object.defineProperty(proto, 'scrollTo', original.scrollTo);
      else delete proto.scrollTo;
      Element.prototype.getBoundingClientRect = original.rect;
    }
  });
});
