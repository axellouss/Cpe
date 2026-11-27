import { describe, expect, it } from 'vitest';
import type { EnvelopeRow, VolumeRow, ZoneRow } from '../../src/core/types';
import { envelopeDeductLines, envelopePasteBlock, luxeebEnvelopeRows, PASTE_EOL, volumesPasteBlock, zonesPasteBlock } from '../../src/export';
import { ENVELOPE_BLOCK, makeEnvelope, makeSheets, VOLUMES_BLOCK, ZONES_BLOCK } from './fixtures';

/** Relit un bloc comme le ferait un tableur : lignes séparées par CRLF, cellules par tabulation. */
function grid(block: string): string[][] {
  return block.split('\r\n').map((l) => l.split('\t'));
}

describe('envelopePasteBlock', () => {
  it('produit exactement le bloc attendu', () => {
    expect(envelopePasteBlock(makeEnvelope())).toBe(ENVELOPE_BLOCK);
  });

  it('a une ligne par élément et quatre cellules par ligne : Anzahl, Länge, Breite, Orientierung', () => {
    const cells = grid(envelopePasteBlock(makeEnvelope()));
    expect(cells).toHaveLength(6);
    for (const line of cells) expect(line).toHaveLength(4);
    expect(cells[0]).toEqual(['2,00', '1,20', '1,35', 'Nord']);
    expect(cells[2]).toEqual(['1,00', '8,00', '2,80', 'Ost']);
  });

  it('n’a ni en-tête, ni fin de ligne finale, ni point décimal, ni saut de ligne isolé', () => {
    const block = envelopePasteBlock(makeEnvelope());
    expect(block.startsWith('2,00')).toBe(true);
    expect(block.endsWith('\n')).toBe(false);
    expect(block).not.toContain('.');
    expect(block.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(PASTE_EOL).toBe('\r\n');
  });

  it('garde les lignes à déduire à leur place et sait dire lesquelles marquer « x »', () => {
    const rows = makeEnvelope();
    expect(envelopeDeductLines(rows)).toEqual([1]);
    const second = rows.map((r, i) => (i === 3 ? { ...r, deduct: true } : r));
    expect(envelopeDeductLines(second)).toEqual([1, 4]);
    expect(grid(envelopePasteBlock(second))).toHaveLength(6);
    expect(envelopeDeductLines([])).toEqual([]);
  });

  it('rend une chaîne vide sans ligne', () => {
    expect(envelopePasteBlock([])).toBe('');
  });

  it('arrondit au centimètre et laisse vide une cellule sans valeur', () => {
    const [first] = makeEnvelope();
    const odd: EnvelopeRow = { ...first!, count: 3, length: 1.005, width: Number.NaN, orientation: 'SW' };
    expect(envelopePasteBlock([odd])).toBe('3,00\t1,01\t\tSüdwest');
  });

  it('couvre les neuf orientations de l’outil', () => {
    const [first] = makeEnvelope();
    const all = (['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'H'] as const).map((orientation) => ({ ...first!, orientation }));
    expect(grid(envelopePasteBlock(all)).map((l) => l[3])).toEqual(['Nord', 'Nordost', 'Ost', 'Südost', 'Süd', 'Südwest', 'West', 'Nordwest', 'Horizontal']);
  });
});

describe('luxeebEnvelopeRows', () => {
  it('ne change rien quand toutes les parois perdent de la chaleur', () => {
    const rows = makeEnvelope();
    expect(luxeebEnvelopeRows(rows)).toEqual(rows);
  });

  it('retire une paroi vers un local chauffé avec les fenêtres qui s’y déduisaient', () => {
    const rows = makeEnvelope();
    const base = rows[2]!;
    const windowOnParty: EnvelopeRow = { ...rows[0]!, id: 'x1', boundary: 'heated', orientation: 'W' };
    const partyWall: EnvelopeRow = { ...base, id: 'x2', boundary: 'heated', orientation: 'W' };
    const mixed = [rows[0]!, rows[1]!, windowOnParty, partyWall, rows[2]!];
    expect(luxeebEnvelopeRows(mixed).map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
    // Le « x » de la fenêtre retirée ne doit pas se reporter sur le mur est.
    expect(envelopeDeductLines(luxeebEnvelopeRows(mixed))).toEqual([1]);
  });

  it('garde une ligne à déduire restée sans paroi (le guide la signale)', () => {
    const rows = makeEnvelope();
    const orphan: EnvelopeRow = { ...rows[0]!, id: 'orphan' };
    expect(luxeebEnvelopeRows([rows[1]!, orphan]).map((r) => r.id)).toEqual(['e2', 'orphan']);
  });
});

describe('zonesPasteBlock et volumesPasteBlock', () => {
  it('produisent exactement les blocs attendus', () => {
    const sheets = makeSheets();
    expect(zonesPasteBlock(sheets.zones)).toBe(ZONES_BLOCK);
    expect(volumesPasteBlock(sheets.volumes)).toBe(VOLUMES_BLOCK);
  });

  it('portent la surface par la cellule « Länge », comme l’exemple du manuel (1,00 × 1,00 × 186,00)', () => {
    const zone: ZoneRow = { id: 'z', label: 'Wohnräume mit Lüftung', area: 186, clearHeight: 2.5, airVolume: 465, from: 'user', storeyId: null };
    expect(zonesPasteBlock([zone])).toBe('Wohnräume mit Lüftung\t1,00\t1,00\t186,00');
    const volume: VolumeRow = { id: 'v', label: 'Gebäude', area: 222.5, height: 2.8, volume: 623, from: 'user', storeyId: null };
    expect(volumesPasteBlock([volume])).toBe('Gebäude\t1,00\t1,00\t222,50\t2,80');
  });

  it('séparent plusieurs lignes par CRLF', () => {
    const sheets = makeSheets();
    const two = [sheets.zones[0]!, { ...sheets.zones[0]!, id: 'z1', label: 'Étage', area: 55.25 }];
    expect(zonesPasteBlock(two)).toBe(`${ZONES_BLOCK}\r\nÉtage\t1,00\t1,00\t55,25`);
    expect(zonesPasteBlock([])).toBe('');
    expect(volumesPasteBlock([])).toBe('');
  });

  it('ne laissent pas un libellé casser la grille ni lancer une formule', () => {
    const sheets = makeSheets();
    const nasty = [
      { ...sheets.zones[0]!, label: 'Séjour\tcuisine\r\nRDC' },
      { ...sheets.zones[0]!, label: '=HYPERLINK("http://x";"clic")' },
      { ...sheets.zones[0]!, label: '-1 Sous-sol' },
    ];
    const cells = grid(zonesPasteBlock(nasty));
    expect(cells).toHaveLength(3);
    for (const line of cells) expect(line).toHaveLength(4);
    expect(cells[0]![0]).toBe('Séjour cuisine RDC');
    expect(cells[1]![0]).toBe(`'=HYPERLINK("http://x";"clic")`);
    expect(cells[2]![0]).toBe("'-1 Sous-sol");

    const volumeCells = grid(volumesPasteBlock([{ ...sheets.volumes[0]!, label: '@x\ty' }]));
    expect(volumeCells).toEqual([["'@x y", '1,00', '1,00', '80,00', '2,80']]);
  });
});
