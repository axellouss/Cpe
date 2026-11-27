import { describe, expect, it } from 'vitest';
import { belongsToBand, overlapNeeded, selectBands, type LevelInput, type ZRange } from '../../../src/readers/ifc/bands';

let nextId = 1;
const level = (name: string, z: number, contained = 0): LevelInput => ({ id: nextId++, name, z, elevation: z, contained });
const range = (zMin: number, zMax: number): ZRange => ({ zMin, zMax });
const repeat = (n: number, r: ZRange): ZRange[] => Array.from({ length: n }, () => r);

describe('choix des étages réels', () => {
  it('maison simple : un étage par niveau, bornes ouvertes en bas et en haut', () => {
    const { bands, dropped } = selectBands(
      [level('Étage', 2.8, 10), level('RDC', 0, 12)],
      [...repeat(6, range(0, 2.8)), ...repeat(4, range(2.8, 5.4))],
      [range(0, 2.5), range(2.8, 5.2)],
    );
    expect(bands.map((b) => b.level.name)).toEqual(['RDC', 'Étage']);
    expect(bands[0]!.zFrom).toBe(-Infinity);
    expect(bands[0]!.zTo).toBe(2.8);
    expect(bands[1]!.zTo).toBe(Infinity);
    expect(dropped).toHaveLength(0);
  });

  it('écarte le niveau de toiture au-dessus duquel plus aucun mur ne monte', () => {
    const { bands, dropped } = selectBands(
      [level('RDC', 0, 12), level('Étage', 2.8, 10), level('Toiture', 5.4, 1)],
      [...repeat(6, range(0, 2.8)), ...repeat(4, range(2.8, 5.4))],
      [],
    );
    expect(bands.map((b) => b.level.name)).toEqual(['RDC', 'Étage']);
    expect(dropped.map((l) => l.name)).toEqual(['Toiture']);
  });

  it('niveaux auxiliaires Revit : fondations et plan de plafond sont absorbés (cas du Duplex)', () => {
    const { bands, dropped } = selectBands(
      [level('T/FDN', -1.25, 14), level('Level 1', 0, 62), level('Level 2', 3.1, 83), level('Roof', 6.0, 8)],
      [...repeat(7, range(-1.25, 0)), ...repeat(17, range(0, 3.1)), ...repeat(17, range(3.1, 6.0)), ...repeat(4, range(6.0, 6.6))],
      [...repeat(10, range(0.02, 2.6)), ...repeat(10, range(3.12, 5.7))],
    );
    expect(bands.map((b) => b.level.name)).toEqual(['Level 1', 'Level 2']);
    expect(bands[0]!.absorbed.map((l) => l.name)).toEqual(['T/FDN']);
    expect(dropped.map((l) => l.name)).toEqual(['Roof']);
  });

  it('entre deux niveaux voisins, garde celui qui porte le plus d’éléments', () => {
    const { bands } = selectBands(
      [level('Level 1 Living Rm.', -0.55, 31), level('Level 1', 0, 117), level('Ceiling', 2.7, 5), level('Level 2', 3.0, 72)],
      [...repeat(6, range(0, 2.7)), ...repeat(2, range(-0.6, 2.7)), ...repeat(14, range(3.0, 8)), ...repeat(3, range(2.7, 9))],
      [],
    );
    expect(bands.map((b) => b.level.name)).toEqual(['Level 1', 'Level 2']);
    // Un niveau absorbé est rattaché à la tranche qui le contient : le plan de plafond (2,70) est sous « Level 2 » (3,00).
    expect(bands[0]!.absorbed.map((l) => l.name)).toEqual(['Level 1 Living Rm.', 'Ceiling']);
    expect(bands[1]!.absorbed).toHaveLength(0);
  });

  it('un plan de référence sur lequel rien n’est posé n’est pas un étage', () => {
    const { bands } = selectBands(
      [level('RDC', 0, 20), level('Repère', 2.0, 0), level('Étage', 4.0, 20)],
      [...repeat(4, range(0, 4)), ...repeat(4, range(4, 7))],
      [],
    );
    expect(bands.map((b) => b.level.name)).toEqual(['RDC', 'Étage']);
  });

  it('sans aucun indice, retombe sur l’espacement des niveaux', () => {
    const { bands } = selectBands([level('A', 0), level('B', 0.5), level('C', 3)], [range(-10, 20)], []);
    expect(bands.map((b) => b.level.name)).toEqual(['A', 'C']);
  });
});

describe('appartenance d’un élément à une tranche', () => {
  it('exige 1 m de recouvrement, ou la moitié de la tranche si elle est basse', () => {
    expect(overlapNeeded(0, 2.8)).toBe(1);
    expect(overlapNeeded(0, 1.2)).toBeCloseTo(0.6, 9);
  });

  it('un mur de 15 m appartient à chaque étage qu’il traverse (export Revit)', () => {
    const wall = range(0, 15);
    expect(belongsToBand(wall, 0, 3)).toBe(true);
    expect(belongsToBand(wall, 6, 9)).toBe(true);
    expect(belongsToBand(wall, 15, 18)).toBe(false);
  });

  it('garde les murs de jambette de 50 cm, mais pas l’acrotère de l’étage du dessous', () => {
    expect(belongsToBand(range(2.7, 3.2), 2.7, 6.1)).toBe(true); // tient tout entier dans la tranche
    expect(belongsToBand(range(0, 3.0), 2.7, 6.1)).toBe(false); // ne dépasse que de 30 cm
  });
});
