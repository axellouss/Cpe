/**
 * Moteur de DOUTES : ne poser que les questions où il y a un doute.
 *
 * Chaque donnée du CPE reçoit des SIGNAUX venus de groupes indépendants (texte de la planche, géométrie, coupe,
 * façades dessinées, cartouche, maquette IFC, bibliothèque du bureau, hypothèse de l'outil). Confiance d'une valeur :
 *     c = 1 − Π (1 − w_g)   sur les groupes qui la SOUTIENNENT, un seul signal compté par groupe (le plus fort),
 * plafonnée à 0,4 dès qu'un signal FORT d'un autre groupe la contredit (0,6 pour un signal faible).
 * Poids : fort 0,7 ; faible 0,4 ; hypothèse 0. Deux signaux forts concordants : 0,91 ; un fort : 0,70 ; un fort et
 * un faible : 0,82. Une question est posée si c < seuil(impact) : 0,85 (fort), 0,65 (moyen), 0,35 (faible) — mêmes
 * paliers que core/reading.ts.
 *
 * Les données qu'AUCUN plan ne porte (λ, menuiseries, ventilation, chauffage, ponts thermiques) n'ont que des
 * hypothèses : elles font UNE question par feuille de LuxEeB-Tool, dont les sous-doutes deviennent des lignes.
 * Une réponse « je ne sais pas » garde la proposition, étiquetée hypothèse (`answerUnknown`).
 *
 * Aucune option n'est inventée : les choix proposés sont ceux du modèle (core/types) attestés par un CPE réel
 * LuxEeB-Tool 6.25 ou par les notes de recherche (docs/recherche/cpe-method).
 *
 * Fonctions pures : rien n'est lu ailleurs que dans les arguments.
 */
import { pointInPolygon, polygonArea } from '../core/geometry';
import type { DossierSheetKey } from '../core/cpe';
import type { Read, SheetReading } from '../core/reading';
import type { Lang, PlanSheet, Project, Sourced } from '../core/types';
import { formatNumber, t } from '../i18n';
import { deriveSheets } from './derive';
import { constructionFromComposition, dominantInsulation, isEnvelopeComposition } from './materials';
import './messages';
import { computeU } from './uvalue';

// ───────────────────────────── Signaux et confiance ─────────────────────────────

export type SignalGroup = 'plan-text' | 'plan-geometry' | 'section' | 'facade-drawing' | 'title-block' | 'ifc' | 'office' | 'tool-hypothesis';
export type Strength = 'strong' | 'weak' | 'hypothesis';

export interface Signal {
  group: SignalGroup;
  strength: Strength;
  /** Valeur soutenue (forme courte, comparable). */
  value: string;
  /** Code court du signal (« title-block.occasion », « edges.heated »…). */
  source: string;
}

export type Impact = 'high' | 'medium' | 'low';

export const SIGNAL_WEIGHT: Readonly<Record<Strength, number>> = { strong: 0.7, weak: 0.4, hypothesis: 0 };
export const ASK_THRESHOLD: Readonly<Record<Impact, number>> = { high: 0.85, medium: 0.65, low: 0.35 };

export interface Evaluation {
  value: string | null;
  confidence: number;
  support: Signal[];
  contradictions: Signal[];
}

/** Force d'un signal d'après la confiance de la lecture qui le porte. */
export function strengthOf(confidence: number): Strength {
  return confidence >= 0.65 ? 'strong' : confidence > 0 ? 'weak' : 'hypothesis';
}

/** Valeur la mieux soutenue et sa confiance, par recoupement de groupes INDÉPENDANTS. */
export function evaluate(signals: readonly Signal[]): Evaluation {
  if (signals.length === 0) return { value: null, confidence: 0, support: [], contradictions: [] };
  const score = (v: string): number => {
    const byGroup = new Map<SignalGroup, number>();
    for (const s of signals) if (s.value === v) byGroup.set(s.group, Math.max(byGroup.get(s.group) ?? 0, SIGNAL_WEIGHT[s.strength]));
    return 1 - [...byGroup.values()].reduce((p, w) => p * (1 - w), 1);
  };
  const values = [...new Set(signals.map((s) => s.value))].sort((a, b) => score(b) - score(a));
  const value = values[0]!;
  let confidence = score(value);
  const contradictions = signals.filter((s) => s.value !== value && s.strength !== 'hypothesis');
  if (contradictions.some((s) => s.strength === 'strong')) confidence = Math.min(confidence, 0.4);
  else if (contradictions.length > 0) confidence = Math.min(confidence, 0.6);
  return { value, confidence, support: signals.filter((s) => s.value === value), contradictions };
}

export function shouldAsk(impact: Impact, e: Pick<Evaluation, 'confidence'>): boolean {
  return e.confidence < ASK_THRESHOLD[impact];
}

// ───────────────────────────── Catalogue ─────────────────────────────

export type DoubtId =
  | 'an-unlabelled'
  | 'materials'
  | 'windows'
  | 'ventilation'
  | 'heating'
  | 'thermal-bridges'
  | 'occasion'
  | 'attached'
  | 'scale'
  | 'top'
  | 'bottom'
  | 'unheated-zone'
  | 'openings'
  | 'building-type'
  | 'heights'
  | 'room-heated'
  | 'opening-heights'
  | 'renewables'
  | 'north'
  | 'year'
  | 'identity';

export interface DoubtSpec {
  id: DoubtId;
  /** Feuille de LuxEeB-Tool concernée. */
  sheet: DossierSheetKey;
  impact: Impact;
  /** Question regroupée (données absentes de tout plan) : ses sous-doutes sont des lignes. */
  grouped: boolean;
  /** Choix proposés (clés de `doubt.option.<valeur>`) ; vide = saisie libre ou confirmation. */
  options: readonly string[];
  /** Documentation : signaux qui dispensent de la poser, et ce qui la déclenche. */
  skipWhen: string;
  trigger: string;
}

/** Le catalogue, dans l'ordre d'affichage à impact égal. */
export const DOUBT_CATALOG: readonly DoubtSpec[] = [
  { id: 'occasion', sheet: 'general', impact: 'high', grouped: false, options: ['new', 'existing'], skipWhen: 'phase du cartouche (« autorisation de bâtir ») + aucune mention d’existant + façades complètes', trigger: 'cartouche muet ou mention « existant », « transformation »' },
  { id: 'attached', sheet: 'general', impact: 'high', grouped: false, options: ['one-side', 'other'], skipWhen: 'mur mitoyen lu sur les plans (isolant, limite) + façade de ce côté non dessinée', trigger: 'un seul de ces signaux, ou des signaux contraires' },
  { id: 'scale', sheet: 'envelope', impact: 'high', grouped: false, options: [], skipWhen: 'échelle du cartouche + surfaces écrites = surfaces mesurées, ou cotes hors tout recoupées', trigger: 'échelle seulement supposée, ou surfaces qui ne collent pas' },
  { id: 'top', sheet: 'envelope', impact: 'high', grouped: false, options: ['flat', 'pitched', 'attic'], skipWhen: 'plan de toiture + coupe (acrotère ou faîtage) concordants', trigger: 'aucune vue de toiture ni coupe, ou vues contraires' },
  { id: 'bottom', sheet: 'envelope', impact: 'high', grouped: false, options: ['ground', 'basement-unheated', 'basement-heated'], skipWhen: 'composition « dalle sur sol » + coupe sans sous-sol', trigger: 'plan de sous-sol, ou ni composition ni coupe' },
  { id: 'unheated-zone', sheet: 'envelope', impact: 'high', grouped: false, options: ['unheated', 'heated'], skipWhen: 'nom de local non chauffé + isolant qui passe entre ce local et le logement', trigger: 'nom sans isolant lu, ou isolant sans nom' },
  { id: 'an-unlabelled', sheet: 'zones', impact: 'high', grouped: false, options: ['include', 'exclude'], skipWhen: 'toutes les surfaces chauffées portent une étiquette', trigger: 'surface chauffée sans étiquette ≥ 1 m² (escalier, dégagement), ou somme des étiquettes nettement sous la surface du contour' },
  { id: 'materials', sheet: 'opaque', impact: 'high', grouped: true, options: [], skipWhen: 'toutes les λ confirmées par l’utilisateur, aucune couche douteuse', trigger: 'toujours sinon : la planche ne donne jamais les λ' },
  { id: 'windows', sheet: 'windows', impact: 'high', grouped: true, options: [], skipWhen: 'Ug, Uf, Ψg, g et cadre confirmés pour tous les types, portes comprises', trigger: 'toujours sinon : la planche ne les donne pas' },
  { id: 'ventilation', sheet: 'ventilation', impact: 'high', grouped: true, options: ['windows', 'exhaust', 'balanced-hr'], skipWhen: 'type, débit, rendement, puissance et étanchéité déjà répondus', trigger: 'toujours sinon : aucun plan ne donne rendement et puissance' },
  { id: 'heating', sheet: 'heating', impact: 'high', grouped: true, options: [], skipWhen: 'générateur, émission, températures, eau chaude et ballon déjà répondus', trigger: 'toujours sinon (le plan n’écrit qu’un mot : « PAC », « Boiler ») : une confirmation' },
  { id: 'thermal-bridges', sheet: 'other', impact: 'high', grouped: true, options: ['0.10', '0.05', '0.03', 'detailed'], skipWhen: 'choix déjà répondu', trigger: 'toujours sinon' },
  { id: 'openings', sheet: 'envelope', impact: 'high', grouped: false, options: [], skipWhen: 'cotes de baies écrites, ou baies vues sur les plans, ou sur les façades', trigger: 'aucune baie lue nulle part' },
  { id: 'building-type', sheet: 'general', impact: 'medium', grouped: false, options: ['EFH', 'MFH'], skipWhen: 'objet du cartouche (« maison unifamiliale »), ou une seule cuisine', trigger: 'cartouche muet et plusieurs cuisines, ou aucune' },
  { id: 'heights', sheet: 'envelope', impact: 'medium', grouped: false, options: [], skipWhen: 'niveaux écrits en plan et en coupe, recoupés', trigger: 'pas de niveaux, ou hauteurs par défaut' },
  { id: 'room-heated', sheet: 'zones', impact: 'medium', grouped: false, options: ['heated', 'unheated'], skipWhen: 'pièce ambiguë à l’intérieur du contour isolé', trigger: 'pièce ambiguë (buanderie, local technique…) hors du contour isolé ou sans contour' },
  { id: 'opening-heights', sheet: 'envelope', impact: 'medium', grouped: false, options: [], skipWhen: 'hauteur écrite sous la largeur (cote à deux nombres) ou mesurée sur la façade', trigger: 'baies dont la hauteur est une valeur d’usage' },
  { id: 'renewables', sheet: 'photovoltaic', impact: 'medium', grouped: false, options: ['none', 'pv', 'solar-thermal'], skipWhen: 'plan de toiture lu sans panneaux ni mention', trigger: 'panneaux ou mention lus, ou pas de plan de toiture' },
  { id: 'north', sheet: 'envelope', impact: 'low', grouped: false, options: [], skipWhen: 'flèche du nord lue, loin d’une limite de secteur', trigger: 'pas de flèche, ou à moins de 5° d’une limite de secteur' },
  { id: 'year', sheet: 'general', impact: 'low', grouped: false, options: [], skipWhen: 'date du cartouche', trigger: 'pas de date' },
  { id: 'identity', sheet: 'general', impact: 'low', grouped: false, options: [], skipWhen: 'adresse et localité du cartouche', trigger: 'cartouche sans adresse' },
];


// ───────────────────────────── Doute produit ─────────────────────────────

export interface DoubtChoice {
  value: string;
  label: string;
}

export interface Doubt {
  id: DoubtId;
  sheet: DossierSheetKey;
  impact: Impact;
  grouped: boolean;
  /** La donnée concernée (« Surface de référence An »). */
  datum: string;
  /** La question, courte, dans la langue demandée. */
  question: string;
  /** Ce que l'outil propose ; « je ne sais pas » le garde, étiqueté hypothèse. null = rien à proposer (saisie). */
  proposal: DoubtChoice | null;
  options: DoubtChoice[];
  /** Lignes de détail d'une question regroupée (couches douteuses, éléments sans composition…). */
  details: string[];
  /** Effet chiffré, quand il est calculable (« +5,1 m² d'An, soit +7 % »). */
  effect: string | null;
  /** Part de l'effet (0..1) : sert au tri à impact égal. */
  effectShare: number | null;
  confidence: number;
  signals: Signal[];
}

/** « Je ne sais pas » : la proposition est gardée, étiquetée HYPOTHÈSE (jamais présentée comme lue ni confirmée). */
export function answerUnknown(doubt: Doubt, lang: Lang): Sourced<string> | null {
  if (!doubt.proposal) return null;
  return { value: doubt.proposal.value, from: 'default', confidence: 0, source: t(lang, 'doubt.unknown.source') };
}

// ───────────────────────────── Collecte ─────────────────────────────

interface Draft {
  signals: Signal[];
  /** Faux : la question ne s'applique pas (rien à trancher). */
  applicable: boolean;
  /** Vrai : déjà répondu par l'utilisateur, ne jamais reposer. */
  answered: boolean;
  params?: Record<string, string | number>;
  /** Variante de formulation (clé complète), quand la question standard ne convient pas. */
  questionKey?: string;
  proposal?: string | null;
  details?: string[];
  effect?: { text: string; share: number | null } | null;
}

const NOT_APPLICABLE: Draft = { signals: [], applicable: false, answered: false };
const ANSWERED: Draft = { signals: [], applicable: true, answered: true };

const sig = (group: SignalGroup, strength: Strength, value: string, source: string): Signal => ({ group, strength, value, source });
const fromRead = <T>(r: Read<T> | null | undefined, group: SignalGroup, source: string, map: (v: T) => string = String): Signal[] =>
  r ? [sig(group, strengthOf(r.confidence), map(r.value), source)] : [];

const pct = (share: number): string => formatNumber(share * 100, 0);

/**
 * Questions à poser, triées par impact puis par effet. Les signaux viennent du contrat de lecture (`reading`), des
 * détections des feuilles et du projet (réponses déjà données, valeurs confirmées). Une lecture absente ou dégradée
 * ajoute des questions ; une réponse déjà donnée en retire.
 */
export function collectDoubts(reading: SheetReading | undefined, project: Project, sheets: readonly PlanSheet[], lang: Lang): Doubt[] {
  const derived = deriveSheets(project, lang);
  const ctx = context(reading, project, sheets, derived);
  const out: Doubt[] = [];
  for (const spec of DOUBT_CATALOG) {
    const d = COLLECTORS[spec.id](ctx, lang);
    if (!d.applicable || d.answered) continue;
    const e = evaluate(d.signals);
    // Question regroupée (données absentes de tout plan) : posée tant qu'elle n'est pas répondue.
    if (!spec.grouped && !shouldAsk(spec.impact, e)) continue;
    const proposal = d.proposal === undefined ? e.value : d.proposal;
    out.push({
      id: spec.id,
      sheet: spec.sheet,
      impact: spec.impact,
      grouped: spec.grouped,
      datum: t(lang, `doubt.${spec.id}.datum`),
      question: t(lang, d.questionKey ?? `doubt.${spec.id}.question`, d.params ?? {}),
      proposal: proposal ? { value: proposal, label: choiceLabel(spec.id, proposal, lang) } : null,
      options: spec.options.map((v) => ({ value: v, label: choiceLabel(spec.id, v, lang) })),
      details: d.details ?? [],
      effect: d.effect?.text ?? null,
      effectShare: d.effect?.share ?? null,
      confidence: Math.round(e.confidence * 100) / 100,
      signals: d.signals,
    });
  }
  const rank: Record<Impact, number> = { high: 0, medium: 1, low: 2 };
  const order = new Map(DOUBT_CATALOG.map((s, i) => [s.id, i]));
  return out.sort(
    (a, b) => rank[a.impact] - rank[b.impact] || (b.effectShare ?? -1) - (a.effectShare ?? -1) || order.get(a.id)! - order.get(b.id)!,
  );
}

function choiceLabel(id: DoubtId, value: string, lang: Lang): string {
  const specific = t(lang, `doubt.${id}.option.${value}`);
  if (!specific.startsWith('doubt.')) return specific;
  const generic = t(lang, `doubt.option.${value}`);
  return generic.startsWith('doubt.') ? value : generic;
}

// ───────────────────────────── Contexte commun ─────────────────────────────

interface Ctx {
  reading: SheetReading | undefined;
  project: Project;
  sheets: readonly PlanSheet[];
  plans: readonly PlanSheet[];
  derived: ReturnType<typeof deriveSheets>;
  texts: string[];
}

function context(reading: SheetReading | undefined, project: Project, sheets: readonly PlanSheet[], derived: ReturnType<typeof deriveSheets>): Ctx {
  const plans = sheets.filter((s) => !s.role || s.role === 'floor-plan');
  const texts = sheets.flatMap((s) => (s.texts ?? []).map((x) => x.text));
  return { reading, project, sheets, plans, derived, texts };
}

const hasView = (ctx: Ctx, kind: string): boolean => (ctx.reading?.views ?? []).some((v) => v.kind === kind) || ctx.sheets.some((s) => s.role === kind);
const norm = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

type Collector = (ctx: Ctx, lang: Lang) => Draft;

const COLLECTORS: Record<DoubtId, Collector> = {
  occasion: (ctx) => {
    if (ctx.project.answers.occasion) return ANSWERED;
    const r = ctx.reading;
    const signals = fromRead(r?.titleBlock?.occasion, 'title-block', 'title-block.occasion');
    if (ctx.texts.length >= 20) {
      const existing = ctx.texts.some((x) => /existant|a demolir|demoli|bestand|abbruch|renovation|transformation|umbau/.test(norm(x)));
      signals.push(existing ? sig('plan-text', 'strong', 'existing', 'text.existing') : sig('plan-text', 'weak', 'new', 'text.no-existing'));
    }
    if ((r?.elevations ?? []).length > 0) signals.push(sig('facade-drawing', 'weak', 'new', 'elevations.whole'));
    return { signals, applicable: true, answered: false };
  },

  attached: (ctx, lang) => {
    if (ctx.project.answers.attachment) return ANSWERED;
    const signals: Signal[] = [];
    // Géométrie : côtés du contour chauffé lus comme mitoyens (directions distinctes dans le repère de la feuille).
    const dirs = new Set<number>();
    let sawEdges = false;
    let partyLength = 0;
    for (const s of ctx.plans) {
      const poly = s.detected.heatedOutline;
      const edges = s.detected.heatedEdges;
      if (!poly || !edges || edges.length !== poly.length) continue;
      sawEdges = true;
      const mpu = s.metresPerUnit?.value ?? 0;
      edges.forEach((e, i) => {
        if (e.boundary !== 'heated' || e.confidence < 0.5) return;
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        dirs.add(Math.round(((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) / 90) % 4);
        partyLength += Math.hypot(b.x - a.x, b.y - a.y) * mpu;
      });
    }
    if (sawEdges) {
      const v = dirs.size === 1 ? 'one-side' : 'other';
      signals.push(sig('plan-geometry', 'strong', v, 'edges.heated'));
    }
    // Façades dessinées : un côté de plan sans façade = mitoyen probable.
    // Seuls les côtés rattachés avec une confiance suffisante comptent ; un rattachement incertain affaiblit le signal.
    const placed = (ctx.reading?.elevations ?? []).filter((e) => e.planSideDeg && Number.isFinite(e.planSideDeg.value) && e.planSideDeg.confidence >= 0.35);
    const sides = new Set(placed.map((e) => ((Math.round(e.planSideDeg!.value / 90) % 4) + 4) % 4));
    const sure = placed.every((e) => e.planSideDeg!.confidence >= 0.65);
    if (sides.size === 4) signals.push(sig('facade-drawing', sure ? 'strong' : 'weak', 'other', 'elevations.4'));
    else if (sides.size === 3) signals.push(sig('facade-drawing', sure ? 'strong' : 'weak', 'one-side', 'elevations.3'));
    else if (sides.size === 2) signals.push(sig('facade-drawing', 'weak', 'other', 'elevations.2'));
    // Surface du mur mitoyen : longueur lue (tous étages) × hauteur moyenne des étages du modèle.
    const heights = ctx.project.model.storeys.map((st) => st.grossHeight.value).filter((h) => Number.isFinite(h) && h > 0);
    const meanHeight = heights.length > 0 ? heights.reduce((a, b) => a + b, 0) / heights.length : 0;
    const area = partyLength * meanHeight;
    const env = ctx.derived.totals.envelopeArea;
    return {
      signals,
      applicable: true,
      answered: false,
      params: { area: formatNumber(area, 0) },
      effect: area > 0 && env > 0 ? { text: t(lang, 'doubt.attached.effect', { area: formatNumber(area, 0), pct: pct(area / (env + area)) }), share: area / (env + area) } : null,
    };
  },

  scale: (ctx) => {
    const storeys = ctx.project.model.storeys;
    const valid = (v: number | undefined): boolean => v !== undefined && Number.isFinite(v) && v > 0;
    if (storeys.length > 0 && storeys.every((s) => s.metresPerUnit.from === 'user' && valid(s.metresPerUnit.value))) return ANSWERED;
    // Une échelle ne compte comme lue que si sa valeur est utilisable (finie, positive) : la provenance ne suffit pas.
    // Une feuille dont l'échelle est inutilisable rend aussi caducs les recoupements (surfaces, cotes) : on demande.
    if (ctx.plans.some((s) => s.metresPerUnit && !valid(s.metresPerUnit.value))) {
      return { signals: [sig('tool-hypothesis', 'hypothesis', 'unknown', 'sheet.scale-invalid')], applicable: true, answered: false };
    }
    const signals: Signal[] = [];
    const known = ctx.plans.filter((s) => s.metresPerUnit && valid(s.metresPerUnit.value) && s.metresPerUnit.from !== 'default' && s.metresPerUnit.from !== 'estimate');
    if (ctx.plans.length > 0 && known.length === ctx.plans.length && ctx.reading?.titleBlock?.scaleDen) signals.push(sig('title-block', 'strong', 'ok', 'title-block.scale'));
    else if (ctx.plans.length > 0 && known.length === ctx.plans.length) signals.push(sig('plan-geometry', 'weak', 'ok', 'sheet.scale'));
    let agree = 0;
    let disagree = 0;
    for (const s of ctx.plans) {
      for (const r of s.detected.rooms) {
        if (!(r.statedArea && r.measuredArea)) continue;
        if (Math.abs(r.statedArea - r.measuredArea) / r.statedArea <= 0.03) agree++;
        else disagree++;
      }
    }
    if (agree + disagree >= 2) signals.push(sig('plan-text', 'strong', agree >= 2 * disagree ? 'ok' : 'mismatch', 'rooms.stated-vs-measured'));
    if (ctx.plans.some((s) => (s.detected.footprintSize?.confidence ?? 0) >= 0.65)) signals.push(sig('plan-geometry', 'strong', 'ok', 'footprint.dims'));
    return { signals, applicable: ctx.plans.length > 0 || storeys.length > 0, answered: false };
  },

  top: (ctx) => {
    if (ctx.project.model.top.from === 'user') return ANSWERED;
    const r = ctx.reading;
    const signals: Signal[] = [];
    signals.push(...fromRead(r?.roof?.flat, 'plan-geometry', 'roof.flat', (f) => (f ? 'flat' : 'pitched')));
    if (r?.roof?.pitchDeg) signals.push(sig('plan-geometry', strengthOf(r.roof.pitchDeg.confidence), 'pitched', 'roof.pitch'));
    if (r?.levels?.top) signals.push(sig('section', strengthOf(r.levels.top.confidence), r.levels.top.role === 'top' ? 'flat' : 'pitched', 'levels.top'));
    if ((r?.compositions ?? []).some((c) => c.element === 'ceiling-to-unheated')) signals.push(sig('plan-text', 'strong', 'attic', 'composition.ceiling'));
    return { signals, applicable: true, answered: false };
  },

  bottom: (ctx) => {
    if (ctx.project.model.bottom.from === 'user') return ANSWERED;
    const r = ctx.reading;
    const signals: Signal[] = [];
    const basementPlan = (r?.views ?? []).some((v) => v.kind === 'floor-plan' && (v.storeyRank ?? 0) < 0) || ctx.sheets.some((s) => (s.storeyRank ?? 0) < 0);
    if (basementPlan) signals.push(sig('plan-geometry', 'strong', 'basement-unheated', 'view.basement'));
    if ((r?.compositions ?? []).some((c) => c.element === 'floor-on-ground')) signals.push(sig('plan-text', 'strong', 'ground', 'composition.floor-on-ground'));
    if (hasView(ctx, 'section') && !basementPlan && (r?.levels?.floors[0]?.rel ?? 0) > -1) signals.push(sig('section', 'strong', 'ground', 'section.no-basement'));
    return { signals, applicable: true, answered: false };
  },

  'unheated-zone': (ctx) => {
    const zones = ctx.plans.flatMap((s) => s.detected.unheatedZones ?? []);
    const named = ctx.plans.flatMap((s) => s.detected.rooms.filter((r) => r.heatedGuess === 'no' && !r.exterior));
    if (zones.length === 0 && named.length === 0) return NOT_APPLICABLE;
    const signals: Signal[] = [];
    if (named.length > 0) signals.push(sig('plan-text', 'strong', 'unheated', 'room.name'));
    const insulated = ctx.plans.some((s) => (s.detected.heatedEdges ?? []).some((e) => e.boundary === 'unheated' && (e.sources ?? []).includes('insulation') && e.confidence >= 0.5));
    if (insulated) signals.push(sig('plan-geometry', 'strong', 'unheated', 'edges.insulation'));
    else if (zones.length > 0) signals.push(sig('plan-geometry', 'weak', 'unheated', 'zone.outline'));
    const names = [...new Set([...zones.flatMap((z) => z.names), ...named.map((r) => r.name)])].filter(Boolean);
    return { signals, applicable: true, answered: false, params: { names: names.join(', ') || '?' }, details: [], proposal: 'unheated' };
  },

  'an-unlabelled': (ctx, lang) => {
    const storeys = ctx.project.model.storeys;
    if (storeys.length > 0 && storeys.every((s) => s.netAreaOverride?.from === 'user')) return ANSWERED;
    let unlabelled = 0;
    let labelled = 0;
    let gross = 0;
    for (const s of ctx.plans) {
      unlabelled += (s.detected.unlabelledAreas ?? []).filter((u) => u.area >= 1).reduce((a, u) => a + u.area, 0);
      labelled += s.detected.rooms.filter((r) => r.heatedGuess === 'yes' && !r.exterior).reduce((a, r) => a + (r.statedArea ?? r.measuredArea ?? 0), 0);
      const mpu = s.metresPerUnit?.value ?? 0;
      if (s.detected.heatedOutline && mpu > 0) gross += polygonArea(s.detected.heatedOutline.map((p) => ({ x: p.x * mpu, y: p.y * mpu })));
    }
    const fallback = unlabelled < 1 && labelled > 0 && gross > 0 && labelled < 0.75 * gross;
    if (unlabelled < 1 && !fallback) return NOT_APPLICABLE;
    const signals = [sig('plan-text', 'strong', 'labels', 'rooms.stated'), sig('plan-geometry', unlabelled >= 1 ? 'strong' : 'weak', 'labels+unlabelled', unlabelled >= 1 ? 'faces.unlabelled' : 'outline.net-estimate')];
    const an = ctx.derived.totals.an > 0 ? ctx.derived.totals.an : labelled;
    const share = unlabelled >= 1 && an > 0 ? unlabelled / an : null;
    return {
      signals,
      applicable: true,
      answered: false,
      params: unlabelled >= 1 ? { area: formatNumber(unlabelled, 1) } : { labelled: formatNumber(labelled, 0), gross: formatNumber(gross, 0) },
      // Repli sans surface identifiée : on ne parle ni d'escalier ni de dégagement, seulement de l'écart constaté.
      ...(unlabelled >= 1 ? {} : { questionKey: 'doubt.an-unlabelled.questionEstimate' }),
      proposal: 'include',
      effect: share !== null ? { text: t(lang, 'doubt.an-unlabelled.effect', { area: formatNumber(unlabelled, 1), pct: pct(share) }), share } : null,
    };
  },

  materials: (ctx, lang) => {
    const model = ctx.project.model;
    const confirmed = model.constructions.filter((c) => c.category !== 'door').every((c) => c.u?.from === 'user' || ((c.layers ?? []).length > 0 && (c.layers ?? []).every((l) => l.lambda?.from === 'user' && !l.doubt)));
    const office = model.constructions.some((c) => (c.layers ?? []).some((l) => l.lambda?.from === 'user' && (l.lambda.confidence ?? 1) < 0.85));
    if (confirmed && !office && model.constructions.some((c) => c.category !== 'door')) return ANSWERED;
    const comps = (ctx.reading?.compositions ?? []).filter(isEnvelopeComposition);
    const fallback = dominantInsulation(comps);
    const built = comps.map((rc, i) => constructionFromComposition(rc, { id: `doubt-${i}`, lang, projectInsulation: fallback }));
    const layers = built.reduce((n, c) => n + (c.layers ?? []).length, 0);
    const details: string[] = [];
    for (const c of built) for (const l of c.layers ?? []) if (l.doubt) details.push(`${c.name} — ${l.planText ?? l.name} : ${l.doubt}`);
    // Éléments de l'enveloppe sans composition lue.
    const types = new Set(comps.map((c) => c.element));
    const missing: string[] = [];
    const need = (cond: boolean, element: (typeof comps)[number]['element'], key: string): void => {
      if (cond && !types.has(element)) missing.push(t(lang, `doubt.materials.element.${key}`));
    };
    const rows = ctx.derived.envelope;
    need(rows.some((r) => r.kind === 'wall' && r.boundary === 'outside'), 'external-wall', 'wall');
    need(rows.some((r) => r.kind === 'wall' && r.boundary === 'unheated'), 'wall-to-unheated', 'wallUnheated');
    need(rows.some((r) => r.kind === 'floor' && r.boundary === 'ground'), 'floor-on-ground', 'floorGround');
    need(rows.some((r) => r.kind === 'floor' && r.boundary === 'unheated'), 'floor-to-unheated', 'floorUnheated');
    need(rows.some((r) => r.kind === 'roof'), 'roof', 'roof');
    for (const m of missing) details.push(t(lang, 'doubt.materials.missing', { element: m }));
    // Effet chiffré : sensibilité du U du mur à la λ de son isolant (+10 %).
    let effect: Draft['effect'] = null;
    const wall = built.find((c) => c.luxeebType === 'aussenwand' && c.u);
    if (wall) {
      const u0 = computeU(wall).u;
      const bumped = { ...wall, layers: (wall.layers ?? []).map((l) => (l.lambda && l.lambda.value < 0.1 ? { ...l, lambda: { ...l.lambda, value: l.lambda.value * 1.1 } } : l)) };
      const u1 = computeU(bumped).u;
      if (u0 && u1) effect = { text: t(lang, 'doubt.materials.effect', { pct: pct(u1 / u0 - 1) }), share: u1 / u0 - 1 };
    }
    return {
      signals: [sig('tool-hypothesis', 'hypothesis', 'usage', 'materials.usage')],
      applicable: true,
      answered: false,
      params: { layers, doubtful: details.length },
      ...(layers === 0 ? { questionKey: 'doubt.materials.questionMissing' } : {}),
      proposal: null,
      details,
      effect,
    };
  },

  windows: (ctx, lang) => {
    const model = ctx.project.model;
    const types = model.windowTypes;
    const doors = model.constructions.filter((c) => c.category === 'door');
    const typeOk = (w: (typeof types)[number]): boolean => w.uw?.from === 'user' || [w.ug, w.uf, w.psiG].every((x) => x?.from === 'user');
    const used = new Set(ctx.derived.envelope.map((r) => r.windowTypeId).filter((x): x is string => x !== null));
    const relevant = types.filter((w) => used.size === 0 || used.has(w.id));
    if (relevant.length > 0 && relevant.every(typeOk) && doors.every((d) => d.u?.from === 'user')) return ANSWERED;
    const env = ctx.derived.totals.envelopeArea;
    const win = ctx.derived.totals.windowArea;
    const share = env > 0 && win > 0 ? win / env : null;
    // Les valeurs d'usage sont celles d'un triple vitrage NEUF : elles ne sont proposées que pour une construction neuve.
    const existing = ctx.project.answers.occasion !== null && ctx.project.answers.occasion !== undefined
      ? ctx.project.answers.occasion !== 'new'
      : (ctx.reading?.titleBlock?.occasion?.value ?? 'new') !== 'new';
    return {
      signals: [sig('tool-hypothesis', 'hypothesis', 'usage', 'windows.usage')],
      applicable: true,
      answered: false,
      // Nombre de types à saisir : un par façade et par dimensions, comme l'expert.
      params: { count: Math.max(1, new Set(ctx.derived.envelope.filter((r) => r.kind === 'window').map((r) => `${r.orientation}|${r.length}|${r.width}`)).size) },
      ...(existing ? { questionKey: 'doubt.windows.questionExisting', proposal: null } : { proposal: 'triple-new' }),
      details: existing
        ? [t(lang, 'doubt.windows.detail.existing'), t(lang, 'doubt.windows.detail.heights')]
        : [t(lang, 'doubt.windows.detail.values'), t(lang, 'doubt.windows.detail.heights'), t(lang, 'doubt.windows.detail.doors')],
      effect: share !== null ? { text: t(lang, 'doubt.windows.effect', { pct: pct(share) }), share } : null,
    };
  },

  ventilation: (ctx, lang) => {
    const a = ctx.project.answers;
    const deviceOk = a.ventilation !== null && (a.ventilation !== 'balanced-hr' || (a.ventilationFlow != null && a.heatRecovery != null && a.fanPower != null));
    if (deviceOk && a.airtightness != null && (a.airtightness !== 'measured' || a.n50 !== null)) return ANSWERED;
    const r = ctx.reading;
    const signals = fromRead(r?.systems?.ventilation, 'plan-text', 'systems.ventilation');
    const vmc = (r?.equipment ?? []).some((e) => e.kind === 'ventilation-unit');
    if (vmc) signals.push(sig('plan-text', 'weak', 'balanced-hr', 'equipment.vmc'));
    const e = evaluate(signals);
    const isNew = a.occasion === 'new' || r?.titleBlock?.occasion?.value === 'new';
    return {
      signals: signals.length > 0 ? signals : [sig('tool-hypothesis', 'hypothesis', 'unknown', 'ventilation.none')],
      applicable: true,
      answered: false,
      proposal: e.value ?? (isNew ? 'balanced-hr' : null),
      details: [t(lang, 'doubt.ventilation.detail.device'), t(lang, 'doubt.ventilation.detail.airtightness')],
    };
  },

  heating: (ctx, lang) => {
    const a = ctx.project.answers;
    if (a.heatGenerator && a.heatEmission && a.hotWater && a.hotWaterStorageInside != null && a.emissionTemps) return ANSWERED;
    const r = ctx.reading;
    const signals = fromRead(r?.systems?.heatGenerator, 'plan-text', 'systems.heatGenerator');
    if ((r?.equipment ?? []).some((e) => e.kind === 'heat-pump' && e.outside === true)) signals.push(sig('plan-geometry', 'weak', 'heat-pump-air', 'equipment.outdoor-unit'));
    const e = evaluate(signals);
    const tank = (r?.equipment ?? []).some((x) => x.kind === 'hot-water-tank');
    const details = [t(lang, 'doubt.heating.detail.emission'), t(lang, tank ? 'doubt.heating.detail.tankRead' : 'doubt.heating.detail.tank')];
    return {
      signals: signals.length > 0 ? signals : [sig('tool-hypothesis', 'hypothesis', 'unknown', 'heating.none')],
      applicable: true,
      answered: false,
      params: { generator: e.value ? t(lang, `doubt.generator.${e.value}`) : '?' },
      proposal: e.value,
      details,
    };
  },

  'thermal-bridges': (ctx, lang) => {
    const a = ctx.project.answers;
    if (a.thermalBridges && a.thermalMass) return ANSWERED;
    const env = ctx.derived.totals.envelopeArea;
    const heavy = (ctx.reading?.compositions ?? []).some((c) => c.layers.some((l) => ['beton', 'beton-arme', 'bloc-beton', 'brique', 'silico-calcaire'].includes(l.material)));
    const details = heavy ? [t(lang, 'doubt.thermal-bridges.detail.heavy')] : [t(lang, 'doubt.thermal-bridges.detail.mass')];
    return {
      signals: [sig('tool-hypothesis', 'hypothesis', '0.10', 'thermal-bridges.default')],
      applicable: true,
      answered: false,
      proposal: a.thermalBridges ?? '0.10',
      details,
      effect: env > 0 ? { text: t(lang, 'doubt.thermal-bridges.effect', { wk: formatNumber(0.07 * env, 1) }), share: null } : null,
    };
  },

  openings: (ctx) => {
    const r = ctx.reading;
    const signals: Signal[] = [];
    if ((r?.openingPairs ?? []).length > 0) signals.push(sig('plan-text', 'strong', 'ok', 'opening-pairs'));
    const detected = ctx.plans.flatMap((s) => s.detected.openings);
    if (detected.length > 0) signals.push(sig('plan-geometry', strengthOf(Math.max(...detected.map((o) => o.confidence ?? 0.5))), 'ok', 'openings.detected'));
    if ((r?.elevations ?? []).some((e) => e.bays.length > 0)) signals.push(sig('facade-drawing', 'weak', 'ok', 'elevations.bays'));
    if (ctx.project.model.storeys.some((s) => s.openings.length > 0)) signals.push(sig('plan-geometry', 'strong', 'ok', 'model.openings'));
    // Les dimensions de chaque baie se vérifient dans le relevé : la question ne vient que si AUCUNE baie n'est lue.
    if (signals.length > 0) return NOT_APPLICABLE;
    return { signals, applicable: ctx.plans.length > 0 || ctx.project.model.storeys.length > 0, answered: false };
  },

  'building-type': (ctx) => {
    const a = ctx.project.answers;
    if (a.buildingType && a.dwellings) return ANSWERED;
    const r = ctx.reading;
    const signals = fromRead(r?.titleBlock?.buildingType, 'title-block', 'title-block.type');
    const kitchens = ctx.plans.flatMap((s) => s.detected.rooms).filter((x) => /cuisine|kuche|kitchen|kochen/.test(norm(x.name))).length;
    if (kitchens === 1) signals.push(sig('plan-text', 'weak', 'EFH', 'rooms.kitchen'));
    else if (kitchens >= 2) signals.push(sig('plan-text', 'strong', 'MFH', 'rooms.kitchens'));
    return { signals, applicable: true, answered: false };
  },

  heights: (ctx) => {
    const storeys = ctx.project.model.storeys;
    if (storeys.length > 0 && storeys.every((s) => s.grossHeight.from === 'user')) return ANSWERED;
    const lv = ctx.reading?.levels;
    const signals: Signal[] = [];
    const need = Math.max(1, ctx.plans.length, storeys.length);
    if (lv && lv.floors.length >= need) signals.push(sig('plan-text', lv.checks.failed > 0 ? 'weak' : 'strong', 'ok', 'levels.floors'));
    if (lv && hasView(ctx, 'section') && (lv.clearHeights.length > 0 || lv.marks.some((m) => (ctx.reading?.views ?? []).some((v) => v.id === m.viewId && v.kind === 'section')))) {
      signals.push(sig('section', 'strong', 'ok', 'section.levels'));
    }
    // Une hauteur par défaut dans le modèle n'est soutenue par rien : la question est posée.
    if (storeys.some((s) => s.grossHeight.from === 'default' || s.grossHeight.from === 'estimate')) return { signals: [], applicable: true, answered: false };
    if (storeys.length > 0 && storeys.every((s) => s.grossHeight.from === 'plan')) signals.push(sig('plan-geometry', 'weak', 'ok', 'model.heights'));
    return { signals, applicable: true, answered: false };
  },

  'room-heated': (ctx) => {
    // Pièce ambiguë (buanderie, local technique…) : tranchée si elle est dans le contour isolé lu.
    const ambiguous: string[] = [];
    for (const s of ctx.plans) {
      for (const r of s.detected.rooms) {
        if (r.heatedGuess !== 'ask' || r.exterior) continue;
        const inside = r.at && s.detected.heatedOutline && pointInPolygon(r.at, s.detected.heatedOutline);
        if (!inside) ambiguous.push(r.name);
      }
    }
    // Pièces que le modèle signale encore à trancher (relecture de l'expert pas faite).
    for (const st of ctx.project.model.storeys) for (const r of st.rooms) if (r.needsReview && !ambiguous.includes(r.name)) ambiguous.push(r.name);
    if (ambiguous.length === 0) return NOT_APPLICABLE;
    return { signals: [], applicable: true, answered: false, params: { names: ambiguous.join(', ') }, proposal: 'heated' };
  },

  'opening-heights': (ctx) => {
    const detected = ctx.plans.flatMap((s) => s.detected.openings);
    const modelOpenings = ctx.project.model.storeys.flatMap((s) => s.openings);
    if (detected.length === 0 && modelOpenings.length === 0) return NOT_APPLICABLE;
    if (modelOpenings.length > 0 && modelOpenings.every((o) => o.from === 'user')) return ANSWERED;
    const guessed = detected.filter((o) => o.heightFrom === 'default' || o.height === undefined).length;
    // Des hauteurs d'usage : rien ne les soutient, la question est posée.
    if (guessed > 0) return { signals: [], applicable: true, answered: false, params: { count: guessed } };
    const signals: Signal[] = [];
    if ((ctx.reading?.openingPairs ?? []).length > 0) signals.push(sig('plan-text', 'strong', 'ok', 'opening-pairs'));
    if (detected.some((o) => o.heightFrom === 'plan-dim')) signals.push(sig('plan-text', 'strong', 'ok', 'openings.plan-dim'));
    if (detected.some((o) => o.heightFrom === 'elevation') || (ctx.reading?.elevations ?? []).some((e) => e.bays.length > 0)) {
      signals.push(sig('facade-drawing', 'weak', 'ok', 'elevations.bays'));
    }
    return { signals, applicable: true, answered: false, params: { count: detected.length || modelOpenings.length } };
  },

  renewables: (ctx) => {
    const a = ctx.project.answers;
    if (a.photovoltaic !== null && a.solarThermal !== null) return ANSWERED;
    const eq = ctx.reading?.equipment ?? [];
    const signals: Signal[] = [];
    if (eq.some((e) => e.kind === 'photovoltaic')) signals.push(sig('plan-text', 'strong', 'pv', 'equipment.pv'));
    if (eq.some((e) => e.kind === 'solar-thermal')) signals.push(sig('plan-text', 'strong', 'solar-thermal', 'equipment.solar'));
    if (signals.length === 0 && hasView(ctx, 'roof-plan')) signals.push(sig('plan-geometry', 'strong', 'none', 'roof-plan.empty'));
    // Panneaux lus : il faut quand même leurs caractéristiques (surface, puissance).
    if (signals.some((s) => s.value !== 'none')) return { signals: [], applicable: true, answered: false, proposal: signals[0]!.value };
    return { signals, applicable: true, answered: false, proposal: 'none' };
  },

  north: (ctx) => {
    if (ctx.project.model.northAngle.from === 'user') return ANSWERED;
    const n = ctx.reading?.north;
    if (!n) {
      const fromModel = ctx.project.model.northAngle.from === 'plan';
      return { signals: fromModel ? [sig('plan-geometry', 'weak', 'read', 'model.north')] : [], applicable: true, answered: false };
    }
    const strength = n.marginDeg < 5 ? 'weak' : strengthOf(n.confidence);
    return { signals: [sig('plan-geometry', strength, 'read', 'north.arrow')], applicable: true, answered: false, params: { angle: formatNumber(n.sheetUpAzimuth, 0) } };
  },

  year: (ctx) => {
    if (ctx.project.answers.yearBuilt !== null) return ANSWERED;
    const y = ctx.reading?.titleBlock?.year ?? null;
    return { signals: y ? [sig('title-block', 'strong', String(y), 'title-block.date')] : [], applicable: true, answered: false, proposal: y ? String(y) : null };
  },

  identity: (ctx) => {
    const a = ctx.project.answers;
    if (a.street.trim() && a.locality.trim()) return ANSWERED;
    const tb = ctx.reading?.titleBlock;
    return { signals: tb?.street && tb.locality ? [sig('title-block', 'strong', 'ok', 'title-block.address')] : [], applicable: true, answered: false, proposal: null };
  },
};
