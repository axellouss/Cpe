/**
 * Termes ALLEMANDS de LuxEeB-Tool, recopiés tels quels du manuel officiel (version 1.7, juin 2013) et des
 * captures d'écran qu'il contient. La page du manuel est indiquée pour chaque groupe.
 *
 * RÈGLE : ne rien ajouter ici qui ne se lise pas dans le manuel. Les options des listes des installations
 * techniques (générateurs, vecteurs énergétiques…) n'y figurent volontairement pas : le guide donne la réponse
 * de l'expert en clair et le laisse choisir l'entrée dans SA version de l'outil.
 *
 * Le manuel décrit la version 2.7 de l'outil ; le ministère le publie toujours pour la version actuelle,
 * mais des libellés ont pu changer : le guide le dit à l'utilisateur (voir « export.guide.disclaimer »).
 */
import type { Boundary, ConstructionCategory, OrientationOrHorizontal } from '../core/types';

/** Entrées du menu de navigation (clic droit), dans l'ordre — manuel p. 11. */
export const LUXEEB_MENU = {
  project: 'Projektdaten',
  opaque: 'U-Werte opaker Bauteile',
  windows: 'U-Wert transparenter Bauteile',
  thermalBridges: 'Wärmebrücken',
  envelope: 'Gebäudehülle',
  areas: 'Flächen und Volumina',
  ventilation: 'Lüftung, Luftdichtheit, Lüftungsanlagen',
  parameters: 'sonstige Parameter',
  overview: 'Übersicht aller Bauteile',
  heating: 'Heizungsanlagen',
  hotWater: 'Warmwasseranlagen',
  auxiliary: 'Hilfsenergie',
} as const;

/** Titres des feuilles et tableaux, tels qu'affichés en tête de feuille. */
export const LUXEEB_SHEET = {
  project: 'Allgemeine Projektdaten', // p. 12
  opaque: 'Berechnung der U-Werte von Bauteilen', // p. 15
  opaqueManual: 'Eigene Angaben', // p. 18 (« Eigene Angaben, Nachweis der Berechnung als Anlage beizufügen »)
  windows: 'Berechnung der U-Werte von transparenten Bauteilen', // p. 19
  thermalBridges: 'Berechnung linearer Wärmebrücken', // p. 21
  envelope: 'Flächeneingabe der Gebäudehülle', // p. 22
  shading: 'Verschattung bei transparenten Bauteilen', // p. 22 (partie droite de la même feuille)
  zones: 'Energiebezugsflächen / Zonen', // p. 24
  volumes: 'Gebäudevolumen Ve', // p. 24
  ventilation: 'Berechnung des energetischen Luftwechsels', // p. 25
  parameters: 'sonstige Parameter', // p. 29
  overview: 'Übersicht der Gebäudegeometrie und Bauteile', // p. 29
  heating: 'Auswahl Heizungsanlagen', // p. 31
  heatingExisting: 'Auswahl Heizungsanlagen für Bestandsgebäude', // p. 32
  hotWater: 'Auswahl Warmwassererzeugung', // p. 33
} as const;

/** Champs de la page de démarrage — p. 12-13. */
export const LUXEEB_PROJECT = {
  designation: 'Bezeichnung',
  street: 'Straße, Nr.',
  postcodeLocality: 'PLZ, Ort',
  yearBuilt: 'Baujahr Gebäude',
  dwellings: 'Wohneinheiten',
  buildingType: 'Gebäudetyp',
  occasion: 'Nachweisart',
  issuer: 'Aussteller',
  owner: 'Eigentümer',
  /** Valeurs d'exemple lues dans le manuel (p. 13) — les autres entrées des listes n'y sont pas montrées. */
  buildingTypeEfh: 'Wohnen EFH',
  occasionNewExample: 'Neubau (Bauantrag)',
} as const;

/** Colonnes de « Flächeneingabe der Gebäudehülle » — p. 22 et 24. */
export const LUXEEB_ENVELOPE = {
  /** La liste déroulante n'a pas d'en-tête dans l'outil ; « Bauteil » est le mot du manuel pour ses entrées. */
  element: 'Bauteil',
  count: 'Anzahl',
  length: 'Länge (Rohbaumaß)',
  width: 'Breite (Rohbaumaß)',
  orientation: 'Orientierung',
  deduct: 'Abzug',
  area: 'A',
  /** Marque de déduction (p. 22 : « x » dans la colonne Abzug). */
  deductMark: 'x',
} as const;

/** Valeurs de la colonne « Orientierung » — p. 22, 29 et 30. */
export const LUXEEB_ORIENTATION: Record<OrientationOrHorizontal, string> = {
  N: 'Nord',
  NE: 'Nordost',
  E: 'Ost',
  SE: 'Südost',
  S: 'Süd',
  SW: 'Südwest',
  W: 'West',
  NW: 'Nordwest',
  H: 'Horizontal',
};

/** Colonnes de « Energiebezugsflächen / Zonen » et « Gebäudevolumen Ve » — p. 24. */
export const LUXEEB_AREAS = {
  roomName: 'Raumbezeichnung',
  designation: 'Bezeichnung',
  count: 'Anzahl',
  width: 'Breite',
  length: 'Länge',
  height: 'Höhe',
  ventilationSystem: 'Lüftungsanlage',
  noVentilation: 'keine Anlage',
  sum: 'Summe',
  an: 'An',
  vn: 'Vn',
  ve: 'Ve',
} as const;

/** Éléments opaques — p. 15 et 18. */
export const LUXEEB_OPAQUE = {
  designation: 'Bezeichnung',
  uValue: 'U-Wert',
  situation: 'Einbausituation',
  description: 'Beschreibung',
  slabArea: 'Fläche des Bauteils A',
  perimeter: 'Perimeter P',
  depth: 'Tiefe T',
  /** Nombre d'emplacements (p. 15 : « 20 éléments de construction sont disponibles »). */
  slots: 20,
} as const;

/** Options de la liste « Einbausituation » de la saisie manuelle « Eigene Angaben » — capture p. 18. */
export const LUXEEB_SITUATION = {
  wall: 'Außenwand',
  roof: 'Dach gegen außen',
  ground: 'Bauteil gegen Erdreich',
  unheated: 'Bauteil gegen unbeheizt',
  other: 'sonstige Einbauarten',
} as const;

/** Fenêtres — p. 19 et 20. */
export const LUXEEB_WINDOWS = {
  designation: 'Bezeichnung',
  width: 'Breite',
  height: 'Höhe',
  uWindow: 'U-Wert Fenster',
  gValue: 'g-Wert',
  windowType: 'Fenstertyp',
  paneCount: 'Scheibenzahl',
  /** Valeur standard du raccord verre-cadre (p. 19). */
  psiDefault: '0,06 W/(mK)',
} as const;

/** Feuille de synthèse « Übersicht der Gebäudegeometrie und Bauteile » — capture p. 29. */
export const LUXEEB_OVERVIEW = {
  envelopeGross: 'Brutto Gebäudehüllfläche',
  /** Surface PONDÉRÉE par les facteurs de correction de température (408 m² pour 457 m² bruts dans l'exemple). */
  envelopeWeighted: 'Gebäudehüllfläche',
  ve: 'Beheiztes Bruttogebäudevolumen',
  vn: 'Beheiztes Gebäudeluftvolumen',
  /** Écrit ainsi dans l'outil, avec l'espace. */
  aOverV: 'A/V- Verhältnis',
  an: 'Energiebezugsfläche',
  windowArea: 'Gesamtfensterflächen',
} as const;

/** Ventilation et étanchéité — p. 25 et 28. */
export const LUXEEB_VENTILATION = {
  airtightnessChoice: 'Auswahl der Luftdichtheit',
  airtightnessValue: 'Luftdichtheitswert',
} as const;

/** Champs de « sonstige Parameter » — capture p. 29. */
export const LUXEEB_PARAMETERS = {
  climate: 'Klimadatensatz',
  thermalBridges: 'Wärmebrücken',
  setback: 'Absenkverhalten',
  control: 'Regel & Wärmeübergabe',
  construction: 'Bauweise des Gebäudes',
} as const;

/** Champs des feuilles de chauffage — p. 31 (neuf) et p. 32 (existant). */
export const LUXEEB_HEATING = {
  system: 'Systemwahl',
  mainDistribution: 'Lage der Hauptverteilung',
  risers: 'Lage der Verteilungsstränge',
  generator: 'Wärmeerzeuger',
  subsystem: 'Untersystem',
  carrier: 'Energieträger',
  solarThermal: 'Thermische Solaranlage',
  existingKind: 'Art der Wärmeerzeugung',
  existingPipes: 'Wärmeschutz der Rohrleitungen',
} as const;

/** Champs de la feuille d'eau chaude sanitaire — p. 33. */
export const LUXEEB_HOT_WATER = {
  supply: 'Art der Trinkwasserversorgung',
  storageLocation: 'Aufstellungsort des Speichers',
  storageKind: 'Art des Speichersystems',
  generator: 'Wärmeerzeuger',
  subsystem: 'Untersystem',
} as const;

export interface SituationProposal {
  /** Option de la liste « Einbausituation » ; null = paroi hors enveloppe (local chauffé). */
  option: string | null;
  /** Vrai si le cas ne figure pas tel quel dans la liste : proposition à vérifier par l'expert. */
  toCheck: boolean;
}

/**
 * Option de « Einbausituation » proposée pour un type d'élément (saisie manuelle).
 * Les cas sans option évidente (porte, plancher sur extérieur) sont marqués « à vérifier ».
 */
export function proposeSituation(category: ConstructionCategory, boundary: Boundary): SituationProposal {
  if (boundary === 'heated') return { option: null, toCheck: false };
  if (boundary === 'ground') return { option: LUXEEB_SITUATION.ground, toCheck: false };
  if (boundary === 'unheated') return { option: LUXEEB_SITUATION.unheated, toCheck: false };
  switch (category) {
    case 'wall':
      return { option: LUXEEB_SITUATION.wall, toCheck: false };
    case 'roof':
    case 'ceiling':
      return { option: LUXEEB_SITUATION.roof, toCheck: category === 'ceiling' };
    case 'door':
      return { option: LUXEEB_SITUATION.wall, toCheck: true };
    case 'floor':
      return { option: LUXEEB_SITUATION.other, toCheck: true };
    default:
      return { option: LUXEEB_SITUATION.other, toCheck: true };
  }
}
