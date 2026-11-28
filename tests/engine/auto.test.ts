/**
 * Moteur automatique : projet construit tout seul à partir de la lecture d'une planche (buildAutoProject).
 *
 * Les documents viennent de la VÉRITÉ des quatre planches synthétiques (tests/engine/auto-planche.ts). Chaque
 * grandeur du relevé est comparée à un calcul de CONTRÔLE écrit ici, à partir des polygones, niveaux et
 * compositions de la vérité, sans passer par le moteur : étages, arêtes, baies, An, Ve, surfaces par orientation et
 * par nature, questions restantes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { EnvelopeRow, Lang, Orientation, PlanDocument, Vec2 } from '../../src/core/types';
import { buildAutoProject, collectDoubts, confirmedAnswers, createEmptyProject, deriveSheets, MAX_AUTO_DOUBTS, modelFromDocument, type AutoBuild } from '../../src/engine';
import { readCadDetailed } from '../../src/readers/cad';
import { fixtureBytes } from '../readers/cad/helpers';
import { documentFromTruth, PLANCHES, readPlancheTruth, sheetIdOf, truthPlans, truthStoreys, type PlancheName, type Truth, type TruthView } from './auto-planche';
import { deepFreeze } from './helpers';

const M_PER_PT = 0.0254 / 72;
const ORIENT: readonly Orientation[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// ───────────────────────────── Calcul de contrôle (vérité seule) ─────────────────────────────

const pts = (poly: [number, number][]): Vec2[] => poly.map(([x, y]) => ({ x, y }));
function area(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}
function inside(p: Vec2, poly: readonly Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
/** Secteur de la normale extérieure de l'arête i (repère y vers le bas, haut de feuille = azimut `up`). */
function sector(poly: readonly Vec2[], i: number, up: number): Orientation {
  const a = poly[i]!;
  const b = poly[(i + 1) % poly.length]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let n = { x: (b.y - a.y) / len, y: -(b.x - a.x) / len };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (inside({ x: mid.x + n.x, y: mid.y + n.y }, poly)) n = { x: -n.x, y: -n.y };
  const az = (((up + (Math.atan2(n.x, -n.y) * 180) / Math.PI) % 360) + 360) % 360;
  return ORIENT[Math.floor(((az + 22.5) % 360) / 45)]!;
}
const onSeg = (p: Vec2, [s, e]: [[number, number], [number, number]]): boolean => {
  const dx = e[0] - s[0];
  const dy = e[1] - s[1];
  const t = Math.max(0, Math.min(1, ((p.x - s[0]) * dx + (p.y - s[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (s[0] + t * dx), p.y - (s[1] + t * dy)) < 0.5;
};

/** Épaisseur comptée d'une composition de la vérité (m) : films, béton de propreté et empierrement exclus. */
function thickness(truth: Truth, element: string): number | null {
  const c = truth.pages.flatMap((p) => (p as unknown as { compositions?: { element: string; layers: { thickness_cm: number | null; material_key: string }[] }[] }).compositions ?? []).find((x) => x.element === element);
  if (!c) return null;
  const excluded = ['pe_film', 'vapour_barrier', 'lean_concrete', 'gravel'];
  return c.layers.filter((l) => l.thickness_cm !== null && !excluded.includes(l.material_key)).reduce((s, l) => s + l.thickness_cm!, 0) / 100;
}

interface Control {
  heated: { level: number; poly: Vec2[]; view: TruthView }[];
  /** Hauteur brute par étage chauffé (m), du bas vers le haut ; null si la vérité n'a pas de niveaux. */
  heights: number[] | null;
  an: number;
  unlabelled: number;
  ve: number;
  /** Surface brute des murs par « secteur|nature ». */
  walls: Map<string, number>;
  ground: number;
  overUnheated: number;
  roofFlat: number;
  windowArea: number;
  windowCount: number;
  doorCount: number;
  partyEdges: number;
  unheatedEdges: number;
}

/** Convention des cotes extérieures (réglage par défaut du moteur), repli de niveau fini à niveau fini. */
function controlHeights(truth: Truth, levels: number[]): number[] | null {
  const storeys = truthStoreys(truth).filter((s) => levels.includes(s.level));
  if (storeys.length !== levels.length || storeys.length === 0) return null;
  const marks = truth.pages.flatMap((p) => p.levels ?? []);
  const floors = storeys.map((s) => s.floor_m);
  const ridge = marks.find((m) => /first/i.test(m.what ?? ''));
  const eaves = marks.find((m) => /traufe/i.test(m.what ?? ''));
  if (ridge && eaves) return floors.map((f, i) => (i + 1 < floors.length ? floors[i + 1]! - f : eaves.value_m - f));
  const ground = thickness(truth, 'ground-floor');
  const roof = thickness(truth, 'roof');
  const between = thickness(truth, 'floor-over-unheated') ?? thickness(truth, 'intermediate-floor');
  const clear = storeys[storeys.length - 1]!.clear_height_m;
  if (ground !== null && roof !== null && clear !== undefined && (floors.length === 1 || between !== null)) {
    const bounds = [floors[0]! - ground, ...floors.slice(1).map((f) => f - (between ?? 0)), floors[floors.length - 1]! + clear + roof];
    return floors.map((_, i) => bounds[i + 1]! - bounds[i]!);
  }
  const top = Math.max(...marks.map((m) => m.value_m));
  return floors.map((f, i) => (i + 1 < floors.length ? floors[i + 1]! : top) - f);
}

function control(truth: Truth): Control {
  const up = truth.north_azimuth_deg;
  const k = M_PER_PT * truth.scale_den;
  const heated = truthPlans(truth)
    .filter(({ view }) => view.heated_outline_pt && view.heated_outline_pt.length >= 3)
    .map(({ view }) => ({ level: view.level ?? 0, poly: pts(view.heated_outline_pt!).map((p) => ({ x: p.x * k, y: p.y * k })), view }))
    .sort((a, b) => a.level - b.level);
  const heights = controlHeights(
    truth,
    heated.map((h) => h.level),
  );
  const pitched = truth.building['roof'] === 'gable';
  const sectionRoof = truth.pages.flatMap((p) => p.views).map((v) => (typeof v.roof === 'object' ? v.roof : null)).find(Boolean);
  const walls = new Map<string, number>();
  let partyEdges = 0;
  let unheatedEdges = 0;
  let ve = 0;
  heated.forEach((h, i) => {
    const kpt = (p: Vec2): Vec2 => ({ x: p.x / k, y: p.y / k });
    const height = heights?.[i] ?? 0;
    ve += area(h.poly) * height;
    h.poly.forEach((a, j) => {
      const b = h.poly[(j + 1) % h.poly.length]!;
      const isOn = (segs: [[number, number], [number, number]][] | undefined) => (segs ?? []).some((s) => onSeg(kpt(a), s) && onSeg(kpt(b), s));
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (isOn(h.view.party_edges_pt)) {
        partyEdges++;
        return;
      }
      const nature = isOn(h.view.unheated_edges_pt) ? 'unheated' : 'outside';
      if (nature === 'unheated') unheatedEdges++;
      let wall = len * height;
      // Pignon d'une toiture à deux pans (faîtage le long du grand côté) : triangle au-dessus du dernier étage.
      if (pitched && i === heated.length - 1 && sectionRoof && typeof sectionRoof === 'object' && sectionRoof.pitch_deg) {
        const xs = h.poly.map((p) => p.x);
        const ys = h.poly.map((p) => p.y);
        const w = Math.max(...xs) - Math.min(...xs);
        const d = Math.max(...ys) - Math.min(...ys);
        const span = Math.min(w, d);
        const alongX = w >= d;
        const perpendicular = alongX ? Math.abs(b.x - a.x) < 1e-6 : Math.abs(b.y - a.y) < 1e-6;
        if (perpendicular) wall += (span * (span / 2) * Math.tan((sectionRoof.pitch_deg * Math.PI) / 180)) / 2;
      }
      // Paroi vers un local non chauffé : sans orientation dans LuxEeB-Tool, une seule ligne.
      const key = nature === 'unheated' ? '-|unheated' : `${sector(h.poly, j, up)}|${nature}`;
      walls.set(key, (walls.get(key) ?? 0) + wall);
    });
  });
  // Volume sous les rampants (deux pans) : demi-hauteur du faîtage au-dessus de l'égout.
  if (pitched && sectionRoof && typeof sectionRoof === 'object' && sectionRoof.ridge_m && sectionRoof.eaves_m) {
    ve += area(heated[heated.length - 1]!.poly) * ((sectionRoof.ridge_m - sectionRoof.eaves_m) / 2);
  }
  let an = 0;
  let unlabelled = 0;
  let windowArea = 0;
  let windowCount = 0;
  let doorCount = 0;
  for (const h of heated) {
    for (const r of h.view.rooms ?? []) {
      if (!r.heated_true) continue;
      const m = r.area_label ? /(\d+,\d+)/.exec(r.area_label) : null;
      if (m) an += Number(m[1]!.replace(',', '.'));
      else unlabelled += r.area_true_m2;
    }
    for (const o of h.view.openings ?? []) {
      if (!o.in_envelope) continue;
      if (o.kind === 'window') {
        windowArea += o.width_m * o.height_m;
        windowCount++;
      } else doorCount++;
    }
  }
  const lowest = heated[0]!;
  const top = heated[heated.length - 1]!;
  // Plancher d'étage au-dessus d'un local non chauffé : surface de l'étage hors de celle de l'étage du dessous.
  let overUnheated = 0;
  for (let i = 1; i < heated.length; i++) overUnheated += Math.max(0, area(heated[i]!.poly) - area(heated[i - 1]!.poly));
  const basement = (truth.building['basement'] as { heated?: boolean } | false | undefined) || null;
  return {
    heated,
    heights,
    an,
    unlabelled,
    ve,
    walls,
    ground: basement ? 0 : area(lowest.poly),
    overUnheated: overUnheated + (basement ? area(lowest.poly) : 0),
    roofFlat: pitched ? 0 : area(top.poly),
    windowArea,
    windowCount,
    doorCount,
    partyEdges,
    unheatedEdges,
  };
}

function wallAreas(rows: readonly EnvelopeRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== 'wall' || r.manual) continue;
    const key = r.boundary === 'unheated' ? '-|unheated' : `${r.orientation}|${r.boundary}`;
    out.set(key, (out.get(key) ?? 0) + r.grossArea);
  }
  return out;
}

const langOf = (name: PlancheName): Lang => (name.includes('A2') ? 'de' : 'fr');

interface Case {
  truth: Truth;
  doc: PlanDocument;
  auto: AutoBuild;
  control: Control;
}
const cases = new Map<PlancheName, Case>();

beforeAll(async () => {
  for (const name of PLANCHES) {
    const truth = await readPlancheTruth(name);
    const doc = documentFromTruth(truth);
    cases.set(name, { truth, doc, auto: buildAutoProject(doc, createEmptyProject(langOf(name)), langOf(name)), control: control(truth) });
  }
});
const get = (name: PlancheName): Case => cases.get(name)!;

// ───────────────────────────── Étages, arêtes, baies ─────────────────────────────

describe.each(PLANCHES)('%s — étages et contours', (name) => {
  it('les plans chauffés deviennent les étages, du bas vers le haut ; un sous-sol non chauffé reste hors du volume', () => {
    const { truth, auto } = get(name);
    const heatedLevels = truthPlans(truth)
      .filter(({ view }) => view.heated_outline_pt && view.heated_outline_pt.length >= 3)
      .sort((a, b) => (a.view.level ?? 0) - (b.view.level ?? 0));
    expect(auto.storeySheetIds).toEqual(heatedLevels.map(({ page, view }) => sheetIdOf(page, view.level)));
    expect(auto.project.model.storeys.map((s) => s.sheetId)).toEqual(auto.storeySheetIds);
    // La feuille de façade (rôle « elevation ») n'est jamais un étage.
    expect(auto.storeySheetIds.some((id) => id.includes('elevation'))).toBe(false);
    const basements = truthPlans(truth).filter(({ view }) => !view.heated_outline_pt);
    expect((auto.project.model.unheatedStoreys ?? []).map((s) => s.sheetId)).toEqual(basements.map(({ page, view }) => sheetIdOf(page, view.level)));
  });

  it('chaque arête porte la nature lue : façade, local non chauffé, mitoyen', () => {
    const { auto, control: c } = get(name);
    const edges = auto.project.model.storeys.flatMap((s) => s.edges);
    expect(edges.filter((e) => e.boundary === 'heated').length).toBe(c.partyEdges);
    expect(edges.filter((e) => e.boundary === 'unheated').length).toBe(c.unheatedEdges);
    for (const s of auto.project.model.storeys) {
      expect(s.edges.length).toBe(s.outline.length);
      expect(s.metresPerUnit.from).toBe('plan');
    }
  });

  it('les baies de l’enveloppe sont portées par leur arête ; porte de garage et portes intérieures écartées', () => {
    const { auto, control: c } = get(name);
    const openings = auto.project.model.storeys.flatMap((s) => s.openings);
    const windows = openings.filter((o) => o.kind === 'window');
    expect(windows.reduce((n, o) => n + o.count, 0)).toBe(c.windowCount);
    expect(openings.filter((o) => o.kind === 'door').reduce((n, o) => n + o.count, 0)).toBe(c.doorCount);
    expect(windows.reduce((s, o) => s + o.width * o.height * o.count, 0)).toBeCloseTo(c.windowArea, 6);
    for (const s of auto.project.model.storeys) {
      for (const o of s.openings) {
        expect(o.edgeIndex).toBeGreaterThanOrEqual(0);
        expect(s.edges[o.edgeIndex]!.boundary).not.toBe('heated');
        expect(o.from).toBe('plan');
      }
    }
  });
});

describe('baies regroupées et portes', () => {
  it('deux fenêtres identiques sur la même arête font une ligne de 2', () => {
    const upper = get('planche_sans_titres').auto.project.model.storeys[1]!;
    const pair = upper.openings.filter((o) => o.kind === 'window' && o.width === 2 && o.height === 1.25);
    expect(pair).toHaveLength(1);
    expect(pair[0]!.count).toBe(2);
  });

  it('A1 : la porte vers le garage est sur l’arête « non chauffé » avec son type ; la porte de garage reste hors enveloppe', () => {
    const rez = get('planche_A1_archicad').auto.project.model.storeys[0]!;
    const toGarage = rez.openings.find((o) => o.constructionId === 'door-unheated')!;
    expect(rez.edges[toGarage.edgeIndex]!.boundary).toBe('unheated');
    expect(rez.footprint?.openings.map((o) => o.width)).toEqual([2.4]);
    const rows = deriveSheets(get('planche_A1_archicad').auto.project, 'fr').envelope;
    expect(rows.find((r) => r.kind === 'door' && r.boundary === 'unheated')).toBeDefined();
    expect(rows.some((r) => r.kind === 'door' && r.width === 2.1 && r.length === 2.4)).toBe(false);
    // Allège lue reportée sur la baie.
    expect(rez.openings.find((o) => o.kind === 'window' && o.width === 1.2 && o.height === 1.25)!.sill).toBe(0.9);
  });
});

// ───────────────────────────── Surfaces, volumes, relevé ─────────────────────────────

describe.each(['planche_A1_archicad', 'planche_A2_de_titres_dessus', 'planche_2pages'] as const)('%s — relevé face au calcul de contrôle', (name) => {
  it('hauteurs brutes : niveaux et compositions lus, provenance plan', () => {
    const { auto, control: c } = get(name);
    const heights = auto.project.model.storeys.map((s) => s.grossHeight);
    heights.forEach((h, i) => {
      expect(h.value).toBeCloseTo(c.heights![i]!, 2);
      expect(h.from).toBe('plan');
      expect(h.note).toBeTruthy();
    });
  });

  it('An : surfaces INSCRITES des pièces chauffées ; escalier sans étiquette non compté d’office', () => {
    const { auto, control: c } = get(name);
    const sheets = deriveSheets(auto.project, langOf(name));
    expect(sheets.totals.an).toBeCloseTo(c.an, 1);
    const unl = auto.project.model.storeys.flatMap((s) => s.rooms.filter((r) => r.unlabelled));
    expect(unl.every((r) => !r.heated)).toBe(true);
    expect(unl.reduce((s, r) => s + r.area.value, 0)).toBeCloseTo(c.unlabelled, 1);
    // Locaux non chauffés et extérieurs jamais comptés.
    for (const s of auto.project.model.storeys) for (const r of s.rooms) if (/garage|terrasse/i.test(r.name)) expect(r.heated).toBe(false);
  });

  it('Ve : contours chauffés × hauteurs (et rampants)', () => {
    const { auto, control: c } = get(name);
    const ve = deriveSheets(auto.project, langOf(name)).totals.ve;
    expect(Math.abs(ve - c.ve) / c.ve).toBeLessThan(0.01);
  });

  it('murs : surface brute par orientation et par nature', () => {
    const { auto, control: c } = get(name);
    const got = wallAreas(deriveSheets(auto.project, langOf(name)).envelope);
    expect([...got.keys()].sort()).toEqual([...c.walls.keys()].sort());
    for (const [key, value] of c.walls) expect(Math.abs(got.get(key)! - value) / value, key).toBeLessThan(0.01);
  });

  it('planchers et toiture : sur sol, sur local non chauffé (sous-sol ou garage sous l’étage), toiture', () => {
    const { auto, control: c } = get(name);
    const rows = deriveSheets(auto.project, langOf(name)).envelope;
    const sum = (f: (r: EnvelopeRow) => boolean) => rows.filter(f).reduce((s, r) => s + r.grossArea, 0);
    expect(sum((r) => r.kind === 'floor' && r.boundary === 'ground')).toBeCloseTo(c.ground, 1);
    expect(sum((r) => r.kind === 'floor' && r.boundary === 'unheated')).toBeCloseTo(c.overUnheated, 1);
    if (c.roofFlat > 0) expect(sum((r) => r.kind === 'roof')).toBeCloseTo(c.roofFlat, 1);
    else expect(sum((r) => r.kind === 'roof')).toBeGreaterThan(area(c.heated[c.heated.length - 1]!.poly));
  });
});

describe('fermetures, parois, nord, identité', () => {
  it('toiture plate (acrotère), toiture inclinée habitée (faîtage + égout) ; plancher bas sur sol ou sur sous-sol', () => {
    expect(get('planche_A1_archicad').auto.project.model.top).toMatchObject({ kind: 'flat-roof', from: 'plan' });
    expect(get('planche_A1_archicad').auto.project.model.bottom).toMatchObject({ kind: 'slab-on-ground', from: 'plan' });
    const a2 = get('planche_A2_de_titres_dessus').auto.project.model;
    expect(a2.top.kind).toBe('pitched-roof');
    expect(a2.top.pitchDeg).toBe(35);
    expect(a2.top.kneeWallHeight).toBeCloseTo(5.6 - 2.75, 6);
    expect(a2.bottom).toMatchObject({ kind: 'above-unheated', from: 'plan' });
  });

  it('une construction par composition d’enveloppe, rattachée au bon élément ; sans composition : sans couches', () => {
    const a1 = get('planche_A1_archicad').auto.project.model.constructions;
    const byId = (id: string) => a1.find((c) => c.id === id)!;
    expect(byId('wall-outside').layers!.length).toBe(3);
    expect(byId('wall-unheated').layers!.length).toBe(2);
    expect(byId('roof').layers!.length).toBeGreaterThan(0);
    expect(byId('floor-ground').layers!.length).toBeGreaterThan(0);
    expect(byId('floor-unheated').layers!.length).toBeGreaterThan(0);
    // λ jamais présentées comme confirmées.
    for (const c of a1) for (const l of c.layers ?? []) expect(l.lambda?.from ?? 'default').not.toBe('user');
    // Portes : hypothèses d'usage étiquetées.
    expect(byId('door').u).toMatchObject({ from: 'default' });
    expect(byId('door-unheated').u).toMatchObject({ from: 'default' });
    const p2 = get('planche_2pages').auto.project.model.constructions;
    expect(p2.find((c) => c.id === 'wall-outside')!.layers ?? []).toHaveLength(0);
    const materials = collectDoubts(get('planche_2pages').doc.reading, get('planche_2pages').auto.project, get('planche_2pages').doc.sheets, 'fr').find((d) => d.id === 'materials')!;
    expect(materials.details.join(' ')).toMatch(/mur/i);
  });

  it('types de fenêtres de l’expert, ordre de saisie de l’expert, façades dessinées dans leur ordre', () => {
    const m = get('planche_A1_archicad').auto.project.model;
    expect(m.envelopeOrder).toBe('expert');
    expect(m.facadeViews!.map((f) => f.short)).toEqual(['AV', 'ARR', 'LAT']);
    expect(m.facadeViews!.map((f) => f.orientation)).toEqual(['E', 'W', 'S']);
    expect(m.windowTypes.some((w) => /^ARR 400\*215/.test(w.name))).toBe(true);
    for (const w of m.windowTypes) expect(w.uw?.from ?? 'default').not.toBe('user');
  });

  it('nord lu → model.northAngle, avec sa provenance et son doute de secteur', () => {
    for (const name of PLANCHES) {
      const { truth, auto } = get(name);
      expect(auto.project.model.northAngle.value).toBe(truth.north_azimuth_deg);
      expect(auto.project.model.northAngle.from).toBe('plan');
    }
    // 250° est à 2,5° de la limite 247,5° : signalé.
    expect(get('planche_A1_archicad').auto.project.model.northAngle.doubt).toBeTruthy();
  });

  it('cartouche et équipements : PROPOSÉS, jamais confirmés', () => {
    const { auto } = get('planche_A1_archicad');
    const a = auto.project.answers;
    expect(a).toMatchObject({ projectName: 'Maison Exemple', street: '12, rue des Essais', postcode: 'L-0000', locality: 'Exempleville', buildingType: 'EFH', dwellings: 1, occasion: 'new', yearBuilt: 2026 });
    expect(a.heatGenerator).toBe('heat-pump-air');
    expect(a.attachment).toBe('one-side');
    const confirmed = confirmedAnswers(a);
    expect(confirmed.street).toBe('');
    expect(confirmed.occasion).toBeNull();
    expect(confirmed.heatGenerator).toBeNull();
    expect(Object.keys(a.proposed ?? {})).toEqual(expect.arrayContaining(['street', 'occasion', 'heatGenerator', 'attachment']));
    // Aucune valeur du projet ne porte la provenance « utilisateur ».
    expect(JSON.stringify(auto.project)).not.toMatch(/"from":"user"/);
  });
});

// ───────────────────────────── Questions restantes ─────────────────────────────

describe('questions restantes', () => {
  const expected: Record<PlancheName, { sufficient: boolean; doubts: string[] }> = {
    planche_A1_archicad: { sufficient: true, doubts: ['an-unlabelled', 'heating', 'materials', 'thermal-bridges', 'ventilation', 'windows'] },
    planche_A2_de_titres_dessus: { sufficient: true, doubts: ['an-unlabelled', 'attached', 'heating', 'materials', 'renewables', 'thermal-bridges', 'ventilation', 'windows'] },
    planche_2pages: { sufficient: true, doubts: ['an-unlabelled', 'attached', 'heating', 'materials', 'renewables', 'thermal-bridges', 'ventilation', 'windows'] },
    // Ni niveaux, ni toiture, ni compositions : trop de questions, parcours guidé.
    planche_sans_titres: {
      sufficient: false,
      doubts: ['an-unlabelled', 'attached', 'bottom', 'heating', 'heights', 'materials', 'occasion', 'renewables', 'thermal-bridges', 'top', 'ventilation', 'windows'],
    },
  };
  it.each(PLANCHES)('%s : nombre et nature des questions, parcours possible ou non', (name) => {
    const { doc, auto } = get(name);
    const doubts = collectDoubts(doc.reading, auto.project, doc.sheets, langOf(name));
    expect(doubts.map((d) => d.id).sort()).toEqual(expected[name].doubts);
    expect(auto.sufficient).toBe(expected[name].sufficient);
    if (auto.sufficient) expect(doubts.length).toBeLessThanOrEqual(MAX_AUTO_DOUBTS);
    else expect(auto.notes.length).toBeGreaterThan(0);
  });

  it('A2 : le sous-sol non chauffé ne pose pas de question sur ses locaux (tranché par le plancher bas lu)', () => {
    const { doc, auto } = get('planche_A2_de_titres_dessus');
    const ids = collectDoubts(doc.reading, auto.project, doc.sheets, 'de').map((d) => d.id);
    expect(ids).not.toContain('unheated-zone');
    expect(ids).not.toContain('room-heated');
    expect(ids).not.toContain('bottom');
  });

  it('pièce ambiguë DANS le contour isolé : comptée sans question', () => {
    const rez = get('planche_A1_archicad').auto.project.model.storeys[0]!;
    expect(rez.rooms.find((r) => r.name === 'Buanderie')).toMatchObject({ heated: true, needsReview: false });
  });

  it('« existant » seul (terrain, voisin) ne fait pas douter d’une construction neuve ; « à démolir » si', () => {
    const doc = documentFromTruth(get('planche_A1_archicad').truth);
    doc.sheets[0]!.texts!.push({ text: 'Immeuble existant', x: 0, y: 0 }, { text: 'TN existant', x: 0, y: 0 });
    const auto = buildAutoProject(doc, createEmptyProject('fr'), 'fr');
    expect(collectDoubts(doc.reading, auto.project, doc.sheets, 'fr').map((d) => d.id)).not.toContain('occasion');
    doc.sheets[0]!.texts!.push({ text: 'Mur à démolir', x: 0, y: 0 });
    const occasion = collectDoubts(doc.reading, buildAutoProject(doc, createEmptyProject('fr'), 'fr').project, doc.sheets, 'fr').find((d) => d.id === 'occasion');
    expect(occasion).toBeDefined();
  });

  it('toiture plate sans mention « plate » : acrotère coté, dalle de toiture et plan de toiture sans faîtage suffisent', () => {
    const doc = documentFromTruth(get('planche_A1_archicad').truth);
    doc.reading!.roof = null;
    const auto = buildAutoProject(doc, createEmptyProject('fr'), 'fr');
    expect(auto.project.model.top).toMatchObject({ kind: 'flat-roof', from: 'plan' });
    expect(collectDoubts(doc.reading, auto.project, doc.sheets, 'fr').map((d) => d.id)).not.toContain('top');
  });

  it('une seule porte sans hauteur écrite (moins de 1 % de l’enveloppe) : pas de question, hauteur d’usage étiquetée', () => {
    const doc = documentFromTruth(get('planche_A1_archicad').truth);
    const toGarage = doc.sheets[0]!.detected.openings.find((o) => o.toUnheated)!;
    delete toGarage.height;
    toGarage.heightFrom = 'default';
    const auto = buildAutoProject(doc, createEmptyProject('fr'), 'fr');
    expect(collectDoubts(doc.reading, auto.project, doc.sheets, 'fr').map((d) => d.id)).not.toContain('opening-heights');
    const door = auto.project.model.storeys[0]!.openings.find((o) => o.constructionId === 'door-unheated')!;
    expect(door.from).toBe('default');
  });

  it('sans titre de vue : les deux plans sont quand même lus comme étages', () => {
    expect(get('planche_sans_titres').auto.project.model.storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée', '1er étage']);
  });
});

// ───────────────────────────── Ce que l'utilisateur a déjà confirmé ─────────────────────────────

describe('valeurs déjà confirmées dans le projet de départ', () => {
  it('ne sont jamais écrasées par la lecture', () => {
    const { doc } = get('planche_A1_archicad');
    const base = createEmptyProject('fr');
    base.answers.street = '7, rue Saisie';
    base.answers.occasion = 'existing';
    base.model.top = { ...base.model.top, kind: 'attic-ceiling', from: 'user' };
    base.model.northAngle = { value: 10, from: 'user' };
    const auto = buildAutoProject(doc, base, 'fr');
    expect(auto.project.answers.street).toBe('7, rue Saisie');
    expect(auto.project.answers.occasion).toBe('existing');
    expect(auto.project.answers.proposed?.['street']).toBeUndefined();
    expect(auto.project.answers.proposed?.['occasion']).toBeUndefined();
    expect(auto.project.model.top.kind).toBe('attic-ceiling');
    expect(auto.project.model.northAngle).toEqual({ value: 10, from: 'user' });
    // Une valeur seulement proposée dans le projet de départ est, elle, remplacée par la nouvelle lecture.
    const proposedBase = createEmptyProject('fr');
    proposedBase.answers.street = 'ancienne proposition';
    proposedBase.answers.proposed = { street: { confidence: 0.5, source: 'x' } };
    expect(buildAutoProject(doc, proposedBase, 'fr').project.answers.street).toBe('12, rue des Essais');
  });

  it('questions tranchées : celles du questionnaire restent tranchées, celles des valeurs relues reviennent', () => {
    const { doc } = get('planche_A1_archicad');
    const base = createEmptyProject('fr');
    base.answers.resolvedDoubts = { occasion: 'user', 'an-unlabelled': 'user', top: 'unknown' };
    const auto = buildAutoProject(doc, base, 'fr');
    expect(auto.project.answers.resolvedDoubts).toEqual({ occasion: 'user' });
    expect(collectDoubts(doc.reading, auto.project, doc.sheets, 'fr').map((d) => d.id)).toContain('an-unlabelled');
  });

  it('fonction pure : document et projet de départ intacts', () => {
    const doc = deepFreeze(documentFromTruth(get('planche_A1_archicad').truth));
    const base = deepFreeze(createEmptyProject('fr'));
    expect(() => buildAutoProject(doc, base, 'fr')).not.toThrow();
  });
});

// ───────────────────────────── Lectures dégradées ─────────────────────────────

describe('lectures dégradées : jamais de plantage, jamais de valeur inventée présentée comme lue', () => {
  const build = (options: Parameters<typeof documentFromTruth>[1], name: PlancheName = 'planche_A1_archicad') => {
    const doc = documentFromTruth(get(name).truth, options);
    const auto = buildAutoProject(doc, createEmptyProject('fr'), 'fr');
    return { doc, auto, doubts: collectDoubts(doc.reading, auto.project, doc.sheets, 'fr').map((d) => d.id) };
  };

  it('sans contour chauffé : contour tiré de l’emprise et des pièces, parcours guidé', () => {
    const { auto } = build({ noHeatedOutline: true });
    expect(auto.sufficient).toBe(false);
    expect(auto.project.model.storeys.length).toBe(2);
    expect(auto.notes.join(' ')).toMatch(/contour/);
    // Le garage nommé est retiré de l'emprise au rez (chemin historique).
    const rez = auto.project.model.storeys[0]!;
    expect(rez.rooms.find((r) => r.name === 'Garage')?.heated).toBe(false);
  });

  it('sans niveaux : hauteurs par défaut marquées telles, question des hauteurs', () => {
    const { auto, doubts } = build({ noLevels: true });
    for (const s of auto.project.model.storeys) expect(s.grossHeight.from).toBe('default');
    expect(doubts).toContain('heights');
  });

  it('sans compositions : parois sans couches (U à définir), question des matériaux qui le dit', () => {
    const { doc, auto } = build({ noCompositions: true });
    for (const c of auto.project.model.constructions) if (c.category !== 'door') expect(c.layers ?? []).toHaveLength(0);
    const m = collectDoubts(doc.reading, auto.project, doc.sheets, 'fr').find((d) => d.id === 'materials')!;
    expect(m.question).toMatch(/Aucune composition/);
  });

  it('sans nord : nord par défaut, question du nord', () => {
    const { auto, doubts } = build({ noNorth: true });
    expect(auto.project.model.northAngle.from).toBe('default');
    expect(doubts).toContain('north');
  });

  it('sans cartouche : rien d’inventé, questions d’identité, de date, d’occasion', () => {
    const { auto, doubts } = build({ noTitleBlock: true });
    expect(auto.project.answers.street).toBe('');
    expect(auto.project.answers.yearBuilt).toBeNull();
    expect(doubts).toEqual(expect.arrayContaining(['identity', 'year']));
  });

  it('échelle seulement supposée, sans recoupement : question de l’échelle, parcours guidé', () => {
    const doc = documentFromTruth(get('planche_A1_archicad').truth, { guessedScale: true });
    for (const s of doc.sheets) {
      delete s.detected.footprintSize;
      for (const r of s.detected.rooms) delete r.measuredArea;
    }
    const auto = buildAutoProject(doc, createEmptyProject('fr'), 'fr');
    expect(collectDoubts(doc.reading, auto.project, doc.sheets, 'fr').map((d) => d.id)).toContain('scale');
    expect(auto.sufficient).toBe(false);
    expect(auto.notes.join(' ')).toMatch(/[ÉE]chelle/);
  });

  it('échelle supposée mais recoupée par les surfaces écrites et les cotes hors tout : pas de question', () => {
    const { auto, doubts } = build({ guessedScale: true });
    expect(doubts).not.toContain('scale');
    expect(auto.sufficient).toBe(true);
  });

  it('sans vue de toiture ni coupe : l’acrotère coté propose la toiture plate, à confirmer', () => {
    const { auto, doubts, doc } = build({ noRoof: true }, 'planche_2pages');
    expect(auto.project.model.top).toMatchObject({ kind: 'flat-roof', from: 'plan' });
    expect(doubts).toContain('top');
    expect(collectDoubts(doc.reading, auto.project, doc.sheets, 'fr').find((d) => d.id === 'top')!.proposal?.value).toBe('flat');
  });

  it('ni toiture ni niveaux : fermeture haute par défaut, parcours guidé', () => {
    const { auto, doubts } = build({ noRoof: true, noLevels: true }, 'planche_2pages');
    expect(auto.project.model.top.from).toBe('default');
    expect(doubts).toEqual(expect.arrayContaining(['top', 'heights']));
    expect(auto.sufficient).toBe(false);
  });

  it('sans alignement lu : les boîtes des bâtiments alignent les étages, garage sous la chambre retrouvé', () => {
    const { auto } = build({ noAlignment: true });
    const rows = deriveSheets(auto.project, 'fr').envelope;
    const over = rows.filter((r) => r.kind === 'floor' && r.boundary === 'unheated').reduce((s, r) => s + r.grossArea, 0);
    expect(over).toBeCloseTo(get('planche_A1_archicad').control.overUnheated, 1);
  });

  it('document vide ou incohérent : pas de plantage', () => {
    const empty: PlanDocument = { fileName: 'x.pdf', kind: 'pdf', sheets: [], storeysAligned: false, warnings: [], reading: documentFromTruth(get('planche_A1_archicad').truth).reading! };
    const r = buildAutoProject(empty, createEmptyProject('fr'), 'fr');
    expect(r.sufficient).toBe(false);
    expect(r.project.model.storeys).toHaveLength(0);
    const broken = documentFromTruth(get('planche_A1_archicad').truth);
    broken.sheets[0]!.detected.heatedEdges = broken.sheets[0]!.detected.heatedEdges!.slice(1);
    broken.sheets[1]!.detected.heatedOutline = [{ x: Number.NaN, y: 0 }, { x: 1, y: 1 }];
    broken.sheets[1]!.metresPerUnit = { value: 0, from: 'plan' };
    expect(() => buildAutoProject(broken, createEmptyProject('fr'), 'fr')).not.toThrow();
    expect(buildAutoProject(broken, createEmptyProject('fr'), 'fr').notes.join(' ')).toMatch(/murs/);
  });
});

// ───────────────────────────── Ancien chemin : IFC, DXF ─────────────────────────────

describe('document sans lecture de planche (DXF, IFC)', () => {
  it('passe par l’ancien chemin, résultat inchangé', async () => {
    const { doc } = await readCadDetailed(fixtureBytes('fixture_2storeys_aia.dxf'), 'fixture_2storeys_aia.dxf', 'dxf');
    expect(doc.sheets.length).toBeGreaterThan(0);
    expect(doc.reading).toBeUndefined();
    const auto = buildAutoProject(doc, createEmptyProject('fr'), 'fr');
    expect(auto.project.model).toEqual(modelFromDocument(doc, 'fr'));
    expect(auto.sufficient).toBe(false);
  });
});
