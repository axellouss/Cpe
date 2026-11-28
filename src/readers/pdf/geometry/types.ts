/**
 * Géométrie d'une planche — types internes du module (le contrat avec le reste de l'application est
 * SheetDetection dans core/types.ts et ReadRoof / ReadElevation dans core/reading.ts).
 *
 * Repère : celui de la page (points PDF, y vers le bas). `mpp` = mètres réels par point de la page.
 */
import type { DetectedRoom, Lang } from '../../../core/types';
import type { ReadGlazingBox, ReadOpeningPair } from '../../../core/reading';
import type { Poly } from '../planar';
import type { RawBox, RawSeg, RawText } from '../raw';

export type { Poly } from '../planar';

/** Remplissage d'une vue, déjà découpé en polygones (règle pair-impair). */
export interface FillShape {
  polys: Poly[];
  bbox: RawBox;
  color: number;
  alpha: number;
  stroked: boolean;
}

/** Zone hachurée d'une vue. */
export interface HatchShape {
  polys: Poly[];
  bbox: RawBox;
  angles: number[];
  color: number;
  spacing: number;
}

/** Tout ce que la géométrie connaît d'une vue : les éléments VISIBLES dont le centre tombe dans sa boîte. */
export interface ViewInput {
  page: number;
  viewId: string;
  box: RawBox;
  fills: FillShape[];
  hatches: HatchShape[];
  segs: RawSeg[];
  texts: RawText[];
}

/** Contexte d'une lecture de plan d'étage. */
export interface FloorPlanContext {
  /** Échelle annoncée (cartouche, intitulé), en mètres par point ; null si inconnue. */
  declaredMpp?: number | null;
  /** Cotes de baies « largeur / hauteur » lues dans le texte (autre lot). */
  openingPairs?: readonly ReadOpeningPair[];
  /** Pièces lues dans le texte (nom, surface, position), si un autre lecteur les a déjà trouvées. */
  rooms?: readonly DetectedRoom[];
  /** Encadrés d'éclairement naturel (surface vitrée par pièce). */
  glazing?: readonly ReadGlazingBox[];
  lang?: Lang;
}

/** Une valeur mesurée, sa confiance (0..1, même lecture que core/reading.ts) et ses signaux. */
export interface Measured<T> {
  value: T;
  confidence: number;
  sources: string[];
  doubt?: string | null;
}
