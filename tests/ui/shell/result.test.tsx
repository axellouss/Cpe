// @vitest-environment jsdom
/**
 * Écran « Résultat » seul, sur un vrai projet (moteur et export réels, lecteurs simulés) :
 *  - la grille ne montre que les colonnes de LuxEeB-Tool ; aides de lecture et remarque passent sous la ligne ;
 *  - la copie d'une ligne est exactement une ligne du bloc, et n'existe pas pour un tableau sans bloc ;
 *  - une coche « saisie » survit au changement de langue et tombe quand une valeur à saisir change ;
 *  - le bouton des lignes à marquer dit ce qu'il copie.
 * La mise en page elle-même (aucun défilement en largeur, cartes sur écran étroit) se vérifie dans un navigateur :
 * le navigateur simulé n'applique pas les feuilles de style.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lang, ManualRow, Storey } from '../../../src/core/types';
import { buildGuide } from '../../../src/export';
import type { GuideTable } from '../../../src/export';
import { STORAGE_KEYS } from '../../../src/ui/shell/autosave';
import { AnnounceProvider } from '../../../src/ui/shell/components/common';
import { ResultScreen, rowCopyText, rowKey, tableLayout } from '../../../src/ui/shell/components/ResultScreen';
import { derive } from '../../../src/ui/shell/compute';
import '../../../src/ui/shell/messages';
import { currentStorey, selectProject, ShellStoreContext } from '../../../src/ui/shell/store';
import { rect, testStore } from './helpers';
import type { TestStore } from './helpers';

vi.mock('../../../src/readers', () => ({
  UnsupportedFormatError: class UnsupportedFormatError extends Error {},
  readPlanFile: async () => {
    throw new Error('aucun lecteur dans ce test');
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted extends TestStore {
  container: HTMLElement;
  root: Root;
}

let mounted: Mounted | null = null;
const copied: string[] = [];

/** Maison de 10 m × 8 m, une fenêtre double au nord et une porte au sud : de quoi avoir des lignes à déduire. */
function house(test: TestStore): void {
  const state = test.store.getState();
  state.startBlank();
  const storey = currentStorey(test.store.getState())!;
  const outline = rect(10, 8);
  const next: Storey = {
    ...storey,
    outline,
    edges: outline.map(() => ({ boundary: 'outside' as const, constructionId: null })),
    openings: [
      { id: 'o1', edgeIndex: 0, kind: 'window', width: 1.2, height: 1.35, count: 2, position: 0.4, windowTypeId: null, from: 'plan' },
      { id: 'o2', edgeIndex: 2, kind: 'door', width: 1, height: 2.1, count: 1, position: 0.5, windowTypeId: null, from: 'plan' },
    ],
  };
  test.store.getState().storeyChanged(next);
  test.store.getState().answer({ occasion: 'existing', buildingType: 'EFH', dwellings: 1, yearBuilt: 1974, projectName: 'Maison test' });
}

async function mount(test: TestStore = testStore()): Promise<Mounted> {
  house(test);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ShellStoreContext.Provider value={test.store}>
        <AnnounceProvider>
          <ResultScreen />
        </AnnounceProvider>
      </ShellStoreContext.Provider>,
    );
  });
  mounted = { ...test, container, root };
  return mounted;
}

const all = (testId: string, within: ParentNode = document): HTMLElement[] => Array.from(within.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));

function tableEl(key: string): HTMLElement {
  const found = all('guide-table').find((t) => t.getAttribute('data-key') === key);
  if (!found) throw new Error(`tableau absent : ${key}`);
  return found;
}

const rowsOf = (key: string): HTMLElement[] => all('guide-row', tableEl(key));
const box = (row: HTMLElement): HTMLInputElement => row.querySelector<HTMLInputElement>('[data-testid="row-entered"]')!;
const texts = (elements: Iterable<Element>): string[] => Array.from(elements, (el) => (el.textContent ?? '').trim());

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function setLang(m: Mounted, lang: Lang): Promise<void> {
  await act(async () => {
    m.store.getState().setLang(lang);
  });
}

/** Le guide que l'écran affiche, pour comparer sans recopier les valeurs du moteur. */
function guideTable(m: Mounted, key: string): GuideTable {
  const state = m.store.getState();
  const project = selectProject(state);
  const sheets = derive(project, state.lang).sheets!;
  return buildGuide(sheets, project, state.lang)
    .flatMap((s) => s.tables)
    .find((tb) => tb.key === key)!;
}

beforeEach(() => {
  copied.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
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
});

describe('résultat — chiffres-clés', () => {
  it('chaque chiffre-clé porte sa provenance : une enveloppe calculée sur des hauteurs par défaut ne passe pas pour un fait', async () => {
    const m = await mount();
    const figures = Array.from(document.querySelectorAll<HTMLElement>('.figures__item'));
    expect(figures).toHaveLength(5);
    // An, Ve, enveloppe A, fenêtres, A/Ve : tous étiquetés.
    for (const figure of figures) expect(figure.querySelector('.tag'), figure.textContent ?? '').not.toBeNull();
    // Hauteurs d'étage par défaut : l'enveloppe, Ve et A/Ve le disent, comme les valeurs de contrôle du guide.
    const tagOf = (i: number): string => figures[i]!.querySelector('.tag')!.className;
    expect(tagOf(1)).toContain('tag--default');
    expect(tagOf(2)).toContain('tag--default');
    expect(tagOf(4)).toContain('tag--default');
    const check = buildGuide(derive(selectProject(m.store.getState()), 'fr').sheets!, selectProject(m.store.getState()), 'fr').find((s) => s.key === 'check')!;
    expect(check.items.find((i) => i.key === 'check.envelopeGross')!.from).toBe('default');
  });
});

describe('résultat — grille aux colonnes de LuxEeB-Tool', () => {
  it('ne met dans la grille de l’enveloppe que les colonnes de l’outil, dans son ordre, entre la coche et la source', async () => {
    await mount();
    const envelope = tableEl('envelope');
    const head = Array.from(envelope.querySelectorAll('thead th'));
    expect(texts(envelope.querySelectorAll('thead .gtable__term'))).toEqual([
      'N°',
      'Bauteil',
      'Anzahl',
      'Länge (Rohbaumaß) [m]',
      'Breite (Rohbaumaß) [m]',
      'Orientierung',
      'Abzug',
      'A [m²]',
    ]);
    // coche + 8 colonnes de l'outil + source + copie de la ligne : rien d'autre ne tient de la place en largeur
    expect(head).toHaveLength(11);
    expect(head[0]!.textContent).toContain('Saisie dans LuxEeB-Tool');
    expect(head.at(-2)!.textContent).toBe('Source');
    expect(head.at(-1)!.textContent).toBe('Copier la ligne');
    for (const column of ['Repère du relevé', 'Orientation (azimut)', 'Contre']) expect(texts(head).join('|')).not.toContain(column);

    const rows = rowsOf('envelope');
    expect(rows.length).toBeGreaterThanOrEqual(8); // fenêtre, porte, 4 murs, plancher haut, plancher bas
    for (const row of rows) {
      const main = row.querySelector('.gtable__main')!;
      // la première rangée de la ligne : la coche, les 8 valeurs, la provenance, la copie de la ligne
      expect(main.children).toHaveLength(11);
      expect(all('row-cell', main)).toHaveLength(8);
      expect(main.querySelectorAll('[data-testid="row-entered"]')).toHaveLength(1);
      expect(main.querySelectorAll('.tag')).toHaveLength(1);
      expect(main.querySelectorAll('[data-testid="copy-row"]')).toHaveLength(1);
    }
  });

  it('place les aides de lecture et la remarque sous la ligne, en texte qui revient à la ligne', async () => {
    const m = await mount();
    const guide = guideTable(m, 'envelope');
    const rows = rowsOf('envelope');
    rows.forEach((row, i) => {
      const aside = row.querySelector<HTMLElement>('[data-testid="row-aside"]')!;
      expect(texts(aside.querySelectorAll('dt'))).toEqual(['Repère du relevé', 'Orientation (azimut)', 'Contre']);
      expect(texts(aside.querySelectorAll('dd'))).toEqual(guide.aside.map((c) => guide.rows[i]!.cells[c]));
      // Ce ne sont pas des valeurs de l'outil : rien à copier ici.
      expect(aside.querySelectorAll('button')).toHaveLength(0);
      // Et elles ne sont plus dans la grille.
      const main = texts(all('row-cell', row));
      expect(main).toEqual(guide.rows[i]!.cells.filter((_, c) => !guide.aside.includes(c)).map((cell) => (cell === '' ? '' : cell)).map((cell, c) => `${texts(row.querySelectorAll('.gtable__label'))[c]}${cell || '–'}`));
    });
    // La remarque d'une ligne à déduire suit ses aides, dans la même cellule.
    const window = rows[0]!;
    expect(window.className).toContain('is-deduct');
    expect(window.querySelector('[data-testid="row-aside"] .gtable__note')!.textContent).toBe('À déduire de la prochaine ligne sans « x ».');
    expect(window.querySelector('[data-testid="row-aside"] td[colspan]')!.getAttribute('colspan')).toBe('10');
  });

  it('garde sur chaque valeur le nom de sa colonne dans l’outil, pour l’affichage en cartes', async () => {
    await mount();
    for (const key of ['constructions', 'windowTypes', 'envelope', 'zones', 'volumes']) {
      const terms = texts(tableEl(key).querySelectorAll('thead .gtable__term'));
      for (const row of rowsOf(key)) {
        const labels = Array.from(row.querySelectorAll('.gtable__label'));
        expect(texts(labels), key).toEqual(terms);
        // Le lecteur d'écran a déjà l'en-tête de colonne : le rappel visuel ne doit pas être lu deux fois.
        for (const label of labels) expect(label.getAttribute('aria-hidden')).toBe('true');
      }
    }
  });

  it('reste un tableau pour un lecteur d’écran, même mis en cartes : rôles écrits en toutes lettres', async () => {
    await mount();
    const envelope = tableEl('envelope');
    const table = envelope.querySelector('table')!;
    expect(table.getAttribute('role')).toBe('table');
    expect(document.getElementById(table.getAttribute('aria-labelledby')!)!.textContent).toBe('Enveloppe (Flächeneingabe der Gebäudehülle)');
    for (const th of table.querySelectorAll('th')) expect(th.getAttribute('role')).toBe('columnheader');
    for (const group of table.querySelectorAll('thead, tbody')) expect(group.getAttribute('role')).toBe('rowgroup');
    for (const tr of table.querySelectorAll('tr')) expect(tr.getAttribute('role')).toBe('row');
    for (const td of table.querySelectorAll('td')) expect(td.getAttribute('role')).toBe('cell');
    // Chaque coche et chaque bouton a un nom ; rien n'est accessible seulement au survol ou au glissement.
    for (const input of table.querySelectorAll('input')) expect(input.getAttribute('aria-label')).toMatch(/^Ligne \d+ saisie dans LuxEeB-Tool$/);
    for (const button of table.querySelectorAll('button')) expect(button.getAttribute('aria-label')).toMatch(/^Copier /);
  });

  it('sépare aussi les aides de lecture des types d’éléments, de fenêtres et des zones', async () => {
    await mount();
    expect(texts(tableEl('constructions').querySelectorAll('thead .gtable__term'))).toEqual([
      'Bezeichnung',
      'U-Wert [W/(m²K)]',
      'Einbausituation',
      'Fläche des Bauteils A [m²]',
      'Perimeter P [m]',
    ]);
    expect(texts(rowsOf('constructions')[0]!.querySelectorAll('[data-testid="row-aside"] dt'))).toEqual(['Catégorie', 'Contre', 'Surface totale [m²]']);
    expect(rowsOf('constructions')[0]!.querySelector('[data-testid="row-aside"] .gtable__note')!.textContent).toContain('Valeur U');

    expect(texts(tableEl('windowTypes').querySelectorAll('thead .gtable__term'))).toEqual(['Bezeichnung', 'Breite [m]', 'Höhe [m]', 'g-Wert [-]', 'U-Wert Fenster [W/(m²K)]']);
    expect(texts(rowsOf('windowTypes')[0]!.querySelectorAll('[data-testid="row-aside"] dt'))).toEqual(['Nombre de fenêtres', 'Surface totale [m²]']);

    expect(texts(tableEl('zones').querySelectorAll('thead .gtable__term'))).toEqual(['Raumbezeichnung', 'Anzahl', 'Breite [m]', 'Länge [m]', 'Vn [m³]']);
    expect(texts(rowsOf('zones')[0]!.querySelectorAll('[data-testid="row-aside"] dt'))).toEqual(['Hauteur libre [m]']);
    // Volumes : aucune aide, aucune remarque — pas de seconde rangée vide.
    expect(rowsOf('volumes')[0]!.querySelector('[data-testid="row-aside"]')).toBeNull();
  });

  it('répartit les colonnes sans rien perdre : grille + aides = toutes les colonnes du guide', async () => {
    const m = await mount();
    for (const key of ['constructions', 'windowTypes', 'envelope', 'zones', 'volumes']) {
      const table = guideTable(m, key);
      const layout = tableLayout(table);
      expect([...layout.grid, ...layout.aside].sort((a, b) => a - b), key).toEqual(table.columns.map((_, c) => c));
      expect(layout.aside, key).toEqual(table.aside);
      // Le nom de la ligne est la première colonne de texte de la grille.
      expect(table.columns[layout.lead]!.split(' — ')[0], key).toBe(key === 'envelope' ? 'Bauteil' : key === 'zones' ? 'Raumbezeichnung' : 'Bezeichnung');
    }
    // « Einbausituation » est un texte long de l'outil : deux places sur une carte ; « Orientierung » n'en prend qu'une.
    const constructions = guideTable(m, 'constructions');
    expect(tableLayout(constructions).wide[4]).toBe(true);
    expect(tableLayout(guideTable(m, 'envelope')).wide.some(Boolean)).toBe(false);
  });
});

describe('résultat — copie d’une ligne', () => {
  it('copie exactement une ligne du bloc à coller : 4 colonnes pour l’enveloppe et les zones, 5 pour les volumes', async () => {
    await mount();
    for (const [key, columns] of [
      ['envelope', 4],
      ['zones', 4],
      ['volumes', 5],
    ] as const) {
      const table = tableEl(key);
      await click(table.querySelector<HTMLElement>('[data-testid="copy-block"]')!);
      const lines = copied.at(-1)!.split('\r\n');
      const rows = rowsOf(key);
      expect(lines, key).toHaveLength(rows.length);
      for (const [i, row] of rows.entries()) {
        const button = row.querySelector<HTMLElement>('[data-testid="copy-row"]')!;
        expect(button.getAttribute('aria-label')).toBe(`Copier la ligne ${i + 1}`);
        await click(button);
        expect(copied.at(-1), `${key} ligne ${i + 1}`).toBe(lines[i]);
        expect(copied.at(-1)!.split('\t'), `${key} ligne ${i + 1}`).toHaveLength(columns);
      }
    }
  });

  it('ne propose aucune copie de ligne pour un tableau sans bloc : ses colonnes ne sont pas celles de l’outil', async () => {
    const m = await mount();
    for (const key of ['constructions', 'windowTypes']) {
      const table = tableEl(key);
      expect(rowsOf(key).length, key).toBeGreaterThan(0);
      expect(table.querySelector('[data-testid="copy-block"]'), key).toBeNull();
      expect(table.querySelectorAll('[data-testid="copy-row"]'), key).toHaveLength(0);
      // La colonne elle-même a disparu : coche + colonnes de l'outil + source.
      const guide = guideTable(m, key);
      expect(table.querySelectorAll('thead th'), key).toHaveLength(guide.columns.length - guide.aside.length + 2);
      expect(texts(table.querySelectorAll('thead th')).join('|'), key).not.toContain('Copier la ligne');
      guide.rows.forEach((_, i) => expect(rowCopyText(guide, i)).toBe(''));
      // La copie cellule par cellule reste.
      expect(rowsOf(key)[0]!.querySelectorAll('.copy--cell').length, key).toBeGreaterThan(0);
    }
  });
});

describe('résultat — coches « saisie dans LuxEeB-Tool »', () => {
  const progress = (): string[] => texts(document.querySelectorAll('.toc__progress'));
  const cellsOf = (row: HTMLElement): string[] => all('row-cell', row).map((cell) => (cell.querySelector('.copy--cell')?.textContent ?? '').trim());

  it('garde les coches quand on change de langue', async () => {
    const m = await mount();
    for (const key of ['constructions', 'windowTypes', 'envelope', 'zones', 'volumes']) {
      await click(box(rowsOf(key)[0]!));
    }
    await click(box(rowsOf('envelope')[3]!));
    const before = { constructions: rowsOf('constructions').length, envelope: rowsOf('envelope').length };
    expect(progress()).toEqual([`saisies : 1/${before.constructions}`, 'saisies : 1/1', `saisies : 2/${before.envelope}`, 'saisies : 2/2']);
    const stored = (): string[] => Object.keys((JSON.parse(m.storage.getItem(STORAGE_KEYS.marks)!) as { entered: Record<string, true> }).entered);
    expect(stored()).toHaveLength(6);

    await setLang(m, 'de');
    // Les textes ont bien changé de langue…
    expect(tableEl('envelope').textContent).toContain('Außenwand');
    expect(tableEl('envelope').textContent).not.toContain('Mur extérieur');
    // … et les coches sont toujours là, sur les mêmes lignes.
    expect(progress()).toEqual([`eingetragen: 1/${before.constructions}`, 'eingetragen: 1/1', `eingetragen: 2/${before.envelope}`, 'eingetragen: 2/2']);
    for (const key of ['constructions', 'windowTypes', 'envelope', 'zones', 'volumes']) {
      expect(box(rowsOf(key)[0]!).checked, key).toBe(true);
      expect(rowsOf(key)[0]!.className, key).toContain('is-entered');
    }
    expect(box(rowsOf('envelope')[3]!).checked).toBe(true);
    expect(box(rowsOf('envelope')[1]!).checked).toBe(false);
    expect(tableEl('envelope').textContent).toContain(`eingetragen: 2/${before.envelope}`);

    // Cocher en allemand, relire en français : même clé.
    await click(box(rowsOf('envelope')[1]!));
    await setLang(m, 'fr');
    expect(box(rowsOf('envelope')[1]!).checked).toBe(true);
    expect(progress()[2]).toBe(`saisies : 3/${before.envelope}`);
    expect(stored()).toHaveLength(7);
  });

  it('construit la clé sans aucun texte traduit', async () => {
    const m = await mount();
    const keysIn = async (lang: Lang): Promise<string[]> => {
      await setLang(m, lang);
      const state = m.store.getState();
      const project = selectProject(state);
      return buildGuide(derive(project, lang).sheets!, project, lang).flatMap((s) => s.tables.flatMap((tb) => tb.rows.map((row) => rowKey(s.key, tb.key, row))));
    };
    const fr = await keysIn('fr');
    const de = await keysIn('de');
    expect(fr.length).toBeGreaterThan(10);
    expect(de).toEqual(fr);
    expect(new Set(fr).size).toBe(fr.length);
    expect(rowKey('envelope', 'envelope', { id: 'wall:1', stamp: '1␟2,00' })).toBe(rowKey('envelope', 'envelope', { id: 'wall:1', stamp: '1␟2,00' }));
    expect(rowKey('envelope', 'envelope', { id: 'wall:1', stamp: '1␟2,00' })).not.toBe(rowKey('envelope', 'envelope', { id: 'wall:1', stamp: '1␟2,10' }));
    expect(rowKey('envelope', 'envelope', { id: 'wall:1', stamp: '1' })).not.toBe(rowKey('areas', 'zones', { id: 'wall:1', stamp: '1' }));
  });

  it('décoche la ligne dont une valeur à saisir change, et pas les autres', async () => {
    const m = await mount();
    const last = rowsOf('envelope').length - 1;
    // La fenêtre du nord (ligne 1) et une paroi qui ne la porte pas : le plancher bas (dernière ligne).
    expect(cellsOf(rowsOf('envelope')[0]!).slice(2, 5)).toEqual(['2,00', '1,20', '1,35']);
    await click(box(rowsOf('envelope')[0]!));
    await click(box(rowsOf('envelope')[last]!));
    await click(box(rowsOf('zones')[0]!));
    await click(box(rowsOf('constructions')[0]!));
    await click(box(rowsOf('windowTypes')[0]!));
    expect(box(rowsOf('envelope')[0]!).checked).toBe(true);
    const totalArea = (): string => texts(rowsOf('constructions')[0]!.querySelectorAll('[data-testid="row-aside"] dd'))[2]!;
    const areaBefore = totalArea();

    // La fenêtre passe de 1,20 m à 1,40 m de large.
    await act(async () => {
      const storey = currentStorey(m.store.getState())!;
      m.store.getState().storeyChanged({ ...storey, openings: storey.openings.map((o) => (o.id === 'o1' ? { ...o, width: 1.4 } : o)) });
    });
    expect(cellsOf(rowsOf('envelope')[0]!).slice(2, 5)).toEqual(['2,00', '1,40', '1,35']);
    expect(box(rowsOf('envelope')[0]!).checked).toBe(false);
    expect(rowsOf('envelope')[0]!.className).not.toContain('is-entered');
    // Les lignes dont rien ne change restent cochées.
    expect(box(rowsOf('envelope')[last]!).checked).toBe(true);
    expect(box(rowsOf('zones')[0]!).checked).toBe(true);
    // Type d'élément (mur) : sa surface totale change, mais elle ne se saisit pas sur cette ligne.
    expect(totalArea()).not.toBe(areaBefore);
    expect(box(rowsOf('constructions')[0]!).checked).toBe(true);
    // Type de fenêtre : la largeur typique, elle, se saisit.
    expect(box(rowsOf('windowTypes')[0]!).checked).toBe(false);
    expect(progress()[2]).toBe(`saisies : 1/${last + 1}`);
  });

  it('décoche aussi la ligne dont seule l’orientation change : elle se saisit, même sans nombre modifié', async () => {
    const m = await mount();
    const manual: ManualRow = { id: 'm1', label: 'Mur ajouté', constructionId: null, windowTypeId: null, count: 1, length: 3, width: 2.5, orientation: 'N', boundary: 'outside', deduct: false };
    const setManual = async (patch: Partial<ManualRow>): Promise<void> => {
      await act(async () => {
        m.store.getState().updateProject((p) => ({ ...p, model: { ...p.model, manualRows: [{ ...manual, ...patch }] } }));
      });
    };
    const added = (): HTMLElement => rowsOf('envelope').find((row) => row.getAttribute('data-row') === 'manual:m1')!;
    await setManual({});
    expect(cellsOf(added()).slice(2, 6)).toEqual(['1,00', '3,00', '2,50', 'Nord']);
    await click(box(added()));
    expect(box(added()).checked).toBe(true);

    // Renommer le repère ne touche à rien de ce qui se saisit.
    await setManual({ label: 'Mur du garage' });
    expect(added().querySelector('[data-testid="row-aside"] dd')!.textContent).toBe('Mur du garage');
    expect(box(added()).checked).toBe(true);

    // Même ligne, mêmes nombres, autre orientation : à ressaisir.
    await setManual({ label: 'Mur du garage', orientation: 'S' });
    expect(cellsOf(added()).slice(2, 6)).toEqual(['1,00', '3,00', '2,50', 'Süd']);
    expect(box(added()).checked).toBe(false);
  });
});

describe('résultat — bouton des lignes à marquer', () => {
  const item = (key: string): HTMLElement => all('guide-item').find((i) => i.getAttribute('data-key') === key)!;

  it('dit qu’il copie le « x », pas la liste affichée', async () => {
    const m = await mount();
    const lines = item('envelope.deductLines');
    // La liste affichée : les numéros des lignes à déduire (la fenêtre et la porte).
    const numbers = guideTable(m, 'envelope').rows.flatMap((row, i) => (row.deduct ? [String(i + 1)] : []));
    expect(numbers).toHaveLength(2);
    expect(lines.querySelector('.gitem__text')!.textContent).toBe(numbers.join(', '));
    const button = lines.querySelector<HTMLElement>('[data-testid="copy-item"]')!;
    expect(button.textContent).toBe('Copier « x »');
    expect(button.getAttribute('aria-label')).toBe('Copier « x » (Lignes à marquer « x »)');
    await click(button);
    expect(copied).toEqual(['x']);
    expect(button.textContent).toBe('Copié');
  });

  it('le dit aussi en allemand', async () => {
    const m = await mount();
    await setLang(m, 'de');
    const button = item('envelope.deductLines').querySelector<HTMLElement>('[data-testid="copy-item"]')!;
    expect(button.textContent).toBe('„x“ kopieren');
    expect(button.getAttribute('aria-label')).toBe('„x“ kopieren (Zeilen mit „x“)');
    await click(button);
    expect(copied).toEqual(['x']);
  });

  it('laisse « Copier » aux boutons qui copient la valeur affichée', async () => {
    await mount();
    const year = item('project.yearBuilt').querySelector<HTMLElement>('[data-testid="copy-item"]')!;
    expect(year.textContent).toBe('Copier');
    expect(year.getAttribute('aria-label')).toBe('Copier Baujahr Gebäude');
    // Un seul bouton nomme ce qu'il copie : celui des lignes à marquer.
    expect(all('copy-item').filter((b) => b.textContent !== 'Copier')).toHaveLength(1);
    await click(year);
    expect(copied).toEqual(['1974']);
  });
});
