/**
 * Le moteur est fait de fonctions PURES : mêmes entrées → mêmes sorties, et les objets reçus ne sont jamais modifiés
 * (l'interface peut donc recalculer à chaque geste sans copie défensive).
 */
import { describe, expect, it } from 'vitest';
import type { ManualRow, PlanDocument, Project } from '../../src/core/types';
import { createEmptyProject, createStorey, deriveSheets, modelFromDocument, rescaleStorey, storeyMetrics } from '../../src/engine';
import { EAST, NORTH, SOUTH, WEST, deepFreeze, doorAt, project, rect, room, sheet, storey, windowAt } from './helpers';

/** Un projet qui passe par toutes les branches : mitoyen, garage, toiture inclinée, retrait, pièces, lignes manuelles. */
function richProject(): Project {
  const manualRows: ManualRow[] = [
    { id: 'm1', label: 'Lucarne – fenêtre', constructionId: null, windowTypeId: 'window-default', count: 1, length: 1.2, width: 1.1, orientation: 'S', boundary: 'outside', deduct: true },
    { id: 'm2', label: 'Lucarne', constructionId: 'wall-outside', windowTypeId: null, count: 1, length: 5, width: 1.5, orientation: 'S', boundary: 'outside', deduct: false },
  ];
  return project(
    [
      storey('rdc', 'RDC', rect(12, 10), {
        boundaries: { [EAST]: 'heated', [WEST]: 'unheated' },
        openings: [windowAt(NORTH, 1.2, 1.35, 2), doorAt(WEST, 0.9, 2), windowAt(EAST, 1, 1), windowAt(9, 1, 1)],
        rooms: [room('Séjour', 40), room('Cuisine', 14), room('Cave', 10, false, true)],
      }),
      storey('combles', 'Combles', rect(12, 8), { openings: [windowAt(SOUTH, 0.78, 1.18)], netArea: 60, heightFrom: 'default' }),
    ],
    {
      northAngle: { value: 20, from: 'default' },
      storeysAligned: true,
      top: { kind: 'pitched-roof', pitchDeg: 40, shape: 'gable', ridgeAngle: null, kneeWallHeight: 0, constructionId: null, from: 'user' },
      bottom: { kind: 'above-unheated', constructionId: null, from: 'default' },
      manualRows,
    },
  );
}

describe('deriveSheets est pure', () => {
  it('ne modifie pas le projet reçu', () => {
    const p = richProject();
    const before = structuredClone(p);
    deriveSheets(p, 'fr');
    deriveSheets(p, 'de');
    expect(p).toEqual(before);
  });

  it('fonctionne sur un projet gelé en profondeur (toute écriture lèverait une erreur)', () => {
    const frozen = deepFreeze(richProject());
    expect(() => deriveSheets(frozen, 'fr')).not.toThrow();
    expect(deriveSheets(frozen, 'fr')).toEqual(deriveSheets(richProject(), 'fr'));
  });

  it('est déterministe : deux appels donnent des résultats égaux mais indépendants', () => {
    const p = richProject();
    const a = deriveSheets(p, 'fr');
    const b = deriveSheets(p, 'fr');
    expect(a).toEqual(b);
    expect(a.envelope[0]).not.toBe(b.envelope[0]);
    // Modifier un résultat ne touche ni le projet ni le résultat suivant
    a.envelope[0]!.count = 99;
    a.totals.an = -1;
    expect(deriveSheets(p, 'fr')).toEqual(b);
  });

  it('ne partage pas ses objets avec le projet (valeurs U recopiées)', () => {
    const p = richProject();
    p.model.constructions = p.model.constructions.map((c) => ({ ...c, u: { value: 0.25, from: 'user' as const } }));
    const d = deriveSheets(p, 'fr');
    d.constructions[0]!.u!.value = 99;
    expect(p.model.constructions.every((c) => c.u!.value === 0.25)).toBe(true);
  });

  it('la langue ne change que les textes, jamais les nombres', () => {
    const numbers = (lang: 'fr' | 'de') => {
      const d = deriveSheets(richProject(), lang);
      return {
        rows: d.envelope.map((r) => [r.id, r.kind, r.count, r.length, r.width, r.orientation, r.boundary, r.deduct, r.grossArea, r.netArea, r.from]),
        zones: d.zones.map((z) => [z.area, z.clearHeight, z.airVolume, z.from]),
        volumes: d.volumes.map((v) => [v.area, v.height, v.volume, v.from]),
        totals: d.totals,
        findings: d.findings.map((f) => [f.code, f.severity]),
      };
    };
    expect(numbers('de')).toEqual(numbers('fr'));
  });

  it('respecte partout les invariants du tableau LuxEeB', () => {
    const d = deriveSheets(richProject(), 'fr');
    const ids = d.envelope.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // identifiants uniques
    let pending = 0;
    for (const r of d.envelope) {
      // surface = nombre × longueur × largeur, à partir des valeurs arrondies au centimètre
      expect(r.length).toBe(Math.round(r.length * 100) / 100);
      expect(r.width).toBe(Math.round(r.width * 100) / 100);
      expect(r.grossArea).toBeCloseTo(r.count * r.length * r.width, 9);
      expect(r.boundary).not.toBe('heated');
      if (r.deduct) {
        pending += r.grossArea;
        expect(r.netArea).toBe(r.grossArea);
      } else {
        // « Abzug » : tout ce qui est marqué au-dessus est déduit de la première ligne non marquée
        expect(r.netArea).toBeCloseTo(r.grossArea - pending, 9);
        pending = 0;
      }
    }
    expect(pending).toBe(0); // aucune déduction orpheline en fin de tableau
    const nonDeducted = d.envelope.filter((r) => !r.deduct).reduce((s, r) => s + r.grossArea, 0);
    expect(d.totals.envelopeArea).toBeCloseTo(nonDeducted, 2);
    expect(d.totals.an).toBeCloseTo(d.zones.reduce((s, z) => s + z.area, 0), 2);
    expect(d.totals.vn).toBeCloseTo(d.zones.reduce((s, z) => s + z.airVolume, 0), 2);
    expect(d.totals.ve).toBeCloseTo(d.volumes.reduce((s, v) => s + v.volume, 0), 2);
    // Le récapitulatif par type retrouve toute l'enveloppe opaque : nets des parois + portes
    const opaque = d.envelope.filter((r) => r.constructionId !== null).reduce((s, r) => s + (r.deduct ? r.grossArea : r.netArea), 0);
    expect(d.constructions.reduce((s, c) => s + c.area, 0)).toBeCloseTo(opaque, 1);
    const glazed = d.envelope.filter((r) => r.kind === 'window').reduce((s, r) => s + r.grossArea, 0);
    expect(d.windows.reduce((s, w) => s + w.area, 0)).toBeCloseTo(glazed, 2);
    expect(opaque + glazed).toBeCloseTo(nonDeducted, 6);
  });
});

describe('les autres fonctions du moteur sont pures aussi', () => {
  const source = () =>
    sheet('s1', 'Plan RDC', {
      metresPerUnit: { value: 0.01, from: 'plan' },
      detected: {
        outline: rect(1000, 800),
        openings: [{ kind: 'window', a: { x: 200, y: 15 }, b: { x: 320, y: 15 } }],
        rooms: [{ name: 'Séjour', statedArea: 30, heatedGuess: 'yes', at: { x: 1, y: 2 }, polygon: rect(5, 5) }],
        notes: [],
      },
    });

  it('createStorey ne modifie ni la feuille ni le bâtiment, et ne partage aucun point avec la feuille', () => {
    const frozenSheet = deepFreeze(source());
    const frozenModel = deepFreeze(createEmptyProject('fr').model);
    const s = createStorey(frozenSheet, 'RDC', frozenModel);
    expect(frozenModel.storeys).toEqual([]); // l'étage est RENDU, pas ajouté
    s.outline[0]!.x = 123;
    s.metresPerUnit.value = 5;
    s.rooms[0]!.polygon![0]!.x = 77;
    s.rooms[0]!.at!.x = 88;
    expect(frozenSheet).toEqual(source());
  });

  it('modelFromDocument ne modifie pas le document', () => {
    const doc: PlanDocument = { fileName: 'a.dxf', kind: 'dxf', sheets: [source()], northAngle: { value: 10, from: 'plan' }, storeysAligned: false, warnings: [] };
    const frozen = deepFreeze(structuredClone(doc));
    const model = modelFromDocument(frozen, 'fr');
    model.northAngle.value = 99;
    model.storeys[0]!.outline[0]!.x = 123;
    expect(frozen).toEqual(doc);
  });

  it('storeyMetrics et rescaleStorey ne modifient pas l’étage', () => {
    const s = deepFreeze(createStorey(source(), 'RDC', createEmptyProject('fr').model));
    expect(() => storeyMetrics(s)).not.toThrow();
    const rescaled = rescaleStorey(s, { value: 0.02, from: 'user' });
    expect(rescaled).not.toBe(s);
    expect(s.metresPerUnit.value).toBe(0.01);
    expect(storeyMetrics(rescaled).grossArea).toBeCloseTo(320); // 20 × 16 m
  });
});
