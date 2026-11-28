/**
 * Ce qu'un lecteur de planches PARFAIT rendrait pour la planche synthétique A1 (« Maison Exemple », données
 * inventées) : lecture complète (SheetReading), feuilles de plan avec leur détection, et projet de départ. Des options
 * retirent des signaux pour simuler une lecture dégradée.
 */
import type { ReadElevation, ReadView, SheetReading, ViewKind } from '../../src/core/reading';
import { emptyReading } from '../../src/core/reading';
import type { DetectedEdge, DetectedOpening, DetectedRoom, PlanDocument, PlanSheet, PlanText, Project, Vec2 } from '../../src/core/types';
import { createEmptyProject, modelFromDocument } from '../../src/engine';
import { readCompositionOf, truthCompositions, type TruthComposition } from './planche-helpers';

const M_PER_PT = 0.0254 / 72; // 1 pt
type P = [number, number];

interface TruthRoom {
  name: string;
  area_true_m2: number;
  heated_true: boolean;
  kind: string;
  poly_pt: P[];
  area_label: string | null;
  label_pt: P | null;
}
interface TruthOpening {
  kind: 'window' | 'door' | string;
  a_pt: P;
  b_pt: P;
  width_m: number;
  height_m: number;
  sill_m: number | null;
  exterior: boolean;
  to_unheated: boolean;
}
interface TruthView {
  kind: string;
  title: string | null;
  level?: number | null;
  name?: string | null;
  bbox_pt?: [number, number, number, number];
  outline_pt?: P[];
  heated_outline_pt?: P[];
  rooms?: TruthRoom[];
  openings?: TruthOpening[];
  party_edges_pt?: [P, P][];
  unheated_edges_pt?: [P, P][];
  scale_den?: number;
}

export interface CaseOptions {
  /** Retirer les façades dessinées. */
  noElevations?: boolean;
  /** Retirer les coupes (et donc les hauteurs libres). */
  noSections?: boolean;
  /** Retirer le cartouche. */
  noTitleBlock?: boolean;
  /** Retirer les compositions. */
  noCompositions?: boolean;
  /**
   * Ne garder que les noms de pièces comme textes de feuille. Par défaut, 12 textes de cotes fictifs s'y ajoutent,
   * comme sur une vraie planche (des centaines de cotes) : le signal faible « aucune mention d'existant » ne joue
   * qu'à partir de 20 textes lus.
   */
  sparseTexts?: boolean;
}

export interface PlancheCase {
  reading: SheetReading;
  sheets: PlanSheet[];
  project: Project;
}

const v2 = (p: P): Vec2 => ({ x: p[0], y: p[1] });
const box = (b: [number, number, number, number] | undefined) => (b ? { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] } : { minX: 0, minY: 0, maxX: 1, maxY: 1 });
const near = (a: P, b: Vec2): boolean => Math.hypot(a[0] - b.x, a[1] - b.y) < 0.5;
const area = (label: string | null): number | undefined => {
  const m = label ? /([\d]+,[\d]+)/.exec(label) : null;
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

export function plancheA1(truth: Record<string, unknown>, options: CaseOptions = {}): PlancheCase {
  const page = (truth['pages'] as Record<string, unknown>[])[0]!;
  const views = page['views'] as TruthView[];
  const upAzimuth = truth['north_azimuth_deg'] as number;
  const facadeAz = truth['facade_azimuth_deg'] as Record<string, number>;
  const reading = emptyReading();

  // ── Vues ──
  let k = 0;
  reading.views = views
    .filter((v) => !(options.noElevations && v.kind === 'elevation') && !(options.noSections && v.kind === 'section') && !(options.noTitleBlock && v.kind === 'titleblock'))
    .map(
      (v): ReadView => ({
        id: `p1-${KIND[v.kind] ?? 'other'}${++k}`,
        page: 1,
        kind: KIND[v.kind] ?? 'other',
        title: v.title,
        titleBox: null,
        storeyRank: v.kind === 'plan' ? (v.level ?? null) : null,
        sides: v.kind === 'elevation' ? [v.name === 'rear' ? 'back' : v.name === 'side' ? 'left' : 'front'] : null,
        box: box(v.bbox_pt),
        buildingBox: null,
        sheetId: v.kind === 'plan' ? `sheet-${v.level}` : null,
        confidence: 0.9,
        sources: ['title'],
        doubts: [],
      }),
    );

  // ── Façades dessinées : côté du plan = azimut de la façade − azimut du haut de la feuille ──
  reading.elevations = reading.views
    .filter((v) => v.kind === 'elevation')
    .map((v): ReadElevation => {
      const side = v.sides![0]!;
      const az = facadeAz[side === 'back' ? 'rear' : side === 'left' ? 'side' : 'front']!;
      return {
        viewId: v.id,
        sides: [side],
        widthM: null,
        heightM: null,
        bays: [{ box: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, widthM: 1, heightM: 1, kind: 'window', parts: 1 }],
        planSideDeg: { value: (((az - upAzimuth) % 360) + 360) % 360, confidence: 0.8, evidence: [] },
      };
    });

  // ── Cartouche, niveaux, compositions, nord, équipements, toiture ──
  const tb = page['titleblock'] as Record<string, unknown>;
  if (!options.noTitleBlock) {
    const [postcode, ...locality] = String(tb['postcode_locality']).split(' ');
    reading.titleBlock = {
      project: String(tb['object']),
      phase: String(tb['phase']),
      buildingType: { value: 'EFH', confidence: 0.8, evidence: [{ source: 'title-block' }] },
      dwellings: { value: 1, confidence: 0.8, evidence: [{ source: 'title-block' }] },
      occasion: { value: 'new', confidence: 0.8, evidence: [{ source: 'title-block' }] },
      street: String(tb['street']),
      postcode: postcode ?? null,
      locality: locality.join(' ') || null,
      date: String(tb['date']),
      year: 2026,
      index: String(tb['index']),
      scaleDen: 100,
      format: 'A1',
      page: 1,
      box: null,
      confidence: 0.85,
    };
  }
  const storeys = page['storeys'] as { floor_m: number; storey_height_m: number; clear_height_m: number }[];
  const lv = page['levels'] as { value_m: number; what: string }[];
  const top = lv.find((l) => /acrot/.test(l.what));
  reading.levels = {
    referenceAbs: 312.25,
    floors: storeys.map((s) => ({ rel: s.floor_m, abs: null, label: 'NF', viewIds: [], confidence: 0.9 })),
    storeyHeights: storeys.slice(1).map((s, i) => s.floor_m - storeys[i]!.floor_m),
    top: top ? { rel: top.value_m, role: 'top', confidence: 0.9 } : null,
    eaves: null,
    clearHeights: options.noSections ? [] : storeys.map((s) => s.clear_height_m),
    marks: [],
    checks: { checked: 4, failed: 0 },
  };
  if (!options.noCompositions) reading.compositions = truthCompositions(truth).map((c: TruthComposition) => readCompositionOf(c));
  const sectors = [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5];
  reading.north = {
    sheetUpAzimuth: upAzimuth,
    marginDeg: Math.min(...sectors.map((s) => Math.abs(s - upAzimuth))),
    confidence: 0.85,
    evidence: [],
    page: 1,
    box: null,
  };
  reading.equipment = [
    { kind: 'heat-pump', raw: 'PAC', viewId: null, outside: true, page: 1, at: { x: 0, y: 0 } },
    { kind: 'hot-water-tank', raw: 'Boiler', viewId: null, outside: false, page: 1, at: { x: 0, y: 0 } },
    { kind: 'ventilation-unit', raw: 'VMC', viewId: null, outside: false, page: 1, at: { x: 0, y: 0 } },
  ];
  reading.systems = {
    heatGenerator: { value: 'heat-pump-air', confidence: 0.7, evidence: [{ source: 'equipment' }] },
    hotWater: { value: 'with-heating', confidence: 0.4, evidence: [{ source: 'equipment' }] },
    ventilation: { value: 'balanced-hr', confidence: 0.5, evidence: [{ source: 'equipment' }] },
    photovoltaic: null,
    solarThermal: null,
  };
  reading.roof = { sheetId: null, outline: null, widthM: 9.2, depthM: 12.4, areaM2: 114.08, flat: { value: true, confidence: 0.8, evidence: [] }, pitchDeg: null };

  // ── Feuilles de plan ──
  const sheets: PlanSheet[] = views
    .filter((v) => v.kind === 'plan')
    .map((v) => {
      const heated = (v.heated_outline_pt ?? []).map(v2);
      const edges: DetectedEdge[] = heated.map((a, i) => {
        const b = heated[(i + 1) % heated.length]!;
        const match = (segs: [P, P][] | undefined) => (segs ?? []).some(([p, q]) => (near(p, a) && near(q, b)) || (near(p, b) && near(q, a)));
        if (match(v.party_edges_pt)) return { boundary: 'heated', confidence: 0.85, sources: ['foreign-masonry', 'no-opening'] };
        if (match(v.unheated_edges_pt)) return { boundary: 'unheated', confidence: 0.85, sources: ['insulation', 'room-name'] };
        return { boundary: 'outside', confidence: 0.85, sources: ['insulation'] };
      });
      const rooms: DetectedRoom[] = [];
      const unlabelled: { area: number }[] = [];
      for (const r of v.rooms ?? []) {
        if (!r.area_label) {
          unlabelled.push({ area: r.area_true_m2 });
          continue;
        }
        const ext = /terrasse|balcon/i.test(r.name);
        const room: DetectedRoom = {
          name: r.name,
          statedArea: area(r.area_label),
          measuredArea: r.area_true_m2,
          polygon: r.poly_pt.map(v2),
          heatedGuess: r.heated_true ? 'yes' : 'no',
          confidence: 0.9,
        };
        if (r.label_pt) room.at = v2(r.label_pt);
        if (ext) room.exterior = true;
        rooms.push(room);
      }
      const garage = rooms.filter((r) => r.heatedGuess === 'no' && !r.exterior);
      const openings: DetectedOpening[] = (v.openings ?? []).map((o) => ({
        kind: o.kind === 'door' ? 'door' : 'window',
        a: v2(o.a_pt),
        b: v2(o.b_pt),
        width: o.width_m,
        height: o.height_m,
        sill: o.sill_m ?? undefined,
        exterior: o.exterior,
        toUnheated: o.to_unheated,
        heightFrom: 'plan-dim',
        confidence: 0.85,
      }));
      const texts: PlanText[] = rooms.map((r) => ({ text: r.name, x: r.at?.x ?? 0, y: r.at?.y ?? 0 }));
      if (!options.sparseTexts) for (let i = 0; i < 12; i++) texts.push({ text: `${(1 + i / 10).toFixed(2).replace('.', ',')}`, x: i, y: 0 });
      const st = storeys[v.level ?? 0]!;
      const sheet: PlanSheet = {
        id: `sheet-${v.level}`,
        name: v.title ?? `Niveau ${v.level}`,
        role: 'floor-plan',
        storeyRank: v.level ?? null,
        page: 1,
        bbox: box(v.bbox_pt),
        texts,
        metresPerUnit: { value: M_PER_PT * (v.scale_den ?? 100), from: 'plan', note: '1:100' },
        detected: {
          outline: (v.outline_pt ?? []).map(v2),
          heatedOutline: heated,
          heatedEdges: edges,
          unheatedZones: garage.map((g) => ({ polygon: g.polygon!, names: [g.name], area: g.measuredArea })),
          unlabelledAreas: unlabelled,
          footprintSize: { width: 9.2, depth: 12.4, confidence: 0.9 },
          outlineConfidence: 0.9,
          rooms,
          openings,
          storeyHeight: st.storey_height_m,
          clearHeight: st.clear_height_m,
          elevation: st.floor_m,
          notes: [],
        },
      };
      return sheet;
    });
  reading.openingPairs = sheets.flatMap((s) => s.detected.openings.map((o) => ({ width: o.width ?? 0, height: o.height ?? 0, sill: o.sill ?? null, viewId: null, page: 1, at: o.a })));

  const doc: PlanDocument = { fileName: 'planche_A1_archicad.pdf', kind: 'pdf', sheets, northAngle: { value: upAzimuth, from: 'plan' }, storeysAligned: false, warnings: [], reading };
  const base = createEmptyProject('fr');
  const model = modelFromDocument(doc, 'fr');
  model.top = { ...model.top, kind: 'flat-roof', from: 'plan' };
  model.bottom = { ...model.bottom, kind: 'slab-on-ground', from: 'plan' };
  return { reading, sheets, project: { ...base, model } };
}
