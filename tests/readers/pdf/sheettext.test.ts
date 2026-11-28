/**
 * Lecture de tout le texte des quatre planches SYNTHÉTIQUES (tests/fixtures/pdf/planche), comparée à leur vérité
 * *.truth.json. Les vues ne sont pas encore produites par l'analyse : elles sont construites ici depuis la vérité.
 */
import { describe, expect, it } from 'vitest';
import type { ElementType, MaterialKey, ReadView, ViewKind } from '../../../src/core/reading';
import { readSheetText, type SheetTextRead } from '../../../src/readers/pdf/sheettext';
import { split } from '../../semantics/lines';
import { fixtureBytes, readFixture } from './helpers';

/** Famille attendue des couches des planches synthétiques (table de référence écrite à la main). */
const MATERIAL_OF: Record<string, MaterialKey> = {
  'Béton': 'beton',
  'Isolation type EPS': 'eps',
  'Enduit de façade': 'enduit-facade',
  'Revêtement de sol': 'revetement-sol',
  'Chape': 'chape',
  'Isolation mousse PUR': 'pur',
  'Radier béton': 'beton-arme',
  'Isolation type XPS sous radier': 'xps',
  'Film PE': 'film',
  'Béton de propreté': 'beton-maigre',
  'Empierrement': 'empierrement',
  'Isolation acoustique': 'isolant',
  'Dalle béton': 'beton-arme',
  'Enduit plâtre': 'enduit-platre',
  'Isolation type EPS en sous-face': 'eps',
  'Étanchéité bitumineuse': 'etancheite',
  'Isolation type PIR': 'pir',
  'Innenputz': 'enduit-platre',
  'Kalksandstein': 'silico-calcaire',
  'WDVS EPS 032': 'eps',
  'Außenputz': 'enduit-facade',
  'Dachziegel': 'bardage',
  'Lattung': 'bois',
  'Holzfaserdämmplatte': 'fibre-bois',
  'Mineralwolle zw. Sparren': 'laine-minerale',
  'Dampfbremse': 'film',
  'Gipskarton': 'enduit-platre',
  'Bodenbelag': 'revetement-sol',
  'Estrich': 'chape',
  'Trittschalldämmung': 'isolant',
  'Wärmedämmung EPS': 'eps',
  'Stahlbeton': 'beton-arme',
  'Mineralwolle Kellerdecke': 'laine-minerale',
};

// ───────────────────────────── Vérité ─────────────────────────────

interface TView {
  kind: string;
  title?: string | null;
  level?: number;
  bbox_pt: [number, number, number, number];
  building_bbox_pt?: [number, number, number, number] | null;
  rooms?: { name: string; area_label: string | null; heated_true: boolean; kind?: string }[];
  dims?: { width_text?: string; height_text?: string }[];
  daylight_boxes?: { texts: string[] }[];
}
interface TPage {
  number: number;
  views: TView[];
  levels?: { label: string; value_m: number; altitude_m?: number; what?: string }[];
  storeys?: { level: number; floor_m: number; storey_height_m: number | null }[];
  compositions?: { title: string; element: string; to_unheated?: boolean; layers: { thickness_cm: number | null; text: string }[] }[];
  surface_table?: Record<string, number>;
  titleblock?: { object: string; phase: string; street: string; postcode_locality: string; date: string; format: string; scale: string; index: string };
  equipment?: { text: string; where: string }[];
}
interface Truth {
  north_azimuth_deg: number;
  building: { labelled_heated_area_by_level_m2?: Record<string, number> };
  pages: TPage[];
}

const KIND: Record<string, ViewKind> = { plan: 'floor-plan', 'roof-plan': 'roof-plan', section: 'section', elevation: 'elevation', table: 'table', titleblock: 'title-block', photo: 'photo', north: 'north-arrow', notes: 'legend' };

function truthOf(name: string): Truth {
  return JSON.parse(new TextDecoder('utf-8').decode(fixtureBytes(`planche/${name}.truth.json`))) as Truth;
}

/** Vues de la vérité, au format du contrat ; l'identifiant garde l'indice de la vue dans sa page. */
function viewsOf(truth: Truth): { views: ReadView[]; byId: Map<string, TView> } {
  const views: ReadView[] = [];
  const byId = new Map<string, TView>();
  for (const p of truth.pages) {
    p.views.forEach((v, k) => {
      const [x0, y0, x1, y1] = v.bbox_pt;
      const bb = v.building_bbox_pt;
      const id = `p${p.number}-${v.kind}${k}`;
      byId.set(id, v);
      views.push({
        id,
        page: p.number,
        kind: KIND[v.kind] ?? 'other',
        title: v.title ?? null,
        titleBox: null,
        storeyRank: v.kind === 'plan' ? (v.level ?? null) : null,
        sides: null,
        box: { minX: x0, minY: y0, maxX: x1, maxY: y1 },
        buildingBox: bb ? { minX: bb[0], minY: bb[1], maxX: bb[2], maxY: bb[3] } : null,
        sheetId: null,
        confidence: 1,
        sources: ['truth'],
        doubts: [],
      });
    });
  }
  return { views, byId };
}

/** « 1,385 » → 1.385 m ; « 60 » → 0,60 m ; « 885 » (88⁵) → 0,885 m. */
function truthDim(text: string): number {
  if (text.includes(',')) return Number(text.replace(',', '.'));
  return text.length === 3 ? Number(text) / 1000 : Number(text) / 100;
}

function num(text: string): number {
  return Number(/(\d+(?:,\d+)?)/.exec(text)![1]!.replace(',', '.'));
}

const ELEMENT: Record<string, ElementType> = { 'ground-floor': 'floor-on-ground', 'intermediate-floor': 'intermediate-floor', 'floor-over-unheated': 'floor-to-unheated', roof: 'roof' };

const NAMES = ['planche_A1_archicad', 'planche_A2_de_titres_dessus', 'planche_2pages', 'planche_sans_titres'] as const;

async function readOf(name: string): Promise<{ s: SheetTextRead; truth: Truth; views: ReadView[]; byId: Map<string, TView> }> {
  const { details } = await readFixture(`planche/${name}.pdf`);
  const truth = truthOf(name);
  const { views, byId } = viewsOf(truth);
  return { s: readSheetText(details.raw, views, { lang: 'fr' }), truth, views, byId };
}

// ───────────────────────────── Comparaisons ─────────────────────────────

describe.each(NAMES)('planche %s', (name) => {
  it('cartouche : objet, phase, adresse du projet, date, format, échelle, indice', async () => {
    const { s, truth } = await readOf(name);
    const t = truth.pages.find((p) => p.titleblock)!.titleblock!;
    const tb = s.titleBlock!;
    const [postcode, ...loc] = t.postcode_locality.split(' ');
    expect(tb.project).toBe(t.object);
    expect(tb.phase).toBe(t.phase);
    expect(tb.street).toBe(t.street);
    expect(tb.postcode).toBe(postcode);
    expect(tb.locality).toBe(loc.join(' '));
    expect(tb.date).toBe(t.date);
    expect(tb.year).toBe(Number(t.date.slice(-4)));
    expect(tb.format).toBe(t.format);
    expect(tb.scaleDen).toBe(Number(t.scale.split(/[:/]/)[1]));
    expect(tb.index).toBe(t.index);
    expect(tb.buildingType!.value).toBe('EFH');
    expect(tb.dwellings!.value).toBe(1);
    expect(tb.occasion).toMatchObject({ value: 'new', doubt: null });
    // Les autres adresses sont gardées, chacune sous son intitulé.
    const under = s.titleBlockDetails!.addresses.map((a) => a.under);
    expect(under).toEqual(expect.arrayContaining(['owner', 'commune', 'architect']));
  });

  it('nord : azimut du haut de la feuille', async () => {
    const { s, truth } = await readOf(name);
    expect(s.north).not.toBeNull();
    const d = Math.abs(((s.north!.sheetUpAzimuth - truth.north_azimuth_deg + 540) % 360) - 180);
    expect(d).toBeLessThan(1);
    // Marge au secteur bien lue : question seulement près d'une limite.
    expect(s.north!.confidence >= 0.85).toBe(s.north!.marginDeg > 5);
  });

  it('pièces et surfaces inscrites, par plan d’étage', async () => {
    const { s, views, byId } = await readOf(name);
    for (const v of views.filter((x) => x.kind === 'floor-plan')) {
      const truthRooms = byId.get(v.id)!.rooms!.filter((r) => r.area_label !== null);
      const read = s.rooms[v.id] ?? [];
      const key = (n: string, a: number): string => `${n}|${a.toFixed(2)}`;
      expect(read.map((r) => key(r.name, r.statedArea)).sort(), v.id).toEqual(truthRooms.map((r) => key(r.name, num(r.area_label!))).sort());
      for (const r of read) {
        const t = truthRooms.find((x) => x.name === r.name)!;
        if (r.outsideEnvelope) expect(t.heated_true, r.name).toBe(false);
        if (r.heatedGuess === 'yes') expect(t.heated_true, r.name).toBe(true);
        if (r.heatedGuess === 'ask') expect(r.doubt, r.name).not.toBeNull();
      }
    }
  });

  it('paires de cotes de baies par plan d’étage', async () => {
    const { s, views, byId } = await readOf(name);
    for (const v of views.filter((x) => x.kind === 'floor-plan')) {
      const expected = (byId.get(v.id)!.dims ?? []).filter((d) => d.width_text && d.height_text).map((d) => `${truthDim(d.width_text!).toFixed(3)}/${truthDim(d.height_text!).toFixed(3)}`).sort();
      const read = s.openingPairs.filter((p) => p.viewId === v.id).map((p) => `${p.width.toFixed(3)}/${p.height.toFixed(3)}`).sort();
      expect(read, v.id).toEqual(expected);
    }
    // Aucune paire hors des plans et des façades.
    const kinds = new Map(views.map((v) => [v.id, v.kind]));
    expect(s.openingPairs.every((p) => p.viewId === null || kinds.get(p.viewId) === 'floor-plan' || kinds.get(p.viewId) === 'elevation')).toBe(true);
  });

  it('niveaux finis, hauteurs d’étage, sommet', async () => {
    const { s, truth } = await readOf(name);
    const storeys = truth.pages.find((p) => p.storeys)?.storeys;
    if (!storeys) {
      expect(s.levels).toBeNull();
      return;
    }
    const lv = s.levels!;
    expect(lv.floors.map((f) => f.rel)).toEqual(storeys.map((x) => x.floor_m));
    const heights = storeys.slice(0, -1).map((x) => x.storey_height_m);
    expect(lv.storeyHeights).toEqual(heights);
    expect(lv.floors.every((f) => f.confidence >= 0.65)).toBe(true);
    const levels = truth.pages.flatMap((p) => p.levels ?? []);
    // Sommet : la cote nommée acrotère ou faîtage, sinon (vérité sans légende) la plus haute.
    const top = levels.find((l) => /acrot|first/i.test(`${l.what ?? ''} ${l.label}`)) ?? [...levels].sort((a, b) => b.value_m - a.value_m)[0]!;
    expect(lv.top?.rel).toBe(top.value_m);
    expect(lv.checks.failed).toBe(0);
    const eaves = levels.find((l) => /traufe|égout/i.test(l.label));
    expect(lv.eaves).toBe(eaves ? eaves.value_m : null);
  });

  it('compositions : rôle et épaisseurs de l’intérieur vers l’extérieur', async () => {
    const { s, truth } = await readOf(name);
    const comps = truth.pages.flatMap((p) => p.compositions ?? []);
    expect(s.compositions).toHaveLength(comps.length);
    for (const c of comps) {
      const element: ElementType = c.element === 'wall' ? (c.to_unheated ? 'wall-to-unheated' : 'external-wall') : ELEMENT[c.element]!;
      const written = c.layers.map((l) => l.thickness_cm);
      const expected = element === 'roof' ? [...written].reverse() : written;
      const found = s.compositions.find((x) => x.element === element && x.layers.map((l) => l.thicknessCm).join('|') === expected.join('|'));
      expect(found, `${c.title} ${element} ${expected.join('/')}`).toBeDefined();
      // Famille de matériau de chaque couche, comparée à une table écrite à la main (indépendante de materialKey).
      const texts = c.layers.map((l) => l.text);
      const mats = (element === 'roof' ? [...texts].reverse() : texts).map((t) => MATERIAL_OF[t]);
      expect(found!.layers.map((l) => l.material), `${c.title}`).toEqual(mats);
    }
  });

  it('tableau des surfaces, encadrés d’éclairement, équipements', async () => {
    const { s, truth, views, byId } = await readOf(name);
    const table = truth.pages.find((p) => p.surface_table)?.surface_table;
    if (table) {
      expect(s.siteAreas).toMatchObject({
        terrain: { value: table.terrain_m2 },
        sealed: { value: table.sealed_m2, max: table.sealed_max_m2 },
        footprint: { value: table.footprint_m2, max: table.footprint_max_m2 },
        grossFloor: { value: table.gross_floor_m2, max: table.gross_floor_max_m2 },
      });
    } else expect(s.siteAreas).toBeNull();

    for (const v of views.filter((x) => x.kind === 'floor-plan')) {
      const boxes = byId.get(v.id)!.daylight_boxes ?? [];
      const read = s.glazing.filter((g) => g.viewId === v.id);
      expect(read.map((g) => g.glazedArea).sort(), v.id).toEqual(boxes.map((b) => num(b.texts[0]!)).sort());
      expect(read.map((g) => g.floorArea).sort(), v.id).toEqual(boxes.map((b) => num(b.texts[1]!)).sort());
    }

    const eq = truth.pages.flatMap((p) => p.equipment ?? []);
    const kindOf: Record<string, string> = { PAC: 'heat-pump', Boiler: 'hot-water-tank', VMC: 'ventilation-unit' };
    expect([...new Set(s.equipment.map((e) => e.kind))].sort()).toEqual([...new Set(eq.map((e) => kindOf[e.text]!))].sort());
    if (eq.some((e) => e.text === 'PAC' && /extérieur/.test(e.where))) {
      expect(s.equipment.some((e) => e.kind === 'heat-pump' && e.outside === true)).toBe(true);
      expect(s.systems!.heatGenerator).toMatchObject({ value: 'heat-pump-air' });
    } else expect(s.systems!.heatGenerator).toBeNull();
  });
});

describe('planche A1 : sommes par niveau et doutes', () => {
  it('surface inscrite des pièces dans l’enveloppe, par niveau', async () => {
    const { s, truth, views } = await readOf('planche_A1_archicad');
    const expected = truth.building.labelled_heated_area_by_level_m2!;
    for (const v of views.filter((x) => x.kind === 'floor-plan')) {
      const sum = (s.rooms[v.id] ?? []).filter((r) => !r.outsideEnvelope).reduce((a, r) => a + r.statedArea, 0);
      expect(sum).toBeCloseTo(expected[String(v.storeyRank)]!, 2);
    }
  });

  it('une seule question par sujet de doute réel, et des textes sans clé ni variable non remplacée', async () => {
    const { s } = await readOf('planche_A1_archicad');
    for (const d of s.doubts) expect(d.text).not.toMatch(/read\.|\{\w+\}/);
    // Le plancher au-dessus du garage est recoupé par le garage du plan : pas de question de type.
    expect(s.compositions.find((c) => c.element === 'floor-to-unheated')!.doubt ?? null).toBeNull();
    // Le nord est à 2,5° d'une limite de secteur : question.
    expect(s.doubts.some((d) => d.topic === 'north')).toBe(true);
  });

  it('pure : les pages et les vues reçues ne sont pas modifiées, deux lectures sont égales', async () => {
    const { details } = await readFixture('planche/planche_A1_archicad.pdf');
    const { views } = viewsOf(truthOf('planche_A1_archicad'));
    const textsBefore = JSON.stringify(details.raw[0]!.texts);
    const viewsBefore = JSON.stringify(views);
    const a = readSheetText(details.raw, views, { lang: 'de' });
    const b = readSheetText(details.raw, views, { lang: 'de' });
    expect(a).toEqual(b);
    expect(JSON.stringify(details.raw[0]!.texts)).toBe(textsBefore);
    expect(JSON.stringify(views)).toBe(viewsBefore);
    expect(a.doubts.some((d) => /Sektorgrenze/.test(d.text))).toBe(true);
  });

  it('même lecture quand l’export découpe les textes par mot ou par caractère', async () => {
    const { details } = await readFixture('planche/planche_A1_archicad.pdf');
    const { views } = viewsOf(truthOf('planche_A1_archicad'));
    const summary = (s: SheetTextRead): string =>
      JSON.stringify({
        comps: s.compositions.map((c) => `${c.element}:${c.layers.map((l) => l.thicknessCm).join('/')}`).sort(),
        rooms: Object.fromEntries(Object.entries(s.rooms).map(([k, rs]) => [k, rs.map((r) => `${r.name}:${r.statedArea}`).sort()])),
        floors: s.levels?.floors.map((f) => f.rel),
        top: s.levels?.top?.rel,
        pairs: s.openingPairs.map((p) => `${p.viewId}:${p.width}/${p.height}`).sort(),
        tb: [s.titleBlock?.postcode, s.titleBlock?.year, s.titleBlock?.index, s.titleBlock?.scaleDen],
        site: s.siteAreas?.footprint,
        north: s.north?.sheetUpAzimuth,
      });
    const ref = summary(readSheetText(details.raw, views, { lang: 'fr' }));
    for (const mode of ['word', 'char'] as const) {
      const pages = details.raw.map((p) => ({ ...p, texts: p.texts.flatMap((t) => split(t, mode)) }));
      expect(summary(readSheetText(pages, views, { lang: 'fr' })), mode).toBe(ref);
    }
  });

  it('sans vues : la lecture se fait sur la page entière', async () => {
    const { details } = await readFixture('planche/planche_A1_archicad.pdf');
    const s = readSheetText(details.raw, [], { lang: 'fr' });
    expect(s.titleBlock!.postcode).toBe('L-0000');
    expect(s.rooms['p1']!.length).toBeGreaterThanOrEqual(15);
    expect(s.compositions.length).toBeGreaterThanOrEqual(5);
  });
});
