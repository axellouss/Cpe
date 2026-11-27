import { describe, expect, it } from 'vitest';
import {
  azimuthOfVector,
  centroid,
  cleanPolygon,
  closestOnSegment,
  edgeAzimuth,
  edgeOrientation,
  edgeOutwardNormal,
  extentAlong,
  isSelfIntersecting,
  longestEdgeAngle,
  marginToSectorBoundary,
  nearestEdge,
  pointInPolygon,
  polygonArea,
  polygonPerimeter,
  round,
  sectorOfAzimuth,
  signedArea,
} from '../../src/core/geometry';
import type { Vec2 } from '../../src/core/types';

// Rectangle 10 × 8 dans le repère écran (y vers le bas), parcouru dans le sens horaire À L'ÉCRAN :
// haut-gauche → haut-droite → bas-droite → bas-gauche.
const RECT_CW: Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 8 },
  { x: 0, y: 8 },
];
const RECT_CCW: Vec2[] = [...RECT_CW].reverse();

describe('aire et périmètre', () => {
  it('calcule aire et périmètre quel que soit le sens de parcours', () => {
    expect(polygonArea(RECT_CW)).toBeCloseTo(80);
    expect(polygonArea(RECT_CCW)).toBeCloseTo(80);
    expect(polygonPerimeter(RECT_CW)).toBeCloseTo(36);
    expect(Math.sign(signedArea(RECT_CW))).toBe(-Math.sign(signedArea(RECT_CCW)));
  });

  it("gère un polygone en L", () => {
    const L: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 8 },
      { x: 0, y: 8 },
    ];
    expect(polygonArea(L)).toBeCloseTo(10 * 4 + 6 * 4);
    expect(polygonPerimeter(L)).toBeCloseTo(36);
  });

  it('calcule le centre de gravité', () => {
    const c = centroid(RECT_CW);
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(4);
  });
});

describe('normales extérieures et orientation', () => {
  it('donne une normale vers l’extérieur pour les deux sens de parcours', () => {
    // Arête du haut (y = 0) : l'extérieur est vers le haut de l'écran = (0, -1).
    const top = edgeOutwardNormal(RECT_CW, 0);
    expect(top.x).toBeCloseTo(0);
    expect(top.y).toBeCloseTo(-1);
    // Dans RECT_CCW, l'arête du haut est celle qui relie (10,0) et (0,0).
    const idx = RECT_CCW.findIndex((p, i) => p.y === 0 && RECT_CCW[(i + 1) % 4]!.y === 0);
    const top2 = edgeOutwardNormal(RECT_CCW, idx);
    expect(top2.x).toBeCloseTo(0);
    expect(top2.y).toBeCloseTo(-1);
  });

  it('nord en haut : haut = N, droite = E, bas = S, gauche = O', () => {
    expect(edgeOrientation(RECT_CW, 0, 0)).toBe('N');
    expect(edgeOrientation(RECT_CW, 1, 0)).toBe('E');
    expect(edgeOrientation(RECT_CW, 2, 0)).toBe('S');
    expect(edgeOrientation(RECT_CW, 3, 0)).toBe('W');
  });

  it('tourne avec l’angle du nord', () => {
    // Le haut de la feuille pointe vers l'Est (azimut 90) : la façade du haut regarde l'Est.
    expect(edgeOrientation(RECT_CW, 0, 90)).toBe('E');
    expect(edgeOrientation(RECT_CW, 1, 90)).toBe('S');
    // Nord à 45° : façade du haut au Nord-Est.
    expect(edgeOrientation(RECT_CW, 0, 45)).toBe('NE');
    expect(edgeAzimuth(RECT_CW, 3, 45)).toBeCloseTo(315);
  });

  it('convertit vecteurs et azimuts', () => {
    expect(azimuthOfVector({ x: 0, y: -1 }, 0)).toBeCloseTo(0);
    expect(azimuthOfVector({ x: 1, y: 0 }, 0)).toBeCloseTo(90);
    expect(azimuthOfVector({ x: 0, y: 1 }, 0)).toBeCloseTo(180);
    expect(azimuthOfVector({ x: -1, y: 0 }, 0)).toBeCloseTo(270);
    expect(azimuthOfVector({ x: -1, y: 0 }, 100)).toBeCloseTo(10);
  });

  it('découpe en 8 secteurs de 45°', () => {
    expect(sectorOfAzimuth(0)).toBe('N');
    expect(sectorOfAzimuth(22.4)).toBe('N');
    expect(sectorOfAzimuth(22.5)).toBe('NE');
    expect(sectorOfAzimuth(337.4)).toBe('NW');
    expect(sectorOfAzimuth(337.5)).toBe('N');
    expect(sectorOfAzimuth(180)).toBe('S');
    expect(sectorOfAzimuth(-90)).toBe('W');
    expect(sectorOfAzimuth(725)).toBe('N');
  });

  it('mesure la marge par rapport à une limite de secteur', () => {
    expect(marginToSectorBoundary(0)).toBeCloseTo(22.5);
    expect(marginToSectorBoundary(22.5)).toBeCloseTo(0);
    expect(marginToSectorBoundary(20)).toBeCloseTo(2.5);
    expect(marginToSectorBoundary(25)).toBeCloseTo(2.5);
  });
});

describe('outils divers', () => {
  it('teste l’appartenance d’un point', () => {
    expect(pointInPolygon({ x: 5, y: 4 }, RECT_CW)).toBe(true);
    expect(pointInPolygon({ x: 11, y: 4 }, RECT_CW)).toBe(false);
  });

  it('trouve le point le plus proche sur un segment et l’arête la plus proche', () => {
    const c = closestOnSegment({ x: 5, y: -3 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(c.point.x).toBeCloseTo(5);
    expect(c.t).toBeCloseTo(0.5);
    expect(c.distance).toBeCloseTo(3);
    expect(nearestEdge({ x: 9.5, y: 4 }, RECT_CW)?.index).toBe(1);
  });

  it('détecte un polygone croisé', () => {
    const bow: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 8 },
      { x: 10, y: 0 },
      { x: 0, y: 8 },
    ];
    expect(isSelfIntersecting(bow)).toBe(true);
    expect(isSelfIntersecting(RECT_CW)).toBe(false);
  });

  it('nettoie doublons et sommets alignés', () => {
    const messy: Vec2[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 8 },
      { x: 0, y: 8 },
      { x: 0, y: 0 },
    ];
    const clean = cleanPolygon(messy);
    expect(clean).toHaveLength(4);
    expect(polygonArea(clean)).toBeCloseTo(80);
  });

  it('mesure l’étendue le long d’une direction', () => {
    expect(longestEdgeAngle(RECT_CW)).toBeCloseTo(0);
    const e = extentAlong(RECT_CW, 0);
    expect(e.along).toBeCloseTo(10);
    expect(e.across).toBeCloseTo(8);
    const e90 = extentAlong(RECT_CW, 90);
    expect(e90.along).toBeCloseTo(8);
    expect(e90.across).toBeCloseTo(10);
  });

  it('arrondit au centimètre', () => {
    expect(round(1.005)).toBe(1.01);
    expect(round(2.675)).toBe(2.68);
    expect(round(12.3449)).toBe(12.34);
    expect(round(3.14159, 3)).toBe(3.142);
  });
});
