// @vitest-environment jsdom
/**
 * Parcours AUTOMATIQUE, vu par l'expert : dépôt d'une planche → lecture → « Voici ce que j'ai lu » → seules questions
 * de doute → dossier. Les lecteurs sont simulés ; le moteur est le vrai, sauf ses trois raccords du parcours
 * (buildAutoProject, applyDoubtAnswer, collectDoubts), simulés ici pour que l'interface se teste seule.
 * Maison inventée : aucune donnée réelle.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHEETS_625 } from '../../../src/core/cpe';
import type { SheetReading } from '../../../src/core/reading';
import type { PlanDocument, Project } from '../../../src/core/types';
import type { Doubt, DoubtId } from '../../../src/engine';
import { App } from '../../../src/ui/shell';
import { selectCanUndo, selectMarks, selectOpenDoubts, selectProject } from '../../../src/ui/shell/store';
import { doc, houseDoc, rect, sheet, testStore } from './helpers';
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
  readPlanFile: async (f: { name: string }, options?: { onProgress?: (p: { stage: string; status: string }) => void }) => {
    const found = readers.documents.get(f.name);
    if (!found) throw new Error('lecture impossible');
    options?.onProgress?.({ stage: 'open', status: 'done' });
    return found;
  },
}));

/** Raccords du moteur simulés : la suffisance, les questions et l'effet d'une réponse sont réglés par chaque test. */
const engine = vi.hoisted(() => ({
  sufficient: true,
  notes: [] as string[],
  doubts: [] as unknown[],
  built: 0,
  collected: 0,
  answers: [] as { id: string; value: string }[],
}));

vi.mock('../../../src/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/engine')>();
  return {
    ...real,
    buildAutoProject: (d: PlanDocument, base: Project, lang: 'fr' | 'de') => {
      engine.built += 1;
      const build = real.buildAutoProject(d, base, lang);
      // Ce que le vrai moteur reprend du cartouche lu.
      const type = d.reading?.titleBlock?.buildingType?.value ?? null;
      return { ...build, project: { ...build.project, answers: { ...build.project.answers, buildingType: type } }, sufficient: engine.sufficient, notes: engine.notes };
    },
    collectDoubts: (_r: unknown, project: Project) => {
      engine.collected += 1;
      // L'échelle corrigée sur le plan ne fait plus doute : la question disparaît au recalcul.
      // Comme le vrai moteur : une question tranchée (answers.resolvedDoubts) n'est plus posée.
      const resolved = project.answers.resolvedDoubts ?? {};
      return (engine.doubts as Doubt[]).filter((d) => !(d.id in resolved) && !(d.id === 'scale' && project.model.storeys[0]?.metresPerUnit.from === 'user'));
    },
    applyDoubtAnswer: (project: Project, d: Doubt, value: string) => {
      engine.answers.push({ id: d.id, value });
      const how: 'user' | 'unknown' = value === real.DOUBT_UNKNOWN ? 'unknown' : 'user';
      const answers = { ...project.answers, resolvedDoubts: { ...(project.answers.resolvedDoubts ?? {}), [d.id]: how } };
      if (d.id === 'occasion' && value !== real.DOUBT_UNKNOWN) return { ...project, answers: { ...answers, occasion: value as 'new' | 'existing' } };
      return { ...project, answers };
    },
  };
});

// Bouchon de l'éditeur de plan : il montre l'outil reçu.
vi.mock('../../../src/ui/plan', async () => {
  const React = await import('react');
  type Props = import('../../../src/ui/plan').PlanEditorProps;
  const PlanEditor = (props: Props) => React.createElement('div', { 'data-testid': 'stub-editor', 'data-tool': props.tool });
  return { PlanEditor };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ───────────────────────────── Maison inventée ─────────────────────────────

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });

function reading(): SheetReading {
  const view = (id: string, kind: SheetReading['views'][number]['kind'], b: ReturnType<typeof box>, extra: Partial<SheetReading['views'][number]> = {}) => ({
    id,
    page: 1,
    kind,
    title: null,
    titleBox: null,
    storeyRank: null,
    sides: null,
    box: b,
    buildingBox: null,
    sheetId: null,
    confidence: 0.9,
    sources: ['title'],
    doubts: [],
    ...extra,
  });
  return {
    views: [
      view('p1-floor-plan1', 'floor-plan', box(0, 0, 590, 480), { storeyRank: 0, sheetId: 'rez', title: 'PLAN REZ' }),
      view('p1-floor-plan2', 'floor-plan', box(600, 0, 1190, 480), { storeyRank: 1, sheetId: 'etage', title: 'PLAN ÉTAGE' }),
      view('p1-section1', 'section', box(0, 500, 590, 790)),
      view('p1-elevation1', 'elevation', box(600, 500, 890, 790), { sides: ['front'] }),
      view('p1-title-block1', 'title-block', box(900, 800, 1190, 990)),
    ],
    titleBlock: {
      project: 'Maison Exemple',
      phase: 'autorisation de bâtir',
      buildingType: { value: 'EFH', confidence: 0.9, evidence: [{ source: 'title-block', page: 1, box: box(910, 810, 1180, 840) }] },
      dwellings: null,
      occasion: { value: 'new', confidence: 0.7, evidence: [{ source: 'title-block', page: 1, box: box(910, 850, 1180, 880) }] },
      street: '1, rue Inventée',
      postcode: 'L-0000',
      locality: 'Exempleville',
      date: '01/01/2030',
      year: 2030,
      index: null,
      scaleDen: 100,
      format: 'A1',
      page: 1,
      box: box(900, 800, 1190, 990),
      confidence: 0.9,
    },
    siteAreas: null,
    levels: null,
    compositions: [],
    north: null,
    equipment: [],
    systems: null,
    openingPairs: [],
    glazing: [],
    elevations: [],
    roof: null,
    alignment: [],
    log: [],
  };
}

function planche(fileName = 'planche.pdf'): PlanDocument {
  return doc(
    fileName,
    [
      { ...sheet('rez', 'Rez-de-chaussée', { imageUrl: 'blob:page-1', detected: { rooms: [{ name: 'Séjour', statedArea: 38, heatedGuess: 'yes' }] } }), page: 1 },
      { ...sheet('etage', 'Étage', { outline: rect(1000, 800) }), page: 1 },
    ],
    { kind: 'pdf', reading: reading() },
  );
}

function doubt(id: DoubtId, extra: Partial<Doubt> = {}): Doubt {
  return {
    id,
    sheet: 'general',
    impact: 'high',
    grouped: false,
    datum: `Donnée ${id}`,
    question: `Question ${id} ?`,
    proposal: null,
    options: [],
    details: [],
    effect: null,
    effectShare: null,
    confidence: 0.5,
    signals: [],
    ...extra,
  };
}

const OCCASION = doubt('occasion', {
  proposal: { value: 'new', label: 'Bâtiment neuf' },
  options: [
    { value: 'new', label: 'Bâtiment neuf' },
    { value: 'existing', label: 'Bâtiment existant' },
  ],
  effect: 'Change la feuille Allgemeine Projektdaten',
  signals: [{ group: 'title-block', strength: 'strong', value: 'new', source: 'title-block.occasion' }],
});
const SCALE = doubt('scale', { sheet: 'envelope', datum: 'Échelle' });
const MATERIALS = doubt('materials', { sheet: 'opaque', grouped: true, details: ['Isolant : λ 0,035 proposé', 'Brique : λ 0,45 proposé'] });
const WINDOWS = doubt('windows', { sheet: 'windows', grouped: true, details: ['Triple vitrage : Ug 0,6 proposé'] });

// ───────────────────────────── Montage ─────────────────────────────

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
const text = (): string => document.body.textContent ?? '';

async function click(target: HTMLElement | string): Promise<void> {
  const el = typeof target === 'string' ? q(target) : target;
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function drop(m: Mounted, document: PlanDocument): Promise<void> {
  readers.documents.set(document.fileName, document);
  await act(async () => {
    await m.store.getState().ingestFiles([{ name: document.fileName, arrayBuffer: async () => new ArrayBuffer(4) }]);
  });
}

/** Planche lue et jugée suffisante : on arrive sur « Voici ce que j'ai lu ». */
async function readPlanche(doubts: Doubt[] = [OCCASION, SCALE, MATERIALS, WINDOWS], test?: TestStore): Promise<Mounted> {
  engine.doubts = doubts;
  const m = await mount(test);
  await drop(m, planche());
  return m;
}

const card = (): string | null => q('doubt-card').getAttribute('data-doubt');

beforeEach(() => {
  readers.documents.clear();
  engine.sufficient = true;
  engine.notes = [];
  engine.doubts = [];
  engine.built = 0;
  engine.collected = 0;
  engine.answers = [];
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

// ───────────────────────────── Aiguillage ─────────────────────────────

describe('aiguillage après la lecture', () => {
  it('planche suffisante : parcours automatique, écran « Voici ce que j’ai lu », barre Lecture · Lu · Doutes · Dossier', async () => {
    const m = await readPlanche();
    expect(engine.built).toBe(1);
    expect(m.store.getState().step).toBe('overview');
    expect(selectMarks(m.store.getState()).flow).toBe('auto');
    expect(has('auto-steps')).toBe(true);
    expect(all('auto-step-home').length + all('auto-step-overview').length + all('auto-step-doubts').length + all('auto-step-dossier').length).toBe(4);
    expect(q('auto-step-overview').getAttribute('aria-current')).toBe('step');
    expect(q('doubts-left').textContent).toContain('4');
    expect(selectProject(m.store.getState()).model.storeys).toHaveLength(2);
  });

  it('planche insuffisante : parcours guidé inchangé, avec la raison tirée des notes du moteur', async () => {
    engine.sufficient = false;
    engine.notes = ['Aucune échelle sûre sur cette planche.'];
    const m = await readPlanche();
    expect(m.store.getState().step).toBe('read');
    expect(q('guided-reason').textContent).toContain('Aucune échelle sûre sur cette planche.');
    expect(selectMarks(m.store.getState()).flow).toBeUndefined();
    expect(has('auto-steps')).toBe(false);
  });

  it('un dessin DXF suit le parcours guidé sans passer par la lecture automatique', async () => {
    const m = await mount();
    await drop(m, houseDoc());
    expect(engine.built).toBe(0);
    expect(m.store.getState().step).toBe('read');
    expect(has('guided-reason')).toBe(false);
  });

  it('montre la lecture étape par étape pendant qu’elle se fait', async () => {
    engine.doubts = [OCCASION];
    const m = await mount();
    readers.documents.set('planche.pdf', planche());
    let seen = false;
    const unsubscribe = m.store.subscribe((s) => {
      if (s.stages.some((x) => x.key === 'views' && x.status === 'done' && x.detail?.params.sections === 1)) seen = true;
    });
    await act(async () => {
      await m.store.getState().ingestFiles([{ name: 'planche.pdf', arrayBuffer: async () => new ArrayBuffer(4) }]);
    });
    unsubscribe();
    expect(seen).toBe(true);
    expect(m.store.getState().stages).toEqual([]);
  });
});

// ───────────────────────────── « Voici ce que j'ai lu » ─────────────────────────────

describe('écran « Voici ce que j’ai lu »', () => {
  it('groupe les données comme les feuilles de LuxEeB-Tool, avec un niveau de confiance lisible et une phrase de tête juste', async () => {
    await readPlanche();
    const groups = all('ov-group').map((g) => g.getAttribute('data-group'));
    expect(groups.slice(0, 3)).toEqual(['project', 'areas', 'envelope']);
    expect(groups).toContain('systems');
    const trusts = all('field').map((f) => f.getAttribute('data-trust'));
    for (const t of trusts) expect(['crossChecked', 'read', 'assumption', 'missing', 'user']).toContain(t);
    const sure = trusts.filter((t) => t === 'crossChecked' || t === 'read').length;
    const assumed = trusts.filter((t) => t === 'assumption').length;
    expect(q('ov-lead').textContent).toContain(`J’ai lu ${trusts.length} données : ${sure} sont sûres, ${assumed} sont des hypothèses.`);
    // Le type de bâtiment est lu dans le cartouche avec une confiance ≥ 0,85 : « lu et recoupé ».
    expect(document.querySelector('[data-field="buildingType"]')?.getAttribute('data-trust')).toBe('crossChecked');
    expect(q('answer-doubts').textContent).toContain('4');
  });

  it('« voir sur la planche » allume la vue et l’endroit lus sur la miniature', async () => {
    await readPlanche();
    expect(all('thumb-view')).toHaveLength(5);
    expect(text()).toContain('Plan rez');
    expect(text()).toContain('Cartouche');
    expect(has('thumb-spot')).toBe(false);
    const field = document.querySelector<HTMLElement>('[data-field="occasion"]')!;
    await click(field.querySelector<HTMLElement>('[data-testid="locate"]')!);
    expect(has('thumb-spot')).toBe(true);
    expect(document.querySelector('[data-view="p1-title-block1"]')?.getAttribute('data-lit')).toBe('true');
    expect(field.classList.contains('is-lit')).toBe(true);
  });

  it('sans question : « Voir le dossier » à la place de « Répondre », et l’écran des doutes mène au dossier', async () => {
    const m = await readPlanche([]);
    expect(has('answer-doubts')).toBe(false);
    await click('see-dossier');
    expect(m.store.getState().step).toBe('dossier');
    act(() => m.store.getState().goTo('doubts'));
    expect(has('doubts-none')).toBe(true);
    await click('doubts-dossier');
    expect(m.store.getState().step).toBe('dossier');
  });
});

// ───────────────────────────── Cartes de doute ─────────────────────────────

describe('questions de doute', () => {
  it('une carte à la fois, dans l’ordre du moteur, la proposition déjà choisie ; une réponse = un pas d’annulation', async () => {
    const m = await readPlanche();
    await click('answer-doubts');
    expect(m.store.getState().step).toBe('doubts');
    expect(q('doubt-counter').textContent).toContain('4 question');
    expect(card()).toBe('occasion');
    const radios = all('doubt-choice').map((c) => c.querySelector('input') as HTMLInputElement);
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['new', true],
      ['existing', false],
    ]);
    expect(q('doubt-effect').textContent).toContain('Allgemeine Projektdaten');
    expect(text()).toContain('Pourquoi je demande');
    // L'endroit est connu (cartouche) et la page a une image : l'extrait est montré.
    expect(has('doubt-snippet')).toBe(true);

    const before = m.store.getState().history.past.length;
    await click(all('doubt-choice')[1]!.querySelector('input')!);
    await click('doubt-ok');
    expect(engine.answers).toEqual([{ id: 'occasion', value: 'existing' }]);
    expect(m.store.getState().history.past.length).toBe(before + 1);
    expect(selectProject(m.store.getState()).answers.occasion).toBe('existing');
    expect(card()).toBe('scale');
    expect(q('doubt-counter').textContent).toContain('3 question');

    act(() => m.store.getState().undo());
    expect(selectMarks(m.store.getState()).doubts?.occasion).toBeUndefined();
    expect(selectOpenDoubts(m.store.getState())).toHaveLength(4);
  });

  it('« je ne sais pas » garde la proposition (DOUBT_UNKNOWN) ; « précédent » revient sur la carte répondue', async () => {
    const m = await readPlanche();
    await click('answer-doubts');
    await click('doubt-unknown');
    expect(engine.answers).toEqual([{ id: 'occasion', value: 'unknown' }]);
    expect(card()).toBe('scale');
    await click('doubt-previous');
    expect(card()).toBe('occasion');
    expect(q('doubt-answered').textContent).toContain('je ne sais pas');
    // La proposition reste choisie.
    expect((all('doubt-choice')[0]!.querySelector('input') as HTMLInputElement).checked).toBe(true);
    // « Précédent » sur la première carte ramène à l'écran « lu ».
    await click('doubt-previous');
    expect(m.store.getState().step).toBe('overview');
  });

  it('questions regroupées : lignes de détail, puis « Tout confirmer » d’un geste et d’un seul pas d’annulation', async () => {
    const m = await readPlanche();
    await click('answer-doubts');
    expect(has('confirm-all')).toBe(false);
    await click('doubt-ok');
    await click('doubt-unknown');
    expect(card()).toBe('materials');
    expect(q('doubt-details').textContent).toContain('Brique');
    expect(q('confirm-all').textContent).toContain('2');
    const before = m.store.getState().history.past.length;
    await click('confirm-all');
    expect(m.store.getState().history.past.length).toBe(before + 1);
    expect(engine.answers.slice(-2).map((a) => a.id)).toEqual(['materials', 'windows']);
    expect(selectOpenDoubts(m.store.getState())).toHaveLength(0);
    expect(m.store.getState().step).toBe('dossier');
    expect(q('doubts-left').textContent).toContain('Aucun doute');
  });

  it('« corriger sur le plan » ouvre l’éditeur sur l’outil voulu, « Terminé, revenir » ramène à la carte ; la question corrigée disparaît', async () => {
    const m = await readPlanche();
    await click('answer-doubts');
    await click('doubt-ok');
    expect(card()).toBe('scale');
    await click('doubt-fix');
    expect(m.store.getState().step).toBe('plan');
    expect(q('fix-banner').textContent).toContain('Vous corrigez');
    expect(q('stub-editor').getAttribute('data-tool')).toBe('scale');
    expect(has('auto-steps')).toBe(true);
    // L'expert corrige l'échelle sur le plan.
    act(() =>
      m.store.getState().apply((ws) => ({
        ...ws,
        project: { ...ws.project, model: { ...ws.project.model, storeys: ws.project.model.storeys.map((s) => ({ ...s, metresPerUnit: { value: 0.01, from: 'user' as const } })) } },
      })),
    );
    await click('fix-done');
    expect(m.store.getState().step).toBe('doubts');
    expect(selectOpenDoubts(m.store.getState()).map((d) => d.id)).toEqual(['materials', 'windows']);
    expect(card()).not.toBe('occasion');
  });
});

// ───────────────────────────── Dossier ─────────────────────────────

describe('dossier', () => {
  it('feuilles dans l’ordre de LuxEeB-Tool, doutes ouverts rappelés en tête, encadré « reste à faire », jamais de classe', async () => {
    const m = await readPlanche();
    await click('ov-dossier-anyway');
    expect(m.store.getState().step).toBe('dossier');
    expect(all('open-doubt')).toHaveLength(4);
    const order = SHEETS_625.map((s) => s.key as string);
    const shown = all('dossier-sheet').map((s) => order.indexOf(s.getAttribute('data-sheet')!));
    expect(shown.length).toBeGreaterThan(2);
    expect(shown.every((v) => v >= 0)).toBe(true);
    expect([...shown].sort((a, b) => a - b)).toEqual(shown);
    expect(q('still-in-luxeeb').textContent).toContain('signés par vous');
    expect(text()).not.toMatch(/classe\s+[A-I]\b|Klasse\s+[A-I]\b/);
    // Les exports existants restent là.
    expect(text()).toContain('Tableaux à copier');
    await click('open-doubt-answer');
    expect(m.store.getState().step).toBe('doubts');
  });
});

// ───────────────────────────── Reprise, langue ─────────────────────────────

describe('reprise et langue', () => {
  it('après rechargement : même écran, réponses gardées, pas de miniature et proposition de redéposer la planche', async () => {
    const first = await readPlanche();
    await click('answer-doubts');
    await click('doubt-ok');
    first.store.getState().flushAutosave();
    const saved = first.storage.dump();
    await act(async () => {
      first.root.unmount();
    });
    first.container.remove();
    first.store.getState().dispose();
    mounted = null;

    const m = await mount(testStore({}, saved));
    await click('resume-saved');
    expect(m.store.getState().step).toBe('doubts');
    expect(card()).toBe('scale');
    act(() => m.store.getState().goTo('overview'));
    expect(has('sheet-thumb')).toBe(false);
    expect(has('redrop')).toBe(true);
    expect(document.querySelector('[data-field="occasion"]')?.getAttribute('data-trust')).toBe('user');

    // La planche redéposée retrouve ses étages sans relecture du projet.
    await drop(m, planche());
    expect(engine.built).toBe(1);
    expect(has('sheet-thumb')).toBe(true);
    expect(selectMarks(m.store.getState()).doubts?.occasion?.value).toBe('new');
  });

  it('en allemand', async () => {
    const m = await readPlanche();
    act(() => m.store.getState().setLang('de'));
    expect(text()).toContain('Das habe ich gelesen');
    expect(text()).toContain('Fragen beantworten (4)');
    await click('answer-doubts');
    expect(text()).toContain('Weiß ich nicht');
    expect(text()).toContain('Warum ich frage');
    act(() => m.store.getState().goTo('dossier'));
    expect(text()).toContain('Was in LuxEeB-Tool noch zu tun ist');
    expect(selectCanUndo(m.store.getState())).toBe(true);
  });
});
