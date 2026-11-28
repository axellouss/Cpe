/**
 * Réponses aux questions de doute (applyDoubtAnswer) : pour CHAQUE question du catalogue, chaque choix proposé, la
 * saisie libre quand la question en attend une, et « je ne sais pas ». Après la réponse la question ne revient plus ;
 * les valeurs touchées portent la provenance 'user' (ou hypothèse pour « je ne sais pas ») ; l'effet annoncé est
 * celui obtenu. Documents tirés de la vérité des planches synthétiques (données inventées).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Lang, PlanDocument, Project } from '../../src/core/types';
import {
  applyDoubtAnswer,
  buildAutoProject,
  collectDoubts,
  createEmptyProject,
  deriveSheets,
  DOUBT_CATALOG,
  DOUBT_CONFIRM,
  DOUBT_UNKNOWN,
  type Doubt,
  type DoubtId,
} from '../../src/engine';
import { documentFromTruth, readPlancheTruth, type DocOptions, type PlancheName, type Truth } from './auto-planche';
import { deepFreeze } from './helpers';

interface Scenario {
  doc: PlanDocument;
  project: Project;
  lang: Lang;
}

const truths = new Map<PlancheName, Truth>();
beforeAll(async () => {
  for (const name of ['planche_A1_archicad', 'planche_A2_de_titres_dessus', 'planche_2pages', 'planche_sans_titres'] as const) truths.set(name, await readPlancheTruth(name));
});

function scenario(name: PlancheName, options: DocOptions = {}, patch?: (doc: PlanDocument) => void): Scenario {
  const lang: Lang = name.includes('A2') ? 'de' : 'fr';
  const doc = documentFromTruth(truths.get(name)!, options);
  patch?.(doc);
  return { doc, project: buildAutoProject(doc, createEmptyProject(lang), lang).project, lang };
}

const doubtsOf = (s: Scenario, project: Project = s.project): Doubt[] => collectDoubts(s.doc.reading, project, s.doc.sheets, s.lang);
const ask = (s: Scenario, id: DoubtId): Doubt => {
  const d = doubtsOf(s).find((x) => x.id === id);
  if (!d) throw new Error(`question ${id} absente`);
  return d;
};

/** Situation où chaque question est posée, et saisies libres qu'elle accepte. */
const SCENARIOS: Record<DoubtId, { make: () => Scenario; free?: string[] }> = {
  'an-unlabelled': { make: () => scenario('planche_A1_archicad'), free: ['7,5'] },
  materials: { make: () => scenario('planche_A1_archicad') },
  windows: { make: () => scenario('planche_A1_archicad') },
  ventilation: { make: () => scenario('planche_A1_archicad') },
  heating: { make: () => scenario('planche_A1_archicad') },
  'thermal-bridges': { make: () => scenario('planche_A1_archicad') },
  occasion: { make: () => scenario('planche_sans_titres') },
  attached: { make: () => scenario('planche_2pages') },
  scale: {
    make: () =>
      scenario('planche_A1_archicad', { guessedScale: true }, (doc) => {
        for (const s of doc.sheets) {
          delete s.detected.footprintSize;
          for (const r of s.detected.rooms) delete r.measuredArea;
        }
      }),
    free: ['1:100', '50'],
  },
  top: { make: () => scenario('planche_sans_titres') },
  bottom: { make: () => scenario('planche_sans_titres') },
  'unheated-zone': {
    // Le nom « Garage » est lu, mais pas le trait d'isolant entre le garage et le logement.
    make: () =>
      scenario('planche_A1_archicad', {}, (doc) => {
        for (const s of doc.sheets) for (const e of s.detected.heatedEdges ?? []) if (e.boundary === 'unheated') e.sources = ['room-name'];
      }),
  },
  openings: {
    make: () =>
      scenario('planche_sans_titres', { noElevations: true }, (doc) => {
        for (const s of doc.sheets) s.detected.openings = [];
        doc.reading!.openingPairs = [];
      }),
  },
  'building-type': { make: () => scenario('planche_A1_archicad', { noTitleBlock: true }) },
  heights: { make: () => scenario('planche_sans_titres'), free: ['2,9', '2,9; 3,1'] },
  'room-heated': {
    // Le garage n'est pas reconnu comme non chauffé par son nom : à trancher (hors du contour isolé).
    make: () =>
      scenario('planche_A1_archicad', {}, (doc) => {
        for (const s of doc.sheets) for (const r of s.detected.rooms) if (r.name === 'Garage') r.heatedGuess = 'ask';
      }),
  },
  'opening-heights': {
    make: () =>
      scenario('planche_2pages', {}, (doc) => {
        for (const s of doc.sheets) {
          for (const o of s.detected.openings) {
            if (o.kind !== 'window') continue;
            delete o.height;
            o.heightFrom = 'default';
          }
        }
      }),
    free: ['1,35'],
  },
  renewables: { make: () => scenario('planche_2pages') },
  north: { make: () => scenario('planche_A1_archicad', { noNorth: true }), free: ['45', '112,5'] },
  year: { make: () => scenario('planche_A1_archicad', { noTitleBlock: true }), free: ['2025'] },
  identity: { make: () => scenario('planche_A1_archicad', { noTitleBlock: true }), free: ['7, rue des Essais, L-0000 Exempleville', 'Lot 7'] },
};

describe('chaque question du catalogue : chaque réponse la fait disparaître', () => {
  it('le catalogue est couvert en entier', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(DOUBT_CATALOG.map((d) => d.id).sort());
  });

  describe.each(DOUBT_CATALOG.map((d) => d.id))('%s', (id) => {
    it('est posée dans sa situation', () => {
      expect(doubtsOf(SCENARIOS[id].make()).map((d) => d.id)).toContain(id);
    });

    it('choix, confirmation, saisie libre et « je ne sais pas » : question tranchée, projet de départ intact', () => {
      const s = SCENARIOS[id].make();
      const d = ask(s, id);
      const before = JSON.stringify(s.project);
      deepFreeze(s.project);
      // « Confirmer » n'a de sens que s'il y a une proposition, ou une valeur déjà dans le projet (hauteurs, nord…).
      const nothingToConfirm = !d.proposal && (id === 'year' || id === 'identity');
      const values = [...d.options.map((o) => o.value), ...(SCENARIOS[id].free ?? []), DOUBT_UNKNOWN, ...((d.proposal || d.options.length === 0) && !nothingToConfirm ? [DOUBT_CONFIRM] : [])];
      if (nothingToConfirm) expect(applyDoubtAnswer(s.project, d, DOUBT_CONFIRM, s.lang)).toBe(s.project);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        const next = applyDoubtAnswer(s.project, d, v, s.lang);
        expect(next, `${id}=${v}`).not.toBe(s.project);
        expect(doubtsOf(s, next).map((x) => x.id), `${id}=${v}`).not.toContain(id);
        expect(next.answers.resolvedDoubts?.[id], `${id}=${v}`).toBe(v === DOUBT_UNKNOWN ? 'unknown' : 'user');
        expect(() => deriveSheets(next, s.lang)).not.toThrow();
      }
      expect(JSON.stringify(s.project)).toBe(before);
    });

    it('« je ne sais pas » ne fabrique aucune valeur « utilisateur »', () => {
      const s = SCENARIOS[id].make();
      const next = applyDoubtAnswer(s.project, ask(s, id), DOUBT_UNKNOWN, s.lang);
      const users = (p: Project) => (JSON.stringify(p).match(/"from":"user"/g) ?? []).length;
      expect(users(next)).toBe(users(s.project));
    });
  });

  it('une réponse incomprise laisse le projet tel quel, la question reste posée', () => {
    const s = scenario('planche_sans_titres');
    for (const id of ['top', 'bottom', 'heights', 'occasion'] as const) {
      const next = applyDoubtAnswer(s.project, ask(s, id), 'n’importe quoi', s.lang);
      expect(next).toBe(s.project);
    }
    expect(applyDoubtAnswer(s.project, ask(s, 'top'), '   ', s.lang)).toBe(s.project);
  });
});

// ───────────────────────────── Effet annoncé = effet obtenu ─────────────────────────────

describe('effet des réponses', () => {
  const an = (s: Scenario, p: Project) => deriveSheets(p, s.lang).totals.an;

  it('an-unlabelled : compter → An augmente de la surface annoncée ; ne pas compter → inchangé ; saisie → surface saisie', () => {
    const s = scenario('planche_A1_archicad');
    const d = ask(s, 'an-unlabelled');
    const announced = Number(/(\d+,\d)\s*m²/.exec(d.question)![1]!.replace(',', '.'));
    const a0 = an(s, s.project);
    const inc = applyDoubtAnswer(s.project, d, 'include', 'fr');
    expect(an(s, inc) - a0).toBeCloseTo(announced, 1);
    expect(inc.model.storeys.flatMap((st) => st.rooms.filter((r) => r.unlabelled)).every((r) => r.heated && r.area.from === 'user')).toBe(true);
    expect(an(s, applyDoubtAnswer(s.project, d, 'exclude', 'fr'))).toBeCloseTo(a0, 6);
    expect(an(s, applyDoubtAnswer(s.project, d, '7,5', 'fr')) - a0).toBeCloseTo(7.5, 1);
    // « Je ne sais pas » : la proposition (compter) est appliquée, étiquetée hypothèse.
    const unknown = applyDoubtAnswer(s.project, d, DOUBT_UNKNOWN, 'fr');
    expect(an(s, unknown) - a0).toBeCloseTo(announced, 1);
    expect(unknown.model.storeys.flatMap((st) => st.rooms.filter((r) => r.unlabelled)).every((r) => r.area.from === 'default' && r.area.confidence === 0)).toBe(true);
  });

  it('top / bottom : la fermeture choisie, confirmée par l’utilisateur', () => {
    const s = scenario('planche_sans_titres');
    const top = applyDoubtAnswer(s.project, ask(s, 'top'), 'flat', 'fr');
    expect(top.model.top).toMatchObject({ kind: 'flat-roof', from: 'user' });
    expect(deriveSheets(top, 'fr').envelope.some((r) => r.kind === 'roof')).toBe(true);
    expect(applyDoubtAnswer(s.project, ask(s, 'top'), 'pitched', 'fr').model.top.kind).toBe('pitched-roof');
    expect(applyDoubtAnswer(s.project, ask(s, 'top'), 'attic', 'fr').model.top.kind).toBe('attic-ceiling');
    const bottom = applyDoubtAnswer(s.project, ask(s, 'bottom'), 'ground', 'fr');
    expect(bottom.model.bottom).toMatchObject({ kind: 'slab-on-ground', from: 'user' });
    expect(applyDoubtAnswer(s.project, ask(s, 'bottom'), 'basement-unheated', 'fr').model.bottom.kind).toBe('above-unheated');
    expect(applyDoubtAnswer(s.project, ask(s, 'top'), DOUBT_UNKNOWN, 'fr').model.top.from).toBe('default');
  });

  it('bottom « sous-sol chauffé » : le sous-sol lu revient dans le volume chauffé', () => {
    const s = scenario('planche_A2_de_titres_dessus');
    const d: Doubt = { ...ask(scenario('planche_sans_titres'), 'bottom') };
    expect(s.project.model.unheatedStoreys).toHaveLength(1);
    const next = applyDoubtAnswer(s.project, d, 'basement-heated', 'de');
    expect(next.model.storeys).toHaveLength(3);
    expect(next.model.unheatedStoreys).toBeUndefined();
    expect(next.model.storeys[0]!.edges.every((e) => e.boundary === 'ground')).toBe(true);
    expect(deriveSheets(next, 'de').totals.an).toBeGreaterThan(deriveSheets(s.project, 'de').totals.an + 30);
  });

  it('heights : la hauteur saisie, pour tous les étages ou étage par étage', () => {
    const s = scenario('planche_sans_titres');
    const d = ask(s, 'heights');
    const one = applyDoubtAnswer(s.project, d, '2,9', 'fr');
    expect(one.model.storeys.map((st) => st.grossHeight)).toEqual([
      { value: 2.9, from: 'user' },
      { value: 2.9, from: 'user' },
    ]);
    expect(deriveSheets(one, 'fr').totals.ve).toBeCloseTo(80 * 2.9 * 2, 1);
    const two = applyDoubtAnswer(s.project, d, '2,9; 3,1', 'fr');
    expect(two.model.storeys.map((st) => st.grossHeight.value)).toEqual([2.9, 3.1]);
    // Hauteurs par défaut gardées, étiquetées hypothèse.
    const unknown = applyDoubtAnswer(s.project, d, DOUBT_UNKNOWN, 'fr');
    expect(unknown.model.storeys.every((st) => st.grossHeight.from === 'default' && st.grossHeight.confidence === 0)).toBe(true);
  });

  it('unheated-zone « chauffé » : le garage rentre dans l’enveloppe et dans An, plus de plancher sur local non chauffé', () => {
    const s = SCENARIOS['unheated-zone'].make();
    const d = ask(s, 'unheated-zone');
    const a0 = an(s, s.project);
    const next = applyDoubtAnswer(s.project, d, 'heated', 'fr');
    expect(an(s, next) - a0).toBeCloseTo(15.88, 2);
    const rows = deriveSheets(next, 'fr').envelope;
    expect(rows.some((r) => r.boundary === 'unheated')).toBe(false);
    expect(rows.some((r) => r.kind === 'door' && r.length === 2.4)).toBe(true);
    // « Non chauffé » : rien ne change dans le relevé.
    expect(deriveSheets(applyDoubtAnswer(s.project, d, 'unheated', 'fr'), 'fr').envelope).toEqual(deriveSheets(s.project, 'fr').envelope);
  });

  it('room-heated : la pièce ambiguë est comptée ou non', () => {
    const s = SCENARIOS['room-heated'].make();
    const d = ask(s, 'room-heated');
    const a0 = an(s, s.project);
    expect(an(s, applyDoubtAnswer(s.project, d, 'heated', 'fr')) - a0).toBeCloseTo(15.88, 2);
    expect(an(s, applyDoubtAnswer(s.project, d, 'unheated', 'fr'))).toBeCloseTo(a0, 6);
  });

  it('north : nord saisi, orientations recalculées ; confirmation du nord proposé', () => {
    const s = SCENARIOS.north.make();
    const d = ask(s, 'north');
    const next = applyDoubtAnswer(s.project, d, '180', 'fr');
    expect(next.model.northAngle).toMatchObject({ value: 180, from: 'user' });
    const orient = (p: Project) => deriveSheets(p, 'fr').envelope.filter((r) => r.kind === 'wall' && r.boundary === 'outside').map((r) => r.orientation).sort();
    expect(orient(next)).not.toEqual(orient(s.project));
    expect(applyDoubtAnswer(s.project, d, DOUBT_CONFIRM, 'fr').model.northAngle).toMatchObject({ value: s.project.model.northAngle.value, from: 'user' });
  });

  it('scale : échelle saisie, surfaces mesurées qui suivent', () => {
    const s = SCENARIOS.scale.make();
    const d = ask(s, 'scale');
    const next = applyDoubtAnswer(s.project, d, '1:50', 'fr');
    expect(next.model.storeys[0]!.metresPerUnit).toMatchObject({ from: 'user', note: '1:50' });
    expect(next.model.storeys[0]!.metresPerUnit.value).toBeCloseTo((0.0254 / 72) * 50, 9);
    const g0 = deriveSheets(s.project, 'fr').totals.grossFloorArea;
    expect(deriveSheets(next, 'fr').totals.grossFloorArea).toBeCloseTo(g0 / 4, 1);
  });

  it('réponses du questionnaire : la réponse donnée devient celle de l’utilisateur', () => {
    const s = scenario('planche_A1_archicad', { noTitleBlock: true });
    const id1 = applyDoubtAnswer(s.project, ask(s, 'identity'), '7, rue des Essais, L-0000 Exempleville', 'fr');
    expect(id1.answers).toMatchObject({ street: '7, rue des Essais', postcode: 'L-0000', locality: 'Exempleville' });
    expect(id1.answers.proposed?.['street']).toBeUndefined();
    expect(applyDoubtAnswer(s.project, ask(s, 'year'), '2025', 'fr').answers.yearBuilt).toBe(2025);
    const mfh = applyDoubtAnswer(s.project, ask(s, 'building-type'), 'MFH', 'fr').answers;
    expect(mfh.buildingType).toBe('MFH');
    const s2 = scenario('planche_sans_titres');
    const occ = applyDoubtAnswer(s2.project, ask(s2, 'occasion'), 'existing', 'fr').answers;
    expect(occ.occasion).toBe('existing');
    expect(occ.proposed?.['occasion']).toBeUndefined();
    // « Je ne sais pas » : la proposition lue est gardée, étiquetée hypothèse (confiance 0).
    const occU = applyDoubtAnswer(s2.project, ask(s2, 'occasion'), DOUBT_UNKNOWN, 'fr').answers;
    expect(occU.occasion).toBe('new');
    expect(occU.proposed?.['occasion']?.confidence).toBe(0);
  });

  it('installations, ponts thermiques, renouvelables, mitoyenneté', () => {
    const s = scenario('planche_A1_archicad');
    const heat = applyDoubtAnswer(s.project, ask(s, 'heating'), DOUBT_CONFIRM, 'fr').answers;
    expect(heat).toMatchObject({ heatGenerator: 'heat-pump-air', heatEmission: 'floor-heating', emissionTemps: '35/28', hotWater: 'with-heating', hotWaterStorageInside: true });
    expect(heat.proposed?.['heatGenerator']).toBeUndefined();
    const tb = applyDoubtAnswer(s.project, ask(s, 'thermal-bridges'), '0.03', 'fr').answers;
    expect(tb).toMatchObject({ thermalBridges: '0.03', thermalMass: 'heavy' });
    expect(applyDoubtAnswer(s.project, ask(s, 'ventilation'), 'balanced-hr', 'fr').answers.ventilation).toBe('balanced-hr');
    const s2 = scenario('planche_2pages');
    expect(applyDoubtAnswer(s2.project, ask(s2, 'renewables'), 'pv', 'fr').answers).toMatchObject({ photovoltaic: true, solarThermal: false });
    expect(applyDoubtAnswer(s2.project, ask(s2, 'attached'), 'one-side', 'fr').answers.attachment).toBe('one-side');
  });

  it('matériaux et menuiseries confirmés : λ et valeurs des fenêtres passent à l’utilisateur, U recalculé', () => {
    const s = scenario('planche_A1_archicad');
    const mat = applyDoubtAnswer(s.project, ask(s, 'materials'), DOUBT_CONFIRM, 'fr');
    const wall = mat.model.constructions.find((c) => c.id === 'wall-outside')!;
    expect(wall.layers!.every((l) => !l.lambda || l.lambda.from === 'user')).toBe(true);
    expect(wall.u?.value).toBeGreaterThan(0);
    const win = applyDoubtAnswer(s.project, ask(s, 'windows'), DOUBT_CONFIRM, 'fr');
    expect(win.model.windowTypes.every((w) => w.g === null || w.g.from === 'user')).toBe(true);
    expect(win.model.constructions.filter((c) => c.category === 'door').every((c) => c.u?.from === 'user')).toBe(true);
  });

  it('opening-heights : la hauteur saisie remplace les hauteurs d’usage seulement', () => {
    const s = SCENARIOS['opening-heights'].make();
    const next = applyDoubtAnswer(s.project, ask(s, 'opening-heights'), '1,35', 'fr');
    const windows = next.model.storeys.flatMap((st) => st.openings.filter((o) => o.kind === 'window'));
    expect(windows.every((o) => o.height === 1.35 && o.from === 'user')).toBe(true);
    // La porte d'entrée, de hauteur lue, ne bouge pas.
    expect(next.model.storeys.flatMap((st) => st.openings.filter((o) => o.kind === 'door')).every((o) => o.height === 2.2)).toBe(true);
  });
});
