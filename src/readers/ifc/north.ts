/**
 * Conversion du nord vrai de l'IFC vers la convention de l'application.
 *
 * IFC : `IfcGeometricRepresentationContext.TrueNorth` = direction du nord dans le plan du modèle
 *       (x à droite, y vers le HAUT). Valeur par défaut des exports : (0, 1), « le nord est +Y ».
 * Application : feuille en y vers le BAS avec x_feuille = x_IFC et y_feuille = −y_IFC ; le plan se regarde donc
 *       comme une vue de dessus ordinaire et le HAUT de la feuille est la direction +Y de l'IFC.
 *       `northAngle` = azimut (0 = nord, 90 = est, sens horaire) vers lequel pointe ce haut de feuille.
 *
 * Si le nord vrai est tourné de β dans le sens horaire par rapport à +Y (β = atan2(x, y)), alors +Y est à β dans
 * le sens anti-horaire du nord : son azimut vaut −β. Exemple : TrueNorth = (1, 0) (le nord est à droite du plan)
 * → le haut du plan regarde l'ouest → northAngle = 270.
 */
import { normDeg, radToDeg, round } from '../../core/geometry';

/** En dessous de cet écart à +Y (degrés), le nord est tenu pour la valeur par défaut de l'export. */
export const DEFAULT_NORTH_TOLERANCE_DEG = 0.05;

/** Angle horaire (degrés, dans ]−180, 180]) de +Y vers le nord vrai ; null si la direction est nulle. */
export function trueNorthBearing(x: number, y: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < 1e-9) return null;
  return radToDeg(Math.atan2(x, y));
}

/**
 * Azimut du haut de la feuille d'après TrueNorth, ou null si TrueNorth est absent, nul ou égal à la valeur par
 * défaut +Y (auquel cas le fichier ne dit rien de crédible et l'expert doit poser la boussole).
 */
export function northAngleFromTrueNorth(x: number, y: number): number | null {
  const bearing = trueNorthBearing(x, y);
  if (bearing === null || Math.abs(bearing) < DEFAULT_NORTH_TOLERANCE_DEG) return null;
  const angle = round(normDeg(-bearing), 2);
  return angle >= 360 ? 0 : angle;
}
