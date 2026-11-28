/**
 * Parcours AUTOMATIQUE (logique pure, sans React) : ce que l'écran « Voici ce que j'ai lu » montre, d'où vient chaque
 * donnée et à quel point elle est sûre, où la montrer sur la planche, et comment les questions de doute du moteur
 * (engine/doubts) deviennent des cartes : réponse proposée, « pourquoi je demande », temps estimé, extrait, outil du
 * plan pour « corriger sur le plan ».
 *
 * Confiance lisible, quatre états plus « vous » (mêmes paliers que core/reading.ts) :
 *   crossChecked  lu et recoupé : confiance ≥ 0,85 (deux signaux indépendants concordent) ;
 *   read          lu : une source, ou un calcul fait sur des valeurs lues ;
 *   assumption    hypothèse : rien sur la planche, valeur d'usage de l'outil (provenance « default » / « estimate ») ;
 *   missing       manquant : rien de lu ni de proposé ;
 *   user          vous : saisi ou confirmé par l'expert (provenance « user », ou réponse à une question).
 * Une donnée liée à une question de doute encore ouverte est en plus marquée « à vérifier ».
 */
import { SHEETS_625 } from '../../core/cpe';
import type { DossierSheetKey, LuxeebElementType } from '../../core/cpe';
import type { ElementType, Read, ReadView, SheetReading, ViewKind } from '../../core/reading';
import type { BBox, Lang, LuxeebSheets, PlanSheet, Project, Provenance, Sourced, Vec2 } from '../../core/types';
import { evaluate } from '../../engine';
import type { Doubt, DoubtId } from '../../engine';
import { formatNumber, t } from '../../i18n';
import type { Marks, PlanStepKey, ReadingStage, ReadingStageKey } from './types';
import { READING_STAGES } from './types';

// ───────────────────────────── Confiance lisible ─────────────────────────────

export type Trust = 'crossChecked' | 'read' | 'assumption' | 'missing' | 'user';
export const TRUSTS: readonly Trust[] = ['crossChecked', 'read', 'assumption', 'missing', 'user'];

/** Palier « lu et recoupé » du contrat de lecture. */
const CROSS_CHECKED = 0.85;

/** Confiance d'une valeur sourcée du projet. Une valeur sans confiance mesurée et lue sur le plan reste « lu ». */
export function trustOfSourced(s: Pick<Sourced<unknown>, 'from' | 'confidence'> | null | undefined): Trust {
  if (!s) return 'missing';
  return trustOfProvenance(s.from, s.confidence);
}

export function trustOfProvenance(from: Provenance | null, confidence?: number | null): Trust {
  if (from === null) return 'missing';
  if (from === 'user') return 'user';
  if (from === 'default' || from === 'estimate') return 'assumption';
  return confidence !== undefined && confidence !== null && confidence >= CROSS_CHECKED ? 'crossChecked' : 'read';
}

/** Confiance d'une lecture : 0 = hypothèse de l'outil, ≥ 0,85 recoupé, sinon lu. */
export function trustOfRead(r: Pick<Read<unknown>, 'confidence'> | null | undefined): Trust {
  if (!r) return 'missing';
  if (r.confidence <= 0) return 'assumption';
  return r.confidence >= CROSS_CHECKED ? 'crossChecked' : 'read';
}

/** La plus faible de plusieurs confiances (une seule hypothèse suffit à faire une hypothèse). */
export function weakestTrust(list: readonly Trust[]): Trust {
  if (list.length === 0) return 'missing';
  const rank: Record<Trust, number> = { missing: 0, assumption: 1, read: 2, crossChecked: 3, user: 4 };
  return list.reduce((a, b) => (rank[b] < rank[a] ? b : a));
}

// ───────────────────────────── Endroits sur la planche ─────────────────────────────

/** Où une donnée a été lue : page (à partir de 1), boîte en unités de feuille (points PDF), vue qui la contient. */
export interface Anchor {
  page: number;
  box: BBox;
  viewId: string | null;
}

const PAD = 12;

export function sameAnchor(a: Anchor | null | undefined, b: Anchor | null | undefined): boolean {
  if (!a || !b) return false;
  return a.page === b.page && a.viewId === b.viewId && a.box.minX === b.box.minX && a.box.minY === b.box.minY && a.box.maxX === b.box.maxX && a.box.maxY === b.box.maxY;
}

function boxOfPoints(points: readonly Vec2[], pad = 0): BBox | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

const validBox = (b: BBox | null | undefined): b is BBox =>
  !!b && [b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) && b.maxX > b.minX && b.maxY > b.minY;

const contains = (outer: BBox, inner: BBox): boolean => inner.minX >= outer.minX - 1 && inner.minY >= outer.minY - 1 && inner.maxX <= outer.maxX + 1 && inner.maxY <= outer.maxY + 1;

/** Vue de la planche qui contient une boîte (la plus petite), ou null. */
export function viewAt(views: readonly ReadView[], page: number, box: BBox): ReadView | null {
  const inside = views.filter((v) => v.page === page && validBox(v.box) && contains(v.box, box));
  inside.sort((a, b) => area(a.box) - area(b.box));
  return inside[0] ?? null;
}

const area = (b: BBox): number => (b.maxX - b.minX) * (b.maxY - b.minY);

function anchor(reading: SheetReading | undefined, page: number | null | undefined, box: BBox | null | undefined, viewId?: string | null): Anchor | null {
  if (!validBox(box)) return null;
  const p = page ?? 1;
  return { page: p, box, viewId: viewId ?? (reading ? (viewAt(reading.views, p, box)?.id ?? null) : null) };
}

function viewAnchor(reading: SheetReading | undefined, kinds: readonly ViewKind[], pick?: (v: ReadView) => boolean): Anchor | null {
  const view = (reading?.views ?? []).find((v) => kinds.includes(v.kind) && (!pick || pick(v)));
  if (!view) return null;
  return anchor(reading, view.page, view.buildingBox ?? view.box, view.id);
}

function pointAnchor(reading: SheetReading | undefined, page: number, at: Vec2, viewId: string | null, half = 24): Anchor | null {
  return anchor(reading, page, { minX: at.x - half, minY: at.y - half, maxX: at.x + half, maxY: at.y + half }, viewId);
}

/** Feuille (vue en plan) d'un identifiant, avec sa page. */
function sheetAnchor(reading: SheetReading | undefined, sheets: readonly PlanSheet[], sheetId: string | null, box?: BBox | null): Anchor | null {
  if (!sheetId) return null;
  const sheet = sheets.find((s) => s.id === sheetId);
  if (!sheet) return null;
  const view = (reading?.views ?? []).find((v) => v.sheetId === sheetId);
  if (box) return anchor(reading, sheet.page ?? view?.page ?? 1, box, view?.id ?? null);
  if (view) return anchor(reading, view.page, view.buildingBox ?? view.box, view.id);
  return anchor(reading, sheet.page ?? 1, sheet.bbox, null);
}

const COMPOSITION_OF: Partial<Record<LuxeebElementType, ElementType[]>> = {
  aussenwand: ['external-wall'],
  'wand-unbeheizt': ['wall-to-unheated'],
  kellerwand: ['wall-to-ground'],
  dach: ['roof'],
  geschossdecke: ['ceiling-to-unheated'],
  bodenplatte: ['floor-on-ground'],
  'boden-aussen': ['floor-to-outside'],
  kellerdecke: ['floor-to-unheated'],
};

function compositionAnchor(reading: SheetReading | undefined, elements: readonly ElementType[]): Anchor | null {
  for (const c of reading?.compositions ?? []) {
    if (!elements.includes(c.element)) continue;
    for (const o of c.occurrences) {
      const a = anchor(reading, o.page, o.box, o.viewId);
      if (a) return a;
    }
  }
  return null;
}

/** Endroit de la planche qui appuie une question de doute ; null si aucun endroit précis n'est connu. */
export function doubtAnchor(id: DoubtId, reading: SheetReading | undefined, sheets: readonly PlanSheet[]): Anchor | null {
  const r = reading;
  const plans = sheets.filter((s) => !s.role || s.role === 'floor-plan');
  const tb = r?.titleBlock ? anchor(r, r.titleBlock.page, r.titleBlock.box) : null;
  switch (id) {
    case 'occasion':
    case 'building-type':
    case 'year':
    case 'identity':
    case 'scale':
      return tb;
    case 'north':
      return r?.north ? anchor(r, r.north.page, r.north.box) : null;
    case 'materials':
      return compositionAnchor(r, ['external-wall', 'wall-to-unheated', 'roof', 'floor-on-ground', 'floor-to-unheated', 'floor-to-outside', 'ceiling-to-unheated', 'wall-to-ground']);
    case 'bottom':
      return compositionAnchor(r, ['floor-on-ground', 'floor-to-unheated']) ?? viewAnchor(r, ['section']);
    case 'top':
    case 'renewables':
      return viewAnchor(r, ['roof-plan']) ?? viewAnchor(r, ['section']);
    case 'heights':
      return viewAnchor(r, ['section']);
    case 'openings':
    case 'opening-heights':
    case 'windows':
      return viewAnchor(r, ['elevation']);
    case 'heating': {
      const e = (r?.equipment ?? []).find((x) => x.kind === 'heat-pump') ?? (r?.equipment ?? []).find((x) => x.kind === 'hot-water-tank' || x.kind === 'boiler');
      return e ? pointAnchor(r, e.page, e.at, e.viewId) : null;
    }
    case 'ventilation': {
      const e = (r?.equipment ?? []).find((x) => x.kind === 'ventilation-unit');
      return e ? pointAnchor(r, e.page, e.at, e.viewId) : null;
    }
    case 'an-unlabelled': {
      for (const s of plans) {
        const u = (s.detected.unlabelledAreas ?? []).find((x) => x.area >= 1 && x.polygon && x.polygon.length >= 3);
        if (u?.polygon) return sheetAnchor(r, sheets, s.id, boxOfPoints(u.polygon, PAD));
      }
      return plans[0] ? sheetAnchor(r, sheets, plans[0].id) : null;
    }
    case 'unheated-zone': {
      for (const s of plans) {
        const z = (s.detected.unheatedZones ?? []).find((x) => x.polygon.length >= 3);
        if (z) return sheetAnchor(r, sheets, s.id, boxOfPoints(z.polygon, PAD));
      }
      return null;
    }
    case 'room-heated': {
      for (const s of plans) {
        const room = s.detected.rooms.find((x) => x.heatedGuess === 'ask' && !x.exterior && (x.polygon || x.at));
        if (room) return sheetAnchor(r, sheets, s.id, room.polygon ? boxOfPoints(room.polygon, PAD) : boxOfPoints([room.at!], 40));
      }
      return null;
    }
    case 'attached':
      return viewAnchor(r, ['floor-plan']);
    case 'thermal-bridges':
      return null;
  }
}

// ───────────────────────────── Questions de doute → cartes ─────────────────────────────

/** Empreinte d'une question : si la relecture ou une correction change ce qui est proposé, la question revient. */
export function doubtStamp(d: Pick<Doubt, 'id' | 'proposal' | 'options'>): string {
  return `${d.id}|${d.proposal?.value ?? ''}|${d.options.map((o) => o.value).join(',')}`;
}

/** Vrai si la question a reçu une réponse qui vaut encore (même empreinte). */
export function isAnswered(d: Doubt, marks: Pick<Marks, 'doubts'>): boolean {
  return marks.doubts?.[d.id]?.stamp === doubtStamp(d);
}

/** Questions encore ouvertes, dans l'ordre du moteur. */
export function openDoubts(all: readonly Doubt[], marks: Pick<Marks, 'doubts'>): Doubt[] {
  return all.filter((d) => !isAnswered(d, marks));
}

/** Choix proposés : ceux du moteur, et la proposition en tête si elle n'en fait pas partie (année lue, valeur d'usage). */
export function choicesOf(d: Doubt): { value: string; label: string }[] {
  const options = [...d.options];
  if (d.proposal && !options.some((o) => o.value === d.proposal!.value)) options.unshift(d.proposal);
  return options;
}

/** Saisie attendue quand il n'y a rien à choisir. */
export function inputKindOf(d: Doubt): 'number' | 'text' | null {
  if (choicesOf(d).length > 0) return null;
  if (d.id === 'year' || d.id === 'heights') return 'number';
  if (d.id === 'identity') return 'text';
  return null;
}

/** Étape de l'éditeur de plan où la donnée se corrige ; null si elle ne se corrige pas sur le plan. */
export function fixStepOf(id: DoubtId): PlanStepKey | null {
  switch (id) {
    case 'scale':
      return 'scale';
    case 'heights':
      return 'height';
    case 'openings':
    case 'opening-heights':
      return 'opening';
    case 'north':
      return 'north';
    case 'unheated-zone':
    case 'attached':
      return 'boundary';
    case 'an-unlabelled':
    case 'room-heated':
      return 'rooms';
    default:
      return null;
  }
}

/** Question qui ne porte que sur des valeurs d'usage (rien sur aucun plan) : elle se confirme d'un geste. */
export const isUsual = (d: Pick<Doubt, 'grouped'>): boolean => d.grouped;

/** « Pourquoi je demande », d'après les signaux du moteur. */
export function whyOf(d: Doubt): string {
  if (d.grouped) return 'shell.doubt.why.notOnPlan';
  const real = d.signals.filter((s) => s.strength !== 'hypothesis');
  if (real.length === 0) return d.signals.length > 0 ? 'shell.doubt.why.assumption' : 'shell.doubt.why.nothing';
  const e = evaluate(d.signals);
  if (e.contradictions.length > 0) return 'shell.doubt.why.conflict';
  return new Set(e.support.filter((s) => s.strength !== 'hypothesis').map((s) => s.group)).size >= 2 ? 'shell.doubt.why.weak' : 'shell.doubt.why.single';
}

/**
 * Temps estimé d'une carte (s) : choix 15, saisie 20, correction sur le plan 45, question regroupée 10 + 6 par ligne.
 * Estimation de conception, pas une mesure.
 */
export function secondsOf(d: Doubt): number {
  if (d.grouped) return 10 + 6 * Math.max(1, d.details.length);
  if (choicesOf(d).length > 0) return 15;
  if (inputKindOf(d)) return 20;
  return fixStepOf(d.id) ? 45 : 15;
}

export function budget(list: readonly Doubt[]): { count: number; seconds: number; minutes: number } {
  const seconds = list.reduce((n, d) => n + secondsOf(d), 0);
  return { count: list.length, seconds, minutes: Math.max(1, Math.ceil(seconds / 60)) };
}

/** Feuille de LuxEeB-Tool d'une question, avec son titre dans l'outil. */
export function sheetOf(key: DossierSheetKey, lang: Lang): { title: string; luxeeb: string } {
  const info = SHEETS_625.find((s) => s.key === key);
  return { title: info ? (lang === 'de' ? info.de : info.fr) : key, luxeeb: info?.de ?? key };
}

/**
 * Valeur à envoyer pour « confirmer » une question : la proposition, sinon (question regroupée sans proposition,
 * données de bibliothèque) le mot « confirm ». Voir le rapport : le contrat n'a pas de valeur dédiée.
 */
export const CONFIRM_VALUE = 'confirm';
export function confirmValueOf(d: Doubt): string {
  return d.proposal?.value ?? CONFIRM_VALUE;
}

/**
 * Paquet de cartes de la session : les questions déjà vues (dans l'ordre où elles sont venues), mises à jour par
 * les questions encore ouvertes, puis les nouvelles. Une question répondue que le moteur ne pose plus reste dans le
 * paquet (pour « précédent »), avec son dernier texte connu.
 */
export function mergeDeck(seen: readonly Doubt[], current: readonly Doubt[]): Doubt[] {
  const fresh = new Map(current.map((d) => [d.id, d]));
  const out = seen.map((d) => fresh.get(d.id) ?? d);
  for (const d of current) if (!seen.some((s) => s.id === d.id)) out.push(d);
  return out;
}

// ───────────────────────────── Progression de la lecture ─────────────────────────────

export function pendingStages(): ReadingStage[] {
  return READING_STAGES.map((key, i) => ({ key, status: i === 0 ? 'running' : 'pending' }));
}

export function setStage(stages: readonly ReadingStage[], key: ReadingStageKey, status: ReadingStage['status'], detail?: ReadingStage['detail']): ReadingStage[] {
  return stages.map((s) => (s.key === key ? (detail ? { key, status, detail } : { ...s, status }) : s));
}

/** Ce que chaque étape a trouvé, d'après le document lu (les mêmes chiffres que l'écran « lu »). */
export function stageDetails(doc: { sheets: readonly PlanSheet[]; reading?: SheetReading; kind: string }): Record<Exclude<ReadingStageKey, 'doubts'>, ReadingStage['detail'] | null> {
  const r = doc.reading;
  const pages = new Set(doc.sheets.map((s) => s.page ?? 1)).size || 1;
  const views = r?.views ?? [];
  const count = (k: ViewKind): number => views.filter((v) => v.kind === k).length;
  const plans = doc.sheets.filter((s) => !s.role || s.role === 'floor-plan');
  const rooms = plans.reduce((n, s) => n + s.detected.rooms.filter((x) => !x.exterior).length, 0);
  const unheated = plans.reduce((n, s) => n + (s.detected.unheatedZones ?? []).length, 0);
  const fp = plans.map((s) => s.detected.footprintSize).find((f) => f && f.width > 0 && f.depth > 0);
  return {
    open: { key: 'shell.reading.detail.open', params: { pages } },
    views: views.length > 0
      ? { key: 'shell.reading.detail.views', params: { plans: count('floor-plan') + count('roof-plan'), sections: count('section'), elevations: count('elevation'), other: views.length - count('floor-plan') - count('roof-plan') - count('section') - count('elevation') } }
      : null,
    rooms: rooms > 0 ? { key: 'shell.reading.detail.rooms', params: { rooms, plans: plans.length } } : null,
    envelope: fp
      ? { key: unheated > 0 ? 'shell.reading.detail.envelopeUnheated' : 'shell.reading.detail.envelope', params: { width: formatNumber(fp.width, 2), depth: formatNumber(fp.depth, 2), unheated } }
      : null,
    layers: (r?.compositions ?? []).length > 0 ? { key: 'shell.reading.detail.layers', params: { count: r!.compositions.length } } : null,
    check: r?.levels ? { key: 'shell.reading.detail.check', params: { checked: r.levels.checks.checked } } : null,
  };
}

// ───────────────────────────── Écran « Voici ce que j'ai lu » ─────────────────────────────

/** Groupes, dans l'ordre des feuilles de LuxEeB-Tool. */
export type OverviewGroup = 'project' | 'areas' | 'envelope' | 'layers' | 'windows' | 'systems';
export const OVERVIEW_GROUPS: readonly OverviewGroup[] = ['project', 'areas', 'envelope', 'layers', 'windows', 'systems'];

export interface OverviewField {
  id: string;
  group: OverviewGroup;
  /** Libellé déjà traduit. */
  label: string;
  /** Terme de LuxEeB-Tool, montré en petit (allemand de l'outil). */
  term?: string;
  /** Valeur affichée ; '' = manquante. */
  value: string;
  trust: Trust;
  /** Une question de doute encore ouverte porte sur cette donnée. */
  doubt: DoubtId | null;
  anchor: Anchor | null;
}

export interface OverviewInput {
  project: Project;
  derived: LuxeebSheets | null;
  reading: SheetReading | undefined;
  sheets: readonly PlanSheet[];
  /** Questions encore ouvertes. */
  open: readonly Doubt[];
  marks: Pick<Marks, 'doubts'>;
  lang: Lang;
}

const m2 = (v: number): string => `${formatNumber(v, 2)} m²`;

/** Les données lues, groupées comme les feuilles de LuxEeB-Tool. */
export function overviewFields(input: OverviewInput): OverviewField[] {
  const { project, derived, reading: r, sheets, open, marks, lang } = input;
  const tr = (key: string, params?: Record<string, string | number>): string => t(lang, key, params);
  const a = project.answers;
  const model = project.model;
  const out: OverviewField[] = [];
  const openIds = new Set(open.map((d) => d.id));
  const answered = (id: DoubtId | null): boolean => id !== null && marks.doubts?.[id] !== undefined && !openIds.has(id);
  const proposalOf = (id: DoubtId): Doubt | undefined => open.find((d) => d.id === id && d.proposal);
  const tb = r?.titleBlock ?? null;
  const tbAnchor = tb ? anchor(r, tb.page, tb.box) : null;

  const push = (f: Omit<OverviewField, 'doubt' | 'trust'> & { trust: Trust; doubt?: DoubtId | null }): void => {
    const doubt = f.doubt ?? null;
    let trust = f.trust;
    if (answered(doubt) && trust !== 'missing') trust = 'user';
    out.push({ ...f, trust, doubt: doubt !== null && openIds.has(doubt) ? doubt : null });
  };

  /** Réponse du projet, recoupée avec la lecture du cartouche ; sans réponse, la proposition du moteur (hypothèse). */
  const answer = (id: string, group: OverviewGroup, labelKey: string, term: string, value: string | null, read: Pick<Read<unknown>, 'confidence'> | null | undefined, doubt: DoubtId | null, where: Anchor | null): void => {
    if (value) {
      // Sans lecture qui l'appuie (projet repris sans la planche, réponse d'une autre source) : « lu », jamais « recoupé ».
      push({ id, group, label: tr(labelKey), term, value, trust: read ? trustOfRead(read) : 'read', doubt, anchor: where });
      return;
    }
    const proposed = doubt ? proposalOf(doubt) : undefined;
    push({ id, group, label: tr(labelKey), term, value: proposed?.proposal?.label ?? '', trust: proposed ? 'assumption' : 'missing', doubt, anchor: where });
  };

  // ── Projet (Allgemeine Projektdaten) ──
  const designation = a.projectName.trim() || tb?.project || '';
  push({ id: 'designation', group: 'project', label: tr('shell.ov.f.designation'), term: 'Bezeichnung', value: designation, trust: designation ? (tb?.project ? trustOfRead({ confidence: tb.confidence }) : 'read') : 'missing', doubt: 'identity', anchor: tbAnchor });
  const address = [a.street.trim(), `${a.postcode} ${a.locality}`.trim()].filter(Boolean).join(', ');
  push({ id: 'address', group: 'project', label: tr('shell.ov.f.address'), term: 'Straße, PLZ, Ort', value: address, trust: address ? (tb?.street ? trustOfRead({ confidence: tb.confidence }) : 'read') : 'missing', doubt: 'identity', anchor: tbAnchor });
  answer('buildingType', 'project', 'shell.ov.f.buildingType', 'Gebäudetyp', a.buildingType ? tr(`shell.q.buildingType.${a.buildingType}`) : null, tb?.buildingType, 'building-type', tbAnchor);
  answer('occasion', 'project', 'shell.ov.f.occasion', 'Nachweisart', a.occasion ? tr(`shell.q.occasion.${a.occasion}`) : null, tb?.occasion, 'occasion', tbAnchor);
  answer('year', 'project', 'shell.ov.f.year', 'Baujahr', a.yearBuilt !== null ? String(a.yearBuilt) : null, tb?.year ? { confidence: tb.confidence } : null, 'year', tbAnchor);
  if (a.dwellings !== null || tb?.dwellings) answer('dwellings', 'project', 'shell.ov.f.dwellings', 'Wohneinheiten', a.dwellings !== null ? String(a.dwellings) : null, tb?.dwellings, null, tbAnchor);
  const floorViews = (r?.views ?? []).filter((v) => v.kind === 'floor-plan');
  if (model.storeys.length > 0) {
    const levels = r?.levels?.floors.length ?? 0;
    const agree = floorViews.length === model.storeys.length && levels >= model.storeys.length;
    push({ id: 'storeys', group: 'project', label: tr('shell.ov.f.storeys'), term: 'Anzahl Geschosse', value: String(model.storeys.length), trust: agree ? 'crossChecked' : 'read', anchor: viewAnchor(r, ['floor-plan']) });
  }
  answer('attachment', 'project', 'shell.ov.f.attachment', 'Anbausituation', a.attachment ? tr(`shell.ov.attachment.${a.attachment}`) : null, null, 'attached', viewAnchor(r, ['floor-plan']));

  // ── Surfaces chauffées An par niveau (Energiebezugsflächen / Zonen) ──
  for (const st of model.storeys) {
    const zone = derived?.zones.find((z) => z.storeyId === st.id);
    const heated = st.rooms.filter((x) => x.heated);
    const trust = st.netAreaOverride
      ? trustOfSourced(st.netAreaOverride)
      : heated.length === 0
        ? 'missing'
        : weakestTrust(heated.map((x) => trustOfSourced(x.area)));
    const value = zone ? tr('shell.ov.v.zone', { area: m2(zone.area), rooms: heated.length }) : '';
    push({ id: `zone:${st.id}`, group: 'areas', label: st.name, term: 'Zone', value, trust: value ? trust : 'missing', doubt: openIds.has('an-unlabelled') ? 'an-unlabelled' : 'room-heated', anchor: sheetAnchor(r, sheets, st.sheetId) });
  }
  if (derived && derived.totals.an > 0) {
    push({ id: 'an', group: 'areas', label: tr('shell.ov.f.an'), term: 'Energiebezugsfläche An', value: m2(derived.totals.an), trust: weakestTrust(out.filter((f) => f.group === 'areas').map((f) => f.trust)), doubt: 'an-unlabelled', anchor: null });
  }

  // ── Enveloppe (Flächeneingabe der Gebäudehülle, Ve) ──
  const first = model.storeys[0];
  if (first) {
    const sheet = sheets.find((s) => s.id === first.sheetId);
    const fp = sheet?.detected.footprintSize;
    const mpu = first.metresPerUnit.value;
    const ob = boxOfPoints(first.outline);
    const size = fp && fp.width > 0 ? `${formatNumber(fp.width, 2)} × ${formatNumber(fp.depth, 2)} m` : ob && mpu > 0 ? `${formatNumber((ob.maxX - ob.minX) * mpu, 2)} × ${formatNumber((ob.maxY - ob.minY) * mpu, 2)} m` : '';
    const conf = fp?.confidence ?? sheet?.detected.outlineConfidence;
    push({ id: 'footprint', group: 'envelope', label: tr('shell.ov.f.footprint'), term: 'Gebäudehülle', value: size, trust: size ? (first.outline.length >= 3 ? trustOfProvenance('plan', conf) : 'missing') : 'missing', doubt: 'scale', anchor: sheetAnchor(r, sheets, first.sheetId) });
    push({
      id: 'heights',
      group: 'envelope',
      label: tr('shell.ov.f.heights'),
      term: 'Geschosshöhe',
      value: model.storeys.map((s) => `${formatNumber(s.grossHeight.value, 2)} m`).join(' · '),
      trust: weakestTrust(model.storeys.map((s) => trustOfSourced(s.grossHeight))),
      doubt: 'heights',
      anchor: viewAnchor(r, ['section']),
    });
  }
  const topReads = [r?.roof?.flat ?? null, r?.levels?.top ?? null].filter((x) => x !== null && x.confidence >= 0.65);
  push({
    id: 'top',
    group: 'envelope',
    label: tr('shell.ov.f.top'),
    term: 'Dach',
    value: tr(`shell.top.${model.top.kind}`),
    trust: model.top.from === 'user' ? 'user' : model.top.from === 'default' || model.top.from === 'estimate' ? 'assumption' : topReads.length >= 2 ? 'crossChecked' : 'read',
    doubt: 'top',
    anchor: viewAnchor(r, ['roof-plan']) ?? viewAnchor(r, ['section']),
  });
  const ground = (r?.compositions ?? []).some((c) => c.element === 'floor-on-ground');
  const section = (r?.views ?? []).some((v) => v.kind === 'section');
  push({
    id: 'bottom',
    group: 'envelope',
    label: tr('shell.ov.f.bottom'),
    term: 'Bodenplatte',
    value: tr(`shell.bottom.${model.bottom.kind}`),
    trust: model.bottom.from === 'user' ? 'user' : model.bottom.from === 'default' || model.bottom.from === 'estimate' ? 'assumption' : ground && section ? 'crossChecked' : 'read',
    doubt: 'bottom',
    anchor: compositionAnchor(r, ['floor-on-ground', 'floor-to-unheated']) ?? viewAnchor(r, ['section']),
  });
  const plans = sheets.filter((s) => !s.role || s.role === 'floor-plan');
  const unheatedNames = [...new Set(plans.flatMap((s) => (s.detected.unheatedZones ?? []).flatMap((z) => z.names)))].filter(Boolean);
  if (unheatedNames.length > 0) {
    const insulated = plans.some((s) => (s.detected.heatedEdges ?? []).some((e) => e.boundary === 'unheated' && (e.sources ?? []).includes('insulation')));
    push({ id: 'unheated', group: 'envelope', label: tr('shell.ov.f.unheated'), term: 'unbeheizt', value: unheatedNames.join(', '), trust: insulated ? 'crossChecked' : 'read', doubt: 'unheated-zone', anchor: doubtAnchor('unheated-zone', r, sheets) });
  }
  if (model.storeys.length > 0 || r?.north) {
    const az = ((model.northAngle.value % 360) + 360) % 360;
    push({ id: 'north', group: 'envelope', label: tr('shell.ov.f.north'), term: 'Orientierung', value: tr('shell.ov.v.north', { angle: formatNumber(az, 0) }), trust: trustOfSourced(model.northAngle), doubt: 'north', anchor: r?.north ? anchor(r, r.north.page, r.north.box) : null });
  }
  if (derived && derived.totals.envelopeArea > 0) {
    const rows = derived.envelope.filter((x) => !x.deduct);
    push({ id: 'envelopeArea', group: 'envelope', label: tr('shell.ov.f.envelopeArea'), term: 'A', value: m2(derived.totals.envelopeArea), trust: weakestTrust(rows.map((x) => trustOfProvenance(x.from === 'calc' ? 'plan' : x.from))), anchor: null });
  }
  if (derived && derived.totals.ve > 0) {
    push({ id: 've', group: 'envelope', label: tr('shell.ov.f.ve'), term: 'Ve', value: `${formatNumber(derived.totals.ve, 1)} m³`, trust: trustOfProvenance(derived.totals.veFrom === 'calc' ? 'plan' : derived.totals.veFrom), anchor: viewAnchor(r, ['section']) });
  }

  // ── Parois et couches (Berechnung der U-Werte von Bauteilen) ──
  const usedConstructions = derived ? derived.constructions : [];
  const seen = new Set<string>();
  for (const c of usedConstructions) {
    if (c.category === 'door' || seen.has(c.constructionId)) continue;
    seen.add(c.constructionId);
    const full = model.constructions.find((x) => x.id === c.constructionId);
    const layers = full?.layers ?? [];
    const thickness = layers.reduce((s, l) => s + (l.thicknessCm?.value ?? 0), 0);
    const u = c.u ? formatNumber(c.u.value, 3) : null;
    const value = layers.length > 0
      ? tr('shell.ov.v.layers', { count: layers.length, cm: formatNumber(thickness, 1), u: u ?? '–' })
      : u
        ? tr('shell.ov.v.u', { u })
        : '';
    const thickTrust = layers.length > 0 ? weakestTrust(layers.map((l) => trustOfSourced(l.thicknessCm))) : trustOfSourced(c.u);
    const type = full?.luxeebType;
    push({ id: `wall:${c.constructionId}`, group: 'layers', label: c.name, term: 'Bauteil', value, trust: value ? thickTrust : 'missing', anchor: compositionAnchor(r, type ? (COMPOSITION_OF[type] ?? []) : []) });
  }
  const lambdas = model.constructions.flatMap((c) => (c.layers ?? []).map((l) => l.lambda)).filter((x): x is Sourced<number> => !!x);
  if (lambdas.length > 0 || openIds.has('materials')) {
    push({ id: 'lambda', group: 'layers', label: tr('shell.ov.f.lambda'), term: 'λ [W/(mK)]', value: lambdas.length > 0 ? tr('shell.ov.v.lambda', { count: lambdas.length }) : '', trust: lambdas.length > 0 ? weakestTrust(lambdas.map(trustOfSourced)) : 'missing', doubt: 'materials', anchor: null });
  }

  // ── Fenêtres et portes (transparente Bauteile, Eigene Angaben) ──
  for (const w of derived?.windows ?? []) {
    const type = model.windowTypes.find((x) => x.id === w.windowTypeId);
    const fromOpenings = model.storeys.flatMap((s) => s.openings.filter((o) => o.windowTypeId === w.windowTypeId || (o.windowTypeId === null && o.kind === 'window')));
    const trust = type?.geometry ? trustOfProvenance('plan', type.geometry.fensterTyp.confidence) : fromOpenings.length > 0 ? weakestTrust(fromOpenings.map((o) => trustOfProvenance(o.from))) : 'read';
    push({ id: `window:${w.windowTypeId}`, group: 'windows', label: w.name, term: 'Fenster', value: tr('shell.ov.v.window', { count: w.count, width: formatNumber(w.typicalWidth, 2), height: formatNumber(w.typicalHeight, 2), area: m2(w.area) }), trust, doubt: 'opening-heights', anchor: viewAnchor(r, ['elevation']) });
  }
  const glazing = model.windowTypes.find((w) => w.ug || w.uw || w.g);
  if (glazing || openIds.has('windows')) {
    const parts = glazing ? [glazing.ug ? `Ug ${formatNumber(glazing.ug.value, 2)}` : null, glazing.uf ? `Uf ${formatNumber(glazing.uf.value, 2)}` : null, glazing.uw && !glazing.ug ? `Uw ${formatNumber(glazing.uw.value, 2)}` : null, glazing.g ? `g ${formatNumber(glazing.g.value, 2)}` : null].filter(Boolean) : [];
    const trust = glazing ? weakestTrust([glazing.ug, glazing.uf, glazing.uw, glazing.g].filter((x): x is Sourced<number> => !!x).map(trustOfSourced)) : 'missing';
    push({ id: 'glazing', group: 'windows', label: tr('shell.ov.f.glazing'), term: 'Ug · Uf · g', value: parts.join(' · '), trust: parts.length > 0 ? trust : 'missing', doubt: 'windows', anchor: null });
  }
  const doors = model.constructions.filter((c) => c.category === 'door' && usedConstructions.some((u) => u.constructionId === c.id));
  if (doors.length > 0) {
    push({ id: 'doors', group: 'windows', label: tr('shell.ov.f.doors'), term: 'Eigene Angaben', value: doors.map((d) => (d.u ? `${d.name} U ${formatNumber(d.u.value, 2)}` : d.name)).join(' · '), trust: weakestTrust(doors.map((d) => trustOfSourced(d.u))), doubt: 'windows', anchor: null });
  }

  // ── Installations (Lüftung, Heizung, Warmwasser, sonstige Parameter) ──
  const sys = r?.systems ?? null;
  const heatAnchor = doubtAnchor('heating', r, sheets);
  answer('heating', 'systems', 'shell.ov.f.heating', 'Wärmeerzeuger', a.heatGenerator ? tr(`shell.q.generator.${a.heatGenerator}`) : null, sys?.heatGenerator, 'heating', heatAnchor);
  answer('hotWater', 'systems', 'shell.ov.f.hotWater', 'Warmwasser', a.hotWater ? tr(`shell.q.hotWaterKind.${a.hotWater}`) : null, sys?.hotWater, 'heating', heatAnchor);
  answer('ventilation', 'systems', 'shell.ov.f.ventilation', 'Lüftung', a.ventilation ? tr(`shell.q.ventilationKind.${a.ventilation}`) : null, sys?.ventilation, 'ventilation', doubtAnchor('ventilation', r, sheets));
  answer('bridges', 'systems', 'shell.ov.f.bridges', 'Wärmebrücken', a.thermalBridges ? tr(`shell.ov.bridges.${a.thermalBridges.replace('.', '')}`) : null, null, 'thermal-bridges', null);
  const renew = a.photovoltaic === null && a.solarThermal === null ? null : a.photovoltaic || a.solarThermal ? [a.photovoltaic ? tr('shell.ov.v.pv') : null, a.solarThermal ? tr('shell.ov.v.solar') : null].filter(Boolean).join(' · ') : tr('shell.ov.v.none');
  answer('renewables', 'systems', 'shell.ov.f.renewables', 'Photovoltaik', renew, sys?.photovoltaic, 'renewables', doubtAnchor('renewables', r, sheets));

  return out;
}

/** Comptes de la phrase de tête : « J'ai lu 30 données : 24 sûres, 6 hypothèses ». */
export function overviewCounts(fields: readonly OverviewField[]): Record<Trust, number> & { total: number; sure: number } {
  const c: Record<Trust, number> = { crossChecked: 0, read: 0, assumption: 0, missing: 0, user: 0 };
  for (const f of fields) c[f.trust]++;
  return { ...c, total: fields.length, sure: c.crossChecked + c.read };
}

// ───────────────────────────── Miniature de la planche ─────────────────────────────

export interface PageThumb {
  page: number;
  /** Cadre de la page (uf). */
  frame: BBox;
  image: { url: string; x: number; y: number; width: number; height: number } | null;
  views: ReadView[];
}

/** Pages de la planche, avec leur image de fond (portée par les feuilles) et les vues reconnues. */
export function pageThumbs(reading: SheetReading | undefined, sheets: readonly PlanSheet[]): PageThumb[] {
  const pages = new Set<number>();
  for (const v of reading?.views ?? []) pages.add(v.page);
  for (const s of sheets) if (s.image) pages.add(s.page ?? 1);
  const out: PageThumb[] = [];
  for (const page of [...pages].sort((x, y) => x - y)) {
    const sheet = sheets.find((s) => (s.page ?? 1) === page && s.image);
    const views = (reading?.views ?? []).filter((v) => v.page === page && validBox(v.box));
    const image = sheet?.image ?? null;
    const frame = image
      ? { minX: image.x, minY: image.y, maxX: image.x + image.width, maxY: image.y + image.height }
      : boxOfPoints(views.flatMap((v) => [{ x: v.box.minX, y: v.box.minY }, { x: v.box.maxX, y: v.box.maxY }]), 20);
    if (!frame || !validBox(frame)) continue;
    out.push({ page, frame, image: image ? { ...image } : null, views });
  }
  return out;
}

/** Libellé court d'une vue : son genre dans la langue de l'interface (le titre écrit sur la planche est montré à part). */
export function viewLabel(v: Pick<ReadView, 'kind' | 'storeyRank'>, lang: Lang): string {
  if (v.kind === 'floor-plan' && v.storeyRank !== null) {
    if (v.storeyRank === 0) return t(lang, 'shell.ov.view.ground');
    if (v.storeyRank < 0) return t(lang, 'shell.ov.view.basement');
    return t(lang, 'shell.ov.view.upper', { rank: v.storeyRank });
  }
  return t(lang, `shell.ov.view.${v.kind}`);
}

/**
 * Boîte élargie autour d'un endroit, pour l'extrait d'une carte : marge de 12 uf, puis élargie au rapport largeur /
 * hauteur voulu (celui du cadre de l'extrait, pour ne montrer ni bande vide ni endroit rogné), et ramenée dans la
 * page quand elle en déborde.
 */
export function snippetBox(a: Anchor, frame: BBox | null, aspect = 0): BBox {
  let box = { minX: a.box.minX - PAD, minY: a.box.minY - PAD, maxX: a.box.maxX + PAD, maxY: a.box.maxY + PAD };
  if (aspect > 0) {
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const W = Math.max(w, h * aspect);
    const H = W / aspect;
    box = { minX: cx - W / 2, minY: cy - H / 2, maxX: cx + W / 2, maxY: cy + H / 2 };
  }
  if (!frame) return box;
  // Glisser dans la page (sans déformer) quand c'est possible, sinon rogner.
  const shift = (lo: number, hi: number, fLo: number, fHi: number): [number, number] => {
    if (hi - lo >= fHi - fLo) return [Math.max(lo, fLo), Math.min(hi, fHi)];
    if (lo < fLo) return [fLo, fLo + (hi - lo)];
    if (hi > fHi) return [fHi - (hi - lo), fHi];
    return [lo, hi];
  };
  const [minX, maxX] = shift(box.minX, box.maxX, frame.minX, frame.maxX);
  const [minY, maxY] = shift(box.minY, box.maxY, frame.minY, frame.maxY);
  return { minX, minY, maxX, maxY };
}
