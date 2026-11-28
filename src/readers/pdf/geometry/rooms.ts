/**
 * Pièces d'une vue en plan : étiquettes (nom + surface écrite) appariées aux polygones du dessin, et échelle
 * retrouvée par les surfaces.
 *
 * 1. Étiquette : un texte de surface (« S: 35,00 m² », « Fläche: 12,30 m² », « 21,95 m² ») et le nom écrit juste
 *    au-dessus (ou, à défaut, juste en dessous), dans la même colonne.
 * 2. Candidats : tout polygone de remplissage ou de zone hachurée (carrelage) qui contient la surface ET le nom.
 *    Chaque candidat donne une échelle k = √(surface écrite / aire dessinée).
 * 3. Échelle de la vue : le MODE des k (le k qui a le plus de voisins à ±2 %), pas la médiane : les candidats faux
 *    (pelouse, parcelle, contour d'étage) donnent des k dispersés, les vraies pièces le même k. C'est un recoupement
 *    indépendant du cartouche.
 * 4. Repli sans remplissage de pièce : faces fermées par les murs (traits épais, bords des matériaux de mur) et par
 *    des « ponts de portes » (deux bouts de mur parallèles qui se font face à une largeur de porte).
 */
import type { DetectedRoom, Vec2 } from '../../../core/types';
import { pointInPoly, polyArea, polygonizeSegments, type Poly, type Seg } from '../planar';
import type { RawText } from '../raw';
import type { ViewInput } from './types';

/** Texte de surface avec préfixe (« S: 35,00 m », « SU = 12,3 », « Fläche: 12,30 m² »). */
const AREA_PREFIXED_RE =
  /^(?:S|SU|SH|SN|SHAB|A|NF|NGF|NRF|WF|Fl(?:ä|ae|a)che|Surf(?:ace|\.)?)\s*[:=]\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m2|m²|m|qm)?\.?$/i;
/** Texte de surface sans préfixe : l'unité est alors exigée (« 21,95 m² »). */
const AREA_BARE_RE = /^(\d{1,4}[.,]\d{1,2})\s*(?:m2|m²|m|qm)$/i;
/** Un nom de pièce a au moins deux lettres et ne commence pas par un nombre ou une cote de niveau. */
const NAME_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]{2}/;
const NOT_NAME_RE = /^\s*(?:[+\-±]?\d|all\.?\s|nf\b|okff|ok\s|s\s*[:=])/i;

/** Locaux non chauffés reconnus à leur nom. */
export const UNHEATED_RE =
  /garage|carport|non[- ]?chauff|unbeheizt|\bcave\b|keller|remise|\babri\b|local poubelle|poubelles|m[üu]llraum|gartenhaus|abstellraum au(?:ss|ß)en|cellier non chauff/i;
/** Espaces extérieurs (jamais comptés, jamais dans le contour). */
export const OUTSIDE_RE = /terrasse|balcon|loggia|balkon|terrace|\bpergola\b|car ?port|\bauvent\b|vordach/i;
/** Hall, entrée : la pièce derrière une porte d'entrée. */
export const ENTRANCE_RE = /hall|entr[ée]e|flur|diele|windfang|vestibule|eingang|sas\b/i;

export interface RoomLabel {
  name: string;
  stated: number | null;
  /** Point de l'étiquette (centre du texte de surface, ou du nom). */
  at: Vec2;
  nameAt: Vec2 | null;
  size: number;
  /** Pièce fournie par un autre lecteur (contexte) plutôt que trouvée ici. */
  fromContext: boolean;
}

export function parseArea(s: string): number | null {
  const t = s.trim();
  const m = AREA_PREFIXED_RE.exec(t) ?? AREA_BARE_RE.exec(t);
  if (!m) return null;
  const v = Number(m[1]!.replace(',', '.'));
  return v > 0 && v < 5000 ? v : null;
}

function isHorizontal(t: RawText): boolean {
  return Math.abs(t.angle) < 1.5;
}

function isNameText(t: RawText): boolean {
  // « Surface vitrée : » est la clé d'une ligne « clé : valeur » (encadré, tableau), pas un nom de pièce.
  return NAME_RE.test(t.s) && !NOT_NAME_RE.test(t.s) && parseArea(t.s) === null && t.s.length <= 40 && !/[:=]\s*$/.test(t.s);
}

/**
 * Valeur d'une ligne « clé : valeur » : un texte terminé par « : » ou « = » écrit juste à sa gauche, sur la même
 * ligne (encadré d'éclairement, tableau des surfaces). Ce n'est pas l'étiquette d'une pièce.
 */
function isKeyedValue(t: RawText, texts: readonly RawText[]): boolean {
  for (const n of texts) {
    if (n === t || !/[:=]\s*$/.test(n.s)) continue;
    const size = Math.max(t.size, n.size);
    if (Math.abs(n.cy - t.cy) > 0.4 * size) continue;
    const gap = t.x0 - n.x1;
    if (gap >= -0.5 * size && gap <= 2 * size) return true;
  }
  return false;
}

/** Étiquettes de pièce écrites dans la vue. */
export function findRoomLabels(texts: readonly RawText[]): RoomLabel[] {
  const out: RoomLabel[] = [];
  const names = texts.filter((t) => isHorizontal(t) && isNameText(t));
  for (const t of texts) {
    if (!isHorizontal(t)) continue;
    const stated = parseArea(t.s);
    if (stated === null || isKeyedValue(t, texts)) continue;
    let best: RawText | null = null;
    let bd = Infinity;
    for (const n of names) {
      const size = Math.max(t.size, n.size);
      const overlap = Math.min(t.x1, n.x1) - Math.max(t.x0, n.x0);
      if (overlap < -size) continue;
      const dy = t.cy - n.cy;
      let score: number;
      if (dy >= 0.3 * size && dy <= 3 * size) score = dy + 0.2 * Math.abs(t.cx - n.cx);
      else if (-dy >= 0.3 * size && -dy <= 2.2 * size) score = 1.5 * -dy + 0.2 * Math.abs(t.cx - n.cx) + size;
      else continue;
      if (score < bd) {
        bd = score;
        best = n;
      }
    }
    out.push({
      name: best ? best.s.trim() : '?',
      stated,
      at: { x: t.cx, y: t.cy },
      nameAt: best ? { x: best.cx, y: best.cy } : null,
      size: t.size,
      fromContext: false,
    });
  }
  return out;
}

/** Ajoute les pièces lues ailleurs (contexte) qui ne correspondent à aucune étiquette trouvée ici. */
export function mergeContextRooms(own: RoomLabel[], ctx: readonly DetectedRoom[] | undefined): RoomLabel[] {
  if (!ctx || ctx.length === 0) return own;
  const out = own.slice();
  for (const r of ctx) {
    if (!r.at) continue;
    const near = out.find(
      (l) => Math.hypot(l.at.x - r.at!.x, l.at.y - r.at!.y) < 3 * l.size || (l.nameAt && Math.hypot(l.nameAt.x - r.at!.x, l.nameAt.y - r.at!.y) < 3 * l.size),
    );
    if (near) {
      if (near.name === '?' && r.name) near.name = r.name;
      continue;
    }
    out.push({ name: r.name, stated: r.statedArea ?? null, at: { x: r.at.x, y: r.at.y }, nameAt: null, size: 6, fromContext: true });
  }
  return out;
}

// ───────────────────────────── Appariement aux polygones, échelle ─────────────────────────────

export type ZoneSource = 'zone-fill' | 'hatch-zone' | 'wall-faces';

export interface ZoneCandidate {
  poly: Poly;
  source: ZoneSource;
  areaPt: number;
  /** k = √(surface écrite / aire), m par point ; NaN sans surface écrite. */
  k: number;
}

export interface RoomZone {
  label: RoomLabel;
  poly: Poly | null;
  source: ZoneSource | null;
  /** Sources indépendantes qui donnent le même polygone (remplissage + carrelage). */
  agreeing: ZoneSource[];
  /** Surface mesurée à l'échelle retenue (m²). */
  measured: number | null;
}

export interface AreaScale {
  mpp: number;
  /** Nombre de pièces dont un candidat tombe sur le mode. */
  support: number;
}

/** Mode robuste : le k qui a le plus de voisins à |ln(k/k')| < tol, moyenne géométrique de ces voisins. */
export function modeScale(ks: readonly number[], tol = 0.02): { k: number; members: number[] } | null {
  let best: { k: number; members: number[] } | null = null;
  for (const k of ks) {
    if (!(k > 0)) continue;
    const near = ks.filter((x) => x > 0 && Math.abs(Math.log(x / k)) < tol);
    if (!best || near.length > best.members.length) {
      const m = near.reduce((s, x) => s + Math.log(x), 0) / near.length;
      best = { k: Math.exp(m), members: near };
    }
  }
  return best;
}

function labelPoints(l: RoomLabel): Vec2[] {
  return l.nameAt ? [l.at, l.nameAt] : [l.at];
}

function candidatesFor(l: RoomLabel, pool: readonly { poly: Poly; source: ZoneSource }[]): ZoneCandidate[] {
  const pts = labelPoints(l);
  const out: ZoneCandidate[] = [];
  for (const c of pool) {
    if (!pts.every((p) => pointInPoly(p.x, p.y, c.poly))) continue;
    const a = polyArea(c.poly);
    if (!(a > 0)) continue;
    out.push({ poly: c.poly, source: c.source, areaPt: a, k: l.stated ? Math.sqrt(l.stated / a) : Number.NaN });
  }
  return out;
}

/** Polygones candidats d'une vue : remplissages et zones hachurées. */
export function zonePool(v: ViewInput): { poly: Poly; source: ZoneSource }[] {
  const pool: { poly: Poly; source: ZoneSource }[] = [];
  for (const f of v.fills) for (const p of f.polys) pool.push({ poly: p, source: 'zone-fill' });
  for (const h of v.hatches) for (const p of h.polys) pool.push({ poly: p, source: 'hatch-zone' });
  return pool;
}

/**
 * Apparie les étiquettes aux polygones et retrouve l'échelle par les surfaces. `declaredMpp` (cartouche) ne sert
 * que de repli quand le mode a moins de 3 pièces, ou de départage.
 */
export function matchRoomZones(
  labels: readonly RoomLabel[],
  pool: readonly { poly: Poly; source: ZoneSource }[],
  declaredMpp: number | null,
): { scale: AreaScale | null; rooms: RoomZone[]; candidates: ZoneCandidate[][] } {
  const per = labels.map((l) => candidatesFor(l, pool));
  const ks: number[] = [];
  for (const cs of per) {
    const seen = new Set<number>();
    for (const c of cs) {
      if (!(c.k > 0)) continue;
      const key = Math.round(c.k * 1e7);
      if (seen.has(key)) continue;
      seen.add(key);
      ks.push(c.k);
    }
  }
  const mode = modeScale(ks);
  let scale: AreaScale | null = null;
  if (mode) {
    const support = per.filter((cs) => cs.some((c) => c.k > 0 && Math.abs(Math.log(c.k / mode.k)) < 0.02)).length;
    const agreesDeclared = declaredMpp ? Math.abs(Math.log(mode.k / declaredMpp)) < 0.01 : false;
    if (support >= 3 || (support >= 1 && agreesDeclared)) scale = { mpp: mode.k, support };
    else if (declaredMpp) scale = { mpp: declaredMpp, support: 0 };
    else if (support >= 1) scale = { mpp: mode.k, support };
  } else if (declaredMpp) scale = { mpp: declaredMpp, support: 0 };
  const rooms: RoomZone[] = labels.map((label, i) => {
    const cs = per[i]!;
    if (!scale) return { label, poly: null, source: null, agreeing: [], measured: null };
    const k = scale.mpp;
    let ok: ZoneCandidate[];
    if (label.stated) ok = cs.filter((c) => Math.abs(Math.log(c.k / k)) < 0.05);
    else {
      // Pièce sans surface écrite : le plus petit candidat qui reste une pièce plausible (1–200 m²).
      ok = cs.filter((c) => c.areaPt * k * k >= 1 && c.areaPt * k * k <= 200);
    }
    ok.sort((a, b) => (label.stated ? Math.abs(Math.log(a.k / k)) - Math.abs(Math.log(b.k / k)) : a.areaPt - b.areaPt));
    const chosen = ok[0];
    if (!chosen) return { label, poly: null, source: null, agreeing: [], measured: null };
    const agreeing = [...new Set(ok.filter((c) => Math.abs(c.areaPt / chosen.areaPt - 1) < 0.02).map((c) => c.source))];
    return { label, poly: chosen.poly, source: chosen.source, agreeing, measured: chosen.areaPt * k * k };
  });
  return { scale, rooms, candidates: per };
}

// ───────────────────────────── Repli : faces fermées par les murs ─────────────────────────────

interface ShortEdge {
  a: Vec2;
  b: Vec2;
  m: Vec2;
  d: Vec2;
  len: number;
  owner: number;
}

/**
 * Ponts entre deux bouts de mur qui se font face : bords courts (épaisseur de mur) de deux polygones différents,
 * parallèles, de même longueur, en face l'un de l'autre et à une distance de largeur de baie. Renvoie le
 * quadrilatère du pont (les deux bords et les deux traits qui les joignent).
 */
export function wallBridges(
  walls: readonly Poly[],
  mpp: number,
  opts: { minGapM: number; maxGapM: number; minEdgeM?: number; maxEdgeM?: number },
): { quad: Vec2[]; gapM: number; a: ShortEdge; b: ShortEdge }[] {
  const minEdge = (opts.minEdgeM ?? 0.08) / mpp;
  const maxEdge = (opts.maxEdgeM ?? 0.5) / mpp;
  const short: ShortEdge[] = [];
  walls.forEach((p, owner) => {
    const r = p.outer;
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < minEdge || len > maxEdge) continue;
      short.push({ a, b, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, len, owner });
    }
  });
  const out: { quad: Vec2[]; gapM: number; a: ShortEdge; b: ShortEdge }[] = [];
  const minGap = opts.minGapM / mpp;
  const maxGap = opts.maxGapM / mpp;
  short.sort((s, t) => s.m.x - t.m.x);
  for (let i = 0; i < short.length; i++) {
    const s = short[i]!;
    for (let j = i + 1; j < short.length; j++) {
      const t = short[j]!;
      if (t.m.x - s.m.x > maxGap) break;
      if (s.owner === t.owner) continue;
      const cos = s.d.x * t.d.x + s.d.y * t.d.y;
      if (Math.abs(cos) < 0.98) continue;
      if (Math.abs(s.len - t.len) * mpp > 0.06) continue;
      const vx = t.m.x - s.m.x;
      const vy = t.m.y - s.m.y;
      const dist = Math.hypot(vx, vy);
      if (dist < minGap || dist > maxGap) continue;
      if (Math.abs(vx * s.d.x + vy * s.d.y) * mpp > 0.03) continue;
      const [ta, tb] = cos > 0 ? [t.a, t.b] : [t.b, t.a];
      out.push({ quad: [s.a, s.b, tb, ta], gapM: dist * mpp, a: s, b: t });
    }
  }
  return out;
}

function ringSegs(r: readonly Vec2[], out: Seg[]): void {
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
}

/** Faces fermées par les murs : traits épais (≥ `minW` pt, non tiretés), bords des matériaux de mur, ponts de portes. */
export function wallFaces(v: ViewInput, walls: readonly Poly[], mpp: number, maxDoorM: number, minW = 0.45): Poly[] {
  const segs: Seg[] = [];
  for (const s of v.segs) if (s.w >= minW && !s.dash) segs.push({ ax: s.x0, ay: s.y0, bx: s.x1, by: s.y1 });
  for (const w of walls) {
    ringSegs(w.outer, segs);
    for (const h of w.holes) ringSegs(h, segs);
  }
  for (const br of wallBridges(walls, mpp, { minGapM: 0.55, maxGapM: maxDoorM })) {
    const q = br.quad;
    segs.push({ ax: q[1]!.x, ay: q[1]!.y, bx: q[2]!.x, by: q[2]!.y }, { ax: q[3]!.x, ay: q[3]!.y, bx: q[0]!.x, by: q[0]!.y });
  }
  return polygonizeSegments(segs, 0.05);
}

/**
 * Repli pour les étiquettes restées sans polygone : face fermée la plus proche de la surface écrite parmi celles
 * qui contiennent l'étiquette (ponts de portes jusqu'à 1,3 m, puis jusqu'à 2,6 m pour les passages larges).
 */
export function roomFacesFallback(v: ViewInput, rooms: RoomZone[], walls: readonly Poly[], mpp: number): void {
  const todo = rooms.filter((r) => !r.poly);
  if (todo.length === 0) return;
  const faceSets = [wallFaces(v, walls, mpp, 1.3)];
  if (todo.some((r) => r.label.stated)) faceSets.push(wallFaces(v, walls, mpp, 2.6));
  const wallArea = new Set(walls.map((w) => Math.round(polyArea(w) * 100)));
  for (const r of todo) {
    const pts = labelPoints(r.label);
    let best: { poly: Poly; area: number; score: number } | null = null;
    for (const faces of faceSets) {
      const inside = faces
        .filter((f) => pts.every((p) => pointInPoly(p.x, p.y, f)) && !wallArea.has(Math.round(polyArea(f) * 100)))
        .map((f) => ({ poly: f, area: polyArea(f) * mpp * mpp }))
        .filter((f) => f.area >= 0.5 && f.area <= 500)
        .sort((a, b) => a.area - b.area);
      const f = inside[0];
      if (!f) continue;
      const score = r.label.stated ? Math.abs(Math.log(f.area / r.label.stated)) : f.area;
      if (!best || score < best.score - 1e-9) best = { ...f, score };
    }
    if (best) {
      r.poly = best.poly;
      r.source = 'wall-faces';
      r.agreeing = ['wall-faces'];
      r.measured = best.area;
    }
  }
}

/** Confiance d'une pièce : surface mesurée face à la surface écrite, nombre de sources du polygone. */
export function roomConfidence(r: RoomZone): { confidence: number; approx: boolean } {
  if (!r.poly || r.measured === null) return { confidence: r.label.stated ? 0.65 : 0.4, approx: false };
  if (!r.label.stated) return { confidence: r.source === 'wall-faces' ? 0.5 : 0.65, approx: false };
  const gap = Math.abs(r.measured / r.label.stated - 1);
  if (gap <= 0.02) {
    const indep = r.agreeing.length >= 2 ? 0.95 : r.source === 'wall-faces' ? 0.85 : 0.9;
    return { confidence: indep, approx: false };
  }
  if (gap <= 0.1) return { confidence: 0.6, approx: true };
  return { confidence: 0.45, approx: true };
}
