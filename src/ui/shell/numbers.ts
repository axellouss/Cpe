/**
 * Nombres saisis et affichés : virgule décimale en français comme en allemand (c'est aussi ce qu'attend
 * LuxEeB-Tool sous Excel). La saisie accepte le point et la virgule.
 */
import { formatNumber } from '../../i18n';

/** « 2,80 », « 2.8 », « 1 234,5 » → nombre ; null si le texte est vide ou n'est pas un nombre. */
export function parseNumber(text: string): number | null {
  const clean = text.replace(/[\s  ']/g, '').replace(',', '.');
  if (clean === '' || clean === '-' || clean === '.') return null;
  if (!/^-?\d*\.?\d*$/.test(clean)) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}

/** Nombre pour un champ de saisie : décimales utiles seulement (2,8 et non 2,800), virgule décimale. */
export function inputNumber(value: number | null | undefined, maxDigits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(Number(value.toFixed(maxDigits))).replace('.', ',');
}

/** Nombre affiché avec un nombre fixe de décimales. */
export function fixed(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '–';
  return formatNumber(value, digits);
}

/** Surface ou volume affiché : une décimale suffit à l'œil (les valeurs exactes sont dans le résultat). */
export function rounded(value: number | null | undefined, digits = 1): string {
  return fixed(value, digits);
}

/** Échelle « 1 unité = x m » lisible : 0,01 → « 1 cm », 0,001 → « 1 mm », 1 → « 1 m », sinon la valeur en mètres. */
export function unitLength(metresPerUnit: number): string {
  if (!(metresPerUnit > 0)) return '?';
  const near = (target: number): boolean => Math.abs(metresPerUnit - target) / target < 1e-6;
  if (near(1)) return '1 m';
  if (near(0.1)) return '10 cm';
  if (near(0.01)) return '1 cm';
  if (near(0.001)) return '1 mm';
  if (near(0.0254)) return '1 in';
  if (metresPerUnit >= 0.1) return `${String(Number(metresPerUnit.toPrecision(4))).replace('.', ',')} m`;
  if (metresPerUnit >= 0.001) return `${String(Number((metresPerUnit * 100).toPrecision(4))).replace('.', ',')} cm`;
  return `${String(Number((metresPerUnit * 1000).toPrecision(4))).replace('.', ',')} mm`;
}
