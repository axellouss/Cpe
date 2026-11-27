/**
 * Étages : création à partir d'une feuille lue, premier jet de bâtiment à partir d'un document, mesures en direct.
 * Fonctions pures : rien n'est modifié dans les objets reçus.
 */
import {
  centroid,
  closestOnSegment,
  distance,
  edgeEnds,
  edgeLength,
  lerp,
  pointInPolygon,
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
import { ON_OUTLINE_TOL_M, proposeHeatedOutline, remapOpenings } from './heatedOutline';
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
  const footprint = copyOutline(detected.outline);
  const metresPerUnit: Sourced<number> = sheet.metresPerUnit ? { ...sheet.metresPerUnit } : { value: 1, from: 'estimate' };
  // Les lecteurs donnent l'emprise de tout le bâtiment dessiné. Le contour CHAUFFÉ proposé en retire les annexes
  // hors enveloppe par nature (garage accolé…) ; sans échelle lue, on ne retire rien (les seuils sont en mètres).
  const proposal = sheet.metresPerUnit ? proposeHeatedOutline(footprint, detected.rooms, metresPerUnit.value) : null;
  const carved = proposal && proposal.removed.length > 0 ? proposal : null;
  const outline = carved ? carved.outline : footprint;
  const edges: StoreyEdge[] = carved
    ? carved.boundaries.map((boundary) => ({ boundary, constructionId: null }))
    : outline.map(() => ({ boundary: 'outside', constructionId: null }));
  // Les ouvertures sont d'abord posées sur l'emprise, puis reportées : celles de l'annexe retirée disparaissent.
  const footprintOpenings = openingsFromDetection(detected.openings, footprint, metresPerUnit, id);
  const openings = carved
    ? remapOpenings(footprintOpenings, footprint, carved.outline, carved.sources, ON_OUTLINE_TOL_M / metresPerUnit.value)
    : footprintOpenings;

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
    openings,
    rooms,
    netAreaOverride: null,
  };
}

/** Arête du contour qui passe par le point `at` (à `tol` près), avec la position du point le long de l'arête. */
function edgeThrough(at: Vec2, outline: readonly Vec2[], tol: number): { index: number; t: number } | null {
  let best: { index: number; t: number; distance: number } | null = null;
  for (let i = 0; i < outline.length; i++) {
    const [p, q] = edgeEnds(outline, i);
    const cl = closestOnSegment(at, p, q);
    if (cl.distance <= tol && (!best || cl.distance < best.distance)) best = { index: i, t: cl.t, distance: cl.distance };
  }
  return best ? { index: best.index, t: best.t } : null;
}

function pointOnEdge(outline: readonly Vec2[], index: number, t: number): Vec2 {
  const [p, q] = edgeEnds(outline, index);
  return lerp(p, q, t);
}

/**
 * Locaux de l'étage (avec polygone) qui se trouvent dans l'emprise lue sur la feuille mais HORS du contour de
 * l'étage : ce sont ceux que le contour chauffé proposé a laissés dehors (garage accolé…).
 */
export function roomsOutsideOutline(storey: Storey, sheet: PlanSheet | null): Room[] {
  const footprint = copyOutline(sheet?.detected.outline);
  if (footprint.length < 3 || storey.outline.length < 3) return [];
  return storey.rooms.filter((r) => {
    if (!r.polygon || r.polygon.length < 3) return false;
    const c = centroid(r.polygon);
    return pointInPolygon(c, footprint) && !pointInPolygon(c, storey.outline);
  });
}

/**
 * Remet dans le contour TOUTE l'emprise lue sur la feuille (l'expert juge que le garage est dans l'enveloppe).
 * Les arêtes qui longeaient déjà le contour gardent leur nature et leur type de mur ; les ouvertures suivent ;
 * celles que le lecteur avait vues sur la partie réintégrée (porte du garage) reviennent. Les pièces ne changent
 * pas : un local réintégré mais non compté dans An sera signalé par le constat « outline.containsUnheated ».
 * Renvoie null si la feuille n'a pas d'emprise.
 */
export function restoreFootprint(storey: Storey, sheet: PlanSheet | null): Storey | null {
  const footprint = copyOutline(sheet?.detected.outline);
  const scale = storey.metresPerUnit.value;
  if (!sheet || footprint.length < 3 || !(scale > 0)) return null;
  const tol = ON_OUTLINE_TOL_M / scale;

  const edges: StoreyEdge[] = footprint.map((_, i) => {
    // L'arête actuelle qui passe par le milieu de cette arête de l'emprise lui transmet nature et type de mur.
    const through = edgeThrough(pointOnEdge(footprint, i, 0.5), storey.outline, tol);
    const old = through ? storey.edges[through.index] : undefined;
    return old ? { ...old } : { boundary: 'outside', constructionId: null };
  });

  const openings: Opening[] = [];
  for (const o of storey.openings) {
    if (o.edgeIndex < 0 || o.edgeIndex >= storey.outline.length) continue;
    const host = edgeThrough(pointOnEdge(storey.outline, o.edgeIndex, o.position), footprint, tol);
    if (host) openings.push({ ...o, edgeIndex: host.index, position: host.t });
  }
  const taken = new Set(storey.openings.map((o) => o.id));
  for (const o of openingsFromDetection(sheet.detected.openings, footprint, storey.metresPerUnit, storey.id)) {
    // Déjà portée par le contour actuel : présente, ou supprimée exprès par l'expert — on n'y touche pas.
    if (edgeThrough(pointOnEdge(footprint, o.edgeIndex, o.position), storey.outline, tol)) continue;
    let n = openings.length + 1;
    let id = `${storey.id}-o${n}`;
    while (taken.has(id)) id = `${storey.id}-o${++n}`;
    taken.add(id);
    openings.push({ ...o, id });
  }
  return { ...storey, outline: footprint, edges, openings };
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
