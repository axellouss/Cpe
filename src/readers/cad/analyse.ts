/**
 * Analyse d'un dessin mis à plat : calques de murs, unité, plans (un par bâtiment dessiné), contour extérieur,
 * pièces, ouvertures, flèche du nord. Tout est exprimé dans le repère d'ANALYSE (y vers le haut) ;
 * la conversion vers le repère des feuilles se fait dans index.ts.
 *
 * Principe de robustesse (notes de recherche PDF § 3 et DWG § 6) :
 *  - le CONTOUR vient d'une « fermeture » topologiquement tolérante (épaissir puis amincir les traits de murs) :
 *    elle survit aux extrémités mal accrochées et aux murs non refermés ;
 *  - les PIÈCES et les OUVERTURES viennent du modèle exact (murs pleins + tableaux appariés) et ne sont
 *    proposées que lorsqu'il se referme.
 */
import type { DetectedRoom, PlanText, Vec2 } from '../../core/types';
import { isSelfIntersecting } from '../../core/geometry';
import { fold, guessStorey, isNorthArrowName, parseOpeningSize, parseRoomLabel, roomsFromTexts } from '../../semantics/labels';
import { classifyLayer } from './layers';
import type { LayerCategory } from './layers';
import { SEG_CURVE, SEG_LINE, SEG_POLY } from './load';
import type { RawDrawing, RawInsert } from './load';
import { closeOutline, pointInRing, pointRingDistance, pointSegDistance, ringArea, ringBox, ringPerimeter, simplifyRing } from './planar';
import type { Box, Seg } from './planar';
import { SegGrid } from './spatial';
import { chooseUnit, collectUnitEvidence, wallThicknessEvidence } from './units';
import type { UnitEvidence } from './units';
import { buildWalls, parallelPairScore } from './walls';
import type { Bridge, WallModel } from './walls';

export interface PlanOpening {
  kind: 'window' | 'door' | 'unknown';
  a: Vec2;
  b: Vec2;
  /** Largeur en unités du dessin. */
  width: number;
  /** Hauteur en mètres, si un nom de bloc ou un attribut la donne. */
  height?: number;
  /** 'gap' = intervalle dans le mur ; 'insert' = bloc posé sur un mur non interrompu. */
  source: 'gap' | 'insert';
}

export type OutlineMode = 'exact' | 'stable' | 'approx' | 'none';

export interface PlanAnalysis {
  /** Emprise grossière du plan (fermeture large) : sert à répartir le contenu entre les feuilles. */
  hull: Vec2[];
  box: Box;
  outline?: Vec2[];
  outlineMode: OutlineMode;
  /** Rayon de fermeture utilisé (m). */
  closeRadius: number;
  /** Pièces (positions et polygones dans le repère d'analyse). */
  rooms: DetectedRoom[];
  openings: PlanOpening[];
  /** Titre de plan le plus proche, s'il nomme un niveau. */
  title?: string;
  storey?: { fr: string; de: string; rank: number };
  /** Titre indiquant une coupe, une façade, un détail… : la vue n'est pas un plan d'étage. */
  viewTitle?: string;
  unpairedJambs: number;
  /** Groupes de pièces que le dessin ne sépare pas (porte restée ouverte dans le modèle exact). */
  mergedRooms: string[][];
  /** Écarts entre surface écrite et surface mesurée : [nom, écrite, mesurée]. */
  areaMismatches: [string, number, number][];
  /** Nombre d'ouvertures écartées car peu plausibles. */
  rejectedOpenings: number;
  /** Pièces probablement non chauffées englobées dans le contour. */
  unheatedInside: string[];
}

export interface Analysis {
  /** Unités de dessin par mètre utilisées pour l'analyse ; null = aucune analyse géométrique possible. */
  perMetre: number | null;
  evidence: UnitEvidence[];
  agreed: boolean;
  wallLayers: string[];
  wallSource: 'name' | 'geometry' | 'none';
  walls: WallModel | null;
  plans: PlanAnalysis[];
  /** Plans supplémentaires ignorés (au-delà de la limite). */
  droppedPlans: number;
  north: { angle: number; block: string; count: number } | null;
  /** Rapports surface mesurée / surface écrite des pièces fermées (contrôle de l'unité). */
  areaRatios: number[];
  /** Renseigné quand le dessin a trop de traits de murs pour être analysé : leur nombre. */
  tooHeavy?: number;
}

const MAX_PLANS = 12;
/** Nombre de traits de murs au-delà duquel on renonce à l'analyse (≈ 0,7 ms par trait). */
export const MAX_WALL_SEGMENTS = 20_000;
const VIEW_RE =
  /(^|[^a-z])(coupe|coupes|facade|facades|elevation|elevations|schnitt|schnitte|ansicht|ansichten|section|sections|detail|details|situation|lageplan|implantation|plan de masse|perspective|toiture|toitures|dachaufsicht|dachdraufsicht|fondations?|fundamente?|fundamentplan)([^a-z]|$)/;

const HEIGHT_TAG = /^(haut|hauteur|h|ht|hoehe|hohe|height|hgt)$/;
const WIDTH_TAG = /^(larg|largeur|l|lg|b|breite|width|w)$/;

function isStroke(kind: number): boolean {
  return kind === SEG_LINE || kind === SEG_POLY || kind === SEG_CURVE;
}

function segAt(d: RawDrawing, i: number): Seg {
  return { ax: d.segXY[4 * i]!, ay: d.segXY[4 * i + 1]!, bx: d.segXY[4 * i + 2]!, by: d.segXY[4 * i + 3]! };
}

function boxDistance(x: number, y: number, b: Box): number {
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dy = Math.max(b.minY - y, 0, y - b.maxY);
  return Math.hypot(dx, dy);
}

function inBox(x: number, y: number, b: Box, margin: number): boolean {
  return x >= b.minX - margin && x <= b.maxX + margin && y >= b.minY - margin && y <= b.maxY + margin;
}

function segmentsCross(a: Seg, b: Seg): boolean {
  const d1 = (a.bx - a.ax) * (b.ay - a.ay) - (a.by - a.ay) * (b.ax - a.ax);
  const d2 = (a.bx - a.ax) * (b.by - a.ay) - (a.by - a.ay) * (b.bx - a.ax);
  const d3 = (b.bx - b.ax) * (a.ay - b.ay) - (b.by - b.ay) * (a.ax - b.ax);
  const d4 = (b.bx - b.ax) * (a.by - b.ay) - (b.by - b.ay) * (a.bx - b.ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Distance d'un segment à un polygone convexe (0 s'il le touche ou y entre). */
function segPolyDistance(s: Seg, poly: readonly Vec2[]): number {
  if (pointInRing(s.ax, s.ay, poly) || pointInRing(s.bx, s.by, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    if (segmentsCross(s, { ax: p.x, ay: p.y, bx: q.x, by: q.y })) return 0;
    best = Math.min(
      best,
      pointSegDistance(s.ax, s.ay, p.x, p.y, q.x, q.y),
      pointSegDistance(s.bx, s.by, p.x, p.y, q.x, q.y),
      pointSegDistance(p.x, p.y, s.ax, s.ay, s.bx, s.by),
    );
  }
  return best;
}

/**
 * Remplace les traits enfermés dans des zones déjà fermées par le pourtour de ces zones : même bord extérieur
 * après fermeture, beaucoup moins de traits à épaissir.
 */
function reduceByRings(edges: readonly Seg[], rings: readonly Vec2[][], tol: number): Seg[] {
  if (rings.length === 0) return [...edges];
  const boxes = rings.map((r) => ringBox(r));
  const out: Seg[] = [];
  for (const e of edges) {
    const mx = (e.ax + e.bx) / 2;
    const my = (e.ay + e.by) / 2;
    let enclosed = false;
    for (let i = 0; i < rings.length && !enclosed; i++) {
      if (!inBox(mx, my, boxes[i]!, 2 * tol)) continue;
      const ring = rings[i]!;
      // Enfermé : les deux bouts et le milieu sont dans la zone ou sur son bord.
      const inside = (x: number, y: number): boolean => pointInRing(x, y, ring) || pointRingDistance(x, y, ring) <= 2 * tol;
      enclosed = inside(mx, my) && inside(e.ax, e.ay) && inside(e.bx, e.by);
    }
    if (!enclosed) out.push(e);
  }
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      out.push({ ax: p.x, ay: p.y, bx: q.x, by: q.y });
    }
  }
  return out;
}

interface Evidence {
  cat: 'window' | 'door';
  /** Indice de l'insertion ; −1 pour un trait isolé. */
  insert: number;
  box: Box;
  used: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Nom de bloc ou attributs → hauteur d'ouverture (m), contrôlée par la largeur mesurée. */
function openingHeight(ins: RawInsert | null, widthMetres: number | null): number | undefined {
  if (!ins) return undefined;
  const candidates: string[] = [ins.name];
  let w: string | null = null;
  let h: string | null = null;
  for (const [tag, value] of Object.entries(ins.attribs)) {
    const t = fold(tag);
    if (HEIGHT_TAG.test(t)) h = value;
    else if (WIDTH_TAG.test(t)) w = value;
    else candidates.push(value);
  }
  if (h !== null) {
    if (w !== null) candidates.unshift(`${w} x ${h}`);
    else if (widthMetres !== null) candidates.unshift(`${Math.round(widthMetres * 100)} x ${h}`);
  }
  for (const c of candidates) {
    const size = parseOpeningSize(c);
    if (!size) continue;
    // Une largeur annoncée très différente de la largeur mesurée : le texte parle d'autre chose.
    if (widthMetres !== null && Math.abs(size.width - widthMetres) > Math.max(0.15, 0.2 * widthMetres)) continue;
    return size.height;
  }
  return undefined;
}

export interface AnalyseOptions {
  /** Unité imposée (seconde passe après le contrôle par les surfaces écrites). */
  forcedPerMetre?: number;
}

export async function analyse(d: RawDrawing, options: AnalyseOptions, pause: () => Promise<void>): Promise<Analysis> {
  const cats: (LayerCategory | null)[] = d.layers.map((name) => classifyLayer(name));

  // ── Traits par calque ──
  const strokeCount = new Int32Array(d.layers.length);
  for (let i = 0; i < d.segCount; i++) {
    const k = d.segKind[i]!;
    if (k === SEG_LINE || k === SEG_POLY) strokeCount[d.segLayer[i]!]!++;
  }
  const collect = (keep: (layer: number) => boolean, straightOnly: boolean): Seg[] => {
    const out: Seg[] = [];
    for (let i = 0; i < d.segCount; i++) {
      const k = d.segKind[i]!;
      if (straightOnly ? k !== SEG_LINE && k !== SEG_POLY : !isStroke(k)) continue;
      if (keep(d.segLayer[i]!)) out.push(segAt(d, i));
    }
    return out;
  };

  let wallLayerIds = cats.map((c, i) => (c === 'wall' ? i : -1)).filter((i) => i >= 0);
  let wallSource: Analysis['wallSource'] = 'name';
  const namedCount = wallLayerIds.reduce((s, i) => s + strokeCount[i]!, 0);
  if (namedCount < 8) {
    wallLayerIds = [];
    wallSource = 'none';
  }

  // ── Unité ──
  const evidence = collectUnitEvidence(d, cats);
  const candidateLayer = (layer: number): boolean => cats[layer] === null || cats[layer] === 'wall';
  if (wallLayerIds.length > 0) {
    // Seulement sur des calques de murs NOMMÉS : ailleurs, deux murs d'une même pièce passent pour un mur épais.
    const sample = collect((l) => wallLayerIds.includes(l), true);
    // L'épaisseur des murs ne départage que mm / cm / m : sans objet si le dessin est en pouces ou en pieds.
    const imperial = evidence.some((e) => e.perMetre > 2 && e.perMetre < 50 && e.perMetre !== 10);
    if (sample.length <= 60_000 && !imperial) {
      const wallsEv = wallThicknessEvidence(sample);
      if (wallsEv) evidence.push(wallsEv);
    }
  }
  const choice = chooseUnit(evidence);
  const u = options.forcedPerMetre ?? choice.perMetre;
  const empty: Analysis = {
    perMetre: u,
    evidence,
    agreed: choice.agreed,
    wallLayers: [],
    wallSource: 'none',
    walls: null,
    plans: [],
    droppedPlans: 0,
    north: findNorth(d, cats),
    areaRatios: [],
  };
  if (u === null) return empty;
  await pause();

  // ── Calques de murs : repli géométrique (traits doubles parallèles) ──
  if (wallLayerIds.length === 0) {
    const scores: { layer: number; matched: number; share: number }[] = [];
    for (let layer = 0; layer < d.layers.length; layer++) {
      if (!candidateLayer(layer) || strokeCount[layer]! < 8) continue;
      const segs = collect((l) => l === layer, true);
      if (segs.length > 60_000) continue;
      scores.push({ layer, ...parallelPairScore(segs, u) });
    }
    scores.sort((a, b) => b.matched - a.matched);
    const best = scores[0];
    if (best && best.matched > 10 * u && best.share > 0.4) {
      wallLayerIds = [best.layer];
      for (const s of scores.slice(1)) if (s.matched > 0.5 * best.matched && s.share > 0.5) wallLayerIds.push(s.layer);
      wallSource = 'geometry';
    }
    await pause();
  }
  if (wallLayerIds.length === 0) return empty;

  const wallSet = new Set(wallLayerIds);
  const wallSegs = collect((l) => wallSet.has(l), false);
  if (wallSegs.length > MAX_WALL_SEGMENTS) {
    // Au-delà, l'analyse bloquerait le navigateur pendant de longues secondes : on rend le dessin sans propositions.
    return { ...empty, wallLayers: wallLayerIds.map((i) => d.layers[i]!), wallSource, tooHeavy: wallSegs.length };
  }
  const zero = d.layers.indexOf('0');
  const layer0: Seg[] = [];
  if (zero >= 0 && !wallSet.has(zero)) {
    for (let i = 0; i < d.segCount; i++) if (d.segLayer[i] === zero && d.segKind[i] === SEG_LINE) layer0.push(segAt(d, i));
  }

  // ── Textes utiles ──
  const visibleTexts = d.texts.filter((t) => !t.dim && !t.hidden && t.text.length > 0);
  const labelPts: Vec2[] = [];
  for (const t of visibleTexts) {
    if (parseRoomLabel(t.text.replace(/\n/g, ' '))?.name) labelPts.push({ x: t.cx, y: t.cy });
  }

  // ── Modèle exact des murs ──
  const walls = buildWalls(wallSegs, layer0, labelPts, u);
  await pause();

  const tol = 0.01 * u;
  const edges: Seg[] = [...walls.segs];
  for (const b of walls.bridges) {
    for (let i = 0; i < 4; i++) {
      const p = b.quad[i]!;
      const q = b.quad[(i + 1) % 4]!;
      edges.push({ ax: p.x, ay: p.y, bx: q.x, by: q.y });
    }
  }

  // ── Plans : une tache par bâtiment dessiné (fermeture large) ──
  const R = [0.25, 0.6, 1.25];
  const big = (ring: readonly Vec2[]): boolean => {
    const b = ringBox(ring);
    return ringArea(ring) >= 9 * u * u && Math.min(b.maxX - b.minX, b.maxY - b.minY) >= 2 * u;
  };
  const result: Analysis = { ...empty, wallLayers: wallLayerIds.map((i) => d.layers[i]!), wallSource, walls };
  const rings1 = closeOutline(edges, [], R[0]! * u);
  await pause();
  // Les fermetures larges coûtent cher (≈ 3 ms par trait) : on ne leur donne que ce qui compte pour le bord
  // extérieur — le pourtour des zones déjà fermées et les traits qui n'y sont pas enfermés.
  const reduced = reduceByRings(edges, rings1.filter((r) => ringArea(r) >= u * u), tol);
  const rings3 = closeOutline(reduced, [], R[2]! * u).filter(big);
  await pause();
  if (rings3.length === 0) return result;
  const hulls = rings3.slice(0, MAX_PLANS);
  result.droppedPlans = rings3.length - hulls.length;
  let rings2: Vec2[][] | null = null;
  const largestInside = (rings: readonly Vec2[][], hull: readonly Vec2[], box: Box): Vec2[] | null => {
    for (const ring of rings) {
      // Les anneaux sont triés du plus grand au plus petit.
      const v = ring[0]!;
      if (!inBox(v.x, v.y, box, 2 * tol)) continue;
      if (pointInRing(v.x, v.y, hull) || pointRingDistance(v.x, v.y, hull) <= 4 * tol) return ring;
    }
    return null;
  };

  // ── Indices d'ouvertures : blocs et traits des calques de portes / fenêtres ──
  const evidenceList: Evidence[] = [];
  const insertEvidence = new Int32Array(d.inserts.length).fill(-1);
  d.inserts.forEach((ins, idx) => {
    if (ins.segEnd <= ins.segStart) return;
    const layerCat = cats[ins.layer] ?? null;
    const nameCat = classifyLayer(ins.name);
    const cat = layerCat === 'window' || layerCat === 'door' ? layerCat : nameCat === 'window' || nameCat === 'door' ? nameCat : null;
    if (!cat) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = ins.segStart; i < ins.segEnd; i++) {
      for (let k = 0; k < 4; k += 2) {
        const x = d.segXY[4 * i + k]!;
        const y = d.segXY[4 * i + k + 1]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    // Un « bloc » de plus de 12 m n'est pas une menuiserie (plan entier inséré comme xref lié).
    if (Math.max(maxX - minX, maxY - minY) > 12 * u) return;
    insertEvidence[idx] = evidenceList.length;
    evidenceList.push({ cat, insert: idx, box: { minX, minY, maxX, maxY }, used: false });
  });
  const inEvidenceInsert = (insert: number): boolean => {
    for (let i = insert; i >= 0; i = d.inserts[i]!.parent) if (insertEvidence[i]! >= 0) return true;
    return false;
  };
  const looseGrid = new SegGrid(0.5 * u);
  const looseSegs: Seg[] = [];
  const looseCat: ('window' | 'door')[] = [];
  for (let i = 0; i < d.segCount; i++) {
    const cat = cats[d.segLayer[i]!] ?? null;
    if ((cat !== 'window' && cat !== 'door') || !isStroke(d.segKind[i]!)) continue;
    if (inEvidenceInsert(d.segInsert[i]!)) continue;
    looseGrid.add(looseSegs.length, segAt(d, i));
    looseSegs.push(segAt(d, i));
    looseCat.push(cat);
  }
  // Un quart de cercle de 0,5 à 1,25 m est un débattement de porte, même sur un calque « ouvertures » mixte.
  const doorArcs = d.arcs.filter((a) => {
    const cat = cats[a.layer] ?? null;
    return (cat === 'window' || cat === 'door') && a.sweep >= 80 && a.sweep <= 100 && a.radius >= 0.5 * u && a.radius <= 1.25 * u && !inEvidenceInsert(a.insert);
  });

  interface Hit {
    cat: 'window' | 'door';
    insert: number;
    dist: number;
  }
  const classifyBridge = (b: Bridge): { hit: Hit | null; compound: boolean } => {
    const reach = 0.12 * u;
    const box = ringBox(b.quad);
    const hits: Hit[] = [];
    const spans: [number, number][] = [];
    const touched: Evidence[] = [];
    for (const ev of evidenceList) {
      if (ev.box.maxX < box.minX - reach || ev.box.minX > box.maxX + reach || ev.box.maxY < box.minY - reach || ev.box.minY > box.maxY + reach) continue;
      const ins = d.inserts[ev.insert]!;
      let best = Infinity;
      let centre = Infinity;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = ins.segStart; i < ins.segEnd; i++) {
        const s = segAt(d, i);
        const dist = segPolyDistance(s, b.quad);
        if (dist < best) best = dist;
        centre = Math.min(centre, pointSegDistance(b.cx, b.cy, s.ax, s.ay, s.bx, s.by));
        // Emprise du bloc le long du mur, mesurée depuis le centre de l'ouverture.
        const t1 = (s.ax - b.cx) * b.dirX + (s.ay - b.cy) * b.dirY;
        const t2 = (s.bx - b.cx) * b.dirX + (s.by - b.cy) * b.dirY;
        lo = Math.min(lo, t1, t2);
        hi = Math.max(hi, t1, t2);
      }
      if (best <= reach) {
        ev.used = true;
        touched.push(ev);
        hits.push({ cat: ev.cat, insert: ev.insert, dist: centre });
        spans.push([Math.max(lo, -b.width / 2), Math.min(hi, b.width / 2)]);
      }
    }
    // Plusieurs menuiseries disjointes qui ne couvrent pas l'intervalle : le « pont » enjambe en réalité un morceau
    // de mur manquant. On ne le propose pas ; les blocs seront repris un par un.
    if (spans.length >= 2) {
      spans.sort((p, q) => p[0] - q[0]);
      let groups = 0;
      let covered = 0;
      let end = -Infinity;
      for (const [from, to] of spans) {
        if (to <= from) continue;
        if (from > end + 0.05 * u) groups++;
        covered += Math.max(0, to - Math.max(from, end));
        end = Math.max(end, to);
      }
      if (groups >= 2 && covered < 0.75 * b.width) {
        for (const ev of touched) ev.used = false;
        return { hit: null, compound: true };
      }
    }
    for (const i of looseGrid.query(box.minX - reach, box.minY - reach, box.maxX + reach, box.maxY + reach)) {
      const s = looseSegs[i]!;
      if (segPolyDistance(s, b.quad) <= reach) hits.push({ cat: looseCat[i]!, insert: -1, dist: pointSegDistance(b.cx, b.cy, s.ax, s.ay, s.bx, s.by) });
    }
    for (const a of doorArcs) {
      if (!inBox(a.cx, a.cy, box, reach)) continue;
      if (pointInRing(a.cx, a.cy, b.quad) || pointRingDistance(a.cx, a.cy, b.quad) <= reach) hits.push({ cat: 'door', insert: -1, dist: Math.hypot(a.cx - b.cx, a.cy - b.cy) });
    }
    if (hits.length === 0) return { hit: null, compound: false };
    // Un bloc prime sur des traits isolés, une porte sur une fenêtre, le plus proche sur le plus lointain.
    hits.sort((p, q) => Number(p.insert < 0) - Number(q.insert < 0) || Number(p.cat !== 'door') - Number(q.cat !== 'door') || p.dist - q.dist);
    return { hit: hits[0]!, compound: false };
  };
  // Tous les ponts sont classés (aussi les portes intérieures) pour marquer les blocs déjà « consommés ».
  const bridgeHits = walls.bridges.map((b) => classifyBridge(b));

  // ── Titres ──
  const titleHeights = visibleTexts.map((t) => t.height).filter((h) => h > 0);
  const medianHeight = titleHeights.length > 0 ? median(titleHeights) : 0;
  const titles = visibleTexts
    .map((t) => ({ t, flat: t.text.replace(/\n/g, ' ') }))
    .filter(({ t, flat }) => flat.length <= 45 && t.height >= medianHeight)
    .map(({ t, flat }) => {
      // « Coupe sur le rez-de-chaussée » est une coupe : le mot de vue l'emporte sur le nom du niveau.
      const view = VIEW_RE.test(fold(flat));
      return { t, flat, storey: view ? null : guessStorey(flat), view };
    })
    .filter((c) => c.storey !== null || c.view);

  const boxes = hulls.map((h) => ringBox(h));
  const nearestPlan = (x: number, y: number): number => {
    let best = -1;
    let bestD = Infinity;
    boxes.forEach((b, i) => {
      const dist = boxDistance(x, y, b);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    return best;
  };

  for (let k = 0; k < hulls.length; k++) {
    const hull = hulls[k]!;
    const box = boxes[k]!;
    const a3 = ringArea(hull);
    const jambsHere = walls.freeJambs.filter((p) => inBox(p.x, p.y, box, tol) && (pointInRing(p.x, p.y, hull) || pointRingDistance(p.x, p.y, hull) <= 4 * tol));

    // ── Contour : la plus petite fermeture qui donne (presque) la même emprise que la plus large ──
    let ring: Vec2[] = hull;
    let mode: OutlineMode = 'approx';
    let radius = R[2]!;
    const ring1 = largestInside(rings1, hull, box);
    const a1 = ring1 ? ringArea(ring1) : 0;
    const compact1 = ring1 !== null && a1 >= 9 * u * u && a1 / ringPerimeter(ring1) >= 0.6 * u;
    if (ring1 && compact1 && jambsHere.length === 0 && a1 >= 0.5 * a3) {
      ring = ring1;
      mode = 'exact';
      radius = R[0]!;
    } else if (ring1 && a1 >= 0.97 * a3) {
      ring = ring1;
      mode = 'stable';
      radius = R[0]!;
    } else {
      if (!rings2) {
        rings2 = closeOutline(reduced, [], R[1]! * u);
        await pause();
      }
      const ring2 = largestInside(rings2, hull, box);
      if (ring2 && ringArea(ring2) >= 0.97 * a3) {
        ring = ring2;
        mode = 'stable';
        radius = R[1]!;
      }
    }
    let outline: Vec2[] | undefined = simplifyRing(ring, tol);
    if (outline.length < 3 || isSelfIntersecting(outline)) outline = ring.length <= 2000 && !isSelfIntersecting(ring) ? ring : undefined;
    if (outline) {
      const area = ringArea(outline);
      if (area < 9 * u * u || area / ringPerimeter(outline) < 0.5 * u) outline = undefined;
    }
    if (!outline) mode = 'none';
    const boundary = outline ?? hull;

    // ── Titre du plan ──
    let title: string | undefined;
    let storey: PlanAnalysis['storey'];
    let viewTitle: string | undefined;
    {
      let bestD = 8 * u;
      for (const c of titles) {
        if (nearestPlan(c.t.cx, c.t.cy) !== k) continue;
        if (pointInRing(c.t.cx, c.t.cy, boundary)) continue; // un nom de pièce (« Cave », « Grenier ») n'est pas un titre
        const dist = boxDistance(c.t.cx, c.t.cy, box);
        if (dist >= bestD) continue;
        bestD = dist;
        if (c.storey) {
          title = c.flat;
          storey = c.storey;
          viewTitle = undefined;
        } else {
          title = undefined;
          storey = undefined;
          viewTitle = c.flat;
        }
      }
    }

    // ── Pièces ──
    const labelTexts: PlanText[] = [];
    for (const t of visibleTexts) {
      const cat = cats[t.layer] ?? null;
      if (cat === 'dim' || cat === 'axis') continue;
      if (!inBox(t.cx, t.cy, box, tol)) continue;
      if (!pointInRing(t.cx, t.cy, boundary)) continue;
      const pt: PlanText = { text: t.text.replace(/\n/g, ' '), x: t.cx, y: t.cy };
      if (t.height > 0) pt.height = t.height;
      labelTexts.push(pt);
    }
    const rooms = roomsFromTexts(labelTexts);
    const holes: { ring: Vec2[]; area: number; box: Box }[] = [];
    for (const comp of walls.comps) {
      for (const h of comp.holes) {
        const area = ringArea(h);
        if (area < 0.3 * u * u) continue;
        const hb = ringBox(h);
        if (hb.maxX < box.minX || hb.minX > box.maxX || hb.maxY < box.minY || hb.minY > box.maxY) continue;
        holes.push({ ring: h, area, box: hb });
      }
    }
    holes.sort((p, q) => p.area - q.area);
    const holeOf = rooms.map((r) => {
      if (!r.at) return -1;
      for (let i = 0; i < holes.length; i++) {
        const h = holes[i]!;
        if (inBox(r.at.x, r.at.y, h.box, 0) && pointInRing(r.at.x, r.at.y, h.ring)) return i;
      }
      return -1;
    });
    const mergedRooms: string[][] = [];
    const areaMismatches: [string, number, number][] = [];
    const ratios: number[] = [];
    holes.forEach((h, i) => {
      const inside = rooms.filter((_r, ri) => holeOf[ri] === i);
      if (inside.length === 1) {
        const room = inside[0]!;
        room.polygon = simplifyRing(h.ring, tol * 0.2);
        room.measuredArea = Math.round((h.area / (u * u)) * 1000) / 1000;
        if (room.statedArea !== undefined && room.statedArea > 0) {
          ratios.push(room.measuredArea / room.statedArea);
          if (Math.abs(room.statedArea - room.measuredArea) > Math.max(0.3, 0.03 * room.measuredArea)) {
            areaMismatches.push([room.name, room.statedArea, room.measuredArea]);
          }
        }
      } else if (inside.length > 1) {
        mergedRooms.push(inside.map((r) => r.name));
      }
    });
    result.areaRatios.push(...ratios);

    // ── Ouvertures sur le contour ──
    const openings: PlanOpening[] = [];
    let rejected = 0;
    if (outline) {
      walls.bridges.forEach((b, bi) => {
        if (!inBox(b.cx, b.cy, box, tol)) return;
        if (pointRingDistance(b.cx, b.cy, outline) > b.thick / 2 + 3 * tol) return;
        const classified = bridgeHits[bi]!;
        if (classified.compound) return;
        const hit = classified.hit;
        const metres = b.width / u;
        const plausible = hit ? metres >= 0.4 && metres <= 5.5 : metres >= 0.5 && metres <= 3;
        if (!plausible) {
          rejected++;
          return;
        }
        // Extrémités sur la face extérieure du mur : pour chaque tableau, le coin le plus proche du contour.
        const pick = (p: Vec2, q: Vec2): Vec2 => (pointRingDistance(p.x, p.y, outline) <= pointRingDistance(q.x, q.y, outline) ? p : q);
        const a = pick(b.quad[0]!, b.quad[1]!);
        const bb = pick(b.quad[2]!, b.quad[3]!);
        const opening: PlanOpening = { kind: hit ? hit.cat : 'unknown', a: { x: a.x, y: a.y }, b: { x: bb.x, y: bb.y }, width: b.width, source: 'gap' };
        const height = openingHeight(hit && hit.insert >= 0 ? d.inserts[hit.insert]! : null, metres);
        if (height !== undefined) opening.height = height;
        openings.push(opening);
      });

      // Blocs posés sur un mur que le dessin n'interrompt pas (murs « traversants »).
      for (const ev of evidenceList) {
        if (ev.used) continue;
        const cx = (ev.box.minX + ev.box.maxX) / 2;
        const cy = (ev.box.minY + ev.box.maxY) / 2;
        if (!inBox(cx, cy, box, tol)) continue;
        // Arête du contour la plus proche du centre du bloc.
        let bestD = Infinity;
        let ex = 1;
        let ey = 0;
        let fx = cx;
        let fy = cy;
        for (let i = 0; i < outline.length; i++) {
          const p = outline[i]!;
          const q = outline[(i + 1) % outline.length]!;
          const dist = pointSegDistance(cx, cy, p.x, p.y, q.x, q.y);
          if (dist < bestD) {
            bestD = dist;
            const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
            ex = (q.x - p.x) / len;
            ey = (q.y - p.y) / len;
            const t = Math.max(0, Math.min(len, (cx - p.x) * ex + (cy - p.y) * ey));
            fx = p.x + ex * t;
            fy = p.y + ey * t;
          }
        }
        if (bestD > 0.45 * u) continue;
        const ins = d.inserts[ev.insert]!;
        let lo = Infinity;
        let hi = -Infinity;
        let across = 0;
        for (let i = ins.segStart; i < ins.segEnd; i++) {
          for (let c = 0; c < 4; c += 2) {
            const x = d.segXY[4 * i + c]! - fx;
            const y = d.segXY[4 * i + c + 1]! - fy;
            const along = x * ex + y * ey;
            if (along < lo) lo = along;
            if (along > hi) hi = along;
            across = Math.max(across, Math.abs(-x * ey + y * ex));
          }
        }
        let width = hi - lo;
        let radius90 = 0;
        for (let i = ins.arcStart; i < ins.arcEnd; i++) {
          const arc = d.arcs[i]!;
          if (arc.sweep >= 80 && arc.sweep <= 100) radius90 = Math.max(radius90, arc.radius);
        }
        if (ev.cat === 'door') {
          if (radius90 <= 0) continue;
          width = radius90;
        } else if (across > 0.7 * u) {
          continue; // trop saillant pour être dans l'épaisseur du mur
        }
        const metres = width / u;
        if (!(metres >= 0.4 && metres <= 4)) {
          rejected++;
          continue;
        }
        ev.used = true;
        const mid = (lo + hi) / 2;
        const opening: PlanOpening = {
          kind: ev.cat,
          a: { x: fx + ex * (mid - width / 2), y: fy + ey * (mid - width / 2) },
          b: { x: fx + ex * (mid + width / 2), y: fy + ey * (mid + width / 2) },
          width,
          source: 'insert',
        };
        const height = openingHeight(ins, metres);
        if (height !== undefined) opening.height = height;
        openings.push(opening);
      }
    }

    result.plans.push({
      hull,
      box,
      outline,
      outlineMode: mode,
      closeRadius: radius,
      rooms,
      openings,
      title,
      storey,
      viewTitle,
      unpairedJambs: jambsHere.length,
      mergedRooms,
      areaMismatches,
      rejectedOpenings: rejected,
      unheatedInside: outline ? rooms.filter((r) => r.heatedGuess === 'no').map((r) => r.name) : [],
    });
    await pause();
  }
  return result;
}

/** Flèche du nord : bloc dont le nom (ou le calque) désigne le nord ; on suppose qu'elle pointe vers +Y dans le bloc. */
function findNorth(d: RawDrawing, cats: readonly (LayerCategory | null)[]): Analysis['north'] {
  let found: { angle: number; block: string } | null = null;
  let count = 0;
  for (const ins of d.inserts) {
    const byName = isNorthArrowName(ins.name);
    const size = ins.segEnd - ins.segStart;
    const byLayer = !byName && cats[ins.layer] === 'symbol' && isNorthArrowName(d.layers[ins.layer] ?? '') && size >= 2 && size <= 300;
    if (!byName && !byLayer) continue;
    count++;
    if (found) continue;
    // Direction du nord dans le dessin (y vers le haut) → azimut du HAUT de la feuille.
    const bearing = (Math.atan2(ins.upX, ins.upY) * 180) / Math.PI;
    let angle = -bearing % 360;
    if (angle < 0) angle += 360;
    found = { angle: Math.round(angle * 100) / 100 === 360 ? 0 : Math.round(angle * 100) / 100, block: ins.name };
  }
  return found ? { ...found, count } : null;
}
