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
import type { BBox, Lang, PlanSheet, Project, ProjectAnswers, Sourced } from '../core/types';
import { formatNumber, t } from '../i18n';
import { deriveSheets } from './derive';
import { constructionFromComposition, dominantInsulation, isEnvelopeComposition } from './materials';
import './messages';
import { partyEvidence, readsDetached } from './party';
import { heightFromOf, type OpeningHeights } from './provenance';
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
  { id: 'heating', sheet: 'heating', impact: 'high', grouped: true, options: ['heat-pump-air', 'heat-pump-ground', 'gas-condensing', 'pellets', 'district-heating', 'other'], skipWhen: 'générateur, émission, températures, eau chaude et ballon déjà répondus', trigger: 'toujours sinon (le plan n’écrit qu’un mot : « PAC », « Boiler ») : une confirmation' },
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


/**
 * Questions « hors plan » : elles portent sur ce qu'AUCUN plan ne porte (λ, menuiseries, ventilation, chauffage,
 * ponts thermiques, installations renouvelables). L'interface les confirme d'un geste ; elles ne décident pas du
 * parcours automatique, qui dépend de la géométrie lue (engine/auto, MAX_AUTO_DOUBTS).
 */
export const OFF_PLAN_DOUBTS: ReadonlySet<DoubtId> = new Set<DoubtId>([
  ...DOUBT_CATALOG.filter((s) => s.grouped).map((s) => s.id),
  'renewables',
]);

/** Vrai si la question porte sur le plan lu (et compte dans le plafond du parcours automatique). */
export const isPlanDoubt = (d: Pick<Doubt, 'id'>): boolean => !OFF_PLAN_DOUBTS.has(d.id);

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
  /** Endroit de la planche qui appuie la question (page à partir de 1, boîte en uf), quand il est connu. */
  where?: { page: number; box: BBox; sheetId?: string | null };
  /** Où corriger sur le plan : étage (Storey.id) et outil de l'éditeur concernés. */
  fix?: { storeyId: string | null; step: 'scale' | 'outline' | 'rooms' | 'boundary' | 'opening' | 'height' | 'north' };
  /**
   * Question regroupée sur plusieurs niveaux : une ligne par niveau, à laquelle on peut répondre à part. Réponse
   * niveau par niveau : `<key>=<choix>` séparés par « ; » (ex. « st1=include;st2=exclude »).
   */
  parts?: DoubtPart[];
}

export interface DoubtPart {
  /** Identifiant du niveau (Storey.id). */
  key: string;
  label: string;
  /** Valeur en jeu pour ce niveau (m² pour les surfaces sans étiquette). */
  amount: number;
  /** Effet chiffré de « compter » pour ce niveau. */
  effect: string | null;
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
  /** Choix propres à cette question quand ils diffèrent du catalogue (question de convention, choix par niveau). */
  options?: readonly string[];
  /** Libellés de ces choix propres (sinon `doubt.<id>.option.<valeur>`). */
  optionLabels?: Readonly<Record<string, string>>;
  parts?: DoubtPart[];
}

const NOT_APPLICABLE: Draft = { signals: [], applicable: false, answered: false };
const ANSWERED: Draft = { signals: [], applicable: true, answered: true };

const sig = (group: SignalGroup, strength: Strength, value: string, source: string): Signal => ({ group, strength, value, source });
const fromRead = <T>(r: Read<T> | null | undefined, group: SignalGroup, source: string, map: (v: T) => string = String): Signal[] =>
  r ? [sig(group, strengthOf(r.confidence), map(r.value), source)] : [];

const pct = (share: number): string => formatNumber(share * 100, 0);

/** Écart (m) entre hauteur écrite sur le plan et hauteur vue en façade au-delà duquel la convention est demandée. */
export const HEIGHT_CONVENTION_GAP = 0.05;

/**
 * Questions à poser, triées par impact puis par effet. Les signaux viennent du contrat de lecture (`reading`), des
 * détections des feuilles et du projet (réponses déjà données, valeurs confirmées). Une lecture absente ou dégradée
 * ajoute des questions ; une réponse déjà donnée en retire.
 */
export function collectDoubts(reading: SheetReading | undefined, project: Project, sheets: readonly PlanSheet[], lang: Lang): Doubt[] {
  const derived = deriveSheets(project, lang);
  // PROPOSÉ ≠ CONFIRMÉ : une réponse que l'outil a seulement proposée (lue ou supposée) ne tranche aucune question.
  const ctx = context(reading, { ...project, answers: confirmedAnswers(project.answers) }, sheets, derived);
  const resolved = project.answers.resolvedDoubts ?? {};
  const out: Doubt[] = [];
  for (const spec of DOUBT_CATALOG) {
    // Question déjà tranchée par l'utilisateur (réponse ou « je ne sais pas ») : jamais reposée.
    if (Object.prototype.hasOwnProperty.call(resolved, spec.id)) continue;
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
      options: (d.options ?? spec.options).map((v) => ({ value: v, label: d.optionLabels?.[v] ?? choiceLabel(spec.id, v, lang) })),
      details: d.details ?? [],
      ...(d.parts && d.parts.length > 0 ? { parts: d.parts } : {}),
      effect: d.effect?.text ?? null,
      effectShare: d.effect?.share ?? null,
      confidence: Math.round(e.confidence * 100) / 100,
      signals: d.signals,
      ...placeOf(spec.id, ctx),
    });
  }
  const rank: Record<Impact, number> = { high: 0, medium: 1, low: 2 };
  const order = new Map(DOUBT_CATALOG.map((s, i) => [s.id, i]));
  return out.sort(
    (a, b) => rank[a.impact] - rank[b.impact] || (b.effectShare ?? -1) - (a.effectShare ?? -1) || order.get(a.id)! - order.get(b.id)!,
  );
}

/** Valeur « non renseignée » de chaque réponse proposable (même forme que les réponses vides). */
const EMPTY_ANSWER: Partial<Record<keyof ProjectAnswers, null | ''>> = { projectName: '', street: '', postcode: '', locality: '' };

/**
 * Les réponses telles que l'UTILISATEUR les a données : celles que l'outil a seulement proposées (`proposed`) sont
 * remises à « non renseigné ». Sert à décider si une question est déjà tranchée.
 */
export function confirmedAnswers(answers: ProjectAnswers): ProjectAnswers {
  const proposed = answers.proposed;
  if (!proposed) return answers;
  const out = { ...answers } as unknown as Record<string, unknown>;
  for (const key of Object.keys(proposed)) {
    if (!Object.prototype.hasOwnProperty.call(out, key) || key === 'proposed' || key === 'resolvedDoubts') continue;
    out[key] = Object.prototype.hasOwnProperty.call(EMPTY_ANSWER, key) ? EMPTY_ANSWER[key as keyof ProjectAnswers] : null;
  }
  return out as unknown as ProjectAnswers;
}

function choiceLabel(id: DoubtId, value: string, lang: Lang): string {
  const specific = t(lang, `doubt.${id}.option.${value}`);
  if (!specific.startsWith('doubt.')) return specific;
  const generic = t(lang, `doubt.option.${value}`);
  return generic.startsWith('doubt.') ? value : generic;
}

// ───────────────────────────── Endroit de la planche et outil de correction ─────────────────────────────

type Where = NonNullable<Doubt['where']>;
type FixStep = NonNullable<Doubt['fix']>['step'];

const validBox = (b: BBox | null | undefined): b is BBox =>
  !!b && [b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) && b.maxX > b.minX && b.maxY > b.minY;

function boxAround(points: readonly { x: number; y: number }[], pad: number): BBox | null {
  const ok = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (ok.length === 0) return null;
  return {
    minX: Math.min(...ok.map((p) => p.x)) - pad,
    minY: Math.min(...ok.map((p) => p.y)) - pad,
    maxX: Math.max(...ok.map((p) => p.x)) + pad,
    maxY: Math.max(...ok.map((p) => p.y)) + pad,
  };
}

/** Outil de l'éditeur de plan où chaque question se corrige ; absent : elle ne se corrige pas sur le plan. */
const FIX_STEP: Partial<Record<DoubtId, FixStep>> = {
  scale: 'scale',
  heights: 'height',
  openings: 'opening',
  'opening-heights': 'opening',
  north: 'north',
  'unheated-zone': 'boundary',
  attached: 'boundary',
  'an-unlabelled': 'rooms',
  'room-heated': 'rooms',
};

/**
 * Endroit de la planche qui appuie la question (boîte de la pièce, de la zone, du bloc de composition, de
 * l'équipement, du cartouche, de la vue) et étage à ouvrir pour la corriger : celui de la feuille où le doute a été
 * vu, sinon le premier étage. Rien d'inventé : sans endroit connu, `where` est absent.
 */
function placeOf(id: DoubtId, ctx: Ctx): Pick<Doubt, 'where' | 'fix'> {
  const r = ctx.reading;
  const found: Where[] = [];
  const put = (page: number | null | undefined, box: BBox | null | undefined, sheetId: string | null = null): void => {
    if (found.length === 0 && validBox(box)) found.push({ page: page ?? 1, box, sheetId });
  };
  const onSheet = (sheet: PlanSheet, box: BBox | null): void =>
    put(sheet.page ?? (r?.views ?? []).find((v) => v.sheetId === sheet.id)?.page ?? 1, box, sheet.id);
  const view = (kinds: readonly string[]): void => {
    const v = (r?.views ?? []).find((x) => kinds.includes(x.kind));
    if (v) put(v.page, v.buildingBox ?? v.box, v.sheetId);
  };
  const composition = (elements: readonly string[]): void => {
    for (const c of r?.compositions ?? []) {
      if (!elements.includes(c.element)) continue;
      for (const o of c.occurrences) put(o.page, o.box);
    }
  };
  const equipment = (kinds: readonly string[]): void => {
    const e = (r?.equipment ?? []).find((x) => kinds.includes(x.kind));
    if (e) put(e.page, { minX: e.at.x - 24, minY: e.at.y - 24, maxX: e.at.x + 24, maxY: e.at.y + 24 });
  };
  switch (id) {
    case 'occasion':
    case 'building-type':
    case 'year':
    case 'identity':
    case 'scale':
      if (r?.titleBlock) put(r.titleBlock.page, r.titleBlock.box);
      break;
    case 'north':
      if (r?.north) put(r.north.page, r.north.box);
      break;
    case 'materials':
      composition(['external-wall', 'wall-to-unheated', 'roof', 'floor-on-ground', 'floor-to-unheated', 'floor-to-outside', 'ceiling-to-unheated', 'wall-to-ground']);
      break;
    case 'bottom':
      composition(['floor-on-ground', 'floor-to-unheated']);
      view(['section']);
      break;
    case 'top':
    case 'renewables':
      view(['roof-plan']);
      view(['section']);
      break;
    case 'heights':
      view(['section']);
      break;
    case 'openings':
    case 'opening-heights':
    case 'windows':
      view(['elevation']);
      break;
    case 'heating':
      equipment(['heat-pump']);
      equipment(['hot-water-tank', 'boiler']);
      break;
    case 'ventilation':
      equipment(['ventilation-unit']);
      break;
    case 'an-unlabelled':
      for (const s of ctx.plans) {
        const u = (s.detected.unlabelledAreas ?? []).find((x) => x.area >= 1 && (x.polygon?.length ?? 0) >= 3);
        if (u?.polygon) onSheet(s, boxAround(u.polygon, 12));
      }
      break;
    case 'unheated-zone':
      for (const s of ctx.heatedPlans) {
        const z = (s.detected.unheatedZones ?? []).find((x) => x.polygon.length >= 3);
        if (z) onSheet(s, boxAround(z.polygon, 12));
        const room = s.detected.rooms.find((x) => x.heatedGuess === 'no' && !x.exterior && (x.polygon || x.at));
        if (room) onSheet(s, room.polygon ? boxAround(room.polygon, 12) : boxAround([room.at!], 40));
      }
      break;
    case 'room-heated':
      for (const s of ctx.heatedPlans) {
        const room = s.detected.rooms.find((x) => x.heatedGuess === 'ask' && !x.exterior && isRoomName(x.name) && (x.polygon || x.at));
        if (room) onSheet(s, room.polygon ? boxAround(room.polygon, 12) : boxAround([room.at!], 40));
      }
      break;
    case 'attached': {
      // Le plan d'un étage du volume chauffé (pas celui d'un sous-sol laissé hors du volume).
      const heated = new Set(ctx.heatedPlans.map((s) => s.id));
      const v = (r?.views ?? []).find((x) => x.kind === 'floor-plan' && x.sheetId !== null && heated.has(x.sheetId));
      if (v) put(v.page, v.buildingBox ?? v.box, v.sheetId);
      view(['floor-plan']);
      break;
    }
    case 'thermal-bridges':
      break;
  }
  const out: Pick<Doubt, 'where' | 'fix'> = {};
  const where = found[0];
  if (where) out.where = where;
  const step = FIX_STEP[id];
  const storeys = ctx.project.model.storeys;
  if (step && storeys.length > 0) {
    const sheetId = where?.sheetId ?? null;
    const storey = (sheetId !== null ? storeys.find((s) => s.sheetId === sheetId) : undefined) ?? storeys[0]!;
    out.fix = { storeyId: storey.id, step };
  }
  return out;
}

/**
 * Vrai si un texte lu comme nom de pièce en est un : non vide, court, sans cote ni phrase d'annotation (« Surface
 * séjour », « Composition mur garage » sont des annotations du plan, pas des pièces).
 */
export function isRoomName(name: string | null | undefined): boolean {
  const n = norm((name ?? '').trim());
  if (n.length < 2 || n.length > 32) return false;
  if (/^(surface|flache|composition|aufbau|coupe|schnitt|facade|ansicht|mur|wand|dalle|platte|toiture|dach|plancher|boden|niveau|echelle|massstab)\b/.test(n)) return false;
  return /[a-z]/.test(n);
}

// ───────────────────────────── Contexte commun ─────────────────────────────

interface Ctx {
  reading: SheetReading | undefined;
  project: Project;
  sheets: readonly PlanSheet[];
  plans: readonly PlanSheet[];
  /** Plans des niveaux du volume chauffé (sans les sous-sols laissés hors du volume). */
  heatedPlans: readonly PlanSheet[];
  derived: ReturnType<typeof deriveSheets>;
  texts: string[];
}

function context(reading: SheetReading | undefined, project: Project, sheets: readonly PlanSheet[], derived: ReturnType<typeof deriveSheets>): Ctx {
  const plans = sheets.filter((s) => !s.role || s.role === 'floor-plan');
  // Niveaux que le modèle laisse hors du volume chauffé (sous-sol non chauffé) : c'est la question « plancher bas »
  // qui les tranche ; leurs locaux ne font pas de question à part.
  const outside = new Set((project.model.unheatedStoreys ?? []).map((s) => s.sheetId).filter((id): id is string => id !== null));
  const heatedPlans = plans.filter((s) => !outside.has(s.id));
  const texts = sheets.flatMap((s) => (s.texts ?? []).map((x) => x.text));
  return { reading, project, sheets, plans, heatedPlans, derived, texts };
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
      // Vocabulaire d'un projet sur l'existant. « Existant » seul ne compte pas : une planche de construction neuve
      // le porte souvent pour ce qui l'entoure (terrain, canalisation, immeuble voisin existants).
      const existing = ctx.texts.some((x) => /a demolir|demoli|bestand(?!teil)|abbruch|renovation|transformation|umbau|sanierung/.test(norm(x)));
      signals.push(existing ? sig('plan-text', 'strong', 'existing', 'text.existing') : sig('plan-text', 'weak', 'new', 'text.no-existing'));
    }
    if ((r?.elevations ?? []).length > 0) signals.push(sig('facade-drawing', 'weak', 'new', 'elevations.whole'));
    return { signals, applicable: true, answered: false };
  },

  attached: (ctx, lang) => {
    if (ctx.project.answers.attachment) return ANSWERED;
    const signals: Signal[] = [];
    // Géométrie : côtés mitoyens comptés par la normale EXTÉRIEURE de leur arête (indépendante du sens du contour).
    const party = partyEvidence(ctx.plans);
    // Aucun mur mitoyen lu et chaque façade porte une baie ou un isolant : bâtiment isolé, rien à demander.
    if (readsDetached(party)) return NOT_APPLICABLE;
    const partyLength = party.length;
    if (party.sawEdges) {
      const v = party.sides.size === 1 ? 'one-side' : 'other';
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
    else {
      // Composition de toiture : une dalle (béton) sans couverture ni lattis est une toiture plate ; tuiles, ardoises
      // ou lattis sur chevrons font une toiture inclinée. Signal faible : la forme n'est pas écrite.
      const roof = (r?.compositions ?? []).find((c) => c.element === 'roof');
      if (roof) {
        const has = (keys: readonly string[]) => roof.layers.some((l) => keys.includes(l.material));
        if (has(['bardage', 'bois'])) signals.push(sig('plan-text', 'weak', 'pitched', 'composition.roof-covering'));
        else if (has(['beton', 'beton-arme'])) signals.push(sig('plan-text', 'weak', 'flat', 'composition.roof-slab'));
      }
    }
    // Plan de toiture dessiné sans faîtage ni égout coté : toiture plate probable (signal faible).
    const ridge = r?.levels?.top?.role === 'ridge' || (r?.levels?.eaves ?? null) !== null || (r?.roof?.pitchDeg ?? null) !== null;
    if (hasView(ctx, 'roof-plan') && !ridge && !r?.roof?.flat) signals.push(sig('plan-geometry', 'weak', 'flat', 'roof-plan.no-ridge'));
    return { signals, applicable: true, answered: false };
  },

  bottom: (ctx) => {
    if (ctx.project.model.bottom.from === 'user') return ANSWERED;
    const r = ctx.reading;
    const signals: Signal[] = [];
    const basementPlan = (r?.views ?? []).some((v) => v.kind === 'floor-plan' && (v.storeyRank ?? 0) < 0) || ctx.sheets.some((s) => (s.storeyRank ?? 0) < 0);
    if (basementPlan) signals.push(sig('plan-geometry', 'strong', 'basement-unheated', 'view.basement'));
    const comps = r?.compositions ?? [];
    if (comps.some((c) => c.element === 'floor-on-ground')) signals.push(sig('plan-text', 'strong', 'ground', 'composition.floor-on-ground'));
    // Plancher bas décrit comme « sur local non chauffé », sans dalle sur sol : le sous-sol n'est pas chauffé.
    else if (basementPlan && comps.some((c) => c.element === 'floor-to-unheated')) signals.push(sig('plan-text', 'strong', 'basement-unheated', 'composition.floor-to-unheated'));
    if (hasView(ctx, 'section') && !basementPlan && (r?.levels?.floors[0]?.rel ?? 0) > -1) signals.push(sig('section', 'strong', 'ground', 'section.no-basement'));
    return { signals, applicable: true, answered: false };
  },

  'unheated-zone': (ctx) => {
    const zones = ctx.heatedPlans.flatMap((s) => s.detected.unheatedZones ?? []);
    const named = ctx.heatedPlans.flatMap((s) => s.detected.rooms.filter((r) => r.heatedGuess === 'no' && !r.exterior));
    if (zones.length === 0 && named.length === 0) return NOT_APPLICABLE;
    const signals: Signal[] = [];
    if (named.length > 0) signals.push(sig('plan-text', 'strong', 'unheated', 'room.name'));
    const insulated = ctx.heatedPlans.some((s) => (s.detected.heatedEdges ?? []).some((e) => e.boundary === 'unheated' && (e.sources ?? []).includes('insulation') && e.confidence >= 0.5));
    if (insulated) signals.push(sig('plan-geometry', 'strong', 'unheated', 'edges.insulation'));
    else if (zones.length > 0) signals.push(sig('plan-geometry', 'weak', 'unheated', 'zone.outline'));
    const names = [...new Set([...zones.flatMap((z) => z.names), ...named.map((r) => r.name)].map((x) => x.trim()))].filter(isRoomName);
    return {
      signals,
      applicable: true,
      answered: false,
      params: { names: names.join(', ') },
      // Aucun nom lisible : on parle de « la zone » sans inventer de nom.
      ...(names.length === 0 ? { questionKey: 'doubt.unheated-zone.questionUnnamed' } : {}),
      details: [],
      proposal: 'unheated',
    };
  },

  'an-unlabelled': (ctx, lang) => {
    const storeys = ctx.project.model.storeys;
    if (storeys.length > 0 && storeys.every((s) => s.netAreaOverride?.from === 'user')) return ANSWERED;
    let unlabelled = 0;
    let labelled = 0;
    let gross = 0;
    const perLevel: string[] = [];
    const parts: DoubtPart[] = [];
    const anBase = ctx.derived.totals.an;
    for (const s of ctx.plans) {
      const here = (s.detected.unlabelledAreas ?? []).filter((u) => u.area >= 1).reduce((a, u) => a + u.area, 0);
      unlabelled += here;
      if (here >= 1) {
        const storey = storeys.find((st) => st.sheetId === s.id);
        const level = storey?.name ?? s.name;
        const effect = anBase > 0 ? t(lang, 'doubt.an-unlabelled.effect', { area: formatNumber(here, 1), pct: pct(here / anBase) }) : null;
        perLevel.push(t(lang, 'doubt.an-unlabelled.detail', { level, area: formatNumber(here, 1) }) + (effect ? ` (${effect})` : ''));
        // Réponse niveau par niveau : seulement pour un niveau du modèle qui porte ces surfaces.
        if (storey && storey.rooms.some((r) => r.unlabelled)) parts.push({ key: storey.id, label: level, amount: here, effect });
      }
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
      // Une seule question pour tout le bâtiment : le détail par niveau dès qu'il y en a plusieurs, avec un choix
      // « compter seulement ce niveau » en plus du choix global (et la réponse niveau par niveau, `parts`).
      details: perLevel.length > 1 ? perLevel : [],
      ...(parts.length > 1
        ? {
            parts,
            options: ['include', 'exclude', ...parts.map((p) => `only:${p.key}`)],
            optionLabels: Object.fromEntries(parts.map((p) => [`only:${p.key}`, t(lang, 'doubt.an-unlabelled.option.only', { level: p.label, area: formatNumber(p.amount, 1) })])),
          }
        : {}),
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
    const named = e.value ? t(lang, `doubt.generator.${e.value}`) : '';
    const generatorLabel = named && !named.startsWith('doubt.') ? named : '';
    return {
      signals: signals.length > 0 ? signals : [sig('tool-hypothesis', 'hypothesis', 'unknown', 'heating.none')],
      applicable: true,
      answered: false,
      params: { generator: generatorLabel },
      // Rien d'écrit sur le plan (ou un mot que l'outil ne sait pas nommer) : on demande le générateur, sans en proposer un.
      ...(generatorLabel ? {} : { questionKey: 'doubt.heating.questionNone' }),
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
    for (const s of ctx.heatedPlans) {
      for (const r of s.detected.rooms) {
        if (r.heatedGuess !== 'ask' || r.exterior || !isRoomName(r.name)) continue;
        const inside = r.at && s.detected.heatedOutline && pointInPolygon(r.at, s.detected.heatedOutline);
        if (!inside) ambiguous.push(r.name);
      }
    }
    // Pièces que le modèle signale encore à trancher (relecture de l'expert pas faite).
    for (const st of ctx.project.model.storeys) for (const r of st.rooms) if (r.needsReview && !r.unlabelled && isRoomName(r.name) && !ambiguous.includes(r.name)) ambiguous.push(r.name);
    if (ambiguous.length === 0) return NOT_APPLICABLE;
    return { signals: [], applicable: true, answered: false, params: { names: ambiguous.join(', ') }, proposal: 'heated' };
  },

  'opening-heights': (ctx, lang) => {
    const detected = ctx.plans.flatMap((s) => s.detected.openings);
    const modelOpenings = ctx.project.model.storeys.flatMap((s) => s.openings) as OpeningHeights[];
    if (detected.length === 0 && modelOpenings.length === 0) return NOT_APPLICABLE;
    // Hauteur écrite sur le plan et hauteur vue en façade qui diffèrent de plus de 5 cm : UNE question de convention
    // pour tout le projet, appliquée à toutes les baies concernées.
    const split = modelOpenings.filter((o) => o.heightPlan !== undefined && o.heightElevation !== undefined && Math.abs(o.heightPlan - o.heightElevation) > HEIGHT_CONVENTION_GAP + 1e-9 && heightFromOf(o) !== 'user');
    if (split.length > 0) {
      const n = split.reduce((a, o) => a + o.count, 0);
      const gaps = split.map((o) => Math.abs(o.heightPlan! - o.heightElevation!) * 100);
      return {
        signals: [sig('plan-text', 'strong', 'plan', 'openings.height-plan'), sig('facade-drawing', 'strong', 'elevation', 'openings.height-elevation')],
        applicable: true,
        answered: false,
        params: { count: n, gap: formatNumber(Math.max(...gaps), 0) },
        questionKey: 'doubt.opening-heights.questionConvention',
        options: ['plan', 'plan+5', 'elevation'],
        proposal: 'plan',
        details: [t(lang, 'doubt.opening-heights.detail.convention', { count: n, gap: formatNumber(Math.max(...gaps), 0) })],
      };
    }
    // Fenêtres dont la hauteur est une valeur d'usage (les portes gardent leur hauteur de porte, étiquetée hypothèse).
    const windows = modelOpenings.filter((o) => o.kind === 'window');
    if (windows.length > 0 && windows.every((o) => heightFromOf(o) === 'user')) return ANSWERED;
    const guessedModel = windows.filter((o) => heightFromOf(o) === 'default');
    const guessedDetected = modelOpenings.length > 0 ? [] : detected.filter((o) => o.kind !== 'door' && (o.exterior !== false || o.toUnheated === true) && (o.heightFrom === 'default' || o.height === undefined));
    const guessed = guessedModel.reduce((a, o) => a + o.count, 0) + guessedDetected.length;
    // Des hauteurs d'usage : rien ne les soutient, la question est posée — sauf si ces baies pèsent moins de 1 %
    // de l'enveloppe : la valeur reste étiquetée hypothèse dans le relevé.
    const env = ctx.derived.totals.envelopeArea;
    const guessedArea =
      guessedModel.reduce((a, o) => a + o.width * o.height * o.count, 0) + guessedDetected.reduce((a, o) => a + (o.width ?? 1) * (o.height ?? 1.25), 0);
    const minor = env > 0 && guessedArea / env < 0.01;
    if (guessed > 0 && !minor) return { signals: [], applicable: true, answered: false, params: { count: guessed } };
    if (guessed > 0) return NOT_APPLICABLE;
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
