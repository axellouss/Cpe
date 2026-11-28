/**
 * Baies des murs extérieurs d'un plan d'étage.
 *
 * Pour chaque arête de l'emprise (≥ 1 m, non mitoyenne) :
 *  1. trous de la maçonnerie (bande de 0,8 m à l'intérieur) et de l'isolant (bande de 0,35 m) ;
 *  2. tableaux : traits épais perpendiculaires à la façade qui touchent sa face extérieure et restent dans le mur ;
 *  3. cote « largeur / hauteur » écrite en face (lue par un autre lot : ReadOpeningPair) et allège ;
 *  4. symbole dans le trou : traits parallèles au mur sur toute la largeur (vitrage) ou vantail et arc (porte) ;
 *  5. pièce derrière (point à 1 m à l'intérieur) : local non chauffé → baie hors enveloppe (porte de garage) ;
 *     hall, entrée → porte d'entrée.
 * Largeur retenue : la cote écrite, recoupée par les tableaux ou le trou d'isolant (à 7 cm près) ; sans cote, les
 * tableaux s'ils concordent avec le trou d'isolant, sinon le trou d'isolant, sinon celui de la maçonnerie (doute).
 *
 * Portes entre logement et local non chauffé : ponts posés sur les trous de l'isolant (envelope.ts) qui séparent
 * une zone chauffée d'une zone non chauffée.
 */
import type { DetectedOpening, Vec2 } from '../../../core/types';
import type { ReadOpeningPair } from '../../../core/reading';
import { intersectPolys, pointInPoly, type Poly } from '../planar';
import type { RawSeg } from '../raw';
import type { ThermalZones } from './envelope';
import { onParty } from './envelope';
import type { Footprint } from './footprint';
import type { OwnWalls } from './materials';
import { ENTRANCE_RE, type RoomZone } from './rooms';
import { polyBox, round } from './util';

export interface WallEdge {
  a: Vec2;
  b: Vec2;
  /** Direction unitaire a → b. */
  u: Vec2;
  /** Normale extérieure unitaire. */
  n: Vec2;
  len: number;
  index: number;
}

/** Baie trouvée sur le plan, avec ce qu'il faut pour la rattacher à une façade dessinée. */
export interface PlanBay {
  opening: DetectedOpening;
  edge: WallEdge;
  /** Centre de la baie sur la face extérieure (uf). */
  centre: Vec2;
  /** Vrai si la baie est dans l'enveloppe (pièce chauffée derrière). */
  inEnvelope: boolean;
  room: string | null;
  sources: string[];
}

export function footprintEdges(fp: Footprint, mpp: number, minM = 1.0): WallEdge[] {
  const r = fp.ring;
  const out: WallEdge[] = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len * mpp < minM) continue;
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    let n = { x: u.y, y: -u.x };
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const eps = 0.05 / mpp;
    if (pointInPoly(m.x + n.x * eps, m.y + n.y * eps, fp.poly)) n = { x: -n.x, y: -n.y };
    out.push({ a, b, u, n, len, index: i });
  }
  return out;
}

const along = (e: WallEdge, p: Vec2): number => (p.x - e.a.x) * e.u.x + (p.y - e.a.y) * e.u.y;
/** Distance vers l'extérieur (positive dehors, négative dans le mur). */
const outward = (e: WallEdge, p: Vec2): number => (p.x - e.a.x) * e.n.x + (p.y - e.a.y) * e.n.y;
const at = (e: WallEdge, t: number, d = 0): Vec2 => ({ x: e.a.x + e.u.x * t + e.n.x * d, y: e.a.y + e.u.y * t + e.n.y * d });

/** Intervalles [t0, t1] (uf, le long de l'arête) couverts par la matière dans la bande [d0, d1] vers l'intérieur. */
export function coverage(e: WallEdge, material: readonly Poly[], d1: number, d0 = 0): [number, number][] {
  const band: Poly = { outer: [at(e, 0, -d0), at(e, e.len, -d0), at(e, e.len, -d1), at(e, 0, -d1)], holes: [] };
  const bb = polyBox(band);
  const near = material.filter((p) => {
    const b = polyBox(p);
    return b.minX <= bb.maxX && b.maxX >= bb.minX && b.minY <= bb.maxY && b.maxY >= bb.minY;
  });
  const iv: [number, number][] = [];
  for (const p of intersectPolys([band], near)) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of p.outer) {
      const t = along(e, q);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    if (hi - lo > 0.05) iv.push([lo, hi]);
  }
  iv.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const x of iv) {
    const l = merged[merged.length - 1];
    if (l && x[0] <= l[1] + 0.3) l[1] = Math.max(l[1], x[1]);
    else merged.push([x[0], x[1]]);
  }
  return merged;
}

export interface Gap {
  t0: number;
  t1: number;
  widthM: number;
}

/** Trous d'au moins `minM` entre deux intervalles couverts (les bouts d'arête non couverts ne comptent pas). */
export function gapsOf(cov: readonly [number, number][], mpp: number, minM = 0.4): Gap[] {
  const out: Gap[] = [];
  for (let i = 0; i + 1 < cov.length; i++) {
    const t0 = cov[i]![1];
    const t1 = cov[i + 1]![0];
    if ((t1 - t0) * mpp >= minM) out.push({ t0, t1, widthM: (t1 - t0) * mpp });
  }
  return out;
}

/** Tableaux : plus grand écart (≥ 0,4 m) entre traits épais perpendiculaires qui touchent la face extérieure. */
function jambs(segs: readonly RawSeg[], e: WallEdge, g: Gap, mpp: number): { t0: number; t1: number; widthM: number } | null {
  const pos: number[] = [];
  for (const s of segs) {
    if (s.w < 0.45 || s.dash) continue;
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const L = Math.hypot(dx, dy);
    if (L * mpp < 0.1) continue;
    if (Math.abs((dx * e.u.x + dy * e.u.y) / L) > 0.09) continue;
    const t = along(e, { x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 });
    if (t < g.t0 - 1 || t > g.t1 + 1) continue;
    const d0 = -outward(e, { x: s.x0, y: s.y0 });
    const d1 = -outward(e, { x: s.x1, y: s.y1 });
    if (Math.min(d0, d1) * mpp > 0.3 || Math.max(d0, d1) * mpp > 0.9 || Math.min(d0, d1) * mpp < -0.05) continue;
    if (!pos.some((p) => Math.abs(p - t) < 0.5)) pos.push(t);
  }
  pos.sort((a, b) => a - b);
  let best: { t0: number; t1: number; widthM: number } | null = null;
  for (let i = 0; i + 1 < pos.length; i++) {
    const w = (pos[i + 1]! - pos[i]!) * mpp;
    if (w >= 0.4 && (!best || w > best.widthM)) best = { t0: pos[i]!, t1: pos[i + 1]!, widthM: w };
  }
  return best;
}

/** Symbole dessiné dans le trou : vitrage (traits parallèles sur toute la largeur) et/ou vantail de porte. */
/** Portée minimale d'un vantail dessiné en trait droit, mesurée depuis la face extérieure du mur (m). */
export const LEAF_MIN_REACH_M = 0.8;
/** Distance maximale entre la face extérieure du mur et le début d'un arc d'ouverture (m). */
export const ARC_MAX_START_M = 0.55;

export function openingSymbol(segs: readonly RawSeg[], e: WallEdge, t0: number, t1: number, depthPt: number, mpp: number): { glazing: number; leaf: boolean; arc: boolean; straightLeaf: boolean } {
  const w = t1 - t0;
  let glazing = 0;
  let leaf = false;
  let arc = 0;
  let arcA0 = Infinity;
  let arcA1 = -Infinity;
  let arcD0 = Infinity;
  let arcD1 = -Infinity;
  for (const s of segs) {
    const p0 = { x: s.x0, y: s.y0 };
    const p1 = { x: s.x1, y: s.y1 };
    const a0 = along(e, p0);
    const a1 = along(e, p1);
    const d0 = -outward(e, p0);
    const d1 = -outward(e, p1);
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const L = Math.hypot(dx, dy);
    if (!(L > 0)) continue;
    const cos = Math.abs((dx * e.u.x + dy * e.u.y) / L);
    if (s.curve) {
      // Arc d'ouverture : morceaux de courbe à moins d'une largeur de vantail du trou.
      if (Math.min(a0, a1) >= t0 - 0.05 / mpp && Math.max(a0, a1) <= t1 + 0.05 / mpp && Math.max(Math.abs(d0), Math.abs(d1)) <= w * 1.1 + depthPt) {
        arc += L;
        arcA0 = Math.min(arcA0, a0, a1);
        arcA1 = Math.max(arcA1, a0, a1);
        arcD0 = Math.min(arcD0, Math.abs(d0), Math.abs(d1));
        arcD1 = Math.max(arcD1, Math.abs(d0), Math.abs(d1));
      }
      continue;
    }
    if (cos > 0.99) {
      const lo = Math.min(a0, a1);
      const hi = Math.max(a0, a1);
      const span = Math.min(hi, t1) - Math.max(lo, t0);
      const dm = (d0 + d1) / 2;
      if (span >= 0.7 * w && dm >= -0.02 / mpp && dm <= depthPt + 0.02 / mpp && hi - lo <= w * 1.2 + 0.1 / mpp) glazing++;
    } else if (cos < 0.12 && L >= 0.45 * w && L <= 1.25 * w) {
      const tm = (a0 + a1) / 2;
      const nearJamb = Math.min(Math.abs(tm - t0), Math.abs(tm - t1)) * mpp < 0.15;
      const dIn = Math.max(Math.abs(d0), Math.abs(d1));
      // Un vantail ouvert entre dans la pièce : son bout dépasse l'épaisseur du mur. Un trait perpendiculaire qui
      // reste dans le mur (retour de tableau, about d'isolant) n'en est pas un, même s'il a la longueur d'une
      // petite fenêtre.
      if (nearJamb && dIn <= w * 1.3 + depthPt && dIn * mpp >= LEAF_MIN_REACH_M) leaf = true;
    }
  }
  // Arc d'ouverture : un quart de cercle (deux quarts pour une porte double) qui part du mur. Sa longueur reste
  // inférieure à 2,3 fois sa plus grande étendue ; un cercle entier (lavabo, appareil) la dépasse, et un arc qui
  // ne s'approche pas à moins de 0,5 m de la face extérieure n'est pas posé sur ce mur.
  const extent = Math.max(arcA1 - arcA0, arcD1 - arcD0);
  const hasArc = arc >= 0.5 * w && extent > 0 && arc <= 2.3 * extent && arcD0 * mpp <= ARC_MAX_START_M;
  // Vitrage dessiné dans le trou et vantail en simple trait droit, sans arc : le trait droit est le plus souvent
  // une cloison qui aboutit au tableau ; on garde la fenêtre.
  const straightLeaf = leaf;
  if (glazing >= 2 && !hasArc) leaf = false;
  if (hasArc) leaf = true;
  return { glazing, leaf, arc: hasArc, straightLeaf };
}

function pairsFor(e: WallEdge, pairs: readonly ReadOpeningPair[], mpp: number): { p: ReadOpeningPair; t: number }[] {
  const max = 4 / mpp;
  return pairs
    .map((p) => ({ p, t: along(e, p.at), d: outward(e, p.at) }))
    .filter((x) => x.d > 0 && x.d < max && x.t > -0.3 / mpp && x.t < e.len + 0.3 / mpp)
    .map(({ p, t }) => ({ p, t }));
}

function roomAt(rooms: readonly RoomZone[], p: Vec2): string | null {
  for (const r of rooms) if (r.poly && pointInPoly(p.x, p.y, r.poly)) return r.label.name;
  return null;
}

/** Baies des arêtes extérieures (non mitoyennes) de l'emprise. */
export function planBays(
  segs: readonly RawSeg[],
  fp: Footprint,
  walls: OwnWalls,
  zones: ThermalZones,
  rooms: readonly RoomZone[],
  pairs: readonly ReadOpeningPair[],
  mpp: number,
): PlanBay[] {
  const out: PlanBay[] = [];
  const usedPairs = new Set<ReadOpeningPair>();
  for (const e of footprintEdges(fp, mpp)) {
    const mid = at(e, e.len / 2);
    if (onParty(mid, e.n, fp.party, mpp)) continue;
    const masCov = coverage(e, walls.masonry, 0.8 / mpp);
    const insCov = walls.insulation.length > 0 ? coverage(e, walls.insulation, 0.35 / mpp) : [];
    const masGaps = gapsOf(masCov, mpp);
    const insGaps = gapsOf(insCov, mpp);
    const edgePairs = pairsFor(e, pairs, mpp);
    // Épaisseur du mur à cet endroit : la bande couverte, au plus 0,8 m.
    const depthPt = 0.6 / mpp;
    for (const g of masGaps) {
      const c0 = (g.t0 + g.t1) / 2;
      const jb = jambs(segs, e, g, mpp);
      // Trou d'isolant propre à CE trou de maçonnerie : un trou d'isolant qui déborde nettement sur la maçonnerie
      // voisine couvre plusieurs baies (trumeau sans isolant dessiné) et ne dit rien de la largeur de celle-ci.
      const slack = 0.15 / mpp;
      const ig = insGaps.find((x) => x.t0 < g.t1 && x.t1 > g.t0 && x.t0 >= g.t0 - slack && x.t1 <= g.t1 + slack) ?? null;
      const tolT = Math.max(0.3 / mpp, 0.25 * (g.t1 - g.t0));
      const cand = edgePairs
        .filter((x) => !usedPairs.has(x.p) && Math.abs(x.t - c0) <= tolT && x.p.width <= g.widthM + 0.3)
        .sort((x, y) => Math.abs(x.t - c0) - Math.abs(y.t - c0))[0];
      const pair = cand?.p ?? null;
      if (pair) usedPairs.add(pair);
      const sources: string[] = ['masonry-gap'];
      if (jb) sources.push('jambs');
      if (ig) sources.push('insulation-gap');
      if (pair) sources.push('opening-pair');
      // Largeur et centre.
      let width: number;
      let wConf: number;
      let centreT = c0;
      if (pair) {
        width = pair.width;
        const second = (jb && Math.abs(jb.widthM - pair.width) <= 0.07) || (ig && Math.abs(ig.widthM - pair.width) <= 0.07);
        wConf = second ? 0.9 : 0.75;
        if (jb && Math.abs(jb.widthM - pair.width) <= 0.07) centreT = (jb.t0 + jb.t1) / 2;
      } else if (jb && ig && Math.abs(jb.widthM - ig.widthM) <= 0.07) {
        width = jb.widthM;
        wConf = 0.85;
        centreT = (jb.t0 + jb.t1) / 2;
      } else if (ig) {
        width = ig.widthM;
        wConf = jb && Math.abs(jb.widthM - ig.widthM) <= 0.12 ? 0.7 : 0.6;
        centreT = (ig.t0 + ig.t1) / 2;
      } else if (jb && Math.abs(jb.widthM - g.widthM) <= 0.07) {
        width = jb.widthM;
        wConf = 0.65;
        centreT = (jb.t0 + jb.t1) / 2;
      } else if (jb && jb.widthM >= 0.6 && jb.t0 >= g.t0 - slack && jb.t1 <= g.t1 + slack) {
        // Tableaux seuls, plus étroits que le trou de maçonnerie : une seule source, doute.
        width = jb.widthM;
        wConf = 0.55;
        centreT = (jb.t0 + jb.t1) / 2;
      } else {
        width = g.widthM;
        wConf = 0.45;
      }
      const half = width / mpp / 2;
      const a = at(e, centreT - half);
      const b = at(e, centreT + half);
      const behind = at(e, centreT, -1.0 / mpp);
      const inUnheated = zones.unheated.some((u) => pointInPoly(behind.x, behind.y, u.poly));
      const room = roomAt(rooms, behind);
      const sym = openingSymbol(segs, e, centreT - half, centreT + half, depthPt, mpp);
      if (sym.glazing >= 2) sources.push('glazing-lines');
      if (sym.leaf) sources.push('door-leaf');
      const op: DetectedOpening = { kind: 'unknown', a, b, width: round(width, 3), exterior: true, confidence: wConf };
      if (pair) {
        op.height = pair.height;
        op.heightFrom = 'plan-dim';
        if (pair.sill !== null) op.sill = pair.sill;
      }
      const sill = pair?.sill ?? null;
      const tall = pair ? pair.height >= 1.9 : false;
      const entrance = room !== null && ENTRANCE_RE.test(room);
      if (inUnheated) {
        // Local non chauffé (garage) : une large baie sans allège écrite est la porte du garage, même si son
        // tablier est dessiné en traits parallèles comme un vitrage.
        const noSill = !pair || ((pair.sill === null || pair.sill <= 0.05) && pair.height >= 1.9);
        if (width >= 2.0 && noSill) {
          op.kind = 'door';
          op.detail = 'garage-door';
          if (!pair && !sym.leaf) op.confidence = Math.min(op.confidence ?? 1, 0.65);
        } else if (width >= 1.8 && sym.glazing < 2) {
          op.kind = 'door';
          op.detail = 'garage-door';
        } else op.kind = sym.leaf && sym.glazing < 2 ? 'door' : sym.glazing >= 2 ? 'window' : width >= 1.8 ? 'door' : 'unknown';
        if (op.kind === 'door' && width >= 1.8) op.detail = 'garage-door';
      } else if (pair && sill !== null && sill > 0.05) {
        op.kind = 'window';
      } else if (pair && tall) {
        if (sym.leaf && sym.glazing < 2) {
          op.kind = 'door';
          if (entrance) op.detail = 'entrance-door';
        } else {
          op.kind = 'window';
          op.detail = 'french-window';
        }
      } else if (pair) {
        op.kind = 'window';
      } else if (entrance && sym.straightLeaf && !sym.leaf) {
        // Vitrage et vantail en trait droit sans arc, devant un hall : porte d'entrée probable, une seule source.
        op.kind = 'door';
        op.detail = 'entrance-door';
        op.confidence = Math.min(op.confidence ?? 1, 0.6);
      } else if (sym.glazing >= 2 && !sym.leaf) {
        op.kind = 'window';
      } else if (sym.leaf) {
        op.kind = 'door';
        if (entrance) op.detail = 'entrance-door';
      } else if (entrance) {
        op.kind = 'door';
        op.detail = 'entrance-door';
        op.confidence = Math.min(op.confidence ?? 1, 0.6);
      }
      if (op.kind === 'unknown') op.confidence = Math.min(op.confidence ?? 1, 0.45);
      out.push({ opening: op, edge: e, centre: at(e, centreT), inEnvelope: !inUnheated, room, sources });
    }
  }
  return out;
}

/** Portes entre logement et local non chauffé : ponts d'isolant posés à la limite chauffé / non chauffé. */
export function climateDoors(
  zones: ThermalZones,
  walls: OwnWalls,
  segs: readonly RawSeg[],
  rooms: readonly RoomZone[],
  pairs: readonly ReadOpeningPair[],
  mpp: number,
): PlanBay[] {
  const out: PlanBay[] = [];
  if (!zones.heated || zones.unheated.length === 0) return out;
  const inHeated = (p: Vec2): boolean => pointInPoly(p.x, p.y, zones.heated!);
  const inUnheated = (p: Vec2): boolean => zones.unheated.some((u) => pointInPoly(p.x, p.y, u.poly));
  const quadBox = (q: readonly Vec2[]) => polyBox({ outer: q as Vec2[], holes: [] });
  const tolB = 0.05 / mpp;
  for (const br of zones.bridges) {
    // Un pont qui en contient un autre enjambe un bout d'isolant : il double deux trous voisins, ce n'est pas une porte.
    const bb = quadBox(br.quad);
    const spans = zones.bridges.some((o) => {
      if (o === br) return false;
      const ob = quadBox(o.quad);
      return o.gapM < br.gapM && ob.minX >= bb.minX - tolB && ob.maxX <= bb.maxX + tolB && ob.minY >= bb.minY - tolB && ob.maxY <= bb.maxY + tolB;
    });
    if (spans) continue;
    const [q0, q1, q2, q3] = br.quad as [Vec2, Vec2, Vec2, Vec2];
    // q0q1 et q3q2 : les deux bouts de bande ; le trou va de leur milieu à l'autre.
    const m1 = { x: (q0.x + q1.x) / 2, y: (q0.y + q1.y) / 2 };
    const m2 = { x: (q2.x + q3.x) / 2, y: (q2.y + q3.y) / 2 };
    const gx = m2.x - m1.x;
    const gy = m2.y - m1.y;
    const gl = Math.hypot(gx, gy);
    if (!(gl > 0)) continue;
    const nrm = { x: -gy / gl, y: gx / gl };
    const c = { x: (m1.x + m2.x) / 2, y: (m1.y + m2.y) / 2 };
    const probe = 0.4 / mpp;
    const pA = { x: c.x + nrm.x * probe, y: c.y + nrm.y * probe };
    const pB = { x: c.x - nrm.x * probe, y: c.y - nrm.y * probe };
    let heatedSide: Vec2 | null = null;
    if (inHeated(pA) && inUnheated(pB)) heatedSide = { x: nrm.x, y: nrm.y };
    else if (inHeated(pB) && inUnheated(pA)) heatedSide = { x: -nrm.x, y: -nrm.y };
    if (!heatedSide) continue;
    const roomPt = { x: c.x + heatedSide.x * (0.8 / mpp), y: c.y + heatedSide.y * (0.8 / mpp) };
    const room = roomAt(rooms, roomPt);
    // Le mur est-il aussi ouvert (maçonnerie absente sur le trou) ? Sinon simple reprise d'isolant.
    const ux = gx / gl;
    const uy = gy / gl;
    const s = 0.08 / mpp;
    const p1 = { x: m1.x + ux * s, y: m1.y + uy * s };
    const p2 = { x: m2.x - ux * s, y: m2.y - uy * s };
    const off = (p: Vec2, d: number): Vec2 => ({ x: p.x + heatedSide!.x * (d / mpp), y: p.y + heatedSide!.y * (d / mpp) });
    const corridor: Poly = { outer: [off(p1, 0.02), off(p2, 0.02), off(p2, 0.6), off(p1, 0.6)], holes: [] };
    const masonryIn = intersectPolys([corridor], walls.masonry).reduce((sum, p) => sum + p.outer.length, 0) > 0;
    const e: WallEdge = { a: m1, b: m2, u: { x: gx / gl, y: gy / gl }, n: { x: -heatedSide.x, y: -heatedSide.y }, len: gl, index: -1 };
    const sym = openingSymbol(segs, e, 0, gl, 0.6 / mpp, mpp);
    // Mur fermé derrière le trou d'isolant et aucun vantail : reprise d'isolant, pas une porte.
    if (masonryIn && !sym.leaf) continue;
    const sources = ['insulation-gap'];
    if (!masonryIn) sources.push('masonry-gap');
    if (sym.leaf) sources.push('door-leaf');
    const pair = pairs.find((p) => Math.hypot(p.at.x - c.x, p.at.y - c.y) * mpp < 1.2) ?? null;
    const op: DetectedOpening = {
      kind: 'door',
      a: m1,
      b: m2,
      width: round(br.gapM, 3),
      exterior: false,
      toUnheated: true,
      detail: 'door-to-unheated',
      confidence: !masonryIn || sym.leaf ? 0.8 : 0.5,
    };
    if (pair) {
      op.height = pair.height;
      op.heightFrom = 'plan-dim';
      sources.push('opening-pair');
    }
    out.push({ opening: op, edge: e, centre: c, inEnvelope: true, room, sources });
  }
  return out;
}
