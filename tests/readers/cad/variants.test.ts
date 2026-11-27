/**
 * Versions DÉGRADÉES des plans d'essai (tests/fixtures/cad/variants) : ce que le lecteur supporte, et ce qu'il ne
 * sait pas encore faire — les cas en échec connu sont marqués `it.fails` (ils ne sont pas cachés).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { isSelfIntersecting } from '../../../src/core/geometry';
import { EXPECTED_NORTH_ANGLE, angleDiff, openingAzimuth, outlineArea, readFixture, sortedWidths, truthOf, truthWidths } from './helpers';
import type { Read, TruthFile } from './helpers';

interface Expectation {
  /** Azimut du haut de la feuille attendu ; null si la flèche du nord est perdue. */
  north: number | null;
  /** Les hauteurs de fenêtres sont-elles encore lisibles ? */
  heights: boolean;
  wallSource: 'name' | 'geometry';
}

const BASES: { file: string; floor: string }[] = [
  { file: 'fixture_rdc_cm', floor: 'RDC' },
  { file: 'fixture_etage_mm', floor: 'ETAGE' },
];

/** Contrôles communs : unité, une feuille, contour à 1 %, fenêtres (nombre, largeurs, orientation). */
function checkCore(read: Read, truth: TruthFile, floor: string, expected: Expectation): void {
  expect(read.doc.sheets).toHaveLength(1);
  const sheet = read.doc.sheets[0]!;
  expect(sheet.metresPerUnit!.value).toBeCloseTo(1 / truth.units_per_m, 10);
  expect(read.details.wallSource).toBe(expected.wallSource);

  const outline = sheet.detected.outline!;
  expect(isSelfIntersecting(outline)).toBe(false);
  const footprint = truth.floors[0]!.footprint_all_m2;
  expect(Math.abs(outlineArea(sheet) - footprint) / footprint).toBeLessThan(0.01);

  const windows = sheet.detected.openings.filter((o) => o.kind === 'window');
  expect(sortedWidths(windows)).toEqual(truthWidths(truth.windows, floor));
  if (expected.heights) {
    expect(windows.map((w) => w.height).sort()).toEqual(truth.windows.map((w) => w.height_cm! / 100).sort());
  } else {
    expect(windows.every((w) => w.height === undefined)).toBe(true);
  }

  if (expected.north === null) {
    expect(read.doc.northAngle).toBeUndefined();
    expect(read.doc.warnings.join('\n')).toMatch(/flèche du nord/);
  } else {
    expect(angleDiff(read.doc.northAngle!.value, expected.north)).toBeLessThan(0.1);
    // Orientation des fenêtres : même multiensemble d'azimuts que la vérité terrain.
    const azimuths = windows.map((w) => Math.round(openingAzimuth(w, outline, read.doc.northAngle!.value))).sort((a, b) => a - b);
    expect(azimuths).toEqual(truth.windows.map((w) => Math.round(w.azimuth_deg!)).sort((a, b) => a - b));
  }
}

function checkRooms(read: Read, truth: TruthFile): void {
  const rooms = read.doc.sheets[0]!.detected.rooms;
  expect(rooms.map((r) => r.name).sort()).toEqual(truth.rooms.map((r) => r.name).sort());
  for (const expected of truth.rooms) {
    const room = rooms.find((r) => r.name === expected.name)!;
    if (expected.stated_m2 !== null) expect(room.statedArea).toBeCloseTo(expected.stated_m2, 2);
    expect(Math.abs(room.measuredArea! - expected.area_m2)).toBeLessThan(0.02);
  }
}

const NORTH = EXPECTED_NORTH_ANGLE;

describe.each(BASES)('$file — variantes supportées', ({ file, floor }) => {
  const truth = truthOf(`${file}.dxf`);

  it('rotated17 : tout le dessin tourné de 17° (plus rien n’est horizontal)', async () => {
    const read = await readFixture(`variants/${file}__rotated17.dxf`);
    // La flèche du nord a tourné avec le dessin : le haut de la feuille regarde 17° plus à l'est.
    checkCore(read, truth, floor, { north: (NORTH + 17) % 360, heights: true, wallSource: 'name' });
    checkRooms(read, truth);
    expect(read.doc.sheets[0]!.detected.outline!.length).toBeLessThanOrEqual(12);
  });

  it('anon_layers : calques sans nom parlant, murs retrouvés par leurs doubles traits', async () => {
    const read = await readFixture(`variants/${file}__anon_layers.dxf`);
    checkCore(read, truth, floor, { north: NORTH, heights: true, wallSource: 'geometry' });
    checkRooms(read, truth);
    expect(read.details.wallLayers).toEqual(['Calque5']);
    expect(read.doc.warnings.join('\n')).toMatch(/Aucun calque ne porte un nom de mur : « Calque5 »/);
  });

  it('walls_through : murs dessinés à travers les fenêtres, ouvertures lues sur les blocs', async () => {
    const read = await readFixture(`variants/${file}__walls_through.dxf`);
    checkCore(read, truth, floor, { north: NORTH, heights: true, wallSource: 'name' });
    checkRooms(read, truth);
  });

  it('gaps_3cm : 30 % des extrémités de murs reculées de 3 cm, dessin réparé', async () => {
    const read = await readFixture(`variants/${file}__gaps_3cm.dxf`);
    checkCore(read, truth, floor, { north: NORTH, heights: true, wallSource: 'name' });
    const rooms = read.doc.sheets[0]!.detected.rooms;
    expect(rooms.map((r) => r.name).sort()).toEqual(truth.rooms.map((r) => r.name).sort());
    // Les réparations déplacent des coins de quelques centimètres : tolérance un peu plus large sur les surfaces.
    for (const expected of truth.rooms) {
      const room = rooms.find((r) => r.name === expected.name)!;
      expect(Math.abs(room.measuredArea! - expected.area_m2)).toBeLessThan(0.05);
    }
    expect(read.doc.sheets[0]!.detected.notes.join('\n')).toMatch(/Dessin réparé/);
  });
});

describe('fixture_rdc_cm — autres variantes supportées', () => {
  const truth = truthOf('fixture_rdc_cm.dxf');

  it('exploded : blocs décomposés — fenêtres et portes retrouvées, hauteurs et flèche du nord perdues', async () => {
    const read = await readFixture('variants/fixture_rdc_cm__exploded.dxf');
    checkCore(read, truth, 'RDC', { north: null, heights: false, wallSource: 'name' });
    checkRooms(read, truth);
    expect(sortedWidths(read.doc.sheets[0]!.detected.openings, 'door')).toEqual([1, 2.5]);
  });

  it('one_block : tout le plan dans un seul bloc (xref lié), blocs imbriqués développés', async () => {
    const read = await readFixture('variants/fixture_rdc_cm__one_block.dxf');
    checkCore(read, truth, 'RDC', { north: NORTH, heights: true, wallSource: 'name' });
    checkRooms(read, truth);
    expect(read.details.entities).toBe(1);
  });

  it('no_units : $INSUNITS = 0, unité retrouvée par les portes, les murs et les surfaces écrites', async () => {
    const read = await readFixture('variants/fixture_rdc_cm__no_units.dxf');
    checkCore(read, truth, 'RDC', { north: NORTH, heights: true, wallSource: 'name' });
    checkRooms(read, truth);
    expect(read.details.unitEvidence.map((e) => e.source).sort()).toEqual(['areas', 'doors', 'walls']);
    expect(read.doc.sheets[0]!.metresPerUnit!.from).toBe('plan');
  });
});

describe('no_jambs — murs dessinés sans tableaux (défaut composé : un trait de mur est en plus sur le calque « 0 »)', () => {
  describe('fixture_rdc_cm', () => {
    const truth = truthOf('fixture_rdc_cm.dxf');
    let read: Read;
    beforeAll(async () => {
      read = await readFixture('variants/fixture_rdc_cm__no_jambs.dxf');
    });

    it('garde le bon contour (fermeture large) et toutes les fenêtres, en le signalant comme approché', () => {
      checkCore(read, truth, 'RDC', { north: NORTH, heights: true, wallSource: 'name' });
      expect(read.doc.warnings.join('\n')).toMatch(/murs non refermés, contour approché/);
      expect(read.doc.sheets[0]!.detected.notes.join('\n')).toMatch(/bouts de murs sans tableau dessiné ont été refermés/);
    });

    it('nomme les 6 pièces et ne mesure que celles qui se referment (jamais de surface fausse)', () => {
      const rooms = read.doc.sheets[0]!.detected.rooms;
      expect(rooms.map((r) => r.name).sort()).toEqual(truth.rooms.map((r) => r.name).sort());
      for (const room of rooms) {
        if (room.measuredArea === undefined) continue;
        const expected = truth.rooms.find((r) => r.name === room.name)!;
        expect(Math.abs(room.measuredArea - expected.area_m2)).toBeLessThan(0.02);
      }
      expect(rooms.filter((r) => r.measuredArea !== undefined).map((r) => r.name).sort()).toEqual(['Buanderie', 'Garage', 'Hall', 'WC']);
    });

    // ÉCHEC CONNU : le mur extérieur du séjour et de la cuisine ne se referme pas dans le modèle exact
    // (le trait manquant est sur le calque « 0 » et les tableaux manquent) → pas de polygone pour ces deux pièces.
    it.fails('mesure aussi le séjour et la cuisine', () => {
      checkRooms(read, truth);
    });
  });

  describe('fixture_etage_mm', () => {
    const truth = truthOf('fixture_etage_mm.dxf');
    let read: Read;
    beforeAll(async () => {
      read = await readFixture('variants/fixture_etage_mm__no_jambs.dxf');
    });

    it('garde le contour et les 7 fenêtres (le faux « pont » de 4,37 m est écarté, les blocs repris un par un)', () => {
      checkCore(read, truth, 'ETAGE', { north: NORTH, heights: true, wallSource: 'name' });
      expect(sortedWidths(read.doc.sheets[0]!.detected.openings).some((w) => w > 3)).toBe(false);
    });

    it('signale les deux pièces que le dessin ne sépare plus, sans leur donner de surface mesurée', () => {
      const sheet = read.doc.sheets[0]!;
      expect(sheet.detected.notes.join('\n')).toMatch(/Pièces non séparées.*Kinderzimmer \+ Bad/);
      for (const name of ['Kinderzimmer', 'Bad']) {
        const room = sheet.detected.rooms.find((r) => r.name === name)!;
        expect(room.measuredArea).toBeUndefined();
        expect(room.polygon).toBeUndefined();
        expect(room.statedArea).toBeGreaterThan(0);
      }
    });

    // ÉCHEC CONNU : la cloison entre « Kinderzimmer » et « Bad » reste ouverte (bout de mur enjambé par un pont).
    it.fails('mesure les 6 pièces', () => {
      checkRooms(read, truth);
    });
  });
});
