/**
 * Provenance : « la plus faible l'emporte ».
 * Ordre du plus faible au plus fort : estimate < default < plan < calc < user.
 */
import type { Provenance } from '../core/types';

const RANK: Record<Provenance, number> = { estimate: 0, default: 1, plan: 2, calc: 3, user: 4 };

/** Provenance la plus faible d'une liste ; liste vide → 'calc' (aucune donnée d'entrée douteuse). */
export function weakest(...sources: readonly Provenance[]): Provenance {
  let best: Provenance | null = null;
  for (const s of sources) {
    if (best === null || RANK[s] < RANK[best]) best = s;
  }
  return best ?? 'calc';
}

/** Vrai si la valeur n'a été ni lue sur le plan ni confirmée : à confirmer ou à remplacer par l'expert. */
export function isUnconfirmed(p: Provenance): boolean {
  return p === 'default' || p === 'estimate';
}
