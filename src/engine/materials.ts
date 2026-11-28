/**
 * Bibliothèque de matériaux et passage d'une composition LUE sur la planche (core/reading `ReadComposition`) à un
 * élément opaque à couches (`Construction`).
 *
 * Une planche donne les matériaux et les épaisseurs, JAMAIS les conductivités. Politique, sans exception :
 *  1. bibliothèque du bureau : λ confirmée par l'utilisateur sur un projet précédent → proposée (from 'user',
 *     confiance 0,8 : la question « matériaux » la rappelle quand même, d'un mot) ;
 *  2. sinon valeur d'USAGE : λ relevée dans un CPE réel établi avec LuxEeB-Tool 6.25 par un expert agréé. C'est une
 *     HYPOTHÈSE (from 'default', confiance 0) à remplacer par la valeur déclarée du produit ; jamais une valeur
 *     réglementaire, jamais présentée comme lue ;
 *  3. sinon rien : λ vide, à choisir dans la base de matériaux de LuxEeB-Tool (la question le met en tête).
 *
 * La bibliothèque d'usage est une donnée modifiable (`withUsageLambda`) ; la bibliothèque du bureau est une structure
 * pure : son stockage (navigateur, fichier) est l'affaire de l'interface.
 */
import { luxeebTypeOfElement, type ConstructionLayer } from '../core/cpe';
import type { ElementType, MaterialKey, ReadComposition, ReadLayer } from '../core/reading';
import type { Construction, ConstructionCategory, Lang, Sourced, WindowType } from '../core/types';
import { proposeFensterTyp, precalculatedU, precalculatedUw } from './uvalue';

export type MaterialFamily = 'insulation' | 'masonry' | 'concrete' | 'screed' | 'render' | 'finish' | 'membrane' | 'wood' | 'air' | 'cladding' | 'excluded' | 'unknown';

export interface MaterialInfo {
  name: { fr: string; de: string };
  family: MaterialFamily;
  /** λ d'usage (W/mK) ; null = aucune valeur proposée, à choisir dans l'outil. */
  lambda: number | null;
}

/** Source affichée d'une λ d'usage. */
export const USAGE_SOURCE = {
  fr: 'Valeur d’usage relevée dans un CPE LuxEeB-Tool d’un expert agréé — hypothèse à remplacer par la valeur déclarée du produit (pas une valeur réglementaire)',
  de: 'Erfahrungswert aus einem LuxEeB-Tool-Pass eines zugelassenen Experten — Annahme, durch den deklarierten Wert des Produkts ersetzen (kein Normwert)',
} as const;

/** Valeurs d'usage par famille de matériau. Modifiable par `withUsageLambda` (le bureau peut corriger une valeur). */
export const MATERIAL_LIBRARY: Readonly<Record<MaterialKey, MaterialInfo>> = {
  'beton-arme': { name: { fr: 'Béton armé', de: 'Stahlbeton' }, family: 'concrete', lambda: 2.1 },
  beton: { name: { fr: 'Béton', de: 'Beton' }, family: 'concrete', lambda: 2.1 },
  'bloc-beton': { name: { fr: 'Bloc béton', de: 'Betonstein' }, family: 'masonry', lambda: 0.484 },
  'beton-maigre': { name: { fr: 'Béton de propreté', de: 'Sauberkeitsschicht' }, family: 'excluded', lambda: null },
  'silico-calcaire': { name: { fr: 'Silico-calcaire', de: 'Kalksandstein' }, family: 'masonry', lambda: null },
  brique: { name: { fr: 'Brique', de: 'Ziegel' }, family: 'masonry', lambda: null },
  bois: { name: { fr: 'Bois', de: 'Holz' }, family: 'wood', lambda: null },
  eps: { name: { fr: 'EPS', de: 'EPS' }, family: 'insulation', lambda: 0.032 },
  xps: { name: { fr: 'XPS', de: 'XPS' }, family: 'insulation', lambda: 0.036 },
  pur: { name: { fr: 'Mousse PU', de: 'PU-Schaum' }, family: 'insulation', lambda: 0.028 },
  pir: { name: { fr: 'Isolant PIR', de: 'PIR-Dämmung' }, family: 'insulation', lambda: 0.022 },
  'laine-minerale': { name: { fr: 'Laine minérale', de: 'Mineralwolle' }, family: 'insulation', lambda: null },
  'fibre-bois': { name: { fr: 'Fibre de bois', de: 'Holzfaser' }, family: 'insulation', lambda: null },
  isolant: { name: { fr: 'Isolant', de: 'Dämmung' }, family: 'insulation', lambda: null },
  chape: { name: { fr: 'Chape', de: 'Estrich' }, family: 'screed', lambda: 1.4 },
  'revetement-sol': { name: { fr: 'Revêtement de sol', de: 'Bodenbelag' }, family: 'finish', lambda: 1.0 },
  'enduit-platre': { name: { fr: 'Enduit plâtre', de: 'Gipsputz' }, family: 'render', lambda: 0.7 },
  'enduit-facade': { name: { fr: 'Enduit de façade', de: 'Außenputz' }, family: 'render', lambda: 0.7 },
  etancheite: { name: { fr: 'Étanchéité', de: 'Abdichtung' }, family: 'membrane', lambda: 0.17 },
  film: { name: { fr: 'Film PE', de: 'PE-Folie' }, family: 'excluded', lambda: null },
  empierrement: { name: { fr: 'Empierrement', de: 'Schotter' }, family: 'excluded', lambda: null },
  'lame-air': { name: { fr: 'Lame d’air', de: 'Luftschicht' }, family: 'air', lambda: null },
  bardage: { name: { fr: 'Bardage', de: 'Verkleidung' }, family: 'cladding', lambda: null },
  inconnu: { name: { fr: 'Matériau inconnu', de: 'Unbekannter Baustoff' }, family: 'unknown', lambda: null },
};

/** Copie de la bibliothèque d'usage avec une λ changée (null = plus de valeur proposée). */
export function withUsageLambda(
  library: Readonly<Record<MaterialKey, MaterialInfo>>,
  key: MaterialKey,
  lambda: number | null,
): Record<MaterialKey, MaterialInfo> {
  return { ...library, [key]: { ...library[key], lambda } };
}

// ───────────────────────────── Bibliothèque du bureau ─────────────────────────────

/** Une λ confirmée par l'utilisateur, réutilisée d'un projet à l'autre. */
export interface OfficeMaterial {
  lambda: number;
  /** Nom saisi dans LuxEeB-Tool (« EPS 032 »), s'il a été donné. */
  name?: string;
  /** Date de confirmation (AAAA-MM-JJ). */
  confirmedAt: string;
}

export interface OfficeLibrary {
  version: 1;
  materials: Partial<Record<MaterialKey, OfficeMaterial>>;
}

export function emptyOfficeLibrary(): OfficeLibrary {
  return { version: 1, materials: {} };
}

/** Bibliothèque du bureau avec une λ confirmée (nouvelle structure ; l'ancienne n'est pas modifiée). */
export function confirmOfficeLambda(office: OfficeLibrary, key: MaterialKey, lambda: number, confirmedAt: string, name?: string): OfficeLibrary {
  if (!(lambda > 0) || !Number.isFinite(lambda)) return office;
  const entry: OfficeMaterial = name ? { lambda, name, confirmedAt } : { lambda, confirmedAt };
  return { version: 1, materials: { ...office.materials, [key]: entry } };
}

/** Relit une bibliothèque du bureau venue du stockage, sans confiance aveugle : les entrées invalides sont ignorées. */
export function sanitizeOfficeLibrary(raw: unknown): OfficeLibrary {
  const out = emptyOfficeLibrary();
  if (typeof raw !== 'object' || raw === null) return out;
  const materials = (raw as { materials?: unknown }).materials;
  if (typeof materials !== 'object' || materials === null) return out;
  for (const key of Object.keys(MATERIAL_LIBRARY) as MaterialKey[]) {
    if (!Object.prototype.hasOwnProperty.call(materials, key)) continue;
    const e = (materials as Record<string, unknown>)[key];
    if (typeof e !== 'object' || e === null) continue;
    const { lambda, confirmedAt, name } = e as { lambda?: unknown; confirmedAt?: unknown; name?: unknown };
    if (typeof lambda !== 'number' || !(lambda > 0) || !Number.isFinite(lambda) || lambda > 10) continue;
    if (typeof confirmedAt !== 'string' || confirmedAt.length > 40) continue;
    const entry: OfficeMaterial = { lambda, confirmedAt };
    if (typeof name === 'string' && name.length > 0 && name.length <= 120) entry.name = name;
    out.materials[key] = entry;
  }
  return out;
}

/** Confirmations à reporter dans la bibliothèque du bureau : les λ des couches confirmées par l'utilisateur. */
export function officeLibraryFromConstructions(office: OfficeLibrary, constructions: readonly Construction[], confirmedAt: string): OfficeLibrary {
  let lib = office;
  for (const c of constructions) {
    for (const l of c.layers ?? []) {
      if (l.material && l.material !== 'inconnu' && l.material !== 'isolant' && l.lambda && l.lambda.from === 'user') {
        lib = confirmOfficeLambda(lib, l.material, l.lambda.value, confirmedAt, l.name);
      }
    }
  }
  return lib;
}

// ───────────────────────────── λ d'une couche ─────────────────────────────

export const OFFICE_CONFIDENCE = 0.8;

/** λ proposée pour une famille : bureau, sinon usage (hypothèse), sinon null. */
export function lambdaFor(
  key: MaterialKey,
  lang: Lang,
  office: OfficeLibrary | null = null,
  library: Readonly<Record<MaterialKey, MaterialInfo>> = MATERIAL_LIBRARY,
): Sourced<number> | null {
  const mine = office?.materials[key];
  if (mine) {
    return { value: mine.lambda, from: 'user', confidence: OFFICE_CONFIDENCE, source: officeNote(lang, mine.confirmedAt) };
  }
  const usage = library[key]?.lambda ?? null;
  if (usage === null) return null;
  return { value: usage, from: 'default', confidence: 0, source: USAGE_SOURCE[lang] };
}

function officeNote(lang: Lang, date: string): string {
  return lang === 'de' ? `Bürobibliothek (bestätigt am ${date})` : `Bibliothèque du bureau (confirmée le ${date})`;
}

// ───────────────────────────── Composition lue → élément ─────────────────────────────

/** Doutes ajoutés par couche (textes courts, dans la langue demandée). */
const LAYER_DOUBT = {
  fr: {
    noLambda: 'aucune λ proposée : à choisir dans la base de LuxEeB-Tool',
    genericInsulation: 'type d’isolant non écrit',
    genericInsulationFallback: 'type d’isolant non écrit : {name} supposé (vu ailleurs dans le projet)',
    concreteWall: '« béton » dans un mur : coulé ou en blocs ?',
    unknown: 'matériau non reconnu',
    noThickness: 'épaisseur non écrite',
  },
  de: {
    noLambda: 'kein λ vorgeschlagen: in der Materialdatenbank von LuxEeB-Tool wählen',
    genericInsulation: 'Dämmstoff nicht angegeben',
    genericInsulationFallback: 'Dämmstoff nicht angegeben: {name} angenommen (anderswo im Projekt)',
    concreteWall: '„Beton“ in einer Wand: Ortbeton oder Steine?',
    unknown: 'Baustoff nicht erkannt',
    noThickness: 'Dicke nicht angegeben',
  },
} as const;

const WALL_ELEMENTS: readonly ElementType[] = ['external-wall', 'wall-to-unheated', 'wall-to-ground', 'party-wall', 'internal-wall'];

/** Catégorie du modèle pour un rôle lu (y compris les parois hors enveloppe, pour pouvoir les montrer). */
export function categoryOfElement(element: ElementType): ConstructionCategory {
  switch (element) {
    case 'roof':
      return 'roof';
    case 'ceiling-to-unheated':
      return 'ceiling';
    case 'floor-on-ground':
    case 'floor-to-unheated':
    case 'floor-to-outside':
    case 'intermediate-floor':
      return 'floor';
    default:
      return 'wall';
  }
}

/** Vrai si la composition décrit une paroi de l'enveloppe thermique (un élément à saisir dans l'outil). */
export function isEnvelopeComposition(rc: Pick<ReadComposition, 'element'>): boolean {
  return luxeebTypeOfElement(rc.element) !== null;
}

export interface CompositionOptions {
  id: string;
  /** Nom de l'élément ; par défaut, celui du type LuxEeB dans la langue demandée. */
  name?: string;
  lang: Lang;
  office?: OfficeLibrary | null;
  library?: Readonly<Record<MaterialKey, MaterialInfo>>;
  /** Isolant typé vu ailleurs dans le projet : sert de repli pour un « isolant » sans type (avec un doute). */
  projectInsulation?: MaterialKey | null;
}

/**
 * Composition lue → élément à couches. Seules les couches comptées (`counted`) sont gardées, de l'intérieur vers
 * l'extérieur comme le contrat de lecture les donne. Chaque couche porte sa λ (bureau, usage ou rien) et ses doutes ;
 * `u` est le pré-calcul quand toutes les λ sont connues.
 */
export function constructionFromComposition(rc: ReadComposition, options: CompositionOptions): Construction {
  const { lang } = options;
  const texts = LAYER_DOUBT[lang];
  const library = options.library ?? MATERIAL_LIBRARY;
  const type = luxeebTypeOfElement(rc.element);
  const category = categoryOfElement(rc.element);
  const isWall = WALL_ELEMENTS.includes(rc.element);
  const layers: ConstructionLayer[] = rc.layers
    .filter((l) => l.counted)
    .map((l) => layerFromRead(l, rc.confidence, isWall, options, library, texts));
  const construction: Construction = {
    id: options.id,
    name: options.name ?? defaultElementName(rc, lang),
    category,
    u: null,
    layers,
    deltaU: 0,
  };
  if (type !== null) construction.luxeebType = type;
  construction.u = type !== null ? precalculatedU(construction) : null;
  return construction;
}

function layerFromRead(
  l: ReadLayer,
  confidence: number,
  isWall: boolean,
  options: CompositionOptions,
  library: Readonly<Record<MaterialKey, MaterialInfo>>,
  texts: (typeof LAYER_DOUBT)[Lang],
): ConstructionLayer {
  const { lang } = options;
  const doubts: string[] = [];
  if (l.doubt) doubts.push(l.doubt);
  let key: MaterialKey = l.material;
  let lambda = lambdaFor(key, lang, options.office ?? null, library);
  if (key === 'isolant') {
    const fallback = options.projectInsulation ?? null;
    if (fallback && fallback !== 'isolant') {
      key = fallback;
      lambda = lambdaFor(fallback, lang, options.office ?? null, library);
      doubts.push(texts.genericInsulationFallback.replace('{name}', library[fallback].name[lang]));
    } else {
      doubts.push(texts.genericInsulation);
    }
  }
  if (key === 'inconnu') doubts.push(texts.unknown);
  else if (lambda === null) doubts.push(texts.noLambda);
  if (key === 'beton' && isWall) doubts.push(texts.concreteWall);
  // Épaisseur absente ou illisible : la couche reste dans l'élément et BLOQUE le pré-calcul (thicknessUnknown).
  // Seule exception : une couche de la famille « exclue » (film…) sans épaisseur, qui ne compte pas (épaisseur 0).
  const excluded = library[key].family === 'excluded';
  const thicknessKnown = l.thicknessCm !== null && Number.isFinite(l.thicknessCm) && l.thicknessCm >= 0;
  if (!thicknessKnown && !excluded) doubts.push(texts.noThickness);
  const layer: ConstructionLayer = {
    name: key === 'inconnu' ? l.label : library[key].name[lang],
    material: key,
    lambda,
    thicknessCm: {
      value: thicknessKnown ? (l.thicknessCm as number) : 0,
      from: 'plan',
      confidence: thicknessKnown ? confidence : 0,
    },
    planText: l.raw,
  };
  if (!thicknessKnown && !excluded) layer.thicknessUnknown = true;
  if (doubts.length > 0) layer.doubt = doubts.join(' ; ');
  return layer;
}

function defaultElementName(rc: ReadComposition, lang: Lang): string {
  const names: Record<ElementType, { fr: string; de: string }> = {
    'external-wall': { fr: 'Façade', de: 'Außenwand' },
    'wall-to-unheated': { fr: 'Mur contre local non chauffé', de: 'Wand zu unbeheizt' },
    'wall-to-ground': { fr: 'Mur contre terre', de: 'Kellerwand' },
    'party-wall': { fr: 'Mur mitoyen', de: 'Gebäudetrennwand' },
    'internal-wall': { fr: 'Mur intérieur', de: 'Innenwand' },
    'floor-on-ground': { fr: 'Dalle sur sol', de: 'Bodenplatte' },
    'floor-to-unheated': { fr: 'Dalle contre local non chauffé', de: 'Decke über unbeheizt' },
    'floor-to-outside': { fr: 'Dalle contre extérieur', de: 'Boden nach Außen' },
    'intermediate-floor': { fr: 'Dalle d’étage', de: 'Geschossdecke (beheizt)' },
    roof: { fr: 'Toiture', de: 'Dach' },
    'ceiling-to-unheated': { fr: 'Plancher sous comble', de: 'Decke zum Dachraum' },
    unknown: { fr: 'Paroi', de: 'Bauteil' },
  };
  return names[rc.element][lang];
}

/** Isolant typé le plus fréquent dans les compositions lues (repli pour un « isolant » sans type), ou null. */
export function dominantInsulation(compositions: readonly ReadComposition[]): MaterialKey | null {
  const count = new Map<MaterialKey, number>();
  for (const rc of compositions) {
    for (const l of rc.layers) {
      if (l.counted && l.material !== 'isolant' && MATERIAL_LIBRARY[l.material].family === 'insulation') {
        count.set(l.material, (count.get(l.material) ?? 0) + (l.thicknessCm ?? 0));
      }
    }
  }
  let best: MaterialKey | null = null;
  let bestN = 0;
  for (const [k, n] of count) if (n > bestN) [best, bestN] = [k, n];
  return best;
}

/** Couches douteuses d'un ensemble d'éléments : pour la question regroupée « matériaux ». */
export function doubtfulLayers(constructions: readonly Construction[]): { constructionId: string; index: number; layer: ConstructionLayer }[] {
  const out: { constructionId: string; index: number; layer: ConstructionLayer }[] = [];
  for (const c of constructions) {
    (c.layers ?? []).forEach((layer, index) => {
      if (layer.doubt || layer.lambda === null) out.push({ constructionId: c.id, index, layer });
    });
  }
  return out;
}

// ───────────────────────────── Menuiseries : valeurs d'usage ─────────────────────────────

/**
 * Menuiseries d'une maison neuve telles qu'un expert agréé les a saisies dans un CPE LuxEeB-Tool 6.25 (triple
 * vitrage). HYPOTHÈSE à remplacer par les valeurs déclarées des menuiseries ; le plan n'en dit rien.
 */
export const WINDOW_USAGE = { ug: 0.5, uf: 1.0, psiG: 0.035, g: 0.5, frameWidth: 0.112, doorU: 1.3 } as const;

export const WINDOW_USAGE_SOURCE = {
  fr: 'Valeur d’usage (triple vitrage neuf) relevée dans un CPE LuxEeB-Tool — hypothèse à remplacer par les valeurs déclarées des menuiseries',
  de: 'Erfahrungswert (neue Dreifachverglasung) aus einem LuxEeB-Tool-Pass — Annahme, durch die deklarierten Werte der Fenster ersetzen',
} as const;

function usage(value: number, lang: Lang): Sourced<number> {
  return { value, from: 'default', confidence: 0, source: WINDOW_USAGE_SOURCE[lang] };
}

/**
 * Type de fenêtre proposé pour des dimensions données : géométrie de la feuille des fenêtres, einfach / mehrfach
 * d'après la largeur, Ug / Uf / Ψg / g / cadre d'usage (hypothèses), Uw pré-calculé.
 */
export function windowTypeHypothesis(id: string, name: string, width: number, height: number, lang: Lang): WindowType {
  const typ = proposeFensterTyp(width);
  const type: WindowType = {
    id,
    name,
    uw: null,
    g: usage(WINDOW_USAGE.g, lang),
    geometry: { width, height, frameWidth: usage(WINDOW_USAGE.frameWidth, lang), fensterTyp: typ.fensterTyp, panes: typ.panes },
    ug: usage(WINDOW_USAGE.ug, lang),
    uf: usage(WINDOW_USAGE.uf, lang),
    psiG: usage(WINDOW_USAGE.psiG, lang),
  };
  const uw = precalculatedUw(type);
  if (uw) {
    const { detail: _detail, ...value } = uw;
    type.uw = value;
  }
  return type;
}

/** Porte saisie par sa valeur propre, U d'usage (hypothèse). */
export function doorHypothesis(id: string, name: string, toUnheated: boolean, lang: Lang): Construction {
  return {
    id,
    name,
    category: 'door',
    u: usage(WINDOW_USAGE.doorU, lang),
    luxeebType: toUnheated ? 'tuer-unbeheizt' : 'aussentuer',
    ownValue: true,
  };
}
