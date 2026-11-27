/**
 * Indices d'échelle lus sur une page : échelle annoncée (cartouche, titre de vue) et auto-calibrage par les cotes.
 *
 * Règle d'or (mesurée sur un A3 « ajusté à la page » en A4 : cartouche 1:100, réalité 1:141, surfaces fausses
 * de −50 %) : l'échelle écrite n'est qu'un INDICE. La vérité vient du consensus des cotes — et des surfaces
 * écrites dans les pièces, voir walls.ts.
 *
 * Auto-calibrage par les cotes (porté de analyze.py, validé sur les plans d'essai) :
 *  1. on fusionne les traits fins alignés ; une ligne de cote est une ligne coupée en son axe par au moins
 *     deux petits traits (tirets à 45°, lignes d'attache) ;
 *  2. deux coupures voisines délimitent un intervalle ;
 *  3. le nombre écrit parallèlement, au droit de l'intervalle, donne valeur / longueur ;
 *  4. les nombres à virgule sont des mètres (« 3,26⁵ » = 3,265 m), les entiers sont essayés en mm, cm et m ;
 *     on garde l'hypothèse qui met le plus de cotes d'accord (médiane, tolérance 2 %).
 * Non couvert : flèches ou points sans trait qui coupe la ligne, texte logé dans une ligne interrompue,
 * cotes obliques, cotes de rayon ou d'angle.
 */
import { fold } from '../../semantics/labels';
import { METRES_PER_POINT } from './raw';
import type { RawPage, RawSeg, RawText } from './raw';

// ───────────────────────────── Échelle annoncée ─────────────────────────────

export interface DeclaredScale {
  /** Dénominateur : 100 pour 1:100. */
  den: number;
  /** Vrai si un mot l'accompagne (« Échelle », « Maßstab », « M »…). */
  keyword: boolean;
  text: string;
  size: number;
  /** Indice, dans la liste reçue, du texte qui porte l'échelle : sert à rattacher une échelle écrite près d'une vue à cette vue. */
  index: number;
}

/** Dénominateurs d'échelles de dessin courants. */
export const STANDARD_SCALES: readonly number[] = [5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000];
/** Échelles habituelles d'un plan d'étage, de la plus probable à la moins probable. */
const PLAN_SCALES: readonly number[] = [100, 50, 200, 75, 25, 20, 125, 150, 250, 500];
/** Échelles auxquelles un plan coté en millimètres est d'ordinaire dessiné. */
const MM_PLAN_SCALES: readonly number[] = [20, 50, 100];

const SCALE_RE =
  /(?<![\d/.:,])(?:(?<![a-z])(echelle|ech\.?|mass?stab|mst\.?|scale|m\.?)\s*[:=]?\s*)?1\s*[:/]\s*(\d{1,4})(?:\s*(?:eme|e)(?![a-z]))?(?![\d/:,]|\.\d)/g;

/**
 * Échelles écrites sur la page, les plus crédibles d'abord (mot-clé, puis corps du texte).
 * Sans mot-clé, seules les échelles de plan usuelles (≥ 1:20) sont retenues : « 1/2 » est un numéro de page.
 */
export function declaredScales(texts: readonly RawText[]): DeclaredScale[] {
  const out: DeclaredScale[] = [];
  for (let index = 0; index < texts.length; index++) {
    const t = texts[index]!;
    const folded = fold(t.s);
    SCALE_RE.lastIndex = 0;
    for (let m = SCALE_RE.exec(folded); m; m = SCALE_RE.exec(folded)) {
      const den = Number(m[2]);
      const keyword = m[1] !== undefined;
      if (!STANDARD_SCALES.includes(den)) continue;
      if (!keyword && den < 20) continue;
      out.push({ den, keyword, text: t.s, size: t.size, index });
    }
  }
  out.sort((a, b) => Number(b.keyword) - Number(a.keyword) || b.size - a.size);
  return out;
}

const UNIT_HINT_RE = /(?:cotes?|dimensions?|mesures?|masse?|massangaben|bemassung|vermassung|abmessungen)\b[^.;\n]{0,24}?\b(?:en|in)\s+(mm|cm|m)\b/;

/** « Toutes les cotes sont en cm », « Alle Maße in m » → unité des cotes entières ; null sinon. */
export function dimensionUnitHint(texts: readonly RawText[]): DimUnit | null {
  for (const t of texts) {
    const m = UNIT_HINT_RE.exec(fold(t.s));
    if (m) return m[1] as DimUnit;
  }
  return null;
}

// ───────────────────────────── Cotes ─────────────────────────────

export type DimUnit = 'mm' | 'cm' | 'm';
const UNIT_METRES: Readonly<Record<DimUnit, number>> = { mm: 0.001, cm: 0.01, m: 1 };
/** À égalité, l'ordre de préférence des unités des cotes entières d'un plan de bâtiment. */
const UNIT_ORDER: readonly DimUnit[] = ['cm', 'mm', 'm'];

interface DimToken {
  value: number;
  decimal: boolean;
  /** Exposant « ⁵ » allemand : un demi-centimètre de plus. */
  half: boolean;
  cx: number;
  cy: number;
  angle: number;
  size: number;
  /** Indice du texte d'origine dans la page : dit à quelle vue la cote appartient. */
  index: number;
}

const NUMBER_RE = /^\d{1,5}(?:[.,]\d{1,3})?$/;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  return n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/** Écart d'angle entre deux directions non orientées (degrés, 0..90). */
function directionGap(a: number, b: number): number {
  const d = (((a - b) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
}

/** Nombres isolés ; l'exposant « 5 » allemand (« 11⁵ », « 3,26⁵ ») est rattaché au nombre qu'il suit. */
function dimensionTokens(texts: readonly RawText[]): DimToken[] {
  const numeric: { t: RawText; index: number }[] = [];
  texts.forEach((t, index) => {
    if (NUMBER_RE.test(t.s)) numeric.push({ t, index });
  });
  if (numeric.length === 0) return [];
  const main = median(numeric.map((n) => n.t.size));
  const raised = numeric.map((n) => n.t).filter((t) => t.size < 0.8 * main && t.s === '5');
  const used = new Set<number>();
  const out: DimToken[] = [];
  for (const { t, index } of numeric) {
    if (t.size < 0.8 * main) continue;
    let half = false;
    for (let i = 0; i < raised.length; i++) {
      const u = raised[i]!;
      if (used.has(i) || Math.round(u.angle) !== Math.round(t.angle)) continue;
      let ok = false;
      if (Math.abs(Math.round(t.angle)) < 1) {
        // Texte horizontal : l'exposant suit le nombre, relevé.
        ok = u.x0 - t.x1 > -1 && u.x0 - t.x1 < 0.6 * t.size && u.cy > t.y0 - 0.6 * t.size && u.cy < t.cy;
      } else if (Math.abs(Math.round(t.angle) - 90) < 1) {
        // Texte vertical lu vers le haut : l'exposant est au-dessus, décalé vers la gauche.
        ok = t.y0 - u.y1 > -1 && t.y0 - u.y1 < 0.6 * t.size && u.cx > t.x0 - 0.6 * t.size && u.cx < t.cx;
      }
      if (ok) {
        used.add(i);
        half = true;
        break;
      }
    }
    out.push({
      value: Number(t.s.replace(',', '.')),
      decimal: /[.,]/.test(t.s),
      half,
      cx: t.cx,
      cy: t.cy,
      angle: t.angle,
      size: t.size,
      index,
    });
  }
  return out;
}

interface MergedLine {
  /** Direction, en degrés dans [0, 180), repère de la feuille (y vers le bas). */
  theta: number;
  /** Distance signée de la droite à l'origine. */
  rho: number;
  /** Étendue le long de la droite. */
  a0: number;
  a1: number;
}

/** Fusionne les traits fins droits, alignés, qui se touchent ou se recouvrent. */
function mergedThinLines(segs: readonly RawSeg[], maxWidth: number, tol = 0.4): MergedLine[] {
  const groups = new Map<string, { a0: number; a1: number; rho: number }[]>();
  for (const s of segs) {
    if (s.curve || !s.stroke || s.w > maxWidth || s.dash) continue;
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    if (Math.hypot(dx, dy) < 0.2) continue;
    let th = (((Math.atan2(dy, dx) * 180) / Math.PI) % 180 + 180) % 180;
    if (th > 179.75) th = 0;
    const thq = Math.round(th * 2) / 2;
    const rad = (thq * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const rho = -uy * s.x0 + ux * s.y0;
    const p = ux * s.x0 + uy * s.y0;
    const q = ux * s.x1 + uy * s.y1;
    const key = `${thq}|${Math.round(rho / tol)}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push({ a0: Math.min(p, q), a1: Math.max(p, q), rho });
  }
  const out: MergedLine[] = [];
  for (const [key, list] of groups) {
    const theta = Number(key.slice(0, key.indexOf('|')));
    list.sort((a, b) => a.a0 - b.a0);
    let cur = { ...list[0]! };
    for (let i = 1; i < list.length; i++) {
      const it = list[i]!;
      if (it.a0 <= cur.a1 + tol) cur.a1 = Math.max(cur.a1, it.a1);
      else {
        out.push({ theta, rho: cur.rho, a0: cur.a0, a1: cur.a1 });
        cur = { ...it };
      }
    }
    out.push({ theta, rho: cur.rho, a0: cur.a0, a1: cur.a1 });
  }
  return out;
}

/** Grille de hachage de points : retrouve vite les points proches d'une droite. */
class PointGrid {
  private readonly cells = new Map<number, number[]>();

  constructor(
    private readonly cell: number,
    xs: readonly number[],
    ys: readonly number[],
  ) {
    for (let i = 0; i < xs.length; i++) {
      const k = this.key(Math.floor(xs[i]! / cell), Math.floor(ys[i]! / cell));
      const list = this.cells.get(k);
      if (list) list.push(i);
      else this.cells.set(k, [i]);
    }
  }

  private key(ix: number, iy: number): number {
    return (ix + 32768) * 65536 + (iy + 32768);
  }

  /** Appelle `visit` pour chaque point à moins de `reach` (environ) de la portion de droite donnée. */
  alongLine(line: MergedLine, reach: number, stamp: Int32Array, mark: number, visit: (index: number) => void): void {
    const rad = (line.theta * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const span = Math.ceil(reach / this.cell);
    const step = this.cell / 2;
    for (let a = line.a0 - reach; a <= line.a1 + reach + step; a += step) {
      const x = ux * a - uy * line.rho;
      const y = uy * a + ux * line.rho;
      const ix = Math.floor(x / this.cell);
      const iy = Math.floor(y / this.cell);
      for (let jx = ix - span; jx <= ix + span; jx++) {
        for (let jy = iy - span; jy <= iy + span; jy++) {
          const list = this.cells.get(this.key(jx, jy));
          if (!list) continue;
          for (const i of list) {
            if (stamp[i] === mark) continue;
            stamp[i] = mark;
            visit(i);
          }
        }
      }
    }
  }
}

export interface DimObservation {
  token: DimToken;
  /** Longueur de l'intervalle mesurée sur la feuille (pt). */
  lengthPt: number;
}

export interface DimHypothesis {
  unit: DimUnit;
  /** Dénominateur médian. */
  den: number;
  /** Cotes à moins de 2 % de la médiane. */
  inliers: number;
  /** Moyenne des cotes concordantes. */
  meanDen: number;
  /** Dispersion des cotes concordantes (%). */
  spreadPct: number;
  /** Plus grande cote concordante, en mètres, sous cette hypothèse. */
  maxMetres: number;
}

export interface DimCalibration {
  /** Nombre de couples cote ↔ intervalle. */
  n: number;
  nInteger: number;
  nDecimal: number;
  /** Médiane des valeurs des cotes ENTIÈRES telles qu'écrites (« 10000 », « 850 ») ; NaN sans cote entière. */
  integerMedian: number;
  hypotheses: DimHypothesis[];
}

/** Associe les nombres aux intervalles des lignes de cote et évalue chaque unité possible des cotes entières. */
export function calibrateByDimensions(page: RawPage): DimCalibration {
  return calibrateObservations(dimensionObservations(page));
}

/**
 * Couples cote ↔ intervalle de toute la page. Chaque couple garde l'indice de son nombre dans la page : l'appelant
 * peut ainsi calibrer une VUE à part (un plan au 1:100 à côté d'une coupe au 1:50) avec `calibrateObservations`.
 */
export function dimensionObservations(page: RawPage): DimObservation[] {
  const empty: DimObservation[] = [];
  const tokens = dimensionTokens(page.texts);
  if (tokens.length < 2) return empty;

  const widths = [...new Set(page.segs.filter((s) => s.stroke).map((s) => Math.round(s.w * 100) / 100))].sort((a, b) => a - b);
  if (widths.length === 0) return empty;
  const thinMax = widths[Math.min(2, widths.length - 1)]! + 0.01;

  const tokenGrid = new PointGrid(
    32,
    tokens.map((t) => t.cx),
    tokens.map((t) => t.cy),
  );
  const tokenStamp = new Int32Array(tokens.length).fill(-1);
  const maxTokenReach = 3.2 * Math.max(...tokens.map((t) => t.size));

  // Petits traits susceptibles de couper une ligne de cote.
  const sx: number[] = [];
  const sy: number[] = [];
  const sTheta: number[] = [];
  for (const s of page.segs) {
    if (s.curve || !s.stroke) continue;
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const len = Math.hypot(dx, dy);
    if (len <= 1 || len >= 16) continue;
    sx.push((s.x0 + s.x1) / 2);
    sy.push((s.y0 + s.y1) / 2);
    sTheta.push((((Math.atan2(dy, dx) * 180) / Math.PI) % 180 + 180) % 180);
  }
  if (sx.length < 2) return empty;
  const shortGrid = new PointGrid(16, sx, sy);
  const shortStamp = new Int32Array(sx.length).fill(-1);

  const lines = mergedThinLines(page.segs, thinMax).filter((l) => l.a1 - l.a0 > 8);
  const observations: DimObservation[] = [];
  const usedToken = new Uint8Array(tokens.length);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    // Une ligne sans nombre à proximité n'est pas une ligne de cote : on évite le travail inutile.
    const near: number[] = [];
    tokenGrid.alongLine(line, maxTokenReach, tokenStamp, li, (i) => near.push(i));
    if (near.length === 0) continue;

    const rad = (line.theta * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const cuts: number[] = [];
    shortGrid.alongLine(line, 1, shortStamp, li, (i) => {
      const d = Math.abs(-uy * sx[i]! + ux * sy[i]! - line.rho);
      const a = ux * sx[i]! + uy * sy[i]!;
      if (d < 0.35 && a >= line.a0 - 0.5 && a <= line.a1 + 0.5 && directionGap(sTheta[i]!, line.theta) > 20) cuts.push(a);
    });
    if (cuts.length < 2) continue;
    cuts.sort((a, b) => a - b);
    const marks: number[] = [cuts[0]!];
    for (const c of cuts) if (c - marks[marks.length - 1]! > 0.6) marks.push(c);
    if (marks.length < 2) continue;

    for (let k = 0; k + 1 < marks.length; k++) {
      const b0 = marks[k]!;
      const b1 = marks[k + 1]!;
      let best = -1;
      let bestScore = Infinity;
      for (const i of near) {
        if (usedToken[i]) continue;
        const t = tokens[i]!;
        // Sens de lecture parallèle à la ligne (l'angle du texte est trigonométrique, celui de la ligne en y vers le bas).
        if (directionGap(-t.angle, line.theta) > 5) continue;
        const a = ux * t.cx + uy * t.cy;
        const d = Math.abs(-uy * t.cx + ux * t.cy - line.rho);
        if (d > 3.2 * t.size) continue;
        if (a < b0 - 0.25 * t.size || a > b1 + 0.25 * t.size) continue;
        const score = d + 0.5 * Math.abs(a - (b0 + b1) / 2);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best >= 0) {
        usedToken[best] = 1;
        observations.push({ token: tokens[best]!, lengthPt: b1 - b0 });
      }
    }
  }
  return observations;
}

/** Longueur réelle (m) annoncée par une cote, si ses entiers sont lus dans l'unité donnée. */
function observedMetres(o: DimObservation, unit: DimUnit): number {
  const t = o.token;
  return t.decimal ? t.value + (t.half ? 0.005 : 0) : (t.value + (t.half ? 0.5 : 0)) * UNIT_METRES[unit];
}

/** Dénominateur que donne chaque cote (valeur annoncée / longueur sur la feuille). */
function observedDens(observations: readonly DimObservation[], unit: DimUnit): number[] {
  return observations.map((o) => observedMetres(o, unit) / (o.lengthPt * METRES_PER_POINT));
}

/**
 * Centre du groupe de valeurs le plus fourni (fenêtre de ±2 %) : sert quand la médiane tombe ENTRE deux
 * groupes — page portant deux vues à deux échelles, cotées à parts presque égales.
 */
function densestCentre(values: readonly number[]): { centre: number; count: number } {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  let centre = Number.NaN;
  let count = 0;
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (sorted[j]! < sorted[i]! / 1.04) j++;
    if (i - j + 1 > count) {
      count = i - j + 1;
      centre = median(sorted.slice(j, i + 1));
    }
  }
  return { centre, count };
}

/** Évalue, pour un lot de cotes (une page entière ou une seule vue), chaque unité possible des cotes entières. */
export function calibrateObservations(observations: readonly DimObservation[]): DimCalibration {
  const integers = observations.filter((o) => !o.token.decimal).map((o) => o.token.value);
  const integerMedian = median(integers);
  if (observations.length === 0) return { n: 0, nInteger: 0, nDecimal: 0, integerMedian, hypotheses: [] };
  const hypotheses: DimHypothesis[] = [];
  for (const unit of UNIT_ORDER) {
    const metres = observations.map((o) => observedMetres(o, unit));
    const dens = observedDens(observations, unit);
    let med = median(dens);
    if (!(med > 0)) continue;
    const near = (centre: number): number => dens.reduce((n, d) => n + (Math.abs(d / centre - 1) < 0.02 ? 1 : 0), 0);
    // La médiane fait foi tant qu'elle rassemble la moitié des cotes ; sinon le groupe le plus fourni l'emporte.
    if (near(med) < 0.5 * dens.length) {
      const dense = densestCentre(dens);
      if (dense.centre > 0 && near(dense.centre) > near(med)) med = dense.centre;
    }
    let inliers = 0;
    let sum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    let maxMetres = 0;
    dens.forEach((d, i) => {
      if (Math.abs(d / med - 1) >= 0.02) return;
      inliers++;
      sum += d;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
      if (metres[i]! > maxMetres) maxMetres = metres[i]!;
    });
    if (inliers === 0) continue;
    hypotheses.push({ unit, den: med, inliers, meanDen: sum / inliers, spreadPct: (100 * (hi - lo)) / med, maxMetres });
  }
  const nInteger = integers.length;
  return { n: observations.length, nInteger, nDecimal: observations.length - nInteger, integerMedian, hypotheses };
}

/**
 * Second groupe de cotes concordantes, à une AUTRE échelle que celle retenue (au moins deux cotes, et au moins
 * 15 % des cotes lues, à plus de 10 % de la première) : signe d'une page qui porte des vues à des échelles
 * différentes. null s'il n'y en a pas.
 */
export function secondDimensionCluster(observations: readonly DimObservation[], choice: DimChoice): { den: number; inliers: number } | null {
  const rest = observedDens(observations, choice.unit).filter((d) => d > 0 && Math.abs(d / choice.den - 1) >= 0.1);
  if (rest.length < 2) return null;
  const dense = densestCentre(rest);
  if (!(dense.centre > 0) || dense.count < 2 || dense.count < 0.15 * observations.length) return null;
  const members = rest.filter((d) => Math.abs(d / dense.centre - 1) < 0.02);
  if (members.length < 2) return null;
  return { den: members.reduce((s, d) => s + d, 0) / members.length, inliers: members.length };
}

export interface DimChoice {
  unit: DimUnit;
  den: number;
  inliers: number;
  n: number;
  spreadPct: number;
  /** Vrai si une autre unité expliquait aussi bien les cotes entières et que seul l'usage a tranché. */
  ambiguous: boolean;
}

function closeness(den: number, refs: readonly number[]): number {
  let best = Infinity;
  for (const r of refs) best = Math.min(best, Math.abs(Math.log(den / r)));
  return best;
}

/**
 * Choisit l'unité des cotes entières : le plus de cotes concordantes d'abord, puis l'indice le plus fort
 * disponible — mention écrite (« cotes en cm »), échelle annoncée ou donnée par les surfaces, usage.
 * `anchors` = dénominateurs suggérés par ailleurs (échelles annoncées, calibrage par les surfaces).
 */
export function chooseDimensionScale(cal: DimCalibration, anchors: readonly number[], hint: DimUnit | null): DimChoice | null {
  if (cal.hypotheses.length === 0) return null;
  const plausible = cal.hypotheses.filter((h) => h.meanDen >= 4 && h.meanDen <= 2500);
  if (plausible.length === 0) return null;
  const top = Math.max(...plausible.map((h) => h.inliers));
  // Toutes les cotes sont à virgule : l'unité des entiers n'intervient pas.
  const tied = cal.nInteger === 0 ? plausible.slice(0, 1) : plausible.filter((h) => h.inliers === top);
  let pick = tied[0]!;
  let ambiguous = false;
  if (tied.length > 1) {
    const hinted = hint ? tied.find((h) => h.unit === hint) : undefined;
    const anchored = anchors.length > 0 ? tied.filter((h) => closeness(h.meanDen, anchors) < 0.03) : [];
    if (hinted) pick = hinted;
    else if (anchored.length === 1) pick = anchored[0]!;
    else {
      // Ni mention ni recoupement. La plus grande cote d'un plan de bâtiment est une longueur de bâtiment
      // (ni 1,35 m ni 1 350 m) ; s'il reste un doute, l'échelle de plan la plus usuelle l'emporte, et on le dit.
      let pool = anchored.length > 1 ? anchored : tied;
      const sized = pool.filter((h) => h.maxMetres >= 2.5 && h.maxMetres <= 150);
      if (sized.length > 0) pool = sized;
      const refs = anchors.length > 0 ? anchors : PLAN_SCALES;
      pick = [...pool].sort((x, y) => closeness(x.meanDen, refs) - closeness(y.meanDen, refs))[0]!;
      // Cotes en millimètres : la plupart des cotes entières dépassent 1000 (« 10000 », « 8500 », « 1500 ») et, lues
      // en mm, donnent une échelle de plan usuelle (1:20, 1:50, 1:100). Lues en cm, elles donneraient un bâtiment
      // de 100 m aux fenêtres de 15 m, à une échelle de plan de masse (1:500). Le doute reste signalé (`ambiguous`).
      const mm = pool.find((h) => h.unit === 'mm');
      if (anchors.length === 0 && mm && cal.integerMedian >= 1000 && closeness(mm.meanDen, MM_PLAN_SCALES) < 0.03) pick = mm;
      ambiguous = anchors.length === 0 && pool.some((h) => h !== pick && closeness(h.meanDen, STANDARD_SCALES) < 0.03 && h.meanDen >= 10 && h.meanDen <= 1000);
    }
  }
  return { unit: pick.unit, den: pick.meanDen, inliers: pick.inliers, n: cal.n, spreadPct: pick.spreadPct, ambiguous };
}
