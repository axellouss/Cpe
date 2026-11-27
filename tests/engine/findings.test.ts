/**
 * Contrôles de plausibilité : chaque code est déclenché au moins une fois, avec sa gravité,
 * et son texte existe en français ET en allemand, toutes variables remplies.
 */
import { describe, expect, it } from 'vitest';
import type { ManualRow, Project, Severity, TopClosure, Vec2 } from '../../src/core/types';
import { FINDING_CODES, deriveSheets, findingText, type FindingCode } from '../../src/engine';
import { ENGINE_MESSAGES } from '../../src/engine/messages';
import { knownKeys, t } from '../../src/i18n';
import { EAST, NORTH, SOUTH, codes, finding, project, rect, room, storey, windowAt } from './helpers';

/** Boîte 10 × 8 × 2,80 m entièrement confirmée, 4 fenêtres (14,8 m² pour 100,8 m² de façade) : aucun contrôle sauf les valeurs U. */
function sound(patch: Parameters<typeof storey>[3] = {}, outline: Vec2[] = rect(10, 8)): Project {
  return project([
    storey('rdc', 'RDC', outline, { netArea: 64, openings: [windowAt(NORTH, 2, 1.5, 2), windowAt(SOUTH, 2, 2.2, 2)], ...patch }),
  ]);
}

const pitchedTop = (patch: Partial<TopClosure> = {}): TopClosure => ({
  kind: 'pitched-roof',
  pitchDeg: 35,
  shape: 'gable',
  ridgeAngle: null,
  kneeWallHeight: 1,
  constructionId: null,
  from: 'user',
  ...patch,
});

const manual = (patch: Partial<ManualRow>): ManualRow => ({
  id: 'm1',
  label: 'Ligne manuelle',
  constructionId: null,
  windowTypeId: null,
  count: 1,
  length: 2,
  width: 1,
  orientation: 'S',
  boundary: 'outside',
  deduct: false,
  ...patch,
});

const L_SHAPE: Vec2[] = [
  { x: 0, y: 0 },
  { x: 12, y: 0 },
  { x: 12, y: 6 },
  { x: 6, y: 6 },
  { x: 6, y: 10 },
  { x: 0, y: 10 },
];

/** Polygone régulier à n côtés de rayon r (m). */
function polygon(n: number, r: number): Vec2[] {
  return Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((2 * Math.PI * i) / n), y: r * Math.sin((2 * Math.PI * i) / n) }));
}

interface Scenario {
  severity: Severity;
  /** Ce que l'expert a fait (ou pas fait) pour déclencher le contrôle. */
  why: string;
  build: () => Project;
  /** Variables attendues (sous-ensemble). */
  params?: Record<string, string | number>;
}

const SCENARIOS: Record<FindingCode, Scenario> = {
  'model.noStorey': { severity: 'block', why: 'aucun étage tracé', build: () => project([]) },
  'storey.outlineInvalid': {
    severity: 'block',
    why: 'contour de 1,5 × 2 m = 3 m² (< 4 m²)',
    build: () => sound({ openings: [], netArea: 2 }, rect(1.5, 2)),
    params: { storey: 'RDC', storeyId: 'rdc', area: '3,00' },
  },
  'scale.unconfirmed': {
    severity: 'block',
    why: "échelle seulement estimée (plan sans échelle lisible)",
    build: () => sound({ scale: { value: 1, from: 'estimate' } }),
    params: { storey: 'RDC' },
  },
  'height.default': {
    severity: 'warn',
    why: "hauteur d'étage laissée à la valeur par défaut",
    build: () => sound({ heightFrom: 'default' }),
    params: { storey: 'RDC', height: '2,80' },
  },
  'clearHeight.default': {
    severity: 'warn',
    why: 'hauteur libre laissée à la valeur par défaut',
    build: () => sound({ heightFrom: 'default' }),
    params: { storey: 'RDC', height: '2,50' },
  },
  'height.implausible': {
    severity: 'warn',
    why: "hauteur d'étage de 5,20 m (hors 2,20 – 4,50 m)",
    build: () => sound({ grossHeight: 5.2 }),
    params: { height: '5,20' },
  },
  'clearHeight.aboveGross': {
    severity: 'block',
    why: 'hauteur libre 2,60 m > hauteur brute 2,40 m',
    build: () => sound({ grossHeight: 2.4, clearHeight: 2.6 }),
    params: { clear: '2,60', gross: '2,40' },
  },
  'an.estimated': {
    severity: 'block',
    why: 'ni pièces ni surface nette : An estimé à 80 % de 80 m²',
    build: () => sound({ netArea: undefined }),
    params: { storey: 'RDC', area: '64,00' },
  },
  'an.grossLike': {
    severity: 'warn',
    why: 'An = 76 m² pour 80 m² bruts = 95 % (> 92 %) : surfaces prises en dimensions brutes',
    build: () => sound({ netArea: 76 }),
    params: { ratio: '95', an: '76,00', gross: '80,00' },
  },
  'an.low': {
    severity: 'warn',
    why: 'An = 40 m² pour 80 m² bruts = 50 % (< 55 %)',
    build: () => sound({ netArea: 40 }),
    params: { ratio: '50', an: '40,00', gross: '80,00' },
  },
  'rooms.needReview': {
    severity: 'warn',
    why: 'une cave et une buanderie pas encore tranchées',
    build: () =>
      sound({ netArea: undefined, rooms: [room('Séjour', 50), room('Cave', 12, false, true), room('Buanderie', 6, false, true)] }),
    params: { count: 2 },
  },
  'outline.containsUnheated': {
    severity: 'warn',
    why: 'garage tranché « non compté dans An » mais resté à l’intérieur du contour chauffé',
    build: () =>
      sound({
        netArea: undefined,
        rooms: [
          room('Séjour', 50),
          { ...room('Garage', 14, false, false), polygon: [{ x: 6, y: 4 }, { x: 9.6, y: 4 }, { x: 9.6, y: 7.6 }, { x: 6, y: 7.6 }] },
          // sans polygone, impossible de dire où il est : pas de constat pour lui
          room('Abri', 5, false, false),
        ],
      }),
    params: { storey: 'RDC', storeyId: 'rdc', rooms: '« Garage »', count: 1 },
  },
  'outline.unconditionedInside': {
    severity: 'info',
    why: 'chaufferie non comptée dans An, à l’intérieur du contour : correct si elle est dans l’enveloppe isolée',
    build: () =>
      sound({
        netArea: undefined,
        rooms: [
          room('Séjour', 50),
          { ...room('Chaufferie', 6, false, false), polygon: [{ x: 6, y: 4 }, { x: 9.6, y: 4 }, { x: 9.6, y: 7.6 }, { x: 6, y: 7.6 }] },
          // connue par sa seule étiquette (polygone non fermé sur le plan) : signalée aussi
          { ...room('Local technique', 4, false, false), at: { x: 2, y: 2 } },
        ],
      }),
    params: { storey: 'RDC', storeyId: 'rdc', rooms: '« Chaufferie », « Local technique »', count: 2 },
  },
  'north.default': {
    severity: 'warn',
    why: 'boussole jamais tournée',
    build: () => {
      const p = sound();
      p.model.northAngle = { value: 0, from: 'default' };
      return p;
    },
    params: { angle: '0' },
  },
  'orientation.borderline': {
    severity: 'info',
    why: 'façades à 2,5° de la limite de secteur',
    build: () => {
      const p = sound();
      p.model.northAngle = { value: 20, from: 'user' };
      return p;
    },
    params: { azimuth: '20', orientation: 'Nord', other: 'Nord-Est' },
  },
  'windows.none': { severity: 'warn', why: 'aucune fenêtre', build: () => sound({ openings: [] }) },
  'windows.exceedWall': {
    severity: 'block',
    why: '3 baies de 4 × 2,50 m (30 m²) sur un mur est de 8 × 2,80 m (22,4 m²)',
    build: () => sound({ openings: [windowAt(EAST, 4, 2.5, 3)] }),
    params: { wall: 'Mur extérieur – Est (RDC)', wallArea: '22,40', openingArea: '30,00' },
  },
  'windows.share': {
    severity: 'warn',
    why: 'une seule fenêtre de 1 m² pour 100,8 m² de façade (1 %)',
    build: () => sound({ openings: [windowAt(NORTH, 1, 1)] }),
    params: { share: '1', windowArea: '1,00', facadeArea: '100,80' },
  },
  'opening.onHeatedWall': {
    severity: 'warn',
    why: 'fenêtre posée sur le mur mitoyen chauffé',
    build: () => sound({ boundaries: { [EAST]: 'heated' }, openings: [windowAt(EAST, 1, 1, 2), windowAt(NORTH, 2, 1.5, 3)] }),
    params: { storey: 'RDC', count: 2 },
  },
  'opening.orphan': {
    severity: 'warn',
    why: "ouverture rattachée à l'arête n° 7 d'un contour qui n'en a que 4",
    build: () => sound({ openings: [windowAt(7, 1, 1), windowAt(NORTH, 2, 1.5, 3)] }),
    params: { storey: 'RDC', count: 1 },
  },
  'opening.inRoof': {
    severity: 'info',
    why: 'fenêtre posée côté égout sous une toiture sans jambette',
    build: () => {
      const p = sound({ openings: [windowAt(NORTH, 0.78, 1.18, 2)] });
      p.model.top = pitchedTop({ kneeWallHeight: 0 });
      return p;
    },
    params: { storey: 'RDC', count: 2 },
  },
  'neighbours.heatedExcluded': {
    severity: 'info',
    why: 'mur est (8 m) mitoyen avec un voisin chauffé',
    build: () => sound({ boundaries: { [EAST]: 'heated' } }),
    params: { length: '8,00' },
  },
  'top.default': {
    severity: 'warn',
    why: 'type de toiture jamais choisi',
    build: () => {
      const p = sound();
      p.model.top = { ...p.model.top, kind: 'attic-ceiling', from: 'default' };
      return p;
    },
    params: { kind: 'plancher haut vers grenier non chauffé' },
  },
  'bottom.default': {
    severity: 'warn',
    why: 'fermeture basse jamais choisie',
    build: () => {
      const p = sound();
      p.model.bottom = { ...p.model.bottom, from: 'default' };
      return p;
    },
    params: { kind: 'dalle sur terre-plein' },
  },
  'aOverVe.implausible': {
    severity: 'warn',
    why: 'cabanon de 3 × 3 × 2,80 m : A = 33,6 + 9 + 9 = 51,6 m², Ve = 25,2 m³ → A/Ve = 2,05',
    build: () => sound({ openings: [windowAt(NORTH, 1, 1)], netArea: 7 }, rect(3, 3)),
    params: { value: '2,05' },
  },
  'roof.estimated': {
    severity: 'warn',
    why: 'toiture à deux pans sur un contour en L',
    build: () => {
      const p = sound({ netArea: 70 }, L_SHAPE);
      p.model.top = pitchedTop();
      return p;
    },
    params: { storey: 'RDC' },
  },
  'roof.monoDirection': {
    severity: 'warn',
    why: 'toit monopente : le plan ne dit pas de quel côté il descend',
    build: () => {
      const p = sound();
      p.model.top = pitchedTop({ shape: 'mono', pitchDeg: 8, kneeWallHeight: 2.5 });
      return p;
    },
    params: { orientation: 'Sud' },
  },
  'roof.ridgeAssumed': {
    severity: 'warn',
    why: 'toit à deux pans : le plan ne dit pas dans quel sens court le faîtage',
    build: () => {
      const p = sound();
      p.model.top = pitchedTop();
      return p;
    },
    // Contour 10 × 8 m, nord en haut : faîtage supposé le long des 10 m, pans vers le nord et le sud.
    params: { a: 'Nord', b: 'Sud' },
  },
  'roof.pitchImplausible': {
    severity: 'warn',
    why: 'pente de 80° saisie',
    build: () => {
      const p = sound();
      p.model.top = pitchedTop({ pitchDeg: 80 });
      return p;
    },
    params: { pitch: '80' },
  },
  'attic.heightRule': {
    severity: 'info',
    why: 'combles chauffés sous rampants',
    build: () => {
      const p = sound();
      p.model.top = pitchedTop();
      return p;
    },
    params: { storey: 'RDC' },
  },
  'stepback.byAreas': {
    severity: 'info',
    why: 'étage de 60 m² sur un RDC de 80 m², feuilles non superposables',
    build: () => {
      const p = sound();
      p.model.storeys.push(storey('etage', 'Étage', rect(10, 6), { netArea: 48 }));
      return p;
    },
    params: { lower: 'RDC', upper: 'Étage', area: '20,00' },
  },
  'manual.heatedIgnored': {
    severity: 'info',
    why: 'ligne manuelle contre un local chauffé',
    build: () => {
      const p = sound();
      p.model.manualRows = [manual({ boundary: 'heated' })];
      return p;
    },
    params: { count: 1 },
  },
  'abzug.dangling': {
    severity: 'warn',
    why: 'ligne manuelle « à déduire » placée en dernier',
    build: () => {
      const p = sound();
      p.model.manualRows = [manual({ deduct: true })];
      return p;
    },
    params: { count: 1 },
  },
  'constructions.overLimit': {
    severity: 'warn',
    why: '21 types de murs différents + toiture + dalle = 23 types pour 20 emplacements',
    build: () => {
      const outline = polygon(21, 6);
      const p = sound({ openings: [] }, outline);
      p.model.constructions = [
        ...p.model.constructions,
        ...outline.map((_, i) => ({ id: `mur-${i}`, name: `Mur type ${i + 1}`, category: 'wall' as const, u: null })),
      ];
      p.model.storeys[0]!.edges = outline.map((_, i) => ({ boundary: 'outside' as const, constructionId: `mur-${i}` }));
      return p;
    },
    params: { count: 23, limit: 20 },
  },
  'uvalues.missing': {
    severity: 'info',
    why: 'valeurs U non renseignées (cas normal : elles se définissent dans LuxEeB-Tool)',
    build: () => sound(),
    params: { count: 4 }, // mur extérieur, toiture, dalle, type de fenêtre
  },
};

describe('chaque contrôle de plausibilité', () => {
  it('le cas de référence ne déclenche que « uvalues.missing »', () => {
    expect(codes(deriveSheets(sound(), 'fr'))).toEqual(['uvalues.missing']);
  });

  it('plus aucun contrôle quand les valeurs U sont renseignées', () => {
    const p = sound();
    p.model.constructions = p.model.constructions.map((c) => ({ ...c, u: { value: 0.3, from: 'user' } }));
    p.model.windowTypes = p.model.windowTypes.map((w) => ({ ...w, uw: { value: 1.1, from: 'user' }, g: { value: 0.6, from: 'user' } }));
    const d = deriveSheets(p, 'fr');
    expect(d.findings).toEqual([]);
    // Les valeurs U saisies sont reprises telles quelles dans le récapitulatif, jamais inventées
    expect(d.constructions.every((c) => c.u?.value === 0.3 && c.u.from === 'user')).toBe(true);
    expect(d.windows[0]).toMatchObject({ uw: { value: 1.1, from: 'user' }, g: { value: 0.6, from: 'user' } });
  });

  it.each(FINDING_CODES.map((code) => [code, SCENARIOS[code]] as const))('%s', (code, scenario) => {
    for (const lang of ['fr', 'de'] as const) {
      const sheets = deriveSheets(scenario.build(), lang);
      const found = finding(sheets, code);
      expect(found, `« ${code} » attendu quand : ${scenario.why}`).toBeDefined();
      expect(found!.severity).toBe(scenario.severity);
      if (lang === 'fr' && scenario.params) expect(found!.params).toMatchObject(scenario.params);

      const text = t(lang, `finding.${code}`, found!.params);
      expect(text).not.toBe(`finding.${code}`); // la clé existe
      expect(text).not.toMatch(/[{}]/); // toutes les variables sont remplies
      expect(text.length).toBeGreaterThan(20);
    }
    // Le texte allemand n'est pas un simple repli sur le français
    expect(ENGINE_MESSAGES.de[`finding.${code}`]).not.toBe(ENGINE_MESSAGES.fr[`finding.${code}`]);
  });

  it('le tableau de scénarios couvre tous les codes, et le moteur n’en émet aucun autre', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...FINDING_CODES].sort());
    const emitted = new Set<string>();
    for (const code of FINDING_CODES) for (const c of codes(deriveSheets(SCENARIOS[code].build(), 'fr'))) emitted.add(c);
    expect([...emitted].sort()).toEqual([...FINDING_CODES].sort());
  });
});

describe('détails de quelques contrôles', () => {
  it('contour inutilisable : moins de 3 points, ou lignes qui se croisent', () => {
    expect(codes(deriveSheets(sound({ openings: [] }, [{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'fr'))).toContain('storey.outlineInvalid');
    const bowtie: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 8 },
      { x: 10, y: 0 },
      { x: 0, y: 8 },
    ];
    expect(finding(deriveSheets(sound({ openings: [] }, bowtie), 'fr'), 'storey.outlineInvalid')!.severity).toBe('block');
    // Un étage sans contour ne produit aucune paroi, mais garde sa ligne de zone et de volume
    const empty = deriveSheets(sound({ openings: [] }, []), 'fr');
    expect(empty.envelope).toEqual([]);
    expect(empty.zones).toHaveLength(1);
    expect(empty.volumes[0]).toMatchObject({ area: 0, volume: 0 });
  });

  it("échelle par défaut ou estimée : bloquant, et toute la géométrie de l'étage devient « estimation »", () => {
    const d = deriveSheets(sound({ scale: { value: 1, from: 'estimate' } }), 'fr');
    expect(finding(d, 'scale.unconfirmed')!.severity).toBe('block');
    expect(d.envelope.filter((r) => !r.deduct).every((r) => r.from === 'estimate')).toBe(true);
    expect(d.totals.veFrom).toBe('estimate');
    expect(codes(deriveSheets(sound({ scale: { value: 1, from: 'default' } }), 'fr'))).toContain('scale.unconfirmed');
    expect(codes(deriveSheets(sound({ scale: { value: 0.01, from: 'plan' } }, rect(1000, 800)), 'fr'))).not.toContain('scale.unconfirmed');
  });

  it("hauteur d'étage trop faible aussi", () => {
    expect(finding(deriveSheets(sound({ grossHeight: 2.0, clearHeight: 1.9 }), 'fr'), 'height.implausible')!.params.height).toBe('2,00');
    expect(codes(deriveSheets(sound({ grossHeight: 2.2, clearHeight: 2.0 }), 'fr'))).not.toContain('height.implausible');
    expect(codes(deriveSheets(sound({ grossHeight: 4.5 }), 'fr'))).not.toContain('height.implausible');
  });

  it('An : la somme des pièces chauffées remplace l’estimation ; une surface saisie remplace les pièces', () => {
    const rooms = [room('Séjour', 40), room('Cuisine', 15), room('Garage', 18, false)];
    const withRooms = deriveSheets(sound({ netArea: undefined, rooms }), 'fr');
    expect(withRooms.totals).toMatchObject({ an: 55, anFrom: 'plan' });
    expect(codes(withRooms)).not.toContain('an.estimated');
    const overridden = deriveSheets(sound({ netArea: 58, rooms: [...rooms, room('Cave', 9, false, true)] }), 'fr');
    expect(overridden.totals).toMatchObject({ an: 58, anFrom: 'user' });
    // Les pièces ne servent plus : inutile de demander de les trancher
    expect(codes(overridden)).not.toContain('rooms.needReview');
  });

  it('An proche du brut : seuil à 92 %', () => {
    expect(codes(deriveSheets(sound({ netArea: 73.6 }), 'fr'))).not.toContain('an.grossLike'); // 92,0 %
    expect(codes(deriveSheets(sound({ netArea: 74 }), 'fr'))).toContain('an.grossLike'); // 92,5 %
    expect(codes(deriveSheets(sound({ netArea: 44 }), 'fr'))).not.toContain('an.low'); // 55,0 %
    expect(codes(deriveSheets(sound({ netArea: 43 }), 'fr'))).toContain('an.low'); // 53,8 %
  });

  it('part de fenêtres : trop (> 45 %) comme trop peu (< 5 %)', () => {
    // 2 × (8 × 2,5) = 40 m² au nord et au sud + 15 m² à l'est = 55 m² pour 100,8 m² de façade = 55 %
    const glassy = deriveSheets(sound({ openings: [windowAt(NORTH, 8, 2.5), windowAt(SOUTH, 8, 2.5), windowAt(EAST, 6, 2.5)] }), 'fr');
    expect(finding(glassy, 'windows.share')!.params).toEqual({ share: '55', windowArea: '55,00', facadeArea: '100,80' });
    // Sans aucune fenêtre : un seul message (« aucune fenêtre »), pas deux
    const none = codes(deriveSheets(sound({ openings: [] }), 'fr'));
    expect(none).toContain('windows.none');
    expect(none).not.toContain('windows.share');
  });

  it('fermetures haute et basse confirmées : plus de message', () => {
    const p = SCENARIOS['top.default'].build();
    p.model.top.from = 'user';
    expect(codes(deriveSheets(p, 'fr'))).not.toContain('top.default');
    expect(finding(deriveSheets(SCENARIOS['top.default'].build(), 'de'), 'top.default')!.params.kind).toBe(
      'oberste Geschossdecke zum unbeheizten Dachboden',
    );
  });

  it('A/Ve : une maison ordinaire est dans la plage, un grand volume compact mitoyen des deux côtés en sort', () => {
    // 20 × 20 × 2,80 m sur 5 niveaux, mitoyen à l'est et à l'ouest :
    // A = 2 façades × 20 × 14 + toiture 400 + dalle 400 = 1360 m² ; Ve = 400 × 14 = 5600 m³ → A/Ve = 0,24
    const levels = Array.from({ length: 5 }, (_, i) =>
      storey(`n${i}`, `Niveau ${i}`, rect(20, 20), {
        netArea: 320,
        boundaries: { [EAST]: 'heated', 3: 'heated' },
        openings: [windowAt(NORTH, 2, 1.5, 4)],
      }),
    );
    const d = deriveSheets(project(levels), 'fr');
    expect(d.totals).toMatchObject({ envelopeArea: 1360, ve: 5600, aOverVe: 0.243 });
    expect(finding(d, 'aOverVe.implausible')!.params.value).toBe('0,24');
  });

  it('20 types opaques exactement : pas encore de dépassement', () => {
    const p = SCENARIOS['constructions.overLimit'].build();
    // On ramène 3 arêtes au type par défaut « Mur extérieur » : 18 types de murs + mur extérieur + toiture + dalle = 21 → encore trop
    const edges = p.model.storeys[0]!.edges;
    for (const i of [0, 1, 2]) edges[i] = { boundary: 'outside', constructionId: null };
    expect(finding(deriveSheets(p, 'fr'), 'constructions.overLimit')!.params.count).toBe(21);
    edges[3] = { boundary: 'outside', constructionId: null };
    const d = deriveSheets(p, 'fr');
    expect(d.constructions).toHaveLength(20);
    expect(codes(d)).not.toContain('constructions.overLimit');
  });
});

describe('dictionnaires FR / DE du moteur', () => {
  it('tous les codes ont un texte enregistré dans les deux langues', () => {
    for (const lang of ['fr', 'de'] as const) {
      const keys = new Set(knownKeys(lang));
      for (const code of FINDING_CODES) expect(keys.has(`finding.${code}`), `${lang} : finding.${code}`).toBe(true);
    }
  });

  it('findingText donne la phrase complète, nombres à la française', () => {
    const d = deriveSheets(SCENARIOS['windows.exceedWall'].build(), 'fr');
    expect(findingText(finding(d, 'windows.exceedWall')!, 'fr')).toBe(
      'Mur extérieur – Est (RDC) : les ouvertures (30,00 m²) dépassent la surface de la paroi (22,40 m²). Corrigez leurs dimensions ou la façade qui les porte.',
    );
    const g = deriveSheets(SCENARIOS['neighbours.heatedExcluded'].build(), 'de');
    expect(findingText(finding(g, 'neighbours.heatedExcluded')!, 'de')).toBe(
      '8,00 m Wände zu beheizten Nachbarn: nicht Teil der Hülle, keine Zeile in der Tabelle.',
    );
  });

  it('les deux langues ont les mêmes clés et les mêmes variables', () => {
    expect(Object.keys(ENGINE_MESSAGES.de).sort()).toEqual(Object.keys(ENGINE_MESSAGES.fr).sort());
    const variables = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(ENGINE_MESSAGES.fr)) {
      expect(variables(ENGINE_MESSAGES.de[key]!), key).toEqual(variables(ENGINE_MESSAGES.fr[key]!));
    }
  });
});
