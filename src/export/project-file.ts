/**
 * Fichier de projet Plan2CPE : JSON lisible, versionné.
 *
 *   { "app": "Plan2CPE", "version": 1, "model": { … }, "answers": { … } }
 *
 * Lecture STRICTE sur les types (un fichier abîmé ou étranger est refusé avec un message clair, en français
 * par défaut, traduisible) et TOLÉRANTE sur le reste :
 *  - les champs inconnus sont ignorés (et donc absents du projet renvoyé) ;
 *  - une réponse absente du questionnaire vaut « non renseigné » ;
 *  - le marqueur « app » est facultatif (un projet sérialisé à la main par JSON.stringify reste lisible).
 * Aucune cohérence métier n'est jugée ici (hauteurs plausibles, indices d'arêtes…) : c'est le rôle des
 * contrôles du moteur. Un projet en cours de saisie doit toujours pouvoir être enregistré et rouvert.
 *
 * L'écriture passe par la même validation : `serializeProject` refuse d'écrire un fichier que
 * `parseProject` ne saurait pas relire (un nombre NaN, par exemple, deviendrait « null » en JSON).
 */
import type {
  BottomClosure,
  BuildingModel,
  Construction,
  Lang,
  ManualRow,
  Opening,
  Project,
  ProjectAnswers,
  Room,
  Sourced,
  Storey,
  StoreyEdge,
  TopClosure,
  Vec2,
  WindowType,
} from '../core/types';
import { t } from '../i18n';
import './messages';

/** Marqueur d'application écrit dans chaque fichier. */
export const PROJECT_FILE_APP = 'Plan2CPE';
/** Version du format de fichier écrite et relue. */
export const PROJECT_FILE_VERSION = 1;

type Params = Record<string, string | number>;

/**
 * Erreur de lecture ou d'écriture d'un fichier de projet. `message` est en français ;
 * `localized('de')` donne le même message en allemand.
 */
export class ProjectFileError extends Error {
  readonly key: string;
  readonly params: Params;
  /** 'save' : le projet en mémoire ne peut pas être enregistré ; 'load' : le fichier ne peut pas être lu. */
  readonly stage: 'load' | 'save';

  constructor(key: string, params: Params = {}, stage: 'load' | 'save' = 'load') {
    super(ProjectFileError.compose('fr', key, params, stage));
    this.name = 'ProjectFileError';
    this.key = key;
    this.params = params;
    this.stage = stage;
  }

  localized(lang: Lang): string {
    return ProjectFileError.compose(lang, this.key, this.params, this.stage);
  }

  private static compose(lang: Lang, key: string, params: Params, stage: 'load' | 'save'): string {
    // Les variables qui sont elles-mêmes des clés (« un nombre », « un texte »…) sont traduites d'abord.
    const resolved: Params = {};
    for (const [name, value] of Object.entries(params)) {
      // Seules les variables que le code fournit lui-même comme clés sont traduites ; une valeur venue du fichier
      // (qui pourrait ressembler à une clé) est citée telle quelle.
      const ownKey = (name === 'expected' || name === 'found') && typeof value === 'string' && value.startsWith('export.file.');
      resolved[name] = ownKey ? t(lang, value as string) : value;
    }
    const text = t(lang, key, resolved);
    return stage === 'save' ? `${t(lang, 'export.file.savePrefix')} ${text}` : text;
  }
}

/** Message d'une erreur quelconque dans la langue de l'interface (pour l'afficher à l'utilisateur). */
export function projectFileErrorMessage(error: unknown, lang: Lang): string {
  if (error instanceof ProjectFileError) return error.localized(lang);
  const detail = error instanceof Error ? error.message : String(error);
  return t(lang, 'export.file.unexpected', { detail });
}

// ───────────────────────────── Petits lecteurs typés ─────────────────────────────

type Obj = Record<string, unknown>;
type Reader<T> = (value: unknown, path: string) => T;

function fail(key: string, params: Params): never {
  throw new ProjectFileError(key, params);
}

function describe(value: unknown): string {
  if (value === null) return 'export.file.found.null';
  if (value === undefined) return 'export.file.found.undefined';
  if (Array.isArray(value)) return 'export.file.found.array';
  switch (typeof value) {
    case 'string':
      return 'export.file.found.string';
    case 'number':
      return Number.isFinite(value) ? 'export.file.found.number' : 'export.file.found.nonFinite';
    case 'boolean':
      return 'export.file.found.boolean';
    case 'object':
      return 'export.file.found.object';
    default:
      return 'export.file.found.other';
  }
}

function wrongType(path: string, expected: string, value: unknown): never {
  if (value === undefined) fail('export.file.missing', { path });
  return fail('export.file.type', { path, expected: `export.file.expected.${expected}`, found: describe(value) });
}

const asObject: Reader<Obj> = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return wrongType(path, 'object', value);
  return value as Obj;
};

const asString: Reader<string> = (value, path) => (typeof value === 'string' ? value : wrongType(path, 'string', value));

const asNumber: Reader<number> = (value, path) =>
  typeof value === 'number' && Number.isFinite(value) ? value : wrongType(path, 'number', value);

const asIndex: Reader<number> = (value, path) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : wrongType(path, 'index', value);

const asBoolean: Reader<boolean> = (value, path) => (typeof value === 'boolean' ? value : wrongType(path, 'boolean', value));

function oneOf<T extends string>(allowed: readonly T[]): Reader<T> {
  return (value, path) => {
    if (typeof value !== 'string') return wrongType(path, 'string', value);
    const found = allowed.find((a) => a === value);
    if (found === undefined) return fail('export.file.enum', { path, value: value.slice(0, 40), allowed: allowed.join(', ') });
    return found;
  };
}

function nullable<T>(reader: Reader<T>): Reader<T | null> {
  return (value, path) => (value === null ? null : reader(value, path));
}

/**
 * Longueur maximale d'une liste du fichier projet. Aucun bâtiment réel n'en approche ; au-delà, le fichier est
 * corrompu ou hostile, et les contrôles géométriques (quadratiques) figeraient l'onglet.
 */
export const MAX_LIST_LENGTH = 5000;

function listOf<T>(reader: Reader<T>): Reader<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return wrongType(path, 'array', value);
    if (value.length > MAX_LIST_LENGTH) return fail('export.file.tooLong', { path, found: value.length, max: MAX_LIST_LENGTH });
    return value.map((entry: unknown, i) => reader(entry, `${path}[${i}]`));
  };
}

/** Lit le champ `key` de `obj` avec le lecteur donné (le chemin sert aux messages d'erreur). */
function field<T>(obj: Obj, key: string, path: string, reader: Reader<T>): T {
  return reader(Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined, path ? `${path}.${key}` : key);
}

/** Champ facultatif : absent (ou undefined) → non renvoyé. */
function optional<T>(obj: Obj, key: string, path: string, reader: Reader<T>): T | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] === undefined) return undefined;
  return field(obj, key, path, reader);
}

// ───────────────────────────── Énumérations du contrat ─────────────────────────────

const PROVENANCE = oneOf(['plan', 'calc', 'default', 'estimate', 'user'] as const);
const BOUNDARY = oneOf(['outside', 'ground', 'unheated', 'heated'] as const);
const CATEGORY = oneOf(['wall', 'roof', 'ceiling', 'floor', 'door'] as const);
const OPENING_KIND = oneOf(['window', 'door'] as const);
const TOP_KIND = oneOf(['flat-roof', 'pitched-roof', 'attic-ceiling'] as const);
const ROOF_SHAPE = oneOf(['gable', 'hip', 'mono'] as const);
const BOTTOM_KIND = oneOf(['slab-on-ground', 'above-unheated', 'above-outside'] as const);
const ORIENTATION = oneOf(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'H'] as const);
const BUILDING_TYPE = oneOf(['EFH', 'MFH'] as const);
const OCCASION = oneOf(['new', 'existing'] as const);
const GENERATOR = oneOf([
  'gas-condensing',
  'gas-low-temp',
  'oil-condensing',
  'oil-low-temp',
  'old-boiler',
  'heat-pump-air',
  'heat-pump-ground',
  'pellets',
  'wood-logs',
  'district-heating',
  'electric-direct',
  'other',
] as const);
const EMISSION = oneOf(['radiators', 'floor-heating', 'mixed', 'air'] as const);
const HOT_WATER = oneOf(['with-heating', 'separate-electric', 'separate-heat-pump', 'separate-other'] as const);
const VENTILATION = oneOf(['windows', 'exhaust', 'balanced-hr'] as const);
const WINDOW_GENERATION = oneOf(['single', 'double-old', 'double-lowe', 'triple'] as const);

// ───────────────────────────── Lecteurs du modèle ─────────────────────────────

const readVec2: Reader<Vec2> = (value, path) => {
  const o = asObject(value, path);
  return { x: field(o, 'x', path, asNumber), y: field(o, 'y', path, asNumber) };
};

const readSourcedNumber: Reader<Sourced<number>> = (value, path) => {
  const o = asObject(value, path);
  const sourced: Sourced<number> = { value: field(o, 'value', path, asNumber), from: field(o, 'from', path, PROVENANCE) };
  const note = optional(o, 'note', path, asString);
  if (note !== undefined) sourced.note = note;
  return sourced;
};

const readEdge: Reader<StoreyEdge> = (value, path) => {
  const o = asObject(value, path);
  return { boundary: field(o, 'boundary', path, BOUNDARY), constructionId: field(o, 'constructionId', path, nullable(asString)) };
};

const readOpening: Reader<Opening> = (value, path) => {
  const o = asObject(value, path);
  const opening: Opening = {
    id: field(o, 'id', path, asString),
    edgeIndex: field(o, 'edgeIndex', path, asIndex),
    kind: field(o, 'kind', path, OPENING_KIND),
    width: field(o, 'width', path, asNumber),
    height: field(o, 'height', path, asNumber),
    count: field(o, 'count', path, asNumber),
    position: field(o, 'position', path, asNumber),
    windowTypeId: field(o, 'windowTypeId', path, nullable(asString)),
    from: field(o, 'from', path, PROVENANCE),
  };
  const sheetWidth = optional(o, 'sheetWidth', path, asNumber);
  if (sheetWidth !== undefined) opening.sheetWidth = sheetWidth;
  return opening;
};

const readRoom: Reader<Room> = (value, path) => {
  const o = asObject(value, path);
  const room: Room = {
    id: field(o, 'id', path, asString),
    name: field(o, 'name', path, asString),
    area: field(o, 'area', path, readSourcedNumber),
    heated: field(o, 'heated', path, asBoolean),
    needsReview: field(o, 'needsReview', path, asBoolean),
  };
  const polygon = optional(o, 'polygon', path, listOf(readVec2));
  if (polygon !== undefined) room.polygon = polygon;
  const at = optional(o, 'at', path, readVec2);
  if (at !== undefined) room.at = at;
  return room;
};

const readStorey: Reader<Storey> = (value, path) => {
  const o = asObject(value, path);
  const outline = field(o, 'outline', path, listOf(readVec2));
  const edges = field(o, 'edges', path, listOf(readEdge));
  // Invariant du contrat : une condition aux limites par côté du contour.
  if (edges.length !== outline.length) fail('export.file.length', { path: `${path}.edges`, found: edges.length, expected: outline.length });
  return {
    id: field(o, 'id', path, asString),
    name: field(o, 'name', path, asString),
    sheetId: field(o, 'sheetId', path, nullable(asString)),
    outline,
    edges,
    metresPerUnit: field(o, 'metresPerUnit', path, readSourcedNumber),
    grossHeight: field(o, 'grossHeight', path, readSourcedNumber),
    clearHeight: field(o, 'clearHeight', path, readSourcedNumber),
    openings: field(o, 'openings', path, listOf(readOpening)),
    rooms: field(o, 'rooms', path, listOf(readRoom)),
    netAreaOverride: field(o, 'netAreaOverride', path, nullable(readSourcedNumber)),
  };
};

const readTop: Reader<TopClosure> = (value, path) => {
  const o = asObject(value, path);
  return {
    kind: field(o, 'kind', path, TOP_KIND),
    pitchDeg: field(o, 'pitchDeg', path, asNumber),
    shape: field(o, 'shape', path, ROOF_SHAPE),
    ridgeAngle: field(o, 'ridgeAngle', path, nullable(asNumber)),
    kneeWallHeight: field(o, 'kneeWallHeight', path, asNumber),
    constructionId: field(o, 'constructionId', path, nullable(asString)),
    from: field(o, 'from', path, PROVENANCE),
  };
};

const readBottom: Reader<BottomClosure> = (value, path) => {
  const o = asObject(value, path);
  return {
    kind: field(o, 'kind', path, BOTTOM_KIND),
    constructionId: field(o, 'constructionId', path, nullable(asString)),
    from: field(o, 'from', path, PROVENANCE),
  };
};

const readConstruction: Reader<Construction> = (value, path) => {
  const o = asObject(value, path);
  return {
    id: field(o, 'id', path, asString),
    name: field(o, 'name', path, asString),
    category: field(o, 'category', path, CATEGORY),
    u: field(o, 'u', path, nullable(readSourcedNumber)),
  };
};

const readWindowType: Reader<WindowType> = (value, path) => {
  const o = asObject(value, path);
  return {
    id: field(o, 'id', path, asString),
    name: field(o, 'name', path, asString),
    uw: field(o, 'uw', path, nullable(readSourcedNumber)),
    g: field(o, 'g', path, nullable(readSourcedNumber)),
  };
};

const readManualRow: Reader<ManualRow> = (value, path) => {
  const o = asObject(value, path);
  return {
    id: field(o, 'id', path, asString),
    label: field(o, 'label', path, asString),
    constructionId: field(o, 'constructionId', path, nullable(asString)),
    windowTypeId: field(o, 'windowTypeId', path, nullable(asString)),
    count: field(o, 'count', path, asNumber),
    length: field(o, 'length', path, asNumber),
    width: field(o, 'width', path, asNumber),
    orientation: field(o, 'orientation', path, ORIENTATION),
    boundary: field(o, 'boundary', path, BOUNDARY),
    deduct: field(o, 'deduct', path, asBoolean),
  };
};

const readModel: Reader<BuildingModel> = (value, path) => {
  const o = asObject(value, path);
  return {
    storeys: field(o, 'storeys', path, listOf(readStorey)),
    northAngle: field(o, 'northAngle', path, readSourcedNumber),
    storeysAligned: field(o, 'storeysAligned', path, asBoolean),
    top: field(o, 'top', path, readTop),
    bottom: field(o, 'bottom', path, readBottom),
    constructions: field(o, 'constructions', path, listOf(readConstruction)),
    windowTypes: field(o, 'windowTypes', path, listOf(readWindowType)),
    manualRows: field(o, 'manualRows', path, listOf(readManualRow)),
  };
};

// ───────────────────────────── Réponses ─────────────────────────────

/** Réponse du questionnaire : absente → valeur « non renseigné » ; présente → type vérifié. */
function answer<T>(obj: Obj, key: string, path: string, reader: Reader<T>, missing: T): T {
  const value = optional(obj, key, path, reader);
  return value === undefined ? missing : value;
}

const readAnswers: Reader<ProjectAnswers> = (value, path) => {
  const o = asObject(value, path);
  return {
    projectName: answer(o, 'projectName', path, asString, ''),
    street: answer(o, 'street', path, asString, ''),
    postcode: answer(o, 'postcode', path, asString, ''),
    locality: answer(o, 'locality', path, asString, ''),
    buildingType: answer(o, 'buildingType', path, nullable(BUILDING_TYPE), null),
    dwellings: answer(o, 'dwellings', path, nullable(asNumber), null),
    occasion: answer(o, 'occasion', path, nullable(OCCASION), null),
    yearBuilt: answer(o, 'yearBuilt', path, nullable(asNumber), null),
    insulationWallsCm: answer(o, 'insulationWallsCm', path, nullable(asNumber), null),
    insulationRoofCm: answer(o, 'insulationRoofCm', path, nullable(asNumber), null),
    insulationFloorCm: answer(o, 'insulationFloorCm', path, nullable(asNumber), null),
    windowGeneration: answer(o, 'windowGeneration', path, nullable(WINDOW_GENERATION), null),
    heatGenerator: answer(o, 'heatGenerator', path, nullable(GENERATOR), null),
    heatGeneratorYear: answer(o, 'heatGeneratorYear', path, nullable(asNumber), null),
    heatEmission: answer(o, 'heatEmission', path, nullable(EMISSION), null),
    hotWater: answer(o, 'hotWater', path, nullable(HOT_WATER), null),
    ventilation: answer(o, 'ventilation', path, nullable(VENTILATION), null),
    n50: answer(o, 'n50', path, nullable(asNumber), null),
    solarThermal: answer(o, 'solarThermal', path, nullable(asBoolean), null),
    photovoltaic: answer(o, 'photovoltaic', path, nullable(asBoolean), null),
  };
};

// ───────────────────────────── Projet ─────────────────────────────

/** Vérifie une valeur quelconque et renvoie un projet « propre » (champs du contrat seulement). */
function readProject(value: unknown): Project {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('export.file.notObject', {});
  const root = value as Obj;

  const app = Object.prototype.hasOwnProperty.call(root, 'app') ? root['app'] : undefined;
  if (app !== undefined && app !== PROJECT_FILE_APP) {
    fail('export.file.wrongApp', { app: typeof app === 'string' ? app.slice(0, 40) : '?' });
  }

  const version = Object.prototype.hasOwnProperty.call(root, 'version') ? root['version'] : undefined;
  if (version === undefined || version === null) fail('export.file.noVersion', {});
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fail('export.file.badVersion', { version: String(version).slice(0, 20), supported: PROJECT_FILE_VERSION });
  }
  if (version > PROJECT_FILE_VERSION) fail('export.file.newerVersion', { version });

  return {
    version: PROJECT_FILE_VERSION,
    model: field(root, 'model', '', readModel),
    answers: field(root, 'answers', '', readAnswers),
  };
}

/** Toute erreur imprévue devient une ProjectFileError : jamais de TypeError brut pour l'appelant. */
function guarded<T>(stage: 'load' | 'save', run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ProjectFileError) {
      throw stage === error.stage ? error : new ProjectFileError(error.key, error.params, stage);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProjectFileError('export.file.unexpected', { detail: detail.slice(0, 120) }, stage);
  }
}

/**
 * Projet → JSON (sauvegarde), indenté, clés dans un ordre stable.
 * Lève une ProjectFileError si le projet contient une valeur qui ne survivrait pas à la relecture
 * (nombre non fini, champ obligatoire manquant) : mieux vaut le dire à l'enregistrement qu'à la réouverture.
 */
export function serializeProject(project: Project): string {
  return guarded('save', () => {
    const clean = readProject(project);
    return JSON.stringify({ app: PROJECT_FILE_APP, version: clean.version, model: clean.model, answers: clean.answers }, null, 2);
  });
}

/** JSON → projet, avec validation ; lève une ProjectFileError (message en français) si le fichier n'est pas un projet valide. */
export function parseProject(json: string): Project {
  return guarded('load', () => {
    if (typeof json !== 'string') fail('export.file.notString', {});
    // Un éditeur de texte peut avoir ajouté une marque d'ordre des octets en tête de fichier.
    const text = json.replace(/^\uFEFF/, '').trim();
    if (text === '') fail('export.file.empty', {});
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      fail('export.file.notJson', {});
    }
    return readProject(data);
  });
}
