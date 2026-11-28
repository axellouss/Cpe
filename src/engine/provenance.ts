/**
 * Provenance : « la plus faible l'emporte ».
 * Ordre du plus faible au plus fort : estimate < default < plan < calc < user.
 */
import type { Opening, Provenance } from '../core/types';

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

/**
 * Baie du modèle avec la provenance de sa HAUTEUR, distincte de `from` (provenance la plus faible de la baie, souvent
 * celle de la largeur) : une hauteur saisie par l'utilisateur ne fait pas passer une largeur supposée pour confirmée.
 * Hauteurs lues sur le plan et sur la façade, gardées quand le lecteur donne les deux (question de convention).
 * Champs du moteur, absents du contrat `Opening` (core/types) : facultatifs, gardés par le fichier de projet.
 */
export type OpeningHeights = Opening & { heightFrom?: Provenance; heightPlan?: number; heightElevation?: number };

/** Provenance de la hauteur d'une baie ; projets anciens : déduite de `from` ('default' = hauteur d'usage). */
export function heightFromOf(o: Opening): Provenance {
  const h = (o as OpeningHeights).heightFrom;
  if (h) return h;
  return o.from === 'default' ? 'default' : o.from === 'estimate' ? 'estimate' : o.from;
}
