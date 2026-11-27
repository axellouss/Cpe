/**
 * Opérations pures sur le projet (mode expert, hauteurs, feuilles) et enregistrement dans le navigateur.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '../../../src/core/types';
import { createEmptyProject, createStorey, DEFAULT_CONSTRUCTION_IDS, DEFAULT_WINDOW_TYPE_ID, deriveSheets } from '../../../src/engine';
import { parseProject, serializeProject } from '../../../src/export';
import {
  browserStorage,
  clearWorkspace,
  dropLegacyEntered,
  initialLang,
  LEGACY_ENTERED_KEY,
  loadWorkspace,
  memoryStorage,
  parseWorkspace,
  sanitizeMarks,
  saveWorkspace,
  serializeWorkspace,
  STORAGE_KEYS,
} from '../../../src/ui/shell/autosave';
import {
  relocalizeDefaults,
  addConstruction,
  addManualRow,
  addRoom,
  addWindowType,
  assignSheet,
  confirmScale,
  duplicateStorey,
  isDefaultConstruction,
  mapStorey,
  removeConstruction,
  removeManualRow,
  removeRoom,
  removeWindowType,
  setEdge,
  setNetArea,
  setStoreyHeight,
  uniqueId,
  updateConstruction,
  updateManualRow,
  updateOpening,
  updateRoom,
  updateWindowType,
} from '../../../src/ui/shell/modelOps';
import { inputNumber, parseNumber, unitLength } from '../../../src/ui/shell/numbers';
import { emptyMarks } from '../../../src/ui/shell/types';
import { houseDoc, rect, sheet } from './helpers';

function house(): Project {
  const project = createEmptyProject('fr');
  const source = houseDoc().sheets[0]!;
  project.model.storeys.push(createStorey(source, 'Rez-de-chaussée', project.model));
  return project;
}

describe('étages et hauteurs', () => {
  it('une hauteur saisie devient « vous » ; une valeur absurde est ignorée', () => {
    const project = house();
    const id = project.model.storeys[0]!.id;
    const next = setStoreyHeight(project, id, 'gross', 2.95);
    expect(next.model.storeys[0]!.grossHeight).toEqual({ value: 2.95, from: 'user' });
    expect(next.model.storeys[0]!.clearHeight.from).toBe('default');
    expect(setStoreyHeight(next, id, 'gross', 0)).toBe(next);
    expect(setStoreyHeight(next, id, 'gross', Number.NaN)).toBe(next);
    expect(setStoreyHeight(next, id, 'gross', 2.95)).toBe(next);
    // Le projet reçu n'est jamais modifié.
    expect(project.model.storeys[0]!.grossHeight.from).toBe('default');
    expect(mapStorey(project, 'inconnu', (s) => ({ ...s, name: 'x' }))).toBe(project);
  });

  it('valider l’échelle la rend « confirmée » sans changer sa valeur', () => {
    const project = house();
    const id = project.model.storeys[0]!.id;
    const next = confirmScale(project, id);
    expect(next.model.storeys[0]!.metresPerUnit).toMatchObject({ value: 0.01, from: 'user' });
    expect(confirmScale(next, id)).toBe(next);
  });

  it('la surface nette saisie se retire en vidant le champ', () => {
    const project = house();
    const id = project.model.storeys[0]!.id;
    const withArea = setNetArea(project, id, 48);
    expect(withArea.model.storeys[0]!.netAreaOverride).toEqual({ value: 48, from: 'user' });
    expect(setNetArea(withArea, id, -3)).toBe(withArea);
    expect(setNetArea(withArea, id, null).model.storeys[0]!.netAreaOverride).toBeNull();
  });

  it('donner une feuille à un étage vide reprend ce que le lecteur y propose ; un étage tracé garde sa géométrie', () => {
    const project = createEmptyProject('fr');
    const blank = createStorey(null, 'Mon étage', project.model);
    project.model.storeys.push(blank);
    const source = houseDoc().sheets[0]!;

    const adopted = assignSheet(setStoreyHeight(project, blank.id, 'gross', 3.1), blank.id, source).model.storeys[0]!;
    expect(adopted).toMatchObject({ id: blank.id, name: 'Mon étage', sheetId: source.id });
    expect(adopted.outline).toHaveLength(4);
    expect(adopted.metresPerUnit.value).toBe(0.01);
    expect(adopted.rooms).toHaveLength(3);
    expect(adopted.rooms.every((r) => r.id.startsWith(blank.id))).toBe(true);
    expect(adopted.grossHeight).toEqual({ value: 3.1, from: 'user' }); // hauteur confirmée gardée

    const other = sheet('autre', 'Autre plan', { outline: rect(500, 500) });
    const moved = assignSheet({ ...project, model: { ...project.model, storeys: [adopted] } }, blank.id, other).model.storeys[0]!;
    expect(moved.sheetId).toBe('autre');
    expect(moved.outline).toEqual(adopted.outline);
    const detached = assignSheet({ ...project, model: { ...project.model, storeys: [moved] } }, blank.id, null).model.storeys[0]!;
    expect(detached.sheetId).toBeNull();
  });

  it('duplique un étage avec des identifiants neufs', () => {
    const project = house();
    const source = project.model.storeys[0]!;
    const { project: next, storey } = duplicateStorey(project, source.id, 'Étage');
    expect(next.model.storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    expect(storey?.id).not.toBe(source.id);
    expect(storey?.rooms.map((r) => r.name)).toEqual(source.rooms.map((r) => r.name));
    const ids = [...source.rooms, ...source.openings, ...(storey?.rooms ?? []), ...(storey?.openings ?? [])].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(duplicateStorey(project, 'inconnu', 'x').storey).toBeNull();
    // Le moteur accepte le résultat.
    expect(() => deriveSheets(next, 'fr')).not.toThrow();
  });

  it('façades et ouvertures se corrigent en mode expert', () => {
    const project = house();
    const storey = project.model.storeys[0]!;
    const edged = setEdge(project, storey.id, 1, { boundary: 'heated' });
    expect(edged.model.storeys[0]!.edges.map((e) => e.boundary)).toEqual(['outside', 'heated', 'outside', 'outside']);
    expect(setEdge(project, storey.id, 99, { boundary: 'ground' })).toBe(project);

    const opening = storey.openings[0]!;
    const resized = updateOpening(project, storey.id, opening.id, { height: 1.5 });
    expect(resized.model.storeys[0]!.openings[0]).toMatchObject({ height: 1.5, from: 'user' });
  });
});

describe('pièces', () => {
  it('trancher une pièce lève « à revoir » ; corriger sa surface la marque « vous »', () => {
    const project = house();
    const storey = project.model.storeys[0]!;
    const laundry = storey.rooms.find((r) => r.needsReview)!;
    const decided = updateRoom(project, storey.id, laundry.id, { heated: true });
    expect(decided.model.storeys[0]!.rooms.find((r) => r.id === laundry.id)).toMatchObject({ heated: true, needsReview: false });
    const resized = updateRoom(decided, storey.id, laundry.id, { area: 5.2, name: 'Buanderie chauffée' });
    expect(resized.model.storeys[0]!.rooms.find((r) => r.id === laundry.id)).toMatchObject({ name: 'Buanderie chauffée', area: { value: 5.2, from: 'user' } });
  });

  it('une pièce ajoutée attend sa surface', () => {
    const project = house();
    const id = project.model.storeys[0]!.id;
    const added = addRoom(project, id, 'Bureau');
    const room = added.model.storeys[0]!.rooms.at(-1)!;
    expect(room).toMatchObject({ name: 'Bureau', heated: true, needsReview: true, area: { value: 0 } });
    const filled = updateRoom(added, id, room.id, { area: 9 });
    expect(filled.model.storeys[0]!.rooms.at(-1)).toMatchObject({ needsReview: false, area: { value: 9, from: 'user' } });
    expect(removeRoom(filled, id, room.id).model.storeys[0]!.rooms).toHaveLength(3);
  });
});

describe('types d’éléments, fenêtres, lignes manuelles', () => {
  it('ajoute un type avec une valeur U facultative, et le retire en remettant les parois au type par défaut', () => {
    let project = house();
    const storeyId = project.model.storeys[0]!.id;
    project = addConstruction(project, 'wall', 'Mur isolé 12 cm');
    const custom = project.model.constructions.at(-1)!;
    expect(custom).toMatchObject({ name: 'Mur isolé 12 cm', category: 'wall', u: null });
    expect(isDefaultConstruction(custom.id)).toBe(false);

    project = updateConstruction(project, custom.id, { u: 0.24 });
    expect(project.model.constructions.at(-1)!.u).toEqual({ value: 0.24, from: 'user' });
    project = updateConstruction(project, custom.id, { u: null });
    expect(project.model.constructions.at(-1)!.u).toBeNull();
    project = updateConstruction(project, custom.id, { u: -1 });
    expect(project.model.constructions.at(-1)!.u).toBeNull();

    project = setEdge(project, storeyId, 0, { constructionId: custom.id });
    project = addManualRow(project, 'Lucarne');
    const row = project.model.manualRows[0]!;
    project = updateManualRow(project, row.id, { constructionId: custom.id, length: 2.4, width: -5 });
    expect(project.model.manualRows[0]).toMatchObject({ length: 2.4, width: 1, constructionId: custom.id });

    project = removeConstruction(project, custom.id);
    expect(project.model.constructions.some((c) => c.id === custom.id)).toBe(false);
    expect(project.model.storeys[0]!.edges[0]!.constructionId).toBeNull();
    expect(project.model.manualRows[0]!.constructionId).toBeNull();
    expect(removeManualRow(project, row.id).model.manualRows).toHaveLength(0);
  });

  it('les types par défaut ne se suppriment pas et gardent leur catégorie', () => {
    const project = house();
    const wall = DEFAULT_CONSTRUCTION_IDS.wallOutside;
    expect(isDefaultConstruction(wall)).toBe(true);
    expect(removeConstruction(project, wall)).toBe(project);
    expect(updateConstruction(project, wall, { category: 'roof' }).model.constructions.find((c) => c.id === wall)?.category).toBe('wall');
    expect(removeWindowType(project, DEFAULT_WINDOW_TYPE_ID)).toBe(project);
  });

  it('types de fenêtres : Uw et g facultatifs, g borné à 1', () => {
    let project = addWindowType(house(), 'Triple vitrage');
    const type = project.model.windowTypes.at(-1)!;
    project = updateWindowType(project, type.id, { uw: 0.8, g: 0.5 });
    expect(project.model.windowTypes.at(-1)).toMatchObject({ uw: { value: 0.8, from: 'user' }, g: { value: 0.5, from: 'user' } });
    project = updateWindowType(project, type.id, { g: 1.4 });
    expect(project.model.windowTypes.at(-1)!.g?.value).toBe(0.5);
    const storey = project.model.storeys[0]!;
    project = updateOpening(project, storey.id, storey.openings[0]!.id, { windowTypeId: type.id });
    project = removeWindowType(project, type.id);
    expect(project.model.storeys[0]!.openings[0]!.windowTypeId).toBeNull();
  });

  it('fabrique des identifiants libres', () => {
    expect(uniqueId('manual', [])).toBe('manual-1');
    expect(uniqueId('manual', ['manual-1', 'manual-2', 'manual-4'])).toBe('manual-3');
  });
});

describe('nombres saisis', () => {
  it('accepte la virgule et le point, refuse le reste', () => {
    expect(parseNumber('2,80')).toBe(2.8);
    expect(parseNumber('2.8')).toBe(2.8);
    expect(parseNumber(' 1 234,5 ')).toBe(1234.5);
    expect(parseNumber('2,')).toBe(2);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1,2,3')).toBeNull();
    expect(parseNumber('-')).toBeNull();
  });

  it('affiche avec une virgule et sans zéros inutiles', () => {
    expect(inputNumber(2.8)).toBe('2,8');
    expect(inputNumber(2.95, 2)).toBe('2,95');
    expect(inputNumber(1974, 0)).toBe('1974');
    expect(inputNumber(null)).toBe('');
    expect(unitLength(0.01)).toBe('1 cm');
    expect(unitLength(0.001)).toBe('1 mm');
    expect(unitLength(1)).toBe('1 m');
    expect(unitLength(0.035278)).toBe('3,528 cm');
    expect(unitLength(0)).toBe('?');
  });
});

describe('enregistrement dans le navigateur', () => {
  it('écrit puis relit le projet et ses repères', () => {
    const storage = memoryStorage();
    const project = house();
    const marks = { ...emptyMarks(), plan: { [project.model.storeys[0]!.id]: { outline: true as const } }, yearFromPeriod: true };
    expect(saveWorkspace(storage, { project, marks })).toEqual({ ok: true, error: null });
    const loaded = loadWorkspace(storage);
    expect(loaded?.project).toEqual(JSON.parse(JSON.stringify(project)));
    expect(loaded?.marks).toEqual(marks);
    clearWorkspace(storage);
    expect(loadWorkspace(storage)).toBeNull();
  });

  it('ne lève jamais : stockage absent, plein, ou projet non enregistrable', () => {
    const project = house();
    expect(saveWorkspace(null, { project, marks: emptyMarks() }).ok).toBe(false);
    const full = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('quota'); } };
    expect(saveWorkspace(full, { project, marks: emptyMarks() }).ok).toBe(false);
    expect(() => clearWorkspace(full)).not.toThrow();
    const reading = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => undefined, removeItem: () => undefined };
    expect(loadWorkspace(reading)).toBeNull();
    expect(initialLang(reading, ['de'])).toBe('de');

    // Une valeur que la relecture refuserait (nombre non fini) : l'enregistrement échoue proprement.
    const broken = structuredClone(project);
    broken.model.storeys[0]!.grossHeight.value = Number.NaN;
    const result = saveWorkspace(memoryStorage(), { project: broken, marks: emptyMarks() });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('fichier projet : les validations voyagent avec le projet, et un fichier sans elles s’ouvre « à confirmer »', () => {
    const project = house();
    const first = project.model.storeys[0]!.id;
    const marks = {
      ...emptyMarks(),
      plan: { [first]: { outline: true as const, boundary: true as const }, 'etage-disparu': { outline: true as const } },
      questions: { year: 'answered' as const },
      yearFromPeriod: true,
    };
    const json = serializeWorkspace({ project, marks });
    // Le fichier reste un projet du contrat : `parseProject` le relit sans broncher.
    expect(parseProject(json)).toEqual(JSON.parse(JSON.stringify(project)));
    const opened = parseWorkspace(json);
    expect(opened.project).toEqual(JSON.parse(JSON.stringify(project)));
    // Les repères d'un étage qui n'existe pas sont écartés.
    expect(opened.marks).toEqual({ ...marks, plan: { [first]: { outline: true, boundary: true } } });
    // Ancien fichier (sans repères), repères illisibles : tout est « à confirmer », sans erreur.
    expect(parseWorkspace(serializeProject(project)).marks).toEqual(emptyMarks());
    const odd = JSON.parse(json) as Record<string, unknown>;
    odd.marks = 'n’importe quoi';
    expect(parseWorkspace(JSON.stringify(odd)).marks).toEqual(emptyMarks());
    expect(() => parseWorkspace('{"bonjour":1}')).toThrow();
  });

  it('ne laisse pas une clé du fichier toucher au prototype des repères', () => {
    const marks = sanitizeMarks(JSON.parse('{"plan":{"__proto__":{"scale":true},"constructor":{"scale":true},"storey-1":{"scale":true}}}'));
    expect(Object.getPrototypeOf(marks.plan)).toBe(Object.prototype);
    expect(Object.keys(marks.plan)).toEqual(['storey-1']);
    expect((marks.plan as Record<string, unknown>).scale).toBeUndefined();
  });

  it('se méfie de ce qu’il relit', () => {
    expect(sanitizeMarks(null)).toEqual(emptyMarks());
    expect(sanitizeMarks('texte')).toEqual(emptyMarks());
    expect(
      sanitizeMarks({
        plan: { 'storey-1': { outline: true, rooms: 'oui', inconnu: true }, 'storey-2': 'x', 'storey-3': {} },
        questions: { year: 'skipped', windows: 'answered', heating: 'peut-être', autre: 'answered' },
        yearFromPeriod: 'true',
      }),
    ).toEqual({ plan: { 'storey-1': { outline: true } }, questions: { year: 'skipped', windows: 'answered' }, yearFromPeriod: false, entered: {} });

    const storage = memoryStorage({ [STORAGE_KEYS.project]: serializeProject(house()), [STORAGE_KEYS.marks]: '{illisible' });
    expect(loadWorkspace(storage)?.marks).toEqual(emptyMarks());
    expect(loadWorkspace(memoryStorage({ [STORAGE_KEYS.project]: '[]' }))).toBeNull();
  });

  it('langue de départ : celle retenue, sinon celle du navigateur, sinon le français', () => {
    expect(initialLang(memoryStorage({ [STORAGE_KEYS.lang]: 'de' }), ['fr-FR'])).toBe('de');
    expect(initialLang(memoryStorage({ [STORAGE_KEYS.lang]: 'en' }), ['de-DE'])).toBe('de');
    expect(initialLang(null, ['lb-LU', 'fr'])).toBe('de');
    expect(initialLang(null, ['en-GB', 'fr-BE'])).toBe('fr');
    expect(initialLang(null, ['en-US'])).toBe('fr');
    expect(initialLang(null)).toBe('fr');
  });

  it('relit les lignes cochées « saisies » avec prudence : seules les clés à vrai sont gardées', () => {
    expect(sanitizeMarks({ entered: { a: true, b: true } }).entered).toEqual({ a: true, b: true });
    expect(sanitizeMarks({ entered: { a: 1, b: 'oui', c: null, d: true, '': true } }).entered).toEqual({ d: true });
    expect(sanitizeMarks({ entered: ['a', 'b'] }).entered).toEqual({});
    expect(sanitizeMarks({}).entered).toEqual({});
    // Clés démesurées ou visant le prototype : écartées.
    const hostile = JSON.parse(`{"entered":{"__proto__":true,"constructor":true,"prototype":true,"${'x'.repeat(401)}":true,"ok":true}}`) as unknown;
    const clean = sanitizeMarks(hostile);
    expect(Object.keys(clean.entered)).toEqual(['ok']);
    expect(({} as Record<string, unknown>).ok).toBeUndefined();
    // Un fichier ne peut pas en faire porter des dizaines de milliers.
    const many = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, true]));
    expect(Object.keys(sanitizeMarks({ entered: many }).entered)).toHaveLength(5000);
  });

  it('efface l’ancienne clé des coches, du temps où elles vivaient à part du projet', () => {
    const storage = memoryStorage({ [LEGACY_ENTERED_KEY]: '["a"]', [STORAGE_KEYS.lang]: 'de' });
    dropLegacyEntered(storage);
    expect(storage.dump()).toEqual({ [STORAGE_KEYS.lang]: 'de' });
    dropLegacyEntered(null);
  });

  it('sans navigateur, il n’y a pas de stockage', () => {
    expect(browserStorage()).toBeNull();
  });
});

describe('changement de langue', () => {
  it('les noms par défaut suivent la langue ; un nom personnalisé ne change jamais', () => {
    let project = house();
    project = updateConstruction(project, DEFAULT_CONSTRUCTION_IDS.roof, { name: 'Toit ardoise' });
    const de = relocalizeDefaults(project, 'fr', 'de');
    const names = (p: Project): Record<string, string> => Object.fromEntries(p.model.constructions.map((c) => [c.id, c.name]));
    expect(names(de)[DEFAULT_CONSTRUCTION_IDS.wallOutside]).toBe('Außenwand');
    expect(names(de)[DEFAULT_CONSTRUCTION_IDS.roof]).toBe('Toit ardoise');
    expect(de.model.windowTypes[0]!.name).toBe('Fenster');
    expect(de.model.storeys[0]!.name).toBe('Erdgeschoss');
    // Retour au français : on retrouve le projet de départ ; même langue : même objet.
    expect(relocalizeDefaults(de, 'de', 'fr')).toEqual(project);
    expect(relocalizeDefaults(project, 'fr', 'fr')).toBe(project);
    // Tableaux dans la nouvelle langue.
    const rows = deriveSheets(de, 'de').envelope.map((r) => r.elementName);
    expect(rows).toContain('Außenwand');
    expect(rows).not.toContain('Mur extérieur');
  });
});
