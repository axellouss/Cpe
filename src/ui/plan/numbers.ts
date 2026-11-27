/**
 * Saisie et affichage des nombres dans l'éditeur (logique pure).
 * La virgule décimale est acceptée partout (FR comme DE), le point aussi.
 */

/** « 12,50 », « 12.5 », « 1 250,5 » → nombre ; null si ce n'est pas un nombre. */
export function parseDecimal(text: string): number | null {
  const s = text.replace(/[\s']/g, '');
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(s)) return null;
  const v = Number(s.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

/**
 * Longueur réelle saisie pour « poser la règle » : mètres par défaut, « cm » et « mm » acceptés en suffixe.
 * « 13,50 », « 13.5 m », « 1350 cm », « 13500mm » → 13.5 ; null si illisible ou ≤ 0.
 */
export function parseLengthMetres(text: string): number | null {
  const m = /^\s*([\d\s'.,+-]+?)\s*(mm|cm|m)?\s*$/i.exec(text);
  if (!m) return null;
  const v = parseDecimal(m[1]!);
  if (v === null || !(v > 0)) return null;
  const unit = (m[2] ?? 'm').toLowerCase();
  return unit === 'mm' ? v / 1000 : unit === 'cm' ? v / 100 : v;
}

/**
 * Dimension d'une baie : mètres, mais les habitudes de chantier sont tolérées — une valeur ≥ 30 est prise pour
 * des centimètres, ≥ 300 pour des millimètres (« 120 » → 1,20 m ; « 1350 » → 1,35 m). null si illisible ou ≤ 0.
 */
export function parseOpeningDimension(text: string): number | null {
  const m = /^\s*([\d\s'.,+-]+?)\s*(mm|cm|m)?\s*$/i.exec(text);
  if (!m) return null;
  const v = parseDecimal(m[1]!);
  if (v === null || !(v > 0)) return null;
  const unit = m[2]?.toLowerCase();
  if (unit === 'mm') return v / 1000;
  if (unit === 'cm') return v / 100;
  if (unit === 'm') return v;
  if (v >= 300) return v / 1000;
  if (v >= 30) return v / 100;
  return v;
}

/** Nombre avec virgule décimale et un nombre fixe de décimales ; « – » si non fini. */
export function formatDecimal(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '–';
  return value.toFixed(digits).replace('.', ',');
}

/** Angle saisi au clavier (« 225 », « -45 », « 22,5° ») ramené dans [0, 360) ; null si illisible. */
export function parseAngle(text: string): number | null {
  const v = parseDecimal(text.replace(/°/g, ''));
  if (v === null) return null;
  const r = v % 360;
  return r < 0 ? r + 360 : r;
}
