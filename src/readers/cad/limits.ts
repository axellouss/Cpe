/**
 * Temps accordés à la lecture d'un DWG / DXF : larges, mais FINIS — aucun fichier ne doit bloquer la page.
 * Sans dépendance : partagé par le fil principal (chien de garde du worker) et par le décodeur.
 *
 * Repères mesurés (poste de développement) : un DWG réel de 2,6 Mo se décode en 1 s ; les fichiers de tiers
 * les plus lourds se lisent en 6 s analyse comprise ; un DXF synthétique de 50 Mo en 10 s. Les valeurs
 * ci-dessous laissent une marge d'un facteur 10 pour un poste lent.
 */

const MEGABYTE = 1_048_576;

/** Temps accordé au DÉCODAGE d'un DWG par acad-ts (garde-fou en place, voir guard.ts), en millisecondes. */
export function decodeBudgetMs(bytes: number): number {
  return Math.min(300_000, Math.round(20_000 + (4_000 * Math.max(0, bytes)) / MEGABYTE));
}

/**
 * Temps accordé à la lecture COMPLÈTE (décodage + analyse) dans le worker avant que le fil principal ne
 * l'arrête, en millisecondes. Toujours supérieur au temps de décodage : le garde-fou interne parle le premier.
 */
export function watchdogMs(bytes: number): number {
  return Math.min(600_000, Math.round(45_000 + (8_000 * Math.max(0, bytes)) / MEGABYTE));
}
