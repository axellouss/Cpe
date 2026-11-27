import { describe, expect, it } from 'vitest';
import type { EnvelopeRow, Lang } from '../../src/core/types';
import { buildGuide, GUIDE_SECTION_KEYS, guideDisclaimer, type GuideItem, type GuideSection, type GuideTable } from '../../src/export';
import { ENVELOPE_AZIMUTH_COLUMN } from '../../src/export/guide';
import { ENVELOPE_BLOCK, makeProject, makeSheets, VOLUMES_BLOCK, ZONES_BLOCK } from './fixtures';

const PROVENANCES = ['plan', 'calc', 'default', 'estimate', 'user'];

function guide(lang: Lang): GuideSection[] {
  return buildGuide(makeSheets(), makeProject(), lang);
}

function section(sections: GuideSection[], key: string): GuideSection {
  const found = sections.find((s) => s.key === key);
  if (!found) throw new Error(`section ${key} absente`);
  return found;
}

function item(s: GuideSection, key: string): GuideItem {
  const found = s.items.find((i) => i.key === key);
  if (!found) throw new Error(`valeur ${key} absente de ${s.key}`);
  return found;
}

function table(s: GuideSection, key: string): GuideTable {
  const found = s.tables.find((tb) => tb.key === key);
  if (!found) throw new Error(`tableau ${key} absent de ${s.key}`);
  return found;
}

/** Tous les textes d'un guide, pour les contrôles de formulation. */
function allTexts(sections: GuideSection[]): string[] {
  const out: string[] = [];
  for (const s of sections) {
    out.push(s.luxeebName, s.title, s.help);
    for (const i of s.items) out.push(i.label, i.value, i.copy, i.note ?? '');
    for (const tb of s.tables) {
      out.push(...tb.columns, tb.pasteHint);
      for (const r of tb.rows) out.push(...r.cells, r.note ?? '');
    }
  }
  return out;
}

describe('buildGuide — ordre et titres', () => {
  it('suit l’ordre de saisie de LuxEeB-Tool', () => {
    expect(guide('fr').map((s) => s.key)).toEqual(['project', 'opaque', 'windows', 'envelope', 'areas', 'check', 'remaining']);
    expect(guide('de').map((s) => s.key)).toEqual([...GUIDE_SECTION_KEYS]);
  });

  it('nomme chaque étape par le titre allemand de la feuille, identique dans les deux langues', () => {
    const expected = [
      'Allgemeine Projektdaten',
      'Berechnung der U-Werte von Bauteilen',
      'Berechnung der U-Werte von transparenten Bauteilen',
      'Flächeneingabe der Gebäudehülle',
      'Energiebezugsflächen / Zonen · Gebäudevolumen Ve',
      'Übersicht der Gebäudegeometrie und Bauteile',
      'Wärmebrücken · Lüftung, Luftdichtheit, Lüftungsanlagen · sonstige Parameter · Heizungsanlagen · Warmwasseranlagen · Hilfsenergie',
    ];
    expect(guide('fr').map((s) => s.luxeebName)).toEqual(expected);
    expect(guide('de').map((s) => s.luxeebName)).toEqual(expected);
  });

  it('traduit les titres et donne une aide d’une ligne qui cite le menu de l’outil', () => {
    expect(guide('fr').map((s) => s.title)).toEqual([
      'Données générales du projet',
      'Éléments de construction opaques',
      'Éléments de construction transparents (fenêtres)',
      "Surfaces de l'enveloppe du bâtiment",
      'Surface de référence énergétique et volume',
      'Contrôle de la géométrie saisie',
      "Reste à saisir à la main dans l'outil",
    ]);
    expect(guide('de').map((s) => s.title)).toEqual([
      'Projektdaten (Startseite)',
      'Opake Bauteile (U-Werte)',
      'Transparente Bauteile (Fenster)',
      'Flächen der Gebäudehülle',
      'Energiebezugsfläche und Volumen',
      'Kontrolle der eingegebenen Geometrie',
      'Noch von Hand im Tool einzugeben',
    ]);
    const menus = ['Projektdaten', 'U-Werte opaker Bauteile', 'U-Wert transparenter Bauteile', 'Gebäudehülle', 'Flächen und Volumina', 'Übersicht aller Bauteile'];
    for (const lang of ['fr', 'de'] as const) {
      const sections = guide(lang);
      menus.forEach((menu, i) => {
        expect(sections[i]!.help).toContain(lang === 'fr' ? `« ${menu} »` : `„${menu}“`);
      });
      for (const s of sections) {
        expect(s.help.length).toBeGreaterThan(20);
        expect(s.help).not.toMatch(/[\r\n]/);
      }
    }
  });
});

describe('buildGuide — invariants', () => {
  it.each(['fr', 'de'] as const)('chaque valeur et chaque ligne porte sa provenance (%s)', (lang) => {
    const keys = new Set<string>();
    for (const s of guide(lang)) {
      for (const i of s.items) {
        expect(keys.has(i.key), `clé en double : ${i.key}`).toBe(false);
        keys.add(i.key);
        expect(i.label).not.toBe('');
        expect(i.value).not.toBe('');
        expect(typeof i.copy).toBe('string');
        expect(i.from === null || PROVENANCES.includes(i.from)).toBe(true);
        // Une valeur sans provenance est une valeur que l'expert doit fournir : il faut lui dire quoi faire.
        if (i.from === null) expect(i.note, i.key).toBeTruthy();
      }
      for (const tb of s.tables) {
        for (const r of tb.rows) {
          expect(PROVENANCES).toContain(r.from);
          expect(r.cells).toHaveLength(tb.columns.length);
        }
      }
    }
  });

  it.each(['fr', 'de'] as const)('ne laisse aucune clé de traduction, variable ou « undefined » visible (%s)', (lang) => {
    for (const text of allTexts(guide(lang))) {
      expect(text).not.toMatch(/export\.[a-z]+\./);
      expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(text).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it.each(['fr', 'de'] as const)('ne promet jamais un remplissage automatique de l’outil (%s)', (lang) => {
    for (const text of allTexts(guide(lang))) expect(text.toLowerCase()).not.toMatch(/automati/);
    expect(guideDisclaimer('fr')).toContain("Rien n'est transmis à LuxEeB-Tool");
    expect(guideDisclaimer('de')).toContain('Es wird nichts an das LuxEeB-Tool übertragen');
  });

  it('écrit les copies numériques avec virgule décimale et sans unité', () => {
    for (const lang of ['fr', 'de'] as const) {
      for (const s of guide(lang)) {
        for (const i of s.items) {
          if (/^[\d.,-]+$/.test(i.copy)) expect(i.copy, i.key).toMatch(/^-?\d+(,\d+)?$/);
        }
      }
    }
  });
});

describe('buildGuide — page de démarrage', () => {
  it('donne les champs dans l’ordre de la feuille, terme allemand puis traduction', () => {
    const s = section(guide('fr'), 'project');
    expect(s.items.map((i) => i.label)).toEqual([
      'Bezeichnung — désignation',
      'Straße, Nr. — rue et numéro',
      'PLZ, Ort — code postal',
      'PLZ, Ort — localité',
      'Baujahr Gebäude — année de construction',
      'Wohneinheiten — nombre de logements',
      'Gebäudetyp — type de bâtiment',
      'Nachweisart — type de justificatif',
      'Aussteller / Eigentümer — émetteur et propriétaire',
    ]);
    expect(item(s, 'project.name')).toEqual({ key: 'project.name', label: 'Bezeichnung — désignation', value: 'Maison Schmit', copy: 'Maison Schmit', from: 'user' });
    expect(item(s, 'project.yearBuilt').copy).toBe('1978');
    expect(item(s, 'project.dwellings').copy).toBe('1');
  });

  it('retire le « L- » du code postal copié, car la cellule de l’outil le porte déjà', () => {
    const postcode = item(section(guide('fr'), 'project'), 'project.postcode');
    expect(postcode.value).toBe('L-7410');
    expect(postcode.copy).toBe('7410');
    expect(postcode.note).toContain('L-');

    const project = makeProject();
    const copyOf = (postcode: string): string => {
      project.answers.postcode = postcode;
      return item(section(buildGuide(makeSheets(), project, 'fr'), 'project'), 'project.postcode').copy;
    };
    expect(copyOf('l 1234')).toBe('1234');
    expect(copyOf('L–1234')).toBe('1234');
    expect(copyOf('1234')).toBe('1234');
    // un texte qui commence seulement par la lettre L n'est pas amputé
    expect(copyOf('Luxembourg')).toBe('Luxembourg');
    expect(copyOf('D-54290')).toBe('D-54290');
  });

  it('ne donne rien à coller pour les listes déroulantes et ne cite que les entrées lues dans le manuel', () => {
    const fr = section(guide('fr'), 'project');
    expect(item(fr, 'project.buildingType').value).toBe('Wohnen EFH — maison unifamiliale');
    expect(item(fr, 'project.buildingType').copy).toBe('');
    expect(item(fr, 'project.occasion').value).toBe("Bâtiment existant — choisir l'entrée correspondante de la liste");
    expect(item(fr, 'project.occasion').copy).toBe('');

    const project = makeProject();
    project.answers.buildingType = 'MFH';
    project.answers.occasion = 'new';
    const de = section(buildGuide(makeSheets(), project, 'de'), 'project');
    expect(item(de, 'project.buildingType').value).toBe('MFH — Mehrfamilienhaus (den MFH-Eintrag der Liste wählen)');
    expect(item(de, 'project.occasion').value).toBe('Neubau — zum Beispiel „Neubau (Bauantrag)“, je nach Fall');
    expect(item(de, 'project.name').label).toBe('Bezeichnung');
  });

  it('signale ce qui n’est pas renseigné au lieu de l’inventer', () => {
    const project = makeProject();
    project.answers.projectName = '   ';
    project.answers.yearBuilt = null;
    project.answers.buildingType = null;
    const s = section(buildGuide(makeSheets(), project, 'fr'), 'project');
    for (const key of ['project.name', 'project.yearBuilt', 'project.buildingType']) {
      expect(item(s, key)).toMatchObject({ value: '—', copy: '', from: null, note: 'Non renseigné dans Plan2CPE : à compléter par vous.' });
    }
    expect(item(s, 'project.parties')).toMatchObject({ copy: '', from: null });
  });

  it('protège la copie d’un nom qui ressemble à une formule', () => {
    const project = makeProject();
    project.answers.projectName = '=SUM(A1:A9)';
    const name = item(section(buildGuide(makeSheets(), project, 'fr'), 'project'), 'project.name');
    expect(name.value).toBe('=SUM(A1:A9)');
    expect(name.copy).toBe("'=SUM(A1:A9)");
  });
});

describe('buildGuide — types d’éléments et de fenêtres', () => {
  it('liste les éléments opaques avec surface, milieu, Einbausituation et paramètres du sol', () => {
    const tb = table(section(guide('fr'), 'opaque'), 'constructions');
    expect(tb.columns).toEqual([
      'Bezeichnung — désignation',
      'Catégorie',
      'Contre',
      // ordre de l'outil (« Eigene Angaben ») : U-Wert avant Einbausituation
      'U-Wert [W/(m²K)] — valeur U',
      'Einbausituation — situation proposée pour la saisie manuelle',
      'Surface totale [m²]',
      'Fläche des Bauteils A [m²] — surface de la dalle contre terre',
      'Perimeter P [m] — périmètre caractéristique',
    ]);
    expect(tb.rows.map((r) => r.cells)).toEqual([
      ['Mur extérieur', 'Mur', 'extérieur', '0,35', 'Außenwand', '75,16', '', ''],
      ['Toiture plate', 'Toiture', 'extérieur', '', 'Dach gegen außen', '80,00', '', ''],
      ['Dalle sur terre-plein', 'Plancher bas', 'terre', '0,406', 'Bauteil gegen Erdreich', '80,00', '80,00', '28,00'],
    ]);
    // Provenance la plus faible entre la valeur U et les lignes d'enveloppe dont la surface est la somme :
    // U par défaut ; toiture sans U mais dont la ligne d'enveloppe repose sur une valeur par défaut ; U estimé.
    expect(tb.rows.map((r) => r.from)).toEqual(['default', 'default', 'estimate']);
    expect(tb.rows[1]!.note).toContain('Valeur U à définir dans LuxEeB-Tool');
    expect(tb.rows[2]!.note).toBe(
      'Valeur U : estimation — à remplacer. Typologie 1970-1980. Dalle contre terre : reportez la surface (A) et le périmètre (P).',
    );
    expect(tb.pasteBlock).toBe('');
    expect(tb.pasteHint).toBe("Pas de bloc à coller : chaque type se crée à la main dans l'outil.");
  });

  it('propose les cinq options de « Einbausituation » du manuel, et marque les cas douteux', () => {
    const sheets = makeSheets();
    const base = sheets.constructions[0]!;
    sheets.constructions = [
      { ...base, category: 'wall', boundary: 'ground' },
      { ...base, category: 'wall', boundary: 'unheated' },
      { ...base, category: 'ceiling', boundary: 'unheated' },
      { ...base, category: 'floor', boundary: 'unheated' },
      { ...base, category: 'floor', boundary: 'outside' },
      { ...base, category: 'door', boundary: 'outside' },
      { ...base, category: 'wall', boundary: 'heated' },
    ];
    const tb = table(section(buildGuide(sheets, makeProject(), 'de'), 'opaque'), 'constructions');
    expect(tb.rows.map((r) => r.cells[4])).toEqual([
      'Bauteil gegen Erdreich',
      'Bauteil gegen unbeheizt',
      'Bauteil gegen unbeheizt',
      'Bauteil gegen unbeheizt',
      'sonstige Einbauarten',
      'Außenwand',
      '',
    ]);
    expect(tb.rows[0]!.note).toContain('Die Tiefe (T) tragen Sie selbst ein');
    expect(tb.rows[4]!.note).toContain('Vorgeschlagene Einbausituation prüfen');
    expect(tb.rows[5]!.note).toContain('Vorgeschlagene Einbausituation prüfen');
    expect(tb.rows[6]!.note).toContain('nicht in die Gebäudehülle eintragen');
    expect(tb.rows[1]!.note).not.toContain('prüfen');
  });

  it('rappelle les réponses sur l’isolation et prévient au-delà de 20 types', () => {
    const fr = section(guide('fr'), 'opaque');
    expect(item(fr, 'opaque.insulationWalls')).toMatchObject({ label: 'Isolation ajoutée après coup — murs', value: '12 cm', copy: '12', from: 'user' });
    expect(item(fr, 'opaque.insulationRoof')).toMatchObject({ value: 'aucune isolation ajoutée', copy: '' });
    expect(fr.items.some((i) => i.key === 'opaque.insulationFloor')).toBe(false); // non renseignée
    expect(fr.items.some((i) => i.key === 'opaque.slots')).toBe(false);

    const sheets = makeSheets();
    const base = sheets.constructions[0]!;
    sheets.constructions = Array.from({ length: 21 }, (_, i) => ({ ...base, constructionId: `c${i}`, name: `Type ${i + 1}` }));
    const slots = item(section(buildGuide(sheets, makeProject(), 'fr'), 'opaque'), 'opaque.slots');
    expect(slots.value).toBe('21 types pour 20 emplacements');
    expect(slots.note).toContain('20 emplacements');
  });

  it('donne pour chaque type de fenêtre la taille typique, dans l’ordre Breite puis Höhe', () => {
    const fr = section(guide('fr'), 'windows');
    const tb = table(fr, 'windowTypes');
    expect(tb.columns.slice(0, 3)).toEqual([
      'Bezeichnung — désignation',
      "Breite [m] — largeur d'une fenêtre typique",
      "Höhe [m] — hauteur d'une fenêtre typique",
    ]);
    expect(tb.rows).toEqual([
      {
        // ordre de l'outil : g-Wert avant U-Wert Fenster
        cells: ['Fenêtre PVC', '1,20', '1,35', '2', '3,24', '0,60', '1,30'],
        from: 'default',
        note: "Valeur U : saisi ou confirmé par l'expert. Facteur g : valeur par défaut — à confirmer.",
      },
    ]);
    expect(item(fr, 'windows.generation').value).toBe('Double vitrage à isolation renforcée (basse émissivité)');

    const sheets = makeSheets();
    sheets.windows = [{ ...sheets.windows[0]!, uw: null, g: null }];
    const row = table(section(buildGuide(sheets, makeProject(), 'fr'), 'windows'), 'windowTypes').rows[0]!;
    expect(row.cells.slice(5)).toEqual(['', '']);
    // Sans U ni g : la ligne vaut ce que valent les fenêtres relevées (ici lues sur le plan), pas « calculé ».
    expect(row.from).toBe('plan');
    expect(row.note).toContain('0,06 W/(mK)');
  });
});

describe('buildGuide — enveloppe', () => {
  it('reprend le bloc à coller et le présente comme un essai, la recopie restant la voie sûre', () => {
    const fr = table(section(guide('fr'), 'envelope'), 'envelope');
    expect(fr.pasteBlock).toBe(ENVELOPE_BLOCK);
    expect(fr.pasteHint).toContain('À essayer');
    expect(fr.pasteHint).toContain('« Anzahl »');
    expect(fr.pasteHint).toContain('6 ligne(s) × 4 colonnes');
    expect(fr.pasteHint).toContain("n'a pas été vérifié");
    expect(fr.pasteHint).toContain('recopiez ligne par ligne');
    expect(fr.pasteHint).toContain('« Abzug »');

    const de = table(section(guide('de'), 'envelope'), 'envelope');
    expect(de.pasteBlock).toBe(ENVELOPE_BLOCK);
    expect(de.pasteHint).toContain('Zum Ausprobieren');
    expect(de.pasteHint).toContain('nicht geprüft');
    expect(de.pasteHint).toContain('Zeile für Zeile');
  });

  it('donne ligne par ligne l’élément à choisir, les dimensions, l’orientation de l’outil et la surface attendue', () => {
    const tb = table(section(guide('fr'), 'envelope'), 'envelope');
    expect(tb.columns).toEqual([
      'N°',
      'Bauteil — élément à choisir dans la liste déroulante',
      'Anzahl — nombre',
      'Länge (Rohbaumaß) [m] — longueur brute',
      'Breite (Rohbaumaß) [m] — largeur ou hauteur brute',
      "Orientierung — orientation (valeur de l'outil)",
      'Abzug — déduction : « x » à saisir',
      "A [m²] — surface attendue dans l'outil",
      'Repère du relevé',
      'Orientation (azimut)',
      'Contre',
    ]);
    expect(tb.columns[ENVELOPE_AZIMUTH_COLUMN]).toBe('Orientation (azimut)');
    expect(tb.rows[0]).toEqual({
      cells: ['1', 'Fenêtre PVC', '2,00', '1,20', '1,35', 'Nord', 'x', '3,24', 'Fenêtre 1,20 × 1,35 m – Nord (RDC)', 'Nord (0°)', 'extérieur'],
      from: 'plan',
      deduct: true,
      note: 'À déduire de la prochaine ligne sans « x ».',
    });
    // le mur porte la surface nette, après déduction des fenêtres
    expect(tb.rows[1]).toEqual({
      cells: ['2', 'Mur extérieur', '1,00', '10,00', '2,80', 'Nord', '', '24,76', 'Mur extérieur – Nord (RDC)', 'Nord (0°)', 'extérieur'],
      from: 'plan',
      deduct: false,
    });
    expect(tb.rows[2]!.cells.slice(5, 10)).toEqual(['Ost', '', '22,40', 'Mur extérieur – Est (RDC)', 'Est (90°)']);
    expect(tb.rows.map((r) => r.from)).toEqual(['plan', 'plan', 'plan', 'plan', 'default', 'user']);
    // les cellules des colonnes du bloc sont exactement celles du bloc
    expect(tb.rows.map((r) => r.cells.slice(2, 6).join('\t')).join('\r\n')).toBe(ENVELOPE_BLOCK);
  });

  it('traduit l’orientation pour le lecteur allemand sans toucher à la valeur de l’outil', () => {
    const tb = table(section(guide('de'), 'envelope'), 'envelope');
    expect(tb.rows[2]!.cells[5]).toBe('Ost');
    expect(tb.rows[2]!.cells[9]).toBe('Ost (90°)');
    expect(tb.rows[2]!.cells[10]).toBe('Außenluft');
    expect(tb.rows[0]!.note).toBe('Wird von der nächsten Zeile ohne „x“ abgezogen.');
  });

  it('dit quelles lignes marquer d’un « x »', () => {
    const s = section(guide('fr'), 'envelope');
    expect(item(s, 'envelope.rowCount').value).toBe('6');
    expect(item(s, 'envelope.deductLines')).toMatchObject({ value: '1', copy: 'x', from: 'calc' });
    expect(item(s, 'envelope.deductLines').note).toContain('« Abzug »');

    const sheets = makeSheets();
    sheets.envelope = sheets.envelope.filter((r) => !r.deduct);
    const none = item(section(buildGuide(sheets, makeProject(), 'fr'), 'envelope'), 'envelope.deductLines');
    expect(none).toMatchObject({ value: '—', copy: '', note: 'Aucune ligne à déduire.' });
  });

  it('écarte les parois vers un local chauffé et signale une déduction orpheline', () => {
    const sheets = makeSheets();
    const party: EnvelopeRow = { ...sheets.envelope[2]!, id: 'party', label: 'Mur mitoyen', boundary: 'heated', orientation: 'W' };
    const orphan: EnvelopeRow = { ...sheets.envelope[0]!, id: 'orphan', label: 'Fenêtre sans mur' };
    sheets.envelope = [...sheets.envelope, party, orphan];
    const tb = table(section(buildGuide(sheets, makeProject(), 'fr'), 'envelope'), 'envelope');
    expect(tb.rows).toHaveLength(7);
    expect(tb.rows.map((r) => r.cells[8])).not.toContain('Mur mitoyen');
    expect(tb.rows[6]!.cells[0]).toBe('7');
    expect(tb.rows[6]!.note).toBe("Ligne à déduire sans ligne suivante : vérifiez l'ordre des lignes.");
    expect(tb.pasteBlock.split('\r\n')).toHaveLength(7);
  });

  it('reste utilisable sans aucune ligne', () => {
    const sheets = makeSheets();
    sheets.envelope = [];
    sheets.zones = [];
    sheets.volumes = [];
    sheets.constructions = [];
    sheets.windows = [];
    for (const lang of ['fr', 'de'] as const) {
      const sections = buildGuide(sheets, makeProject(), lang);
      expect(sections.map((s) => s.key)).toEqual([...GUIDE_SECTION_KEYS]);
      const tb = table(section(sections, 'envelope'), 'envelope');
      expect(tb.rows).toEqual([]);
      expect(tb.pasteBlock).toBe('');
      expect(tb.pasteHint).toBe(lang === 'fr' ? 'Aucune ligne à reporter.' : 'Keine Zeilen zu übertragen.');
      expect(item(section(sections, 'check'), 'check.aOverVe')).toMatchObject({ value: '—', copy: '', from: null });
    }
  });
});

describe('buildGuide — surfaces, volumes et contrôle', () => {
  it('donne les zones et les volumes avec leurs blocs', () => {
    const s = section(guide('fr'), 'areas');
    const zones = table(s, 'zones');
    expect(zones.columns).toEqual([
      'Raumbezeichnung — désignation de la zone',
      'Anzahl — nombre',
      'Breite [m] — largeur',
      'Länge [m] — porte la surface',
      'Hauteur libre [m]',
      "Vn [m³] — indicatif : l'outil calcule Vn lui-même",
    ]);
    expect(zones.rows).toEqual([{ cells: ['Zone chauffée – Rez-de-chaussée', '1,00', '1,00', '68,40', '2,50', '171,00'], from: 'estimate' }]);
    expect(zones.pasteBlock).toBe(ZONES_BLOCK);
    expect(zones.pasteHint).toContain('À essayer');
    expect(zones.pasteHint).toContain('« Raumbezeichnung »');
    expect(zones.pasteHint).toContain('recopiez ligne par ligne');

    const volumes = table(s, 'volumes');
    expect(volumes.columns).toEqual([
      'Bezeichnung — désignation',
      'Anzahl — nombre',
      'Breite [m] — largeur',
      'Länge [m] — porte la surface',
      'Höhe [m] — hauteur',
      'Ve [m³] — Ve attendu',
    ]);
    expect(volumes.rows).toEqual([{ cells: ['Rez-de-chaussée', '1,00', '1,00', '80,00', '2,80', '224,00'], from: 'plan' }]);
    expect(volumes.pasteBlock).toBe(VOLUMES_BLOCK);
    expect(volumes.pasteHint).toContain('« Bezeichnung »');
    expect(s.help).toContain('« Lüftungsanlage »');
  });

  it('donne les sommes à comparer avec la ligne « Summe » de l’outil', () => {
    const s = section(guide('de'), 'areas');
    expect(item(s, 'areas.sumAn')).toEqual({
      key: 'areas.sumAn',
      label: 'Summe An',
      value: '68,40 m²',
      copy: '68,40',
      from: 'estimate',
      note: 'Mit der Zeile „Summe“ der Zonentabelle vergleichen.',
    });
    expect(item(s, 'areas.sumVe')).toMatchObject({ label: 'Summe Ve', value: '224,00 m³', copy: '224,00', from: 'plan' });
  });

  it('calcule les totaux de contrôle à partir des valeurs arrondies qui seront saisies', () => {
    const sheets = makeSheets();
    // 3,333 → saisi 3,33 ; 2,005 → saisi 2,01 : l'outil affichera 3,33 × 2,01 = 6,69 et non 3,333 × 2,005 = 6,68
    sheets.volumes = [{ id: 'v', label: 'Test', area: 3.333, height: 2.005, volume: 6.682665, from: 'plan', storeyId: null }];
    const s = buildGuide(sheets, makeProject(), 'fr');
    expect(table(section(s, 'areas'), 'volumes').rows[0]!.cells).toEqual(['Test', '1,00', '1,00', '3,33', '2,01', '6,69']);
    expect(item(section(s, 'areas'), 'areas.sumVe').copy).toBe('6,69');
    expect(item(section(s, 'check'), 'check.ve').copy).toBe('6,69');
  });

  it('compare avec la feuille de synthèse, en prévenant que l’outil pondère sa surface A', () => {
    const s = section(guide('fr'), 'check');
    expect(s.items.map((i) => [i.key, i.value, i.from])).toEqual([
      ['check.envelopeGross', '238,40 m²', 'default'],
      ['check.ve', '224,00 m³', 'plan'],
      ['check.an', '68,40 m²', 'estimate'],
      ['check.vn', '171,00 m³', 'estimate'],
      ['check.windowArea', '3,24 m²', 'plan'],
      ['check.aOverVe', '1,06 1/m', 'default'],
    ]);
    const gross = item(s, 'check.envelopeGross');
    expect(gross.label).toBe("Brutto Gebäudehüllfläche — surface brute de l'enveloppe");
    expect(gross.note).toContain('« Gebäudehüllfläche »');
    expect(gross.note).toContain('pondère');
    expect(item(s, 'check.vn').note).toContain("L'outil calcule Vn lui-même");
  });
});

describe('buildGuide — reste à saisir à la main', () => {
  it('donne les réponses de l’expert en clair, dans l’ordre des feuilles de l’outil', () => {
    const s = section(guide('fr'), 'remaining');
    expect(s.items.map((i) => [i.key, i.value])).toEqual([
      ['remaining.thermalBridges', "choix de l'expert"],
      ['remaining.shading', "choix de l'expert"],
      ['remaining.ventilation', 'Aération par les fenêtres (aucune installation)'],
      ['remaining.n50', "pas de test d'étanchéité"],
      ['remaining.parameters', "choix de l'expert"],
      ['remaining.emission', 'Radiateurs'],
      ['remaining.heating', 'Chaudière gaz à condensation (installée en 2012)'],
      ['remaining.heatingYear', '2012'],
      ['remaining.solarThermal', 'Non'],
      ['remaining.hotWater', 'Par le générateur de chauffage'],
      ['remaining.auxiliary', "choix de l'expert"],
      ['remaining.photovoltaic', 'Oui'],
    ]);
    expect(item(s, 'remaining.heating').label).toBe('Heizungsanlagen — installation de chauffage');
    expect(item(s, 'remaining.shading').label).toBe('Verschattung bei transparenten Bauteilen — ombrage des fenêtres');
    expect(item(s, 'remaining.shading').note).toContain('« Flächeneingabe der Gebäudehülle »');
    expect(item(s, 'remaining.heating').note).toContain('« Auswahl Heizungsanlagen für Bestandsgebäude »');
    expect(item(s, 'remaining.ventilation').note).toContain('« keine Anlage »');
    expect(item(s, 'remaining.hotWater').note).toContain('« Auswahl Warmwassererzeugung »');
    expect(item(s, 'remaining.n50')).toMatchObject({ copy: '', from: 'default' });
  });

  it('ne donne à coller que les vraies valeurs (année, n50), jamais une entrée de liste', () => {
    const project = makeProject();
    project.answers.n50 = 1.5;
    project.answers.occasion = 'new';
    project.answers.ventilation = 'balanced-hr';
    const s = section(buildGuide(makeSheets(), project, 'de'), 'remaining');
    const withCopy = s.items.filter((i) => i.copy !== '').map((i) => [i.key, i.copy]);
    expect(withCopy).toEqual([
      ['remaining.n50', '1,50'],
      ['remaining.heatingYear', '2012'],
    ]);
    expect(item(s, 'remaining.n50')).toMatchObject({ label: 'Luftdichtheitswert n50', value: '1,50 1/h', from: 'user' });
    expect(item(s, 'remaining.heating').value).toBe('Gas-Brennwertkessel (Baujahr 2012)');
    expect(item(s, 'remaining.heating').note).toContain('„Auswahl Heizungsanlagen“');
    expect(item(s, 'remaining.heating').note).toContain('„Wärmeerzeuger“');
    expect(item(s, 'remaining.ventilation').value).toBe('Zu- und Abluftanlage mit Wärmerückgewinnung');
    expect(item(s, 'remaining.ventilation').note).toContain('„Berechnung des energetischen Luftwechsels“');
  });

  it('marque les réponses manquantes comme « à compléter », sans provenance', () => {
    const project = makeProject();
    Object.assign(project.answers, {
      heatGenerator: null,
      heatGeneratorYear: null,
      heatEmission: null,
      hotWater: null,
      ventilation: null,
      solarThermal: null,
      photovoltaic: null,
      occasion: null,
    });
    const s = section(buildGuide(makeSheets(), project, 'fr'), 'remaining');
    for (const key of ['remaining.ventilation', 'remaining.emission', 'remaining.heating', 'remaining.solarThermal', 'remaining.hotWater', 'remaining.photovoltaic']) {
      expect(item(s, key), key).toMatchObject({ value: '—', copy: '', from: null });
      expect(item(s, key).note).toBeTruthy();
    }
    expect(s.items.some((i) => i.key === 'remaining.heatingYear')).toBe(false);
    expect(item(s, 'remaining.heating').note).toContain('« Auswahl Heizungsanlagen »');
  });
});
