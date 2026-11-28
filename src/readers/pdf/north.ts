/**
 * Flèche du NORD dessinée sur une page PDF → azimut vers lequel regarde le haut de la feuille.
 *
 * Signaux, par leur structure (jamais une couleur ou une position propre à une planche) :
 * 1. un texte « N », « NORD », « North », « Norden » ;
 * 2. à moins de 12 corps, un CERCLE : une chaîne de petits traits bout à bout dont les points sont à distance
 *    constante (8 %) d'un centre ajusté aux moindres carrés ;
 * 3. dans le cercle, une forme PLEINE décentrée (demi-barre, triangle) : la direction centre → forme est le nord
 *    (axe principal de la forme si elle est allongée). Les diamètres et disques symétriques n'ont pas de sens : ignorés.
 * Repli sans cercle : la forme pleine la plus proche du texte, orientée vers lui (le « N » est au bout de la flèche),
 * avec une confiance basse.
 *
 * Les remplissages viennent de RawPage.fills quand l'extraction les fournit ; sinon ils sont reconstitués à partir
 * des traits marqués `fill` regroupés par tracé d'origine (`pid`).
 */
import type { Evidence, ReadNorth } from '../../core/reading';
import type { BBox, Lang } from '../../core/types';
import { registerMessages, t, type Dictionary } from '../../i18n';
import { lineCenter, type SheetLine } from '../../semantics/labels';
import type { RawPage, RawSeg } from './raw';
import { textLines } from './textlines';

const MESSAGES: Dictionary = {
  fr: {
    'read.north.margin': 'Le nord lu tombe à {margin}° d’une limite de secteur : confirmer l’orientation des façades.',
    'read.north.arrowOnly': 'Nord lu sur une flèche sans cercle : confirmer l’orientation des façades.',
  },
  de: {
    'read.north.margin': 'Die gelesene Nordrichtung liegt {margin}° neben einer Sektorgrenze: Ausrichtung der Fassaden bitte bestätigen.',
    'read.north.arrowOnly': 'Nordrichtung von einem Pfeil ohne Kreis gelesen: Ausrichtung der Fassaden bitte bestätigen.',
  },
};
registerMessages(MESSAGES);

type Pt = [number, number];

const LABEL_RE = /^(?:n|nord|north|norden)$/i;
/** Rayon de recherche du symbole autour du texte, en corps. */
const SEARCH_SIZES = 12;
/** Marge sous laquelle l'orientation des façades devient douteuse (8 secteurs de 45°). */
const MARGIN_DOUBT_DEG = 5;

/** Les 8 secteurs de LuxEeB-Tool, de 45° chacun, centrés sur N, NE, E… */
export function sectorOf(azimuth: number): 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' {
  const s = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
  return s[Math.round((((azimuth % 360) + 360) % 360) / 45) % 8]!;
}

/** Distance angulaire à la limite de secteur la plus proche (22,5° au centre d'un secteur). */
export function sectorMargin(azimuth: number): number {
  const d = (((azimuth + 22.5) % 45) + 45) % 45;
  return Math.min(d, 45 - d);
}

/** Azimut de la normale extérieure du côté d'un plan, connaissant l'azimut du haut de la feuille. */
export function sideAzimuth(sheetUpAzimuth: number, side: 'top' | 'right' | 'bottom' | 'left'): number {
  const add = { top: 0, right: 90, bottom: 180, left: 270 }[side];
  return (sheetUpAzimuth + add) % 360;
}

/** Cercle des moindres carrés (méthode de Kåsa). null si les points sont alignés. */
export function fitCircle(pts: readonly Pt[]): { cx: number; cy: number; r: number } | null {
  if (pts.length < 3) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (const [x, y] of pts) {
    const u = x - mx;
    const v = y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const a = 0.5 * (suuu + suvv);
  const b = 0.5 * (svvv + svuu);
  const uc = (a * svv - b * suv) / det;
  const vc = (b * suu - a * suv) / det;
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length) };
}

/**
 * Polygones remplis de la page : RawPage.fills s'il y en a, sinon les traits `fill` regroupés par tracé (`pid`),
 * chaque discontinuité ouvrant un nouvel anneau.
 */
export function filledPolygons(page: Pick<RawPage, 'fills' | 'segs'>): Pt[][] {
  if (page.fills.length > 0) return page.fills.flatMap((f) => f.rings.map((r) => openRing(r.map((p) => [p[0], p[1]] as Pt))).filter((r) => r.length >= 3));
  const byPid = new Map<number, RawSeg[]>();
  for (const s of page.segs) {
    if (!s.fill) continue;
    const list = byPid.get(s.pid);
    if (list) list.push(s);
    else byPid.set(s.pid, [s]);
  }
  const out: Pt[][] = [];
  for (const segs of byPid.values()) {
    let ring: Pt[] = [];
    let last: Pt | null = null;
    const flush = (): void => {
      if (ring.length >= 3) out.push(ring);
      ring = [];
    };
    for (const s of segs) {
      if (!last || Math.abs(last[0] - s.x0) > 1e-6 || Math.abs(last[1] - s.y0) > 1e-6) {
        flush();
        ring.push([s.x0, s.y0]);
      }
      ring.push([s.x1, s.y1]);
      last = [s.x1, s.y1];
    }
    flush();
  }
  return out.map(openRing).filter((r) => r.length >= 3);
}

/**
 * Un anneau fermé répète son premier point : on l'ôte, quel que soit le chemin (remplissages ou traits), sinon le
 * sommet compté deux fois biaise le centroïde et l'axe principal, et les deux chemins ne concordent plus.
 */
function openRing(r: Pt[]): Pt[] {
  if (r.length < 2) return r;
  const a = r[0]!;
  const b = r[r.length - 1]!;
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 ? r.slice(0, -1) : r;
}

/** Axe d'une forme : direction principale (ACP des sommets) si elle est allongée, sinon null. */
function principalAxis(pts: readonly Pt[], gx: number, gy: number): Pt | null {
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p[0] - gx) ** 2;
    syy += (p[1] - gy) ** 2;
    sxy += (p[0] - gx) * (p[1] - gy);
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const root = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2);
  const l1 = (sxx + syy) / 2 + root;
  const l2 = (sxx + syy) / 2 - root;
  return l1 > 9 * Math.max(l2, 1e-9) ? [Math.cos(th), Math.sin(th)] : null;
}

/** Azimut du haut de la feuille pour une direction du nord vue sur la feuille (repère page, y vers le bas). */
function upAzimuth(dir: Pt): number {
  const trig = (Math.atan2(-dir[1], dir[0]) * 180) / Math.PI;
  return (((trig - 90) % 360) + 360) % 360;
}

interface Label {
  text: string;
  cx: number;
  cy: number;
  size: number;
  box: BBox;
}

function labelsOf(page: RawPage, lines?: readonly SheetLine[]): Label[] {
  const ls = lines ?? textLines(page.texts, page.number).lines;
  return ls.filter((l) => l.page === page.number && LABEL_RE.test(l.text.trim())).map((l) => ({ text: l.text.trim(), ...lineCenterXY(l), size: l.size, box: l.box }));
}

function lineCenterXY(l: SheetLine): { cx: number; cy: number } {
  const c = lineCenter(l);
  return { cx: c.x, cy: c.y };
}

/** Cercle le plus proche du texte : composantes de petits traits reliés par leurs extrémités (0,05 uf). */
function circleNear(segs: readonly RawSeg[], lab: Label): { cx: number; cy: number; r: number } | null {
  const R = SEARCH_SIZES * lab.size;
  const near = segs.filter((s) => s.stroke && Math.hypot((s.x0 + s.x1) / 2 - lab.cx, (s.y0 + s.y1) / 2 - lab.cy) < R && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 0.25 * R);
  const parent = near.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const key = (x: number, y: number): string => `${Math.round(x * 20)},${Math.round(y * 20)}`;
  const byEnd = new Map<string, number>();
  near.forEach((s, i) => {
    for (const k of [key(s.x0, s.y0), key(s.x1, s.y1)]) {
      const j = byEnd.get(k);
      if (j === undefined) byEnd.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const comps = new Map<number, Pt[]>();
  near.forEach((s, i) => {
    const r = find(i);
    const list = comps.get(r);
    const pts: Pt[] = [[s.x0, s.y0], [s.x1, s.y1]];
    if (list) list.push(...pts);
    else comps.set(r, pts);
  });
  let best: { cx: number; cy: number; r: number } | null = null;
  let bestD = Infinity;
  for (const pts of comps.values()) {
    if (pts.length < 24) continue;
    const fit = fitCircle(pts);
    if (!fit || fit.r < 0.5 * lab.size || fit.r > R) continue;
    const ok = pts.filter((p) => Math.abs(Math.hypot(p[0] - fit.cx, p[1] - fit.cy) - fit.r) < 0.08 * fit.r).length / pts.length;
    const d = Math.hypot(fit.cx - lab.cx, fit.cy - lab.cy);
    if (ok > 0.9 && d < bestD) {
      best = fit;
      bestD = d;
    }
  }
  return best;
}

function centroid(pts: readonly Pt[]): Pt {
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}

/** Lecture détaillée : la flèche et son doute éventuel (le contrat ReadNorth ne porte pas de texte de doute). */
export function readNorthDetailed(page: RawPage, opts: { lines?: readonly SheetLine[]; lang?: Lang } = {}): { north: ReadNorth; doubt: string | null } | null {
  const lang = opts.lang ?? 'fr';
  const labels = labelsOf(page, opts.lines);
  if (labels.length === 0) return null;
  const polys = filledPolygons(page);
  // Les mots entiers (« NORD ») avant la lettre seule, plus ambiguë (repère d'axe, coordonnée).
  labels.sort((a, b) => b.text.length - a.text.length);
  const withCircle = new Set<Label>();
  for (const lab of labels) {
    const circle = circleNear(page.segs, lab);
    if (!circle) continue;
    withCircle.add(lab);
    let best: { dir: Pt; off: number } | null = null;
    for (const pts of polys) {
      const [gx, gy] = centroid(pts);
      const off = Math.hypot(gx - circle.cx, gy - circle.cy);
      if (off > circle.r || off < 0.2 * circle.r) continue; // hors du cercle, ou symétrique (diamètre, disque)
      if (pts.some((p) => Math.hypot(p[0] - circle.cx, p[1] - circle.cy) > 1.35 * circle.r)) continue;
      let dir = principalAxis(pts, gx, gy) ?? [gx - circle.cx, gy - circle.cy];
      if (dir[0] * (gx - circle.cx) + dir[1] * (gy - circle.cy) < 0) dir = [-dir[0], -dir[1]];
      if (!best || off > best.off) best = { dir, off };
    }
    if (!best) continue;
    const az = upAzimuth(best.dir);
    const margin = sectorMargin(az);
    const doubt = margin > MARGIN_DOUBT_DEG ? null : t(lang, 'read.north.margin', { margin: margin.toFixed(0) });
    const circleBox: BBox = { minX: circle.cx - circle.r, minY: circle.cy - circle.r, maxX: circle.cx + circle.r, maxY: circle.cy + circle.r };
    const evidence: Evidence[] = [
      { source: 'north-label', detail: lab.text, page: page.number, box: lab.box },
      { source: 'north-circle', page: page.number, box: circleBox },
      { source: 'north-filled-shape', page: page.number },
    ];
    return {
      north: { sheetUpAzimuth: Math.round(az * 10) / 10, marginDeg: Math.round(margin * 10) / 10, confidence: doubt ? 0.5 : 0.85, evidence, page: page.number, box: circleBox },
      doubt,
    };
  }
  // Repli : flèche pleine sans cercle, près d'un mot « NORD » (pas d'une lettre seule, trop ambiguë sans cercle).
  // Un cercle trouvé sans forme orientée (diamètre symétrique) n'a pas de sens : pas de repli autour de lui.
  for (const lab of labels) {
    if (lab.text.length < 4 || withCircle.has(lab)) continue;
    let best: { dir: Pt; d: number; pts: Pt[] } | null = null;
    for (const pts of polys) {
      const [gx, gy] = centroid(pts);
      const d = Math.hypot(gx - lab.cx, gy - lab.cy);
      if (d > 6 * lab.size || d < 0.5 * lab.size) continue;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      if (ext > 8 * lab.size || ext < 0.5 * lab.size) continue;
      let dir = principalAxis(pts, gx, gy) ?? [lab.cx - gx, lab.cy - gy];
      if (dir[0] * (lab.cx - gx) + dir[1] * (lab.cy - gy) < 0) dir = [-dir[0], -dir[1]];
      if (!best || d < best.d) best = { dir, d, pts };
    }
    if (!best) continue;
    const az = upAzimuth(best.dir);
    const xs = best.pts.map((p) => p[0]);
    const ys = best.pts.map((p) => p[1]);
    const box: BBox = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    return {
      north: {
        sheetUpAzimuth: Math.round(az * 10) / 10,
        marginDeg: Math.round(sectorMargin(az) * 10) / 10,
        confidence: 0.5,
        evidence: [{ source: 'north-label', detail: lab.text, page: page.number, box: lab.box }, { source: 'north-arrow-only', page: page.number, box }],
        page: page.number,
        box,
      },
      doubt: t(lang, 'read.north.arrowOnly'),
    };
  }
  return null;
}

/** Flèche du nord de la page ; null si aucune n'est reconnue (l'orientation devient une question). */
export function readNorth(page: RawPage, opts: { lines?: readonly SheetLine[]; lang?: Lang } = {}): ReadNorth | null {
  return readNorthDetailed(page, opts)?.north ?? null;
}
