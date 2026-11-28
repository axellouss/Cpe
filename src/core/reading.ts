/**
 * Lecture d'une PLANCHE — contrat entre les lecteurs (qui la remplissent), le moteur (qui en tire le bâtiment et
 * les questions de doute) et l'interface (qui montre ce qui a été lu, et d'où).
 *
 * Une planche d'autorisation porte plusieurs VUES (plans d'étage, plan de toiture, coupes, façades, tableau de
 * surfaces, cartouche) et beaucoup de texte utile au CPE : surfaces des pièces, niveaux, compositions des parois,
 * cotes de baies, équipements. Tout ce qui est lu porte sa CONFIANCE et sa PREUVE (où, par quel signal) : c'est ce
 * qui permet de ne poser que les questions où il y a un doute.
 *
 * Confiance (0..1), même lecture partout :
 *   ≥ 0,85  lu et recoupé par deux signaux indépendants → pas de question
 *   ≥ 0,65  lu, une seule source → pas de question si l'effet est faible
 *   < 0,65  à confirmer → question
 *   0       hypothèse de l'outil (rien sur la planche) → toujours montrée comme telle
 *
 * Unités : les positions sont en unités de feuille (points PDF, y vers le bas), les grandeurs physiques en mètres,
 * m² ou cm selon leur nom. Les angles suivent core/types.ts (azimut : 0 = nord, sens horaire).
 */
import type { BBox, BuildingType, HeatGenerator, HotWater, Occasion, Vec2, Ventilation } from './types';

// ───────────────────────────── Preuve et confiance ─────────────────────────────

/** D'où vient une valeur lue. `source` est un code court et stable (« stated-area », « zone-fill », « title-block »…). */
export interface Evidence {
  source: string;
  /** Précision affichable (« 8,00 lu sur la chaîne de cotes »). */
  detail?: string;
  /** Page (à partir de 1) et endroit de la planche, pour « montrer où ». */
  page?: number;
  box?: BBox;
}

export interface Read<T> {
  value: T;
  confidence: number;
  evidence: Evidence[];
  /** Raison du doute, courte, dans la langue de lecture ; absente ou null quand il n'y en a pas. */
  doubt?: string | null;
}

export const CONFIDENCE_CROSS_CHECKED = 0.85;
export const CONFIDENCE_SINGLE_SOURCE = 0.65;

// ───────────────────────────── Vues de la planche ─────────────────────────────

export type ViewKind =
  | 'floor-plan'
  | 'roof-plan'
  | 'section'
  | 'elevation'
  | 'site-plan'
  | 'table'
  | 'title-block'
  | 'photo'
  | 'legend'
  | 'north-arrow'
  | 'other';

/** Côté d'une façade tel que la planche le nomme (« avant », « Ansicht Nord »…). */
export type ElevationSide = 'front' | 'back' | 'side' | 'left' | 'right' | 'north' | 'south' | 'east' | 'west';

export interface ReadView {
  /** Identifiant stable : `p{page}-{kind}{k}`. */
  id: string;
  /** Page, à partir de 1. */
  page: number;
  kind: ViewKind;
  /** Titre écrit sur la planche, recollé (« PLAN 1ER ÉTAGE ») ; null si la vue n'en a pas. */
  title: string | null;
  titleBox: BBox | null;
  /** Rang du niveau pour un plan d'étage : −1 sous-sol, 0 rez-de-chaussée, 1 premier étage… */
  storeyRank: number | null;
  sides: ElevationSide[] | null;
  /** Étendue de la vue sur la page (uf). */
  box: BBox;
  /** Étendue du BÂTIMENT dans la vue, quand la vue montre aussi la parcelle, la rue… */
  buildingBox: BBox | null;
  /** Feuille (PlanSheet.id) produite pour cette vue ; null pour les vues qui ne deviennent pas des feuilles. */
  sheetId: string | null;
  confidence: number;
  /** Signaux qui ont servi (« title », « clip-frame », « content-rooms »…). */
  sources: string[];
  doubts: string[];
}

// ───────────────────────────── Compositions de parois ─────────────────────────────

/** Rôle thermique d'une paroi décrite par une annotation « Composition … ». */
export type ElementType =
  | 'external-wall'
  | 'wall-to-unheated'
  | 'wall-to-ground'
  | 'party-wall'
  | 'internal-wall'
  | 'floor-on-ground'
  | 'floor-to-unheated'
  | 'floor-to-outside'
  | 'intermediate-floor'
  | 'roof'
  | 'ceiling-to-unheated'
  | 'unknown';

/** Famille de matériau reconnue dans le libellé d'une couche. La conductivité n'est PAS lue : voir engine/materials. */
export type MaterialKey =
  | 'beton-arme'
  | 'beton'
  | 'bloc-beton'
  | 'beton-maigre'
  | 'silico-calcaire'
  | 'brique'
  | 'bois'
  | 'eps'
  | 'xps'
  | 'pur'
  | 'pir'
  | 'laine-minerale'
  | 'fibre-bois'
  | 'isolant'
  | 'chape'
  | 'revetement-sol'
  | 'enduit-platre'
  | 'enduit-facade'
  | 'etancheite'
  | 'film'
  | 'empierrement'
  | 'lame-air'
  | 'bardage'
  | 'inconnu';

export interface ReadLayer {
  /** Texte d'origine (« 20cm Isolation type EPS »). */
  raw: string;
  /** Libellé sans l'épaisseur (« Isolation type EPS »). */
  label: string;
  material: MaterialKey;
  /** Épaisseur en cm ; null quand la ligne n'en donne pas (film, membrane). */
  thicknessCm: number | null;
  /** Faux pour une couche hors calcul thermique (film, béton de propreté, empierrement sous le dernier isolant). */
  counted: boolean;
  /** Raison d'un doute sur cette couche (couche mixte, isolant sans type, « béton » sans précision…). */
  doubt?: string | null;
}

export interface ReadComposition {
  id: string;
  element: ElementType;
  /** Couches de l'INTÉRIEUR vers l'extérieur (plancher : du haut vers le bas ; toiture : du bas vers le haut). */
  layers: ReadLayer[];
  /** Où le bloc apparaît (un même bloc est souvent répété sur plusieurs vues). */
  occurrences: { viewId: string | null; header: string; page?: number; box?: BBox }[];
  confidence: number;
  doubt?: string | null;
}

// ───────────────────────────── Niveaux et hauteurs ─────────────────────────────

export type LevelRole =
  | 'finished-floor'
  | 'structure'
  | 'top'
  | 'ridge'
  | 'eaves'
  | 'terrain'
  | 'excavation'
  | 'reference'
  | 'regulatory'
  | 'unknown';

export interface ReadLevelMark {
  /** Cote relative (m), p. ex. +3,145 ; null si seule l'altitude est écrite. */
  rel: number | null;
  /** Altitude (m), p. ex. 252,69 ; null si absente. */
  abs: number | null;
  raw: string;
  label: string | null;
  role: LevelRole;
  viewId: string | null;
  page: number;
  at: Vec2;
}

export interface ReadLevels {
  /** Altitude du ±0,00, si la planche la donne. */
  referenceAbs: number | null;
  /** Niveaux finis des étages, du plus bas au plus haut. */
  floors: { rel: number; abs: number | null; label: string | null; viewIds: string[]; confidence: number }[];
  /** Hauteurs d'étage de niveau fini à niveau fini : storeyHeights[i] = floors[i+1].rel − floors[i].rel. */
  storeyHeights: number[];
  /** Sommet du volume : acrotère (toiture plate) ou faîtage. */
  top: { rel: number; role: 'top' | 'ridge'; confidence: number } | null;
  /** Égout de toiture (toiture inclinée), si coté. */
  eaves: number | null;
  /** Hauteurs libres écrites (« HSP 2,50 »). */
  clearHeights: number[];
  marks: ReadLevelMark[];
  /** Recoupements « relatif + référence = altitude ». */
  checks: { checked: number; failed: number };
}

// ───────────────────────────── Cartouche, tableau, équipements, nord ─────────────────────────────

export interface ReadTitleBlock {
  /** Objet du projet tel qu'écrit (« Construction d'une maison unifamiliale »). */
  project: string | null;
  phase: string | null;
  buildingType: Read<BuildingType> | null;
  dwellings: Read<number> | null;
  occasion: Read<Occasion> | null;
  street: string | null;
  postcode: string | null;
  locality: string | null;
  /** Date du plan telle qu'écrite, et son année. */
  date: string | null;
  year: number | null;
  index: string | null;
  scaleDen: number | null;
  format: string | null;
  page: number | null;
  box: BBox | null;
  confidence: number;
}

export interface ReadAreaLine {
  value: number;
  max?: number;
}

/** Tableau « calcul des surfaces » d'une planche d'autorisation (m²). */
export interface ReadSiteAreas {
  terrain?: ReadAreaLine;
  sealed?: ReadAreaLine;
  footprint?: ReadAreaLine;
  grossFloor?: ReadAreaLine;
  page?: number;
  box?: BBox;
}

export type EquipmentKind =
  | 'heat-pump'
  | 'hot-water-tank'
  | 'ventilation-unit'
  | 'boiler'
  | 'gas'
  | 'oil'
  | 'pellets'
  | 'stove'
  | 'district-heating'
  | 'solar-thermal'
  | 'photovoltaic'
  | 'cistern'
  | 'other';

export interface ReadEquipment {
  kind: EquipmentKind;
  raw: string;
  viewId: string | null;
  /** Dessiné hors du bâtiment (unité extérieure de pompe à chaleur) ; null si inconnu. */
  outside: boolean | null;
  page: number;
  at: Vec2;
}

/** Installations PROPOSÉES d'après les équipements écrits : toujours à confirmer. */
export interface ReadSystems {
  heatGenerator: Read<HeatGenerator> | null;
  hotWater: Read<HotWater> | null;
  ventilation: Read<Ventilation> | null;
  photovoltaic: Read<boolean> | null;
  solarThermal: Read<boolean> | null;
}

export interface ReadNorth {
  /** Azimut vers lequel regarde le HAUT de la feuille (0 = nord en haut, 90 = le haut regarde l'est). */
  sheetUpAzimuth: number;
  /** Écart jusqu'à la limite de secteur la plus proche (LuxEeB-Tool distingue 8 secteurs de 45°). */
  marginDeg: number;
  confidence: number;
  evidence: Evidence[];
  page: number;
  box: BBox | null;
}

// ───────────────────────────── Baies écrites, éclairement, façades ─────────────────────────────

/** Cote de baie à deux nombres superposés sur une chaîne de cotes : largeur au-dessus, hauteur dessous. */
export interface ReadOpeningPair {
  width: number;
  height: number;
  /** Allège écrite à proximité (« ALL. 0,90 »), en m. */
  sill: number | null;
  viewId: string | null;
  page: number;
  at: Vec2;
}

/** Encadré d'éclairement naturel d'une pièce de vie (« Surface vitrée : 13,54 m² »). */
export interface ReadGlazingBox {
  viewId: string | null;
  room: string | null;
  glazedArea: number | null;
  floorArea: number | null;
  required: number | null;
  page: number;
  at: Vec2;
}

export interface ReadElevationBay {
  /** Rectangle de la baie dans la vue (uf). */
  box: BBox;
  widthM: number;
  heightM: number;
  kind: 'window' | 'door' | 'wide-door';
  /** Nombre de vantaux ou de vitres dessinés. */
  parts: number;
}

export interface ReadElevation {
  viewId: string;
  sides: ElevationSide[] | null;
  /** Dimensions hors tout de la façade dessinée (m). */
  widthM: number | null;
  heightM: number | null;
  bays: ReadElevationBay[];
  /**
   * Côté du plan auquel cette façade correspond : azimut de la normale extérieure dans le repère de la FEUILLE,
   * en degrés depuis le haut de la feuille, sens horaire (0 = côté haut du plan, 90 = côté droit, 180 = bas, 270 = gauche).
   */
  planSideDeg: Read<number> | null;
}

// ───────────────────────────── Toiture ─────────────────────────────

export interface ReadRoof {
  /** Feuille du plan de toiture, s'il y en a une. */
  sheetId: string | null;
  /** Contour extérieur de la toiture (uf de sa feuille). */
  outline: Vec2[] | null;
  widthM: number | null;
  depthM: number | null;
  areaM2: number | null;
  /** Toiture plate ? (acrotère coté, pas de faîtage, mention « toiture plate »…). */
  flat: Read<boolean> | null;
  /** Pente lue (degrés), toiture inclinée. */
  pitchDeg: Read<number> | null;
}

// ───────────────────────────── Lecture complète ─────────────────────────────

/** Tout ce qui a été lu sur un document, en plus des feuilles (PlanSheet) et de leur détection. */
export interface SheetReading {
  views: ReadView[];
  titleBlock: ReadTitleBlock | null;
  siteAreas: ReadSiteAreas | null;
  levels: ReadLevels | null;
  compositions: ReadComposition[];
  north: ReadNorth | null;
  equipment: ReadEquipment[];
  systems: ReadSystems | null;
  openingPairs: ReadOpeningPair[];
  glazing: ReadGlazingBox[];
  elevations: ReadElevation[];
  roof: ReadRoof | null;
  /**
   * Translations qui amènent chaque feuille de plan dans un repère commun au bâtiment (uf) : les étages deviennent
   * superposables (plancher au-dessus d'un local non chauffé, encorbellement). Vide si l'alignement n'est pas sûr.
   */
  alignment: { sheetId: string; dx: number; dy: number; confidence: number }[];
  /** Journal de lecture, pour le diagnostic (jamais montré tel quel). */
  log: string[];
}

export function emptyReading(): SheetReading {
  return {
    views: [],
    titleBlock: null,
    siteAreas: null,
    levels: null,
    compositions: [],
    north: null,
    equipment: [],
    systems: null,
    openingPairs: [],
    glazing: [],
    elevations: [],
    roof: null,
    alignment: [],
    log: [],
  };
}
