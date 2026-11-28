import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/core/types';
import { parseProject, PROJECT_FILE_APP, PROJECT_FILE_VERSION, ProjectFileError, projectFileErrorMessage, serializeProject } from '../../src/export';
import { makeProject } from './fixtures';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Step = string | number;

function fileOf(project: Project = makeProject()): Json {
  return JSON.parse(serializeProject(project)) as Json;
}

/** « model.storeys[0].edges » → ['model', 'storeys', 0, 'edges'] */
function steps(path: string): Step[] {
  return [...path.matchAll(/[^.[\]]+/g)].map((m) => (/^\d+$/.test(m[0]) ? Number(m[0]) : m[0]));
}

function child(node: Json, step: Step): Json {
  const value = Array.isArray(node) && typeof step === 'number' ? node[step] : node !== null && typeof node === 'object' && !Array.isArray(node) ? node[String(step)] : undefined;
  if (value === undefined) throw new Error(`chemin de test invalide : ${String(step)}`);
  return value;
}

/** Copie du JSON où la valeur au chemin donné est remplacée (ou supprimée si `replacement` est undefined). */
function mutate(root: Json, path: Step[], replacement: Json | undefined): Json {
  const copy = JSON.parse(JSON.stringify(root)) as Json;
  let node = copy;
  for (const step of path.slice(0, -1)) node = child(node, step);
  const last = path[path.length - 1]!;
  if (Array.isArray(node) && typeof last === 'number') {
    if (replacement === undefined) node.splice(last, 1);
    else node[last] = replacement;
  } else if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    if (replacement === undefined) delete node[String(last)];
    else node[String(last)] = replacement;
  } else {
    throw new Error('chemin de test invalide');
  }
  return copy;
}

/** Appelle parseProject et renvoie l'erreur levée (échoue s'il n'y en a pas). */
function errorOf(json: unknown): ProjectFileError {
  try {
    parseProject(json as string);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectFileError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    return error as ProjectFileError;
  }
  throw new Error('parseProject aurait dû refuser ce fichier');
}

/** Fichier valide dont un champ est remplacé (ou supprimé), puis relu : renvoie l'erreur. */
function errorWith(path: string, replacement: Json | undefined): ProjectFileError {
  return errorOf(JSON.stringify(mutate(fileOf(), steps(path), replacement)));
}

describe('serializeProject', () => {
  it('écrit un JSON indenté, marqué et versionné', () => {
    const text = serializeProject(makeProject());
    expect(text.startsWith('{\n  "app": "Plan2CPE",\n  "version": 2,\n  "model": {')).toBe(true);
    const file = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(file)).toEqual(['app', 'version', 'model', 'answers']);
    expect(file['app']).toBe(PROJECT_FILE_APP);
    expect(file['version']).toBe(PROJECT_FILE_VERSION);
  });

  it('fait un aller-retour sans perte', () => {
    const project = makeProject();
    const back = parseProject(serializeProject(project));
    expect(back).toEqual(project);
    expect(back).not.toBe(project);
    // forme canonique : relire puis réécrire ne change plus rien
    expect(serializeProject(back)).toBe(serializeProject(project));
  });

  it('conserve les champs facultatifs présents et n’en invente pas', () => {
    const back = parseProject(serializeProject(makeProject()));
    const storey = back.model.storeys[0]!;
    expect(storey.metresPerUnit.note).toBe('Règle posée sur la cote 10,00');
    expect('note' in storey.grossHeight).toBe(false);
    expect(storey.rooms[0]!.at).toEqual({ x: 3, y: 3 });
    expect('polygon' in storey.rooms[0]!).toBe(false);
    expect(storey.rooms[1]!.polygon).toHaveLength(4);
    expect('at' in storey.rooms[1]!).toBe(false);
  });

  it('accepte un projet vide en cours de saisie', () => {
    const project = makeProject();
    project.model.storeys = [];
    project.model.constructions = [];
    project.model.windowTypes = [];
    project.answers.projectName = '';
    expect(parseProject(serializeProject(project))).toEqual(project);
  });

  it('ne modifie pas le projet reçu et ignore les champs facultatifs « undefined »', () => {
    const project = makeProject();
    (project.model.northAngle as { note?: string }).note = undefined;
    const before = JSON.stringify(project);
    const text = serializeProject(project);
    expect(JSON.stringify(project)).toBe(before);
    expect('note' in parseProject(text).model.northAngle).toBe(false);
  });

  it('refuse d’écrire un fichier qu’il ne saurait pas relire (nombre non fini)', () => {
    const project = makeProject();
    project.model.storeys[0]!.grossHeight.value = Number.NaN;
    let caught: unknown;
    try {
      serializeProject(project);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProjectFileError);
    const error = caught as ProjectFileError;
    expect(error.stage).toBe('save');
    expect(error.message).toBe(
      'Enregistrement impossible, le projet contient une valeur invalide. Fichier de projet invalide : « model.storeys[0].grossHeight.value » doit être un nombre (trouvé : un nombre non fini).',
    );
    expect(error.localized('de')).toBe(
      'Speichern nicht möglich, das Projekt enthält einen ungültigen Wert. Projektdatei ungültig: „model.storeys[0].grossHeight.value“ muss eine Zahl sein (gefunden: eine nicht endliche Zahl).',
    );
  });

  it('refuse proprement un projet absent ou incomplet en mémoire', () => {
    for (const bad of [undefined, null, 42, {}, { version: 1 }, { version: 1, model: {}, answers: {} }]) {
      expect(() => serializeProject(bad as unknown as Project)).toThrow(ProjectFileError);
    }
  });
});

describe('parseProject — tolérance', () => {
  it('ignore les champs inconnus à tous les niveaux', () => {
    let file = fileOf();
    const extras: [string, Json][] = [
      ['savedWith', 'Plan2CPE 9.9'],
      ['model.futureField', { a: 1 }],
      ['model.storeys[0].color', 'red'],
      ['model.storeys[0].rooms[0].tags', ['x']],
      // « confidence » fait partie du format 2 : le champ inconnu essayé ici est un autre.
      ['model.storeys[0].metresPerUnit.precision', 0.9],
      ['answers.batteryStorage', true],
    ];
    for (const [path, value] of extras) file = mutate(file, steps(path), value);
    const project = parseProject(JSON.stringify(file));
    expect(project).toEqual(makeProject());
    expect('futureField' in project.model).toBe(false);
    expect('batteryStorage' in project.answers).toBe(false);
  });

  it('lit un projet écrit sans marqueur d’application (JSON.stringify direct)', () => {
    expect(parseProject(JSON.stringify(makeProject()))).toEqual(makeProject());
  });

  it('accepte une marque BOM et des blancs autour du JSON', () => {
    const text = `${String.fromCharCode(0xfeff)}\n  ${serializeProject(makeProject())}\n\n`;
    expect(parseProject(text)).toEqual(makeProject());
  });

  it('prend une réponse absente du questionnaire pour « non renseigné »', () => {
    let file = fileOf();
    for (const path of ['answers.photovoltaic', 'answers.n50', 'answers.street']) file = mutate(file, steps(path), undefined);
    const project = parseProject(JSON.stringify(file));
    expect(project.answers.photovoltaic).toBeNull();
    expect(project.answers.n50).toBeNull();
    expect(project.answers.street).toBe('');
    expect(project.answers.projectName).toBe('Maison Schmit');
    const empty = parseProject(JSON.stringify(mutate(file, ['answers'], {})));
    expect(empty.answers.heatGenerator).toBeNull();
    expect(empty.answers.projectName).toBe('');
  });

  it('ne se laisse pas polluer par une clé « __proto__ »', () => {
    const text = serializeProject(makeProject()).replace('"app": "Plan2CPE",', '"app": "Plan2CPE", "__proto__": {"polluted": true},');
    const project = parseProject(text);
    expect(project).toEqual(makeProject());
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect((project as unknown as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('parseProject — refus avec un message clair en français', () => {
  it.each([
    ['', 'Le fichier de projet est vide.'],
    ['   \n ', 'Le fichier de projet est vide.'],
    ['ceci n’est pas du JSON', "Ce fichier n'est pas un projet Plan2CPE lisible : son contenu n'est pas du JSON valide (fichier tronqué ou d'un autre type ?)."],
    ['{"version": 1, "model": {', "Ce fichier n'est pas un projet Plan2CPE lisible : son contenu n'est pas du JSON valide (fichier tronqué ou d'un autre type ?)."],
    ['[]', "Ce fichier n'est pas un projet Plan2CPE : un objet JSON est attendu à la racine."],
    ['null', "Ce fichier n'est pas un projet Plan2CPE : un objet JSON est attendu à la racine."],
    ['42', "Ce fichier n'est pas un projet Plan2CPE : un objet JSON est attendu à la racine."],
    ['"texte"', "Ce fichier n'est pas un projet Plan2CPE : un objet JSON est attendu à la racine."],
    ['{}', "Ce fichier n'est pas un projet Plan2CPE : le numéro de version est absent."],
    ['{"name": "package", "dependencies": {}}', "Ce fichier n'est pas un projet Plan2CPE : le numéro de version est absent."],
    ['{"version": "1"}', 'Version de fichier non reconnue (1) : seuls les formats 1, 2 sont pris en charge.'],
    ['{"version": 0}', 'Version de fichier non reconnue (0) : seuls les formats 1, 2 sont pris en charge.'],
    ['{"version": 1.5}', 'Version de fichier non reconnue (1.5) : seuls les formats 1, 2 sont pris en charge.'],
    ['{"version": 3}', "Ce projet a été enregistré avec une version plus récente de Plan2CPE (format 3). Mettez l'application à jour pour l'ouvrir."],
    ['{"app": "AutreLogiciel", "version": 1}', "Ce fichier vient d'une autre application (« AutreLogiciel ») : ce n'est pas un projet Plan2CPE."],
    ['{"version": 1}', 'Fichier de projet incomplet : « model » est absent.'],
    ['{"version": 1, "model": []}', 'Fichier de projet invalide : « model » doit être un objet (trouvé : une liste).'],
  ])('%s', (json, message) => {
    expect(errorOf(json).message).toBe(message);
  });

  it('refuse ce qui n’est pas une chaîne sans lever de TypeError', () => {
    for (const bad of [undefined, null, 42, {}, [], new Uint8Array(3)]) {
      expect(errorOf(bad).message).toBe("Aucun contenu à lire : le fichier de projet n'a pas pu être chargé.");
    }
  });

  it('nomme le champ fautif par son chemin', () => {
    expect(errorWith('answers', undefined).message).toBe('Fichier de projet incomplet : « answers » est absent.');
    expect(errorWith('model.storeys[0].grossHeight', undefined).message).toBe('Fichier de projet incomplet : « model.storeys[0].grossHeight » est absent.');
    expect(errorWith('model.storeys[0].grossHeight.value', '2,80').message).toBe(
      'Fichier de projet invalide : « model.storeys[0].grossHeight.value » doit être un nombre (trouvé : un texte).',
    );
    expect(errorWith('model.storeys[0].outline[2].y', null).message).toBe(
      'Fichier de projet invalide : « model.storeys[0].outline[2].y » doit être un nombre (trouvé : une valeur vide (null)).',
    );
    expect(errorWith('model.storeys', {}).message).toBe('Fichier de projet invalide : « model.storeys » doit être une liste (trouvé : un objet).');
    expect(errorWith('model.storeysAligned', 'non').message).toBe('Fichier de projet invalide : « model.storeysAligned » doit être vrai ou faux (trouvé : un texte).');
    expect(errorWith('model.storeys[0].name', 12).message).toBe('Fichier de projet invalide : « model.storeys[0].name » doit être un texte (trouvé : un nombre).');
    expect(errorWith('model.storeys[0].openings[0].edgeIndex', -1).message).toBe(
      'Fichier de projet invalide : « model.storeys[0].openings[0].edgeIndex » doit être un entier positif ou nul (trouvé : un nombre).',
    );
    expect(errorWith('answers.dwellings', 'deux').message).toBe('Fichier de projet invalide : « answers.dwellings » doit être un nombre (trouvé : un texte).');
    expect(errorWith('model.windowTypes[0].uw', 1.3).message).toBe(
      'Fichier de projet invalide : « model.windowTypes[0].uw » doit être un objet (trouvé : un nombre).',
    );
  });

  it('refuse une valeur hors de la liste admise en les énumérant', () => {
    expect(errorWith('model.top.kind', 'dome').message).toBe(
      'Fichier de projet invalide : « model.top.kind » vaut « dome » ; valeurs admises : flat-roof, pitched-roof, attic-ceiling.',
    );
    expect(errorWith('model.storeys[0].edges[1].boundary', 'water').message).toBe(
      'Fichier de projet invalide : « model.storeys[0].edges[1].boundary » vaut « water » ; valeurs admises : outside, ground, unheated, heated.',
    );
    expect(errorWith('model.northAngle.from', 'guess').message).toContain('valeurs admises : plan, calc, default, estimate, user');
    expect(errorWith('answers.ventilation', 'none').message).toContain('« answers.ventilation » vaut « none »');
  });

  it('cite une valeur venue du fichier telle quelle, même si elle ressemble à une clé de message', () => {
    expect(errorWith('model.storeys[0].edges[1].boundary', 'export.file.notJson').message).toBe(
      'Fichier de projet invalide : « model.storeys[0].edges[1].boundary » vaut « export.file.notJson » ; valeurs admises : outside, ground, unheated, heated.',
    );
  });

  it('refuse une liste démesurée avant de la parcourir (fichier corrompu ou hostile)', () => {
    const data = JSON.parse(serializeProject(makeProject())) as { model: { storeys: { outline: unknown[]; edges: unknown[] }[] } };
    const storey = data.model.storeys[0]!;
    storey.outline = Array.from({ length: 5001 }, (_, i) => ({ x: i, y: i % 2 }));
    storey.edges = storey.outline.map(() => ({ boundary: 'outside', constructionId: null }));
    const error = errorOf(JSON.stringify(data));
    expect(error.key).toBe('export.file.tooLong');
    expect(error.message).toBe('Fichier de projet invalide : « model.storeys[0].outline » compte 5001 éléments (maximum : 5000).');
    expect(error.localized('de')).toContain('5001 Elemente');
  });

  it('refuse un contour dont les côtés n’ont pas tous leur condition aux limites', () => {
    expect(errorWith('model.storeys[0].edges[3]', undefined).message).toBe(
      'Fichier de projet invalide : « model.storeys[0].edges » compte 3 élément(s) au lieu de 4 (un par côté du contour).',
    );
  });

  it('sait redire l’erreur en allemand', () => {
    const error = errorWith('model.storeys[0].grossHeight.value', 'x');
    expect(error.stage).toBe('load');
    expect(error.key).toBe('export.file.type');
    expect(error.localized('de')).toBe('Projektdatei ungültig: „model.storeys[0].grossHeight.value“ muss eine Zahl sein (gefunden: ein Text).');
    expect(projectFileErrorMessage(error, 'de')).toBe(error.localized('de'));
    expect(projectFileErrorMessage(error, 'fr')).toBe(error.message);
    expect(projectFileErrorMessage(new RangeError('pile pleine'), 'fr')).toBe("Le fichier de projet n'a pas pu être lu (pile pleine).");
    expect(errorOf('{').localized('de')).toContain('kein gültiges JSON');
  });
});

describe('parseProject — fichiers abîmés au hasard', () => {
  /** Tous les chemins (objets et tableaux) d'une valeur JSON. */
  function paths(value: Json, prefix: Step[] = []): Step[][] {
    const out: Step[][] = [];
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        out.push([...prefix, i], ...paths(v, [...prefix, i]));
      });
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) out.push([...prefix, k], ...paths(v, [...prefix, k]));
    }
    return out;
  }

  it('renvoie un projet valide ou lève une ProjectFileError — jamais autre chose', () => {
    const valid = fileOf();
    const replacements: (Json | undefined)[] = [undefined, null, 'x', '', 42, -1, 1.5, true, false, [], {}, [null], { value: 'x' }, [[1]]];
    let refused = 0;
    let accepted = 0;
    for (const path of paths(valid)) {
      for (const replacement of replacements) {
        const text = JSON.stringify(mutate(valid, path, replacement));
        try {
          const project = parseProject(text);
          // Accepté : le résultat doit lui-même être enregistrable et relisible.
          expect(parseProject(serializeProject(project))).toEqual(project);
          accepted++;
        } catch (error) {
          if (!(error instanceof ProjectFileError)) {
            throw new Error(`erreur brute pour ${path.join('.')} ← ${JSON.stringify(replacement)} : ${String(error)}`);
          }
          expect(error.message).toMatch(/^(Fichier de projet|Ce fichier|Version de fichier|Ce projet)/);
          expect(error.message).not.toMatch(/undefined|Cannot|export\.file|\{[a-z]+\}/);
          refused++;
        }
      }
    }
    // Le jeu d'essai produit des milliers de fichiers abîmés ; la plupart doivent être refusés.
    expect(refused).toBeGreaterThan(1000);
    expect(accepted).toBeGreaterThan(50);
  });

  it('refuse tout fichier tronqué', () => {
    const text = serializeProject(makeProject());
    for (let cut = 0; cut < text.length - 1; cut += 37) {
      expect(() => parseProject(text.slice(0, cut))).toThrow(ProjectFileError);
    }
  });
});
