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
  /** Zone de découpe active quand le trait a été peint (indice dans RawPage.clips ; 0 = page entière). */
  clip?: number;
  /** Couleur du trait, 0xRRGGBB. */
  color?: number;
}

/** Boîte englobante en unités de feuille. */
export interface RawBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Zone de découpe (« clip ») rencontrée sur la page. */
export interface ClipZone {
  id: number;
  /** Zone englobante (−1 pour la page). */
  parent: number;
  bbox: RawBox;
  /** Vrai si la zone est un simple rectangle (cadre de vue). */
  rect: boolean;
  /** Nombre de tracés peints sous cette zone. */
  ops: number;
}

/** Remplissage : anneaux du polygone, couleur. Les murs pochés, les zones de pièces, la toiture en sont. */
export interface FillArea {
  rings: [number, number][][];
  bbox: RawBox;
  /** 0xRRGGBB. */
  color: number;
  alpha: number;
  clip: number;
  /** Vrai si le contour est aussi tracé. */
  stroked: boolean;
  /** Aire de l'anneau extérieur (uf²). */
  area: number;
}

/** Hachure : des traits parallèles réguliers remplissant une zone ; les traits eux-mêmes sont retirés de `segs`. */
export interface HatchZone {
  clip: number;
  bbox: RawBox;
  /** Contour de la zone hachurée. */
  rings: [number, number][][];
  /** Directions des traits, 0..180° ; une seule = hachure simple, deux = hachure croisée. */
  angles: number[];
  /** Écart moyen entre deux traits (uf). */
  spacing: number;
  color: number;
  width: number;
  /** Nombre de traits regroupés. */
  count: number;
  source: 'clip' | 'path';
}

/** Trame de micro-traits (pointillé de terrain d'une coupe) : retirée de `segs`, seule son emprise est gardée. */
export interface StippleZone {
  clip: number;
  bbox: RawBox;
  count: number;
  color: number;
}

export interface ImageArea {
  bbox: RawBox;
  pixelsPerPoint: number;
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
  /** Remplissages (polygones colorés). */
  fills: FillArea[];
  /** Zones hachurées (traits parallèles regroupés). */
  hatches: HatchZone[];
  /** Trames de micro-traits retirées. */
  stipples: StippleZone[];
  /** Zones de découpe utilisées. */
  clips: ClipZone[];
  /** Emprise de chaque image matricielle. */
  imageAreas: ImageArea[];
  /** Bilan de l'allègement : traits rencontrés, et retirés comme trame ou regroupés en hachure. */
  lightening: { rawStrokeSegs: number; stippleSegs: number; hatchSegs: number };
}

/** Mètres de papier par point PDF (1 pt = 1/72 pouce). */
export const METRES_PER_POINT = 0.0254 / 72;
