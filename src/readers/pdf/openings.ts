/**
 * Ouvertures des murs EXTÉRIEURS d'une vue en plan : ce sont les interruptions jumelles des deux faces d'un mur
 * (voir walls.ts) dont une face longe le contour proposé.
 *
 * Type proposé d'après ce qui est dessiné dans l'ouverture :
 *  - arc de débattement, ou vantail partant d'un tableau → porte ;
 *  - trait interrompu en travers (porte de garage, baie libre) → porte ;
 *  - trait(s) continu(s) parallèle(s) au mur dans son épaisseur (dormant, vitrage) → fenêtre ;
 *  - rien de tout cela → « unknown », l'expert précise.
 * La largeur vient du plan (dimension brute du vide dans le mur) ; la hauteur n'est pas lisible sur un plan.
 */
import type { DetectedOpening, Vec2 } from '../../core/types';
import { pointRingDistance } from './planar';
import type { Seg } from './planar';
import type { RawPage } from './raw';
import type { WallGap } from './walls';

/** Largeurs plausibles d'une ouverture de façade (m). */
const MIN_WIDTH_M = 0.4;
const MAX_WIDTH_M = 6;

function midpoint(s: Seg): Vec2 {
  return { x: (s.ax + s.bx) / 2, y: (s.ay + s.by) / 2 };
}

export function detectOpenings(page: RawPage, segIndices: readonly number[], outline: readonly Vec2[], gaps: readonly WallGap[], metresPerPoint: number): DetectedOpening[] {
  const onOutline = 0.06 / metresPerPoint;
  const exterior: { gap: WallGap; face: Seg }[] = [];
  for (const g of gaps) {
    const width = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) * metresPerPoint;
    if (width < MIN_WIDTH_M || width > MAX_WIDTH_M) continue;
    const ma = midpoint(g.faceA);
    const mb = midpoint(g.faceB);
    const da = pointRingDistance(ma.x, ma.y, outline);
    const db = pointRingDistance(mb.x, mb.y, outline);
    if (Math.min(da, db) > onOutline) continue; // mur intérieur
    exterior.push({ gap: g, face: da <= db ? g.faceA : g.faceB });
  }
  if (exterior.length === 0) return [];

  const out: DetectedOpening[] = [];
  const tol = 0.05 / metresPerPoint;
  for (const { gap, face } of exterior) {
    const length = Math.hypot(gap.b.x - gap.a.x, gap.b.y - gap.a.y);
    const ux = (gap.b.x - gap.a.x) / length;
    const uy = (gap.b.y - gap.a.y) / length;
    const half = gap.thickness / 2 + tol;
    let parallel = 0;
    let dashed = 0;
    let leaf = 0;
    /** Par tracé courbe : distance mini à l'axe (et sa position le long du mur), distance maxi. */
    const arcs = new Map<number, { near: number; nearAt: number; far: number; pieces: number }>();
    for (const i of segIndices) {
      const s = page.segs[i]!;
      if (!s.stroke) continue;
      // Repère de l'ouverture : p le long du mur depuis a, q en travers depuis l'axe.
      const p0 = (s.x0 - gap.a.x) * ux + (s.y0 - gap.a.y) * uy;
      const p1 = (s.x1 - gap.a.x) * ux + (s.y1 - gap.a.y) * uy;
      const q0 = -(s.x0 - gap.a.x) * uy + (s.y0 - gap.a.y) * ux;
      const q1 = -(s.x1 - gap.a.x) * uy + (s.y1 - gap.a.y) * ux;
      if (Math.max(p0, p1) < -0.2 * length || Math.min(p0, p1) > 1.2 * length) continue;
      if (Math.min(Math.abs(q0), Math.abs(q1)) > 1.2 * length + half) continue;
      const along = Math.abs(p1 - p0);
      const across = Math.abs(q1 - q0);
      if (s.curve) {
        let arc = arcs.get(s.pid);
        if (!arc) arcs.set(s.pid, (arc = { near: Infinity, nearAt: 0, far: 0, pieces: 0 }));
        arc.pieces++;
        for (const [p, q] of [
          [p0, q0],
          [p1, q1],
        ] as const) {
          if (Math.abs(q) < arc.near) {
            arc.near = Math.abs(q);
            arc.nearAt = p;
          }
          if (Math.abs(q) > arc.far) arc.far = Math.abs(q);
        }
        continue;
      }
      const inBand = Math.abs(q0) <= half && Math.abs(q1) <= half;
      if (inBand && across <= tol) {
        // Trait parallèle au mur, dans son épaisseur, qui couvre l'essentiel du vide.
        const cover = Math.min(Math.max(p0, p1), length) - Math.max(Math.min(p0, p1), 0);
        if (cover >= 0.6 * length) {
          if (s.dash) dashed++;
          else parallel++;
        }
        continue;
      }
      // Vantail : part d'un tableau, quitte le mur à peu près d'équerre, long comme l'ouverture est large.
      const len = Math.hypot(along, across);
      const atJamb = (p: number, q: number): boolean => Math.abs(q) <= half && (Math.abs(p) <= 2 * tol || Math.abs(p - length) <= 2 * tol);
      const leaves = Math.max(Math.abs(q0), Math.abs(q1)) > half;
      if ((atJamb(p0, q0) || atJamb(p1, q1)) && leaves && len >= 0.6 * length && len <= 1.15 * length) leaf++;
    }
    // Arc de débattement de CETTE ouverture : il touche le mur à un tableau et s'en écarte d'une largeur de porte.
    let swing = 0;
    for (const arc of arcs.values()) {
      const touches = arc.near <= half && arc.nearAt >= -2 * tol && arc.nearAt <= length + 2 * tol;
      const depth = arc.far - gap.thickness / 2;
      if (arc.pieces >= 4 && touches && depth >= 0.6 * length && depth <= 1.15 * length) swing++;
    }
    let kind: DetectedOpening['kind'] = 'unknown';
    if (swing > 0 || leaf > 0 || dashed > 0) kind = 'door';
    else if (parallel > 0) kind = 'window';
    out.push({
      kind,
      a: { x: face.ax, y: face.ay },
      b: { x: face.bx, y: face.by },
      width: Math.round(length * metresPerPoint * 100) / 100,
      exterior: true,
    });
  }
  return out;
}
