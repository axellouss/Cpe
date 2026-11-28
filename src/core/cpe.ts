/**
 * Plan2CPE — le DOSSIER CPE : ce qu'il faut saisir dans LuxEeB-Tool, feuille par feuille, dans l'ordre de l'outil.
 *
 * Calqué sur une sortie réelle de LuxEeB-Tool « version 6.25 », règlement « ab 01/2023 (RGD 2021-REF) » : les noms
 * allemands ci-dessous sont ceux qu'imprime l'outil (feuilles, colonnes, types d'éléments, plages du contrôle de
 * plausibilité). Les libellés français sont nos traductions, sauf mention « fr observé » (l'outil imprime certaines
 * feuilles en français).
 *
 * Chaque valeur du dossier porte sa provenance (`from`), sa confiance (0..1, même lecture que core/reading.ts), la
 * raison d'un doute et sa source. Une HYPOTHÈSE de l'outil (rien sur la planche) est `from: 'default'`, confiance 0,
 * avec sa source citée : elle est toujours montrée comme telle.
 *
 * Le passeport officiel sort de LuxEeB-Tool, établi par un expert agréé : ce dossier ne le remplace pas, il prépare
 * la saisie. Les valeurs U / Uw calculées ici sont des PRÉ-CALCULS ; LuxEeB-Tool fait foi.
 */
import type { ElementType, MaterialKey } from './reading';
import type { Boundary, ConstructionCategory, Lang, Orientation, OrientationOrHorizontal, Provenance, Sourced } from './types';

// ───────────────────────────── Types d'éléments de LuxEeB-Tool ─────────────────────────────

/** Types d'éléments tels que LuxEeB-Tool 6.25 les regroupe (« Übersicht nach Bauteiletyp »). */
export type LuxeebElementType =
  | 'aussenwand'
  | 'wand-unbeheizt'
  | 'kellerwand'
  | 'dach'
  | 'geschossdecke'
  | 'bodenplatte'
  | 'boden-aussen'
  | 'kellerdecke'
  | 'aussentuer'
  | 'tuer-unbeheizt';

export const LUXEEB_ELEMENT_TYPES: readonly LuxeebElementType[] = [
  'aussenwand',
  'wand-unbeheizt',
  'dach',
  'geschossdecke',
  'bodenplatte',
  'boden-aussen',
  'kellerdecke',
  'kellerwand',
  'aussentuer',
  'tuer-unbeheizt',
];

/**
 * Nom du type dans LuxEeB-Tool (allemand, tel qu'imprimé dans « Übersicht nach Bauteiletyp ») et traduction.
 * `ownValue` : élément saisi par sa valeur propre (« Eigene Angaben », emplacements 21 à 40), sans couches.
 */
export const LUXEEB_ELEMENT_LABEL: Record<LuxeebElementType, { de: string; fr: string; ownValue: boolean }> = {
  aussenwand: { de: 'Außenwand', fr: 'Mur extérieur', ownValue: false },
  'wand-unbeheizt': { de: 'Wand zu unbeheizt', fr: 'Mur vers local non chauffé', ownValue: false },
  kellerwand: { de: 'Kellerwand', fr: 'Mur contre terre', ownValue: false },
  dach: { de: 'Dach', fr: 'Toiture', ownValue: false },
  geschossdecke: { de: 'Geschossdecke', fr: 'Plancher sous comble non chauffé', ownValue: false },
  bodenplatte: { de: 'Bodenplatte', fr: 'Dalle sur terre-plein', ownValue: false },
  'boden-aussen': { de: 'Boden nach Außen', fr: 'Plancher sur extérieur', ownValue: false },
  kellerdecke: { de: 'Kellerdecke', fr: 'Plancher sur local non chauffé', ownValue: false },
  aussentuer: { de: 'Außentür', fr: 'Porte extérieure', ownValue: true },
  'tuer-unbeheizt': { de: 'Tür zu unbeheizt', fr: 'Porte vers local non chauffé', ownValue: true },
};

/**
 * Résistances superficielles (m²K/W) par type. `observed` : valeur lue dans le CPE de référence (LuxEeB-Tool 6.25) ;
 * sinon valeur de la norme EN ISO 6946 pour le sens du flux, NON observée dans l'outil : à vérifier.
 */
export const SURFACE_RESISTANCES: Record<
  Exclude<LuxeebElementType, 'aussentuer' | 'tuer-unbeheizt'>,
  { rsi: number; rse: number; observed: boolean }
> = {
  aussenwand: { rsi: 0.13, rse: 0.04, observed: true },
  'wand-unbeheizt': { rsi: 0.13, rse: 0.13, observed: true },
  kellerwand: { rsi: 0.13, rse: 0, observed: false },
  dach: { rsi: 0.1, rse: 0.04, observed: true },
  geschossdecke: { rsi: 0.1, rse: 0.1, observed: false },
  bodenplatte: { rsi: 0.17, rse: 0, observed: true },
  'boden-aussen': { rsi: 0.17, rse: 0.04, observed: true },
  kellerdecke: { rsi: 0.17, rse: 0.17, observed: true },
};

/**
 * Facteurs de température Fx affichés par LuxEeB-Tool dans le CPE de référence. Ce sont des OBSERVATIONS (un cas,
 * un local non chauffé de type garage), pas une table réglementaire. Celui du sol est calculé par l'outil à partir de
 * A, P et de la profondeur : il n'est jamais proposé ici.
 */
export const FX_OBSERVED: Partial<Record<LuxeebElementType, number>> = {
  aussenwand: 1,
  dach: 1,
  aussentuer: 1,
  'wand-unbeheizt': 0.8,
  kellerdecke: 0.8,
  'tuer-unbeheizt': 0.8,
};

/** Type LuxEeB d'une paroi d'après sa catégorie et ce qu'il y a derrière (repli quand `luxeebType` est absent). */
export function luxeebTypeOf(category: ConstructionCategory, boundary: Boundary): LuxeebElementType {
  switch (category) {
    case 'wall':
      return boundary === 'ground' ? 'kellerwand' : boundary === 'unheated' ? 'wand-unbeheizt' : 'aussenwand';
    case 'roof':
      return 'dach';
    case 'ceiling':
      return boundary === 'outside' ? 'dach' : 'geschossdecke';
    case 'floor':
      return boundary === 'ground' ? 'bodenplatte' : boundary === 'unheated' ? 'kellerdecke' : 'boden-aussen';
    case 'door':
      return boundary === 'unheated' ? 'tuer-unbeheizt' : 'aussentuer';
  }
}

/** Rôle thermique lu sur la planche (annotation « Composition … ») → type LuxEeB ; null si la paroi n'en est pas un. */
export function luxeebTypeOfElement(element: ElementType): LuxeebElementType | null {
  switch (element) {
    case 'external-wall':
      return 'aussenwand';
    case 'wall-to-unheated':
      return 'wand-unbeheizt';
    case 'wall-to-ground':
      return 'kellerwand';
    case 'floor-on-ground':
      return 'bodenplatte';
    case 'floor-to-unheated':
      return 'kellerdecke';
    case 'floor-to-outside':
      return 'boden-aussen';
    case 'roof':
      return 'dach';
    case 'ceiling-to-unheated':
      return 'geschossdecke';
    default:
      return null; // mur mitoyen, cloison, plancher intermédiaire, inconnu : hors enveloppe ou à trancher
  }
}

/** Catégorie et milieu du modèle (core/types) qui correspondent à un type LuxEeB. */
export function categoryOfLuxeebType(type: LuxeebElementType): { category: ConstructionCategory; boundary: Boundary } {
  switch (type) {
    case 'aussenwand':
      return { category: 'wall', boundary: 'outside' };
    case 'wand-unbeheizt':
      return { category: 'wall', boundary: 'unheated' };
    case 'kellerwand':
      return { category: 'wall', boundary: 'ground' };
    case 'dach':
      return { category: 'roof', boundary: 'outside' };
    case 'geschossdecke':
      return { category: 'ceiling', boundary: 'unheated' };
    case 'bodenplatte':
      return { category: 'floor', boundary: 'ground' };
    case 'boden-aussen':
      return { category: 'floor', boundary: 'outside' };
    case 'kellerdecke':
      return { category: 'floor', boundary: 'unheated' };
    case 'aussentuer':
      return { category: 'door', boundary: 'outside' };
    case 'tuer-unbeheizt':
      return { category: 'door', boundary: 'unheated' };
  }
}

// ───────────────────────────── Couches, sol, fenêtres ─────────────────────────────

/** Nombre de couches par élément dans « Berechnung der U-Werte von Bauteilen » (lignes 1 à 10). */
export const LUXEEB_LAYER_SLOTS = 10;
/** Emplacements d'éléments : 1 à 20 calculés par couches, 21 à 40 « Eigene Angaben ». */
export const LUXEEB_CALCULATED_SLOTS = 20;
export const LUXEEB_OWN_VALUE_SLOTS = 20;

/** Une couche d'élément opaque, de l'INTÉRIEUR vers l'EXTÉRIEUR (ordre de l'outil : « intérieur » en haut). */
export interface ConstructionLayer {
  /** Nom tel qu'il sera saisi (« EPS », « Dalle béton »). */
  name: string;
  /** Famille reconnue (core/reading) ; null si inconnue. */
  material: MaterialKey | null;
  /** Conductivité (W/mK). null = à choisir dans la base de matériaux de LuxEeB-Tool (aucune valeur proposée). */
  lambda: Sourced<number> | null;
  /** Épaisseur (cm). Une valeur 0 donnée explicitement = couche sans résistance (film), sautée par le calcul. */
  thicknessCm: Sourced<number>;
  /**
   * Vrai quand l'épaisseur n'est pas connue (non écrite ou illisible sur le plan) : la couche empêche alors le
   * pré-calcul du U au lieu d'être confondue avec un film. Absent = épaisseur connue.
   */
  thicknessUnknown?: boolean;
  /** Texte d'origine sur la planche (« 20cm Isolation type EPS »), s'il y en a un. */
  planText?: string;
  /** Raison d'un doute sur cette couche (couche mixte, isolant sans type…). */
  doubt?: string | null;
}

/** Données des éléments contre terre (« Données nécessaires pour constructions enterrées ») : l'outil en tire B' et Fx. */
export interface GroundData {
  /** Surface de l'élément A (m²). */
  area: Sourced<number>;
  /** Périmètre exposé P (m) : côtés contre l'extérieur ou un local non chauffé, sans les murs mitoyens. */
  perimeter: Sourced<number>;
  /** Profondeur T (m) sous le terrain ; absente = non renseignée. */
  depth?: Sourced<number>;
}

/** « einfach » : un seul vitrage dans le cadre ; « mehrfach » : plusieurs vitrages séparés par des montants. */
export type FensterTyp = 'einfach' | 'mehrfach';

/** Géométrie d'un type de fenêtre telle que la feuille des fenêtres la demande (dimensions brutes, m). */
export interface WindowGeometry {
  width: number;
  height: number;
  /** Largeur de cadre (« Rahmenbreite », m). */
  frameWidth: Sourced<number>;
  fensterTyp: Sourced<FensterTyp>;
  /** Nombre de vitrages (« Scheibenzahl ») : 1 pour « einfach ». */
  panes: number;
}

// ───────────────────────────── Modèle : façades dessinées, réponses ─────────────────────────────
/** Une façade dessinée sur la planche. */
export interface FacadeView {
  /** Orientation de sa normale extérieure. */
  orientation: Orientation;
  /** Abréviation pour nommer les fenêtres (« AV », « ARR », « GAU »…). */
  short: string;
  /** Titre lu (« FAÇADE AVANT ») ; null si la façade n'est pas dessinée (repli par orientation). */
  title: string | null;
  /** Vue lue (ReadView.id) ; absente si inconnue. */
  viewId?: string;
}

export type Airtightness = 'class-a-with-ventilation' | 'measured';
/** '0.10' forfait sans justification ; '0.05' forfait réduit ; '0.03' « selon DIN 4108 avec 0,03 » ; 'detailed' calcul. */
export type ThermalBridges = '0.10' | '0.05' | '0.03' | 'detailed';
/**
 * Situation d'accolement. Seul « einseitig angebaut » est attesté (CPE de référence) : 'one-side'. Toute autre
 * situation est 'other', à choisir dans la liste de LuxEeB-Tool (aucun libellé de l'outil n'est inventé).
 */
export type Attachment = 'one-side' | 'other';

// ───────────────────────────── Feuilles de LuxEeB-Tool 6.25 ─────────────────────────────

export type DossierSheetKey =
  | 'general'
  | 'opaque'
  | 'ownValues'
  | 'windows'
  | 'envelope'
  | 'zones'
  | 'volumes'
  | 'ventilation'
  | 'other'
  | 'heating'
  | 'hotWater'
  | 'auxiliary'
  | 'photovoltaic'
  | 'summer'
  | 'plausibility';

export interface DossierSheetInfo {
  key: DossierSheetKey;
  /** Titre imprimé par l'outil (allemand, ou français quand l'outil imprime la feuille en français). */
  de: string;
  fr: string;
  /** Vrai si le titre français est celui qu'imprime l'outil (sinon c'est notre traduction). */
  frObserved: boolean;
  /** Vrai si la feuille demande des saisies (les autres sont des résultats ou des contrôles). */
  input: boolean;
}

/** Les feuilles du CPE dans l'ordre de LuxEeB-Tool 6.25. */
export const SHEETS_625: readonly DossierSheetInfo[] = [
  { key: 'general', de: 'Allgemeine Projektdaten', fr: 'Informations générales du projet', frObserved: true, input: true },
  { key: 'opaque', de: 'Berechnung der U-Werte von Bauteilen', fr: 'Calcul valeur U de la construction', frObserved: true, input: true },
  { key: 'ownValues', de: 'Eigene Angaben', fr: 'Valeurs propres', frObserved: false, input: true },
  { key: 'windows', de: 'Berechnung der U-Werte von transparenten Bauteilen', fr: 'Calcul des valeurs U des fenêtres', frObserved: false, input: true },
  { key: 'envelope', de: 'Flächeneingabe der Gebäudehülle', fr: 'Saisie des surfaces de l’enveloppe', frObserved: false, input: true },
  { key: 'zones', de: 'Energiebezugsflächen / Zonen', fr: 'Surfaces de référence / zones', frObserved: false, input: true },
  { key: 'volumes', de: 'Gebäudevolumen Ve', fr: 'Volume du bâtiment Ve', frObserved: false, input: true },
  { key: 'ventilation', de: 'Berechnung des energetischen Luftwechsels', fr: 'Ventilation et étanchéité', frObserved: false, input: true },
  { key: 'other', de: 'Sonstige Parameter', fr: 'Autres paramètres', frObserved: false, input: true },
  { key: 'heating', de: 'Auswahl Heizungsanlagen', fr: 'Chauffage', frObserved: false, input: true },
  { key: 'hotWater', de: 'Auswahl Warmwassererzeugung', fr: 'Eau chaude sanitaire', frObserved: false, input: true },
  { key: 'auxiliary', de: 'Berechnung des Hilfsenergiebedarfs', fr: 'Énergie auxiliaire', frObserved: false, input: false },
  { key: 'photovoltaic', de: 'Photovoltaikanlagen', fr: 'Évaluation des systèmes photovoltaïques', frObserved: true, input: true },
  { key: 'summer', de: 'Sommerlicher Wärmeschutz', fr: 'Protection thermique d’été', frObserved: false, input: true },
  { key: 'plausibility', de: 'Plausibilitätscheck - Berechnungsergebnisse', fr: 'Contrôle de plausibilité', frObserved: false, input: false },
];

/** Colonnes imprimées par l'outil, feuille par feuille (allemand tel qu'imprimé ; français = traduction). */
export const LUXEEB_COLUMNS = {
  opaque: {
    layer: { de: 'Schicht', fr: 'Couche' },
    lambda: { de: 'λ [W/(mK)]', fr: 'λ [W/(mK)]' },
    thickness: { de: 'Dicke [cm]', fr: 'épais. [cm]' },
    rsi: { de: 'Rsi [m²K/W]', fr: 'intérieur Rsi (m²K/W)' },
    rse: { de: 'Rse [m²K/W]', fr: 'extérieur Rse (m²K/W)' },
    deltaU: { de: 'ΔU Zuschlag [W/m²K]', fr: 'ΔU Supplément (W/m²K)' },
    total: { de: 'Bauteildicke [cm]', fr: 'épaisseur de l’élément (cm)' },
    u: { de: 'U-Wert [W/m²K]', fr: 'valeur U (W/m²K)' },
    groundArea: { de: 'Fläche des Bauteils A [m²]', fr: 'surf. de l’élém. de construction A [m²]' },
    groundPerimeter: { de: 'Perimeter P [m]', fr: 'périmètre P [m]' },
    groundDepth: { de: 'Tiefe T [m]', fr: 'profondeur T [m]' },
  },
  windows: {
    name: { de: 'Bezeichnung', fr: 'Désignation' },
    mounting: { de: 'Einbauart des Fensterelements', fr: 'Pose de l’élément' },
    width: { de: 'Breite [m]', fr: 'Largeur [m]' },
    height: { de: 'Höhe [m]', fr: 'Hauteur [m]' },
    frame: { de: 'Rahmenbreite [m]', fr: 'Largeur de cadre [m]' },
    type: { de: 'Fenstertyp', fr: 'Type de fenêtre' },
    panes: { de: 'Scheibenzahl', fr: 'Nombre de vitrages' },
    ug: { de: 'U-Wert Glas [W/(m²K)]', fr: 'U vitrage [W/(m²K)]' },
    uf: { de: 'U-Wert Rahmen [W/(m²K)]', fr: 'U cadre [W/(m²K)]' },
    psi: { de: 'Ψg Rahmenverbund [W/(mK)]', fr: 'Ψg intercalaire [W/(mK)]' },
    g: { de: 'g-Wert [-]', fr: 'facteur g [-]' },
    uw: { de: 'U-Wert Fenster [W/(m²K)]', fr: 'U fenêtre [W/(m²K)]' },
  },
  envelope: {
    element: { de: 'Bauteilnummer', fr: 'Élément' },
    count: { de: 'Anzahl', fr: 'Nombre' },
    length: { de: 'Länge [m]', fr: 'Longueur [m]' },
    widthOrArea: { de: 'Breite [m] od. Fläche [m²]', fr: 'Largeur [m] ou surface [m²]' },
    orientation: { de: 'Orientierung', fr: 'Orientation' },
    u: { de: 'U [W/m²K]', fr: 'U [W/m²K]' },
    fx: { de: 'FJ', fr: 'Fx' },
    deduct: { de: 'Abzug', fr: 'Déduction' },
    area: { de: 'Ai [m²]', fr: 'Surface nette [m²]' },
  },
  zones: {
    name: { de: 'Raumbezeichnung', fr: 'Désignation' },
    count: { de: 'Anzahl', fr: 'Nombre' },
    length: { de: 'Länge [m]', fr: 'Longueur [m]' },
    widthOrArea: { de: 'Breite [m] od. Fläche [m²]', fr: 'Largeur [m] ou surface [m²]' },
    height: { de: 'Höhe [m]', fr: 'Hauteur [m]' },
    ventilation: { de: 'Zugewiesen zu Lüftungsanlage', fr: 'Ventilation rattachée' },
  },
  volumes: {
    name: { de: 'Bezeichnung', fr: 'Désignation' },
    count: { de: 'Anzahl', fr: 'Nombre' },
    length: { de: 'Länge [m]', fr: 'Longueur [m]' },
    widthOrArea: { de: 'Breite [m] od. Fläche [m²]', fr: 'Largeur [m] ou surface [m²]' },
    height: { de: 'Höhe [m]', fr: 'Hauteur [m]' },
  },
  ventilation: {
    unit: { de: 'Bezeichnung der Anlage', fr: 'Désignation de l’installation' },
    flow: { de: 'Volumenstrom der Anlage VL,i [m³/h]', fr: 'Débit de l’installation [m³/h]' },
    hours: { de: 'Vollbetriebszeit tB,H [h/d]', fr: 'Durée de fonctionnement [h/j]' },
    recovery: { de: 'Wärmebereitstellungsgrad WRG', fr: 'Rendement de récupération' },
    power: { de: 'spezifische Leistungsaufnahme qL,i [W/(m³/h)]', fr: 'Puissance spécifique [W/(m³/h)]' },
    airtightness: { de: 'Auswahl der Luftdichtheit', fr: 'Choix de l’étanchéité à l’air' },
    n50: { de: 'Luftdichtheitswert für Berechnung n50 [1/h]', fr: 'Valeur n50 pour le calcul [1/h]' },
  },
  other: {
    thermalBridges: { de: 'Wärmebrücken', fr: 'Ponts thermiques' },
    setback: { de: 'Nachtabsenkung', fr: 'Réduction nocturne' },
    control: { de: 'Regel- und Wärmeübergabe', fr: 'Contrôle et transfert de chaleur' },
    construction: { de: 'Bauweise des Gebäudes', fr: 'Construction du bâtiment' },
    regulation: { de: 'Version der Verordnung', fr: 'Version du règlement' },
  },
} as const;

/**
 * Plages « übliche Werte » de la feuille « Plausibilitätscheck » imprimées par LuxEeB-Tool 6.25. `computable` : vrai
 * si la grandeur se calcule à partir du relevé (les autres sont des résultats du bilan de l'outil).
 */
export interface PlausibilityRange {
  key: string;
  de: string;
  fr: string;
  min: number;
  max: number;
  unit: string;
  computable: boolean;
}

export const PLAUSIBILITY_625: readonly PlausibilityRange[] = [
  { key: 'anPerStorey', de: 'Energiebezugsfläche je Geschoss', fr: 'An par étage', min: 50, max: 10000, unit: 'm²/Gesch.', computable: true },
  { key: 'roofPerAn', de: 'Dachflächen', fr: 'Toitures', min: 0.4, max: 1.1, unit: 'm²/m²EBF', computable: true },
  { key: 'floorPerAn', de: 'Bodenflächen', fr: 'Planchers bas', min: 0.4, max: 0.8, unit: 'm²/m²EBF', computable: true },
  { key: 'facadePerAn', de: 'Fassadenflächen', fr: 'Façades', min: 1, max: 2, unit: 'm²/m²EBF', computable: true },
  { key: 'windowPerAn', de: 'Fensterflächen', fr: 'Fenêtres', min: 0.1, max: 0.3, unit: 'm²/m²EBF', computable: true },
  { key: 'envelopePerAn', de: 'Gebäudehüllflächen', fr: 'Enveloppe', min: 1.8, max: 3.8, unit: 'm²/m²EBF', computable: true },
  { key: 'aOverVe', de: 'A/V-Verhältnis', fr: 'Rapport A/Ve', min: 0.5, max: 1, unit: '1/m', computable: true },
  { key: 'windowShare', de: 'Fensterflächenanteil', fr: 'Part de fenêtres', min: 0.05, max: 0.5, unit: '-', computable: true },
  { key: 'meanU', de: 'mittlerer U-Wert', fr: 'U moyen', min: 0.1, max: 1.5, unit: 'W/(m²K)', computable: true },
  { key: 'vnOverVe', de: 'Verhältnis Vn/Ve', fr: 'Rapport Vn/Ve', min: 0.5, max: 1.04, unit: 'm³/m³', computable: true },
  { key: 'n50', de: 'Luftdichtheit', fr: 'Étanchéité n50', min: 0.6, max: 1.5, unit: '1/h', computable: true },
  { key: 'heatRecovery', de: 'Wärmerückgewinnung Lüftung', fr: 'Récupération de chaleur', min: 0.6, max: 0.95, unit: '-', computable: true },
  { key: 'qH', de: 'Heizwärmebedarf', fr: 'Besoin de chauffage', min: 5, max: 500, unit: 'kWh/(m²a)', computable: false },
  { key: 'qP', de: 'Primärenergiebedarf', fr: 'Énergie primaire', min: 15, max: 800, unit: 'kWh/(m²a)', computable: false },
];

/** Version de l'outil et du règlement sur lesquelles ce dossier a été calqué. */
export const LUXEEB_TOOL_VERSION = '6.25';
export const LUXEEB_REGULATION = 'ab 01/2023 (RGD 2021-REF)';

// ───────────────────────────── Dossier ─────────────────────────────

/** Une valeur du dossier : texte prêt à saisir, avec sa provenance, sa confiance, son doute et sa source. */
export interface DossierValue {
  /** Valeur affichée et à saisir (nombres au format de l'outil, virgule décimale) ; '' = rien à saisir. */
  text: string;
  /** Valeur brute quand c'est un nombre. */
  number?: number;
  from: Provenance | null;
  /** 0..1 ; 0 = hypothèse de l'outil, null = non renseigné. */
  confidence: number | null;
  doubt?: string | null;
  /** D'où vient la valeur (« lu dans le cartouche », « valeur d'usage, à remplacer… »). */
  source?: string;
}

export interface DossierColumn {
  key: string;
  /** Libellé de l'outil (allemand) et traduction. */
  de: string;
  fr: string;
}

export interface DossierTable {
  key: string;
  columns: DossierColumn[];
  rows: { id: string; cells: DossierValue[] }[];
}

/** Un champ isolé d'une feuille (« Gebäudetyp », « Nachweisart »…). */
export interface DossierField {
  key: string;
  de: string;
  fr: string;
  value: DossierValue;
}

/** Résultat d'un contrôle de plausibilité calculé sur le relevé. */
export interface PlausibilityCheck {
  key: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  unit: string;
  /** 'P' = dans la plage ; 'out' = hors plage ; 'n/a' = non calculable ici. */
  status: 'P' | 'out' | 'n/a';
}

/** Une hypothèse à confirmer (rien sur la planche) : ce qu'elle remplace et sa source. */
export interface DossierAssumption {
  key: string;
  sheet: DossierSheetKey;
  text: string;
  source: string;
}

export interface DossierSection {
  key: DossierSheetKey;
  /** Titre de la feuille dans l'outil (allemand) et titre dans la langue demandée. */
  luxeebName: string;
  title: string;
  fields: DossierField[];
  tables: DossierTable[];
  /** Remarques courtes (dans la langue demandée). */
  notes: string[];
}

export interface Dossier {
  version: 2;
  lang: Lang;
  tool: { version: string; regulation: string };
  sections: DossierSection[];
  plausibility: PlausibilityCheck[];
  assumptions: DossierAssumption[];
}

/** Libellé d'une colonne ou d'une feuille dans la langue demandée, l'allemand de l'outil restant affiché à côté. */
export function bilingual(label: { de: string; fr: string }, lang: Lang): string {
  return lang === 'de' ? label.de : `${label.de} — ${label.fr}`;
}

/** Orientation telle que l'outil l'attend dans la colonne « Orientierung » (vide pour une paroi vers le non chauffé). */
export type DossierOrientation = OrientationOrHorizontal | '';

// ───────────────────────────── Listes exhaustives (lecture des fichiers de projet) ─────────────────────────────

const MATERIAL_KEY_SET: Record<MaterialKey, true> = {
  'beton-arme': true,
  beton: true,
  'bloc-beton': true,
  'beton-maigre': true,
  'silico-calcaire': true,
  brique: true,
  bois: true,
  eps: true,
  xps: true,
  pur: true,
  pir: true,
  'laine-minerale': true,
  'fibre-bois': true,
  isolant: true,
  chape: true,
  'revetement-sol': true,
  'enduit-platre': true,
  'enduit-facade': true,
  etancheite: true,
  film: true,
  empierrement: true,
  'lame-air': true,
  bardage: true,
  inconnu: true,
};

/** Toutes les familles de matériaux du contrat de lecture (core/reading `MaterialKey`). */
export const MATERIAL_KEYS = Object.keys(MATERIAL_KEY_SET) as MaterialKey[];
