/**
 * Extraction allégée d'une page PDF : trames de micro-traits et hachures retirées de `segs` et résumées en zones,
 * remplissages, zones de découpe, couleur et découpe de chaque trait.
 *
 * 1. Critères purs de hatch.ts, un par un, sur des traits fabriqués.
 * 2. Planches d'autorisation SYNTHÉTIQUES (tests/fixtures/pdf/planche, données inventées) face à leur vérité
 *    (*.truth.json : nombre de micro-traits et de traits de hachure, murs, pièces, toiture, cadres de vues).
 * 3. Planches d'essai plus anciennes : l'allègement n'y retire rien (non-régression).
 */
import { describe, expect, it } from 'vitest';
import {
  boxArea,
  directionBin,
  groupHatches,
  hatchOf,
  HATCH_MAX_CLIP_SHARE,
  isDisjointRun,
  isMicroExtent,
  isStipple,
  MIN_STIPPLE,
  PATH_HATCH_MAX_SPACING,
  regularStep,
  sameInk,
  SMALL_PT,
  stippleZones,
} from '../../../src/readers/pdf/hatch';
import type { ClipStrokeStat } from '../../../src/readers/pdf/hatch';
import { extractPage } from '../../../src/readers/pdf/extract';
import type { ExtractOptions } from '../../../src/readers/pdf/extract';
import { createPdfEngine } from '../../../src/readers/pdf/init-node';
import type { ClipZone, RawBox, RawPage, RawSeg } from '../../../src/readers/pdf/raw';
import { METRES_PER_POINT } from '../../../src/readers/pdf/raw';
import { fixtureBytes, seg } from './helpers';

// ───────────────────────────── Outils ─────────────────────────────

const PAGE_AREA = 1000 * 1000;
const box = (minX: number, minY: number, maxX: number, maxY: number): RawBox => ({ minX, minY, maxX, maxY });
const zone = (id: number, b: RawBox, parent = 0): ClipZone => ({ id, parent, bbox: b, rect: true, ops: 0 });

/** Traits parallèles de direction `deg` (repère de la feuille), de pas `step`, coupés à la longueur `len`. */
function family(deg: number, step: number, n: number, len: number, extra: Partial<RawSeg> = {}, ox = 100, oy = 100): RawSeg[] {
  const a = (deg * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const out: RawSeg[] = [];
  for (let k = 0; k < n; k++) {
    const cx = ox - dy * step * k;
    const cy = oy + dx * step * k;
    out.push(seg(cx, cy, cx + dx * len, cy + dy * len, 0.28, extra));
  }
  return out;
}

const engine = createPdfEngine();
const pages = new Map<string, Promise<RawPage[]>>();

/** Pages extraites d'un PDF d'essai (une fois par fichier et par jeu d'options). */
function extracted(name: string, options: ExtractOptions = {}): Promise<RawPage[]> {
  const key = `${name} ${JSON.stringify(options)}`;
  let p = pages.get(key);
  if (!p) {
    p = (async () => {
      const opened = await engine.open(new Uint8Array(fixtureBytes(name)));
      try {
        const out: RawPage[] = [];
        for (let n = 1; n <= opened.doc.numPages; n++) out.push(await extractPage(await opened.doc.getPage(n), engine.ops, options));
        return out;
      } finally {
        await opened.close();
      }
    })();
    pages.set(key, p);
  }
  return p;
}

interface Counts {
  hatch_lines: number;
  stipple_traits: number;
  tile_lines: number;
  clip_paths: number;
}
interface PlancheRoom {
  name: string;
  area_true_m2: number;
  label_pt: [number, number] | null;
  poly_pt: [number, number][];
}
interface PlancheView {
  kind: string;
  title: string | null;
  bbox_pt: [number, number, number, number];
  clip_pt?: [number, number, number, number];
  outline_pt?: [number, number][];
  roof_fill_bbox_pt?: [number, number, number, number];
  rooms?: PlancheRoom[];
}
interface PlancheTruth {
  scale_den: number;
  pages: { counts: Counts; views: PlancheView[] }[];
}

function truthOf(name: string): PlancheTruth {
  return JSON.parse(new TextDecoder('utf-8').decode(fixtureBytes(name.replace(/\.pdf$/, '.truth.json')))) as PlancheTruth;
}

const inside = (b: RawBox, x: number, y: number, tol = 0): boolean => x >= b.minX - tol && x <= b.maxX + tol && y >= b.minY - tol && y <= b.maxY + tol;

/** Points d'échantillon le long du contour, décalés de `inset` (pt) vers l'intérieur (contour rectangulaire ou en L). */
function insetSamples(outline: readonly [number, number][], inset: number, every: number): [number, number][] {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of outline) {
    cx += x / outline.length;
    cy += y / outline.length;
  }
  const out: [number, number][] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let nx = -(b[1] - a[1]) / len;
    let ny = (b[0] - a[0]) / len;
    // Normale vers l'intérieur : du côté du centre (suffisant pour les contours d'essai, convexes ou en L).
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    if (nx * (cx - mx) + ny * (cy - my) < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let t = every / 2; t < len; t += every) out.push([a[0] + ((b[0] - a[0]) * t) / len + nx * inset, a[1] + ((b[1] - a[1]) * t) / len + ny * inset]);
  }
  return out;
}

const PLANCHES = ['planche/planche_A1_archicad.pdf', 'planche/planche_A2_de_titres_dessus.pdf', 'planche/planche_2pages.pdf', 'planche/planche_sans_titres.pdf'];

// ───────────────────────────── 1. Critères purs ─────────────────────────────

describe('critères de trame et de hachure (hatch.ts)', () => {
  it('un sous-tracé de moins de 3 pt de diagonale est un micro-trait', () => {
    expect(isMicroExtent(0.15, 0.1)).toBe(true);
    expect(isMicroExtent(2, 2)).toBe(true); // diagonale 2,83
    expect(isMicroExtent(SMALL_PT, 0)).toBe(false);
    expect(isMicroExtent(2.2, 2.2)).toBe(false); // diagonale 3,11
  });

  it('les directions sont rangées par classes de 5°, sans sens', () => {
    expect(directionBin({ x0: 0, y0: 0, x1: 10, y1: 0 })).toBe(0);
    expect(directionBin({ x0: 10, y0: 0, x1: 0, y1: 0 })).toBe(0);
    expect(directionBin({ x0: 0, y0: 0, x1: 10, y1: 10 })).toBe(45);
    expect(directionBin({ x0: 0, y0: 0, x1: -10, y1: 10 })).toBe(135);
    expect(directionBin({ x0: 0, y0: 0, x1: 10, y1: 10.5 })).toBe(45);
    expect(directionBin({ x0: 0, y0: 0, x1: 0, y1: -7 })).toBe(90);
  });

  it('pas régulier : multiples du pas acceptés (droites manquantes), écarts quelconques refusés', () => {
    expect(regularStep(family(45, 1.7, 10, 8), 45)).toBeCloseTo(1.7, 1);
    const holes = family(0, 2, 12, 8).filter((_, k) => k !== 3 && k !== 7);
    expect(regularStep(holes, 0)).toBeCloseTo(2, 1);
    const rnd = [0, 1.1, 3.9, 4.6, 8.8, 9.1, 13.7, 15.2].map((o) => seg(0, o, 10, o, 0.28));
    expect(regularStep(rnd, 0)).toBeNull();
    // Deux droites seulement : pas de pas mesurable.
    expect(regularStep([seg(0, 0, 9, 0, 0.28), seg(0, 2, 9, 2, 0.28), seg(3, 2, 6, 2, 0.28)], 0)).toBeNull();
    // Traits superposés (pas < 0,15 pt) : pas une hachure.
    expect(regularStep(family(0, 0.1, 10, 8), 0)).toBeNull();
  });

  it('hachure simple, hachure croisée, et ce qui n’en est pas', () => {
    const simple = hatchOf(family(45, 1.7, 12, 9));
    expect(simple?.angles).toEqual([45]);
    expect(simple?.spacing).toBeCloseTo(1.7, 1);
    const crossed = hatchOf([...family(45, 2.4, 10, 9), ...family(135, 2.4, 10, 9)]);
    expect(crossed?.angles.slice().sort((a, b) => a - b)).toEqual([45, 135]);
    // Trop peu de traits.
    expect(hatchOf(family(45, 1.7, 7, 9))).toBeNull();
    // Trois directions à parts égales : un symbole, pas une hachure.
    expect(hatchOf([...family(0, 2, 4, 9), ...family(60, 2, 4, 9), ...family(120, 2, 4, 9)])).toBeNull();
    // Un trait étranger sur dix-huit reste toléré (≥ 90 % dans les directions retenues).
    expect(hatchOf([...family(45, 1.7, 17, 9), seg(0, 0, 3, 7, 0.28)])?.angles).toEqual([45]);
  });

  it('un tracé de traits disjoints n’est pas une polyligne', () => {
    expect(isDisjointRun(family(0, 2, 12, 8))).toBe(true);
    const poly: RawSeg[] = [];
    for (let k = 0; k < 12; k++) poly.push(seg(k * 2, 0, (k + 1) * 2, k % 2 ? 0 : 2, 0.28));
    expect(isDisjointRun(poly)).toBe(false);
  });

  it('encre homogène : même épaisseur, même couleur, même pointillé', () => {
    expect(sameInk(family(45, 2, 10, 8, { color: 0x333333 }))).toBe(true);
    expect(sameInk([...family(45, 2, 9, 8), seg(0, 0, 9, 9, 0.5)])).toBe(false);
    expect(sameInk([...family(45, 2, 9, 8), seg(0, 0, 9, 9, 0.28, { color: 0xff0000 })])).toBe(false);
    expect(sameInk([...family(45, 2, 9, 8), seg(0, 0, 9, 9, 0.28, { dash: true })])).toBe(false);
    expect(sameInk([])).toBe(false);
  });

  it('trame : sous une découpe de taille moyenne, au moins 500 micro-traits faisant 80 % des traits', () => {
    const z = zone(3, box(0, 0, 400, 50));
    const stat = (all: number, micro: number): ClipStrokeStat => ({ all, micro, box: box(1, 1, 399, 49), color: 0x595959 });
    expect(isStipple(z, stat(600, 600), PAGE_AREA)).toBe(true);
    expect(isStipple(z, stat(MIN_STIPPLE - 1, MIN_STIPPLE - 1), PAGE_AREA)).toBe(false);
    expect(isStipple(z, stat(1000, 700), PAGE_AREA)).toBe(false); // 70 % seulement
    expect(isStipple(zone(0, box(0, 0, 1000, 1000)), stat(9000, 9000), PAGE_AREA)).toBe(false); // la page
    expect(isStipple(zone(4, box(0, 0, 800, 800)), stat(9000, 9000), PAGE_AREA)).toBe(false); // 64 % de la page
    const zones = stippleZones([zone(0, box(0, 0, 1000, 1000)), zone(1, box(0, 0, 10, 10)), z, z], [undefined, stat(20, 20), undefined, stat(800, 790)], PAGE_AREA);
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({ clip: 3, count: 790, color: 0x595959 });
  });

  it('regroupement sous découpe : hachure retirée, contour gardé, bords de remplissage jamais touchés', () => {
    const clips = [zone(0, box(0, 0, 1000, 1000)), zone(1, box(95, 95, 125, 125))];
    const hatch = family(45, 1.7, 20, 9, { clip: 1 });
    const outline = [seg(95, 95, 125, 95, 0.71), seg(125, 95, 125, 125, 0.71)]; // hors découpe (clip 0)
    const fillEdges = family(45, 1.7, 10, 9, { clip: 1, fill: true, stroke: false, w: 0 });
    const g = groupHatches([...outline, ...hatch, ...fillEdges], clips, [[], [[[95, 95], [125, 95], [125, 125], [95, 125]]]], PAGE_AREA);
    expect(g.zones).toHaveLength(1);
    expect(g.zones[0]).toMatchObject({ clip: 1, source: 'clip', angles: [45], count: 20 });
    expect(g.zones[0]!.rings[0]).toHaveLength(4);
    expect(g.count).toBe(20);
    expect([...g.drop].slice(0, 2)).toEqual([0, 0]);
    expect([...g.drop].slice(22).every((d) => d === 0)).toBe(true);
  });

  it('pas de regroupement sous une grande découpe, ni avec des épaisseurs mêlées', () => {
    const big = [zone(0, box(0, 0, 1000, 1000)), zone(1, box(0, 0, 300, 300))];
    expect(boxArea(big[1]!.bbox)).toBeGreaterThan(HATCH_MAX_CLIP_SHARE * PAGE_AREA);
    // Un tracé par trait : seul le critère « sous découpe » peut jouer.
    const each = family(45, 1.7, 20, 9, { clip: 1 }).map((s, i) => ({ ...s, pid: i }));
    expect(groupHatches(each, big, [], PAGE_AREA).count).toBe(0);
    expect(groupHatches(each, [big[0]!, zone(1, box(95, 95, 125, 125))], [], PAGE_AREA).count).toBe(20);
    const small = [zone(0, box(0, 0, 1000, 1000)), zone(1, box(95, 95, 125, 125))];
    const mixed = [...family(45, 1.7, 10, 9, { clip: 1 }), ...family(45, 1.7, 10, 9, { clip: 1, w: 0.5 }, 100, 140)].map((s, i) => ({ ...s, pid: i }));
    expect(groupHatches(mixed, small, [], PAGE_AREA).count).toBe(0);
  });

  it('repli sans découpe : une hachure dense d’un seul tracé est regroupée, pas des marches d’escalier', () => {
    const clips = [zone(0, box(0, 0, 1000, 1000))];
    const dense = family(135, 2.2, 30, 10, { pid: 7 });
    const g = groupHatches(dense, clips, [], PAGE_AREA);
    expect(g.zones).toHaveLength(1);
    expect(g.zones[0]).toMatchObject({ source: 'path', angles: [135], count: 30, clip: 0 });
    expect(g.zones[0]!.rings[0]).toHaveLength(4);
    // Douze marches de 0,25 m au 1/100 (7,1 pt) : même structure, mais pas trop large pour une hachure.
    const stairs = family(0, 7.1, 12, 28, { pid: 8 });
    expect(7.1).toBeGreaterThan(PATH_HATCH_MAX_SPACING);
    expect(groupHatches(stairs, clips, [], PAGE_AREA).count).toBe(0);
    // Trop peu de traits.
    expect(groupHatches(family(135, 2.2, 11, 10, { pid: 9 }), clips, [], PAGE_AREA).count).toBe(0);
  });
});

// ───────────────────────────── 2. Planches synthétiques ─────────────────────────────

describe('planches synthétiques : allègement face à la vérité', () => {
  for (const name of PLANCHES) {
    it(`${name} : micro-traits de trame et traits de hachure retirés comme dans la vérité`, async () => {
      const raw = await extracted(name);
      const truth = truthOf(name);
      expect(raw).toHaveLength(truth.pages.length);
      raw.forEach((p, i) => {
        const c = truth.pages[i]!.counts;
        expect(p.truncated).toBe(false);
        // Trames : tous les micro-traits du pointillé de terrain, rien d'autre.
        expect(p.lightening.stippleSegs).toBeGreaterThanOrEqual(c.stipple_traits * 0.99);
        expect(p.lightening.stippleSegs).toBeLessThanOrEqual(c.stipple_traits * 1.01);
        expect(p.stipples.length > 0).toBe(c.stipple_traits > 0);
        expect(p.stipples.reduce((n, z) => n + z.count, 0)).toBe(p.lightening.stippleSegs);
        // Hachures (et carrelage, empierrement) : presque toutes ; les découpes de moins de huit traits restent.
        const hatchTruth = c.hatch_lines + c.tile_lines;
        expect(p.lightening.hatchSegs).toBeGreaterThanOrEqual(hatchTruth * 0.97);
        expect(p.lightening.hatchSegs).toBeLessThanOrEqual(hatchTruth);
        expect(p.hatches.reduce((n, z) => n + z.count, 0)).toBe(p.lightening.hatchSegs);
        // Le bilan tombe juste : traits tracés rencontrés = gardés + retirés.
        const keptStrokes = p.segs.filter((s) => s.stroke).length;
        expect(keptStrokes + p.lightening.stippleSegs + p.lightening.hatchSegs).toBe(p.lightening.rawStrokeSegs);
        // Une découpe par chemin de découpe du générateur (plus la page).
        expect(p.clips).toHaveLength(c.clip_paths + 1);
      });
    });
  }

  it('la planche A1 n’est pas tronquée même avec un plafond abaissé à 60 000 traits', async () => {
    const [lite] = await extracted('planche/planche_A1_archicad.pdf', { maxSegments: 60_000 });
    const [full] = await extracted('planche/planche_A1_archicad.pdf', { maxSegments: 60_000, lighten: false });
    expect(full!.truncated).toBe(true); // sans allègement, le plafond est atteint…
    expect(full!.segs.length).toBeLessThan(61_000);
    expect(lite!.truncated).toBe(false); // … avec, la page est lue entière
    const [ref] = await extracted('planche/planche_A1_archicad.pdf');
    expect(lite!.segs).toEqual(ref!.segs);
  });

  it('la planche allemande A2 (135 000 micro-traits) n’est pas tronquée à 60 000 traits', async () => {
    const [lite] = await extracted('planche/planche_A2_de_titres_dessus.pdf', { maxSegments: 60_000 });
    expect(lite!.truncated).toBe(false);
    expect(lite!.lightening.rawStrokeSegs).toBeGreaterThan(130_000);
    expect(lite!.segs.length).toBeLessThan(2_000);
  });

  it('allègement = retrait seulement : les traits gardés sont, dans l’ordre, ceux de la lecture sans allègement', async () => {
    for (const name of PLANCHES) {
      const lite = await extracted(name);
      const full = await extracted(name, { lighten: false, maxSegments: 2_000_000 });
      lite.forEach((p, i) => {
        const all = full[i]!.segs;
        let j = 0;
        for (const s of p.segs) {
          while (j < all.length && all[j] !== undefined && !sameSeg(all[j]!, s)) j++;
          expect(j).toBeLessThan(all.length);
          j++;
        }
        expect(all.length - p.segs.length).toBe(p.lightening.stippleSegs + p.lightening.hatchSegs);
        // Les bords de remplissage restent tous.
        expect(p.segs.filter((s) => s.fill).length).toBe(all.filter((s) => s.fill).length);
      });
    }
  });

  it('A1 : les hachures regroupées recouvrent les murs extérieurs des trois plans', async () => {
    const [p] = await extracted('planche/planche_A1_archicad.pdf');
    const truth = truthOf('planche/planche_A1_archicad.pdf');
    const k = 1 / (METRES_PER_POINT * truth.scale_den); // points par mètre de bâtiment
    const plans = truth.pages[0]!.views.filter((v) => v.kind === 'plan' && v.outline_pt);
    expect(plans).toHaveLength(2);
    for (const v of plans) {
      // Bande d'isolant (0,10 m sous la face extérieure) et cœur porteur (0,30 m).
      for (const inset of [0.1, 0.3]) {
        const pts = insetSamples(v.outline_pt!, inset * k, 0.5 * k);
        const covered = pts.filter(([x, y]) => p!.hatches.some((h) => inside(h.bbox, x, y, 0.3))).length;
        // Les baies coupent le mur : quelques points tombent dans une ouverture.
        expect(covered / pts.length).toBeGreaterThan(0.75);
      }
    }
    // Béton en hachure simple, isolant en hachure croisée, au même trait fin.
    const walls = p!.hatches.filter((h) => Math.abs(h.width - 0.28) < 0.02);
    expect(walls.some((h) => h.angles.length === 1)).toBe(true);
    expect(walls.some((h) => h.angles.length === 2)).toBe(true);
    for (const h of walls) {
      expect(h.spacing).toBeGreaterThan(1);
      expect(h.spacing).toBeLessThan(3);
      expect(h.source).toBe('clip');
      expect(h.rings.length).toBeGreaterThan(0);
    }
  });

  it('A1 : chaque pièce a son remplissage, d’aire égale à la surface vraie (1 %)', async () => {
    const [p] = await extracted('planche/planche_A1_archicad.pdf');
    const truth = truthOf('planche/planche_A1_archicad.pdf');
    const m2 = (METRES_PER_POINT * truth.scale_den) ** 2;
    const rooms = truth.pages[0]!.views.flatMap((v) => (v.kind === 'plan' ? (v.rooms ?? []) : []));
    expect(rooms.length).toBeGreaterThan(12);
    for (const r of rooms) {
      const [cx, cy] = r.poly_pt.reduce((a, q) => [a[0] + q[0] / r.poly_pt.length, a[1] + q[1] / r.poly_pt.length], [0, 0]);
      const hit = p!.fills.find((f) => f.alpha === 1 && inside(f.bbox, cx, cy) && Math.abs(f.area * m2 - r.area_true_m2) <= 0.01 * r.area_true_m2);
      expect(hit, r.name).toBeDefined();
      expect(hit!.rings.length).toBeGreaterThan(0);
    }
  });

  it('A1 : la toiture est un remplissage qui couvre l’emprise du bâtiment', async () => {
    const [p] = await extracted('planche/planche_A1_archicad.pdf');
    const roofView = truthOf('planche/planche_A1_archicad.pdf').pages[0]!.views.find((v) => v.kind === 'roof-plan')!;
    const [x0, y0, x1, y1] = roofView.roof_fill_bbox_pt!;
    const roof = p!.fills.find((f) => Math.abs(f.bbox.minX - x0) < 1 && Math.abs(f.bbox.minY - y0) < 1 && Math.abs(f.bbox.maxX - x1) < 1 && Math.abs(f.bbox.maxY - y1) < 1);
    expect(roof).toBeDefined();
    expect(roof!.area).toBeCloseTo((x1 - x0) * (y1 - y0), -1);
    expect(roof!.stroked).toBe(true);
  });

  it('A1 : les cadres des trois plans sont des découpes rectangulaires, et chaque trait connaît la sienne', async () => {
    const [p] = await extracted('planche/planche_A1_archicad.pdf');
    const truth = truthOf('planche/planche_A1_archicad.pdf');
    const frames = truth.pages[0]!.views.filter((v) => v.kind === 'plan' || v.kind === 'roof-plan');
    expect(frames).toHaveLength(3);
    for (const v of frames) {
      const [x0, y0, x1, y1] = v.bbox_pt;
      const clip = p!.clips.find((c) => c.rect && Math.abs(c.bbox.minX - x0) < 0.5 && Math.abs(c.bbox.minY - y0) < 0.5 && Math.abs(c.bbox.maxX - x1) < 0.5 && Math.abs(c.bbox.maxY - y1) < 0.5);
      expect(clip, v.title ?? v.kind).toBeDefined();
      expect(clip!.parent).toBe(0);
      expect(clip!.ops).toBeGreaterThan(20);
      // Les traits peints sous ce cadre le touchent presque tous ; le cadre de situation, répété en entier sous
      // chaque vue, déborde chez les voisines (traits invisibles, gardés comme avant).
      const mine = p!.segs.filter((s) => s.clip === clip!.id);
      expect(mine.length).toBeGreaterThan(100);
      const b = clip!.bbox;
      const touching = mine.filter((s) => Math.max(s.x0, s.x1) >= b.minX && Math.min(s.x0, s.x1) <= b.maxX && Math.max(s.y0, s.y1) >= b.minY && Math.min(s.y0, s.y1) <= b.maxY);
      expect(touching.length).toBeGreaterThan(0.8 * mine.length);
      // Plans d'étage : les découpes des hachures de murs sont dans ce cadre (la toiture n'est pas coupée).
      const nested = p!.hatches.filter((h) => p!.clips[h.clip]!.parent === clip!.id);
      if (v.kind === 'plan') expect(nested.length, v.title ?? v.kind).toBeGreaterThan(10);
    }
    // Hors des cadres (cartouche, coupes, façades) : la page entière.
    expect(p!.segs.filter((s) => s.clip === 0).length).toBeGreaterThan(500);
    // Couleurs : le trait noir domine, et les limites de parcelle en tireté sont d'une autre couleur, plus rouge que verte.
    expect(p!.segs.filter((s) => s.color === 0).length).toBeGreaterThan(p!.segs.length / 3);
    const dashed = p!.segs.filter((s) => s.dash && s.stroke && (s.color ?? 0) !== 0);
    expect(dashed.some((s) => (s.color! >> 16) > 2 * ((s.color! >> 8) & 255))).toBe(true);
    // La photo est une image matricielle dont l'emprise est connue.
    expect(p!.imageAreas).toHaveLength(1);
    const photo = truth.pages[0]!.views.find((v) => v.kind === 'photo')!;
    const img = p!.imageAreas[0]!;
    expect(inside(box(...photo.bbox_pt), (img.bbox.minX + img.bbox.maxX) / 2, (img.bbox.minY + img.bbox.maxY) / 2)).toBe(true);
    expect(img.pixelsPerPoint).toBeGreaterThan(0);
  });

  it('variante allemande : murs en remplissage plein, isolant en hachure simple', async () => {
    const [p] = await extracted('planche/planche_A2_de_titres_dessus.pdf');
    const truth = truthOf('planche/planche_A2_de_titres_dessus.pdf');
    const k = 1 / (METRES_PER_POINT * truth.scale_den);
    const dark = p!.fills.filter((f) => {
      const r = f.color >> 16;
      const g = (f.color >> 8) & 255;
      const b = f.color & 255;
      return Math.max(r, g, b) < 0x70 && Math.max(r, g, b) - Math.min(r, g, b) < 0x10 && f.alpha === 1;
    });
    expect(dark.length).toBeGreaterThan(10);
    const insulation = p!.hatches.filter((h) => Math.abs(h.width - 0.28) < 0.02);
    expect(insulation.length).toBeGreaterThan(5);
    for (const h of insulation) expect(h.angles).toHaveLength(1);
    const plans = truth.pages[0]!.views.filter((v) => v.kind === 'plan' && v.outline_pt);
    expect(plans).toHaveLength(3);
    for (const v of plans) {
      // Niveaux chauffés : l'isolant (0,175 m côté extérieur) est hachuré, le cœur porteur derrière est poché.
      // Sous-sol non chauffé : un mur porteur de 0,30 m, poché, sans isolant.
      const basement = /KELLER/i.test(v.title ?? '');
      if (!basement) {
        const pts = insetSamples(v.outline_pt!, 0.08 * k, 0.5 * k);
        const hatched = pts.filter(([x, y]) => insulation.some((h) => inside(h.bbox, x, y, 0.3))).length;
        expect(hatched / pts.length, v.title ?? '').toBeGreaterThan(0.6);
      }
      const core = insetSamples(v.outline_pt!, (basement ? 0.15 : 0.26) * k, 0.5 * k);
      const poched = core.filter(([x, y]) => dark.some((f) => inside(f.bbox, x, y, 0.3))).length;
      expect(poched / core.length).toBeGreaterThan(0.6);
    }
  });
});

function sameSeg(a: RawSeg, b: RawSeg): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1 && a.w === b.w && a.pid === b.pid && a.stroke === b.stroke && a.fill === b.fill && a.dash === b.dash && a.curve === b.curve;
}

// ───────────────────────────── 3. Planches d'essai plus anciennes ─────────────────────────────

describe('planches d’essai existantes : rien n’est retiré', () => {
  for (const name of ['fr_A3_1-100.pdf', 'de_A3_1-50.pdf', 'fr_A3_rot90.pdf', 'fr_A4_fit.pdf', 'cad_plot_ezdxf.pdf', 'layers_ocg.pdf', 'scan_only_A3.pdf']) {
    it(`${name} : mêmes traits avec et sans allègement`, async () => {
      const lite = await extracted(name);
      const full = await extracted(name, { lighten: false });
      lite.forEach((p, i) => {
        expect(p.lightening.stippleSegs).toBe(0);
        expect(p.lightening.hatchSegs).toBe(0);
        expect(p.hatches).toHaveLength(0);
        expect(p.stipples).toHaveLength(0);
        expect(p.segs).toEqual(full[i]!.segs);
        expect(p.truncated).toBe(false);
        for (const s of p.segs) {
          expect(typeof s.clip).toBe('number');
          expect(typeof s.color).toBe('number');
        }
      });
    });
  }
});
