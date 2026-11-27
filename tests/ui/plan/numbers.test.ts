import { describe, expect, it } from 'vitest';
import { formatDecimal, parseAngle, parseDecimal, parseLengthMetres, parseOpeningDimension } from '../../../src/ui/plan/numbers';

describe('saisie des nombres', () => {
  it('virgule ou point décimal, espaces tolérés', () => {
    expect(parseDecimal('12,50')).toBe(12.5);
    expect(parseDecimal('12.5')).toBe(12.5);
    expect(parseDecimal(' 1 250,5 ')).toBe(1250.5);
    expect(parseDecimal('1 250,5')).toBe(1250.5);
    expect(parseDecimal(',5')).toBe(0.5);
    expect(parseDecimal('-3')).toBe(-3);
    expect(parseDecimal('7,')).toBe(7);
  });

  it('refuse ce qui n’est pas un nombre', () => {
    for (const bad of ['', ' ', 'abc', '12,5,3', '1.2.3', '12m', '--4', 'NaN', 'Infinity', '1e3']) {
      expect(parseDecimal(bad)).toBeNull();
    }
  });

  it('longueur de la règle : mètres par défaut, cm et mm en suffixe, jamais ≤ 0', () => {
    expect(parseLengthMetres('13,50')).toBe(13.5);
    expect(parseLengthMetres('13.5 m')).toBe(13.5);
    expect(parseLengthMetres('1350 cm')).toBe(13.5);
    expect(parseLengthMetres('13500mm')).toBe(13.5);
    expect(parseLengthMetres('13,5 M')).toBe(13.5);
    // Pas de devinette d'unité ici : une cote de 1350 sans unité reste 1350 m, et l'aperçu de taille montre l'erreur.
    expect(parseLengthMetres('1350')).toBe(1350);
    expect(parseLengthMetres('0')).toBeNull();
    expect(parseLengthMetres('-2')).toBeNull();
    expect(parseLengthMetres('')).toBeNull();
    expect(parseLengthMetres('douze')).toBeNull();
    expect(parseLengthMetres('12 km')).toBeNull();
  });

  it('dimension de baie : mètres, avec les habitudes de chantier (cm, mm)', () => {
    expect(parseOpeningDimension('1,20')).toBe(1.2);
    expect(parseOpeningDimension('120')).toBe(1.2);
    expect(parseOpeningDimension('1350')).toBe(1.35);
    expect(parseOpeningDimension('90')).toBe(0.9);
    expect(parseOpeningDimension('2')).toBe(2);
    expect(parseOpeningDimension('29')).toBe(29); // absurde, donc refusé plus loin par le contrôle de plausibilité
    expect(parseOpeningDimension('60 cm')).toBe(0.6);
    expect(parseOpeningDimension('20 cm')).toBe(0.2);
    expect(parseOpeningDimension('1 m')).toBe(1);
    expect(parseOpeningDimension('0')).toBeNull();
    expect(parseOpeningDimension('large')).toBeNull();
  });

  it('affichage : virgule décimale, tiret si non fini', () => {
    expect(formatDecimal(95.5)).toBe('95,50');
    expect(formatDecimal(1.005, 2)).toBe('1,00');
    expect(formatDecimal(13.456, 1)).toBe('13,5');
    expect(formatDecimal(4, 0)).toBe('4');
    expect(formatDecimal(Number.NaN)).toBe('–');
    expect(formatDecimal(Infinity)).toBe('–');
  });

  it('angles ramenés dans [0, 360)', () => {
    expect(parseAngle('225')).toBe(225);
    expect(parseAngle('360')).toBe(0);
    expect(parseAngle('-45')).toBe(315);
    expect(parseAngle('22,5°')).toBe(22.5);
    expect(parseAngle('725')).toBe(5);
    expect(parseAngle('nord')).toBeNull();
    expect(parseAngle('')).toBeNull();
  });
});
