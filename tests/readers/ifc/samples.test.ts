/**
 * Contrôle FACULTATIF sur les modèles IFC réels de la recherche (téléchargements tiers, hors dépôt).
 * Indiquer leur dossier dans la variable d'environnement PLAN2CPE_IFC_SAMPLES ; sans elle, ou si un fichier
 * manque, les tests correspondants sont sautés.
 *
 * Valeurs attendues : notes de recherche IFC § 2.3 (calcul à la main et deux chaînes d'outils indépendantes,
 * ifcopenshell + shapely et web-ifc + trame, d'accord à 0,5 %).
 */
import { describe, expect, it } from 'vitest';
import { polygonArea } from '../../../src/core/geometry';
import type { PlanDocument } from '../../../src/core/types';
import { readIfc } from '../../../src/readers/ifc';
import { nodeFs, samplesDir } from './helpers';

const dir = samplesDir();
const fs = dir ? await nodeFs() : null;
const has = (name: string): boolean => dir !== null && fs !== null && fs.existsSync(`${dir}/${name}`);

async function read(name: string): Promise<PlanDocument> {
  const bytes = fs!.readFileSync(`${dir}/${name}`);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return readIfc(buffer, name);
}

const areaOf = (doc: PlanDocument, sheet: number): number => polygonArea(doc.sheets[sheet]!.detected.outline ?? []);
const exterior = (doc: PlanDocument, kind: 'window' | 'door'): { n: number; area: number } => {
  let n = 0;
  let area = 0;
  for (const s of doc.sheets) {
    for (const o of s.detected.openings) {
      if (o.exterior && o.kind === kind) {
        n++;
        area += (o.width ?? 0) * (o.height ?? 0);
      }
    }
  }
  return { n, area };
};

describe('modèles IFC réels (facultatif)', () => {
  it.skipIf(!has('AC20-FZK-Haus.ifc'))('AC20-FZK-Haus : 120,0 m² par étage, 23,6 m² de fenêtres, nord à 310°', async () => {
    const doc = await read('AC20-FZK-Haus.ifc');
    expect(doc.sheets.map((s) => s.name)).toEqual(['Erdgeschoss', 'Dachgeschoss']);
    expect(areaOf(doc, 0)).toBeCloseTo(120, 1);
    expect(areaOf(doc, 1)).toBeCloseTo(120, 1);
    expect(doc.sheets[0]!.detected.outline).toHaveLength(4);
    expect(exterior(doc, 'window')).toEqual({ n: 11, area: expect.closeTo(23.6, 2) });
    expect(exterior(doc, 'door')).toEqual({ n: 2, area: expect.closeTo(6.8, 1) });
    expect(doc.northAngle?.value).toBeCloseTo(310, 0);
    expect(doc.sheets[0]!.detected.storeyHeight).toBeCloseTo(2.7, 2);
    expect(doc.sheets[0]!.detected.rooms).toHaveLength(6);
    // « Galerie » sous rampants : 107,16 m² au sol, ~94,6 m² avec au moins 1,0 m de hauteur libre.
    const galerie = doc.sheets[1]!.detected.rooms[0]!;
    expect(galerie.measuredArea!).toBeGreaterThan(93);
    expect(galerie.measuredArea!).toBeLessThan(96);
    expect(galerie.statedArea).toBeCloseTo(74.51, 1);
  });

  it.skipIf(!has('AC11-FZK-Haus-IFC.ifc'))('AC11-FZK-Haus : mêmes surfaces, nord par défaut donc non repris', async () => {
    const doc = await read('AC11-FZK-Haus-IFC.ifc');
    expect(areaOf(doc, 0)).toBeCloseTo(120, 1);
    expect(areaOf(doc, 1)).toBeCloseTo(120, 1);
    expect(exterior(doc, 'window').area).toBeCloseTo(23.6, 2);
    expect(doc.northAngle).toBeUndefined();
  });

  it.skipIf(!has('AC11-Institute-Var-2-IFC.ifc'))('AC11-Institute : 2592 m² sur 5 niveaux, 309,5 m² de fenêtres', async () => {
    const doc = await read('AC11-Institute-Var-2-IFC.ifc');
    expect(doc.sheets).toHaveLength(5);
    expect(doc.sheets.reduce((a, _, i) => a + areaOf(doc, i), 0)).toBeCloseTo(2592, 0);
    expect(exterior(doc, 'window')).toEqual({ n: 206, area: expect.closeTo(309.5, 1) });
  });

  it.skipIf(!has('AC9R1-Haus-G-H-Ver2-2x3.ifc'))('AC9R1-Haus-G-H : 443 m² sur 4 niveaux, 68,5 m² de fenêtres', async () => {
    const doc = await read('AC9R1-Haus-G-H-Ver2-2x3.ifc');
    expect(doc.sheets.map((s) => s.name)).toEqual(['Keller', 'Erdgeschoss', 'Obergeschoss', 'Dachgeschoss']);
    const total = doc.sheets.reduce((a, _, i) => a + areaOf(doc, i), 0);
    expect(Math.abs(total - 443.26) / 443.26).toBeLessThan(0.01);
    expect(exterior(doc, 'window').area).toBeCloseTo(68.46, 1);
  });

  it.skipIf(!has('Ifc2x3_Duplex_Architecture.ifc'))('Duplex (Revit) : 2 étages de 156,6 m², niveaux auxiliaires et local « Roof » écartés', async () => {
    const doc = await read('Ifc2x3_Duplex_Architecture.ifc');
    expect(doc.sheets.map((s) => s.name)).toEqual(['Level 1', 'Level 2']);
    expect(areaOf(doc, 0)).toBeCloseTo(156.64, 1);
    expect(areaOf(doc, 1)).toBeCloseTo(156.64, 1);
    expect(doc.northAngle).toBeUndefined();
    expect(doc.warnings.some((w) => /fenêtre\(s\) de toit/.test(w))).toBe(true);
    expect(doc.sheets[1]!.detected.rooms.some((r) => r.name === 'Roof')).toBe(false);
  });

  it.skipIf(!has('BasicHouse.ifc'))('BasicHouse (Revit, 53 Mo, mm) : 214,7 m², 38,2 m² de fenêtres, sans trianguler les menuiseries', async () => {
    const doc = await read('BasicHouse.ifc');
    expect(doc.sheets).toHaveLength(1);
    expect(areaOf(doc, 0)).toBeCloseTo(214.7, 1);
    expect(exterior(doc, 'window')).toEqual({ n: 19, area: expect.closeTo(38.18, 1) });
    expect(doc.warnings.some((w) => /Aucun local/.test(w))).toBe(true);
  }, 30_000);
});
