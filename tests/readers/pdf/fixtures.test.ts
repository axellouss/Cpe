/**
 * Lecteur PDF sur les plans d'essai, comparé à leur vérité terrain :
 *  - fr_A3_1-100.pdf  A3 au 1:100, style « AutoCAD » (traits de murs séparés, cotes en cm) : RDC + étage + coupe
 *                     sur UNE page ;
 *  - de_A3_1-50.pdf   A3 au 1:50, style « Archicad » (murs remplis, cotes allemandes m / cm avec exposant ⁵) :
 *                     EG, OG et Schnitt sur TROIS pages ;
 *  - fr_A4_fit.pdf    le premier « ajusté à la page » en A4 : le cartouche dit toujours 1:100, la réalité est 1:141,5 ;
 *  - fr_A3_rot90.pdf  le premier avec /Rotate 90 (page couchée).
 * Les largeurs d'ouvertures attendues viennent du script qui a dessiné les plans (make_fixtures.py, notes de recherche).
 */
import { describe, expect, it } from 'vitest';
import { isSelfIntersecting } from '../../../src/core/geometry';
import type { PlanSheet } from '../../../src/core/types';
import { areaM2, distanceToRing, labelledArea, readFixture, scaleDen, sheetForView, sorted, truthOf } from './helpers';
import type { Truth, TruthView } from './helpers';

function planViews(truth: Truth, page: number): TruthView[] {
  return truth.pages[page]!.views.filter((v) => v.outline_pt !== undefined);
}

/** Vérifie pièces et contour d'une feuille contre une vue de la vérité terrain. */
function expectViewMatches(sheet: PlanSheet, view: TruthView): void {
  // Contour : aire à 1 % près, et chaque sommet vrai à moins de 0,5 pt du contour proposé.
  const outline = sheet.detected.outline!;
  expect(outline.length).toBeGreaterThanOrEqual(4);
  expect(isSelfIntersecting(outline)).toBe(false);
  expect(Math.abs(areaM2(sheet, outline) / view.outline_area_m2! - 1)).toBeLessThan(0.01);
  for (const [x, y] of view.outline_pt!) expect(distanceToRing({ x, y }, outline)).toBeLessThan(0.5);

  // Pièces : toutes, et seulement elles.
  const rooms = sheet.detected.rooms;
  expect(rooms).toHaveLength(view.rooms!.length);
  for (const expected of view.rooms!) {
    const room = rooms.find((r) => r.name === expected.name);
    expect(room, `pièce « ${expected.name} »`).toBeDefined();
    const stated = labelledArea(expected);
    if (stated === null) expect(room!.statedArea).toBeUndefined();
    else expect(room!.statedArea).toBeCloseTo(stated, 6);
    // Polygone mesuré sur le dessin : à 0,5 % de la surface vraie.
    expect(room!.polygon, `polygone de « ${expected.name} »`).toBeDefined();
    expect(Math.abs(room!.measuredArea! / expected.area_true_m2 - 1)).toBeLessThan(0.005);
    expect(Math.abs(areaM2(sheet, room!.polygon!) / expected.area_true_m2 - 1)).toBeLessThan(0.005);
    // La proposition « chauffé ? » ne contredit jamais la vérité (au pire, elle demande).
    expect(room!.heatedGuess).not.toBe(expected.heated_true ? 'no' : 'yes');
    // L'étiquette est dans son polygone.
    expect(room!.at).toBeDefined();
  }
}

describe('fr_A3_1-100.pdf — une page, deux plans et une coupe', () => {
  const name = 'fr_A3_1-100.pdf';

  it('produit une feuille par vue en plan, pas pour la coupe', async () => {
    const { doc, details } = await readFixture(name);
    expect(doc.kind).toBe('pdf');
    expect(doc.fileName).toBe(name);
    expect(doc.storeysAligned).toBe(false);
    expect(details.pageCount).toBe(1);
    expect(details.pages[0]!.sheets).toBe(2);
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    expect(details.pages[0]!.views.map((v) => v.kind)).toEqual(['plan', 'plan', 'section']);
    expect(new Set(doc.sheets.map((s) => s.id)).size).toBe(2);
    // Sous Node, pas d'image de fond.
    for (const s of doc.sheets) expect(s.image).toBeUndefined();
    expect(doc.warnings).toEqual([]);
  });

  it('retrouve l’échelle à 0,5 % près, par recoupement du cartouche, des cotes et des surfaces', async () => {
    const { doc, details } = await readFixture(name);
    const truth = truthOf(name);
    for (const s of doc.sheets) {
      expect(Math.abs(scaleDen(s) / truth.scale_den - 1)).toBeLessThan(0.005);
      expect(s.metresPerUnit!.from).toBe('plan');
      expect(s.metresPerUnit!.note).toMatch(/1:100/);
      expect(s.metresPerUnit!.note).toMatch(/cartouche/);
      expect(s.metresPerUnit!.note).toMatch(/41 cotes/);
      expect(s.metresPerUnit!.note).toMatch(/11 pièces/);
    }
    // Toutes les cotes du plan (41) ont trouvé leur intervalle, lues en centimètres.
    const report = details.pages[0]!;
    const cotes = truth.pages[0]!.views.reduce((n, v) => n + v.dims.length, 0);
    expect(report.dims!.n).toBe(cotes);
    expect(report.dims!.inliers).toBe(cotes);
    expect(report.dims!.unit).toBe('cm');
    expect(report.declared).toEqual([100]);
    expect(Math.abs(report.areas!.den / 100 - 1)).toBeLessThan(0.001);
  });

  it('retrouve pièces, surfaces et contours de chaque plan', async () => {
    const { doc } = await readFixture(name);
    const views = planViews(truthOf(name), 0);
    expect(views).toHaveLength(2);
    for (const view of views) {
      const sheet = sheetForView(doc, view);
      expect(sheet.name).toBe(view.view);
      expectViewMatches(sheet, view);
    }
  });

  it('signale le garage englobé par le contour', async () => {
    const { doc } = await readFixture(name);
    const rdc = doc.sheets[0]!;
    expect(rdc.detected.notes.join('\n')).toMatch(/englobe Garage/);
    expect(rdc.detected.rooms.find((r) => r.name === 'Garage')!.heatedGuess).toBe('no');
    expect(rdc.detected.rooms.find((r) => r.name === 'Buanderie')!.heatedGuess).toBe('ask');
  });

  it('lit hauteur d’étage et hauteur libre sur la coupe, par niveau', async () => {
    const { doc } = await readFixture(name);
    const section = truthOf(name).pages[0]!.views.find((v) => v.levels_m !== undefined)!;
    const [rdc, etage] = doc.sheets;
    expect(rdc!.detected.storeyHeight).toBeCloseTo(section.storey_height_m!, 6);
    expect(rdc!.detected.clearHeight).toBeCloseTo(section.clear_height_m!, 6);
    expect(rdc!.detected.elevation).toBeCloseTo(0, 6);
    expect(etage!.detected.storeyHeight).toBeCloseTo(section.storey_height_m!, 6);
    expect(etage!.detected.clearHeight).toBeCloseTo(section.clear_height_m!, 6);
    expect(etage!.detected.elevation).toBeCloseTo(2.8, 6);
  });

  it('propose les ouvertures des murs extérieurs avec leur largeur', async () => {
    const { doc } = await readFixture(name);
    const [rdc, etage] = doc.sheets;
    const widths = (s: PlanSheet, kind: string): number[] => sorted(s.detected.openings.filter((o) => o.kind === kind).map((o) => o.width!));
    // RDC : 5 fenêtres, la porte d'entrée et la porte de garage (make_fixtures.py, make_fr).
    expect(widths(rdc!, 'window')).toEqual([0.8, 1, 1.5, 1.5, 2.5]);
    expect(widths(rdc!, 'door')).toEqual([1, 2.5]);
    expect(widths(rdc!, 'unknown')).toEqual([]);
    // Étage : 6 fenêtres, aucune porte extérieure.
    expect(widths(etage!, 'window')).toEqual([1, 1, 1.2, 1.5, 1.5, 1.5]);
    expect(etage!.detected.openings.every((o) => o.kind === 'window' && o.exterior === true)).toBe(true);
    // Chaque ouverture est posée sur le contour proposé.
    for (const s of [rdc!, etage!]) {
      for (const o of s.detected.openings) {
        expect(distanceToRing(o.a, s.detected.outline!)).toBeLessThan(0.5);
        expect(distanceToRing(o.b, s.detected.outline!)).toBeLessThan(0.5);
      }
    }
  });

  it('range traits et textes dans la feuille de leur vue', async () => {
    const { doc, details } = await readFixture(name);
    const raw = details.raw[0]!;
    const [rdc, etage] = doc.sheets;
    for (const s of [rdc!, etage!]) {
      expect(s.segments!.length % 4).toBe(0);
      expect(s.segments!.length).toBeGreaterThan(400);
      expect(s.bbox.minX).toBeGreaterThanOrEqual(0);
      expect(s.bbox.maxX).toBeLessThanOrEqual(raw.width);
      expect(s.bbox.maxY).toBeLessThanOrEqual(raw.height);
      // Rien de la feuille ne déborde de son étendue (à la marge près).
      for (let i = 0; i < s.segments!.length; i += 2) {
        expect(s.segments![i]!).toBeGreaterThan(s.bbox.minX - 7);
        expect(s.segments![i]!).toBeLessThan(s.bbox.maxX + 7);
      }
    }
    // Les deux plans sont côte à côte : leurs étendues ne se recouvrent pas.
    expect(rdc!.bbox.maxX).toBeLessThan(etage!.bbox.minX);
    expect(rdc!.texts!.some((t) => t.text === 'Séjour')).toBe(true);
    expect(rdc!.texts!.some((t) => t.text === 'Rez-de-chaussée')).toBe(true);
    expect(rdc!.texts!.some((t) => t.text === 'Chambre 1')).toBe(false);
    expect(etage!.texts!.some((t) => t.text === 'Chambre 1')).toBe(true);
    // Textes de la coupe et du cartouche : dans aucune feuille de plan.
    for (const s of [rdc!, etage!]) expect(s.texts!.some((t) => /Coupe A-A|HSP|Projet/.test(t.text))).toBe(false);
    // Ancrage des textes : début de la ligne de base, hauteur = corps.
    const sejour = rdc!.texts!.find((t) => t.text === 'Séjour')!;
    expect(sejour.height).toBeCloseTo(8, 3);
    expect(sejour.y).toBeCloseTo(283.46, 1);
  });

  it('repère la flèche du nord à 3° près, comme une estimation', async () => {
    const { doc } = await readFixture(name);
    const truth = truthOf(name);
    expect(doc.northAngle).toBeDefined();
    expect(doc.northAngle!.from).toBe('estimate');
    // Le nord est à +25° (horaire) du haut : le haut de la feuille pointe donc vers l'azimut 335°.
    const expected = (360 - truth.north_cw_from_up_deg) % 360;
    const gap = Math.abs(((doc.northAngle!.value - expected + 540) % 360) - 180);
    expect(gap).toBeLessThan(3);
  });
});

describe('de_A3_1-50.pdf — trois pages : EG, OG, Schnitt', () => {
  const name = 'de_A3_1-50.pdf';

  it('produit une feuille par page de plan et aucune pour la coupe', async () => {
    const { doc, details } = await readFixture(name);
    expect(details.pageCount).toBe(3);
    expect(details.pages.map((p) => p.sheets)).toEqual([1, 1, 0]);
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    expect(details.pages[2]!.views.map((v) => v.kind)).toEqual(['section']);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/^Page 3 : coupe ou façade « Schnitt A-A »/);
  });

  it('retrouve l’échelle 1:50 malgré les cotes mêlant mètres, centimètres et demi-centimètres', async () => {
    const { doc, details } = await readFixture(name);
    const truth = truthOf(name);
    for (const s of doc.sheets) {
      expect(Math.abs(scaleDen(s) / truth.scale_den - 1)).toBeLessThan(0.005);
      expect(s.metresPerUnit!.from).toBe('plan');
    }
    // Toutes les cotes, y compris « 11⁵ » et « 3,26⁵ », concordent.
    truth.pages.forEach((p, i) => {
      const cotes = p.views.reduce((n, v) => n + v.dims.length, 0);
      expect(details.pages[i]!.dims!.inliers).toBe(cotes);
      expect(Math.abs(details.pages[i]!.dims!.den / 50 - 1)).toBeLessThan(0.0005);
    });
  });

  it('retrouve pièces, surfaces (m², m2, qm, « A: », « NGF ») et contours', async () => {
    const { doc } = await readFixture(name);
    const truth = truthOf(name);
    for (const pageIndex of [0, 1]) {
      const [view] = planViews(truth, pageIndex);
      const sheet = sheetForView({ ...doc, sheets: [doc.sheets[pageIndex]!] }, view!);
      expectViewMatches(sheet, view!);
    }
    expect(doc.sheets[0]!.detected.notes.join('\n')).toMatch(/englobe Technik, Garage/);
  });

  it('reporte sur les plans les hauteurs lues sur la page de coupe', async () => {
    const { doc } = await readFixture(name);
    const [eg, og] = doc.sheets;
    expect(eg!.detected.storeyHeight).toBeCloseTo(2.8, 6);
    expect(eg!.detected.clearHeight).toBeCloseTo(2.5, 6);
    expect(eg!.detected.elevation).toBeCloseTo(0, 6);
    expect(og!.detected.storeyHeight).toBeCloseTo(2.8, 6);
    expect(og!.detected.clearHeight).toBeCloseTo(2.5, 6);
    expect(og!.detected.elevation).toBeCloseTo(2.8, 6);
  });

  it('propose les ouvertures des murs extérieurs (murs dessinés en polygones remplis)', async () => {
    const { doc } = await readFixture(name);
    const [eg, og] = doc.sheets;
    const widths = (s: PlanSheet, kind: string): number[] => sorted(s.detected.openings.filter((o) => o.kind === kind).map((o) => o.width!));
    expect(widths(eg!, 'window')).toEqual([1, 1.2, 1.26, 1.5, 2.5]);
    expect(widths(eg!, 'door')).toEqual([1.01, 2.5]);
    expect(widths(og!, 'window')).toEqual([1, 1.26, 1.26, 1.5, 1.5, 1.5]);
    expect(widths(og!, 'door')).toEqual([]);
  });

  it('repère la flèche du nord à 3° près', async () => {
    const { doc } = await readFixture(name);
    const expected = (360 - truthOf(name).north_cw_from_up_deg) % 360;
    const gap = Math.abs(((doc.northAngle!.value - expected + 540) % 360) - 180);
    expect(gap).toBeLessThan(3);
  });

  it('garde toute la page sur la feuille d’un plan seul sur sa page', async () => {
    const { doc, details } = await readFixture(name);
    const eg = doc.sheets[0]!;
    expect(eg.segments!.length / 4).toBe(details.raw[0]!.segs.length);
    expect(eg.texts!.length).toBe(details.raw[0]!.texts.length);
    expect(eg.texts!.some((t) => t.text === 'Maßstab 1:50')).toBe(true);
  });
});

describe('fr_A4_fit.pdf — plan « ajusté à la page »', () => {
  const name = 'fr_A4_fit.pdf';

  it('prend l’échelle des cotes, pas celle du cartouche, et le dit', async () => {
    const { doc, details } = await readFixture(name);
    const raw = details.raw[0]!;
    // Le A3 au 1:100 a été réduit pour tenir sur un A4 : l'échelle réelle est 100 / facteur de réduction.
    const factor = Math.min(raw.width / 1190.551, raw.height / 841.8898);
    const trueDen = 100 / factor;
    expect(trueDen).toBeGreaterThan(141);
    expect(details.pages[0]!.declared).toEqual([100]);
    for (const s of doc.sheets) {
      expect(Math.abs(scaleDen(s) / trueDen - 1)).toBeLessThan(0.005);
      expect(s.metresPerUnit!.from).toBe('plan');
      expect(s.metresPerUnit!.note).toMatch(/1:141,5/);
      expect(s.metresPerUnit!.note).toMatch(/cartouche annonce 1:100/);
    }
    expect(doc.warnings.some((w) => /cartouche annonce 1:100 mais les cotes donnent 1:141,5/.test(w))).toBe(true);
  });

  it('donne alors les bonnes surfaces (le cartouche les aurait divisées par deux)', async () => {
    const { doc } = await readFixture(name);
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    const [rdc, etage] = doc.sheets;
    expect(Math.abs(areaM2(rdc!, rdc!.detected.outline!) / 114.75 - 1)).toBeLessThan(0.01);
    expect(Math.abs(areaM2(etage!, etage!.detected.outline!) / 85 - 1)).toBeLessThan(0.01);
    const sejour = rdc!.detected.rooms.find((r) => r.name === 'Séjour')!;
    expect(sejour.statedArea).toBeCloseTo(32.45, 6);
    expect(Math.abs(sejour.measuredArea! / 32.45 - 1)).toBeLessThan(0.005);
    // Au 1:100 du cartouche, le contour ne ferait que la moitié de la surface.
    const wrong = areaM2({ ...rdc!, metresPerUnit: { value: (100 * 0.0254) / 72, from: 'estimate' } }, rdc!.detected.outline!);
    expect(wrong / 114.75).toBeLessThan(0.51);
  });
});

describe('fr_A3_rot90.pdf — page couchée (/Rotate 90)', () => {
  const name = 'fr_A3_rot90.pdf';

  it('redresse la page : mêmes feuilles, mêmes mesures que le plan droit', async () => {
    const turned = await readFixture(name);
    const straight = await readFixture('fr_A3_1-100.pdf');
    const raw = turned.details.raw[0]!;
    expect(raw.turned).not.toBe(0);
    expect(raw.rotation).toBe(0);
    // Page en paysage, texte horizontal.
    expect(raw.width).toBeGreaterThan(raw.height);
    const upright = raw.texts.filter((t) => Math.abs(t.angle) < 1).length;
    expect(upright).toBeGreaterThan(0.8 * raw.texts.length);
    expect(turned.doc.warnings.some((w) => /redressée/.test(w))).toBe(true);

    expect(turned.doc.sheets.map((s) => s.name)).toEqual(straight.doc.sheets.map((s) => s.name));
    turned.doc.sheets.forEach((s, i) => {
      const ref = straight.doc.sheets[i]!;
      expect(scaleDen(s)).toBeCloseTo(scaleDen(ref), 6);
      expect(areaM2(s, s.detected.outline!)).toBeCloseTo(areaM2(ref, ref.detected.outline!), 2);
      expect(s.detected.rooms.map((r) => [r.name, r.statedArea, r.measuredArea])).toEqual(ref.detected.rooms.map((r) => [r.name, r.statedArea, r.measuredArea]));
      expect(s.detected.storeyHeight).toBe(ref.detected.storeyHeight);
      expect(s.bbox.minX).toBeCloseTo(ref.bbox.minX, 1);
      expect(s.bbox.maxY).toBeCloseTo(ref.bbox.maxY, 1);
    });
    const views = planViews(truthOf('fr_A3_1-100.pdf'), 0);
    for (const view of views) expectViewMatches(sheetForView(turned.doc, view), view);
  });
});
