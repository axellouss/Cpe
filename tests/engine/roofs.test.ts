/**
 * Fermeture haute : toiture plate, plancher haut sous grenier, et les trois formes de toiture inclinée
 * au-dessus de combles CHAUFFÉS. Maison type : 12,00 m (est-ouest) × 10,00 m (nord-sud).
 *
 * Rappels : tan 30° = 0,57735 ; cos 30° = 0,86603 ; tan 10° = 0,17633 ; cos 10° = 0,98481.
 */
import { describe, expect, it } from 'vitest';
import type { RoofShape, TopClosure, Vec2 } from '../../src/core/types';
import { deriveSheets } from '../../src/engine';
import { NORTH, brief, codes, finding, project, rect, storey, windowAt } from './helpers';

function top(patch: Partial<TopClosure>): TopClosure {
  return { kind: 'pitched-roof', pitchDeg: 30, shape: 'gable', ridgeAngle: null, kneeWallHeight: 0.5, constructionId: null, from: 'user', ...patch };
}

/** Rez-de-chaussée de 2,90 m + combles chauffés sous toiture ; faîtage le long du grand côté (est-ouest) par défaut. */
function atticHouse(patch: Partial<TopClosure>, outline: Vec2[] = rect(12, 10)) {
  const atticOutline = outline.map((p) => ({ ...p }));
  return project(
    [
      storey('rdc', 'RDC', outline, { grossHeight: 2.9, netArea: 95 }),
      // La hauteur d'étage saisie pour les combles (ici absurde et « par défaut ») ne doit servir à RIEN sous une toiture inclinée.
      storey('combles', 'Combles', atticOutline, { grossHeight: 9.99, clearHeight: 2.2, heightFrom: 'default', netArea: 70 }),
    ],
    { top: top(patch) },
  );
}

const rowsOf = (shape: RoofShape, patch: Partial<TopClosure> = {}) => deriveSheets(atticHouse({ shape, ...patch }), 'fr');

describe('toiture à deux pans (gable), 30°, jambette 0,50 m', () => {
  const sheets = rowsOf('gable');

  it('donne murs gouttereaux, pignons et les deux pans', () => {
    // Portée W = 10 m → hauteur de faîtage au-dessus de la jambette = 5 × tan 30° = 2,887 m
    // Murs gouttereaux (N et S, le long du faîtage) : hauteur = jambette = 0,50 m
    // Pignons (E et O) : hauteur équivalente = 0,50 + 2,887 / 2 = 1,943 → 1,94 m (rectangle + triangle ramenés à un rectangle)
    // Pans : 120 / cos 30° = 138,56 m² au total → 69,28 m² chacun ; longueur 12 m, largeur 69,28 / 12 = 5,7735 → 5,77 m
    expect(sheets.envelope.map(brief)).toEqual([
      'wall N 1 × 12.00 × 2.90', // RDC
      'wall N 1 × 12.00 × 0.50', // jambette des combles
      'wall E 1 × 10.00 × 2.90',
      'wall E 1 × 10.00 × 1.94', // pignon
      'wall S 1 × 12.00 × 2.90',
      'wall S 1 × 12.00 × 0.50',
      'wall W 1 × 10.00 × 2.90',
      'wall W 1 × 10.00 × 1.94',
      'roof N 1 × 12.00 × 5.77',
      'roof S 1 × 12.00 × 5.77',
      'floor H 1 × 12.00 × 10.00',
    ]);
    expect(sheets.envelope.find((r) => r.kind === 'roof')!.label).toBe('Pan de toiture Nord, 30° (Combles)');
    // Comparaison avec la maison de référence FZK-Haus (même gabarit, mesurée sur sa maquette IFC) :
    // façades RDC 34,8 et 29,0 m² ; pan de toiture 69,28 m² ; pignon 19,43 m² (ici 19,40 avec la hauteur arrondie au cm).
    expect(sheets.envelope.map((r) => r.grossArea)).toEqual([34.8, 6, 29, 19.4, 34.8, 6, 29, 19.4, 69.24, 69.24, 120]);
  });

  it('calcule le volume des combles avec une hauteur équivalente', () => {
    // Volume = 120 × 0,50 + 120 × 2,887 / 2 = 60 + 173,2 = 233,2 m³ → hauteur équivalente 1,943 → 1,94 m → 120 × 1,94 = 232,8 m³
    expect(sheets.volumes.map((v) => [v.label, v.area, v.height, v.volume])).toEqual([
      ['RDC', 120, 2.9, 348],
      ['Combles', 120, 1.94, 232.8],
    ]);
    // A = murs (2 × 40,8 + 2 × 48,4 = 178,4) + pans (138,48) + dalle (120) = 436,88 ; Ve = 580,8 ; A/Ve = 0,752
    expect(sheets.totals).toMatchObject({ envelopeArea: 436.88, ve: 580.8, aOverVe: 0.752 });
  });

  it("n'utilise pas la hauteur d'étage saisie pour les combles, et rappelle la règle du 1,00 m pour An", () => {
    // Seule la hauteur libre des combles (pour Vn) reste « par défaut » ; aucune alerte sur leur hauteur brute de 9,99 m
    expect(codes(sheets).sort()).toEqual(['attic.heightRule', 'clearHeight.default', 'uvalues.missing', 'windows.none']);
    expect(finding(sheets, 'attic.heightRule')!.params).toEqual({ storey: 'Combles', storeyId: 'combles' });
    expect(sheets.totals.veFrom).toBe('plan');
  });

  it('oriente les pans perpendiculairement au faîtage, que l’on peut imposer', () => {
    // Faîtage nord-sud (90° depuis l'axe x de la feuille) : L = 10 m, portée W = 12 m
    // → hauteur de faîtage 6 × tan 30° = 3,464 ; pignons au N et au S : 0,50 + 1,732 = 2,23 m ; jambettes à l'E et à l'O
    // → pans E et O : 69,28 m² chacun, longueur 10 m, largeur 6,93 m
    const turned = rowsOf('gable', { ridgeAngle: 90 });
    expect(turned.envelope.filter((r) => r.storeyId === 'combles').map(brief)).toEqual([
      'wall N 1 × 12.00 × 2.23',
      'wall E 1 × 10.00 × 0.50',
      'wall S 1 × 12.00 × 2.23',
      'wall W 1 × 10.00 × 0.50',
      'roof E 1 × 10.00 × 6.93',
      'roof W 1 × 10.00 × 6.93',
    ]);
  });

  it('suit la rotation du nord', () => {
    // Haut du plan vers l'est (azimut 90°) : le pan qui regardait le haut du plan regarde maintenant l'est
    const p = atticHouse({ shape: 'gable' });
    p.model.northAngle = { value: 90, from: 'user' };
    expect(deriveSheets(p, 'fr').envelope.filter((r) => r.kind === 'roof').map(brief)).toEqual([
      'roof E 1 × 12.00 × 5.77',
      'roof W 1 × 12.00 × 5.77',
    ]);
  });

  it('sans jambette : pas de mur gouttereau, et une fenêtre posée là devient une fenêtre de toit déduite du pan', () => {
    const p = atticHouse({ shape: 'gable', kneeWallHeight: 0 });
    p.model.storeys[1]!.openings = [windowAt(NORTH, 0.78, 1.18)];
    const d = deriveSheets(p, 'fr');
    expect(d.envelope.filter((r) => r.storeyId === 'combles').map(brief)).toEqual([
      'wall E 1 × 10.00 × 1.44', // pignon : 0 + 2,887 / 2
      'wall W 1 × 10.00 × 1.44',
      'window N 1 × 0.78 × 1.18 Abzug',
      'roof N 1 × 12.00 × 5.77',
      'roof S 1 × 12.00 × 5.77',
    ]);
    // Pan nord : 69,24 − 0,78 × 1,18 (0,9204) = 68,3196 m²
    expect(d.envelope.find((r) => r.kind === 'roof' && r.orientation === 'N')!.netArea).toBe(68.3196);
    expect(finding(d, 'opening.inRoof')).toMatchObject({ severity: 'info', params: { storey: 'Combles', count: 1 } });
  });
});

describe('toiture à croupes (hip), 30°, jambette 0,50 m', () => {
  const sheets = rowsOf('hip');

  it('donne quatre murs bas et quatre pans', () => {
    // Rectangle L × W = 12 × 10. En plan : deux triangles d'about de W²/4 = 25 m², deux trapèzes de (120 − 50) / 2 = 35 m².
    // En vraie grandeur (÷ cos 30°) : abouts 28,87 m² (longueur 10 → largeur 2,887 → 2,89), trapèzes 40,41 m² (longueur 12 → 3,368 → 3,37)
    // Tous les murs des combles ont la hauteur de la jambette.
    expect(sheets.envelope.filter((r) => r.storeyId === 'combles').map(brief)).toEqual([
      'wall N 1 × 12.00 × 0.50',
      'wall E 1 × 10.00 × 0.50',
      'wall S 1 × 12.00 × 0.50',
      'wall W 1 × 10.00 × 0.50',
      'roof N 1 × 12.00 × 3.37',
      'roof E 1 × 10.00 × 2.89',
      'roof S 1 × 12.00 × 3.37',
      'roof W 1 × 10.00 × 2.89',
    ]);
    // Total des pans : 2 × 40,44 + 2 × 28,90 = 138,68 pour 138,56 théoriques (écart dû à l'arrondi des largeurs au cm)
    const roofArea = sheets.envelope.filter((r) => r.kind === 'roof').reduce((s, r) => s + r.grossArea, 0);
    expect(roofArea).toBeCloseTo(138.68, 2);
    expect(Math.abs(roofArea - 120 / Math.cos(Math.PI / 6))).toBeLessThan(0.15);
  });

  it('calcule le volume sous croupes', () => {
    // Volume = 120 × 0,50 + 2,887 × (120 / 2 − 10² / 6) = 60 + 2,887 × 43,33 = 185,09 m³ → hauteur 1,542 → 1,54 → 184,8 m³
    expect(sheets.volumes[1]).toMatchObject({ area: 120, height: 1.54, volume: 184.8 });
  });

  it('place toujours le faîtage le long de la grande dimension', () => {
    // Même si l'on impose 90°, un toit à croupes sur 12 × 10 a son faîtage est-ouest
    expect(rowsOf('hip', { ridgeAngle: 90 }).envelope.map(brief)).toEqual(sheets.envelope.map(brief));
  });

  it('sur un contour en L, conserve la surface totale et prévient que la répartition est approchée', () => {
    // L : 12 × 6 + 6 × 4 = 96 m², inscrit dans 12 × 10 = 120 m² → les quatre pans sont réduits de 96 / 120 = 0,8
    const L: Vec2[] = [
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 10 },
      { x: 0, y: 10 },
    ];
    const d = deriveSheets(atticHouse({ shape: 'hip' }, L), 'fr');
    const roofs = d.envelope.filter((r) => r.kind === 'roof');
    // Trapèzes : 40,41 × 0,8 = 32,33 → 12 × 2,69 ; abouts : 28,87 × 0,8 = 23,09 → 10 × 2,31
    expect(roofs.map(brief)).toEqual(['roof N 1 × 12.00 × 2.69', 'roof E 1 × 10.00 × 2.31', 'roof S 1 × 12.00 × 2.69', 'roof W 1 × 10.00 × 2.31']);
    // Total théorique 96 / cos 30° = 110,85 m²
    expect(finding(d, 'roof.estimated')).toEqual({
      code: 'roof.estimated',
      severity: 'info',
      params: { storey: 'Combles', storeyId: 'combles', area: '110,85' },
    });
    expect(codes(sheets)).not.toContain('roof.estimated');
  });
});

describe('toiture monopente (mono), 10°, murs de 2,40 m côté bas', () => {
  const sheets = rowsOf('mono', { pitchDeg: 10, kneeWallHeight: 2.4 });

  it('donne un seul pan et des murs à la hauteur moyenne', () => {
    // Portée 10 m → dénivelé 10 × tan 10° = 1,763 m ; hauteur moyenne des murs = 2,40 + 0,882 = 3,28 m
    // Pan : 120 / cos 10° = 121,85 m² ; longueur 12 → largeur 10,154 → 10,15 m
    expect(sheets.envelope.filter((r) => r.storeyId === 'combles').map(brief)).toEqual([
      'wall N 1 × 12.00 × 3.28',
      'wall E 1 × 10.00 × 3.28',
      'wall S 1 × 12.00 × 3.28',
      'wall W 1 × 10.00 × 3.28',
      'roof S 1 × 12.00 × 10.15',
    ]);
    // Volume = 120 × 2,40 + 120 × 1,763 / 2 = 288 + 105,8 = 393,8 m³ → hauteur 3,28 → 393,6 m³
    expect(sheets.volumes[1]).toMatchObject({ height: 3.28, volume: 393.6 });
  });

  it("marque comme estimation ce que le plan ne dit pas : sens de la pente, mur bas / mur haut", () => {
    const attic = sheets.envelope.filter((r) => r.storeyId === 'combles');
    const from = Object.fromEntries(attic.map((r) => [`${r.kind} ${r.orientation}`, r.from]));
    // Murs le long du faîtage : l'un est en réalité à 2,40 m, l'autre à 4,16 m → moyenne = estimation
    expect(from).toEqual({ 'wall N': 'estimate', 'wall S': 'estimate', 'wall E': 'plan', 'wall W': 'plan', 'roof S': 'estimate' });
    expect(finding(sheets, 'roof.monoDirection')).toEqual({ code: 'roof.monoDirection', severity: 'warn', params: { orientation: 'Sud' } });
    // Tourner le faîtage de 180° inverse le sens supposé de la pente
    expect(rowsOf('mono', { pitchDeg: 10, kneeWallHeight: 2.4, ridgeAngle: 180 }).envelope.filter((r) => r.kind === 'roof').map(brief)).toEqual([
      'roof N 1 × 12.00 × 10.15',
    ]);
  });
});

describe('maison de plain-pied sous toiture inclinée (un seul niveau, plafond rampant)', () => {
  it('le niveau unique est à la fois le premier (dalle) et le dernier (toiture)', () => {
    // 12 × 10 m, murs de 2,60 m jusqu'à la sablière, deux pans à 30°
    const p = project([storey('rdc', 'RDC', rect(12, 10), { netArea: 95, openings: [windowAt(NORTH, 2, 1.5, 3)] })], {
      top: top({ kneeWallHeight: 2.6 }),
    });
    const d = deriveSheets(p, 'fr');
    expect(d.envelope.map(brief)).toEqual([
      'window N 3 × 2.00 × 1.50 Abzug',
      'wall N 1 × 12.00 × 2.60',
      'wall E 1 × 10.00 × 4.04', // pignon : 2,60 + 2,887 / 2 = 4,043
      'wall S 1 × 12.00 × 2.60',
      'wall W 1 × 10.00 × 4.04',
      'roof N 1 × 12.00 × 5.77',
      'roof S 1 × 12.00 × 5.77',
      'floor H 1 × 12.00 × 10.00',
    ]);
    // Volume = 120 × 2,60 + 120 × 2,887 / 2 = 312 + 173,2 = 485,2 m³ → hauteur équivalente 4,04 m → 484,8 m³
    expect(d.volumes).toEqual([{ id: 'volume:rdc', label: 'RDC', area: 120, height: 4.04, volume: 484.8, from: 'plan', storeyId: 'rdc' }]);
  });
});

describe('toiture plate et plancher haut sous grenier non chauffé', () => {
  it('toiture plate : une ligne horizontale contre extérieur, de la surface du dernier niveau', () => {
    const p = atticHouse({});
    p.model.top = top({ kind: 'flat-roof' });
    p.model.storeys[1]!.grossHeight = { value: 2.7, from: 'user' };
    const d = deriveSheets(p, 'fr');
    expect(d.envelope.filter((r) => r.kind === 'roof' || r.kind === 'ceiling').map((r) => [brief(r), r.boundary, r.constructionId])).toEqual([
      ['roof H 1 × 12.00 × 10.00', 'outside', 'roof'],
    ]);
    // Les deux niveaux ont alors des murs ordinaires : 12 × 2,90 et 12 × 2,70 au nord
    expect(d.envelope.filter((r) => r.orientation === 'N').map(brief)).toEqual(['wall N 1 × 12.00 × 2.90', 'wall N 1 × 12.00 × 2.70']);
    expect(d.volumes[1]).toMatchObject({ height: 2.7, volume: 324 });
  });

  it('grenier non chauffé : une ligne de plancher haut contre local non chauffé', () => {
    const p = atticHouse({});
    p.model.top = top({ kind: 'attic-ceiling' });
    p.model.storeys[1]!.grossHeight = { value: 2.7, from: 'user' };
    const d = deriveSheets(p, 'fr');
    expect(d.envelope.filter((r) => r.kind === 'roof' || r.kind === 'ceiling').map((r) => [brief(r), r.boundary, r.constructionId])).toEqual([
      ['ceiling H 1 × 12.00 × 10.00', 'unheated', 'ceiling-attic'],
    ]);
  });

  it("utilise le type choisi par l'expert s'il est de la bonne catégorie, sinon le type par défaut", () => {
    const p = atticHouse({});
    p.model.constructions = [...p.model.constructions, { id: 'toit-vert', name: 'Toiture végétalisée', category: 'roof', u: null }];
    p.model.top = top({ kind: 'flat-roof', constructionId: 'toit-vert' });
    expect(deriveSheets(p, 'fr').envelope.find((r) => r.kind === 'roof')!.elementName).toBe('Toiture végétalisée');
    // L'expert repasse à « grenier non chauffé » : le type de toiture resté sélectionné ne convient plus à un plancher haut
    p.model.top = top({ kind: 'attic-ceiling', constructionId: 'toit-vert' });
    expect(deriveSheets(p, 'fr').envelope.find((r) => r.kind === 'ceiling')!.constructionId).toBe('ceiling-attic');
  });
});
