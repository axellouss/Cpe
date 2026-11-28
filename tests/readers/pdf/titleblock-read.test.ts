/**
 * Champs du cartouche : objet, phase, type de bâtiment et logements, neuf ou existant, adresse du projet distinguée
 * des autres adresses, date et année, indice, échelle, format. Cartouches inventés, en français et en allemand.
 */
import { describe, expect, it } from 'vitest';
import { readTitleBlock, titleBlockFields } from '../../../src/readers/pdf/titleblock';
import { box, lines, mk } from '../../semantics/lines';

/** Cartouche français à colonnes : intitulés en petit corps, valeurs dessous. */
function cartoucheFr(): ReturnType<typeof mk>[] {
  return [
    mk('PROJET :', 1010, 20, 4), mk("Construction d'une", 1010, 32, 10), mk('maison unifamiliale', 1010, 44, 10),
    mk('DATE :', 1200, 20, 4), mk('03.02.2025', 1200, 28, 6), mk('ÉCHELLE :', 1260, 20, 4), mk('1/50', 1260, 28, 6),
    mk('PHASE :', 1010, 70, 4), mk('Autorisation de bâtir', 1010, 78, 6),
    mk('ADRESSE :', 1110, 70, 4), mk('Maison Essai – Lot 3', 1110, 78, 6), mk('7, rue Fictive', 1110, 86, 6), mk('L-0000 Exempleville', 1110, 94, 6),
    mk('FORMAT :', 1260, 70, 4), mk('A2', 1260, 78, 6),
    mk('INDICE :', 1010, 120, 4), mk('C', 1010, 134, 14),
    mk('MODIFICATIONS :', 1060, 120, 4), mk('A. Première version', 1060, 128, 6), mk('DATE :', 1260, 120, 4), mk('10.12.2024', 1260, 128, 6),
    mk("MAÎTRE D'OUVRAGE :", 1010, 160, 4), mk('Famille Essai', 1010, 168, 6), mk('1, allée Inventée', 1010, 176, 6), mk('L-0001 Fictiveville', 1010, 184, 6),
    mk('ARCHITECTE :', 1200, 160, 4), mk('Atelier Essai', 1200, 168, 6), mk('2, place Modèle', 1200, 176, 6), mk('L-0002 Démoville', 1200, 184, 6),
  ];
}

describe('readTitleBlock', () => {
  it('cartouche français : tous les champs, et l’adresse du projet sous « Adresse »', () => {
    const { titleBlock: tb, details } = readTitleBlock(lines(cartoucheFr()), box(1000, 0, 1400, 200));
    expect(tb).toMatchObject({
      project: "Construction d'une maison unifamiliale",
      phase: 'Autorisation de bâtir',
      street: '7, rue Fictive',
      postcode: 'L-0000',
      locality: 'Exempleville',
      date: '03.02.2025',
      year: 2025,
      index: 'C',
      scaleDen: 50,
      format: 'A2',
      page: 1,
    });
    expect(tb.buildingType).toMatchObject({ value: 'EFH', doubt: null });
    expect(tb.dwellings).toMatchObject({ value: 1 });
    expect(tb.occasion).toMatchObject({ value: 'new', doubt: null });
    expect(tb.occasion!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(tb.confidence).toBeGreaterThanOrEqual(0.85);
    expect(details.addresses.map((a) => [a.under, a.postcode])).toEqual([['address', 'L-0000'], ['owner', 'L-0001'], ['architect', 'L-0002']]);
    expect(details.owner[0]).toBe('Famille Essai');
    expect(details.doubts).toEqual([]);
  });

  it('cartouche allemand en une colonne, intitulé et valeur sur la même ligne', () => {
    const texts = [
      mk('Bauvorhaben:', 1010, 20, 4), mk('Neubau eines', 1010, 30, 6), mk('Einfamilienhauses mit Garage', 1010, 38, 6), mk('Haus Muster – Lot 4', 1010, 46, 6), mk('3, Rue Exemple', 1010, 54, 6), mk('L-0000 Exempleville', 1010, 62, 6),
      mk('Bauherr:', 1010, 90, 4), mk('Familie Muster', 1010, 98, 6), mk('L-9999 Autreville', 1010, 106, 6),
      mk('Gemeinde:', 1010, 130, 4), mk('Administration communale', 1010, 138, 6), mk("d'Exempleville", 1010, 146, 6),
      mk('Phase: Baugenehmigung', 1010, 170, 6), mk('Maßstab: 1:100', 1010, 178, 6), mk('Format: A3', 1010, 186, 6), mk('Datum: 05.02.2025', 1010, 194, 6), mk('Index: B', 1010, 202, 6),
    ];
    const { titleBlock: tb, details } = readTitleBlock(lines(texts), null, { lang: 'de' });
    expect(tb).toMatchObject({ project: 'Neubau eines Einfamilienhauses mit Garage', phase: 'Baugenehmigung', postcode: 'L-0000', street: '3, Rue Exemple', year: 2025, index: 'B', scaleDen: 100, format: 'A3' });
    expect(tb.buildingType!.value).toBe('EFH');
    expect(tb.occasion!.value).toBe('new');
    expect(details.addresses.find((a) => a.under === 'owner')!.postcode).toBe('L-9999');
    expect(details.commune).toBe('Exempleville');
    expect(tb.box).not.toBeNull();
  });

  it('collectif « 6 logements » ; collectif sans nombre → question', () => {
    const six = readTitleBlock(lines([mk('PROJET:', 10, 10, 4), mk("Construction d'une résidence de 6 logements", 10, 20, 8)]), null).titleBlock;
    expect(six.buildingType).toMatchObject({ value: 'MFH' });
    expect(six.dwellings).toMatchObject({ value: 6 });
    const some = readTitleBlock(lines([mk('OBJET :', 10, 10, 4), mk('Immeuble résidentiel', 10, 20, 8)]), null);
    expect(some.titleBlock.buildingType!.value).toBe('MFH');
    expect(some.titleBlock.dwellings).toBeNull();
    expect(some.details.doubts.join(' ')).toMatch(/combien de logements/);
  });

  it('« Transformation » → bâtiment existant, à confirmer', () => {
    const { titleBlock: tb } = readTitleBlock(lines([mk('OBJET:', 10, 10, 4), mk("Transformation et agrandissement d'une maison", 10, 20, 8), mk('PHASE:', 10, 40, 4), mk('Autorisation de bâtir', 10, 50, 8)]), null);
    expect(tb.occasion).toMatchObject({ value: 'existing' });
    expect(tb.occasion!.confidence).toBeLessThan(0.65);
    expect(tb.occasion!.doubt).toMatch(/existant/);
  });

  it('sans intitulé « Adresse » : on ne prend pas l’adresse du maître d’ouvrage', () => {
    const { titleBlock: tb, details } = readTitleBlock(lines([mk('PROJET :', 10, 10, 4), mk('Maison unifamiliale', 10, 20, 8), mk("MAÎTRE D'OUVRAGE :", 10, 50, 4), mk('M. Essai', 10, 58, 6), mk('L-0001 Fictiveville', 10, 66, 6)]), null);
    expect(tb.postcode).toBeNull();
    expect(details.doubts.join(' ')).toMatch(/Laquelle/);
  });

  it('la date du plan l’emporte sur celle du tableau des modifications', () => {
    const texts = [mk('MODIFICATIONS :', 10, 10, 4), mk('A. Indice A', 10, 18, 6), mk('DATE :', 120, 10, 4), mk('01.01.2024', 120, 18, 6), mk('DATE :', 10, 60, 4), mk('15.03.2025', 10, 68, 6)];
    expect(readTitleBlock(lines(texts), null).titleBlock).toMatchObject({ date: '15.03.2025', year: 2025 });
  });

  it('titleBlockFields : colonnes séparées par l’intitulé voisin de la même rangée', () => {
    const fields = titleBlockFields(lines(cartoucheFr()), null);
    expect(fields.find((f) => f.role === 'project')!.values).toEqual(["Construction d'une", 'maison unifamiliale']);
    expect(fields.find((f) => f.role === 'scale')!.values).toEqual(['1/50']);
  });
  it('cartouche allemand : rue écrite « nom + numéro », sur la ligne de l’intitulé ou dessous', () => {
    const inline = [
      mk('Bauvorhaben: Neubau Einfamilienhaus', 10, 10, 6),
      mk('Adresse: Musterstraße 4', 10, 30, 6), mk('L-0000 Exempleville', 10, 38, 6),
      mk('Bauherr: Familie Muster', 10, 60, 6), mk('L-9999 Autreville', 10, 68, 6),
      mk('Maßstab: 1:100', 10, 90, 6),
    ];
    const a = readTitleBlock(lines(inline), null, { lang: 'de' });
    expect(a.titleBlock).toMatchObject({ street: 'Musterstraße 4', postcode: 'L-0000', locality: 'Exempleville', scaleDen: 100 });
    expect(a.details.addresses.map((x) => [x.under, x.postcode])).toEqual([['address', 'L-0000'], ['owner', 'L-9999']]);
    expect(a.details.addressConfidence).toBe(0.9);
    const below = [mk('Bauort:', 10, 10, 4), mk('Hauptstr. 12a', 10, 18, 6), mk('L-0000 Exempleville', 10, 26, 6), mk('Projekt:', 120, 10, 4), mk('Umbau Wohnhaus', 120, 18, 6)];
    expect(readTitleBlock(lines(below), null).titleBlock).toMatchObject({ street: 'Hauptstr. 12a', postcode: 'L-0000' });
    const lux = [mk('ADRESSE :', 10, 10, 4), mk('Haaptstrooss 7', 10, 18, 6), mk('L-0000 Exempleville', 10, 26, 6)];
    expect(readTitleBlock(lines(lux), null).titleBlock.street).toBe('Haaptstrooss 7');
  });
});
