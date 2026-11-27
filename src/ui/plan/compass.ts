/**
 * Boussole et orientation des façades (logique pure).
 *
 * `northAngle` = azimut vers lequel pointe le HAUT de la feuille (0 = le nord est en haut, 90 = le haut regarde l'est).
 * À l'écran, l'aiguille du nord est donc tournée de −northAngle par rapport à la verticale (sens horaire positif).
 */
import { edgeAzimuth, marginToSectorBoundary, normDeg as coreNormDeg, sectorOfAzimuth } from '../../core/geometry';
import type { Orientation, Vec2 } from '../../core/types';

/** Angle dans [0, 360), sans « −0 » (qui s'afficherait bien mais surprendrait une comparaison stricte). */
function normDeg(a: number): number {
  return coreNormDeg(a) + 0;
}

/** Angle à l'écran (degrés, sens horaire depuis le haut) de l'aiguille du nord. */
export function needleScreenAngle(northAngle: number): number {
  return normDeg(-northAngle);
}

/** northAngle correspondant à une aiguille pointée du centre de la rose vers le pointeur. */
export function northFromPointer(centre: Vec2, pointer: Vec2): number | null {
  const dx = pointer.x - centre.x;
  const dy = pointer.y - centre.y;
  if (Math.hypot(dx, dy) < 4) return null; // trop près du centre : direction indéfinie
  const screenAngle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return normDeg(-screenAngle);
}

/**
 * Arrondit au degré et « aimante » les multiples de 45° (à ±magnetDeg près) : la plupart des plans sont dessinés
 * avec le nord sur un axe ou une diagonale.
 */
export function settleAngle(angle: number, magnetDeg = 3): number {
  const a = normDeg(angle);
  const nearest45 = Math.round(a / 45) * 45;
  if (Math.abs(a - nearest45) <= magnetDeg) return normDeg(nearest45);
  return normDeg(Math.round(a));
}

/** Tourne l'AIGUILLE de `delta` degrés dans le sens horaire (delta < 0 : sens inverse). */
export function rotateNeedle(northAngle: number, delta: number): number {
  return normDeg(Math.round((northAngle - delta) * 10) / 10);
}

export interface FacadeOrientation {
  sector: Orientation;
  /** Azimut de la normale extérieure, arrondi au degré, dans [0, 360). */
  azimuth: number;
  /** Vrai si l'azimut est à moins de 5° d'une limite de secteur : orientation « à cheval ». */
  borderline: boolean;
}

export function facadeOrientation(outline: readonly Vec2[], edgeIndex: number, northAngle: number): FacadeOrientation {
  const azimuth = edgeAzimuth(outline, edgeIndex, northAngle);
  const rounded = normDeg(Math.round(azimuth));
  return { sector: sectorOfAzimuth(azimuth), azimuth: rounded, borderline: marginToSectorBoundary(azimuth) < 5 };
}

/** Secteur vers lequel regarde le haut de la feuille. */
export function topSector(northAngle: number): Orientation {
  return sectorOfAzimuth(normDeg(northAngle));
}
