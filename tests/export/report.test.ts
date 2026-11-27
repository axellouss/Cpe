// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { EnvelopeRow, Lang, LuxeebSheets, Project } from '../../src/core/types';
import { buildReportHtml, reportHtml } from '../../src/export';
import { registerMessages } from '../../src/i18n';
import { makeProject, makeSheets } from './fixtures';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function report(lang: Lang = 'fr', sheets: LuxeebSheets = makeSheets(), project: Project = makeProject()): string {
  return reportHtml(sheets, project, lang);
}

/** Le tableau qui suit le titre de section donné. */
function tableUnder(doc: Document, heading: string): HTMLTableElement {
  const h2 = [...doc.querySelectorAll('h2')].find((h) => h.textContent === heading);
  if (!h2) throw new Error(`section absente : ${heading}`);
  const table = h2.parentElement?.querySelector('table');
  if (!table) throw new Error(`pas de tableau sous : ${heading}`);
  return table;
}

function cells(row: Element): string[] {
  return [...row.children].map((c) => (c.textContent ?? '').trim());
}

describe('reportHtml — document autonome', () => {
  it.each(['fr', 'de'] as const)('est une page HTML complète, sans script ni ressource externe (%s)', (lang) => {
    const html = report(lang);
    expect(html.startsWith('<!DOCTYPE html>\n<html lang="' + lang + '">')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<(link|img|iframe|object|embed|form|input|base)\b/i);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).not.toMatch(/undefined|NaN|\[object|export\.[a-z]+\.[a-z]/);

    const doc = parse(html);
    expect(doc.documentElement.lang).toBe(lang);
    expect(doc.querySelectorAll('script, link, img, iframe').length).toBe(0);
    expect(doc.querySelectorAll('style').length).toBe(1);
    expect(doc.querySelector('h1')?.textContent).toBe(lang === 'fr' ? 'Dossier de relevé pour LuxEeB-Tool' : 'Aufmaß-Dossier für das LuxEeB-Tool');
  });

  it('contient les sections attendues, dans l’ordre', () => {
    const titles = [...parse(report('fr')).querySelectorAll('h2')].map((h) => h.textContent);
    expect(titles).toEqual([
      "Responsabilité de l'expert",
      'Données du projet',
      'Grandeurs principales',
      'Hypothèses',
      'Pièces et surface de référence énergétique',
      "Berechnung der U-Werte von Bauteilen — Types d'éléments opaques",
      'Berechnung der U-Werte von transparenten Bauteilen — Types de fenêtres',
      "Flächeneingabe der Gebäudehülle — Surfaces de l'enveloppe",
      'Energiebezugsflächen / Zonen — Surface de référence énergétique (zones)',
      'Gebäudevolumen Ve — Volume brut chauffé',
      'Contrôles de plausibilité',
      'Légende des provenances',
      "Visa de l'expert",
    ]);
    const de = [...parse(report('de')).querySelectorAll('h2')].map((h) => h.textContent);
    expect(de).toHaveLength(titles.length);
    expect(de[0]).toBe('Verantwortung des Experten');
    expect(de[3]).toBe('Annahmen');
    expect(de[11]).toBe('Legende der Herkunftsangaben');
  });

  it('rappelle que l’expert reste responsable, dans les deux langues', () => {
    const fr = parse(report('fr')).querySelector('section.resp')?.textContent ?? '';
    expect(fr).toContain("Ce n'est pas un certificat de performance énergétique");
    expect(fr).toContain('reste seul responsable des données saisies dans LuxEeB-Tool et du certificat établi');
    const de = parse(report('de')).querySelector('section.resp')?.textContent ?? '';
    expect(de).toContain('Es ist kein Energiepass');
    expect(de).toContain('bleibt allein verantwortlich');
    expect(parse(report('fr')).querySelector('footer')?.textContent).toContain("Rien n'est transmis à LuxEeB-Tool");
  });
});

describe('reportHtml — contenu', () => {
  it('donne les données du projet, chacune avec son étiquette de provenance', () => {
    const table = tableUnder(parse(report('fr')), 'Données du projet');
    const rows = [...table.tBodies[0]!.rows];
    expect(rows.length).toBeGreaterThanOrEqual(19);
    for (const row of rows) expect(row.querySelectorAll('.tag').length, row.textContent ?? '').toBe(1);
    const byLabel = new Map(rows.map((r) => [cells(r)[0], r]));
    expect(byLabel.get('Bezeichnung — désignation')?.children[1]?.textContent).toBe('Maison Schmit expert');
    expect(byLabel.get('Bezeichnung — désignation')?.querySelector('.tag')?.getAttribute('title')).toBe("saisi ou confirmé par l'expert");
    expect(byLabel.get('Isolation ajoutée après coup — plancher bas')?.children[1]?.textContent).toBe('non renseigné à saisir');
    expect(byLabel.get("Étanchéité à l'air n50")?.querySelector('.tag')?.className).toBe('tag tag-default');
  });

  it('donne les grandeurs principales avec unité et provenance', () => {
    const rows = [...tableUnder(parse(report('fr')), 'Grandeurs principales').tBodies[0]!.rows].map(cells);
    expect(rows).toEqual([
      ['Energiebezugsfläche An — surface de référence énergétique An', '68,40 m² estimé'],
      ["Beheiztes Gebäudeluftvolumen Vn — volume d'air chauffé Vn", '171,00 m³ estimé'],
      ['Beheiztes Bruttogebäudevolumen Ve — volume brut chauffé Ve', '224,00 m³ plan'],
      ["Surface de l'enveloppe thermique A", '238,40 m² défaut'],
      ["A/Ve — rapport surface d'enveloppe / volume brut", '1,06 1/m défaut'],
      ['Surface brute de plancher chauffée', '80,00 m² calculé'],
      ['Gesamtfensterflächen — surface totale des fenêtres', '3,24 m² plan'],
      ['Surface de façade contre extérieur', '78,40 m² plan'],
    ]);
  });

  it('expose les hypothèses : nord, fermetures, étages, pièces — avec provenance et remarque', () => {
    const doc = parse(report('fr'));
    const general = [...tableUnder(doc, 'Hypothèses').tBodies[0]!.rows].map(cells);
    expect(general[0]).toEqual(['Azimut du haut de la feuille (nord)', '0° défautNord supposé en haut de la feuille']);
    expect(general[1]).toEqual(['Fermeture haute', "Toiture plate · Type d'élément : Toiture plate défaut"]);
    expect(general[2]).toEqual(['Fermeture basse', "Dalle sur terre-plein · Type d'élément : Dalle sur terre-plein expert"]);

    const section = [...doc.querySelectorAll('h2')].find((h) => h.textContent === 'Hypothèses')!.parentElement!;
    const storeys = section.querySelectorAll('table')[1]!;
    expect(cells(storeys.tHead!.rows[0]!)).toEqual([
      'Étage',
      'Échelle [m par unité du plan]',
      "Hauteur d'étage brute [m]",
      'Hauteur libre [m]',
      'Surface nette saisie [m²]',
      'Côtés du contour',
      'Ouvertures',
    ]);
    expect(cells(storeys.tBodies[0]!.rows[0]!)).toEqual([
      'Rez-de-chaussée',
      '1 expertRègle posée sur la cote 10,00',
      '2,80 plan',
      '2,50 défaut',
      'somme des pièces',
      '3 × extérieur, 1 × local chauffé (mitoyen)',
      '2 plan',
    ]);

    const rooms = [...tableUnder(doc, 'Pièces et surface de référence énergétique').tBodies[0]!.rows].map(cells);
    expect(rooms).toEqual([
      ['Séjour', '42,30 planÉtiquette du plan', 'Oui', ''],
      ['Buanderie', '9,10 estimé', 'Non', 'Oui'],
    ]);
  });

  it('décrit une toiture inclinée avec pente, forme et mur de jambette', () => {
    const project = makeProject();
    project.model.top = { kind: 'pitched-roof', pitchDeg: 37.5, shape: 'hip', ridgeAngle: null, kneeWallHeight: 0.8, constructionId: null, from: 'user' };
    const fr = [...tableUnder(parse(report('fr', makeSheets(), project)), 'Hypothèses').tBodies[0]!.rows].map(cells);
    expect(fr[1]![1]).toBe(
      "Toiture inclinée, combles chauffés · Pente 37,5° · Forme : quatre pans (croupes) · Mur de jambette (Kniestock) 0,80 m · Type d'élément : type par défaut expert",
    );
    const de = [...tableUnder(parse(report('de', makeSheets(), project)), 'Annahmen').tBodies[0]!.rows].map(cells);
    expect(de[1]![1]).toBe('Geneigtes Dach, beheiztes Dachgeschoss · Neigung 37,5° · Form: Walmdach · Kniestock 0,80 m · Bauteiltyp: Standardtyp Experte');
  });

  it('reprend tous les tableaux, une étiquette de provenance par ligne', () => {
    const doc = parse(report('fr'));
    const envelope = tableUnder(doc, "Flächeneingabe der Gebäudehülle — Surfaces de l'enveloppe");
    const rows = [...envelope.tBodies[0]!.rows];
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.querySelectorAll('.tag').length).toBe(1);
    expect(cells(rows[0]!)).toEqual(['1', 'Fenêtre PVC', '2,00', '1,20', '1,35', 'Nord', 'x', '3,24', 'Fenêtre 1,20 × 1,35 m – Nord (RDC)', 'extérieur', 'plan']);
    expect(rows[0]!.className).toBe('deduct');
    expect(cells(rows[1]!).slice(0, 8)).toEqual(['2', 'Mur extérieur', '1,00', '10,00', '2,80', 'Nord', '', '24,76']);
    expect(cells(rows[4]!).at(-1)).toBe('défaut');
    // l'en-tête sépare le terme de l'outil de sa traduction
    const head = envelope.tHead!.rows[0]!.children[2]!;
    expect(head.childNodes[0]!.textContent).toBe('Anzahl');
    expect(head.querySelector('.tr')?.textContent).toBe('nombre');

    expect(cells(tableUnder(doc, "Berechnung der U-Werte von Bauteilen — Types d'éléments opaques").tBodies[0]!.rows[2]!)).toEqual([
      'Dalle sur terre-plein',
      'Plancher bas',
      'terre',
      'Bauteil gegen Erdreich',
      '80,00',
      '0,406',
      '80,00',
      '28,00',
      'estimé',
      'Valeur U : estimation — à remplacer. Typologie 1970-1980. Dalle contre terre : reportez la surface (A) et le périmètre (P).',
    ]);
    expect(cells(tableUnder(doc, 'Berechnung der U-Werte von transparenten Bauteilen — Types de fenêtres').tBodies[0]!.rows[0]!).slice(0, 8)).toEqual([
      'Fenêtre PVC',
      '1,20',
      '1,35',
      '2',
      '3,24',
      '1,30',
      '0,60',
      'défaut',
    ]);
    expect(cells(tableUnder(doc, 'Energiebezugsflächen / Zonen — Surface de référence énergétique (zones)').tBodies[0]!.rows[0]!)).toEqual([
      'Zone chauffée – Rez-de-chaussée',
      '1,00',
      '1,00',
      '68,40',
      '2,50',
      '171,00',
      'estimé',
    ]);
    expect(cells(tableUnder(doc, 'Gebäudevolumen Ve — Volume brut chauffé').tBodies[0]!.rows[0]!)).toEqual(['Rez-de-chaussée', '1,00', '1,00', '80,00', '2,80', '224,00', 'plan']);
  });

  it('montre à part les parois vers un local chauffé, à ne pas saisir', () => {
    const sheets = makeSheets();
    const party: EnvelopeRow = { ...sheets.envelope[2]!, id: 'party', label: 'Mur mitoyen ouest', boundary: 'heated', orientation: 'W' };
    sheets.envelope = [...sheets.envelope, party];
    const doc = parse(report('fr', sheets));
    const section = [...doc.querySelectorAll('h2')].find((h) => h.textContent?.startsWith('Flächeneingabe'))!.parentElement!;
    const tables = section.querySelectorAll('table');
    expect(tables).toHaveLength(2);
    expect(tables[0]!.tBodies[0]!.rows).toHaveLength(6);
    expect(section.textContent).toContain("hors enveloppe : à ne pas saisir dans l'outil");
    expect(cells(tables[1]!.tBodies[0]!.rows[0]!)).toEqual(['Mur mitoyen ouest', 'Mur extérieur', '1,00', '8,00', '2,80', 'West', 'local chauffé (mitoyen)', 'plan']);
    expect(report('fr')).not.toContain('hors enveloppe');
  });

  it('explique les étiquettes de provenance dans une légende', () => {
    for (const lang of ['fr', 'de'] as const) {
      const doc = parse(report(lang));
      const legend = doc.querySelector('table.legend')!;
      const rows = [...legend.querySelectorAll('tr')].map(cells);
      expect(rows).toEqual(
        lang === 'fr'
          ? [
              ['plan', 'lu sur le plan'],
              ['calculé', 'calculé'],
              ['défaut', 'valeur par défaut — à confirmer'],
              ['estimé', 'estimation — à remplacer'],
              ['expert', "saisi ou confirmé par l'expert"],
              ['à saisir', 'non renseigné — à saisir par vous'],
            ]
          : [
              ['Plan', 'aus dem Plan gelesen'],
              ['berechnet', 'berechnet'],
              ['Standard', 'Standardwert — zu bestätigen'],
              ['geschätzt', 'Schätzung — zu ersetzen'],
              ['Experte', 'vom Experten eingegeben oder bestätigt'],
              ['offen', 'keine Angabe — von Ihnen einzutragen'],
            ],
      );
      // toute étiquette utilisée dans le dossier figure dans la légende
      const known = new Set([...legend.querySelectorAll('.tag')].map((el) => el.className));
      for (const el of doc.querySelectorAll('.tag')) expect(known.has(el.className)).toBe(true);
    }
  });

  it('reste lisible pour un projet vide', () => {
    const sheets = makeSheets();
    Object.assign(sheets, { envelope: [], zones: [], volumes: [], constructions: [], windows: [], findings: [] });
    const project = makeProject();
    project.model.storeys = [];
    project.answers.projectName = '';
    project.answers.street = '';
    project.answers.postcode = '';
    project.answers.locality = '';
    for (const lang of ['fr', 'de'] as const) {
      const doc = parse(report(lang, sheets, project));
      expect(doc.querySelector('.proj')?.textContent).toBe(lang === 'fr' ? 'Projet sans nom' : 'Projekt ohne Namen');
      expect(doc.querySelectorAll('p.empty').length).toBeGreaterThanOrEqual(7);
      expect(doc.body.textContent).toContain(lang === 'fr' ? 'Aucune remarque.' : 'Keine Hinweise.');
      expect(doc.body.textContent).not.toMatch(/undefined|NaN/);
    }
  });
});

describe('reportHtml — contrôles de plausibilité', () => {
  it('traduit par les clés « finding.<code> », classe par gravité et se replie si une clé manque', () => {
    registerMessages({
      fr: { 'finding.test.report': '{storey} : hauteur de {height} m à vérifier.' },
      de: { 'finding.test.report': '{storey}: Höhe von {height} m prüfen.' },
    });
    const sheets = makeSheets();
    sheets.findings = [
      { code: 'test.absent', severity: 'info', params: { count: 3, share: 0.12345 } },
      { code: 'test.report', severity: 'warn', params: { storey: 'Étage', height: 2.5 } },
      { code: 'test.sansParam', severity: 'block', params: {} },
    ];
    const fr = [...tableUnder(parse(report('fr', sheets)), 'Contrôles de plausibilité').tBodies[0]!.rows];
    expect(fr.map((r) => r.className)).toEqual(['sev-block', 'sev-warn', 'sev-info']);
    expect(fr.map(cells)).toEqual([
      ['Bloquant', 'Contrôle « test.sansParam »test.sansParam'],
      ['À vérifier', 'Étage : hauteur de 2,5 m à vérifier.test.report'],
      ['Information', 'Contrôle « test.absent » (détails : count = 3 ; share = 0,12)test.absent'],
    ]);
    const de = [...tableUnder(parse(report('de', sheets)), 'Plausibilitätsprüfungen').tBodies[0]!.rows].map(cells);
    expect(de).toEqual([
      ['Blockierend', 'Prüfung „test.sansParam“test.sansParam'],
      ['Zu prüfen', 'Étage: Höhe von 2,5 m prüfen.test.report'],
      ['Hinweis', 'Prüfung „test.absent“ (Details: count = 3 ; share = 0,12)test.absent'],
    ]);
  });

  it('supporte un contrôle mal formé sans planter', () => {
    const sheets = makeSheets();
    sheets.findings = [{ code: 'test.cassé', severity: 'fatal', params: undefined } as unknown as LuxeebSheets['findings'][number]];
    const rows = [...tableUnder(parse(report('fr', sheets)), 'Contrôles de plausibilité').tBodies[0]!.rows].map(cells);
    expect(rows).toEqual([['Information', 'Contrôle « test.cassé »test.cassé']]);
  });
});

describe('reportHtml — date et plans (laissés à l’appelant)', () => {
  it('laisse la date à remplir à la main quand elle n’est pas fournie', () => {
    const doc = parse(report('fr'));
    const meta = doc.querySelector('.meta')!;
    expect(meta.textContent).toBe('Date : ');
    expect(meta.querySelector('.blank')).not.toBeNull();
    expect(buildReportHtml(makeSheets(), makeProject(), 'fr')).toBe(report('fr'));
    expect(buildReportHtml(makeSheets(), makeProject(), 'fr', {})).toBe(report('fr'));
    expect(buildReportHtml(makeSheets(), makeProject(), 'fr', { date: new Date(Number.NaN) })).toBe(report('fr'));
  });

  it('met la date fournie au format de la langue, ou la chaîne telle quelle', () => {
    const date = new Date(2026, 10, 27);
    const meta = (lang: Lang, d: Date | string): string => parse(buildReportHtml(makeSheets(), makeProject(), lang, { date: d })).querySelector('.meta')?.textContent ?? '';
    expect(meta('fr', date)).toBe('Date : 27/11/2026');
    expect(meta('de', date)).toBe('Datum: 27.11.2026');
    expect(meta('fr', new Date(2027, 0, 5))).toBe('Date : 05/01/2027');
    expect(meta('fr', '27 novembre 2026')).toBe('Date : 27 novembre 2026');
  });

  it('cite les plans utilisés', () => {
    const html = buildReportHtml(makeSheets(), makeProject(), 'de', { date: '27.11.2026', sources: ['EG.dxf', 'Schnitt A-A.pdf', '  '] });
    expect(parse(html).querySelector('.meta')?.textContent).toBe('Datum: 27.11.2026 · Verwendete Pläne: EG.dxf, Schnitt A-A.pdf');
  });

  it('est déterministe : même entrée, même sortie', () => {
    expect(report('fr')).toBe(report('fr'));
    expect(report('de')).toBe(report('de'));
  });
});

describe('reportHtml — injection HTML', () => {
  const ATTACKS = ['<script>alert(1)</script>', '<img src=x onerror=alert(2)>', '"><svg onload=alert(3)>', "'-alert(4)-'", '</td></tr></table><h1>pwn</h1>', 'Tom & Jerry <b>gras</b>'];

  function hostile(): { sheets: LuxeebSheets; project: Project } {
    const [a, b, c, d, e, f] = ATTACKS as [string, string, string, string, string, string];
    const project = makeProject();
    project.answers.projectName = a;
    project.answers.street = b;
    project.answers.postcode = c;
    project.answers.locality = d;
    const storey = project.model.storeys[0]!;
    storey.name = e;
    storey.metresPerUnit.note = a;
    storey.rooms[0]!.name = b;
    storey.rooms[0]!.area.note = c;
    project.model.northAngle.note = f;
    project.model.constructions[1]!.name = e;

    const sheets = makeSheets();
    sheets.envelope = sheets.envelope.map((r, i) => ({ ...r, label: ATTACKS[i % ATTACKS.length]!, elementName: ATTACKS[(i + 1) % ATTACKS.length]! }));
    sheets.envelope.push({ ...sheets.envelope[2]!, id: 'party', boundary: 'heated', label: a, elementName: b });
    sheets.zones = [{ ...sheets.zones[0]!, label: a }];
    sheets.volumes = [{ ...sheets.volumes[0]!, label: b }];
    sheets.constructions = sheets.constructions.map((x, i) => ({ ...x, name: ATTACKS[i]!, u: x.u ? { ...x.u, note: c } : null }));
    sheets.windows = [{ ...sheets.windows[0]!, name: e, g: { value: 0.6, from: 'default', note: a } }];
    sheets.findings = [
      { code: '<script>alert(5)</script>', severity: 'warn', params: { '<b>k</b>': '<i>v</i>', storey: a } },
      { code: 'test.xss', severity: 'info', params: { storey: b } },
    ];
    return { sheets, project };
  }

  it.each(['fr', 'de'] as const)('n’exécute ni n’interprète aucun texte venu du projet ou des plans (%s)', (lang) => {
    registerMessages({ fr: { 'finding.test.xss': 'Étage {storey} à revoir.' }, de: { 'finding.test.xss': 'Geschoss {storey} prüfen.' } });
    const { sheets, project } = hostile();
    const html = buildReportHtml(sheets, project, lang, { date: '<script>alert(6)</script>', sources: ['<img src=y onerror=alert(7)>'] });

    // Dans le texte source : aucune balise active, aucun attribut d'événement hors d'un texte échappé.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<svg/i);
    expect(html).not.toContain('<h1>pwn</h1>');
    expect(html).not.toContain('<b>gras</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Tom &amp; Jerry &lt;b&gt;gras&lt;/b&gt;');
    expect(html).toContain('&#39;-alert(4)-&#39;');

    // Dans le document relu par un navigateur : la structure est intacte et les textes sont là, tels quels.
    const doc = parse(html);
    expect(doc.querySelectorAll('script, img, svg, b, i, iframe').length).toBe(0);
    expect(doc.querySelectorAll('h1').length).toBe(1);
    expect(doc.querySelectorAll('h2').length).toBe(13);
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(['lang', 'charset', 'name', 'content', 'class', 'title']).toContain(attr.name);
      }
    }
    const text = doc.body.textContent ?? '';
    for (const attack of ATTACKS) expect(text).toContain(attack);
    expect(doc.title).toContain('<script>alert(1)</script>');
    expect(doc.querySelector('.proj strong')?.textContent).toBe('<script>alert(1)</script>');
    expect(text).toContain('<script>alert(6)</script>');
    expect(text).toContain('<img src=y onerror=alert(7)>');
    expect(text).toContain(lang === 'fr' ? 'Étage <img src=x onerror=alert(2)> à revoir.' : 'Geschoss <img src=x onerror=alert(2)> prüfen.');
    // les en-têtes de tableaux n'ont pas bougé
    const envelope = [...doc.querySelectorAll('h2')].find((h) => h.textContent?.startsWith('Flächeneingabe'))!.parentElement!.querySelectorAll('table');
    expect(envelope[0]!.tBodies[0]!.rows).toHaveLength(6);
    expect(envelope[1]!.tBodies[0]!.rows).toHaveLength(1);
  });

  it('échappe aussi les guillemets dans les attributs', () => {
    const html = report('fr');
    // les seuls attributs « title » sont ceux des étiquettes, tirés du dictionnaire
    const titles = [...parse(html).querySelectorAll('[title]')].map((el) => el.getAttribute('title'));
    expect(titles.length).toBeGreaterThan(20);
    expect(new Set(titles)).toEqual(
      new Set([
        'lu sur le plan',
        'calculé',
        'valeur par défaut — à confirmer',
        'estimation — à remplacer',
        "saisi ou confirmé par l'expert",
        'non renseigné — à saisir par vous',
      ]),
    );
    expect(html).toContain('title="saisi ou confirmé par l&#39;expert"');
  });
});
