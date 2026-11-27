/**
 * Magasin de l'application : historique, enregistrement automatique, étages, documents, réponses → modèle.
 * Les lecteurs de plans sont simulés (ils sont testés ailleurs) ; le moteur et l'export sont les vrais.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDocument } from '../../../src/core/types';
import { serializeProject } from '../../../src/export';
import { STORAGE_KEYS } from '../../../src/ui/shell/autosave';
import type { StorageLike } from '../../../src/ui/shell/autosave';
import { canGoTo, currentStorey, selectCanRedo, selectCanUndo, selectMarks, selectProject } from '../../../src/ui/shell/store';
import { doc, file, houseDoc, rect, sheet, testStore } from './helpers';

const readers = vi.hoisted(() => {
  class UnsupportedFormatError extends Error {
    constructor(
      public readonly format: string,
      public readonly fileName: string,
    ) {
      super(`Format non lisible : ${fileName}`);
      this.name = 'UnsupportedFormatError';
    }
  }
  return { UnsupportedFormatError, documents: new Map<string, unknown>(), calls: [] as string[] };
});

vi.mock('../../../src/readers', () => ({
  UnsupportedFormatError: readers.UnsupportedFormatError,
  readPlanFile: async (f: { name: string }) => {
    readers.calls.push(f.name);
    if (/\.(pln|rvt)$/i.test(f.name)) throw new readers.UnsupportedFormatError(f.name.endsWith('.rvt') ? 'rvt' : 'pln', f.name);
    const found = readers.documents.get(f.name);
    if (!found) throw new Error('pas encore implémenté');
    return found;
  },
}));

function provide(document: PlanDocument): void {
  readers.documents.set(document.fileName, document);
}

beforeEach(() => {
  readers.documents.clear();
  readers.calls.length = 0;
});

describe('départ sans plan et historique', () => {
  it('crée un étage sur grille vierge et ouvre le plan sur le contour à tracer', () => {
    const { store } = testStore();
    expect(store.getState().step).toBe('home');
    expect(canGoTo(store.getState(), 'plan')).toBe(false);

    store.getState().startBlank();
    const state = store.getState();
    const storey = currentStorey(state);
    expect(state.step).toBe('plan');
    expect(storey?.sheetId).toBeNull();
    expect(storey?.name).toBe('Rez-de-chaussée');
    // Grille en mètres : l'échelle n'est pas à régler, la première étape ouverte est le contour.
    expect(state.planStep).toBe('outline');
    expect(selectCanUndo(state)).toBe(true);
  });

  it('annule et rétablit, avec un message qui nomme l’action', () => {
    const { store } = testStore();
    store.getState().startBlank();
    store.getState().undo();
    expect(selectProject(store.getState()).model.storeys).toHaveLength(0);
    expect(store.getState().toast?.text).toContain('étage ajouté');
    expect(selectCanRedo(store.getState())).toBe(true);
    store.getState().redo();
    expect(selectProject(store.getState()).model.storeys).toHaveLength(1);
    store.getState().redo();
    expect(store.getState().toast?.text).toBe('Rien à rétablir.');
  });

  it('fusionne les versions d’un même glissement dans l’éditeur, pas deux gestes distincts', () => {
    const { store, tick } = testStore();
    store.getState().startBlank();
    const before = store.getState().history.past.length;
    const storey = currentStorey(store.getState())!;

    // Un glissement : 20 versions à 16 ms d'intervalle.
    for (let i = 1; i <= 20; i++) {
      tick(16);
      const outline = rect(4 + i * 0.1, 3);
      store.getState().storeyChanged({ ...currentStorey(store.getState())!, outline, edges: outline.map(() => ({ boundary: 'outside' as const, constructionId: null })) });
    }
    expect(store.getState().history.past.length).toBe(before + 1);

    // Un second geste, une seconde plus tard : nouveau pas.
    tick(1000);
    store.getState().storeyChanged({ ...currentStorey(store.getState())!, outline: rect(10, 8), edges: rect(10, 8).map(() => ({ boundary: 'outside' as const, constructionId: null })) });
    expect(store.getState().history.past.length).toBe(before + 2);

    store.getState().undo();
    expect(currentStorey(store.getState())!.outline[1]!.x).toBeCloseTo(6, 5);
    store.getState().undo();
    expect(currentStorey(store.getState())!.outline).toEqual(storey.outline);
  });

  it('la saisie d’un nom caractère par caractère ne fait qu’un pas', () => {
    const { store, tick } = testStore();
    store.getState().startBlank();
    const id = currentStorey(store.getState())!.id;
    const before = store.getState().history.past.length;
    for (const name of ['R', 'RD', 'RDC']) {
      tick(120);
      store.getState().renameStorey(id, name);
    }
    expect(currentStorey(store.getState())!.name).toBe('RDC');
    expect(store.getState().history.past.length).toBe(before + 1);
  });
});

describe('étages', () => {
  it('ajoute, duplique, réordonne et supprime (avec retour possible)', () => {
    const { store } = testStore();
    store.getState().startBlank();
    const first = currentStorey(store.getState())!;
    const outline = rect(10, 8);
    store.getState().storeyChanged({ ...first, outline, edges: outline.map(() => ({ boundary: 'outside' as const, constructionId: null })) });

    store.getState().duplicateStorey(first.id);
    let storeys = selectProject(store.getState()).model.storeys;
    expect(storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée', '1er étage']);
    expect(storeys[1]!.outline).toEqual(outline);
    expect(storeys[1]!.outline).not.toBe(storeys[0]!.outline);
    expect(store.getState().storeyId).toBe(storeys[1]!.id);

    store.getState().addStorey(null);
    storeys = selectProject(store.getState()).model.storeys;
    expect(storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée', '1er étage', '2e étage']);
    expect(new Set(storeys.map((s) => s.id)).size).toBe(3);

    // Monter le rez-de-chaussée d'un cran.
    store.getState().moveStorey(first.id, 1);
    expect(selectProject(store.getState()).model.storeys.map((s) => s.name)).toEqual(['1er étage', 'Rez-de-chaussée', '2e étage']);
    store.getState().moveStorey(first.id, -1);
    store.getState().moveStorey(first.id, -1); // déjà en bas : sans effet
    expect(selectProject(store.getState()).model.storeys[0]!.id).toBe(first.id);

    // Valider une étape puis supprimer l'étage : ses repères partent avec lui, et reviennent avec « annuler ».
    store.getState().selectStorey(first.id);
    store.getState().confirmPlanStep('outline');
    expect(selectMarks(store.getState()).plan[first.id]?.outline).toBe(true);
    store.getState().removeStorey(first.id);
    expect(selectProject(store.getState()).model.storeys.map((s) => s.name)).toEqual(['1er étage', '2e étage']);
    expect(selectMarks(store.getState()).plan[first.id]).toBeUndefined();
    expect(store.getState().storeyId).not.toBe(first.id);
    store.getState().undo();
    expect(selectProject(store.getState()).model.storeys).toHaveLength(3);
    expect(selectMarks(store.getState()).plan[first.id]?.outline).toBe(true);
  });

  it('supprimer le dernier étage ramène à l’accueil', () => {
    const { store } = testStore();
    store.getState().startBlank();
    store.getState().removeStorey(currentStorey(store.getState())!.id);
    expect(store.getState().step).toBe('home');
    expect(currentStorey(store.getState())).toBeNull();
  });

  it('valider une étape passe à la suivante encore ouverte ; l’éditeur qui termine un outil fait de même', () => {
    const { store } = testStore();
    store.getState().startBlank();
    const storey = currentStorey(store.getState())!;
    const outline = rect(10, 8);
    store.getState().storeyChanged({ ...storey, outline, edges: outline.map(() => ({ boundary: 'outside' as const, constructionId: null })) });

    store.getState().toolDone('outline');
    expect(selectMarks(store.getState()).plan[storey.id]?.outline).toBe(true);
    expect(store.getState().planStep).toBe('boundary');
    expect(store.getState().celebrate?.key).toBe(`${storey.id}:outline`);

    store.getState().confirmPlanStep('boundary');
    expect(store.getState().planStep).toBe('opening');

    // Nord : la validation rend la valeur « confirmée par l'expert » dans le modèle.
    expect(selectProject(store.getState()).model.northAngle.from).toBe('default');
    store.getState().toolDone('north');
    expect(selectProject(store.getState()).model.northAngle.from).toBe('user');

    // L'outil « déplacer » ne correspond à aucune étape.
    const marks = selectMarks(store.getState());
    store.getState().toolDone('pan');
    expect(selectMarks(store.getState())).toBe(marks);
  });

  it('le nord tourné dans l’éditeur est normalisé et marqué « vous »', () => {
    const { store } = testStore();
    store.getState().startBlank();
    store.getState().northChanged(-20);
    expect(selectProject(store.getState()).model.northAngle).toEqual({ value: 340, from: 'user' });
  });
});

describe('documents', () => {
  it('lit les fichiers, propose les étages, et construit le bâtiment à l’acceptation', async () => {
    provide(houseDoc());
    const { store } = testStore();
    await store.getState().ingestFiles([file('maison.dxf')]);

    let state = store.getState();
    expect(state.step).toBe('read');
    expect(state.busy).toBe(false);
    expect(state.documents).toHaveLength(1);
    // Les identifiants de feuilles sont uniques entre fichiers.
    expect(state.documents[0]!.doc.sheets.map((s) => s.id)).toEqual(['maison.dxf#cad-1', 'maison.dxf#cad-2']);
    expect(state.proposal?.mode).toBe('replace');
    expect(state.proposal?.sheets.filter((s) => s.include).map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    // Rien n'est construit tant que l'expert n'a pas accepté.
    expect(selectProject(state).model.storeys).toHaveLength(0);

    state.acceptProposal();
    state = store.getState();
    const project = selectProject(state);
    expect(state.step).toBe('plan');
    expect(project.model.storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    expect(project.model.storeys[0]!.sheetId).toBe('maison.dxf#cad-1');
    expect(project.model.northAngle).toMatchObject({ value: 340, from: 'plan' });
    expect(project.model.storeys[0]!.rooms).toHaveLength(3);
    // Échelle lue sur le plan avec indices concordants : pré-cochée « à confirmer ».
    expect(state.planStep).toBe('scale');

    // Un seul « annuler » défait toute l'acceptation.
    state.undo();
    expect(selectProject(store.getState()).model.storeys).toHaveLength(0);
  });

  it('un format fermé ouvre l’explication sans bloquer les autres fichiers', async () => {
    provide(houseDoc());
    const { store } = testStore();
    await store.getState().ingestFiles([file('projet.pln'), file('maison.dxf')]);
    const state = store.getState();
    expect(state.closedFiles).toEqual([{ format: 'pln', fileName: 'projet.pln' }]);
    expect(state.reading.map((r) => r.status)).toEqual(['unsupported', 'done']);
    expect(state.documents).toHaveLength(1);
    expect(state.step).toBe('read');
    state.dismissClosedFiles();
    expect(store.getState().closedFiles).toHaveLength(0);
  });

  it('un format fermé seul laisse sur l’écran courant', async () => {
    const { store } = testStore();
    await store.getState().ingestFiles([file('maquette.rvt')]);
    expect(store.getState().step).toBe('home');
    expect(store.getState().closedFiles[0]).toEqual({ format: 'rvt', fileName: 'maquette.rvt' });
  });

  it('une erreur de lecture est montrée gentiment et ne casse rien', async () => {
    const { store } = testStore();
    await store.getState().ingestFiles([file('inconnu.dxf')]);
    const state = store.getState();
    expect(state.step).toBe('home');
    expect(state.busy).toBe(false);
    expect(state.reading[0]).toMatchObject({ name: 'inconnu.dxf', status: 'error', message: 'pas encore implémenté' });
  });

  it('libère les adresses d’objets quand un document est retiré, remplacé, ou au nouveau projet', async () => {
    provide(doc('scan.png', [sheet('image', 'Scan', { outline: null, scale: null, imageUrl: 'blob:scan-1' })], { kind: 'image' }));
    provide(doc('rdc.pdf', [sheet('p1', 'RDC', { imageUrl: 'blob:rdc-1' })], { kind: 'pdf' }));
    const { store, revoked } = testStore();
    await store.getState().ingestFiles([file('scan.png'), file('rdc.pdf')]);
    expect(store.getState().documents.map((d) => d.urls)).toEqual([['blob:scan-1'], ['blob:rdc-1']]);
    expect(revoked).toEqual([]);

    // Même fichier redéposé (nouvelle lecture, nouvelle adresse) : l'ancienne est libérée.
    provide(doc('scan.png', [sheet('image', 'Scan', { outline: null, scale: null, imageUrl: 'blob:scan-2' })], { kind: 'image' }));
    await store.getState().ingestFiles([file('scan.png')]);
    expect(revoked).toEqual(['blob:scan-1']);
    expect(store.getState().documents).toHaveLength(2);

    store.getState().removeDocument('rdc.pdf');
    expect(revoked).toEqual(['blob:scan-1', 'blob:rdc-1']);
    expect(store.getState().documents.map((d) => d.id)).toEqual(['scan.png']);

    store.getState().newProject();
    expect(revoked).toEqual(['blob:scan-1', 'blob:rdc-1', 'blob:scan-2']);
    expect(store.getState().documents).toHaveLength(0);
    expect(store.getState().step).toBe('home');
  });

  it('retirer le dernier document depuis la lecture ramène à l’accueil', async () => {
    provide(houseDoc());
    const { store } = testStore();
    await store.getState().ingestFiles([file('maison.dxf')]);
    store.getState().removeDocument('maison.dxf');
    expect(store.getState().step).toBe('home');
    expect(store.getState().proposal).toBeNull();
  });

  it('un scan sans contour propose quand même un étage, à tracer', async () => {
    provide(doc('scan.png', [sheet('image', 'scan', { outline: null, scale: null })], { kind: 'image' }));
    const { store } = testStore();
    await store.getState().ingestFiles([file('scan.png')]);
    expect(store.getState().proposal?.sheets[0]).toMatchObject({ role: 'noOutline', include: true });
    store.getState().acceptProposal();
    const storey = currentStorey(store.getState())!;
    expect(storey.outline).toHaveLength(0);
    expect(storey.sheetId).toBe('scan.png#image');
    // Échelle inconnue : c'est la première chose à faire.
    expect(store.getState().planStep).toBe('scale');
  });

  it('l’exemple absent est signalé sans erreur', async () => {
    const { store } = testStore();
    await store.getState().loadSample();
    expect(store.getState().step).toBe('home');
    expect(store.getState().toast?.tone).toBe('warn');
  });

  it('l’exemple présent suit le même chemin qu’un fichier déposé', async () => {
    provide(houseDoc('maison-exemple.dxf'));
    const { store } = testStore({ fetchSample: async () => file('maison-exemple.dxf') });
    await store.getState().loadSample();
    expect(store.getState().step).toBe('read');
    expect(readers.calls).toEqual(['maison-exemple.dxf']);
  });
});

describe('enregistrement automatique', () => {
  it('écrit le projet (pas les plans) et le propose au démarrage suivant', async () => {
    provide(houseDoc());
    const first = testStore();
    await first.store.getState().ingestFiles([file('maison.dxf')]);
    // Lire un plan ne suffit pas à écrire : le projet est encore vide.
    expect(first.storage.getItem(STORAGE_KEYS.project)).toBeNull();
    first.store.getState().acceptProposal();
    first.store.getState().answer({ projectName: 'Maison Müller' });
    first.store.getState().confirmPlanStep('outline');

    const saved = first.storage.getItem(STORAGE_KEYS.project);
    expect(saved).not.toBeNull();
    expect(first.store.getState().saveState).toBe('saved');
    // Le fichier enregistré est le projet seul : ni traits du plan, ni image.
    expect(saved).not.toContain('segments');
    expect(saved).not.toContain('blob:');
    expect(JSON.parse(first.storage.getItem(STORAGE_KEYS.marks)!).plan).toBeTruthy();

    // Nouveau démarrage sur le même poste.
    const second = testStore({}, first.storage.dump());
    expect(second.store.getState().saved).toEqual({ name: 'Maison Müller', storeys: 2 });
    expect(selectProject(second.store.getState()).model.storeys).toHaveLength(0);
    second.store.getState().resumeSaved();
    const state = second.store.getState();
    expect(state.saved).toBeNull();
    expect(state.step).toBe('plan');
    expect(selectProject(state).answers.projectName).toBe('Maison Müller');
    expect(selectProject(state).model.storeys).toHaveLength(2);
    const id = selectProject(state).model.storeys[0]!.id;
    expect(selectMarks(state).plan[id]?.outline).toBe(true);
    // Les plans, eux, ne sont pas revenus : le fond est à redéposer.
    expect(state.documents).toHaveLength(0);
  });

  it('un projet vide n’écrase pas le projet retrouvé ; commencer autre chose le remplace', () => {
    const first = testStore();
    first.store.getState().startBlank();
    const before = first.storage.getItem(STORAGE_KEYS.project);
    expect(before).not.toBeNull();

    const second = testStore({}, first.storage.dump());
    expect(second.store.getState().saved?.storeys).toBe(1);
    second.store.getState().setLang('de');
    second.store.getState().goTo('questions');
    expect(second.storage.getItem(STORAGE_KEYS.project)).toBe(before);

    second.store.getState().answer({ occasion: 'new' });
    expect(second.store.getState().saved).toBeNull();
    expect(second.storage.getItem(STORAGE_KEYS.project)).not.toBe(before);
  });

  it('effacer le projet retrouvé vide le stockage', () => {
    const first = testStore();
    first.store.getState().startBlank();
    const second = testStore({}, first.storage.dump());
    second.store.getState().discardSaved();
    expect(second.store.getState().saved).toBeNull();
    expect(second.storage.getItem(STORAGE_KEYS.project)).toBeNull();
  });

  it('continue sans enregistrement quand le stockage refuse d’écrire', () => {
    const broken: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    const { store } = testStore({ storage: broken });
    store.getState().startBlank();
    expect(store.getState().saveState).toBe('failed');
    expect(store.getState().toast?.tone).toBe('warn');
    // L'application reste utilisable.
    store.getState().answer({ occasion: 'existing' });
    expect(selectProject(store.getState()).answers.occasion).toBe('existing');
  });

  it('fonctionne sans stockage du tout', () => {
    const { store } = testStore({ storage: null });
    expect(store.getState().saveState).toBe('off');
    store.getState().startBlank();
    expect(store.getState().saveState).toBe('off');
    expect(selectProject(store.getState()).model.storeys).toHaveLength(1);
  });

  it('ignore un enregistrement illisible', () => {
    const { store } = testStore({}, { [STORAGE_KEYS.project]: '{"pas":"un projet"', [STORAGE_KEYS.marks]: 'oups' });
    expect(store.getState().saved).toBeNull();
    expect(store.getState().step).toBe('home');
  });

  it('diffère l’écriture et la regroupe quand un délai est réglé', () => {
    vi.useFakeTimers();
    try {
      const { store, storage } = testStore({ autosaveDelay: 400 });
      store.getState().startBlank();
      store.getState().answer({ occasion: 'existing' });
      expect(storage.getItem(STORAGE_KEYS.project)).toBeNull();
      vi.advanceTimersByTime(399);
      expect(storage.getItem(STORAGE_KEYS.project)).toBeNull();
      vi.advanceTimersByTime(2);
      expect(storage.getItem(STORAGE_KEYS.project)).toContain('"existing"');

      // Fermeture de la page : l'écriture en attente part tout de suite.
      store.getState().answer({ occasion: 'new' });
      store.getState().flushAutosave();
      expect(storage.getItem(STORAGE_KEYS.project)).toContain('"new"');
      store.getState().dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retient la langue choisie', () => {
    const first = testStore({ languages: ['de-LU'] });
    expect(first.store.getState().lang).toBe('de');
    first.store.getState().setLang('fr');
    expect(first.storage.getItem(STORAGE_KEYS.lang)).toBe('fr');
    const second = testStore({ languages: ['de-LU'] }, first.storage.dump());
    expect(second.store.getState().lang).toBe('fr');
  });
});

describe('ouverture d’un projet enregistré en fichier', () => {
  it('ouvre un fichier valide et signale que les plans sont à redéposer', async () => {
    provide(houseDoc());
    const source = testStore();
    await source.store.getState().ingestFiles([file('maison.dxf')]);
    source.store.getState().acceptProposal();
    const json = serializeProject(selectProject(source.store.getState()));

    const { store, storage } = testStore();
    // Des lignes cochées « saisies » dans un projet précédent ne doivent pas apparaître cochées dans celui-ci.
    store.getState().toggleEntered('envelope/rows/0/abc');
    expect(Object.keys(store.getState().entered)).toHaveLength(1);
    expect(store.getState().openProjectText(json)).toBe(true);
    expect(store.getState().entered).toEqual({});
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.entered) ?? '[]')).toEqual([]);
    expect(store.getState().step).toBe('plan');
    expect(selectProject(store.getState()).model.storeys).toHaveLength(2);
    expect(store.getState().toast?.text).toContain('redéposez');

    // Les plans redéposés retrouvent leurs étages sans repasser par la confirmation.
    await store.getState().ingestFiles([file('maison.dxf')]);
    expect(store.getState().step).toBe('plan');
    expect(selectProject(store.getState()).model.storeys).toHaveLength(2);
    expect(store.getState().toast?.tone).toBe('ok');
  });

  it('un fichier réellement nouveau passe par la lecture, même si les autres plans sont déjà chargés', async () => {
    provide(houseDoc());
    provide(doc('combles.dxf', [sheet('cad-1', 'Combles', { outline: rect(900, 700) })]));
    const { store } = testStore();
    await store.getState().ingestFiles([file('maison.dxf')]);
    store.getState().acceptProposal();
    expect(store.getState().step).toBe('plan');

    await store.getState().ingestFiles([file('combles.dxf')]);
    let state = store.getState();
    expect(state.step).toBe('read');
    expect(state.proposal?.mode).toBe('append');
    expect(state.proposal?.sheets.filter((s) => s.role === 'used')).toHaveLength(2);
    // Rien n'est ajouté sans que l'expert le coche.
    expect(state.proposal?.sheets.some((s) => s.include)).toBe(false);
    const attic = state.proposal!.sheets.find((s) => s.fileName === 'combles.dxf')!;
    state.setProposal({ ...state.proposal!, sheets: state.proposal!.sheets.map((s) => (s.sheetId === attic.sheetId ? { ...s, include: true } : s)) });
    store.getState().acceptProposal();
    state = store.getState();
    expect(selectProject(state).model.storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage', 'Combles']);
    // On arrive sur le nouvel étage.
    expect(currentStorey(state)?.name).toBe('Combles');

    // « Repartir de ces plans » reconstruit tout ; les repères du plan repartent de zéro.
    state.confirmPlanStep('outline');
    state.goTo('read');
    store.getState().setProposalMode('replace');
    expect(store.getState().proposal?.sheets.filter((s) => s.include)).toHaveLength(3);
    store.getState().acceptProposal();
    expect(selectProject(store.getState()).model.storeys).toHaveLength(3);
    expect(selectMarks(store.getState()).plan).toEqual({});
  });

  it('refuse un fichier qui n’est pas un projet, avec un message', () => {
    const { store } = testStore();
    expect(store.getState().openProjectText('{"bonjour":1}')).toBe(false);
    expect(store.getState().step).toBe('home');
    expect(store.getState().toast?.tone).toBe('warn');
    expect(store.getState().toast?.text.length).toBeGreaterThan(10);
  });
});

describe('réponses et modèle', () => {
  it('la toiture et le plancher bas choisis modifient le bâtiment, provenance « vous »', () => {
    const { store } = testStore();
    store.getState().startBlank();
    let model = selectProject(store.getState()).model;
    expect(model.top.from).toBe('default');
    expect(model.bottom.from).toBe('default');

    store.getState().setTop({ kind: 'pitched-roof' });
    store.getState().setTop({ pitchDeg: 40 });
    store.getState().setTop({ shape: 'hip', kneeWallHeight: 0.5 });
    store.getState().setBottom('above-unheated');
    model = selectProject(store.getState()).model;
    expect(model.top).toMatchObject({ kind: 'pitched-roof', pitchDeg: 40, shape: 'hip', kneeWallHeight: 0.5, from: 'user' });
    expect(model.bottom).toMatchObject({ kind: 'above-unheated', from: 'user' });

    // Valeurs absurdes ignorées, le reste gardé.
    store.getState().setTop({ pitchDeg: Number.NaN, kneeWallHeight: -1 });
    expect(selectProject(store.getState()).model.top).toMatchObject({ pitchDeg: 40, kneeWallHeight: 0.5 });

    store.getState().undo();
    store.getState().undo();
    expect(selectProject(store.getState()).model.bottom.from).toBe('default');
  });

  it('une année issue d’une période est marquée approximative jusqu’à sa saisie exacte', () => {
    const { store } = testStore();
    store.getState().answerYear(1975, true);
    expect(selectProject(store.getState()).answers.yearBuilt).toBe(1975);
    expect(selectMarks(store.getState()).yearFromPeriod).toBe(true);
    store.getState().answerYear(1974, false);
    expect(selectProject(store.getState()).answers.yearBuilt).toBe(1974);
    expect(selectMarks(store.getState()).yearFromPeriod).toBe(false);
  });

  it('« je ne sais pas » vide la réponse, marque la question et avance', () => {
    const { store } = testStore();
    store.getState().openQuestion('windows');
    store.getState().answer({ windowGeneration: 'triple' });
    store.getState().skipQuestion();
    const state = store.getState();
    expect(selectProject(state).answers.windowGeneration).toBeNull();
    expect(selectMarks(state).questions.windows).toBe('skipped');
    expect(state.question).toBe('heating');
    // Annuler rend la réponse.
    state.undo();
    expect(selectProject(store.getState()).answers.windowGeneration).toBe('triple');
  });

  it('marquer une question « vue » n’ouvre pas de pas d’historique', () => {
    const { store } = testStore();
    store.getState().openQuestion('hotWater');
    const before = store.getState().history.past.length;
    store.getState().skipQuestion(); // rien n'était renseigné
    expect(store.getState().history.past.length).toBe(before);
    expect(selectMarks(store.getState()).questions.hotWater).toBe('skipped');
    store.getState().answer({ ventilation: 'windows' });
    store.getState().continueQuestion();
    expect(store.getState().history.past.length).toBe(before + 1);
    expect(selectMarks(store.getState()).questions.ventilation).toBe('answered');
  });
});

describe('navigation', () => {
  it('saute d’un constat au bon étage et au bon outil', async () => {
    provide(houseDoc());
    const { store } = testStore();
    await store.getState().ingestFiles([file('maison.dxf')]);
    store.getState().acceptProposal();
    const upper = selectProject(store.getState()).model.storeys[1]!;
    store.getState().goTo('result');

    store.getState().jumpTo({ step: 'plan', storeyId: upper.id, planStep: 'opening', focus: null });
    expect(store.getState()).toMatchObject({ step: 'plan', storeyId: upper.id, planStep: 'opening', planFocus: null });

    store.getState().jumpTo({ step: 'plan', storeyId: upper.id, planStep: 'outline', focus: 'heights' });
    expect(store.getState().planFocus).toBe('heights');
    store.getState().clearPlanFocus();
    expect(store.getState().planFocus).toBeNull();

    store.getState().jumpTo({ step: 'questions', question: 'closure', part: 'bottom' });
    expect(store.getState()).toMatchObject({ step: 'questions', question: 'closure', questionPart: 'bottom' });

    store.getState().jumpTo({ step: 'expert', tab: 'manual' });
    expect(store.getState()).toMatchObject({ expertOpen: true, expertTab: 'manual', step: 'questions' });
  });

  it('sans étage, « corriger sur le plan » ouvre une grille vierge', () => {
    const { store } = testStore();
    store.getState().jumpTo({ step: 'plan', storeyId: null, planStep: 'outline', focus: null });
    expect(store.getState().step).toBe('plan');
    expect(selectProject(store.getState()).model.storeys).toHaveLength(1);
  });

  it('coche et décoche les lignes saisies, et s’en souvient', () => {
    const first = testStore();
    first.store.getState().toggleEntered('envelope/envelope/0/abc');
    first.store.getState().toggleEntered('areas/zones/1/def');
    first.store.getState().toggleEntered('areas/zones/1/def');
    expect(first.store.getState().entered).toEqual({ 'envelope/envelope/0/abc': true });
    const second = testStore({}, first.storage.dump());
    expect(second.store.getState().entered).toEqual({ 'envelope/envelope/0/abc': true });
  });

  it('les étapes verrouillées ne s’ouvrent pas', () => {
    const { store } = testStore();
    store.getState().goTo('read');
    expect(store.getState().step).toBe('home');
    store.getState().goTo('plan');
    expect(store.getState().step).toBe('home');
    store.getState().goTo('result');
    expect(store.getState().step).toBe('result');
  });
});
