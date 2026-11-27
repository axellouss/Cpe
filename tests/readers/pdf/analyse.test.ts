/**
 * Analyse du lecteur PDF sur des pages SYNTHÉTIQUES (traits et textes écrits à la main) : chaque test isole
 * une règle — lecture de l'échelle annoncée, unité des cotes, grande baie, contour qui fuit, coupe, cartouche…
 * Unités : points PDF ; au 1:100, 1 m = 28,346 pt.
 */
import { describe, expect, it } from 'vitest';
import { analysePdf, METRES_PER_POINT } from '../../../src/readers/pdf';
import type { RawSeg, RawText } from '../../../src/readers/pdf';
import { calibrateByDimensions, chooseDimensionScale, declaredScales, dimensionUnitHint } from '../../../src/readers/pdf/scale';
import { areaM2, dimensionChain, page, rect, scaleDen, seg, text } from './helpers';

/** Points par mètre au 1:100. */
const M = 1 / (100 * METRES_PER_POINT);
const WALL = 1.4;
const THIN = 0.25;

function dens(...lines: string[]): number[] {
  return declaredScales(lines.map((s) => text(s, 100, 100))).map((d) => d.den);
}

describe('échelle annoncée (cartouche, titre de vue)', () => {
  it('reconnaît les écritures françaises et allemandes', () => {
    expect(dens('Échelle 1:100')).toEqual([100]);
    expect(dens('ECHELLE : 1/50')).toEqual([50]);
    expect(dens('Ech. 1/50e')).toEqual([50]);
    expect(dens('Maßstab 1:50')).toEqual([50]);
    expect(dens('Massstab 1:200')).toEqual([200]);
    expect(dens('M 1:100')).toEqual([100]);
    expect(dens('M. 1:20')).toEqual([20]);
    expect(dens('Mst. 1:75')).toEqual([75]);
    expect(dens('1:100')).toEqual([100]);
    expect(dens('Échelle 1:100        12.03.2024')).toEqual([100]);
  });

  it('ne prend pas dates, heures et numéros de page pour des échelles', () => {
    expect(dens('12.03.2024')).toEqual([]);
    expect(dens('Page 1/2')).toEqual([]);
    expect(dens('Blatt 1/5')).toEqual([]);
    expect(dens('1/20/2024')).toEqual([]);
    expect(dens('11:20')).toEqual([]);
    expect(dens('Pente 1:5')).toEqual([]);
    expect(dens('Raum 1:10')).toEqual([]);
    expect(dens('1:123')).toEqual([]);
  });

  it('classe d’abord l’échelle accompagnée d’un mot-clé, puis le plus gros texte', () => {
    const found = declaredScales([text('1:20', 0, 0, 14), text('Échelle 1:100', 0, 0, 8), text('1:50', 0, 0, 10)]);
    expect(found.map((d) => d.den)).toEqual([100, 20, 50]);
    expect(found[0]!.keyword).toBe(true);
  });

  it('lit la mention d’unité des cotes', () => {
    expect(dimensionUnitHint([text('Toutes les cotes sont en cm. Niveaux en m.', 0, 0)])).toBe('cm');
    expect(dimensionUnitHint([text('Cotes en mm', 0, 0)])).toBe('mm');
    expect(dimensionUnitHint([text('Alle Maße in m', 0, 0)])).toBe('m');
    expect(dimensionUnitHint([text('Maßangaben in cm', 0, 0)])).toBe('cm');
    expect(dimensionUnitHint([text('Séjour', 0, 0)])).toBeNull();
  });
});

describe('auto-calibrage par les cotes', () => {
  // Chaîne de 4 intervalles au 1:100 : 1,5 + 2,5 + 3,5 + 2,5 m.
  const xs = [100, 100 + 1.5 * M, 100 + 4 * M, 100 + 7.5 * M, 100 + 10 * M];

  it('cotes entières : le centimètre l’emporte parce que 10 m est un bâtiment et 1 m non', () => {
    const chain = dimensionChain(xs, 400, ['150', '250', '350', '250']);
    const total = dimensionChain([xs[0]!, xs[4]!], 430, ['1000']);
    const cal = calibrateByDimensions(page([...chain.segs, ...total.segs, seg(0, 0, 10, 0, 1)], [...chain.texts, ...total.texts]));
    expect(cal.n).toBe(5);
    expect(cal.nInteger).toBe(5);
    const choice = chooseDimensionScale(cal, [], null)!;
    expect(choice.unit).toBe('cm');
    expect(choice.den).toBeCloseTo(100, 3);
    expect(choice.inliers).toBe(5);
    expect(choice.ambiguous).toBe(false);
  });

  it('une mention « cotes en mm » renverse ce choix', () => {
    const chain = dimensionChain(xs, 400, ['150', '250', '350', '250']);
    const cal = calibrateByDimensions(page(chain.segs, chain.texts));
    expect(chooseDimensionScale(cal, [], 'mm')!.den).toBeCloseTo(10, 3);
    // … de même qu'une échelle annoncée ailleurs sur le plan.
    expect(chooseDimensionScale(cal, [10], null)!.unit).toBe('mm');
  });

  it('cotes à virgule : des mètres, quelle que soit l’unité supposée des entiers', () => {
    const chain = dimensionChain(xs, 400, ['1,50', '2,50', '3,50', '2,50']);
    const cal = calibrateByDimensions(page(chain.segs, chain.texts));
    expect(cal.nDecimal).toBe(4);
    const choice = chooseDimensionScale(cal, [], null)!;
    expect(choice.den).toBeCloseTo(100, 3);
    expect(choice.ambiguous).toBe(false);
  });

  it('cotes verticales lues de bas en haut', () => {
    const lines: RawSeg[] = [seg(60, 100, 60, 100 + 8 * M, THIN)];
    const texts: RawText[] = [];
    const ys = [100, 100 + 2 * M, 100 + 5 * M, 100 + 6.5 * M, 100 + 8 * M];
    for (const y of ys) lines.push(seg(57.5, y + 2.5, 62.5, y - 2.5, THIN * 1.5));
    ['200', '300', '150', '150'].forEach((s, i) => texts.push(text(s, 54, (ys[i]! + ys[i + 1]!) / 2, 6, 90)));
    const cal = calibrateByDimensions(page(lines, texts));
    expect(cal.n).toBe(4);
    expect(chooseDimensionScale(cal, [], 'cm')!.den).toBeCloseTo(100, 3);
  });

  it('une cote fausse parmi d’autres ne déplace pas le consensus', () => {
    const chain = dimensionChain(xs, 400, ['150', '250', '999', '250']);
    const more = dimensionChain(xs, 430, ['150', '250', '350', '250']);
    const cal = calibrateByDimensions(page([...chain.segs, ...more.segs], [...chain.texts, ...more.texts]));
    const choice = chooseDimensionScale(cal, [], 'cm')!;
    expect(choice.n).toBe(8);
    expect(choice.inliers).toBe(7);
    expect(choice.den).toBeCloseTo(100, 3);
  });
});

/**
 * Maison rectangulaire (dimensions extérieures en mètres, murs de 40 cm) dont le mur du bas porte une ouverture :
 * `outer` et `inner` donnent l'étendue du vide sur la face extérieure et sur la face intérieure.
 */
function house(x: number, y: number, width: number, depth: number, opening?: { outer: [number, number]; inner: [number, number] }): RawSeg[] {
  const t = 0.4 * M;
  const x1 = x + width * M;
  const y1 = y + depth * M;
  const segs: RawSeg[] = [
    seg(x, y, x1, y, WALL),
    seg(x, y, x, y1, WALL),
    seg(x1, y, x1, y1, WALL),
    seg(x + t, y + t, x1 - t, y + t, WALL),
    seg(x + t, y + t, x + t, y1 - t, WALL),
    seg(x1 - t, y + t, x1 - t, y1 - t, WALL),
  ];
  if (!opening) {
    segs.push(seg(x, y1, x1, y1, WALL), seg(x + t, y1 - t, x1 - t, y1 - t, WALL));
    return segs;
  }
  const [o0, o1] = opening.outer.map((v) => x + v * M) as [number, number];
  const [i0, i1] = opening.inner.map((v) => x + v * M) as [number, number];
  segs.push(seg(x, y1, o0, y1, WALL), seg(o1, y1, x1, y1, WALL));
  segs.push(seg(x + t, y1 - t, i0, y1 - t, WALL), seg(i1, y1 - t, x1 - t, y1 - t, WALL));
  // Tableaux de l'ouverture.
  segs.push(seg(o0, y1, i0, y1 - t, WALL), seg(o1, y1, i1, y1 - t, WALL));
  return segs;
}

/** Traits fins d'habillage : sans eux la page n'aurait qu'une épaisseur de trait et pas de classe de murs. */
function dressing(): RawSeg[] {
  const out: RawSeg[] = [];
  for (let i = 0; i < 30; i++) out.push(seg(900, 100 + 6 * i, 1100, 100 + 6 * i, THIN));
  return out;
}

describe('contour d’un plan', () => {
  it('referme une baie de 4 m, plus large que le rayon de fermeture, grâce aux vides jumeaux des deux faces du mur', () => {
    const segs = [...house(200, 200, 10, 8, { outer: [3, 7], inner: [3, 7] }), ...dressing()];
    const texts = [text('Échelle 1:100', 1000, 700, 10), text('Séjour', 340, 300), text('66,24 m²', 340, 310, 7), text('Rez-de-chaussée', 340, 500, 10)];
    const { doc } = analysePdf([page(segs, texts)], 'maison.pdf');
    expect(doc.sheets).toHaveLength(1);
    const sheet = doc.sheets[0]!;
    expect(sheet.name).toBe('Rez-de-chaussée');
    expect(scaleDen(sheet)).toBeCloseTo(100, 6);
    expect(sheet.detected.outline).toBeDefined();
    expect(Math.abs(areaM2(sheet, sheet.detected.outline!) / 80 - 1)).toBeLessThan(0.01);
    expect(sheet.detected.outline!).toHaveLength(4);
    // La baie est proposée comme ouverture de 4 m, de type à préciser (rien n'est dessiné dedans).
    expect(sheet.detected.openings.map((o) => [o.kind, o.width])).toEqual([['unknown', 4]]);
    // Une seule pièce, sans autre surface pour recouper : mesurée car murs et contour concordent.
    const sejour = sheet.detected.rooms[0]!;
    expect(sejour.statedArea).toBeCloseTo(66.24, 6);
    expect(Math.abs(sejour.measuredArea! / 66.24 - 1)).toBeLessThan(0.005);
  });

  it('ne propose PAS de contour quand une grande ouverture sans vide jumeau y laisse une entaille', () => {
    // Ébrasement : 4 m côté extérieur, 3 m côté intérieur — les deux vides ne sont pas jumeaux, rien ne les referme.
    // La fermeture seule y laisse une entaille en V qui ne suit aucun mur : on préfère ne rien proposer.
    const segs = [...house(200, 200, 10, 8, { outer: [3, 7], inner: [3.5, 6.5] }), ...dressing()];
    const texts = [text('Échelle 1:100', 1000, 700, 10), text('Séjour', 340, 300), text('66,24 m²', 340, 310, 7)];
    const { doc } = analysePdf([page(segs, texts)], 'maison.pdf');
    expect(doc.sheets).toHaveLength(1);
    const sheet = doc.sheets[0]!;
    expect(sheet.detected.outline).toBeUndefined();
    expect(sheet.detected.openings).toEqual([]);
    expect(sheet.detected.notes.join('\n')).toMatch(/Pas de contour proposé : le tracé calculé coupe à travers le plan/);
    expect(doc.warnings.some((w) => /aucun contour de bâtiment fiable/i.test(w))).toBe(true);
    // La pièce reste proposée avec sa surface écrite.
    expect(sheet.detected.rooms.map((r) => [r.name, r.statedArea])).toEqual([['Séjour', 66.24]]);
  });

  it('ne propose PAS de contour quand il fuit : une pièce étiquetée se retrouve dehors', () => {
    // Façade ouverte sur 7 m (côté intérieur 6 m) : la fermeture entre dans le bâtiment et n'entoure plus que les murs.
    const segs = [...house(200, 200, 10, 8, { outer: [1.5, 8.5], inner: [2, 8] }), ...dressing()];
    const texts = [text('Échelle 1:100', 1000, 700, 10), text('Séjour', 340, 300), text('66,24 m²', 340, 310, 7)];
    const { doc } = analysePdf([page(segs, texts)], 'maison.pdf');
    expect(doc.sheets).toHaveLength(1);
    const sheet = doc.sheets[0]!;
    // La « vue » trouvée n'est qu'un ruban de murs, sans pièce dedans : elle n'est pas reconnue comme un plan.
    expect(sheet.detected.outline).toBeUndefined();
    expect(sheet.detected.notes.join('\n')).toMatch(/Pas de contour fiable/);
    expect(sheet.detected.rooms.map((r) => r.name)).toEqual(['Séjour']);
    expect(sheet.detected.rooms.every((r) => r.polygon === undefined)).toBe(true);
    expect(doc.warnings.some((w) => /aucun contour de bâtiment fiable/i.test(w))).toBe(true);
  });

  it('façade largement ouverte sur une pièce : pas de contour, les deux pièces restent proposées', () => {
    // Deux pièces séparées par une cloison ; la façade de la seconde est ouverte sur 4,4 m (3,4 m côté intérieur).
    const t = 0.4 * M;
    const partition = [seg(200 + 4 * M, 200 + t, 200 + 4 * M, 200 + 8 * M - t, WALL), seg(200 + 4.2 * M, 200 + t, 200 + 4.2 * M, 200 + 8 * M - t, WALL)];
    const segs = [...house(200, 200, 10, 8, { outer: [5, 9.4], inner: [5.5, 8.9] }), ...partition, ...dressing()];
    const texts = [
      text('Échelle 1:100', 1000, 700, 10),
      text('Chambre', 200 + 2.2 * M, 300),
      text('25,92 m²', 200 + 2.2 * M, 310, 7),
      text('Séjour', 200 + 6.9 * M, 300),
      text('38,88 m²', 200 + 6.9 * M, 310, 7),
    ];
    const { doc, pages } = analysePdf([page(segs, texts)], 'maison.pdf');
    expect(pages[0]!.views.map((v) => v.kind)).toEqual(['plan']);
    const sheet = doc.sheets[0]!;
    expect(sheet.detected.outline).toBeUndefined();
    // Selon la géométrie, la fermeture entaille le plan ou y entre franchement : dans les deux cas, rien n'est proposé.
    expect(sheet.detected.notes.join('\n')).toMatch(/Pas de contour proposé/);
    expect(sheet.detected.rooms.map((r) => [r.name, r.statedArea])).toEqual([
      ['Chambre', 25.92],
      ['Séjour', 38.88],
    ]);
    // La chambre, fermée et conforme à sa surface écrite, garde son polygone ; le séjour ouvert n'en a pas.
    expect(sheet.detected.rooms[0]!.polygon).toBeDefined();
    expect(sheet.detected.rooms[1]!.polygon).toBeUndefined();
  });

  it('une tache de murs sans titre ni pièce (détail, légende) n’est pas proposée comme plan', () => {
    const segs = [...house(200, 200, 10, 8), ...house(700, 200, 4, 4), ...dressing()];
    const texts = [text('Échelle 1:100', 1000, 700, 10), text('Séjour', 340, 300), text('66,24 m²', 340, 310, 7)];
    const { doc, pages } = analysePdf([page(segs, texts)], 'maison.pdf');
    expect(pages[0]!.views.map((v) => v.kind).sort()).toEqual(['other', 'plan']);
    expect(doc.sheets).toHaveLength(1);
    expect(Math.abs(areaM2(doc.sheets[0]!, doc.sheets[0]!.detected.outline!) / 80 - 1)).toBeLessThan(0.01);
  });

  it('une étiquette de terrasse hors du contour n’est pas une fuite', () => {
    const segs = [...house(200, 200, 10, 8), ...dressing()];
    const texts = [text('Échelle 1:100', 1000, 700, 10), text('Séjour', 340, 300), text('66,24 m²', 340, 310, 7), text('Terrasse', 340, 450), text('12,00 m²', 340, 460, 7)];
    const { doc } = analysePdf([page(segs, texts)], 'maison.pdf');
    const sheet = doc.sheets[0]!;
    expect(sheet.detected.outline).toBeDefined();
    expect(sheet.detected.rooms.map((r) => r.name)).toEqual(['Séjour']);
  });

  it('un cartouche dessiné en traits forts n’est pas pris pour une vue', () => {
    const segs = [...house(200, 200, 10, 8), ...rect(700, 600, 1150, 800, WALL), ...dressing()];
    const texts = [
      text('Séjour', 340, 300),
      text('66,24 m²', 340, 310, 7),
      text('Projet', 760, 630, 6),
      text('Maître d’ouvrage', 760, 670, 6),
      text('Échelle 1:100', 900, 720, 10),
      text('Indice B', 760, 770, 6),
    ];
    const { doc, pages } = analysePdf([page(segs, texts)], 'maison.pdf');
    expect(pages[0]!.views).toHaveLength(1);
    expect(doc.sheets).toHaveLength(1);
    expect(Math.abs(areaM2(doc.sheets[0]!, doc.sheets[0]!.detected.outline!) / 80 - 1)).toBeLessThan(0.01);
  });
});

describe('vues, titres et coupes', () => {
  it('titres écrits AU-DESSUS des vues : chaque plan garde le sien', () => {
    const segs = [...house(200, 100, 8, 5), ...house(200, 400, 8, 5), ...dressing()];
    const texts = [
      text('Échelle 1:100', 1000, 780, 10),
      text('Étage', 313, 80, 12),
      text('Chambre', 313, 170),
      text('33,12 m²', 313, 180, 7),
      text('Rez-de-chaussée', 313, 380, 12),
      text('Séjour', 313, 470),
      text('33,12 m²', 313, 480, 7),
    ];
    const { doc } = analysePdf([page(segs, texts)], 'maison.pdf');
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    expect(doc.sheets[0]!.detected.rooms.map((r) => r.name)).toEqual(['Séjour']);
    expect(doc.sheets[1]!.detected.rooms.map((r) => r.name)).toEqual(['Chambre']);
  });

  it('une vue titrée « Coupe » ne devient pas une feuille, mais donne les hauteurs', () => {
    const segs = [...house(200, 100, 8, 5), ...house(200, 420, 8, 5.6), ...dressing()];
    const texts = [
      text('Échelle 1:100', 1000, 780, 10),
      text('Rez-de-chaussée', 313, 300, 12),
      text('Séjour', 313, 170),
      text('33,12 m²', 313, 180, 7),
      text('Coupe B-B', 313, 640, 12),
      text('±0,00', 470, 578, 6),
      text('+2,90', 470, 496, 6),
      text('+5,80', 470, 414, 6),
      text('HSP 2,60 m', 313, 540, 6),
    ];
    const { doc, pages } = analysePdf([page(segs, texts)], 'maison.pdf');
    expect(pages[0]!.views.map((v) => v.kind).sort()).toEqual(['plan', 'section']);
    expect(doc.sheets).toHaveLength(1);
    expect(doc.sheets[0]!.name).toBe('Rez-de-chaussée');
    expect(doc.sheets[0]!.detected.storeyHeight).toBeCloseTo(2.9, 6);
    expect(doc.sheets[0]!.detected.clearHeight).toBeCloseTo(2.6, 6);
    expect(doc.sheets[0]!.detected.elevation).toBeCloseTo(0, 6);
  });

  it('niveaux d’appuis et de plafonds cotés en plus : pas de hauteur d’étage devinée sans hauteur libre', () => {
    const segs = [...house(200, 100, 8, 5), ...house(200, 420, 8, 5.6), ...dressing()];
    const texts = [
      text('Échelle 1:100', 1000, 780, 10),
      text('Rez-de-chaussée', 313, 300, 12),
      text('Séjour', 313, 170),
      text('33,12 m²', 313, 180, 7),
      text('Coupe B-B', 313, 640, 12),
      ...['±0,00', '+1,00', '+2,60', '+2,90', '+5,50', '+5,80'].map((s, i) => text(s, 470, 578 - 30 * i, 6)),
    ];
    const { doc } = analysePdf([page(segs, texts)], 'maison.pdf');
    expect(doc.sheets[0]!.detected.storeyHeight).toBeUndefined();
    expect(doc.sheets[0]!.detected.clearHeight).toBeUndefined();
  });

  it('un PDF qui ne contient qu’une coupe est quand même proposé, avec un avertissement', () => {
    const segs = [...house(200, 200, 8, 5.6), ...dressing()];
    const texts = [text('Échelle 1:100', 1000, 700, 10), text('Coupe A-A', 313, 420, 12), text('±0,00', 470, 358, 6), text('+2,80', 470, 279, 6)];
    const { doc, pages } = analysePdf([page(segs, texts)], 'coupe.pdf');
    expect(pages[0]!.views.map((v) => v.kind)).toEqual(['section']);
    expect(doc.sheets).toHaveLength(1);
    expect(doc.sheets[0]!.detected.outline).toBeUndefined();
    expect(doc.warnings.some((w) => /Aucun plan d’étage reconnu/.test(w))).toBe(true);
  });

  it('page vide : une feuille vide et un message, pas d’erreur', () => {
    const { doc } = analysePdf([page([], [])], 'vide.pdf');
    expect(doc.sheets).toHaveLength(1);
    expect(doc.sheets[0]!.metresPerUnit).toBeNull();
    expect(doc.sheets[0]!.segments).toBeUndefined();
    expect(doc.warnings).toHaveLength(1);
  });

  it('nomme la feuille unique d’après le fichier quand le plan n’a pas de titre', () => {
    const segs = [...house(200, 200, 10, 8), ...dressing()];
    const texts = [text('Échelle 1:100', 1000, 700, 10), text('Séjour', 340, 300), text('66,24 m²', 340, 310, 7)];
    expect(analysePdf([page(segs, texts)], 'Maison_Dupont_RDC.pdf').doc.sheets[0]!.name).toBe('Rez-de-chaussée');
    expect(analysePdf([page(segs, texts)], 'plan-17.pdf').doc.sheets[0]!.name).toBe('Page 1');
  });
});
