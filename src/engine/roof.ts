/**
 * Toiture inclinée au-dessus de combles CHAUFFÉS : pans, hauteurs équivalentes des murs, volume.
 *
 * Modèle simple, sur l'étendue du contour mesurée le long du faîtage (L) et en travers (W = portée) :
 *   - hauteur de faîtage au-dessus de la jambette : W/2 × tan(pente) (deux pans, croupes), W × tan(pente) (monopente) ;
 *   - surface totale des pans = surface du contour / cos(pente), exacte tant que tous les pans ont la même pente ;
 *   - murs d'égout (parallèles au faîtage) : hauteur de la jambette ; pignons : jambette + hauteur de faîtage / 2.
 * Lucarnes, débords, toitures à la Mansart : non couverts → l'expert complète par des lignes manuelles.
 */
import { azimuthOfVector, degToRad, extentAlong, longestEdgeAngle, normDeg, polygonArea, radToDeg, sectorOfAzimuth } from '../core/geometry';
import type { Orientation, RoofShape, TopClosure, Vec2 } from '../core/types';

/** Pente utilisée dans les calculs, bornée pour éviter cos(pente) → 0. */
const MAX_PITCH_DEG = 85;

export interface RoofSlope {
  /** Azimut vers lequel le pan descend (direction de sa normale projetée). */
  azimuth: number;
  orientation: Orientation;
  /** Surface réelle du pan (m²). */
  area: number;
  /** Longueur de la ligne d'égout (m) : sert de « longueur » dans le tableau, largeur = surface / longueur. */
  length: number;
}

export interface PitchedRoof {
  shape: RoofShape;
  /** Pente retenue (degrés). */
  pitchDeg: number;
  /** Direction du faîtage (degrés depuis +x, repère de la feuille). */
  ridgeAngle: number;
  /** Étendue du contour le long du faîtage, L (m). */
  ridgeLength: number;
  /** Étendue en travers du faîtage, W (m). */
  span: number;
  /** Hauteur du faîtage au-dessus de la tête de jambette (m). */
  rise: number;
  kneeWallHeight: number;
  /** Hauteur des murs d'égout (m). */
  eavesHeight: number;
  /** Hauteur équivalente des murs pignons (m). */
  gableHeight: number;
  /** Vrai si la hauteur des murs d'égout n'est qu'une moyenne (monopente : mur bas et mur haut confondus). */
  eavesEstimated: boolean;
  /** Vrai si le contour s'écarte de plus de 2 % du rectangle L × W. */
  nonRectangular: boolean;
  slopes: RoofSlope[];
  /** Surface totale des pans (m²). */
  totalArea: number;
  /** Volume brut de l'étage sous toiture (m³), jambette comprise. */
  volume: number;
}

/** Écart angulaire (0..90°) entre deux directions non orientées. */
function lineAngleBetween(a: number, b: number): number {
  const d = normDeg(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

/** Vrai si l'arête i longe le faîtage (à 45° près) : c'est un mur d'égout ; sinon un pignon. */
export function isEavesEdge(poly: readonly Vec2[], i: number, ridgeAngle: number): boolean {
  const a = poly[i]!;
  const b = poly[(i + 1) % poly.length]!;
  const edgeAngle = radToDeg(Math.atan2(b.y - a.y, b.x - a.x));
  return lineAngleBetween(edgeAngle, ridgeAngle) <= 45 + 1e-9;
}

/**
 * Calcule la toiture inclinée posée sur le contour `poly` (en MÈTRES, repère de la feuille).
 * `northAngle` = azimut du haut de la feuille.
 */
export function computePitchedRoof(poly: readonly Vec2[], top: TopClosure, northAngle: number): PitchedRoof {
  const area = polygonArea(poly);
  const pitchDeg = Math.min(MAX_PITCH_DEG, Math.max(0, top.pitchDeg));
  const pitch = degToRad(pitchDeg);
  const cos = Math.cos(pitch);
  const tan = Math.tan(pitch);
  const knee = Math.max(0, top.kneeWallHeight);

  let ridgeAngle = top.ridgeAngle ?? longestEdgeAngle(poly);
  let extent = extentAlong(poly, ridgeAngle);
  // Toit à croupes : le faîtage suit toujours la grande dimension (sinon il n'existerait pas).
  if (top.shape === 'hip' && extent.along < extent.across) {
    ridgeAngle += 90;
    extent = { along: extent.across, across: extent.along };
  }
  const L = extent.along;
  const W = extent.across;
  const rise = top.shape === 'mono' ? W * tan : (W / 2) * tan;
  const totalArea = cos > 0 ? area / cos : 0;
  const rectArea = L * W;
  const nonRectangular = rectArea > 0 && Math.abs(area - rectArea) > 0.02 * rectArea;

  // Dans le repère de la feuille : u le long du faîtage, v en travers.
  const ridge = degToRad(ridgeAngle);
  const u: Vec2 = { x: Math.cos(ridge), y: Math.sin(ridge) };
  const v: Vec2 = { x: -u.y, y: u.x };
  const slope = (dir: Vec2, slopeArea: number, length: number): RoofSlope => {
    const azimuth = azimuthOfVector(dir, northAngle);
    return { azimuth, orientation: sectorOfAzimuth(azimuth), area: slopeArea, length };
  };
  const neg = (p: Vec2): Vec2 => ({ x: -p.x, y: -p.y });

  let slopes: RoofSlope[];
  let roofVolume: number;
  if (top.shape === 'gable') {
    slopes = [slope(v, totalArea / 2, L), slope(neg(v), totalArea / 2, L)];
    roofVolume = (area * rise) / 2;
  } else if (top.shape === 'mono') {
    // Sens de la pente inconnu : par convention le pan regarde vers +v (tourner le faîtage de 180° l'inverse).
    slopes = [slope(v, totalArea, L)];
    roofVolume = (area * rise) / 2;
  } else {
    // Croupes sur un rectangle L × W : deux triangles d'about (W²/4 chacun en plan), deux trapèzes pour le reste.
    const k = rectArea > 0 ? area / rectArea : 0; // contour non rectangulaire : on conserve le total
    const endArea = cos > 0 ? ((W * W) / 4 / cos) * k : 0;
    const sideArea = cos > 0 ? ((L * W - (W * W) / 2) / 2 / cos) * k : 0;
    slopes = [slope(v, sideArea, L), slope(neg(v), sideArea, L), slope(u, endArea, W), slope(neg(u), endArea, W)];
    roofVolume = Math.max(0, rise * (area / 2 - (W * W) / 6));
  }

  return {
    shape: top.shape,
    pitchDeg,
    ridgeAngle,
    ridgeLength: L,
    span: W,
    rise,
    kneeWallHeight: knee,
    eavesHeight: top.shape === 'mono' ? knee + rise / 2 : knee,
    gableHeight: top.shape === 'hip' ? knee : knee + rise / 2,
    eavesEstimated: top.shape === 'mono',
    nonRectangular,
    slopes: slopes.filter((s) => s.area > 0 && s.length > 0),
    totalArea,
    volume: area * knee + roofVolume,
  };
}
