/**
 * Lecture d'un PDF de bout en bout : fonction du contrat (`readPdf`), extraction pdf.js, erreurs, dictionnaires.
 */
import { describe, expect, it } from 'vitest';
import { knownKeys } from '../../../src/i18n';
import { readPlanFile } from '../../../src/readers';
import { PDF_MESSAGES, PdfReadError, readPdf, readPdfDetailed } from '../../../src/readers/pdf';
import { fixtureBytes, readFixture } from './helpers';

describe('readPdf', () => {
  it('rend le document du contrat et laisse intact le tampon reçu', async () => {
    const data = fixtureBytes('fr_A3_1-100.pdf');
    const size = data.byteLength;
    const doc = await readPdf(data, 'fr_A3_1-100.pdf');
    // pdf.js prend possession des tampons qu'on lui passe : le lecteur lui donne une copie.
    expect(data.byteLength).toBe(size);
    expect(doc.kind).toBe('pdf');
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    expect(doc.storeysAligned).toBe(false);
    for (const s of doc.sheets) {
      expect(s.segments).toBeInstanceOf(Float32Array);
      expect(s.metresPerUnit!.value).toBeCloseTo((100 * 0.0254) / 72, 9);
      expect(Array.isArray(s.detected.notes)).toBe(true);
    }
    // Le même fichier relu donne le même résultat.
    const again = await readPdf(data, 'fr_A3_1-100.pdf');
    expect(again.sheets.map((s) => [s.id, s.name, s.detected.outline])).toEqual(doc.sheets.map((s) => [s.id, s.name, s.detected.outline]));
  });

  it('est appelé par le point d’entrée commun des lecteurs', async () => {
    const data = fixtureBytes('de_A3_1-50.pdf');
    const doc = await readPlanFile({ name: 'plans.pdf', arrayBuffer: async () => data });
    expect(doc.kind).toBe('pdf');
    expect(doc.sheets).toHaveLength(2);
    const scan = fixtureBytes('scan_fr_100dpi.jpg');
    const image = await readPlanFile({ name: 'scan.jpg', arrayBuffer: async () => scan });
    expect(image.kind).toBe('image');
    expect(image.sheets[0]!.bbox.maxX).toBe(1654);
  });

  it('fichier qui n’est pas un PDF : erreur claire, en français', async () => {
    const junk = new TextEncoder().encode('ceci n’est pas un PDF').buffer as ArrayBuffer;
    await expect(readPdf(junk, 'faux.pdf')).rejects.toBeInstanceOf(PdfReadError);
    await expect(readPdf(junk, 'faux.pdf')).rejects.toThrow(/illisible ou abîmé/);
  });

  it('PDF protégé par mot de passe : erreur qui le dit', async () => {
    const error = await readPdf(fixtureBytes('protected.pdf'), 'protected.pdf').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PdfReadError);
    expect((error as PdfReadError).reason).toBe('password');
    expect((error as PdfReadError).message).toMatch(/mot de passe/);
  });

  it('messages en allemand sur demande', async () => {
    const { doc } = await readPdfDetailed(fixtureBytes('fr_A4_fit.pdf'), 'fr_A4_fit.pdf', { lang: 'de' });
    expect(doc.sheets.map((s) => s.name)).toEqual(['Erdgeschoss', 'Obergeschoss']);
    expect(doc.warnings.some((w) => /Schriftfeld steht 1:100/.test(w))).toBe(true);
  });
});

describe('extraction pdf.js', () => {
  it('retrouve textes et traits du plan français, avec leurs épaisseurs réelles', async () => {
    const raw = (await readFixture('fr_A3_1-100.pdf')).details.raw[0]!;
    expect(raw.width).toBeCloseTo(1190.551, 2);
    expect(raw.height).toBeCloseTo(841.89, 2);
    expect(raw.texts).toHaveLength(91);
    expect(raw.segs).toHaveLength(553);
    expect(raw.images).toBe(0);
    expect(raw.truncated).toBe(false);
    const widths = [...new Set(raw.segs.filter((s) => s.stroke).map((s) => s.w.toFixed(2)))].sort();
    expect(widths).toEqual(['0.26', '0.37', '0.51', '0.71', '1.42', '1.98']);
    // Accents et exposants arrivent tels quels ; les cotes verticales se lisent de bas en haut.
    expect(raw.texts.some((t) => t.s === 'Rez-de-chaussée')).toBe(true);
    expect(raw.texts.some((t) => t.s === '32,45 m²')).toBe(true);
    expect(raw.texts.filter((t) => Math.abs(t.angle - 90) < 1)).toHaveLength(14);
    expect(raw.segs.some((s) => s.dash)).toBe(true);
    expect(raw.segs.some((s) => s.curve)).toBe(true);
  });

  it('applique l’échelle des Form XObjects aux épaisseurs (plan réduit pour tenir sur un A4)', async () => {
    const raw = (await readFixture('fr_A4_fit.pdf')).details.raw[0]!;
    expect(raw.segs).toHaveLength(553);
    const widths = [...new Set(raw.segs.filter((s) => s.stroke).map((s) => s.w.toFixed(2)))].sort();
    expect(widths).toEqual(['0.18', '0.26', '0.36', '0.50', '1.00', '1.40']);
  });

  it('plan allemand : remplissages des murs distingués des traits, trois pages', async () => {
    const raw = (await readFixture('de_A3_1-50.pdf')).details.raw;
    expect(raw.map((p) => p.texts.length)).toEqual([57, 42, 32]);
    expect(raw.map((p) => p.segs.filter((s) => s.stroke).length)).toEqual([321, 219, 85]);
    expect(raw[0]!.segs.some((s) => s.fill && !s.stroke)).toBe(true);
    expect(raw[0]!.texts.some((t) => t.s === 'Maßstab 1:50')).toBe(true);
  });
});

describe('dictionnaires', () => {
  it('français et allemand ont les mêmes clés, toutes enregistrées', () => {
    const fr = Object.keys(PDF_MESSAGES.fr).sort();
    const de = Object.keys(PDF_MESSAGES.de).sort();
    expect(de).toEqual(fr);
    const registered = new Set(knownKeys('fr'));
    for (const key of fr) expect(registered.has(key)).toBe(true);
    for (const key of fr) {
      const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
      expect(vars(PDF_MESSAGES.de[key]!), key).toEqual(vars(PDF_MESSAGES.fr[key]!));
    }
  });

  it('aucun message ne sort avec une clé ou une variable non remplacée', async () => {
    for (const name of ['fr_A3_1-100.pdf', 'fr_A4_fit.pdf', 'fr_A3_rot90.pdf', 'de_A3_1-50.pdf', 'cad_plot_ezdxf.pdf', 'scan_only_A3.pdf', 'layers_ocg.pdf']) {
      const { doc } = await readFixture(name);
      const texts = [...doc.warnings, ...doc.sheets.flatMap((s) => [...s.detected.notes, s.metresPerUnit?.note ?? '', s.name]), doc.northAngle?.note ?? ''];
      for (const text of texts) {
        expect(text).not.toMatch(/\{\w+\}/);
        expect(text).not.toMatch(/^pdf\./);
      }
    }
  });
});
