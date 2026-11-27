/**
 * Étages : création à partir d'une feuille lue, premier jet de bâtiment à partir d'un document, mesures en direct.
 * Fonctions pures : rien n'est modifié dans les objets reçus.
 */
import {
  centroid,
  closestOnSegment,
  distance,
  edgeEnds,
  extentAlong,
  longestEdgeAngle,
  radToDeg,
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
  TopClosure,
  Vec2,
} from '../core/types';
import { guessStorey, isRoofLevelName } from '../semantics/labels';
import {
  DEFAULT_CLEAR_HEIGHT,
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_GROSS_HEIGHT,
  DEFAULT_WINDOW_HEIGHT,
  defaultBottom,
  defaultTop,
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
  // Une surface non finie (NaN) compte pour zéro : elle ne doit pas contaminer An.
  const positive = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);
  if (storey.netAreaOverride) {
    return { area: positive(storey.netAreaOverride.value), source: 'override', from: storey.netAreaOverride.from };
  }
  if (storey.rooms.some((r) => r.area.value > 0)) {
    const heated = storey.rooms.filter((r) => r.heated);
    const area = heated.reduce((sum, r) => sum + positive(r.area.value), 0);
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
    const drawn = distance(d.a, d.b);
    const width = round(d.width ?? drawn * scale, 3);
    if (!(width > 0)) continue;
    const height = d.height ?? (kind === 'door' ? DEFAULT_DOOR_HEIGHT : DEFAULT_WINDOW_HEIGHT);
    // Largeur mesurée sur la feuille avec une échelle non confirmée : simple estimation, que `rescaleStorey` corrigera.
    const widthIsGuess = d.width === undefined && isUnconfirmed(metresPerUnit.from);
    // Largeur donnée par le lecteur mais égale au tracé (à 2 % près) : c'est une mesure à SON échelle, pas un texte
    // lu — elle doit suivre une correction d'échelle. Une largeur lue (« F 120/135 ») ne suit pas.
    const measured = d.width === undefined || (drawn > 0 && Math.abs(d.width - drawn * scale) <= MEASURED_WIDTH_TOLERANCE * d.width);
    const opening: Opening = {
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
    };
    if (measured && drawn > 0) opening.sheetWidth = d.width === undefined ? drawn : d.width / scale;
    openings.push(opening);
  }
  return openings;
}

/**
 * Murs de hauteurs inégales au dernier niveau : en dessous de cette hauteur de mur bas (m), ce sont des combles
 * sous toiture inclinée (jambette) ; au-dessus, un étage plein dont seuls pignons ou acrotères dépassent.
 */
const ATTIC_MAX_EAVES = 2.0;

/** Épaisseur minimale d'un plancher ou d'un plafond entre la hauteur libre et la hauteur brute (m). */
const MIN_SLAB = 0.2;

/** Hauteur d'étage à proposer quand les murs du dernier niveau ont des hauteurs inégales (toujours « à confirmer »). */
function unevenStoreyHeight(ridge: number, eaves: number, clear: number | undefined): number {
  if (eaves < ATTIC_MAX_EAVES) return ridge;
  // Le plus bas sommet de mur, sauf s'il ne laisse pas la place d'un plafond au-dessus de la hauteur libre.
  return clear !== undefined && eaves < clear + MIN_SLAB ? ridge : eaves;
}

/** Écart relatif au-delà duquel la surface écrite et la surface mesurée d'une pièce ne disent plus la même chose. */
const ROOM_AREA_MISMATCH = 0.05;

/**
 * Surface d'une pièce : celle écrite sur le plan quand elle concorde avec la mesure (l'expert peut la relire sur
 * le plan). Quand elles divergent de plus de 5 %, la surface écrite suit une autre règle que celle de An —
 * surface habitable au-dessus de 1,80 ou 2,00 m sous rampant, typiquement — et c'est la mesure (faces intérieures,
 * hauteur libre ≥ 1,00 m quand le lecteur la connaît) qui est retenue, avec les deux valeurs en note.
 */
function pickRoomArea(
  stated: number | undefined,
  measured: number | undefined,
): { value: number; note?: string; measured: boolean } {
  const s = stated !== undefined && stated > 0 ? stated : undefined;
  const m = measured !== undefined && measured > 0 ? measured : undefined;
  if (s !== undefined && m !== undefined && Math.abs(s - m) / m > ROOM_AREA_MISMATCH) {
    return { value: round(m, 2), note: `${round(s, 2)} / ${round(m, 2)}`, measured: true };
  }
  return { value: s ?? m ?? 0, measured: s === undefined && m !== undefined };
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
    const picked = pickRoomArea(r.statedArea, r.measuredArea);
    const area = picked.value;
    const room: Room = {
      id: `${id}-r${i + 1}`,
      name: r.name,
      area: picked.note ? { value: area, from: 'plan', note: picked.note } : { value: area, from: area > 0 ? 'plan' : 'default' },
      heated: r.heatedGuess === 'yes',
      needsReview: r.heatedGuess === 'ask' || !(area > 0),
    };
    // Surface mesurée sur le dessin : on garde sa valeur en unités de feuille, pour qu'elle suive une correction d'échelle.
    if (picked.measured && metresPerUnit.value > 0) room.sheetArea = area / (metresPerUnit.value * metresPerUnit.value);
    if (r.polygon) room.polygon = r.polygon.map((p) => ({ x: p.x, y: p.y }));
    if (r.at) room.at = { x: r.at.x, y: r.at.y };
    return room;
  });

  const roofWindows = (detected.roofWindows ?? []).filter((w) => w.width > 0 && w.height > 0).map((w) => ({ width: w.width, height: w.height }));
  return {
    ...(roofWindows.length > 0 ? { roofWindows } : {}),
    id,
    name,
    sheetId: sheet.id,
    outline,
    edges,
    metresPerUnit,
    grossHeight:
      detected.storeyHeight === undefined
        ? { value: DEFAULT_GROSS_HEIGHT, from: 'default' }
        : detected.eavesHeight === undefined
          ? // Mesurée jusqu'au sommet des murs seulement (dernier niveau d'une maquette) : il manque la toiture.
            { value: detected.storeyHeight, from: detected.storeyHeightToWallTop ? 'estimate' : 'plan' }
          : // Murs de hauteurs inégales : ni le faîtage ni un acrotère ne sont une hauteur d'étage. Sous des combles
            // (murs bas), la valeur ne sert que si l'expert écarte la toiture inclinée ; sinon on retient le plus
            // bas sommet de mur. Dans les deux cas : à confirmer.
            { value: unevenStoreyHeight(detected.storeyHeight, detected.eavesHeight, detected.clearHeight), from: 'estimate' },
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

/** Écart relatif en deçà duquel une largeur donnée par le lecteur est reconnue comme « mesurée sur le tracé ». */
const MEASURED_WIDTH_TOLERANCE = 0.02;

/**
 * Applique une nouvelle échelle à un étage (« poser la règle »). Tout ce qui a été MESURÉ sur la feuille avec
 * l'ancienne échelle suit la nouvelle :
 *  - les largeurs d'ouvertures mesurées sur le dessin (`sheetWidth`), tant que l'expert ne les a pas saisies ;
 *  - les surfaces de pièces mesurées sur le dessin (`sheetArea`), tant que l'expert ne les a pas saisies.
 * Ne bougent pas : les valeurs saisies par l'expert, et les surfaces écrites sur le plan (elles ne dépendent pas
 * de l'échelle). Une largeur seulement estimée (échelle non confirmée) devient « à confirmer ». Renvoie un nouvel étage.
 */
export function rescaleStorey(storey: Storey, metresPerUnit: Sourced<number>): Storey {
  const old = storey.metresPerUnit.value;
  const next = metresPerUnit.value;
  const changed = old > 0 && next > 0 && Math.abs(next / old - 1) > 1e-9;
  return {
    ...storey,
    metresPerUnit: { ...metresPerUnit },
    openings: storey.openings.map((o): Opening => {
      if (o.from === 'user') return { ...o };
      const from = o.from === 'estimate' ? (isUnconfirmed(metresPerUnit.from) ? 'estimate' : 'default') : o.from;
      // Seules les largeurs mesurées sur le dessin dépendent de l'échelle.
      const width = o.sheetWidth !== undefined && next > 0 ? round(o.sheetWidth * next, 3) : o.width;
      return { ...o, width, from };
    }),
    rooms: storey.rooms.map((r): Room => {
      // Seules les surfaces mesurées sur le dessin (`sheetArea`) dépendent de l'échelle ; une surface écrite sur le
      // plan ne bouge pas, même si elle vaut à peu près l'aire du polygone.
      if (!changed || r.area.from === 'user' || r.sheetArea === undefined) return r;
      return { ...r, area: { ...r.area, value: round(r.sheetArea * next * next, 2) } };
    }),
  };
}

// ───────────────────────────── Premier jet à partir d'un document ─────────────────────────────

/** En dessous, une feuille n'est proposée comme étage que si elle est seule (m²). */
const MIN_STOREY_AREA = 12;
/** … ou si elle pèse au moins cette part de la plus grande feuille. */
const MIN_STOREY_SHARE = 0.1;

function sheetFootprintArea(sheet: PlanSheet): number {
  const outline = sheet.detected.outline;
  if (!outline || outline.length < 3) return 0;
  const scale = sheet.metresPerUnit?.value ?? 1;
  return polygonArea(outline) * scale * scale;
}

interface Candidate {
  sheet: PlanSheet;
  docIndex: number;
  elevation: number | undefined;
  guess: { fr: string; de: string; rank: number } | null;
}

/**
 * Ordre du bas vers le haut : altitudes si toutes connues ; sinon les niveaux reconnus à leur nom, par rang, et
 * au-dessus d'eux les feuilles au nom inconnu, dans l'ordre du document (un « Plan 3 » ne doit pas faire perdre
 * l'ordre du rez-de-chaussée et de l'étage).
 */
function sortBottomUp(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates];
  if (sorted.every((c) => c.elevation !== undefined)) {
    sorted.sort((a, b) => a.elevation! - b.elevation! || a.docIndex - b.docIndex);
  } else if (sorted.some((c) => c.guess !== null)) {
    const rank = (c: Candidate): number => (c.guess ? c.guess.rank : Number.POSITIVE_INFINITY);
    sorted.sort((a, b) => (rank(a) === rank(b) ? a.docIndex - b.docIndex : rank(a) < rank(b) ? -1 : 1));
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

/** Vrai si le nom de la feuille désigne un sous-sol (rang ≤ −1) ; un rez-de-jardin est un niveau habité. */
export function isBasementSheetName(name: string): boolean {
  const guess = guessStorey(name);
  return guess !== null && guess.rank <= -1;
}

/** Un niveau d'une maquette situé au moins aussi bas sous le niveau de référence est tenu pour enterré (m). */
const UNDERGROUND_DROP = 1.5;
/** Le niveau de référence (± 0,00) doit être à moins de cela de zéro pour que les altitudes soient parlantes (m). */
const GROUND_REFERENCE_MAX = 0.6;

/**
 * Feuilles à proposer NON chauffées d'office : sous-sols reconnus à leur nom, et — quand toutes les feuilles
 * portent une altitude (maquette IFC) — niveaux situés au moins 1,50 m sous le niveau le plus proche de ± 0,00
 * (« -1 - Garage » à −2,50 m), quel que soit leur nom. L'expert peut toujours les cocher.
 */
export function basementSheetIds(sheets: readonly PlanSheet[]): Set<string> {
  const ids = new Set(sheets.filter((s) => isBasementSheetName(s.name)).map((s) => s.id));
  const levels = sheets.filter((s) => s.detected.elevation !== undefined);
  if (levels.length >= 2 && levels.length === sheets.length) {
    const ground = levels.reduce((best, s) => (Math.abs(s.detected.elevation!) < Math.abs(best.detected.elevation!) ? s : best));
    const zero = ground.detected.elevation!;
    if (Math.abs(zero) <= GROUND_REFERENCE_MAX) {
      for (const s of levels) if (s.detected.elevation! <= zero - UNDERGROUND_DROP) ids.add(s.id);
    }
  }
  return ids;
}

/**
 * Range des feuilles du bas vers le haut avec la règle du premier jet : altitudes si toutes connues, sinon rang
 * des noms reconnus puis feuilles au nom inconnu dans l'ordre reçu.
 */
export function orderSheetsBottomUp<T extends PlanSheet>(sheets: readonly T[]): T[] {
  const candidates: Candidate[] = sheets.map((sheet, docIndex) => ({
    sheet,
    docIndex,
    elevation: sheet.detected.elevation,
    guess: guessStorey(sheet.name),
  }));
  return sortBottomUp(candidates).map((c) => c.sheet as T);
}

export function modelFromDocument(doc: PlanDocument, lang: Lang): BuildingModel {
  const model = emptyModel(lang);
  model.storeysAligned = doc.storeysAligned;
  if (doc.northAngle) model.northAngle = { ...doc.northAngle };

  let hasBasement = false;
  const basements = basementSheetIds(doc.sheets);
  const candidates: Candidate[] = [];
  doc.sheets.forEach((sheet, docIndex) => {
    const guess = guessStorey(sheet.name);
    // Rang ≤ −1 : sous-sol. Un rez-de-jardin (−0,5) est un niveau habité : il reste un étage chauffé.
    if (basements.has(sheet.id)) {
      // Sous-sol reconnu : hors volume chauffé par défaut → le premier étage chauffé repose sur un local non chauffé.
      hasBasement = true;
      return;
    }
    if ((sheet.detected.outline?.length ?? 0) < 3) return;
    // Un plan de toiture (« Roof Line », « Dachaufsicht ») n'est pas un étage.
    if (!guess && isRoofLevelName(sheet.name)) return;
    candidates.push({ sheet, docIndex, elevation: sheet.detected.elevation, guess });
  });

  // Une feuille minuscule à côté des autres (édicule, lanterneau, détail pris pour un plan) n'est pas un étage.
  const footprints = candidates.map((c) => sheetFootprintArea(c.sheet));
  const largest = Math.max(0, ...footprints);
  const kept = candidates.filter((_, i) => footprints[i]! >= Math.min(MIN_STOREY_AREA, largest) && footprints[i]! >= MIN_STOREY_SHARE * largest);
  candidates.length = 0;
  candidates.push(...kept);

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

  const proposedTop = proposeTopClosure(sorted[sorted.length - 1]?.sheet ?? null, model.storeys[model.storeys.length - 1] ?? null);
  if (proposedTop) model.top = proposedTop;
  return model;
}

/**
 * Fermeture haute proposée d'après la feuille du dernier étage : quand ses murs ont des hauteurs inégales et que le
 * plus bas est une jambette (combles), une toiture inclinée à deux pans avec sa jambette et sa pente, À CONFIRMER
 * (provenance 'estimate'). null s'il n'y a rien à proposer : l'appelant garde sa fermeture.
 */
export function proposeTopClosure(sheet: PlanSheet | null, topStorey: Storey | null): TopClosure | null {
  const top = sheet?.detected;
  if (!top || !topStorey || top.eavesHeight === undefined || top.storeyHeight === undefined) return null;
  const rise = top.storeyHeight - top.eavesHeight;
  const scale = topStorey.metresPerUnit.value;
  const span = extentAlong(topStorey.outline, longestEdgeAngle(topStorey.outline)).across * scale;
  if (!(rise > 0.5 && span > 1 && top.eavesHeight < ATTIC_MAX_EAVES)) return null;
  const pitch = radToDeg(Math.atan2(rise, span / 2));
  return {
    ...defaultTop(),
    kind: 'pitched-roof',
    shape: 'gable',
    pitchDeg: Math.round(Math.min(70, Math.max(5, pitch))),
    kneeWallHeight: round(Math.max(0, top.eavesHeight), 2),
    from: 'estimate',
  };
}
