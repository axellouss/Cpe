/**
 * Fenêtres et portes : position en plan, direction le long du mur, test « donne sur l'extérieur ».
 *
 * La géométrie vient de la RÉSERVATION (IfcOpeningElement, un simple pavé) et non de la menuiserie :
 * les familles Revit de fenêtres pèsent des centaines de milliers de triangles pour rien (NOTES § 2.4).
 * La direction le long du mur est l'axe du placement de la menuiserie dont l'étendue correspond le mieux
 * à OverallWidth (l'axe X selon la norme ; vérifié sur 876 ouvertures réelles, 2 exceptions rattrapées).
 * Fonctions pures ; repère IFC (x à droite, y vers le haut, z vertical), mètres.
 */
import type { Frame } from './model';
import { isInside, type Grid } from './raster';

export interface OpeningGeometry {
  /** Centre en plan. */
  cx: number;
  cy: number;
  /** Direction unitaire le long du mur. */
  dx: number;
  dy: number;
  /** Étendue le long du mur et dans l'épaisseur (m). */
  along: number;
  depth: number;
  zMin: number;
  zMax: number;
  /** Vrai si l'ouverture est couchée (fenêtre de toit) plutôt que dans un mur. */
  tilted: boolean;
}

/**
 * Direction du plus grand côté du rectangle englobant d'aire minimale des points en plan
 * (exact pour un pavé, quel que soit le nombre de sommets répétés dans la soupe).
 */
function longSideAxis(points: Float32Array): { x: number; y: number } {
  // Enveloppe convexe (chaîne monotone d'Andrew) des sommets dédoublonnés au dixième de millimètre.
  const seen = new Set<string>();
  const pts: [number, number][] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i]!;
    const y = points[i + 1]!;
    const key = `${Math.round(x * 1e4)}:${Math.round(y * 1e4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pts.push([x, y]);
  }
  if (pts.length < 2) return { x: 1, y: 0 };
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const turn = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const hull: [number, number][] = [];
  for (const p of pts) {
    while (hull.length >= 2 && turn(hull[hull.length - 2]!, hull[hull.length - 1]!, p) <= 0) hull.pop();
    hull.push(p);
  }
  const lower = hull.length + 1;
  for (let i = pts.length - 2; i >= 0; i--) {
    const p = pts[i]!;
    while (hull.length >= lower && turn(hull[hull.length - 2]!, hull[hull.length - 1]!, p) <= 0) hull.pop();
    hull.push(p);
  }
  hull.pop();
  let best = { x: 1, y: 0 };
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const ux = (b[0] - a[0]) / l;
    const uy = (b[1] - a[1]) / l;
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const area = (uMax - uMin) * (vMax - vMin);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      best = uMax - uMin >= vMax - vMin ? { x: ux, y: uy } : { x: -uy, y: ux };
    }
  }
  return best;
}

/** Part de la surface du maillage dont la normale n'est ni horizontale ni verticale (faces « couchées »). */
function obliqueShare(soup: Float32Array): number {
  let total = 0;
  let oblique = 0;
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const ux = soup[t + 3]! - soup[t]!;
    const uy = soup[t + 4]! - soup[t + 1]!;
    const uz = soup[t + 5]! - soup[t + 2]!;
    const vx = soup[t + 6]! - soup[t]!;
    const vy = soup[t + 7]! - soup[t + 1]!;
    const vz = soup[t + 8]! - soup[t + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) continue;
    total += l;
    const up = Math.abs(nz) / l;
    if (up > 0.17 && up < 0.985) oblique += l; // entre 10° et 80° de l'horizontale
  }
  return total > 0 ? oblique / total : 0;
}

/**
 * Mesure une ouverture à partir d'un maillage (réservation ou, à défaut, menuiserie).
 * @param soup          triangles [x, y, z] × 3
 * @param frame         repère du placement de la menuiserie (axes), si connu
 * @param overallWidth  largeur déclarée (m), pour choisir l'axe « le long du mur »
 */
export function openingGeometry(soup: Float32Array, frame: Frame | null, overallWidth: number | null): OpeningGeometry | null {
  if (soup.length < 9) return null;
  let ax: { x: number; y: number } | null = null;
  let tilted = false;
  if (frame) {
    if (Math.abs(frame.z[2]) < 0.9) tilted = true;
    const h = Math.hypot(frame.x[0], frame.x[1]);
    if (h > 0.5) ax = { x: frame.x[0] / h, y: frame.x[1] / h };
  }
  if (!tilted && obliqueShare(soup) > 0.5) tilted = true;
  const fromFrame = ax !== null;
  if (!ax) ax = longSideAxis(soup);

  const measure = (ux: number, uy: number): { lo: number; hi: number } => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i + 2 < soup.length; i += 3) {
      const s = soup[i]! * ux + soup[i + 1]! * uy;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    return { lo, hi };
  };
  let u = ax;
  let eu = measure(u.x, u.y);
  let ev = measure(-u.y, u.x);
  if (fromFrame && overallWidth !== null) {
    // L'axe X du placement est censé suivre le mur ; on ne le troque contre Y que si Y colle nettement mieux.
    const missU = Math.abs(eu.hi - eu.lo - overallWidth);
    const missV = Math.abs(ev.hi - ev.lo - overallWidth);
    if (missV + 0.05 < missU && missV < 0.12 + 0.1 * overallWidth) {
      u = { x: -u.y, y: u.x };
      const swap = eu;
      eu = ev;
      ev = swap;
    }
  }
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 2; i < soup.length; i += 3) {
    const z = soup[i]!;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  const cu = (eu.lo + eu.hi) / 2;
  const cv = (ev.lo + ev.hi) / 2;
  // (u, v) orthonormé avec v = (−u.y, u.x) : retour au repère du plan.
  const vx = -u.y;
  const vy = u.x;
  return {
    cx: cu * u.x + cv * vx,
    cy: cu * u.y + cv * vy,
    dx: u.x,
    dy: u.y,
    along: eu.hi - eu.lo,
    depth: ev.hi - ev.lo,
    zMin,
    zMax,
    tilted,
  };
}

export interface ExteriorProbe {
  /** Vrai si exactement un côté de l'ouverture débouche hors de l'emprise. */
  exterior: boolean;
  /** Point de la façade en face du centre de l'ouverture (si extérieur). */
  fx: number;
  fy: number;
  /** Normale unitaire dirigée vers l'extérieur (si extérieur). */
  nx: number;
  ny: number;
}

/**
 * Test géométrique « ouverture extérieure » : on s'éloigne du plan de l'ouverture des deux côtés ;
 * exactement un des deux côtés doit sortir de l'emprise du niveau à moins de `reach` mètres.
 * Trois lignes de sonde (centre et quarts de la largeur) votent, pour ne pas dépendre d'un poteau ou d'un refend.
 */
export function probeExterior(grid: Grid, labels: Uint16Array, g: OpeningGeometry, reach: number): ExteriorProbe {
  const nx = -g.dy;
  const ny = g.dx;
  const step = grid.cell / 2;
  const exit = (ox: number, oy: number, sign: number): number => {
    for (let t = step; t <= reach; t += step) {
      if (!isInside(grid, labels, ox + sign * nx * t, oy + sign * ny * t)) return t;
    }
    return Infinity;
  };
  let votesPlus = 0;
  let votesMinus = 0;
  let distPlus = Infinity;
  let distMinus = Infinity;
  for (const f of [0, -0.25, 0.25]) {
    const ox = g.cx + g.dx * g.along * f;
    const oy = g.cy + g.dy * g.along * f;
    const plus = exit(ox, oy, 1);
    const minus = exit(ox, oy, -1);
    if (Number.isFinite(plus) && !Number.isFinite(minus)) {
      votesPlus++;
      if (plus < distPlus) distPlus = plus;
    } else if (Number.isFinite(minus) && !Number.isFinite(plus)) {
      votesMinus++;
      if (minus < distMinus) distMinus = minus;
    }
  }
  if (votesPlus >= 2 && votesPlus > votesMinus) {
    return { exterior: true, fx: g.cx + nx * distPlus, fy: g.cy + ny * distPlus, nx, ny };
  }
  if (votesMinus >= 2 && votesMinus > votesPlus) {
    return { exterior: true, fx: g.cx - nx * distMinus, fy: g.cy - ny * distMinus, nx: -nx, ny: -ny };
  }
  return { exterior: false, fx: g.cx, fy: g.cy, nx, ny };
}
