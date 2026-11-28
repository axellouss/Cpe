/**
 * Cotes de NIVEAU écrites sur une planche (« +0,20=+312,45 », « NF +2,87⁵ », « OKFF EG ±0,00 », « First +7,85 ») :
 * valeur relative, altitude, rôle (niveau fini, structure, acrotère, faîtage, égout, terrain, référence, gabarit
 * réglementaire), puis synthèse : altitude du ±0,00, niveaux finis des étages, hauteurs d'étage, sommet du volume,
 * égout, hauteurs libres écrites.
 *
 * Recoupements : « relatif + référence = altitude » (qui valide aussi l'exposant ⁵ du demi-centimètre), même niveau
 * fini lu sur plusieurs vues, sommet présent sur le plan de toiture. Les gabarits réglementaires (« gabarit max 9,00 »)
 * ne sont jamais pris pour le bâtiment.
 */
import type { LevelRole, ReadComposition, ReadLevelMark, ReadLevels, ReadView } from '../core/reading';
import type { Lang } from '../core/types';
import { registerMessages, t, type Dictionary } from '../i18n';
import { isStructureKey } from './compositions';
import { fold, lineCenter, parseDecimal, viewAt, type SheetLine } from './labels';

const MESSAGES: Dictionary = {
  fr: {
    'read.level.single': 'Niveau fini {value} lu une seule fois, sans altitude pour le vérifier : le confirmer.',
    'read.level.mismatch': 'Niveau fini {value} : avec la référence {ref}, l’altitude devrait être {expected}, mais {abs} est écrit. Quelle cote est juste ?',
    'read.level.top': 'Cote {value} : est-ce le haut de l’acrotère (ou le faîtage) ?',
    'read.level.grossHeight': 'Hauteur du volume chauffé : {layers} m (d’après les compositions) ou {top} m (sommet − niveau fini bas) ?',
    'read.level.noFloors': 'Niveaux finis non lus : hauteur du volume chauffé ?',
    'read.level.unlabelled': 'Niveaux d’étage lus sur les plans, sans mention « niveau fini » : les confirmer.',
  },
  de: {
    'read.level.single': 'Fertigfußboden {value} nur einmal gelesen, ohne Höhe über NN zur Kontrolle: bitte bestätigen.',
    'read.level.mismatch': 'Fertigfußboden {value}: mit der Bezugshöhe {ref} müsste die Höhe {expected} sein, angegeben ist {abs}. Welche Kote stimmt?',
    'read.level.top': 'Kote {value}: ist das die Oberkante Attika (oder der First)?',
    'read.level.grossHeight': 'Höhe des beheizten Volumens: {layers} m (aus den Aufbauten) oder {top} m (Oberkante − unterster Fertigfußboden)?',
    'read.level.noFloors': 'Keine Fertigfußböden gelesen: Höhe des beheizten Volumens?',
    'read.level.unlabelled': 'Geschosshöhen aus den Grundrissen, ohne Angabe „Fertigfußboden“: bitte bestätigen.',
  },
};
registerMessages(MESSAGES);

// ───────────────────────────── Cotes de niveau ─────────────────────────────

const WORD = "[A-Za-zÀ-ÿ.'’]{1,12}";
const SIGN = '(\\+\\/-|±|\\+|-|−)';
const NUM = '(\\d{1,3}[.,]\\d{2,3})(⁵)?';
/**
 * Ligne entière : préfixe facultatif (« NF », « OKFF EG », « First »), signe, valeur à 2 ou 3 décimales et ⁵
 * facultatif, puis « = altitude » facultative, puis mention facultative (« axe rue », « (acrotère) »).
 */
const LEVEL_RE = new RegExp(
  `^(?:(${WORD}(?:\\s${WORD}){0,2})\\s*:?\\s*)?${SIGN}?\\s?${NUM}(?:\\s*m)?(?:\\s*=\\s*${SIGN}?\\s?(\\d{2,4}[.,]\\d{1,3})(⁵)?(?:\\s*m)?)?(?:\\s*\\(?\\s*(${WORD}(?:\\s${WORD}){0,3})\\s*\\)?)?$`,
);

const ROLE_RULES: { re: RegExp; role: LevelRole }[] = [
  { re: /\b(?:ha|handp|hf|hmax|gabarit)\b.*max|\bmax\b|\bmaxi|zulassig|maximal|hochstens/, role: 'regulatory' },
  { re: /^(?:nf|niv\.? fini|niveau fini|niveau plancher fini|okff|ok ff|ok ffb|okffb|fff|ffb|okfb|fbok|fussboden|fertigfussboden|ff)\b/, role: 'finished-floor' },
  { re: /^(?:nb|okrd|ok rd|okrb|ok rf|okrf|rd|ok roh|rohfussboden|brut|niveau brut|dalle brute)\b/, role: 'structure' },
  { re: /acrotere|attika|\bhp\b|haut acrot|ok attika/, role: 'top' },
  { re: /faitage|\bfirst\b|\bfh\b|\bok first/, role: 'ridge' },
  { re: /corniche|egout|traufe|\btr\b|\bth\b|gouttiere/, role: 'eaves' },
  { re: /terrain|\btn\b|\bgok\b|gelande|\bog\b|\bngok\b/, role: 'terrain' },
  { re: /^fe\b|fond de fouille|fond d'excavation|aushub|baugrube/, role: 'excavation' },
  { re: /axe rue|axe de la rue|\baxe\b|strassenachse|\bref\b|reference|\bnn\b|repere/, role: 'reference' },
];

export function levelRole(label: string | null): LevelRole {
  if (!label) return 'unknown';
  const f = fold(label);
  for (const r of ROLE_RULES) if (r.re.test(f)) return r.role;
  return 'unknown';
}

function signed(sign: string | undefined, digits: string, half: string | undefined): number {
  const v = parseDecimal(half ? digits + '5' : digits);
  return sign === '-' || sign === '−' ? -v : v;
}

/** Une cote de niveau dans un texte d'une ligne ; null si la ligne n'en est pas une. */
export function parseLevelText(text: string): { rel: number | null; abs: number | null; prefix: string | null; suffix: string | null } | null {
  const s = text.replace(/\s+/g, ' ').trim();
  const m = LEVEL_RE.exec(s);
  if (!m) return null;
  const [, pre, sgn, d1, h1, sgn2, d2, h2, suf] = m;
  const prefix = pre?.trim() || null;
  // Sans signe, seule une mention de niveau reconnue fait d'un nombre une cote (« NF 2,875 ») : sinon c'est une cote
  // de longueur.
  if (!sgn && !(prefix && levelRole(prefix) !== 'unknown')) return null;
  if (prefix && !/^\p{L}/u.test(prefix)) return null;
  let rel: number | null = signed(sgn === '+/-' || sgn === '±' ? '+' : sgn, d1!, h1);
  let abs: number | null = d2 ? signed(sgn2, d2, h2) : null;
  // « +311,95 » seul : une altitude, pas un niveau relatif.
  if (abs === null && Math.abs(rel) > 100) {
    abs = rel;
    rel = null;
  }
  return { rel, abs, prefix, suffix: suf?.trim() || null };
}

/** Lignes qui peuvent servir d'étiquette à une cote voisine : un texte court avec au moins deux lettres. */
function isLabelLine(l: SheetLine): boolean {
  return /\p{L}{2}/u.test(l.text) && l.text.length <= 30 && parseLevelText(l.text) === null;
}

/**
 * Cotes de niveau d'un ensemble de lignes. Étiquette : le préfixe ou la mention écrits avec la cote, sinon le texte
 * court le plus proche dans la même vue (à 4 corps + la demi-largeur de la cote), sinon aucune.
 */
export function levelMarks(lines: readonly SheetLine[], views: readonly ReadView[]): ReadLevelMark[] {
  const labels = lines.filter(isLabelLine);
  const out: ReadLevelMark[] = [];
  for (const l of lines) {
    const p = parseLevelText(l.text);
    if (!p) continue;
    const at = lineCenter(l);
    const view = viewAt(views, l.page, at);
    let label = p.prefix ?? p.suffix;
    if (!label) {
      let best: SheetLine | null = null;
      let bestD = Infinity;
      const reach = 4 * l.size + (l.box.maxX - l.box.minX) / 2;
      for (const o of labels) {
        if (o.page !== l.page) continue;
        const c = lineCenter(o);
        if (viewAt(views, o.page, c) !== view) continue;
        const d = Math.hypot(c.x - at.x, c.y - at.y);
        if (d < reach && d < bestD) {
          best = o;
          bestD = d;
        }
      }
      label = best?.text ?? null;
    }
    let role = levelRole(p.prefix);
    if (role === 'unknown') role = levelRole(p.suffix);
    if (role === 'unknown') role = levelRole(label);
    out.push({ rel: p.rel, abs: p.abs, raw: l.text, label, role, viewId: view?.id ?? null, page: l.page, at });
  }
  return out;
}

// ───────────────────────────── Synthèse ─────────────────────────────

/** Écart toléré entre « relatif + référence » et l'altitude écrite (m). */
const ABS_TOL = 0.011;
/** Deux cotes à moins de 6 mm l'une de l'autre sont le même niveau. */
const SAME_LEVEL = 0.006;
/** Le sommet est au moins à 1,5 m au-dessus du dernier niveau fini. */
const TOP_MIN_ABOVE = 1.5;

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

function cluster<T extends { rel: number | null }>(marks: readonly T[]): { rel: number; marks: T[] }[] {
  const groups: { rel: number; marks: T[] }[] = [];
  for (const m of marks) {
    if (m.rel === null) continue;
    const g = groups.find((x) => Math.abs(x.rel - m.rel!) < SAME_LEVEL);
    if (g) g.marks.push(m);
    else groups.push({ rel: m.rel, marks: [m] });
  }
  return groups.sort((a, b) => a.rel - b.rel);
}

function mostCommon(values: readonly (string | null)[]): string | null {
  const count = new Map<string, number>();
  for (const v of values) if (v) count.set(v, (count.get(v) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of count) if (c > n) [best, n] = [v, c];
  return best;
}

/** Doutes de la synthèse des niveaux (le contrat ReadLevels n'en porte pas : ils accompagnent le résultat). */
export interface LevelDoubt {
  topic: 'floor' | 'top' | 'floors-unlabelled';
  value: number | null;
  text: string;
}

/**
 * Synthèse des cotes de niveau :
 * - altitude du ±0,00 : médiane des cotes « ±0,00 = altitude », sinon l'écart altitude − relatif commun à au moins
 *   deux cotes ;
 * - contrôle de chaque cote « relatif + référence = altitude » (±11 mm) ;
 * - niveaux finis regroupés à 6 mm près ; confiance 0,5 + 0,15 par vue (3 au plus) + 0,1 si l'altitude concorde ;
 *   repli sans mention « niveau fini » : les cotes écrites dans les plans d'étage (confiance 0,5) ;
 * - sommet : cote « acrotère / faîtage », sinon la cote la plus répétée à plus de 1,5 m au-dessus du dernier niveau
 *   fini, hors gabarits réglementaires et terrain ; +0,15 si elle figure sur le plan de toiture.
 */
export function summarizeLevels(marks: readonly ReadLevelMark[], views: readonly ReadView[] = [], lang: Lang = 'fr'): { levels: ReadLevels; doubts: LevelDoubt[] } {
  const doubts: LevelDoubt[] = [];
  const zero = marks.filter((m) => m.rel === 0 && m.abs !== null);
  let referenceAbs: number | null = zero.length > 0 ? median(zero.map((m) => m.abs!)) : null;
  if (referenceAbs === null) {
    const offsets = cluster(marks.filter((m) => m.rel !== null && m.abs !== null).map((m) => ({ rel: Math.round((m.abs! - m.rel!) * 1000) / 1000 })));
    const best = offsets.sort((a, b) => b.marks.length - a.marks.length)[0];
    if (best && best.marks.length >= 2) referenceAbs = best.rel;
  }
  let checked = 0;
  let failed = 0;
  const absOk = (m: ReadLevelMark): boolean => referenceAbs !== null && m.rel !== null && m.abs !== null && Math.abs(m.rel + referenceAbs - m.abs) <= ABS_TOL;
  if (referenceAbs !== null) {
    for (const m of marks) {
      if (m.rel === null || m.abs === null) continue;
      checked++;
      if (!absOk(m)) failed++;
    }
  }
  const kindOf = new Map(views.map((v) => [v.id, v.kind]));

  // Niveaux finis.
  let ff = cluster(marks.filter((m) => m.role === 'finished-floor' && m.rel !== null));
  let unlabelled = false;
  if (ff.length === 0) {
    // Repli : cotes écrites dans les plans d'étage, sans mention.
    ff = cluster(marks.filter((m) => m.rel !== null && m.role === 'unknown' && m.viewId !== null && kindOf.get(m.viewId) === 'floor-plan'));
    unlabelled = ff.length > 0;
  }
  const floors = ff.map((g) => {
    const viewIds = [...new Set(g.marks.map((m) => m.viewId).filter((v): v is string => v !== null))];
    const ok = g.marks.some(absOk);
    let confidence = Math.min(0.97, 0.5 + 0.15 * Math.min(viewIds.length, 3) + (ok ? 0.1 : 0));
    if (unlabelled) confidence = Math.min(confidence, 0.5);
    // Une altitude écrite qui contredit « relatif + référence » : la contradiction est dite telle quelle.
    const bad = referenceAbs !== null ? g.marks.find((m) => m.rel !== null && m.abs !== null && !absOk(m)) : undefined;
    if (bad && referenceAbs !== null && !ok) {
      confidence = Math.min(confidence, 0.5);
      doubts.push({
        topic: 'floor',
        value: g.rel,
        text: t(lang, 'read.level.mismatch', { value: fmt(g.rel, 3), ref: fmt(referenceAbs, 2), expected: fmt(bad.rel! + referenceAbs, 2), abs: fmt(bad.abs!, 2) }),
      });
    } else if (!unlabelled && viewIds.length < 2 && !ok) {
      confidence = Math.min(confidence, 0.6);
      doubts.push({ topic: 'floor', value: g.rel, text: t(lang, 'read.level.single', { value: fmt(g.rel, 3) }) });
    }
    const abs = g.marks.find((m) => m.abs !== null)?.abs ?? null;
    return { rel: g.rel, abs, label: mostCommon(g.marks.map((m) => m.label)), viewIds, confidence: round2(confidence) };
  });
  if (unlabelled) doubts.push({ topic: 'floors-unlabelled', value: null, text: t(lang, 'read.level.unlabelled') });
  const storeyHeights = floors.slice(1).map((f, i) => Math.round((f.rel - floors[i]!.rel) * 1000) / 1000);

  // Sommet.
  const regulatory = marks.filter((m) => m.role === 'regulatory' && m.rel !== null).map((m) => m.rel!);
  const lastFloor = floors.length > 0 ? floors[floors.length - 1]!.rel : 0;
  const named = cluster(marks.filter((m) => (m.role === 'top' || m.role === 'ridge') && m.rel !== null));
  const candidates = named.length > 0
    ? named
    : cluster(marks.filter((m) => m.rel !== null && m.rel > lastFloor + TOP_MIN_ABOVE && m.role !== 'regulatory' && m.role !== 'terrain' && m.role !== 'eaves' && !regulatory.some((r) => Math.abs(r - m.rel!) < SAME_LEVEL)));
  let top: ReadLevels['top'] = null;
  if (candidates.length > 0) {
    // La plus répétée ; à égalité, la plus haute.
    const pick = [...candidates].sort((a, b) => b.marks.length - a.marks.length || b.rel - a.rel)[0]!;
    // Plusieurs sommets nommés (acrotère et faîtage) : le plus haut est le sommet du volume.
    const chosen = named.length > 0 ? [...named].sort((a, b) => b.rel - a.rel)[0]! : pick;
    const viewIds = new Set(chosen.marks.map((m) => m.viewId));
    const onRoof = chosen.marks.some((m) => m.viewId !== null && kindOf.get(m.viewId) === 'roof-plan');
    const confidence = Math.min(0.95, 0.4 + 0.1 * Math.min(viewIds.size, 4) + (onRoof ? 0.15 : 0) + (named.length > 0 ? 0.2 : 0));
    const role: 'top' | 'ridge' = chosen.marks.some((m) => m.role === 'ridge') ? 'ridge' : 'top';
    top = { rel: chosen.rel, role, confidence: round2(confidence) };
    if (confidence < 0.65) doubts.push({ topic: 'top', value: chosen.rel, text: t(lang, 'read.level.top', { value: fmt(chosen.rel, 2) }) });
  }
  const eavesGroups = cluster(marks.filter((m) => m.role === 'eaves'));
  const eaves = eavesGroups.length > 0 ? [...eavesGroups].sort((a, b) => b.marks.length - a.marks.length)[0]!.rel : null;

  return {
    levels: { referenceAbs, floors, storeyHeights, top, eaves, clearHeights: [], marks: [...marks], checks: { checked, failed } },
    doubts,
  };
}

// ───────────────────────────── Hauteurs libres ─────────────────────────────

const HSP_RE = /\b(?:hsp|h\.s\.p\.?|hauteur sous plafond|hauteur libre|h\s*=|lichte\s*(?:raum)?hohe|raumhohe|lh|lrh)\s*[:=]?\s*(\d[.,]\d{1,3})\s*m?\b/;

/** Hauteurs libres écrites (« HSP 2,50 », « lichte Raumhöhe 2,55 m », « h = 2,60 ») ; jamais un muret ou un maximum. */
export function clearHeights(lines: readonly SheetLine[]): number[] {
  const out: number[] = [];
  for (const l of lines) {
    const f = fold(l.text);
    if (/muret|cloture|pare-vue|mauer|zaun|\bmax\b|maxi|garde-corps|brustung|allege/.test(f)) continue;
    const m = HSP_RE.exec(f);
    if (!m) continue;
    const v = parseDecimal(m[1]!);
    if (v >= 1.8 && v <= 5) out.push(v);
  }
  return out;
}

/** Cotes, synthèse et hauteurs libres d'un ensemble de lignes (toutes pages). */
export function readLevels(lines: readonly SheetLine[], views: readonly ReadView[], lang: Lang = 'fr'): { levels: ReadLevels | null; doubts: LevelDoubt[] } {
  const marks = levelMarks(lines, views);
  const clear = clearHeights(lines);
  if (marks.length === 0 && clear.length === 0) return { levels: null, doubts: [] };
  const { levels, doubts } = summarizeLevels(marks, views, lang);
  levels.clearHeights = clear;
  return { levels, doubts };
}

// ───────────────────────────── Hauteur brute du volume chauffé ─────────────────────────────

/**
 * Hauteur brute du volume chauffé, de deux façons indépendantes :
 * - d'après les compositions : bas = niveau fini bas − couches comptées du plancher sur sol ; haut = dernier niveau
 *   fini + dernière hauteur d'étage − couches au-dessus de la structure du plancher intermédiaire + couches au-dessus
 *   de la structure de la toiture ;
 * - d'après le sommet : acrotère − niveau fini bas (toiture plate seulement ; un faîtage ne borne pas le volume).
 * Question si elles diffèrent de plus de 5 %.
 */
export function grossHeightEstimate(levels: ReadLevels | null, compositions: readonly ReadComposition[], lang: Lang = 'fr'): { fromLayers: number | null; fromTop: number | null; doubt: string | null } {
  const ff = levels?.floors.map((f) => f.rel) ?? [];
  if (!levels || ff.length === 0) return { fromLayers: null, fromTop: null, doubt: t(lang, 'read.level.noFloors') };
  const sum = (c: ReadComposition | undefined, keep: (i: number, structIdx: number) => boolean): number => {
    if (!c) return Number.NaN;
    const structIdx = c.layers.findIndex((l) => isStructureKey(l.material));
    return c.layers.reduce((acc, l, i) => (l.counted && keep(i, structIdx) ? acc + (l.thicknessCm ?? 0) : acc), 0) / 100;
  };
  const ground = compositions.find((c) => c.element === 'floor-on-ground');
  const mid = compositions.find((c) => c.element === 'intermediate-floor');
  const roof = compositions.find((c) => c.element === 'roof');
  const h = levels.storeyHeights.length > 0 ? levels.storeyHeights[levels.storeyHeights.length - 1]! : Number.NaN;
  const bottom = ff[0]! - sum(ground, () => true);
  // Toiture : couches de l'intérieur vers l'extérieur ; au-dessus de la structure = indices plus grands.
  const top = ff[ff.length - 1]! + h - sum(mid, (i, s) => i < s) + sum(roof, (i, s) => s >= 0 && i > s);
  const fromLayers = Number.isFinite(top - bottom) ? Math.round((top - bottom) * 100) / 100 : null;
  // Seul un acrotère (toiture plate) borne le volume chauffé ; un faîtage ne le fait pas.
  const fromTop = levels.top && levels.top.role === 'top' ? Math.round((levels.top.rel - ff[0]!) * 100) / 100 : null;
  const doubt = fromLayers !== null && fromTop !== null && Math.abs(fromLayers - fromTop) / fromTop > 0.05
    ? t(lang, 'read.level.grossHeight', { layers: fmt(fromLayers, 2), top: fmt(fromTop, 2) })
    : null;
  return { fromLayers, fromTop, doubt };
}

function fmt(v: number, digits: number): string {
  return v.toFixed(digits).replace('.', ',');
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
