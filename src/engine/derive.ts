/**
 * Du bâtiment confirmé aux tableaux de LuxEeB-Tool : enveloppe, zones (An / Vn), volumes (Ve), récapitulatifs,
 * totaux et contrôles de plausibilité. Fonction pure : le projet reçu n'est jamais modifié.
 *
 * Rappels de méthode :
 *  - enveloppe A et volume Ve en dimensions EXTÉRIEURES (contour brut × hauteur d'étage brute) ;
 *  - LuxEeB-Tool déduit les lignes marquées « Abzug » de la PROCHAINE ligne non marquée : chaque fenêtre ou porte
 *    est donc placée juste AVANT la paroi qui la porte ;
 *  - les longueurs sont arrondies au centimètre et les surfaces recalculées à partir des valeurs arrondies,
 *    pour afficher exactement ce que LuxEeB-Tool calculera après saisie ;
 *  - les murs mitoyens contre un voisin chauffé ne font pas partie de l'enveloppe.
 *
 * Provenance d'une ligne = la plus faible des données dont elle dépend :
 *  - la géométrie du contour compte pour 'plan', mais une échelle non confirmée l'affaiblit ;
 *  - une ligne ORIENTÉE (mur, ouverture, pan de toiture) dépend aussi du nord : nord non confirmé → ligne à confirmer ;
 *  - s'y ajoutent la hauteur d'étage, la fermeture haute ou basse, et la provenance propre de chaque ouverture.
 */
import {
  edgeAzimuth,
  edgeLength,
  extentAlong,
  isSelfIntersecting,
  longestEdgeAngle,
  marginToSectorBoundary,
  polygonArea,
  round,
  scalePolygon,
  sectorOfAzimuth,
} from '../core/geometry';
import {
  ORIENTATIONS,
  type Boundary,
  type BuildingModel,
  type Construction,
  type ConstructionSummary,
  type EnvelopeRow,
  type Finding,
  type Lang,
  type LuxeebSheets,
  type ManualRow,
  type Opening,
  type Orientation,
  type OrientationOrHorizontal,
  type Project,
  type Provenance,
  type Room,
  type Severity,
  type Sourced,
  type Storey,
  type Totals,
  type Vec2,
  type VolumeRow,
  type WindowSummary,
  type WindowType,
  type ZoneRow,
} from '../core/types';
import { formatNumber, t } from '../i18n';
import {
  DEFAULT_CONSTRUCTION_IDS,
  bottomBoundary,
  defaultFloorId,
  defaultWallId,
  resolveConstruction,
  resolveWindowType,
} from './defaults';
import type { FindingCode } from './messages';
import { differenceArea, differenceWithinArea, grownArea } from './polygonOps';
import { isOutsideEnvelopeName } from '../semantics/labels';
import { unheatedRoomsBeside, unheatedRoomsInsideOutline } from './heatedOutline';
import { isUnconfirmed, weakest } from './provenance';
import { computePitchedRoof, isEavesEdge, type PitchedRoof, type RoofSlope } from './roof';
import { netAreaOf, type NetArea } from './storey';
import { CONFIDENCE_SINGLE_SOURCE, type ElevationSide, type ReadComposition, type ReadLevels, type SheetReading } from '../core/reading';
import type { FacadeView } from '../core/cpe';
import { DEFAULT_WINDOW_TYPE_ID } from './defaults';
import { MATERIAL_LIBRARY, windowTypeHypothesis } from './materials';

// ───────────────────────────── Seuils de plausibilité (propres à l'outil, non réglementaires) ─────────────────────────────

const MIN_OUTLINE_AREA = 4; // m²
const HEIGHT_RANGE = { min: 2.2, max: 4.5 }; // m
const AN_RATIO_RANGE = { min: 0.55, max: 0.92 }; // An / surface brute de plancher
const WINDOW_SHARE_RANGE = { min: 0.05, max: 0.45 }; // fenêtres / façades extérieures
const A_OVER_VE_RANGE = { min: 0.25, max: 1.3 }; // 1/m
const PITCH_RANGE = { min: 3, max: 75 }; // degrés
const BORDERLINE_MARGIN = 5; // degrés autour d'une limite de secteur
const STEP_MIN_AREA = 0.5; // m² : en dessous, un décalage entre étages est du bruit de tracé
/** Un local et ses murs extérieurs : portée de la dilatation de son polygone (m). */
const ROOM_WALL_REACH = 0.65;
/** Épaisseur de mur typique, quand seule une surface peut être estimée (m). */
const ROOM_WALL_TYPICAL = 0.3;
const LUXEEB_OPAQUE_SLOTS = 20; // manuel LuxEeB-Tool, ch. 2.2.2 : « 20 éléments de construction sont disponibles »

const BOUNDARY_ORDER: Record<Boundary, number> = { outside: 0, unheated: 1, ground: 2, heated: 3 };
const SEVERITY_ORDER: Record<Severity, number> = { block: 0, warn: 1, info: 2 };

// ───────────────────────────── Structures de travail ─────────────────────────────

/** Un étage ramené en mètres. */
interface StoreyGeometry {
  storey: Storey;
  /** Contour en mètres (repère de la feuille). */
  poly: Vec2[];
  area: number;
  /** Vrai si le contour a au moins 3 points : on peut en tirer des parois. */
  usable: boolean;
  /** Provenance de la géométrie : 'plan', affaiblie par une échelle non confirmée. */
  geometryFrom: Provenance;
}

/** Fenêtres ou portes identiques portées par une même paroi. */
interface OpeningGroup {
  kind: 'window' | 'door';
  windowType: WindowType | null;
  construction: Construction | null;
  widthCm: number;
  heightCm: number;
  count: number;
  sources: Provenance[];
  storeys: Storey[];
}

/** Ce qui peut porter des ouvertures : un groupe de murs ou un pan de toiture. */
interface OpeningHost {
  openings: Map<string, OpeningGroup>;
}

interface WallGroup extends OpeningHost {
  key: string;
  construction: Construction;
  boundary: Boundary;
  orientation: Orientation;
  heightCm: number;
  length: number;
  sources: Provenance[];
  storeys: Storey[];
  /** Ordre « expert » : surface cumulée (m²) et hauteurs rencontrées (cm), le mur couvrant plusieurs étages. */
  area: number;
  heights: Set<number>;
}

interface SlopeHost extends OpeningHost {
  slope: RoofSlope;
}

/** Ligne en cours de construction : le nom du type et le libellé sont fixés à la fin (noms rendus non ambigus). */
interface Draft {
  row: EnvelopeRow;
  construction: Construction | null;
  label: (elementName: string) => string;
}

/** Une paroi précédée de ses lignes à déduire. */
interface Block {
  host: Draft;
  deductions: Draft[];
}

function pushUnique<T>(list: T[], item: T): void {
  if (!list.includes(item)) list.push(item);
}

function fmt(value: number, digits = 2): string {
  return formatNumber(value, digits);
}

// ───────────────────────────── Calcul ─────────────────────────────

export function deriveSheets(project: Project, lang: Lang): LuxeebSheets {
  const model = project.model;
  /**
   * Ordre de saisie de l'expert (planchers bas, toiture, façade par façade dans l'ordre des façades dessinées,
   * portes puis fenêtres avant leur mur, puis parois vers le non chauffé). Absent : ordre historique, inchangé.
   */
  const expert = model.envelopeOrder === 'expert';
  const facadeRank = (o: Orientation): number => {
    const i = model.facadeViews?.findIndex((f) => f.orientation === o) ?? -1;
    return i >= 0 ? i : 100 + ORIENTATIONS.indexOf(o);
  };
  const facadeShort = (o: Orientation): string =>
    model.facadeViews?.find((f) => f.orientation === o)?.short || t(lang, `engine.short.${o}`);
  const northFinite = Number.isFinite(model.northAngle.value);
  const north = northFinite ? model.northAngle.value : 0;
  // Un nord illisible vaut un nord non confirmé.
  const northFrom: Provenance = northFinite ? model.northAngle.from : 'default';
  const findings: Finding[] = [];
  const note = (code: FindingCode, severity: Severity, params: Record<string, string | number> = {}): void => {
    findings.push({ code, severity, params });
  };
  const orientationName = (o: OrientationOrHorizontal): string => t(lang, `engine.orientation.${o}`);
  const storeyNames = (storeys: readonly Storey[]): string => storeys.map((s) => s.name).join(t(lang, 'engine.storeys.join'));
  const storeyIdOf = (storeys: readonly Storey[]): string | null => (storeys.length === 1 ? storeys[0]!.id : null);

  // ── Étages en mètres ──
  const geometries: StoreyGeometry[] = model.storeys.map((storey) => {
    const s = storey.metresPerUnit.value;
    // Échelle ou sommet non fini (NaN, infini) : l'étage est inutilisable, et le dit par un constat bloquant.
    const finite = Number.isFinite(s) && s > 0 && storey.outline.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const poly = finite ? scalePolygon(storey.outline, s) : [];
    const usable = poly.length >= 3;
    return {
      storey,
      poly,
      area: finite ? polygonArea(poly) : 0,
      usable,
      // Sans contour utilisable, rien n'a été « lu sur le plan » : un volume de 0 m³ ne doit pas en porter l'étiquette.
      geometryFrom: usable ? weakest('plan', storey.metresPerUnit.from) : 'estimate',
    };
  });
  const topGeometry = geometries[geometries.length - 1];
  const bottomGeometry = geometries[0];
  const pitched: PitchedRoof | null =
    model.top.kind === 'pitched-roof' && topGeometry && topGeometry.usable && topGeometry.area > 0
      ? computePitchedRoof(
          topGeometry.poly,
          model.top,
          north,
          topGeometry.poly.map((_, i) => topGeometry.storey.edges[i]?.boundary),
        )
      : null;
  /**
   * Ce qui affaiblit tout ce qui dépend de la forme du toit : sens du faîtage seulement supposé, ou contour non
   * rectangulaire (portée, hauteurs de murs et volume ne sont alors que des approximations).
   */
  const roofDoubt: Provenance[] = pitched && (pitched.ridgeAssumed || pitched.nonRectangular) ? ['estimate'] : [];
  const isPitchedTop = (g: StoreyGeometry): boolean => model.top.kind === 'pitched-roof' && g === topGeometry;

  const drafts: Draft[] = [];
  const draft = (
    p: Omit<EnvelopeRow, 'label' | 'elementName' | 'grossArea' | 'netArea' | 'constructionId' | 'windowTypeId'> & {
      construction: Construction | null;
      windowType: WindowType | null;
      label: (elementName: string) => string;
    },
  ): Draft => {
    const length = round(Math.max(0, p.length));
    const width = round(Math.max(0, p.width));
    const count = Math.max(0, p.count);
    const grossArea = round(count * length * width, 4);
    const d: Draft = {
      row: {
        id: p.id,
        kind: p.kind,
        label: '',
        elementName: p.windowType ? p.windowType.name : (p.construction?.name ?? ''),
        constructionId: p.construction ? p.construction.id : null,
        windowTypeId: p.windowType ? p.windowType.id : null,
        count,
        length,
        width,
        orientation: p.orientation,
        boundary: p.boundary,
        deduct: p.deduct,
        grossArea,
        netArea: grossArea,
        from: p.from,
        storeyId: p.storeyId,
        manual: p.manual,
      },
      construction: p.construction,
      label: p.label,
    };
    if (p.entry === 'area') d.row.entry = 'area';
    drafts.push(d);
    return d;
  };

  /** Lignes « Abzug » d'une paroi, dans l'ordre de première apparition. */
  const openingDrafts = (host: OpeningHost, hostId: string, orientation: Orientation, boundary: Boundary): Draft[] =>
    [...host.openings.entries()]
      // Ordre « expert » : les portes d'abord, puis les fenêtres, chacune dans l'ordre de première apparition.
      .sort(([, a], [, b]) => (expert ? Number(a.kind === 'window') - Number(b.kind === 'window') : 0))
      .map(([key, o]) => {
      const width = o.widthCm / 100;
      const height = o.heightCm / 100;
      return draft({
        id: `opening:${hostId}:${key}`,
        kind: o.kind,
        construction: o.construction,
        windowType: o.windowType,
        count: o.count,
        length: width,
        width: height,
        orientation,
        boundary,
        deduct: true,
        from: weakest(...o.sources, northFrom),
        storeyId: storeyIdOf(o.storeys),
        manual: false,
        label: () =>
          expert ? expertOpeningLabel(o, orientation, boundary) : t(lang, `engine.row.${o.kind}`, {
            width: fmt(width),
            height: fmt(height),
            orientation: orientationName(orientation),
            storeys: storeyNames(o.storeys),
          }),
      });
    });

  /** Nom à la manière de l'expert : « AV 94*125 X2 » (façade, largeur*hauteur en cm, nombre), « Porte d'entrée ». */
  const expertOpeningLabel = (o: OpeningGroup, orientation: Orientation, boundary: Boundary): string => {
    if (o.kind === 'door') return t(lang, boundary === 'unheated' ? 'engine.row.expert.doorUnheated' : 'engine.row.expert.door');
    const prefix = boundary === 'unheated' ? '' : `${facadeShort(orientation)} `;
    return `${prefix}${o.widthCm}*${o.heightCm}${o.count > 1 ? ` X${o.count}` : ''}`;
  };

  // ── 1. Murs et ouvertures ──
  const walls = new Map<string, WallGroup>();
  const slopeHosts: SlopeHost[] = (pitched?.slopes ?? []).map((slope) => ({ slope, openings: new Map() }));
  const borderline = new Map<number, { azimuth: number; length: number }>();
  let heatedLength = 0;

  const addOpening = (host: OpeningHost, o: Opening, g: StoreyGeometry): void => {
    const widthCm = Math.round(o.width * 100);
    const heightCm = Math.round(o.height * 100);
    const windowType = o.kind === 'window' ? resolveWindowType(model, o.windowTypeId, lang) : null;
    // Une porte peut porter son propre type (porte d'entrée, porte vers un local non chauffé) ; sinon le type par défaut.
    const doorTypeId = o.constructionId ?? null;
    const doorType = doorTypeId !== null && model.constructions.some((c) => c.id === doorTypeId && c.category === 'door') ? doorTypeId : null;
    const construction = o.kind === 'door' ? resolveConstruction(model, doorType, DEFAULT_CONSTRUCTION_IDS.door, lang) : null;
    const key = `${o.kind}:${windowType?.id ?? construction?.id ?? ''}:${widthCm}x${heightCm}`;
    let group = host.openings.get(key);
    if (!group) {
      group = { kind: o.kind, windowType, construction, widthCm, heightCm, count: 0, sources: [], storeys: [] };
      host.openings.set(key, group);
    }
    group.count += o.count;
    // Une dimension saisie par l'expert ne dépend pas de l'échelle ; une dimension lue sur le plan, si.
    group.sources.push(o.from === 'user' ? 'user' : weakest(o.from, g.storey.metresPerUnit.from));
    pushUnique(group.storeys, g.storey);
  };

  const nearestSlope = (azimuth: number): SlopeHost | null => {
    let best: SlopeHost | null = null;
    let bestGap = Infinity;
    for (const h of slopeHosts) {
      const d = Math.abs(azimuth - h.slope.azimuth) % 360;
      const gap = d > 180 ? 360 - d : d;
      if (gap < bestGap) {
        best = h;
        bestGap = gap;
      }
    }
    return best;
  };

  for (const g of geometries) {
    const activeOpenings = g.storey.openings.filter((o) => o.count > 0 && o.width > 0 && o.height > 0);
    const countOf = (list: readonly Opening[]): number => list.reduce((sum, o) => sum + o.count, 0);
    if (!g.usable) {
      if (activeOpenings.length > 0) {
        note('opening.orphan', 'warn', { storey: g.storey.name, storeyId: g.storey.id, count: countOf(activeOpenings) });
      }
      continue;
    }
    const roof = g === topGeometry ? pitched : null;
    /** Par arête : le mur (ou le pan de toiture) qui porte ses ouvertures, 'heated' pour un mitoyen, null si aucun. */
    const hostOfEdge: Array<WallGroup | SlopeHost | 'heated' | null> = [];
    /** Hauteur (cm) du mur porté par chaque arête : un groupe « expert » peut réunir plusieurs hauteurs. */
    const heightOfEdge: number[] = [];

    for (let i = 0; i < g.poly.length; i++) {
      const edge = g.storey.edges[i];
      const boundary: Boundary = edge?.boundary ?? 'outside';
      const length = edgeLength(g.poly, i);
      if (boundary === 'heated') {
        heatedLength += length;
        hostOfEdge.push('heated');
        continue;
      }
      const azimuth = edgeAzimuth(g.poly, i, north);
      const orientation = sectorOfAzimuth(azimuth);
      if (boundary === 'outside' && length > 0 && marginToSectorBoundary(azimuth) < BORDERLINE_MARGIN) {
        const bucket = Math.round(azimuth * 10) % 3600;
        const entry = borderline.get(bucket) ?? { azimuth, length: 0 };
        entry.length += length;
        borderline.set(bucket, entry);
      }

      let height: number;
      const sources: Provenance[] = [g.geometryFrom, northFrom];
      if (roof) {
        const eaves = isEavesEdge(g.poly, i, roof.ridgeAngle);
        height = eaves ? roof.eavesHeight : roof.gableHeight;
        sources.push(model.top.from, ...roofDoubt);
        if (eaves && roof.eavesEstimated) sources.push('estimate');
      } else {
        height = g.storey.grossHeight.value;
        sources.push(g.storey.grossHeight.from);
      }
      const heightCm = Math.round(height * 100);
      if (!(heightCm > 0) || !(length > 0)) {
        // Pas de mur (jambette nulle sous un rampant) : une ouverture posée là est une fenêtre de toit.
        hostOfEdge.push(roof ? nearestSlope(azimuth) : null);
        continue;
      }

      // Un type qui n'est pas (ou plus) un mur ne peut pas habiller une façade : on retombe sur le type par défaut.
      const edgeTypeId = edge?.constructionId ?? null;
      const wallTypeId = edgeTypeId !== null && model.constructions.some((c) => c.id === edgeTypeId && c.category === 'wall') ? edgeTypeId : null;
      const construction = resolveConstruction(model, wallTypeId, defaultWallId(boundary), lang);
      // Ordre « expert » : un mur par façade, tous étages et hauteurs confondus (saisi en surface s'il le faut).
      // Vers le non chauffé ou la terre, l'orientation ne compte pas pour l'outil : une seule ligne par type.
      const key = !expert
        ? `${construction.id}|${boundary}|${orientation}|${heightCm}`
        : boundary === 'outside'
          ? `${construction.id}|${boundary}|${orientation}`
          : `${construction.id}|${boundary}`;
      let group = walls.get(key);
      if (!group) {
        group = {
          key,
          construction,
          boundary,
          orientation,
          heightCm,
          length: 0,
          sources: [],
          storeys: [],
          openings: new Map(),
          area: 0,
          heights: new Set(),
        };
        walls.set(key, group);
      }
      group.length += length;
      group.area += length * (heightCm / 100);
      group.heights.add(heightCm);
      heightOfEdge[i] = heightCm;
      group.sources.push(...sources);
      pushUnique(group.storeys, g.storey);
      hostOfEdge.push(group);
    }

    const onHeated: Opening[] = [];
    const orphans: Opening[] = [];
    const inRoof: Opening[] = [];
    /** Largeur cumulée des ouvertures par arête, et nombre d'ouvertures plus hautes que leur mur. */
    const widthOnEdge = new Map<number, number>();
    let tooTall = 0;
    for (const o of activeOpenings) {
      const host = Number.isInteger(o.edgeIndex) ? hostOfEdge[o.edgeIndex] : undefined;
      if (host === undefined || host === null) orphans.push(o);
      else if (host === 'heated') onHeated.push(o);
      else {
        if ('slope' in host) inRoof.push(o);
        else {
          widthOnEdge.set(o.edgeIndex, (widthOnEdge.get(o.edgeIndex) ?? 0) + o.width * o.count);
          if (o.height * 100 > (heightOfEdge[o.edgeIndex] ?? host.heightCm) + 1) tooTall += o.count;
        }
        addOpening(host, o, g);
      }
    }
    const where = { storey: g.storey.name, storeyId: g.storey.id };
    // Contrôle façade par façade, AVANT le regroupement : une fenêtre trop large sur un étage ne doit pas être
    // masquée par le mur de même orientation d'un autre étage.
    for (const [index, widths] of widthOnEdge) {
      const length = edgeLength(g.poly, index);
      if (widths > length + 0.01) {
        note('opening.exceedsFacade', 'warn', {
          ...where,
          orientation: orientationName(sectorOfAzimuth(edgeAzimuth(g.poly, index, north))),
          widths: fmt(widths),
          length: fmt(length),
        });
      }
    }
    if (tooTall > 0) note('opening.tallerThanWall', 'warn', { ...where, count: tooTall });
    if (onHeated.length > 0) note('opening.onHeatedWall', 'warn', { ...where, count: countOf(onHeated) });
    if (orphans.length > 0) note('opening.orphan', 'warn', { ...where, count: countOf(orphans) });
    if (inRoof.length > 0) note('opening.inRoof', 'info', { ...where, count: countOf(inRoof) });
  }

  const constructionRank = (c: Construction): number => {
    const i = model.constructions.findIndex((x) => x.id === c.id);
    return i < 0 ? model.constructions.length : i;
  };
  const byOrientation = (a: WallGroup, b: WallGroup): number =>
    ORIENTATIONS.indexOf(a.orientation) - ORIENTATIONS.indexOf(b.orientation) ||
    BOUNDARY_ORDER[a.boundary] - BOUNDARY_ORDER[b.boundary] ||
    constructionRank(a.construction) - constructionRank(b.construction) ||
    b.heightCm - a.heightCm;
  // Ordre « expert » : les façades (contre extérieur) dans l'ordre des façades dessinées, puis contre terre, puis
  // vers le non chauffé ; repli par orientation quand la façade n'est pas dessinée.
  const byFacade = (a: WallGroup, b: WallGroup): number =>
    BOUNDARY_ORDER[a.boundary] - BOUNDARY_ORDER[b.boundary] ||
    facadeRank(a.orientation) - facadeRank(b.orientation) ||
    constructionRank(a.construction) - constructionRank(b.construction);
  const wallBlocks: Block[] = [...walls.values()]
    .sort(expert ? byFacade : byOrientation)
    .map((w) => {
      const id = `wall:${w.key}`;
      const deductions = openingDrafts(w, id, w.orientation, w.boundary);
      // Plusieurs étages ou plusieurs hauteurs : la surface seule, dans « Breite [m] od. Fläche [m²] ».
      const byArea = expert && (w.storeys.length > 1 || w.heights.size > 1);
      const host = draft({
        id,
        kind: 'wall',
        construction: w.construction,
        windowType: null,
        count: 1,
        length: byArea ? 1 : w.length,
        width: byArea ? w.area : w.heightCm / 100,
        ...(byArea ? { entry: 'area' as const } : {}),
        orientation: w.orientation,
        boundary: w.boundary,
        deduct: false,
        from: weakest(...w.sources),
        storeyId: storeyIdOf(w.storeys),
        manual: false,
        label: (element) =>
          // Vers le non chauffé ou la terre (ordre « expert »), l'orientation ne dit rien : elle n'est pas nommée.
          expert && w.boundary !== 'outside'
            ? t(lang, 'engine.row.wallInside', { element, storeys: storeyNames(w.storeys) })
            : t(lang, 'engine.row.wall', {
                element,
                orientation: orientationName(w.orientation),
                storeys: storeyNames(w.storeys),
              }),
      });
      return { host, deductions };
    });

  // ── 2. Fermeture haute du dernier étage ──
  /**
   * Longueur × largeur d'une surface horizontale. Rectangle : ses deux côtés. Toute autre forme : la surface sur
   * la longueur et 1 m de largeur (comme le fait le manuel de LuxEeB-Tool), pour que longueur × largeur redonne
   * exactement la surface — une « largeur moyenne » arrondie au centimètre ne le ferait pas.
   */
  const horizontalDims = (poly: readonly Vec2[], area: number): { length: number; width: number } => {
    if (!(area > 0)) return { length: 0, width: 0 };
    const e = extentAlong(poly, longestEdgeAngle(poly));
    const rect = e.along * e.across;
    return rect > 0 && Math.abs(rect - area) <= 0.001 * area ? { length: e.along, width: e.across } : { length: area, width: 1 };
  };
  const ofCategory = (id: string | null, category: Construction['category']): string | null =>
    id !== null && model.constructions.some((c) => c.id === id && c.category === category) ? id : null;

  const roofBlocks: Block[] = [];
  const ceilingBlocks: Block[] = [];
  const floorBlocks: Block[] = [];

  if (topGeometry && topGeometry.usable && topGeometry.area > 0) {
    const g = topGeometry;
    const top = model.top;
    if (top.kind === 'pitched-roof' && pitched) {
      const construction = resolveConstruction(model, ofCategory(top.constructionId, 'roof'), DEFAULT_CONSTRUCTION_IDS.roof, lang);
      const from = weakest(g.geometryFrom, top.from, northFrom, ...roofDoubt);
      const ordered = [...slopeHosts].sort(
        (a, b) => ORIENTATIONS.indexOf(a.slope.orientation) - ORIENTATIONS.indexOf(b.slope.orientation),
      );
      ordered.forEach((h, n) => {
        const id = `roof:slope:${n}:${h.slope.orientation}`;
        const deductions = openingDrafts(h, id, h.slope.orientation, 'outside');
        const host = draft({
          id,
          kind: 'roof',
          construction,
          windowType: null,
          count: 1,
          length: h.slope.length,
          width: h.slope.area / h.slope.length,
          orientation: h.slope.orientation,
          boundary: 'outside',
          deduct: false,
          from,
          storeyId: g.storey.id,
          manual: false,
          label: () =>
            t(lang, 'engine.row.roofSlope', {
              orientation: orientationName(h.slope.orientation),
              pitch: fmt(pitched.pitchDeg, 0),
              storey: g.storey.name,
            }),
        });
        roofBlocks.push({ host, deductions });
      });
    } else if (top.kind === 'flat-roof') {
      const construction = resolveConstruction(model, ofCategory(top.constructionId, 'roof'), DEFAULT_CONSTRUCTION_IDS.roof, lang);
      const host = draft({
        id: 'roof:top',
        kind: 'roof',
        construction,
        windowType: null,
        count: 1,
        ...horizontalDims(g.poly, g.area),
        orientation: 'H',
        boundary: 'outside',
        deduct: false,
        from: weakest(g.geometryFrom, top.from),
        storeyId: g.storey.id,
        manual: false,
        label: () => t(lang, 'engine.row.roofFlat', { storey: g.storey.name }),
      });
      roofBlocks.push({ host, deductions: [] });
    } else if (top.kind === 'attic-ceiling') {
      const construction = resolveConstruction(
        model,
        ofCategory(top.constructionId, 'ceiling'),
        DEFAULT_CONSTRUCTION_IDS.ceiling,
        lang,
      );
      const host = draft({
        id: 'ceiling:top',
        kind: 'ceiling',
        construction,
        windowType: null,
        count: 1,
        ...horizontalDims(g.poly, g.area),
        orientation: 'H',
        boundary: 'unheated',
        deduct: false,
        from: weakest(g.geometryFrom, top.from),
        storeyId: g.storey.id,
        manual: false,
        label: () => t(lang, 'engine.row.ceiling', { storey: g.storey.name }),
      });
      ceilingBlocks.push({ host, deductions: [] });
    }
  }

  // ── 3. Fermeture basse du premier étage ──
  let groundSlab: { constructionId: string; slabArea: number; perimeter: number } | null = null;
  if (bottomGeometry && bottomGeometry.usable && bottomGeometry.area > 0) {
    const g = bottomGeometry;
    const bottom = model.bottom;
    const boundary = bottomBoundary(bottom.kind);
    const construction = resolveConstruction(model, ofCategory(bottom.constructionId, 'floor'), defaultFloorId(bottom.kind), lang);
    const host = draft({
      id: 'floor:bottom',
      kind: 'floor',
      construction,
      windowType: null,
      count: 1,
      ...horizontalDims(g.poly, g.area),
      orientation: 'H',
      boundary,
      deduct: false,
      from: weakest(g.geometryFrom, bottom.from),
      storeyId: g.storey.id,
      manual: false,
      label: () => t(lang, `engine.row.floor.${bottom.kind}`, { storey: g.storey.name }),
    });
    floorBlocks.push({ host, deductions: [] });
    if (boundary === 'ground') {
      // Manuel LuxEeB-Tool 2.2.5 : la partie du périmètre au contact de zones chauffées ne compte pas.
      let perimeter = 0;
      for (let i = 0; i < g.poly.length; i++) {
        if ((g.storey.edges[i]?.boundary ?? 'outside') !== 'heated') perimeter += edgeLength(g.poly, i);
      }
      // Même surface que la ligne effectivement saisie dans le tableau.
      groundSlab = { constructionId: construction.id, slabArea: host.row.grossArea, perimeter: round(perimeter) };
    }
  }

  // ── 4. Décalages entre étages consécutifs : toitures-terrasses et surplombs ──
  for (let i = 0; i + 1 < geometries.length; i++) {
    const lower = geometries[i]!;
    const upper = geometries[i + 1]!;
    if (!lower.usable || !upper.usable) continue;
    let exposed = Math.max(0, lower.area - upper.area);
    let overhang = Math.max(0, upper.area - lower.area);
    let exact = false;
    // Étages dessinés côte à côte : la translation d'alignement de chaque contour les rend superposables.
    const byOffset = !model.storeysAligned && lower.storey.offset !== undefined && upper.storey.offset !== undefined;
    const shift = (g: StoreyGeometry): Vec2 => {
      const k = g.storey.metresPerUnit.value;
      const o = byOffset ? g.storey.offset : undefined;
      return o && Number.isFinite(o.dx) && Number.isFinite(o.dy) ? { x: o.dx * k, y: o.dy * k } : { x: 0, y: 0 };
    };
    const lowerShift = shift(lower);
    const upperShift = shift(upper);
    const moved = (poly: readonly Vec2[], d: Vec2): Vec2[] => poly.map((p) => ({ x: p.x + d.x, y: p.y + d.y }));
    const lowerPoly = moved(lower.poly, lowerShift);
    const upperPoly = moved(upper.poly, upperShift);
    if (model.storeysAligned || byOffset) {
      const e = differenceArea(lowerPoly, upperPoly);
      const o = differenceArea(upperPoly, lowerPoly);
      if (e !== null && o !== null) {
        exposed = e;
        overhang = o;
        exact = true;
      }
    }
    // Un alignement peu sûr ne vaut pas une lecture : ce qu'il donne reste à confirmer.
    const alignmentDoubt: Provenance[] =
      byOffset && Math.min(lower.storey.offset!.confidence, upper.storey.offset!.confidence) < CONFIDENCE_SINGLE_SOURCE ? ['estimate'] : [];
    const from = weakest(lower.geometryFrom, upper.geometryFrom, ...alignmentDoubt);
    if (exposed > STEP_MIN_AREA) {
      const host = draft({
        id: `roof:terrace:${lower.storey.id}`,
        kind: 'roof',
        construction: resolveConstruction(model, null, DEFAULT_CONSTRUCTION_IDS.roof, lang),
        windowType: null,
        count: 1,
        // Forme quelconque : on porte la surface sur la longueur, largeur 1 m.
        length: exposed,
        width: 1,
        orientation: 'H',
        boundary: 'outside',
        deduct: false,
        from,
        storeyId: lower.storey.id,
        manual: false,
        label: () => t(lang, 'engine.row.roofTerrace', { storey: lower.storey.name }),
      });
      roofBlocks.push({ host, deductions: [] });
    }
    // Part du surplomb qui couvre un local non chauffé laissé hors du contour du niveau inférieur (garage intégré
    // sous des chambres) : ce plancher donne sur un local non chauffé, pas sur l'air extérieur.
    let overUnheated = 0;
    const below = unheatedRoomsBeside(lower.storey);
    if (overhang > STEP_MIN_AREA && below.length > 0) {
      const scale = lower.storey.metresPerUnit.value;
      for (const room of below) {
        const footprint = moved(scalePolygon(room.polygon!, scale), lowerShift);
        const part = exact ? differenceWithinArea(upperPoly, lowerPoly, footprint, ROOM_WALL_REACH) : null;
        overUnheated += part ?? grownArea(footprint, ROOM_WALL_TYPICAL) ?? polygonArea(footprint);
      }
      overUnheated = Math.min(overhang, overUnheated);
      if (overhang - overUnheated <= STEP_MIN_AREA) overUnheated = overhang;
    }
    // Mesure du lecteur (plans superposés) : elle remplace la différence de contours, même si celle-ci ne voit rien.
    const readOver = upper.storey.floorOverUnheated;
    let overFrom = exact ? from : weakest(from, 'estimate');
    if (readOver && Number.isFinite(readOver.value) && readOver.value > STEP_MIN_AREA) {
      overUnheated = readOver.value;
      overhang = Math.max(0, overhang - readOver.value);
      overFrom = readOver.from;
    }
    if (overUnheated > STEP_MIN_AREA) {
      const host = draft({
        id: `floor:overUnheated:${upper.storey.id}`,
        kind: 'floor',
        construction: resolveConstruction(model, null, DEFAULT_CONSTRUCTION_IDS.floorUnheated, lang),
        windowType: null,
        count: 1,
        length: overUnheated,
        width: 1,
        orientation: 'H',
        boundary: 'unheated',
        deduct: false,
        from: overFrom,
        storeyId: upper.storey.id,
        manual: false,
        label: () =>
          below.some((r) => r.name.trim())
            ? t(lang, 'engine.row.floorOverUnheated', { storey: upper.storey.name, rooms: below.map((r) => r.name.trim()).filter(Boolean).join(', ') })
            : t(lang, 'engine.row.floorOverUnheatedPlain', { storey: upper.storey.name }),
      });
      floorBlocks.push({ host, deductions: [] });
      overhang -= overUnheated;
    }
    // Il reste un surplomb alors que le niveau du dessous a un mur contre un local non chauffé dont on ne connaît pas
    // l'emprise : ce plancher donne peut-être sur ce local. On ne l'affirme pas « sur extérieur » comme une lecture.
    const overhangUncertain = overhang > STEP_MIN_AREA && lower.storey.edges.some((e) => e.boundary === 'unheated');
    if (overhangUncertain) {
      note('stepback.overhangUncertain', 'warn', { lower: lower.storey.name, upper: upper.storey.name, area: fmt(overhang) });
    }
    if (overhang > STEP_MIN_AREA) {
      const host = draft({
        id: `floor:overhang:${upper.storey.id}`,
        kind: 'floor',
        construction: resolveConstruction(model, null, DEFAULT_CONSTRUCTION_IDS.floorOutside, lang),
        windowType: null,
        count: 1,
        length: overhang,
        width: 1,
        orientation: 'H',
        boundary: 'outside',
        deduct: false,
        from: overhangUncertain ? weakest(from, 'estimate') : from,
        storeyId: upper.storey.id,
        manual: false,
        label: () => t(lang, 'engine.row.floorOverhang', { storey: upper.storey.name }),
      });
      floorBlocks.push({ host, deductions: [] });
    }
    if (!exact && (exposed > STEP_MIN_AREA || overhang > STEP_MIN_AREA || overUnheated > STEP_MIN_AREA)) {
      note('stepback.byAreas', 'info', {
        lower: lower.storey.name,
        upper: upper.storey.name,
        area: fmt(Math.max(exposed, overhang, overUnheated)),
      });
    }
  }

  // ── 5. Lignes manuelles de l'expert (même règle « Abzug » entre elles) ──
  const manualBlocks: Block[] = [];
  let pendingManual: Draft[] = [];
  let manualHeated = 0;
  let manualMismatch = 0;
  for (const m of model.manualRows) {
    if (m.boundary === 'heated') {
      manualHeated++;
      continue;
    }
    const d = manualDraft(m, model, lang, draft);
    if (m.deduct) pendingManual.push(d);
    else {
      // Une fenêtre nord déduite d'une dalle : la ligne à déduire n'est pas devant la bonne paroi.
      manualMismatch += pendingManual.filter((x) => x.row.orientation !== d.row.orientation || x.row.boundary !== d.row.boundary).length;
      manualBlocks.push({ host: d, deductions: pendingManual });
      pendingManual = [];
    }
  }
  if (manualMismatch > 0) note('manual.deductMismatch', 'warn', { count: manualMismatch });
  const danglingManual = pendingManual;
  if (manualHeated > 0) note('manual.heatedIgnored', 'info', { count: manualHeated });
  if (danglingManual.length > 0) note('abzug.dangling', 'warn', { count: danglingManual.length });

  // ── 6. Noms des types (rendus non ambigus) et libellés ──
  const boundariesOf = new Map<string, Set<Boundary>>();
  for (const d of drafts) {
    if (!d.construction) continue;
    const set = boundariesOf.get(d.construction.id) ?? new Set<Boundary>();
    set.add(d.row.boundary);
    boundariesOf.set(d.construction.id, set);
  }
  /** Un même type utilisé contre deux milieux différents donne deux éléments dans LuxEeB-Tool : on les distingue par le nom. */
  const elementNameOf = (c: Construction, boundary: Boundary): string =>
    (boundariesOf.get(c.id)?.size ?? 0) > 1 ? `${c.name} (${t(lang, `engine.against.${boundary}`)})` : c.name;
  for (const d of drafts) {
    if (d.construction) d.row.elementName = elementNameOf(d.construction, d.row.boundary);
    d.row.label = d.label(d.row.elementName);
  }

  // ── 7. Assemblage dans l'ordre de saisie, déductions comprises ──
  const envelope: EnvelopeRow[] = [];
  let facadeWindowArea = 0;
  const order = expert
    ? [...floorBlocks, ...roofBlocks, ...ceilingBlocks, ...wallBlocks, ...manualBlocks]
    : [...wallBlocks, ...roofBlocks, ...ceilingBlocks, ...floorBlocks, ...manualBlocks];
  if (expert) {
    // Surface horizontale de forme quelconque (portée par la longueur, largeur 1 m) : comme l'expert, la surface
    // va seule dans « Breite [m] od. Fläche [m²] ». La surface brute ne change pas.
    for (const block of order) {
      const r = block.host.row;
      if (r.kind !== 'wall' && r.entry !== 'area' && r.width === 1 && r.length !== 1) {
        r.width = r.length;
        r.length = 1;
        r.entry = 'area';
      }
    }
  }
  for (const block of order) {
    let deducted = 0;
    for (const d of block.deductions) {
      envelope.push(d.row);
      deducted += d.row.grossArea;
      if (d.row.kind === 'window' && block.host.row.kind === 'wall' && block.host.row.boundary === 'outside') {
        facadeWindowArea += d.row.grossArea;
      }
    }
    const host = block.host.row;
    host.netArea = round(host.grossArea - deducted, 4);
    envelope.push(host);
    if (host.netArea < 0) {
      note('windows.exceedWall', 'block', { wall: host.label, wallArea: fmt(host.grossArea), openingArea: fmt(deducted) });
    }
  }
  for (const d of danglingManual) envelope.push(d.row);

  // ── 8. Zones (An, Vn) et volumes (Ve) ──
  const zones: ZoneRow[] = [];
  const volumes: VolumeRow[] = [];
  const netAreas: NetArea[] = [];
  for (const g of geometries) {
    const net = netAreaOf(g.storey, g.area);
    netAreas.push(net);
    const area = round(net.area);
    const clearHeight = Number.isFinite(g.storey.clearHeight.value) ? round(g.storey.clearHeight.value) : 0;
    zones.push({
      id: `zone:${g.storey.id}`,
      label: g.storey.name,
      area,
      clearHeight,
      airVolume: round(area * clearHeight, 4),
      from: weakest(net.from, g.storey.clearHeight.from),
      storeyId: g.storey.id,
    });

    // Sous une toiture inclinée, la hauteur d'étage saisie ne sert pas : hauteur équivalente = volume / surface.
    const underRoof = g === topGeometry && pitched !== null;
    const grossArea = round(g.area);
    const rawHeight = underRoof ? (g.area > 0 ? pitched.volume / g.area : 0) : g.storey.grossHeight.value;
    // Une hauteur non finie est signalée par « height.implausible » ; elle ne doit pas rendre Ve illisible.
    const height = Number.isFinite(rawHeight) ? round(rawHeight) : 0;
    volumes.push({
      id: `volume:${g.storey.id}`,
      label: g.storey.name,
      area: grossArea,
      height,
      volume: round(grossArea * height, 4),
      from: underRoof ? weakest(g.geometryFrom, model.top.from, ...roofDoubt) : weakest(g.geometryFrom, g.storey.grossHeight.from),
      storeyId: g.storey.id,
    });
  }

  // ── 9. Récapitulatifs par type ──
  const constructionsByKey = new Map<string, { construction: Construction; boundary: Boundary; area: number }>();
  for (const d of drafts) {
    if (!d.construction) continue;
    const key = `${d.construction.id}|${d.row.boundary}`;
    const entry = constructionsByKey.get(key) ?? { construction: d.construction, boundary: d.row.boundary, area: 0 };
    // Une porte (ligne déduite) compte pour sa propre surface ; une paroi pour sa surface nette.
    entry.area += d.row.deduct ? d.row.grossArea : d.row.netArea;
    constructionsByKey.set(key, entry);
  }
  const constructions: ConstructionSummary[] = [...constructionsByKey.values()]
    .sort(
      (a, b) =>
        constructionRank(a.construction) - constructionRank(b.construction) || BOUNDARY_ORDER[a.boundary] - BOUNDARY_ORDER[b.boundary],
    )
    .map((e) => {
      const summary: ConstructionSummary = {
        constructionId: e.construction.id,
        name: elementNameOf(e.construction, e.boundary),
        category: e.construction.category,
        boundary: e.boundary,
        area: round(e.area),
        u: e.construction.u ? { ...e.construction.u } : null,
      };
      if (groundSlab && e.boundary === 'ground' && e.construction.id === groundSlab.constructionId) {
        summary.ground = { slabArea: groundSlab.slabArea, perimeter: groundSlab.perimeter };
      }
      return summary;
    });

  const windowsByType = new Map<string, { type: WindowType; area: number; count: number; sizes: Map<string, { w: number; h: number; n: number }> }>();
  for (const row of envelope) {
    if (row.kind !== 'window' || row.windowTypeId === null) continue;
    const type = resolveWindowType(model, row.windowTypeId, lang);
    const entry = windowsByType.get(type.id) ?? { type, area: 0, count: 0, sizes: new Map() };
    entry.area += row.grossArea;
    entry.count += row.count;
    const sizeKey = `${row.length}x${row.width}`;
    const size = entry.sizes.get(sizeKey) ?? { w: row.length, h: row.width, n: 0 };
    size.n += row.count;
    entry.sizes.set(sizeKey, size);
    windowsByType.set(type.id, entry);
  }
  const windows: WindowSummary[] = [...windowsByType.values()].map((e) => {
    let typical = { w: 0, h: 0, n: 0 };
    for (const s of e.sizes.values()) if (s.n > typical.n) typical = s;
    return {
      windowTypeId: e.type.id,
      name: e.type.name,
      area: round(e.area),
      count: e.count,
      typicalWidth: typical.w,
      typicalHeight: typical.h,
      uw: e.type.uw ? { ...e.type.uw } : null,
      g: e.type.g ? { ...e.type.g } : null,
    };
  });

  // ── 10. Totaux ──
  const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
  const an = sum(zones.map((z) => z.area));
  const ve = sum(volumes.map((v) => v.volume));
  const envelopeArea = sum(envelope.filter((r) => !r.deduct).map((r) => r.grossArea));
  const grossFloorArea = sum(geometries.map((g) => g.area));
  const windowArea = sum(envelope.filter((r) => r.kind === 'window').map((r) => r.grossArea));
  const facadeArea = sum(envelope.filter((r) => r.kind === 'wall' && !r.deduct && r.boundary === 'outside').map((r) => r.grossArea));
  const totals: Totals = {
    an: round(an),
    vn: round(sum(zones.map((z) => z.airVolume))),
    ve: round(ve),
    envelopeArea: round(envelopeArea),
    aOverVe: ve > 0 ? round(envelopeArea / ve, 3) : 0,
    grossFloorArea: round(grossFloorArea),
    windowArea: round(windowArea),
    facadeArea: round(facadeArea),
    anFrom: weakest(...netAreas.map((n) => n.from)),
    veFrom: weakest(...volumes.map((v) => v.from)),
  };

  // ── 11. Contrôles de plausibilité ──
  if (geometries.length === 0) {
    note('model.noStorey', 'block');
  } else {
    if (isUnconfirmed(northFrom)) note('north.default', 'warn', { angle: fmt(north, 0) });
    if (isUnconfirmed(model.top.from)) note('top.default', 'warn', { kind: t(lang, `engine.top.${model.top.kind}`) });
    if (isUnconfirmed(model.bottom.from)) note('bottom.default', 'warn', { kind: t(lang, `engine.bottom.${model.bottom.kind}`) });
  }

  geometries.forEach((g, i) => {
    const where = { storey: g.storey.name, storeyId: g.storey.id };
    const s = g.storey;
    if (!g.usable || isSelfIntersecting(g.poly) || !(g.area >= MIN_OUTLINE_AREA)) {
      note('storey.outlineInvalid', 'block', { ...where, area: fmt(g.area) });
    }
    if (isUnconfirmed(s.metresPerUnit.from)) note('scale.unconfirmed', 'block', where);
    if (!isPitchedTop(g)) {
      const h = s.grossHeight.value;
      if (isUnconfirmed(s.grossHeight.from)) note('height.default', 'warn', { ...where, height: fmt(h) });
      // Écrit de façon à attraper aussi une hauteur non finie.
      if (!(h >= HEIGHT_RANGE.min && h <= HEIGHT_RANGE.max)) note('height.implausible', 'warn', { ...where, height: fmt(h) });
      if (s.clearHeight.value > h) {
        note('clearHeight.aboveGross', 'warn', { ...where, clear: fmt(s.clearHeight.value), gross: fmt(h) });
      }
    }
    // LuxEeB-Tool calcule Vn lui-même à partir de An : la hauteur libre n'est qu'une valeur de contrôle.
    if (isUnconfirmed(s.clearHeight.from)) note('clearHeight.default', 'info', { ...where, height: fmt(s.clearHeight.value) });
    if (netAreas[i]!.source === 'estimate') note('an.estimated', 'block', { ...where, area: fmt(netAreas[i]!.area) });
    // Local « non compté dans An » à l'intérieur du contour : A et Ve le comptent, An non. C'est juste pour un local
    // non conditionné situé DANS l'enveloppe (chaufferie, local technique), faux pour un local hors enveloppe.
    const inside = unheatedRoomsInsideOutline(s);
    const outsideByNature = inside.filter((r) => isOutsideEnvelopeName(r.name));
    const toCheck = inside.filter((r) => !isOutsideEnvelopeName(r.name));
    const names = (rooms: readonly Room[]): string => rooms.map((r) => `« ${r.name || '?'} »`).join(', ');
    if (outsideByNature.length > 0) {
      note('outline.containsUnheated', 'warn', { ...where, rooms: names(outsideByNature), count: outsideByNature.length });
    }
    if (toCheck.length > 0) note('outline.unconditionedInside', 'info', { ...where, rooms: names(toCheck), count: toCheck.length });
  });

  // Fenêtres de toit vues dans la maquette mais portées par aucune façade : elles manquent au relevé tant que
  // l'expert ne les a pas ajoutées en lignes manuelles « à déduire » devant le pan de toiture concerné.
  const manualDeductions = model.manualRows.filter((m) => m.deduct).reduce((n, m) => n + Math.max(1, Math.round(m.count)), 0);
  let roofWindowsSeen = 0;
  for (const g of geometries) {
    const seen = g.storey.roofWindows ?? [];
    if (seen.length === 0) continue;
    roofWindowsSeen += seen.length;
    const sizes = [...new Set(seen.map((w) => `${fmt(w.width)} × ${fmt(w.height)}`))].join(' ; ');
    note('opening.roofWindowsUnplaced', manualDeductions >= roofWindowsSeen ? 'info' : 'warn', {
      storey: g.storey.name,
      storeyId: g.storey.id,
      count: seen.length,
      sizes,
    });
  }

  const roomsToReview = sum(
    model.storeys.map((s) => (s.netAreaOverride ? 0 : s.rooms.filter((r) => r.needsReview).length)),
  );
  if (roomsToReview > 0) note('rooms.needReview', 'warn', { count: roomsToReview });

  if (grossFloorArea > 0) {
    const ratio = an / grossFloorArea;
    const params = { ratio: fmt(ratio * 100, 0), an: fmt(an), gross: fmt(grossFloorArea) };
    if (ratio > AN_RATIO_RANGE.max) note('an.grossLike', 'warn', params);
    else if (ratio < AN_RATIO_RANGE.min) note('an.low', 'warn', params);
  }

  for (const b of [...borderline.values()].sort((x, y) => x.azimuth - y.azimuth)) {
    const here = sectorOfAzimuth(b.azimuth);
    const before = sectorOfAzimuth(b.azimuth - BORDERLINE_MARGIN);
    const other = before !== here ? before : sectorOfAzimuth(b.azimuth + BORDERLINE_MARGIN);
    note('orientation.borderline', 'info', {
      length: fmt(b.length),
      azimuth: fmt(Math.round(b.azimuth) % 360, 0),
      orientation: orientationName(here),
      other: orientationName(other),
    });
  }

  if (heatedLength > 0) note('neighbours.heatedExcluded', 'info', { length: fmt(heatedLength) });

  if (geometries.some((g) => g.usable)) {
    if (windowArea <= 0) note('windows.none', 'warn');
    else if (facadeArea > 0) {
      const share = facadeWindowArea / facadeArea;
      if (share > WINDOW_SHARE_RANGE.max || share < WINDOW_SHARE_RANGE.min) {
        note('windows.share', 'warn', {
          share: fmt(share * 100, 0),
          windowArea: fmt(facadeWindowArea),
          facadeArea: fmt(facadeArea),
        });
      }
    }
  }

  if (ve > 0 && envelopeArea > 0) {
    const ratio = envelopeArea / ve;
    if (ratio < A_OVER_VE_RANGE.min || ratio > A_OVER_VE_RANGE.max) note('aOverVe.implausible', 'warn', { value: fmt(ratio) });
  }

  if (model.top.kind === 'pitched-roof' && topGeometry) {
    const where = { storey: topGeometry.storey.name, storeyId: topGeometry.storey.id };
    note('attic.heightRule', 'info', where);
    if (model.top.pitchDeg < PITCH_RANGE.min || model.top.pitchDeg > PITCH_RANGE.max) {
      note('roof.pitchImplausible', 'warn', { pitch: fmt(model.top.pitchDeg, 0) });
    }
    if (pitched) {
      if (pitched.nonRectangular) note('roof.estimated', 'warn', { ...where, area: fmt(pitched.totalArea) });
      const first = pitched.slopes[0];
      const second = pitched.slopes[1];
      if (pitched.ridgeAssumed && pitched.shape === 'mono' && first) {
        note('roof.monoDirection', 'warn', { orientation: orientationName(first.orientation) });
      } else if (pitched.ridgeAssumed && first && second) {
        const [a, b] = [first.orientation, second.orientation].sort((x, y) => ORIENTATIONS.indexOf(x) - ORIENTATIONS.indexOf(y));
        note('roof.ridgeAssumed', 'warn', { a: orientationName(a!), b: orientationName(b!) });
      }
    }
  }

  if (constructions.length > LUXEEB_OPAQUE_SLOTS) {
    note('constructions.overLimit', 'warn', { count: constructions.length, limit: LUXEEB_OPAQUE_SLOTS });
  }
  const withoutU = constructions.filter((c) => c.u === null).length + windows.filter((w) => w.uw === null).length;
  if (withoutU > 0) note('uvalues.missing', 'info', { count: withoutU });

  // Les plus graves d'abord (tri stable : l'ordre d'émission est conservé à gravité égale).
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return { envelope, zones, volumes, constructions, windows, totals, findings };
}

// ───────────────────────────── Lignes manuelles ─────────────────────────────

type DraftFactory = (
  p: Omit<EnvelopeRow, 'label' | 'elementName' | 'grossArea' | 'netArea' | 'constructionId' | 'windowTypeId'> & {
    construction: Construction | null;
    windowType: WindowType | null;
    label: (elementName: string) => string;
  },
) => Draft;

/**
 * Ligne saisie par l'expert → ligne d'enveloppe. Le genre vient du type choisi ; sans type, on le déduit :
 * à déduire → fenêtre du type par défaut ; verticale → mur ; horizontale → toiture, plancher haut ou dalle selon le milieu.
 */
function manualDraft(m: ManualRow, model: BuildingModel, lang: Lang, draft: DraftFactory): Draft {
  let kind: EnvelopeRow['kind'];
  let construction: Construction | null = null;
  let windowType: WindowType | null = null;
  const chosen = m.constructionId !== null ? model.constructions.find((c) => c.id === m.constructionId) : undefined;
  if (m.windowTypeId !== null || (!chosen && m.deduct)) {
    kind = 'window';
    windowType = resolveWindowType(model, m.windowTypeId, lang);
  } else if (chosen) {
    kind = chosen.category;
    construction = chosen;
  } else if (m.orientation !== 'H') {
    kind = 'wall';
    construction = resolveConstruction(model, null, defaultWallId(m.boundary), lang);
  } else if (m.boundary === 'outside') {
    kind = 'roof';
    construction = resolveConstruction(model, null, DEFAULT_CONSTRUCTION_IDS.roof, lang);
  } else if (m.boundary === 'unheated') {
    kind = 'ceiling';
    construction = resolveConstruction(model, null, DEFAULT_CONSTRUCTION_IDS.ceiling, lang);
  } else {
    kind = 'floor';
    construction = resolveConstruction(model, null, DEFAULT_CONSTRUCTION_IDS.floorGround, lang);
  }
  return draft({
    id: `manual:${m.id}`,
    kind,
    construction,
    windowType,
    count: Number.isFinite(m.count) ? m.count : 0,
    length: Number.isFinite(m.length) ? m.length : 0,
    width: Number.isFinite(m.width) ? m.width : 0,
    orientation: m.orientation,
    boundary: m.boundary,
    deduct: m.deduct,
    from: 'user',
    storeyId: null,
    manual: true,
    label: (element) => (m.label.trim() !== '' ? m.label : element),
  });
}

// ───────────────────────────── Ordre « expert » : préparation du modèle ─────────────────────────────

/**
 * Épaisseur (m) d'une composition lue : somme de TOUTES ses couches comptées (le lecteur ne compte pas le béton de
 * propreté ni les films sous le dernier isolant). null — donc repli sur la convention 'levels' — quand une couche
 * comptée qui a une résistance n'a pas d'épaisseur lisible : on ne raccourcit pas l'enveloppe en silence.
 */
export function compositionThickness(rc: ReadComposition | undefined): number | null {
  if (!rc) return null;
  const counted = rc.layers.filter((l) => l.counted);
  const unreadable = counted.some(
    (l) => (l.thicknessCm === null || !Number.isFinite(l.thicknessCm) || l.thicknessCm < 0) && MATERIAL_LIBRARY[l.material].family !== 'excluded',
  );
  if (unreadable) return null;
  const sum = counted.reduce((s, l) => s + (l.thicknessCm !== null && l.thicknessCm > 0 ? l.thicknessCm : 0), 0);
  return sum > 0 ? sum / 100 : null;
}

export interface EnvelopeHeights {
  /** Convention effectivement appliquée (repli 'levels' quand la coupe ne donne pas de quoi faire mieux). */
  convention: 'external' | 'levels';
  /** Hauteur brute par étage chauffé, du bas vers le haut (m). */
  heights: Sourced<number>[];
  /** Bas et haut de l'enveloppe (m, relatifs au ±0,00). */
  bottom: number;
  top: number;
}

/**
 * Hauteurs brutes des étages tirées des niveaux et des compositions lus sur la planche.
 *  - 'external' (cotes extérieures) : du dessous du dernier isolant du plancher bas jusqu'au dessus de la toiture
 *    (niveau fini du dernier étage + hauteur libre lue + épaisseur de la toiture) ; la limite entre deux étages est
 *    le DESSOUS du plancher qui les sépare (celui au-dessus d'un local non chauffé s'il y en a un, sinon le plancher
 *    d'étage) : un mur vers un garage s'arrête ainsi sous le plancher qui le couvre ;
 *  - 'levels' : de niveau fini à niveau fini, puis jusqu'au sommet coté (acrotère, faîtage).
 * Repli 'levels' quand une donnée de la convention extérieure manque ; null quand les niveaux ne suffisent pas.
 * Le choix de la convention est un réglage du bureau, jamais une question.
 */
export function envelopeHeights(
  levels: ReadLevels | null | undefined,
  compositions: readonly ReadComposition[],
  storeyCount: number,
  convention: 'external' | 'levels' = 'external',
): EnvelopeHeights | null {
  if (!levels || storeyCount < 1) return null;
  const floors = [...levels.floors].sort((a, b) => a.rel - b.rel).slice(0, storeyCount);
  if (floors.length < storeyCount) return null;
  const confidence = Math.min(...floors.map((f) => f.confidence), levels.top?.confidence ?? 1);
  const find = (element: ReadComposition['element']): ReadComposition | undefined => compositions.find((c) => c.element === element);
  const last = floors[floors.length - 1]!;

  const tryExternal = (): { bottom: number; splits: number[]; top: number } | null => {
    const ground = compositionThickness(find('floor-on-ground'));
    const roof = compositionThickness(find('roof'));
    const clear = levels.clearHeights.length > 0 ? levels.clearHeights[levels.clearHeights.length - 1]! : null;
    if (ground === null || roof === null || clear === null) return null;
    const between = compositionThickness(find('floor-to-unheated')) ?? compositionThickness(find('intermediate-floor'));
    if (floors.length > 1 && between === null) return null;
    const splits = floors.slice(1).map((f) => f.rel - (between ?? 0));
    return { bottom: floors[0]!.rel - ground, splits, top: last.rel + clear + roof };
  };
  const tryLevels = (): { bottom: number; splits: number[]; top: number } | null => {
    const top = levels.top?.rel ?? null;
    if (top === null || !(top > last.rel)) return null;
    return { bottom: floors[0]!.rel, splits: floors.slice(1).map((f) => f.rel), top };
  };

  let used: 'external' | 'levels' = convention;
  let z = convention === 'external' ? tryExternal() : tryLevels();
  if (!z && convention === 'external') {
    used = 'levels';
    z = tryLevels();
  }
  if (!z) return null;
  const bounds = [z.bottom, ...z.splits, z.top];
  const heights: Sourced<number>[] = [];
  for (let i = 0; i < storeyCount; i++) {
    const h = round(bounds[i + 1]! - bounds[i]!, 3);
    if (!(h > 0)) return null;
    heights.push({
      value: h,
      from: 'plan',
      confidence,
      note: used === 'external' ? 'Cotes extérieures : niveaux et compositions lus' : 'De niveau fini à niveau fini',
    });
  }
  return { convention: used, heights, bottom: z.bottom, top: z.top };
}

const SIDE_SHORT: Partial<Record<ElevationSide, 'front' | 'back' | 'left' | 'right' | 'side'>> = {
  front: 'front',
  back: 'back',
  left: 'left',
  right: 'right',
  side: 'side',
};
const SIDE_RANK: Record<ElevationSide, number> = { front: 0, back: 1, left: 2, right: 3, side: 4, north: 5, east: 6, south: 7, west: 8 };

/**
 * Façades dessinées → ordre et noms courts de l'expert. L'orientation vient du côté du plan auquel la façade
 * correspond (`planSideDeg`) et du nord lu ; une façade sans l'un des deux est laissée de côté (repli par
 * orientation dans le relevé). Ordre : avant, arrière, puis les autres comme la planche les donne.
 */
export function facadeViewsFromReading(reading: SheetReading | null | undefined, lang: Lang): FacadeView[] {
  if (!reading?.north) return [];
  const up = reading.north.sheetUpAzimuth;
  const out: { view: FacadeView; rank: number }[] = [];
  reading.elevations.forEach((e, k) => {
    if (!e.planSideDeg) return;
    const orientation = sectorOfAzimuth((((up + e.planSideDeg.value) % 360) + 360) % 360);
    if (out.some((o) => o.view.orientation === orientation)) return;
    const side = e.sides?.[0] ?? null;
    const named = side ? SIDE_SHORT[side] : undefined;
    const title = reading.views.find((v) => v.id === e.viewId)?.title ?? null;
    out.push({
      view: { orientation, short: t(lang, `engine.short.${named ?? orientation}`), title, viewId: e.viewId },
      rank: (side ? SIDE_RANK[side] : 9) * 100 + k,
    });
  });
  return out.sort((a, b) => a.rank - b.rank).map((o) => o.view);
}

/**
 * Un type de fenêtre par façade et par dimensions, nommé comme l'expert (« AV 94*125 X2 »), avec la géométrie de la
 * feuille des fenêtres et les valeurs d'usage étiquetées hypothèses (voir engine/materials). Seules les fenêtres
 * sans type choisi (type par défaut) sont concernées ; le modèle reçu n'est pas modifié.
 */
export function withExpertWindowTypes(model: BuildingModel, lang: Lang): BuildingModel {
  const north = Number.isFinite(model.northAngle.value) ? model.northAngle.value : 0;
  const isDefault = (id: string | null): boolean => id === null || id === DEFAULT_WINDOW_TYPE_ID || !model.windowTypes.some((w) => w.id === id);
  const short = (o: Orientation): string => model.facadeViews?.find((f) => f.orientation === o)?.short || t(lang, `engine.short.${o}`);
  const groups = new Map<string, { o: Orientation; w: number; h: number; n: number }>();
  const keyOf = new Map<string, string>(); // `${storeyId}:${openingId}` → clé de groupe
  for (const s of model.storeys) {
    const poly = scalePolygon(s.outline, s.metresPerUnit.value);
    for (const op of s.openings) {
      if (op.kind !== 'window' || !isDefault(op.windowTypeId) || !(op.width > 0) || !(op.height > 0)) continue;
      if (poly.length < 3 || !(op.edgeIndex < poly.length)) continue;
      const boundary = s.edges[op.edgeIndex]?.boundary ?? 'outside';
      if (boundary === 'heated') continue;
      const o = sectorOfAzimuth(edgeAzimuth(poly, op.edgeIndex, north));
      const w = Math.round(op.width * 100);
      const h = Math.round(op.height * 100);
      const key = `${o}|${w}|${h}`;
      const g = groups.get(key) ?? { o, w, h, n: 0 };
      g.n += op.count;
      groups.set(key, g);
      keyOf.set(`${s.id}:${op.id}`, key);
    }
  }
  if (groups.size === 0) return model;
  const typeId = (key: string): string => `window-${key.replace(/\|/g, '-')}`;
  const types = [...groups.entries()].map(([key, g]) =>
    windowTypeHypothesis(typeId(key), `${short(g.o)} ${g.w}*${g.h}${g.n > 1 ? ` X${g.n}` : ''}`, g.w / 100, g.h / 100, lang),
  );
  return {
    ...model,
    windowTypes: [...model.windowTypes.filter((w) => !types.some((n) => n.id === w.id)), ...types],
    storeys: model.storeys.map((s) => ({
      ...s,
      openings: s.openings.map((op) => {
        const key = keyOf.get(`${s.id}:${op.id}`);
        return key ? { ...op, windowTypeId: typeId(key) } : op;
      }),
    })),
  };
}
