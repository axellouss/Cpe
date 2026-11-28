/**
 * Documents « lus » fabriqués à partir de la VÉRITÉ des quatre planches synthétiques (tests/fixtures/pdf/planche) :
 * ce qu'un lecteur de planches parfait rendrait (feuilles de plan avec contour chauffé, arêtes, pièces, baies, locaux
 * non chauffés, surfaces sans étiquette ; lecture avec vues, niveaux, compositions, cartouche, nord, toiture,
 * façades). Des options retirent des signaux pour simuler une lecture dégradée. Données inventées uniquement.
 *
 * Les lecteurs réels sont écrits par d'autres lots : ces documents testent le MOTEUR sur le contrat seul.
 */
import { emptyReading, type ElevationSide, type ReadElevation, type ReadView, type SheetReading, type ViewKind } from '../../src/core/reading';
import type { DetectedEdge, DetectedOpening, DetectedRoom, PlanDocument, PlanSheet, PlanText, Vec2 } from '../../src/core/types';
import { readCompositionOf, truthCompositions } from './planche-helpers';

export const PLANCHES = ['planche_A1_archicad', 'planche_A2_de_titres_dessus', 'planche_2pages', 'planche_sans_titres'] as const;
export type PlancheName = (typeof PLANCHES)[number];

const M_PER_PT = 0.0254 / 72;
type P = [number, number];

export interface TruthRoom {
  name: string;
  area_true_m2: number;
  heated_true: boolean;
  kind: string;
  poly_pt: P[];
  area_label: string | null;
  label_pt: P | null;
}
export interface TruthOpening {
  kind: string;
  side?: string;
  name?: string;
  a_pt: P;
  b_pt: P;
  width_m: number;
  height_m: number;
  sill_m: number | null;
  exterior: boolean;
  to_unheated: boolean;
  in_envelope: boolean;
  azimuth_deg?: number;
}
export interface TruthView {
  kind: string;
  title: string | null;
  level?: number | null;
  name?: string | null;
  azimuth_deg?: number;
  bbox_pt?: [number, number, number, number];
  building_bbox_pt?: [number, number, number, number];
  outline_pt?: P[];
  heated_outline_pt?: P[] | null;
  rooms?: TruthRoom[];
  openings?: TruthOpening[];
  party_edges_pt?: [P, P][];
  unheated_edges_pt?: [P, P][];
  scale_den?: number;
  roof?: { type?: string; ridge_m?: number; eaves_m?: number; pitch_deg?: number } | string;
}
export interface TruthStorey {
  level: number;
  floor_m: number;
  storey_height_m: number | null;
  clear_height_m?: number;
  heated?: boolean;
}
export interface TruthPage {
  number: number;
  views: TruthView[];
  levels?: { label: string; value_m: number; altitude_m?: number; what?: string }[];
  storeys?: TruthStorey[];
  titleblock?: Record<string, unknown>;
  equipment?: { text: string; level: number; where: string }[];
}
export interface Truth {
  file: string;
  scale_den: number;
  north_azimuth_deg: number;
  facade_azimuth_deg?: Record<string, number>;
  building: Record<string, unknown>;
  pages: TruthPage[];
}

export interface DocOptions {
  /** Le lecteur n'a pas su lire le contour chauffé : seule l'emprise est donnée. */
  noHeatedOutline?: boolean;
  /** Ni niveaux, ni hauteurs libres. */
  noLevels?: boolean;
  noCompositions?: boolean;
  noNorth?: boolean;
  noTitleBlock?: boolean;
  noElevations?: boolean;
  /** Pas de translation d'alignement des étages. */
  noAlignment?: boolean;
  /** Aucune vue de toiture ni coupe, toiture non lue. */
  noRoof?: boolean;
  /** Échelle seulement supposée par le lecteur. */
  guessedScale?: boolean;
}

const v2 = (p: P): Vec2 => ({ x: p[0], y: p[1] });
const box = (b: [number, number, number, number] | undefined) => (b ? { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] } : { minX: 0, minY: 0, maxX: 1, maxY: 1 });
/** Vrai si le point est sur le segment [p, q] (à 0,5 pt près). */
const onSegment = (pt: Vec2, [p, q]: [P, P]): boolean => {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((pt.x - p[0]) * dx + (pt.y - p[1]) * dy) / len2)) : 0;
  return Math.hypot(pt.x - (p[0] + t * dx), pt.y - (p[1] + t * dy)) < 0.5;
};
const statedOf = (label: string | null): number | undefined => {
  const m = label ? /(\d+,\d+)/.exec(label) : null;
  return m ? Number(m[1]!.replace(',', '.')) : undefined;
};

const KIND: Record<string, ViewKind> = {
  plan: 'floor-plan',
  'roof-plan': 'roof-plan',
  section: 'section',
  elevation: 'elevation',
  table: 'table',
  titleblock: 'title-block',
  photo: 'photo',
  north: 'north-arrow',
  notes: 'other',
};

const SIDE: Record<string, ElevationSide> = {
  front: 'front',
  rear: 'back',
  side: 'side',
  left: 'left',
  right: 'right',
  N: 'north',
  S: 'south',
  E: 'east',
  W: 'west',
};

/** Pièces dont le nom seul ne dit pas si elles sont chauffées (le lecteur répond « ask »). */
const AMBIGUOUS = /buanderie|cellier|technique|technik|debarras|débarras|vorraum/i;

export async function readPlancheTruth(name: PlancheName): Promise<Truth> {
  const fsModule = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: 'utf-8'): string };
  return JSON.parse(fs.readFileSync(new URL(`../fixtures/pdf/planche/${name}.truth.json`, import.meta.url), 'utf-8')) as Truth;
}

/** Vues de plan d'étage de la vérité, avec leur page. */
export function truthPlans(truth: Truth): { page: number; view: TruthView }[] {
  return truth.pages.flatMap((p) => p.views.filter((v) => v.kind === 'plan').map((view) => ({ page: p.number, view })));
}

export function truthStoreys(truth: Truth): TruthStorey[] {
  return truth.pages.flatMap((p) => p.storeys ?? []).sort((a, b) => a.level - b.level);
}

export const sheetIdOf = (page: number, level: number | null | undefined): string => `p${page}-plan-${level ?? 0}`;

/** Ce qu'un lecteur parfait rendrait pour cette planche. */
export function documentFromTruth(truth: Truth, options: DocOptions = {}): PlanDocument {
  const reading: SheetReading = emptyReading();
  const up = truth.north_azimuth_deg;

  // ── Vues ──
  const counters = new Map<string, number>();
  const viewOf = new Map<TruthView, ReadView>();
  for (const page of truth.pages) {
    for (const v of page.views) {
      const kind = KIND[v.kind] ?? 'other';
      if (options.noElevations && kind === 'elevation') continue;
      if (options.noRoof && (kind === 'roof-plan' || kind === 'section')) continue;
      if (options.noTitleBlock && kind === 'title-block') continue;
      if (options.noNorth && kind === 'north-arrow') continue;
      const key = `${page.number}-${kind}`;
      const k = (counters.get(key) ?? 0) + 1;
      counters.set(key, k);
      const rv: ReadView = {
        id: `p${page.number}-${kind}${k}`,
        page: page.number,
        kind,
        title: v.title,
        titleBox: null,
        storeyRank: kind === 'floor-plan' ? (v.level ?? null) : null,
        sides: kind === 'elevation' && v.name ? [SIDE[v.name] ?? 'side'] : null,
        box: box(v.bbox_pt),
        buildingBox: v.building_bbox_pt ? box(v.building_bbox_pt) : null,
        sheetId: kind === 'floor-plan' ? sheetIdOf(page.number, v.level) : null,
        confidence: v.title ? 0.9 : 0.7,
        sources: v.title ? ['title'] : ['content-rooms'],
        doubts: [],
      };
      reading.views.push(rv);
      viewOf.set(v, rv);
    }
  }

  // ── Façades dessinées : côté du plan = azimut de la façade − azimut du haut de la feuille ──
  if (!options.noElevations) {
    for (const page of truth.pages) {
      for (const v of page.views) {
        const rv = viewOf.get(v);
        if (!rv || rv.kind !== 'elevation' || v.azimuth_deg === undefined) continue;
        const e: ReadElevation = {
          viewId: rv.id,
          sides: rv.sides,
          widthM: null,
          heightM: null,
          bays: (v.openings ?? []).map(() => ({ box: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, widthM: 1, heightM: 1, kind: 'window' as const, parts: 1 })),
          planSideDeg: { value: (((v.azimuth_deg - up) % 360) + 360) % 360, confidence: 0.8, evidence: [{ source: 'elevation-title' }] },
        };
        reading.elevations.push(e);
      }
    }
  }

  // ── Cartouche ──
  const tbPage = truth.pages.find((p) => p.titleblock);
  const tb = tbPage?.titleblock;
  if (tb && !options.noTitleBlock) {
    const object = String(tb['object'] ?? '');
    const [postcode, ...locality] = String(tb['postcode_locality'] ?? '').split(' ');
    const date = String(tb['date'] ?? '');
    const year = /(\d{4})$/.exec(date);
    const single = /unifamiliale|einfamilienhaus/i.test(object);
    reading.titleBlock = {
      project: String(tb['project_name'] ?? object),
      phase: String(tb['phase'] ?? ''),
      buildingType: single ? { value: 'EFH', confidence: 0.8, evidence: [{ source: 'title-block' }] } : null,
      dwellings: single ? { value: 1, confidence: 0.8, evidence: [{ source: 'title-block' }] } : null,
      occasion: /construction|neubau/i.test(object) ? { value: 'new', confidence: 0.8, evidence: [{ source: 'title-block' }] } : null,
      street: tb['street'] ? String(tb['street']) : null,
      postcode: postcode || null,
      locality: locality.join(' ') || null,
      date,
      year: year ? Number(year[1]) : null,
      index: String(tb['index'] ?? ''),
      scaleDen: truth.scale_den,
      format: String(tb['format'] ?? ''),
      page: tbPage!.number,
      box: null,
      confidence: 0.85,
    };
  }

  // ── Niveaux ──
  const storeys = truthStoreys(truth);
  const marks = truth.pages.flatMap((p) => p.levels ?? []);
  if (!options.noLevels && storeys.length > 0) {
    const floorValues = new Set(storeys.map((s) => s.floor_m));
    const ridge = marks.find((m) => /first|faîtage|faitage/i.test(m.what ?? m.label));
    const eaves = marks.find((m) => /traufe|égout|egout/i.test(m.what ?? m.label));
    const highest = marks.filter((m) => !floorValues.has(m.value_m)).sort((a, b) => b.value_m - a.value_m)[0];
    const flatTop = !ridge && highest && highest.value_m > Math.max(...floorValues) ? highest : null;
    reading.levels = {
      referenceAbs: marks.find((m) => m.value_m === 0)?.altitude_m ?? null,
      floors: storeys.map((s) => {
        const plan = truthPlans(truth).find((p) => p.view.level === s.level);
        const rv = plan ? viewOf.get(plan.view) : undefined;
        return { rel: s.floor_m, abs: null, label: 'NF', viewIds: rv ? [rv.id] : [], confidence: 0.9 };
      }),
      storeyHeights: storeys.slice(1).map((s, i) => s.floor_m - storeys[i]!.floor_m),
      top: ridge ? { rel: ridge.value_m, role: 'ridge', confidence: 0.9 } : flatTop ? { rel: flatTop.value_m, role: 'top', confidence: 0.9 } : null,
      eaves: eaves ? eaves.value_m : null,
      clearHeights: storeys.filter((s) => s.clear_height_m !== undefined).map((s) => s.clear_height_m!),
      marks: [],
      checks: { checked: 2, failed: 0 },
    };
  }

  if (!options.noCompositions) reading.compositions = truthCompositions(truth as unknown as Record<string, unknown>).map((c) => readCompositionOf(c));

  if (!options.noNorth) {
    const sectors = [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5];
    reading.north = {
      sheetUpAzimuth: up,
      marginDeg: Math.min(...sectors.map((s) => Math.min(Math.abs(s - up), 360 - Math.abs(s - up)))),
      confidence: 0.85,
      evidence: [{ source: 'north-arrow' }],
      page: 1,
      box: null,
    };
  }

  // ── Toiture ──
  const roofType = typeof truth.building['roof'] === 'string' ? (truth.building['roof'] as string) : null;
  const sectionRoof = truth.pages.flatMap((p) => p.views).map((v) => (typeof v.roof === 'object' ? v.roof : null)).find((r) => r && r.type);
  if (!options.noRoof && (roofType || sectionRoof)) {
    const flat = roofType === 'flat';
    reading.roof = {
      sheetId: null,
      outline: null,
      widthM: null,
      depthM: null,
      areaM2: null,
      flat: { value: flat, confidence: 0.8, evidence: [{ source: flat ? 'parapet' : 'ridge' }] },
      pitchDeg: !flat && sectionRoof?.pitch_deg ? { value: sectionRoof.pitch_deg, confidence: 0.8, evidence: [{ source: 'section' }] } : null,
    };
  }

  // ── Équipements ──
  const equipment = truth.pages.flatMap((p) => p.equipment ?? []);
  for (const e of equipment) {
    const kind = /pac/i.test(e.text) ? 'heat-pump' : /boiler/i.test(e.text) ? 'hot-water-tank' : /vmc/i.test(e.text) ? 'ventilation-unit' : 'other';
    reading.equipment.push({ kind, raw: e.text, viewId: null, outside: /extérieur/i.test(e.where), page: 1, at: { x: 0, y: 0 } });
  }
  if (equipment.length > 0) {
    const has = (k: string) => reading.equipment.some((e) => e.kind === k);
    reading.systems = {
      heatGenerator: has('heat-pump') ? { value: 'heat-pump-air', confidence: 0.7, evidence: [{ source: 'equipment' }] } : null,
      hotWater: has('hot-water-tank') ? { value: 'with-heating', confidence: 0.4, evidence: [{ source: 'equipment' }] } : null,
      ventilation: has('ventilation-unit') ? { value: 'balanced-hr', confidence: 0.5, evidence: [{ source: 'equipment' }] } : null,
      photovoltaic: null,
      solarThermal: null,
    };
  }

  // ── Feuilles de plan ──
  const sheets: PlanSheet[] = [];
  for (const { page, view: v } of truthPlans(truth)) {
    const id = sheetIdOf(page, v.level);
    const heatedTruth = !options.noHeatedOutline && v.heated_outline_pt && v.heated_outline_pt.length >= 3 ? v.heated_outline_pt.map(v2) : null;
    const edges: DetectedEdge[] | undefined = heatedTruth?.map((a, i) => {
      const b = heatedTruth[(i + 1) % heatedTruth.length]!;
      // Une arête mitoyenne ou vers le non chauffé peut n'être qu'une PARTIE du côté de la vérité.
      const match = (segs: [P, P][] | undefined) => (segs ?? []).some((seg) => onSegment(a, seg) && onSegment(b, seg));
      if (match(v.party_edges_pt)) return { boundary: 'heated', confidence: 0.85, sources: ['foreign-masonry', 'no-opening'] };
      if (match(v.unheated_edges_pt)) return { boundary: 'unheated', confidence: 0.85, sources: ['insulation', 'room-name'] };
      return { boundary: 'outside', confidence: 0.85, sources: ['insulation'] };
    });
    const rooms: DetectedRoom[] = [];
    const unlabelled: { polygon: Vec2[]; area: number }[] = [];
    const zones: { polygon: Vec2[]; names: string[]; area?: number }[] = [];
    for (const r of v.rooms ?? []) {
      if (!r.area_label) {
        // Escalier sans étiquette : une surface du volume chauffé qu'aucune pièce ne couvre (seulement si chauffé).
        if (r.heated_true && heatedTruth) unlabelled.push({ polygon: r.poly_pt.map(v2), area: r.area_true_m2 });
        continue;
      }
      const exterior = r.kind === 'exterior';
      const room: DetectedRoom = {
        name: r.name,
        statedArea: statedOf(r.area_label),
        measuredArea: r.area_true_m2,
        polygon: r.poly_pt.map(v2),
        heatedGuess: exterior ? 'no' : AMBIGUOUS.test(r.name) ? 'ask' : r.heated_true ? 'yes' : 'no',
        confidence: 0.9,
      };
      if (r.label_pt) room.at = v2(r.label_pt);
      if (exterior) room.exterior = true;
      rooms.push(room);
      if (!r.heated_true && !exterior && heatedTruth) zones.push({ polygon: room.polygon!, names: [r.name], area: room.statedArea });
    }
    const openings: DetectedOpening[] = (v.openings ?? []).map((o) => {
      const d: DetectedOpening = {
        kind: o.kind === 'door' ? 'door' : 'window',
        a: v2(o.a_pt),
        b: v2(o.b_pt),
        width: o.width_m,
        height: o.height_m,
        exterior: o.exterior,
        toUnheated: o.to_unheated,
        heightFrom: 'plan-dim',
        confidence: 0.85,
      };
      if (o.sill_m !== null && o.sill_m !== undefined) d.sill = o.sill_m;
      if (o.to_unheated) d.detail = 'door-to-unheated';
      else if (o.exterior && o.kind === 'door' && /garage/i.test(o.name ?? '')) d.detail = 'garage-door';
      else if (o.exterior && o.kind === 'door') d.detail = 'entrance-door';
      return d;
    });
    const texts: PlanText[] = rooms.map((r) => ({ text: r.name, x: r.at?.x ?? 0, y: r.at?.y ?? 0 }));
    for (let i = 0; i < 24; i++) texts.push({ text: `${(1 + i / 10).toFixed(2).replace('.', ',')}`, x: i, y: 0 });
    const bb = v.building_bbox_pt ?? v.bbox_pt;
    const den = v.scale_den ?? truth.scale_den;
    const sheet: PlanSheet = {
      id,
      name: v.title ?? `Vue ${page}-${v.level}`,
      role: 'floor-plan',
      storeyRank: v.level ?? null,
      page,
      bbox: box(v.bbox_pt),
      texts,
      metresPerUnit: options.guessedScale ? { value: M_PER_PT * den, from: 'estimate' } : { value: M_PER_PT * den, from: 'plan', note: `1:${den}` },
      detected: {
        outline: (v.outline_pt ?? []).map(v2),
        unheatedZones: zones,
        unlabelledAreas: unlabelled,
        footprintSize: bb ? { width: (bb[2] - bb[0]) * M_PER_PT * den, depth: (bb[3] - bb[1]) * M_PER_PT * den, confidence: 0.9 } : undefined,
        outlineConfidence: 0.9,
        rooms,
        openings,
        notes: [],
      },
    };
    if (heatedTruth) {
      sheet.detected.heatedOutline = heatedTruth;
      sheet.detected.heatedEdges = edges!;
    }
    sheets.push(sheet);
    if (!options.noAlignment && bb) reading.alignment.push({ sheetId: id, dx: -bb[0], dy: -bb[1], confidence: 0.9 });
  }
  // Une façade lue comme feuille : jamais un étage, même si elle a un contour.
  const elevation = truth.pages.flatMap((p) => p.views.map((v) => ({ page: p.number, v }))).find((x) => x.v.kind === 'elevation');
  if (elevation) {
    const b = box(elevation.v.bbox_pt);
    sheets.push({
      id: `p${elevation.page}-elevation-sheet`,
      name: elevation.v.title ?? 'Façade',
      role: 'elevation',
      page: elevation.page,
      bbox: b,
      metresPerUnit: { value: M_PER_PT * truth.scale_den, from: 'plan' },
      detected: {
        outline: [
          { x: b.minX, y: b.minY },
          { x: b.maxX, y: b.minY },
          { x: b.maxX, y: b.maxY },
          { x: b.minX, y: b.maxY },
        ],
        rooms: [],
        openings: [],
        notes: [],
      },
    });
  }
  reading.openingPairs = sheets.flatMap((s) =>
    s.detected.openings.filter((o) => o.exterior).map((o) => ({ width: o.width ?? 0, height: o.height ?? 0, sill: o.sill ?? null, viewId: null, page: s.page ?? 1, at: o.a })),
  );
  const doc: PlanDocument = { fileName: truth.file, kind: 'pdf', sheets, storeysAligned: false, warnings: [], reading };
  if (reading.north) doc.northAngle = { value: up, from: 'plan' };
  return doc;
}
