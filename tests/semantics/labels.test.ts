import { describe, expect, it } from 'vitest';
import {
  classifyRoomName,
  guessStorey,
  isNorthArrowName,
  looksLikeRoomName,
  parseArea,
  parseClearHeight,
  parseOpeningSize,
  parseRoomLabel,
  parseScaleText,
  roomsFromTexts,
} from '../../src/semantics/labels';

describe('parseArea', () => {
  it.each([
    ['32,45 m²', 32.45],
    ['28.10 m2', 28.1],
    ['S = 12,5m²', 12.5],
    ['Wohnzimmer 24,80 qm', 24.8],
    ['A: 7.02 m^2', 7.02],
    ['118 m²', 118],
  ])('%s → %s', (text, expected) => {
    expect(parseArea(text)).toBeCloseTo(expected);
  });

  it('ignore les textes sans surface', () => {
    expect(parseArea('Séjour')).toBeNull();
    expect(parseArea('3,45 m')).toBeNull();
    expect(parseArea('12 mm')).toBeNull();
    expect(parseArea('1:100')).toBeNull();
  });
});

describe('parseScaleText', () => {
  it.each([
    ['Échelle 1:100', 100],
    ['ECHELLE : 1/50', 50],
    ['Maßstab 1:200', 200],
    ['M 1:75', 75],
    ['1:100', 100],
    ['Plan RDC - éch. 1:20', 20],
  ])('%s → %s', (text, expected) => {
    expect(parseScaleText(text)).toBe(expected);
  });

  it('refuse les rapports qui ne sont pas des échelles', () => {
    expect(parseScaleText('21:30')).toBeNull();
    expect(parseScaleText('1:37')).toBeNull();
    expect(parseScaleText('Séjour')).toBeNull();
  });
});

describe('classement des pièces', () => {
  it.each([
    ['Séjour', 'yes'],
    ['Wohnzimmer', 'yes'],
    ['Chambre 1', 'yes'],
    ['Chambre 1 (combles)', 'yes'],
    ['Schlafzimmer', 'yes'],
    ['Küche', 'yes'],
    ['SdB', 'yes'],
    ['WC', 'yes'],
    ['Hall d’entrée', 'yes'],
    ['Flur', 'yes'],
    ['Garage', 'no'],
    ['Chaufferie', 'no'],
    ['Heizraum', 'no'],
    ['Terrasse', 'no'],
    ['Cave non chauffée', 'no'],
    ['Cave', 'ask'],
    ['Keller', 'ask'],
    ['Buanderie', 'ask'],
    ['Waschküche', 'ask'],
    ['Hobbyraum', 'ask'],
    ['Grenier', 'ask'],
    ['Local 12', 'ask'],
  ] as const)('%s → %s', (name, expected) => {
    expect(classifyRoomName(name)).toBe(expected);
  });

  it('distingue un nom de pièce d’une cote', () => {
    expect(looksLikeRoomName('Séjour')).toBe(true);
    expect(looksLikeRoomName('3,45')).toBe(false);
    expect(looksLikeRoomName('1:100')).toBe(false);
    expect(looksLikeRoomName('Plan du rez-de-chaussée')).toBe(false);
  });
});

describe('parseRoomLabel', () => {
  it('sépare nom et surface', () => {
    expect(parseRoomLabel('Séjour 32,45 m²')).toEqual({ name: 'Séjour', area: 32.45 });
    expect(parseRoomLabel('Wohnzimmer  28.10 m2')).toEqual({ name: 'Wohnzimmer', area: 28.1 });
    expect(parseRoomLabel('1.02 Cuisine S = 12,16 m²')).toEqual({ name: 'Cuisine', area: 12.16 });
    expect(parseRoomLabel('Chambre 2')).toEqual({ name: 'Chambre 2' });
  });

  it('garde une surface seule et rejette le reste', () => {
    expect(parseRoomLabel('12,16 m²')).toEqual({ name: '', area: 12.16 });
    expect(parseRoomLabel('345')).toBeNull();
    expect(parseRoomLabel('COUPE A-A')).toBeNull();
  });
});

describe('roomsFromTexts', () => {
  it('associe un nom et la surface écrite juste à côté', () => {
    const rooms = roomsFromTexts([
      { text: 'Séjour', x: 100, y: 100, height: 10 },
      { text: '32,45 m²', x: 100, y: 114, height: 10 },
      { text: 'Garage', x: 400, y: 100, height: 10 },
      { text: '18,00 m²', x: 400, y: 114, height: 10 },
      { text: 'Cuisine 12,16 m²', x: 100, y: 300, height: 10 },
      { text: '3,45', x: 250, y: 20, height: 8 },
    ]);
    expect(rooms).toHaveLength(3);
    const sejour = rooms.find((r) => r.name === 'Séjour');
    expect(sejour?.statedArea).toBeCloseTo(32.45);
    expect(sejour?.heatedGuess).toBe('yes');
    const garage = rooms.find((r) => r.name === 'Garage');
    expect(garage?.statedArea).toBeCloseTo(18);
    expect(garage?.heatedGuess).toBe('no');
    expect(rooms.find((r) => r.name === 'Cuisine')?.statedArea).toBeCloseTo(12.16);
  });

  it('ne vole pas la surface d’une pièce éloignée', () => {
    const rooms = roomsFromTexts([
      { text: 'Bureau', x: 0, y: 0, height: 10 },
      { text: '9,90 m²', x: 900, y: 900, height: 10 },
    ]);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.statedArea).toBeUndefined();
  });
});

describe('niveaux, ouvertures, nord, hauteurs', () => {
  it('reconnaît les niveaux', () => {
    expect(guessStorey('Plan du rez-de-chaussée')?.rank).toBe(0);
    expect(guessStorey('Grundriss Erdgeschoss')?.fr).toBe('Rez-de-chaussée');
    expect(guessStorey('1er étage')?.rank).toBe(1);
    expect(guessStorey('Grundriss 1. OG')?.rank).toBe(1);
    expect(guessStorey('2. Obergeschoss')?.rank).toBe(2);
    expect(guessStorey('SOUS-SOL')?.rank).toBe(-1);
    expect(guessStorey('Kellergeschoss')?.rank).toBe(-1);
    expect(guessStorey('Dachgeschoss')?.rank).toBe(9);
    expect(guessStorey('Coupe A-A')).toBeNull();
  });

  it('lit les dimensions d’ouvertures en m, cm ou mm', () => {
    expect(parseOpeningSize('1,40x1,35')).toEqual({ width: 1.4, height: 1.35 });
    expect(parseOpeningSize('F 120/135')).toEqual({ width: 1.2, height: 1.35 });
    expect(parseOpeningSize('PORTE 90 x 210')).toEqual({ width: 0.9, height: 2.1 });
    expect(parseOpeningSize('1260x1385')).toEqual({ width: 1.26, height: 1.385 });
    expect(parseOpeningSize('A-A')).toBeNull();
    expect(parseOpeningSize('1/2')).toBeNull();
  });

  it('reconnaît une flèche du nord', () => {
    expect(isNorthArrowName('NORD')).toBe(true);
    expect(isNorthArrowName('Nordpfeil')).toBe(true);
    expect(isNorthArrowName('fleche_nord')).toBe(true);
    expect(isNorthArrowName('A-ANNO-NORTH')).toBe(true);
    expect(isNorthArrowName('Nordwand')).toBe(false);
  });

  it('lit une hauteur sous plafond', () => {
    expect(parseClearHeight('HSP 2,50')).toBeCloseTo(2.5);
    expect(parseClearHeight('lichte Raumhöhe = 2.55 m')).toBeCloseTo(2.55);
    expect(parseClearHeight('Séjour')).toBeNull();
  });
});
