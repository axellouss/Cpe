/**
 * Cas limites du lecteur DWG / DXF sur de petits DXF écrits à la main : unité (indices concordants, contradictoires,
 * absents), fichiers illisibles ou vides, calques masqués, plans multiples, vues qui ne sont pas des plans.
 */
import { describe, expect, it } from 'vitest';
import { polygonArea } from '../../../src/core/geometry';
import { MAX_DISPLAY_SEGMENTS, readCad, readCadDetailed, thinSegments } from '../../../src/readers/cad';
import { SEG_HATCH, SEG_LINE, dxfOffLayers, readDrawing } from '../../../src/readers/cad/load';
import { dxfLine, dxfRect, dxfText, miniDxf, oneRoom, outlineArea, textBytes } from './helpers';

const noPause = async (): Promise<void> => {};

describe('unité du dessin', () => {
  it('en-tête, épaisseur des murs et surface écrite concordants → provenance « plan »', async () => {
    const { doc, details } = await readCadDetailed(miniDxf(5, oneRoom(1)), 'mini.dxf', 'dxf');
    const scale = doc.sheets[0]!.metresPerUnit!;
    expect(scale).toMatchObject({ value: 0.01, from: 'plan' });
    expect(details.unitEvidence.map((e) => e.source).sort()).toEqual(['areas', 'header', 'walls']);
    expect(outlineArea(doc.sheets[0]!)).toBeCloseTo(4.6 * 5.6, 2);
    expect(doc.sheets[0]!.detected.rooms[0]).toMatchObject({ name: 'Séjour', statedArea: 20, measuredArea: 20, heatedGuess: 'yes' });
  });

  it('en-tête faux (mm annoncés, dessin en cm) → cm retenus, provenance « estimate » et explication', async () => {
    const { doc } = await readCadDetailed(miniDxf(4, oneRoom(1)), 'mini.dxf', 'dxf');
    const scale = doc.sheets[0]!.metresPerUnit!;
    expect(scale.value).toBeCloseTo(0.01, 10);
    expect(scale.from).toBe('estimate');
    expect(scale.note).toMatch(/Indices contradictoires/);
    expect(scale.note).toMatch(/en-tête du fichier : millimètres/);
    expect(scale.note).toMatch(/centimètres retenus/);
    expect(doc.warnings).toContain(scale.note);
    // La géométrie est quand même analysée avec la bonne unité.
    expect(doc.sheets[0]!.detected.rooms[0]!.measuredArea).toBeCloseTo(20, 2);
  });

  it('dessin en mètres sans unité dans l’en-tête → mètres d’après les murs et la surface écrite', async () => {
    const { doc } = await readCadDetailed(miniDxf(0, oneRoom(0.01)), 'mini.dxf', 'dxf');
    expect(doc.sheets[0]!.metresPerUnit).toMatchObject({ value: 1, from: 'plan' });
    expect(outlineArea(doc.sheets[0]!)).toBeCloseTo(4.6 * 5.6, 2);
  });

  it('un seul indice (en-tête, sans murs ni étiquette) → « estimate », à confirmer', async () => {
    const entities = [...dxfLine('DIVERS', 0, 0, 500, 0), ...dxfLine('DIVERS', 500, 0, 500, 300)];
    const { doc } = await readCadDetailed(miniDxf(4, entities), 'mini.dxf', 'dxf');
    const scale = doc.sheets[0]!.metresPerUnit!;
    expect(scale).toMatchObject({ value: 0.001, from: 'estimate' });
    expect(scale.note).toMatch(/un seul indice \(en-tête du fichier\)/);
    expect(doc.sheets[0]!.detected.outline).toBeUndefined();
  });

  it('aucun indice → échelle null, pas de contour, avertissement « posez la règle »', async () => {
    const entities = [...dxfLine('DIVERS', 0, 0, 500, 0), ...dxfLine('DIVERS', 500, 0, 500, 300)];
    const { doc, details } = await readCadDetailed(miniDxf(0, entities), 'mini.dxf', 'dxf');
    expect(details.unitsPerMetre).toBeNull();
    expect(doc.sheets).toHaveLength(1);
    expect(doc.sheets[0]!.metresPerUnit).toBeNull();
    expect(doc.sheets[0]!.detected.outline).toBeUndefined();
    expect(doc.sheets[0]!.detected.openings).toEqual([]);
    expect(doc.sheets[0]!.segments!.length).toBe(8);
    expect(doc.warnings.join('\n')).toMatch(/Unité du dessin inconnue/);
  });

  it('en-tête en mm (faux), murs trop épais pour départager → unité corrigée par la surface écrite dans la pièce', async () => {
    // Murs de 70 cm (hors de la plage 8–60 cm de l'indice « épaisseur ») : seul l'en-tête vote, et il se trompe.
    // Avec des mm rien ne se referme ; le lecteur essaie alors les autres unités et garde celle où la surface
    // mesurée rejoint la surface écrite.
    const entities = [...dxfRect('MUR', 0, 0, 540, 640), ...dxfRect('MUR', 70, 70, 470, 570), ...dxfText('TEXTE', 200, 300, 12, 'Séjour 20,00 m²')];
    const { doc } = await readCadDetailed(miniDxf(4, entities), 'mini.dxf', 'dxf');
    const scale = doc.sheets[0]!.metresPerUnit!;
    expect(scale.value).toBeCloseTo(0.01, 10);
    expect(scale.from).toBe('estimate');
    expect(scale.note).toMatch(/Indices contradictoires/);
    expect(doc.warnings.join('\n')).toMatch(/Unité corrigée d’après les surfaces écrites dans les pièces : centimètres/);
    expect(outlineArea(doc.sheets[0]!)).toBeCloseTo(5.4 * 6.4, 2);
    expect(doc.sheets[0]!.detected.rooms[0]!.measuredArea).toBeCloseTo(20, 2);
  });

  it('aucun indice d’unité mais une surface écrite → unité trouvée par essais, à confirmer (un seul indice)', async () => {
    const entities = [...dxfRect('MUR', 0, 0, 540, 640), ...dxfRect('MUR', 70, 70, 470, 570), ...dxfText('TEXTE', 200, 300, 12, 'Séjour 20,00 m²')];
    const { doc } = await readCadDetailed(miniDxf(0, entities), 'mini.dxf', 'dxf');
    const scale = doc.sheets[0]!.metresPerUnit!;
    expect(scale.value).toBeCloseTo(0.01, 10);
    expect(scale.from).toBe('estimate');
    expect(scale.note).toMatch(/un seul indice \(surfaces écrites dans les pièces\)/);
  });
});

describe('fichiers illisibles ou vides', () => {
  it('octets quelconques annoncés comme DWG → erreur en français qui conseille le DXF', async () => {
    await expect(readCad(textBytes('ceci n’est pas un dessin'), 'faux.dwg', 'dwg')).rejects.toThrow(/fichier DWG est illisible.*enregistrer en DXF/s);
  });

  it('octets quelconques annoncés comme DXF → erreur en français qui conseille de le réenregistrer', async () => {
    await expect(readCad(textBytes('ceci n’est pas un dessin'), 'faux.dxf', 'dxf')).rejects.toThrow(/fichier DXF est illisible.*Réenregistrez/s);
    await expect(readCad(new ArrayBuffer(0), 'vide.dxf', 'dxf')).rejects.toThrow(/illisible/);
  });

  it('un DXF qui ne contient que du texte donne une feuille sans contour plutôt qu’une erreur', async () => {
    const doc = await readCad(miniDxf(0, dxfText('T', 0, 0, 10, 'Bonjour')), 'texte.dxf', 'dxf');
    expect(doc.sheets).toHaveLength(1);
    expect(doc.sheets[0]!.texts).toEqual([{ text: 'Bonjour', x: 0, y: 0, height: 10 }]);
    expect(doc.sheets[0]!.segments!.length).toBe(0);
    expect(doc.sheets[0]!.metresPerUnit).toBeNull();
  });

  it('DXF sans aucune entité → erreur « aucun dessin dans l’espace objet »', async () => {
    await expect(readCad(miniDxf(4, []), 'vide.dxf', 'dxf')).rejects.toThrow(/aucun dessin/);
  });
});

describe('calques, blocs et textes', () => {
  const layerTable = (rows: [string, number, number][]): string[] => [
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(rows.length),
    ...rows.flatMap(([name, flags, colour]) => ['0', 'LAYER', '2', name, '70', String(flags), '62', String(colour), '6', 'CONTINUOUS']),
    '0', 'ENDTAB', '0', 'ENDSEC',
  ];

  it('ignore les calques gelés et éteints, et le dit', async () => {
    const tables = layerTable([['MUR', 0, 7], ['GELE', 1, 7], ['ETEINT', 0, -7]]);
    const entities = [...oneRoom(1), ...dxfLine('GELE', 0, 1000, 500, 1000), ...dxfLine('ETEINT', 0, 1100, 500, 1100), ...dxfLine('ETEINT', 0, 1200, 500, 1200)];
    const bytes = miniDxf(5, entities, tables);
    expect([...dxfOffLayers(new Uint8Array(bytes))]).toEqual(['ETEINT']);
    const doc = await readCad(bytes, 'mini.dxf', 'dxf');
    expect(doc.sheets[0]!.segments!.length / 4).toBe(8);
    expect(doc.warnings.join('\n')).toMatch(/3 objets sur des calques éteints ou gelés/);
  });

  it('développe les blocs imbriqués, mis à l’échelle, en miroir et en repère inversé', async () => {
    const blocks = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '8', '0', '2', 'PORTE_90', '70', '0', '10', '0', '20', '0', '30', '0', '3', 'PORTE_90', '1', '',
      ...dxfLine('0', 0, 0, 0, 90),
      '0', 'ARC', '8', '0', '10', '0', '20', '0', '40', '90', '50', '0', '51', '90',
      '0', 'ENDBLK', '8', '0',
      '0', 'BLOCK', '8', '0', '2', 'GROUPE', '70', '0', '10', '0', '20', '0', '30', '0', '3', 'GROUPE', '1', '',
      '0', 'INSERT', '8', 'PORTE', '2', 'PORTE_90', '10', '100', '20', '0', '41', '-1', '42', '1', '50', '0',
      ...dxfLine('MUR', 0, 0, 50, 0),
      '0', 'ENDBLK', '8', '0',
      '0', 'ENDSEC',
    ];
    const entities = [
      '0', 'INSERT', '8', 'PORTE', '2', 'PORTE_90', '10', '1000', '20', '0', '41', '1', '42', '1', '50', '90',
      '0', 'INSERT', '8', '0', '2', 'GROUPE', '10', '2000', '20', '0', '41', '2', '42', '2', '50', '0',
      '0', 'INSERT', '8', 'PORTE', '2', 'PORTE_90', '10', '-3000', '20', '0', '41', '1', '42', '1', '50', '0', '210', '0', '220', '0', '230', '-1',
    ];
    const raw = await readDrawing(miniDxf(5, entities, blocks), 'dxf', noPause);
    const box = (index: number): number[] => {
      const ins = raw.inserts[index]!;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = ins.segStart; i < ins.segEnd; i++) {
        for (let k = 0; k < 4; k += 2) {
          const x = raw.segXY[4 * i + k]! + raw.origin.x;
          const y = raw.segXY[4 * i + k + 1]! + raw.origin.y;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      return [minX, minY, maxX, maxY].map((v) => Math.round(v * 100) / 100);
    };
    expect(raw.inserts.map((i) => [i.name, raw.layers[i.layer], i.depth, i.parent])).toEqual([
      ['PORTE_90', 'PORTE', 0, -1],
      ['GROUPE', '0', 0, -1],
      ['PORTE_90', 'PORTE', 1, 1],
      ['PORTE_90', 'PORTE', 0, -1],
    ]);
    expect(box(0)).toEqual([910, 0, 1000, 90]); // tourné de 90°
    expect(box(2)).toEqual([2020, 0, 2200, 180]); // imbriqué, miroir, échelle 2
    expect(box(1)).toEqual([2000, 0, 2200, 180]);
    expect(box(3)).toEqual([2910, 0, 3000, 90]); // repère d'objet inversé (extrusion −Z)
    // Le contenu dessiné sur le calque « 0 » d'un bloc prend le calque de l'insertion ; le reste garde le sien.
    const layersOfGroup = new Set<string>();
    for (let i = raw.inserts[1]!.segStart; i < raw.inserts[1]!.segEnd; i++) layersOfGroup.add(raw.layers[raw.segLayer[i]!]!);
    expect([...layersOfGroup].sort()).toEqual(['MUR', 'PORTE']);
    expect(raw.arcs.map((a) => [Math.round(a.radius), Math.round(a.sweep)])).toEqual([[90, 90], [180, 90], [90, 90]]);
  });

  it('DXF R12 : polylignes « lourdes » (POLYLINE / VERTEX / SEQEND) avec bulge, cercle, ellipse, textes tournés', async () => {
    const entities = [
      // Polyligne fermée de 3 sommets ; le deuxième côté est un demi-cercle (bulge 1).
      '0', 'POLYLINE', '8', 'MUR', '66', '1', '70', '1', '10', '0', '20', '0', '30', '0',
      '0', 'VERTEX', '8', 'MUR', '10', '0', '20', '0', '30', '0',
      '0', 'VERTEX', '8', 'MUR', '10', '100', '20', '0', '30', '0', '42', '1',
      '0', 'VERTEX', '8', 'MUR', '10', '100', '20', '50', '30', '0',
      '0', 'SEQEND', '8', 'MUR',
      '0', 'CIRCLE', '8', 'ROND', '10', '500', '20', '0', '40', '10',
      '0', 'TEXT', '8', 'T', '10', '1000', '20', '0', '40', '10', '1', 'Salon', '50', '90', '72', '1', '11', '1000', '21', '50',
    ];
    const raw = await readDrawing(miniDxf(5, entities, [], 'AC1009'), 'dxf', noPause);
    const count = (layer: string): number => {
      let n = 0;
      for (let i = 0; i < raw.segCount; i++) if (raw.layers[raw.segLayer[i]!] === layer) n++;
      return n;
    };
    expect(count('MUR')).toBe(2 + 24); // deux côtés droits + demi-cercle en 24 cordes
    expect(count('ROND')).toBe(48);
    expect(raw.arcs).toHaveLength(1);
    expect(raw.arcs[0]).toMatchObject({ radius: 25, sweep: 180 });
    expect(raw.arcs[0]!.cx + raw.origin.x).toBeCloseTo(100, 6);
    expect(raw.arcs[0]!.cy + raw.origin.y).toBeCloseTo(25, 6);
    // Demi-cercle parcouru en sens trigonométrique de (100, 0) à (100, 50) : il déborde vers la droite.
    let maxX = -Infinity;
    for (let i = 0; i < raw.segCount; i++) if (raw.layers[raw.segLayer[i]!] === 'MUR') maxX = Math.max(maxX, raw.segXY[4 * i]! + raw.origin.x);
    expect(maxX).toBeCloseTo(125, 1);
    // Texte centré sur (1000, 50) et tourné de 90° : il se lit de bas en haut, corps du texte à gauche de la ligne de base.
    const salon = raw.texts[0]!;
    expect(salon.text).toBe('Salon');
    expect(salon.cx + raw.origin.x).toBeCloseTo(995, 6);
    expect(salon.cy + raw.origin.y).toBeCloseTo(50, 6);
    expect(salon.lines[0]!.x + raw.origin.x).toBeCloseTo(1000, 6);
    expect(salon.lines[0]!.y + raw.origin.y).toBeCloseTo(35, 6);
  });

  it('lit la flèche du nord tournée (bloc « NORD »), y compris vers l’ouest', async () => {
    const blocks = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '8', '0', '2', 'NORD', '70', '0', '10', '0', '20', '0', '30', '0', '3', 'NORD', '1', '',
      ...dxfLine('0', 0, 0, 0, 60),
      '0', 'ENDBLK', '8', '0',
      '0', 'ENDSEC',
    ];
    const north = async (rotation: number): Promise<number | undefined> => {
      const entities = [...oneRoom(1), '0', 'INSERT', '8', 'SYMBOLES', '2', 'NORD', '10', '900', '20', '500', '50', String(rotation)];
      return (await readCad(miniDxf(5, entities, blocks), 'mini.dxf', 'dxf')).northAngle?.value;
    };
    // Flèche tournée de 90° dans le sens trigonométrique : le nord est à GAUCHE, le haut de la feuille regarde l'est.
    expect(await north(90)).toBeCloseTo(90, 5);
    expect(await north(0)).toBeCloseTo(0, 5);
    expect(await north(-45)).toBeCloseTo(315, 5);
  });
});

describe('plusieurs vues dans le même dessin', () => {
  const room = (dx: number, layer = 'MUR'): string[] => [...dxfRect(layer, dx, 0, dx + 460, 560), ...dxfRect(layer, dx + 30, 30, dx + 430, dx === 0 ? 530 : 530)];

  it('sépare deux plans éloignés et les nomme d’après leurs titres (« Étage » avant « Combles »)', async () => {
    const entities = [
      ...room(0), ...dxfText('TEXTE', 150, 280, 12, 'Grenier 20,00 m²'), ...dxfText('TITRES', 0, -150, 25, 'PLAN DES COMBLES'),
      ...room(1500), ...dxfText('TEXTE', 1650, 280, 12, 'Chambre 20,00 m²'), ...dxfText('TITRES', 1500, -150, 25, "PLAN DE L'ETAGE"),
    ];
    const doc = await readCad(miniDxf(5, entities), 'maison.dxf', 'dxf');
    expect(doc.sheets.map((s) => s.name)).toEqual(['Étage', 'Combles']);
    expect(doc.sheets.map((s) => s.detected.rooms.map((r) => r.name))).toEqual([['Chambre'], ['Grenier']]);
    for (const sheet of doc.sheets) expect(outlineArea(sheet)).toBeCloseTo(4.6 * 5.6, 2);
  });

  it('un nom de pièce « Cave » DANS le plan n’est pas pris pour le titre du niveau', async () => {
    const entities = [...room(0), ...dxfText('TEXTE', 150, 280, 12, 'Cave 20,00 m²')];
    const doc = await readCad(miniDxf(5, entities), 'projet.dxf', 'dxf');
    expect(doc.sheets[0]!.name).toBe('projet');
    expect(doc.sheets[0]!.detected.rooms[0]).toMatchObject({ name: 'Cave', heatedGuess: 'ask' });
  });

  it('nomme la feuille unique d’après le nom du fichier quand il désigne un niveau', async () => {
    const doc = await readCad(miniDxf(5, oneRoom(1)), 'maison_rdc.dxf', 'dxf');
    expect(doc.sheets[0]!.name).toBe('Rez-de-chaussée');
  });

  it('une vue titrée « COUPE A-A » ne reçoit pas de contour (ce n’est pas un plan d’étage)', async () => {
    const entities = [
      ...room(0), ...dxfText('TEXTE', 150, 280, 12, 'Séjour 20,00 m²'), ...dxfText('TITRES', 0, -150, 25, 'REZ-DE-CHAUSSEE'),
      ...room(1500), ...dxfText('TITRES', 1500, -150, 25, 'COUPE A-A'),
    ];
    const doc = await readCad(miniDxf(5, entities), 'maison.dxf', 'dxf');
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'COUPE A-A']);
    expect(doc.sheets[0]!.detected.outline).toBeDefined();
    expect(doc.sheets[1]!.detected.outline).toBeUndefined();
    expect(doc.sheets[1]!.detected.notes.join('\n')).toMatch(/coupe, façade ou détail/);
  });
});

describe('contour', () => {
  it('ne propose jamais un contour minuscule : un local de 2 m × 2 m est refusé', async () => {
    const entities = [...dxfRect('MUR', 0, 0, 200, 200), ...dxfRect('MUR', 20, 20, 180, 180)];
    const doc = await readCad(miniDxf(5, entities), 'abri.dxf', 'dxf');
    expect(doc.sheets[0]!.detected.outline).toBeUndefined();
    expect(doc.warnings.join('\n')).toMatch(/Aucun contour de bâtiment/);
  });

  it('referme une porte sans seuil et garde un contour exact (bâtiment en L, angle rentrant conservé)', async () => {
    // L : 10 m × 8 m avec un retrait de 4 m × 3 m dans l'angle nord-est ; murs de 30 cm ; porte de 90 cm au sud.
    const outer: [number, number][] = [[0, 0], [1000, 0], [1000, 500], [600, 500], [600, 800], [0, 800]];
    const inner: [number, number][] = [[30, 30], [970, 30], [970, 470], [570, 470], [570, 770], [30, 770]];
    const ring = (pts: [number, number][], skip: number): string[] =>
      pts.flatMap((p, i) => (i === skip ? [] : dxfLine('MUR', p[0], p[1], pts[(i + 1) % pts.length]![0], pts[(i + 1) % pts.length]![1])));
    const entities = [
      ...ring(outer, 0), ...ring(inner, 0),
      // Mur sud coupé par la porte (x de 400 à 490), avec ses tableaux.
      ...dxfLine('MUR', 0, 0, 400, 0), ...dxfLine('MUR', 490, 0, 1000, 0), ...dxfLine('MUR', 30, 30, 400, 30), ...dxfLine('MUR', 490, 30, 970, 30),
      ...dxfLine('MUR', 400, 0, 400, 30), ...dxfLine('MUR', 490, 0, 490, 30),
      ...dxfText('TEXTE', 300, 300, 12, 'Séjour'),
    ];
    const doc = await readCad(miniDxf(5, entities), 'l.dxf', 'dxf');
    const sheet = doc.sheets[0]!;
    expect(sheet.detected.outline).toHaveLength(6);
    expect(outlineArea(sheet)).toBeCloseTo(80 - 12, 2);
    // La porte n'a ni bloc ni symbole : proposée comme ouverture de type inconnu, large de 90 cm.
    expect(sheet.detected.openings).toHaveLength(1);
    expect(sheet.detected.openings[0]).toMatchObject({ kind: 'unknown', width: 0.9, exterior: true });
    const m = sheet.metresPerUnit!.value;
    expect(polygonArea(sheet.detected.rooms[0]!.polygon!) * m * m).toBeCloseTo(9.4 * 7.4 - 4 * 3, 2);
  });
});

describe('allègement de l’affichage', () => {
  it('au-delà de 150 000 traits : hachures d’abord, puis les plus petits traits, jamais les murs', () => {
    const n = MAX_DISPLAY_SEGMENTS + 50_000;
    const segXY = new Float64Array(n * 4);
    const segKind = new Uint8Array(n).fill(SEG_LINE);
    const segLayer = new Int32Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      // Longueurs de 1 à n : les traits les plus courts ont les plus petits indices.
      segXY[4 * i + 2] = i + 1;
      if (i < 10_000) segKind[i] = SEG_HATCH;
      if (i >= 10_000 && i < 10_100) segLayer[i] = 0; // 100 traits de murs, très courts
    }
    const all = Array.from({ length: n }, (_v, i) => i);
    const { kept, dropped } = thinSegments({ segXY, segKind, segLayer }, all, new Set([0]));
    expect(kept.length).toBeLessThanOrEqual(MAX_DISPLAY_SEGMENTS);
    expect(kept.length).toBeGreaterThan(MAX_DISPLAY_SEGMENTS - 10);
    expect(dropped).toBe(n - kept.length);
    expect(kept.some((i) => i < 10_000)).toBe(false); // plus de hachures
    for (let i = 10_000; i < 10_100; i++) expect(kept).toContain(i); // murs conservés
    expect(kept[kept.length - 1]).toBe(n - 1); // les plus longs sont gardés
    // En dessous du seuil, rien ne change.
    expect(thinSegments({ segXY, segKind, segLayer }, all.slice(0, 1000), new Set()).dropped).toBe(0);
  });
});
