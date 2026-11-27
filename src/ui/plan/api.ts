/**
 * Contrat de l'éditeur de plan (le « terrain de jeu ») entre src/ui/plan (qui l'implémente)
 * et src/ui/shell (qui l'héberge et pilote les étapes).
 */
import type { Construction, Lang, PlanSheet, Storey, WindowType } from '../../core/types';

/**
 * Outil actif. Le shell choisit l'outil selon l'étape ; l'éditeur gère toute l'interaction.
 *  - pan      : se déplacer / zoomer (toujours possible aussi à la molette, au pincement et avec Espace)
 *  - scale    : « poser la règle » — cliquer deux points puis saisir la longueur réelle → metresPerUnit
 *  - outline  : tracer / corriger le contour extérieur chauffé (accrochage aux traits du plan, angles droits)
 *  - boundary : toucher une façade pour dire ce qu'il y a derrière (extérieur → mitoyen chauffé → non chauffé → terre)
 *  - opening  : toucher une façade pour y poser une fenêtre ou une porte (largeur × hauteur, nombre)
 *  - north    : tourner la boussole
 *  - rooms    : toucher une pièce pour la compter ou non dans An
 */
export type PlanTool = 'pan' | 'scale' | 'outline' | 'boundary' | 'opening' | 'north' | 'rooms';

export interface PlanEditorProps {
  /** Fond de plan ; null = grille vierge où 1 unité = 1 m. */
  sheet: PlanSheet | null;
  /** Étage en cours d'édition (contour en unités de feuille). */
  storey: Storey;
  /** Autres étages tracés sur la même feuille, affichés en filigrane. */
  ghostStoreys?: Storey[];
  northAngle: number;
  tool: PlanTool;
  lang: Lang;
  constructions: Construction[];
  windowTypes: WindowType[];
  /** Mise à jour immuable de l'étage (contour, arêtes, ouvertures, pièces, échelle). */
  onStoreyChange(next: Storey): void;
  onNorthChange(angle: number): void;
  /** L'utilisateur a terminé l'action de l'outil (règle posée, contour fermé…) : le shell peut passer à la suite. */
  onToolDone?(tool: PlanTool): void;
  className?: string;
}
