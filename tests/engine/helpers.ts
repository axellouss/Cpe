/**
 * Petits constructeurs pour les tests du moteur. Tous les plans de test sont tracés directement en MÈTRES
 * (1 unité de feuille = 1 m, échelle confirmée), repère écran : x à droite, y vers le BAS.
 */
import type {
  BuildingModel,
  Boundary,
  EnvelopeRow,
  Finding,
  LuxeebSheets,
  Opening,
  PlanSheet,
  Project,
  Provenance,
  Room,
  Storey,
  Vec2,
} from '../../src/core/types';
import { createEmptyProject } from '../../src/engine';

/**
 * Rectangle largeur × profondeur, parcouru dans le sens horaire à l'écran en partant du coin haut-gauche.
 * Avec le nord en haut du plan, les arêtes sont donc dans l'ordre : 0 = Nord, 1 = Est, 2 = Sud, 3 = Ouest.
 */
export function rect(width: number, depth: number, x0 = 0, y0 = 0): Vec2[] {
  return [
    { x: x0, y: y0 },
    { x: x0 + width, y: y0 },
    { x: x0 + width, y: y0 + depth },
    { x: x0, y: y0 + depth },
  ];
}

export const NORTH = 0;
export const EAST = 1;
export const SOUTH = 2;
export const WEST = 3;

export interface StoreyOptions {
  grossHeight?: number;
  clearHeight?: number;
  heightFrom?: Provenance;
  /** Milieu derrière chaque arête ; 'outside' par défaut. */
  boundaries?: Partial<Record<number, Boundary>>;
  openings?: Opening[];
  rooms?: Room[];
  /** Surface nette saisie par l'expert (m²). */
  netArea?: number;
  scale?: { value: number; from: Provenance };
}

/** Étage entièrement confirmé par l'expert (sauf indication contraire). */
export function storey(id: string, name: string, outline: Vec2[], options: StoreyOptions = {}): Storey {
  const heightFrom = options.heightFrom ?? 'user';
  return {
    id,
    name,
    sheetId: null,
    outline,
    edges: outline.map((_, i) => ({ boundary: options.boundaries?.[i] ?? 'outside', constructionId: null })),
    metresPerUnit: options.scale ?? { value: 1, from: 'user' },
    grossHeight: { value: options.grossHeight ?? 2.8, from: heightFrom },
    clearHeight: { value: options.clearHeight ?? 2.5, from: heightFrom },
    openings: options.openings ?? [],
    rooms: options.rooms ?? [],
    netAreaOverride: options.netArea === undefined ? null : { value: options.netArea, from: 'user' },
  };
}

let openingSerial = 0;

export function windowAt(edgeIndex: number, width: number, height: number, count = 1): Opening {
  return { id: `w${++openingSerial}`, edgeIndex, kind: 'window', width, height, count, position: 0.5, windowTypeId: null, from: 'user' };
}

export function doorAt(edgeIndex: number, width: number, height: number, count = 1): Opening {
  return { id: `d${++openingSerial}`, edgeIndex, kind: 'door', width, height, count, position: 0.5, windowTypeId: null, from: 'user' };
}

export function room(name: string, area: number, heated = true, needsReview = false): Room {
  return { id: `room-${name}`, name, area: { value: area, from: 'plan' }, heated, needsReview };
}

/**
 * Projet dont TOUT est confirmé par l'expert : nord en haut, toiture plate, dalle sur terre-plein.
 * `patch` remplace les champs voulus du modèle.
 */
export function project(storeys: Storey[], patch: Partial<BuildingModel> = {}): Project {
  const base = createEmptyProject('fr');
  return {
    ...base,
    model: {
      ...base.model,
      storeys,
      northAngle: { value: 0, from: 'user' },
      top: { ...base.model.top, kind: 'flat-roof', from: 'user' },
      bottom: { ...base.model.bottom, kind: 'slab-on-ground', from: 'user' },
      ...patch,
    },
  };
}

/** Résumé lisible d'une ligne : « genre orientation nombre × longueur × largeur [Abzug] ». */
export function brief(row: EnvelopeRow): string {
  return `${row.kind} ${row.orientation} ${row.count} × ${row.length.toFixed(2)} × ${row.width.toFixed(2)}${row.deduct ? ' Abzug' : ''}`;
}

export function codes(sheets: LuxeebSheets): string[] {
  return sheets.findings.map((f) => f.code);
}

export function finding(sheets: LuxeebSheets, code: string): Finding | undefined {
  return sheets.findings.find((f) => f.code === code);
}

/** Feuille synthétique telle qu'un lecteur de plans la produirait. */
export function sheet(id: string, name: string, patch: Partial<PlanSheet> = {}): PlanSheet {
  return {
    id,
    name,
    bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    metresPerUnit: { value: 1, from: 'plan' },
    detected: { rooms: [], openings: [], notes: [] },
    ...patch,
  };
}

/** Gèle un objet en profondeur : toute tentative de modification lève une erreur (mode strict des modules). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
