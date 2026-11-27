/**
 * Briques pures du lecteur DWG / DXF : décodage des textes, classement des calques, vote de l'unité,
 * géométrie (fermeture, simplification), messages FR / DE.
 */
import { describe, expect, it } from 'vitest';
import { knownKeys, t } from '../../../src/i18n';
import { classifyLayer, normalizeLayerName } from '../../../src/readers/cad/layers';
import { restoreClassNames } from '../../../src/readers/cad/load';
import { CAD_MESSAGES } from '../../../src/readers/cad/messages';
import { closeOutline, polygonizeSegments, ringArea, simplifyRing } from '../../../src/readers/cad/planar';
import type { Seg } from '../../../src/readers/cad/planar';
import { decodeMText, decodeText } from '../../../src/readers/cad/text';
import { chooseUnit, nearestUnit, unitDef, wallThicknessEvidence } from '../../../src/readers/cad/units';
import { buildWalls, clusterEndpoints, parallelPairScore } from '../../../src/readers/cad/walls';

const rect = (x0: number, y0: number, x1: number, y1: number): Seg[] => [
  { ax: x0, ay: y0, bx: x1, by: y0 },
  { ax: x1, ay: y0, bx: x1, by: y1 },
  { ax: x1, ay: y1, bx: x0, by: y1 },
  { ax: x0, ay: y1, bx: x0, by: y0 },
];

describe('décodage des textes', () => {
  it('TEXT : codes %% et \\U+', () => {
    expect(decodeText('%%uMASTER BEDROOM%%u')).toBe('MASTER BEDROOM');
    expect(decodeText('45%%d')).toBe('45°');
    expect(decodeText('%%c120 %%p0.5')).toBe('⌀120 ±0.5');
    expect(decodeText('S\\U+00E9jour 32 m\\U+00B2')).toBe('Séjour 32 m²');
    expect(decodeText('  Hall   \t d’entrée ')).toBe('Hall d’entrée');
  });

  it('MTEXT : sauts de ligne, polices, empilements, accolades', () => {
    expect(decodeMText('Cuisine\\P12,16 m²')).toBe('Cuisine\n12,16 m²');
    expect(decodeMText('{\\fArial|b1|i0|c0|p34;WC}\\P2,40 m2')).toBe('WC\n2,40 m2');
    expect(decodeMText('\\A1;\\H2.5x;\\C1;Chambre 1')).toBe('Chambre 1');
    expect(decodeMText('{\\LSéjour\\l}\\~32,45 m\\S2^;')).toBe('Séjour 32,45 m2/');
    expect(decodeMText('1\\S1/2;"')).toBe('11/2"');
    expect(decodeMText('a\\\\b \\{c\\}')).toBe('a\\b {c}');
    expect(decodeMText('\\pxqc;Bad\\P\\P5,43 qm')).toBe('Bad\n\n5,43 qm');
    expect(decodeMText('')).toBe('');
  });
});

describe('classement des calques par leur nom', () => {
  it('reconnaît les murs en français, allemand, anglais et AIA', () => {
    for (const name of ['MUR', 'Murs porteurs', 'Wand', 'Aussenwand', 'A-WALL', 'A-WALL-FULL', 'WALLS', 'Mauerwerk', 'Cloisons', 'GROS_OEUVRE', '01_Wände']) {
      expect(classifyLayer(name), name).toBe('wall');
    }
  });

  it('retire les préfixes de xref (liés ou attachés)', () => {
    expect(normalizeLayerName('xref-Bishop-Overland-08$0$A-WALL')).toBe('a wall');
    expect(classifyLayer('xref-Bishop-Overland-08$0$A-WALL')).toBe('wall');
    expect(classifyLayer('plan_rdc|MUR')).toBe('wall');
  });

  it('ne prend pas pour des murs les hachures, fondations, toitures et cotes qui en portent le nom', () => {
    expect(classifyLayer('MUR-HACHURE')).toBe('hatch');
    expect(classifyLayer('Wand_Schraffur')).toBe('hatch');
    expect(classifyLayer('S-STEM-WALL')).toBe('foundation');
    expect(classifyLayer('A-WALL-PATT')).toBe('hatch');
    expect(classifyLayer('Cotation murs')).toBe('dim');
  });

  it('reconnaît portes, fenêtres, textes, cartouche, axes, mobilier', () => {
    expect(classifyLayer('PORTE')).toBe('door');
    expect(classifyLayer('Tuer')).toBe('door');
    expect(classifyLayer('Türen')).toBe('door');
    expect(classifyLayer('A-DOOR')).toBe('door');
    expect(classifyLayer('FENETRE')).toBe('window');
    expect(classifyLayer('Fenster')).toBe('window');
    expect(classifyLayer('A-GLAZ')).toBe('window');
    expect(classifyLayer('Text_Raum')).toBe('text');
    expect(classifyLayer('CARTOUCHE')).toBe('frame');
    expect(classifyLayer('Plankopf')).toBe('frame');
    expect(classifyLayer('Achsen')).toBe('axis');
    expect(classifyLayer('MOBILIER')).toBe('furniture');
    expect(classifyLayer('ESCALIER')).toBe('stair');
    expect(classifyLayer('Calque5')).toBeNull();
    expect(classifyLayer('0')).toBeNull();
  });

  it('classe aussi les noms de blocs (« FENETRE », « PORTE_90 », « Fenster 1,40x1,35 »)', () => {
    expect(classifyLayer('FENETRE')).toBe('window');
    expect(classifyLayer('PORTE_90')).toBe('door');
    expect(classifyLayer('Fenster 1,40x1,35')).toBe('window');
    expect(classifyLayer('Tuer_80')).toBe('door');
    expect(classifyLayer('LIT_160')).toBeNull();
  });
});

describe('unité', () => {
  it('unité standard la plus proche', () => {
    expect(unitDef(1000).metres).toBe(0.001);
    expect(unitDef(39.37).metres).toBe(0.0254);
    expect(nearestUnit(98)).toBe(100);
    expect(nearestUnit(1040)).toBe(1000);
    expect(nearestUnit(300)).toBeNull();
  });

  it('vote : la majorité pondérée l’emporte, l’en-tête seul perd contre la géométrie', () => {
    expect(chooseUnit([])).toEqual({ perMetre: null, agreed: false });
    const header = { source: 'header' as const, perMetre: 1000, weight: 1, detail: '' };
    const doors = { source: 'doors' as const, perMetre: 100, weight: 2, detail: '' };
    const walls = { source: 'walls' as const, perMetre: 100, weight: 1, detail: '' };
    expect(chooseUnit([header]).perMetre).toBe(1000);
    expect(chooseUnit([header, doors])).toEqual({ perMetre: 100, agreed: false });
    expect(chooseUnit([header, walls]).perMetre).toBe(100);
    expect(chooseUnit([doors, walls])).toEqual({ perMetre: 100, agreed: true });
  });

  it('épaisseur des murs : 30 unités entre les deux faces → cm ; 300 → mm ; 0,3 → m', () => {
    const walls = (k: number): Seg[] => [...rect(0, 0, 1000 * k, 800 * k), ...rect(30 * k, 30 * k, 970 * k, 770 * k)];
    expect(wallThicknessEvidence(walls(1))).toMatchObject({ source: 'walls', perMetre: 100 });
    expect(wallThicknessEvidence(walls(10))).toMatchObject({ perMetre: 1000 });
    expect(wallThicknessEvidence(walls(0.01))).toMatchObject({ perMetre: 1 });
    // Des traits sans jumeau ne votent pas.
    expect(wallThicknessEvidence(rect(0, 0, 1000, 800))).toBeNull();
  });

  it('indice « doubles traits » : part des traits ayant un jumeau à l’épaisseur d’un mur', () => {
    const walls = [...rect(0, 0, 1000, 800), ...rect(30, 30, 970, 770)];
    expect(parallelPairScore(walls, 100).share).toBeCloseTo(1, 5);
    expect(parallelPairScore(rect(0, 0, 1000, 800), 100).share).toBe(0);
  });
});

describe('géométrie', () => {
  it('fermeture : referme les ouvertures plus étroites que 2r et rend le bord extérieur exact', () => {
    // Carré de 10 × 8 m dont le côté sud a une ouverture de 2 m (unités : cm).
    const segs: Seg[] = [
      { ax: 0, ay: 0, bx: 400, by: 0 },
      { ax: 600, ay: 0, bx: 1000, by: 0 },
      { ax: 1000, ay: 0, bx: 1000, by: 800 },
      { ax: 1000, ay: 800, bx: 0, by: 800 },
      { ax: 0, ay: 800, bx: 0, by: 0 },
    ];
    const closed = closeOutline(segs, [], 125);
    expect(closed).toHaveLength(1);
    expect(ringArea(closed[0]!)).toBeCloseTo(800_000, -1);
    // Rayon trop petit : l'ouverture reste ouverte, il ne reste qu'un liseré sans surface.
    const open = closeOutline(segs, [], 25);
    expect(open.every((r) => ringArea(r) < 10_000)).toBe(true);
    expect(closeOutline([], [], 10)).toEqual([]);
  });

  it('fermeture : insensible aux extrémités mal accrochées (écarts de 2 cm)', () => {
    const segs: Seg[] = [
      { ax: 2, ay: 1, bx: 998, by: -1 },
      { ax: 1000, ay: 2, bx: 1001, by: 799 },
      { ax: 999, ay: 801, bx: 1, by: 800 },
      { ax: -1, ay: 798, bx: 0, by: 2 },
    ];
    const rings = closeOutline(segs, [], 25);
    expect(rings).toHaveLength(1);
    expect(Math.abs(ringArea(rings[0]!) - 800_000) / 800_000).toBeLessThan(0.005);
  });

  it('simplification : retire les sommets alignés, garde les coins', () => {
    const ring = [
      { x: 0, y: 0 }, { x: 5, y: 0.001 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 10, y: 8 }, { x: 5, y: 8.002 }, { x: 0, y: 8 }, { x: 0, y: 3 },
    ];
    const simple = simplifyRing(ring, 0.01);
    expect(simple).toHaveLength(4);
    expect(ringArea(simple)).toBeCloseTo(80, 6);
  });

  it('découpe et faces : deux carrés qui se chevauchent donnent trois faces', () => {
    const { faces } = polygonizeSegments([...rect(0, 0, 10, 10), ...rect(5, 5, 15, 15)], 0.001);
    expect(faces.map((f) => Math.round(ringArea(f.outer))).sort((a, b) => a - b)).toEqual([25, 75, 75]);
  });

  it('regroupe les extrémités proches et supprime les doublons', () => {
    const merged = clusterEndpoints(
      [
        { ax: 0, ay: 0, bx: 100, by: 0 },
        { ax: 100.4, ay: 0.3, bx: 100, by: 50 },
        { ax: 100, ay: 0, bx: 0, by: 0 }, // doublon inversé
        { ax: 7, ay: 7, bx: 7.2, by: 7.1 }, // segment nul après regroupement
      ],
      1,
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]!.bx).toBeCloseTo(merged[1]!.ax, 9);
    expect(merged[0]!.by).toBeCloseTo(merged[1]!.ay, 9);
  });

  it('murs pleins et tableaux : une pièce avec une porte donne un pont de la largeur de la porte', () => {
    // Pièce 5 × 4 m intérieur, murs 30 cm, porte de 90 cm dans le mur sud avec ses tableaux (unités : cm).
    const segs: Seg[] = [
      { ax: 0, ay: 0, bx: 200, by: 0 }, { ax: 290, ay: 0, bx: 560, by: 0 },
      { ax: 30, ay: 30, bx: 200, by: 30 }, { ax: 290, ay: 30, bx: 530, by: 30 },
      { ax: 200, ay: 0, bx: 200, by: 30 }, { ax: 290, ay: 0, bx: 290, by: 30 },
      { ax: 560, ay: 0, bx: 560, by: 460 }, { ax: 560, ay: 460, bx: 0, by: 460 }, { ax: 0, ay: 460, bx: 0, by: 0 },
      { ax: 530, ay: 30, bx: 530, by: 430 }, { ax: 530, ay: 430, bx: 30, by: 430 }, { ax: 30, ay: 430, bx: 30, by: 30 },
    ];
    const walls = buildWalls(segs, [], [], 100);
    expect(walls.solids).toHaveLength(1);
    expect(walls.bridges).toHaveLength(1);
    expect(walls.bridges[0]!.width).toBeCloseTo(90, 6);
    expect(walls.bridges[0]!.thick).toBeCloseTo(30, 6);
    expect(walls.freeJambs).toHaveLength(0);
    expect(walls.comps).toHaveLength(1);
    expect(walls.comps[0]!.holes).toHaveLength(1);
    expect(ringArea(walls.comps[0]!.holes[0]!)).toBeCloseTo(500 * 400, 3);
    expect(ringArea(walls.comps[0]!.outer)).toBeCloseTo(560 * 460, 3);
  });
});

describe('noms de classes d’acad-ts après minification', () => {
  it('réattribue le nom d’export aux classes dont le nom a été raccourci, sans toucher aux autres', () => {
    class Shortened {}
    Object.defineProperty(Shortened, 'name', { value: 'a', configurable: true });
    class Anonymous {}
    Object.defineProperty(Anonymous, 'name', { value: '', configurable: true });
    class RealName {}
    class Arc {}
    const restored = restoreClassNames({ LwPolyline: Shortened, Layer: Anonymous, Alias: RealName, Arc, notAClass: 42, text: 'x' });
    expect(restored).toBe(2);
    expect(Shortened.name).toBe('LwPolyline');
    expect(Anonymous.name).toBe('Layer');
    expect(RealName.name).toBe('RealName'); // alias d'export : vrai nom conservé
    expect(Arc.name).toBe('Arc');
  });
});

describe('messages', () => {
  it('chaque message existe en français et en allemand, avec les mêmes variables', () => {
    const fr = Object.keys(CAD_MESSAGES.fr).sort();
    const de = Object.keys(CAD_MESSAGES.de).sort();
    expect(de).toEqual(fr);
    const vars = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const key of fr) expect(vars(CAD_MESSAGES.de[key]!), key).toEqual(vars(CAD_MESSAGES.fr[key]!));
    for (const key of fr) expect(key.startsWith('cad.')).toBe(true);
  });

  it('les messages sont enregistrés dans le dictionnaire commun', () => {
    expect(knownKeys('fr')).toContain('cad.warn.north.none');
    expect(knownKeys('de')).toContain('cad.warn.north.none');
    expect(t('de', 'cad.unit.cm')).toBe('Zentimeter');
    expect(t('fr', 'cad.sheet.plan', { n: 2 })).toBe('Plan 2');
  });
});
