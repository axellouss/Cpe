// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Provenance } from '../../src/core/types';
import { EXPORT_MIME, exportFileName, reportHtml } from '../../src/export';
import { weakestProvenance } from '../../src/export/format';
import { makeProject, makeSheets } from './fixtures';

describe('exportFileName', () => {
  it('propose un nom par type de fichier, d’après le nom du projet', () => {
    const project = makeProject();
    expect(exportFileName(project, 'project')).toBe('plan2cpe-maison-schmit.json');
    expect(exportFileName(project, 'csv')).toBe('plan2cpe-maison-schmit-releve.csv');
    expect(exportFileName(project, 'report')).toBe('plan2cpe-maison-schmit-dossier.html');
  });

  it('retire accents et caractères interdits dans un nom de fichier', () => {
    const project = makeProject();
    project.answers.projectName = "  Maison Müller – Rue de l'Église n°12 / lot: <A>?  ";
    expect(exportFileName(project, 'project')).toBe('plan2cpe-maison-muller-rue-de-l-eglise-n-12-lot-a.json');
    project.answers.projectName = 'Straße ' + 'x'.repeat(80);
    const name = exportFileName(project, 'csv');
    expect(name).toMatch(/^plan2cpe-strasse-x+-releve\.csv$/);
    expect(name.length).toBeLessThanOrEqual('plan2cpe-'.length + 40 + '-releve.csv'.length);
    expect(name).toMatch(/^[a-z0-9.-]+$/);
  });

  it('retombe sur « projet » quand le nom est vide ou inutilisable', () => {
    const project = makeProject();
    for (const empty of ['', '   ', '???', '../..']) {
      project.answers.projectName = empty;
      expect(exportFileName(project, 'report')).toBe('plan2cpe-projet-dossier.html');
    }
  });

  it('nomme les fichiers dans la langue de l’interface : allemand sans accent ni « ß »', () => {
    const project = makeProject();
    expect(exportFileName(project, 'project', 'de')).toBe('plan2cpe-maison-schmit.json');
    expect(exportFileName(project, 'csv', 'de')).toBe('plan2cpe-maison-schmit-aufmass.csv');
    expect(exportFileName(project, 'report', 'de')).toBe('plan2cpe-maison-schmit-akte.html');
    project.answers.projectName = '';
    expect(exportFileName(project, 'csv', 'de')).toBe('plan2cpe-projekt-aufmass.csv');
    expect(exportFileName(project, 'csv', 'fr')).toBe('plan2cpe-projet-releve.csv');
    for (const lang of ['fr', 'de'] as const) for (const kind of ['project', 'csv', 'report'] as const) expect(exportFileName(project, kind, lang)).toMatch(/^[a-z0-9.-]+$/);
  });

  it('donne le type MIME de chaque fichier', () => {
    expect(EXPORT_MIME).toEqual({ project: 'application/json', csv: 'text/csv;charset=utf-8', report: 'text/html;charset=utf-8' });
  });
});

describe('données inattendues à l’exécution', () => {
  it('ignore une provenance inconnue au lieu de la propager', () => {
    expect(weakestProvenance(['user', 'toString' as Provenance, 'plan'])).toBe('plan');
    expect(weakestProvenance(['constructor' as Provenance])).toBe('calc');
  });

  it('ne met jamais une provenance ou une gravité inconnue dans un nom de classe HTML', () => {
    const sheets = makeSheets();
    const hostile = '"><script>alert(1)</script>' as Provenance;
    sheets.envelope = sheets.envelope.map((r) => ({ ...r, from: hostile }));
    sheets.zones = sheets.zones.map((z) => ({ ...z, from: hostile }));
    sheets.totals = { ...sheets.totals, anFrom: hostile, veFrom: hostile };
    sheets.findings = [{ code: 'x', severity: 'constructor' as unknown as 'info', params: {} }];
    const project = makeProject();
    project.model.top.from = hostile;
    project.model.storeys[0]!.grossHeight.from = hostile;
    const html = reportHtml(sheets, project, 'fr');
    expect(html).not.toMatch(/<script/i);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script').length).toBe(0);
    const classes = new Set([...doc.querySelectorAll('.tag')].map((el) => el.className));
    for (const cls of classes) expect(cls).toMatch(/^tag tag-(plan|calc|default|estimate|user|none)$/);
    expect(classes.has('tag tag-none')).toBe(true);
    expect([...doc.querySelectorAll('tr[class^="sev-"]')].map((el) => el.className)).toEqual(['sev-info']);
  });
});
