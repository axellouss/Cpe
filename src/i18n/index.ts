/**
 * Traductions FR / DE. Chaque module enregistre son dictionnaire avec `registerMessages`.
 * Les clés sont préfixées par module (« plan.tool.outline », « finding.an.estimated »…).
 * Variables : « {nom} » dans le texte, remplacées par `params`.
 */
import type { Lang } from '../core/types';

export type Messages = Record<string, string>;
export type Dictionary = Record<Lang, Messages>;

const registry: Dictionary = { fr: {}, de: {} };

export function registerMessages(dict: Dictionary): void {
  Object.assign(registry.fr, dict.fr);
  Object.assign(registry.de, dict.de);
}

/** Traduit une clé. Clé inconnue : repli sur le français, puis sur la clé elle-même (visible, donc repérable). */
export function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const template = registry[lang][key] ?? registry.fr[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

/** Nombre au format local : virgule décimale en FR comme en DE (c'est aussi ce qu'attend LuxEeB-Tool sous Excel). */
export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '–';
  return value.toFixed(digits).replace('.', ',');
}

/** Clés définies pour une langue (utile aux tests de complétude des dictionnaires). */
export function knownKeys(lang: Lang): string[] {
  return Object.keys(registry[lang]);
}
