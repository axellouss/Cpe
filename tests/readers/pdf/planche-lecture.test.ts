/**
 * Lecture COMPLÈTE de bout en bout (readPdfDetailed) des quatre planches SYNTHÉTIQUES de tests/fixtures/pdf/planche
 * (données inventées), face à leur vérité *.truth.json : vues, pièces et surfaces par niveau, contour chauffé, arêtes
 * mitoyennes et vers le non chauffé, baies par côté avec leurs dimensions, niveaux et hauteurs, compositions,
 * cartouche, tableau des surfaces, nord, toiture, façades rattachées ; puis le vrai moteur (buildAutoProject,
 * collectDoubts) sur le document lu : étages, An, questions restantes. Chaque planche se lit en moins de 3 s.
 *
 * À la différence de tests/readers/pdf/geometry/planches.test.ts (vues et paires tirées de la vérité), RIEN ici ne
 * vient de la vérité : tout est lu dans le PDF.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReadProgress } from '../../../src/readers';
import type { DetectedOpening, PlanDocument, PlanSheet, Vec2 } from '../../../src/core/types';
import { buildAutoProject, collectDoubts, createEmptyProject, deriveSheets, MAX_AUTO_DOUBTS } from '../../../src/engine';
import { readPdfDetailed } from '../../../src/readers/pdf';
import type { PdfReadDetails } from '../../../src/readers/pdf';
import { ringArea } from '../../../src/readers/pdf/planar';
import { fixtureBytes } from './helpers';

// ───────────────────────────── Vérité ─────────────────────────────

type P = [number, number];
interface TOpening {
  kind: 'window' | 'door';
  side: string;
  a_pt: P;
  b_pt: P;
  width_m: number;
  height_m: number;
  exterior: boolean;
}
interface TRoom {
  name: string;
  area_true_m2: number;
  area_label: string | null;
  heated_true: boolean;
}
interface TView {
  kind: string;
  title: string | null;
  name?: string;
  level?: number | null;
  azimuth_deg?: number;
  outline_area_m2?: number;
  heated_outline_area_m2?: number;
  party_wall_length_m?: number;
  wall_to_unheated_length_m?: number;
  rooms?: TRoom[];
  openings?: TOpening[];
  dims?: { chain?: string; width_text?: string }[];
}
interface TPage {
  views: TView[];
  levels?: { value_m: number; what: string }[];
  storeys?: { level: number; floor_m: number; storey_height_m: number | null; heated?: boolean }[];
  compositions?: { element: string; layers: { thickness_cm: number | null }[] }[];
  surface_table?: { footprint_m2?: number };
  titleblock?: { object?: string };
}
interface TTruth {
  scale_den: number;
  north_azimuth_deg: number;
  building: { storeys_heated: number; roof: string | null; labelled_heated_area_by_level_m2?: Record<string, number>; heated_area_by_level_m2?: Record<string, number> };
  pages: TPage[];
}

const FILES = {
  A1: 'planche/planche_A1_archicad.pdf',
  A2: 'planche/planche_A2_de_titres_dessus.pdf',
  P2: 'planche/planche_2pages.pdf',
  ST: 'planche/planche_sans_titres.pdf',
} as const;
type Key = keyof typeof FILES;
const KEYS = Object.keys(FILES) as Key[];

const KIND: Record<string, string> = { plan: 'floor-plan', 'roof-plan': 'roof-plan', elevation: 'elevation', section: 'section' };

interface Loaded {
  truth: TTruth;
  doc: PlanDocument;
  details: PdfReadDetails;
  progress: ReadProgress[];
  ms: number;
}
const loaded = new Map<Key, Loaded>();

function truthOf(file: string): TTruth {
  return JSON.parse(new TextDecoder('utf-8').decode(fixtureBytes(file.replace(/\.pdf$/, '.truth.json')))) as TTruth;
}

async function load(key: Key): Promise<Loaded> {
  const hit = loaded.get(key);
  if (hit) return hit;
  const progress: ReadProgress[] = [];
  const t0 = performance.now();
  const { doc, details } = await readPdfDetailed(fixtureBytes(FILES[key]), FILES[key], { lang: key === 'A2' ? 'de' : 'fr', onProgress: (p) => progress.push(p) });
  const l: Loaded = { truth: truthOf(FILES[key]), doc, details, progress, ms: performance.now() - t0 };
  loaded.set(key, l);
  return l;
}

const planViews = (t: TTruth): TView[] => t.pages.flatMap((p) => p.views.filter((v) => v.kind === 'plan'));
const mpp = (s: PlanSheet): number => s.metresPerUnit!.value;
const rel = (a: number, b: number): number => Math.abs(a / b - 1);
const mid = (o: { a: Vec2; b: Vec2 }): Vec2 => ({ x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 });
const tmid = (o: TOpening): Vec2 => ({ x: (o.a_pt[0] + o.b_pt[0]) / 2, y: (o.a_pt[1] + o.b_pt[1]) / 2 });
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const angle = (a: number, b: number): number => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/** Feuilles de plan d'étage, dans l'ordre des niveaux (les planches sans titre : de gauche à droite). */
function floorSheets(doc: PlanDocument): PlanSheet[] {
  return doc.sheets.filter((s) => (s.role ?? 'floor-plan') === 'floor-plan').sort((a, b) => (a.storeyRank ?? 0) - (b.storeyRank ?? 0) || a.bbox.minX - b.bbox.minX);
}

function edgeLengths(s: PlanSheet, boundary: 'heated' | 'unheated' | 'outside'): number {
  const r = s.detected.heatedOutline;
  const e = s.detected.heatedEdges;
  if (!r || !e) return 0;
  let sum = 0;
  r.forEach((p, i) => {
    if (e[i]?.boundary === boundary) sum += dist(p, r[(i + 1) % r.length]!) * mpp(s);
  });
  return sum;
}

function nearest(ops: readonly DetectedOpening[], t: TOpening, m: number): DetectedOpening | undefined {
  const c = tmid(t);
  return [...ops].filter((o) => dist(mid(o), c) * m < 0.5).sort((x, y) => dist(mid(x), c) - dist(mid(y), c))[0];
}

beforeAll(async () => {
  for (const k of KEYS) await load(k);
}, 120_000);

// ───────────────────────────── Lecture ─────────────────────────────

describe.each(KEYS)('planche %s lue de bout en bout', (key) => {
  it('se lit en moins de 3 s et suit ses étapes dans l’ordre', async () => {
    const { details, progress } = await load(key);
    expect(details.timing.total, `${key} ${Math.round(details.timing.total)} ms`).toBeLessThan(3000);
    const stages = progress.filter((p) => p.status !== 'running').map((p) => p.stage);
    expect(stages).toEqual(['open', 'views', 'rooms', 'envelope', 'layers', 'check']);
    const rooms = progress.find((p) => p.stage === 'rooms')!;
    expect(rooms.counts!.rooms!).toBeGreaterThan(0);
  });

  it('vues : chaque plan, coupe et façade de la vérité est reconnu ; une feuille par plan d’étage', async () => {
    const { truth, doc } = await load(key);
    const views = doc.reading!.views;
    truth.pages.forEach((p, i) => {
      for (const kind of ['plan', 'section', 'elevation']) {
        const want = p.views.filter((v) => v.kind === kind).length;
        const got = views.filter((v) => v.page === i + 1 && v.kind === KIND[kind]).length;
        expect(got, `${key} p${i + 1} ${kind}`).toBe(want);
      }
    });
    const sheets = floorSheets(doc);
    expect(sheets).toHaveLength(planViews(truth).length);
    // Chaque plan d'étage renvoie à sa feuille ; la feuille porte le rang du niveau quand le titre le dit.
    for (const v of views.filter((x) => x.kind === 'floor-plan')) expect(doc.sheets.map((s) => s.id), v.id).toContain(v.sheetId);
    if (key !== 'ST') expect(sheets.map((s) => s.storeyRank)).toEqual(planViews(truth).map((v) => v.level));
  });

  it('pièces par niveau : surface écrite reprise, polygone à 1 % près, chauffé ou non', async () => {
    const { truth, doc } = await load(key);
    const sheets = floorSheets(doc);
    planViews(truth).forEach((tv, i) => {
      const s = sheets[i]!;
      for (const r of tv.rooms ?? []) {
        if (r.area_label === null) continue;
        const d = s.detected.rooms.find((x) => x.name === r.name);
        expect(d, `${key} ${s.name} ${r.name}`).toBeDefined();
        expect(d!.statedArea).toBeCloseTo(Number(/(\d+[.,]\d+)/.exec(r.area_label)![1]!.replace(',', '.')), 2);
        if (/terrasse|balcon/i.test(r.name)) {
          expect(d!.heatedGuess).toBe('no');
          continue;
        }
        expect(d!.polygon, `${key} ${r.name}`).toBeDefined();
        expect(rel(ringArea(d!.polygon!) * mpp(s) ** 2, r.area_true_m2), `${key} ${r.name}`).toBeLessThanOrEqual(0.01);
        if ((tv.level ?? 0) >= 0) expect(d!.heatedGuess, `${key} ${s.name} ${r.name}`).toBe(r.heated_true ? 'yes' : 'no');
      }
      // Aucune pièce inventée.
      const names = new Set((tv.rooms ?? []).map((r) => r.name));
      for (const d of s.detected.rooms) expect(names.has(d.name), `${key} ${s.name} « ${d.name} »`).toBe(true);
    });
  });

  it('emprise et contour chauffé (≤ 2 %), arêtes mitoyennes et vers le non chauffé (≤ 5 %)', async () => {
    const { truth, doc } = await load(key);
    const sheets = floorSheets(doc);
    planViews(truth).forEach((tv, i) => {
      const s = sheets[i]!;
      const d = s.detected;
      expect(d.outline, `${key} ${s.name}`).toBeDefined();
      expect(rel(ringArea(d.outline!) * mpp(s) ** 2, tv.outline_area_m2!), `${key} ${s.name} emprise`).toBeLessThanOrEqual(0.02);
      expect(d.outlineConfidence ?? 0).toBeGreaterThan(0);
      if ((tv.heated_outline_area_m2 ?? 0) > 0) {
        expect(d.heatedOutline, `${key} ${s.name}`).toBeDefined();
        expect(rel(ringArea(d.heatedOutline!) * mpp(s) ** 2, tv.heated_outline_area_m2!), `${key} ${s.name} chauffé`).toBeLessThanOrEqual(0.02);
        expect(d.heatedEdges).toHaveLength(d.heatedOutline!.length);
        // Mitoyen : sur un niveau entièrement chauffé, toute la ligne mitoyenne est une arête « heated ».
        if (tv.party_wall_length_m! > 0 && tv.heated_outline_area_m2 === tv.outline_area_m2) {
          expect(rel(edgeLengths(s, 'heated'), tv.party_wall_length_m!), `${key} ${s.name} mitoyen`).toBeLessThanOrEqual(0.05);
        }
        if (tv.party_wall_length_m === 0) expect(edgeLengths(s, 'heated'), `${key} ${s.name}`).toBe(0);
        if (tv.wall_to_unheated_length_m! > 0) expect(rel(edgeLengths(s, 'unheated'), tv.wall_to_unheated_length_m!), `${key} ${s.name} vers non chauffé`).toBeLessThanOrEqual(0.05);
        else expect(edgeLengths(s, 'unheated'), `${key} ${s.name}`).toBe(0);
      } else {
        // Sous-sol sans isolant : tout le niveau est un local non chauffé.
        expect((d.unheatedZones ?? []).length, `${key} ${s.name}`).toBeGreaterThan(0);
      }
    });
  });

  it('baies des murs extérieurs : retrouvées par côté, largeur à 3 cm, hauteur à 3 cm quand elle est écrite', async () => {
    const { truth, doc } = await load(key);
    const sheets = floorSheets(doc);
    planViews(truth).forEach((tv, i) => {
      const s = sheets[i]!;
      const ext = (tv.openings ?? []).filter((o) => o.exterior);
      const chained = new Set((tv.dims ?? []).filter((x) => x.width_text).map((x) => String(x.chain).split('-')[0]));
      let hit = 0;
      for (const o of ext) {
        const d = nearest(s.detected.openings, o, mpp(s));
        if (!d) continue;
        hit++;
        expect(Math.abs(d.width! - o.width_m), `${key} ${s.name} ${o.side} ${o.width_m}`).toBeLessThanOrEqual(0.03);
        if (chained.has(o.side)) expect(Math.abs(d.height! - o.height_m), `${key} ${s.name} ${o.side} h ${o.height_m}`).toBeLessThanOrEqual(0.03);
      }
      expect(hit, `${key} ${s.name} baies ${hit}/${ext.length}`).toBe(ext.length);
    });
  });

  it('nord : azimut du haut de la feuille lu sur la flèche (≤ 3°)', async () => {
    const { truth, doc } = await load(key);
    expect(doc.northAngle, key).toBeDefined();
    expect(angle(doc.northAngle!.value, truth.north_azimuth_deg), `${key} ${doc.northAngle!.value}`).toBeLessThanOrEqual(3);
    expect(doc.reading!.north!.page).toBeGreaterThan(0);
  });

  it('cartouche, tableau des surfaces, niveaux et compositions lus ; preuves situées', async () => {
    const { truth, doc } = await load(key);
    const r = doc.reading!;
    const tb = truth.pages.map((p) => p.titleblock).find((x) => x?.object);
    if (tb) {
      expect(r.titleBlock?.project, key).toBe(tb.object);
      expect(r.titleBlock?.scaleDen).toBe(truth.scale_den);
    }
    const table = truth.pages.map((p) => p.surface_table).find((x) => x?.footprint_m2 !== undefined);
    if (table) expect(r.siteAreas?.footprint?.value).toBeCloseTo(table.footprint_m2!, 2);
    const storeys = truth.pages.flatMap((p) => p.storeys ?? []);
    if (storeys.length > 0) {
      expect(r.levels!.floors.map((f) => f.rel)).toEqual(storeys.map((s) => s.floor_m));
      // Rattachés aux feuilles : niveau fini, hauteur d'étage jusqu'au niveau suivant.
      const sheets = floorSheets(doc);
      storeys.forEach((st, i) => {
        expect(sheets[i]!.detected.elevation, `${key} ${sheets[i]!.name}`).toBeCloseTo(st.floor_m, 3);
        if (st.storey_height_m !== null && i + 1 < storeys.length) expect(sheets[i]!.detected.storeyHeight).toBeCloseTo(st.storey_height_m, 3);
      });
    }
    const comps = truth.pages.flatMap((p) => p.compositions ?? []);
    expect(r.compositions.length, key).toBe(comps.length);
    for (const c of comps) {
      const want = c.layers.map((l) => l.thickness_cm).filter((x): x is number => x !== null);
      const found = r.compositions.some((rc) => {
        const got = rc.layers.map((l) => l.thicknessCm).filter((x): x is number => x !== null);
        return want.every((w) => got.includes(w));
      });
      expect(found, `${key} ${c.element} ${want.join('+')}`).toBe(true);
    }
    // Les preuves disent où : la page au moins.
    for (const e of r.titleBlock?.buildingType?.evidence ?? []) expect(e.page, key).toBeGreaterThan(0);
  });
});

describe('planche A1 : toiture, façades, recoupements', () => {
  it('toiture plate 9,20 × 12,40 m ; plancher au-dessus du garage', async () => {
    const { doc } = await load('A1');
    const roof = doc.reading!.roof!;
    expect(roof.flat?.value).toBe(true);
    expect(roof.widthM).toBeCloseTo(9.2, 1);
    expect(roof.depthM).toBeCloseTo(12.4, 1);
    const over = doc.reading!.floorOverUnheated ?? [];
    expect(over).toHaveLength(1);
    expect(rel(over[0]!.areaM2, 15.876)).toBeLessThan(0.25);
  });

  it('façades rattachées à leur côté du plan (avant, arrière, latérale)', async () => {
    const { truth, doc } = await load('A1');
    const north = truth.north_azimuth_deg;
    const elev = doc.reading!.elevations;
    expect(elev).toHaveLength(3);
    for (const tv of truth.pages[0]!.views.filter((v) => v.kind === 'elevation')) {
      const e = elev.find((x) => doc.reading!.views.find((v) => v.id === x.viewId)?.title === tv.title);
      expect(e, tv.title ?? '').toBeDefined();
      expect(angle(e!.planSideDeg!.value, tv.azimuth_deg! - north), `${tv.title}`).toBeLessThanOrEqual(5);
      expect(e!.bays.length).toBe((tv.openings ?? []).length);
    }
  });

  it('recoupements : emprise confirmée par le tableau, local technique de l’étage chauffé, pas d’avertissement faux', async () => {
    const { doc } = await load('A1');
    const [rdc, etage] = floorSheets(doc);
    expect(rdc!.detected.notes.some((n) => n.includes('tableau des surfaces'))).toBe(true);
    expect(etage!.detected.rooms.find((r) => r.name === 'Local technique')?.heatedGuess).toBe('yes');
    expect(doc.warnings.filter((w) => /contour/i.test(w))).toEqual([]);
    expect(doc.warnings.filter((w) => /partielle/i.test(w))).toEqual([]);
  });
});

describe('planche A2 (allemand) : textes du lecteur en allemand', () => {
  it('notes et nord en allemand, sous-sol non chauffé, pas de toiture plate inventée', async () => {
    const { doc } = await load('A2');
    expect(doc.northAngle!.note).toMatch(/Nordpfeil/);
    const [keller] = floorSheets(doc);
    expect(keller!.detected.heatedOutline).toBeUndefined();
    expect(doc.reading!.roof?.flat?.value).not.toBe(true);
  });
});

// ───────────────────────────── Moteur sur le document lu ─────────────────────────────

describe.each(KEYS)('planche %s : projet automatique et questions restantes', (key) => {
  it('étages chauffés, An entre la somme des pièces étiquetées et le volume chauffé, peu de questions', async () => {
    const { truth, doc } = await load(key);
    const lang = key === 'A2' ? 'de' : 'fr';
    const auto = buildAutoProject(doc, createEmptyProject(lang), lang);
    const p = auto.project;
    expect(p.model.storeys.length, key).toBe(truth.building.storeys_heated);
    const an = deriveSheets(p, lang).totals.an;
    const labelled = Object.values(truth.building.labelled_heated_area_by_level_m2 ?? {}).reduce((a, b) => a + b, 0);
    const heated = Object.values(truth.building.heated_area_by_level_m2 ?? {}).reduce((a, b) => a + b, 0);
    if (labelled > 0) expect(an, `${key} An ${an}`).toBeGreaterThanOrEqual(0.97 * labelled);
    if (heated > 0) expect(an, `${key} An ${an}`).toBeLessThanOrEqual(1.03 * heated);
    const doubts = collectDoubts(doc.reading, p, doc.sheets, lang);
    const ids = doubts.map((d) => d.id as string);
    // La planche « Archicad » complète reste sous le seuil du parcours automatique. Les autres planches, moins
    // bavardes (pas d'équipement écrit, pas de tableau), en posent davantage : c'est le moteur qui en décide.
    if (key === 'A1') expect(doubts.length, `${key} ${ids.join(', ')}`).toBeLessThanOrEqual(MAX_AUTO_DOUBTS);
    // Questions plausibles : jamais d'échelle, ni de nord quand la flèche est lue loin d'un changement de secteur,
    // ni de nombre d'étages quand plans et niveaux concordent.
    expect(ids, key).not.toContain('scale');
    if ((doc.reading!.north?.marginDeg ?? 0) >= 10) expect(ids, key).not.toContain('north');
    for (const d of doubts) expect(d.question.length, `${key} ${d.id}`).toBeGreaterThan(0);
  });
});
