/**
 * Valeurs de départ : réponses vides, types d'éléments par défaut, projet vide.
 * Les valeurs U restent à null : elles se définissent dans LuxEeB-Tool (aucune table officielle n'est embarquée ici).
 */
import type {
  BottomClosure,
  BottomKind,
  Boundary,
  BuildingModel,
  Construction,
  ConstructionCategory,
  Lang,
  Project,
  ProjectAnswers,
  TopClosure,
  WindowType,
} from '../core/types';
import { t } from '../i18n';
import './messages';

/** Identifiants stables des types par défaut (un par catégorie et condition aux limites usuelle). */
export const DEFAULT_CONSTRUCTION_IDS = {
  wallOutside: 'wall-outside',
  wallGround: 'wall-ground',
  wallUnheated: 'wall-unheated',
  roof: 'roof',
  ceiling: 'ceiling-attic',
  floorGround: 'floor-ground',
  floorUnheated: 'floor-unheated',
  floorOutside: 'floor-outside',
  door: 'door',
} as const;

export const DEFAULT_WINDOW_TYPE_ID = 'window-default';

/** Hauteurs par défaut (m) — toujours marquées 'default', donc à confirmer. */
export const DEFAULT_GROSS_HEIGHT = 2.8;
export const DEFAULT_CLEAR_HEIGHT = 2.5;
export const DEFAULT_WINDOW_HEIGHT = 1.35;
export const DEFAULT_DOOR_HEIGHT = 2.1;

const DEFAULT_CONSTRUCTION_LIST: ReadonlyArray<{ id: string; category: ConstructionCategory }> = [
  { id: DEFAULT_CONSTRUCTION_IDS.wallOutside, category: 'wall' },
  { id: DEFAULT_CONSTRUCTION_IDS.wallGround, category: 'wall' },
  { id: DEFAULT_CONSTRUCTION_IDS.wallUnheated, category: 'wall' },
  { id: DEFAULT_CONSTRUCTION_IDS.roof, category: 'roof' },
  { id: DEFAULT_CONSTRUCTION_IDS.ceiling, category: 'ceiling' },
  { id: DEFAULT_CONSTRUCTION_IDS.floorGround, category: 'floor' },
  { id: DEFAULT_CONSTRUCTION_IDS.floorUnheated, category: 'floor' },
  { id: DEFAULT_CONSTRUCTION_IDS.floorOutside, category: 'floor' },
  { id: DEFAULT_CONSTRUCTION_IDS.door, category: 'door' },
];

export function emptyAnswers(): ProjectAnswers {
  return {
    projectName: '',
    street: '',
    postcode: '',
    locality: '',
    buildingType: null,
    dwellings: null,
    occasion: null,
    yearBuilt: null,
    insulationWallsCm: null,
    insulationRoofCm: null,
    insulationFloorCm: null,
    windowGeneration: null,
    heatGenerator: null,
    heatGeneratorYear: null,
    heatEmission: null,
    hotWater: null,
    ventilation: null,
    n50: null,
    solarThermal: null,
    photovoltaic: null,
  };
}

export function defaultConstructions(lang: Lang): Construction[] {
  return DEFAULT_CONSTRUCTION_LIST.map((c) => ({
    id: c.id,
    name: t(lang, `engine.construction.${c.id}`),
    category: c.category,
    u: null,
  }));
}

export function defaultWindowTypes(lang: Lang): WindowType[] {
  return [{ id: DEFAULT_WINDOW_TYPE_ID, name: t(lang, 'engine.windowType.default'), uw: null, g: null }];
}

/** Fermeture haute de départ : plancher haut vers grenier non chauffé (à confirmer). */
export function defaultTop(): TopClosure {
  return {
    kind: 'attic-ceiling',
    pitchDeg: 35,
    shape: 'gable',
    ridgeAngle: null,
    kneeWallHeight: 0,
    constructionId: null,
    from: 'default',
  };
}

export function defaultBottom(kind: BottomKind = 'slab-on-ground'): BottomClosure {
  return { kind, constructionId: null, from: 'default' };
}

export function emptyModel(lang: Lang): BuildingModel {
  return {
    storeys: [],
    northAngle: { value: 0, from: 'default' },
    storeysAligned: false,
    top: defaultTop(),
    bottom: defaultBottom(),
    constructions: defaultConstructions(lang),
    windowTypes: defaultWindowTypes(lang),
    manualRows: [],
  };
}

export function createEmptyProject(lang: Lang): Project {
  return { version: 1, model: emptyModel(lang), answers: emptyAnswers() };
}

// ───────────────────────────── Choix du type par défaut ─────────────────────────────

/** Type de mur par défaut selon ce qu'il y a derrière. */
export function defaultWallId(boundary: Boundary): string {
  if (boundary === 'ground') return DEFAULT_CONSTRUCTION_IDS.wallGround;
  if (boundary === 'unheated') return DEFAULT_CONSTRUCTION_IDS.wallUnheated;
  return DEFAULT_CONSTRUCTION_IDS.wallOutside;
}

/** Type de plancher bas par défaut selon la fermeture basse. */
export function defaultFloorId(kind: BottomKind): string {
  if (kind === 'above-unheated') return DEFAULT_CONSTRUCTION_IDS.floorUnheated;
  if (kind === 'above-outside') return DEFAULT_CONSTRUCTION_IDS.floorOutside;
  return DEFAULT_CONSTRUCTION_IDS.floorGround;
}

/** Condition aux limites d'un plancher bas. */
export function bottomBoundary(kind: BottomKind): Boundary {
  if (kind === 'above-unheated') return 'unheated';
  if (kind === 'above-outside') return 'outside';
  return 'ground';
}

/**
 * Retrouve un type d'élément : celui demandé s'il existe, sinon le type par défaut indiqué,
 * sinon ce type par défaut recréé à la volée (si l'expert l'a supprimé de sa liste). Ne modifie jamais le modèle.
 */
export function resolveConstruction(
  model: BuildingModel,
  constructionId: string | null,
  fallbackId: string,
  lang: Lang,
): Construction {
  if (constructionId !== null) {
    const wanted = model.constructions.find((c) => c.id === constructionId);
    if (wanted) return wanted;
  }
  const fallback = model.constructions.find((c) => c.id === fallbackId);
  if (fallback) return fallback;
  const builtIn = defaultConstructions(lang).find((c) => c.id === fallbackId);
  if (builtIn) return builtIn;
  // `fallbackId` vient toujours de DEFAULT_CONSTRUCTION_IDS : ce repli n'est là que pour le typage.
  return { id: fallbackId, name: fallbackId, category: 'wall', u: null };
}

/** Retrouve un type de fenêtre : celui demandé s'il existe, sinon le type par défaut (recréé au besoin). */
export function resolveWindowType(model: BuildingModel, windowTypeId: string | null, lang: Lang): WindowType {
  if (windowTypeId !== null) {
    const wanted = model.windowTypes.find((w) => w.id === windowTypeId);
    if (wanted) return wanted;
  }
  const fallback = model.windowTypes.find((w) => w.id === DEFAULT_WINDOW_TYPE_ID) ?? model.windowTypes[0];
  return fallback ?? defaultWindowTypes(lang)[0]!;
}
