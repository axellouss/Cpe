/**
 * Mise en forme commune à tout l'export : nombres au format LuxEeB (virgule décimale), orientations,
 * textes sûrs pour Excel et pour le HTML, étiquettes de provenance. Fonctions pures.
 */
import { azimuthOfSector } from '../core/geometry';
import type { Lang, OrientationOrHorizontal, Provenance } from '../core/types';
import { t } from '../i18n';
import { LUXEEB_ORIENTATION } from './luxeeb-terms';
import './messages';

// ───────────────────────────── Nombres ─────────────────────────────

/** Arrondi décimal « au plus proche, demi vers l'extérieur » : 1,005 → 1,01 (et non 1,00 comme toFixed). */
function roundDecimal(value: number, digits: number): number {
  const abs = Math.abs(value);
  const k = 10 ** digits;
  // Passage par l'écriture décimale courte pour gommer le bruit binaire (1.005 vaut en réalité 1.00499999…).
  const text = abs.toPrecision(15);
  const scaled = text.includes('e') ? abs * k : Number(`${text}e${digits}`);
  const rounded = Math.round(scaled) / k;
  return value < 0 ? -rounded : rounded;
}

/**
 * Une valeur seule au format LuxEeB : virgule décimale, nombre fixe de décimales (2 par défaut),
 * pas de séparateur de milliers, pas d'unité. Valeur non finie → chaîne vide (rien à coller).
 */
export function luxeebNumber(value: number, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const d = Number.isInteger(digits) ? Math.min(Math.max(digits, 0), 6) : 2;
  const text = roundDecimal(value, d).toFixed(d);
  // « -0,00 » n'a aucun sens dans une cellule.
  return (Number(text) === 0 ? text.replace('-', '') : text).replace('.', ',');
}

/** Valeur U : 2 décimales, 3 si la valeur en porte une troisième (0,206 reste 0,206). */
export function luxeebUValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  const hasThird = Math.abs(roundDecimal(value, 3) - roundDecimal(value, 2)) > 1e-9;
  return luxeebNumber(value, hasThird ? 3 : 2);
}

/** Nombre « tel quel » avec virgule décimale et au plus `significant` chiffres significatifs (échelles, angles). */
export function compactNumber(value: number, significant = 4): string {
  if (!Number.isFinite(value)) return '';
  return String(Number(value.toPrecision(significant))).replace('.', ',');
}

// ───────────────────────────── Orientations ─────────────────────────────

/** Libellé d'orientation tel qu'il apparaît dans la liste « Orientierung » de LuxEeB-Tool (allemand). */
export function luxeebOrientation(o: OrientationOrHorizontal): string {
  return LUXEEB_ORIENTATION[o] ?? '';
}

/** Libellé d'orientation pour l'utilisateur, avec l'azimut : « Est (90°) » en français, « Ost (90°) » en allemand. */
export function orientationLabel(o: OrientationOrHorizontal, lang: Lang): string {
  const name = t(lang, `export.orient.${o}`);
  return o === 'H' ? name : `${name} (${azimuthOfSector(o)}°)`;
}

// ───────────────────────────── Textes ─────────────────────────────

/** Texte sur une ligne : caractères de contrôle (tabulation, saut de ligne…) remplacés par une espace. */
export function cleanText(text: string): string {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Texte destiné à une cellule Excel (collage ou CSV). Un texte venu d'un plan n'est pas digne de confiance :
 * s'il commence par « = », « + », « - » ou « @ », Excel l'exécuterait comme une formule. On le fait précéder
 * d'une apostrophe, que Excel traite comme la marque « ceci est du texte ».
 */
export function excelSafeText(text: string): string {
  // Un guillemet double en tête ferait lire la suite comme un champ entre guillemets (tabulations et sauts de
  // ligne compris) lors d'un collage : on l'écarte.
  const clean = cleanText(text).replace(/^"+/, '');
  return /^[=+\-@＝＋－＠]/.test(clean) ? `'${clean}` : clean;
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Échappe un texte pour le placer dans du HTML (contenu ou attribut entre guillemets). */
export function escapeHtml(text: string): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

/** « Terme allemand de l'outil — traduction ». La traduction est omise si elle est vide ou identique. */
export function termLabel(lang: Lang, term: string, translationKey: string, unit?: string): string {
  const head = unit ? `${term} [${unit}]` : term;
  const translation = t(lang, translationKey);
  return translation && translation !== translationKey && translation !== term ? `${head} — ${translation}` : head;
}

// ───────────────────────────── Provenance ─────────────────────────────

/** Du plus faible au plus fort — même ordre que le moteur : une valeur calculée vaut ce que valent ses entrées. */
const PROVENANCE_RANK: Record<Provenance, number> = { estimate: 0, default: 1, plan: 2, calc: 3, user: 4 };

export const PROVENANCES: readonly Provenance[] = ['plan', 'calc', 'default', 'estimate', 'user'];

/** Vrai si la valeur est bien l'une des cinq provenances du contrat (les données viennent parfois de loin). */
/**
 * Remarque d'une surface de pièce. Le moteur note « écrite / mesurée » (« 74,51 / 94,05 ») quand la surface écrite
 * sur le plan contredit la mesure et que la mesure est retenue : dit en toutes lettres pour le relevé et le dossier.
 * Toute autre remarque est rendue telle quelle.
 */
export function roomAreaNote(note: string | undefined, lang: Lang): string {
  if (!note) return '';
  const m = /^(\d+(?:[.,]\d+)?) \/ (\d+(?:[.,]\d+)?)$/.exec(note.trim());
  if (!m) return note;
  return t(lang, 'export.note.roomAreaMeasured', { stated: m[1]!.replace('.', ','), measured: m[2]!.replace('.', ',') });
}

export function isProvenance(value: unknown): value is Provenance {
  return typeof value === 'string' && (PROVENANCES as readonly string[]).includes(value);
}

/** Provenance la plus faible d'une liste (les valeurs absentes sont ignorées) ; liste vide → 'calc'. */
export function weakestProvenance(sources: readonly (Provenance | null | undefined)[]): Provenance {
  let weakest: Provenance | null = null;
  for (const s of sources) {
    if (!isProvenance(s)) continue;
    if (weakest === null || PROVENANCE_RANK[s] < PROVENANCE_RANK[weakest]) weakest = s;
  }
  return weakest ?? 'calc';
}

/** Explication complète d'une provenance (« valeur par défaut — à confirmer »). null = valeur absente. */
export function provenanceLabel(from: Provenance | null, lang: Lang): string {
  return t(lang, from ? `export.prov.${from}` : 'export.prov.none');
}

/** Étiquette courte d'une provenance (« défaut »). null = valeur absente. */
export function provenanceTag(from: Provenance | null, lang: Lang): string {
  return t(lang, from ? `export.prov.short.${from}` : 'export.prov.short.none');
}
