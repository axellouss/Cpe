/**
 * Enveloppe thermique d'un niveau.
 *
 * Partage de l'emprise en zones chauffée / non chauffée : croissance simultanée sur trame de 2 cm depuis les pièces,
 * l'isolant faisant barrière. Les trous de l'isolant à une largeur de porte (porte entre logement et garage) sont
 * d'abord pontés (deux bouts de bande d'isolant qui se font face) : la porte reste une porte, pas une fuite. Une pièce
 * est une graine non chauffée si son NOM le dit (garage, cave…) ; le recoupement est l'isolant : un local nommé
 * non chauffé que l'isolant ne sépare pas du logement est un doute.
 *
 * Puis la nature de chaque arête du contour chauffé (façade, vers le non chauffé, mitoyenne), les surfaces sans
 * étiquette du volume chauffé (escalier) et la longueur des parois vers le non chauffé.
 */
import type { Vec2 } from '../../../core/types';
import { bufferPolys, differencePolys, intersectPolys, pointInPoly, pointRingDistance, polyArea, type Poly } from '../planar';
import type { Footprint, PartyLine } from './footprint';
import type { RawSeg } from '../raw';
import { Grid } from './grid';
import { wallBridges, type RoomZone } from './rooms';
import { mergeCollinear, orthogonalize, polyBox, thickness } from './util';

export interface ThermalZones {
  heated: Poly | null;
  unheated: { poly: Poly; names: string[]; areaM2: number }[];
  /**
   * Locaux nommés non chauffés que l'isolant ne sépare pas du chauffé : ils RESTENT dans le contour chauffé (et hors de
   * `unheated`), avec une question.
   */
  unsealed: string[];
  /**
   * Locaux nommés non chauffés, séparés par l'isolant mais entourés par le chauffé (sans arête sur l'emprise) : le
   * contour chauffé n'a pas de trou, ils y restent, hors de `unheated`, avec une question. Chauffé + non chauffé =
   * emprise, toujours.
   */
  enclosed: string[];
  /** Ponts posés sur les trous d'isolant (portes possibles), quadrilatères en points. */
  bridges: { quad: Vec2[]; gapM: number }[];
}

export interface SeedRoom {
  poly: Poly;
  heated: boolean;
  name: string;
}

export function splitHeatedZones(fp: Footprint, rooms: readonly SeedRoom[], insulation: readonly Poly[], mpp: number): ThermalZones {
  const bridges = wallBridges(insulation, mpp, { minGapM: 0.5, maxGapM: 2.6, minEdgeM: 0.05, maxEdgeM: 0.45 })
    .filter((br) => {
      // Un pont ne recouvre pas l'isolant lui-même (bande coupée en deux morceaux voisins = pas un trou).
      const q: Poly = { outer: br.quad, holes: [] };
      const over = intersectPolys([q], insulation).reduce((s, p) => s + polyArea(p), 0);
      return over < 0.2 * polyArea(q);
    })
    .map((br) => ({ quad: br.quad, gapM: br.gapM }));
  const anyUnheated = rooms.some((r) => !r.heated);
  if (!anyUnheated) return { heated: fp.poly, unheated: [], unsealed: [], enclosed: [], bridges };
  const res = 0.02 / mpp;
  const b = polyBox(fp.poly);
  const g = new Grid(b.minX - 2 * res, b.minY - 2 * res, res, b.maxX + 2 * res, b.maxY + 2 * res);
  const inside = g.mask();
  g.fill(inside, fp.poly);
  const barrier = g.mask();
  for (const p of insulation) g.fill(barrier, p);
  for (const br of bridges) g.fill(barrier, { outer: br.quad, holes: [] });
  // 0 libre, −1 hors emprise ou barrière, sinon 1 + indice de la graine.
  const lab = new Int32Array(g.size);
  for (let c = 0; c < lab.length; c++) if (!inside[c] || barrier[c]) lab[c] = -1;
  const q = new Int32Array(g.size);
  let tail = 0;
  rooms.forEach((r, k) => {
    const m = g.mask();
    g.fill(m, r.poly);
    for (let c = 0; c < m.length; c++) {
      if (m[c] && lab[c] === 0) {
        lab[c] = k + 1;
        q[tail++] = c;
      }
    }
  });
  const W = g.w;
  const H = g.h;
  for (let head = 0; head < tail; head++) {
    const c = q[head]!;
    const i = c % W;
    const j = (c / W) | 0;
    const v = lab[c]!;
    if (i + 1 < W && lab[c + 1] === 0) (lab[c + 1] = v), (q[tail++] = c + 1);
    if (i > 0 && lab[c - 1] === 0) (lab[c - 1] = v), (q[tail++] = c - 1);
    if (j + 1 < H && lab[c + W] === 0) (lab[c + W] = v), (q[tail++] = c + W);
    if (j > 0 && lab[c - W] === 0) (lab[c - W] = v), (q[tail++] = c - W);
  }
  // Contacts directs (sans barrière) entre une zone non chauffée et une zone chauffée.
  const contact = new Map<number, number>();
  const heatedOf = (v: number): boolean => v > 0 && rooms[v - 1]!.heated;
  for (let c = 0; c < lab.length; c++) {
    const v = lab[c]!;
    if (v <= 0 || heatedOf(v)) continue;
    const i = c % W;
    for (const n of [i + 1 < W ? c + 1 : -1, c + W < lab.length ? c + W : -1, i > 0 ? c - 1 : -1, c - W]) {
      if (n < 0) continue;
      const u = lab[n]!;
      if (u > 0 && heatedOf(u)) contact.set(v, (contact.get(v) ?? 0) + 1);
    }
  }
  // Seuil 1 m : un mur mitoyen non isolé touche à la fois le garage et le séjour sur son épaisseur (≈ 0,3 m).
  const unsealed = [...contact].filter(([, n]) => n * res * mpp > 1.0).map(([v]) => rooms[v - 1]!.name);
  // Une composante par groupe de locaux non chauffés contigus.
  const um = g.mask();
  for (let c = 0; c < lab.length; c++) if (lab[c]! > 0 && !heatedOf(lab[c]!)) um[c] = 1;
  const unheated: ThermalZones['unheated'] = [];
  for (const comp of g.components(um)) {
    if (comp.length * res * res * mpp * mpp < 0.5) continue;
    const names = [...new Set(comp.map((c) => rooms[lab[c]! - 1]!.name))];
    // Local que l'isolant ne sépare pas du logement : il reste chauffé (la question le dit), jamais retiré.
    if (names.some((n) => unsealed.includes(n))) continue;
    // Ouverture morphologique de 0,2 m : la croissance déborde un peu dans l'épaisseur d'un mur non isolé (mur
    // mitoyen commun au garage et au séjour) ; ces languettes de moins de 0,4 m ne sont pas du local.
    const r = 0.2 / mpp;
    for (const p of bufferPolys(bufferPolys(g.cellsToPolys(comp), -r), r)) {
      const ring = orthogonalize(mergeCollinear(p.outer, 0.03 / mpp));
      const poly: Poly = { outer: ring, holes: [] };
      const a = polyArea(poly) * mpp * mpp;
      if (a >= 0.5) unheated.push({ poly, names, areaM2: a });
    }
  }
  if (unheated.length === 0) return { heated: fp.poly, unheated: [], unsealed, enclosed: [], bridges };
  // Zone chauffée = emprise − non chauffé, en vectoriel : les bords extérieurs restent ceux de l'emprise.
  // Ouverture de 5 cm : le local non chauffé s'arrête souvent à un ou deux centimètres de l'emprise (trait du mur
  // extérieur) ; la languette qui resterait relierait sinon le chauffé tout autour du local, et la simplification
  // des sommets la refermerait en rendant l'emprise entière.
  const sliver = 0.05 / mpp;
  const rest = bufferPolys(bufferPolys(differencePolys([fp.poly], unheated.map((u) => u.poly)), -sliver), sliver);
  rest.sort((x, y) => polyArea(y) - polyArea(x));
  const main = rest[0];
  let heated: Poly | null = null;
  if (main && polyArea(main) * mpp * mpp >= 1) {
    heated = { outer: orthogonalize(mergeCollinear(main.outer, 0.03 / mpp)), holes: [] };
  }
  // Le contour chauffé est un anneau sans trou : un local non chauffé qu'il recouvre encore (entouré par le logement)
  // y reste, chauffé avec une question, et sort de la liste des non chauffés.
  const enclosed: string[] = [];
  if (heated) {
    const h = heated;
    for (let i = unheated.length - 1; i >= 0; i--) {
      const u = unheated[i]!;
      const over = intersectPolys([u.poly], [h]).reduce((sum, p) => sum + polyArea(p), 0);
      if (over > 0.5 * polyArea(u.poly)) {
        enclosed.push(...u.names.filter((n) => !enclosed.includes(n)));
        unheated.splice(i, 1);
      }
    }
    if (unheated.length === 0) return { heated: fp.poly, unheated: [], unsealed, enclosed, bridges };
  }
  // Les locaux non chauffés recalés sur l'emprise (une cellule de jeu avec ses bords).
  for (const u of unheated) {
    const fit = intersectPolys([u.poly], [fp.poly]);
    fit.sort((x, y) => polyArea(y) - polyArea(x));
    if (fit[0]) u.poly = { outer: orthogonalize(mergeCollinear(fit[0].outer, 0.03 / mpp)), holes: [] };
  }
  return { heated, unheated, unsealed, enclosed, bridges };
}

// ───────────────────────────── Arêtes du contour chauffé ─────────────────────────────

export type EdgeKind = 'exterior' | 'party' | 'unheated' | 'other';

export interface EnvelopeEdge {
  a: Vec2;
  b: Vec2;
  lengthM: number;
  /** Normale extérieure (unitaire, repère de la feuille). */
  n: Vec2;
  kind: EdgeKind;
  /** Part de l'arête doublée d'isolant (bande de 0,3 m à l'intérieur), 0..1. */
  insulatedShare: number;
}

function outwardNormal(ring: readonly Vec2[], i: number, poly: Poly): Vec2 {
  const a = ring[i]!;
  const b = ring[(i + 1) % ring.length]!;
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let n = { x: (b.y - a.y) / L, y: -(b.x - a.x) / L };
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const eps = Math.max(0.05, L * 1e-3);
  if (pointInPoly(m.x + n.x * eps, m.y + n.y * eps, poly)) n = { x: -n.x, y: -n.y };
  return n;
}

export function onParty(m: Vec2, n: Vec2, party: readonly PartyLine[], mpp: number): boolean {
  return party.some((p) => {
    if (p.axis === 'x') return Math.abs(n.x) > 0.9 && Math.abs(m.x - p.at) * mpp < 0.1 && m.y >= p.span[0] - 0.5 / mpp && m.y <= p.span[1] + 0.5 / mpp;
    return Math.abs(n.y) > 0.9 && Math.abs(m.y - p.at) * mpp < 0.1 && m.x >= p.span[0] - 0.5 / mpp && m.x <= p.span[1] + 0.5 / mpp;
  });
}

function insulatedShare(a: Vec2, b: Vec2, n: Vec2, insulation: readonly Poly[], mpp: number): number {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(L > 0)) return 0;
  const d = 0.3 / mpp;
  const band: Poly = { outer: [a, b, { x: b.x - n.x * d, y: b.y - n.y * d }, { x: a.x - n.x * d, y: a.y - n.y * d }], holes: [] };
  const bb = polyBox(band);
  const near = insulation.filter((p) => {
    const pb = polyBox(p);
    return pb.minX <= bb.maxX && pb.maxX >= bb.minX && pb.minY <= bb.maxY && pb.maxY >= bb.minY;
  });
  if (near.length === 0) return 0;
  const area = intersectPolys([band], near).reduce((s, p) => s + polyArea(p), 0);
  // Une bande d'isolant de 5 cm au moins tout le long = arête isolée.
  return Math.min(1, area / (L * (0.05 / mpp)));
}

/** Nature de chaque arête du contour chauffé (dans l'ordre de ses sommets). */
export function classifyBoundary(zones: ThermalZones, fp: Footprint, insulation: readonly Poly[], mpp: number): EnvelopeEdge[] {
  const heated = zones.heated;
  if (!heated) return [];
  const ring = heated.outer;
  const tol = 0.06 / mpp;
  const out: EnvelopeEdge[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const n = outwardNormal(ring, i, heated);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const probe = { x: m.x + n.x * tol, y: m.y + n.y * tol };
    let kind: EdgeKind = 'other';
    if (zones.unheated.some((u) => pointInPoly(probe.x, probe.y, u.poly) || pointRingDistance(m.x, m.y, u.poly.outer) < tol * 0.5)) kind = 'unheated';
    else if (pointRingDistance(m.x, m.y, fp.ring) < tol || !pointInPoly(probe.x, probe.y, fp.poly)) kind = onParty(m, n, fp.party, mpp) ? 'party' : 'exterior';
    out.push({ a, b, lengthM: L * mpp, n, kind, insulatedShare: insulatedShare(a, b, n, insulation, mpp) });
  }
  return out;
}

/** Longueur des parois entre chauffé et non chauffé (somme des arêtes du contour chauffé qui longent un local non chauffé). */
export function wallToUnheatedM(edges: readonly EnvelopeEdge[]): number {
  return edges.filter((e) => e.kind === 'unheated').reduce((s, e) => s + e.lengthM, 0);
}

/** Ce que semble être une surface sans étiquette, d'après ce qui est dessiné dedans. */
export type UnlabelledKind = 'stairs' | 'void' | 'passage' | 'unknown';

export interface UnlabelledArea {
  poly: Poly;
  areaM2: number;
  kind: UnlabelledKind;
}

/** Largeur minimale d'un passage (m) : plus mince, une surface n'est jamais une surface habitable sans étiquette. */
const MIN_PASSAGE_M = 0.6;

/** Vrai si la surface tient partout dans une bande plus mince que `widthM` (érosion de la demi-largeur : rien ne reste). */
function narrowerThan(p: Poly, widthM: number, mpp: number): boolean {
  return bufferPolys([p], -(widthM / 2) / mpp).every((q) => polyArea(q) * mpp * mpp < 0.01);
}

/**
 * Nature probable d'une surface sans étiquette, par ce qui est tracé dedans :
 * - escalier : au moins 5 traits parallèles de 0,5 m ou plus, de même longueur à 20 % près, dont au moins 4 écarts
 *   successifs de 0,15 à 0,40 m (les marches) ;
 * - trémie : deux traits qui traversent la surface en diagonale, dans deux directions (la croix du vide) ;
 * - dégagement : moins de 1,3 m de large partout et allongé (longueur ≥ 2,5 × largeur) ;
 * sinon inconnue. Les signaux sont la structure du dessin, jamais une couleur.
 */
export function unlabelledKind(p: Poly, segs: readonly RawSeg[], mpp: number): UnlabelledKind {
  const b = polyBox(p);
  const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
  const inside = segs.filter((s) => pointInPoly((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, p));
  const dirOf = (s: RawSeg): number => (((Math.atan2(s.y1 - s.y0, s.x1 - s.x0) * 180) / Math.PI) + 360) % 180;
  const lenOf = (s: RawSeg): number => Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
  // Marches : traits regroupés par direction (à 3° près), puis par longueur.
  const groups = new Map<number, RawSeg[]>();
  for (const s of inside) {
    if (lenOf(s) * mpp < 0.5) continue;
    const k = Math.round(dirOf(s) / 3) % 60;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  for (const g of groups.values()) {
    if (g.length < 5) continue;
    const L = g.map(lenOf).sort((x, y) => x - y)[Math.floor(g.length / 2)]!;
    const same = g.filter((s) => Math.abs(lenOf(s) / L - 1) <= 0.2);
    if (same.length < 5) continue;
    const a = (dirOf(same[0]!) * Math.PI) / 180;
    const nx = -Math.sin(a);
    const ny = Math.cos(a);
    const pos = same.map((s) => ((s.x0 + s.x1) / 2) * nx + ((s.y0 + s.y1) / 2) * ny).sort((x, y) => x - y);
    let regular = 0;
    for (let i = 1; i < pos.length; i++) {
      const d = (pos[i]! - pos[i - 1]!) * mpp;
      if (d >= 0.15 && d <= 0.4) regular++;
    }
    if (regular >= 4) return 'stairs';
  }
  const diagonals = inside.filter((s) => {
    const d = dirOf(s);
    return lenOf(s) >= 0.6 * diag && d > 15 && d < 165 && Math.abs(d - 90) > 15;
  });
  if (diagonals.some((s) => diagonals.some((t) => t !== s && Math.abs(dirOf(s) - dirOf(t)) > 30))) return 'void';
  if (narrowerThan(p, 1.3, mpp)) {
    // Rectangle de même aire et même périmètre : largeur w et longueur l (w + l = P / 2, w · l = A).
    const A = polyArea(p) * mpp * mpp;
    const half = (2 * A) / Math.max(1e-9, thickness(p) * mpp) / 2;
    const w = (half - Math.sqrt(Math.max(0, half * half - 4 * A))) / 2;
    if (w > 0 && A / w >= 2.5 * w) return 'passage';
  }
  return 'unknown';
}

/**
 * Surfaces sans étiquette du volume chauffé : zone chauffée − pièces − murs, morceaux d'au moins 1 m² et assez
 * trapus. D'abord les remplissages de pièce sans étiquette (escalier dessiné en zone), puis le reste.
 *
 * Jamais une surface habitable sans étiquette : une bande plus mince qu'un passage (0,6 m partout), ni une bande
 * dans l'épaisseur d'un mur au droit d'une baie (embrasure : un centre de baie à moins de 0,8 m, et moins de 0,8 m
 * de large partout). Chaque surface gardée porte son polygone et ce qu'elle semble être (`unlabelledKind`).
 */
export function unlabelledAreas(
  heated: Poly | null,
  rooms: readonly RoomZone[],
  walls: readonly Poly[],
  unlabelledFills: readonly Poly[],
  mpp: number,
  context: { segs?: readonly RawSeg[]; bayCentres?: readonly Vec2[] } = {},
): UnlabelledArea[] {
  if (!heated) return [];
  const used = rooms.filter((r) => r.poly).map((r) => r.poly!);
  const out: UnlabelledArea[] = [];
  const taken: Poly[] = [];
  const bays = context.bayCentres ?? [];
  const segs = context.segs ?? [];
  const habitable = (p: Poly): boolean => {
    if (narrowerThan(p, MIN_PASSAGE_M, mpp)) return false;
    const nearBay = bays.some((c) => pointInPoly(c.x, c.y, p) || pointRingDistance(c.x, c.y, p.outer) * mpp < 0.8);
    return !(nearBay && narrowerThan(p, 0.8, mpp));
  };
  for (const f of unlabelledFills) {
    const inside = intersectPolys([f], [heated]);
    const a = inside.reduce((s, p) => s + polyArea(p), 0) * mpp * mpp;
    if (a < 1 || a < 0.9 * polyArea(f) * mpp * mpp) continue;
    if (used.some((u) => intersectPolys([u], [f]).reduce((s, p) => s + polyArea(p), 0) > 0.2 * polyArea(f))) continue;
    // Écartée ou non, elle sort du reste : une embrasure ne doit pas réapparaître plus bas.
    taken.push(f);
    if (!habitable(f)) continue;
    out.push({ poly: f, areaM2: a, kind: unlabelledKind(f, segs, mpp) });
  }
  // Ouverture morphologique de 0,15 m : les joints entre pièces et murs, les passages et les embrasures de baies
  // (moins de 0,3 m de large) relient sinon l'escalier à tout le reste du niveau.
  const r = 0.15 / mpp;
  const rest = bufferPolys(bufferPolys(differencePolys([heated], [...used, ...walls, ...taken]), -r), r);
  for (const p of rest) {
    const a = polyArea(p) * mpp * mpp;
    if (a < 1 || thickness(p) * mpp < 0.4 || !habitable(p)) continue;
    out.push({ poly: p, areaM2: a, kind: unlabelledKind(p, segs, mpp) });
  }
  return out;
}

/** Plancher d'un étage au-dessus d'un local non chauffé du niveau du dessous (repère commun : décalage `offset`). */
export function floorOverUnheated(
  lowerUnheated: readonly Poly[],
  upperHeated: Poly | null,
  offset: Vec2,
  mpp: number,
): { poly: Poly; areaM2: number }[] {
  if (!upperHeated || lowerUnheated.length === 0) return [];
  const moved = lowerUnheated.map((u) => ({ outer: u.outer.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })), holes: [] }));
  return intersectPolys([upperHeated], moved)
    .map((p) => ({ poly: p, areaM2: polyArea(p) * mpp * mpp }))
    .filter((x) => x.areaM2 >= 0.5);
}
