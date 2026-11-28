/**
 * Géométrie des TEXTES d'une page PDF : exposants rattachés (« ² », le « ⁵ » du demi-centimètre, « ER » de
 * « 1ER »), morceaux de glyphes recollés, lignes de texte, valeur des cotes et paires de cotes de baies.
 *
 * Tout se décide par la STRUCTURE, relative au corps du texte : corps plus petit, relevé, collé à droite, même
 * ligne de base. Le calcul se fait dans le repère local du texte (u le long de la lecture, v vers le haut du
 * texte) : il vaut donc aussi pour les textes verticaux des cotes. Aucune coordonnée propre à une planche.
 *
 * Seuils mesurés sur une planche Archicad réelle et vérifiés sur des exports découpés mot par mot et glyphe par
 * glyphe : exposant à 0,45–0,8 corps du voisin, morceaux d'une même ligne espacés de 0,34 à 1,05 corps (deux
 * étiquettes voisines : 1,46 corps).
 */
import type { ReadOpeningPair, ReadView } from '../../core/reading';
import type { BBox } from '../../core/types';
import { fold, lineCenter, parseDecimal, readingFrame, sameDirection, viewAt, type SheetLine } from '../../semantics/labels';
import type { RawText } from './raw';

// ───────────────────────────── Repère local ─────────────────────────────

/** Étendue d'un texte dans le repère local d'un sens de lecture (u le long, v vers le haut) et sa ligne de base. */
export interface LocalExtent {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  base: number;
}

export function localExtent(t: RawText, angle = t.angle): LocalExtent {
  const { d, up } = readingFrame(angle);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const x of [t.x0, t.x1]) {
    for (const y of [t.y0, t.y1]) {
      const u = x * d.x + y * d.y;
      const v = x * up.x + y * up.y;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
  }
  return { u0, u1, v0, v1, base: t.bx * up.x + t.by * up.y };
}

// ───────────────────────────── Jetons : exposants et glyphes recollés ─────────────────────────────

/**
 * Un texte de la page, avec ses exposants. `main` : texte sans exposant ; `sup` : exposant final éventuel (« 5 »,
 * « 2 », « ER ») ; `text` : rendu (« 63⁵ », « 3,41 m² », « PLAN 1ER »). `t` porte la boîte du texte principal.
 */
export interface Token {
  t: RawText;
  main: string;
  text: string;
  sup: string;
  parts: RawText[];
}

const SUP_GLYPH: Record<string, string> = { '2': '²', '3': '³', '5': '⁵' };
/** Corps d'un exposant par rapport à son voisin. */
const SUP_SIZE_MIN = 0.45;
const SUP_SIZE_MAX = 0.8;
const GRID = 20;

function gridKeys(t: RawText): string[] {
  const keys: string[] = [];
  for (let gx = Math.floor(t.x0 / GRID); gx <= Math.floor(t.x1 / GRID); gx++) {
    for (let gy = Math.floor(t.y0 / GRID); gy <= Math.floor(t.y1 / GRID); gy++) keys.push(`${gx},${gy}`);
  }
  return keys;
}

/**
 * Rattache les exposants à leur texte : un texte de 3 caractères au plus devient l'exposant d'un voisin quand son
 * corps vaut 0,45 à 0,8 fois celui du voisin (même sens à 2° près), qu'il commence entre −0,3 et +0,5 corps après
 * la fin du voisin, et qu'il est relevé (centre au-dessus de la ligne de base + 0,35 corps, haut sous la ligne de
 * base + 1,25 corps). « 3,41 m » + « 2 » → « 3,41 m² » ; « 63 » + « 5 » → « 63⁵ » ; « PLAN 1 » + « ER » → « PLAN 1ER ».
 * Les morceaux d'un même mot écrits glyphe par glyphe sont ensuite recollés (mergeGlyphRuns).
 */
export function attachSuperscripts(texts: readonly RawText[]): Token[] {
  // Index spatial : chaque texte est rangé dans toutes les cases que couvre sa boîte (sinon l'exposant d'un grand
  // titre, loin du centre du titre, se perd).
  const grid = new Map<string, number[]>();
  texts.forEach((t, i) => {
    for (const k of gridKeys(t)) {
      const cell = grid.get(k);
      if (cell) cell.push(i);
      else grid.set(k, [i]);
    }
  });
  const isSup = new Set<number>();
  const supsOf = new Map<number, number[]>();
  for (let i = 0; i < texts.length; i++) {
    const u = texts[i]!;
    if (u.s.length > 3 || u.s.length === 0) continue;
    let best = -1;
    let bestGap = Infinity;
    const seen = new Set<number>();
    const gx = Math.floor(u.cx / GRID);
    const gy = Math.floor(u.cy / GRID);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (j === i || seen.has(j)) continue;
          seen.add(j);
          const t = texts[j]!;
          if (!(u.size < SUP_SIZE_MAX * t.size && u.size > SUP_SIZE_MIN * t.size) || !sameDirection(u.angle, t.angle)) continue;
          const L = localExtent(t);
          const U = localExtent(u, t.angle);
          const gap = U.u0 - L.u1;
          const raised = (U.v0 + U.v1) / 2 > L.base + 0.35 * t.size && U.v1 < L.base + 1.25 * t.size;
          if (gap > -0.3 * t.size && gap < 0.5 * t.size && raised && Math.abs(gap) < bestGap) {
            best = j;
            bestGap = Math.abs(gap);
          }
        }
      }
    }
    if (best >= 0) {
      isSup.add(i);
      const list = supsOf.get(best);
      if (list) list.push(i);
      else supsOf.set(best, [i]);
    }
  }
  const out: Token[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (isSup.has(i)) continue;
    const t = texts[i]!;
    // Un exposant rattaché à un texte qui est lui-même exposant d'un autre : on ne garde que le premier niveau.
    const sups = (supsOf.get(i) ?? []).filter((k) => !supsOf.has(k)).map((k) => texts[k]!);
    sups.sort((a, b) => localExtent(a, t.angle).u0 - localExtent(b, t.angle).u0);
    const sup = sups.map((s) => s.s).join('');
    const rendered = SUP_GLYPH[sup] ?? sup;
    out.push({ t, main: t.s, text: t.s + rendered, sup, parts: [t, ...sups] });
  }
  return mergeGlyphRuns(out);
}

/** Étendue d'un jeton, exposants compris, dans le repère d'un sens de lecture. */
function tokenExtent(k: Token, angle = k.t.angle): LocalExtent {
  const L = localExtent(k.t, angle);
  for (const p of k.parts.slice(1)) {
    const P = localExtent(p, angle);
    L.u0 = Math.min(L.u0, P.u0);
    L.u1 = Math.max(L.u1, P.u1);
  }
  return L;
}

function unionBox(parts: readonly RawText[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of parts) {
    minX = Math.min(minX, p.x0);
    minY = Math.min(minY, p.y0);
    maxX = Math.max(maxX, p.x1);
    maxY = Math.max(maxY, p.y1);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Exports qui écrivent glyphe par glyphe (ou mot par mot sans espace) : les morceaux qui se TOUCHENT (écart de
 * −0,3 à 0,2 corps, même ligne de base à 0,2 corps, même corps, même sens) forment un seul jeton ; un écart de plus
 * de 0,12 corps devient une espace. Les nombres d'une chaîne de cotes ne se touchent pas : ils restent séparés.
 * Un jeton qui porte déjà un exposant n'absorbe rien après lui (« PLAN 1ER » puis « ÉTAGE » restent deux jetons).
 */
export function mergeGlyphRuns(tokens: readonly Token[]): Token[] {
  const rows = new Map<string, { k: Token; L: LocalExtent }[]>();
  for (const k of tokens) {
    const L = tokenExtent(k);
    const key = `${Math.round(k.t.angle)}|${Math.round(L.base / (0.5 * k.t.size))}|${k.t.size.toFixed(1)}`;
    const row = rows.get(key);
    if (row) row.push({ k, L });
    else rows.set(key, [{ k, L }]);
  }
  const out: Token[] = [];
  for (const row of rows.values()) {
    row.sort((a, b) => a.L.u0 - b.L.u0);
    let cur: { k: Token; end: number; base: number } | null = null;
    for (const it of row) {
      const s = it.k.t.size;
      const gapU = cur ? it.L.u0 - cur.end : Infinity;
      if (cur && !cur.k.sup && gapU < 0.2 * s && gapU > -0.3 * s && Math.abs(cur.base - it.L.base) < 0.2 * s) {
        const space = gapU > 0.12 * s ? ' ' : '';
        const t0 = cur.k.t;
        const t1 = it.k.t;
        const x0 = Math.min(t0.x0, t1.x0);
        const y0 = Math.min(t0.y0, t1.y0);
        const x1 = Math.max(t0.x1, t1.x1);
        const y1 = Math.max(t0.y1, t1.y1);
        const t: RawText = { ...t0, s: t0.s + space + t1.s, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
        cur.k = { t, main: cur.k.main + space + it.k.main, text: cur.k.text + space + it.k.text, sup: it.k.sup, parts: [...cur.k.parts, ...it.k.parts] };
        cur.end = Math.max(cur.end, it.L.u1);
        continue;
      }
      if (cur) out.push(cur.k);
      cur = { k: it.k, end: it.L.u1, base: it.L.base };
    }
    if (cur) out.push(cur.k);
  }
  return out;
}

// ───────────────────────────── Lignes ─────────────────────────────

export interface TextLine extends SheetLine {
  tokens: Token[];
}

/** Un jeton qui commence par un intitulé (« S: », « NF : ») ouvre une nouvelle ligne quand il suit un nombre. */
const KEY_START_RE = /^\p{L}{1,12}\.?\s?:/u;

/**
 * Regroupe en LIGNES les jetons de même sens (2°), même corps (rapport 0,75 à 1,33) et même ligne de base (0,35
 * corps), espacés le long de la lecture de −0,3 à `maxGapFactor` corps (1,1 par défaut). Exception : « S: 3,41 m² » et
 * « S: 4,96 m² » écrits côte à côte restent deux lignes (un intitulé qui suit un nombre n'est pas joint).
 */
export function buildLines(tokens: readonly Token[], page = 1, maxGapFactor = 1.1): TextLine[] {
  interface Item {
    k: Token;
    L: LocalExtent;
    used: boolean;
  }
  // Par sens de lecture arrondi au degré ; dans chaque groupe, rangés par ligne de base pour chercher vite.
  const groups = new Map<number, Item[]>();
  for (const k of tokens) {
    const key = ((Math.round(k.t.angle) % 360) + 360) % 360;
    const it: Item = { k, L: tokenExtent(k), used: false };
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }
  const lines: TextLine[] = [];
  for (const group of groups.values()) {
    const byBase = [...group].sort((a, b) => a.L.base - b.L.base);
    const bases = byBase.map((it) => it.L.base);
    const lowerBound = (v: number): number => {
      let lo = 0;
      let hi = bases.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bases[mid]! < v) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const order = [...group].sort((a, b) => a.L.u0 - b.L.u0);
    for (const seed of order) {
      if (seed.used) continue;
      seed.used = true;
      const s = seed.k.t.size;
      const angle = seed.k.t.angle;
      // Candidats : même ligne de base (marge large ici, test exact dans le repère de la graine ensuite).
      const cands: { it: Item; L: LocalExtent }[] = [];
      for (let i = lowerBound(seed.L.base - 0.6 * s); i < byBase.length && bases[i]! <= seed.L.base + 0.6 * s; i++) {
        const o = byBase[i]!;
        if (o.used || !sameDirection(o.k.t.angle, angle)) continue;
        const r = o.k.t.size / s;
        if (r < 0.75 || r > 1.33) continue;
        const L = tokenExtent(o.k, angle);
        if (Math.abs(L.base - seed.L.base) > 0.35 * s) continue;
        cands.push({ it: o, L });
      }
      const members: { k: Token; L: LocalExtent }[] = [{ k: seed.k, L: seed.L }];
      let end = seed.L.u1;
      for (;;) {
        let next: { it: Item; L: LocalExtent } | null = null;
        const last = members[members.length - 1]!.k;
        for (const c of cands) {
          if (c.it.used) continue;
          const gap = c.L.u0 - end;
          if (gap < -0.3 * s || gap > maxGapFactor * s) continue;
          if (KEY_START_RE.test(c.it.k.text) && /\d/.test(last.text)) continue;
          if (!next || c.L.u0 < next.L.u0) next = c;
        }
        if (!next) break;
        next.it.used = true;
        members.push({ k: next.it.k, L: next.L });
        end = Math.max(end, next.L.u1);
      }
      let text = '';
      let prevEnd = -Infinity;
      for (const m of members) {
        if (text && m.L.u0 - prevEnd > 0.12 * s) text += ' ';
        text += m.k.text;
        prevEnd = Math.max(prevEnd, m.L.u1);
      }
      lines.push({
        text: text.replace(/\s+/g, ' ').trim(),
        page,
        angle,
        size: s,
        box: unionBox(members.flatMap((m) => m.k.parts)),
        u0: seed.L.u0,
        u1: end,
        base: seed.L.base,
        tokens: members.map((m) => m.k),
      });
    }
  }
  // Ordre stable : de haut en bas puis de gauche à droite (lecture d'une feuille).
  lines.sort((a, b) => a.box.minY - b.box.minY || a.box.minX - b.box.minX);
  return lines;
}

/** Jetons et lignes d'une liste de textes d'une page. */
export function textLines(texts: readonly RawText[], page = 1): { tokens: Token[]; lines: TextLine[] } {
  const tokens = attachSuperscripts(texts);
  return { tokens, lines: buildLines(tokens, page) };
}

// ───────────────────────────── Cotes ─────────────────────────────

/**
 * Valeur d'une cote, en MÈTRES, à partir de son texte et de son exposant éventuel « 5 » (demi-centimètre).
 * Convention des plans luxembourgeois et allemands : avec décimale → mètres, entier → centimètres.
 * « 63 » + « 5 » → 0,635 ; « 4,12 » + « 5 » → 4,125 ; « 1,2 » + « 5 » → 1,205 ; « 1,26 » → 1,26 ; « 24 » → 0,24. null si ce n'est pas une cote.
 */
export function dimensionValue(main: string, sup = ''): number | null {
  const s = main.trim();
  if (!/^\d{1,5}(?:[.,]\d{1,3})?$/.test(s)) return null;
  if (sup !== '' && sup !== '5') return null;
  const half = sup === '5';
  // Le ⁵ ajoute un demi-centimètre, quelle que soit la précision écrite (« 1,2⁵ » = 1,205 m, pas 1,25).
  if (/[.,]/.test(s)) return half ? Math.round((parseDecimal(s) + 0.005) * 10000) / 10000 : parseDecimal(s);
  return (parseDecimal(s) + (half ? 0.5 : 0)) / 100;
}

/** Cote numérique isolée sur la page. */
export interface DimToken {
  value: number;
  /** Texte rendu (« 63⁵ »). */
  raw: string;
  /** Écrite avec une décimale (donc en mètres). */
  decimal: boolean;
  half: boolean;
  cx: number;
  cy: number;
  angle: number;
  size: number;
}

export function dimensionTokens(tokens: readonly Token[]): DimToken[] {
  const out: DimToken[] = [];
  for (const k of tokens) {
    const value = dimensionValue(k.main, k.sup);
    if (value === null) continue;
    // Centre du nombre principal : l'exposant, décalé, ne doit pas déplacer la cote.
    out.push({ value, raw: k.text, decimal: /[.,]/.test(k.main), half: k.sup === '5', cx: k.t.cx, cy: k.t.cy, angle: k.t.angle, size: k.t.size });
  }
  return out;
}

// ───────────────────────────── Baies : largeur / hauteur superposées ─────────────────────────────

/** Allège écrite : « ALL. 0,90 », « Allège 1,10 », « BRH 0,90 », « Brüstungshöhe 0,85 ». */
const SILL_RE = /^(?:all\.?|allege|bru(?:stungs)?h(?:ohe)?\.?|brh|bh)\s*[:=]?\s*(\d[.,]\d{2})\s*m?$/;
const PAIR_WIDTH = { min: 0.3, max: 8 };
const PAIR_HEIGHT = { min: 0.3, max: 3.2 };

/**
 * Cotes de baies écrites en DEUX nombres superposés sur une chaîne de cotes : largeur au-dessus, hauteur dessous
 * (« 1,26 / 1,38 », « 60 / 80 » en cm). Les deux nombres : même sens et même corps (15 %), centrés l'un sur l'autre le long de
 * la lecture (0,8 corps), lignes de base décalées de 0,7 à 1,6 corps ; largeur 0,3–8 m, hauteur 0,3–3,2 m.
 * Seulement dans les plans et les façades (ou hors de toute vue connue). Allège : la mention « ALL. » la plus proche
 * (25 corps), dans la même vue.
 */
export function openingPairs(dims: readonly DimToken[], lines: readonly SheetLine[], views: readonly ReadView[], page = 1): ReadOpeningPair[] {
  const sills = lines.flatMap((l) => {
    if (l.page !== page) return [];
    const m = SILL_RE.exec(fold(l.text).replace(/\s+/g, ' '));
    if (!m) return [];
    const at = lineCenter(l);
    return [{ value: parseDecimal(m[1]!), at, view: viewAt(views, page, at) }];
  });
  // Du haut vers le bas dans le repère de chaque cote : le nombre du dessus est examiné avant celui du dessous.
  const vOf = (t: DimToken): number => {
    const { up } = readingFrame(t.angle);
    return t.cx * up.x + t.cy * up.y;
  };
  const usable = [...dims].sort((a, b) => vOf(b) - vOf(a));
  const used = new Set<DimToken>();
  const out: ReadOpeningPair[] = [];
  for (const a of usable) {
    if (used.has(a) || a.value < PAIR_WIDTH.min || a.value > PAIR_WIDTH.max) continue;
    const { d, up } = readingFrame(a.angle);
    const ua = a.cx * d.x + a.cy * d.y;
    const va = a.cx * up.x + a.cy * up.y;
    let best: DimToken | null = null;
    let bestDv = Infinity;
    for (const b of usable) {
      if (b === a || used.has(b) || !sameDirection(a.angle, b.angle) || Math.abs(a.size - b.size) > 0.15 * a.size) continue;
      if (b.value < PAIR_HEIGHT.min || b.value > PAIR_HEIGHT.max) continue;
      const ub = b.cx * d.x + b.cy * d.y;
      const dv = va - (b.cx * up.x + b.cy * up.y); // > 0 : b est sous a
      if (Math.abs(ua - ub) > 0.8 * a.size || dv < 0.7 * a.size || dv > 1.6 * a.size) continue;
      if (dv < bestDv) {
        best = b;
        bestDv = dv;
      }
    }
    if (!best) continue;
    const at = { x: (a.cx + best.cx) / 2, y: (a.cy + best.cy) / 2 };
    const view = viewAt(views, page, at);
    if (view && view.kind !== 'floor-plan' && view.kind !== 'elevation') continue;
    // Deux entiers superposés (« 120 » sur « 135 ») hors de toute vue connue : rien ne dit que c'est une baie (une
    // chaîne de cotes en centimètres en donne autant). Il faut alors une décimale ou un ⁵ pour l'accepter.
    if (!view && !a.decimal && !best.decimal && !a.half && !best.half) continue;
    used.add(a);
    used.add(best);
    let sill: number | null = null;
    let sillD = 25 * a.size;
    for (const s of sills) {
      if (s.view !== view) continue;
      const dd = Math.hypot(s.at.x - at.x, s.at.y - at.y);
      if (dd < sillD) {
        sill = s.value;
        sillD = dd;
      }
    }
    out.push({ width: a.value, height: best.value, sill, viewId: view?.id ?? null, page, at });
  }
  return out;
}
