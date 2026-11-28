/**
 * Géométrie de planche (src/readers/pdf/geometry) sur les quatre planches SYNTHÉTIQUES de tests/fixtures/pdf/planche
 * (données inventées), face à leur vérité *.truth.json :
 *  - pièces : polygone et surface (≤ 1 %), échelle retrouvée par les surfaces ;
 *  - emprise et contour chauffé (aire ≤ 2 %), arêtes mitoyennes et vers le non chauffé (longueur ≤ 5 %) ;
 *  - baies des murs extérieurs par côté (nombre exact, largeur ≤ 3 cm, hauteur quand la paire est écrite), porte
 *    d'entrée, porte de garage, porte entre logement et garage ;
 *  - toiture, façades (baies, côté du plan), calage des plans, plancher au-dessus du non chauffé ;
 *  - variante allemande sans remplissage de pièces (repli : ce qui baisse est vérifié), planche en L, deux pages.
 *
 * Les vues (ReadView) et les paires « largeur / hauteur » (ReadOpeningPair) sont tirées de la vérité : leur lecture
 * appartient à d'autres lots (découpage en vues, lecture des textes).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ElevationSide, ReadOpeningPair, ReadView, ViewKind } from '../../../../src/core/reading';
import type { DetectedOpening, Vec2 } from '../../../../src/core/types';
import { extractPage } from '../../../../src/readers/pdf/extract';
import {
  analyseFloorPlan,
  applyOpeningUpdates,
  readBuildingGeometry,
  type BuildingGeometry,
  type FloorPlanEntry,
  type FloorPlanGeometry,
} from '../../../../src/readers/pdf/geometry';
import { createPdfEngine } from '../../../../src/readers/pdf/init-node';
import { ringArea } from '../../../../src/readers/pdf/planar';
import { METRES_PER_POINT, type RawPage } from '../../../../src/readers/pdf/raw';
import { fixtureBytes } from '../helpers';

// ───────────────────────────── Vérité ─────────────────────────────

type P = [number, number];
interface TOpening {
  kind: 'window' | 'door';
  side: string;
  a_pt: P;
  b_pt: P;
  width_m: number;
  height_m: number;
  sill_m: number | null;
  exterior: boolean;
  to_unheated: boolean;
  in_envelope: boolean;
  name?: string;
}
interface TRoom {
  name: string;
  area_true_m2: number;
  area_label: string | null;
  heated_true: boolean;
  poly_pt: P[];
}
interface TView {
  kind: string;
  title: string | null;
  name?: string;
  level?: number | null;
  bbox_pt: [number, number, number, number];
  building_bbox_pt?: [number, number, number, number];
  outline_area_m2?: number;
  heated_outline_area_m2?: number;
  party_wall_length_m?: number;
  wall_to_unheated_length_m?: number;
  rooms?: TRoom[];
  openings?: (TOpening & { rect_pt?: number[] })[];
  dims?: { chain?: string; width_text?: string }[];
  roof?: string;
  scale_den?: number;
}
interface TTruth {
  scale_den: number;
  north_azimuth_deg?: number;
  pages: { views: TView[] }[];
}

const KIND: Record<string, ViewKind> = { plan: 'floor-plan', 'roof-plan': 'roof-plan', elevation: 'elevation', section: 'section' };
const SIDE: Record<string, ElevationSide> = { front: 'front', rear: 'back', side: 'side', N: 'north', S: 'south', E: 'east', W: 'west' };
/** Normale extérieure d'un côté du plan (repère de la feuille, y vers le bas). */
const OUT: Record<string, P> = { rear: [0, -1], front: [0, 1], left: [-1, 0], right: [1, 0] };
/** Côté du plan → azimut sur la feuille (0 = haut, sens horaire). */
const SIDE_DEG: Record<string, number> = { rear: 0, right: 90, front: 180, left: 270 };

interface Fixture {
  name: string;
  truth: TTruth;
  pages: RawPage[];
  views: (ReadView & { truth: TView })[];
  pairs: ReadOpeningPair[];
  plans: { view: ReadView & { truth: TView }; g: FloorPlanGeometry }[];
  building: BuildingGeometry;
}

const engine = createPdfEngine();

async function extractAll(file: string): Promise<RawPage[]> {
  const opened = await engine.open(new Uint8Array(fixtureBytes(file)));
  try {
    const out: RawPage[] = [];
    for (let n = 1; n <= opened.doc.numPages; n++) out.push(await extractPage(await opened.doc.getPage(n), engine.ops, {}));
    return out;
  } finally {
    await opened.close();
  }
}

function truthOf(file: string): TTruth {
  return JSON.parse(new TextDecoder('utf-8').decode(fixtureBytes(file.replace(/\.pdf$/, '.truth.json')))) as TTruth;
}

/** Vues du contrat et paires « largeur / hauteur » écrites, tirées de la vérité. */
function viewsAndPairs(truth: TTruth): { views: Fixture['views']; pairs: ReadOpeningPair[] } {
  const views: Fixture['views'] = [];
  const pairs: ReadOpeningPair[] = [];
  truth.pages.forEach((p, pi) => {
    const counts: Record<string, number> = {};
    for (const tv of p.views) {
      const kind = KIND[tv.kind];
      if (!kind) continue;
      const k = (counts[kind] = (counts[kind] ?? 0) + 1);
      const id = `p${pi + 1}-${kind}${k}`;
      const b = tv.bbox_pt;
      const bb = tv.building_bbox_pt;
      views.push({
        id,
        page: pi + 1,
        kind,
        title: tv.title,
        titleBox: null,
        storeyRank: kind === 'floor-plan' ? (tv.level ?? null) : null,
        sides: kind === 'elevation' && tv.name ? [SIDE[tv.name] ?? 'side'] : null,
        box: { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] },
        buildingBox: bb ? { minX: bb[0], minY: bb[1], maxX: bb[2], maxY: bb[3] } : null,
        sheetId: kind === 'floor-plan' || kind === 'roof-plan' ? id : null,
        confidence: 1,
        sources: [],
        doubts: [],
        truth: tv,
      });
      if (tv.kind !== 'plan') continue;
      // Paires écrites : seulement sur les côtés dont la chaîne de cotes porte des « largeur / hauteur ».
      const chained = new Set((tv.dims ?? []).filter((d) => d.width_text).map((d) => String(d.chain).split('-')[0]));
      for (const o of tv.openings ?? []) {
        if (!o.exterior || !chained.has(o.side)) continue;
        const [nx, ny] = OUT[o.side]!;
        // Paire écrite à 0,8 m devant la baie, côté extérieur (dans la boîte de la vue).
        const d = 0.8 / (METRES_PER_POINT * (tv.scale_den ?? truth.scale_den));
        pairs.push({
          width: o.width_m,
          height: o.height_m,
          sill: o.sill_m,
          viewId: id,
          page: pi + 1,
          at: { x: (o.a_pt[0] + o.b_pt[0]) / 2 + nx * d, y: (o.a_pt[1] + o.b_pt[1]) / 2 + ny * d },
        });
      }
    }
  });
  return { views, pairs };
}

const fixtures = new Map<string, Fixture>();
const FILES = {
  A1: 'planche/planche_A1_archicad.pdf',
  A2: 'planche/planche_A2_de_titres_dessus.pdf',
  P2: 'planche/planche_2pages.pdf',
  ST: 'planche/planche_sans_titres.pdf',
} as const;
type Key = keyof typeof FILES;

async function load(key: Key): Promise<Fixture> {
  const cached = fixtures.get(key);
  if (cached) return cached;
  const file = FILES[key];
  const truth = truthOf(file);
  const pages = await extractAll(file);
  const { views, pairs } = viewsAndPairs(truth);
  const lang = key === 'A2' ? 'de' : 'fr';
  const plans: Fixture['plans'] = [];
  const entries: FloorPlanEntry[] = [];
  for (const v of views.filter((x) => x.kind === 'floor-plan')) {
    const den = v.truth.scale_den ?? truth.scale_den;
    const g = analyseFloorPlan(pages[v.page - 1]!, v, { declaredMpp: METRES_PER_POINT * den, openingPairs: pairs, lang });
    plans.push({ view: v, g });
    if (g.mpp) entries.push({ view: v, detection: g.detection, mpp: g.mpp });
  }
  const building = readBuildingGeometry(pages, views, entries, { lang });
  applyOpeningUpdates(entries, building.openingUpdates);
  const f: Fixture = { name: key, truth, pages, views, pairs, plans, building };
  fixtures.set(key, f);
  return f;
}

// ───────────────────────────── Outils de mesure ─────────────────────────────

const mid = (o: { a: Vec2; b: Vec2 }): Vec2 => ({ x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 });
const tmid = (o: TOpening): Vec2 => ({ x: (o.a_pt[0] + o.b_pt[0]) / 2, y: (o.a_pt[1] + o.b_pt[1]) / 2 });
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const rel = (a: number, b: number): number => Math.abs(a / b - 1);

/** Baie lue la plus proche d'une baie de la vérité (à 0,5 m près), sinon undefined. */
function found(ops: readonly DetectedOpening[], t: TOpening, mpp: number): DetectedOpening | undefined {
  const c = tmid(t);
  return [...ops].filter((o) => dist(mid(o), c) * mpp < 0.5).sort((x, y) => dist(mid(x), c) - dist(mid(y), c))[0];
}

// ───────────────────────────── Tests ─────────────────────────────

beforeAll(async () => {
  for (const k of Object.keys(FILES) as Key[]) await load(k);
}, 120_000);

describe.each(Object.keys(FILES) as Key[])('planche %s : plans d’étage', (key) => {
  it('pièces étiquetées : polygone retrouvé, aire ≤ 1 % de la vraie, surface écrite reprise', async () => {
    const f = await load(key);
    for (const { view, g } of f.plans) {
      const mpp = g.mpp!;
      expect(mpp, view.id).toBeTruthy();
      for (const r of view.truth.rooms ?? []) {
        if (r.area_label === null) continue;
        const d = g.detection.rooms.find((x) => x.name === r.name);
        expect(d, `${view.id} ${r.name}`).toBeDefined();
        expect(d!.polygon, `${view.id} ${r.name}`).toBeDefined();
        const a = ringArea(d!.polygon!) * mpp * mpp;
        expect(rel(a, r.area_true_m2), `${view.id} ${r.name} ${a}`).toBeLessThanOrEqual(0.01);
        expect(d!.statedArea).toBeCloseTo(Number(/(\d+[.,]\d+)/.exec(r.area_label)![1]!.replace(',', '.')), 2);
        expect(d!.measuredArea!).toBeGreaterThan(0);
        // Chauffé ou non d'après le nom et l'isolant ; au sous-sol sans isolant, les locaux sont à confirmer.
        const basement = (view.storeyRank ?? 0) < 0;
        if (basement) expect(['no', 'ask'], `${view.id} ${r.name}`).toContain(d!.heatedGuess);
        else expect(d!.heatedGuess, `${view.id} ${r.name}`).toBe(r.heated_true ? 'yes' : 'no');
      }
      // Aucune pièce inventée : chaque pièce lue porte un nom de la vérité.
      const names = new Set((view.truth.rooms ?? []).map((r) => r.name));
      for (const d of g.detection.rooms) expect(names.has(d.name), `${view.id} pièce lue « ${d.name} »`).toBe(true);
    }
  });

  it('échelle retrouvée par les surfaces écrites (mode), à 0,1 % de l’échelle de la vérité', async () => {
    const f = await load(key);
    for (const { view, g } of f.plans) {
      const den = view.truth.scale_den ?? f.truth.scale_den;
      expect(rel(g.mpp! / METRES_PER_POINT, den), view.id).toBeLessThan(0.001);
      if (key === 'A2') {
        // Sans remplissage de pièce, pas de mode des surfaces : l'échelle annoncée est recoupée par les contours
        // pris entre les murs (au moins trois pièces à 2 % près).
        expect(g.scale!.source, view.id).toBe('declared');
        expect(g.scale!.confidence, view.id).toBeGreaterThanOrEqual(0.85);
      } else {
        expect(g.scale!.support, view.id).toBeGreaterThanOrEqual(3);
        expect(g.scale!.source, view.id).toBe('areas+declared');
      }
    }
  });

  it('emprise : aire ≤ 2 %, dimensions hors tout recoupées', async () => {
    const f = await load(key);
    for (const { view, g } of f.plans) {
      const d = g.detection;
      const a = ringArea(d.outline!) * g.mpp! * g.mpp!;
      expect(rel(a, view.truth.outline_area_m2!), `${view.id} ${a}`).toBeLessThanOrEqual(0.02);
      const bb = view.truth.building_bbox_pt!;
      const k = METRES_PER_POINT * (view.truth.scale_den ?? f.truth.scale_den);
      expect(Math.abs(d.footprintSize!.width - (bb[2] - bb[0]) * k), view.id).toBeLessThan(0.05);
      expect(Math.abs(d.footprintSize!.depth - (bb[3] - bb[1]) * k), view.id).toBeLessThan(0.05);
      expect(d.outlineConfidence!).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('contour chauffé : aire ≤ 2 % (niveau entièrement non chauffé : pas de contour chauffé)', async () => {
    const f = await load(key);
    for (const { view, g } of f.plans) {
      const d = g.detection;
      const want = view.truth.heated_outline_area_m2!;
      if (want === 0) {
        expect(d.heatedOutline, view.id).toBeUndefined();
        const u = (d.unheatedZones ?? []).reduce((s, z) => s + (z.area ?? 0), 0);
        expect(rel(u, view.truth.outline_area_m2!), view.id).toBeLessThanOrEqual(0.02);
        continue;
      }
      const a = ringArea(d.heatedOutline!) * g.mpp! * g.mpp!;
      expect(rel(a, want), `${view.id} ${a}`).toBeLessThanOrEqual(0.02);
      expect(d.heatedEdges!.length).toBe(d.heatedOutline!.length);
    }
  });

  it('arêtes : mitoyenne et vers le non chauffé, longueur ≤ 5 %', async () => {
    const f = await load(key);
    for (const { view, g } of f.plans) {
      const mpp = g.mpp!;
      const party = (g.footprint?.party ?? []).reduce((s, p) => s + (p.span[1] - p.span[0]) * mpp, 0);
      const wantParty = view.truth.party_wall_length_m ?? 0;
      if (wantParty === 0) expect(party, view.id).toBe(0);
      else expect(rel(party, wantParty), `${view.id} ${party}`).toBeLessThanOrEqual(0.05);
      const d = g.detection;
      const toU = (d.heatedEdges ?? []).reduce((s, e, i) => {
        if (e.boundary !== 'unheated') return s;
        const a = d.heatedOutline![i]!;
        const b = d.heatedOutline![(i + 1) % d.heatedOutline!.length]!;
        return s + Math.hypot(b.x - a.x, b.y - a.y) * mpp;
      }, 0);
      const wantU = view.truth.wall_to_unheated_length_m ?? 0;
      if (wantU === 0) expect(toU, view.id).toBe(0);
      else expect(rel(toU, wantU), `${view.id} ${toU}`).toBeLessThanOrEqual(0.05);
      // Une arête mitoyenne du contour chauffé n'est jamais une façade.
      if (wantParty > 0 && d.heatedEdges) expect(d.heatedEdges.some((e) => e.boundary === 'heated'), view.id).toBe(true);
    }
  });

  it('baies des murs extérieurs : nombre exact par côté, largeur ≤ 3 cm, nature et hauteur écrite', async () => {
    const f = await load(key);
    for (const { view, g } of f.plans) {
      const mpp = g.mpp!;
      const ext = g.detection.openings.filter((o) => o.exterior);
      const want = (view.truth.openings ?? []).filter((o) => o.exterior);
      // Autant de baies lues que de baies vraies, chacune retrouvée à sa place : le compte par côté est alors exact.
      expect(ext.length, view.id).toBe(want.length);
      const matched = new Set<DetectedOpening>();
      for (const t of want) {
        const o = found(ext, t, mpp);
        if (o) matched.add(o);
        const label = `${view.id} ${t.name ?? t.kind} ${t.side}`;
        expect(o, label).toBeDefined();
        expect(Math.abs(o!.width! - t.width_m), label).toBeLessThanOrEqual(0.03);
        expect(o!.kind, label).toBe(t.kind);
        if (!t.in_envelope && t.kind === 'door') expect(o!.detail, label).toBe('garage-door');
        if (t.kind === 'door' && t.in_envelope) expect(o!.detail, label).toBe('entrance-door');
        const paired = f.pairs.some((p) => p.viewId === view.id && dist(p.at, tmid(t)) * mpp < 2);
        if (paired) {
          expect(o!.height, label).toBeCloseTo(t.height_m, 2);
          expect(o!.heightFrom, label).toBe('plan-dim');
        }
      }
      expect(matched.size, view.id).toBe(want.length);
    }
  });

  it('surface sans étiquette du volume chauffé (escalier) : signalée par une question', async () => {
    const f = await load(key);
    for (const { view, g } of f.plans) {
      const stair = (view.truth.rooms ?? []).find((r) => r.area_label === null && r.heated_true);
      if (!stair || view.truth.heated_outline_area_m2 === 0) continue;
      const u = g.detection.unlabelledAreas ?? [];
      expect(u.length, view.id).toBeGreaterThanOrEqual(1);
      const best = u.reduce((m, x) => (Math.abs(x.area - stair.area_true_m2) < Math.abs(m.area - stair.area_true_m2) ? x : m));
      // Remplissage de zone sans étiquette : aire exacte. Repli sans remplissage (planche allemande) : moins sûr.
      expect(rel(best.area, stair.area_true_m2), `${view.id} ${best.area}`).toBeLessThanOrEqual(key === 'A2' ? 0.25 : 0.02);
      expect(g.doubts.some((q) => q.includes((Math.round(best.area * 100) / 100).toFixed(2).replace('.', ','))), view.id).toBe(true);
    }
  });

  it('moins d’une seconde par vue (garde large pour une machine partagée)', async () => {
    const f = await load(key);
    for (const { view, g } of f.plans) expect(g.ms, view.id).toBeLessThan(2500);
  });
});

describe('planche A1 : garage dans l’emprise, mitoyen, toiture, façades', () => {
  it('garage : local non chauffé exclu du contour chauffé, porte vers le logement trouvée', async () => {
    const f = await load('A1');
    const { view, g } = f.plans.find((p) => p.view.storeyRank === 0)!;
    const d = g.detection;
    expect(d.unheatedZones).toHaveLength(1);
    expect(d.unheatedZones![0]!.names).toEqual(['Garage']);
    expect(rel(d.unheatedZones![0]!.area!, view.truth.outline_area_m2! - view.truth.heated_outline_area_m2!)).toBeLessThanOrEqual(0.02);
    expect(d.rooms.find((r) => r.name === 'Garage')!.heatedGuess).toBe('no');
    expect(d.rooms.find((r) => r.name === 'Terrasse')!.exterior).toBe(true);
    const t = view.truth.openings!.find((o) => o.to_unheated)!;
    const doors = d.openings.filter((o) => o.toUnheated);
    expect(doors).toHaveLength(1);
    expect(doors[0]!.kind).toBe('door');
    expect(doors[0]!.exterior).toBe(false);
    expect(Math.abs(doors[0]!.width! - t.width_m)).toBeLessThanOrEqual(0.03);
    expect(dist(mid(doors[0]!), tmid(t)) * g.mpp!).toBeLessThan(0.5);
  });

  it('les lignes « clé : valeur » des encadrés d’éclairement ne deviennent pas des pièces', async () => {
    const f = await load('A1');
    for (const { g } of f.plans) for (const r of g.detection.rooms) expect(r.name).not.toMatch(/surface|coefficient/i);
  });

  it('toiture : anneau extérieur du remplissage, toit plat', async () => {
    const f = await load('A1');
    const roofView = f.views.find((v) => v.kind === 'roof-plan')!;
    const roof = f.building.roof!;
    expect(roof.sheetId).toBe(roofView.id);
    expect(rel(roof.areaM2!, roofView.truth.outline_area_m2!)).toBeLessThanOrEqual(0.02);
    expect(roof.widthM!).toBeCloseTo(9.2, 1);
    expect(roof.depthM!).toBeCloseTo(12.4, 1);
    expect(roof.flat?.value).toBe(true);
  });

  it('plancher de l’étage au-dessus du garage (plans calés par le cadre répété)', async () => {
    const f = await load('A1');
    const up = f.plans.find((p) => p.view.storeyRank === 1)!;
    const rdc = f.plans.find((p) => p.view.storeyRank === 0)!;
    const over = f.building.floorOverUnheated.filter((x) => x.sheetId === up.view.id);
    expect(over).toHaveLength(1);
    expect(over[0]!.belowSheetId).toBe(rdc.view.id);
    expect(rel(over[0]!.areaM2, rdc.view.truth.outline_area_m2! - rdc.view.truth.heated_outline_area_m2!)).toBeLessThanOrEqual(0.02);
    expect(over[0]!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(f.building.floorOverOutside).toEqual([]);
  });
});

describe.each(['A1', 'A2', 'P2'] as Key[])('planche %s : façades dessinées', (key) => {
  it('baies de chaque façade : nombre, largeur et hauteur à 3 cm près', async () => {
    const f = await load(key);
    const elevs = f.views.filter((v) => v.kind === 'elevation');
    expect(f.building.elevations).toHaveLength(elevs.length);
    for (const v of elevs) {
      const e = f.building.elevations.find((x) => x.viewId === v.id)!;
      const want = v.truth.openings ?? [];
      expect(e.bays.length, v.id).toBe(want.length);
      const got = [...e.bays].sort((a, b) => a.widthM - b.widthM || a.heightM - b.heightM);
      const exp = [...want].sort((a, b) => a.width_m - b.width_m || a.height_m - b.height_m);
      got.forEach((b, i) => {
        expect(Math.abs(b.widthM - exp[i]!.width_m), `${v.id} ${i}`).toBeLessThanOrEqual(0.03);
        expect(Math.abs(b.heightM - exp[i]!.height_m), `${v.id} ${i}`).toBeLessThanOrEqual(0.03);
      });
      const doors = e.bays.filter((b) => b.kind === 'door' || b.kind === 'wide-door').length;
      expect(doors, v.id).toBe(want.filter((o) => o.kind === 'door').length);
    }
  });

  it('chaque façade rattachée au bon côté du plan, sans question', async () => {
    const f = await load(key);
    const plan = f.views.find((v) => v.kind === 'floor-plan' && v.storeyRank === 0) ?? f.views.find((v) => v.kind === 'floor-plan')!;
    for (const v of f.views.filter((x) => x.kind === 'elevation')) {
      const e = f.building.elevations.find((x) => x.viewId === v.id)!;
      // Côté attendu : celui des baies du plan qui portent les mêmes dimensions (vérité).
      const sides = new Set<string>();
      for (const o of v.truth.openings ?? []) {
        for (const pv of f.views.filter((x) => x.kind === 'floor-plan')) {
          const t = (pv.truth.openings ?? []).find((x) => x.exterior && x.width_m === o.width_m && x.height_m === o.height_m && (!o.name || x.name === o.name));
          if (t) sides.add(t.side);
        }
      }
      expect(sides.size, `${v.id} (vérité ambiguë)`).toBe(1);
      const side = [...sides][0]!;
      expect(e.planSideDeg, v.id).not.toBeNull();
      expect(e.planSideDeg!.value, v.id).toBeCloseTo(SIDE_DEG[side]!, 0);
      expect(e.planSideDeg!.confidence, v.id).toBeGreaterThanOrEqual(0.65);
      expect(e.planSideDeg!.doubt, v.id).toBeNull();
      void plan;
    }
    expect(f.building.doubts).toEqual([]);
  });

  it('hauteurs des baies sans cote écrite reprises des façades, celles du plan confirmées', async () => {
    const f = await load(key);
    for (const { view, g } of f.plans) {
      const mpp = g.mpp!;
      for (const t of (view.truth.openings ?? []).filter((o) => o.exterior)) {
        const o = found(g.detection.openings, t, mpp)!;
        // Une baie que les façades dessinées ne montrent pas (aucune façade de ce côté) garde une hauteur inconnue.
        const shown = f.views.some((v) => v.kind === 'elevation' && (v.truth.openings ?? []).some((x) => x.name === t.name));
        if (!shown) continue;
        expect(o.height, `${view.id} ${t.name}`).toBeDefined();
        expect(Math.abs(o.height! - t.height_m), `${view.id} ${t.name}`).toBeLessThanOrEqual(0.03);
        expect(o.heightFrom === 'plan-dim' || o.heightFrom === 'elevation').toBe(true);
      }
    }
  });
});

describe('calage des plans d’étage', () => {
  it.each(Object.keys(FILES) as Key[])('%s : décalage entre niveaux égal à celui des bâtiments dessinés (≤ 0,3 m)', async (key) => {
    const f = await load(key);
    const ref = f.plans.find((p) => p.view.storeyRank === 0)!;
    const rb = ref.view.truth.building_bbox_pt!;
    for (const { view, g } of f.plans) {
      const a = f.building.alignment.find((x) => x.sheetId === view.id)!;
      expect(a, view.id).toBeDefined();
      const b = view.truth.building_bbox_pt!;
      expect(Math.abs(a.dx - (rb[0] - b[0])) * g.mpp!, view.id).toBeLessThan(0.3);
      expect(Math.abs(a.dy - (rb[1] - b[1])) * g.mpp!, view.id).toBeLessThan(0.3);
      expect(a.confidence, view.id).toBeGreaterThanOrEqual(0.85);
    }
  });
});

describe('planche allemande A2 : pièces sans remplissage, murs pleins, sous-sol', () => {
  it('repli honnête : contours pris entre les murs, signalés, confiance plus basse qu’avec un remplissage', async () => {
    const a2 = await load('A2');
    const a1 = await load('A1');
    for (const { g } of a2.plans) {
      expect(g.materials).toBe('solid');
      expect(g.detection.notes.some((n) => /ohne Füllung/.test(n))).toBe(true);
      for (const r of g.detection.rooms.filter((x) => x.polygon)) expect(r.confidence!).toBeLessThanOrEqual(0.85);
    }
    const withFill = a1.plans[0]!.g.detection.rooms.filter((r) => r.polygon && r.statedArea);
    expect(Math.min(...withFill.map((r) => r.confidence!))).toBeGreaterThanOrEqual(0.9);
  });

  it('sous-sol sans isolant : tout le niveau est non chauffé, ses pièces sont à confirmer, l’étage du dessus repose dessus', async () => {
    const f = await load('A2');
    const kg = f.plans.find((p) => p.view.storeyRank === -1)!;
    expect(kg.g.detection.heatedOutline).toBeUndefined();
    expect(kg.g.detection.rooms.every((r) => r.heatedGuess !== 'yes')).toBe(true);
    expect(kg.g.detection.notes.some((n) => /unbeheizt/.test(n))).toBe(true);
    const eg = f.plans.find((p) => p.view.storeyRank === 0)!;
    const over = f.building.floorOverUnheated.find((x) => x.sheetId === eg.view.id)!;
    expect(rel(over.areaM2, 44.8)).toBeLessThanOrEqual(0.02);
  });

  it('textes destinés à l’utilisateur en allemand', async () => {
    const f = await load('A2');
    const eg = f.plans.find((p) => p.view.storeyRank === 0)!;
    expect(eg.g.detection.notes.join(' ')).toMatch(/Maßstab|Grundfläche|Öffnungen/);
    expect(eg.g.detection.notes.join(' ')).not.toMatch(/Échelle|Emprise/);
  });
});

describe('planche en L sur deux pages (P2)', () => {
  it('emprise en L à six sommets ; façades de la page 2 lues à l’échelle des plans de la page 1', async () => {
    const f = await load('P2');
    for (const { g } of f.plans) expect(g.detection.outline).toHaveLength(6);
    const elevs = f.views.filter((v) => v.kind === 'elevation');
    expect(elevs.every((v) => v.page === 2)).toBe(true);
    for (const e of f.building.elevations) {
      expect(e.widthM!).toBeCloseTo(10, 1);
      expect(e.bays.length).toBeGreaterThan(0);
    }
    expect(f.building.roof).toBeNull();
    expect(f.building.floorOverUnheated).toEqual([]);
  });
});
