/**
 * Format de fichier 2 : lecture des fichiers 1 (migration sans rien inventer), aller-retour des champs ajoutés,
 * refus clair d'une valeur invalide dans un champ nouveau.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/core/types';
import { deriveSheets } from '../../src/engine';
import { parseProject, PROJECT_FILE_VERSION, ProjectFileError, serializeProject } from '../../src/export';
import { makeProject } from './fixtures';

/** Le même projet tel qu'un Plan2CPE d'avant le dossier CPE l'aurait écrit. */
function v1Text(project: Project = makeProject()): string {
  return JSON.stringify({ app: 'Plan2CPE', version: 1, model: project.model, answers: project.answers }, null, 2);
}

function richProject(): Project {
  const p = makeProject();
  const wall = p.model.constructions[0]!;
  wall.luxeebType = 'aussenwand';
  wall.deltaU = 0;
  wall.layers = [
    { name: 'Enduit plâtre', material: 'enduit-platre', lambda: { value: 0.7, from: 'default', confidence: 0, source: 'valeur d’usage' }, thicknessCm: { value: 1.5, from: 'plan', confidence: 0.9 } },
    { name: 'EPS', material: 'eps', lambda: null, thicknessCm: { value: 20, from: 'plan' }, planText: '20cm Isolation type EPS', doubt: null },
    { name: 'Laine minérale', material: 'laine-minerale', lambda: null, thicknessCm: { value: 0, from: 'plan', confidence: 0 }, thicknessUnknown: true, doubt: 'épaisseur non écrite' },
  ];
  p.model.constructions[2]!.ground = { area: { value: 80, from: 'calc' }, perimeter: { value: 28, from: 'calc' } };
  p.model.constructions.push({ id: 'c-door', name: 'Porte d’entrée', category: 'door', u: { value: 1.3, from: 'default', source: 'hypothèse' }, ownValue: true, luxeebType: 'aussentuer' });
  const w = p.model.windowTypes[0]!;
  w.geometry = { width: 1.2, height: 1.35, frameWidth: { value: 0.112, from: 'default' }, fensterTyp: { value: 'einfach', from: 'default', confidence: 0.4, doubt: 'largeur seule' }, panes: 1 };
  w.ug = { value: 0.5, from: 'default' };
  w.uf = null;
  w.psiG = { value: 0.035, from: 'default' };
  p.model.facadeViews = [{ orientation: 'S', short: 'AV', title: 'FAÇADE AVANT', viewId: 'p1-elevation1' }, { orientation: 'N', short: 'ARR', title: null }];
  p.model.heightConvention = 'external';
  p.model.envelopeOrder = 'expert';
  p.answers.ventilationUnit = 'VMC double flux';
  p.answers.ventilationFlow = 120;
  p.answers.heatRecovery = 0.85;
  p.answers.fanPower = null;
  p.answers.airtightness = 'class-a-with-ventilation';
  p.answers.thermalBridges = '0.03';
  p.answers.thermalMass = 'heavy';
  p.answers.emissionTemps = '35/28';
  p.answers.hotWaterStorageInside = true;
  p.answers.attachment = 'one-side';
  return p;
}

describe('fichier de version 1', () => {
  it('se relit, devient un projet de version 2, sans aucun champ ajouté', () => {
    const back = parseProject(v1Text());
    expect(back.version).toBe(2);
    expect(back).toEqual({ ...makeProject(), version: 2 });
    // Aucun champ de la version 2 n'apparaît, pas même à null.
    expect('facadeViews' in back.model).toBe(false);
    expect('envelopeOrder' in back.model).toBe(false);
    expect('layers' in back.model.constructions[0]!).toBe(false);
    expect('geometry' in back.model.windowTypes[0]!).toBe(false);
    for (const key of ['ventilationUnit', 'airtightness', 'thermalBridges', 'attachment', 'hotWaterStorageInside']) {
      expect(key in back.answers).toBe(false);
    }
    expect('confidence' in back.model.storeys[0]!.metresPerUnit).toBe(false);
  });

  it('se réécrit en version 2 et donne le même relevé', () => {
    const original = makeProject();
    const migrated = parseProject(v1Text(original));
    const text = serializeProject(migrated);
    expect(JSON.parse(text).version).toBe(PROJECT_FILE_VERSION);
    expect(PROJECT_FILE_VERSION).toBe(2);
    expect(deriveSheets(parseProject(text), 'fr')).toEqual(deriveSheets(original, 'fr'));
  });
});

describe('champs de la version 2', () => {
  it('font un aller-retour sans perte', () => {
    const project = richProject();
    const back = parseProject(serializeProject(project));
    expect(back).toEqual(project);
    expect(serializeProject(back)).toBe(serializeProject(project));
  });

  it('ne changent pas le relevé tant que l’ordre « expert » n’est pas demandé', () => {
    const project = richProject();
    delete project.model.envelopeOrder;
    expect(deriveSheets(project, 'fr').envelope).toEqual(deriveSheets(makeProject(), 'fr').envelope);
  });

  it('sont vérifiés comme les autres : valeur hors liste refusée avec son chemin', () => {
    const data = JSON.parse(serializeProject(richProject())) as { model: { constructions: { luxeebType?: string; layers?: { material: string }[] }[] } };
    data.model.constructions[0]!.layers![1]!.material = 'adamantium';
    let caught: unknown;
    try {
      parseProject(JSON.stringify(data));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectFileError);
    expect((caught as Error).message).toContain('« model.constructions[0].layers[1].material » vaut « adamantium »');
  });

  it('refusent une réponse au mauvais type', () => {
    const data = JSON.parse(serializeProject(richProject())) as { answers: Record<string, unknown> };
    data.answers['heatRecovery'] = '86 %';
    expect(() => parseProject(JSON.stringify(data))).toThrow('« answers.heatRecovery » doit être un nombre');
  });
});
