/**
 * Du contour « en escalier » suivi sur la trame au polygone proposé à l'expert :
 * simplification (Douglas-Peucker sur un anneau fermé), accrochage aux sommets exacts des maillages
 * (coins de murs et de locaux), puis suppression des sommets alignés.
 * Fonctions pures ; repère quelconque (les mêmes unités partout).
 */
import type { Vec2 } from '../../core/types';

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas-Peucker sur la chaîne ouverte pts[from..to] (indices pris modulo n) ; marque les sommets gardés. */
function simplifyChain(pts: readonly Vec2[], from: number, to: number, tol: number, keep: Uint8Array): void {
  const n = pts.length;
  const stack: number[] = [from, to];
  while (stack.length > 0) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const pa = pts[a % n]!;
    const pb = pts[b % n]!;
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i % n]!, pa, pb);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst % n] = 1;
      stack.push(a, worst, worst, b);
    }
  }
}

/** Simplifie un anneau fermé (sans point de fermeture répété) à la tolérance donnée. */
export function simplifyRing(pts: readonly Vec2[], tol: number): Vec2[] {
  const n = pts.length;
  if (n <= 4) return pts.map((p) => ({ x: p.x, y: p.y }));
  // Deux ancres sûres : le sommet le plus à gauche et le plus éloigné de lui.
  let i0 = 0;
  for (let i = 1; i < n; i++) {
    const p = pts[i]!;
    const q = pts[i0]!;
    if (p.x < q.x || (p.x === q.x && p.y < q.y)) i0 = i;
  }
  let i1 = i0;
  let far = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(pts[i]!.x - pts[i0]!.x, pts[i]!.y - pts[i0]!.y);
    if (d > far) {
      far = d;
      i1 = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[i0] = 1;
  keep[i1] = 1;
  const a = Math.min(i0, i1);
  const b = Math.max(i0, i1);
  simplifyChain(pts, a, b, tol, keep);
  simplifyChain(pts, b, a + n, tol, keep);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) out.push({ x: pts[i]!.x, y: pts[i]!.y });
  return out;
}

/** Index spatial de points (hachage sur une grille de pas `radius`). */
export class PointIndex {
  private readonly buckets = new Map<number, number[]>();
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly seen = new Set<number>();

  constructor(
    private readonly radius: number,
    private readonly originX: number,
    private readonly originY: number,
  ) {}

  private key(ix: number, iy: number): number {
    return (ix + 1048576) * 2097152 + (iy + 1048576);
  }

  /** Ajoute un point (les doublons au dixième de millimètre sont ignorés). */
  add(x: number, y: number): void {
    const fine = Math.round((x - this.originX) * 1e4) * 67108864 + Math.round((y - this.originY) * 1e4);
    if (this.seen.has(fine)) return;
    this.seen.add(fine);
    const k = this.key(Math.floor((x - this.originX) / this.radius), Math.floor((y - this.originY) / this.radius));
    const idx = this.xs.length;
    this.xs.push(x);
    this.ys.push(y);
    const b = this.buckets.get(k);
    if (b) b.push(idx);
    else this.buckets.set(k, [idx]);
  }

  /** Ajoute tous les sommets (x, y) d'une soupe de triangles [x, y, z, …]. */
  addSoup(soup: Float32Array): void {
    for (let i = 0; i + 2 < soup.length; i += 3) this.add(soup[i]!, soup[i + 1]!);
  }

  /** Point indexé le plus proche de (x, y) à moins de `radius`, ou null. */
  nearest(x: number, y: number): Vec2 | null {
    const ix = Math.floor((x - this.originX) / this.radius);
    const iy = Math.floor((y - this.originY) / this.radius);
    let best = -1;
    let bestD = this.radius;
    for (let a = ix - 1; a <= ix + 1; a++) {
      for (let b = iy - 1; b <= iy + 1; b++) {
        const bucket = this.buckets.get(this.key(a, b));
        if (!bucket) continue;
        for (const idx of bucket) {
          const d = Math.hypot(this.xs[idx]! - x, this.ys[idx]! - y);
          if (d <= bestD) {
            bestD = d;
            best = idx;
          }
        }
      }
    }
    return best < 0 ? null : { x: this.xs[best]!, y: this.ys[best]! };
  }
}

/** Retire les doublons consécutifs puis, tant qu'il y en a, les sommets à moins de `tol` de la droite de leurs voisins. */
export function dropCollinear(pts: readonly Vec2[], tol: number): Vec2[] {
  let ring: Vec2[] = [];
  for (const p of pts) {
    const last = ring[ring.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) ring.push(p);
  }
  while (ring.length > 1 && Math.hypot(ring[0]!.x - ring[ring.length - 1]!.x, ring[0]!.y - ring[ring.length - 1]!.y) <= 1e-6) ring.pop();
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length && ring.length > 3; i++) {
      const n = ring.length;
      if (distToSegment(ring[i]!, ring[(i - 1 + n) % n]!, ring[(i + 1) % n]!) <= tol) {
        ring = ring.filter((_, k) => k !== i);
        i--;
        changed = true;
      }
    }
  }
  return ring;
}

/**
 * Contour proposé : anneau en escalier → polygone net.
 *
 * Les sommets de l'escalier s'écartent de la vraie façade d'au plus ~0,7 maille de part et d'autre ; la
 * simplification tolère donc 1,5 maille. Chaque sommet gardé est ensuite raccroché au sommet exact le plus
 * proche (coin de mur ou de local) ; un sommet resté sur la trame n'est conservé que s'il marque un vrai angle.
 *
 * @param stair   sommets suivis sur la trame
 * @param cell    maille de la trame (m)
 * @param exact   sommets exacts des maillages (index de rayon ≥ 3 mailles), ou null
 */
export function cleanOutline(stair: readonly Vec2[], cell: number, exact: PointIndex | null): Vec2[] {
  if (stair.length < 3) return [];
  const simplified = simplifyRing(stair, 1.5 * cell);
  let ring: { p: Vec2; snapped: boolean }[] = [];
  for (const p of simplified) {
    const hit = exact ? exact.nearest(p.x, p.y) : null;
    const q = hit ?? p;
    const last = ring[ring.length - 1];
    if (last && Math.hypot(q.x - last.p.x, q.y - last.p.y) <= 1e-6) continue;
    ring.push({ p: q, snapped: hit !== null });
  }
  while (ring.length > 1 && Math.hypot(ring[0]!.p.x - ring[ring.length - 1]!.p.x, ring[0]!.p.y - ring[ring.length - 1]!.p.y) <= 1e-6) ring.pop();
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length && ring.length > 3; i++) {
      const n = ring.length;
      const cur = ring[i]!;
      const tol = cur.snapped ? 0.4 * cell : 1.5 * cell;
      if (distToSegment(cur.p, ring[(i - 1 + n) % n]!.p, ring[(i + 1) % n]!.p) <= tol) {
        ring = ring.filter((_, k) => k !== i);
        i--;
        changed = true;
      }
    }
  }
  return ring.length >= 3 ? ring.map((v) => ({ x: v.p.x, y: v.p.y })) : [];
}
