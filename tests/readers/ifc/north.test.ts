import { describe, expect, it } from 'vitest';
import { azimuthOfVector } from '../../../src/core/geometry';
import { northAngleFromTrueNorth, trueNorthBearing } from '../../../src/readers/ifc/north';

/** Vecteur IFC (y vers le haut) → vecteur de feuille (y vers le bas), comme le fait le lecteur. */
const toSheet = (x: number, y: number) => ({ x, y: -y });

describe('nord IFC → azimut du haut de la feuille', () => {
  it('ne propose rien pour le nord par défaut (+Y), absent ou nul', () => {
    expect(northAngleFromTrueNorth(0, 1)).toBeNull();
    expect(northAngleFromTrueNorth(6.1e-17, 1)).toBeNull(); // (0, 1) écrit par Revit
    expect(northAngleFromTrueNorth(0, 0)).toBeNull();
    expect(northAngleFromTrueNorth(Number.NaN, 1)).toBeNull();
  });

  it('cas synthétique : nord vrai vers +X → le haut de la feuille regarde l’ouest', () => {
    // Le nord est à droite du plan ; le haut du plan (+Y IFC) est donc à 90° dans le sens anti-horaire du nord : l'ouest.
    expect(trueNorthBearing(1, 0)).toBeCloseTo(90, 9);
    expect(northAngleFromTrueNorth(1, 0)).toBe(270);
    // Nord vers −X → le haut regarde l'est ; nord vers −Y → le haut regarde le sud.
    expect(northAngleFromTrueNorth(-1, 0)).toBe(90);
    expect(northAngleFromTrueNorth(0, -1)).toBe(180);
  });

  it('nord tourné de 50° dans le sens horaire (AC20-FZK-Haus) → 310°', () => {
    expect(northAngleFromTrueNorth(Math.sin((50 * Math.PI) / 180), Math.cos((50 * Math.PI) / 180))).toBeCloseTo(310, 6);
    // Une direction non normée donne le même angle.
    expect(northAngleFromTrueNorth(0.766 * 7, 0.643 * 7)).toBeCloseTo(310, 0);
  });

  it('avec cet angle, la direction du nord vrai reportée sur la feuille a bien l’azimut 0', () => {
    for (const deg of [-170, -90, -30, 12.5, 30, 50, 90, 135, 179]) {
      const x = Math.sin((deg * Math.PI) / 180);
      const y = Math.cos((deg * Math.PI) / 180);
      const angle = northAngleFromTrueNorth(x, y);
      expect(angle).not.toBeNull();
      const az = azimuthOfVector(toSheet(x, y), angle!);
      expect(Math.min(az, 360 - az)).toBeLessThan(0.01);
      // Et une façade tournée vers +X de l'IFC (à droite sur la feuille) regarde 90° plus loin dans le sens horaire.
      const east = azimuthOfVector(toSheet(y, -x), angle!);
      expect(Math.abs(east - 90)).toBeLessThan(0.01);
    }
  });
});
