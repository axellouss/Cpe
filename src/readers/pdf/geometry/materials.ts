/**
 * Matériaux des murs coupés, reconnus à leur STRUCTURE de dessin :
 *  - hachure diagonale simple → maçonnerie ; hachure diagonale croisée → isolant (convention Archicad, la plus
 *    courante sur les planches d'autorisation luxembourgeoises) ;
 *  - repli sans hachure croisée : poché plein sombre en bandes minces → maçonnerie, et la hachure diagonale simple
 *    devient alors l'isolant (convention « poché + isolant hachuré ») ;
 *  - la couleur de fond de l'isolant est APPRISE (vote des remplissages sous les zones croisées), jamais codée : ses
 *    bandes minces sans hachure (hachure coupée au bord d'une vue) sont ajoutées à l'isolant.
 * Seules les formes minces (épaisseur ≤ 0,8 m) comptent comme murs : un parquet hachuré n'en est pas un.
 *
 * Puis les murs « à nous » : la maçonnerie qui touche une pièce, celle qui y est reliée de proche en proche, et
 * l'isolant qui la double. Une maçonnerie atteinte seulement À TRAVERS un isolant appartient au voisin (mur mitoyen).
 */
import { polyArea, polysWithinDistance, type Poly } from '../planar';
import type { RawBox } from '../raw';
import type { FillShape, HatchShape, ViewInput } from './types';
import { boxesNear, boxH, boxW, luminance, polyBox, thickness } from './util';

export type MaterialMode = 'hatch' | 'solid' | 'masonry-only' | 'none';

export interface WallMaterials {
  masonry: Poly[];
  insulation: Poly[];
  mode: MaterialMode;
  /** Couleurs de fond apprises pour l'isolant. */
  insulationColors: number[];
}

const MAX_WALL_M = 0.8;

function diagonal(a: number): boolean {
  const m = ((a % 90) + 90) % 90;
  return m > 5 && m < 85;
}

export function isDiagonalHatch(h: Pick<HatchShape, 'angles'>): boolean {
  return h.angles.some(diagonal);
}

/** Hachure croisée : au moins deux directions diagonales distinctes (45° et 135°). */
export function isCrossHatch(h: Pick<HatchShape, 'angles'>): boolean {
  const d = [...new Set(h.angles.filter(diagonal).map((a) => ((a % 180) + 180) % 180))];
  for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) if (Math.abs(Math.abs(d[i]! - d[j]!) - 90) < 20) return true;
  return false;
}

function wallLike(p: Poly, mpp: number): boolean {
  const t = thickness(p) * mpp;
  return t > 0.01 && t <= MAX_WALL_M && polyArea(p) * mpp * mpp >= 0.002;
}

function overlapArea(a: RawBox, b: RawBox): number {
  return Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
}

function darkThinFills(fills: readonly FillShape[], mpp: number): Poly[] {
  const out: Poly[] = [];
  for (const f of fills) {
    if (f.alpha < 0.6 || luminance(f.color) >= 0.5) continue;
    for (const p of f.polys) if (wallLike(p, mpp) && p.holes.length === 0) out.push(p);
  }
  return out;
}

export function classifyWallMaterials(v: ViewInput, mpp: number): WallMaterials {
  const single: Poly[] = [];
  const cross: Poly[] = [];
  const crossZones: HatchShape[] = [];
  for (const h of v.hatches) {
    if (!isDiagonalHatch(h)) continue;
    const isCross = isCrossHatch(h);
    for (const p of h.polys) {
      if (!wallLike(p, mpp)) continue;
      (isCross ? cross : single).push(p);
    }
    if (isCross) crossZones.push(h);
  }
  // Fond de l'isolant appris par vote : un remplissage non blanc qui couvre ≥ 80 % d'une zone croisée.
  const votes = new Map<number, number>();
  for (const h of crossZones) {
    const ah = boxW(h.bbox) * boxH(h.bbox);
    if (!(ah > 0)) continue;
    for (const f of v.fills) {
      if (luminance(f.color) > 0.98) continue;
      if (overlapArea(f.bbox, h.bbox) >= 0.8 * ah) votes.set(f.color, (votes.get(f.color) ?? 0) + 1);
    }
  }
  const insulationColors = [...votes].filter(([, n]) => n >= 3).map(([c]) => c);
  if (cross.length > 0) {
    const insulation = cross.slice();
    for (const f of v.fills) {
      if (!insulationColors.includes(f.color)) continue;
      for (const p of f.polys) {
        if (!wallLike(p, mpp)) continue;
        const b = polyBox(p);
        if (insulation.some((q) => { const qb = polyBox(q); return overlapArea(qb, b) >= 0.8 * boxW(b) * boxH(b); })) continue;
        insulation.push(p);
      }
    }
    // Maçonnerie hachurée ; à défaut (béton en poché plein, isolant croisé), le poché sombre en bandes minces.
    const masonry = single.length > 0 ? single : darkThinFills(v.fills, mpp);
    return { masonry, insulation, mode: 'hatch', insulationColors };
  }
  const solid = darkThinFills(v.fills, mpp);
  if (solid.length >= 3) return { masonry: solid, insulation: single, mode: 'solid', insulationColors };
  if (single.length > 0) return { masonry: single, insulation: [], mode: 'masonry-only', insulationColors };
  return { masonry: [], insulation: [], mode: 'none', insulationColors };
}

// ───────────────────────────── Murs « à nous » ─────────────────────────────

export interface OwnWalls {
  masonry: Poly[];
  insulation: Poly[];
  /** Maçonnerie du voisin (atteinte seulement à travers un isolant) ou isolée du bâtiment. */
  foreign: Poly[];
}

interface Item {
  p: Poly;
  b: RawBox;
}

function near(a: Item, b: Item, d: number): boolean {
  return boxesNear(a.b, b.b, d) && polysWithinDistance(a.p, b.p, d);
}

/**
 * Propagation depuis les pièces. Tolérances en points de page : `epsRoom` entre une pièce et son mur (le remplissage
 * de pièce s'arrête parfois un peu avant le mur), `eps` entre isolant et maçonnerie.
 */
export function ownWalls(m: WallMaterials, rooms: readonly Poly[], eps = 0.3, epsRoom = 1.0): OwnWalls {
  const mas: Item[] = m.masonry.map((p) => ({ p, b: polyBox(p) }));
  const ins: Item[] = m.insulation.map((p) => ({ p, b: polyBox(p) }));
  const rms: Item[] = rooms.map((p) => ({ p, b: polyBox(p) }));
  const ownM = new Set<number>();
  const ownI = new Set<number>();
  mas.forEach((x, i) => {
    if (rms.some((r) => near(x, r, epsRoom))) ownM.add(i);
  });
  // Lien maçonnerie–maçonnerie : contact, ou joint étroit sans isolant commun (le joint de mitoyenneté en a un).
  const link = (a: number, b: number): boolean => {
    const A = mas[a]!;
    const B = mas[b]!;
    if (near(A, B, 0.05)) return true;
    if (!near(A, B, 0.6)) return false;
    return !ins.some((g) => near(g, A, 0.1) && near(g, B, 0.1));
  };
  let frontier = [...ownM];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (let i = 0; i < mas.length; i++) {
      if (ownM.has(i)) continue;
      if (frontier.some((j) => link(i, j))) {
        ownM.add(i);
        next.push(i);
      }
    }
    frontier = next;
  }
  ins.forEach((g, i) => {
    if ([...ownM].some((j) => near(g, mas[j]!, eps)) || rms.some((r) => near(g, r, epsRoom))) ownI.add(i);
  });
  frontier = [...ownI];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (let i = 0; i < ins.length; i++) {
      if (ownI.has(i)) continue;
      if (frontier.some((j) => near(ins[i]!, ins[j]!, eps))) {
        ownI.add(i);
        next.push(i);
      }
    }
    frontier = next;
  }
  return {
    masonry: mas.filter((_, i) => ownM.has(i)).map((x) => x.p),
    insulation: ins.filter((_, i) => ownI.has(i)).map((x) => x.p),
    foreign: mas.filter((_, i) => !ownM.has(i)).map((x) => x.p),
  };
}
