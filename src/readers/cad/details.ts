/**
 * Options et compte rendu d'une lecture DWG / DXF (types seuls : partagés par le fil principal et le worker).
 */
import type { Lang, PlanDocument } from '../../core/types';
import type { UnitEvidence } from './units';

export interface CadReadOptions {
  /** Langue des noms de feuilles, notes et avertissements (défaut : français). */
  lang?: Lang;
  /**
   * Temps accordé au décodage d'un DWG, en millisecondes (défaut : selon la taille du fichier, voir limits.ts).
   * Passé ce délai, la lecture échoue avec le message « fichier illisible ou abîmé ».
   */
  decodeBudgetMs?: number;
}

/** Détails de lecture utiles aux tests et au diagnostic (hors contrat PlanDocument). */
export interface CadReadDetails {
  /** Unités de dessin par mètre utilisées pour l'analyse (null = inconnue). */
  unitsPerMetre: number | null;
  unitEvidence: UnitEvidence[];
  wallLayers: string[];
  wallSource: 'name' | 'geometry' | 'none';
  /** Par feuille : x_feuille = x_CAO − x0 ; y_feuille = y0 − y_CAO. */
  sheetOrigins: { x0: number; y0: number }[];
  version: string;
  entities: number;
  segments: number;
  /** Durées en millisecondes. */
  timing: { read: number; analyse: number; total: number };
}

/** Résultat d'une lecture : le document et ses détails. */
export interface CadRead {
  doc: PlanDocument;
  details: CadReadDetails;
}
