/**
 * Petits outils géométriques du module (purs, sans jsts : voir planar.ts pour les opérations booléennes).
 */
import type { Vec2 } from '../../../core/types';
import { polyArea, ringArea, type Poly } from '../planar';
import type { RawBox } from '../raw';

export function polyBox(p: Poly): RawBox {
  return ringBox(p.outer);
}

export function ringBox(r: readonly Vec2[]): RawBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of r) {
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boxesBox(bs: readonly RawBox[]): RawBox | null {
  if (bs.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bs) {
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}

export function boxW(b: RawBox): number {
  return b.maxX - b.minX;
}

export function boxH(b: RawBox): number {
  return b.maxY - b.minY;
}

export function boxesNear(a: RawBox, b: RawBox, d: number): boolean {
  return a.minX <= b.maxX + d && b.minX <= a.maxX + d && a.minY <= b.maxY + d && b.minY <= a.maxY + d;
}

export function boxContains(outer: RawBox, inner: RawBox, tol: number): boolean {
  return inner.minX >= outer.minX - tol && inner.minY >= outer.minY - tol && inner.maxX <= outer.maxX + tol && inner.maxY <= outer.maxY + tol;
}

/** Luminance (0 noir … 1 blanc) d'une couleur 0xRRGGBB. */
export function luminance(color: number): number {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  return (0.3 * r + 0.59 * g + 0.11 * b) / 255;
}

/** Épaisseur caractéristique d'une forme mince : 2 × aire / périmètre (une bande L × e donne ≈ e). */
export function thickness(p: Poly): number {
  let per = 0;
  for (const r of [p.outer, ...p.holes]) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      per += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return per > 0 ? (2 * polyArea(p)) / per : 0;
}

/** Part de la boîte englobante occupée par l'anneau extérieur (1 = rectangle aligné sur les axes). */
export function rectangularity(r: readonly Vec2[]): number {
  const b = ringBox(r);
  const a = boxW(b) * boxH(b);
  return a > 0 ? ringArea(r) / a : 0;
}

/** Fusionne les sommets presque alignés (écart à la corde < tol), y compris autour du premier sommet. */
export function mergeCollinear(ring: readonly Vec2[], tol: number): Vec2[] {
  const pts = ring.map((p) => ({ x: p.x, y: p.y }));
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      const L = Math.hypot(c.x - a.x, c.y - a.y);
      if (L === 0 || Math.hypot(b.x - a.x, b.y - a.y) < tol * 0.01) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
      const d = Math.abs((c.x - a.x) * (a.y - b.y) - (a.x - b.x) * (c.y - a.y)) / L;
      if (d < tol) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/**
 * Redresse un anneau presque orthogonal : chaque arête à moins de `angTolDeg` d'un axe y est ramenée, les
 * sommets étant recalculés à l'intersection des arêtes voisines. Les arêtes vraiment obliques sont gardées.
 */
export function orthogonalize(ring: readonly Vec2[], angTolDeg = 4): Vec2[] {
  const n = ring.length;
  if (n < 4) return ring.map((p) => ({ x: p.x, y: p.y }));
  type Line = { kind: 'h' | 'v' | 'o'; at: number; a: Vec2; b: Vec2 };
  const lines: Line[] = [];
  const tol = Math.tan((angTolDeg * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    if (dy <= dx * tol) lines.push({ kind: 'h', at: (a.y + b.y) / 2, a, b });
    else if (dx <= dy * tol) lines.push({ kind: 'v', at: (a.x + b.x) / 2, a, b });
    else lines.push({ kind: 'o', at: 0, a, b });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n]!;
    const cur = lines[i]!;
    const p = ring[i]!;
    if (prev.kind === 'h' && cur.kind === 'v') out.push({ x: cur.at, y: prev.at });
    else if (prev.kind === 'v' && cur.kind === 'h') out.push({ x: prev.at, y: cur.at });
    else if (prev.kind === 'h' && cur.kind === 'o') out.push({ x: p.x, y: prev.at });
    else if (prev.kind === 'o' && cur.kind === 'h') out.push({ x: p.x, y: cur.at });
    else if (prev.kind === 'v' && cur.kind === 'o') out.push({ x: prev.at, y: p.y });
    else if (prev.kind === 'o' && cur.kind === 'v') out.push({ x: cur.at, y: p.y });
    else out.push({ x: p.x, y: p.y });
  }
  return mergeCollinear(out, 1e-6);
}

/** Côté d'une normale extérieure dans le repère de la feuille : azimut en degrés depuis le haut, sens horaire. */
export function sheetAzimuth(n: Vec2): number {
  const deg = (Math.atan2(n.x, -n.y) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Plus petit écart entre deux angles (degrés). */
export function angleGap(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Arrondi à n décimales. */
export function round(v: number, n = 2): number {
  const k = 10 ** n;
  return Math.round(v * k) / k;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Nombre écrit à la française ou à l'allemande (« 2,07 », « 2.07 ») → valeur ; NaN sinon. */
export function parseDecimal(s: string): number {
  return Number(s.replace(',', '.'));
}
