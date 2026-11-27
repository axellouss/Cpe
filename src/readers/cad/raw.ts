/**
 * Formes neutres d'un dessin DWG / DXF « mis à plat » (segments, arcs, textes, insertions de blocs) et erreur de
 * lecture. Ce fichier ne dépend d'AUCUNE bibliothèque : il est partagé par le décodeur (load.ts), l'analyse et
 * l'aiguillage du fil principal, qui ne doit pas embarquer le décodeur.
 *
 * Repère d'ANALYSE : repère CAO (y vers le HAUT) décalé de `origin` pour garder de petits nombres
 * (les plans géoréférencés ont des coordonnées de plusieurs millions d'unités).
 */
import type { Vec2 } from '../../core/types';

/** Nature d'un segment (sert à alléger l'affichage et à choisir les traits de murs). */
export const SEG_LINE = 0;
export const SEG_POLY = 1;
export const SEG_CURVE = 2;
export const SEG_HATCH = 3;
export const SEG_DIM = 4;
export const SEG_FILL = 5;

export interface RawTextLine {
  text: string;
  /** Départ de la ligne de base (repère d'analyse). */
  x: number;
  y: number;
}

export interface RawText {
  /** Texte décodé ; les lignes d'un MTEXT sont séparées par « \n ». */
  text: string;
  /** Centre approximatif du texte. */
  cx: number;
  cy: number;
  height: number;
  layer: number;
  /** Insertion de bloc d'où vient le texte (−1 = directement dans l'espace objet). */
  insert: number;
  /** Texte de cote (valeur mesurée) : ignoré pour les noms de pièces. */
  dim: boolean;
  /** Attribut de bloc invisible : conservé pour les dimensions d'ouvertures, jamais affiché. */
  hidden: boolean;
  lines: RawTextLine[];
}

export interface RawArc {
  cx: number;
  cy: number;
  radius: number;
  /** Angle balayé en degrés (0..360). */
  sweep: number;
  layer: number;
  insert: number;
}

export interface RawInsert {
  name: string;
  layer: number;
  /** Insertion parente (−1 = espace objet). */
  parent: number;
  depth: number;
  /** Point d'insertion (repère d'analyse). */
  x: number;
  y: number;
  /** Direction de l'axe +Y du bloc dans le dessin (vecteur unitaire) : sert à lire une flèche du nord. */
  upX: number;
  upY: number;
  attribs: Record<string, string>;
  /** Segments et arcs produits par ce bloc et ses sous-blocs : intervalles [start, end). */
  segStart: number;
  segEnd: number;
  arcStart: number;
  arcEnd: number;
}

export interface RawDrawing {
  version: string;
  /** $INSUNITS de l'en-tête (0 = sans unité). */
  insUnits: number;
  layers: string[];
  segCount: number;
  /** [x1, y1, x2, y2, …] */
  segXY: Float64Array;
  segLayer: Int32Array;
  segKind: Uint8Array;
  /** Insertion de bloc la plus profonde d'où vient le segment (−1 = espace objet). */
  segInsert: Int32Array;
  arcs: RawArc[];
  texts: RawText[];
  inserts: RawInsert[];
  /** Décalage retiré des coordonnées CAO. */
  origin: Vec2;
  stats: {
    entities: number;
    hiddenLayerEntities: number;
    unsupported: Record<string, number>;
    truncated: boolean;
    missingXrefs: string[];
    readerNotes: number;
    /**
     * Objets d'un DWG que le décodeur n'a pas su lire et a laissés de côté (type d'objet qu'il ne connaît pas,
     * ou données abîmées) : ils manquent dans le dessin. 0 pour un DXF.
     */
    skippedObjects: number;
    /**
     * Parmi eux, ceux dont le décodage a débordé de son flux d'octets : le fichier est ABÎMÉ (un fichier sain
     * n'en a aucun) et le dessin rendu est incomplet. 0 pour un DXF.
     */
    damagedObjects: number;
    /**
     * Traits, arcs et textes retirés car situés à plus de 10⁹ unités de l'origine du dessin (coordonnées
     * aberrantes, signe d'un fichier abîmé ; voir load.ts).
     */
    farEntities: number;
  };
}

export class CadReadError extends Error {
  constructor(
    message: string,
    public readonly reason: 'empty' | 'unreadable',
  ) {
    super(message);
    this.name = 'CadReadError';
  }
}
