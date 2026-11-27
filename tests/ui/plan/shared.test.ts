import { describe, expect, it } from 'vitest';
import { loupePosition } from '../../../src/ui/plan/Loupe';
import { outsideLabel } from '../../../src/ui/plan/shapes';
import { blankGridStep, niceLength, scaleIsGuess, snapRadiusPx } from '../../../src/ui/plan/toolShared';

describe('aides communes des outils', () => {
  it('rayon d’accrochage : plus large au doigt', () => {
    expect(snapRadiusPx('touch')).toBeGreaterThan(snapRadiusPx('pen'));
    expect(snapRadiusPx('pen')).toBeGreaterThan(snapRadiusPx('mouse'));
    expect(snapRadiusPx('inconnu')).toBe(snapRadiusPx('mouse'));
  });

  it('pas de la feuille vierge : rond, au moins 7 px à l’écran, jamais sous le centimètre', () => {
    expect(blankGridStep(36)).toBeCloseTo(0.2, 12); // vue d'ensemble d'une maison : 20 cm
    expect(blankGridStep(150)).toBeCloseTo(0.05, 12); // zoom : 5 cm
    expect(blankGridStep(5000)).toBe(0.01);
    for (const scale of [3, 36, 150, 400]) expect(blankGridStep(scale) * scale).toBeGreaterThanOrEqual(7 - 1e-9);
  });

  it('longueur ronde de la barre d’échelle', () => {
    expect(niceLength(1.9)).toBe(2);
    expect(niceLength(0.84)).toBe(1);
    expect(niceLength(4.2)).toBe(5);
    expect(niceLength(0.13)).toBeCloseTo(0.1, 12);
    expect(niceLength(17)).toBe(20);
    expect(niceLength(80)).toBe(100);
    expect(niceLength(0)).toBe(1);
    expect(niceLength(Number.NaN)).toBe(1);
  });

  it('échelle « supposée » seulement quand sa provenance est une estimation', () => {
    expect(scaleIsGuess({ metresPerUnit: { value: 1, from: 'estimate' } })).toBe(true);
    for (const from of ['plan', 'user', 'calc', 'default'] as const) expect(scaleIsGuess({ metresPerUnit: { value: 0.01, from } })).toBe(false);
  });

  it('étiquette à l’extérieur d’une arête : ancrée du côté du trait quand la normale est horizontale', () => {
    const mid = { x: 100, y: 100 };
    expect(outsideLabel(mid, { x: 1, y: 0 }, 10)).toEqual({ x: 110, y: 100, anchor: 'start' });
    expect(outsideLabel(mid, { x: -1, y: 0 }, 10)).toEqual({ x: 90, y: 100, anchor: 'end' });
    expect(outsideLabel(mid, { x: 0, y: -1 }, 10)).toEqual({ x: 100, y: 85, anchor: 'middle' });
    expect(outsideLabel(mid, { x: 0, y: 1 }, 10).y).toBe(115);
  });

  it('loupe : au-dessus du doigt, sinon sur le côté, toujours dans la zone de plan', () => {
    const size = { width: 360, height: 560 };
    const d = 128;
    const above = loupePosition({ x: 180, y: 400 }, size, d);
    expect(above.y + d).toBeLessThan(400 - 40); // nettement au-dessus du doigt
    expect(above.x + d / 2).toBeCloseTo(180, 9);
    // Doigt près du haut : pas la place au-dessus → sur le côté, sans recouvrir le doigt.
    const left = loupePosition({ x: 300, y: 60 }, size, d);
    expect(left.x + d).toBeLessThan(300 - 40);
    const right = loupePosition({ x: 40, y: 60 }, size, d);
    expect(right.x).toBeGreaterThan(40 + 40);
    for (const finger of [{ x: 2, y: 2 }, { x: 358, y: 558 }, { x: 180, y: 10 }, { x: 5, y: 300 }]) {
      const p = loupePosition(finger, size, d);
      expect(p.x).toBeGreaterThanOrEqual(4);
      expect(p.y).toBeGreaterThanOrEqual(4);
      expect(p.x + d).toBeLessThanOrEqual(size.width - 4);
      expect(p.y + d).toBeLessThanOrEqual(size.height - 4);
    }
  });
});
