/**
 * Découpage des planches SYNTHÉTIQUES (tests/fixtures/pdf/planche) en vues, comparé à leur vérité *.truth.json :
 * genre, titre, rang, côté des façades, boîte de la vue et boîte du bâtiment (à une tolérance raisonnable), et une
 * feuille par plan d'étage avec ses pièces. Les autres vues ne deviennent pas des feuilles mais figurent dans
 * `doc.reading.views`.
 */
import { describe, expect, it } from 'vitest';
import type { ReadView, ViewKind } from '../../../src/core/reading';
import type { BBox, PlanDocument } from '../../../src/core/types';
import { METRES_PER_POINT } from '../../../src/readers/pdf';
import { fold } from '../../../src/semantics/labels';
import { readFixture } from './helpers';

interface FsLike {
  readFileSync(path: string | URL, encoding: 'utf8'): string;
}
const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as FsLike;
const PLANCHE_DIR = new URL('../../fixtures/pdf/planche/', import.meta.url);

interface TruthRoom {
  name: string;
  area_label: string | null;
  label_pt: [number, number] | null;
}
interface TruthView {
  kind: string;
  title: string | null;
  level?: number | null;
  name?: string | null;
  bbox_pt: [number, number, number, number];
  building_bbox_pt?: [number, number, number, number] | null;
  rooms?: TruthRoom[];
}
interface TruthPage {
  number: number;
  views: TruthView[];
}
interface PlancheTruth {
  scale_den: number;
  pages: TruthPage[];
}

function truth(name: string): PlancheTruth {
  return JSON.parse(fs.readFileSync(new URL(name.replace(/\.pdf$/, '.truth.json'), PLANCHE_DIR), 'utf8')) as PlancheTruth;
}

async function read(name: string): Promise<PlanDocument> {
  return (await readFixture(`planche/${name}`)).doc;
}

const KIND: Record<string, ViewKind> = {
  plan: 'floor-plan',
  'roof-plan': 'roof-plan',
  section: 'section',
  elevation: 'elevation',
  table: 'table',
  photo: 'photo',
  titleblock: 'title-block',
  north: 'north-arrow',
  notes: 'legend',
};

/** Côté d'une façade dans la vérité (« front », « rear », « N »…) → vocabulaire du contrat. */
const SIDE: Record<string, string> = { front: 'front', rear: 'back', side: 'side', N: 'north', S: 'south', E: 'east', W: 'west' };

const box = (b: readonly [number, number, number, number]): BBox => ({ minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] });

/** Part de la plus petite des deux boîtes couverte par l'autre. */
function cover(a: BBox, b: BBox): number {
  const w = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const h = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  const area = (x: BBox): number => (x.maxX - x.minX) * (x.maxY - x.minY);
  return (w * h) / Math.min(area(a), area(b));
}

/** Plus grand écart entre les bords de deux boîtes (pt). */
function edgeGap(a: BBox, b: BBox): number {
  return Math.max(Math.abs(a.minX - b.minX), Math.abs(a.minY - b.minY), Math.abs(a.maxX - b.maxX), Math.abs(a.maxY - b.maxY));
}

/** La vue lue qui correspond à une vue de la vérité : même genre, même page, la plus recouvrante. */
function matchView(views: readonly ReadView[], page: number, t: TruthView): ReadView | undefined {
  const kind = KIND[t.kind];
  const cands = views.filter((v) => v.page === page && v.kind === kind);
  return [...cands].sort((a, b) => cover(b.box, box(t.bbox_pt)) - cover(a.box, box(t.bbox_pt)))[0];
}

/** Vérifie les vues d'une planche titrée face à sa vérité. */
async function checkViews(name: string): Promise<void> {
  const doc = await read(name);
  const tr = truth(name);
  const views = doc.reading?.views ?? [];
  const tol = 0.3 / (tr.scale_den * METRES_PER_POINT);
  for (const page of tr.pages) {
    for (const t of page.views) {
      const v = matchView(views, page.number, t);
      expect(v, `${name} p${page.number} ${t.kind} « ${t.title ?? '—'} »`).toBeDefined();
      if (!v) continue;
      // Boîte : l'essentiel du dessin de la vue est dans la boîte lue, et inversement.
      expect(cover(v.box, box(t.bbox_pt)), `${v.id} boîte`).toBeGreaterThan(0.6);
      if (t.title && t.kind !== 'north') expect(fold(v.title ?? '')).toBe(fold(t.title));
      if (t.kind === 'plan') {
        expect(v.storeyRank).toBe(t.level);
        expect(v.confidence).toBeGreaterThanOrEqual(0.65);
      }
      if (t.kind === 'elevation' && t.name) expect(v.sides).toContain(SIDE[t.name]);
      // Boîte du bâtiment : à 0,3 m près quand elle est lue (plans d'étage : toujours lue sur ces planches).
      if (t.building_bbox_pt && (t.kind === 'plan' || v.buildingBox)) {
        expect(v.buildingBox, `${v.id} bâtiment`).not.toBeNull();
        expect(edgeGap(v.buildingBox!, box(t.building_bbox_pt))).toBeLessThan(tol);
      }
    }
  }
}

/** Une feuille par plan d'étage, dans l'ordre des rangs, avec ses pièces étiquetées et son emprise. */
async function checkSheets(name: string): Promise<void> {
  const doc = await read(name);
  const tr = truth(name);
  const mpp = tr.scale_den * METRES_PER_POINT;
  const plans = tr.pages.flatMap((p) => p.views.filter((v) => v.kind === 'plan').map((v) => ({ page: p.number, v })));
  plans.sort((a, b) => (a.v.level ?? 0) - (b.v.level ?? 0));
  expect(doc.sheets).toHaveLength(plans.length);
  doc.sheets.forEach((sheet, i) => {
    const { page, v } = plans[i]!;
    expect(sheet.role).toBe('floor-plan');
    expect(sheet.page).toBe(page);
    expect(sheet.storeyRank).toBe(v.level);
    const view = doc.reading!.views.find((x) => x.sheetId === sheet.id)!;
    expect(view).toBeDefined();
    expect(sheet.bbox).toEqual(view.box);
    const names = sheet.detected.rooms.map((r) => r.name);
    for (const r of v.rooms ?? []) if (r.label_pt) expect(names).toContain(r.name);
    // Pas de pièce venue d'une autre vue (niveau voisin, tableau, cartouche).
    const known = new Set((v.rooms ?? []).map((r) => r.name));
    expect(names.filter((n) => n !== '' && !known.has(n))).toEqual([]);
    const bb = box(v.building_bbox_pt!);
    expect(sheet.detected.footprintSize).toBeDefined();
    expect(sheet.detected.footprintSize!.width).toBeCloseTo((bb.maxX - bb.minX) * mpp, 1);
    expect(sheet.detected.footprintSize!.depth).toBeCloseTo((bb.maxY - bb.minY) * mpp, 1);
    // Les textes et traits de la feuille sont ceux de sa vue.
    for (const t of sheet.texts ?? []) expect(t.x >= view.box.minX - 40 && t.x <= view.box.maxX + 40).toBe(true);
  });
}

describe('planche A1 « Archicad » (trois plans dans un cadre de situation, treize vues)', () => {
  const name = 'planche_A1_archicad.pdf';
  it('retrouve les treize vues : genre, titre (« 1 » + « ER » en exposant), rang, côtés, boîtes', async () => {
    const doc = await read(name);
    expect(doc.reading!.views).toHaveLength(13);
    expect(doc.reading!.views.find((v) => v.storeyRank === 1)!.title).toBe('PLAN 1ER ÉTAGE');
    await checkViews(name);
  });

  it('une feuille par plan d’étage (rez-de-chaussée, 1er étage), la toiture et les coupes restent des vues', async () => {
    await checkSheets(name);
    const doc = await read(name);
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', '1er étage']);
    expect(doc.sheets.map((s) => s.id)).toEqual(['p1-v1', 'p1-v2']);
    const withSheet = doc.reading!.views.filter((v) => v.sheetId !== null).map((v) => v.kind);
    expect(withSheet).toEqual(['floor-plan', 'floor-plan']);
    // La terrasse est lue mais écartée : hors du bâtiment, jamais comptée.
    const terrasse = doc.sheets[0]!.detected.rooms.find((r) => r.name === 'Terrasse')!;
    expect(terrasse.exterior).toBe(true);
    expect(terrasse.heatedGuess).toBe('no');
  });

  it('aucun avertissement de niveaux non séparés ni de dessin lu en partie', async () => {
    const doc = await read(name);
    expect(doc.warnings.some((w) => /plusieurs niveaux|lu en partie|en partie/i.test(w))).toBe(false);
  });
});

describe('planche A2 allemande, titres AU-DESSUS des vues', () => {
  const name = 'planche_A2_de_titres_dessus.pdf';
  it('retrouve les vues, sous-sol compris (rang −1), façades nord et sud', async () => {
    await checkViews(name);
  });

  it('une feuille par niveau, dans l’ordre des rangs, avec l’emprise lue sur le contour', async () => {
    await checkSheets(name);
    const doc = await read(name);
    expect(doc.sheets.map((s) => s.storeyRank)).toEqual([-1, 0, 1]);
  });
});

describe('planche sur deux pages', () => {
  const name = 'planche_2pages.pdf';
  it('les vues des deux pages sont dans la lecture, chacune avec sa page', async () => {
    await checkViews(name);
    const doc = await read(name);
    expect(doc.reading!.views.filter((v) => v.page === 2).map((v) => v.kind).sort()).toEqual(['elevation', 'elevation', 'section', 'title-block']);
  });

  it('seule la page des plans donne des feuilles', async () => {
    await checkSheets(name);
  });
});

describe('planche sans titres de vues : repli', () => {
  const name = 'planche_sans_titres.pdf';
  it('le découpage voit deux plans sans titre, avec un doute, mais ne commande pas la page', async () => {
    const doc = await read(name);
    const plans = doc.reading!.views.filter((v) => v.kind === 'floor-plan');
    expect(plans).toHaveLength(2);
    for (const v of plans) {
      expect(v.title).toBeNull();
      expect(v.storeyRank).toBeNull();
      expect(v.confidence).toBeLessThan(0.65);
      // La vue ne commande pas la page, mais la lecture complète la rattache après coup à la feuille du chemin
      // existant qui couvre la même étendue (une feuille par vue) : sa géométrie et ses preuves s'y retrouvent.
      expect(v.sources).toContain('sheet-overlap');
      expect(doc.sheets.map((s) => s.id)).toContain(v.sheetId);
      expect(v.doubts.length).toBeGreaterThan(0);
    }
    expect(new Set(plans.map((v) => v.sheetId)).size).toBe(2);
  });

  it('chemin existant : deux plans séparés par la page entière, chacun avec ses pièces', async () => {
    const doc = await read(name);
    const tr = truth(name);
    expect(doc.sheets.map((s) => s.name)).toEqual(['Page 1 – plan 1', 'Page 1 – plan 2']);
    const plans = tr.pages[0]!.views.filter((v) => v.kind === 'plan');
    doc.sheets.forEach((s, i) => {
      const names = s.detected.rooms.map((r) => r.name);
      for (const r of plans[i]!.rooms ?? []) if (r.label_pt) expect(names).toContain(r.name);
    });
  });
});
