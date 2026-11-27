/**
 * Orientation : `northAngle` est l'azimut vers lequel pointe le HAUT de la feuille (0 = nord en haut, 90 = est en haut).
 * LuxEeB-Tool classe chaque façade dans l'un des 8 secteurs de 45° (N couvre de 337,5° à 22,5°).
 */
import { describe, expect, it } from 'vitest';
import { deriveSheets } from '../../src/engine';
import { NORTH, SOUTH, brief, codes, project, rect, storey, windowAt } from './helpers';

/** Boîte 10 × 8 m ; la façade tracée en HAUT du plan porte une fenêtre, celle du BAS une baie. */
function boxWithNorth(angle: number) {
  const p = project([
    storey('rdc', 'RDC', rect(10, 8), { netArea: 64, openings: [windowAt(NORTH, 1.2, 1.35), windowAt(SOUTH, 3, 2.2)] }),
  ]);
  p.model.northAngle = { value: angle, from: 'user' };
  return p;
}

const wallsAndWindows = (angle: number) =>
  deriveSheets(boxWithNorth(angle), 'fr')
    .envelope.filter((r) => r.orientation !== 'H')
    .map(brief);

describe('rotation du nord', () => {
  it('nord en haut : haut du plan = N, droite = E, bas = S, gauche = O', () => {
    expect(wallsAndWindows(0)).toEqual([
      'window N 1 × 1.20 × 1.35 Abzug',
      'wall N 1 × 10.00 × 2.80',
      'wall E 1 × 8.00 × 2.80',
      'window S 1 × 3.00 × 2.20 Abzug',
      'wall S 1 × 10.00 × 2.80',
      'wall W 1 × 8.00 × 2.80',
    ]);
  });

  it('haut du plan vers l’est (90°) : tout tourne d’un quart de tour, et l’ordre des lignes suit', () => {
    // La façade du haut regarde l'est, celle de droite le sud, celle du bas l'ouest, celle de gauche le nord
    expect(wallsAndWindows(90)).toEqual([
      'wall N 1 × 8.00 × 2.80',
      'window E 1 × 1.20 × 1.35 Abzug',
      'wall E 1 × 10.00 × 2.80',
      'wall S 1 × 8.00 × 2.80',
      'window W 1 × 3.00 × 2.20 Abzug',
      'wall W 1 × 10.00 × 2.80',
    ]);
  });

  it('haut du plan vers le sud (180°) : la baie du bas du plan regarde le nord', () => {
    expect(wallsAndWindows(180).slice(0, 2)).toEqual(['window N 1 × 3.00 × 2.20 Abzug', 'wall N 1 × 10.00 × 2.80']);
  });

  it('45° : les quatre façades tombent dans les secteurs intermédiaires', () => {
    expect(wallsAndWindows(45)).toEqual([
      'window NE 1 × 1.20 × 1.35 Abzug',
      'wall NE 1 × 10.00 × 2.80',
      'wall SE 1 × 8.00 × 2.80',
      'window SW 1 × 3.00 × 2.20 Abzug',
      'wall SW 1 × 10.00 × 2.80',
      'wall NW 1 × 8.00 × 2.80',
    ]);
  });

  it('la limite entre N et NE est à 22,5° : 22° reste N, 23° passe NE', () => {
    /** Secteur de la façade tracée en haut du plan (celle qui porte la fenêtre de 1,20 m). */
    const topFacade = (angle: number) =>
      deriveSheets(boxWithNorth(angle), 'fr').envelope.find((r) => r.kind === 'window' && r.length === 1.2)!.orientation;
    expect(topFacade(22)).toBe('N');
    expect(topFacade(23)).toBe('NE');
    expect(topFacade(67)).toBe('NE');
    expect(topFacade(68)).toBe('E');
    // De l'autre côté : 338° (= −22°) est encore N, 337° (= −23°) est NO ; un angle négatif est accepté
    expect(topFacade(338)).toBe('N');
    expect(topFacade(337)).toBe('NW');
    expect(topFacade(-23)).toBe('NW');
    expect(topFacade(360 + 23)).toBe('NE');
  });

  it('signale les façades à moins de 5° d’une limite de secteur, avec leur longueur', () => {
    const d = deriveSheets(boxWithNorth(20), 'fr');
    // Azimuts des 4 façades : 20°, 110°, 200°, 290° → toutes à 2,5° d'une limite (22,5° ; 112,5° ; 202,5° ; 292,5°)
    expect(d.findings.filter((f) => f.code === 'orientation.borderline')).toEqual([
      { code: 'orientation.borderline', severity: 'info', params: { length: '10,00', azimuth: '20', orientation: 'Nord', other: 'Nord-Est' } },
      { code: 'orientation.borderline', severity: 'info', params: { length: '8,00', azimuth: '110', orientation: 'Est', other: 'Sud-Est' } },
      { code: 'orientation.borderline', severity: 'info', params: { length: '10,00', azimuth: '200', orientation: 'Sud', other: 'Sud-Ouest' } },
      { code: 'orientation.borderline', severity: 'info', params: { length: '8,00', azimuth: '290', orientation: 'Ouest', other: 'Nord-Ouest' } },
    ]);
    // À 10° de la limite, plus rien
    expect(codes(deriveSheets(boxWithNorth(12), 'fr'))).not.toContain('orientation.borderline');
    // Juste de l'autre côté de la limite : classée NE, limite avec N
    const other = deriveSheets(boxWithNorth(25), 'de').findings.find((f) => f.code === 'orientation.borderline');
    expect(other!.params).toMatchObject({ orientation: 'Nordost', other: 'Nord' });
  });

  it('additionne les façades parallèles de tous les niveaux dans un seul message', () => {
    const p = boxWithNorth(20);
    p.model.storeys.push(storey('etage', 'Étage', rect(10, 8), { netArea: 64 }));
    const first = deriveSheets(p, 'fr').findings.find((f) => f.code === 'orientation.borderline');
    expect(first!.params.length).toBe('20,00');
  });

  it('un contour tourné sur la feuille donne le même résultat qu’un nord tourné', () => {
    // Le même rectangle 10 × 8 dessiné tourné de 30° dans le sens horaire à l'écran, nord en haut :
    // la façade « du haut » regarde alors l'azimut 30° → NE
    const a = (30 * Math.PI) / 180;
    const turned = rect(10, 8).map((p) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }));
    const p = boxWithNorth(0);
    p.model.storeys[0]!.outline = turned;
    const rows = deriveSheets(p, 'fr').envelope.filter((r) => r.orientation !== 'H').map(brief);
    expect(rows).toEqual(wallsAndWindows(30));
    expect(rows[1]).toBe('wall NE 1 × 10.00 × 2.80');
  });
});
