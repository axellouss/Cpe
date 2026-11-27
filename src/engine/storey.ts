/**
 * Étages : création à partir d'une feuille lue, premier jet de bâtiment à partir d'un document, mesures en direct.
 * Fonctions pures : rien n'est modifié dans les objets reçus.
 */
import {
  closestOnSegment,
  distance,
  edgeEnds,
  edgeLength,
  lerp,
  polygonArea,
  polygonPerimeter,
  round,
} from '../core/geometry';
import type {
  BuildingModel,
  DetectedOpening,
  Lang,
  Opening,
  PlanDocument,
  PlanSheet,
  Provenance,
  Room,
  Sourced,
  Storey,
  StoreyEdge,
  Vec2,
} from '../core/types';
import { guessStorey } from '../semantics/labels';
import {
  DEFAULT_CLEAR_HEIGHT,
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_GROSS_HEIGHT,
  DEFAULT_WINDOW_HEIGHT,
  defaultBottom,
  emptyModel,
} from './defaults';
import type { StoreyMetrics } from './index';
import { isUnconfirmed, weakest } from './provenance';

/** Part de la surface brute retenue quand la surface nette est inconnue (estimation grossière, à remplacer). */
export const NET_AREA_ESTIMATE_RATIO = 0.8;

/** Une ouverture détectée à plus de 0,60 m du contour (ou 5 % de l'arête) n'est pas rattachée à une façade. */
const OPENING_MAX_DISTANCE_M = 0.6;
const OPENING_MAX_DISTANCE_RATIO = 0.05;

// ───────────────────────────── Surface nette d'un étage ─────────────────────────────

export interface NetArea {
  area: number;
  source: 'override' | 'rooms' | 'estimate';
  from: Provenance;
}

/**
 * Surface nette retenue pour An : la valeur saisie, sinon la somme des pièces chauffées (dès qu'au moins une pièce
 * a une surface), sinon 80 % de la surface brute — estimation à remplacer.
 */
export function netAreaOf(storey: Storey, grossArea: number): NetArea {
  if (storey.netAreaOverride) {
    return { area: Math.max(0, storey.netAreaOverride.value), source: 'override', from: storey.netAreaOverride.from };
  }
  if (storey.rooms.some((r) => r.area.value > 0)) {
    const heated = storey.rooms.filter((r) => r.heated);
    const area = heated.reduce((sum, r) => sum + Math.max(0, r.area.value), 0);
    return { area, source: 'rooms', from: weakest(...heated.map((r) => r.area.from)) };
  }
  return { area: NET_AREA_ESTIMATE_RATIO * grossArea, source: 'estimate', from: 'estimate' };
}

export function storeyMetrics(storey: Storey): StoreyMetrics {
  const s = storey.metresPerUnit.value;
  const grossArea = polygonArea(storey.outline) * s * s;
  const net = netAreaOf(storey, grossArea);
  return {
    grossArea,
    perimeter: polygonPerimeter(storey.outline) * s,
    netArea: net.area,
    netAreaFrom: net.source,
    grossVolume: grossArea * storey.grossHeight.value,
    edgeLengths: storey.outline.map((_, i) => edgeLength(storey.outline, i) * s),
  };
}

// ───────────────────────────── Création d'un étage ─────────────────────────────

/** Identifiant libre de la forme « storey-N » (déterministe : dépend seulement des étages déjà présents). */
function nextStoreyId(model: BuildingModel): string {
  let max = 0;
  for (const s of model.storeys) {
    const m = /^storey-(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `storey-${Math.max(max, model.storeys.length) + 1}`;
}

/** Copie le contour en retirant les points doublons (dont un éventuel point de fermeture répété). */
function copyOutline(points: readonly Vec2[] | undefined): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points ?? []) {
    const last = out[out.length - 1];
    if (!last || distance(last, p) > 1e-9) out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1 && distance(out[0]!, out[out.length - 1]!) <= 1e-9) out.pop();
  return out;
}

/** Arête du contour qui porte l'ouverture détectée : celle dont les DEUX extrémités de l'ouverture sont les plus proches. */
function hostEdge(d: DetectedOpening, outline: readonly Vec2[]): { index: number; distance: number; t: number } | null {
  let best: { index: number; distance: number; t: number } | null = null;
  const mid = lerp(d.a, d.b, 0.5);
  for (let i = 0; i < outline.length; i++) {
    const [p, q] = edgeEnds(outline, i);
    const dist = Math.max(closestOnSegment(d.a, p, q).distance, closestOnSegment(d.b, p, q).distance);
    if (!best || dist < best.distance) best = { index: i, distance: dist, t: closestOnSegment(mid, p, q).t };
  }
  return best;
}

function openingsFromDetection(
  detected: readonly DetectedOpening[],
  outline: readonly Vec2[],
  metresPerUnit: Sourced<number>,
  storeyId: string,
): Opening[] {
  const scale = metresPerUnit.value;
  const openings: Opening[] = [];
  if (outline.length < 3) return openings;
  for (const d of detected) {
    if (d.exterior === false) continue;
    const host = hostEdge(d, outline);
    if (!host) continue;
    const edgeMetres = edgeLength(outline, host.index) * scale;
    if (host.distance * scale > Math.max(OPENING_MAX_DISTANCE_M, OPENING_MAX_DISTANCE_RATIO * edgeMetres)) continue;
    const kind = d.kind === 'door' ? 'door' : 'window';
    const width = round(d.width ?? distance(d.a, d.b) * scale, 3);
    if (!(width > 0)) continue;
    const height = d.height ?? (kind === 'door' ? DEFAULT_DOOR_HEIGHT : DEFAULT_WINDOW_HEIGHT);
    // Largeur mesurée sur la feuille avec une échelle non confirmée : simple estimation, que `rescaleStorey` corrigera.
    const widthIsGuess = d.width === undefined && isUnconfirmed(metresPerUnit.from);
    openings.push({
      id: `${storeyId}-o${openings.length + 1}`,
      edgeIndex: host.index,
      kind,
      width,
      height: round(height, 3),
      count: 1,
      position: host.t,
      windowTypeId: null,
      // La hauteur se lit rarement sur un plan : sans elle, l'ouverture reste « à confirmer ».
      from: widthIsGuess ? 'estimate' : d.height === undefined ? 'default' : 'plan',
    });
  }
  return openings;
}

export function createStorey(sheet: PlanSheet | null, name: string, model: BuildingModel): Storey {
  const id = nextStoreyId(model);
  if (!sheet) {
    return {
      id,
      name,
      sheetId: null,
      outline: [],
      edges: [],
      metresPerUnit: { value: 1, from: 'user' },
      grossHeight: { value: DEFAULT_GROSS_HEIGHT, from: 'default' },
      clearHeight: { value: DEFAULT_CLEAR_HEIGHT, from: 'default' },
      openings: [],
      rooms: [],
      netAreaOverride: null,
    };
  }

  const detected = sheet.detected;
  const outline = copyOutline(detected.outline);
  const metresPerUnit: Sourced<number> = sheet.metresPerUnit ? { ...sheet.metresPerUnit } : { value: 1, from: 'estimate' };
  const edges: StoreyEdge[] = outline.map(() => ({ boundary: 'outside', constructionId: null }));

  const rooms: Room[] = detected.rooms.map((r, i) => {
    const area = r.statedArea ?? r.measuredArea ?? 0;
    const room: Room = {
      id: `${id}-r${i + 1}`,
      name: r.name,
      area: { value: area, from: area > 0 ? 'plan' : 'default' },
      heated: r.heatedGuess === 'yes',
      needsReview: r.heatedGuess === 'ask' || !(area > 0),
    };
    if (r.polygon) room.polygon = r.polygon.map((p) => ({ x: p.x, y: p.y }));
    if (r.at) room.at = { x: r.at.x, y: r.at.y };
    return room;
  });

  return {
    id,
    name,
    sheetId: sheet.id,
    outline,
    edges,
    metresPerUnit,
    grossHeight:
      detected.storeyHeight !== undefined
        ? { value: detected.storeyHeight, from: 'plan' }
        : { value: DEFAULT_GROSS_HEIGHT, from: 'default' },
    clearHeight:
      detected.clearHeight !== undefined
        ? { value: detected.clearHeight, from: 'plan' }
        : { value: DEFAULT_CLEAR_HEIGHT, from: 'default' },
    openings: openingsFromDetection(detected.openings, outline, metresPerUnit, id),
    rooms,
    netAreaOverride: null,
  };
}

/**
 * Applique une nouvelle échelle à un étage (« poser la règle »). Les largeurs d'ouvertures mesurées sur la feuille
 * avec l'ancienne échelle NON CONFIRMÉE (marquées 'estimate' par `createStorey`) suivent la nouvelle et deviennent
 * « à confirmer ». Les autres (lues dans un texte, saisies par l'expert) ne bougent pas. Renvoie un nouvel étage.
 */
export function rescaleStorey(storey: Storey, metresPerUnit: Sourced<number>): Storey {
  const old = storey.metresPerUnit.value;
  const ratio = old > 0 && metresPerUnit.value > 0 ? metresPerUnit.value / old : 1;
  return {
    ...storey,
    metresPerUnit: { ...metresPerUnit },
    openings: storey.openings.map((o): Opening =>
      o.from === 'estimate' ? { ...o, width: round(o.width * ratio, 3), from: isUnconfirmed(metresPerUnit.from) ? 'estimate' : 'default' } : { ...o },
    ),
  };
}

// ───────────────────────────── Premier jet à partir d'un document ─────────────────────────────

interface Candidate {
  sheet: PlanSheet;
  docIndex: number;
  elevation: number | undefined;
  guess: { fr: string; de: string; rank: number } | null;
}

/** Ordre du bas vers le haut : altitudes si toutes connues, sinon rangs des noms si tous reconnus, sinon ordre du document. */
function sortBottomUp(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates];
  if (sorted.every((c) => c.elevation !== undefined)) {
    sorted.sort((a, b) => a.elevation! - b.elevation! || a.docIndex - b.docIndex);
  } else if (sorted.every((c) => c.guess !== null)) {
    sorted.sort((a, b) => a.guess!.rank - b.guess!.rank || a.docIndex - b.docIndex);
  }
  return sorted;
}

function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function modelFromDocument(doc: PlanDocument, lang: Lang): BuildingModel {
  const model = emptyModel(lang);
  model.storeysAligned = doc.storeysAligned;
  if (doc.northAngle) model.northAngle = { ...doc.northAngle };

  let hasBasement = false;
  const candidates: Candidate[] = [];
  doc.sheets.forEach((sheet, docIndex) => {
    const guess = guessStorey(sheet.name);
    if (guess && guess.rank < 0) {
      // Sous-sol reconnu : hors volume chauffé par défaut → le premier étage chauffé repose sur un local non chauffé.
      hasBasement = true;
      return;
    }
    if ((sheet.detected.outline?.length ?? 0) < 3) return;
    candidates.push({ sheet, docIndex, elevation: sheet.detected.elevation, guess });
  });

  // Nom du niveau dans la langue demandée quand il est reconnu ; si deux feuilles donnent le même niveau
  // (« Étage aile A », « Étage aile B »), leurs propres noms sont plus parlants.
  const sorted = sortBottomUp(candidates);
  const proposed = sorted.map((c) => (c.guess ? c.guess[lang] : c.sheet.name));
  const taken = new Set<string>();
  sorted.forEach((c, i) => {
    const shared = proposed.filter((n) => n === proposed[i]).length > 1;
    const name = uniqueName(shared ? c.sheet.name : proposed[i]!, taken);
    taken.add(name);
    model.storeys.push(createStorey(c.sheet, name, model));
  });
  if (hasBasement) model.bottom = defaultBottom('above-unheated');
  return model;
}
