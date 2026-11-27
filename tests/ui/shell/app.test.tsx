// @vitest-environment jsdom
/**
 * L'application rendue dans un navigateur simulé : parcours sans plan, questions, résultat, copie, langue,
 * formats fermés, mode expert. L'éditeur de plan (canvas) est remplacé par un bouchon qui joue son contrat ;
 * les lecteurs sont simulés ; le moteur et l'export sont les vrais.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDocument } from '../../../src/core/types';
import { GUIDE_SECTION_KEYS } from '../../../src/export';
import { App } from '../../../src/ui/shell';
import { STORAGE_KEYS } from '../../../src/ui/shell/autosave';
import { currentStorey, selectProject } from '../../../src/ui/shell/store';
import { houseDoc, testStore } from './helpers';
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
    if (/\.pln$/i.test(f.name)) throw new readers.UnsupportedFormatError('pln', f.name);
    const found = readers.documents.get(f.name);
    if (!found) throw new Error('lecture impossible');
    return found;
  },
}));

// Bouchon de l'éditeur de plan : il montre l'outil reçu et joue « tracer », « terminer l'outil », « tourner le nord ».
vi.mock('../../../src/ui/plan', async () => {
  const React = await import('react');
  type Props = import('../../../src/ui/plan').PlanEditorProps;
  const PlanEditor = (props: Props) => {
    const trace = (): void => {
      const outline = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 8 },
        { x: 0, y: 8 },
      ];
      props.onStoreyChange({ ...props.storey, outline, edges: outline.map(() => ({ boundary: 'outside' as const, constructionId: null })) });
    };
    return React.createElement(
      'div',
      { 'data-testid': 'stub-editor', 'data-tool': props.tool, 'data-sheet': props.sheet?.id ?? '', 'data-lang': props.lang, 'data-ghosts': String(props.ghostStoreys?.length ?? 0) },
      React.createElement('button', { type: 'button', 'data-testid': 'stub-trace', onClick: trace }, 'tracer'),
      React.createElement('button', { type: 'button', 'data-testid': 'stub-done', onClick: () => props.onToolDone?.(props.tool) }, 'terminer'),
      React.createElement('button', { type: 'button', 'data-testid': 'stub-north', onClick: () => props.onNorthChange(45) }, 'nord'),
    );
  };
  return { PlanEditor };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted extends TestStore {
  container: HTMLElement;
  root: Root;
}

let mounted: Mounted | null = null;
const copied: string[] = [];

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

async function choose(groupTestId: string, value: string): Promise<void> {
  const el = q(groupTestId).querySelector<HTMLElement>(`[data-value="${value}"]`);
  if (!el) throw new Error(`choix introuvable : ${groupTestId} / ${value}`);
  await click(el);
}

async function type(target: HTMLElement | string, value: string): Promise<void> {
  const el = (typeof target === 'string' ? q(target) : target) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    el.focus();
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  copied.length = 0;
  readers.documents.clear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });
  // Pas d'animation (compteurs) ni de défilement dans le navigateur simulé.
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
  vi.useRealTimers();
});

describe('accueil', () => {
  it('dit ce que fait l’outil et que les fichiers restent sur le poste', async () => {
    await mount();
    expect(document.documentElement.lang).toBe('fr');
    expect(text()).toContain('Vos fichiers ne quittent jamais cet ordinateur.');
    expect(text()).toContain('IFC · DWG · DXF · PDF · PNG / JPG');
    expect(has('try-sample') && has('start-blank') && has('open-project')).toBe(true);
    // Les étapes qui n'ont pas encore de sens sont verrouillées.
    expect((q('step-read') as HTMLButtonElement).disabled).toBe(true);
    expect((q('step-plan') as HTMLButtonElement).disabled).toBe(true);
    expect((q('undo') as HTMLButtonElement).disabled).toBe(true);
    // Le sélecteur de fichiers accepte plusieurs plans.
    expect((q('plan-input') as HTMLInputElement).multiple).toBe(true);
  });

  it('passe en allemand, s’en souvient, et garde l’état', async () => {
    const m = await mount();
    await click('start-blank');
    await click('step-home');
    await click('lang-de');
    expect(document.documentElement.lang).toBe('de');
    expect(document.title).toContain('LuxEeB-Tool');
    expect(text()).toContain('Ihre Dateien verlassen diesen Rechner nie.');
    expect(q('lang-de').getAttribute('aria-pressed')).toBe('true');
    expect(m.storage.getItem(STORAGE_KEYS.lang)).toBe('de');
    // Le projet en cours est toujours là.
    expect(selectProject(m.store.getState()).model.storeys).toHaveLength(1);
    await click('step-plan');
    expect(q('stub-editor').getAttribute('data-lang')).toBe('de');
    expect(text()).toContain('Beheizter Umriss');
  });

  it('propose de reprendre le projet retrouvé sur le poste', async () => {
    const first = testStore();
    first.store.getState().startBlank();
    first.store.getState().answer({ projectName: 'Maison Weber' });
    await mount(testStore({}, first.storage.dump()));
    expect(text()).toContain('Maison Weber');
    await click('resume-saved');
    expect(has('stub-editor')).toBe(true);
    expect(text()).toContain('Rez-de-chaussée');
  });

  it('explique un fichier Archicad : recette d’export, trois options, e-mail prêt à copier en français ou en allemand', async () => {
    const m = await mount();
    await act(async () => {
      await m.store.getState().ingestFiles([{ name: 'villa.pln', arrayBuffer: async () => new ArrayBuffer(4) }]);
    });
    const dialog = q('closed-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const content = dialog.textContent ?? '';
    expect(content).toContain('ne se lit que dans Archicad');
    expect(content).toContain('Enregistrer sous');
    for (const option of ['IFC Base Quantities', 'IFC Space boundaries', 'Building Material properties']) expect(content).toContain(option);
    const mail = q('mail-body') as HTMLTextAreaElement;
    expect(mail.value).toContain('villa.pln');
    expect(mail.value).toContain('IFC Space boundaries');
    expect(mail.value).toContain('Bonjour');

    await click('copy-mail');
    expect(copied[0]).toContain('certificat de performance énergétique');
    expect(copied[0]).toContain('villa.pln');

    const deButton = Array.from(dialog.querySelectorAll<HTMLElement>('.mail .lang__btn')).find((b) => b.textContent === 'DE');
    await click(deButton!);
    expect((q('mail-body') as HTMLTextAreaElement).value).toContain('Guten Tag');
    expect((q('mail-body') as HTMLTextAreaElement).value).toContain('Energiepass');

    await click('dialog-close');
    expect(has('closed-dialog')).toBe(false);
    expect(m.store.getState().step).toBe('home');
  });
});

describe('lecture', () => {
  it('montre une carte par document, puis construit le bâtiment d’un toucher', async () => {
    readers.documents.set('maison.dxf', houseDoc() satisfies PlanDocument);
    const m = await mount();
    await act(async () => {
      await m.store.getState().ingestFiles([{ name: 'maison.dxf', arrayBuffer: async () => new ArrayBuffer(4) }]);
    });
    expect(all('doc-card')).toHaveLength(1);
    expect(all('sheet-row')).toHaveLength(2);
    const card = q('doc-card').textContent ?? '';
    expect(card).toContain('maison.dxf');
    expect(card).toContain('1 unité du dessin = 1 cm');
    expect(card).toContain('confirmée');
    expect(card).toContain('3 lues, 52,5 m² au total');
    expect(card).toContain('à trancher : 1');
    expect(card).toContain('azimut 340°');
    expect(card).toContain('2 plans trouvés dans le même dessin.');
    expect(all('stack-row')).toHaveLength(2);
    expect(text()).toContain('Dalle sur terre-plein');

    // Ajuster : renommer l'étage du haut (affiché en premier, comme une coupe).
    await type(all('stack-name')[0]!, 'Combles aménagés');
    await click('accept-read');
    expect(has('stub-editor')).toBe(true);
    expect(all('storey-tab').map((t) => t.querySelector('.tabs__name')?.textContent)).toEqual(['Rez-de-chaussée', 'Combles aménagés']);
    expect(q('stub-editor').getAttribute('data-sheet')).toBe('maison.dxf#cad-1');
    // Ce que le lecteur a proposé est pré-coché « à confirmer ».
    expect(q('plan-step-scale').getAttribute('data-state')).toBe('toConfirm');
    expect(q('plan-step-outline').getAttribute('data-state')).toBe('toConfirm');
    expect(q('plan-step-rooms').getAttribute('data-state')).toBe('todo');
  });
});

describe('plan', () => {
  it('guide étape par étape, règle l’outil de l’éditeur et fait vivre les totaux', async () => {
    const m = await mount();
    await click('start-blank');
    // Grille vierge : l'échelle est acquise, on commence par le contour.
    expect(q('plan-step-scale').getAttribute('data-state')).toBe('done');
    expect(q('stub-editor').getAttribute('data-tool')).toBe('outline');
    expect(q('plan-step-detail').textContent).toContain('dimensions extérieures');
    expect(q('plan-step-boundary').getAttribute('data-state')).toBe('blocked');

    await click('stub-trace');
    expect(q('plan-step-outline').getAttribute('data-state')).toBe('toConfirm');
    await click('stub-done');
    expect(q('plan-step-outline').getAttribute('data-state')).toBe('done');
    expect(q('stub-editor').getAttribute('data-tool')).toBe('boundary');
    expect(q('announcer').textContent).toContain('Contour chauffé');

    await click('plan-confirm-boundary');
    expect(q('stub-editor').getAttribute('data-tool')).toBe('opening');
    await click('plan-step-button-north');
    expect(q('stub-editor').getAttribute('data-tool')).toBe('north');
    await click('stub-north');
    expect(selectProject(m.store.getState()).model.northAngle).toEqual({ value: 45, from: 'user' });
    expect(q('plan-step-north').getAttribute('data-state')).toBe('done');

    // Totaux calculés par le moteur : 10 m × 8 m × 2,80 m.
    const totals = q('totals').textContent ?? '';
    expect(totals).toContain('224,0');
    expect(totals).toContain('64,0'); // An estimée à 80 % de 80 m²

    // Hauteur corrigée : provenance « vous », volume recalculé.
    await type('height-gross', '3');
    expect(currentStorey(m.store.getState())?.grossHeight).toEqual({ value: 3, from: 'user' });
    expect(q('totals').textContent).toContain('240,0');
    await click('height-confirm-clear');
    expect(currentStorey(m.store.getState())?.clearHeight).toEqual({ value: 2.5, from: 'user' });

    // Surface nette saisie : l'étape « pièces » est réglée.
    await type('net-area', '61,5');
    expect(q('plan-step-rooms').getAttribute('data-state')).toBe('done');
    expect(q('totals').textContent).toContain('61,5');
  });

  it('gère les étages : ajouter, renommer, dupliquer, supprimer ; Ctrl+Z annule, Ctrl+Maj+Z rétablit', async () => {
    const m = await mount();
    await click('start-blank');
    await click('stub-trace');
    await click('manage-storey');
    await type('storey-name', 'RDC');
    expect(all('storey-tab')[0]!.textContent).toContain('RDC');
    await click('storey-duplicate');
    expect(all('storey-tab')).toHaveLength(2);
    expect(all('storey-tab')[1]!.getAttribute('aria-selected')).toBe('true');
    // Deux étages sur la même grille : l'autre apparaît en filigrane.
    expect(q('stub-editor').getAttribute('data-ghosts')).toBe('1');
    await click('add-storey');
    expect(all('storey-tab')).toHaveLength(3);
    await click('storey-remove');
    expect(all('storey-tab')).toHaveLength(2);
    expect(q('toast').textContent).toContain('supprimé');

    await key({ key: 'z', ctrlKey: true });
    expect(all('storey-tab')).toHaveLength(3);
    await key({ key: 'z', ctrlKey: true });
    expect(all('storey-tab')).toHaveLength(2);
    await key({ key: 'Z', ctrlKey: true, shiftKey: true });
    expect(all('storey-tab')).toHaveLength(3);
    await click('undo');
    expect(selectProject(m.store.getState()).model.storeys).toHaveLength(2);
    await click('redo');
    expect(selectProject(m.store.getState()).model.storeys).toHaveLength(3);
  });
});

describe('questions', () => {
  it('une question par écran, avec sa raison ; les choix règlent le projet ; « je ne sais pas » fait avancer', async () => {
    const m = await mount();
    await click('start-blank');
    await click('stub-trace');
    await click('to-questions');

    // La seule question indispensable vient en premier : sans elle, pas de résultat ; pas de « je ne sais pas ».
    expect(has('question-closure')).toBe(true);
    expect(text()).toContain('La seule question indispensable');
    expect(text()).toContain('Pourquoi cette question ?');
    expect((q('q-continue') as HTMLButtonElement).disabled).toBe(true);
    expect(has('q-skip')).toBe(false);

    // Toiture et plancher : la réponse change le bâtiment, les totaux réagissent.
    const before = q('q-live').textContent;
    expect(text()).toContain('Hypothèse actuelle');
    await choose('q-top', 'flat-roof');
    expect(selectProject(m.store.getState()).model.top).toMatchObject({ kind: 'flat-roof', from: 'user' });
    // Toit incliné : le toucher ne confirme pas d'office la pente et la jambette par défaut.
    await choose('q-top', 'pitched-roof');
    expect(has('q-pitch')).toBe(true);
    expect(selectProject(m.store.getState()).model.top).toMatchObject({ kind: 'pitched-roof', from: 'estimate' });
    await choose('q-pitch', '45');
    await choose('q-knee', '1');
    // Deux pans : le sens du faîtage se choisit, l'hypothèse est affichée tant qu'il ne l'est pas.
    expect(has('q-ridge')).toBe(true);
    expect(text()).toContain('Vers où descendent les deux pans');
    const ridges = Array.from(q('q-ridge').querySelectorAll<HTMLButtonElement>('button.choice'));
    expect(ridges).toHaveLength(2);
    await choose('q-ridge', ridges[1]!.dataset.value!);
    expect(selectProject(m.store.getState()).model.top.ridgeAngle).toBe(Number(ridges[1]!.dataset.value));
    expect(selectProject(m.store.getState()).model.top.from).toBe('estimate');
    // Quatre pans : le faîtage suit la grande dimension, plus rien à choisir.
    await choose('q-shape', 'hip');
    expect(has('q-ridge')).toBe(false);
    expect(selectProject(m.store.getState()).model.top).toMatchObject({ kind: 'pitched-roof', pitchDeg: 45, shape: 'hip', kneeWallHeight: 1, ridgeAngle: null, from: 'estimate' });
    await choose('q-bottom', 'above-unheated');
    expect(selectProject(m.store.getState()).model.bottom).toMatchObject({ kind: 'above-unheated', from: 'user' });
    expect((q('q-continue') as HTMLButtonElement).disabled).toBe(true); // la toiture n'est pas encore confirmée
    expect(has('q-notes')).toBe(false);
    await click('q-roof-confirm');
    expect(selectProject(m.store.getState()).model.top).toMatchObject({ kind: 'pitched-roof', pitchDeg: 45, shape: 'hip', kneeWallHeight: 1, from: 'user' });
    expect(has('q-roof-confirm')).toBe(false);
    expect(q('q-live').textContent).not.toBe(before);

    // Question indispensable répondue : le résultat est prêt ; les notes de visite sont proposées, pas exigées.
    expect((q('q-continue') as HTMLButtonElement).disabled).toBe(false);
    expect(q('q-continue').textContent).toContain('Voir le résultat');
    expect(text()).toContain('notes de visite');
    await click('q-notes');

    expect(has('question-context')).toBe(true);
    expect(text()).toContain('Note de visite 1 sur 8');
    expect(has('q-skip')).toBe(true);
    expect(has('q-to-result')).toBe(true);
    await choose('q-occasion', 'existing');
    await choose('q-building-type', 'EFH');
    expect(selectProject(m.store.getState()).answers).toMatchObject({ occasion: 'existing', buildingType: 'EFH', dwellings: 1 });
    await click('q-continue');

    expect(has('question-year')).toBe(true);
    await choose('q-period', 'p5');
    expect(selectProject(m.store.getState()).answers.yearBuilt).toBe(1975);
    expect(text()).toContain('Année approximative inscrite : 1975');
    await type('q-year', '1972');
    expect(selectProject(m.store.getState()).answers.yearBuilt).toBe(1972);
    expect(text()).not.toContain('Année approximative');
    await click('q-continue');

    expect(has('question-insulation')).toBe(true);
    await choose('q-insulation-walls', '12');
    await choose('q-insulation-roof', '0');
    await type('q-insulation-floor-exact', '5,5');
    expect(selectProject(m.store.getState()).answers).toMatchObject({ insulationWallsCm: 12, insulationRoofCm: 0, insulationFloorCm: 5.5 });
    await click('q-continue');

    // Choix unique : toucher suffit, l'écran suivant arrive tout seul.
    expect(has('question-windows')).toBe(true);
    vi.useFakeTimers();
    await choose('q-windows', 'triple');
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    expect(has('question-heating')).toBe(true);
    expect(selectProject(m.store.getState()).answers.windowGeneration).toBe('triple');

    await click('q-skip');
    expect(has('question-hotWater')).toBe(true);
    expect(q('dot-heating').className).toContain('dots__dot--skipped');
    // Touche 2 : deuxième choix.
    await key({ key: '2' });
    expect(selectProject(m.store.getState()).answers.hotWater).toBe('separate-electric');

    // Retour par les pastilles : la réponse est toujours là.
    await click('dot-context');
    expect(q('q-occasion').querySelector('[data-value="existing"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('un bâtiment neuf ne voit pas la question sur l’isolation ajoutée', async () => {
    const m = await mount();
    await click('step-questions');
    await click('dot-context');
    await choose('q-occasion', 'new');
    await choose('q-building-type', 'MFH');
    expect(text()).toContain('Note de visite 1 sur 7');
    expect(has('dot-insulation')).toBe(false);
    // Immeuble : le nombre de logements est demandé — sans bloquer, c'est une note de visite.
    expect(has('q-dwellings')).toBe(true);
    await type('q-dwellings', '6');
    expect(selectProject(m.store.getState()).answers.dwellings).toBe(6);
  });
});

describe('résultat', () => {
  async function toResult(): Promise<Mounted> {
    const m = await mount();
    await click('start-blank');
    await click('stub-trace');
    m.store.getState().answer({ occasion: 'existing', buildingType: 'EFH', dwellings: 1, yearBuilt: 1974, projectName: 'Maison test' });
    await click('step-result');
    return m;
  }

  it('présente les sections dans l’ordre de LuxEeB-Tool, avec les termes de l’outil', async () => {
    await toResult();
    expect(all('guide-section').map((s) => s.getAttribute('data-key'))).toEqual([...GUIDE_SECTION_KEYS]);
    const page = text();
    expect(page).toContain('Flächeneingabe der Gebäudehülle');
    expect(page).toContain('Allgemeine Projektdaten');
    expect(page).toContain('Rien n’est transmis à LuxEeB-Tool');
    // Chaque valeur porte son étiquette de provenance.
    expect(document.querySelectorAll('[data-testid="guide-item"] .tag').length).toBe(all('guide-item').length);
    expect(document.querySelectorAll('.tag--user').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.tag--default, .tag--estimate').length).toBeGreaterThan(0);
  });

  it('n’affiche aucune classe énergétique et ne promet aucune saisie automatique', async () => {
    await toResult();
    const page = text().toLowerCase();
    expect(page).not.toMatch(/classe énergétique|classe [a-i]\b|energieklasse/);
    expect(page).not.toMatch(/saisie automatique|rempli automatiquement|envoyé à luxeeb/);
  });

  it('copie une valeur avec confirmation visible et annoncée', async () => {
    await toResult();
    const year = all('guide-item').find((i) => i.getAttribute('data-key') === 'project.yearBuilt')!;
    const button = year.querySelector<HTMLElement>('[data-testid="copy-item"]')!;
    expect(button.textContent).toBe('Copier');
    await click(button);
    expect(copied).toEqual(['1974']);
    expect(button.getAttribute('data-state')).toBe('copied');
    expect(button.textContent).toBe('Copié');
    const live = q('announcer');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toContain('Copié : 1974');
  });

  it('copie un bloc, une ligne ou une cellule, et coche les lignes saisies', async () => {
    const m = await toResult();
    const envelope = all('guide-table').find((t) => t.getAttribute('data-key') === 'envelope')!;
    const rows = Array.from(envelope.querySelectorAll<HTMLElement>('[data-testid="guide-row"]'));
    expect(rows.length).toBeGreaterThanOrEqual(6); // 4 murs, plancher haut, plancher bas

    await click(envelope.querySelector<HTMLElement>('[data-testid="copy-block"]')!);
    const block = copied.at(-1)!;
    expect(block.split('\r\n')).toHaveLength(rows.length);
    expect(block.split('\r\n')[0]!.split('\t')).toHaveLength(4);
    expect(block).toMatch(/\d,\d\d/); // virgule décimale

    // La ligne copiée est exactement sa ligne du bloc.
    await click(rows[1]!.querySelector<HTMLElement>('[data-testid="copy-row"]')!);
    expect(copied.at(-1)).toBe(block.split('\r\n')[1]);

    // Une cellule seule.
    const cell = rows[0]!.querySelector<HTMLElement>('.copy--cell')!;
    await click(cell);
    expect(copied.at(-1)).toBe(cell.textContent);

    // Cocher une ligne : retenu, compté, et gardé au prochain démarrage.
    expect(envelope.textContent).toContain(`saisies : 0/${rows.length}`);
    const box = rows[0]!.querySelector<HTMLInputElement>('[data-testid="row-entered"]')!;
    await click(box);
    expect(Array.from(envelope.querySelectorAll('[data-testid="guide-row"]'))[0]!.className).toContain('is-entered');
    expect(envelope.textContent).toContain(`saisies : 1/${rows.length}`);
    expect(JSON.parse(m.storage.getItem(STORAGE_KEYS.entered)!)).toHaveLength(1);
  });

  it('place les contrôles en haut, bloquants d’abord, chacun avec son bouton vers l’endroit à corriger', async () => {
    const m = await mount();
    await click('step-result');
    // Aucun étage : un constat bloquant, en tête.
    const first = all('finding')[0]!;
    expect(first.getAttribute('data-code')).toBe('model.noStorey');
    expect(first.className).toContain('finding--block');
    expect(q('findings').textContent).toContain('bloquants : 1');
    await click(first.querySelector<HTMLElement>('[data-testid="finding-jump"]')!);
    // Le bouton mène au plan, sur l'outil de contour (une grille vierge est ouverte).
    expect(q('stub-editor').getAttribute('data-tool')).toBe('outline');

    await click('stub-trace');
    await click('step-result');
    const codes = all('finding').map((f) => f.getAttribute('data-code'));
    expect(codes).not.toContain('model.noStorey');
    expect(codes).toContain('height.default');
    const order = all('finding').map((f) => (f.className.includes('--block') ? 0 : f.className.includes('--warn') ? 1 : 2));
    expect(order).toEqual([...order].sort((a, b) => a - b));

    const height = all('finding').find((f) => f.getAttribute('data-code') === 'height.default')!;
    expect(height.textContent).toContain('Corriger les hauteurs');
    await click(height.querySelector<HTMLElement>('[data-testid="finding-jump"]')!);
    expect(m.store.getState()).toMatchObject({ step: 'plan', planFocus: 'heights' });

    await click('step-result');
    const top = all('finding').find((f) => f.getAttribute('data-code') === 'top.default')!;
    await click(top.querySelector<HTMLElement>('[data-testid="finding-jump"]')!);
    expect(has('question-closure')).toBe(true);
  });

  it('prépare les téléchargements : CSV, projet, dossier', async () => {
    await toResult();
    const created: Blob[] = [];
    const clicks: string[] = [];
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      created.push(blob as Blob);
      return `blob:test-${created.length}`;
    };
    URL.revokeObjectURL = () => undefined;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      clicks.push(this.download);
    };
    const opened: string[] = [];
    window.open = ((url: string) => {
      opened.push(url);
      return null; // fenêtre bloquée : le dossier doit alors être proposé en téléchargement
    }) as unknown as typeof window.open;
    try {
      await click('download-csv');
      await click('download-json');
      await click('download-report');
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
    expect(clicks).toEqual(['plan2cpe-maison-test-releve.csv', 'plan2cpe-maison-test.json', 'plan2cpe-maison-test-dossier.html']);
    expect(opened).toHaveLength(1);
    expect(created.map((b) => b.type)).toEqual(['text/csv;charset=utf-8', 'application/json', 'text/html;charset=utf-8', 'text/html;charset=utf-8']);
    expect(q('toast').textContent).toContain('bloquée');
  });
});

describe('mode expert', () => {
  it('ouvre les tableaux modifiables ; une valeur U saisie y porte la provenance « vous » et apparaît dans le résultat', async () => {
    const m = await mount();
    await click('start-blank');
    await click('stub-trace');
    await click('expert-toggle');
    const panel = q('expert-panel');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(q('expert-toggle').getAttribute('aria-pressed')).toBe('true');

    const u = panel.querySelector<HTMLInputElement>('[data-testid="x-u"]')!;
    await type(u, '0,28');
    expect(selectProject(m.store.getState()).model.constructions[0]!.u).toEqual({ value: 0.28, from: 'user' });
    expect(q('x-constructions').querySelector('tbody tr .tag--user')).not.toBeNull();

    await click('x-add-wall');
    expect(selectProject(m.store.getState()).model.constructions.at(-1)).toMatchObject({ category: 'wall', u: null });

    await click('x-tab-manual');
    await click('x-add-manual');
    expect(selectProject(m.store.getState()).model.manualRows).toHaveLength(1);
    expect(has('x-manual')).toBe(true);

    await click('x-tab-rooms');
    await click('x-add-room');
    await type(q('x-room-area'), '14,2');
    expect(currentStorey(m.store.getState())?.rooms[0]).toMatchObject({ area: { value: 14.2, from: 'user' }, needsReview: false });

    await click('x-tab-storeys');
    expect(has('x-storey')).toBe(true);
    expect(has('x-edges')).toBe(true);

    // Échap ferme le panneau.
    await act(async () => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(has('expert-panel')).toBe(false);

    await click('step-result');
    const opaque = all('guide-table').find((t) => t.getAttribute('data-key') === 'constructions')!;
    expect(opaque.textContent).toContain('0,28');
  });
});
