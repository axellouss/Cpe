// @vitest-environment jsdom
/**
 * Coutures entre lecteurs, moteur et magasin : ce qu'une relecture indépendante a trouvé cassé à la jonction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDocument } from '../../../src/core/types';
import { createEmptyProject, deriveSheets } from '../../../src/engine';
import { applyProposal, documentSignature, proposeStoreys, toggleProposalSheet, toLoadedDocument } from '../../../src/ui/shell/documents';
import { addConstruction, addStorey, assignSheet, updateConstruction } from '../../../src/ui/shell/modelOps';
import { selectProject } from '../../../src/ui/shell/store';
import { doc, file, rect, sheet, testStore } from './helpers';

const readers = vi.hoisted(() => {
  class UnsupportedFormatError extends Error {
    constructor(
      public readonly format: string,
      public readonly fileName: string,
    ) {
      super(fileName);
      this.name = 'UnsupportedFormatError';
    }
  }
  return { UnsupportedFormatError, queue: [] as unknown[] };
});

vi.mock('../../../src/readers', () => ({
  UnsupportedFormatError: readers.UnsupportedFormatError,
  // Chaque lecture rend le document suivant de la file : deux fichiers différents peuvent porter le même nom.
  readPlanFile: async () => {
    const next = readers.queue.shift();
    if (!next) throw new Error('rien à lire');
    return next;
  },
}));

beforeEach(() => {
  readers.queue.length = 0;
});

/** Maquette façon FZK-Haus : rez-de-chaussée 12 × 10 m, combles aux murs de 0,67 à 3,39 m, sous-sol. */
function ifcDoc(): PlanDocument {
  const level = (id: string, name: string, elevation: number, patch: Record<string, unknown> = {}) => {
    const s = sheet(id, name, { outline: rect(12, 10) });
    s.metresPerUnit = { value: 1, from: 'plan' };
    s.detected = { ...s.detected, elevation, ...patch };
    return s;
  };
  return doc(
    'maison.ifc',
    [
      level('k', 'Keller', -2.8, { storeyHeight: 2.8 }),
      level('e', 'Erdgeschoss', 0, { storeyHeight: 2.7 }),
      level('d', 'Dachgeschoss', 2.7, { storeyHeight: 3.39, eavesHeight: 0.67, storeyHeightToWallTop: true }),
    ],
    { kind: 'ifc', storeysAligned: true },
  );
}

describe('proposition d’étages', () => {
  it('la toiture inclinée proposée par le moteur arrive dans le projet, à confirmer', () => {
    const documents = [toLoadedDocument(ifcDoc())];
    const proposal = proposeStoreys(documents, createEmptyProject('fr'), 'fr');
    const project = applyProposal(proposal, documents, createEmptyProject('fr'), 'fr');
    expect(project.model.storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Combles']);
    expect(project.model.top).toMatchObject({ kind: 'pitched-roof', pitchDeg: 29, kneeWallHeight: 0.67, from: 'estimate' });
    // Volume : 120 × 2,70 + combles sous toiture (et non 120 × 3,39 jusqu'au faîtage).
    const ve = deriveSheets(project, 'fr').totals.ve;
    expect(ve).toBeGreaterThan(540);
    expect(ve).toBeLessThan(600);
    // Une toiture déjà confirmée par l'expert n'est jamais écrasée.
    const base = createEmptyProject('fr');
    base.model.top = { ...base.model.top, kind: 'flat-roof', from: 'user' };
    expect(applyProposal(proposal, documents, base, 'fr').model.top).toMatchObject({ kind: 'flat-roof', from: 'user' });
  });

  it('un sous-sol coché après coup se range sous le rez-de-chaussée, pas au-dessus de la toiture', () => {
    const documents = [toLoadedDocument(ifcDoc())];
    const proposal = proposeStoreys(documents, createEmptyProject('fr'), 'fr');
    const cellar = proposal.sheets.find((s) => s.sheetName === 'Keller')!;
    expect(cellar).toMatchObject({ role: 'basement', include: false });
    const ticked = toggleProposalSheet(proposal, cellar.sheetId, true);
    expect(ticked.sheets.filter((s) => s.include).map((s) => s.sheetName)).toEqual(['Keller', 'Erdgeschoss', 'Dachgeschoss']);
    const project = applyProposal(ticked, documents, createEmptyProject('fr'), 'fr');
    expect(project.model.storeys.map((s) => s.name)).toEqual(['Sous-sol', 'Rez-de-chaussée', 'Combles']);
    // La dalle sur terre-plein est bien celle du sous-sol.
    const floors = deriveSheets(project, 'fr').envelope.filter((r) => r.kind === 'floor').map((r) => r.label);
    expect(floors.some((l) => l.includes('Sous-sol'))).toBe(true);
    // Sans altitude : le rang du nom suffit.
    const named = [toLoadedDocument(doc('plans.pdf', [sheet('1', 'Rez-de-chaussée', { outline: rect(10, 8) }), sheet('2', 'Sous-sol', { outline: rect(10, 8) })]))];
    const p2 = proposeStoreys(named, createEmptyProject('fr'), 'fr');
    const again = toggleProposalSheet(p2, p2.sheets.find((s) => s.sheetName === 'Sous-sol')!.sheetId, true);
    expect(again.sheets.filter((s) => s.include).map((s) => s.sheetName)).toEqual(['Sous-sol', 'Rez-de-chaussée']);
  });

  it('un rez-de-jardin n’est pas un sous-sol, pour l’application comme pour le moteur', () => {
    const documents = [toLoadedDocument(doc('plans.pdf', [sheet('1', 'Rez-de-jardin', { outline: rect(10, 8) }), sheet('2', 'Rez-de-chaussée', { outline: rect(10, 8) })]))];
    const proposal = proposeStoreys(documents, createEmptyProject('fr'), 'fr');
    expect(proposal.sheets.map((s) => [s.sheetName, s.role, s.include])).toEqual([
      ['Rez-de-jardin', 'storey', true],
      ['Rez-de-chaussée', 'storey', true],
    ]);
    expect(applyProposal(proposal, documents, createEmptyProject('fr'), 'fr').model.bottom.kind).toBe('slab-on-ground');
  });
});

describe('deux fichiers différents du même nom', () => {
  it('le second est gardé à côté sous un nom distinct ; le même fichier redéposé remplace le premier', async () => {
    const a = doc('plan.pdf', [sheet('p1', 'Rez-de-chaussée', { outline: rect(1000, 800) }), sheet('p2', 'Étage', { outline: rect(1000, 800) })]);
    const b = doc('plan.pdf', [sheet('p1', 'Page 1', { outline: rect(600, 400) })]);
    expect(documentSignature(a)).not.toBe(documentSignature(b));
    expect(documentSignature(a)).toBe(documentSignature(structuredClone(a)));

    const { store } = testStore();
    readers.queue.push(a);
    await store.getState().ingestFiles([file('plan.pdf')]);
    store.getState().acceptProposal();
    const before = selectProject(store.getState()).model.storeys.map((s) => s.sheetId);
    expect(before).toEqual(['plan.pdf#p1', 'plan.pdf#p2']);

    readers.queue.push(b);
    await store.getState().ingestFiles([file('plan.pdf')]);
    const ids = store.getState().documents.map((d) => d.id);
    expect(ids).toEqual(['plan.pdf', 'plan.pdf (2)']);
    // Le premier document est intact : le fond des étages tracés n'a pas été échangé.
    expect(store.getState().documents[0]!.doc.sheets).toHaveLength(2);
    expect(store.getState().documents[1]!.doc.sheets[0]!.id).toBe('plan.pdf (2)#p1');
    expect(store.getState().toast?.text).toContain('plan.pdf (2)');
    expect(selectProject(store.getState()).model.storeys.map((s) => s.sheetId)).toEqual(before);

    // Le même fichier redéposé : toujours deux documents, pas trois.
    readers.queue.push(structuredClone(a));
    await store.getState().ingestFiles([file('plan.pdf')]);
    expect(store.getState().documents.map((d) => d.id).sort()).toEqual(['plan.pdf', 'plan.pdf (2)']);
  });
});

describe('opérations sur le modèle', () => {
  it('un étage venu d’un autre fichier : les étages ne sont plus tenus pour superposables', () => {
    let project = createEmptyProject('fr');
    project.model.storeysAligned = true;
    const first = sheet('maison.ifc#a', 'RDC', { outline: rect(10, 8) });
    const second = sheet('maison.ifc#b', 'Étage', { outline: rect(10, 8) });
    project = addStorey(project, first, 'RDC').project;
    project = addStorey(project, second, 'Étage').project;
    expect(project.model.storeysAligned).toBe(true);
    const foreign = sheet('autre.pdf#p1', 'Plan', { outline: rect(900, 700) });
    expect(addStorey(project, foreign, '2e étage').project.model.storeysAligned).toBe(false);
    expect(addStorey(project, null, 'Tracé à la main').project.model.storeysAligned).toBe(false);
    expect(assignSheet(project, project.model.storeys[1]!.id, foreign).model.storeysAligned).toBe(false);
  });

  it('un type de mur qui change de catégorie quitte les façades qui l’utilisaient', () => {
    let project = createEmptyProject('fr');
    project = addStorey(project, sheet('s', 'RDC', { outline: rect(10, 8) }), 'RDC').project;
    project = addConstruction(project, 'wall', 'Mur ancien');
    const custom = project.model.constructions.find((c) => c.name === 'Mur ancien')!;
    project = {
      ...project,
      model: {
        ...project.model,
        storeys: project.model.storeys.map((s) => ({ ...s, edges: s.edges.map((e, i) => (i === 0 ? { ...e, constructionId: custom.id } : e)) })),
      },
    };
    expect(deriveSheets(project, 'fr').envelope.some((r) => r.elementName === 'Mur ancien')).toBe(true);
    const changed = updateConstruction(project, custom.id, { category: 'roof' });
    expect(changed.model.storeys[0]!.edges[0]!.constructionId).toBeNull();
    expect(deriveSheets(changed, 'fr').envelope.some((r) => r.elementName === 'Mur ancien')).toBe(false);
    // Défense en profondeur : même si la référence subsistait, le moteur n'habille pas une façade avec une toiture.
    const stale = { ...changed, model: { ...changed.model, storeys: project.model.storeys } };
    expect(deriveSheets(stale, 'fr').envelope.filter((r) => r.kind === 'wall').some((r) => r.elementName === 'Mur ancien')).toBe(false);
  });
});

describe('contour retracé dans l’éditeur', () => {
  it('les étapes « façades » et « ouvertures » ne restent pas cochées quand des murs ont disparu', async () => {
    const d = doc('maison.dxf', [sheet('s', 'Rez-de-chaussée', { outline: rect(1000, 800), detected: { openings: [{ kind: 'window', a: { x: 300, y: 0 }, b: { x: 420, y: 0 }, width: 1.2, exterior: true }] } })]);
    const { store } = testStore();
    readers.queue.push(d);
    await store.getState().ingestFiles([file('maison.dxf')]);
    store.getState().acceptProposal();
    const s = () => store.getState();
    const storey = () => selectProject(s()).model.storeys[0]!;
    for (const step of ['scale', 'outline', 'boundary', 'opening'] as const) {
      s().selectPlanStep(step);
      s().confirmPlanStep(step);
    }
    expect(s().history.present.marks.plan[storey().id]).toMatchObject({ boundary: true, opening: true });
    expect(storey().openings).toHaveLength(1);

    // L'éditeur rend un contour retracé 3 cm à côté, façades et ouvertures remises à zéro : tout est reporté.
    const moved = rect(1000, 800).map((p) => ({ x: p.x + 3, y: p.y + 2 }));
    s().storeyChanged({ ...storey(), outline: moved, edges: moved.map(() => ({ boundary: 'outside' as const, constructionId: null })), openings: [] });
    expect(storey().openings).toHaveLength(1);
    expect(s().history.present.marks.plan[storey().id]).toMatchObject({ boundary: true, opening: true });

    // Contour réellement différent (façade du haut reculée de 3 m) : la fenêtre n'a plus de mur, on le dit.
    const smaller = [{ x: 0, y: 300 }, { x: 1000, y: 300 }, { x: 1000, y: 800 }, { x: 0, y: 800 }];
    s().storeyChanged({ ...storey(), outline: smaller, edges: smaller.map(() => ({ boundary: 'outside' as const, constructionId: null })), openings: [] });
    expect(storey().openings).toHaveLength(0);
    const marks = s().history.present.marks.plan[storey().id] ?? {};
    expect(marks.boundary).toBeUndefined();
    expect(marks.opening).toBeUndefined();
    expect(marks.outline).toBe(true);
    expect(s().toast?.text).toContain('1 ouverture');
  });
});
