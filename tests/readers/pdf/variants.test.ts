/**
 * Variantes dégradées des plans d'essai : ce que le lecteur fait quand le PDF est moins propre.
 *
 * Les variantes A à E reprennent les essais de résistance des notes de recherche (section 4) ; elles sont
 * appliquées à la représentation intermédiaire des pages (textes + traits), puis analysées par `analysePdf`.
 * Les limites connues sont écrites noir sur blanc avec `it.fails` : le test décrit ce qu'on VOUDRAIT, et
 * échouera le jour où le lecteur saura le faire (il faudra alors retirer le `.fails`).
 */
import { describe, expect, it } from 'vitest';
import type { PlanDocument, PlanSheet } from '../../../src/core/types';
import { analysePdf } from '../../../src/readers/pdf';
import type { RawPage } from '../../../src/readers/pdf';
import { areaM2, readFixture, scaleDen, seededRandom } from './helpers';

const NUMBER = /^\d{1,5}(?:[.,]\d{1,3})?$/;
const AREA = /m[²2]|qm/;

async function firstPage(name: string): Promise<RawPage> {
  return (await readFixture(name)).details.raw[0]!;
}

function analyse(p: RawPage, name = 'variante.pdf'): PlanDocument {
  return analysePdf([p], name).doc;
}

const hairline = (p: RawPage): RawPage => ({ ...p, segs: p.segs.map((s) => ({ ...s, w: s.stroke ? 0.5 : 0 })) });
const withoutDimensions = (p: RawPage): RawPage => ({ ...p, texts: p.texts.filter((t) => !NUMBER.test(t.s)) });
const withoutAreas = (p: RawPage): RawPage => ({ ...p, texts: p.texts.filter((t) => !AREA.test(t.s)) });
const withoutScaleText = (p: RawPage): RawPage => ({ ...p, texts: p.texts.filter((t) => !/1:\d+|cotes sont/.test(t.s)) });
const withoutText = (p: RawPage): RawPage => ({ ...p, texts: [] });
/** Extrémités déplacées de ±0,15 pt (soit ±5 mm réels au 1:100) : accrochage négligé. */
function jittered(p: RawPage, seed = 42): RawPage {
  const r = seededRandom(seed);
  const j = (): number => (r() - 0.5) * 0.3;
  return { ...p, segs: p.segs.map((s) => ({ ...s, x0: s.x0 + j(), y0: s.y0 + j(), x1: s.x1 + j(), y1: s.y1 + j() })) };
}

function outlineAreas(doc: PlanDocument): number[] {
  return doc.sheets.map((s) => (s.detected.outline ? areaM2(s, s.detected.outline) : Number.NaN));
}

describe('A — tous les traits de la même épaisseur (export « tout en trait fin »)', () => {
  it('garde l’échelle des cotes mais ne propose aucun contour', async () => {
    for (const [name, den, sheets] of [
      ['fr_A3_1-100.pdf', 100, 2],
      ['de_A3_1-50.pdf', 50, 1],
    ] as const) {
      const doc = analyse(hairline(await firstPage(name)));
      expect(doc.sheets).toHaveLength(sheets);
      for (const sheet of doc.sheets) {
        expect(Math.abs(scaleDen(sheet) / den - 1)).toBeLessThan(0.005);
        expect(sheet.metresPerUnit!.from).toBe('plan');
        expect(sheet.detected.outline).toBeUndefined();
        expect(sheet.detected.openings).toEqual([]);
        expect(sheet.detected.notes.join('\n')).toMatch(/pas de contour proposé/);
        // Les pièces restent lues dans le texte (noms et surfaces écrites), sans polygone.
        expect(sheet.detected.rooms.length).toBeGreaterThanOrEqual(5);
        expect(sheet.detected.rooms.every((r) => r.polygon === undefined && r.measuredArea === undefined)).toBe(true);
        expect(sheet.detected.rooms.some((r) => r.statedArea !== undefined)).toBe(true);
        // Les phrases du cartouche ne deviennent pas des pièces.
        expect(sheet.detected.rooms.some((r) => /Strassen|Mersch/.test(r.name))).toBe(false);
        // Les traits restent là pour l'accrochage.
        expect(sheet.segments!.length).toBeGreaterThan(300);
      }
      expect(doc.warnings.some((w) => /même épaisseur/.test(w))).toBe(true);
    }
  });

  it('sépare les plans d’une page qui en montre plusieurs : une feuille par niveau, sans les étiquettes de la coupe', async () => {
    const doc = analyse(hairline(await firstPage('fr_A3_1-100.pdf')));
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    const [rdc, etage] = doc.sheets as [PlanSheet, PlanSheet];
    expect(rdc.detected.rooms.map((r) => r.name)).toEqual(['Séjour', 'Cuisine', 'Hall', 'WC', 'Buanderie', 'Garage', 'Cave / Keller']);
    expect(etage.detected.rooms.map((r) => r.name).sort()).toEqual(['Chambre 1', 'Chambre 2', 'Chambre 3', 'Palier', 'SdB']);
    // « Grenier (non chauffé) » est écrit dans la coupe A-A : ce n'est une pièce d'aucun des deux plans.
    expect(doc.sheets.some((s) => s.detected.rooms.some((r) => /Grenier/.test(r.name)))).toBe(false);
    expect(rdc.detected.notes.join('\n')).toMatch(/Étiquettes écartées.*Grenier/);
    expect(rdc.detected.notes.join('\n')).toMatch(/d’après leur place sur la page/);
    // Chaque feuille ne garde que les traits de son plan.
    expect(rdc.segments!.length).toBeLessThan(hairline(await firstPage('fr_A3_1-100.pdf')).segs.length * 4 * 0.7);
  });

  it('plusieurs niveaux qu’on ne sait pas séparer : la feuille couvre la page et le dit', async () => {
    // Les deux plans reliés par un long trait fin : une seule région de dessin.
    const p = hairline(await firstPage('fr_A3_1-100.pdf'));
    const rooms = analyse(p).sheets.flatMap((s) => s.detected.rooms);
    const xs = rooms.map((r) => r.at!.x);
    const ys = rooms.map((r) => r.at!.y);
    const link = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), w: 0.5, curve: false, stroke: true, fill: false, dash: false, pid: 0 };
    const doc = analyse({ ...p, segs: [...p.segs, link] });
    expect(doc.sheets).toHaveLength(1);
    expect(doc.sheets[0]!.name).toBe('Page 1');
    expect(doc.warnings.some((w) => /plusieurs niveaux sur cette page n’ont pas pu être séparés/i.test(w))).toBe(true);
    expect(doc.sheets[0]!.detected.notes.join('\n')).toMatch(/La liste des pièces couvre toute la page/);
  });

  it.fails('LIMITE CONNUE : sans hiérarchie d’épaisseurs, pas de contour ni de découpage en vues', async () => {
    const doc = analyse(hairline(await firstPage('fr_A3_1-100.pdf')));
    expect(doc.sheets).toHaveLength(2);
    expect(doc.sheets[0]!.detected.outline).toBeDefined();
  });
});

describe('B — sans cotes', () => {
  it('confirme le cartouche par les surfaces écrites dans les pièces', async () => {
    const doc = analyse(withoutDimensions(await firstPage('fr_A3_1-100.pdf')));
    expect(doc.sheets).toHaveLength(2);
    for (const s of doc.sheets) {
      expect(scaleDen(s)).toBeCloseTo(100, 6);
      expect(s.metresPerUnit!.from).toBe('plan');
      expect(s.metresPerUnit!.note).toMatch(/surfaces écrites de 11 pièces/);
    }
    const [rdc, etage] = outlineAreas(doc);
    expect(Math.abs(rdc! / 114.75 - 1)).toBeLessThan(0.01);
    expect(Math.abs(etage! / 85 - 1)).toBeLessThan(0.01);
  });

  it('sans cotes ni surfaces : cartouche seul → estimation, avec la consigne de vérifier à la règle', async () => {
    const doc = analyse(withoutAreas(withoutDimensions(await firstPage('fr_A3_1-100.pdf'))));
    for (const s of doc.sheets) {
      expect(scaleDen(s)).toBeCloseTo(100, 6);
      expect(s.metresPerUnit!.from).toBe('estimate');
      expect(s.metresPerUnit!.note).toMatch(/cartouche/);
      expect(s.metresPerUnit!.note).toMatch(/règle/);
    }
    expect(doc.warnings.some((w) => /non vérifiée/.test(w))).toBe(true);
  });

  it('plan « ajusté à la page » sans cotes : les surfaces contredisent le cartouche → estimation signalée', async () => {
    const doc = analyse(withoutDimensions(await firstPage('fr_A4_fit.pdf')));
    for (const s of doc.sheets) {
      expect(Math.abs(scaleDen(s) / 141.5 - 1)).toBeLessThan(0.005);
      expect(s.metresPerUnit!.from).toBe('estimate');
      expect(s.metresPerUnit!.note).toMatch(/cartouche annonce 1:100/);
    }
    expect(doc.warnings.some((w) => /surfaces écrites donnent environ 1:141,5/.test(w))).toBe(true);
  });

  it('ni cartouche ni cotes : les surfaces seules donnent une estimation', async () => {
    const doc = analyse(withoutDimensions(withoutScaleText(await firstPage('de_A3_1-50.pdf'))));
    const sheet = doc.sheets[0]!;
    expect(scaleDen(sheet)).toBeCloseTo(50, 6);
    expect(sheet.metresPerUnit!.from).toBe('estimate');
    expect(sheet.metresPerUnit!.note).toMatch(/surfaces écrites de 6 pièces/);
  });
});

describe('C — sans surfaces écrites', () => {
  it('garde l’échelle des cotes et mesure quand même les pièces si murs et contour concordent', async () => {
    const doc = analyse(withoutAreas(await firstPage('fr_A3_1-100.pdf')));
    expect(doc.sheets).toHaveLength(2);
    const rdc = doc.sheets[0]!;
    expect(rdc.metresPerUnit!.from).toBe('plan');
    const sejour = rdc.detected.rooms.find((r) => r.name === 'Séjour')!;
    expect(sejour.statedArea).toBeUndefined();
    expect(Math.abs(sejour.measuredArea! / 32.45 - 1)).toBeLessThan(0.005);
    expect(sejour.polygon).toBeDefined();
  });

  it('cotes entières sans cartouche ni mention d’unité : centimètres, par la taille du bâtiment', async () => {
    // « 1350 » peut être 13,50 m au 1:100 ou 1,35 m au 1:10 : seul le premier est un bâtiment.
    const doc = analyse(withoutAreas(withoutScaleText(await firstPage('fr_A3_1-100.pdf'))));
    for (const s of doc.sheets) {
      expect(scaleDen(s)).toBeCloseTo(100, 6);
      expect(s.metresPerUnit!.from).toBe('plan');
      expect(s.metresPerUnit!.note).toMatch(/41 cotes concordantes \(cotes entières lues en cm\)/);
    }
  });
});

describe('D — aucun texte (polices converties en dessins)', () => {
  it('rend la feuille avec ses traits, sans échelle ni proposition, et explique quoi faire', async () => {
    const doc = analyse(withoutText(await firstPage('fr_A3_1-100.pdf')));
    expect(doc.sheets).toHaveLength(1);
    const sheet = doc.sheets[0]!;
    expect(sheet.metresPerUnit).toBeNull();
    expect(sheet.detected).toEqual({ rooms: [], openings: [], notes: [] });
    expect(sheet.segments!.length / 4).toBe(553);
    expect(sheet.texts).toBeUndefined();
    expect(sheet.bbox).toEqual({ minX: 0, minY: 0, maxX: 1190.551, maxY: 841.8898 });
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/posez la règle/);
    expect(doc.northAngle).toBeUndefined();
  });

  it('cad_plot_ezdxf.pdf (vrai tracé CAO, textes en contours remplis) : même repli, message adapté', async () => {
    const { doc, details } = await readFixture('cad_plot_ezdxf.pdf');
    expect(details.pages[0]!.kind).toBe('outlined-text');
    expect(details.raw[0]!.texts).toHaveLength(0);
    expect(doc.sheets).toHaveLength(1);
    const sheet = doc.sheets[0]!;
    expect(sheet.metresPerUnit).toBeNull();
    expect(sheet.detected).toEqual({ rooms: [], openings: [], notes: [] });
    expect(sheet.segments!.length / 4).toBeGreaterThan(2000);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/polices vectorisées/);
    expect(doc.warnings[0]).toMatch(/Posez la règle/);
  });

  it.fails('LIMITE CONNUE : pas de reconnaissance de caractères, donc ni échelle ni pièces sur un PDF aux textes vectorisés', async () => {
    const { doc } = await readFixture('cad_plot_ezdxf.pdf');
    // Le dessin dit « Échelle 1:100 », « Séjour », « 70,84 m² » — mais en contours, pas en texte.
    expect(doc.sheets[0]!.metresPerUnit).not.toBeNull();
    expect(doc.sheets[0]!.detected.rooms.length).toBeGreaterThan(0);
  });
});

describe('E — extrémités mal accrochées (±0,15 pt)', () => {
  it('le contour par fermeture tient à 1 % près, l’échelle aussi', async () => {
    const fr = analyse(jittered(await firstPage('fr_A3_1-100.pdf')));
    expect(fr.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    const [rdc, etage] = outlineAreas(fr);
    expect(Math.abs(rdc! / 114.75 - 1)).toBeLessThan(0.01);
    expect(Math.abs(etage! / 85 - 1)).toBeLessThan(0.01);
    for (const s of fr.sheets) {
      expect(Math.abs(scaleDen(s) / 100 - 1)).toBeLessThan(0.005);
      // Le contour reste un polygone simple et sobre malgré les petits décrochements.
      expect(s.detected.outline!.length).toBeLessThanOrEqual(8);
    }
    const de = analyse(jittered(await firstPage('de_A3_1-50.pdf')));
    expect(Math.abs(outlineAreas(de)[0]! / 107.9856 - 1)).toBeLessThan(0.01);
    expect(Math.abs(scaleDen(de.sheets[0]!) / 50 - 1)).toBeLessThan(0.005);
  });

  it('ne propose un polygone de pièce que s’il est recoupé par la surface écrite', async () => {
    const doc = analyse(jittered(await firstPage('fr_A3_1-100.pdf')));
    const rooms = doc.sheets.flatMap((s) => s.detected.rooms);
    expect(rooms).toHaveLength(12);
    for (const r of rooms) {
      if (r.polygon === undefined) {
        expect(r.measuredArea).toBeUndefined();
        continue;
      }
      expect(r.statedArea).toBeDefined();
      expect(Math.abs(r.measuredArea! / r.statedArea! - 1)).toBeLessThanOrEqual(0.03);
    }
    // Les surfaces écrites, elles, restent toutes lues.
    expect(rooms.filter((r) => r.statedArea !== undefined)).toHaveLength(11);
  });

  it.fails('LIMITE CONNUE : avec un accrochage négligé, les faces des pièces ne se referment pas toutes', async () => {
    const doc = analyse(jittered(await firstPage('fr_A3_1-100.pdf')));
    const rooms = doc.sheets.flatMap((s) => s.detected.rooms);
    expect(rooms.every((r) => r.polygon !== undefined)).toBe(true);
  });
});

describe('PDF sans dessin vectoriel', () => {
  it('scan_only_A3.pdf (une image, rien d’autre) : feuille de la page, échelle inconnue, consigne en français', async () => {
    const { doc, details } = await readFixture('scan_only_A3.pdf');
    expect(details.pages[0]!.kind).toBe('raster');
    expect(details.raw[0]!.images).toBe(1);
    expect(details.raw[0]!.imageCoverage).toBeGreaterThan(0.95);
    // Le scan incorporé fait 1654 px de large sur une page A3 : 100 dpi.
    expect((details.raw[0]!.imagePixelsPerPoint * 72) / 100).toBeCloseTo(1, 1);
    expect(doc.sheets).toHaveLength(1);
    const sheet: PlanSheet = doc.sheets[0]!;
    expect(sheet.metresPerUnit).toBeNull();
    expect(sheet.detected).toEqual({ rooms: [], openings: [], notes: [] });
    expect(sheet.segments).toBeUndefined();
    expect(sheet.bbox.maxX).toBeCloseTo(1190.55, 0);
    expect(sheet.bbox.maxY).toBeCloseTo(841.89, 0);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/plan scanné/);
    expect(doc.warnings[0]).toMatch(/posez la règle/);
    expect(doc.warnings[0]).toMatch(/200 dpi/);
    expect(doc.storeysAligned).toBe(false);
  });

  it.fails('LIMITE CONNUE : rien n’est proposé sur un scan (ni échelle, ni contour, ni pièces)', async () => {
    const { doc } = await readFixture('scan_only_A3.pdf');
    expect(doc.sheets[0]!.detected.outline).toBeDefined();
  });

  it('layers_ocg.pdf (calques PDF, presque vide) : se lit sans erreur', async () => {
    const { doc, details } = await readFixture('layers_ocg.pdf');
    expect(doc.sheets).toHaveLength(1);
    expect(details.raw[0]!.segs).toHaveLength(6);
    expect(details.raw[0]!.texts.map((t) => t.s)).toEqual(['1000']);
    expect(doc.sheets[0]!.metresPerUnit).toBeNull();
    expect(details.pages[0]!.kind).toBe('empty');
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/sans dessin exploitable/);
  });
});

describe('calques PDF masqués', () => {
  it('layers_ocg_hidden.pdf : les traits d’un calque masqué ne sont pas lus', async () => {
    const shown = (await readFixture('layers_ocg.pdf')).details.raw[0]!;
    const hidden = (await readFixture('layers_ocg_hidden.pdf')).details.raw[0]!;
    // Le calque « A-DIMS (Cotes) » porte la ligne de cote (trait de 0,3 pt) ; « A-WALL (Murs) » le rectangle.
    expect(shown.segs.some((s) => s.w < 1)).toBe(true);
    expect(hidden.segs.some((s) => s.w < 1)).toBe(false);
    expect(hidden.segs).toHaveLength(4);
    expect(hidden.segs.every((s) => Math.abs(s.w - 1.4) < 0.01)).toBe(true);
  });

  it.fails('LIMITE CONNUE : le TEXTE d’un calque masqué est encore lu (pdf.js ne dit pas à quel calque il appartient)', async () => {
    const hidden = (await readFixture('layers_ocg_hidden.pdf')).details.raw[0]!;
    expect(hidden.texts).toHaveLength(0);
  });
});

describe('texte en allemand sur demande', () => {
  it('analysePdf(…, { lang: "de" }) rend noms de feuilles et remarques en allemand', async () => {
    const raw = (await readFixture('de_A3_1-50.pdf')).details.raw;
    const { doc } = analysePdf(raw, 'de_A3_1-50.pdf', { lang: 'de' });
    expect(doc.sheets.map((s) => s.name)).toEqual(['Erdgeschoss', 'Obergeschoss']);
    expect(doc.sheets[0]!.metresPerUnit!.note).toMatch(/^Maßstab 1:50/);
    expect(doc.warnings[0]).toMatch(/^Seite 3: Schnitt oder Ansicht/);
  });
});
