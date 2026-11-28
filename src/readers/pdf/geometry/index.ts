/**
 * Géométrie d'une planche d'autorisation — points d'entrée PURS (ni pdf.js ni DOM) :
 *
 *  - `detectFloorPlan(page, view, ctx)` : une vue en plan d'étage → SheetDetection (pièces, emprise, contour
 *    chauffé et nature de ses arêtes, locaux non chauffés, surfaces sans étiquette, baies et portes) ;
 *  - `readBuildingGeometry(pages, views, floorPlans, ctx)` : toiture, façades dessinées (baies, côté du plan),
 *    calage des plans d'étage dans un repère commun, plancher au-dessus d'un local non chauffé, hauteurs de baies
 *    recoupées par les façades.
 *
 * Chaque résultat porte une confiance fondée sur le recoupement de signaux indépendants (voir core/reading.ts) :
 * ≥ 0,85 deux signaux concordants, ≥ 0,65 un seul, < 0,65 doute (question).
 */
import type { DetectedEdge, DetectedOpening, DetectedRoom, Lang, SheetDetection, Vec2 } from '../../../core/types';
import type { ReadElevation, ReadNorth, ReadRoof, ReadView, SheetReading } from '../../../core/reading';
import { intersectPolys, pointInPoly, polyArea, type Poly } from '../planar';
import { METRES_PER_POINT, type RawPage, type RawSeg } from '../raw';
import { climateDoors, coverage, footprintEdges, gapsOf, planBays, type PlanBay } from './bays';
import {
  elevationBays,
  levelClusters,
  matchElevationToSides,
  namedAzimuth,
  sideGroups,
  type ElevationBay,
  type PlanForSides,
  type SideBay,
} from './elevation';
import {
  classifyBoundary,
  floorOverUnheated,
  splitHeatedZones,
  unlabelledAreas,
  wallToUnheatedM,
  type EnvelopeEdge,
  type SeedRoom,
  type ThermalZones,
} from './envelope';
import { buildFootprint, overallDimensions, type Footprint, type PartyLine } from './footprint';
import { clipBoxes, viewInput } from './input';
import { classifyWallMaterials, ownWalls, type OwnWalls, type WallMaterials } from './materials';
import { gmsg, sideName } from './messages';
import { readRoof } from './roof';
import {
  findRoomLabels,
  matchRoomZones,
  mergeContextRooms,
  OUTSIDE_RE,
  roomConfidence,
  roomFacesFallback,
  UNHEATED_RE,
  zonePool,
  type AreaScale,
  type RoomZone,
} from './rooms';
import type { FloorPlanContext, ViewInput } from './types';
import { angleGap, boxH, boxW, ringBox, round, sheetAzimuth } from './util';

export type { FloorPlanContext } from './types';
export { UNHEATED_RE, OUTSIDE_RE, ENTRANCE_RE } from './rooms';
export { GEOMETRY_MESSAGES } from './messages';

const fmt = (v: number, d = 2): string => v.toFixed(d).replace('.', ',');

// ───────────────────────────── Plan d'étage ─────────────────────────────

export interface FloorPlanGeometry {
  detection: SheetDetection;
  /** Échelle retenue (m par point) ; null si inconnue. */
  mpp: number | null;
  scale: (AreaScale & { source: 'areas' | 'areas+declared' | 'declared'; confidence: number }) | null;
  footprint: Footprint | null;
  zones: ThermalZones | null;
  edges: EnvelopeEdge[];
  bays: PlanBay[];
  materials: WallMaterials['mode'];
  /** Questions de doute (textes courts dans la langue demandée). */
  doubts: string[];
  ms: number;
}

/** Signaux structurels de mitoyenneté d'une arête de l'emprise (en plus de la maçonnerie voisine accolée). */
function partySignals(
  v: ViewInput,
  e: { a: Vec2; b: Vec2; u: Vec2; n: Vec2; len: number },
  fp: Footprint,
  insShare: number,
  othersInsulated: boolean,
  hasGaps: boolean,
  mpp: number,
): { neighbour: boolean; limit: boolean; noInsulation: boolean; noBays: boolean } {
  const along = (p: Vec2): number => (p.x - e.a.x) * e.u.x + (p.y - e.a.y) * e.u.y;
  const out = (p: Vec2): number => (p.x - e.a.x) * e.n.x + (p.y - e.a.y) * e.n.y;
  const fb = ringBox(fp.ring);
  // Bâtiment voisin dessiné : un remplissage accolé dehors, sur au moins 60 % de l'arête, profond d'au moins 2 m.
  let neighbour = false;
  for (const f of v.fills) {
    const b = f.bbox;
    if (b.minX <= fb.minX && b.maxX >= fb.maxX && b.minY <= fb.minY && b.maxY >= fb.maxY) continue; // pelouse, parcelle
    const corners = [
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY },
      { x: b.minX, y: b.maxY },
    ];
    const ds = corners.map(out);
    const ts = corners.map(along);
    const near = Math.min(...ds) * mpp;
    const far = Math.max(...ds) * mpp;
    if (near < -0.15 || near > 0.15 || far < 2) continue;
    const ov = Math.min(e.len, Math.max(...ts)) - Math.max(0, Math.min(...ts));
    if (ov >= 0.6 * e.len) {
      neighbour = true;
      break;
    }
  }
  // Limite de propriété : traits tiretés parallèles le long de l'arête (à 0,3 m près), sur au moins 50 % de sa longueur.
  const iv: [number, number][] = [];
  for (const s of v.segs) {
    if (!s.dash) continue;
    const p0 = { x: s.x0, y: s.y0 };
    const p1 = { x: s.x1, y: s.y1 };
    const L = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    if (!(L > 0)) continue;
    if (Math.abs(((s.x1 - s.x0) * e.u.x + (s.y1 - s.y0) * e.u.y) / L) < 0.99) continue;
    if (Math.abs(out(p0)) * mpp > 0.3 || Math.abs(out(p1)) * mpp > 0.3) continue;
    const t0 = Math.max(0, Math.min(along(p0), along(p1)));
    const t1 = Math.min(e.len, Math.max(along(p0), along(p1)));
    if (t1 > t0) iv.push([t0, t1]);
  }
  iv.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let end = -Infinity;
  for (const [a, b] of iv) {
    // Les tirets d'une même ligne sont séparés par des blancs : on tolère 0,3 m de blanc.
    const start = Math.max(a, end);
    if (b > start) covered += b - start;
    if (a - end <= 0.3 / mpp && end > -Infinity) covered += Math.max(0, a - end);
    end = Math.max(end, b);
  }
  const limit = covered >= 0.5 * e.len;
  return { neighbour, limit, noInsulation: othersInsulated && insShare < 0.5, noBays: !hasGaps };
}

function insulatedShareOnEdge(e: { a: Vec2; u: Vec2; n: Vec2; len: number }, insulation: readonly Poly[], mpp: number): number {
  if (insulation.length === 0) return 0;
  const cov = coverage({ ...e, b: { x: e.a.x + e.u.x * e.len, y: e.a.y + e.u.y * e.len }, index: -1 }, insulation, 0.35 / mpp);
  return cov.reduce((s, x) => s + Math.min(x[1], e.len) - Math.max(x[0], 0), 0) / e.len;
}

export function analyseFloorPlan(page: RawPage, view: Pick<ReadView, 'id' | 'box' | 'storeyRank'>, ctx: FloorPlanContext = {}): FloorPlanGeometry {
  const t0 = performance.now();
  const lang: Lang = ctx.lang ?? 'fr';
  const v = viewInput(page, view);
  const notes: string[] = [];
  const doubts: string[] = [];
  const labels = mergeContextRooms(findRoomLabels(v.texts), ctx.rooms);
  const declared = ctx.declaredMpp ?? null;
  const matched = matchRoomZones(labels, zonePool(v), declared);
  let rooms = matched.rooms;
  const empty = (mpp: number | null): FloorPlanGeometry => ({
    detection: { rooms: rooms.map((r) => toDetectedRoom(r, null, [], lang)), openings: [], notes },
    mpp,
    scale: null,
    footprint: null,
    zones: null,
    edges: [],
    bays: [],
    materials: 'none',
    doubts,
    ms: performance.now() - t0,
  });
  if (!matched.scale) {
    notes.push(gmsg(lang, 'geo.scale.none'));
    doubts.push(gmsg(lang, 'geo.scale.none'));
    return empty(null);
  }
  const mpp = matched.scale.mpp;
  const den = (k: number): number => Math.round(k / METRES_PER_POINT);
  const materials = classifyWallMaterials(v, mpp);
  // Repli des pièces sans polygone : faces fermées par les murs.
  const before = rooms.filter((r) => r.poly).length;
  roomFacesFallback(v, rooms, [...materials.masonry, ...materials.insulation], mpp);
  const usedFaces = rooms.filter((r) => r.poly).length > before;
  if (usedFaces) notes.push(gmsg(lang, 'geo.rooms.fallback'));
  // Échelle : recoupement surfaces / annonce.
  let scaleSource: 'areas' | 'areas+declared' | 'declared' = 'areas';
  let scaleConf = 0.65;
  if (matched.scale.support === 0) {
    scaleSource = 'declared';
    // Les faces de repli recoupent-elles l'annonce ?
    const fit = rooms.filter((r) => r.source === 'wall-faces' && r.label.stated && r.measured && Math.abs(r.measured / r.label.stated - 1) <= 0.02).length;
    scaleConf = fit >= 3 ? 0.85 : 0.65;
    notes.push(fit >= 3 ? gmsg(lang, 'geo.scale.areas.agree', { den: den(mpp), rooms: fit }) : gmsg(lang, 'geo.scale.declared', { den: den(mpp) }));
  } else if (declared && Math.abs(Math.log(mpp / declared)) <= 0.01) {
    scaleSource = 'areas+declared';
    scaleConf = 0.95;
    notes.push(gmsg(lang, 'geo.scale.areas.agree', { den: den(mpp), rooms: matched.scale.support }));
  } else if (declared) {
    scaleConf = matched.scale.support >= 3 ? 0.6 : 0.45;
    const q = gmsg(lang, 'geo.scale.areas.contradict', { den: den(mpp), declared: den(declared) });
    notes.push(q);
    doubts.push(q);
  } else {
    scaleConf = matched.scale.support >= 3 ? 0.75 : 0.55;
    notes.push(gmsg(lang, 'geo.scale.areas', { den: den(mpp), rooms: matched.scale.support }));
  }
  const inner = rooms.filter((r) => r.poly && !OUTSIDE_RE.test(r.label.name));
  const innerPolys = inner.map((r) => r.poly!);
  const own: OwnWalls = ownWalls(materials, innerPolys, 0.01 / mpp, 0.035 / mpp);
  if (materials.mode === 'none') notes.push(gmsg(lang, 'geo.walls.fallback'));
  else if (materials.mode === 'solid') notes.push(gmsg(lang, 'geo.walls.solid'));
  const thick: { ax: number; ay: number; bx: number; by: number }[] = v.segs
    .filter((s: RawSeg) => s.w >= 0.45 && !s.dash)
    .map((s) => ({ ax: s.x0, ay: s.y0, bx: s.x1, by: s.y1 }));
  let fp = buildFootprint(innerPolys, own, mpp, thick, labels.map((l) => l.at));
  if (!fp) {
    notes.push(gmsg(lang, 'geo.walls.fallback'));
    const g = empty(mpp);
    g.detection.rooms = rooms.map((r) => toDetectedRoom(r, null, [], lang));
    g.scale = { ...matched.scale, source: scaleSource, confidence: scaleConf };
    g.materials = materials.mode;
    return g;
  }
  // Mitoyenneté par signaux structurels (voisin dessiné, limite de propriété, pas d'isolant, pas de baie).
  const edgesFp = footprintEdges(fp, mpp, 3);
  const shares = edgesFp.map((e) => insulatedShareOnEdge(e, own.insulation, mpp));
  const partyConf = new Map<PartyLine, number>();
  for (const p of fp.party) partyConf.set(p, 0.75);
  for (let i = 0; i < edgesFp.length; i++) {
    const e = edgesFp[i]!;
    const axisX = Math.abs(e.n.x) > 0.99;
    const axisY = Math.abs(e.n.y) > 0.99;
    if (!axisX && !axisY) continue;
    const othersInsulated = shares.some((s, j) => j !== i && s >= 0.5);
    const gaps = gapsOf(coverage(e, own.masonry, 0.8 / mpp), mpp);
    const sig = partySignals(v, e, fp, shares[i]!, othersInsulated, gaps.length > 0, mpp);
    const coord = axisX ? e.a.x : e.a.y;
    const existing = fp.party.find((p) => p.axis === (axisX ? 'x' : 'y') && Math.abs(p.at - coord) * mpp < 0.15);
    const count = [sig.neighbour, sig.limit, sig.noInsulation].filter(Boolean).length;
    if (existing) {
      if (sig.neighbour) existing.sources.push('neighbour-drawn');
      if (sig.limit) existing.sources.push('property-line');
      if (sig.noBays) existing.sources.push('no-opening');
      if (sig.neighbour || sig.limit) partyConf.set(existing, 0.9);
      continue;
    }
    if (!sig.noBays) continue;
    const span: [number, number] = axisX ? [Math.min(e.a.y, e.b.y), Math.max(e.a.y, e.b.y)] : [Math.min(e.a.x, e.b.x), Math.max(e.a.x, e.b.x)];
    const keepLess = axisX ? e.n.x > 0 : e.n.y > 0;
    const sources = ['no-opening'];
    if (sig.neighbour) sources.push('neighbour-drawn');
    if (sig.limit) sources.push('property-line');
    if (sig.noInsulation) sources.push('no-insulation');
    const side = sideName(lang, sheetAzimuth(e.n));
    if (count >= 2 && (sig.neighbour || sig.limit)) {
      const line: PartyLine = { axis: axisX ? 'x' : 'y', at: coord, keepLess, span, sources };
      fp.party.push(line);
      partyConf.set(line, count >= 3 ? 0.9 : 0.75);
    } else if (sig.neighbour || sig.limit) {
      doubts.push(gmsg(lang, 'geo.party.ask', { side, length: fmt(e.len * mpp) }));
    }
  }
  fp = { ...fp };
  // Zones thermiques.
  const basement = (view.storeyRank ?? 0) < 0 && own.insulation.length === 0;
  const seeds: SeedRoom[] = inner.map((r) => ({ poly: r.poly!, heated: !UNHEATED_RE.test(r.label.name), name: r.label.name }));
  let zones: ThermalZones;
  if (basement && seeds.some((s) => !s.heated)) {
    zones = { heated: null, unheated: [{ poly: fp.poly, names: seeds.map((s) => s.name), areaM2: fp.areaM2 }], unsealed: [], bridges: [] };
    notes.push(gmsg(lang, 'geo.unheated.basement'));
  } else {
    zones = splitHeatedZones(fp, seeds, own.insulation, mpp);
  }
  for (const name of zones.unsealed) doubts.push(gmsg(lang, 'geo.unheated.unsealed', { name }));
  const edges = classifyBoundary(zones, fp, own.insulation, mpp);
  // Baies.
  const pairs = (ctx.openingPairs ?? []).filter(
    (p) => (p.viewId === view.id || p.viewId === null) && p.page === page.number && p.at.x >= v.box.minX && p.at.x <= v.box.maxX && p.at.y >= v.box.minY && p.at.y <= v.box.maxY,
  );
  const bays = planBays(v.segs, fp, own, zones, rooms, pairs, mpp);
  const doors = climateDoors(zones, own, v.segs, rooms, pairs, mpp);
  const allBays = [...bays, ...doors];
  // Surfaces sans étiquette : remplissages de pièce de même teinte que les pièces appariées, sans étiquette.
  const roomColors = new Set<number>();
  for (const r of rooms) {
    if (r.source !== 'zone-fill' || !r.poly) continue;
    const f = v.fills.find((x) => x.polys.includes(r.poly!));
    if (f) roomColors.add(f.color);
  }
  const used = new Set(rooms.map((r) => r.poly).filter((p): p is Poly => !!p));
  const unlabelledFills = v.fills
    .filter((f) => roomColors.has(f.color))
    .flatMap((f) => f.polys)
    .filter((p) => !used.has(p) && !labels.some((l) => pointInPoly(l.at.x, l.at.y, p)))
    .filter((p) => polyArea(p) * mpp * mpp >= 1 && polyArea(p) * mpp * mpp <= 60);
  const unlabelled = unlabelledAreas(zones.heated, inner, [...own.masonry, ...own.insulation], unlabelledFills, mpp);
  // Cotes hors tout.
  const dims = overallDimensions(v.texts, fp, mpp);
  let outlineConfidence = fp.basis === 'walls' ? 0.75 : fp.basis === 'strokes' ? 0.5 : 0.35;
  const dimsOk = (dims.width !== null ? 1 : 0) + (dims.depth !== null ? 1 : 0);
  if (fp.basis === 'walls' && dimsOk > 0) outlineConfidence = dimsOk === 2 ? 0.92 : 0.85;
  const width = dims.width ?? fp.widthM;
  const depth = dims.depth ?? fp.depthM;
  notes.push(
    dimsOk > 0
      ? gmsg(lang, 'geo.outline.dims', { w: fmt(width), d: fmt(depth) })
      : gmsg(lang, 'geo.outline', { w: fmt(fp.widthM), d: fmt(fp.depthM), area: fmt(fp.areaM2, 1) }),
  );
  for (const p of fp.party) {
    const len = (p.span[1] - p.span[0]) * mpp;
    const deg = p.axis === 'x' ? (p.keepLess ? 90 : 270) : p.keepLess ? 180 : 0;
    notes.push(gmsg(lang, 'geo.party', { side: sideName(lang, deg), length: fmt(len) }));
  }
  // Pièces : contrat.
  const detectedRooms = rooms.map((r) => toDetectedRoom(r, zones, ctx.glazing ?? [], lang, basement));
  const approx = rooms.filter((r) => r.poly && r.label.stated && r.measured !== null);
  const maxGap = approx.reduce((m, r) => Math.max(m, Math.abs(r.measured! / r.label.stated! - 1)), 0);
  notes.push(gmsg(lang, 'geo.rooms.found', { found: rooms.filter((r) => r.poly).length, total: rooms.length, gap: fmt(maxGap * 100, 1) }));
  // Contour chauffé et arêtes.
  const detection: SheetDetection = {
    outline: fp.ring.map((p) => ({ x: p.x, y: p.y })),
    footprintSize: { width: round(width, 3), depth: round(depth, 3), confidence: dimsOk > 0 ? 0.9 : 0.7 },
    outlineConfidence,
    rooms: detectedRooms,
    openings: allBays.map((b) => b.opening),
    notes,
  };
  if (zones.heated) {
    detection.heatedOutline = zones.heated.outer.map((p) => ({ x: p.x, y: p.y }));
    detection.heatedEdges = edges.map((e) => toDetectedEdge(e, fp!, partyConf, mpp));
    notes.push(gmsg(lang, 'geo.heated', { area: fmt(polyArea(zones.heated) * mpp * mpp, 1) }));
  }
  if (zones.unheated.length > 0) {
    detection.unheatedZones = zones.unheated.map((u) => ({ polygon: u.poly.outer.map((p) => ({ x: p.x, y: p.y })), names: u.names, area: round(u.areaM2, 2) }));
    if (!basement) for (const u of zones.unheated) notes.push(gmsg(lang, 'geo.unheated', { names: u.names.join(', '), area: fmt(u.areaM2) }));
    const wallLen = wallToUnheatedM(edges);
    if (wallLen > 0) notes.push(gmsg(lang, 'geo.wallToUnheated', { length: fmt(wallLen) }));
  }
  if (unlabelled.length > 0) {
    detection.unlabelledAreas = unlabelled.map((u) => ({ polygon: u.poly.outer.map((p) => ({ x: p.x, y: p.y })), area: round(u.areaM2, 2) }));
    for (const u of unlabelled) doubts.push(gmsg(lang, 'geo.unlabelled', { area: fmt(u.areaM2) }));
  }
  const ext = allBays.filter((b) => b.opening.exterior);
  notes.push(
    gmsg(lang, 'geo.openings', {
      windows: ext.filter((b) => b.opening.kind === 'window').length,
      doors: ext.filter((b) => b.opening.kind === 'door').length,
      unknown: ext.filter((b) => b.opening.kind === 'unknown').length,
    }),
  );
  for (const b of allBays) {
    const o = b.opening;
    if (o.kind === 'unknown') doubts.push(gmsg(lang, 'geo.opening.unknown', { width: fmt(o.width ?? 0), side: sideName(lang, sheetAzimuth(b.edge.n)) }));
    if (o.toUnheated) notes.push(gmsg(lang, 'geo.door.unheated', { width: fmt(o.width ?? 0), room: b.room ?? '?' }));
  }
  for (const r of rooms) {
    const c = roomConfidence(r);
    if (c.approx && r.measured !== null && r.label.stated) {
      notes.push(`${r.label.name} : ${gmsg(lang, 'geo.room.approx', { measured: fmt(r.measured), stated: fmt(r.label.stated) })}`);
    }
  }
  return {
    detection,
    mpp,
    scale: { ...matched.scale, source: scaleSource, confidence: scaleConf },
    footprint: fp,
    zones,
    edges,
    bays: allBays,
    materials: materials.mode,
    doubts,
    ms: performance.now() - t0,
  };
}

function toDetectedEdge(e: EnvelopeEdge, fp: Footprint, partyConf: Map<PartyLine, number>, mpp: number): DetectedEdge {
  if (e.kind === 'party') {
    const m = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
    const line = fp.party.find((p) => (p.axis === 'x' ? Math.abs(m.x - p.at) : Math.abs(m.y - p.at)) * mpp < 0.1);
    return { boundary: 'heated', confidence: (line && partyConf.get(line)) ?? 0.7, sources: line ? [...new Set(line.sources)] : ['party'] };
  }
  if (e.kind === 'unheated') {
    const ins = e.insulatedShare >= 0.5;
    return { boundary: 'unheated', confidence: ins ? 0.9 : 0.6, sources: ins ? ['room-name', 'insulation'] : ['room-name'] };
  }
  const ins = e.insulatedShare >= 0.5;
  return { boundary: 'outside', confidence: e.kind === 'exterior' ? (ins ? 0.9 : 0.75) : 0.5, sources: ins ? ['footprint', 'insulation'] : ['footprint'] };
}

function toDetectedRoom(r: RoomZone, zones: ThermalZones | null, glazing: NonNullable<FloorPlanContext['glazing']>, lang: Lang, basement = false): DetectedRoom {
  const out: DetectedRoom = { name: r.label.name, heatedGuess: 'yes', at: { x: r.label.at.x, y: r.label.at.y } };
  if (r.label.stated !== null) out.statedArea = r.label.stated;
  if (r.poly) out.polygon = r.poly.outer.map((p) => ({ x: p.x, y: p.y }));
  if (r.measured !== null) out.measuredArea = round(r.measured, 2);
  out.confidence = roomConfidence(r).confidence;
  if (OUTSIDE_RE.test(r.label.name)) {
    out.exterior = true;
    out.heatedGuess = 'no';
  } else if (UNHEATED_RE.test(r.label.name)) out.heatedGuess = zones && zones.unsealed.includes(r.label.name) ? 'ask' : 'no';
  else if (basement) out.heatedGuess = 'ask';
  void lang;
  const g = glazing.find(
    (x) => (x.room && x.room.toLowerCase() === r.label.name.toLowerCase()) || (r.poly && pointInPoly(x.at.x, x.at.y, r.poly)),
  );
  if (g && g.glazedArea !== null) out.glazedArea = g.glazedArea;
  return out;
}

/** Point d'entrée du contrat : une vue en plan d'étage → SheetDetection. */
export function detectFloorPlan(page: RawPage, view: Pick<ReadView, 'id' | 'box' | 'storeyRank'>, ctx: FloorPlanContext = {}): SheetDetection {
  return analyseFloorPlan(page, view, ctx).detection;
}

// ───────────────────────────── Bâtiment : toiture, façades, calage ─────────────────────────────

export interface FloorPlanEntry {
  view: ReadView;
  detection: SheetDetection;
  /** Échelle de la vue (m par point). */
  mpp: number;
}

export interface BuildingContext {
  /** Échelle par vue (m par point) quand elle est connue ; sinon celle des plans de la même page. */
  mppByView?: Record<string, number>;
  north?: ReadNorth | null;
  lang?: Lang;
}

export interface OpeningUpdate {
  sheetId: string;
  /** Indice dans `detection.openings`. */
  index: number;
  height: number;
  heightFrom: 'plan-dim' | 'elevation';
  confidence: number;
  doubt: string | null;
}

export interface FloorOverUnheated {
  /** Feuille de l'étage (plancher chauffé). */
  sheetId: string;
  /** Feuille du niveau du dessous (local non chauffé). */
  belowSheetId: string;
  areaM2: number;
  /** Polygone dans le repère de la feuille de l'étage. */
  polygon: Vec2[];
  confidence: number;
}

export interface BuildingGeometry {
  roof: ReadRoof | null;
  elevations: ReadElevation[];
  alignment: SheetReading['alignment'];
  floorOverUnheated: FloorOverUnheated[];
  /** Plancher d'étage au-dessus de l'extérieur (encorbellement), m² par feuille. */
  floorOverOutside: { sheetId: string; areaM2: number }[];
  /** Hauteurs de baies recoupées par les façades (à reporter dans detection.openings). */
  openingUpdates: OpeningUpdate[];
  doubts: string[];
}

const sheetIdOf = (v: ReadView): string => v.sheetId ?? v.id;

function heatedPolyOf(d: SheetDetection): Poly | null {
  const r = d.heatedOutline ?? d.outline;
  return r && r.length >= 3 ? { outer: r, holes: [] } : null;
}

/** Calage des plans d'étage : cadre répété (même taille de vue sur la même page) et boîtes du bâtiment. */
export function alignFloorPlans(plans: readonly FloorPlanEntry[]): SheetReading['alignment'] {
  if (plans.length === 0) return [];
  const sorted = [...plans].sort((a, b) => (a.view.storeyRank ?? 99) - (b.view.storeyRank ?? 99));
  const ref = sorted.find((p) => p.view.storeyRank === 0) ?? sorted[0]!;
  const refFp = ref.detection.outline ? ringBox(ref.detection.outline) : null;
  const out: SheetReading['alignment'] = [{ sheetId: sheetIdOf(ref.view), dx: 0, dy: 0, confidence: 1 }];
  for (const p of sorted) {
    if (p === ref) continue;
    const signals: { dx: number; dy: number; src: string }[] = [];
    const sameSize = (a: { minX: number; minY: number; maxX: number; maxY: number }, b: typeof a, tol: number): boolean =>
      Math.abs(boxW(a) / boxW(b) - 1) <= tol && Math.abs(boxH(a) / boxH(b) - 1) <= tol;
    if (p.view.page === ref.view.page && sameSize(p.view.box, ref.view.box, 0.01)) {
      signals.push({ dx: ref.view.box.minX - p.view.box.minX, dy: ref.view.box.minY - p.view.box.minY, src: 'repeated-frame' });
    }
    const fp = p.detection.outline ? ringBox(p.detection.outline) : null;
    if (fp && refFp && sameSize(fp, refFp, 0.03)) {
      signals.push({ dx: (refFp.minX + refFp.maxX) / 2 - (fp.minX + fp.maxX) / 2, dy: (refFp.minY + refFp.maxY) / 2 - (fp.minY + fp.maxY) / 2, src: 'footprint' });
    } else if (fp && refFp) {
      signals.push({ dx: refFp.minX - fp.minX, dy: refFp.minY - fp.minY, src: 'footprint-corner' });
    }
    if (signals.length === 0) continue;
    const tol = 0.3 / p.mpp;
    const fpSig = signals.find((s) => s.src !== 'repeated-frame');
    const frame = signals.find((s) => s.src === 'repeated-frame');
    let best = fpSig ?? frame!;
    let confidence: number;
    if (frame && fpSig) {
      const agree = Math.hypot(frame.dx - fpSig.dx, frame.dy - fpSig.dy) <= tol;
      confidence = agree ? 0.92 : 0.5;
      if (agree) best = frame;
    } else confidence = best.src === 'footprint' || best.src === 'repeated-frame' ? 0.7 : 0.5;
    out.push({ sheetId: sheetIdOf(p.view), dx: best.dx, dy: best.dy, confidence });
  }
  return out;
}

function planForSides(p: FloorPlanEntry, offset: { dx: number; dy: number }): PlanForSides | null {
  const ring = p.detection.outline;
  if (!ring || ring.length < 3) return null;
  const shifted = ring.map((q) => ({ x: q.x + offset.dx, y: q.y + offset.dy }));
  const fpPoly: Poly = { outer: ring, holes: [] };
  const bays: SideBay[] = [];
  p.detection.openings.forEach((o, index) => {
    if (!o.exterior) return;
    const m = { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 };
    // Normale extérieure : celle de l'arête de l'emprise la plus proche.
    let best = Infinity;
    let n: Vec2 = { x: 0, y: 1 };
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(L > 0)) continue;
      const t = Math.max(0, Math.min(1, ((m.x - a.x) * (b.x - a.x) + (m.y - a.y) * (b.y - a.y)) / (L * L)));
      const d = Math.hypot(m.x - (a.x + (b.x - a.x) * t), m.y - (a.y + (b.y - a.y) * t));
      if (d < best) {
        best = d;
        n = { x: (b.y - a.y) / L, y: -(b.x - a.x) / L };
        const probe = { x: m.x + n.x * 0.5, y: m.y + n.y * 0.5 };
        if (pointInPoly(probe.x, probe.y, fpPoly)) n = { x: -n.x, y: -n.y };
      }
    }
    if (best * p.mpp > 0.6) return;
    bays.push({
      centre: { x: m.x + offset.dx, y: m.y + offset.dy },
      widthM: o.width ?? Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) * p.mpp,
      n,
      rank: p.view.storeyRank ?? 0,
      heightM: o.height ?? null,
      entrance: o.detail === 'entrance-door',
      garage: o.detail === 'garage-door',
      ref: { sheetId: sheetIdOf(p.view), index },
    });
  });
  return { ring: shifted, rank: p.view.storeyRank ?? 0, bays, mpp: p.mpp };
}

export function readBuildingGeometry(
  pages: readonly RawPage[],
  views: readonly ReadView[],
  floorPlans: readonly FloorPlanEntry[],
  ctx: BuildingContext = {},
): BuildingGeometry {
  const lang: Lang = ctx.lang ?? 'fr';
  const doubts: string[] = [];
  const pageOf = new Map(pages.map((p) => [p.number, p]));
  const clipsOf = new Map(pages.map((p) => [p.number, clipBoxes(p)]));
  const alignment = alignFloorPlans(floorPlans);
  if (alignment.some((a) => a.confidence < 0.65)) doubts.push(gmsg(lang, 'geo.align.ask'));
  const offsetOf = (p: FloorPlanEntry): { dx: number; dy: number } => alignment.find((a) => a.sheetId === sheetIdOf(p.view)) ?? { dx: 0, dy: 0 };
  const mppFor = (v: ReadView): number | null => {
    const m = ctx.mppByView?.[v.id];
    if (m) return m;
    const same = floorPlans.find((p) => p.view.page === v.page) ?? floorPlans[0];
    return same?.mpp ?? null;
  };
  // Plan de référence (rang 0 ou le plus bas) : son emprise sert aux recoupements.
  const sorted = [...floorPlans].sort((a, b) => (a.view.storeyRank ?? 99) - (b.view.storeyRank ?? 99));
  const refPlan = sorted.find((p) => p.view.storeyRank === 0) ?? sorted[0] ?? null;
  const refSize = refPlan?.detection.footprintSize ? { widthM: refPlan.detection.footprintSize.width, depthM: refPlan.detection.footprintSize.depth } : null;
  // Toiture.
  let roof: ReadRoof | null = null;
  for (const v of views) {
    if (v.kind !== 'roof-plan') continue;
    const page = pageOf.get(v.page);
    const mpp = mppFor(v);
    if (!page || !mpp) continue;
    roof = readRoof(viewInput(page, v, clipsOf.get(v.page)), v.sheetId, mpp, refSize);
    if (roof) break;
  }
  // Façades.
  const plans = floorPlans.map((p) => planForSides(p, offsetOf(p))).filter((p): p is PlanForSides => !!p);
  const refRing = plans.find((p) => p.rank === (refPlan?.view.storeyRank ?? 0))?.ring ?? plans[0]?.ring ?? null;
  const groups = refRing ? sideGroups(refRing, plans[0]!.mpp) : [];
  const elevations: ReadElevation[] = [];
  const openingUpdates: OpeningUpdate[] = [];
  for (const v of views) {
    if (v.kind !== 'elevation') continue;
    const page = pageOf.get(v.page);
    const mpp = mppFor(v);
    if (!page || !mpp) continue;
    const er = elevationBays(viewInput(page, v, clipsOf.get(v.page)), mpp);
    const elev: ReadElevation = {
      viewId: v.id,
      sides: v.sides,
      widthM: er ? round(er.widthM, 3) : null,
      heightM: er ? round(er.heightM, 3) : null,
      bays: er ? er.bays.map((b) => ({ box: b.box, widthM: b.widthM, heightM: b.heightM, kind: b.kind, parts: b.parts })) : [],
      planSideDeg: null,
    };
    elevations.push(elev);
    if (!er || groups.length === 0) continue;
    const name = v.title ?? v.id;
    const matches = matchElevationToSides(er.bays, er.widthM, plans, groups);
    const best = matches[0] ?? null;
    const geo = namedAzimuth(v.sides);
    const expectedDeg = geo !== null && ctx.north ? (((geo - ctx.north.sheetUpAzimuth) % 360) + 360) % 360 : null;
    const front = v.sides?.includes('front') ?? false;
    const entranceDeg = plans.flatMap((p) => p.bays.filter((b) => b.entrance || b.garage)).map((b) => sheetAzimuth(b.n));
    let chosen = best;
    let confidence = 0;
    const evidence: { source: string; detail?: string }[] = [];
    let doubt: string | null = null;
    if (best && best.score >= 0.6 && best.margin >= 0.2) {
      confidence = 0.75;
      evidence.push({ source: 'bay-positions', detail: `IoU ${best.score.toFixed(2)}` });
      if (expectedDeg !== null) {
        if (angleGap(expectedDeg, best.group.deg) <= 30) {
          confidence = 0.9;
          evidence.push({ source: 'north-arrow' });
        } else {
          confidence = 0.45;
          doubt = gmsg(lang, 'geo.elev.north.contradict', { name });
        }
      } else if (front && entranceDeg.some((d) => angleGap(d, best.group.deg) <= 10)) {
        confidence = 0.9;
        evidence.push({ source: 'entrance-side' });
      }
    } else if (expectedDeg !== null) {
      const g = [...groups].sort((a, b) => angleGap(a.deg, expectedDeg) - angleGap(b.deg, expectedDeg))[0]!;
      chosen = matches.find((m) => m.group === g) ?? { group: g, score: 0, margin: 0, mirrored: false, levelOf: [] };
      confidence = angleGap(g.deg, expectedDeg) <= 30 ? 0.7 : 0.4;
      evidence.push({ source: 'north-arrow' });
    } else if (front && entranceDeg.length > 0) {
      const d0 = entranceDeg[0]!;
      const g = groups.find((x) => angleGap(x.deg, d0) <= 10);
      if (g) {
        chosen = matches.find((m) => m.group === g && !m.mirrored) ?? { group: g, score: 0, margin: 0, mirrored: false, levelOf: [] };
        confidence = 0.6;
        evidence.push({ source: 'entrance-side' });
      }
    } else if (best) {
      confidence = 0.4;
      evidence.push({ source: 'bay-positions', detail: `IoU ${best.score.toFixed(2)}` });
    }
    if (!chosen) continue;
    if (confidence < 0.65 && !doubt) doubt = gmsg(lang, 'geo.elev.side.ask', { name, side: sideName(lang, chosen.group.deg) });
    if (doubt) doubts.push(doubt);
    elev.planSideDeg = { value: round(chosen.group.deg, 1), confidence, evidence, doubt };
    if (confidence >= 0.65) openingUpdates.push(...crossCheckHeights(er.bays, chosen, plans, lang, doubts));
  }
  // Plancher au-dessus d'un local non chauffé, encorbellement.
  const floorOver: FloorOverUnheated[] = [];
  const floorOverOutside: { sheetId: string; areaM2: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const up = sorted[i]!;
    const rank = up.view.storeyRank;
    if (rank === null) continue;
    const below = [...sorted].reverse().find((p) => p.view.storeyRank !== null && p.view.storeyRank < rank);
    if (!below) continue;
    const oU = offsetOf(up);
    const oB = offsetOf(below);
    const align = Math.min(alignment.find((a) => a.sheetId === sheetIdOf(up.view))?.confidence ?? 0.5, alignment.find((a) => a.sheetId === sheetIdOf(below.view))?.confidence ?? 0.5);
    const heated = heatedPolyOf(up.detection);
    const shift = { x: oB.dx - oU.dx, y: oB.dy - oU.dy };
    const lowerUnheated = (below.detection.unheatedZones ?? []).map((u) => ({ outer: u.polygon, holes: [] }));
    for (const f of floorOverUnheated(lowerUnheated, heated, shift, up.mpp)) {
      floorOver.push({ sheetId: sheetIdOf(up.view), belowSheetId: sheetIdOf(below.view), areaM2: round(f.areaM2, 2), polygon: f.poly.outer, confidence: Math.min(0.9, align) });
    }
    const lowerOutline = below.detection.outline;
    if (heated && lowerOutline) {
      const moved = { outer: lowerOutline.map((p) => ({ x: p.x + shift.x, y: p.y + shift.y })), holes: [] };
      const overhang = polyArea(heated) - intersectPolys([heated], [moved]).reduce((s, p) => s + polyArea(p), 0);
      const a = overhang * up.mpp * up.mpp;
      if (a >= 0.5) floorOverOutside.push({ sheetId: sheetIdOf(up.view), areaM2: round(a, 2) });
    }
  }
  return { roof, elevations, alignment, floorOverUnheated: floorOver, floorOverOutside, openingUpdates, doubts };
}

/** Hauteurs de baies : cote du plan face au cadre dessiné en façade. */
function crossCheckHeights(
  bays: readonly ElevationBay[],
  match: { group: { n: Vec2; deg: number; uMin: number; lengthM: number }; mirrored: boolean; levelOf: number[] },
  plans: readonly PlanForSides[],
  lang: Lang,
  doubts: string[],
): OpeningUpdate[] {
  const out: OpeningUpdate[] = [];
  const cl = levelClusters(bays);
  const g = match.group;
  const u = { x: g.n.y, y: -g.n.x };
  const L = g.lengthM;
  for (const p of plans) {
    for (const b of p.bays) {
      if (angleGap(sheetAzimuth(b.n), g.deg) > 10) continue;
      const t = (b.centre.x * u.x + b.centre.y * u.y - g.uMin) * p.mpp;
      const lo = t - b.widthM / 2;
      const hi = t + b.widthM / 2;
      let best: { bay: ElevationBay; ov: number } | null = null;
      bays.forEach((e, i) => {
        if (match.levelOf.length > 0 && match.levelOf[cl[i]!] !== b.rank) return;
        const x0 = match.mirrored ? L - e.x1 : e.x0;
        const x1 = match.mirrored ? L - e.x0 : e.x1;
        const ov = Math.max(0, Math.min(hi, x1) - Math.max(lo, x0)) / Math.max(hi - lo, x1 - x0);
        if (ov >= 0.5 && (!best || ov > best.ov)) best = { bay: e, ov };
      });
      if (!best) continue;
      const hf = (best as { bay: ElevationBay }).bay.heightM;
      if (b.heightM === null) {
        out.push({ ...b.ref, height: hf, heightFrom: 'elevation', confidence: 0.65, doubt: null });
        continue;
      }
      const diff = b.heightM - hf;
      if (diff >= -0.03 && diff <= 0.25) out.push({ ...b.ref, height: b.heightM, heightFrom: 'plan-dim', confidence: 0.9, doubt: null });
      else {
        const q = gmsg(lang, 'geo.height.ask', { plan: fmt(b.heightM), elev: fmt(hf) });
        doubts.push(q);
        out.push({ ...b.ref, height: b.heightM, heightFrom: 'plan-dim', confidence: 0.5, doubt: q });
      }
    }
  }
  return out;
}

/** Reporte les hauteurs recoupées dans les détections (modifie `floorPlans[i].detection.openings`). */
export function applyOpeningUpdates(floorPlans: readonly FloorPlanEntry[], updates: readonly OpeningUpdate[]): void {
  for (const u of updates) {
    const p = floorPlans.find((x) => sheetIdOf(x.view) === u.sheetId);
    const o: DetectedOpening | undefined = p?.detection.openings[u.index];
    if (!o) continue;
    o.height = u.height;
    o.heightFrom = u.heightFrom;
    // Hauteur du plan confirmée par la façade : la confiance monte ; hauteur venue de la seule façade ou en
    // désaccord : elle ne dépasse pas celle de la recoupe.
    o.confidence = u.heightFrom === 'plan-dim' && !u.doubt ? Math.max(o.confidence ?? 0, u.confidence) : Math.min(o.confidence ?? 1, u.confidence);
  }
}

// Réexports utiles aux tests et au branchement.
export { viewInput } from './input';
export { elevationBays } from './elevation';
export { readRoof, roofOutline } from './roof';
export type { PlanBay } from './bays';
export type { ElevationRead } from './elevation';
