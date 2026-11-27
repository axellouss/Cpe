/**
 * Murs d'une page vectorielle : classe de traits des murs, contour extérieur par « fermeture », faces fermées
 * (pièces). Porté de analyze.py (notes de recherche), où chaque étape a été mesurée sur les plans d'essai.
 *
 * Ce qui est solide : la fermeture par tampon (insensible aux extrémités mal accrochées).
 * Ce qui est fragile : la classe des murs repose sur la hiérarchie des épaisseurs de trait (absente d'un export
 * « tout en trait fin ») ; les faces s'effondrent dès que les extrémités ne se raccordent pas.
 * Les appelants doivent donc recouper (surfaces écrites, accord entre les deux méthodes) avant de proposer.
 */
import type { Vec2 } from '../../core/types';
import { closeOutline, polyArea, pointInPoly, polygonizeSegments } from './planar';
import type { Poly, Seg } from './planar';
import { METRES_PER_POINT } from './raw';
import type { RawPage, RawSeg } from './raw';

/** Au-delà, on renonce à reconstruire les faces (coût et fiabilité). */
const MAX_WALL_SEGMENTS = 40_000;

function roundWidth(w: number): number {
  return Math.round(w * 100) / 100;
}

function isFrameSegment(s: RawSeg, pageW: number, pageH: number): boolean {
  const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
  if (len <= 0.6 * Math.min(pageW, pageH)) return false;
  return (
    Math.min(s.x0, s.x1) < 0.06 * pageW ||
    Math.max(s.x0, s.x1) > 0.94 * pageW ||
    Math.min(s.y0, s.y1) < 0.06 * pageH ||
    Math.max(s.y0, s.y1) > 0.94 * pageH
  );
}

export interface WallClass {
  /** Épaisseur de trait des murs (pt), arrondie au centième. */
  width: number;
  segs: RawSeg[];
}

/**
 * Classe des murs : la plus forte épaisseur de trait qui n'est pas celle du cadre de la feuille et qui porte
 * plus de 4 % de la longueur tracée. null si la page n'a pas de hiérarchie d'épaisseurs exploitable.
 */
export function findWallClass(page: RawPage): WallClass | null {
  const lengthByWidth = new Map<number, number>();
  const frame = new Set<number>();
  let total = 0;
  for (const s of page.segs) {
    if (!s.stroke || s.curve) continue;
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const w = roundWidth(s.w);
    lengthByWidth.set(w, (lengthByWidth.get(w) ?? 0) + len);
    total += len;
    if (isFrameSegment(s, page.width, page.height)) frame.add(w);
  }
  // Une seule épaisseur (hors cadre) : rien ne distingue les murs du reste.
  const usable = [...lengthByWidth.keys()].filter((w) => !frame.has(w));
  if (usable.length < 2 || total <= 0) return null;
  const candidates = usable.filter((w) => lengthByWidth.get(w)! > 0.04 * total).sort((a, b) => b - a);
  const width = candidates[0];
  if (width === undefined) return null;
  // Si la seule classe qui pèse est la plus fine, les murs ne sont pas ce qu'on voit le plus : on ne devine pas.
  if (width <= Math.min(...usable)) return null;
  const segs = page.segs.filter((s) => s.stroke && !s.dash && Math.abs(roundWidth(s.w) - width) < 0.011 && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 0.05);
  if (segs.length < 4) return null;
  return { width, segs };
}

function toSegs(segs: readonly RawSeg[]): Seg[] {
  return segs.map((s) => ({ ax: s.x0, ay: s.y0, bx: s.x1, by: s.y1 }));
}

/**
 * Contours extérieurs des « taches » de murs, par fermeture de rayon `radiusM` (mètres réels) :
 * ferme les ouvertures jusqu'à 2 × rayon. Une tache = un plan, une coupe…
 */
export function closedOutlines(walls: WallClass, metresPerPoint: number, radiusM: number, minAreaM2: number): Vec2[][] {
  const r = radiusM / metresPerPoint;
  const minArea = minAreaM2 / (metresPerPoint * metresPerPoint);
  return closeOutline(toSegs(walls.segs), r, minArea);
}

export interface WallGap {
  /** Extrémités de l'ouverture sur l'axe du mur (uf). */
  a: Vec2;
  b: Vec2;
  /** Épaisseur du mur à cet endroit (uf). */
  thickness: number;
  /** Les deux traits qui referment l'ouverture, un par face du mur. */
  faceA: Seg;
  faceB: Seg;
}

export interface Faces {
  faces: Poly[];
  /** Ouvertures (portes, fenêtres) refermées pour reconstruire les faces. */
  gaps: WallGap[];
}

interface GapCandidate {
  /** Direction du mur, degrés entiers dans [0, 180). */
  theta: number;
  rho: number;
  a0: number;
  a1: number;
}

/** Vides entre traits de murs alignés (même direction, même droite à 0,6 pt près). */
function gapCandidates(walls: WallClass, gapMax: number): GapCandidate[] {
  const byTheta = new Map<number, { rho: number; a0: number; a1: number }[]>();
  for (const s of walls.segs) {
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    // NB : même un bout de mur de 1 pt entre une porte et un refend compte pour le test du vide jumeau.
    if (s.curve || Math.hypot(dx, dy) < 0.2) continue;
    const th = (((Math.atan2(dy, dx) * 180) / Math.PI) % 180 + 180) % 180;
    const thq = Math.round(th) % 180;
    const rad = (thq * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const rho = (-uy * (s.x0 + s.x1)) / 2 + (ux * (s.y0 + s.y1)) / 2;
    const p = ux * s.x0 + uy * s.y0;
    const q = ux * s.x1 + uy * s.y1;
    let list = byTheta.get(thq);
    if (!list) byTheta.set(thq, (list = []));
    list.push({ rho, a0: Math.min(p, q), a1: Math.max(p, q) });
  }
  const candidates: GapCandidate[] = [];
  for (const [theta, list] of byTheta) {
    list.sort((a, b) => a.rho - b.rho);
    let group: typeof list = [];
    const flush = (): void => {
      if (group.length < 2) return;
      group.sort((a, b) => a.a0 - b.a0);
      let end = group[0]!.a1;
      let rho = group[0]!.rho;
      for (let i = 1; i < group.length; i++) {
        const it = group[i]!;
        if (it.a0 - end > 1.0 && it.a0 - end < gapMax) candidates.push({ theta, rho: (rho + it.rho) / 2, a0: end, a1: it.a0 });
        if (it.a1 > end) {
          end = it.a1;
          rho = it.rho;
        }
      }
    };
    for (const it of list) {
      if (group.length > 0 && it.rho - group[group.length - 1]!.rho > 0.6) {
        flush();
        group = [];
      }
      group.push(it);
    }
    flush();
  }
  return candidates;
}

function candidateSeg(c: GapCandidate, extend: number): Seg {
  const rad = (c.theta * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  return {
    ax: ux * (c.a0 - extend) - uy * c.rho,
    ay: uy * (c.a0 - extend) + ux * c.rho,
    bx: ux * (c.a1 + extend) - uy * c.rho,
    by: uy * (c.a1 + extend) + ux * c.rho,
  };
}

/**
 * Ouvertures des murs. Chaque ouverture interrompt les DEUX faces d'un mur : un vide entre deux traits alignés
 * n'est retenu que si un vide jumeau, de même étendue, existe à une épaisseur de mur (4 à 70 cm). Sans ce test,
 * des tableaux alignés de murs différents se rejoignent et coupent les pièces (mesuré sur les plans d'essai).
 * `bridges` = tous les vides qui ont un jumeau (un trait par face) ; `gaps` = les ouvertures, une par paire.
 */
function analyseGaps(walls: WallClass, metresPerPoint: number, maxGapM: number): { bridges: Seg[]; gaps: WallGap[] } {
  if (walls.segs.length > MAX_WALL_SEGMENTS) return { bridges: [], gaps: [] };
  const candidates = gapCandidates(walls, maxGapM / metresPerPoint);
  const tMin = 0.04 / metresPerPoint;
  const tMax = 0.7 / metresPerPoint;
  const paired = new Uint8Array(candidates.length);
  const bridges: Seg[] = [];
  const gaps: WallGap[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    let any = false;
    let twin = -1;
    let twinGap = Infinity;
    for (let j = 0; j < candidates.length; j++) {
      if (j === i) continue;
      const d = candidates[j]!;
      const apart = Math.abs(d.rho - c.rho);
      if (d.theta !== c.theta || apart <= tMin || apart >= tMax) continue;
      if (Math.abs(d.a0 - c.a0) >= 1.5 || Math.abs(d.a1 - c.a1) >= 1.5) continue;
      any = true;
      if (!paired[j] && apart < twinGap) {
        twinGap = apart;
        twin = j;
      }
    }
    if (!any) continue;
    bridges.push(candidateSeg(c, 0));
    if (paired[i] || twin < 0) continue;
    paired[i] = 1;
    paired[twin] = 1;
    const d = candidates[twin]!;
    const rad = (c.theta * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const rho = (c.rho + d.rho) / 2;
    const a0 = (c.a0 + d.a0) / 2;
    const a1 = (c.a1 + d.a1) / 2;
    gaps.push({
      a: { x: ux * a0 - uy * rho, y: uy * a0 + ux * rho },
      b: { x: ux * a1 - uy * rho, y: uy * a1 + ux * rho },
      thickness: twinGap,
      faceA: candidateSeg(c, 0),
      faceB: candidateSeg(d, 0),
    });
  }
  return { bridges, gaps };
}

/** Ouvertures des murs (portes, fenêtres, portes de garage) jusqu'à `maxGapM` mètres de large. */
export function wallGaps(walls: WallClass, metresPerPoint: number, maxGapM: number): WallGap[] {
  return analyseGaps(walls, metresPerPoint, maxGapM).gaps;
}

/**
 * Faces fermées dessinées par les murs, ouvertures refermées (voir `analyseGaps`).
 * `extend` : chaque trait est prolongé d'autant aux deux bouts, pour qu'un accrochage approximatif referme quand
 * même les faces ; les dépassements sont des bouts libres que la reconstruction ignore.
 */
export function buildFaces(walls: WallClass, metresPerPoint: number, maxGapM = 3.0, extend = 0.5): Faces {
  if (walls.segs.length === 0 || walls.segs.length > MAX_WALL_SEGMENTS) return { faces: [], gaps: [] };
  const stretch = (ax: number, ay: number, bx: number, by: number): Seg | null => {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 0.05) return null;
    const ex = (dx / len) * extend;
    const ey = (dy / len) * extend;
    return { ax: ax - ex, ay: ay - ey, bx: bx + ex, by: by + ey };
  };
  const lines: Seg[] = [];
  for (const s of walls.segs) {
    const line = stretch(s.x0, s.y0, s.x1, s.y1);
    if (line) lines.push(line);
  }
  const { bridges, gaps } = analyseGaps(walls, metresPerPoint, maxGapM);
  for (const g of bridges) {
    const line = stretch(g.ax, g.ay, g.bx, g.by);
    if (line) lines.push(line);
  }
  // Grille de 0,05 pt : les flottants simple précision de pdf.js se raccordent alors exactement.
  const faces = polygonizeSegments(lines, 0.05).filter((f) => polyArea(f) > 1.0);
  return { faces, gaps };
}

/** Plus petite face contenant le point (une pièce est la plus petite face autour de son étiquette). */
export function faceAt(faces: readonly Poly[], x: number, y: number): Poly | null {
  let best: Poly | null = null;
  let bestArea = Infinity;
  for (const f of faces) {
    if (!pointInPoly(x, y, f)) continue;
    const a = polyArea(f);
    if (a < bestArea) {
      bestArea = a;
      best = f;
    }
  }
  return best;
}

export interface AreaCalibration {
  /** Pièces dont la surface écrite a pu être comparée à une face. */
  n: number;
  inliers: number;
  /** Dénominateur d'échelle moyen des pièces concordantes ; NaN s'il n'y en a pas. */
  den: number;
  spreadPct: number;
}

/**
 * Calibrage SANS unité par les surfaces écrites : √(surface écrite / aire de la face) pour chaque pièce.
 * Indépendant des cotes et de la question mm / cm / m. À utiliser comme recoupement (les surfaces d'architecte
 * suivent parfois d'autres conventions : enduits déduits, surfaces sous rampants…).
 */
export function calibrateByAreas(labels: readonly { x: number; y: number; area?: number }[], faces: readonly Poly[]): AreaCalibration {
  const dens: number[] = [];
  for (const l of labels) {
    if (l.area === undefined || !(l.area > 0)) continue;
    const face = faceAt(faces, l.x, l.y);
    if (!face) continue;
    dens.push(Math.sqrt(l.area / polyArea(face)) / METRES_PER_POINT);
  }
  if (dens.length === 0) return { n: 0, inliers: 0, den: Number.NaN, spreadPct: Number.NaN };
  const sorted = [...dens].sort((a, b) => a - b);
  const med = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  const inl = dens.filter((d) => Math.abs(d / med - 1) < 0.02);
  if (inl.length === 0) return { n: dens.length, inliers: 0, den: Number.NaN, spreadPct: Number.NaN };
  return {
    n: dens.length,
    inliers: inl.length,
    den: inl.reduce((s, d) => s + d, 0) / inl.length,
    spreadPct: (100 * (Math.max(...inl) - Math.min(...inl))) / med,
  };
}
