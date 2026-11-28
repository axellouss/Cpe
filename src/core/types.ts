/**
 * Plan2CPE — modèle de données partagé (contrat entre lecteurs de plans, éditeur, moteur et export).
 *
 * Conventions valables PARTOUT dans le code :
 *  - Repère plan : x vers la droite, y vers le BAS (comme l'écran). Les lecteurs CAO/IFC inversent y à l'import.
 *  - « Unité de feuille » (uf) : unité brute du plan (mm, cm, pt PDF, pixel…). `metresPerUnit` convertit en mètres.
 *  - Angles en degrés. Azimut : 0 = Nord, 90 = Est, sens horaire.
 *  - `northAngle` = azimut vers lequel pointe le HAUT de la feuille (0 si le nord est en haut).
 *  - Dimensions thermiques selon le règlement luxembourgeois (RGD 2021, annexe I, ch. 5.1) :
 *      · enveloppe A et volume Ve  → dimensions EXTÉRIEURES (brutes)
 *      · surface de référence An   → surface NETTE des locaux conditionnés (hauteur libre > 1,0 m)
 *      · fenêtres                  → dimensions brutes du gros œuvre (« Rohbaumaß »)
 *  - L'outil est un ASSISTANT : chaque valeur porte sa provenance et l'expert reste responsable du CPE.
 */

import type { Airtightness, Attachment, ConstructionLayer, FacadeView, GroundData, LuxeebElementType, ThermalBridges, WindowGeometry } from './cpe';
import type { SheetReading } from './reading';

// ───────────────────────────── Bases ─────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Les 8 secteurs de LuxEeB-Tool + horizontal. */
export type Orientation = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
export type OrientationOrHorizontal = Orientation | 'H';

export const ORIENTATIONS: readonly Orientation[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export type Lang = 'fr' | 'de';

/**
 * D'où vient une valeur.
 *  - plan     : lue/mesurée sur le plan (géométrie, cote, étiquette)
 *  - calc     : calculée à partir d'autres valeurs
 *  - default  : valeur par défaut de l'outil — À CONFIRMER par l'expert
 *  - estimate : estimation grossière — À REMPLACER
 *  - user     : saisie ou confirmée par l'expert
 */
export type Provenance = 'plan' | 'calc' | 'default' | 'estimate' | 'user';

export interface Sourced<T> {
  value: T;
  from: Provenance;
  /** Courte explication affichable (« Échelle 1:100 lue dans le cartouche »). */
  note?: string;
  /**
   * Confiance 0..1 (même lecture que core/reading.ts : ≥ 0,85 recoupé, ≥ 0,65 une source, 0 = hypothèse de l'outil).
   * Absente = non mesurée (projets enregistrés avant la version 2 du fichier, saisies de l'expert).
   */
  confidence?: number;
  /** Raison du doute, courte ; absente ou null quand il n'y en a pas. */
  doubt?: string | null;
  /**
   * Source citée, surtout pour une HYPOTHÈSE (`from: 'default'`) : « valeur d'usage, à remplacer par la valeur
   * déclarée du produit ». Jamais une valeur réglementaire inventée.
   */
  source?: string;
}

// ───────────────────────────── Plans lus ─────────────────────────────

export type SourceKind = 'ifc' | 'dwg' | 'dxf' | 'pdf' | 'image' | 'manual';

export interface PlanText {
  text: string;
  /** Point d'ancrage (uf). */
  x: number;
  y: number;
  /** Hauteur du texte (uf), si connue. */
  height?: number;
}

export interface DetectedRoom {
  name: string;
  /** Surface écrite sur le plan (m²), si une étiquette en donne une. */
  statedArea?: number;
  /** Surface mesurée du polygone (m²), si un contour fermé a été trouvé et l'échelle connue. */
  measuredArea?: number;
  /** Contour intérieur de la pièce (uf). */
  polygon?: Vec2[];
  /** Position de l'étiquette (uf). */
  at?: Vec2;
  /** Proposition : pièce comptée dans An ? 'ask' = ambigu (cave, buanderie, grenier…). */
  heatedGuess: 'yes' | 'no' | 'ask';
  /** Confiance de l'appariement étiquette ↔ polygone et de la surface (0..1), si le lecteur la mesure. */
  confidence?: number;
  /** Surface vitrée écrite pour cette pièce (encadré d'éclairement naturel), en m². */
  glazedArea?: number;
  /** Pièce extérieure au bâtiment (terrasse, balcon) : jamais comptée, jamais dans le contour. */
  exterior?: boolean;
}

export interface DetectedOpening {
  kind: 'window' | 'door' | 'unknown';
  /** Extrémités de l'ouverture sur le mur (uf). */
  a: Vec2;
  b: Vec2;
  /** Largeur (m) si l'échelle est connue. */
  width?: number;
  /** Hauteur (m) si connue (IFC, attribut de bloc, nom de bloc « 1,40x1,35 »). */
  height?: number;
  /** Vrai si l'ouverture donne sur l'extérieur du contour détecté. */
  exterior?: boolean;
  /** Hauteur d'allège (m), si elle est écrite (« ALL. 0,90 »). */
  sill?: number;
  /** D'où vient la hauteur : cote à deux nombres du plan, façade dessinée, ou valeur d'usage. */
  heightFrom?: 'plan-dim' | 'elevation' | 'default';
  /** Hauteur écrite sur le plan (cote à deux nombres), quand elle existe, même si une autre a été retenue (m). */
  heightPlan?: number;
  /** Hauteur de la baie mesurée sur la façade dessinée, quand elle a été retrouvée (m). */
  heightElevation?: number;
  /** Précision sur le genre d'ouverture, quand le lecteur la connaît. */
  detail?: 'entrance-door' | 'garage-door' | 'door-to-unheated' | 'french-window';
  /** Vrai si l'ouverture sépare le volume chauffé d'un local non chauffé (porte vers le garage). */
  toUnheated?: boolean;
  /** Confiance (0..1) sur l'existence et les dimensions de l'ouverture. */
  confidence?: number;
}

/** Ce qu'il y a de l'autre côté d'une arête du contour chauffé proposé par le lecteur. */
export interface DetectedEdge {
  /** 'outside' façade ; 'unheated' vers un local non chauffé ; 'heated' mur mitoyen (voisin chauffé). */
  boundary: 'outside' | 'unheated' | 'heated';
  confidence: number;
  /** Signaux utilisés (« insulation », « room-name », « foreign-masonry », « no-opening »…). */
  sources?: string[];
}

export interface SheetDetection {
  /**
   * Contour extérieur brut (uf, polygone simple) : l'EMPRISE de tout le bâtiment dessiné, annexes comprises.
   * C'est le moteur (`createStorey`) qui en retire les locaux hors enveloppe pour proposer le contour chauffé.
   */
  outline?: Vec2[];
  /**
   * Contour CHAUFFÉ proposé par le lecteur quand il sait le lire lui-même (trait d'isolant, locaux non chauffés
   * nommés). S'il est présent, le moteur le prend tel quel au lieu de le déduire de `outline` et des pièces.
   */
  heatedOutline?: Vec2[];
  /** Nature de chaque arête de `heatedOutline` (même longueur : arête i = sommet i → sommet i+1). */
  heatedEdges?: DetectedEdge[];
  /** Locaux non chauffés compris dans l'emprise (garage, cave…), avec leur contour. */
  unheatedZones?: { polygon: Vec2[]; names: string[]; area?: number }[];
  /** Surfaces du volume chauffé qu'aucune étiquette de pièce ne couvre (escalier, dégagement), en m². */
  unlabelledAreas?: { polygon?: Vec2[]; area: number }[];
  /** Dimensions hors tout du bâtiment sur cette vue (m), recoupées avec les cotes écrites. */
  footprintSize?: { width: number; depth: number; confidence: number };
  /** Confiance globale du contour (0..1), si le lecteur la mesure. */
  outlineConfidence?: number;
  rooms: DetectedRoom[];
  openings: DetectedOpening[];
  /** Hauteur d'étage brute (m) si lisible (IFC, coupe). Dernier niveau : jusqu'au plus haut sommet de mur (faîtage). */
  storeyHeight?: number;
  /**
   * Dernier niveau dont les murs ont des hauteurs inégales (toiture inclinée probable) : hauteur du plus bas
   * sommet de mur (m), c'est-à-dire la jambette. `storeyHeight` est alors la hauteur au faîtage, pas une hauteur d'étage.
   */
  eavesHeight?: number;
  /**
   * Vrai si `storeyHeight` est mesurée jusqu'au sommet des MURS du dernier niveau, sans la toiture au-dessus
   * (dalle, complexe de toiture) : ce n'est pas encore une hauteur « de dalle à dalle », l'expert doit la confirmer.
   */
  storeyHeightToWallTop?: boolean;
  /** Hauteur libre (m) si lisible. */
  clearHeight?: number;
  /** Altitude du niveau (m) si lisible. */
  elevation?: number;
  /**
   * Fenêtres de toit vues par le lecteur (maquette) : elles ne sont portées par aucune façade du contour et ne
   * figurent donc pas dans `openings`. Dimensions hors tout (m).
   */
  roofWindows?: { width: number; height: number }[];
  /** Remarques du lecteur : texte libre court, dans la langue demandée à la lecture. */
  notes: string[];
}

/** Une feuille = une vue en plan exploitable (page PDF, espace objet DWG, étage IFC, image). */
export interface PlanSheet {
  id: string;
  name: string;
  /**
   * Rôle de la vue sur la planche. Absent = plan d'étage (lecteurs qui ne produisent que des plans). Seuls
   * 'floor-plan' (et 'roof-plan' pour la toiture) servent à tracer des étages.
   */
  role?: 'floor-plan' | 'roof-plan' | 'section' | 'elevation' | 'site-plan';
  /** Rang du niveau lu dans le titre de la vue (−1 sous-sol, 0 rez-de-chaussée, 1 étage…). */
  storeyRank?: number | null;
  /** Page du document (à partir de 1). */
  page?: number;
  /** Étendue du contenu (uf). */
  bbox: BBox;
  /** Fond matriciel (page PDF rendue, scan). Couvre le rectangle indiqué (uf). */
  image?: { url: string; x: number; y: number; width: number; height: number };
  /**
   * Traits vectoriels pour l'affichage et l'accrochage : [x1, y1, x2, y2, …] (uf).
   * Les arcs et courbes sont discrétisés par le lecteur.
   */
  segments?: Float32Array;
  texts?: PlanText[];
  /** Échelle : mètres par unité de feuille. null = inconnue → l'utilisateur doit « poser la règle ». */
  metresPerUnit: Sourced<number> | null;
  detected: SheetDetection;
}

export interface PlanDocument {
  fileName: string;
  kind: SourceKind;
  sheets: PlanSheet[];
  /** Azimut du haut de la feuille, si le fichier le donne de façon crédible (IFC TrueNorth non par défaut, flèche nord). */
  northAngle?: Sourced<number>;
  /** Vrai si toutes les feuilles partagent le même repère (IFC) : les étages sont superposables tels quels. */
  storeysAligned: boolean;
  /** Messages du lecteur destinés à l'utilisateur (français, courts). */
  warnings: string[];
  /** Tout ce qui a été lu en plus des feuilles : vues, cartouche, niveaux, compositions, nord… (voir core/reading.ts). */
  reading?: SheetReading;
}

// ───────────────────────────── Bâtiment confirmé par l'expert ─────────────────────────────

/** Ce qu'il y a de l'autre côté d'une paroi. */
export type Boundary =
  | 'outside' // air extérieur
  | 'ground' // terre
  | 'unheated' // local non chauffé (garage, cave, grenier, cage d'escalier froide)
  | 'heated'; // bâtiment/local voisin chauffé (mitoyen) → pas de déperdition, hors tableau d'enveloppe

export type ConstructionCategory =
  | 'wall' // mur (extérieur, contre terre, contre non chauffé)
  | 'roof' // toiture (plate ou inclinée) contre extérieur
  | 'ceiling' // plancher haut vers grenier non chauffé
  | 'floor' // plancher bas (terre-plein, sur cave non chauffée, sur extérieur)
  | 'door'; // porte opaque

/** Type d'élément opaque (LuxEeB-Tool : « opake Bauteile », 20 emplacements au maximum). */
export interface Construction {
  id: string;
  name: string;
  category: ConstructionCategory;
  /** Valeur U (W/m²K) si l'expert la connaît déjà ; sinon null → à définir dans LuxEeB-Tool. */
  u: Sourced<number> | null;
  /** Type d'élément de LuxEeB-Tool ; absent = déduit de la catégorie et du milieu (core/cpe `luxeebTypeOf`). */
  luxeebType?: LuxeebElementType;
  /** Couches de l'INTÉRIEUR vers l'extérieur (10 au plus dans l'outil). Présentes → `u` est un pré-calcul. */
  layers?: ConstructionLayer[];
  /** Supplément ΔU (W/m²K) de la feuille des valeurs U ; absent = 0. */
  deltaU?: number;
  /** Données des éléments contre terre (A, P, profondeur) : l'outil en tire B' et Fx. */
  ground?: GroundData;
  /** Élément saisi par sa valeur propre (« Eigene Angaben ») : porte, élément non calculé par couches. */
  ownValue?: boolean;
}

/** Type de fenêtre (LuxEeB-Tool : « transparente Bauteile »). */
export interface WindowType {
  id: string;
  name: string;
  uw: Sourced<number> | null;
  g: Sourced<number> | null;
  /** Géométrie de la feuille des fenêtres (dimensions brutes, cadre, einfach / mehrfach, vitrages). */
  geometry?: WindowGeometry;
  /** U du vitrage, U du cadre (W/m²K) et Ψ de l'intercalaire (W/mK) : avec `geometry`, `uw` en est le pré-calcul. */
  ug?: Sourced<number> | null;
  uf?: Sourced<number> | null;
  psiG?: Sourced<number> | null;
}

export interface StoreyEdge {
  boundary: Boundary;
  /** Type de mur ; null = type par défaut de la catégorie. */
  constructionId: string | null;
}

export interface Opening {
  id: string;
  /** Indice de l'arête du contour qui porte l'ouverture (arête i : outline[i] → outline[i+1]). */
  edgeIndex: number;
  kind: 'window' | 'door';
  /** Dimensions brutes du gros œuvre (m). */
  width: number;
  height: number;
  /**
   * Largeur mesurée sur le dessin, en unités de feuille, quand elle n'a pas été lue dans un texte : si l'échelle
   * est corrigée, `width` la suit (tant que l'expert ne l'a pas saisie lui-même). Absent pour une largeur lue
   * dans un nom de bloc, une étiquette ou une maquette, qui ne dépend pas de l'échelle.
   */
  sheetWidth?: number;
  count: number;
  /** Position du centre le long de l'arête, 0..1 (affichage uniquement). */
  position: number;
  /** Type de fenêtre (kind = 'window') ; null = type par défaut. */
  windowTypeId: string | null;
  from: Provenance;
  /**
   * Type de porte (kind = 'door') : porte d'entrée ou porte vers un local non chauffé ; absent ou null = type de
   * porte par défaut.
   */
  constructionId?: string | null;
  /** Hauteur d'allège lue (m), quand le plan l'écrit (« ALL. 0,90 »). */
  sill?: number;
}

export interface Room {
  id: string;
  name: string;
  /** Surface nette (m²). */
  area: Sourced<number>;
  /** Comptée dans An ? */
  heated: boolean;
  /** Vrai tant que l'expert n'a pas tranché une pièce ambiguë. */
  needsReview: boolean;
  /**
   * Surface MESURÉE sur le dessin, en unités de feuille au carré, quand `area` en vient (et non d'une surface écrite
   * sur le plan) : si l'échelle est corrigée, `area` la suit tant que l'expert ne l'a pas saisie lui-même.
   */
  sheetArea?: number;
  polygon?: Vec2[];
  at?: Vec2;
  /**
   * Surface du volume chauffé qu'aucune étiquette ne couvre (escalier, dégagement), mesurée par le lecteur : elle
   * n'est comptée dans An que si l'utilisateur le dit (question « an-unlabelled »).
   */
  unlabelled?: boolean;
}

export interface Storey {
  id: string;
  name: string;
  /** Feuille sur laquelle le contour a été tracé (null = saisie sans plan). */
  sheetId: string | null;
  /** Contour extérieur BRUT de la zone chauffée, en unités de feuille. Polygone simple, sens quelconque. */
  outline: Vec2[];
  /** Même longueur que `outline`. */
  edges: StoreyEdge[];
  /** Échelle appliquée au contour (m par uf). */
  metresPerUnit: Sourced<number>;
  /** Hauteur d'étage brute, de dessus de dalle à dessus de dalle (m) — pour A et Ve. */
  grossHeight: Sourced<number>;
  /** Hauteur libre sous plafond (m) — pour Vn. */
  clearHeight: Sourced<number>;
  openings: Opening[];
  rooms: Room[];
  /** Surface nette chauffée de l'étage saisie directement (m²). Prioritaire sur la somme des pièces. */
  netAreaOverride: Sourced<number> | null;
  /**
   * Fenêtres de toit vues dans le fichier mais absentes du relevé (aucune façade ne les porte) : le moteur les
   * rappelle tant que l'expert ne les a pas ajoutées en lignes manuelles. Dimensions hors tout (m).
   */
  roofWindows?: { width: number; height: number }[];
  /**
   * Translation (uf) qui amène le contour dans le repère commun du bâtiment, quand les étages sont dessinés côte à
   * côte sur une même planche : les contours deviennent superposables (plancher au-dessus d'un local non chauffé).
   * Le contour lui-même reste dans le repère de sa feuille (affichage). Absente = repère de la feuille.
   */
  offset?: { dx: number; dy: number; confidence: number };
  /**
   * Emprise lue de tout le bâtiment sur la feuille (annexes comprises) et baies de la partie laissée hors du contour
   * chauffé (porte de garage) : de quoi remettre l'annexe dans l'enveloppe si l'utilisateur la dit chauffée.
   */
  footprint?: { outline: Vec2[]; openings: { kind: 'window' | 'door'; a: Vec2; b: Vec2; width: number; height: number }[] };
  /**
   * Surface (m²) du plancher de cet étage au-dessus d'un local non chauffé, mesurée par le lecteur une fois les plans
   * alignés (SheetReading.floorOverUnheated). Présente, elle remplace la différence de contours du moteur.
   */
  floorOverUnheated?: Sourced<number>;
}

/** Fermeture haute du dernier étage chauffé. */
export type TopKind =
  | 'flat-roof' // toiture plate
  | 'pitched-roof' // toiture inclinée, combles CHAUFFÉS : le dernier étage est sous les rampants
  | 'attic-ceiling'; // plancher haut vers grenier NON chauffé

export type RoofShape = 'gable' | 'hip' | 'mono';

export interface TopClosure {
  kind: TopKind;
  /** Pente en degrés (toiture inclinée). */
  pitchDeg: number;
  shape: RoofShape;
  /**
   * Direction du faîtage dans le repère de la feuille, en degrés depuis l'axe +x (0 = horizontal sur la feuille).
   * null = le long du plus grand côté du contour.
   */
  ridgeAngle: number | null;
  /** Hauteur du mur de jambette / Kniestock (m), pour 'pitched-roof'. */
  kneeWallHeight: number;
  constructionId: string | null;
  from: Provenance;
}

/** Fermeture basse du premier étage chauffé. */
export type BottomKind =
  | 'slab-on-ground' // dalle sur terre-plein
  | 'above-unheated' // plancher sur cave / local non chauffé
  | 'above-outside'; // plancher sur extérieur (pilotis, passage)

export interface BottomClosure {
  kind: BottomKind;
  constructionId: string | null;
  from: Provenance;
}

/** Ligne d'enveloppe ajoutée à la main par l'expert (cas que la géométrie simple ne couvre pas). */
export interface ManualRow {
  id: string;
  label: string;
  constructionId: string | null;
  windowTypeId: string | null;
  count: number;
  length: number;
  width: number;
  orientation: OrientationOrHorizontal;
  boundary: Boundary;
  /** Fenêtre/porte à déduire de la ligne suivante. */
  deduct: boolean;
}

export interface BuildingModel {
  /** Étages CHAUFFÉS, du plus bas au plus haut. */
  storeys: Storey[];
  northAngle: Sourced<number>;
  /** Vrai si les contours des étages sont dans un repère commun (IFC). */
  storeysAligned: boolean;
  top: TopClosure;
  bottom: BottomClosure;
  constructions: Construction[];
  windowTypes: WindowType[];
  manualRows: ManualRow[];
  /**
   * Façades DESSINÉES sur la planche, dans leur ordre (« FAÇADE AVANT », « FAÇADE ARRIÈRE »…) : c'est l'ordre de
   * saisie de l'expert. `short` sert au nom des fenêtres (« AV 94*125 X2 »).
   */
  facadeViews?: FacadeView[];
  /**
   * Convention des hauteurs brutes : 'external' = cotes extérieures (dessous de l'isolant du plancher bas → dessus
   * de l'isolant de toiture) ; 'levels' = de niveau fini à niveau fini, puis jusqu'à l'acrotère. Réglage du bureau.
   */
  heightConvention?: 'external' | 'levels';
  /**
   * Ordre des lignes d'enveloppe : 'expert' = planchers bas, toiture, puis façade par façade (portes, fenêtres, mur),
   * puis parois vers le non chauffé ; absent ou 'luxeeb' = ordre historique par orientation.
   */
  envelopeOrder?: 'expert' | 'luxeeb';
  /**
   * Niveaux lus mais laissés HORS du volume chauffé (sous-sol non chauffé), du bas vers le haut : ils reviennent
   * dans `storeys` si l'utilisateur dit le sous-sol chauffé. Absent = aucun.
   */
  unheatedStoreys?: Storey[];
}


// ───────────────────────────── Réponses aux questions ─────────────────────────────

export type BuildingType = 'EFH' | 'MFH'; // maison unifamiliale / immeuble collectif (termes LuxEeB-Tool)
export type Occasion = 'new' | 'existing';

export type HeatGenerator =
  | 'gas-condensing'
  | 'gas-low-temp'
  | 'oil-condensing'
  | 'oil-low-temp'
  | 'old-boiler'
  | 'heat-pump-air'
  | 'heat-pump-ground'
  | 'pellets'
  | 'wood-logs'
  | 'district-heating'
  | 'electric-direct'
  | 'other';

export type HeatEmission = 'radiators' | 'floor-heating' | 'mixed' | 'air';
export type HotWater = 'with-heating' | 'separate-electric' | 'separate-heat-pump' | 'separate-other';
export type Ventilation = 'windows' | 'exhaust' | 'balanced-hr';
export type WindowGeneration = 'single' | 'double-old' | 'double-lowe' | 'triple';

export interface ProjectAnswers {
  projectName: string;
  street: string;
  postcode: string;
  locality: string;
  buildingType: BuildingType | null;
  dwellings: number | null;
  occasion: Occasion | null;
  yearBuilt: number | null;
  /** Isolation ajoutée après coup (cm) ; null = non renseigné, 0 = aucune. */
  insulationWallsCm: number | null;
  insulationRoofCm: number | null;
  insulationFloorCm: number | null;
  windowGeneration: WindowGeneration | null;
  heatGenerator: HeatGenerator | null;
  heatGeneratorYear: number | null;
  heatEmission: HeatEmission | null;
  hotWater: HotWater | null;
  ventilation: Ventilation | null;
  /** Résultat d'un test d'étanchéité (n50, 1/h) ; null = pas de test. */
  n50: number | null;
  solarThermal: boolean | null;
  photovoltaic: boolean | null;
  // ── Réponses ajoutées avec la version 2 du fichier : absentes = non renseignées (jamais inventées) ──
  /** Désignation de l'appareil de ventilation (« VMC double flux … »). */
  ventilationUnit?: string | null;
  /** Débit moyen de l'installation (m³/h). */
  ventilationFlow?: number | null;
  /** Rendement de récupération de chaleur (0..1). */
  heatRecovery?: number | null;
  /** Puissance spécifique des ventilateurs (W/(m³/h)). */
  fanPower?: number | null;
  /**
   * Choix de l'étanchéité dans l'outil : 'class-a-with-ventilation' = option « classe A+ ou A avec ventilation »
   * (n50 = 0,6, observée dans un CPE 6.25) ; 'measured' = valeur mesurée (test d'infiltrométrie, `n50`).
   */
  airtightness?: Airtightness | null;
  /** Ponts thermiques : forfait (W/m²K, choix attestés) ou calcul détaillé. */
  thermalBridges?: ThermalBridges | null;
  /** Construction du bâtiment : 'heavy' (lourde, béton ou maçonnerie) ; 'other' = autre choix à faire dans l'outil. */
  thermalMass?: 'heavy' | 'other' | null;
  /** Régime de températures de l'émission (« 35/28 »), tel que l'outil le propose. */
  emissionTemps?: string | null;
  /** Ballon d'eau chaude à l'intérieur du volume chauffé ? */
  hotWaterStorageInside?: boolean | null;
  /** Situation d'accolement (« Anbausituation ») : isolé, accolé d'un côté, de deux côtés. */
  attachment?: Attachment | null;
  /**
   * Réponses PROPOSÉES par l'outil (lues sur la planche ou supposées) et pas encore confirmées par l'utilisateur,
   * par nom de champ (« occasion », « street »…) : confiance de la lecture (0 = hypothèse) et source citée. Une
   * réponse listée ici n'est jamais tenue pour une réponse de l'utilisateur. Absent = aucune proposition.
   */
  proposed?: Record<string, { confidence: number; source: string }>;
  /**
   * Questions de doute tranchées, par identifiant (« an-unlabelled »…) : 'user' = réponse donnée ; 'unknown' =
   * « je ne sais pas » (la proposition est gardée, étiquetée hypothèse). Une question tranchée n'est plus posée.
   */
  resolvedDoubts?: Record<string, 'user' | 'unknown'>;
}


export interface Project {
  /** 1 : fichiers enregistrés avant le dossier CPE ; 2 : version actuelle (champs v2 tous facultatifs). */
  version: 1 | 2;
  model: BuildingModel;
  answers: ProjectAnswers;
}

// ───────────────────────────── Résultat : fiches LuxEeB-Tool ─────────────────────────────

/**
 * Une ligne du tableau « Flächeneingabe der Gebäudehülle » de LuxEeB-Tool.
 * Colonnes de saisie de LuxEeB-Tool, dans l'ordre : Bauteil | Anzahl | Länge | Breite | Orientierung | … | Abzug.
 * Règle LuxEeB : les lignes marquées « Abzug » (X) sont déduites de la PROCHAINE ligne non marquée.
 */
export interface EnvelopeRow {
  id: string;
  kind: 'wall' | 'window' | 'door' | 'roof' | 'ceiling' | 'floor';
  /** Libellé lisible (dans la langue demandée). */
  label: string;
  /** Nom du type d'élément à choisir dans la liste « Bauteil ». */
  elementName: string;
  constructionId: string | null;
  windowTypeId: string | null;
  count: number;
  /** m, arrondi au cm. */
  length: number;
  /** m, arrondi au cm (hauteur pour un mur). */
  width: number;
  orientation: OrientationOrHorizontal;
  boundary: Boundary;
  deduct: boolean;
  /** count × length × width (m²). */
  grossArea: number;
  /** Surface après déduction des lignes « Abzug » qui précèdent (m²) ; = grossArea pour les lignes déduites. */
  netArea: number;
  /** Provenance la plus faible parmi les données utilisées. */
  from: Provenance;
  storeyId: string | null;
  manual: boolean;
  /**
   * Saisie : 'area' = surface portée seule par la colonne « Breite [m] od. Fläche [m²] » (longueur 1) quand plusieurs
   * hauteurs s'ajoutent ; absent ou 'dims' = longueur × largeur.
   */
  entry?: 'dims' | 'area';
}

/** Ligne du tableau « Energiebezugsflächen / Zonen » (An et Vn). */
export interface ZoneRow {
  id: string;
  label: string;
  /** Surface nette (m²). */
  area: number;
  clearHeight: number;
  /** area × clearHeight (m³). */
  airVolume: number;
  from: Provenance;
  storeyId: string | null;
}

/** Ligne du tableau « Gebäudevolumen Ve ». */
export interface VolumeRow {
  id: string;
  label: string;
  /** Surface brute (m²) ; LuxEeB accepte Anzahl × Breite × Länge × Höhe : on fournit surface et hauteur. */
  area: number;
  height: number;
  volume: number;
  from: Provenance;
  storeyId: string | null;
}

/** Récapitulatif par type d'élément à créer dans LuxEeB-Tool. */
export interface ConstructionSummary {
  constructionId: string;
  name: string;
  category: ConstructionCategory;
  boundary: Boundary;
  /** Surface nette totale (m²). */
  area: number;
  u: Sourced<number> | null;
  /** Paramètres des éléments contre terre demandés par LuxEeB-Tool. */
  ground?: {
    /** Surface de la dalle A (m²). */
    slabArea?: number;
    /** Périmètre caractéristique P (m) : uniquement les côtés contre terre/extérieur/non chauffé. */
    perimeter?: number;
  };
}

export interface WindowSummary {
  windowTypeId: string;
  name: string;
  /** Surface totale (m²). */
  area: number;
  count: number;
  /** Dimensions de la fenêtre la plus fréquente (m), utiles pour le calcul Uw dans LuxEeB-Tool. */
  typicalWidth: number;
  typicalHeight: number;
  uw: Sourced<number> | null;
  g: Sourced<number> | null;
}

export type Severity = 'info' | 'warn' | 'block';

/** Contrôle de plausibilité. `code` est une clé de traduction ; `params` ses variables. */
export interface Finding {
  code: string;
  severity: Severity;
  params: Record<string, string | number>;
}

export interface Totals {
  /** Surface de référence énergétique An (m²). */
  an: number;
  /** Volume d'air chauffé Vn (m³). */
  vn: number;
  /** Volume brut chauffé Ve (m³). */
  ve: number;
  /** Surface de l'enveloppe thermique A (m²) — hors parois mitoyennes chauffées. */
  envelopeArea: number;
  /** A/Ve (1/m). */
  aOverVe: number;
  /** Somme des surfaces brutes de plancher des étages chauffés (m²). */
  grossFloorArea: number;
  /** Surface totale des fenêtres (m²). */
  windowArea: number;
  /** Surface de façade contre extérieur, fenêtres comprises (m²). */
  facadeArea: number;
  anFrom: Provenance;
  veFrom: Provenance;
}

export interface LuxeebSheets {
  envelope: EnvelopeRow[];
  zones: ZoneRow[];
  volumes: VolumeRow[];
  constructions: ConstructionSummary[];
  windows: WindowSummary[];
  totals: Totals;
  findings: Finding[];
}
