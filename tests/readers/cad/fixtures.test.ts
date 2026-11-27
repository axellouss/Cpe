/**
 * Lecteur DWG / DXF contre la vérité terrain des plans d'essai (tests/fixtures/cad/fixture_truth.json) :
 * unité, nombre de feuilles, pièces et surfaces, contour à 1 % près, fenêtres (nombre, largeurs, hauteurs,
 * orientation), flèche du nord.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { isSelfIntersecting, sectorOfAzimuth } from '../../../src/core/geometry';
import type { PlanSheet } from '../../../src/core/types';
import {
  EXPECTED_NORTH_ANGLE,
  angleDiff,
  openingAzimuth,
  outlineArea,
  readFixture,
  sortedWidths,
  truthOf,
  truthToSheet,
  truthWidths,
} from './helpers';
import type { Read, TruthFile } from './helpers';

/** Vérifie une feuille contre un niveau de la vérité terrain. */
function checkSheet(sheet: PlanSheet, truth: TruthFile, floor: string, north: number, planOrigin: [number, number], sheetOrigin: { x0: number; y0: number }): void {
  const upm = truth.units_per_m;
  const unitsPerCm = upm / 100;
  const floorTruth = truth.floors.find((f) => f.floor === floor)!;
  const outline = sheet.detected.outline!;

  // Contour : polygone simple, emprise du bâtiment à 1 % près.
  expect(outline.length).toBeGreaterThanOrEqual(4);
  expect(outline.length).toBeLessThanOrEqual(12);
  expect(isSelfIntersecting(outline)).toBe(false);
  const area = outlineArea(sheet);
  expect(Math.abs(area - floorTruth.footprint_all_m2) / floorTruth.footprint_all_m2).toBeLessThan(0.01);

  // Pièces : noms, surfaces écrites, surfaces mesurées, position de l'étiquette.
  const rooms = truth.rooms.filter((r) => r.floor === floor);
  expect(sheet.detected.rooms.map((r) => r.name).sort()).toEqual(rooms.map((r) => r.name).sort());
  for (const expected of rooms) {
    const room = sheet.detected.rooms.find((r) => r.name === expected.name)!;
    if (expected.stated_m2 === null) expect(room.statedArea).toBeUndefined();
    else expect(room.statedArea).toBeCloseTo(expected.stated_m2, 2);
    expect(room.measuredArea).toBeCloseTo(expected.area_m2, 1);
    expect(Math.abs(room.measuredArea! - expected.area_m2)).toBeLessThan(0.02);
    expect(room.polygon!.length).toBeGreaterThanOrEqual(4);
    const at = truthToSheet(expected.centroid_cm, planOrigin, unitsPerCm, sheetOrigin);
    expect(Math.hypot(room.at!.x - at.x, room.at!.y - at.y)).toBeLessThan(40 * unitsPerCm);
  }

  // Fenêtres : nombre, largeurs, hauteurs, position et orientation.
  const windows = truth.windows.filter((w) => w.floor === floor);
  const found = sheet.detected.openings.filter((o) => o.kind === 'window');
  expect(sortedWidths(found)).toEqual(truthWidths(truth.windows, floor));
  for (const expected of windows) {
    const centre = truthToSheet(expected.centre_cm, planOrigin, unitsPerCm, sheetOrigin);
    const match = found.find((o) => Math.hypot((o.a.x + o.b.x) / 2 - centre.x, (o.a.y + o.b.y) / 2 - centre.y) < 30 * unitsPerCm);
    expect(match, `fenêtre ${expected.id}`).toBeDefined();
    expect(match!.exterior).toBe(true);
    expect(match!.width).toBeCloseTo(expected.width_cm / 100, 2);
    expect(match!.height).toBeCloseTo(expected.height_cm! / 100, 2);
    const azimuth = openingAzimuth(match!, outline, north);
    expect(angleDiff(azimuth, expected.azimuth_deg!)).toBeLessThan(0.5);
    expect(sectorOfAzimuth(azimuth)).toBe(sectorOfAzimuth(expected.azimuth_deg!));
  }

  // Portes extérieures de la vérité terrain (porte d'entrée) : retrouvées avec la bonne largeur.
  for (const expected of truth.doors.filter((d) => d.floor === floor && d.exterior)) {
    const centre = truthToSheet(expected.centre_cm, planOrigin, unitsPerCm, sheetOrigin);
    const match = sheet.detected.openings.find((o) => Math.hypot((o.a.x + o.b.x) / 2 - centre.x, (o.a.y + o.b.y) / 2 - centre.y) < 30 * unitsPerCm);
    expect(match, `porte ${expected.id}`).toBeDefined();
    expect(match!.kind).toBe('door');
    expect(match!.width).toBeCloseTo(expected.width_cm / 100, 2);
    expect(angleDiff(openingAzimuth(match!, outline, north), expected.azimuth_deg!)).toBeLessThan(0.5);
  }
  // Aucune ouverture intérieure n'est proposée.
  expect(sheet.detected.openings.every((o) => o.exterior === true)).toBe(true);
}

describe('fixture_rdc_cm.dxf — rez-de-chaussée en centimètres, calques français', () => {
  const file = 'fixture_rdc_cm.dxf';
  const truth = truthOf(file);
  let read: Read;
  beforeAll(async () => {
    read = await readFixture(file);
  });

  it('rend une seule feuille, nommée d’après le titre du plan', () => {
    expect(read.doc.kind).toBe('dxf');
    expect(read.doc.fileName).toBe(file);
    expect(read.doc.storeysAligned).toBe(false);
    expect(read.doc.sheets).toHaveLength(1);
    expect(read.doc.sheets[0]!.name).toBe('Rez-de-chaussée');
    expect(read.doc.sheets[0]!.id).toBe('cad-1');
  });

  it('trouve l’unité (cm) avec la provenance « plan » quand les indices concordent', () => {
    const scale = read.doc.sheets[0]!.metresPerUnit!;
    expect(scale.value).toBeCloseTo(1 / truth.units_per_m, 10);
    expect(scale.from).toBe('plan');
    expect(scale.note).toContain('centimètres');
    expect(read.details.unitEvidence.map((e) => e.source).sort()).toEqual(['areas', 'doors', 'header', 'walls']);
  });

  it('reconnaît le calque des murs par son nom', () => {
    expect(read.details.wallLayers).toEqual(['MUR']);
    expect(read.details.wallSource).toBe('name');
  });

  it('retrouve contour, pièces, fenêtres et porte d’entrée', () => {
    checkSheet(read.doc.sheets[0]!, truth, 'RDC', read.doc.northAngle!.value, truth.origin!, read.details.sheetOrigins[0]!);
  });

  it('propose aussi la porte de garage, dessinée d’un simple trait sur le calque des portes', () => {
    const doors = read.doc.sheets[0]!.detected.openings.filter((o) => o.kind === 'door');
    expect(sortedWidths(doors)).toEqual([1, 2.5]);
  });

  it('classe les pièces : garage hors volume chauffé, buanderie à demander', () => {
    const guess = Object.fromEntries(read.doc.sheets[0]!.detected.rooms.map((r) => [r.name, r.heatedGuess]));
    expect(guess).toMatchObject({ Séjour: 'yes', Cuisine: 'yes', Hall: 'yes', WC: 'yes', Buanderie: 'ask', Garage: 'no' });
  });

  it('lit la flèche du nord et demande de la confirmer', () => {
    expect(read.doc.northAngle!.value).toBeCloseTo(EXPECTED_NORTH_ANGLE, 1);
    expect(read.doc.northAngle!.from).toBe('plan');
    expect(read.doc.northAngle!.note).toMatch(/confirmer/i);
  });

  it('signale l’étiquette de surface fausse de la cuisine et le garage englobé dans le contour', () => {
    const notes = read.doc.sheets[0]!.detected.notes.join('\n');
    expect(notes).toContain('« Cuisine » : 12,16 m² écrits, 11,31 m² mesurés');
    expect(notes).toMatch(/englobe « Garage »/);
    expect(notes).toMatch(/calque « 0 »/);
  });

  it('n’émet aucun avertissement quand rien n’est deviné', () => {
    expect(read.doc.warnings).toEqual([]);
  });

  it('place le contenu dans le repère de la feuille : origine en haut à gauche, y vers le bas', () => {
    const sheet = read.doc.sheets[0]!;
    expect(sheet.bbox.minX).toBe(0);
    expect(sheet.bbox.minY).toBe(0);
    const segs = sheet.segments!;
    expect(segs.length % 4).toBe(0);
    expect(segs.length / 4).toBeGreaterThan(300);
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < segs.length; i += 2) {
      expect(segs[i]!).toBeGreaterThanOrEqual(-0.01);
      expect(segs[i + 1]!).toBeGreaterThanOrEqual(-0.01);
      maxX = Math.max(maxX, segs[i]!);
      maxY = Math.max(maxY, segs[i + 1]!);
    }
    expect(maxX).toBeLessThanOrEqual(sheet.bbox.maxX + 0.01);
    expect(maxY).toBeLessThanOrEqual(sheet.bbox.maxY + 0.01);
    // Le titre est SOUS le plan : y plus grand que celui des pièces dans le repère de la feuille.
    const title = sheet.texts!.find((t) => t.text === 'PLAN DU REZ-DE-CHAUSSEE')!;
    const sejour = sheet.detected.rooms.find((r) => r.name === 'Séjour')!;
    expect(title.y).toBeGreaterThan(sejour.at!.y);
  });

  it('décode les textes : MTEXT sans codes de mise en forme, attributs invisibles masqués', () => {
    const texts = read.doc.sheets[0]!.texts!.map((t) => t.text);
    expect(texts).toContain('Séjour 37,08 m²');
    expect(texts).toContain('Cuisine');
    expect(texts).toContain('12,16 m²');
    expect(texts).toContain('WC');
    expect(texts).toContain('2,40 m2');
    expect(texts).toContain('F1'); // attribut visible
    expect(texts).not.toContain('215'); // attribut HAUT invisible
    expect(texts.some((t) => /\\[PfA]|[{}]/.test(t))).toBe(false);
  });
});

describe('fixture_etage_mm.dxf — étage en millimètres, calques allemands, DXF R2000 en cp1252', () => {
  const file = 'fixture_etage_mm.dxf';
  const truth = truthOf(file);
  let read: Read;
  beforeAll(async () => {
    read = await readFixture(file);
  });

  it('trouve l’unité (mm) et le calque « Wand »', () => {
    const scale = read.doc.sheets[0]!.metresPerUnit!;
    expect(scale.value).toBeCloseTo(0.001, 10);
    expect(scale.from).toBe('plan');
    expect(read.details.wallLayers).toEqual(['Wand']);
  });

  it('nomme la feuille d’après « GRUNDRISS OBERGESCHOSS »', () => {
    expect(read.doc.sheets).toHaveLength(1);
    expect(read.doc.sheets[0]!.name).toBe('Étage');
  });

  it('retrouve contour, pièces (noms allemands avec ü et ß décodés) et fenêtres', () => {
    checkSheet(read.doc.sheets[0]!, truth, 'ETAGE', read.doc.northAngle!.value, truth.origin!, read.details.sheetOrigins[0]!);
    expect(read.doc.sheets[0]!.detected.rooms.map((r) => r.name)).toContain('Büro');
  });

  it('lit la hauteur des fenêtres dans le nom du bloc (« Fenster 1,40x1,35 »)', () => {
    const heights = read.doc.sheets[0]!.detected.openings.filter((o) => o.kind === 'window').map((o) => o.height);
    expect(heights.sort()).toEqual([1, 1.35, 1.35, 1.35, 1.35, 1.35, 1.35]);
  });

  it('lit la flèche du nord « Nordpfeil »', () => {
    expect(read.doc.northAngle!.value).toBeCloseTo(EXPECTED_NORTH_ANGLE, 1);
    expect(read.doc.northAngle!.note).toContain('Nordpfeil');
  });

  it('n’a pas de porte extérieure à proposer à l’étage', () => {
    expect(read.doc.sheets[0]!.detected.openings.filter((o) => o.kind !== 'window')).toEqual([]);
  });
});

describe('fixture_2storeys_aia.dxf — deux niveaux côte à côte, sans unité dans l’en-tête, calques AIA', () => {
  const file = 'fixture_2storeys_aia.dxf';
  const truth = truthOf(file);
  let read: Read;
  beforeAll(async () => {
    read = await readFixture(file);
  });

  it('sépare les deux plans en deux feuilles nommées et ordonnées du bas vers le haut', () => {
    expect(read.doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    expect(read.doc.sheets.map((s) => s.id)).toEqual(['cad-1', 'cad-2']);
    expect(read.doc.warnings.join('\n')).toMatch(/2 plans trouvés/);
  });

  it('trouve l’unité (cm) sans l’en-tête, d’après les portes, les murs et les surfaces écrites', () => {
    expect(read.details.unitEvidence.map((e) => e.source)).not.toContain('header');
    for (const sheet of read.doc.sheets) {
      expect(sheet.metresPerUnit!.value).toBeCloseTo(0.01, 10);
      expect(sheet.metresPerUnit!.from).toBe('plan');
    }
    expect(read.details.wallLayers).toEqual(['A-WALL']);
  });

  it('retrouve contour, pièces et fenêtres du rez-de-chaussée', () => {
    checkSheet(read.doc.sheets[0]!, truth, 'RDC', read.doc.northAngle!.value, truth.origins!.RDC!, read.details.sheetOrigins[0]!);
  });

  it('retrouve contour, pièces et fenêtres de l’étage', () => {
    checkSheet(read.doc.sheets[1]!, truth, 'ETAGE', read.doc.northAngle!.value, truth.origins!.ETAGE!, read.details.sheetOrigins[1]!);
  });

  it('répartit traits et textes entre les feuilles, sans le cadre commun', () => {
    const [rdc, etage] = read.doc.sheets as [PlanSheet, PlanSheet];
    expect(rdc.texts!.map((t) => t.text)).toContain('PLAN DU REZ-DE-CHAUSSEE');
    expect(rdc.texts!.map((t) => t.text)).not.toContain("PLAN DE L'ETAGE");
    expect(etage.texts!.map((t) => t.text)).toContain("PLAN DE L'ETAGE");
    // Le cadre fait 41 m de large : aucune feuille ne doit s'étendre autant.
    expect(rdc.bbox.maxX).toBeLessThan(2600);
    expect(etage.bbox.maxX).toBeLessThan(2600);
  });

  it('lit la flèche du nord une fois pour le document', () => {
    expect(read.doc.northAngle!.value).toBeCloseTo(EXPECTED_NORTH_ANGLE, 1);
  });
});

describe('entrée DWG', () => {
  it('lit le rez-de-chaussée converti en DWG 2018 comme le DXF d’origine', async () => {
    const file = 'fixture_rdc_cm.dwg';
    const read = await readFixture(file);
    const truth = truthOf('fixture_rdc_cm.dxf');
    expect(read.doc.kind).toBe('dwg');
    expect(read.details.version).toBe('AC1032');
    expect(read.doc.sheets).toHaveLength(1);
    expect(read.doc.sheets[0]!.name).toBe('Rez-de-chaussée');
    expect(read.doc.sheets[0]!.metresPerUnit).toMatchObject({ value: 0.01, from: 'plan' });
    checkSheet(read.doc.sheets[0]!, truth, 'RDC', read.doc.northAngle!.value, truth.origin!, read.details.sheetOrigins[0]!);
    expect(read.doc.warnings).toEqual([]);
  });

  it('lit l’étage converti en DWG 2000', async () => {
    const read = await readFixture('fixture_etage_mm.dwg');
    const truth = truthOf('fixture_etage_mm.dxf');
    expect(read.details.version).toBe('AC1015');
    checkSheet(read.doc.sheets[0]!, truth, 'ETAGE', read.doc.northAngle!.value, truth.origin!, read.details.sheetOrigins[0]!);
  });

  it('reconnaît un DWG même annoncé comme DXF (octets « AC10xx » en tête)', async () => {
    const { readCad } = await import('../../../src/readers/cad');
    const { fixtureBytes } = await import('./helpers');
    const doc = await readCad(fixtureBytes('fixture_rdc_cm.dwg'), 'plan.dxf', 'dxf');
    expect(doc.sheets[0]!.detected.rooms).toHaveLength(6);
  });
});
