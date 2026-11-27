import { describe, expect, it } from 'vitest';
import type { Lang } from '../../src/core/types';
import { buildGuide, sheetsToCsv } from '../../src/export';
import { registerMessages } from '../../src/i18n';
import { makeProject, makeSheets } from './fixtures';

const BOM = String.fromCharCode(0xfeff);

/** Lecteur CSV minimal (RFC 4180, séparateur « ; ») pour relire ce qu'Excel lirait. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ';') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csv(lang: Lang = 'fr'): string {
  return sheetsToCsv(makeSheets(), makeProject(), lang);
}

function rowsOf(text: string): string[][] {
  return parseCsv(text.slice(1));
}

/** Lignes d'un tableau : celles qui suivent la ligne de titre donnée, en-tête compris, jusqu'à la ligne vide. */
function tableAfter(rows: string[][], title: string): string[][] {
  const start = rows.findIndex((r) => r.length === 1 && r[0] === title);
  if (start < 0) throw new Error(`titre absent : ${title}`);
  const out: string[][] = [];
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.length === 1 && r[0] === '') break;
    out.push(r);
  }
  return out;
}

describe('sheetsToCsv — format', () => {
  it('commence par la marque UTF-8 (BOM), une seule fois', () => {
    const text = csv();
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).not.toContain(BOM);
    expect(text.slice(1).startsWith('Plan2CPE — relevé préparé pour LuxEeB-Tool')).toBe(true);
  });

  it('termine chaque ligne par CRLF, sans saut de ligne isolé', () => {
    const text = csv();
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('sépare par des points-virgules et écrit les nombres avec une virgule décimale', () => {
    const text = csv();
    expect(text).toContain('\r\n1;Fenêtre PVC;2,00;1,20;1,35;Nord;x;3,24;');
    expect(text).toContain('\r\n2;Mur extérieur;1,00;10,00;2,80;Nord;;24,76;');
    expect(text).toContain('\r\nZone chauffée – Rez-de-chaussée;1,00;1,00;68,40;2,50;171,00;estimation — à remplacer;\r\n');
    expect(text).toContain('\r\nRez-de-chaussée;1,00;1,00;80,00;2,80;224,00;lu sur le plan;\r\n');
    // aucun nombre à point décimal
    expect(text).not.toMatch(/\d\.\d/);
  });

  it('garde un nombre de cellules constant dans chaque tableau', () => {
    const rows = rowsOf(csv());
    const titles = [
      'Données du projet',
      'Grandeurs principales',
      "Berechnung der U-Werte von Bauteilen — Types d'éléments opaques",
      'Berechnung der U-Werte von transparenten Bauteilen — Types de fenêtres',
      "Flächeneingabe der Gebäudehülle — Surfaces de l'enveloppe",
      'Energiebezugsflächen / Zonen — Surface de référence énergétique (zones)',
      'Gebäudevolumen Ve — Volume brut chauffé',
      'Pièces et surface de référence énergétique',
      'Contrôles de plausibilité',
    ];
    // les tableaux se suivent dans l'ordre de saisie de l'outil
    const positions = titles.map((title) => rows.findIndex((r) => r.length === 1 && r[0] === title));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const title of titles) {
      const tb = tableAfter(rows, title);
      // au moins l'en-tête ; seul le tableau des contrôles est vide dans ce jeu d'essai
      expect(tb.length, title).toBeGreaterThan(title === 'Contrôles de plausibilité' ? 0 : 1);
      for (const r of tb) expect(r.length, `${title} : ${r.join('|')}`).toBe(tb[0]!.length);
    }
  });
});

describe('sheetsToCsv — contenu', () => {
  it('contient les données du projet avec leur provenance', () => {
    const tb = tableAfter(rowsOf(csv()), 'Données du projet');
    expect(tb[0]).toEqual(['Champ', 'Valeur', 'Provenance']);
    expect(tb).toContainEqual(['Bezeichnung — désignation', 'Maison Schmit', "saisi ou confirmé par l'expert"]);
    expect(tb).toContainEqual(['Straße, Nr. — rue et numéro', "12, rue de l'Église", "saisi ou confirmé par l'expert"]);
    expect(tb).toContainEqual(['Installation de chauffage', 'Chaudière gaz à condensation (installée en 2012)', "saisi ou confirmé par l'expert"]);
    expect(tb).toContainEqual(['Isolation ajoutée après coup — plancher bas', 'non renseigné', 'non renseigné — à saisir par vous']);
    expect(tb).toContainEqual(["Étanchéité à l'air n50", "pas de test d'étanchéité", 'valeur par défaut — à confirmer']);
  });

  it('contient les grandeurs principales avec unité et provenance', () => {
    const tb = tableAfter(rowsOf(csv()), 'Grandeurs principales');
    expect(tb[0]).toEqual(['Champ', 'Valeur', 'Unité', 'Provenance']);
    expect(tb.slice(1).map((r) => [r[1], r[2], r[3]])).toEqual([
      ['68,40', 'm²', 'estimation — à remplacer'],
      ['171,00', 'm³', 'estimation — à remplacer'],
      ['224,00', 'm³', 'lu sur le plan'],
      ['238,40', 'm²', 'valeur par défaut — à confirmer'],
      ['1,06', '1/m', 'valeur par défaut — à confirmer'],
      ['80,00', 'm²', 'calculé'],
      ['3,24', 'm²', 'lu sur le plan'],
      ['78,40', 'm²', 'lu sur le plan'],
    ]);
    expect(tb[1]![0]).toBe('Energiebezugsfläche An — surface de référence énergétique An');
  });

  it('contient toutes les lignes d’enveloppe, avec provenance et remarque en fin de ligne', () => {
    const tb = tableAfter(rowsOf(csv()), "Flächeneingabe der Gebäudehülle — Surfaces de l'enveloppe");
    expect(tb).toHaveLength(7);
    expect(tb[0]!.slice(-2)).toEqual(['Provenance', 'Remarque']);
    expect(tb[1]).toEqual([
      '1',
      'Fenêtre PVC',
      '2,00',
      '1,20',
      '1,35',
      'Nord',
      'x',
      '3,24',
      'Fenêtre 1,20 × 1,35 m – Nord (RDC)',
      'Nord (0°)',
      'extérieur',
      'lu sur le plan',
      'À déduire de la prochaine ligne sans « x ».',
    ]);
    expect(tb[6]!.slice(0, 8)).toEqual(['6', 'Dalle sur terre-plein', '1,00', '10,00', '8,00', 'Horizontal', '', '80,00']);
  });

  it.each(['fr', 'de'] as const)('garde toutes les colonnes du guide, aides de lecture comprises, et rien des repères internes (%s)', (lang) => {
    // À l'écran, les aides de lecture passent sous la ligne ; dans le fichier, elles restent des colonnes.
    const rows = rowsOf(csv(lang));
    const tables = buildGuide(makeSheets(), makeProject(), lang).flatMap((s) => s.tables);
    expect(tables.map((tb) => tb.key)).toEqual(['constructions', 'windowTypes', 'envelope', 'zones', 'volumes']);
    for (const tb of tables) {
      const header = rows.findIndex((r) => r.length === tb.columns.length + 2 && tb.columns.every((column, c) => r[c] === column));
      expect(header, tb.key).toBeGreaterThan(0);
      expect(tb.aside.every((c) => rows[header]![c] === tb.columns[c]), tb.key).toBe(true);
      tb.rows.forEach((row, i) => {
        expect(rows[header + 1 + i]!.slice(0, tb.columns.length), `${tb.key} ${row.id}`).toEqual(row.cells);
        // Rien d'autre que les cellules, la provenance et la remarque : ni identifiant ni empreinte de la ligne.
        expect(rows[header + 1 + i]!, `${tb.key} ${row.id}`).toHaveLength(tb.columns.length + 2);
      });
    }
    expect(csv(lang)).not.toContain('\u241F');
    expect(csv(lang)).not.toContain('c-wall|outside');
  });

  it('détaille les pièces de chaque étage, avec la provenance de leur surface', () => {
    expect(tableAfter(rowsOf(csv()), 'Pièces et surface de référence énergétique')).toEqual([
      ['Étage', 'Pièce', 'Surface nette [m²]', 'Comptée dans An', 'À trancher', 'Provenance', 'Remarque'],
      ['Rez-de-chaussée', 'Séjour', '42,30', 'Oui', '', 'lu sur le plan', 'Étiquette du plan'],
      ['Rez-de-chaussée', 'Buanderie', '9,10', 'Non', 'Oui', 'estimation — à remplacer', ''],
    ]);
    expect(tableAfter(rowsOf(csv('de')), 'Räume und Energiebezugsfläche')[2]).toEqual(['Rez-de-chaussée', 'Buanderie', '9,10', 'Nein', 'Ja', 'Schätzung — zu ersetzen', '']);
  });

  it('existe aussi en allemand', () => {
    const rows = rowsOf(csv('de'));
    expect(rows[0]).toEqual(['Plan2CPE — Aufmaß, vorbereitet für das LuxEeB-Tool']);
    const tb = tableAfter(rows, 'Flächeneingabe der Gebäudehülle — Flächen der Gebäudehülle');
    expect(tb[0]!.slice(0, 3)).toEqual(['Nr.', 'Bauteil — in der Auswahlliste wählen', 'Anzahl']);
    expect(tb[3]!.slice(5, 12)).toEqual(['Ost', '', '22,40', 'Mur extérieur – Est (RDC)', 'Ost (90°)', 'Außenluft', 'aus dem Plan gelesen']);
    expect(tableAfter(rows, 'Projektdaten')).toContainEqual(['Heizungsanlage', 'Gas-Brennwertkessel (Baujahr 2012)', 'vom Experten eingegeben oder bestätigt']);
  });

  it('traduit les contrôles par la clé « finding.<code> » et se replie proprement si elle manque', () => {
    registerMessages({
      fr: { 'finding.test.csv': '{storey} : surface de {area} m² estimée.' },
      de: { 'finding.test.csv': '{storey}: Fläche von {area} m² geschätzt.' },
    });
    const sheets = makeSheets();
    sheets.findings = [
      { code: 'test.inconnu', severity: 'info', params: { ratio: 0.5 } },
      { code: 'test.csv', severity: 'block', params: { storey: 'RDC; "neuf"', area: 68.4 } },
    ];
    const fr = tableAfter(rowsOf(sheetsToCsv(sheets, makeProject(), 'fr')), 'Contrôles de plausibilité');
    expect(fr).toEqual([
      ['Gravité', 'Code', 'Message'],
      ['Bloquant', 'test.csv', 'RDC; "neuf" : surface de 68,4 m² estimée.'],
      ['Information', 'test.inconnu', 'Contrôle « test.inconnu » (détails : ratio = 0,5)'],
    ]);
    const de = tableAfter(rowsOf(sheetsToCsv(sheets, makeProject(), 'de')), 'Plausibilitätsprüfungen');
    expect(de[1]).toEqual(['Blockierend', 'test.csv', 'RDC; "neuf": Fläche von 68,4 m² geschätzt.']);
    expect(de[2]).toEqual(['Hinweis', 'test.inconnu', 'Prüfung „test.inconnu“ (Details: ratio = 0,5)']);
  });
});

describe('sheetsToCsv — textes hostiles', () => {
  it('met entre guillemets les cellules qui contiennent un point-virgule ou un guillemet', () => {
    const project = makeProject();
    project.answers.projectName = 'Maison "Les Tilleuls"; lot 3';
    const text = sheetsToCsv(makeSheets(), project, 'fr');
    expect(text).toContain('Bezeichnung — désignation;"Maison ""Les Tilleuls""; lot 3";');
    expect(tableAfter(rowsOf(text), 'Données du projet')).toContainEqual([
      'Bezeichnung — désignation',
      'Maison "Les Tilleuls"; lot 3',
      "saisi ou confirmé par l'expert",
    ]);
  });

  it('neutralise les formules et aplatit les sauts de ligne venus des plans', () => {
    const sheets = makeSheets();
    sheets.zones = [{ ...sheets.zones[0]!, label: '=cmd|\' /C calc\'!A0' }];
    sheets.envelope = sheets.envelope.map((r, i) => (i === 1 ? { ...r, label: 'Mur\r\nnord;\test', elementName: '+Mur' } : r));
    const project = makeProject();
    project.answers.street = '@rue';
    const text = sheetsToCsv(sheets, project, 'fr');
    const rows = rowsOf(text);
    expect(tableAfter(rows, 'Energiebezugsflächen / Zonen — Surface de référence énergétique (zones)')[1]![0]).toBe("'=cmd|' /C calc'!A0");
    const wall = tableAfter(rows, "Flächeneingabe der Gebäudehülle — Surfaces de l'enveloppe")[2]!;
    expect(wall[1]).toBe("'+Mur");
    expect(wall[8]).toBe('Mur nord; est');
    expect(wall).toHaveLength(13);
    expect(tableAfter(rows, 'Données du projet')).toContainEqual(['Straße, Nr. — rue et numéro', "'@rue", "saisi ou confirmé par l'expert"]);
    // aucune cellule ne commence par un caractère de formule, hormis les nombres négatifs
    for (const r of rows) {
      for (const c of r) {
        if (/^[=+@]/.test(c)) throw new Error(`cellule dangereuse : ${c}`);
        if (c.startsWith('-')) expect(c).toMatch(/^-\d+(,\d+)?$/);
      }
    }
  });

  it('laisse un nombre négatif lisible comme nombre', () => {
    const sheets = makeSheets();
    sheets.totals = { ...sheets.totals, envelopeArea: -12.5 };
    expect(sheetsToCsv(sheets, makeProject(), 'fr')).toContain("Surface de l'enveloppe thermique A;-12,50;m²;");
  });
});
