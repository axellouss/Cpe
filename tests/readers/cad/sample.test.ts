/**
 * Le plan d'exemple livré avec l'application (public/samples/maison-exemple.dxf) doit se lire sans aucun
 * avertissement gênant : c'est la première chose que voit un nouvel utilisateur.
 * En option : fichiers réels de tiers, hors dépôt (variable d'environnement PLAN2CPE_CAD_SAMPLES).
 */
import { describe, expect, it } from 'vitest';
import { isSelfIntersecting } from '../../../src/core/geometry';
import { readCad, readCadDetailed } from '../../../src/readers/cad';
import { bytesOf, fileExists, outlineArea, realSamplesDir, sampleBytes, sortedWidths } from './helpers';

describe('public/samples/maison-exemple.dxf', () => {
  it('donne deux feuilles complètes : rez-de-chaussée et étage', async () => {
    const doc = await readCad(sampleBytes('maison-exemple.dxf'), 'maison-exemple.dxf', 'dxf');
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    expect(doc.storeysAligned).toBe(false);
    expect(doc.northAngle).toMatchObject({ value: 340, from: 'plan' });
    // Seul avertissement : l'information « deux plans dans le même dessin ».
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/2 plans trouvés/);

    const [rdc, etage] = doc.sheets;
    for (const sheet of doc.sheets) {
      expect(sheet.metresPerUnit).toMatchObject({ value: 0.01, from: 'plan' });
      expect(isSelfIntersecting(sheet.detected.outline!)).toBe(false);
    }
    expect(outlineArea(rdc!)).toBeCloseTo(96, 1);
    expect(outlineArea(etage!)).toBeCloseTo(80, 1);

    expect(rdc!.detected.rooms.map((r) => [r.name, r.statedArea, r.heatedGuess])).toEqual([
      ['Séjour', 37.08, 'yes'],
      ['Cuisine', 11.31, 'yes'],
      ['Hall', 8.38, 'yes'],
      ['WC', 2.4, 'yes'],
      ['Buanderie', 4.53, 'ask'],
      ['Garage', 13.24, 'no'],
    ]);
    expect(etage!.detected.rooms.map((r) => r.name)).toEqual(['Chambre 1', 'Chambre 2', 'Dégagement', 'Chambre 3', 'Salle de bain', 'Bureau']);
    // Exemple « propre » : chaque surface écrite correspond à la géométrie.
    for (const sheet of doc.sheets) {
      for (const room of sheet.detected.rooms) expect(Math.abs(room.measuredArea! - room.statedArea!)).toBeLessThan(0.01);
      expect(sheet.detected.notes.join('\n')).not.toMatch(/m² écrits/);
    }

    expect(sortedWidths(rdc!.detected.openings, 'window')).toEqual([0.6, 0.8, 1.2, 1.2, 1.6, 2.4]);
    expect(sortedWidths(rdc!.detected.openings, 'door')).toEqual([1, 2.5]);
    expect(sortedWidths(etage!.detected.openings, 'window')).toEqual([0.8, 0.8, 1, 1, 1.2, 1.4, 1.4]);
    for (const sheet of doc.sheets) {
      for (const o of sheet.detected.openings.filter((x) => x.kind === 'window')) expect(o.height).toBeGreaterThan(0.5);
    }
  });
});

// Fichiers réels de tiers : vérification locale seulement, ils ne sont pas dans le dépôt.
const dir = realSamplesDir();
const floorplan = dir ? `${dir}/probe/floorplan_sky.dxf` : '';
const canteen = dir ? `${dir}/real/mlight_canteen.dwg` : '';

describe.skipIf(!dir || !fileExists(floorplan))('fichier réel : floorplan.dxf (maison américaine, en-tête mm mais dessin en pouces)', () => {
  it('choisit les pouces malgré l’en-tête, trouve le calque des murs derrière le préfixe de xref, propose un contour à vérifier', async () => {
    const { doc, details } = await readCadDetailed(bytesOf(floorplan), 'floorplan.dxf', 'dxf');
    expect(doc.sheets).toHaveLength(1);
    const sheet = doc.sheets[0]!;
    expect(sheet.metresPerUnit).toMatchObject({ value: 0.0254, from: 'estimate' });
    expect(sheet.metresPerUnit!.note).toMatch(/pouces retenus/);
    expect(details.wallLayers).toEqual(['xref-Bishop-Overland-08$0$A-WALL']);
    expect(isSelfIntersecting(sheet.detected.outline!)).toBe(false);
    // Emprise réelle d'environ 190 m² (maison + garage) ; la terrasse couverte est englobée à tort.
    expect(outlineArea(sheet)).toBeGreaterThan(180);
    expect(outlineArea(sheet)).toBeLessThan(230);
    expect(doc.warnings.join('\n')).toMatch(/contour approché/);
    expect(sortedWidths(sheet.detected.openings, 'door')).toEqual([4.88]); // porte de garage 16'
    expect(sheet.detected.openings.filter((o) => o.kind === 'window').length).toBeGreaterThanOrEqual(6);
    expect(doc.northAngle).toBeUndefined();
  });
});

describe.skipIf(!dir || !fileExists(canteen))('fichier réel : canteen.dwg (2,6 Mo, 25 000 entités, plan + façades dans le même espace objet)', () => {
  it('lit le fichier, propose l’emprise du bâtiment et allège l’affichage', async () => {
    const { doc, details } = await readCadDetailed(bytesOf(canteen), 'canteen.dwg', 'dwg');
    expect(details.entities).toBe(25123);
    expect(details.segments).toBeGreaterThan(300_000);
    expect(doc.sheets).toHaveLength(1);
    const sheet = doc.sheets[0]!;
    expect(sheet.metresPerUnit).toMatchObject({ value: 0.001, from: 'plan' });
    expect(details.wallLayers).toEqual(['Wall']);
    expect(sheet.segments!.length / 4).toBeLessThanOrEqual(150_000);
    expect(doc.warnings.join('\n')).toMatch(/affichage allégé/);
    expect(isSelfIntersecting(sheet.detected.outline!)).toBe(false);
    expect(outlineArea(sheet)).toBeGreaterThan(850);
    expect(outlineArea(sheet)).toBeLessThan(980);
    // Pièces numérotées renvoyant à une légende : aucun nom reconnu, mais chaque pièce fermée est rendue,
    // sans nom, « à trancher », avec sa surface mesurée.
    const rooms = sheet.detected.rooms;
    expect(rooms.length).toBeGreaterThan(15);
    for (const room of rooms) {
      expect(room).toMatchObject({ name: '', heatedGuess: 'ask' });
      expect(room.measuredArea).toBeGreaterThanOrEqual(1);
    }
    expect(rooms.reduce((sum, r) => sum + r.measuredArea!, 0)).toBeLessThan(outlineArea(sheet));
    expect(doc.warnings.join('\n')).toMatch(/Aucun nom de pièce reconnu : \d+ pièce\(s\) mesurée\(s\)/);
    expect(sheet.detected.openings.length).toBeGreaterThan(25);
  }, 60_000);
});
