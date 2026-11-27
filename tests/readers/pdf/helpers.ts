/**
 * Outils communs aux tests du lecteur PDF : lecture des plans d'essai, vérité terrain, pages synthétiques.
 *
 * Les plans d'essai (tests/fixtures/pdf) ont été dessinés par nos propres scripts (voir LISEZMOI.txt) ; leurs
 * fichiers *.truth.json donnent, dans le même repère que les feuilles (points PDF, y vers le bas), les pièces,
 * surfaces, contours, cotes, niveaux et le nord exacts.
 */
import { polygonArea } from '../../../src/core/geometry';
import type { PlanDocument, PlanSheet, Vec2 } from '../../../src/core/types';
import { METRES_PER_POINT, readPdfDetailed } from '../../../src/readers/pdf';
import type { PdfReadDetails, RawPage, RawSeg, RawText } from '../../../src/readers/pdf';

// ── Accès disque sous Node, sans dépendre des types de Node (absents du projet) ──

interface FsLike {
  readFileSync(path: string | URL): Uint8Array;
}

const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as FsLike;

const FIXTURE_DIR = new URL('../../fixtures/pdf/', import.meta.url);

export function fixtureBytes(name: string): ArrayBuffer {
  const buf = fs.readFileSync(new URL(name, FIXTURE_DIR));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export interface Read {
  doc: PlanDocument;
  details: PdfReadDetails;
}

const cache = new Map<string, Promise<Read>>();

/** Lit un plan d'essai (une seule fois par fichier pour toute la série de tests). */
export function readFixture(name: string): Promise<Read> {
  let read = cache.get(name);
  if (!read) {
    read = readPdfDetailed(fixtureBytes(name), name);
    cache.set(name, read);
  }
  return read;
}

// ───────────────────────────── Vérité terrain ─────────────────────────────

export interface TruthRoom {
  name: string;
  area_true_m2: number;
  area_label: string | null;
  heated_true: boolean;
  label_pt: [number, number];
  poly_pt: [number, number][];
}

export interface TruthView {
  view: string;
  outline_area_m2?: number;
  outline_pt?: [number, number][];
  heated_outline_area_m2?: number;
  rooms?: TruthRoom[];
  dims: { text: string; true_m: number }[];
  levels_m?: number[];
  storey_height_m?: number;
  clear_height_m?: number;
}

export interface Truth {
  file: string;
  scale_den: number;
  pages: { views: TruthView[] }[];
  /** Direction du nord, en degrés horaires depuis le haut de la page. */
  north_cw_from_up_deg: number;
}

export function truthOf(name: string): Truth {
  const text = new TextDecoder('utf-8').decode(fixtureBytes(name.replace(/\.pdf$/, '.truth.json')));
  return JSON.parse(text) as Truth;
}

/** Surface écrite sur le plan d'après la vérité terrain (« S = 7,89 m² » → 7.89) ; null si la pièce n'en porte pas. */
export function labelledArea(room: TruthRoom): number | null {
  if (room.area_label === null) return null;
  const m = /(\d+(?:[.,]\d+)?)\s*(?:m|qm)/.exec(room.area_label);
  if (!m) throw new Error(`surface illisible dans la vérité terrain : ${room.area_label}`);
  return Number(m[1]!.replace(',', '.'));
}

// ───────────────────────────── Mesures ─────────────────────────────

/** Dénominateur d'échelle d'une feuille (100 pour 1:100) ; NaN si l'échelle est inconnue. */
export function scaleDen(sheet: PlanSheet): number {
  return sheet.metresPerUnit ? sheet.metresPerUnit.value / METRES_PER_POINT : Number.NaN;
}

/** Aire d'un polygone de la feuille, en m². */
export function areaM2(sheet: PlanSheet, polygon: readonly Vec2[]): number {
  const k = sheet.metresPerUnit?.value ?? Number.NaN;
  return polygonArea(polygon) * k * k;
}

export function distanceToRing(p: Vec2, ring: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/** Feuille dont le contour proposé recouvre la vue de la vérité terrain. */
export function sheetForView(doc: PlanDocument, view: TruthView): PlanSheet {
  const pts = view.outline_pt ?? [];
  const cx = pts.reduce((s, p) => s + p[0], 0) / Math.max(1, pts.length);
  const cy = pts.reduce((s, p) => s + p[1], 0) / Math.max(1, pts.length);
  const sheet = doc.sheets.find((s) => {
    const o = s.detected.outline;
    if (!o) return false;
    const xs = o.map((p) => p.x);
    const ys = o.map((p) => p.y);
    return cx > Math.min(...xs) && cx < Math.max(...xs) && cy > Math.min(...ys) && cy < Math.max(...ys);
  });
  if (!sheet) throw new Error(`aucune feuille pour la vue « ${view.view} » (feuilles : ${doc.sheets.map((s) => s.name).join(', ')})`);
  return sheet;
}

export function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

// ───────────────────────────── Pages synthétiques ─────────────────────────────

/** Trait droit continu d'épaisseur `w`. */
export function seg(x0: number, y0: number, x1: number, y1: number, w: number, extra: Partial<RawSeg> = {}): RawSeg {
  return { x0, y0, x1, y1, w, curve: false, stroke: true, fill: false, dash: false, pid: 0, ...extra };
}

/** Texte centré sur (cx, cy) ; `angle` = 90 pour un texte lu de bas en haut. */
export function text(s: string, cx: number, cy: number, size = 8, angle = 0): RawText {
  const w = s.length * size * 0.5;
  const horizontal = Math.abs(angle) < 1;
  const hw = horizontal ? w / 2 : size / 2;
  const hh = horizontal ? size / 2 : w / 2;
  return { s, x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh, cx, cy, bx: cx - hw, by: cy + hh, angle, size };
}

export function page(segs: RawSeg[], texts: RawText[], width = 1190.55, height = 841.89): RawPage {
  return { number: 1, width, height, rotation: 0, turned: 0, texts, segs, images: 0, imageCoverage: 0, imagePixelsPerPoint: 0, truncated: false };
}

/** Rectangle fermé (4 traits). */
export function rect(x0: number, y0: number, x1: number, y1: number, w: number): RawSeg[] {
  return [seg(x0, y0, x1, y0, w), seg(x1, y0, x1, y1, w), seg(x1, y1, x0, y1, w), seg(x0, y1, x0, y0, w)];
}

/**
 * Chaîne de cotes horizontale à l'ordonnée y : une ligne, un tiret à 45° à chaque borne et le nombre au-dessus de
 * chaque intervalle. `labels[i]` est écrit entre xs[i] et xs[i + 1].
 */
export function dimensionChain(xs: readonly number[], y: number, labels: readonly string[], thin = 0.25): { segs: RawSeg[]; texts: RawText[] } {
  const segs: RawSeg[] = [seg(xs[0]! - 4, y, xs[xs.length - 1]! + 4, y, thin)];
  for (const x of xs) segs.push(seg(x - 2.5, y + 2.5, x + 2.5, y - 2.5, thin * 1.5));
  const texts = labels.map((s, i) => text(s, (xs[i]! + xs[i + 1]!) / 2, y - 5, 6));
  return { segs, texts };
}

/** Générateur pseudo-aléatoire reproductible (suite congruentielle), valeurs dans [0, 1). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
