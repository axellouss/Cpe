/**
 * Pièces sans nom reconnu (revue : readers-unlabelled-rooms-dropped) : toute face fermée par les murs dans le
 * contour est rendue avec sa surface mesurée, même si son texte n'est pas dans le vocabulaire ou si elle n'en a
 * aucun. Sinon la surface nette An sort trop basse, avec la provenance « lue sur le plan ».
 */
import { describe, expect, it } from 'vitest';
import { polygonArea } from '../../../src/core/geometry';
import type { DetectedRoom, PlanSheet } from '../../../src/core/types';
import { readCad, readCadDetailed } from '../../../src/readers/cad';
import { detectRooms, looksLikeFreeName, splitFreeLabel } from '../../../src/readers/cad/rooms';
import { parseRoomLabel } from '../../../src/semantics/labels';
import { dxfRect, dxfText, fixtureText, miniDxf, outlineArea, scaleOf, textBytes, truthOf } from './helpers';

/** Nom qu'aucun vocabulaire de pièces ne connaît (contrôlé ci-dessous, pour que le test reste parlant). */
const ODD = 'Zone Q7';

function byName(sheet: PlanSheet, name: string): DetectedRoom {
  const room = sheet.detected.rooms.find((r) => r.name === name);
  if (!room) throw new Error(`pièce « ${name} » absente : ${sheet.detected.rooms.map((r) => r.name).join(', ')}`);
  return room;
}

/** Le rez-de-chaussée d'essai, « Séjour » renommé en un nom inconnu, l'étiquette de la cuisine vidée. */
function relabelledRdc(): ArrayBuffer {
  const text = fixtureText('fixture_rdc_cm.dxf');
  expect(text).toContain('Séjour 37,08 m²');
  expect(text).toContain('Cuisine\\P12,16 m²');
  return textBytes(text.replace('Séjour 37,08 m²', `${ODD} 37,08 m²`).replace('Cuisine\\P12,16 m²', ' '));
}

describe('pièces sans nom reconnu (DXF)', () => {
  it('le nom choisi pour le test n’est pas dans le vocabulaire', () => {
    expect(parseRoomLabel(ODD)?.name ?? null).toBeNull();
  });

  it('texte inconnu → ce texte comme nom ; aucun texte → nom vide ; les deux « à trancher », surface mesurée', async () => {
    const truth = truthOf('fixture_rdc_cm.dxf');
    const original = await readCadDetailed(textBytes(fixtureText('fixture_rdc_cm.dxf')), 'fixture_rdc_cm.dxf', 'dxf');
    const { doc } = await readCadDetailed(relabelledRdc(), 'fixture_rdc_cm.dxf', 'dxf');
    const sheet = doc.sheets[0]!;
    const before = original.doc.sheets[0]!;

    // Les quatre pièces reconnues restent identiques (nom, surfaces, proposition), le contour aussi.
    for (const name of ['Hall', 'WC', 'Buanderie', 'Garage']) expect(byName(sheet, name)).toEqual(byName(before, name));
    expect(sheet.detected.outline).toEqual(before.detected.outline);

    // Les deux autres ne disparaissent plus.
    expect(sheet.detected.rooms).toHaveLength(truth.rooms.length);
    const odd = byName(sheet, ODD);
    expect(odd).toMatchObject({ heatedGuess: 'ask', statedArea: 37.08 });
    expect(odd.measuredArea).toBeCloseTo(byName(before, 'Séjour').measuredArea!, 3);
    const blank = byName(sheet, '');
    expect(blank.heatedGuess).toBe('ask');
    expect(blank.statedArea).toBeUndefined();
    expect(blank.measuredArea).toBeCloseTo(byName(before, 'Cuisine').measuredArea!, 3);
    // Polygone et position dans le repère de la feuille, comme pour une pièce reconnue.
    const m = scaleOf(sheet);
    expect(polygonArea(blank.polygon!) * m * m).toBeCloseTo(blank.measuredArea!, 2);
    expect(blank.at).toBeDefined();

    // Surface nette totale inchangée : rien ne manque.
    const total = (s: PlanSheet): number => s.detected.rooms.reduce((sum, r) => sum + (r.measuredArea ?? 0), 0);
    expect(total(sheet)).toBeCloseTo(total(before), 3);

    // La feuille le dit, et l'avertissement « aucun nom reconnu » n'est pas émis (d'autres noms le sont).
    expect(sheet.detected.notes.join('\n')).toMatch(/2 pièce\(s\) fermée\(s\) par les murs sans nom reconnu.*« Zone Q7 », 1 sans texte/);
    expect(doc.warnings.join('\n')).not.toMatch(/Aucun nom de pièce reconnu/);
  });

  it('la note est rédigée dans la langue demandée', async () => {
    const doc = await readCad(relabelledRdc(), 'fixture_rdc_cm.dxf', 'dxf', { lang: 'de' });
    expect(doc.sheets[0]!.detected.notes.join('\n')).toMatch(/2 von Wänden umschlossene\(r\) Raum\/Räume ohne erkannten Namen.*„Zone Q7“, 1 ohne Text/);
  });

  it('plan sans aucun nom reconnu → pièces mesurées et avertissement « à nommer et à trancher »', async () => {
    // Deux pièces séparées par un mur de 30 cm, sans texte : 5,00 × 5,00 et 4,70 × 5,00.
    const entities = [...dxfRect('MUR', 0, 0, 1060, 560), ...dxfRect('MUR', 30, 30, 530, 530), ...dxfRect('MUR', 560, 30, 1030, 530)];
    const doc = await readCad(miniDxf(5, entities), 'nu.dxf', 'dxf');
    const rooms = doc.sheets[0]!.detected.rooms;
    expect(rooms.map((r) => [r.name, r.heatedGuess])).toEqual([
      ['', 'ask'],
      ['', 'ask'],
    ]);
    expect(rooms.map((r) => r.measuredArea).sort()).toEqual([23.5, 25]);
    expect(doc.warnings.join('\n')).toMatch(/Aucun nom de pièce reconnu : 2 pièce\(s\) mesurée\(s\) sur le dessin, à nommer et à trancher/);
    expect(doc.sheets[0]!.detected.notes.join('\n')).toMatch(/2 pièce\(s\).*sans nom reconnu.*2 sans texte/);
  });

  it('ni gaine de moins de 1 m², ni vide de mur, ni enceinte autour du bâtiment ne deviennent des pièces', async () => {
    const entities = [
      // Mur extérieur en deux parois séparées d'un vide de 5 cm, puis deux pièces.
      ...dxfRect('MUR', 0, 0, 1060, 560),
      ...dxfRect('MUR', 10, 10, 1050, 550),
      ...dxfRect('MUR', 15, 15, 1045, 545),
      ...dxfRect('MUR', 30, 30, 530, 530),
      ...dxfRect('MUR', 560, 30, 1030, 530),
      // Gaine maçonnée dans la seconde pièce : 0,80 × 0,80 = 0,64 m² de vide.
      ...dxfRect('MUR', 900, 400, 1000, 500),
      ...dxfRect('MUR', 910, 410, 990, 490),
      ...dxfText('TEXTE', 200, 280, 12, 'Séjour 25,00 m²'),
      ...dxfText('TEXTE', 700, 280, 12, 'Chambre 23,50 m²'),
    ];
    const doc = await readCad(miniDxf(5, entities), 'gaine.dxf', 'dxf');
    const sheet = doc.sheets[0]!;
    expect(sheet.detected.rooms.map((r) => r.name)).toEqual(['Séjour', 'Chambre']);
    expect(sheet.detected.notes.join('\n')).not.toMatch(/sans nom reconnu/);
    expect(outlineArea(sheet)).toBeCloseTo(10.6 * 5.6, 2);
  });
});

describe('rooms.ts : textes libres', () => {
  it('sépare le nom de la surface écrite', () => {
    expect(splitFreeLabel('Zone Q7 12,40 m²')).toEqual({ name: 'Zone Q7', area: 12.4 });
    expect(splitFreeLabel('2.05 Atelier')).toEqual({ name: 'Atelier', area: null });
    expect(splitFreeLabel('12,40 m²')).toEqual({ name: '', area: 12.4 });
  });

  it('écarte comme nom les cotes, échelles, hauteurs, titres de niveau et textes sans lettres', () => {
    const view = (t: string): boolean => /coupe/i.test(t);
    expect(looksLikeFreeName('Zone Q7', view)).toBe(true);
    for (const t of ['12', '1:50', 'HSP 2,50 m', 'Rez-de-chaussée', 'Coupe A-A', 'x', 'un texte bien trop long pour être un nom de pièce']) {
      expect(looksLikeFreeName(t, view)).toBe(false);
    }
  });

  it('detectRooms : une face déjà nommée n’est pas rendue deux fois ; une face hors du contour est ignorée', () => {
    const square = (x: number, y: number, s: number) => {
      const ring = [
        { x, y },
        { x: x + s, y },
        { x: x + s, y: y + s },
        { x, y: y + s },
      ];
      return { ring, area: s * s, box: { minX: x, minY: y, maxX: x + s, maxY: y + s } };
    };
    const faces = [square(0, 0, 300), square(400, 0, 300), square(5000, 0, 300)];
    const boundary = [
      { x: -30, y: -30 },
      { x: 730, y: -30 },
      { x: 730, y: 330 },
      { x: -30, y: 330 },
    ];
    const result = detectRooms({
      texts: [{ text: 'Séjour', x: 150, y: 150, layer: 0 }],
      faces,
      boundary,
      u: 100,
      tol: 1,
      isViewTitle: () => false,
    });
    expect(result.rooms.map((r) => [r.name, r.measuredArea, r.heatedGuess])).toEqual([
      ['Séjour', 9, 'yes'],
      ['', 9, 'ask'],
    ]);
    expect(result.unrecognised).toEqual(['']);
  });
});
