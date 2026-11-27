/**
 * Lignes ajoutées à la main par l'expert (lucarne, véranda, mur de cage d'escalier…) : elles suivent les lignes
 * calculées, dans l'ordre de l'expert, avec la même règle « Abzug » entre elles.
 */
import { describe, expect, it } from 'vitest';
import type { ManualRow } from '../../src/core/types';
import { deriveSheets } from '../../src/engine';
import { NORTH, brief, codes, finding, project, rect, storey, windowAt } from './helpers';

const row = (id: string, patch: Partial<ManualRow>): ManualRow => ({
  id,
  label: '',
  constructionId: null,
  windowTypeId: null,
  count: 1,
  length: 1,
  width: 1,
  orientation: 'S',
  boundary: 'outside',
  deduct: false,
  ...patch,
});

function withManualRows(rows: ManualRow[]) {
  return project([storey('rdc', 'RDC', rect(10, 8), { netArea: 64, openings: [windowAt(NORTH, 2, 1.5, 4)] })], { manualRows: rows });
}

describe('lignes manuelles', () => {
  const lucarne = [
    row('f', { label: 'Lucarne – fenêtres', windowTypeId: 'window-default', count: 2, length: 1.2, width: 1.1, deduct: true }),
    row('j', { label: 'Lucarne – face et joues', constructionId: 'wall-outside', length: 6.004, width: 1.5 }),
    row('p', { orientation: 'H', boundary: 'unheated', length: 4, width: 3 }), // sans type ni libellé
  ];
  const sheets = deriveSheets(withManualRows(lucarne), 'fr');
  const manualRows = sheets.envelope.filter((r) => r.manual);

  it('viennent après toutes les lignes calculées, dans l’ordre de l’expert', () => {
    expect(sheets.envelope.map((r) => r.manual)).toEqual([false, false, false, false, false, false, false, true, true, true]);
    // Longueur 6,004 m arrondie au centimètre → 6,00
    expect(manualRows.map(brief)).toEqual(['window S 2 × 1.20 × 1.10 Abzug', 'wall S 1 × 6.00 × 1.50', 'ceiling H 1 × 4.00 × 3.00']);
    expect(manualRows.map((r) => r.id)).toEqual(['manual:f', 'manual:j', 'manual:p']);
    expect(manualRows.every((r) => r.from === 'user' && r.storeyId === null)).toBe(true);
  });

  it('appliquent la règle « Abzug » entre elles', () => {
    // Fenêtres : 2 × 1,20 × 1,10 = 2,64 ; face et joues : 6,00 × 1,50 = 9,00 → net 6,36 ; plancher haut 12
    expect(manualRows.map((r) => [r.grossArea, r.netArea])).toEqual([
      [2.64, 2.64],
      [9, 6.36],
      [12, 12],
    ]);
    // La ligne calculée qui précède (la dalle) n'est pas touchée
    expect(sheets.envelope[6]).toMatchObject({ kind: 'floor', grossArea: 80, netArea: 80 });
  });

  it('prennent le genre et le nom du type choisi ; sans type, un type par défaut selon orientation et milieu', () => {
    expect(manualRows.map((r) => [r.kind, r.elementName, r.label])).toEqual([
      ['window', 'Fenêtre', 'Lucarne – fenêtres'],
      ['wall', 'Mur extérieur', 'Lucarne – face et joues'],
      ['ceiling', 'Plancher haut sous grenier non chauffé', 'Plancher haut sous grenier non chauffé'], // libellé vide → nom du type
    ]);
    const guessed = deriveSheets(
      withManualRows([
        row('a', { orientation: 'E', boundary: 'ground' }),
        row('b', { orientation: 'H', boundary: 'outside' }),
        row('c', { orientation: 'H', boundary: 'ground' }),
        row('d', { deduct: true }),
        row('e', { constructionId: 'door', deduct: true }),
        row('g', { orientation: 'W' }),
      ]),
      'fr',
    ).envelope.filter((r) => r.manual);
    expect(guessed.map((r) => [r.kind, r.constructionId ?? r.windowTypeId])).toEqual([
      ['wall', 'wall-ground'],
      ['roof', 'roof'],
      ['floor', 'floor-ground'],
      ['window', 'window-default'],
      ['door', 'door'],
      ['wall', 'wall-outside'],
    ]);
  });

  it('entrent dans les totaux et les récapitulatifs', () => {
    const without = deriveSheets(withManualRows([]), 'fr');
    // + 9 m² de mur et + 12 m² de plancher haut ; les fenêtres déduites ne s'ajoutent pas à l'enveloppe
    expect(sheets.totals.envelopeArea).toBeCloseTo(without.totals.envelopeArea + 9 + 12, 6);
    expect(sheets.totals.windowArea).toBeCloseTo(without.totals.windowArea + 2.64, 6);
    expect(sheets.totals.facadeArea).toBeCloseTo(without.totals.facadeArea + 9, 6);
    expect(sheets.totals.ve).toBe(without.totals.ve); // le volume ne vient que des étages
    const wall = (s: typeof sheets) => s.constructions.find((c) => c.constructionId === 'wall-outside')!.area;
    expect(wall(sheets)).toBeCloseTo(wall(without) + 6.36, 6);
    expect(sheets.windows[0]).toMatchObject({ count: 6, area: 14.64 }); // 4 × 3 m² + 2 × 1,32 m²
    expect(sheets.constructions.find((c) => c.constructionId === 'ceiling-attic')).toMatchObject({ boundary: 'unheated', area: 12 });
  });

  it('signalent une déduction plus grande que la paroi', () => {
    const d = deriveSheets(withManualRows([row('f', { windowTypeId: 'window-default', length: 3, width: 2, deduct: true }), row('m', { label: 'Petit mur', length: 2, width: 2 })]), 'fr');
    expect(finding(d, 'windows.exceedWall')).toEqual({
      code: 'windows.exceedWall',
      severity: 'block',
      params: { wall: 'Petit mur', wallArea: '4,00', openingArea: '6,00' },
    });
    expect(d.envelope.find((r) => r.id === 'manual:m')!.netArea).toBe(-2);
  });

  it('signalent une ligne « à déduire » sans paroi à la suite, et la gardent visible en fin de tableau', () => {
    const d = deriveSheets(withManualRows([row('m', { length: 5, width: 2 }), row('f', { windowTypeId: 'window-default', deduct: true })]), 'fr');
    expect(finding(d, 'abzug.dangling')).toEqual({ code: 'abzug.dangling', severity: 'warn', params: { count: 1 } });
    const last = d.envelope[d.envelope.length - 1]!;
    expect(last).toMatchObject({ id: 'manual:f', deduct: true });
    expect(d.envelope.find((r) => r.id === 'manual:m')!.netArea).toBe(10); // rien n'en a été déduit
  });

  it('laissent hors tableau une ligne contre un local chauffé', () => {
    const d = deriveSheets(withManualRows([row('h', { boundary: 'heated', length: 8, width: 2.8 })]), 'fr');
    expect(d.envelope.some((r) => r.manual)).toBe(false);
    expect(codes(d)).toContain('manual.heatedIgnored');
  });

  it('seules, sans aucun étage : le tableau contient les lignes manuelles et le blocage « aucun étage »', () => {
    const d = deriveSheets(project([], { manualRows: [row('m', { constructionId: 'wall-outside', length: 5, width: 2 })] }), 'fr');
    expect(d.envelope.map(brief)).toEqual(['wall S 1 × 5.00 × 2.00']);
    expect(d.totals).toMatchObject({ envelopeArea: 10, ve: 0, aOverVe: 0, an: 0 });
    expect(d.findings.map((f) => [f.code, f.severity])).toEqual([
      ['model.noStorey', 'block'],
      ['uvalues.missing', 'info'],
    ]);
  });
});
