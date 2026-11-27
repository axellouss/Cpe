/**
 * Jeux d'essai écrits À LA MAIN (ils ne dépendent pas du moteur) : une petite maison mitoyenne d'un niveau,
 * 10 m × 8 m, mur ouest contre un voisin chauffé.
 */
import type { EnvelopeRow, LuxeebSheets, Project } from '../../src/core/types';

export function makeProject(): Project {
  return {
    version: 1,
    model: {
      storeys: [
        {
          id: 's0',
          name: 'Rez-de-chaussée',
          sheetId: 'sheet-1',
          outline: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 8 },
            { x: 0, y: 8 },
          ],
          edges: [
            { boundary: 'outside', constructionId: null },
            { boundary: 'outside', constructionId: 'c-wall' },
            { boundary: 'outside', constructionId: null },
            { boundary: 'heated', constructionId: null },
          ],
          metresPerUnit: { value: 1, from: 'user', note: 'Règle posée sur la cote 10,00' },
          grossHeight: { value: 2.8, from: 'plan' },
          clearHeight: { value: 2.5, from: 'default' },
          openings: [
            { id: 'o1', edgeIndex: 0, kind: 'window', width: 1.2, height: 1.35, count: 2, position: 0.4, windowTypeId: 'w1', from: 'plan' },
          ],
          rooms: [
            { id: 'r1', name: 'Séjour', area: { value: 42.3, from: 'plan', note: 'Étiquette du plan' }, heated: true, needsReview: false, at: { x: 3, y: 3 } },
            {
              id: 'r2',
              name: 'Buanderie',
              area: { value: 9.1, from: 'estimate' },
              heated: false,
              needsReview: true,
              polygon: [
                { x: 7, y: 5 },
                { x: 10, y: 5 },
                { x: 10, y: 8 },
                { x: 7, y: 8 },
              ],
            },
          ],
          netAreaOverride: null,
        },
      ],
      northAngle: { value: 0, from: 'default', note: 'Nord supposé en haut de la feuille' },
      storeysAligned: false,
      top: { kind: 'flat-roof', pitchDeg: 0, shape: 'gable', ridgeAngle: null, kneeWallHeight: 0, constructionId: 'c-roof', from: 'default' },
      bottom: { kind: 'slab-on-ground', constructionId: 'c-floor', from: 'user' },
      constructions: [
        { id: 'c-wall', name: 'Mur extérieur', category: 'wall', u: { value: 0.35, from: 'default' } },
        { id: 'c-roof', name: 'Toiture plate', category: 'roof', u: null },
        { id: 'c-floor', name: 'Dalle sur terre-plein', category: 'floor', u: { value: 0.406, from: 'estimate', note: 'Typologie 1970-1980' } },
      ],
      windowTypes: [{ id: 'w1', name: 'Fenêtre PVC', uw: { value: 1.3, from: 'user' }, g: { value: 0.6, from: 'default' } }],
      manualRows: [],
    },
    answers: {
      projectName: 'Maison Schmit',
      street: "12, rue de l'Église",
      postcode: 'L-7410',
      locality: 'Angelsberg',
      buildingType: 'EFH',
      dwellings: 1,
      occasion: 'existing',
      yearBuilt: 1978,
      insulationWallsCm: 12,
      insulationRoofCm: 0,
      insulationFloorCm: null,
      windowGeneration: 'double-lowe',
      heatGenerator: 'gas-condensing',
      heatGeneratorYear: 2012,
      heatEmission: 'radiators',
      hotWater: 'with-heating',
      ventilation: 'windows',
      n50: null,
      solarThermal: false,
      photovoltaic: true,
    },
  };
}

function row(partial: Partial<EnvelopeRow> & Pick<EnvelopeRow, 'id' | 'kind' | 'label' | 'elementName' | 'count' | 'length' | 'width' | 'orientation'>): EnvelopeRow {
  const grossArea = partial.count * partial.length * partial.width;
  return {
    constructionId: null,
    windowTypeId: null,
    boundary: 'outside',
    deduct: false,
    grossArea,
    netArea: grossArea,
    from: 'plan',
    storeyId: 's0',
    manual: false,
    ...partial,
  };
}

export function makeEnvelope(): EnvelopeRow[] {
  return [
    row({ id: 'e1', kind: 'window', label: 'Fenêtre 1,20 × 1,35 m – Nord (RDC)', elementName: 'Fenêtre PVC', windowTypeId: 'w1', count: 2, length: 1.2, width: 1.35, orientation: 'N', deduct: true }),
    row({ id: 'e2', kind: 'wall', label: 'Mur extérieur – Nord (RDC)', elementName: 'Mur extérieur', constructionId: 'c-wall', count: 1, length: 10, width: 2.8, orientation: 'N', netArea: 24.76 }),
    row({ id: 'e3', kind: 'wall', label: 'Mur extérieur – Est (RDC)', elementName: 'Mur extérieur', constructionId: 'c-wall', count: 1, length: 8, width: 2.8, orientation: 'E' }),
    row({ id: 'e4', kind: 'wall', label: 'Mur extérieur – Sud (RDC)', elementName: 'Mur extérieur', constructionId: 'c-wall', count: 1, length: 10, width: 2.8, orientation: 'S' }),
    row({ id: 'e5', kind: 'roof', label: 'Toiture plate (RDC)', elementName: 'Toiture plate', constructionId: 'c-roof', count: 1, length: 10, width: 8, orientation: 'H', from: 'default' }),
    row({ id: 'e6', kind: 'floor', label: 'Dalle sur terre-plein (RDC)', elementName: 'Dalle sur terre-plein', constructionId: 'c-floor', count: 1, length: 10, width: 8, orientation: 'H', boundary: 'ground', from: 'user' }),
  ];
}

export function makeSheets(): LuxeebSheets {
  return {
    envelope: makeEnvelope(),
    zones: [{ id: 'z0', label: 'Zone chauffée – Rez-de-chaussée', area: 68.4, clearHeight: 2.5, airVolume: 171, from: 'estimate', storeyId: 's0' }],
    volumes: [{ id: 'v0', label: 'Rez-de-chaussée', area: 80, height: 2.8, volume: 224, from: 'plan', storeyId: 's0' }],
    constructions: [
      { constructionId: 'c-wall', name: 'Mur extérieur', category: 'wall', boundary: 'outside', area: 75.16, u: { value: 0.35, from: 'default' } },
      { constructionId: 'c-roof', name: 'Toiture plate', category: 'roof', boundary: 'outside', area: 80, u: null },
      {
        constructionId: 'c-floor',
        name: 'Dalle sur terre-plein',
        category: 'floor',
        boundary: 'ground',
        area: 80,
        u: { value: 0.406, from: 'estimate', note: 'Typologie 1970-1980' },
        ground: { slabArea: 80, perimeter: 28 },
      },
    ],
    windows: [
      { windowTypeId: 'w1', name: 'Fenêtre PVC', area: 3.24, count: 2, typicalWidth: 1.2, typicalHeight: 1.35, uw: { value: 1.3, from: 'user' }, g: { value: 0.6, from: 'default' } },
    ],
    totals: {
      an: 68.4,
      vn: 171,
      ve: 224,
      envelopeArea: 238.4,
      aOverVe: 1.0643,
      grossFloorArea: 80,
      windowArea: 3.24,
      facadeArea: 78.4,
      anFrom: 'estimate',
      veFrom: 'plan',
    },
    findings: [],
  };
}

/** Bloc d'enveloppe attendu pour `makeEnvelope()` — écrit caractère par caractère, sans passer par le code testé. */
export const ENVELOPE_BLOCK =
  '2,00\t1,20\t1,35\tNord\r\n' +
  '1,00\t10,00\t2,80\tNord\r\n' +
  '1,00\t8,00\t2,80\tOst\r\n' +
  '1,00\t10,00\t2,80\tSüd\r\n' +
  '1,00\t10,00\t8,00\tHorizontal\r\n' +
  '1,00\t10,00\t8,00\tHorizontal';

export const ZONES_BLOCK = 'Zone chauffée – Rez-de-chaussée\t1,00\t1,00\t68,40';
export const VOLUMES_BLOCK = 'Rez-de-chaussée\t1,00\t1,00\t80,00\t2,80';
