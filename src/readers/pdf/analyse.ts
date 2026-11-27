/**
 * Analyse des pages extraites d'un PDF → feuilles de plan (PlanDocument). Aucune dépendance à pdf.js ni au
 * navigateur : l'entrée est la représentation intermédiaire de raw.ts.
 *
 * Par page :
 *  1. échelle = recoupement de trois indices indépendants (cartouche, consensus des cotes, surfaces écrites) ;
 *  2. murs = classe de traits la plus épaisse hors cadre ; chaque « tache » de murs refermée est une vue ;
 *  3. une vue est un plan d'étage ou une coupe d'après son titre, ses niveaux et ses pièces ;
 *  4. une feuille par plan : contour (fermeture robuste), pièces (étiquettes + faces si fiables), ouvertures ;
 *  5. les hauteurs lues sur les coupes du document sont distribuées aux feuilles par niveau.
 *
 * Tout ce qui est proposé est accompagné d'une remarque disant d'où il vient ; ce qui n'est pas fiable n'est
 * pas proposé (contour `undefined` + remarque) plutôt que proposé faux.
 */
import { cleanPolygon, isSelfIntersecting, normDeg, round } from '../../core/geometry';
import type { BBox, DetectedOpening, DetectedRoom, Lang, PlanDocument, PlanSheet, PlanText, Sourced, Vec2 } from '../../core/types';
import { formatNumber } from '../../i18n';
import { fold, guessStorey, looksLikeRoomName, parseClearHeight, roomsFromTexts } from '../../semantics/labels';
import { msg } from './messages';
import { detectOpenings } from './openings';
import { pointInPoly, pointInRing, pointRingDistance, polyArea, ringArea, simplifyRing } from './planar';
import type { Poly } from './planar';
import { METRES_PER_POINT } from './raw';
import type { RawPage, RawSeg, RawText } from './raw';
import { freeRoomName, isTotalLabel, roomAreaOf, roomyPoint } from './rooms';
import { STANDARD_SCALES, calibrateObservations, chooseDimensionScale, declaredScales, dimensionObservations, dimensionUnitHint, secondDimensionCluster } from './scale';
import type { DeclaredScale, DimChoice, DimObservation, DimUnit } from './scale';
import { drawingRegions } from './regions';
import { TITLE_BLOCK_RE, frameBox, inFrameCorner, isTitleBlockText } from './titleblock';
import { buildFaces, calibrateByAreas, closedOutlines, faceAt, findWallClass, wallGaps } from './walls';
import type { AreaCalibration, Faces, WallClass, WallGap } from './walls';

// ───────────────────────────── Réglages ─────────────────────────────

/** Rayon de fermeture du contour (m réels) : referme les ouvertures jusqu'à 2,6 m — valeur validée sur les plans d'essai. */
export const CLOSING_RADIUS_M = 1.3;
/** Au-delà de ce nombre de traits de murs, le contour n'est pas cherché (hachures ou mobilier au trait de mur). */
const MAX_CLOSING_SEGMENTS = 12_000;
/** Largeur maximale (m) d'une ouverture de mur reconnue par ses deux faces interrompues (porte de garage double). */
const MAX_OPENING_M = 6;
/** Une tache de murs plus petite n'est pas une vue (flèche du nord, légende, symbole). */
const MIN_VIEW_AREA_M2 = 6;
/** Nombre de traits au-delà duquel l'affichage d'une feuille est allégé. */
export const MAX_DISPLAY_SEGMENTS = 150_000;
/** En dessous, une page n'a pas de dessin vectoriel exploitable. */
const MIN_VECTOR_SEGMENTS = 20;
/** Tolérance entre surface écrite et surface mesurée pour accepter le polygone d'une pièce. */
const ROOM_AREA_TOLERANCE = 0.03;

export interface AnalyseOptions {
  /** Langue des avertissements et remarques (français par défaut, comme le veut le contrat). */
  lang?: Lang;
}

/** Où se trouve une feuille dans le PDF : sert à produire son image de fond. */
export interface SheetPlacement {
  /** Numéro de page (à partir de 1). */
  page: number;
  /** Rotation de vue à utiliser pour le rendu. */
  rotation: number;
  pageWidth: number;
  pageHeight: number;
  /** Vrai si la page est surtout une image (scan) : rendu à la résolution de l'image, en JPEG. */
  raster: boolean;
  pixelsPerPoint: number;
}

/**
 * Nature d'une page : dessin vectoriel avec texte ; image seule (scan) ; dessin dont les textes sont des contours ;
 * dessin sans aucun texte ; page sans dessin exploitable.
 */
export type PageKind = 'vector' | 'raster' | 'outlined-text' | 'no-text' | 'empty';

/** Compte rendu d'analyse d'une page (diagnostic et tests ; hors contrat PlanDocument). */
export interface PageReport {
  page: number;
  kind: PageKind;
  /** Échelles annoncées sur la page (dénominateurs). */
  declared: number[];
  dims: DimChoice | null;
  areas: AreaCalibration | null;
  /** Dénominateur retenu ; null si inconnu. */
  scaleDen: number | null;
  wallWidth: number | null;
  /** Vues trouvées : plan d'étage, coupe ou façade, ou tache de murs sans titre ni pièce (« other », non proposée). */
  views: { kind: 'plan' | 'section' | 'other'; title: string | null; areaM2: number }[];
  /** Nombre de feuilles produites par cette page. */
  sheets: number;
}

export interface PdfAnalysis {
  doc: PlanDocument;
  /** Une entrée par feuille de `doc.sheets`, dans le même ordre. */
  placements: SheetPlacement[];
  pages: PageReport[];
}

// ───────────────────────────── Outils ─────────────────────────────

function capitalise(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function scaleLabel(den: number): string {
  const r = Math.round(den);
  return Math.abs(den - r) < 0.05 ? `1:${r}` : `1:${formatNumber(den, 1)}`;
}

function snapToStandard(den: number, tolerance: number): number {
  for (const s of STANDARD_SCALES) if (Math.abs(den / s - 1) <= tolerance) return s;
  return den;
}

function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '');
}

function ringBBox(ring: readonly Vec2[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Distance d'un point à un rectangle (0 s'il est dedans). */
function rectDistance(x: number, y: number, b: BBox): number {
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dy = Math.max(b.minY - y, 0, y - b.maxY);
  return Math.hypot(dx, dy);
}

/** Textes au format du contrat, ancrés au CENTRE de leur boîte : c'est ce qui convient à l'appariement nom ↔ surface. */
function centredTexts(texts: readonly RawText[]): PlanText[] {
  return texts.map((t) => ({ text: t.s, x: t.cx, y: t.cy, height: t.size }));
}

const SECTION_RE = /\b(coupe|schnitt|querschnitt|langsschnitt|section|facade|fassade|ansicht|elevation|pignon|detail|vue (?:nord|sud|est|ouest|de face|laterale|arriere))\b/;
const PLAN_RE = /\b(plan|grundriss|niveau|ebene|geschoss)\b/;
/** Plan de situation ou d'implantation : il montre la parcelle et les voisins, pas un étage (« Plan de situation 1:500 »). */
const SITE_RE = /\b(plan de situation|situation|plan d'implantation|implantation|plan de masse|lageplan|ubersichtsplan|katasterplan|plan cadastral|site plan)\b/;
/** Étiquettes d'espaces EXTÉRIEURS : normales hors du contour, elles ne signalent pas une fuite. */
const OUTDOOR_RE = /terrasse|balcon|balkon|loggia|jardin|garten|\bcour\b|\bhof\b|pergola|carport|car-port|abri|parking|stellplatz|entree|eingang|zufahrt|acces|rue|strasse|trottoir/;
const LEVEL_RE = /^\s*([+\-±−])\s?(\d{1,2}[.,]\d{2})\s*m?\s*$/;

// ───────────────────────────── Échelle ─────────────────────────────

interface ScaleDecision {
  den: number | null;
  sourced: Sourced<number> | null;
  warnings: string[];
  declared: number[];
  dims: DimChoice | null;
  areas: AreaCalibration | null;
  /** Faces construites à l'échelle retenue (null sans murs ou sans échelle). */
  faces: Faces | null;
}

/**
 * Indices d'échelle d'une PAGE ou d'une VUE. L'échelle se décide par vue quand la page en porte plusieurs : un plan
 * au 1:100 dessiné à côté d'une coupe au 1:50 n'a ni les cotes ni l'intitulé de sa voisine.
 */
interface ScaleEvidence {
  /** Échelles annoncées utilisables (dénominateurs distincts, les plus crédibles d'abord). */
  declared: number[];
  /** D'où elles viennent : cartouche ou texte de la page (`block`), ou intitulé écrit près de la vue (`caption`). */
  source: 'block' | 'caption';
  observations: readonly DimObservation[];
  /** Unité des cotes entières, si le plan la dit. */
  hint: DimUnit | null;
  /** Étiquettes de pièces portant une surface écrite (centre du nom, uf). */
  labels: { x: number; y: number; area: number }[];
  walls: WallClass | null;
}

function validAreas(a: AreaCalibration | null): a is AreaCalibration {
  return !!a && a.inliers >= 3 && a.inliers >= 0.6 * a.n && Number.isFinite(a.den);
}

/** Consensus solide : au moins 4 cotes d'accord, et la majorité des cotes lues. */
function isStrongDims(d: DimChoice | null): boolean {
  return !!d && d.inliers >= 4 && d.inliers >= 0.6 * d.n;
}

/** Consensus faible : 2 ou 3 cotes d'accord, ou une courte majorité. */
function isWeakDims(d: DimChoice | null): boolean {
  return !!d && !isStrongDims(d) && d.inliers >= 2 && d.inliers >= 0.5 * d.n;
}

/** Étiquettes de pièces qui portent une surface, parmi les textes donnés (pour le calibrage par les surfaces). */
function areaLabels(texts: readonly RawText[]): { x: number; y: number; area: number }[] {
  return roomsFromTexts(centredTexts(texts.filter((t) => Math.abs(t.angle) < 1)))
    .filter((r) => r.at && r.statedArea !== undefined)
    .map((r) => ({ x: r.at!.x, y: r.at!.y, area: r.statedArea! }));
}

function decideScale(evidence: ScaleEvidence, lang: Lang, where: string): ScaleDecision {
  const { declared, walls, labels, hint } = evidence;
  // Tournures propres à l'origine de l'échelle annoncée (cartouche ou intitulé de vue), pour des phrases correctes.
  const origin = {
    source: msg(lang, `pdf.source.${evidence.source}`),
    sourceSays: msg(lang, `pdf.source.${evidence.source}.says`),
    sourceFrom: msg(lang, `pdf.source.${evidence.source}.from`),
  };
  const say = (key: string, params: Record<string, string | number> = {}): string => capitalise(msg(lang, key, { where, ...origin, ...params }));
  const note = (key: string, params: Record<string, string | number>): string => msg(lang, key, { ...origin, ...params });
  const cal = calibrateObservations(evidence.observations);
  let dims = chooseDimensionScale(cal, declared, hint);

  // Surfaces écrites dans les pièces : calibrage sans unité, qui demande les faces des murs — donc une échelle
  // de départ pour les seuils (ouvertures, épaisseurs). On part du meilleur indice disponible, sinon on essaie.
  let areas: AreaCalibration | null = null;
  let faces: Faces | null = null;
  let facesDen = 0;
  if (walls && labels.length >= 2) {
    const seeds = dims && isStrongDims(dims) ? [dims.den] : declared.length > 0 ? [declared[0]!] : dims && isWeakDims(dims) ? [dims.den] : [100, 50, 200];
    for (const seed of seeds) {
      let f = buildFaces(walls, seed * METRES_PER_POINT, MAX_OPENING_M);
      let a = calibrateByAreas(labels, f.faces);
      let den = seed;
      if (validAreas(a) && Math.abs(a.den / seed - 1) > 0.1) {
        // L'échelle de départ était loin du compte : on refait les faces avec celle que donnent les surfaces.
        const f2 = buildFaces(walls, a.den * METRES_PER_POINT, MAX_OPENING_M);
        const a2 = calibrateByAreas(labels, f2.faces);
        if (validAreas(a2) && a2.inliers >= a.inliers) {
          den = a.den;
          f = f2;
          a = a2;
        }
      }
      if (a.n > 0 && (!areas || a.inliers > areas.inliers)) {
        areas = a;
        faces = f;
        facesDen = den;
      }
      if (validAreas(a)) break;
    }
  }
  // Les surfaces départagent une unité de cotes restée incertaine.
  if (dims?.ambiguous && validAreas(areas)) dims = chooseDimensionScale(cal, [areas.den], hint);
  const strongDims: DimChoice | null = dims && isStrongDims(dims) ? dims : null;
  const weakDims: DimChoice | null = dims && isWeakDims(dims) ? dims : null;

  const warnings: string[] = [];
  const chosen: { den: number | null; sourced: Sourced<number> | null } = { den: null, sourced: null };
  const set = (value: number, from: Sourced<number>['from'], text: string): void => {
    chosen.den = value;
    chosen.sourced = { value: value * METRES_PER_POINT, from, note: text };
  };
  const rooms = areas?.inliers ?? 0;

  if (strongDims) {
    const d = strongDims;
    const match = declared.find((t) => Math.abs(d.den / t - 1) <= 0.01);
    const areasAgree = validAreas(areas) && Math.abs(areas.den / d.den - 1) <= 0.03;
    if (match !== undefined) {
      // Écart infime : c'est l'échelle nominale, exacte ; sinon la mesure fait foi.
      const exact = Math.abs(d.den / match - 1) <= 0.002;
      const value = exact ? match : d.den;
      const key = !exact ? 'pdf.scale.near.dims' : areasAgree ? 'pdf.scale.agree.dimsAreas' : 'pdf.scale.agree.dims';
      set(value, 'plan', note(key, { scale: scaleLabel(value), dims: d.inliers, rooms, declared: scaleLabel(match) }));
    } else if (declared.length > 0) {
      const value = snapToStandard(d.den, 0.002);
      set(value, 'plan', note('pdf.scale.dims.contradict', { scale: scaleLabel(value), dims: d.inliers, declared: scaleLabel(declared[0]!) }));
      warnings.push(say('pdf.warn.scale.contradict', { scale: scaleLabel(value), declared: scaleLabel(declared[0]!) }));
    } else {
      const value = snapToStandard(d.den, 0.002);
      const unit = msg(lang, `pdf.unit.${d.unit}`);
      if (d.ambiguous && !areasAgree) {
        set(value, 'estimate', note('pdf.scale.dims.ambiguous', { scale: scaleLabel(value), dims: d.inliers, unit }));
        warnings.push(say('pdf.warn.scale.estimate'));
      } else {
        const key = areasAgree ? 'pdf.scale.dimsAreas' : 'pdf.scale.dims';
        set(value, 'plan', note(key, { scale: scaleLabel(value), dims: d.inliers, rooms, unit }));
      }
    }
    if (validAreas(areas) && !areasAgree && chosen.den !== null && chosen.sourced !== null) {
      // Deux indices indépendants se contredisent : la valeur n'est plus « lue sur le plan », l'expert tranche.
      const byAreas = scaleLabel(Math.round(areas.den));
      warnings.push(say('pdf.warn.scale.areasDisagree', { scale: scaleLabel(chosen.den), areas: byAreas }));
      chosen.sourced = { value: chosen.sourced.value, from: 'estimate', note: `${chosen.sourced.note ?? ''} ${note('pdf.scale.areasDisagree', { rooms, areas: byAreas })}`.trim() };
    }
  } else if (declared.length > 0) {
    const first = declared[0]!;
    if (validAreas(areas)) {
      const a = areas;
      const match = declared.find((t) => Math.abs(a.den / t - 1) <= 0.03);
      if (match !== undefined) {
        set(match, 'plan', note('pdf.scale.agree.areas', { scale: scaleLabel(match), rooms }));
      } else {
        const value = snapToStandard(Math.round(a.den * 10) / 10, 0.01);
        set(value, 'estimate', note('pdf.scale.areas.contradict', { scale: scaleLabel(value), rooms, declared: scaleLabel(first) }));
        warnings.push(say('pdf.warn.scale.contradict.areas', { scale: scaleLabel(value), declared: scaleLabel(first) }));
      }
    } else {
      const d = weakDims;
      const match = d ? declared.find((t) => Math.abs(d.den / t - 1) <= 0.01) : undefined;
      if (d && match !== undefined) {
        set(match, 'plan', note('pdf.scale.agree.dims', { scale: scaleLabel(match), dims: d.inliers }));
      } else {
        const key = declared.length > 1 ? 'pdf.scale.title.several' : 'pdf.scale.title';
        set(first, 'estimate', note(key, { scale: scaleLabel(first), list: declared.map(scaleLabel).join(', ') }));
        warnings.push(say('pdf.warn.scale.estimate'));
      }
    }
  } else if (validAreas(areas)) {
    const value = snapToStandard(Math.round(areas.den * 10) / 10, 0.01);
    set(value, 'estimate', note('pdf.scale.areas', { scale: scaleLabel(value), rooms }));
    warnings.push(say('pdf.warn.scale.estimate'));
  } else if (weakDims) {
    const value = snapToStandard(weakDims.den, 0.005);
    set(value, 'estimate', note('pdf.scale.dims.weak', { scale: scaleLabel(value), dims: weakDims.inliers }));
    warnings.push(say('pdf.warn.scale.estimate'));
  }

  // Faces à l'échelle finalement retenue.
  const finalDen = chosen.den;
  if (walls && finalDen !== null) {
    if (!faces || Math.abs(facesDen / finalDen - 1) > 0.01) faces = buildFaces(walls, finalDen * METRES_PER_POINT, MAX_OPENING_M);
  } else {
    faces = null;
  }
  return { den: finalDen, sourced: chosen.sourced, warnings, declared, dims, areas, faces };
}

/**
 * Échelles candidates d'une page qui en porte plusieurs : échelles annoncées distinctes, échelle des cotes et
 * second groupe de cotes concordantes. Liste vide si la page n'a qu'une échelle.
 */
function mixedScales(declared: readonly number[], decision: ScaleDecision, observations: readonly DimObservation[]): number[] {
  const second = decision.dims ? secondDimensionCluster(observations, decision.dims) : null;
  if (declared.length < 2 && !second) return [];
  const all = [...declared];
  if (decision.den !== null) all.push(decision.den);
  if (second) all.push(second.den);
  const out: number[] = [];
  for (const d of all.map((v) => snapToStandard(v, 0.01)).sort((a, b) => a - b)) if (!out.some((o) => Math.abs(o / d - 1) < 0.01)) out.push(d);
  return out.length >= 2 ? out : [];
}

function scaleList(dens: readonly number[]): string {
  return dens.map(scaleLabel).join(', ');
}
// ───────────────────────────── Vues ─────────────────────────────

interface View {
  ring: Vec2[];
  bbox: BBox;
  areaM2: number;
  kind: 'plan' | 'section' | 'other';
  title: RawText | null;
  /** Vrai si le titre est écrit sous ou sur la vue (et non repris du cartouche) : une échelle écrite à côté est la sienne. */
  titleNearby: boolean;
  storey: { fr: string; de: string; rank: number } | null;
  /** Indices des textes et des traits rattachés à la vue. */
  texts: number[];
  segs: number[];
  /** Plus long côté du contour (de plus de 50 cm) qu'aucun trait de mur ne longe, en mètres ; 0 si tous sont appuyés. */
  unsupportedM: number;
}

/**
 * Contrôle du contour obtenu par fermeture : chaque côté doit longer un mur sur une partie au moins de sa
 * longueur. Un côté qui ne suit AUCUN mur est un artefact — typiquement l'entaille en V que laisse une grande
 * ouverture restée ouverte. Renvoie la longueur (uf) du plus long côté sans appui.
 */
function longestUnsupportedEdge(ring: readonly Vec2[], walls: readonly RawSeg[], tol: number, minEdge: number): number {
  let worst = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < minEdge) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let covered = 0;
    for (const s of walls) {
      const q0 = -(s.x0 - a.x) * uy + (s.y0 - a.y) * ux;
      const q1 = -(s.x1 - a.x) * uy + (s.y1 - a.y) * ux;
      if (Math.abs(q0) > tol || Math.abs(q1) > tol) continue;
      const p0 = (s.x0 - a.x) * ux + (s.y0 - a.y) * uy;
      const p1 = (s.x1 - a.x) * ux + (s.y1 - a.y) * uy;
      const overlap = Math.min(Math.max(p0, p1), len) - Math.max(Math.min(p0, p1), 0);
      if (overlap > 0) covered += overlap;
      if (covered >= 0.15 * len) break;
    }
    if (covered < 0.15 * len && len > worst) worst = len;
  }
  return worst;
}

/** Rattache chaque objet de la page à la vue la plus proche, s'il n'en est pas trop loin. */
function assignToViews(page: RawPage, boxes: readonly BBox[], margins: readonly number[]): { texts: number[]; segs: number[] }[] {
  const out = boxes.map(() => ({ texts: [] as number[], segs: [] as number[] }));
  const pick = (x: number, y: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const d = rectDistance(x, y, boxes[i]!);
      if (d <= margins[i]! && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  page.texts.forEach((t, i) => {
    const v = pick(t.cx, t.cy);
    if (v >= 0) out[v]!.texts.push(i);
  });
  page.segs.forEach((s, i) => {
    const v = pick((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2);
    // Un trait très long par rapport à la vue (cadre, cartouche, axe) n'appartient à aucune vue.
    if (v < 0) return;
    const b = boxes[v]!;
    const reach = Math.max(b.maxX - b.minX, b.maxY - b.minY) + 2 * margins[v]!;
    if (Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > reach) return;
    out[v]!.segs.push(i);
  });
  return out;
}

interface ViewCandidate {
  ring: Vec2[];
  bbox: BBox;
  areaM2: number;
}

/**
 * Taches de murs refermées (rayon de fermeture en mètres réels, donc à l'échelle `mpp`), cadre de la feuille exclu.
 * `closing` = traits de murs plus les ponts qui referment les ouvertures reconnues.
 */
function viewCandidates(page: RawPage, walls: WallClass, gaps: readonly WallGap[], mpp: number): { candidates: ViewCandidate[]; closing: RawSeg[] } {
  // Les ouvertures reconnues (vides jumeaux des deux faces d'un mur) sont refermées d'un trait avant la
  // fermeture : même une baie plus large que 2 × rayon ne laisse alors pas « fuir » le contour.
  const bridges: RawSeg[] = gaps.flatMap((g) =>
    [g.faceA, g.faceB].map((f) => ({ x0: f.ax, y0: f.ay, x1: f.bx, y1: f.by, w: walls.width, curve: false, stroke: true, fill: false, dash: false, pid: -1 })),
  );
  const closing = [...walls.segs, ...bridges];
  const rings = closedOutlines({ width: walls.width, segs: closing }, mpp, CLOSING_RADIUS_M, MIN_VIEW_AREA_M2);
  const candidates = rings
    // Un accrochage approximatif laisse des décrochements de quelques millimètres : on les gomme (2 cm réels).
    .map((raw) => cleanPolygon(simplifyRing(raw, Math.max(0.1, 0.02 / mpp)), 0.05))
    .filter((ring) => ring.length >= 3)
    .map((ring) => ({ ring, bbox: ringBBox(ring), areaM2: ringArea(ring) * mpp * mpp }))
    // Le cadre de la feuille, s'il est dessiné au trait de mur, n'est pas une vue.
    .filter((c) => (c.bbox.maxX - c.bbox.minX) * (c.bbox.maxY - c.bbox.minY) < 0.8 * page.width * page.height);
  return { candidates, closing };
}

/** Vues de la page, et rectangles des cartouches écartés (leurs textes ne sont ni des titres ni des intitulés de vue). */
function findViews(page: RawPage, walls: WallClass, gaps: readonly WallGap[], den: number): { views: View[]; blocks: BBox[] } {
  const mpp = den * METRES_PER_POINT;
  const { candidates: all, closing } = viewCandidates(page, walls, gaps, mpp);
  if (all.length === 0) return { views: [], blocks: [] };

  // Un cartouche dessiné en traits forts ressemble à une vue : on le reconnaît à son vocabulaire (« Projet »,
  // « Plan », « Date », « Échelle »…) ou à sa place dans un angle du cadre avec au moins un de ces mots.
  const frame = frameBox(page);
  const blockTexts = page.texts.filter((t) => isTitleBlockText(t.s));
  const blocks: BBox[] = [];
  const candidates = all.filter((c) => {
    const words = blockTexts.filter((t) => pointInRing(t.cx, t.cy, c.ring)).length;
    if (words >= 3 || (words >= 1 && inFrameCorner(c.bbox, frame))) {
      blocks.push(c.bbox);
      return false;
    }
    return true;
  });
  if (candidates.length === 0) return { views: [], blocks };
  const inBlock = (t: RawText): boolean => blocks.some((b) => rectDistance(t.cx, t.cy, b) === 0);

  const margins = candidates.map((c) => {
    const size = Math.max(c.bbox.maxX - c.bbox.minX, c.bbox.maxY - c.bbox.minY);
    return Math.max(4 / mpp, 0.5 * size);
  });
  const owned = assignToViews(
    page,
    candidates.map((c) => c.bbox),
    margins,
  );

  const titles = matchTitles(
    page,
    candidates.map((c) => c.bbox),
    candidates.map((c) => c.ring),
    mpp,
    inBlock,
  );

  const views: View[] = [];
  candidates.forEach((c, i) => {
    const mine = owned[i]!;
    const inside = (t: RawText): boolean => pointInRing(t.cx, t.cy, c.ring);
    const texts = mine.texts.map((k) => page.texts[k]!);

    // Cartouche à traits forts hors des angles du cadre : il porte au moins trois mots-clés.
    const blockWords = texts.filter((t) => inside(t) && TITLE_BLOCK_RE.test(fold(t.s))).length;
    if (blockWords >= 3) return;

    const title = titles.get(i) ?? null;
    const titleFold = title ? fold(title.s) : '';
    const storey = title && !SECTION_RE.test(titleFold) ? guessStorey(title.s) : null;
    const levelMarks = texts.filter((t) => LEVEL_RE.test(t.s)).length;
    const roomsInside = roomsFromTexts(centredTexts(texts.filter(inside)));
    const labelledRooms = roomsInside.filter((r) => r.statedArea !== undefined).length;
    const planTitle = storey !== null || (title !== null && PLAN_RE.test(titleFold));

    // Un plan se reconnaît à son titre ou à ses pièces ; une coupe à son titre ou à ses niveaux cotés. Une tache
    // de murs sans rien de tout cela (légende, détail, tableau en traits forts) n'est pas proposée.
    let kind: View['kind'] = 'other';
    if (title && SITE_RE.test(titleFold)) kind = 'other';
    else if (title && SECTION_RE.test(titleFold)) kind = 'section';
    else if (!planTitle && levelMarks >= 2 && labelledRooms === 0) kind = 'section';
    else if (planTitle || roomsInside.length > 0) kind = 'plan';

    // Le titre appartient à sa vue, même si une autre vue en est plus proche.
    const textIdx = [...mine.texts];
    if (title) {
      const k = page.texts.indexOf(title);
      if (k >= 0 && !textIdx.includes(k)) textIdx.push(k);
    }
    const unsupportedM = longestUnsupportedEdge(c.ring, closing, 0.05 / mpp, 0.5 / mpp) * mpp;
    views.push({ ring: c.ring, bbox: c.bbox, areaM2: c.areaM2, kind, title, titleNearby: title !== null, storey, texts: textIdx, segs: mine.segs, unsupportedM });
  });
  // Un titre adopté par une vue n'est plus un texte des autres.
  for (const v of views) {
    const foreign = new Set(views.filter((o) => o !== v && o.title).map((o) => page.texts.indexOf(o.title!)));
    v.texts = v.texts.filter((k) => !foreign.has(k));
  }

  // Seul plan de la page et pas de titre à côté : le niveau est peut-être nommé ailleurs (cartouche).
  const plans = views.filter((v) => v.kind === 'plan');
  if (plans.length === 1 && !plans[0]!.title) {
    const named = page.texts
      .filter((t) => Math.abs(t.angle) < 1 && t.s.length <= 60 && !SECTION_RE.test(fold(t.s)) && guessStorey(t.s) !== null && !candidates.some((o) => pointInRing(t.cx, t.cy, o.ring)))
      .sort((x, y) => y.size - x.size)[0];
    if (named) {
      plans[0]!.title = named;
      plans[0]!.storey = guessStorey(named.s);
    }
  }
  return { views, blocks };
}

/**
 * Attribue à chaque vue son titre (« Rez-de-chaussée », « Grundriss Obergeschoss », « Coupe A-A »).
 * Un titre est écrit SOUS sa vue (usage courant) ou AU-DESSUS : on essaie les deux conventions pour toute la
 * page et on garde celle qui titre le plus de vues. Sans cela, le titre d'un plan placé au-dessus d'une coupe
 * est pris pour celui de la coupe, dont il est plus proche. Un texte du cartouche (`inBlock`) n'est le titre
 * d'aucune vue : son intitulé de case « Plan » n'en est pas un.
 */
function matchTitles(page: RawPage, boxes: readonly BBox[], rings: readonly Vec2[][], metresPerPoint: number, inBlock: (t: RawText) => boolean): Map<number, RawText> {
  const titles = page.texts.filter((t) => {
    if (Math.abs(t.angle) > 1 || t.s.length > 60) return false;
    const f = fold(t.s);
    if (!SECTION_RE.test(f) && !PLAN_RE.test(f) && !guessStorey(t.s)) return false;
    if (inBlock(t)) return false;
    // Un nom écrit DANS une vue est une étiquette (pièce, niveau d'une coupe), pas un titre.
    return !rings.some((ring) => pointInRing(t.cx, t.cy, ring));
  });
  if (titles.length === 0) return new Map();
  const biggest = Math.max(...titles.map((t) => t.size));

  const attempt = (below: boolean): { map: Map<number, RawText>; cost: number } => {
    const pairs: { view: number; title: number; cost: number }[] = [];
    boxes.forEach((b, i) => {
      const w = b.maxX - b.minX;
      const reach = Math.max(8 / metresPerPoint, b.maxY - b.minY);
      titles.forEach((t, j) => {
        if (t.cx < b.minX - 0.1 * w || t.cx > b.maxX + 0.1 * w) return;
        const dy = below ? t.cy - b.maxY : b.minY - t.cy;
        if (dy < 0 || dy > reach) return;
        // À distance comparable, le texte le plus gros est le titre.
        pairs.push({ view: i, title: j, cost: (dy + 1 / metresPerPoint) * (biggest / t.size) ** 2 });
      });
    });
    pairs.sort((x, y) => x.cost - y.cost);
    const map = new Map<number, RawText>();
    const taken = new Set<number>();
    let cost = 0;
    for (const p of pairs) {
      if (map.has(p.view) || taken.has(p.title)) continue;
      map.set(p.view, titles[p.title]!);
      taken.add(p.title);
      cost += p.cost;
    }
    return { map, cost };
  };
  const under = attempt(true);
  const over = attempt(false);
  if (over.map.size > under.map.size || (over.map.size === under.map.size && over.cost < under.cost)) return over.map;
  return under.map;
}

// ───────────────────────────── Échelle d'une vue ─────────────────────────────

/**
 * Échelles écrites près des vues, par vue (même ordre que `views`) : dans le titre même (« Grundriss EG M 1:100 »),
 * sous ou à côté du titre (« Rez-de-chaussée » puis « Échelle 1:100 »), ou, pour une vue sans titre, juste
 * dessous avec son mot-clé. L'échelle du cartouche n'en fait pas partie : elle vaut pour la page, pas pour une vue.
 */
function captionsByView(page: RawPage, views: readonly View[], declaredAll: readonly DeclaredScale[], blocks: readonly BBox[]): number[][] {
  const out = views.map(() => [] as number[]);
  for (const d of declaredAll) {
    const t = page.texts[d.index];
    if (!t || blocks.some((b) => rectDistance(t.cx, t.cy, b) === 0)) continue;
    let owner = -1;
    views.forEach((v, i) => {
      const title = v.titleNearby ? v.title : null;
      if (owner >= 0 || !title) return;
      const dy = Math.abs(t.cy - title.cy);
      const overlap = Math.min(t.x1, title.x1) - Math.max(t.x0, title.x0);
      const gap = Math.max(t.x0 - title.x1, title.x0 - t.x1);
      if (t === title || (overlap > 0 && dy <= 4.5 * title.size) || (dy <= 0.8 * title.size && gap <= 6 * title.size)) owner = i;
    });
    if (owner < 0 && d.keyword) {
      let bestDy = Infinity;
      views.forEach((v, i) => {
        const b = v.bbox;
        const dy = t.cy - b.maxY;
        if (t.cx < b.minX || t.cx > b.maxX || dy < 0 || dy > Math.max(30, 0.2 * (b.maxY - b.minY)) || dy >= bestDy) return;
        bestDy = dy;
        owner = i;
      });
    }
    if (owner >= 0 && !out[owner]!.includes(d.den)) out[owner]!.push(d.den);
  }
  return out;
}

/** Traits de murs de la vue seule (rectangle de la vue élargi de 10 %), pour ne reconstruire que ses faces. */
function wallsOfView(walls: WallClass, view: View): WallClass {
  const b = view.bbox;
  const m = 0.1 * Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const box: BBox = { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
  return { width: walls.width, segs: walls.segs.filter((s) => rectDistance((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, box) === 0) };
}

/**
 * Cotes d'une vue : celles dont le nombre est plus près de cette vue que de tout autre plan ou coupe, à moins de
 * `reach` (uf) de son rectangle. Les taches de murs sans titre ni pièce (« other ») ne retiennent aucune cote : un
 * artefact de fermeture ne doit pas priver un plan des siennes.
 */
function observationsOfView(view: View, views: readonly View[], observations: readonly DimObservation[], reach: number): DimObservation[] {
  const real = views.filter((v) => v.kind !== 'other');
  return observations.filter((o) => {
    const d = rectDistance(o.token.cx, o.token.cy, view.bbox);
    if (d > reach) return false;
    return real.every((v) => v === view || rectDistance(o.token.cx, o.token.cy, v.bbox) > d);
  });
}

/** Échelle d'une vue d'après ce qu'elle dit d'elle-même : ses cotes, son intitulé, les surfaces écrites dans ses pièces. */
function scaleOfView(
  page: RawPage,
  view: View,
  walls: WallClass | null,
  own: readonly DimObservation[],
  captions: number[],
  hint: DimUnit | null,
  lang: Lang,
  where: string,
): ScaleDecision {
  const labels = areaLabels(view.texts.map((i) => page.texts[i]!)).filter((l) => pointInRing(l.x, l.y, view.ring));
  return decideScale({ declared: captions, source: 'caption', observations: own, hint, labels, walls: walls ? wallsOfView(walls, view) : null }, lang, where);
}

/**
 * Retrace une vue à SON échelle quand elle diffère de celle de la page : la fermeture (rayon en mètres réels) et
 * les ouvertures en dépendent. `view` est null si aucun tracé ne recouvre la vue d'origine.
 */
function rescaleView(page: RawPage, view: View, walls: WallClass, den: number): { view: View | null; gaps: WallGap[] } {
  const mpp = den * METRES_PER_POINT;
  const own = wallsOfView(walls, view);
  const gaps = wallGaps(own, mpp, MAX_OPENING_M);
  const { candidates, closing } = viewCandidates(page, own, gaps, mpp);
  const b = view.bbox;
  const area = (x: BBox): number => Math.max(0, x.maxX - x.minX) * Math.max(0, x.maxY - x.minY);
  let best: ViewCandidate | null = null;
  let bestShare = 0.5;
  for (const c of candidates) {
    const inter: BBox = { minX: Math.max(b.minX, c.bbox.minX), minY: Math.max(b.minY, c.bbox.minY), maxX: Math.min(b.maxX, c.bbox.maxX), maxY: Math.min(b.maxY, c.bbox.maxY) };
    const share = area(inter) / Math.max(1e-9, Math.min(area(b), area(c.bbox)));
    if (share > bestShare) {
      bestShare = share;
      best = c;
    }
  }
  if (!best) return { view: null, gaps };
  const unsupportedM = longestUnsupportedEdge(best.ring, closing, 0.05 / mpp, 0.5 / mpp) * mpp;
  return { view: { ...view, ring: best.ring, bbox: best.bbox, areaM2: best.areaM2, unsupportedM }, gaps };
}
// ───────────────────────────── Coupes : niveaux et hauteurs ─────────────────────────────

interface SectionReading {
  levels: number[];
  /** Hauteur libre par rang de niveau (0 = rez-de-chaussée, 1 = étage…). */
  clearByRank: Map<number, number>;
  clearAll: number[];
}

function readSection(texts: readonly RawText[], metresPerPoint: number | null): SectionReading {
  const levels: number[] = [];
  for (const t of texts) {
    const m = LEVEL_RE.exec(t.s);
    if (!m) continue;
    const v = Number(m[2]!.replace(',', '.'));
    levels.push(m[1] === '-' || m[1] === '−' ? -v : v);
  }
  const storeyLabels = texts
    .map((t) => ({ t, storey: t.s.length <= 24 ? guessStorey(t.s) : null }))
    .filter((x): x is { t: RawText; storey: { fr: string; de: string; rank: number } } => x.storey !== null);
  const clearByRank = new Map<number, number>();
  const clearAll: number[] = [];
  for (const t of texts) {
    const h = parseClearHeight(t.s);
    if (h === null) continue;
    clearAll.push(h);
    // « HSP 2,50 » appartient au niveau dont le nom est écrit juste à côté (moins d'un demi-étage).
    const reach = metresPerPoint ? 1.4 / metresPerPoint : 6 * t.size;
    let best: { rank: number } | null = null;
    let bestD = reach;
    for (const s of storeyLabels) {
      if (s.t === t) continue;
      const d = Math.hypot(s.t.cx - t.cx, s.t.cy - t.cy);
      if (d < bestD) {
        bestD = d;
        best = s.storey;
      }
    }
    const own = guessStorey(t.s);
    const rank = own ? own.rank : best?.rank;
    if (rank !== undefined && !clearByRank.has(rank)) clearByRank.set(rank, h);
  }
  return { levels, clearByRank, clearAll };
}

interface Heights {
  /** Niveaux finis des planchers, du bas vers le haut ; vide si illisibles. */
  floors: number[];
  /** Indice du rez-de-chaussée (niveau ±0,00) dans `floors` ; −1 si inconnu. */
  ground: number;
  clearByRank: Map<number, number>;
  /** Hauteur libre commune à tous les niveaux, si les coupes n'en donnent qu'une. */
  clearCommon: number | null;
}

function combineSections(readings: readonly SectionReading[]): Heights {
  const clearByRank = new Map<number, number>();
  const clearAll: number[] = [];
  const levelSet = new Set<number>();
  for (const r of readings) {
    for (const l of r.levels) levelSet.add(Math.round(l * 1000) / 1000);
    for (const [rank, h] of r.clearByRank) if (!clearByRank.has(rank)) clearByRank.set(rank, h);
    clearAll.push(...r.clearAll);
  }
  const distinctClear = [...new Set(clearAll.map((h) => Math.round(h * 100) / 100))];
  const clearCommon = distinctClear.length === 1 ? distinctClear[0]! : null;
  const levels = [...levelSet].sort((a, b) => a - b);

  // Les niveaux lus sont des planchers finis si chaque écart est une hauteur d'étage plausible ; sinon (appuis,
  // plafonds, faîtage cotés aussi) on ne garde que la chaîne plancher → plancher qu'une hauteur libre connue désigne.
  let floors: number[] = [];
  const plausible = (d: number): boolean => d >= 2.2 && d <= 4.5;
  if (levels.length >= 2 && levels.every((l, i) => i === 0 || plausible(l - levels[i - 1]!))) floors = levels;
  else if (levels.length >= 2 && clearCommon !== null) {
    const start = levels.reduce((best, l) => (Math.abs(l) < Math.abs(best) ? l : best), levels[0]!);
    const chain = [start];
    for (;;) {
      const cur = chain[chain.length - 1]!;
      const next = levels.find((l) => l - cur >= clearCommon + 0.12 && l - cur <= clearCommon + 0.8);
      if (next === undefined) break;
      chain.push(next);
    }
    for (;;) {
      const cur = chain[0]!;
      const prev = [...levels].reverse().find((l) => cur - l >= clearCommon + 0.12 && cur - l <= clearCommon + 0.8);
      if (prev === undefined) break;
      chain.unshift(prev);
    }
    if (chain.length >= 2) floors = chain;
  }
  let ground = -1;
  floors.forEach((l, i) => {
    if (Math.abs(l) <= 0.3 && (ground < 0 || Math.abs(l) < Math.abs(floors[ground]!))) ground = i;
  });
  return { floors, ground, clearByRank, clearCommon };
}

function heightsFor(h: Heights, rank: number | null): { storeyHeight?: number; clearHeight?: number; elevation?: number } {
  const out: { storeyHeight?: number; clearHeight?: number; elevation?: number } = {};
  const diffs = h.floors.slice(1).map((l, i) => round(l - h.floors[i]!, 3));
  const uniform = diffs.length > 0 && diffs.every((d) => Math.abs(d - diffs[0]!) < 0.011) ? diffs[0]! : null;
  const whole = rank !== null && Number.isInteger(rank) && rank >= -3 && rank <= 6;
  if (whole && h.ground >= 0) {
    const idx = h.ground + rank;
    const low = h.floors[idx];
    const high = h.floors[idx + 1];
    if (low !== undefined) out.elevation = round(low, 3);
    if (low !== undefined && high !== undefined) out.storeyHeight = round(high - low, 3);
  }
  if (out.storeyHeight === undefined && uniform !== null && rank !== 9) out.storeyHeight = uniform;
  const clear = (rank !== null ? h.clearByRank.get(rank) : undefined) ?? h.clearCommon ?? undefined;
  if (clear !== undefined && clear >= 1.8 && clear <= 4.5) out.clearHeight = clear;
  if (out.storeyHeight !== undefined && !(out.storeyHeight >= 2.2 && out.storeyHeight <= 4.5)) delete out.storeyHeight;
  if (out.storeyHeight !== undefined && out.clearHeight !== undefined && out.clearHeight >= out.storeyHeight) delete out.clearHeight;
  return out;
}

function heightsText(lang: Lang, h: { storeyHeight?: number; clearHeight?: number }): string {
  const parts: string[] = [];
  if (h.storeyHeight !== undefined) parts.push(msg(lang, 'pdf.height.storey', { value: formatNumber(h.storeyHeight, 2) }));
  if (h.clearHeight !== undefined) parts.push(msg(lang, 'pdf.height.clear', { value: formatNumber(h.clearHeight, 2) }));
  return parts.join(', ');
}

// ───────────────────────────── Nord ─────────────────────────────

/** Flèche du nord : lettre « N » près d'un cercle → direction centre → lettre, en degrés horaires depuis le haut. */
function northDirection(page: RawPage): number | null {
  const letters = page.texts.filter((t) => /^(N|NORD|Nord|Norden|NORDEN)$/.test(t.s));
  if (letters.length === 0) return null;
  const paths = new Map<number, RawSeg[]>();
  for (const s of page.segs) {
    if (!s.curve) continue;
    const list = paths.get(s.pid);
    if (list) list.push(s);
    else paths.set(s.pid, [s]);
  }
  let best: { d: number; angle: number } | null = null;
  for (const segs of paths.values()) {
    if (segs.length < 16) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of segs) {
      minX = Math.min(minX, s.x0, s.x1);
      maxX = Math.max(maxX, s.x0, s.x1);
      minY = Math.min(minY, s.y0, s.y1);
      maxY = Math.max(maxY, s.y0, s.y1);
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 5 || Math.abs(w - h) >= 0.1 * w) continue;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const r = w / 2;
    for (const n of letters) {
      const d = Math.hypot(n.cx - cx, n.cy - cy);
      // La lettre est au bout de la flèche : hors du centre, pas plus loin que quatre rayons.
      if (d < 0.5 * r || d > 4 * r) continue;
      if (!best || d < best.d) best = { d, angle: (Math.atan2(n.cx - cx, -(n.cy - cy)) * 180) / Math.PI };
    }
  }
  return best ? best.angle : null;
}

// ───────────────────────────── Feuilles ─────────────────────────────

interface SheetDraft {
  sheet: PlanSheet;
  placement: SheetPlacement;
  /** Rang du niveau (guessStorey) ; null si inconnu. */
  rank: number | null;
}

function displaySegments(page: RawPage, indices: readonly number[] | null): { data: Float32Array; total: number; kept: number } {
  let list = indices ? indices.map((i) => page.segs[i]!) : page.segs;
  const total = list.length;
  if (total > MAX_DISPLAY_SEGMENTS) {
    // Trop de traits pour un affichage fluide : on garde les plus longs (les hachures et petits détails sautent).
    const lengths = Float64Array.from(list, (s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0));
    const order = Array.from(lengths.keys()).sort((a, b) => lengths[b]! - lengths[a]!);
    const keep = order.slice(0, MAX_DISPLAY_SEGMENTS).sort((a, b) => a - b);
    const source = list;
    list = keep.map((i) => source[i]!);
  }
  const data = new Float32Array(list.length * 4);
  list.forEach((s, i) => {
    data[4 * i] = s.x0;
    data[4 * i + 1] = s.y0;
    data[4 * i + 2] = s.x1;
    data[4 * i + 3] = s.y1;
  });
  return { data, total, kept: list.length };
}

/** Textes de la feuille au format du contrat : ancrés au début de la ligne de base. */
function sheetTexts(texts: readonly RawText[]): PlanText[] {
  return texts.map((t) => ({ text: t.s, x: t.bx, y: t.by, height: t.size }));
}

function contentBBox(page: RawPage, view: View): BBox {
  let { minX, minY, maxX, maxY } = view.bbox;
  const grow = (x0: number, y0: number, x1: number, y1: number): void => {
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  };
  for (const i of view.texts) {
    const t = page.texts[i]!;
    grow(t.x0, t.y0, t.x1, t.y1);
  }
  for (const i of view.segs) {
    const s = page.segs[i]!;
    grow(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.max(s.x0, s.x1), Math.max(s.y0, s.y1));
  }
  return { minX: Math.max(0, minX), minY: Math.max(0, minY), maxX: Math.min(page.width, maxX), maxY: Math.min(page.height, maxY) };
}

function pad(b: BBox, by: number, page: RawPage): BBox {
  return {
    minX: Math.max(0, b.minX - by),
    minY: Math.max(0, b.minY - by),
    maxX: Math.min(page.width, b.maxX + by),
    maxY: Math.min(page.height, b.maxY + by),
  };
}

interface PlanDetection {
  outline?: Vec2[];
  rooms: DetectedRoom[];
  openings: DetectedOpening[];
  notes: string[];
  /**
   * Les surfaces écrites dans les pièces contredisent, d'un même rapport, les surfaces mesurées à l'échelle retenue :
   * nombre de pièces comparées et rapport médian mesuré / écrit. Absent si elles concordent ou ne sont pas comparables.
   */
  areasContradict?: { compared: number; ratio: number };
}

/** Une face plus petite n'est pas proposée comme pièce sans nom (gaine, conduit, niche). */
const MIN_UNNAMED_ROOM_M2 = 1;
/** Au-delà de ce nombre de faces (hachures au trait de mur), les pièces sans nom ne sont pas cherchées. */
const MAX_UNNAMED_FACES = 4000;

/**
 * Pièces SANS nom reconnu d'une vue en plan, toujours rendues « à classer » ('ask') — jamais passées sous silence,
 * sinon la surface nette An serait trop basse sans que rien ne le dise. Chaque face fermée du contour qu'aucune
 * pièce reconnue n'occupe et qui est assez large pour être une pièce (pas un corps de mur, pas une gaine de moins
 * de 1 m², pas le contour lui-même) devient une pièce : polygone, surface mesurée, et pour nom le texte écrit
 * dedans s'il y en a un (« Kind 1 », « Kochen »), sinon un nom VIDE.
 */
function unnamedRooms(args: {
  texts: readonly RawText[];
  title: RawText | null;
  faces: Faces;
  taken: ReadonlySet<Poly>;
  outline: Vec2[];
  view: View;
  mpp: number;
}): DetectedRoom[] {
  const { texts, title, faces, taken, outline, view, mpp } = args;
  if (faces.faces.length > MAX_UNNAMED_FACES) return [];
  const horizontal = texts.filter((t) => Math.abs(t.angle) < 1 && t !== title);
  // Une pièce laisse passer un cercle plus large que le plus épais des murs ; un corps de mur, non.
  const thickest = faces.gaps.reduce((m, g) => Math.max(m, g.thickness * mpp), 0);
  const clear = Math.max(0.3, 0.55 * thickest) / mpp;
  const out: DetectedRoom[] = [];
  for (const f of faces.faces) {
    if (taken.has(f)) continue;
    const m = polyArea(f) * mpp * mpp;
    if (m < MIN_UNNAMED_ROOM_M2 || m > 0.9 * view.areaM2) continue;
    const p = roomyPoint(f, clear);
    if (!p || !pointInRing(p.x, p.y, outline)) continue;
    const polygon = cleanPolygon(f.outer, 0.02);
    if (polygon.length < 3 || isSelfIntersecting(polygon)) continue;
    const inside = horizontal.filter((t) => pointInPoly(t.cx, t.cy, f));
    // Plusieurs surfaces écrites dans la face : une face commune à plusieurs pièces, pas une pièce.
    const areaTexts = inside.filter((t) => roomAreaOf(t.s) !== null);
    if (areaTexts.length > 1) continue;
    const stated = areaTexts[0] ? roomAreaOf(areaTexts[0].s) : null;
    // Nom : le texte de la surface s'il en porte un (« Kind 1 : 17,54 m² »), sinon le plus gros texte de la face.
    const own = areaTexts[0] ? freeRoomName(areaTexts[0].s) : null;
    const nameText = own === null ? [...inside].filter((t) => roomAreaOf(t.s) === null && !isTotalLabel(t.s) && freeRoomName(t.s) !== null).sort((a, b) => b.size - a.size || Math.hypot(a.cx - p.x, a.cy - p.y) - Math.hypot(b.cx - p.x, b.cy - p.y))[0] : undefined;
    const anchor = nameText ?? areaTexts[0];
    const room: DetectedRoom = {
      name: own ?? (nameText ? freeRoomName(nameText.s)! : ''),
      at: anchor ? { x: anchor.cx, y: anchor.cy } : p,
      heatedGuess: 'ask',
      measuredArea: round(m, 2),
      polygon,
    };
    if (stated !== null) room.statedArea = stated;
    out.push(room);
  }
  return out;
}

/** Contour, pièces et ouvertures d'une vue en plan. `ringTrusted` = faux si le tracé de la vue ne peut pas être proposé tel quel. */
function detectPlan(page: RawPage, view: View, faces: Faces | null, gaps: readonly WallGap[], den: number, lang: Lang, ringTrusted = true): PlanDetection {
  const mpp = den * METRES_PER_POINT;
  const notes: string[] = [];
  const texts = view.texts.map((i) => page.texts[i]!);
  const near = 0.3 / mpp;
  const within = (p: Vec2): boolean => pointInRing(p.x, p.y, view.ring) || pointRingDistance(p.x, p.y, view.ring) < near;

  const labelled = roomsFromTexts(centredTexts(texts));

  // ── Contour : la fermeture ne ment pas sur la forme, mais elle « fuit » si une ouverture reste ouverte.
  // Signe d'une fuite : une pièce étiquetée se trouve hors du contour, dans son rectangle englobant.
  let outline: Vec2[] | undefined = view.ring;
  const escaped = labelled.filter(
    (r) => r.at && !within(r.at) && rectDistance(r.at.x, r.at.y, view.bbox) === 0 && !OUTDOOR_RE.test(fold(r.name)) && (r.statedArea !== undefined || r.heatedGuess !== 'no'),
  );
  if (!ringTrusted || outline.length < 3 || outline.length > 400 || isSelfIntersecting(outline)) {
    outline = undefined;
    notes.push(msg(lang, 'pdf.note.outline.none'));
  } else if (escaped.length > 0) {
    outline = undefined;
    notes.push(msg(lang, 'pdf.note.outline.leak', { rooms: escaped.map((r) => r.name).join(', ') }));
  } else if (view.unsupportedM > 0) {
    outline = undefined;
    notes.push(msg(lang, 'pdf.note.outline.unsupported', { length: formatNumber(view.unsupportedM, 1) }));
  }
  // Pièces de la vue : celles du contour s'il est proposé ; sinon toutes celles de l'emprise de la vue (une
  // pièce « sortie » d'un contour qui fuit reste une pièce du plan).
  const rooms = labelled.filter((r) => r.at && (outline ? within(r.at) : rectDistance(r.at.x, r.at.y, view.bbox) <= near));
  if (outline) {
    notes.push(msg(lang, 'pdf.note.outline', { area: formatNumber(view.areaM2, 2), gap: formatNumber(2 * CLOSING_RADIUS_M, 1) }));
    const unheated = rooms.filter((r) => r.heatedGuess === 'no').map((r) => r.name);
    if (unheated.length > 0) notes.push(msg(lang, 'pdf.note.outline.unheated', { rooms: unheated.join(', ') }));
  }

  // ── Pièces : polygone = plus petite face autour de l'étiquette, acceptée seulement si elle est crédible.
  let areasContradict: PlanDetection['areasContradict'];
  const taken = new Set<Poly>();
  if (faces && faces.faces.length > 0 && rooms.length > 0) {
    const faceOf = rooms.map((r) => (r.at ? faceAt(faces.faces, r.at.x, r.at.y) : null));
    const shared = new Map<Poly, number>();
    for (const f of faceOf) {
      if (!f) continue;
      shared.set(f, (shared.get(f) ?? 0) + 1);
      taken.add(f);
    }
    const measured = faceOf.map((f) => (f ? polyArea(f) * mpp * mpp : null));
    // Fiabilité d'ensemble : part des surfaces écrites que le dessin confirme.
    let compared = 0;
    let confirmed = 0;
    let worst = 0;
    const ratios: number[] = [];
    rooms.forEach((r, i) => {
      const m = measured[i];
      if (r.statedArea === undefined || m === null || m === undefined) return;
      compared++;
      if (shared.get(faceOf[i]!) === 1) ratios.push(m / r.statedArea);
      const gap = Math.abs(m / r.statedArea - 1);
      if (gap <= ROOM_AREA_TOLERANCE) {
        confirmed++;
        if (gap > worst) worst = gap;
      }
    });
    // Surfaces écrites contredites d'un même rapport : c'est l'échelle qui est en cause, pas le dessin d'une pièce.
    if (compared >= 2 && confirmed < 0.5 * compared && ratios.length >= 2) {
      const sortedRatios = [...ratios].sort((a, b) => a - b);
      const mid = sortedRatios[Math.floor(sortedRatios.length / 2)]!;
      const agreeing = ratios.filter((x) => Math.abs(x / mid - 1) <= 0.05).length;
      if (Math.abs(mid - 1) > 0.1 && agreeing >= 0.6 * ratios.length) areasContradict = { compared, ratio: mid };
    }
    // Sans surface écrite, l'autre recoupement est l'accord des deux méthodes : les faces (pièces, murs,
    // ouvertures) doivent paver le contour obtenu par fermeture. Des murs mal raccordés font tomber ce taux.
    let paved = 0;
    for (const f of faces.faces) {
      const p = f.outer[0]!;
      if (within(p)) paved += polyArea(f);
    }
    const coverage = paved / Math.max(1e-9, ringArea(view.ring));
    const trusted = compared >= 2 ? confirmed >= 0.8 * compared : outline !== undefined && coverage >= 0.97 && coverage <= 1.01;
    const unmeasured: string[] = [];
    let accepted = 0;
    rooms.forEach((r, i) => {
      const f = faceOf[i];
      const m = measured[i];
      if (!f || m === null || m === undefined) {
        unmeasured.push(r.name);
        return;
      }
      const alone = shared.get(f) === 1;
      const confirmedHere = r.statedArea !== undefined && Math.abs(m / r.statedArea - 1) <= ROOM_AREA_TOLERANCE;
      // Sans surface écrite pour recouper, on ne propose le polygone que si le reste de la vue est confirmé.
      const plausible = r.statedArea === undefined && trusted && alone && m >= 1 && m <= 0.8 * view.areaM2;
      if (confirmedHere || plausible) {
        const polygon = cleanPolygon(f.outer, 0.02);
        if (polygon.length >= 3 && !isSelfIntersecting(polygon)) {
          r.polygon = polygon;
          r.measuredArea = round(m, 2);
          accepted++;
          return;
        }
      }
      if (r.statedArea !== undefined && !confirmedHere && alone) {
        notes.push(msg(lang, 'pdf.note.rooms.mismatch', { room: r.name, stated: formatNumber(r.statedArea, 2), measured: formatNumber(m, 2) }));
      } else unmeasured.push(r.name);
    });
    if (accepted > 0) notes.push(msg(lang, 'pdf.note.rooms.measured', { n: accepted, gap: formatNumber(worst * 100, 1) }));
    if (unmeasured.length > 0) notes.push(msg(lang, 'pdf.note.rooms.unmeasured', { rooms: unmeasured.join(', ') }));
  }

  // ── Pièces sans nom reconnu : les autres faces fermées du contour, « à classer ».
  if (faces && faces.faces.length > 0 && outline) {
    const unnamed = unnamedRooms({ texts, title: view.title, faces, taken, outline, view, mpp });
    if (unnamed.length > 0) {
      rooms.push(...unnamed);
      const list = unnamed.map((r) => (r.name ? msg(lang, 'pdf.room.item', { name: r.name, area: formatNumber(r.measuredArea ?? 0, 2) }) : msg(lang, 'pdf.room.item.noName', { area: formatNumber(r.measuredArea ?? 0, 2) }))).join(', ');
      notes.push(msg(lang, 'pdf.note.rooms.unnamed', { n: unnamed.length, list }));
    }
  }

  // ── Ouvertures des murs extérieurs : seulement si le contour est proposé.
  let openings: DetectedOpening[] = [];
  if (outline) {
    openings = detectOpenings(page, view.segs, outline, gaps, mpp);
    if (openings.length > 0) {
      const count = (kind: DetectedOpening['kind']): number => openings.filter((o) => o.kind === kind).length;
      notes.push(msg(lang, 'pdf.note.openings', { windows: count('window'), doors: count('door'), unknown: count('unknown') }));
    }
  }
  if (view.title) notes.push(msg(lang, 'pdf.note.title', { title: view.title.s }));
  const result: PlanDetection = { rooms, openings, notes };
  if (outline) result.outline = outline;
  if (areasContradict) result.areasContradict = areasContradict;
  return result;
}

/** Vues d'une page sans classe de murs, et pièces de chacune. */
interface HairlineSplit {
  /** Toutes les régions de dessin, comme des vues rectangulaires (même rôle que celles de `findViews`). */
  views: View[];
  /** Régions reconnues comme plans, avec leurs pièces et les étiquettes écartées. */
  plans: { view: View; rooms: DetectedRoom[]; dropped: string[] }[];
  /** Pièces de la page qui ne sont pas écrites dans une coupe ou une façade. */
  kept: DetectedRoom[];
  /** Noms des étiquettes écartées parce qu'écrites dans une coupe ou une façade. */
  dropped: string[];
}

/**
 * Découpe une page « tout en trait fin » en vues d'après les régions de dessin (traits qui se touchent) et leurs
 * titres ; rattache chaque pièce à la région où elle est écrite. Une région titrée « Coupe », « Façade »… ou qui
 * ne porte que des niveaux cotés est une coupe : ses étiquettes (« Grenier ») ne sont pas des pièces d'un plan.
 */
function hairlineViews(page: RawPage, rooms: readonly DetectedRoom[], den: number | null): HairlineSplit {
  const regions = drawingRegions(page) ?? [];
  const empty: HairlineSplit = { views: [], plans: [], kept: [...rooms], dropped: [] };
  if (regions.length === 0) return empty;
  const rings = regions.map((b) => [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ]);
  const mpp = (den ?? 100) * METRES_PER_POINT;
  // Ni un intitulé de cartouche, ni un morceau de tableau ou de phrase (crochets, signes, plus de six mots).
  const notATitle = (t: RawText): boolean => isTitleBlockText(t.s) || /[[\]{}<>=;|]/.test(t.s) || t.s.trim().split(/\s+/).length > 6;
  const titles = matchTitles(page, regions, rings, mpp, notATitle);
  const margins = regions.map((b) => 0.2 * Math.max(b.maxX - b.minX, b.maxY - b.minY));
  const owned = assignToViews(page, regions, margins);
  const views: View[] = regions.map((b, i) => {
    const title = titles.get(i) ?? null;
    const titleFold = title ? fold(title.s) : '';
    const storey = title && !SECTION_RE.test(titleFold) ? guessStorey(title.s) : null;
    const inside = (p: Vec2): boolean => rectDistance(p.x, p.y, b) === 0;
    const mine = rooms.filter((r) => r.at && inside(r.at));
    const texts = owned[i]!.texts.map((k) => page.texts[k]!);
    const levelMarks = texts.filter((t) => LEVEL_RE.test(t.s)).length;
    const buildingSized = Math.min(b.maxX - b.minX, b.maxY - b.minY) * mpp >= 2.5 && (b.maxX - b.minX) * (b.maxY - b.minY) * mpp * mpp >= 12;
    let kind: View['kind'] = 'other';
    if (title && SITE_RE.test(titleFold)) kind = 'other';
    else if (title && SECTION_RE.test(titleFold)) kind = 'section';
    // Un nom de niveau fait un plan si la région a des pièces ou la taille d'un bâtiment : une case de tableau
    // intitulée « Rez-de-chaussée » n'en est pas un. Un titre qui ne contient que le mot « plan » (légende) ne
    // fait un plan que s'il a des pièces.
    else if ((storey !== null && (mine.length > 0 || buildingSized)) || (title !== null && PLAN_RE.test(titleFold) && mine.length > 0)) kind = 'plan';
    // Des cotes de niveau sans aucune étiquette de pièce : une coupe. Avec des pièces, c'est un plan qui porte ses
    // niveaux finis (même règle que pour les vues à murs épais) — le prendre pour une coupe lui ôtait ses pièces.
    else if (mine.length > 0) kind = 'plan';
    else if (levelMarks >= 2) kind = 'section';
    const textIdx = [...owned[i]!.texts];
    if (title) {
      const k = page.texts.indexOf(title);
      if (k >= 0 && !textIdx.includes(k)) textIdx.push(k);
    }
    const areaM2 = (b.maxX - b.minX) * (b.maxY - b.minY) * mpp * mpp;
    return { ring: rings[i]!, bbox: b, areaM2, kind, title, titleNearby: title !== null, storey, texts: textIdx, segs: owned[i]!.segs, unsupportedM: 0 };
  });
  // Une région qui en enveloppe une autre (cadre d'un tableau autour d'un plan, légende englobante) n'est pas un
  // second plan : on garde la région intérieure.
  const wraps = (a: BBox, b: BBox): boolean => a.minX <= b.minX && a.minY <= b.minY && a.maxX >= b.maxX && a.maxY >= b.maxY;
  for (const v of views) {
    if (v.kind === 'plan' && views.some((w) => w !== v && w.kind === 'plan' && wraps(v.bbox, w.bbox))) v.kind = 'other';
  }
  const inRegion = (r: DetectedRoom, v: View): boolean => !!r.at && rectDistance(r.at.x, r.at.y, v.bbox) === 0;
  // Étiquettes écrites dans une coupe, une façade ou un plan de situation : pas des pièces d'un étage.
  const notPlan = views.filter((v) => v.kind !== 'plan' && (v.kind === 'section' || v.title !== null));
  const droppedRooms = rooms.filter((r) => notPlan.some((v) => inRegion(r, v)));
  const kept = rooms.filter((r) => !droppedRooms.includes(r));
  const dropped = droppedRooms.map((r) => r.name);
  const planViews = views.filter((v) => v.kind === 'plan');
  // Les pièces écrites hors de toute région ne peuvent pas être rattachées : sans elles, le découpage n'est pas sûr.
  const orphans = kept.filter((r) => !planViews.some((v) => inRegion(r, v)));
  if (planViews.length < 2 || orphans.length > 0) return { views, plans: [], kept, dropped };
  planViews.sort((a, b) => (a.storey?.rank ?? 99) - (b.storey?.rank ?? 99) || a.bbox.minX - b.bbox.minX);
  const plans = planViews.map((v) => ({ view: v, rooms: kept.filter((r) => inRegion(r, v)), dropped: [] as string[] }));
  if (plans.length > 0 && dropped.length > 0) plans[0]!.dropped = dropped;
  return { views, plans, kept, dropped };
}
function pageKind(page: RawPage): PageKind {
  if (page.segs.length < MIN_VECTOR_SEGMENTS) {
    // Pas de dessin vectoriel : un scan si une image occupe la page, sinon une page (presque) vide.
    return page.images > 0 && page.imageCoverage > 0.2 ? 'raster' : 'empty';
  }
  if (page.texts.length === 0) {
    // Beaucoup de petits remplissages sans aucun texte : ce sont les lettres, converties en dessins.
    const fills = page.segs.filter((s) => s.fill && !s.stroke).length;
    return fills > 0.3 * page.segs.length ? 'outlined-text' : 'no-text';
  }
  return 'vector';
}

interface PageResult {
  drafts: SheetDraft[];
  warnings: string[];
  report: PageReport;
  sections: SectionReading[];
  north: number | null;
  /** Vrai si la page ne montre que des coupes ou façades (aucune feuille produite pour cette raison). */
  sectionOnly: boolean;
}

function wholePagePlacement(page: RawPage, kind: PageKind): SheetPlacement {
  return {
    page: page.number,
    rotation: page.rotation,
    pageWidth: page.width,
    pageHeight: page.height,
    raster: kind === 'raster' || page.imageCoverage > 0.5,
    pixelsPerPoint: page.imagePixelsPerPoint,
  };
}

function analysePage(page: RawPage, multiPage: boolean, lang: Lang): PageResult {
  const where = multiPage ? msg(lang, 'pdf.page', { page: page.number }) : '';
  const say = (key: string, params: Record<string, string | number> = {}): string => capitalise(msg(lang, key, { where, ...params }));
  const kind = pageKind(page);
  const warnings: string[] = [];
  const report: PageReport = { page: page.number, kind, declared: [], dims: null, areas: null, scaleDen: null, wallWidth: null, views: [], sheets: 0 };
  const result: PageResult = { drafts: [], warnings, report, sections: [], north: null, sectionOnly: false };
  if (page.turned !== 0) warnings.push(say('pdf.warn.turned'));
  if (page.truncated) warnings.push(say('pdf.warn.truncated'));

  const display = displaySegments(page, null);
  const wholeSheet = (scale: Sourced<number> | null, rooms: DetectedRoom[], notes: string[]): SheetDraft => {
    if (display.kept < display.total) warnings.push(say('pdf.warn.display', { total: display.total, kept: display.kept }));
    const sheet: PlanSheet = {
      id: `p${page.number}`,
      name: msg(lang, 'pdf.sheet.page', { page: page.number }),
      bbox: { minX: 0, minY: 0, maxX: page.width, maxY: page.height },
      metresPerUnit: scale,
      detected: { rooms, openings: [], notes },
    };
    if (display.data.length > 0) sheet.segments = display.data;
    if (page.texts.length > 0) sheet.texts = sheetTexts(page.texts);
    return { sheet, placement: wholePagePlacement(page, kind), rank: null };
  };

  if (kind !== 'vector') {
    const key = kind === 'raster' ? 'pdf.warn.scan' : kind === 'outlined-text' ? 'pdf.warn.outlinedText' : kind === 'empty' ? 'pdf.warn.empty' : 'pdf.warn.noText';
    warnings.push(say(key));
    // Une page sans dessin peut quand même porter du texte (scan océrisé) : on ne propose rien à partir de lui,
    // sa position sur l'image n'étant pas fiable.
    result.drafts.push(wholeSheet(null, [], []));
    return result;
  }

  const walls = findWallClass(page);
  const declaredAll = declaredScales(page.texts);
  const declared = [...new Set(declaredAll.map((d) => d.den))];
  const observations = dimensionObservations(page);
  const hint = dimensionUnitHint(page.texts);
  const scale = decideScale({ declared, source: 'block', observations, hint, labels: areaLabels(page.texts), walls }, lang, where);
  // Page qui porte plusieurs échelles (annoncées, ou deux groupes de cotes concordantes) : la valeur décidée pour
  // la page entière n'est plus « lue sur le plan ». Chaque vue en plan décide la sienne plus bas.
  const mixed = mixedScales(declared, scale, observations);
  let pageScale: Sourced<number> | null = scale.sourced;
  if (mixed.length > 0 && scale.sourced && scale.den !== null) {
    pageScale = { value: scale.sourced.value, from: 'estimate', note: msg(lang, 'pdf.scale.mixed', { scale: scaleLabel(scale.den), list: scaleList(mixed) }) };
  } else {
    warnings.push(...scale.warnings);
  }
  const mixedPageWarning = (): void => {
    if (mixed.length > 0 && scale.den !== null) warnings.push(say('pdf.warn.scale.mixed.page', { scale: scaleLabel(scale.den), list: scaleList(mixed) }));
  };
  report.declared = scale.declared;
  report.dims = scale.dims;
  report.areas = scale.areas;
  report.scaleDen = scale.den;
  report.wallWidth = walls?.width ?? null;
  result.north = northDirection(page);

  // Sans contour pour trier, toute la page est candidate : on écarte ce qui ressemble à une phrase de cartouche
  // (« Maison unifamiliale à … ») — un nom de pièce est court, ou accompagné de sa surface.
  const allRooms = (): DetectedRoom[] =>
    roomsFromTexts(centredTexts(page.texts)).filter((r) => {
      if (TITLE_BLOCK_RE.test(fold(r.name))) return false;
      return r.statedArea !== undefined || (r.name.length <= 28 && r.name.trim().split(/\s+/).length <= 3);
    });
  const pageTitles = page.texts.filter((t) => Math.abs(t.angle) < 1 && SECTION_RE.test(fold(t.s)));
  // Noms de niveaux écrits sur la page ; une étiquette de pièce (« Garage », « Cave ») n'en est pas un, sauf dans un
  // titre de plan (« Grundriss Keller »).
  const pageStoreys = page.texts.filter(
    (t) => Math.abs(t.angle) < 1 && t.s.length <= 40 && !SECTION_RE.test(fold(t.s)) && guessStorey(t.s) !== null && (!looksLikeRoomName(t.s) || PLAN_RE.test(fold(t.s))),
  );

  if (scale.den === null || !walls) {
    // Pas d'échelle, ou pas de murs reconnaissables : la page entière, avec ce que le texte donne.
    const rooms = allRooms();
    const labelled = rooms.filter((r) => r.statedArea !== undefined).length;
    if (labelled === 0 && pageTitles.length > 0 && pageStoreys.length === 0) {
      // Une coupe ou une façade en traits fins : pas un plan.
      result.sections.push(readSection(page.texts, scale.den !== null ? scale.den * METRES_PER_POINT : null));
      result.sectionOnly = true;
      warnings.push(say('pdf.warn.section', { title: pageTitles[0]!.s }));
      return result;
    }
    if (scale.den === null) warnings.push(say('pdf.warn.scale.none'));
    const notes: string[] = [];
    let kept = rooms;
    if (!walls && page.imageCoverage > 0.5) {
      // Un scan habillé de quelques traits vectoriels (cadre, cartouche) : le plan lui-même est une image.
      warnings.push(say('pdf.warn.scan'));
      notes.push(msg(lang, 'pdf.note.outline.none'));
    } else if (!walls) {
      warnings.push(say('pdf.warn.hairline'));
      notes.push(msg(lang, 'pdf.note.outline.noWalls'));
      // Sans murs, pas de contour pour trier les pièces : on découpe la page en régions de dessin.
      const split = hairlineViews(page, rooms, scale.den);
      if (split.plans.length >= 2) {
        // Plusieurs plans séparés : une feuille par plan, avec ses seules pièces.
        const captions = mixed.length > 0 ? captionsByView(page, split.views, declaredAll, []) : [];
        split.plans.forEach((p, k) => {
          const view = p.view;
          const name = view.storey ? view.storey[lang] : view.title ? view.title.s : msg(lang, 'pdf.sheet.pagePlan', { page: page.number, n: k + 1 });
          let viewScale: Sourced<number> | null = pageScale ? { ...pageScale } : null;
          if (mixed.length > 0 && scale.den !== null) {
            const size = Math.max(view.bbox.maxX - view.bbox.minX, view.bbox.maxY - view.bbox.minY);
            const ownDims = observationsOfView(view, split.views, observations, Math.max(4 / (scale.den * METRES_PER_POINT), 0.5 * size));
            const own = scaleOfView(page, view, null, ownDims, captions[split.views.indexOf(view)] ?? [], hint, lang, `${where}${msg(lang, 'pdf.view', { view: name })}`);
            if (own.den !== null && own.sourced) {
              viewScale = own.sourced;
              if (own.sourced.from !== 'plan') warnings.push(say('pdf.warn.scale.mixed', { scale: scaleLabel(own.den), list: scaleList(mixed), view: name }));
              else warnings.push(...own.warnings);
            } else warnings.push(say('pdf.warn.scale.mixed', { scale: scaleLabel(scale.den), list: scaleList(mixed), view: name }));
          }
          const sheetNotes = [...notes, msg(lang, 'pdf.note.rooms.byView')];
          if (p.dropped.length > 0) sheetNotes.push(msg(lang, 'pdf.note.rooms.section', { rooms: p.dropped.join(', ') }));
          if (view.title) sheetNotes.push(msg(lang, 'pdf.note.title', { title: view.title.s }));
          const sheet: PlanSheet = {
            id: `p${page.number}-v${k + 1}`,
            name,
            bbox: pad(contentBBox(page, view), 6, page),
            metresPerUnit: viewScale,
            detected: { rooms: p.rooms, openings: [], notes: sheetNotes },
          };
          const segments = displaySegments(page, view.segs).data;
          if (segments.length > 0) sheet.segments = segments;
          const texts = view.texts.map((i) => page.texts[i]!);
          if (texts.length > 0) sheet.texts = sheetTexts(texts);
          if (p.rooms.length === 0) warnings.push(say('pdf.warn.noRooms'));
          result.drafts.push({ sheet, placement: wholePagePlacement(page, kind), rank: view.storey?.rank ?? null });
        });
        mixedPageWarning();
        return result;
      }
      const sectionView = split.views.find((v) => v.kind === 'section');
      if (sectionView && split.views.every((v) => v.kind !== 'plan') && split.kept.length === 0) {
        // Rien que des coupes ou façades, reconnues à leur titre : pas un plan.
        result.sections.push(readSection(page.texts, scale.den !== null ? scale.den * METRES_PER_POINT : null));
        result.sectionOnly = true;
        warnings.push(sectionView.title ? say('pdf.warn.section', { title: sectionView.title.s }) : say('pdf.warn.section.untitled'));
        return result;
      }
      // Un seul plan (ou aucun) séparé : la feuille couvre la page, sans les étiquettes des coupes et façades.
      kept = split.kept;
      if (split.dropped.length > 0) notes.push(msg(lang, 'pdf.note.rooms.section', { rooms: split.dropped.join(', ') }));
      // Plusieurs niveaux titrés sur la page (titres des régions, ou à défaut textes hors cartouche) : la liste les mêle.
      // Comptent : les titres des régions reconnues comme plans, et les titres de niveau écrits SEULS hors de tout
      // dessin (deux plans reliés par un trait). Pas un mot dans une légende, une colonne de tableau ou une coupe.
      const titled = split.views.filter((v) => v.kind === 'plan' && v.storey !== null).map((v) => v.storey!.rank);
      const inDrawing = (t: RawText): boolean => split.views.some((v) => rectDistance(t.cx, t.cy, v.bbox) === 0);
      const standalone = pageStoreys.filter((t) => !isTitleBlockText(t.s) && !LEVEL_RE.test(t.s) && t.s.trim().split(/\s+/).length <= 3 && !inDrawing(t));
      const levels = new Set([...titled, ...standalone.map((t) => guessStorey(t.s)!.rank)]);
      if (levels.size > 1 && kept.length > 0) {
        warnings.push(say('pdf.warn.views.wholePage'));
        notes.push(msg(lang, 'pdf.note.rooms.wholePage'));
      }
    } else {
      notes.push(msg(lang, 'pdf.note.outline.none'));
    }
    mixedPageWarning();
    const draft = wholeSheet(pageScale, kept, notes);
    // La page n'est nommée d'après un niveau que si elle n'en cite qu'un (sinon elle en montre sans doute plusieurs).
    const ranks = new Set(pageStoreys.map((t) => guessStorey(t.s)!.rank));
    const storey = ranks.size === 1 ? guessStorey(pageStoreys[0]!.s) : null;
    if (storey) {
      draft.sheet.name = storey[lang];
      draft.rank = storey.rank;
    }
    result.drafts.push(draft);
    return result;
  }

  const den = scale.den;
  const mpp = den * METRES_PER_POINT;
  // Garde-fou : la fermeture coûte à peu près une milliseconde par trait de mur.
  const tooHeavy = walls.segs.length > MAX_CLOSING_SEGMENTS;
  if (tooHeavy) warnings.push(say('pdf.warn.heavy', { count: walls.segs.length }));
  const gaps = tooHeavy ? [] : wallGaps(walls, mpp, MAX_OPENING_M);
  const { views, blocks } = tooHeavy ? { views: [], blocks: [] } : findViews(page, walls, gaps, den);
  report.views = views.map((v) => ({ kind: v.kind, title: v.title?.s ?? null, areaM2: v.areaM2 }));
  const plans = views.filter((v) => v.kind === 'plan');
  const sections = views.filter((v) => v.kind === 'section');

  for (const s of sections) {
    // Seule vue de la page : tous les textes de la page lui appartiennent (niveaux cotés en marge).
    const texts = views.length === 1 ? page.texts : s.texts.map((i) => page.texts[i]!);
    result.sections.push(readSection(texts, mpp));
  }

  if (plans.length === 0) {
    if (sections.length > 0) {
      result.sectionOnly = true;
      warnings.push(sections[0]!.title ? say('pdf.warn.section', { title: sections[0]!.title.s }) : say('pdf.warn.section.untitled'));
      return result;
    }
    warnings.push(say('pdf.warn.noOutline'));
    mixedPageWarning();
    result.drafts.push(wholeSheet(pageScale, allRooms(), [msg(lang, 'pdf.note.outline.none')]));
    return result;
  }

  // Du bas vers le haut du bâtiment, puis de gauche à droite sur la feuille.
  plans.sort((a, b) => (a.storey?.rank ?? 99) - (b.storey?.rank ?? 99) || a.bbox.minX - b.bbox.minX);
  const single = plans.length === 1;
  const captions = mixed.length > 0 ? captionsByView(page, views, declaredAll, blocks) : [];
  plans.forEach((found, k) => {
    const name = found.storey ? found.storey[lang] : found.title ? found.title.s : single ? msg(lang, 'pdf.sheet.page', { page: page.number }) : msg(lang, 'pdf.sheet.pagePlan', { page: page.number, n: k + 1 });
    let view = found;
    let viewDen = den;
    let viewScale: Sourced<number> | null = pageScale ? { ...pageScale } : null;
    let viewFaces = scale.faces;
    let viewGaps = gaps;
    let ringTrusted = true;
    if (mixed.length > 0) {
      // Plusieurs échelles sur la page : l'échelle de CETTE vue, d'après ses seules cotes, son intitulé et ses surfaces.
      const size = Math.max(found.bbox.maxX - found.bbox.minX, found.bbox.maxY - found.bbox.minY);
      const ownDims = observationsOfView(found, views, observations, Math.max(4 / mpp, 0.5 * size));
      const own = scaleOfView(page, found, walls, ownDims, captions[views.indexOf(found)] ?? [], hint, lang, `${where}${msg(lang, 'pdf.view', { view: name })}`);
      if (own.den !== null && own.sourced) {
        viewDen = own.den;
        viewScale = own.sourced;
        // Une estimation de la vue sur une page à plusieurs échelles : l'avertissement nomme les candidates.
        if (own.sourced.from !== 'plan') warnings.push(say('pdf.warn.scale.mixed', { scale: scaleLabel(own.den), list: scaleList(mixed), view: name }));
        else warnings.push(...own.warnings);
        if (Math.abs(own.den / den - 1) > 0.01) {
          // Le tracé de la vue a été cherché à l'échelle de la page : on le refait à la sienne (rayon de fermeture,
          // ouvertures), avec ses seuls murs.
          const redone = rescaleView(page, found, walls, own.den);
          viewGaps = redone.gaps;
          viewFaces = own.faces;
          if (redone.view) view = redone.view;
          else ringTrusted = false;
        }
      } else {
        warnings.push(say('pdf.warn.scale.mixed', { scale: scaleLabel(den), list: scaleList(mixed), view: name }));
      }
    }
    const detection = detectPlan(page, view, viewFaces, viewGaps, viewDen, lang, ringTrusted);
    if (detection.areasContradict && viewScale && viewScale.from === 'plan') {
      // Les surfaces écrites dans les pièces ne correspondent pas aux surfaces mesurées à cette échelle : elle
      // n'est plus « lue sur le plan », l'expert doit la vérifier.
      const c = detection.areasContradict;
      viewScale = { value: viewScale.value, from: 'estimate', note: `${viewScale.note ?? ''} ${msg(lang, 'pdf.scale.rooms.disagree', { rooms: c.compared, ratio: formatNumber(c.ratio, 2) })}`.trim() };
      warnings.push(say('pdf.warn.scale.rooms', { view: name, rooms: c.compared, scale: scaleLabel(viewDen) }));
    }
    const focus = pad(contentBBox(page, view), 6, page);
    let segments: Float32Array;
    let texts: RawText[];
    if (single) {
      // Un seul plan sur la page : la feuille garde tous les traits et textes de la page (coupe et cartouche
      // restent consultables).
      if (display.kept < display.total) warnings.push(say('pdf.warn.display', { total: display.total, kept: display.kept }));
      segments = display.data;
      texts = page.texts;
    } else {
      // Plusieurs plans : chacun ne garde que ses traits et ses textes, pour l'accrochage et la lecture des
      // pièces ; l'image de fond, elle, montre toujours la page entière.
      segments = displaySegments(page, view.segs).data;
      texts = view.texts.map((i) => page.texts[i]!);
    }
    const placement = wholePagePlacement(page, kind);
    const sheet: PlanSheet = {
      id: single ? `p${page.number}` : `p${page.number}-v${k + 1}`,
      name,
      bbox: focus,
      metresPerUnit: viewScale,
      detected: { rooms: detection.rooms, openings: detection.openings, notes: detection.notes },
    };
    if (detection.outline) sheet.detected.outline = detection.outline;
    else warnings.push(say('pdf.warn.noOutline'));
    if (segments.length > 0) sheet.segments = segments;
    if (texts.length > 0) sheet.texts = sheetTexts(texts);
    if (detection.rooms.length === 0) warnings.push(say('pdf.warn.noRooms'));
    result.drafts.push({ sheet, placement, rank: view.storey?.rank ?? null });
  });
  return result;
}

// ───────────────────────────── Document ─────────────────────────────

export function analysePdf(pages: readonly RawPage[], fileName: string, options: AnalyseOptions = {}): PdfAnalysis {
  const lang: Lang = options.lang ?? 'fr';
  const multiPage = pages.length > 1;
  const warnings: string[] = [];
  const drafts: SheetDraft[] = [];
  const reports: PageReport[] = [];
  const sections: SectionReading[] = [];
  const sectionPages: RawPage[] = [];
  let north: number | null = null;

  for (const page of pages) {
    let result: PageResult;
    try {
      result = analysePage(page, multiPage, lang);
    } catch {
      // Une page qui met l'analyse en échec reste affichable : on la rend telle quelle.
      const where = multiPage ? msg(lang, 'pdf.page', { page: page.number }) : '';
      const kind = pageKind(page);
      const display = displaySegments(page, null);
      const sheet: PlanSheet = {
        id: `p${page.number}`,
        name: msg(lang, 'pdf.sheet.page', { page: page.number }),
        bbox: { minX: 0, minY: 0, maxX: page.width, maxY: page.height },
        metresPerUnit: null,
        detected: { rooms: [], openings: [], notes: [] },
      };
      if (display.data.length > 0) sheet.segments = display.data;
      if (page.texts.length > 0) sheet.texts = sheetTexts(page.texts);
      result = {
        drafts: [{ sheet, placement: wholePagePlacement(page, kind), rank: null }],
        warnings: [capitalise(msg(lang, 'pdf.warn.analysis', { where }))],
        report: { page: page.number, kind, declared: [], dims: null, areas: null, scaleDen: null, wallWidth: null, views: [], sheets: 0 },
        sections: [],
        north: null,
        sectionOnly: false,
      };
    }
    result.report.sheets = result.drafts.length;
    reports.push(result.report);
    warnings.push(...result.warnings);
    drafts.push(...result.drafts);
    sections.push(...result.sections);
    if (result.sectionOnly) sectionPages.push(page);
    if (north === null && result.north !== null) north = result.north;
  }

  // Aucun plan reconnu alors que le PDF a des pages : on les propose telles quelles plutôt que rien.
  if (drafts.length === 0 && sectionPages.length > 0) {
    warnings.push(msg(lang, 'pdf.warn.onlySections'));
    for (const page of sectionPages) {
      const display = displaySegments(page, null);
      const sheet: PlanSheet = {
        id: `p${page.number}`,
        name: msg(lang, 'pdf.sheet.page', { page: page.number }),
        bbox: { minX: 0, minY: 0, maxX: page.width, maxY: page.height },
        metresPerUnit: null,
        detected: { rooms: [], openings: [], notes: [] },
      };
      if (display.data.length > 0) sheet.segments = display.data;
      if (page.texts.length > 0) sheet.texts = sheetTexts(page.texts);
      const report = reports.find((r) => r.page === page.number);
      if (report?.scaleDen) sheet.metresPerUnit = { value: report.scaleDen * METRES_PER_POINT, from: 'estimate', note: msg(lang, 'pdf.scale.title', { scale: scaleLabel(report.scaleDen), sourceFrom: msg(lang, 'pdf.source.block.from') }) };
      if (report) report.sheets = 1;
      drafts.push({ sheet, placement: wholePagePlacement(page, pageKind(page)), rank: null });
    }
  }

  // Hauteurs lues sur les coupes, distribuées aux plans par niveau.
  const heights = combineSections(sections);
  for (const d of drafts) {
    const h = heightsFor(heights, d.rank);
    // Une hauteur libre écrite sur le plan lui-même (« HSP 2,50 » dans les pièces) prime sur celle de la coupe.
    const own = (d.sheet.texts ?? []).map((t) => parseClearHeight(t.text)).filter((v): v is number => v !== null);
    const ownDistinct = [...new Set(own.map((v) => Math.round(v * 100) / 100))];
    if (ownDistinct.length === 1 && sections.length === 0) h.clearHeight = ownDistinct[0]!;
    if (h.storeyHeight !== undefined) d.sheet.detected.storeyHeight = h.storeyHeight;
    if (h.clearHeight !== undefined) d.sheet.detected.clearHeight = h.clearHeight;
    if (h.elevation !== undefined) d.sheet.detected.elevation = h.elevation;
    const text = heightsText(lang, h);
    if (text && sections.length > 0) d.sheet.detected.notes.push(msg(lang, 'pdf.note.heights', { heights: text }));
  }

  // Noms : un document d'une seule feuille sans titre prend le niveau que suggère le nom du fichier.
  if (drafts.length === 1 && drafts[0]!.rank === null && /^(Page|Seite) \d+$/.test(drafts[0]!.sheet.name)) {
    const fromFile = guessStorey(baseName(fileName).replace(/[_\-.]+/g, ' '));
    if (fromFile) drafts[0]!.sheet.name = fromFile[lang];
  }
  const seen = new Map<string, number>();
  for (const d of drafts) {
    const n = (seen.get(d.sheet.name) ?? 0) + 1;
    seen.set(d.sheet.name, n);
    if (n > 1) d.sheet.name = `${d.sheet.name} (${n})`;
  }

  const doc: PlanDocument = {
    fileName,
    kind: 'pdf',
    sheets: drafts.map((d) => d.sheet),
    storeysAligned: false,
    warnings: [...new Set(warnings)],
  };
  if (north !== null) {
    // `north` = direction du nord, en degrés horaires depuis le haut ; le haut de la feuille pointe donc vers −north.
    doc.northAngle = { value: round(normDeg(-north), 1), from: 'estimate', note: msg(lang, 'pdf.north.note') };
  }
  return { doc, placements: drafts.map((d) => d.placement), pages: reports };
}
