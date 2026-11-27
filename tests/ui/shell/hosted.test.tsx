// @vitest-environment jsdom
/**
 * Application affichée dans une page hôte (essai publié) : les liens de téléchargement et les nouvelles fenêtres
 * n'y font rien. L'enregistrement passe alors par l'hôte ; s'il n'en propose pas, on ne prétend pas avoir téléchargé.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Storey } from '../../../src/core/types';
import { isHosted, saveText } from '../../../src/ui/shell/browser';
import { AnnounceProvider } from '../../../src/ui/shell/components/common';
import { ResultScreen } from '../../../src/ui/shell/components/ResultScreen';
import '../../../src/ui/shell/messages';
import { currentStorey, ShellStoreContext } from '../../../src/ui/shell/store';
import { rect, testStore } from './helpers';
import type { TestStore } from './helpers';

vi.mock('../../../src/readers', () => ({
  UnsupportedFormatError: class UnsupportedFormatError extends Error {},
  readPlanFile: async () => {
    throw new Error('aucun lecteur dans ce test');
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Host = { claude?: { use: (name: string) => Promise<unknown> } };
const host = globalThis as Host;

const anchorClicks: string[] = [];
const copied: string[] = [];
const opened: string[] = [];
const originalAnchorClick = HTMLAnchorElement.prototype.click;
const originalOpen = window.open;

/** Installe un hôte : `downloads` vaut la fonction d'enregistrement, ou null si l'hôte n'en propose pas. */
function installHost(save: ((request: { filename: string; data: string }) => Promise<unknown>) | null): string[] {
  const asked: string[] = [];
  host.claude = {
    use: async (name: string) => {
      asked.push(name);
      return name === 'downloads' && save ? { save } : null;
    },
  };
  return asked;
}

beforeEach(() => {
  anchorClicks.length = 0;
  copied.length = 0;
  opened.length = 0;
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    anchorClicks.push(this.download);
  };
  window.open = ((url: string) => {
    opened.push(url);
    return null;
  }) as unknown as typeof window.open;
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

afterEach(() => {
  delete host.claude;
  HTMLAnchorElement.prototype.click = originalAnchorClick;
  window.open = originalOpen;
});

describe('enregistrer un fichier, selon l’endroit où la page est affichée', () => {
  it('télécharge directement dans un navigateur ordinaire', async () => {
    expect(isHosted()).toBe(false);
    expect(await saveText('releve.csv', 'text/csv', 'a;b', true)).toBe('saved');
    expect(anchorClicks).toEqual(['releve.csv']);
    expect(copied).toEqual([]);
  });

  it('passe par l’hôte quand il sait enregistrer, sans lien de téléchargement', async () => {
    const saved: { filename: string; data: string }[] = [];
    const asked = installHost(async (request) => {
      saved.push(request);
      return { status: 'saved' };
    });
    expect(isHosted()).toBe(true);
    expect(await saveText('releve.csv', 'text/csv', 'a;b', true)).toBe('saved');
    expect(await saveText('projet.json', 'application/json', '{}', true)).toBe('saved');
    expect(saved).toEqual([
      { filename: 'releve.csv', data: 'a;b' },
      { filename: 'projet.json', data: '{}' },
    ]);
    expect(asked).toEqual(['downloads']); // demandé une seule fois à l'hôte
    expect(anchorClicks).toEqual([]);
    expect(copied).toEqual([]);
  });

  it('ne dit rien de plus quand la personne refuse l’enregistrement proposé par l’hôte', async () => {
    installHost(async () => {
      throw { code: 'declined', message: 'non' };
    });
    expect(await saveText('releve.csv', 'text/csv', 'a;b', true)).toBe('declined');
    expect(anchorClicks).toEqual([]);
    expect(copied).toEqual([]);
  });

  it('copie le texte quand l’hôte ne sait pas enregistrer, au lieu d’un lien sans effet', async () => {
    installHost(null);
    expect(await saveText('releve.csv', 'text/csv', 'a;b', true)).toBe('copied');
    expect(copied).toEqual(['a;b']);
    expect(anchorClicks).toEqual([]);
  });

  it('copie aussi quand l’enregistrement par l’hôte échoue pour une autre raison', async () => {
    installHost(async () => {
      throw { code: 'host_unavailable', message: 'x' };
    });
    expect(await saveText('releve.csv', 'text/csv', 'a;b', true)).toBe('copied');
    expect(copied).toEqual(['a;b']);
  });

  it('avoue l’échec quand rien n’est possible et que copier n’aurait pas de sens (dossier imprimable)', async () => {
    installHost(null);
    expect(await saveText('dossier.html', 'text/html', '<p>x</p>', false)).toBe('failed');
    expect(copied).toEqual([]);
    expect(anchorClicks).toEqual([]);
  });

  it('résiste à un hôte dont la réponse échoue', async () => {
    host.claude = {
      use: async () => {
        throw new Error('hôte muet');
      },
    };
    expect(await saveText('releve.csv', 'text/csv', 'a;b', false)).toBe('failed');
  });
});

// ───────────────────────────── Écran « Résultat » dans une page hôte ─────────────────────────────

interface Mounted extends TestStore {
  container: HTMLElement;
  root: Root;
}
let mounted: Mounted | null = null;

async function mountResult(): Promise<Mounted> {
  const test = testStore();
  test.store.getState().startBlank();
  const storey = currentStorey(test.store.getState())!;
  const outline = rect(10, 8);
  const next: Storey = { ...storey, outline, edges: outline.map(() => ({ boundary: 'outside' as const, constructionId: null })), openings: [] };
  test.store.getState().storeyChanged(next);
  test.store.getState().answer({ occasion: 'existing', buildingType: 'EFH', dwellings: 1, yearBuilt: 1974, projectName: 'Maison test' });
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

async function press(testId: string): Promise<void> {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  // L'enregistrement par l'hôte est asynchrone : on laisse passer ses promesses.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('écran « Résultat » dans une page hôte', () => {
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

  it('enregistre CSV, projet et dossier par l’hôte, sans ouvrir de fenêtre ni cliquer de lien', async () => {
    const saved: string[] = [];
    installHost(async (request) => {
      saved.push(request.filename);
      return { status: 'saved' };
    });
    const m = await mountResult();
    await press('download-csv');
    expect(m.store.getState().toast?.text).toContain('Fichier préparé');
    await press('download-json');
    await press('download-report');
    expect(saved).toEqual(['plan2cpe-maison-test-releve.csv', 'plan2cpe-maison-test.json', 'plan2cpe-maison-test-dossier.html']);
    expect(opened).toEqual([]);
    expect(anchorClicks).toEqual([]);
  });

  it('copie le CSV et le dit quand l’hôte ne sait pas enregistrer ; le dossier, lui, est annoncé comme refusé', async () => {
    installHost(null);
    const m = await mountResult();
    await press('download-csv');
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('LuxEeB');
    expect(m.store.getState().toast?.text).toContain('presse-papiers');
    await press('download-report');
    expect(m.store.getState().toast?.text).toContain('refusé');
    expect(opened).toEqual([]);
    expect(anchorClicks).toEqual([]);
  });

  it('ne montre aucun message quand la personne refuse l’enregistrement', async () => {
    installHost(async () => {
      throw { code: 'declined', message: 'non' };
    });
    const m = await mountResult();
    const before = m.store.getState().toast;
    await press('download-json');
    expect(m.store.getState().toast).toBe(before);
    expect(copied).toEqual([]);
  });
});
