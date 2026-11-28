// @vitest-environment jsdom
/**
 * Parcours automatique de BOUT EN BOUT, avec le VRAI moteur (buildAutoProject, collectDoubts, applyDoubtAnswer) : seuls
 * les lecteurs (le document lu est fabriqué depuis la vérité des quatre planches synthétiques, tests/engine/
 * auto-planche.ts) et l'éditeur de plan sont simulés. Pour chaque planche : dépôt → lecture → écran lu → toutes les
 * cartes répondues (proposition, autre choix, « je ne sais pas », « tout confirmer ») → dossier → tout annuler → tout
 * rétablir → rechargement → même dossier. Données inventées.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDocument, Project } from '../../../src/core/types';
import { DOUBT_CONFIRM, DOUBT_UNKNOWN, deriveSheets } from '../../../src/engine';
import { parseProject, serializeProject, sheetsToCsv } from '../../../src/export';
import { App } from '../../../src/ui/shell';
import { selectAllDoubts, selectCanRedo, selectCanUndo, selectDeck, selectMarks, selectOpenDoubts, selectProject } from '../../../src/ui/shell/store';
import { documentFromTruth } from '../../engine/auto-planche';
import type { PlancheName, Truth } from '../../engine/auto-planche';
import { testStore } from './helpers';
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
    return structuredClone(found);
  },
}));

// Bouchon de l'éditeur de plan : il montre l'outil et l'étage reçus.
vi.mock('../../../src/ui/plan', async () => {
  const React = await import('react');
  type Props = import('../../../src/ui/plan').PlanEditorProps;
  const PlanEditor = (props: Props) => React.createElement('div', { 'data-testid': 'stub-editor', 'data-tool': props.tool });
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

async function unmount(m: Mounted): Promise<void> {
  await act(async () => {
    m.root.unmount();
  });
  m.container.remove();
  m.store.getState().dispose();
  mounted = null;
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

async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function drop(m: Mounted, doc: PlanDocument): Promise<void> {
  readers.documents.set(doc.fileName, doc);
  await act(async () => {
    await m.store.getState().ingestFiles([{ name: doc.fileName, arrayBuffer: async () => new ArrayBuffer(4) }]);
  });
}

// En jsdom, l'adresse du module n'est pas un chemin de fichier : la vérité est importée comme module JSON.
const TRUTHS: Record<PlancheName, () => Promise<{ default: unknown }>> = {
  planche_A1_archicad: () => import('../../fixtures/pdf/planche/planche_A1_archicad.truth.json'),
  planche_A2_de_titres_dessus: () => import('../../fixtures/pdf/planche/planche_A2_de_titres_dessus.truth.json'),
  planche_2pages: () => import('../../fixtures/pdf/planche/planche_2pages.truth.json'),
  planche_sans_titres: () => import('../../fixtures/pdf/planche/planche_sans_titres.truth.json'),
};

async function plancheDoc(name: PlancheName): Promise<PlanDocument> {
  const truth = structuredClone((await TRUTHS[name]()).default) as Truth;
  return documentFromTruth(truth);
}

const csvOf = (p: Project): string => sheetsToCsv(deriveSheets(p, 'fr'), p, 'fr');
const card = (): string | null => q('doubt-card').getAttribute('data-doubt');

beforeEach(() => {
  readers.documents.clear();
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = (() => undefined) as typeof window.scrollTo;
});

afterEach(async () => {
  if (mounted) await unmount(mounted);
  document.body.innerHTML = '';
});

/** Phrases à trous ou noms vides qu'une question ne doit jamais montrer. */
const HOLES = /\?\s*\?|«\s*»|„\s*“|,\s*,|\(\s*\)|:\s*\?|\bundefined\b|\bnull\b|\bNaN\b|\{[a-z]+\}/;

describe.each(['planche_A1_archicad', 'planche_A2_de_titres_dessus', 'planche_2pages'] as const)('%s — parcours complet avec le vrai moteur', (name) => {
  it('dépôt → lu → toutes les cartes → dossier → tout annuler → tout rétablir → rechargement → même dossier', async () => {
    const doc = await plancheDoc(name);
    const m = await mount();
    await drop(m, doc);
    expect(m.store.getState().step).toBe('overview');
    expect(selectMarks(m.store.getState()).flow).toBe('auto');

    // Questions vues comme l'utilisateur les verra : au plus huit, sans phrase à trous, chacune avec un pourquoi.
    const first = selectOpenDoubts(m.store.getState());
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(8);
    for (const d of first) {
      expect(d.question, d.id).not.toMatch(HOLES);
      for (const line of d.details) expect(line, d.id).not.toMatch(HOLES);
      // Une seule question de surface sans étiquette pour tout le bâtiment.
    }
    expect(first.filter((d) => d.id === 'an-unlabelled').length).toBeLessThanOrEqual(1);
    // Les questions qui se corrigent sur le plan nomment un étage du projet.
    const storeyIds = new Set(selectProject(m.store.getState()).model.storeys.map((s) => s.id));
    for (const d of first) if (d.fix) expect(storeyIds.has(d.fix.storeyId ?? ''), d.id).toBe(true);

    await click('answer-doubts');
    expect(m.store.getState().step).toBe('doubts');
    const pastAtStart = m.store.getState().history.past.length;
    let turn = 0;
    const seen: string[] = [];
    while (m.store.getState().step === 'doubts' && has('doubt-card') && turn < 20) {
      const id = card()!;
      seen.push(id);
      expect(q('doubt-card').textContent).toContain('Pourquoi je demande');
      const radios = all('doubt-choice').map((c) => c.querySelector('input') as HTMLInputElement);
      // La proposition, quand il y en a une, est déjà choisie.
      const doubt = selectDeck(m.store.getState()).find((d) => d.id === id)!;
      if (doubt.proposal && radios.length > 0) expect(radios.find((r) => r.checked)?.value).toBe(doubt.proposal.value);
      if (turn === 0) {
        await click('doubt-unknown');
      } else if (has('confirm-all')) {
        await click('confirm-all');
      } else if (turn % 3 === 2) {
        await click('doubt-unknown');
      } else if (radios.length > 1 && turn % 3 === 1) {
        // Un autre choix que la proposition.
        const other = radios.find((r) => !r.checked)!;
        await click(other);
        await click('doubt-ok');
      } else if (has('doubt-input')) {
        const input = q('doubt-input') as HTMLInputElement;
        if (input.value.trim() === '') await type(input, id === 'year' ? '2030' : id === 'identity' ? '1 rue Inventée, L-0000 Exempleville' : '2,80');
        await click('doubt-ok');
      } else {
        await click('doubt-ok');
      }
      // Une réponse refusée laisse la carte : on dit « je ne sais pas » pour avancer.
      if (m.store.getState().step === 'doubts' && has('doubt-card') && card() === id) await click('doubt-unknown');
      turn++;
    }
    expect(m.store.getState().step).toBe('dossier');
    expect(selectOpenDoubts(m.store.getState())).toHaveLength(0);
    expect(new Set(seen).size).toBe(seen.length);
    const answered = selectProject(m.store.getState());
    // Chaque question vue est tranchée DANS LE PROJET (une seule vérité), « je ne sais pas » comprise.
    for (const id of seen) expect(Object.keys(answered.answers.resolvedDoubts ?? {})).toContain(id);
    expect(Object.values(answered.answers.resolvedDoubts ?? {})).toContain('unknown');
    const csv = csvOf(answered);
    expect(csv).toContain('Questions tranchées');
    expect(has('open-doubts')).toBe(false);

    // Tout annuler : les questions reviennent, toutes ; tout rétablir : le même projet.
    const steps = m.store.getState().history.past.length - pastAtStart;
    expect(steps).toBeGreaterThan(0);
    for (let i = 0; i < steps; i++) act(() => m.store.getState().undo());
    expect(selectOpenDoubts(m.store.getState()).map((d) => d.id).sort()).toEqual(first.map((d) => d.id).sort());
    expect(selectProject(m.store.getState()).answers.resolvedDoubts ?? {}).toEqual({});
    while (selectCanRedo(m.store.getState())) act(() => m.store.getState().redo());
    expect(selectOpenDoubts(m.store.getState())).toHaveLength(0);
    expect(csvOf(selectProject(m.store.getState()))).toBe(csv);
    expect(selectCanUndo(m.store.getState())).toBe(true);

    // Fichier de projet : se rouvre sans perte (couches, fenêtres, réponses aux doutes).
    const reopened = parseProject(serializeProject(selectProject(m.store.getState())));
    expect(reopened.answers.resolvedDoubts).toEqual(answered.answers.resolvedDoubts);
    expect(csvOf(reopened)).toBe(csv);

    // Rechargement : même dossier, aucune question revenue.
    m.store.getState().flushAutosave();
    const saved = m.storage.dump();
    await unmount(m);
    const again = await mount(testStore({}, saved));
    await click('resume-saved');
    expect(selectOpenDoubts(again.store.getState())).toHaveLength(0);
    expect(csvOf(selectProject(again.store.getState()))).toBe(csv);

    // La planche relue retrouve le projet sans reposer les questions tranchées.
    await drop(again, doc);
    expect(selectOpenDoubts(again.store.getState())).toHaveLength(0);
  });
});

describe('cohérence moteur ↔ interface', () => {
  it('« corriger sur le plan » ouvre l’étage où le doute a été vu ; le bouton de l’éditeur ramène à la carte', async () => {
    const doc = await plancheDoc('planche_A2_de_titres_dessus');
    const m = await mount();
    await drop(m, doc);
    const unlabelled = selectOpenDoubts(m.store.getState()).find((d) => d.id === 'an-unlabelled');
    expect(unlabelled?.fix?.step).toBe('rooms');
    expect(unlabelled?.where?.sheetId).toBeTruthy();
    const storey = selectProject(m.store.getState()).model.storeys.find((s) => s.id === unlabelled!.fix!.storeyId)!;
    expect(storey.sheetId).toBe(unlabelled!.where!.sheetId);
    act(() => m.store.getState().showDoubt('an-unlabelled'));
    await click('doubt-fix');
    expect(m.store.getState().step).toBe('plan');
    expect(m.store.getState().storeyId).toBe(storey.id);
    expect(q('stub-editor').getAttribute('data-tool')).toBe('rooms');
    // Le bouton de l'éditeur ne part pas dans le parcours guidé : il ramène à l'écran d'origine.
    await click('to-questions');
    expect(m.store.getState().step).toBe('doubts');
    expect(m.store.getState().fixReturn).toBeNull();
  });

  it('une marque d’interface ne contredit pas le projet : annuler une réponse rouvre la question même si marks.doubts la garde', async () => {
    const doc = await plancheDoc('planche_A1_archicad');
    const m = await mount();
    await drop(m, doc);
    const d = selectOpenDoubts(m.store.getState())[0]!;
    act(() => m.store.getState().answerDoubt(d, DOUBT_UNKNOWN));
    expect(selectOpenDoubts(m.store.getState()).some((x) => x.id === d.id)).toBe(false);
    // Le projet perd la réponse par une autre voie (ex. projet remplacé) : la marque seule ne suffit pas.
    act(() => m.store.getState().apply((ws) => ({ ...ws, project: { ...ws.project, answers: { ...ws.project.answers, resolvedDoubts: {} } } })));
    expect(selectMarks(m.store.getState()).doubts?.[d.id]).toBeDefined();
    expect(selectOpenDoubts(m.store.getState()).some((x) => x.id === d.id)).toBe(true);
  });

  it('questions regroupées : « Confirmer » envoie la valeur attendue par le moteur et tranche la question', async () => {
    const doc = await plancheDoc('planche_A1_archicad');
    const m = await mount();
    await drop(m, doc);
    const materials = selectAllDoubts(m.store.getState()).find((x) => x.id === 'materials')!;
    expect(materials.proposal).toBeNull();
    act(() => m.store.getState().showDoubt('materials'));
    expect((q('doubt-ok') as HTMLButtonElement).disabled).toBe(false);
    await click('doubt-ok');
    expect(selectProject(m.store.getState()).answers.resolvedDoubts?.materials).toBe('user');
    expect(selectMarks(m.store.getState()).doubts?.materials?.value).toBe(DOUBT_CONFIRM);
  });

  it('planche insuffisante : la raison du moteur suit la langue de l’utilisateur', async () => {
    const doc = await plancheDoc('planche_sans_titres');
    const m = await mount();
    await drop(m, doc);
    expect(m.store.getState().step).toBe('read');
    expect(q('guided-reason').textContent).toContain('Toiture non lue');
    act(() => m.store.getState().setLang('de'));
    expect(q('guided-reason').textContent).not.toContain('Toiture non lue');
    expect(q('guided-reason').textContent).toMatch(/Dach/);
  });
});
