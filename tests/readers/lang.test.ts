/**
 * Les lecteurs parlent la langue de l'interface : noms de feuilles, notes et avertissements.
 */
import { describe, expect, it } from 'vitest';
import { readPlanFile } from '../../src/readers';
import { fixtureBytes as cadBytes } from './cad/helpers';
import { fixtureBytes as pdfBytes } from './pdf/helpers';

// Mots qui n'existent qu'en français (« des », « du », « Plan » se disent aussi en allemand).
const FRENCH_ONLY = /\b(les|lue|sur|contour|calque|échelle|unité|pièces?|trouvés?|dessin|feuille)\b/i;

function texts(doc: Awaited<ReturnType<typeof readPlanFile>>): string[] {
  return [
    ...doc.warnings,
    ...doc.sheets.flatMap((s) => [...s.detected.notes, ...(s.metresPerUnit?.note ? [s.metresPerUnit.note] : [])]),
    ...(doc.northAngle?.note ? [doc.northAngle.note] : []),
  ];
}

describe('langue des lecteurs', () => {
  it('DXF : français par défaut, allemand sur demande', async () => {
    const data = cadBytes('fixture_rdc_cm.dxf');
    const fr = await readPlanFile({ name: 'rdc.dxf', arrayBuffer: async () => data });
    const de = await readPlanFile({ name: 'rdc.dxf', arrayBuffer: async () => data }, { lang: 'de' });
    expect(fr.sheets[0]!.name).toBe('Rez-de-chaussée');
    expect(de.sheets[0]!.name).toBe('Erdgeschoss');
    expect(texts(fr).length).toBeGreaterThan(0);
    expect(texts(de)).toHaveLength(texts(fr).length);
    for (const line of texts(de)) expect(line, line).not.toMatch(FRENCH_ONLY);
    // La géométrie ne dépend pas de la langue.
    expect(de.sheets[0]!.detected.outline).toEqual(fr.sheets[0]!.detected.outline);
    // Et une lecture en français après une lecture en allemand reste en français.
    const again = await readPlanFile({ name: 'rdc.dxf', arrayBuffer: async () => data });
    expect(texts(again)).toEqual(texts(fr));
  });

  it('PDF : allemand sur demande', async () => {
    const data = pdfBytes('fr_A3_1-100.pdf');
    const de = await readPlanFile({ name: 'plans.pdf', arrayBuffer: async () => data }, { lang: 'de' });
    expect(de.sheets.map((s) => s.name)).toEqual(['Erdgeschoss', 'Obergeschoss']);
    expect(texts(de).length).toBeGreaterThan(0);
    for (const line of texts(de)) expect(line, line).not.toMatch(FRENCH_ONLY);
  });
});
