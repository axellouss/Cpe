/**
 * Petits index spatiaux sur grille régulière (points et segments). Les requêtes renvoient des CANDIDATS :
 * l'appelant vérifie la distance exacte.
 */
import type { Seg } from './planar';

function cellKey(ix: number, iy: number): number {
  // 21 bits par axe ; au-delà les cellules se replient (seulement des candidats en trop).
  return (ix & 0x1fffff) * 2097152 + (iy & 0x1fffff);
}

export class PointGrid {
  private readonly cells = new Map<number, number[]>();

  constructor(private readonly cell: number) {}

  add(x: number, y: number, id: number): void {
    const key = cellKey(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const list = this.cells.get(key);
    if (list) list.push(id);
    else this.cells.set(key, [id]);
  }

  /** Appelle `visit` pour chaque point dont la cellule touche le carré de demi-côté r autour de (x, y). */
  near(x: number, y: number, r: number, visit: (id: number) => void): void {
    const x0 = Math.floor((x - r) / this.cell);
    const x1 = Math.floor((x + r) / this.cell);
    const y0 = Math.floor((y - r) / this.cell);
    const y1 = Math.floor((y + r) / this.cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4 * this.cells.size + 64) {
      for (const list of this.cells.values()) for (const id of list) visit(id);
      return;
    }
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const list = this.cells.get(cellKey(ix, iy));
        if (list) for (const id of list) visit(id);
      }
    }
  }
}

export class SegGrid {
  private readonly cells = new Map<number, number[]>();
  private stamp = new Int32Array(0);
  private tick = 0;
  private count = 0;

  constructor(private readonly cell: number) {}

  private put(ix: number, iy: number, id: number): void {
    const key = cellKey(ix, iy);
    const list = this.cells.get(key);
    if (list) {
      if (list[list.length - 1] !== id) list.push(id);
    } else this.cells.set(key, [id]);
  }

  add(id: number, s: Seg): void {
    if (id >= this.count) this.count = id + 1;
    const c = this.cell;
    const x0 = Math.floor(Math.min(s.ax, s.bx) / c);
    const x1 = Math.floor(Math.max(s.ax, s.bx) / c);
    const y0 = Math.floor(Math.min(s.ay, s.by) / c);
    const y1 = Math.floor(Math.max(s.ay, s.by) / c);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 48) {
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) this.put(ix, iy, id);
      return;
    }
    // Long segment oblique : on marche le long du trait (avec les cellules voisines, par prudence).
    const len = Math.hypot(s.bx - s.ax, s.by - s.ay);
    const steps = Math.max(1, Math.ceil(len / (c / 2)));
    for (let k = 0; k <= steps; k++) {
      const ix = Math.floor((s.ax + ((s.bx - s.ax) * k) / steps) / c);
      const iy = Math.floor((s.ay + ((s.by - s.ay) * k) / steps) / c);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) this.put(ix + dx, iy + dy, id);
    }
  }

  /** Indices (sans doublon) des segments dont une cellule touche la boîte. */
  query(minX: number, minY: number, maxX: number, maxY: number): number[] {
    if (this.stamp.length < this.count) this.stamp = new Int32Array(this.count);
    this.tick++;
    const out: number[] = [];
    const c = this.cell;
    const x0 = Math.floor(minX / c);
    const x1 = Math.floor(maxX / c);
    const y0 = Math.floor(minY / c);
    const y1 = Math.floor(maxY / c);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4 * this.cells.size + 64) {
      // Boîte immense par rapport à la grille : tout est candidat (l'appelant filtre).
      for (let id = 0; id < this.count; id++) out.push(id);
      return out;
    }
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const list = this.cells.get(cellKey(ix, iy));
        if (!list) continue;
        for (const id of list) {
          if (this.stamp[id] !== this.tick) {
            this.stamp[id] = this.tick;
            out.push(id);
          }
        }
      }
    }
    return out;
  }
}
