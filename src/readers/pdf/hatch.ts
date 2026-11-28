/**
 * Allègement d'une page : reconnaître les TRAMES de micro-traits (pointillé de terrain des coupes, gravier…) et les
 * HACHURES (traits parallèles réguliers : béton, isolant, carrelage…) pour les retirer de la liste des traits et
 * n'en garder qu'un résumé (zone, directions, pas, couleur).
 *
 * Fonctions PURES (ni pdf.js ni DOM), appelées par extract.ts et testées une par une. Les critères sont ceux
 * mesurés sur une vraie planche d'autorisation (export Archicad : 320 000 micro-traits et 24 000 traits de hachure)
 * et sur les planches d'essai du dépôt. Ils portent sur la STRUCTURE du dessin (taille des sous-tracés, découpe
 * commune, parallélisme, régularité du pas, épaisseur et couleur homogènes), jamais sur une couleur ou une
 * position particulière. Repli : ce qui ne passe pas tous les critères reste dans `segs`, comme avant.
 */
import type { ClipZone, HatchZone, RawBox, RawSeg, StippleZone } from './raw';

/** Un sous-tracé dont l'étendue (diagonale) est inférieure à ce seuil (≈ 1 mm) peut être un élément de trame. */
export const SMALL_PT = 3;
/** Au moins autant de micro-traits sous une même découpe pour en faire une trame. */
export const MIN_STIPPLE = 500;
/** … et ils doivent faire au moins cette part des traits tracés sous la découpe. */
export const STIPPLE_SHARE = 0.8;
/** Une découpe de trame couvre au plus cette part de la page (sinon c'est la page ou une vue entière). */
export const STIPPLE_MAX_CLIP_SHARE = 0.5;
/** Une découpe de hachure couvre au plus cette part de la page (un mur, une bande d'isolant, une pièce). */
export const HATCH_MAX_CLIP_SHARE = 0.05;
/** Nombre minimal de traits d'une hachure sous découpe. */
export const HATCH_MIN_SEGS = 8;
/** Tolérance sur l'épaisseur des traits d'une même hachure (pt). */
export const HATCH_WIDTH_TOL = 0.02;
/** Hachure sans découpe : nombre minimal de traits d'un même tracé… */
export const PATH_HATCH_MIN_SEGS = 12;
/** … dont au plus cette part est jointe bout à bout (une polyligne n'est pas une hachure). */
export const PATH_HATCH_MAX_JOINED = 0.2;

/** Largeur d'une classe de direction (degrés). */
const ANGLE_BIN = 5;
/** Part des traits qui doivent tomber dans une ou deux directions. */
const DIRECTION_SHARE = 0.9;
/** Pas minimal d'une hachure (pt) : en dessous, ce sont des traits superposés, pas une hachure. */
const MIN_SPACING = 0.15;
/** Écart relatif toléré à un multiple entier du pas. */
const SPACING_TOL = 0.2;
/** Un écart vaut au plus ce nombre de pas (droites manquantes, coupées par la découpe). */
const MAX_STEP_MULTIPLE = 6;
/** Part des écarts qui doivent être des multiples du pas. */
const REGULAR_SHARE = 0.8;

export interface LineLike {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface HatchPattern {
  /** Directions retenues (degrés, 0..175 par pas de 5) : une = hachure simple, deux = croisée. */
  angles: number[];
  /** Pas moyen entre droites voisines (pt). */
  spacing: number;
}

export type Ring = [number, number][];

export const emptyBox = (): RawBox => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

export function growBox(b: RawBox, x: number, y: number): void {
  if (x < b.minX) b.minX = x;
  if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y;
  if (y > b.maxY) b.maxY = y;
}

export function boxArea(b: RawBox): number {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  return w > 0 && h > 0 ? w * h : 0;
}

/** Étendue (diagonale de la boîte) assez petite pour un élément de trame. */
export function isMicroExtent(width: number, height: number): boolean {
  return Math.hypot(width, height) < SMALL_PT;
}

/** Direction d'un trait ramenée à une classe de 5° (0..175). */
export function directionBin(s: LineLike): number {
  const deg = ((((Math.atan2(s.y1 - s.y0, s.x1 - s.x0) * 180) / Math.PI) % 180) + 180) % 180;
  return (Math.round(deg / ANGLE_BIN) * ANGLE_BIN) % 180;
}

/**
 * Hachure ? Traits presque tous (≥ 90 %) dans une ou deux directions ; chaque direction forme au moins trois
 * droites PARALLÈLES distinctes dont les écarts sont presque tous (≥ 80 %) des multiples du pas (quartile bas des
 * écarts, robuste aux droites manquantes), à 20 % près. Un trait coupé en morceaux par la découpe compte pour une
 * seule droite. Renvoie null sinon.
 */
export function hatchOf(segs: readonly LineLike[]): HatchPattern | null {
  if (segs.length < HATCH_MIN_SEGS) return null;
  const bins = new Map<number, number[]>();
  segs.forEach((s, i) => {
    const k = directionBin(s);
    let arr = bins.get(k);
    if (!arr) bins.set(k, (arr = []));
    arr.push(i);
  });
  const top = [...bins.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  const keep = top.slice(0, 2).filter((t) => t[1].length >= 3);
  const covered = keep.reduce((n, t) => n + t[1].length, 0);
  if (covered < DIRECTION_SHARE * segs.length) return null;
  const spacings: number[] = [];
  for (const [deg, idx] of keep) {
    const step = regularStep(idx.map((i) => segs[i]!), deg);
    if (step === null) return null;
    spacings.push(step);
  }
  return { angles: keep.map((t) => t[0]), spacing: spacings.reduce((p, q) => p + q, 0) / spacings.length };
}

/** Pas régulier d'une famille de traits de direction `deg`, ou null si les droites ne sont pas régulièrement espacées. */
export function regularStep(segs: readonly LineLike[], deg: number): number | null {
  const a = (deg * Math.PI) / 180;
  const nx = -Math.sin(a);
  const ny = Math.cos(a);
  // Décalage perpendiculaire de chaque droite (au 1/20 de point).
  const offs = [...new Set(segs.map((s) => Math.round((s.x0 * nx + s.y0 * ny) * 20) / 20))].sort((p, q) => p - q);
  if (offs.length < 3) return null;
  const gaps: number[] = [];
  for (let k = 1; k < offs.length; k++) if (offs[k]! - offs[k - 1]! > 0.04) gaps.push(offs[k]! - offs[k - 1]!);
  if (gaps.length < 2) return null;
  const sorted = [...gaps].sort((p, q) => p - q);
  const step = sorted[Math.floor(sorted.length / 4)]!;
  if (!(step > MIN_SPACING)) return null;
  const regular = gaps.filter((g) => {
    const r = g / step;
    return Math.abs(r - Math.round(r)) < SPACING_TOL && Math.round(r) <= MAX_STEP_MULTIPLE;
  }).length;
  return regular >= REGULAR_SHARE * gaps.length ? step : null;
}

/** Traits d'un même tracé presque tous disjoints (chacun commence ailleurs qu'à la fin du précédent). */
export function isDisjointRun(segs: readonly LineLike[]): boolean {
  let joined = 0;
  for (let k = 1; k < segs.length; k++) {
    const a = segs[k - 1]!;
    const b = segs[k]!;
    if (Math.abs(a.x1 - b.x0) < 0.01 && Math.abs(a.y1 - b.y0) < 0.01) joined++;
  }
  return joined <= PATH_HATCH_MAX_JOINED * segs.length;
}

/** Bilan des traits tracés sous une découpe, compté pendant l'extraction. */
export interface ClipStrokeStat {
  /** Traits tracés (micro-traits compris). */
  all: number;
  /** Traits issus de sous-tracés plus petits que SMALL_PT. */
  micro: number;
  /** Emprise des micro-traits. */
  box: RawBox;
  /** Couleur du premier micro-trait. */
  color: number;
}

/**
 * Trame ? Sous une découpe qui n'est pas la page et couvre au plus la moitié de la page : au moins MIN_STIPPLE
 * micro-traits, qui font au moins 80 % des traits tracés sous cette découpe.
 */
export function isStipple(clip: ClipZone, stat: ClipStrokeStat, pageArea: number): boolean {
  if (clip.id === 0 || boxArea(clip.bbox) > STIPPLE_MAX_CLIP_SHARE * pageArea) return false;
  return stat.micro >= MIN_STIPPLE && stat.micro >= STIPPLE_SHARE * stat.all;
}

/** Zones de trame d'une page, d'après le bilan par découpe (indice = numéro de découpe). */
export function stippleZones(clips: readonly ClipZone[], stats: readonly (ClipStrokeStat | undefined)[], pageArea: number): StippleZone[] {
  const out: StippleZone[] = [];
  stats.forEach((stat, id) => {
    const clip = clips[id];
    if (!stat || !clip || !isStipple(clip, stat, pageArea)) return;
    out.push({ clip: id, bbox: { ...stat.box }, count: stat.micro, color: stat.color });
  });
  return out;
}

/** Traits homogènes : même épaisseur (± HATCH_WIDTH_TOL), même couleur, même pointillé. */
export function sameInk(segs: readonly RawSeg[]): boolean {
  const s0 = segs[0];
  if (!s0) return false;
  return segs.every((s) => Math.abs(s.w - s0.w) <= HATCH_WIDTH_TOL && (s.color ?? 0) === (s0.color ?? 0) && s.dash === s0.dash);
}

function ringOfBox(b: RawBox): Ring {
  return [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ];
}

export interface HatchGrouping {
  zones: HatchZone[];
  /** 1 = trait regroupé dans une hachure (à retirer de `segs`). */
  drop: Uint8Array;
  /** Nombre de traits regroupés. */
  count: number;
}

/**
 * Regroupe les hachures d'une liste de traits :
 *  1. sous une même découpe (pas la page, ≤ 5 % de la page) : au moins HATCH_MIN_SEGS traits tracés (non remplis),
 *     d'encre homogène, qui passent `hatchOf` → zone de contour = la découpe ;
 *  2. repli sans découpe : un même tracé d'au moins PATH_HATCH_MIN_SEGS traits droits disjoints, qui passe
 *     `hatchOf` et dont l'emprise couvre ≤ 5 % de la page → zone de contour = la boîte des traits.
 * Les bords de remplissage (`fill`) ne sont jamais regroupés.
 */
export function groupHatches(segs: readonly RawSeg[], clips: readonly ClipZone[], clipRings: readonly (Ring[] | undefined)[], pageArea: number): HatchGrouping {
  const drop = new Uint8Array(segs.length);
  const zones: HatchZone[] = [];
  let count = 0;
  const byClip = new Map<number, number[]>();
  segs.forEach((s, i) => {
    const clip = s.clip ?? 0;
    if (!s.stroke || s.fill || clip === 0) return;
    let a = byClip.get(clip);
    if (!a) byClip.set(clip, (a = []));
    a.push(i);
  });
  for (const [clip, idx] of byClip) {
    const zone = clips[clip];
    if (!zone || idx.length < HATCH_MIN_SEGS || boxArea(zone.bbox) > HATCH_MAX_CLIP_SHARE * pageArea) continue;
    const mine = idx.map((i) => segs[i]!);
    if (!sameInk(mine)) continue;
    const h = hatchOf(mine);
    if (!h) continue;
    const rings = clipRings[clip];
    zones.push({ clip, bbox: { ...zone.bbox }, rings: rings && rings.length > 0 ? rings : [ringOfBox(zone.bbox)], angles: h.angles, spacing: h.spacing, color: mine[0]!.color ?? 0, width: mine[0]!.w, count: idx.length, source: 'clip' });
    for (const i of idx) drop[i] = 1;
    count += idx.length;
  }
  const byPid = new Map<number, number[]>();
  segs.forEach((s, i) => {
    if (drop[i] || !s.stroke || s.fill || s.curve) return;
    let a = byPid.get(s.pid);
    if (!a) byPid.set(s.pid, (a = []));
    a.push(i);
  });
  for (const idx of byPid.values()) {
    if (idx.length < PATH_HATCH_MIN_SEGS) continue;
    const mine = idx.map((i) => segs[i]!);
    if (!isDisjointRun(mine)) continue;
    const h = hatchOf(mine);
    if (!h) continue;
    const b = emptyBox();
    for (const s of mine) {
      growBox(b, s.x0, s.y0);
      growBox(b, s.x1, s.y1);
    }
    if (boxArea(b) > HATCH_MAX_CLIP_SHARE * pageArea) continue;
    zones.push({ clip: mine[0]!.clip ?? 0, bbox: b, rings: [ringOfBox(b)], angles: h.angles, spacing: h.spacing, color: mine[0]!.color ?? 0, width: mine[0]!.w, count: idx.length, source: 'path' });
    for (const i of idx) drop[i] = 1;
    count += idx.length;
  }
  return { zones, drop, count };
}
