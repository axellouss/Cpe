/**
 * Unité du dessin. Un DWG n'est fiable ni par son en-tête ($INSUNITS vaut souvent 0 ou une valeur par défaut fausse)
 * ni par ses habitudes (mm, cm et m sont tous courants) : on fait VOTER plusieurs indices indépendants.
 */
import type { LayerCategory } from './layers';
import type { RawDrawing } from './load';
import type { Seg } from './planar';
import { SegGrid } from './spatial';

export type UnitSource = 'header' | 'doors' | 'imperial' | 'areas' | 'walls';

export interface UnitEvidence {
  source: UnitSource;
  /** Unités de dessin par mètre proposées par cet indice. */
  perMetre: number;
  weight: number;
  /** Détail chiffré pour le message (rayon médian, nombre de textes…). */
  detail: string;
}

interface UnitDef {
  perMetre: number;
  metres: number;
  /** Clé de traduction du nom de l'unité. */
  key: string;
}

export const UNITS: readonly UnitDef[] = [
  { perMetre: 1000, metres: 0.001, key: 'cad.unit.mm' },
  { perMetre: 100, metres: 0.01, key: 'cad.unit.cm' },
  { perMetre: 10, metres: 0.1, key: 'cad.unit.dm' },
  { perMetre: 1, metres: 1, key: 'cad.unit.m' },
  { perMetre: 1 / 0.0254, metres: 0.0254, key: 'cad.unit.inch' },
  { perMetre: 1 / 0.3048, metres: 0.3048, key: 'cad.unit.foot' },
];

/** $INSUNITS → unité. */
const INSUNITS: Record<number, number> = { 1: 1 / 0.0254, 2: 1 / 0.3048, 4: 1000, 5: 100, 6: 1, 14: 10 };

export function unitDef(perMetre: number): UnitDef {
  let best = UNITS[0]!;
  for (const def of UNITS) if (Math.abs(Math.log(def.perMetre / perMetre)) < Math.abs(Math.log(best.perMetre / perMetre))) best = def;
  return best;
}

/** Unité standard la plus proche d'une valeur calculée, si elle en est vraiment proche (± 15 %). */
export function nearestUnit(perMetre: number): number | null {
  const def = unitDef(perMetre);
  return Math.abs(Math.log(def.perMetre / perMetre)) < 0.15 ? def.perMetre : null;
}

const IMPERIAL_RE = /\d+\s*'\s*(\d+\s*"?)?\s*x\s*\d+\s*'/i;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Indices tirés de l'en-tête, des débattements de portes et des textes en pieds-pouces. */
export function collectUnitEvidence(d: RawDrawing, cats: readonly (LayerCategory | null)[]): UnitEvidence[] {
  const evidence: UnitEvidence[] = [];
  const header = INSUNITS[d.insUnits];
  if (header !== undefined) evidence.push({ source: 'header', perMetre: header, weight: 1, detail: String(d.insUnits) });

  // Débattements de portes : arcs d'environ 90° (sur les calques de portes s'ils sont connus, sinon partout).
  const hasDoorLayer = cats.includes('door');
  const radii: number[] = [];
  for (const a of d.arcs) {
    if (a.sweep < 80 || a.sweep > 100) continue;
    const cat = cats[a.layer] ?? null;
    if (hasDoorLayer && cat !== 'door' && cat !== 'window') continue;
    radii.push(a.radius);
  }
  if (radii.length >= 2) {
    const r = median(radii);
    const ranges: [number, number, number][] = [
      [1000, 550, 1150],
      [100, 55, 115],
      [1, 0.55, 1.15],
      [1 / 0.0254, 22, 42],
      [1 / 0.3048, 1.9, 3.5],
    ];
    for (const [perMetre, lo, hi] of ranges) {
      if (r >= lo && r <= hi) evidence.push({ source: 'doors', perMetre, weight: 2, detail: String(radii.length) });
    }
  }

  let imperial = 0;
  for (const t of d.texts) if (!t.dim && IMPERIAL_RE.test(t.text)) imperial++;
  if (imperial >= 3) evidence.push({ source: 'imperial', perMetre: 1 / 0.0254, weight: 2, detail: String(imperial) });
  return evidence;
}

/**
 * Indice « épaisseur des murs » : pour chaque long trait de mur, distance à son jumeau parallèle le plus proche
 * (l'autre face du mur). La médiane de ces distances est l'épaisseur courante en unités du dessin ; une épaisseur
 * de 8 à 60 cm ne correspond qu'à une seule unité parmi mm / cm / m. Ne vote pas si moins de la moitié des traits
 * ont un jumeau ou si l'épaisseur trouvée n'est plausible dans aucune unité.
 */
export function wallThicknessEvidence(input: readonly Seg[]): UnitEvidence | null {
  if (input.length < 8) return null;
  const lengths = input.map((s) => Math.hypot(s.bx - s.ax, s.by - s.ay));
  const medianLength = median(lengths);
  if (!(medianLength > 0)) return null;
  const index = new SegGrid(medianLength);
  input.forEach((s, i) => index.add(i, s));
  const stride = Math.max(1, Math.ceil(input.length / 3000));
  const found: { dist: number; weight: number }[] = [];
  let total = 0;
  for (let i = 0; i < input.length; i += stride) {
    const len = lengths[i]!;
    if (len < medianLength) continue;
    const s = input[i]!;
    total += len;
    const ux = (s.bx - s.ax) / len;
    const uy = (s.by - s.ay) / len;
    const reach = 0.3 * len;
    let best = Infinity;
    for (const j of index.query(Math.min(s.ax, s.bx) - reach, Math.min(s.ay, s.by) - reach, Math.max(s.ax, s.bx) + reach, Math.max(s.ay, s.by) + reach)) {
      if (j === i) continue;
      const o = input[j]!;
      const l2 = lengths[j]!;
      if (l2 <= 0) continue;
      if (Math.abs(ux * (o.by - o.ay) - uy * (o.bx - o.ax)) / l2 > 0.02) continue;
      const dist = Math.abs((o.ax - s.ax) * uy - (o.ay - s.ay) * ux);
      if (dist < 0.004 * len || dist > reach || dist >= best) continue;
      const t1 = (o.ax - s.ax) * ux + (o.ay - s.ay) * uy;
      const t2 = (o.bx - s.ax) * ux + (o.by - s.ay) * uy;
      const overlap = Math.min(len, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
      if (overlap >= 0.5 * Math.min(len, l2)) best = dist;
    }
    if (Number.isFinite(best)) found.push({ dist: best, weight: len });
  }
  const matched = found.reduce((sum, f) => sum + f.weight, 0);
  if (found.length < 4 || matched < 0.5 * total) return null;
  // Médiane pondérée par la longueur des traits.
  found.sort((a, b) => a.dist - b.dist);
  let acc = 0;
  let thickness = found[found.length - 1]!.dist;
  for (const f of found) {
    acc += f.weight;
    if (acc >= matched / 2) {
      thickness = f.dist;
      break;
    }
  }
  for (const perMetre of [1000, 100, 1]) {
    const metres = thickness / perMetre;
    if (metres >= 0.08 && metres <= 0.6) return { source: 'walls', perMetre, weight: 1, detail: String(Math.round(metres * 100)) };
  }
  return null;
}

export interface UnitChoice {
  /** Unités par mètre retenues ; null si aucun indice. */
  perMetre: number | null;
  /** Vrai si tous les indices sérieux concordent. */
  agreed: boolean;
}

/** Vote pondéré. À égalité, l'indice géométrique l'emporte sur l'en-tête (souvent laissé à sa valeur par défaut). */
export function chooseUnit(evidence: readonly UnitEvidence[]): UnitChoice {
  if (evidence.length === 0) return { perMetre: null, agreed: false };
  const votes = new Map<number, number>();
  for (const e of evidence) {
    const k = unitDef(e.perMetre).perMetre;
    votes.set(k, (votes.get(k) ?? 0) + e.weight + (e.source === 'header' ? 0 : 0.01));
  }
  let best: number | null = null;
  let bestVotes = -1;
  for (const [k, v] of votes) {
    if (v > bestVotes) {
      best = k;
      bestVotes = v;
    }
  }
  const serious = evidence.filter((e) => e.source !== 'walls');
  const agreed = serious.length > 0 && votes.size === 1;
  return { perMetre: best, agreed };
}
