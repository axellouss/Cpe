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
  type Severity,
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
import { differenceArea } from './polygonOps';
import { isUnconfirmed, weakest } from './provenance';
import { computePitchedRoof, isEavesEdge, type PitchedRoof, type RoofSlope } from './roof';
import { netAreaOf, type NetArea } from './storey';

// ───────────────────────────── Seuils de plausibilité (propres à l'outil, non réglementaires) ─────────────────────────────

const MIN_OUTLINE_AREA = 4; // m²
const HEIGHT_RANGE = { min: 2.2, max: 4.5 }; // m
const AN_RATIO_RANGE = { min: 0.55, max: 0.92 }; // An / surface brute de plancher
const WINDOW_SHARE_RANGE = { min: 0.05, max: 0.45 }; // fenêtres / façades extérieures
const A_OVER_VE_RANGE = { min: 0.25, max: 1.3 }; // 1/m
const PITCH_RANGE = { min: 3, max: 75 }; // degrés
const BORDERLINE_MARGIN = 5; // degrés autour d'une limite de secteur
const STEP_MIN_AREA = 0.5; // m² : en dessous, un décalage entre étages est du bruit de tracé
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
  const north = model.northAngle.value;
  const northFrom = model.northAngle.from;
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
    const poly = scalePolygon(storey.outline, s);
    return {
      storey,
      poly,
      area: polygonArea(poly),
      usable: poly.length >= 3,
      geometryFrom: weakest('plan', storey.metresPerUnit.from),
    };
  });
  const topGeometry = geometries[geometries.length - 1];
  const bottomGeometry = geometries[0];
  const pitched: PitchedRoof | null =
    model.top.kind === 'pitched-roof' && topGeometry && topGeometry.usable && topGeometry.area > 0
      ? computePitchedRoof(topGeometry.poly, model.top, north)
      : null;
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
    drafts.push(d);
    return d;
  };

  /** Lignes « Abzug » d'une paroi, dans l'ordre de première apparition. */
  const openingDrafts = (host: OpeningHost, hostId: string, orientation: Orientation, boundary: Boundary): Draft[] =>
    [...host.openings.entries()].map(([key, o]) => {
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
          t(lang, `engine.row.${o.kind}`, {
            width: fmt(width),
            height: fmt(height),
            orientation: orientationName(orientation),
            storeys: storeyNames(o.storeys),
          }),
      });
    });

  // ── 1. Murs et ouvertures ──
  const walls = new Map<string, WallGroup>();
  const slopeHosts: SlopeHost[] = (pitched?.slopes ?? []).map((slope) => ({ slope, openings: new Map() }));
  const borderline = new Map<number, { azimuth: number; length: number }>();
  let heatedLength = 0;

  const addOpening = (host: OpeningHost, o: Opening, g: StoreyGeometry): void => {
    const widthCm = Math.round(o.width * 100);
    const heightCm = Math.round(o.height * 100);
    const windowType = o.kind === 'window' ? resolveWindowType(model, o.windowTypeId, lang) : null;
    const construction = o.kind === 'door' ? resolveConstruction(model, null, DEFAULT_CONSTRUCTION_IDS.door, lang) : null;
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
        sources.push(model.top.from);
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

      const construction = resolveConstruction(model, edge?.constructionId ?? null, defaultWallId(boundary), lang);
      const key = `${construction.id}|${boundary}|${orientation}|${heightCm}`;
      let group = walls.get(key);
      if (!group) {
        group = { key, construction, boundary, orientation, heightCm, length: 0, sources: [], storeys: [], openings: new Map() };
        walls.set(key, group);
      }
      group.length += length;
      group.sources.push(...sources);
      pushUnique(group.storeys, g.storey);
      hostOfEdge.push(group);
    }

    const onHeated: Opening[] = [];
    const orphans: Opening[] = [];
    const inRoof: Opening[] = [];
    for (const o of activeOpenings) {
      const host = Number.isInteger(o.edgeIndex) ? hostOfEdge[o.edgeIndex] : undefined;
      if (host === undefined || host === null) orphans.push(o);
      else if (host === 'heated') onHeated.push(o);
      else {
        if ('slope' in host) inRoof.push(o);
        addOpening(host, o, g);
      }
    }
    const where = { storey: g.storey.name, storeyId: g.storey.id };
    if (onHeated.length > 0) note('opening.onHeatedWall', 'warn', { ...where, count: countOf(onHeated) });
    if (orphans.length > 0) note('opening.orphan', 'warn', { ...where, count: countOf(orphans) });
    if (inRoof.length > 0) note('opening.inRoof', 'info', { ...where, count: countOf(inRoof) });
  }

  const constructionRank = (c: Construction): number => {
    const i = model.constructions.findIndex((x) => x.id === c.id);
    return i < 0 ? model.constructions.length : i;
  };
  const wallBlocks: Block[] = [...walls.values()]
    .sort(
      (a, b) =>
        ORIENTATIONS.indexOf(a.orientation) - ORIENTATIONS.indexOf(b.orientation) ||
        BOUNDARY_ORDER[a.boundary] - BOUNDARY_ORDER[b.boundary] ||
        constructionRank(a.construction) - constructionRank(b.construction) ||
        b.heightCm - a.heightCm,
    )
    .map((w) => {
      const id = `wall:${w.key}`;
      const deductions = openingDrafts(w, id, w.orientation, w.boundary);
      const host = draft({
        id,
        kind: 'wall',
        construction: w.construction,
        windowType: null,
        count: 1,
        length: w.length,
        width: w.heightCm / 100,
        orientation: w.orientation,
        boundary: w.boundary,
        deduct: false,
        from: weakest(...w.sources),
        storeyId: storeyIdOf(w.storeys),
        manual: false,
        label: (element) =>
          t(lang, 'engine.row.wall', {
            element,
            orientation: orientationName(w.orientation),
            storeys: storeyNames(w.storeys),
          }),
      });
      return { host, deductions };
    });

  // ── 2. Fermeture haute du dernier étage ──
  /** Longueur × largeur équivalentes d'une surface horizontale : étendue le long du plus grand côté, puis surface / longueur. */
  const horizontalDims = (poly: readonly Vec2[], area: number): { length: number; width: number } => {
    const length = extentAlong(poly, longestEdgeAngle(poly)).along;
    return length > 0 ? { length, width: area / length } : { length: 0, width: 0 };
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
      const from = weakest(g.geometryFrom, top.from, northFrom, ...(pitched.shape === 'mono' ? (['estimate'] as const) : []));
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
      groundSlab = { constructionId: construction.id, slabArea: round(g.area), perimeter: round(perimeter) };
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
    if (model.storeysAligned) {
      const e = differenceArea(lower.poly, upper.poly);
      const o = differenceArea(upper.poly, lower.poly);
      if (e !== null && o !== null) {
        exposed = e;
        overhang = o;
        exact = true;
      }
    }
    const from = weakest(lower.geometryFrom, upper.geometryFrom);
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
        from,
        storeyId: upper.storey.id,
        manual: false,
        label: () => t(lang, 'engine.row.floorOverhang', { storey: upper.storey.name }),
      });
      floorBlocks.push({ host, deductions: [] });
    }
    if (!exact && (exposed > STEP_MIN_AREA || overhang > STEP_MIN_AREA)) {
      note('stepback.byAreas', 'info', {
        lower: lower.storey.name,
        upper: upper.storey.name,
        area: fmt(Math.max(exposed, overhang)),
      });
    }
  }

  // ── 5. Lignes manuelles de l'expert (même règle « Abzug » entre elles) ──
  const manualBlocks: Block[] = [];
  let pendingManual: Draft[] = [];
  let manualHeated = 0;
  for (const m of model.manualRows) {
    if (m.boundary === 'heated') {
      manualHeated++;
      continue;
    }
    const d = manualDraft(m, model, lang, draft);
    if (m.deduct) pendingManual.push(d);
    else {
      manualBlocks.push({ host: d, deductions: pendingManual });
      pendingManual = [];
    }
  }
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
  for (const block of [...wallBlocks, ...roofBlocks, ...ceilingBlocks, ...floorBlocks, ...manualBlocks]) {
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
    const clearHeight = round(g.storey.clearHeight.value);
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
    const height = round(underRoof ? (g.area > 0 ? pitched.volume / g.area : 0) : g.storey.grossHeight.value);
    volumes.push({
      id: `volume:${g.storey.id}`,
      label: g.storey.name,
      area: grossArea,
      height,
      volume: round(grossArea * height, 4),
      from: underRoof ? weakest(g.geometryFrom, model.top.from) : weakest(g.geometryFrom, g.storey.grossHeight.from),
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
    if (!g.usable || isSelfIntersecting(g.poly) || g.area < MIN_OUTLINE_AREA) {
      note('storey.outlineInvalid', 'block', { ...where, area: fmt(g.area) });
    }
    if (isUnconfirmed(s.metresPerUnit.from)) note('scale.unconfirmed', 'block', where);
    if (!isPitchedTop(g)) {
      const h = s.grossHeight.value;
      if (isUnconfirmed(s.grossHeight.from)) note('height.default', 'warn', { ...where, height: fmt(h) });
      if (h < HEIGHT_RANGE.min || h > HEIGHT_RANGE.max) note('height.implausible', 'warn', { ...where, height: fmt(h) });
      if (s.clearHeight.value > h) {
        note('clearHeight.aboveGross', 'block', { ...where, clear: fmt(s.clearHeight.value), gross: fmt(h) });
      }
    }
    if (isUnconfirmed(s.clearHeight.from)) note('clearHeight.default', 'warn', { ...where, height: fmt(s.clearHeight.value) });
    if (netAreas[i]!.source === 'estimate') note('an.estimated', 'block', { ...where, area: fmt(netAreas[i]!.area) });
  });

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
      if (pitched.nonRectangular) note('roof.estimated', 'info', { ...where, area: fmt(pitched.totalArea) });
      const first = pitched.slopes[0];
      if (pitched.shape === 'mono' && first) note('roof.monoDirection', 'warn', { orientation: orientationName(first.orientation) });
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
