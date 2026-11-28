/**
 * Pièces écrites sur les plans (nom + ligne de surface) et encadrés d'éclairement. Textes inventés.
 */
import { describe, expect, it } from 'vitest';
import { classifyRoomName, glazingBoxes, roomNameOf, roomsFromLines } from '../../src/semantics/labels';
import { box, lines, mk, split, sup, view } from './lines';

const plan = view('plan', 'floor-plan', box(0, 0, 500, 500), { storeyRank: 0 });

describe('vocabulaire', () => {
  it('salle de douche et SdD sont des pièces chauffées', () => {
    expect(classifyRoomName('SdD')).toBe('yes');
    expect(classifyRoomName('S.d.D.')).toBe('yes');
    expect(classifyRoomName('Salle de douche')).toBe('yes');
    // Inchangé : un local technique n'est pas compté d'office (la géométrie tranche).
    expect(classifyRoomName('Local technique')).toBe('no');
  });
});

describe('roomsFromLines', () => {
  it('nom au-dessus d’une ligne de surface, aligné à gauche ou centré ; FR et DE', () => {
    const wc = mk('S: 1,95 m', 250, 137);
    const rooms = roomsFromLines(
      lines([mk('Wohnen/Essen', 120, 130), mk('F: 32,50 m²', 120, 137), mk('Kind 1', 200, 130), mk('NF = 12,10 m²', 196, 137), mk('Salle de douche', 250, 130), wc, sup(wc, '2'), mk('Keller', 350, 130), mk('22,62 m²', 349, 137)]),
      [plan],
    ).sort((a, b) => a.at.x - b.at.x);
    expect(rooms.map((r) => [r.name, r.statedArea, r.heatedGuess])).toEqual([
      ['Wohnen/Essen', 32.5, 'yes'],
      ['Kind 1', 12.1, 'yes'],
      ['Salle de douche', 1.95, 'yes'],
      ['Keller', 22.62, 'ask'],
    ]);
    expect(rooms.every((r) => r.viewId === 'plan' && r.page === 1)).toBe(true);
    expect(rooms[3]!.doubt).toMatch(/comptée dans An/);
    expect(rooms[3]!.confidence).toBeLessThan(0.65);
    expect(rooms[0]!.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it('garage et terrasse : hors enveloppe ; la terrasse est un espace extérieur', () => {
    const rooms = roomsFromLines(lines([mk('Garage', 10, 10), mk('S: 16,00 m²', 10, 17), mk('Terrasse', 100, 10), mk('S: 20,00 m²', 100, 17)]), [plan]);
    expect(rooms.map((r) => [r.name, r.outsideEnvelope, r.exterior])).toEqual([['Garage', true, false], ['Terrasse', true, true]]);
  });

  it('un local technique est signalé : dans l’isolation ou dehors ?', () => {
    const [r] = roomsFromLines(lines([mk('Local technique', 10, 10), mk('S: 4,80 m²', 10, 17)]), [plan], 'de');
    expect(r!.heatedGuess).toBe('no');
    expect(r!.outsideEnvelope).toBe(false);
    expect(r!.doubt).toMatch(/Technikraum/);
  });

  it('au sous-sol, un dégagement n’est pas compté d’office : question', () => {
    const kg = view('kg', 'floor-plan', box(0, 0, 500, 500), { storeyRank: -1 });
    const [r] = roomsFromLines(lines([mk('Vorraum', 10, 10), mk('3,81 m²', 10, 17)]), [kg]);
    expect(r!.heatedGuess).toBe('ask');
    expect(r!.doubt).toMatch(/sous-sol/);
  });

  it('les lignes d’un encadré d’éclairement ne créent jamais de pièce', () => {
    const texts = [
      mk('Surface vitrée :', 120, 200), mk('6,20m²', 160, 200),
      mk('Surface séjour :', 120, 206), mk('32,50m²', 160, 206),
      mk('Coefficient selon règlement', 120, 212),
      mk('1/8 surface du plancher :', 120, 218), mk('4,06m²', 185, 218),
    ];
    expect(roomsFromLines(lines(texts), [plan])).toEqual([]);
  });

  it('repli : « Séjour 28,40 m² » sur une seule ligne ; une ligne découpée par caractère est recollée', () => {
    const rooms = roomsFromLines(lines([...split(mk('Séjour 28,40 m²', 10, 10), 'char'), mk('Total 140,00 m²', 10, 60)]), [plan]);
    expect(rooms.map((r) => [r.name, r.statedArea])).toEqual([['Séjour', 28.4]]);
  });

  it('roomNameOf refuse les repères, niveaux et intitulés', () => {
    expect(roomNameOf('F1')).toBeNull();
    expect(roomNameOf('NF +3,10')).toBeNull();
    expect(roomNameOf('Surface séjour :')).toBeNull();
    expect(roomNameOf('1.02 Chambre 2')).toBe('Chambre 2');
  });
});

describe('glazingBoxes', () => {
  it('lit la surface vitrée, la surface de la pièce et l’exigence, sans créer de pièce', () => {
    const texts = [
      mk('Surface vitrée :', 120, 200), mk('6,20m²', 160, 200),
      mk('Surface séjour :', 120, 206), mk('32,50m²', 160, 206),
      mk('Coefficient selon règlement', 120, 212),
      mk('1/8 surface du plancher :', 120, 218), mk('4,06m²', 185, 218),
      // Encadré suivant, juste en dessous : il ne se mélange pas au premier.
      mk('Surface vitrée : 2,10m²', 120, 230), mk('Surface chambre : 12,00m²', 120, 236), mk('1/8 surface du plancher : 1,50m²', 120, 242),
    ];
    expect(glazingBoxes(lines(texts), [plan])).toEqual([
      { viewId: 'plan', room: 'séjour', glazedArea: 6.2, floorArea: 32.5, required: 4.06, page: 1, at: expect.any(Object) as unknown },
      { viewId: 'plan', room: 'chambre', glazedArea: 2.1, floorArea: 12, required: 1.5, page: 1, at: expect.any(Object) as unknown },
    ]);
  });
});
