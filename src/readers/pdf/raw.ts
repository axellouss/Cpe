/**
 * Représentation intermédiaire d'une page PDF, indépendante de pdf.js : c'est tout ce que l'analyse connaît.
 *
 * Repère : celui de la feuille (points PDF, origine en haut à gauche de la page AFFICHÉE, y vers le bas).
 * La page est déjà redressée : si le texte dominant était couché (/Rotate du traceur, dessin tourné),
 * l'extraction a choisi la vue où il se lit de gauche à droite.
 */

export interface RawText {
  /** Texte, sans blancs autour. */
  s: string;
  /** Boîte englobante (uf). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Centre de la boîte (uf). */
  cx: number;
  cy: number;
  /** Début de la ligne de base (uf). */
  bx: number;
  by: number;
  /** Sens de lecture à l'écran, en degrés, sens trigonométrique : 0 = vers la droite, 90 = vers le haut. */
  angle: number;
  /** Corps du texte (uf). */
  size: number;
}

export interface RawSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Épaisseur réelle du trait (pt) ; 0 pour un simple remplissage. */
  w: number;
  /** Morceau d'une courbe discrétisée. */
  curve: boolean;
  stroke: boolean;
  fill: boolean;
  dash: boolean;
  /** Numéro du tracé (« path ») d'origine. */
  pid: number;
}

export interface RawPage {
  /** Numéro de page, à partir de 1. */
  number: number;
  width: number;
  height: number;
  /** Rotation de vue utilisée (degrés, sens horaire, multiple de 90) : à redonner au rendu de l'image. */
  rotation: number;
  /** Quarts de tour ajoutés à la rotation du fichier pour redresser le texte (0, 90, 180 ou 270). */
  turned: number;
  texts: RawText[];
  segs: RawSeg[];
  /** Nombre d'images matricielles peintes sur la page. */
  images: number;
  /** Part de la page couverte par la plus grande image (0..1). */
  imageCoverage: number;
  /** Résolution de la plus grande image, en pixels par point de page (0 si aucune). */
  imagePixelsPerPoint: number;
  /** Vrai si la page dépassait la limite de traits et a été lue en partie. */
  truncated: boolean;
}

/** Mètres de papier par point PDF (1 pt = 1/72 pouce). */
export const METRES_PER_POINT = 0.0254 / 72;
