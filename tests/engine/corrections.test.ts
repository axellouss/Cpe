/**
 * Défauts relevés par la vérification indépendante du moteur et par l'essai de bout en bout : chaque test aurait
 * attrapé son défaut. Planches synthétiques uniquement (données inventées).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlanDocument, Project } from '../../src/core/types';
import { applyDoubtAnswer, buildAutoProject, collectDoubts, createEmptyProject, deriveSheets, DOUBT_CONFIRM, DOUBT_UNKNOWN, isPlanDoubt, MAX_AUTO_DOUBTS } from '../../src/engine';
import type { OpeningHeights } from '../../src/engine/provenance';
import { outwardSide, partyEvidence } from '../../src/engine/party';
import { documentFromTruth, PLANCHES, readPlancheTruth, type DocOptions, type PlancheName, type Truth } from './auto-planche';

const truths = new Map<PlancheName, Truth>();
beforeAll(async () => {
  for (const n of PLANCHES) truths.set(n, await readPlancheTruth(n));
});

const docOf = (name: PlancheName, options: DocOptions = {}): PlanDocument => documentFromTruth(truths.get(name)!, options);
const build = (doc: PlanDocument, lang: 'fr' | 'de' = 'fr') => buildAutoProject(doc, createEmptyProject(lang), lang);
const doubts = (doc: PlanDocument, p: Project, lang: 'fr' | 'de' = 'fr') => collectDoubts(doc.reading, p, doc.sheets, lang);
const openings = (p: Project, i: number) => p.model.storeys[i]!.openings as OpeningHeights[];

/** Contour chauffé d'une feuille parcouru dans l'autre sens, arêtes réindexées (arête i = ancienne arête n−2−i). */
function reverseOutline(doc: PlanDocument, sheet: number): void {
  const s = doc.sheets[sheet]!;
  const poly = s.detected.heatedOutline!;
  const edges = s.detected.heatedEdges!;
  const n = poly.length;
  s.detected.heatedOutline = poly.slice().reverse();
  s.detected.heatedEdges = poly.map((_, i) => edges[(((n - 2 - i) % n) + n) % n]!);
}

describe('question « hauteurs des baies » en saisie libre', () => {
  it('ne touche que les fenêtres sans hauteur écrite ; hauteurs lues et largeurs supposées gardent leur provenance', () => {
    const doc = docOf('planche_A1_archicad', { guessedScale: true });
    // Rez : largeurs des fenêtres non écrites (mesurées à une échelle supposée), hauteurs LUES.
    for (const o of doc.sheets[0]!.detected.openings) if (o.kind === 'window') delete o.width;
    // Étage : aucune hauteur écrite.
    for (const o of doc.sheets[1]!.detected.openings) {
      delete o.height;
      o.heightFrom = 'default';
    }
    const auto = build(doc);
    const q = doubts(doc, auto.project).find((d) => d.id === 'opening-heights')!;
    expect(q).toBeDefined();
    const windowsUp = openings(auto.project, 1).filter((o) => o.kind === 'window').reduce((a, o) => a + o.count, 0);
    expect(q.question).toContain(String(windowsUp));
    const before = openings(auto.project, 0).map((o) => ({ h: o.height, from: o.from }));
    const next = applyDoubtAnswer(auto.project, q, '1,35', 'fr');
    // Rez : rien ne bouge (hauteurs lues, largeurs toujours supposées).
    expect(openings(next, 0).map((o) => ({ h: o.height, from: o.from }))).toEqual(before);
    expect(openings(next, 0).every((o) => o.heightFrom === 'plan')).toBe(true);
    // Étage : fenêtres à 1,35, hauteur « vous » ; la largeur garde sa provenance (jamais « vous » par ricochet).
    for (const o of openings(next, 1)) {
      if (o.kind === 'window') {
        expect(o.height).toBe(1.35);
        expect(o.heightFrom).toBe('user');
        expect(o.from).not.toBe('user');
      } else {
        expect(o.height).not.toBe(1.35);
        expect(o.heightFrom).toBe('default');
      }
    }
    expect(JSON.stringify(next.model)).not.toMatch(/"from":"user"/);
  });

  it('jamais une porte traitée en fenêtre, même quand toutes les hauteurs manquent', () => {
    const doc = docOf('planche_A1_archicad');
    for (const s of doc.sheets) {
      for (const o of s.detected.openings) {
        delete o.height;
        o.heightFrom = 'default';
      }
    }
    const auto = build(doc);
    const q = doubts(doc, auto.project).find((d) => d.id === 'opening-heights')!;
    const next = applyDoubtAnswer(auto.project, q, '1,35', 'fr');
    const all = next.model.storeys.flatMap((s) => s.openings) as OpeningHeights[];
    expect(all.filter((o) => o.kind === 'door').every((o) => o.height > 1.9 && o.heightFrom === 'default')).toBe(true);
    expect(all.filter((o) => o.kind === 'window').every((o) => o.height === 1.35 && o.heightFrom === 'user')).toBe(true);
    // Les largeurs lues : la baie entière reste « lue », jamais « vous » par ricochet.
    expect(all.filter((o) => o.kind === 'window').every((o) => o.from === 'plan')).toBe(true);
  });

  it('« confirmer » accepte la hauteur d’usage des seules fenêtres concernées', () => {
    const doc = docOf('planche_2pages');
    for (const o of doc.sheets[0]!.detected.openings) if (o.kind === 'window') {
      delete o.height;
      o.heightFrom = 'default';
    }
    const auto = build(doc);
    const q = doubts(doc, auto.project).find((d) => d.id === 'opening-heights')!;
    const next = applyDoubtAnswer(auto.project, q, DOUBT_CONFIRM, 'fr');
    expect(openings(next, 1).every((o) => o.heightFrom === 'plan')).toBe(true);
    expect(openings(next, 0).filter((o) => o.kind === 'window').every((o) => o.heightFrom === 'user')).toBe(true);
    const unknown = applyDoubtAnswer(auto.project, q, DOUBT_UNKNOWN, 'fr');
    expect(JSON.stringify(unknown.model)).not.toMatch(/"heightFrom":"user"/);
  });
});

describe('convention de hauteur des baies (plan ou façade)', () => {
  const withHeights = (gap: number): PlanDocument => {
    const doc = docOf('planche_2pages');
    for (const s of doc.sheets) {
      for (const o of s.detected.openings) {
        if (o.kind !== 'window' || o.height === undefined) continue;
        o.heightPlan = o.height;
        o.heightElevation = Math.round((o.height + gap) * 1000) / 1000;
      }
    }
    return doc;
  };

  it('écart de plus de 5 cm : UNE question pour tout le projet, appliquée à toutes les baies concernées', () => {
    const doc = withHeights(0.1);
    const auto = build(doc);
    const qs = doubts(doc, auto.project).filter((d) => d.id === 'opening-heights');
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(q.options.map((o) => o.value)).toEqual(['plan', 'plan+5', 'elevation']);
    expect(q.options.every((o) => o.label !== o.value)).toBe(true);
    const de = doubts(doc, build(doc, 'de').project, 'de').find((d) => d.id === 'opening-heights')!;
    expect(de.question).not.toBe(q.question);
    for (const [choice, delta] of [['plan', 0], ['plan+5', 0.05], ['elevation', 0.1]] as const) {
      const next = applyDoubtAnswer(auto.project, q, choice, 'fr');
      const split = next.model.storeys.flatMap((s) => s.openings as OpeningHeights[]).filter((o) => o.heightPlan !== undefined);
      expect(split.length).toBeGreaterThan(0);
      for (const o of split) {
        expect(o.height).toBeCloseTo(o.heightPlan! + delta, 3);
        expect(o.heightFrom).toBe('user');
      }
      expect(doubts(doc, next).map((d) => d.id)).not.toContain('opening-heights');
    }
  });

  it('écart de 5 cm ou moins : aucune question', () => {
    for (const gap of [0, 0.03, 0.05]) {
      const doc = withHeights(gap);
      expect(doubts(doc, build(doc).project).map((d) => d.id), String(gap)).not.toContain('opening-heights');
    }
  });
});

describe('mitoyenneté : indépendante du sens de parcours des contours', () => {
  it('côté d’une arête par sa normale extérieure, dans les deux sens', () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const reversed = square.slice().reverse();
    // Arête basse (0,0)→(10,0) et la même parcourue (10,0)→(0,0) : même côté.
    expect(outwardSide(square, 0)).toBe(outwardSide(reversed, 2));
    expect(new Set(square.map((_, i) => outwardSide(square, i))).size).toBe(4);
  });

  it.each([[[] as number[]], [[0]], [[1]], [[0, 1]]])('planche semi-mitoyenne, contours inversés sur %j : « d’un côté », pas de question', (sheets) => {
    const doc = docOf('planche_A1_archicad');
    for (const i of sheets) reverseOutline(doc, i);
    const auto = build(doc);
    expect(auto.project.answers.attachment).toBe('one-side');
    expect(partyEvidence(doc.sheets).sides.size).toBe(1);
    expect(doubts(doc, auto.project).map((d) => d.id)).not.toContain('attached');
  });

  it('maisons isolées (baies sur toutes les façades) : pas de question, isolée proposée', () => {
    for (const name of ['planche_A2_de_titres_dessus', 'planche_2pages', 'planche_sans_titres'] as const) {
      for (const rev of [false, true]) {
        const doc = docOf(name);
        if (rev) for (let i = 0; i < doc.sheets.length; i++) if (doc.sheets[i]!.detected.heatedEdges) reverseOutline(doc, i);
        const lang = name === 'planche_A2_de_titres_dessus' ? 'de' : 'fr';
        const auto = build(doc, lang);
        expect(doubts(doc, auto.project, lang).map((d) => d.id), name).not.toContain('attached');
        expect(auto.project.answers.attachment, name).toBe('other');
        expect(auto.project.answers.proposed?.['attachment'], name).toBeDefined();
      }
    }
  });

  it('façade aveugle sans mur mitoyen lu : la question reste posée (repli)', () => {
    const doc = docOf('planche_A1_archicad');
    for (const s of doc.sheets) for (const e of s.detected.heatedEdges ?? []) if (e.boundary === 'heated') Object.assign(e, { boundary: 'outside', sources: [] });
    expect(doubts(doc, build(doc).project).map((d) => d.id)).toContain('attached');
  });
});

describe('parcours automatique : décidé par la géométrie lue, pas par les valeurs d’usage', () => {
  it.each(PLANCHES)('%s : questions sur le plan sous le plafond ; les questions hors plan ne comptent pas', (name) => {
    const lang = name === 'planche_A2_de_titres_dessus' ? 'de' : 'fr';
    const doc = docOf(name);
    const auto = build(doc, lang);
    const ds = doubts(doc, auto.project, lang);
    const plan = ds.filter(isPlanDoubt);
    expect(plan.length).toBeLessThanOrEqual(MAX_AUTO_DOUBTS);
    for (const id of ['materials', 'windows', 'ventilation', 'heating', 'thermal-bridges', 'renewables']) expect(isPlanDoubt({ id: id as never })).toBe(false);
    // Seule la planche sans toiture ni plancher bas lus est refusée, pour ses fermetures.
    expect(auto.sufficient, auto.notes.join(' / ')).toBe(name !== 'planche_sans_titres');
    if (!auto.sufficient) expect(auto.notes.join(' ')).not.toMatch(/trop|zu viele/);
  });

  it('beaucoup de questions hors plan ne refusent pas le parcours ; beaucoup de questions sur le plan le refusent', () => {
    const doc = docOf('planche_A1_archicad', { noTitleBlock: true, noNorth: true });
    const auto = build(doc);
    const ds = doubts(doc, auto.project);
    expect(ds.length).toBeGreaterThan(ds.filter(isPlanDoubt).length);
    expect(auto.sufficient).toBe(ds.filter(isPlanDoubt).length <= MAX_AUTO_DOUBTS);
  });
});

describe('surfaces sans étiquette : réponse globale ou niveau par niveau', () => {
  const pick = () => {
    for (const name of PLANCHES) {
      const doc = docOf(name);
      const lang: 'fr' | 'de' = name === 'planche_A2_de_titres_dessus' ? 'de' : 'fr';
      const auto = build(doc, lang);
      const q = doubts(doc, auto.project, lang).find((d) => d.id === 'an-unlabelled');
      if (q?.parts && q.parts.length > 1) return { doc, project: auto.project, q, lang };
    }
    return null;
  };

  it('une question, le détail par niveau gardé, un choix par niveau en plus du choix global', () => {
    const found = pick();
    expect(found, 'une planche à plusieurs niveaux avec des surfaces sans étiquette').not.toBeNull();
    const { q } = found!;
    expect(q.details.length).toBe(q.parts!.length);
    expect(q.options.map((o) => o.value)).toEqual(['include', 'exclude', ...q.parts!.map((p) => `only:${p.key}`)]);
    for (const o of q.options) expect(o.label).not.toMatch(/^only:/);
    for (const p of q.parts!) expect(p.effect).toMatch(/%/);
  });

  it('« seulement ce niveau » et « niveau=choix » : An suit, niveau par niveau', () => {
    const { project, q, lang } = pick()!;
    const an = (p: Project) => deriveSheets(p, lang).totals.an;
    const none = an(applyDoubtAnswer(project, q, 'exclude', lang));
    const all = an(applyDoubtAnswer(project, q, 'include', lang));
    let sum = 0;
    for (const part of q.parts!) {
      const one = applyDoubtAnswer(project, q, `only:${part.key}`, lang);
      expect(one).not.toBe(project);
      expect(an(one) - none).toBeCloseTo(part.amount, 0);
      sum += an(one) - none;
      for (const st of one.model.storeys) for (const r of st.rooms.filter((x) => x.unlabelled)) expect(r.heated).toBe(st.id === part.key);
    }
    expect(sum).toBeCloseTo(all - none, 1);
    const [first, ...rest] = q.parts!;
    const mixed = applyDoubtAnswer(project, q, [`${first!.key}=exclude`, ...rest.map((p) => `${p.key}=include`)].join(';'), lang);
    expect(an(mixed) - none).toBeCloseTo(sum - first!.amount, 0);
    expect(mixed.answers.resolvedDoubts?.['an-unlabelled']).toBe('user');
    // Niveau inconnu ou choix incompris : rien ne change.
    expect(applyDoubtAnswer(project, q, 'nope=include', lang)).toBe(project);
    expect(applyDoubtAnswer(project, q, `${first!.key}=peut-être`, lang)).toBe(project);
  });
});

describe('mineurs du verdict', () => {
  it('réponse « chauffage » : seul le générateur est « vous » ; eau chaude, ballon, émission restent proposés', () => {
    const doc = docOf('planche_A1_archicad');
    const auto = build(doc);
    const q = doubts(doc, auto.project).find((d) => d.id === 'heating')!;
    const next = applyDoubtAnswer(auto.project, q, 'heat-pump-air', 'fr').answers;
    expect(next.heatGenerator).toBe('heat-pump-air');
    expect(next.proposed?.['heatGenerator']).toBeUndefined();
    for (const k of ['heatEmission', 'emissionTemps', 'hotWater', 'hotWaterStorageInside']) expect(next.proposed?.[k], k).toBeDefined();
    // Une réponse utilisateur antérieure n'est pas écrasée.
    const before = { ...auto.project, answers: { ...auto.project.answers, hotWater: 'separate-electric' as const } };
    delete before.answers.proposed?.['hotWater'];
    expect(applyDoubtAnswer(before, q, 'gas-condensing', 'fr').answers.hotWater).toBe('separate-electric');
    const tb = applyDoubtAnswer(auto.project, doubts(doc, auto.project).find((d) => d.id === 'thermal-bridges')!, '0.05', 'fr').answers;
    expect(tb.thermalBridges).toBe('0.05');
    expect(tb.proposed?.['thermalBridges']).toBeUndefined();
    expect(tb.proposed?.['thermalMass']).toBeDefined();
  });

  it('petit étage écarté : une note le dit', () => {
    const doc = docOf('planche_A1_archicad');
    const s = doc.sheets[1]!;
    const k = s.metresPerUnit!.value;
    const side = Math.sqrt(10) / k;
    const { x, y } = s.detected.heatedOutline![0]!;
    s.detected.heatedOutline = [{ x, y }, { x: x + side, y }, { x: x + side, y: y + side }, { x, y: y + side }];
    s.detected.heatedEdges = s.detected.heatedOutline.map(() => ({ boundary: 'outside' as const, confidence: 0.9 }));
    s.detected.outline = s.detected.heatedOutline;
    const auto = build(doc);
    expect(auto.project.model.storeys).toHaveLength(1);
    expect(auto.notes.join(' ')).toContain(s.name);
  });

  it('sous-sol avec pièces chauffées mais sans contour isolé : la note ne le dit pas « non chauffé »', () => {
    const doc = docOf('planche_A1_archicad', { noHeatedOutline: true });
    doc.sheets[0]!.storeyRank = -1;
    doc.sheets[0]!.name = 'Plan niveau -1';
    const auto = build(doc);
    const note = auto.notes.find((n) => n.includes('Plan niveau -1'));
    expect(note).toBeDefined();
    expect(note).toMatch(/pièce\(s\) chauffée/);
  });

  it('projet reconstruit : hauteur d’étage et choix des surfaces sans étiquette confirmés gardés, questions toujours tranchées', () => {
    const doc = docOf('planche_A1_archicad');
    const first = build(doc).project;
    const hq = { ...doubts(doc, first).find((d) => d.id === 'an-unlabelled')! };
    let p = applyDoubtAnswer(first, hq, 'exclude', 'fr');
    p = { ...p, model: { ...p.model, storeys: p.model.storeys.map((s, i) => (i === 0 ? { ...s, grossHeight: { value: 3.4, from: 'user' as const } } : s)) } };
    const again = buildAutoProject(doc, p, 'fr').project;
    expect(again.model.storeys[0]!.grossHeight).toMatchObject({ value: 3.4, from: 'user' });
    expect(again.model.storeys.flatMap((s) => s.rooms.filter((r) => r.unlabelled)).every((r) => !r.heated && r.area.from === 'user')).toBe(true);
    expect(again.answers.resolvedDoubts?.['an-unlabelled']).toBe('user');
    expect(doubts(doc, again).map((d) => d.id)).not.toContain('an-unlabelled');
  });
});
