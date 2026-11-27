import { describe, expect, it } from 'vitest';
import { edgeOrientation } from '../../../src/core/geometry';
import type { Vec2 } from '../../../src/core/types';
import { facadeOrientation, needleScreenAngle, northFromPointer, rotateNeedle, settleAngle, topSector } from '../../../src/ui/plan/compass';

/** Rectangle horaire à l'écran : arêtes 0 = haut, 1 = droite, 2 = bas, 3 = gauche. */
const RECT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 0, y: 6 },
];
const centre = { x: 100, y: 100 };

describe('boussole', () => {
  it('aiguille : tournée de −northAngle à l’écran', () => {
    expect(needleScreenAngle(0)).toBe(0);
    expect(needleScreenAngle(90)).toBe(270); // le haut regarde l'est → le nord est à gauche
    expect(needleScreenAngle(270)).toBe(90);
    expect(needleScreenAngle(180)).toBe(180);
  });

  it('pointer une direction donne le northAngle correspondant', () => {
    expect(northFromPointer(centre, { x: 100, y: 40 })).toBe(0); // aiguille en haut : nord en haut
    expect(northFromPointer(centre, { x: 160, y: 100 })).toBe(270); // aiguille à droite : le haut regarde l'ouest
    expect(northFromPointer(centre, { x: 100, y: 160 })).toBe(180);
    expect(northFromPointer(centre, { x: 40, y: 100 })).toBe(90);
    expect(northFromPointer(centre, { x: 101, y: 99 })).toBeNull(); // trop près du centre
  });

  it('glisser l’aiguille puis relire son angle : cohérent avec needleScreenAngle', () => {
    for (const north of [0, 30, 90, 135, 222, 359]) {
      const a = (needleScreenAngle(north) * Math.PI) / 180;
      const pointer = { x: centre.x + Math.sin(a) * 50, y: centre.y - Math.cos(a) * 50 };
      expect(northFromPointer(centre, pointer)!).toBeCloseTo(north, 9);
    }
  });

  it('arrondi au degré, aimant sur les multiples de 45°', () => {
    expect(settleAngle(88)).toBe(90);
    expect(settleAngle(92.9)).toBe(90);
    expect(settleAngle(86.4)).toBe(86);
    expect(settleAngle(358.2)).toBe(0);
    expect(settleAngle(-2)).toBe(0);
    expect(settleAngle(47.5, 1)).toBe(48);
    expect(settleAngle(200.4)).toBe(200);
  });

  it('boutons : tourner l’aiguille à droite diminue l’azimut du haut de la feuille', () => {
    expect(rotateNeedle(0, 45)).toBe(315);
    expect(rotateNeedle(0, -45)).toBe(45);
    expect(rotateNeedle(350, -15)).toBe(5);
    expect(rotateNeedle(10, 5)).toBe(5);
    // Aiguille tournée de 90° à droite = nord à droite = le haut regarde l'ouest.
    expect(needleScreenAngle(rotateNeedle(0, 90))).toBe(90);
  });

  it('orientation des façades : nord en haut', () => {
    expect(facadeOrientation(RECT, 0, 0)).toEqual({ sector: 'N', azimuth: 0, borderline: false });
    expect(facadeOrientation(RECT, 1, 0)).toEqual({ sector: 'E', azimuth: 90, borderline: false });
    expect(facadeOrientation(RECT, 2, 0)).toEqual({ sector: 'S', azimuth: 180, borderline: false });
    expect(facadeOrientation(RECT, 3, 0)).toEqual({ sector: 'W', azimuth: 270, borderline: false });
  });

  it('orientation des façades : suit la boussole, quel que soit le sens de parcours du contour', () => {
    // Le haut de la feuille regarde le sud-ouest (225°).
    expect(facadeOrientation(RECT, 0, 225).sector).toBe('SW');
    expect(facadeOrientation(RECT, 1, 225).sector).toBe('NW');
    expect(facadeOrientation(RECT, 1, 225).azimuth).toBe(315);
    const reversed = [...RECT].reverse();
    const sectors = [0, 1, 2, 3].map((i) => facadeOrientation(reversed, i, 0).sector).sort();
    expect(sectors).toEqual(['E', 'N', 'S', 'W']);
    for (let i = 0; i < 4; i++) expect(facadeOrientation(RECT, i, 37).sector).toBe(edgeOrientation(RECT, i, 37));
  });

  it('signale une façade à cheval sur deux secteurs', () => {
    // Haut de la feuille à 20° : limite N/NE à 22,5° → à 2,5° de la limite.
    expect(facadeOrientation(RECT, 0, 20)).toEqual({ sector: 'N', azimuth: 20, borderline: true });
    expect(facadeOrientation(RECT, 0, 10).borderline).toBe(false);
    expect(facadeOrientation(RECT, 0, 359.6).azimuth).toBe(0);
  });

  it('secteur vers lequel regarde le haut de la feuille', () => {
    expect(topSector(0)).toBe('N');
    expect(topSector(270)).toBe('W');
    expect(topSector(-90)).toBe('W');
    expect(topSector(44)).toBe('NE');
  });
});
