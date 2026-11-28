/**
 * Planches d'autorisation de bâtir SYNTHÉTIQUES (tests/fixtures/pdf/planche, produites par make_planches.py) :
 * cohérence entre chaque PDF et sa vérité de référence (*.truth.json).
 *
 * On vérifie seulement que la planche est lisible par l'extraction brute du dépôt et que la vérité la décrit bien
 * (titres de vues présents, étiquettes de pièces à leur place, aires des polygones, nombre de pages). On n'affirme
 * RIEN sur le découpage en vues ni sur l'analyse actuelle : le lecteur ne sait pas encore lire ces planches.
 */
import { describe, expect, it } from 'vitest';
import { polygonArea } from '../../../src/core/geometry';
import { METRES_PER_POINT, readPdfDetailed } from '../../../src/readers/pdf';
import type { PdfReadDetails, RawText } from '../../../src/readers/pdf';

// ── Accès disque sous Node, sans dépendre des types de Node (comme helpers.ts) ──
interface FsLike {
  readFileSync(path: string | URL): Uint8Array;
}
const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as FsLike;
const PLANCHE_DIR = new URL('../../fixtures/pdf/planche/', import.meta.url);

function bytes(name: string): ArrayBuffer {
  const buf = fs.readFileSync(new URL(name, PLANCHE_DIR));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

interface PlancheRoom {
  name: string;
  area_label: string | null;
  area_true_m2: number;
  heated_true: boolean;
  label_pt: [number, number] | null;
  poly_pt: [number, number][];
}

interface PlancheView {
  kind: string;
  title: string | null;
  level?: number;
  rooms?: PlancheRoom[];
}

interface PlancheTruth {
  file: string;
  scale_den: number;
  pages: { number: number; width_pt: number; height_pt: number; views: PlancheView[] }[];
}

function truthOf(pdf: string): PlancheTruth {
  const text = new TextDecoder('utf-8').decode(bytes(pdf.replace(/\.pdf$/, '.truth.json')));
  return JSON.parse(text) as PlancheTruth;
}

const read = new Map<string, Promise<PdfReadDetails>>();
function details(pdf: string): Promise<PdfReadDetails> {
  let p = read.get(pdf);
  if (!p) {
    p = readPdfDetailed(bytes(pdf), pdf, { images: false }).then((r) => r.details);
    read.set(pdf, p);
  }
  return p;
}

const norm = (s: string): string => s.replace(/\s+/g, '').toUpperCase();

/** Vrai si `target` se lit en recollant, de gauche à droite, des morceaux de texte d'une même ligne (« PLAN 1 » + « ER » + « ÉTAGE »). */
function findTitle(texts: readonly RawText[], target: string): boolean {
  const want = norm(target);
  for (const t of texts) {
    if (t.angle !== 0) continue;
    const first = norm(t.s);
    if (!first || !want.startsWith(first)) continue;
    const row = texts
      .filter((u) => u.angle === 0 && Math.abs(u.by - t.by) < t.size * 0.8 && u.x0 >= t.x0 - 0.5 && u.x0 < t.x0 + 60 * t.size)
      .sort((a, b) => a.x0 - b.x0);
    let acc = '';
    for (const u of row) {
      const next = acc + norm(u.s);
      if (!want.startsWith(next)) continue;
      acc = next;
      if (acc === want) return true;
    }
  }
  return false;
}

const PLANCHES: { file: string; pages: number }[] = [
  { file: 'planche_A1_archicad.pdf', pages: 1 },
  { file: 'planche_A2_de_titres_dessus.pdf', pages: 1 },
  { file: 'planche_2pages.pdf', pages: 2 },
  { file: 'planche_sans_titres.pdf', pages: 1 },
];

for (const { file, pages } of PLANCHES) {
  describe(`${file} — planche synthétique et sa vérité`, () => {
    const truth = (): PlancheTruth => truthOf(file);

    it('s’ouvre avec le lecteur brut et a le bon nombre de pages', async () => {
      const d = await details(file);
      expect(d.pageCount).toBe(pages);
      expect(truth().pages).toHaveLength(pages);
      for (let i = 0; i < pages; i++) {
        const raw = d.raw[i]!;
        expect(raw.width).toBeCloseTo(truth().pages[i]!.width_pt, 0);
        expect(raw.height).toBeCloseTo(truth().pages[i]!.height_pt, 0);
        expect(raw.truncated).toBe(false);
        expect(raw.texts.length).toBeGreaterThan(20);
      }
    }, 60_000);

    it('les titres de vues de la vérité se retrouvent dans les textes extraits', async () => {
      const d = await details(file);
      truth().pages.forEach((page, i) => {
        const texts = d.raw[i]!.texts;
        for (const v of page.views) {
          if (!v.title) continue;
          expect(findTitle(texts, v.title), `titre « ${v.title} » (page ${page.number})`).toBe(true);
        }
      });
    }, 60_000);

    it('chaque étiquette de pièce est à sa place', async () => {
      const d = await details(file);
      let checked = 0;
      truth().pages.forEach((page, i) => {
        const texts = d.raw[i]!.texts;
        for (const v of page.views) {
          for (const room of v.rooms ?? []) {
            if (!room.label_pt) continue;
            const [x, y] = room.label_pt;
            const hit = texts.find((t) => t.s === room.name && Math.abs(t.cx - x) < 2 && Math.abs(t.cy - y) < 2);
            expect(hit, `étiquette « ${room.name} » près de (${x}, ${y})`).toBeDefined();
            if (room.area_label) {
              const area = texts.find((t) => t.s === room.area_label && Math.abs(t.cx - x) < 3 && t.cy > y && t.cy - y < 20);
              expect(area, `surface « ${room.area_label} » sous « ${room.name} »`).toBeDefined();
            }
            checked++;
          }
        }
      });
      expect(checked).toBeGreaterThan(0);
    }, 60_000);

    it('l’aire de chaque polygone de pièce égale sa surface vraie (1 %)', () => {
      const k = METRES_PER_POINT * truth().scale_den;
      for (const page of truth().pages) {
        for (const v of page.views) {
          for (const room of v.rooms ?? []) {
            const a = polygonArea(room.poly_pt.map(([x, y]) => ({ x, y }))) * k * k;
            expect(Math.abs(a / room.area_true_m2 - 1), `aire de « ${room.name} »`).toBeLessThan(0.01);
          }
        }
      }
    });
  });
}
