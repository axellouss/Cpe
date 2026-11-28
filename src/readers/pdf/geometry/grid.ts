/**
 * Trame binaire (cellules carrées) pour les opérations qui se font mal en vectoriel : enveloppe orthoconvexe,
 * croissance de zones avec barrières, distances de Tchebychev. Pas typique : 2 cm réels.
 */
import { unionPolys, type Poly } from '../planar';
import { polyBox } from './util';

export class Grid {
  readonly w: number;
  readonly h: number;

  constructor(
    readonly x0: number,
    readonly y0: number,
    readonly res: number,
    x1: number,
    y1: number,
  ) {
    this.w = Math.max(1, Math.ceil((x1 - x0) / res) + 1);
    this.h = Math.max(1, Math.ceil((y1 - y0) / res) + 1);
  }

  get size(): number {
    return this.w * this.h;
  }

  mask(): Uint8Array {
    return new Uint8Array(this.w * this.h);
  }

  /** Marque (valeur `v`) les cellules dont le centre est dans le polygone (trous compris, pair-impair). */
  fill(m: Uint8Array | Int8Array | Int32Array, p: Poly, v = 1): void {
    const b = polyBox(p);
    const rings = [p.outer, ...p.holes];
    const j0 = Math.max(0, Math.floor((b.minY - this.y0) / this.res) - 1);
    const j1 = Math.min(this.h - 1, Math.ceil((b.maxY - this.y0) / this.res) + 1);
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + (j + 0.5) * this.res;
      xs.length = 0;
      for (const r of rings) {
        for (let i = 0; i < r.length; i++) {
          const a = r[i]!;
          const c = r[(i + 1) % r.length]!;
          if (a.y > y !== c.y > y) xs.push(a.x + ((y - a.y) * (c.x - a.x)) / (c.y - a.y));
        }
      }
      xs.sort((a, c) => a - c);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k]! - this.x0) / this.res - 0.5));
        const i1 = Math.min(this.w - 1, Math.floor((xs[k + 1]! - this.x0) / this.res - 0.5));
        for (let i = i0; i <= i1; i++) m[j * this.w + i] = v;
      }
    }
  }

  /** Enveloppe orthoconvexe (remplissage des lignes et des colonnes, itéré). */
  orthoHull(m: Uint8Array, maxIter = 10): Uint8Array {
    const b = m.slice();
    const { w, h } = this;
    for (let it = 0; it < maxIter; it++) {
      let changed = false;
      for (let j = 0; j < h; j++) {
        let lo = -1;
        let hi = -1;
        for (let i = 0; i < w; i++) {
          if (b[j * w + i]) {
            if (lo < 0) lo = i;
            hi = i;
          }
        }
        if (lo >= 0) {
          for (let i = lo; i <= hi; i++) {
            if (!b[j * w + i]) {
              b[j * w + i] = 1;
              changed = true;
            }
          }
        }
      }
      for (let i = 0; i < w; i++) {
        let lo = -1;
        let hi = -1;
        for (let j = 0; j < h; j++) {
          if (b[j * w + i]) {
            if (lo < 0) lo = j;
            hi = j;
          }
        }
        if (lo >= 0) {
          for (let j = lo; j <= hi; j++) {
            if (!b[j * w + i]) {
              b[j * w + i] = 1;
              changed = true;
            }
          }
        }
      }
      if (!changed) break;
    }
    return b;
  }

  /** Distance de Tchebychev (en cellules) au plus proche 0 du masque, pour les cellules à 1. */
  chebyshev(m: Uint8Array): Int32Array {
    const { w, h } = this;
    const d = new Int32Array(w * h).fill(1 << 29);
    const q = new Int32Array(w * h);
    let tail = 0;
    for (let c = 0; c < w * h; c++) {
      if (!m[c]) {
        d[c] = 0;
        q[tail++] = c;
      }
    }
    for (let head = 0; head < tail; head++) {
      const c = q[head]!;
      const i = c % w;
      const j = (c / w) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          const n = nj * w + ni;
          if (d[n]! > d[c]! + 1) {
            d[n] = d[c]! + 1;
            q[tail++] = n;
          }
        }
      }
    }
    return d;
  }

  /** Composantes 4-connexes d'un masque (listes de cellules). */
  components(m: Uint8Array): number[][] {
    const { w, h } = this;
    const seen = new Uint8Array(w * h);
    const out: number[][] = [];
    const stack: number[] = [];
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || seen[s]) continue;
      const comp: number[] = [];
      stack.length = 0;
      stack.push(s);
      seen[s] = 1;
      while (stack.length > 0) {
        const c = stack.pop()!;
        comp.push(c);
        const i = c % w;
        const j = (c / w) | 0;
        if (i + 1 < w && m[c + 1] && !seen[c + 1]) {
          seen[c + 1] = 1;
          stack.push(c + 1);
        }
        if (i > 0 && m[c - 1] && !seen[c - 1]) {
          seen[c - 1] = 1;
          stack.push(c - 1);
        }
        if (j + 1 < h && m[c + w] && !seen[c + w]) {
          seen[c + w] = 1;
          stack.push(c + w);
        }
        if (j > 0 && m[c - w] && !seen[c - w]) {
          seen[c - w] = 1;
          stack.push(c - w);
        }
      }
      out.push(comp);
    }
    return out;
  }

  /**
   * Cellules → polygones. Les tronçons de ligne identiques d'une ligne à la suivante sont fusionnés en rectangles
   * avant l'union vectorielle (beaucoup moins de pièces à unir).
   */
  cellsToPolys(cells: readonly number[]): Poly[] {
    const { w } = this;
    const rows = new Map<number, number[]>();
    for (const c of cells) {
      const j = (c / w) | 0;
      let r = rows.get(j);
      if (!r) rows.set(j, (r = []));
      r.push(c % w);
    }
    type Run = { i0: number; i1: number; j0: number; j1: number };
    const open = new Map<string, Run>();
    const done: Run[] = [];
    const js = [...rows.keys()].sort((a, b) => a - b);
    let prevJ = -2;
    for (const j of js) {
      const is = rows.get(j)!.sort((a, b) => a - b);
      const runs: [number, number][] = [];
      let s = is[0]!;
      let p = s;
      for (let k = 1; k <= is.length; k++) {
        if (k < is.length && is[k] === p + 1) {
          p = is[k]!;
          continue;
        }
        runs.push([s, p]);
        if (k < is.length) s = p = is[k]!;
      }
      const next = new Map<string, Run>();
      for (const [i0, i1] of runs) {
        const key = `${i0}:${i1}`;
        const o = j === prevJ + 1 ? open.get(key) : undefined;
        if (o) {
          o.j1 = j;
          next.set(key, o);
          open.delete(key);
        } else next.set(key, { i0, i1, j0: j, j1: j });
      }
      for (const r of open.values()) done.push(r);
      open.clear();
      for (const [k, r] of next) open.set(k, r);
      prevJ = j;
    }
    for (const r of open.values()) done.push(r);
    const rnd = (v: number): number => Math.round(v * 1000) / 1000;
    const rects: Poly[] = done.map((r) => {
      const x0 = rnd(this.x0 + r.i0 * this.res);
      const x1 = rnd(this.x0 + (r.i1 + 1) * this.res);
      const y0 = rnd(this.y0 + r.j0 * this.res);
      const y1 = rnd(this.y0 + (r.j1 + 1) * this.res);
      return { outer: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], holes: [] };
    });
    return unionPolys(rects);
  }

  centre(c: number): { x: number; y: number } {
    return { x: this.x0 + ((c % this.w) + 0.5) * this.res, y: this.y0 + (((c / this.w) | 0) + 0.5) * this.res };
  }

  cellAt(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.res);
    const j = Math.floor((y - this.y0) / this.res);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return j * this.w + i;
  }
}
