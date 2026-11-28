/**
 * Bâtiment construit AUTOMATIQUEMENT à partir de la lecture d'une planche, et réponses aux questions de doute :
 * le contrat entre le moteur et l'interface du parcours « dépôt → lecture → doutes → dossier ».
 *
 * Principe : tout ce que la lecture donne avec assez de confiance entre dans le projet sans rien demander
 * (étages et contours chauffés, pièces, baies, hauteurs, toiture, parois et couches, identité du projet,
 * installations proposées) ; ce qui reste douteux devient une question (voir engine/doubts.ts). L'expert peut
 * toujours corriger sur le plan.
 *
 * PROPOSÉ ≠ CONFIRMÉ : rien de ce que l'outil met dans le projet ne porte la provenance 'user'. Les réponses du
 * questionnaire qu'il propose sont listées dans `answers.proposed` (confiance et source citée) : collectDoubts ne
 * les tient jamais pour tranchées. Une valeur déjà confirmée par l'utilisateur dans `base` n'est jamais écrasée.
 *
 * Chaque règle a un repli : sans contour chauffé lu, le contour se déduit de l'emprise et des pièces (chemin
 * historique, engine/storey) ; sans niveaux, les hauteurs du lecteur ou les valeurs par défaut (marquées telles) ;
 * sans composition, une paroi sans couches (U à définir) que la question « matériaux » signale.
 *
 * Fonction pure : le document et le projet reçus ne sont jamais modifiés.
 */
import {
  bboxOf,
  centroid,
  closestOnSegment,
  distance,
  edgeEnds,
  edgeLength,
  extentAlong,
  lerp,
  longestEdgeAngle,
  pointInPolygon,
  polygonArea,
  radToDeg,
  round,
} from '../core/geometry';
import { CONFIDENCE_SINGLE_SOURCE, type ElementType, type ReadComposition, type ReadLevels, type SheetReading } from '../core/reading';
import type {
  BottomClosure,
  BuildingModel,
  Construction,
  DetectedOpening,
  DetectedRoom,
  Lang,
  Opening,
  PlanDocument,
  PlanSheet,
  Project,
  ProjectAnswers,
  Provenance,
  Room,
  Sourced,
  Storey,
  StoreyEdge,
  TopClosure,
  Vec2,
} from '../core/types';
import { formatNumber, t } from '../i18n';
import { guessStorey, isRoofLevelName } from '../semantics/labels';
import { DEFAULT_CONSTRUCTION_IDS, DEFAULT_DOOR_HEIGHT, DEFAULT_WINDOW_HEIGHT, defaultBottom, defaultTop, emptyModel } from './defaults';
import { envelopeHeights, facadeViewsFromReading, withExpertWindowTypes } from './derive';
import { collectDoubts, isPlanDoubt, type Doubt } from './doubts';
import {
  constructionFromComposition,
  doorHypothesis,
  dominantInsulation,
  emptyOfficeLibrary,
  isEnvelopeComposition,
  officeLibraryFromConstructions,
} from './materials';
import './messages';
import { isUnconfirmed, type OpeningHeights } from './provenance';
import { basementSheetIds, createStorey, modelFromDocument, orderSheetsBottomUp, pickRoomArea } from './storey';
import { proposeHeatedOutline } from './heatedOutline';
import { partyEvidence, readsDetached } from './party';

export { applyDoubtAnswer, DOUBT_CONFIRM, DOUBT_UNKNOWN } from './doubtAnswer';

export interface AutoBuild {
  project: Project;
  /**
   * Vrai si la lecture suffit pour le parcours « cartes de doute » : au moins un plan d'étage lu avec son contour
   * et une échelle sûre, une fermeture haute et basse proposées. Faux → parcours guidé sur le plan (repli).
   */
  sufficient: boolean;
  /** Feuilles retenues comme étages chauffés, du bas vers le haut (PlanSheet.id). */
  storeySheetIds: string[];
  /** Pourquoi la lecture ne suffit pas, ou ce qui a été écarté (phrases courtes, dans la langue demandée). */
  notes: string[];
}

/** Au-delà de ce nombre de questions SUR LE PLAN (hors valeurs d'usage), parcours guidé. */
export const MAX_AUTO_DOUBTS = 8;

/** Identifiant du type « porte vers un local non chauffé » (la porte d'entrée garde le type de porte par défaut). */
export const DOOR_UNHEATED_ID = 'door-unheated';

/** Une ouverture lue à plus de 0,60 m du contour (ou 5 % de l'arête) n'est pas portée par cette façade. */
const OPENING_MAX_DISTANCE_M = 0.6;
const OPENING_MAX_DISTANCE_RATIO = 0.05;
/** Feuille minuscule à côté des autres : pas un étage (mêmes seuils que le premier jet historique). */
const MIN_STOREY_AREA = 12;
const MIN_STOREY_SHARE = 0.1;
/** Deux emprises de même taille à 2 % près : l'alignement par leurs boîtes est sûr. */
const SAME_SIZE_TOL = 0.02;
/** Écart toléré entre surface écrite et mesurée d'une pièce (au-delà, la note garde les deux). */
const ROOM_AREA_MISMATCH = 0.05;

/** Rôle lu d'une composition → type par défaut qu'elle habille (null : paroi hors enveloppe). */
const DEFAULT_ID_OF_ELEMENT: Partial<Record<ElementType, string>> = {
  'external-wall': DEFAULT_CONSTRUCTION_IDS.wallOutside,
  'wall-to-unheated': DEFAULT_CONSTRUCTION_IDS.wallUnheated,
  'wall-to-ground': DEFAULT_CONSTRUCTION_IDS.wallGround,
  'floor-on-ground': DEFAULT_CONSTRUCTION_IDS.floorGround,
  'floor-to-unheated': DEFAULT_CONSTRUCTION_IDS.floorUnheated,
  'floor-to-outside': DEFAULT_CONSTRUCTION_IDS.floorOutside,
  roof: DEFAULT_CONSTRUCTION_IDS.roof,
  'ceiling-to-unheated': DEFAULT_CONSTRUCTION_IDS.ceiling,
};

const isFloorPlan = (s: PlanSheet): boolean => !s.role || s.role === 'floor-plan';
const finite = (p: Vec2): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
const validScale = (s: PlanSheet): boolean => s.metresPerUnit !== null && Number.isFinite(s.metresPerUnit.value) && s.metresPerUnit.value > 0;

/** Copie d'un polygone sans doublons ni point de fermeture répété ; [] s'il est inutilisable. */
function cleanPoly(points: readonly Vec2[] | undefined): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points ?? []) {
    if (!finite(p)) return [];
    const last = out[out.length - 1];
    if (!last || distance(last, p) > 1e-9) out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1 && distance(out[0]!, out[out.length - 1]!) <= 1e-9) out.pop();
  return out.length >= 3 && polygonArea(out) > 0 ? out : [];
}

/** Vrai si la réponse de `base` a été donnée (ou confirmée) par l'utilisateur : elle n'est jamais écrasée. */
function confirmedInBase(base: ProjectAnswers, key: keyof ProjectAnswers): boolean {
  const v = base[key];
  if (v === null || v === undefined || v === '') return false;
  return !(base.proposed && Object.prototype.hasOwnProperty.call(base.proposed, key));
}

// ───────────────────────────── Projet automatique ─────────────────────────────

/**
 * Construit le projet à partir d'un document lu. `base` fournit ce que l'utilisateur a déjà saisi (réponses,
 * bibliothèque du bureau) : une valeur confirmée par lui n'est jamais écrasée par la lecture.
 */
export function buildAutoProject(doc: PlanDocument, base: Project, lang: Lang): AutoBuild {
  const reading = doc.reading;
  const hasHeatedOutline = doc.sheets.some((s) => isFloorPlan(s) && cleanPoly(s.detected.heatedOutline).length >= 3);
  // Document sans lecture de planche (IFC, DXF, image) : chemin historique, résultat inchangé.
  if (!reading && !hasHeatedOutline) {
    const model = modelFromDocument(doc, lang);
    return {
      project: { ...base, model },
      sufficient: false,
      storeySheetIds: model.storeys.map((s) => s.sheetId).filter((id): id is string => id !== null),
      notes: [t(lang, 'auto.note.legacy')],
    };
  }

  const notes: string[] = [];
  const model = emptyModel(lang);
  model.storeysAligned = doc.storeysAligned;
  const built = buildStoreys(doc, lang, notes);
  model.storeys = built.storeys;
  if (built.basements.length > 0) model.unheatedStoreys = built.basements;
  if (!doc.storeysAligned) assignOffsets(model.storeys, doc.sheets, reading);
  applyFloorOverUnheated(model.storeys, reading, lang);
  applyHeights(model, built, reading, base.model.heightConvention ?? 'external', lang);
  keepConfirmedStoreys(model.storeys, base.model.storeys);

  model.top = proposeTop(model, reading, built) ?? defaultTop();
  model.bottom = proposeBottom(reading, built, doc);
  model.northAngle = proposeNorth(doc, reading, lang);
  model.constructions = proposeConstructions(base, reading, model.storeys, lang);

  const views = facadeViewsFromReading(reading, lang).map((v) => {
    const e = reading?.elevations.find((x) => x.viewId === v.viewId);
    return e?.planSideDeg ? { ...v, planSideDeg: e.planSideDeg.value } : v;
  });
  if (views.length > 0) model.facadeViews = views;
  model.envelopeOrder = base.model.envelopeOrder ?? 'expert';
  if (base.model.heightConvention) model.heightConvention = base.model.heightConvention;

  // Ce que l'utilisateur a déjà confirmé dans `base` l'emporte sur la lecture.
  if (base.model.top.from === 'user') model.top = { ...base.model.top };
  if (base.model.bottom.from === 'user') model.bottom = { ...base.model.bottom };
  if (base.model.northAngle.from === 'user') model.northAngle = { ...base.model.northAngle };
  if (base.model.manualRows.length > 0) model.manualRows = base.model.manualRows.map((m) => ({ ...m }));

  let withTypes = withExpertWindowTypes(model, lang);
  const confirmedTypes = base.model.windowTypes.filter((w) => w.uw?.from === 'user' || [w.ug, w.uf, w.psiG].every((x) => x?.from === 'user'));
  if (confirmedTypes.length > 0) {
    withTypes = {
      ...withTypes,
      windowTypes: [...withTypes.windowTypes.filter((w) => !confirmedTypes.some((c) => c.id === w.id)), ...confirmedTypes.map((c) => ({ ...c }))],
    };
  }

  const answers = proposeAnswers(base.answers, reading, doc.sheets, lang);
  const resolved = keptResolutions(base, model.storeys);
  if (resolved) answers.resolvedDoubts = resolved;
  else delete answers.resolvedDoubts;
  const project: Project = { version: 2, model: withTypes, answers };

  // ── Le parcours par cartes de doute est-il possible ? ──
  const doubts: Doubt[] = collectDoubts(reading, project, doc.sheets, lang);
  const reasons: string[] = [];
  // Échelle sûre : lue (cartouche, cote) ou seulement supposée mais recoupée par les surfaces écrites ou les cotes
  // hors tout (le moteur de doutes ne pose alors pas la question de l'échelle).
  const scaleDoubt = doubts.some((d) => d.id === 'scale');
  const scaleOk = built.storeys.some((s) => {
    const sheet = doc.sheets.find((x) => x.id === s.sheetId);
    return sheet !== undefined && built.fromReader.has(s.id) && validScale(sheet) && (!isUnconfirmed(sheet.metresPerUnit!.from) || !scaleDoubt);
  });
  if (built.fromReader.size === 0) reasons.push(t(lang, 'auto.note.noFloorPlan'));
  else if (!scaleOk || scaleDoubt) reasons.push(t(lang, 'auto.note.scale'));
  if (project.model.top.from === 'default') reasons.push(t(lang, 'auto.note.top'));
  if (project.model.bottom.from === 'default') reasons.push(t(lang, 'auto.note.bottom'));
  // Seules comptent les questions sur le plan lu : les valeurs d'usage (hors plan) se confirment d'un geste.
  const planDoubts = doubts.filter(isPlanDoubt);
  if (planDoubts.length > MAX_AUTO_DOUBTS) reasons.push(t(lang, 'auto.note.tooManyDoubts', { count: planDoubts.length }));
  return {
    project,
    sufficient: reasons.length === 0,
    storeySheetIds: project.model.storeys.map((s) => s.sheetId).filter((id): id is string => id !== null),
    notes: [...reasons, ...notes],
  };
}

/** Questions dont la réponse est une réponse du questionnaire, gardée telle quelle d'un projet à l'autre. */
const ANSWER_DOUBTS: ReadonlySet<string> = new Set(['occasion', 'attached', 'ventilation', 'heating', 'thermal-bridges', 'building-type', 'year', 'identity', 'renewables']);

/**
 * Questions déjà tranchées dans `base` qui le restent : celles du questionnaire (leurs réponses sont gardées), et les
 * fermetures et le nord quand l'utilisateur les avait confirmés (gardés aussi). Les autres portaient sur des valeurs
 * que la nouvelle lecture remplace (étages, pièces, baies, parois) : elles redeviennent des questions si le doute
 * revient. null = aucune.
 */
function keptResolutions(base: Project, storeys: readonly Storey[]): Record<string, 'user' | 'unknown'> | null {
  const out: Record<string, 'user' | 'unknown'> = {};
  const unlabelled = storeys.flatMap((s) => s.rooms.filter((r) => r.unlabelled));
  for (const [id, how] of Object.entries(base.answers.resolvedDoubts ?? {})) {
    const kept =
      ANSWER_DOUBTS.has(id) ||
      // Valeurs d'étage confirmées et reprises sur la nouvelle lecture (keepConfirmedStoreys) : la question reste tranchée.
      (id === 'heights' && storeys.length > 0 && storeys.every((s) => s.grossHeight.from === 'user')) ||
      (id === 'an-unlabelled' && unlabelled.length > 0 && unlabelled.every((r) => r.area.from === 'user')) ||
      (id === 'top' && base.model.top.from === 'user') ||
      (id === 'bottom' && base.model.bottom.from === 'user') ||
      (id === 'north' && base.model.northAngle.from === 'user');
    if (kept) out[id] = how;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ───────────────────────────── Étages ─────────────────────────────

/**
 * Ce que l'utilisateur a confirmé sur un étage de `base` (hauteur brute, hauteur libre, surface nette saisie, choix
 * de compter ou non les surfaces sans étiquette) est repris sur l'étage de la nouvelle lecture qui lit la même
 * feuille (même PlanSheet.id, sinon même nom). Rien d'autre n'est repris : la lecture remplace le reste.
 */
function keepConfirmedStoreys(storeys: Storey[], previous: readonly Storey[]): void {
  for (const s of storeys) {
    const old = previous.find((p) => p.sheetId !== null && p.sheetId === s.sheetId) ?? previous.find((p) => p.sheetId === null && p.name === s.name);
    if (!old) continue;
    if (old.grossHeight.from === 'user') s.grossHeight = { ...old.grossHeight };
    if (old.clearHeight.from === 'user') s.clearHeight = { ...old.clearHeight };
    if (old.netAreaOverride?.from === 'user') s.netAreaOverride = { ...old.netAreaOverride };
    const decided = old.rooms.filter((r) => r.unlabelled && r.area.from === 'user');
    if (decided.length > 0 && decided.every((r) => r.heated === decided[0]!.heated)) {
      const heated = decided[0]!.heated;
      s.rooms = s.rooms.map((r) => (r.unlabelled ? { ...r, heated, needsReview: false, area: { ...r.area, from: 'user' } } : r));
    }
  }
}

interface BuiltStoreys {
  storeys: Storey[];
  basements: Storey[];
  /** Feuille de chaque étage chauffé, même ordre. */
  sheets: PlanSheet[];
  /** Toutes les feuilles de plan d'étage retenues (sous-sols compris), du bas vers le haut. */
  ordered: PlanSheet[];
  /** Étages dont le contour chauffé vient du lecteur (et non de l'emprise et des pièces). */
  fromReader: Set<string>;
}

/** Plans d'étage du bas vers le haut : rang lu dans le titre ; repli sur l'ordre historique (altitudes, noms). */
function orderPlans(sheets: readonly PlanSheet[]): PlanSheet[] {
  if (sheets.length > 0 && sheets.every((s) => typeof s.storeyRank === 'number' && Number.isFinite(s.storeyRank))) {
    return sheets.map((s, i) => ({ s, i })).sort((a, b) => a.s.storeyRank! - b.s.storeyRank! || a.i - b.i).map((x) => x.s);
  }
  return orderSheetsBottomUp(sheets);
}

function storeyName(sheet: PlanSheet, lang: Lang): string {
  const guess = guessStorey(sheet.name);
  if (guess) return guess[lang];
  const rank = sheet.storeyRank;
  if (typeof rank === 'number' && Number.isInteger(rank) && rank >= -1 && rank <= 60) {
    if (rank <= 1) return t(lang, `auto.storey.rank${rank}`);
    return t(lang, 'auto.storey.rankN', { n: rank });
  }
  return sheet.name;
}

function uniqueName(name: string, taken: Set<string>): string {
  let out = name;
  for (let n = 2; taken.has(out); n++) out = `${name} (${n})`;
  taken.add(out);
  return out;
}

/** Surface (m²) de l'emprise d'une feuille ; null quand son échelle est inutilisable (pas comparable aux autres). */
function footprintArea(sheet: PlanSheet): number | null {
  if (!validScale(sheet)) return null;
  const poly = cleanPoly(sheet.detected.heatedOutline).length >= 3 ? cleanPoly(sheet.detected.heatedOutline) : cleanPoly(sheet.detected.outline);
  const k = sheet.metresPerUnit!.value;
  return polygonArea(poly) * k * k;
}

function buildStoreys(doc: PlanDocument, lang: Lang, notes: string[]): BuiltStoreys {
  const plans = orderPlans(doc.sheets.filter(isFloorPlan));
  const named = basementSheetIds(plans);
  const storeys: Storey[] = [];
  const basements: Storey[] = [];
  const sheets: PlanSheet[] = [];
  const ordered: PlanSheet[] = [];
  const fromReader = new Set<string>();
  const taken = new Set<string>();
  const largest = Math.max(0, ...plans.map(footprintArea).filter((a): a is number => a !== null));
  // Identifiants uniques sur tout le projet, sous-sols compris.
  const idModel: BuildingModel = { ...emptyModel(lang), storeys: [] };
  for (const sheet of plans) {
    const heated = cleanPoly(sheet.detected.heatedOutline);
    const footprint = cleanPoly(sheet.detected.outline);
    if (heated.length < 3 && footprint.length < 3) {
      notes.push(t(lang, 'auto.note.skipped', { name: sheet.name }));
      continue;
    }
    const rank = sheet.storeyRank;
    const basement = named.has(sheet.id) || (typeof rank === 'number' && rank <= -1);
    const heatedRooms = sheet.detected.rooms.filter((r) => r.heatedGuess === 'yes' && !r.exterior);
    // Un plan de toiture mal rangé, ou une feuille minuscule à côté des autres, n'est pas un étage.
    if (!basement && heated.length < 3 && !guessStorey(sheet.name) && isRoofLevelName(sheet.name)) continue;
    const area = footprintArea(sheet);
    if (area !== null && !(area >= Math.min(MIN_STOREY_AREA, largest) && area >= MIN_STOREY_SHARE * largest)) {
      // Jamais écarté en silence : la note le dit (l'expert peut le reprendre sur le plan).
      notes.push(t(lang, 'auto.note.smallStorey', { name: sheet.name, area: formatNumber(area, 1) }));
      continue;
    }
    ordered.push(sheet);
    const storey = storeyFromSheet(sheet, storeyName(sheet, lang), idModel, lang, notes);
    idModel.storeys.push(storey);
    // Sous-sol entièrement non chauffé (aucun contour chauffé, aucune pièce chauffée) : hors du volume chauffé.
    if (basement && !(heated.length >= 3 && heatedRooms.length > 0)) {
      basements.push({ ...storey, name: uniqueName(storey.name, taken) });
      // Des pièces chauffées lues sans contour chauffé : laissé hors du volume, mais la note ne dit pas « non chauffé ».
      notes.push(t(lang, heatedRooms.length > 0 ? 'auto.note.basementRooms' : 'auto.note.basement', { name: sheet.name, count: heatedRooms.length }));
      continue;
    }
    storey.name = uniqueName(storey.name, taken);
    if (heated.length >= 3) fromReader.add(storey.id);
    storeys.push(storey);
    sheets.push(sheet);
  }
  return { storeys, basements, sheets, ordered, fromReader };
}

/** Étage d'une feuille : contour chauffé du lecteur s'il existe, sinon le chemin historique (emprise et pièces). */
function storeyFromSheet(sheet: PlanSheet, name: string, idModel: BuildingModel, lang: Lang, notes: string[]): Storey {
  const base = createStorey(sheet, name, idModel);
  const d = sheet.detected;
  const heated = cleanPoly(d.heatedOutline);
  const footprint = cleanPoly(d.outline);
  const mpu = base.metresPerUnit;
  let outline = base.outline;
  let edges = base.edges;
  if (heated.length >= 3) {
    outline = heated;
    const read = d.heatedEdges && d.heatedEdges.length === heated.length ? d.heatedEdges : null;
    if (!read) notes.push(t(lang, 'auto.note.edges', { name: sheet.name }));
    edges = heated.map((_, i): StoreyEdge => ({ boundary: read ? read[i]!.boundary : 'outside', constructionId: null }));
  } else if (footprint.length >= 3 && validScale(sheet)) {
    // Repli : contour chauffé déduit de l'emprise et des pièces (annexes hors enveloppe retirées).
    const proposal = proposeHeatedOutline(footprint, d.rooms, mpu.value);
    if (proposal && proposal.removed.length > 0) {
      outline = proposal.outline;
      edges = proposal.boundaries.map((boundary) => ({ boundary, constructionId: null }));
    }
  }
  const placed = placeOpenings(d.openings, outline, edges, mpu, base.id);
  const storey: Storey = {
    ...base,
    outline,
    edges,
    openings: placed.openings,
    rooms: roomsOf(sheet, outline, base.id, mpu, lang),
  };
  // Emprise plus grande que le contour chauffé (garage accolé) : gardée pour pouvoir la réintégrer.
  if (footprint.length >= 3 && Math.abs(polygonArea(footprint) - polygonArea(outline)) * mpu.value * mpu.value > 0.5) {
    storey.footprint = { outline: footprint, openings: placed.outside };
  }
  return storey;
}

/** Pièces : surface ÉCRITE quand elle existe, locaux extérieurs écartés, surfaces sans étiquette non comptées. */
function roomsOf(sheet: PlanSheet, outline: readonly Vec2[], storeyId: string, mpu: Sourced<number>, lang: Lang): Room[] {
  const d = sheet.detected;
  const rooms: Room[] = [];
  const anchorOf = (r: DetectedRoom): Vec2 | null => (r.polygon && r.polygon.length >= 3 ? centroid(r.polygon) : (r.at ?? null));
  const k = mpu.value;
  for (const r of d.rooms) {
    if (r.exterior) continue;
    const stated = r.statedArea !== undefined && r.statedArea > 0 ? r.statedArea : undefined;
    const measured = r.measuredArea !== undefined && r.measuredArea > 0 ? r.measuredArea : undefined;
    let area: Sourced<number>;
    let sheetArea: number | undefined;
    if (stated !== undefined) {
      area = { value: stated, from: 'plan' };
      if (r.confidence !== undefined) area.confidence = r.confidence;
      if (measured !== undefined && Math.abs(stated - measured) / measured > ROOM_AREA_MISMATCH) {
        area.note = `${formatNumber(stated)} / ${formatNumber(measured)}`;
      }
    } else {
      const picked = pickRoomArea(undefined, measured);
      area = { value: picked.value, from: picked.value > 0 ? 'plan' : 'default' };
      if (picked.measured && k > 0) sheetArea = picked.value / (k * k);
    }
    // Pièce ambiguë DANS le contour isolé lu : chauffée (l'isolant tranche) ; hors du contour : à trancher.
    const anchor = anchorOf(r);
    const inside = anchor !== null && outline.length >= 3 && pointInPolygon(anchor, outline);
    const heated = r.heatedGuess === 'yes' || (r.heatedGuess === 'ask' && inside);
    const room: Room = {
      id: `${storeyId}-r${rooms.length + 1}`,
      name: r.name,
      area,
      heated,
      needsReview: (r.heatedGuess === 'ask' && !inside) || !(area.value > 0),
    };
    if (sheetArea !== undefined) room.sheetArea = sheetArea;
    if (r.polygon) room.polygon = r.polygon.map((p) => ({ x: p.x, y: p.y }));
    if (r.at) room.at = { x: r.at.x, y: r.at.y };
    rooms.push(room);
  }
  // Locaux non chauffés connus par leur seul contour (zone sans pièce nommée correspondante).
  for (const z of d.unheatedZones ?? []) {
    const poly = cleanPoly(z.polygon);
    if (poly.length < 3) continue;
    const covered = rooms.some((r) => !r.heated && r.polygon && r.polygon.length >= 3 && pointInPolygon(centroid(r.polygon), poly));
    if (covered) continue;
    const value = z.area !== undefined && z.area > 0 ? z.area : round(polygonArea(poly) * k * k, 2);
    rooms.push({
      id: `${storeyId}-r${rooms.length + 1}`,
      name: z.names.filter(Boolean).join(', ') || '?',
      area: { value, from: 'plan' },
      heated: false,
      needsReview: false,
      polygon: poly,
    });
  }
  // Surfaces chauffées sans étiquette : proposées par la question « an-unlabelled », jamais comptées d'office.
  for (const u of d.unlabelledAreas ?? []) {
    if (!(u.area > 0) || !Number.isFinite(u.area)) continue;
    rooms.push({
      id: `${storeyId}-r${rooms.length + 1}`,
      name: t(lang, 'auto.room.unlabelled'),
      area: { value: round(u.area, 2), from: 'plan' },
      heated: false,
      needsReview: false,
      unlabelled: true,
    });
  }
  return rooms;
}

interface PlacedOpenings {
  openings: Opening[];
  /** Baies extérieures qu'aucune arête du contour chauffé ne porte (garage, annexe) : hors enveloppe. */
  outside: NonNullable<Storey['footprint']>['openings'];
}

/** Baies portées par leur arête ; baies identiques d'une même arête regroupées ; portes vers le non chauffé sur leur arête. */
function placeOpenings(detected: readonly DetectedOpening[], outline: readonly Vec2[], edges: readonly StoreyEdge[], mpu: Sourced<number>, storeyId: string): PlacedOpenings {
  const scale = mpu.value;
  const outside: PlacedOpenings['outside'] = [];
  const groups = new Map<string, { o: Opening; positions: number[] }>();
  if (outline.length < 3 || !(scale > 0)) return { openings: [], outside };
  for (const d of detected) {
    if (!finite(d.a) || !finite(d.b)) continue;
    const kind: 'window' | 'door' = d.kind === 'door' ? 'door' : 'window';
    const drawn = distance(d.a, d.b);
    const width = round(d.width ?? drawn * scale, 3);
    if (!(width > 0)) continue;
    const height = round(d.height ?? (kind === 'door' ? DEFAULT_DOOR_HEIGHT : DEFAULT_WINDOW_HEIGHT), 3);
    const toUnheated = d.toUnheated === true || d.detail === 'door-to-unheated';
    // Porte de garage : jamais dans l'enveloppe.
    if (d.detail === 'garage-door') {
      outside.push({ kind, a: { ...d.a }, b: { ...d.b }, width, height });
      continue;
    }
    if (d.exterior === false && !toUnheated) continue; // porte intérieure
    let best: { index: number; distance: number; t: number } | null = null;
    for (let i = 0; i < outline.length; i++) {
      const boundary = edges[i]?.boundary ?? 'outside';
      if (toUnheated && boundary !== 'unheated') continue;
      const [p, q] = edgeEnds(outline, i);
      const dist = Math.max(closestOnSegment(d.a, p, q).distance, closestOnSegment(d.b, p, q).distance);
      if (!best || dist < best.distance) best = { index: i, distance: dist, t: closestOnSegment(lerp(d.a, d.b, 0.5), p, q).t };
    }
    const edgeMetres = best ? edgeLength(outline, best.index) * scale : 0;
    if (!best || best.distance * scale > Math.max(OPENING_MAX_DISTANCE_M, OPENING_MAX_DISTANCE_RATIO * edgeMetres)) {
      if (d.exterior !== false && !toUnheated) outside.push({ kind, a: { ...d.a }, b: { ...d.b }, width, height });
      continue;
    }
    const heightKnown = d.height !== undefined && d.heightFrom !== 'default';
    const widthIsGuess = d.width === undefined && isUnconfirmed(mpu.from);
    const from: Provenance = widthIsGuess ? 'estimate' : heightKnown ? 'plan' : 'default';
    const constructionId = kind === 'door' ? (toUnheated ? DOOR_UNHEATED_ID : DEFAULT_CONSTRUCTION_IDS.door) : null;
    const sill = d.sill !== undefined && Number.isFinite(d.sill) && d.sill >= 0 ? d.sill : undefined;
    // Hauteurs lues sur le plan et sur la façade, gardées toutes les deux (question de convention si elles diffèrent).
    const hPlan = d.heightPlan !== undefined && Number.isFinite(d.heightPlan) && d.heightPlan > 0 ? round(d.heightPlan, 3) : undefined;
    const hElev = d.heightElevation !== undefined && Number.isFinite(d.heightElevation) && d.heightElevation > 0 ? round(d.heightElevation, 3) : undefined;
    const key = `${best.index}|${kind}|${Math.round(width * 100)}|${Math.round(height * 100)}|${constructionId ?? ''}|${from}|${heightKnown ? 'h' : ''}|${sill ?? ''}|${hPlan ?? ''}|${hElev ?? ''}`;
    const g = groups.get(key);
    if (g) {
      g.o.count += 1;
      g.positions.push(best.t);
      continue;
    }
    const o: OpeningHeights = {
      id: '',
      edgeIndex: best.index,
      kind,
      width,
      height,
      count: 1,
      position: best.t,
      windowTypeId: null,
      from,
      // Provenance de la HAUTEUR, distincte de celle de la largeur (proposé ≠ confirmé).
      heightFrom: heightKnown ? 'plan' : 'default',
    };
    if (hPlan !== undefined) o.heightPlan = hPlan;
    if (hElev !== undefined) o.heightElevation = hElev;
    if (constructionId !== null) o.constructionId = constructionId;
    if (sill !== undefined) o.sill = sill;
    // Largeur mesurée sur le dessin (pas lue dans un texte) : elle suit une correction d'échelle.
    if (d.width === undefined && drawn > 0) o.sheetWidth = drawn;
    groups.set(key, { o, positions: [best.t] });
  }
  const openings = [...groups.values()].map((g, i) => ({
    ...g.o,
    id: `${storeyId}-o${i + 1}`,
    position: g.positions.reduce((a, b) => a + b, 0) / g.positions.length,
  }));
  return { openings, outside };
}

// ───────────────────────────── Alignement des étages ─────────────────────────────

/**
 * Translation de chaque étage vers un repère commun : celle du lecteur (`reading.alignment`) si elle couvre tous les
 * étages ; sinon les boîtes des bâtiments (vues) ou des emprises, alignées par leur coin — sûr quand toutes les
 * emprises ont la même taille, à confirmer sinon.
 */
function assignOffsets(storeys: Storey[], sheets: readonly PlanSheet[], reading: SheetReading | undefined): void {
  if (storeys.length < 2) return;
  const read = reading?.alignment ?? [];
  const all = storeys.every((s) => read.some((a) => a.sheetId === s.sheetId && Number.isFinite(a.dx) && Number.isFinite(a.dy)));
  if (all) {
    for (const s of storeys) {
      const a = read.find((x) => x.sheetId === s.sheetId)!;
      s.offset = { dx: a.dx, dy: a.dy, confidence: a.confidence };
    }
    return;
  }
  const boxes = storeys.map((s) => {
    const view = reading?.views.find((v) => v.sheetId !== null && v.sheetId === s.sheetId && v.buildingBox);
    if (view?.buildingBox) return view.buildingBox;
    const sheet = sheets.find((x) => x.id === s.sheetId);
    const poly = cleanPoly(sheet?.detected.outline);
    return poly.length >= 3 ? bboxOf(poly) : outlineBox(s);
  });
  const sizes = boxes.map((b, i) => {
    const k = storeys[i]!.metresPerUnit.value;
    return { w: (b.maxX - b.minX) * k, h: (b.maxY - b.minY) * k };
  });
  const ref = sizes[0]!;
  const same = sizes.every((z) => Math.abs(z.w - ref.w) <= SAME_SIZE_TOL * ref.w && Math.abs(z.h - ref.h) <= SAME_SIZE_TOL * ref.h);
  const confidence = same ? 0.7 : 0.4;
  storeys.forEach((s, i) => {
    s.offset = { dx: -boxes[i]!.minX, dy: -boxes[i]!.minY, confidence };
  });
}

/**
 * Plancher au-dessus d'un local non chauffé mesuré par le lecteur (plans alignés) : il l'emporte sur la différence de
 * contours du moteur. Une mesure peu sûre reste étiquetée à confirmer.
 */
function applyFloorOverUnheated(storeys: Storey[], reading: SheetReading | undefined, lang: Lang): void {
  for (const s of storeys) {
    const list = (reading?.floorOverUnheated ?? []).filter((f) => f.sheetId === s.sheetId && Number.isFinite(f.areaM2) && f.areaM2 > 0);
    if (list.length === 0) continue;
    const area = list.reduce((a, f) => a + f.areaM2, 0);
    const confidence = Math.min(...list.map((f) => f.confidence));
    s.floorOverUnheated = { value: round(area, 2), from: confidence >= CONFIDENCE_SINGLE_SOURCE ? 'plan' : 'estimate', confidence, note: t(lang, 'auto.source.floorOverUnheated') };
  }
}

function outlineBox(s: Storey): { minX: number; minY: number; maxX: number; maxY: number } {
  return bboxOf(s.outline);
}

// ───────────────────────────── Hauteurs ─────────────────────────────

/** Niveaux finis des étages CHAUFFÉS (les sous-sols non chauffés retirés), ou null si on ne sait pas les apparier. */
function heatedLevels(levels: ReadLevels, built: BuiltStoreys, reading: SheetReading | undefined): ReadLevels | null {
  const floors = [...levels.floors].filter((f) => Number.isFinite(f.rel)).sort((a, b) => a.rel - b.rel);
  const n = built.storeys.length;
  if (n === 0) return null;
  let picked: typeof floors | null = null;
  // Appariement par la vue : un niveau lu sur le plan d'un étage lui appartient.
  const byView = built.sheets.map((sheet) => {
    const viewIds = (reading?.views ?? []).filter((v) => v.sheetId === sheet.id).map((v) => v.id);
    return floors.find((f) => f.viewIds.some((id) => viewIds.includes(id)));
  });
  if (byView.every((f) => f !== undefined) && new Set(byView).size === n) picked = byView as typeof floors;
  else if (floors.length === built.ordered.length) {
    picked = built.sheets.map((s) => floors[built.ordered.indexOf(s)]!);
  } else if (floors.length === n) picked = floors;
  if (!picked) return null;
  return { ...levels, floors: picked };
}

function applyHeights(model: BuildingModel, built: BuiltStoreys, reading: SheetReading | undefined, convention: 'external' | 'levels', lang: Lang): void {
  const levels = reading?.levels ?? null;
  const n = model.storeys.length;
  if (!levels || n === 0) return;
  const lv = heatedLevels(levels, built, reading);
  const pitched = isPitchedReading(reading);
  if (lv) {
    const eh = envelopeHeights(lv, reading?.compositions ?? [], n, pitched ? 'levels' : convention);
    if (eh) {
      const note = t(lang, eh.convention === 'external' ? 'auto.height.external' : 'auto.height.levels');
      model.storeys.forEach((s, i) => {
        const h = eh.heights[i]!;
        s.grossHeight = { value: h.value, from: 'plan', note, ...(h.confidence !== undefined ? { confidence: h.confidence } : {}) };
      });
    }
    // Toiture inclinée : le dernier étage monte jusqu'à l'égout (le volume sous les rampants est calculé à part).
    const last = lv.floors[lv.floors.length - 1];
    const top = model.storeys[n - 1]!;
    if (pitched && last && levels.eaves !== null && Number.isFinite(levels.eaves) && levels.eaves > last.rel) {
      top.grossHeight = { value: round(levels.eaves - last.rel, 3), from: 'plan', note: t(lang, 'auto.height.eaves'), confidence: last.confidence };
    }
  }
  // Hauteurs libres rattachées à leur niveau par le lecteur : prioritaires, étage par étage.
  const byFloor = (reading?.clearHeightsByFloor ?? []).filter((h) => h.floorIndex !== null && Number.isFinite(h.value) && h.value > 1 && h.value < 6);
  let placed = 0;
  if (lv && byFloor.length > 0) {
    model.storeys.forEach((s, i) => {
      const index = levels.floors.indexOf(lv.floors[i]!);
      const hit = index >= 0 ? byFloor.filter((h) => h.floorIndex === index).sort((a, b) => b.confidence - a.confidence)[0] : undefined;
      if (!hit) return;
      s.clearHeight = { value: hit.value, from: 'plan', note: t(lang, 'auto.clear.levels'), confidence: hit.confidence };
      placed++;
    });
  }
  if (placed === n) return;
  // Repli : hauteurs libres écrites sans niveau, une par étage, ou une seule pour tous.
  const clear = levels.clearHeights.filter((h) => Number.isFinite(h) && h > 1 && h < 6);
  if (placed === 0 && (clear.length === n || clear.length === 1)) {
    model.storeys.forEach((s, i) => {
      s.clearHeight = { value: clear.length === n ? clear[i]! : clear[0]!, from: 'plan', note: t(lang, 'auto.clear.levels') };
    });
  }
}

function isPitchedReading(reading: SheetReading | undefined): boolean {
  if (!reading) return false;
  if (reading.roof?.flat && reading.roof.flat.value === false && reading.roof.flat.confidence > 0) return true;
  if (reading.roof?.pitchDeg && reading.roof.pitchDeg.value > 5) return true;
  return reading.levels?.top?.role === 'ridge' && !(reading.roof?.flat?.value === true);
}

// ───────────────────────────── Fermetures ─────────────────────────────

function proposeTop(model: BuildingModel, reading: SheetReading | undefined, built: BuiltStoreys): TopClosure | null {
  if (!reading) return null;
  const top = model.storeys[model.storeys.length - 1];
  const attic = reading.compositions.some((c) => c.element === 'ceiling-to-unheated');
  if (attic) return { ...defaultTop(), kind: 'attic-ceiling', from: 'plan' };
  if (reading.roof?.flat?.value === true || (reading.levels?.top?.role === 'top' && !isPitchedReading(reading))) {
    return { ...defaultTop(), kind: 'flat-roof', from: 'plan' };
  }
  if (!isPitchedReading(reading) || !top) return null;
  // Pente lue, sinon tirée du faîtage et de l'égout sur la demi-portée du dernier étage.
  const k = top.metresPerUnit.value;
  const across = top.outline.length >= 3 && k > 0 ? extentAlong(top.outline, longestEdgeAngle(top.outline)).across * k : 0;
  const lv = reading.levels;
  const ridge = lv?.top?.role === 'ridge' ? lv.top.rel : null;
  const eaves = lv?.eaves ?? null;
  let pitch: number | null = reading.roof?.pitchDeg?.value ?? null;
  let from: Provenance = 'plan';
  if (pitch === null && ridge !== null && eaves !== null && ridge > eaves && across > 1) pitch = radToDeg(Math.atan2(ridge - eaves, across / 2));
  if (pitch === null) {
    pitch = defaultTop().pitchDeg;
    from = 'estimate';
  }
  const floors = lv ? heatedLevels(lv, built, reading)?.floors : undefined;
  const lastFloor = floors?.[floors.length - 1]?.rel ?? null;
  const knee = eaves !== null && lastFloor !== null && eaves > lastFloor ? round(eaves - lastFloor, 2) : 0;
  if (eaves === null || lastFloor === null) from = 'estimate';
  return { ...defaultTop(), kind: 'pitched-roof', shape: 'gable', pitchDeg: Math.round(Math.min(70, Math.max(5, pitch))), kneeWallHeight: knee, from };
}

function proposeBottom(reading: SheetReading | undefined, built: BuiltStoreys, doc: PlanDocument): BottomClosure {
  const comps = reading?.compositions ?? [];
  if (built.basements.length > 0) return { ...defaultBottom('above-unheated'), from: 'plan' };
  if (comps.some((c) => c.element === 'floor-on-ground')) return { ...defaultBottom('slab-on-ground'), from: 'plan' };
  if (comps.some((c) => c.element === 'floor-to-outside')) return { ...defaultBottom('above-outside'), from: 'plan' };
  // Une coupe sans sous-sol : terre-plein probable, à confirmer.
  const section = (reading?.views ?? []).some((v) => v.kind === 'section') || doc.sheets.some((s) => s.role === 'section');
  if (section) return { ...defaultBottom('slab-on-ground'), from: 'estimate' };
  return defaultBottom();
}

function proposeNorth(doc: PlanDocument, reading: SheetReading | undefined, lang: Lang): Sourced<number> {
  const n = reading?.north;
  if (n && Number.isFinite(n.sheetUpAzimuth)) {
    const value = ((n.sheetUpAzimuth % 360) + 360) % 360;
    return {
      value,
      from: 'plan',
      confidence: n.confidence,
      note: t(lang, 'auto.source.north'),
      doubt: n.marginDeg < 5 ? t(lang, 'auto.doubt.northBorderline') : null,
    };
  }
  if (doc.northAngle && Number.isFinite(doc.northAngle.value)) return { ...doc.northAngle };
  return { value: 0, from: 'default' };
}

// ───────────────────────────── Parois ─────────────────────────────

/**
 * Une construction par composition d'enveloppe lue, rattachée au type par défaut de son rôle (mur extérieur, mur vers
 * non chauffé, toiture, dalle sur sol, plancher sur non chauffé…) : le relevé l'utilise donc sans autre réglage. Sans
 * composition, le type reste sans couches (U à définir). Portes : valeurs d'usage étiquetées hypothèses.
 */
function proposeConstructions(base: Project, reading: SheetReading | undefined, storeys: readonly Storey[], lang: Lang): Construction[] {
  const office = officeLibraryFromConstructions(emptyOfficeLibrary(), base.model.constructions, '');
  const confirmed = (c: Construction): boolean => c.u?.from === 'user' || ((c.layers ?? []).length > 0 && (c.layers ?? []).every((l) => l.lambda?.from === 'user'));
  const list: Construction[] = emptyModel(lang).constructions;
  const set = (c: Construction): void => {
    const i = list.findIndex((x) => x.id === c.id);
    if (i >= 0) list[i] = c;
    else list.push(c);
  };
  const comps: ReadComposition[] = (reading?.compositions ?? []).filter(isEnvelopeComposition);
  const insulation = dominantInsulation(comps);
  const used = new Map<string, number>();
  for (const rc of comps) {
    const target = DEFAULT_ID_OF_ELEMENT[rc.element];
    if (!target) continue;
    const n = (used.get(target) ?? 0) + 1;
    used.set(target, n);
    set(constructionFromComposition(rc, { id: n === 1 ? target : `${target}-${n}`, lang, office, projectInsulation: insulation }));
  }
  set(doorHypothesis(DEFAULT_CONSTRUCTION_IDS.door, t(lang, 'engine.row.expert.door'), false, lang));
  if (storeys.some((s) => s.openings.some((o) => o.constructionId === DOOR_UNHEATED_ID))) {
    set(doorHypothesis(DOOR_UNHEATED_ID, t(lang, 'engine.row.expert.doorUnheated'), true, lang));
  }
  // Ce que l'utilisateur a confirmé dans `base` (type d'élément, U) n'est jamais remplacé.
  for (const c of base.model.constructions) if (confirmed(c)) set({ ...c });
  return list;
}

// ───────────────────────────── Réponses proposées ─────────────────────────────

function proposeAnswers(base: ProjectAnswers, reading: SheetReading | undefined, sheets: readonly PlanSheet[], lang: Lang): ProjectAnswers {
  const answers: ProjectAnswers = { ...base };
  const proposed: Record<string, { confidence: number; source: string }> = { ...(base.proposed ?? {}) };
  const put = <K extends keyof ProjectAnswers>(key: K, value: ProjectAnswers[K] | null | undefined, confidence: number, source: string): void => {
    if (value === null || value === undefined || value === '' || confirmedInBase(base, key)) return;
    answers[key] = value;
    proposed[key] = { confidence: Math.max(0, Math.min(1, confidence)), source };
  };
  const tb = reading?.titleBlock ?? null;
  if (tb) {
    const src = t(lang, 'auto.source.titleBlock');
    const c = tb.confidence;
    put('projectName', tb.project?.trim() || null, c, src);
    put('street', tb.street?.trim() || null, c, src);
    put('postcode', tb.postcode?.trim() || null, c, src);
    put('locality', tb.locality?.trim() || null, c, src);
    if (tb.buildingType) put('buildingType', tb.buildingType.value, tb.buildingType.confidence, src);
    if (tb.dwellings && Number.isInteger(tb.dwellings.value) && tb.dwellings.value > 0) put('dwellings', tb.dwellings.value, tb.dwellings.confidence, src);
    if (tb.occasion) put('occasion', tb.occasion.value, tb.occasion.confidence, src);
    if (tb.year !== null && Number.isInteger(tb.year) && tb.year > 1800 && tb.year < 2200) put('yearBuilt', tb.year, c, src);
  }
  const sys = reading?.systems ?? null;
  if (sys) {
    const src = t(lang, 'auto.source.systems');
    if (sys.heatGenerator) put('heatGenerator', sys.heatGenerator.value, sys.heatGenerator.confidence, src);
    if (sys.hotWater) put('hotWater', sys.hotWater.value, sys.hotWater.confidence, src);
    if (sys.ventilation) put('ventilation', sys.ventilation.value, sys.ventilation.confidence, src);
    if (sys.photovoltaic) put('photovoltaic', sys.photovoltaic.value, sys.photovoltaic.confidence, src);
    if (sys.solarThermal) put('solarThermal', sys.solarThermal.value, sys.solarThermal.confidence, src);
  }
  // Plan de toiture lu sans panneau ni mention : ni photovoltaïque ni solaire thermique (proposé, pas confirmé).
  const roofPlan = (reading?.views ?? []).some((v) => v.kind === 'roof-plan');
  const panels = (reading?.equipment ?? []).some((e) => e.kind === 'photovoltaic' || e.kind === 'solar-thermal');
  if (roofPlan && !panels) {
    const src = t(lang, 'auto.source.roofPlanEmpty');
    if (!sys?.photovoltaic) put('photovoltaic', false, CONFIDENCE_SINGLE_SOURCE, src);
    if (!sys?.solarThermal) put('solarThermal', false, CONFIDENCE_SINGLE_SOURCE, src);
  }
  // Mitoyenneté : côtés mitoyens comptés par la normale EXTÉRIEURE de leur arête (indépendante du sens du contour).
  // Aucun mur mitoyen et toutes les façades percées ou isolées : bâtiment isolé.
  const party = partyEvidence(sheets);
  if (party.sides.size > 0) {
    put('attachment', party.sides.size === 1 ? 'one-side' : 'other', party.sides.size === 1 ? Math.min(party.confidence, CONFIDENCE_SINGLE_SOURCE) : 0.4, t(lang, 'auto.source.party'));
  } else if (readsDetached(party)) {
    put('attachment', 'other', CONFIDENCE_SINGLE_SOURCE, t(lang, 'auto.source.detached'));
  }
  if (Object.keys(proposed).length > 0) answers.proposed = proposed;
  return answers;
}
