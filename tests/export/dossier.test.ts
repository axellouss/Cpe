/**
 * Dossier CPE : feuilles de LuxEeB-Tool dans l'ordre, colonnes de l'outil, provenance et confiance de chaque valeur,
 * contrôles de plausibilité, hypothèses ; blocs à coller des couches et des fenêtres. Données inventées.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PLAUSIBILITY_625, SHEETS_625 } from '../../src/core/cpe';
import type { Project } from '../../src/core/types';
import { deriveSheets, withExpertWindowTypes } from '../../src/engine';
import { constructionFromComposition } from '../../src/engine/materials';
import { buildDossier, buildReportHtml, envelopePasteBlock, layersPasteBlock, plausibilityChecks, sheetsToCsv, windowsPasteBlock } from '../../src/export';
import { plancheA1 } from '../engine/planche-case';
import { readTruth } from '../engine/planche-helpers';
import { makeProject } from './fixtures';

let rich: Project;
let richCase: ReturnType<typeof plancheA1>;

beforeAll(async () => {
  richCase = plancheA1(await readTruth('planche_A1_archicad'));
  const p = richCase.project;
  // Modèle complet : éléments tirés des compositions lues, fenêtres par façade et dimensions, ordre « expert ».
  const comps = richCase.reading.compositions;
  const wall = constructionFromComposition(comps.find((c) => c.element === 'external-wall')!, { id: 'wall-outside', lang: 'fr' });
  const roof = constructionFromComposition(comps.find((c) => c.element === 'roof')!, { id: 'roof', lang: 'fr' });
  const floor = constructionFromComposition(comps.find((c) => c.element === 'floor-on-ground')!, { id: 'floor-ground', lang: 'fr' });
  const model = {
    ...p.model,
    envelopeOrder: 'expert' as const,
    constructions: p.model.constructions.map((c) => (c.id === wall.id ? wall : c.id === roof.id ? roof : c.id === floor.id ? floor : c)),
  };
  rich = { ...p, model: withExpertWindowTypes(model, 'fr'), answers: { ...p.answers, airtightness: 'class-a-with-ventilation', ventilation: 'balanced-hr', heatRecovery: 0.86 } };
});

describe('buildDossier — structure', () => {
  it('une section par feuille de LuxEeB-Tool 6.25, dans l’ordre de l’outil', () => {
    const d = buildDossier(makeProject(), [], 'fr');
    expect(d.version).toBe(2);
    expect(d.tool.version).toBe('6.25');
    expect(d.sections.map((s) => s.key)).toEqual(SHEETS_625.map((s) => s.key));
    expect(d.sections.map((s) => s.luxeebName)).toEqual(SHEETS_625.map((s) => s.de));
    expect(buildDossier(makeProject(), [], 'de').sections[4]!.title).toBe('Flächeneingabe der Gebäudehülle');
  });

  it('colonnes de l’enveloppe aux libellés de l’outil', () => {
    const env = buildDossier(makeProject(), [], 'fr').sections.find((s) => s.key === 'envelope')!.tables[0]!;
    expect(env.columns.map((c) => c.de).slice(0, 9)).toEqual(['Bauteilnummer', 'Anzahl', 'Länge [m]', 'Breite [m] od. Fläche [m²]', 'Orientierung', 'U [W/m²K]', 'FJ', 'Abzug', 'Ai [m²]']);
  });

  it('chaque valeur porte sa provenance ; une hypothèse a une confiance nulle', () => {
    const d = buildDossier(makeProject(), [], 'fr');
    const win = d.sections.find((s) => s.key === 'windows')!.tables[0]!;
    expect(win.rows).toHaveLength(1);
    const g = win.rows[0]!.cells[10]!; // g-Wert 0,6 'default' dans le jeu d'essai
    expect(g).toMatchObject({ text: '0,60', from: 'default', confidence: 0 });
    for (const s of d.sections) for (const t of s.tables) for (const r of t.rows) for (const c of r.cells) {
      expect(c.text === '' || c.from !== undefined).toBe(true);
      expect(c.text).not.toMatch(/\d\.\d/);
    }
  });

  it('ne présente aucune valeur absente comme lue', () => {
    const d = buildDossier(makeProject(), [], 'fr');
    const vent = d.sections.find((s) => s.key === 'ventilation')!;
    expect(vent.fields.find((f) => f.key === 'flow')!.value).toEqual({ text: '', from: null, confidence: null });
  });
});

describe('buildDossier — planche synthétique riche, ordre « expert »', () => {
  it('éléments à couches, λ d’usage étiquetées hypothèses avec leur source', () => {
    const d = buildDossier(rich, [], 'fr');
    const opaque = d.sections.find((s) => s.key === 'opaque')!;
    const layers = opaque.tables.find((t) => t.key === 'layers')!;
    expect(layers.rows.length).toBeGreaterThanOrEqual(10);
    const eps = layers.rows.find((r) => r.cells[2]!.text === 'EPS')!;
    expect(eps.cells[3]).toMatchObject({ text: '0,032', from: 'default', confidence: 0 });
    expect(eps.cells[3]!.source).toContain('hypothèse');
    expect(opaque.notes.join(' ')).toContain('LuxEeB-Tool fait foi');
    expect(d.assumptions.some((a) => a.sheet === 'opaque' && a.text.includes('EPS'))).toBe(true);
    expect(d.assumptions.some((a) => a.sheet === 'windows')).toBe(true);
  });

  it('épaisseur illisible : ni U pré-calculé, ni épaisseur 0 présentée comme lue', () => {
    const comps = richCase.reading.compositions;
    const rc = comps.find((c) => c.element === 'external-wall')!;
    const broken = { ...rc, layers: rc.layers.map((l) => (l.material === 'eps' ? { ...l, thicknessCm: null } : l)) };
    const wall = constructionFromComposition(broken, { id: 'wall-outside', lang: 'fr' });
    expect(wall.u).toBeNull();
    const p: Project = { ...rich, model: { ...rich.model, constructions: rich.model.constructions.map((c) => (c.id === wall.id ? wall : c)) } };
    const opaque = buildDossier(p, [], 'fr').sections.find((s) => s.key === 'opaque')!;
    const el = opaque.tables.find((t) => t.key === 'elements')!.rows.find((r) => r.id.startsWith('wall-outside|'))!;
    expect(el.cells[4]!.text).toBe('');
    const eps = opaque.tables.find((t) => t.key === 'layers')!.rows.find((r) => r.id.startsWith('wall-outside|') && r.cells[2]!.text === 'EPS')!;
    expect(eps.cells[4]).toMatchObject({ text: '', from: null });
    expect(eps.cells[4]!.doubt).toContain('Épaisseur');
    expect(layersPasteBlock(wall).split('\r\n').find((line) => line.startsWith('EPS'))).toBe('EPS\t0,032\t');
  });

  it('plus de 10 couches dans un élément : signalé (10 lignes dans l’outil)', () => {
    const wall = rich.model.constructions.find((c) => c.id === 'wall-outside')!;
    const many = { ...wall, layers: Array.from({ length: 11 }, (_, k) => ({ ...wall.layers![0]!, name: `Couche ${k + 1}` })) };
    const p: Project = { ...rich, model: { ...rich.model, constructions: rich.model.constructions.map((c) => (c.id === wall.id ? many : c)) } };
    const notes = buildDossier(p, [], 'fr').sections.find((s) => s.key === 'opaque')!.notes.join(' ');
    expect(notes).toContain('11 couches pour 10 lignes');
    expect(buildDossier(rich, [], 'fr').sections.find((s) => s.key === 'opaque')!.notes.join(' ')).not.toContain('lignes dans l’outil');
  });

  it('fenêtres : géométrie, einfach / mehrfach et Uw pré-calculé', () => {
    const d = buildDossier(rich, [], 'fr');
    const win = d.sections.find((s) => s.key === 'windows')!.tables[0]!;
    expect(win.rows.length).toBeGreaterThan(1);
    for (const r of win.rows) {
      expect(['einfach', 'mehrfach']).toContain(r.cells[5]!.text);
      expect(r.cells[11]!.text).toMatch(/^0,\d\d$/);
    }
  });

  it('enveloppe : façades saisies en surface, orientation vide vers le non chauffé', () => {
    const d = buildDossier(rich, [], 'fr');
    const env = d.sections.find((s) => s.key === 'envelope')!.tables[0]!;
    const sheets = deriveSheets(rich, 'fr');
    const areaRows = sheets.envelope.filter((r) => r.entry === 'area');
    expect(areaRows.length).toBeGreaterThan(0);
    for (const r of areaRows) {
      const row = env.rows.find((x) => x.id === r.id)!;
      expect(row.cells[2]!.text).toBe('');
      expect(row.cells[3]!.number).toBeCloseTo(r.grossArea, 2);
    }
    for (const r of sheets.envelope.filter((x) => x.boundary === 'unheated')) expect(env.rows.find((x) => x.id === r.id)!.cells[4]!.text).toBe('');
  });

  it('questions encore ouvertes rangées sous leur feuille', () => {
    const d = buildDossier(rich, richCase.sheets, 'fr', { reading: richCase.reading });
    expect(d.sections.find((s) => s.key === 'zones')!.notes.some((n) => n.startsWith('À trancher'))).toBe(true);
  });
});

describe('contrôles de plausibilité (plages de l’outil)', () => {
  it('toutes les plages calculables sont évaluées ; les résultats du bilan restent « n/a »', () => {
    const checks = plausibilityChecks(rich, deriveSheets(rich, 'fr'), 'fr');
    expect(checks.map((c) => c.key)).toEqual(PLAUSIBILITY_625.map((p) => p.key));
    expect(checks.find((c) => c.key === 'qH')!.status).toBe('n/a');
    expect(checks.find((c) => c.key === 'n50')).toMatchObject({ value: 0.6, status: 'P' });
    expect(checks.find((c) => c.key === 'heatRecovery')).toMatchObject({ value: 0.86, status: 'P' });
    expect(checks.find((c) => c.key === 'windowShare')!.value).toBeGreaterThan(0);
  });

  it('A/V comme l’outil (Ai = Σ A·Fx) : « n/a » tant qu’un Fx (sol) n’est connu que de l’outil', () => {
    // Planche riche : dalle sur sol, dont l'outil calcule le Fx → pas de rapport A/V, et une note l'explique.
    const d = buildDossier(rich, [], 'fr');
    expect(d.plausibility.find((c) => c.key === 'aOverVe')!.status).toBe('n/a');
    expect(d.sections.find((s) => s.key === 'plausibility')!.notes.join(' ')).toContain('Σ A·Fx');
    // Tous les Fx observés (dalle traitée en plancher sur local non chauffé, Fx 0,8) : Ai / Ve, pas l'enveloppe brute.
    const p: Project = {
      ...rich,
      model: { ...rich.model, constructions: rich.model.constructions.map((c) => (c.category === 'floor' ? { ...c, luxeebType: 'kellerdecke' as const } : c)) },
      answers: { ...rich.answers, thermalBridges: '0.05' },
    };
    const sheets = deriveSheets(p, 'fr');
    const checks = plausibilityChecks(p, sheets, 'fr');
    const av = checks.find((c) => c.key === 'aOverVe')!;
    expect(av.value).not.toBeNull();
    expect(av.value!).toBeLessThan(sheets.totals.aOverVe);
    const floor = sheets.envelope.filter((r) => r.kind === 'floor' && !r.deduct).reduce((s, r) => s + r.netArea, 0);
    expect(floor).toBeGreaterThan(0);
    expect(av.value! * sheets.totals.ve).toBeLessThanOrEqual(sheets.totals.envelopeArea - 0.2 * floor + 1e-6);
    const mean = checks.find((c) => c.key === 'meanU')!;
    if (mean.value !== null) expect(mean.value).toBeGreaterThan(0.05);
  });
});

describe('exports adaptés', () => {
  it('CSV : un tableau par feuille avec provenance, confiance, source et doute', () => {
    const csv = sheetsToCsv(deriveSheets(rich, 'fr'), rich, 'fr');
    expect(csv).toContain('Dossier CPE — feuilles de LuxEeB-Tool');
    expect(csv).toContain('Berechnung der U-Werte von Bauteilen — Calcul valeur U de la construction (layers)');
    expect(csv).toContain(';Provenance;Confiance;Source;Doute\r\n');
    expect(csv).toContain('Hypothèses à confirmer');
  });

  it('rapport : hypothèses à confirmer et pré-contrôles, sans nouvelle section de premier niveau', () => {
    const html = buildReportHtml(deriveSheets(rich, 'fr'), rich, 'fr');
    expect(html).toContain('Hypothèses à confirmer (rien sur la planche)');
    expect(html).toContain('Pré-contrôles « Plausibilitätscheck »');
  });

  it('blocs à coller : couches (Baustoff, λ, cm) et fenêtres', () => {
    const wall = rich.model.constructions.find((c) => c.id === 'wall-outside')!;
    expect(layersPasteBlock(wall).split('\r\n')[0]).toBe('Béton\t2,100\t24,0');
    const types = rich.model.windowTypes.filter((w) => w.geometry);
    const first = windowsPasteBlock(types).split('\r\n')[0]!.split('\t');
    expect(first).toHaveLength(10);
    expect(first.slice(4, 10)).toEqual([expect.stringMatching(/^(einfach|mehrfach)$/), expect.stringMatching(/^[12]$/), '0,50', '1,00', '0,035', '0,50']);
    expect(layersPasteBlock({ layers: [{ name: 'Brique', material: 'brique', lambda: null, thicknessCm: { value: 20, from: 'plan' } }] })).toBe('Brique\t\t20,0');
  });

  it('bloc d’enveloppe : une saisie par surface laisse « Länge » vide', () => {
    const rows = deriveSheets(rich, 'fr').envelope;
    const i = rows.findIndex((r) => r.entry === 'area');
    const line = envelopePasteBlock(rows).split('\r\n')[i]!.split('\t');
    expect(line[1]).toBe('');
    expect(Number(line[2]!.replace(',', '.'))).toBeCloseTo(rows[i]!.grossArea, 2);
  });
});
