/**
 * Dossier CPE : tout ce qu'il faut saisir dans LuxEeB-Tool 6.25, une section par feuille de l'outil et dans son
 * ordre, colonnes aux libellés de l'outil. Chaque valeur porte sa provenance, sa confiance, son doute et sa source ;
 * le dossier finit par les pré-contrôles du « Plausibilitätscheck » et la liste des hypothèses à confirmer.
 *
 * Ce dossier PRÉPARE la saisie : le passeport officiel sort de LuxEeB-Tool, établi par un expert agréé. Les valeurs U
 * et Uw sont des pré-calculs ; les classes énergétiques ne sont pas calculées ici.
 *
 * Fonction pure.
 */
import {
  FX_OBSERVED,
  LUXEEB_CALCULATED_SLOTS,
  LUXEEB_COLUMNS,
  LUXEEB_LAYER_SLOTS,
  LUXEEB_OWN_VALUE_SLOTS,
  LUXEEB_ELEMENT_LABEL,
  LUXEEB_REGULATION,
  LUXEEB_TOOL_VERSION,
  PLAUSIBILITY_625,
  SHEETS_625,
  bilingual,
  luxeebTypeOf,
  type Dossier,
  type DossierAssumption,
  type DossierColumn,
  type DossierField,
  type DossierSection,
  type DossierSheetKey,
  type DossierTable,
  type DossierValue,
  type LuxeebElementType,
  type PlausibilityCheck,
} from '../core/cpe';
import type { SheetReading } from '../core/reading';
import type { Construction, EnvelopeRow, Lang, LuxeebSheets, PlanSheet, Project, Provenance, Sourced, WindowType } from '../core/types';
import { collectDoubts, deriveSheets } from '../engine';
import { computeU, meanU, precalculatedUw } from '../engine/uvalue';
import { t } from '../i18n';
import { enumText, integerText, yesNoText } from './answers';
import { cleanText, excelSafeText, luxeebNumber, luxeebOrientation, luxeebUValue } from './format';
import './messages';
import { luxeebEnvelopeRows } from './paste';

// ───────────────────────────── Valeurs ─────────────────────────────

/** Confiance d'une valeur sourcée : mesurée si elle l'a été, sinon d'après sa provenance. */
function confidenceOf(from: Provenance | null, measured?: number): number | null {
  if (measured !== undefined) return measured;
  if (from === null) return null;
  if (from === 'user') return 1;
  if (from === 'default' || from === 'estimate') return 0;
  return null;
}

function val(text: string, from: Provenance | null, extra: { confidence?: number; doubt?: string | null; source?: string; number?: number } = {}): DossierValue {
  const out: DossierValue = { text, from: text === '' && from === null ? null : from, confidence: confidenceOf(text === '' ? null : from, extra.confidence) };
  if (extra.number !== undefined && Number.isFinite(extra.number)) out.number = extra.number;
  if (extra.doubt) out.doubt = extra.doubt;
  if (extra.source) out.source = extra.source;
  return out;
}

const EMPTY: DossierValue = { text: '', from: null, confidence: null };

function num(value: number | null | undefined, from: Provenance | null, digits = 2, extra: { confidence?: number; doubt?: string | null; source?: string } = {}): DossierValue {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return val(luxeebNumber(value, digits), from, { ...extra, number: value });
}

function sourced(s: Sourced<number> | null | undefined, digits = 2): DossierValue {
  if (!s) return EMPTY;
  return num(s.value, s.from, digits, { ...(s.confidence !== undefined ? { confidence: s.confidence } : {}), doubt: s.doubt ?? null, ...(s.source ? { source: s.source } : s.note ? { source: s.note } : {}) });
}

function text(value: string | null | undefined, from: Provenance | null = 'user'): DossierValue {
  const clean = cleanText(value ?? '');
  return clean ? val(excelSafeText(clean), from) : EMPTY;
}

function col(key: string, label: { de: string; fr: string }): DossierColumn {
  return { key, de: label.de, fr: label.fr };
}

function field(key: string, label: { de: string; fr: string }, value: DossierValue): DossierField {
  return { key, de: label.de, fr: label.fr, value };
}

const L = (de: string, fr: string): { de: string; fr: string } => ({ de, fr });

// Clés écrites en toutes lettres (le test du dictionnaire les retrouve dans le code).
const ATTACHMENT_KEY = { 'one-side': 'export.dossier.attachment.oneSide', other: 'export.dossier.attachment.other' } as const;
const AIRTIGHTNESS_KEY = { 'class-a-with-ventilation': 'export.dossier.airtightness.classA', measured: 'export.dossier.airtightness.measured' } as const;
const BRIDGES_KEY = { '0.10': 'export.dossier.thermalBridges.flat010', '0.05': 'export.dossier.thermalBridges.flat005', '0.03': 'export.dossier.thermalBridges.din003', detailed: 'export.dossier.thermalBridges.detailed' } as const;
const MASS_KEY = { heavy: 'export.dossier.thermalMass.heavy', other: 'export.dossier.thermalMass.other' } as const;

// ───────────────────────────── Dossier ─────────────────────────────

export interface DossierOptions {
  /** Lecture de la planche, pour les questions encore ouvertes. */
  reading?: SheetReading;
  /** Relevé déjà calculé (sinon recalculé). */
  derived?: LuxeebSheets;
}

/** Le dossier CPE complet, feuille par feuille dans l'ordre de LuxEeB-Tool 6.25. */
export function buildDossier(project: Project, sheets: readonly PlanSheet[], lang: Lang, options: DossierOptions = {}): Dossier {
  const derived = options.derived ?? deriveSheets(project, lang);
  const model = project.model;
  const a = project.answers;
  const assumptions: DossierAssumption[] = [];
  const assume = (key: string, sheet: DossierSheetKey, what: string, s: { from: Provenance; source?: string; note?: string } | null | undefined): void => {
    if (s && (s.from === 'default' || s.from === 'estimate')) {
      assumptions.push({ key, sheet, text: what, source: s.source ?? s.note ?? t(lang, 'export.dossier.assumption.noSource') });
    }
  };

  const sections = new Map<DossierSheetKey, DossierSection>();
  for (const info of SHEETS_625) {
    sections.set(info.key, { key: info.key, luxeebName: info.de, title: lang === 'de' ? info.de : info.fr, fields: [], tables: [], notes: [] });
  }
  const S = (k: DossierSheetKey): DossierSection => sections.get(k)!;

  // ── Informations générales ──
  S('general').fields.push(
    field('designation', L('Bezeichnung', 'Titre'), text(a.projectName)),
    field('street', L('Straße, Nr.', 'Adresse (rue)'), text(a.street)),
    field('postcodeLocality', L('PLZ, Ort', 'Code postal / ville'), text(`${a.postcode} ${a.locality}`.trim())),
    field('buildingType', L('Gebäudetyp', 'Type de bâtiment'), text(enumText(lang, 'buildingType', a.buildingType))),
    field('occasion', L('Nachweisart', 'Type de preuve'), text(enumText(lang, 'occasion', a.occasion))),
    field('yearBuilt', L('Baujahr Gebäude', 'Année de constr. bâtiment'), text(integerText(a.yearBuilt))),
    field('dwellings', L('Wohneinheiten', 'Unités résidentielles'), text(integerText(a.dwellings))),
    field('storeys', L('Anzahl Geschosse', 'Nombre d’étages'), model.storeys.length > 0 ? num(model.storeys.length, 'calc', 0) : EMPTY),
    field('attachment', L('Anbausituation', 'Situation d’accolement'), text(a.attachment ? t(lang, ATTACHMENT_KEY[a.attachment]) : null)),
  );

  // ── Éléments opaques (1..20) et valeurs propres (21..40) ──
  const used = new Map<string, { construction: Construction; type: LuxeebElementType; area: number }>();
  for (const c of derived.constructions) {
    const construction = model.constructions.find((x) => x.id === c.constructionId) ?? { id: c.constructionId, name: c.name, category: c.category, u: c.u };
    const type = construction.luxeebType ?? luxeebTypeOf(c.category, c.boundary);
    const key = `${c.constructionId}|${c.boundary}`;
    used.set(key, { construction: { ...construction, name: c.name }, type, area: c.area });
  }
  const opaque = [...used.values()].filter((e) => !LUXEEB_ELEMENT_LABEL[e.type].ownValue && !e.construction.ownValue);
  const own = [...used.values()].filter((e) => LUXEEB_ELEMENT_LABEL[e.type].ownValue || e.construction.ownValue);
  const C = LUXEEB_COLUMNS.opaque;
  const elements: DossierTable = {
    key: 'elements',
    columns: [col('nr', L('Nr.', 'N°')), col('name', L('Name', 'Nom')), col('type', L('Bauteiltyp', 'Type')), col('thickness', C.total), col('u', C.u), col('area', L('Fläche [m²]', 'Surface [m²]'))],
    rows: [],
  };
  const layers: DossierTable = {
    key: 'layers',
    columns: [col('nr', L('Nr.', 'N°')), col('layer', C.layer), col('name', L('Baustoff', 'Matériau')), col('lambda', C.lambda), col('thickness', C.thickness)],
    rows: [],
  };
  const ground: DossierTable = {
    key: 'ground',
    columns: [col('nr', L('Nr.', 'N°')), col('area', C.groundArea), col('perimeter', C.groundPerimeter), col('depth', C.groundDepth)],
    rows: [],
  };
  // Capacité de l'outil : 20 éléments calculés, 20 « Eigene Angaben », 10 couches par élément.
  if (opaque.length > LUXEEB_CALCULATED_SLOTS) S('opaque').notes.push(t(lang, 'export.dossier.note.slots', { count: opaque.length, max: LUXEEB_CALCULATED_SLOTS }));
  if (own.length > LUXEEB_OWN_VALUE_SLOTS) S('ownValues').notes.push(t(lang, 'export.dossier.note.slots', { count: own.length, max: LUXEEB_OWN_VALUE_SLOTS }));
  for (const e of opaque) {
    const n = (e.construction.layers ?? []).length;
    if (n > LUXEEB_LAYER_SLOTS) S('opaque').notes.push(t(lang, 'export.dossier.note.layerSlots', { name: e.construction.name, count: n, max: LUXEEB_LAYER_SLOTS }));
  }
  opaque.forEach((e, i) => {
    const nr = String(i + 1);
    const c = e.construction;
    const r = computeU({ ...c, luxeebType: e.type });
    const u = c.u ? sourced(c.u, 3) : r.u !== null ? num(r.u, 'calc', 3, { confidence: r.confidence }) : EMPTY;
    if (u.text) u.text = luxeebUValue(u.number ?? 0);
    elements.rows.push({
      id: `${c.id}|${e.type}`,
      cells: [val(nr, 'calc'), text(c.name, 'calc'), val(LUXEEB_ELEMENT_LABEL[e.type].de, c.luxeebType ? 'plan' : 'calc'), r.thicknessCm > 0 ? num(r.thicknessCm, 'plan', 1) : EMPTY, u, num(e.area, 'calc')],
    });
    if (!r.resistancesObserved && (c.layers ?? []).length > 0) S('opaque').notes.push(t(lang, 'export.dossier.note.rsiUnobserved', { name: c.name }));
    (c.layers ?? []).forEach((l, k) => {
      layers.rows.push({
        id: `${c.id}|${k}`,
        cells: [val(nr, 'calc'), val(String(k + 1), 'calc'), val(excelSafeText(l.name), 'plan', { doubt: l.doubt ?? null }), l.lambda ? { ...sourced(l.lambda, 3), text: luxeebNumber(l.lambda.value, 3) } : val('', null, { doubt: t(lang, 'export.dossier.lambdaMissing') }), l.thicknessUnknown ? val('', null, { doubt: t(lang, 'export.dossier.thicknessMissing') }) : sourced(l.thicknessCm, 1)],
      });
      assume(`lambda:${c.id}:${k}`, 'opaque', `${c.name} — ${l.name} : λ ${l.lambda ? luxeebNumber(l.lambda.value, 3) : '?'}`, l.lambda);
    });
    if (c.ground) ground.rows.push({ id: c.id, cells: [val(nr, 'calc'), sourced(c.ground.area), sourced(c.ground.perimeter), sourced(c.ground.depth)] });
    else if (e.type === 'bodenplatte') {
      const g = derived.constructions.find((x) => x.constructionId === c.id && x.ground)?.ground;
      if (g) ground.rows.push({ id: c.id, cells: [val(nr, 'calc'), num(g.slabArea, 'calc'), num(g.perimeter, 'calc'), EMPTY] });
    }
    if (c.u && !c.layers) assume(`u:${c.id}`, 'opaque', `${c.name} : U ${luxeebUValue(c.u.value)}`, c.u);
  });
  S('opaque').tables.push(elements, layers);
  if (ground.rows.length > 0) S('opaque').tables.push(ground);
  if (opaque.some((e) => (e.construction.layers ?? []).length > 0)) S('opaque').notes.push(t(lang, 'export.dossier.note.precalc'));

  S('ownValues').tables.push({
    key: 'own',
    columns: [col('nr', L('Nr.', 'N°')), col('name', L('Name', 'Nom')), col('type', L('Bauteiltyp', 'Type')), col('u', C.u), col('fx', LUXEEB_COLUMNS.envelope.fx)],
    rows: own.map((e, i) => {
      assume(`own:${e.construction.id}`, 'ownValues', `${e.construction.name} : U ${e.construction.u ? luxeebUValue(e.construction.u.value) : '?'}`, e.construction.u);
      const fx = FX_OBSERVED[e.type];
      return {
        id: `${e.construction.id}|${e.type}`,
        cells: [val(String(21 + i), 'calc'), text(e.construction.name, 'calc'), val(LUXEEB_ELEMENT_LABEL[e.type].de, 'calc'), sourced(e.construction.u, 2), fx !== undefined ? num(fx, 'default', 2, { source: t(lang, 'export.dossier.fxObserved') }) : EMPTY],
      };
    }),
  });

  // ── Fenêtres ──
  const W = LUXEEB_COLUMNS.windows;
  const usedTypes = new Set(derived.envelope.map((r) => r.windowTypeId).filter((x): x is string => x !== null));
  const windowTypes = model.windowTypes.filter((w) => usedTypes.has(w.id));
  S('windows').tables.push({
    key: 'windows',
    columns: [col('name', W.name), col('mounting', W.mounting), col('width', W.width), col('height', W.height), col('frame', W.frame), col('type', W.type), col('panes', W.panes), col('ug', W.ug), col('uf', W.uf), col('psi', W.psi), col('g', W.g), col('uw', W.uw)],
    rows: windowTypes.map((w) => windowRow(w, derived, lang, assume)),
  });

  // ── Enveloppe ──
  const E = LUXEEB_COLUMNS.envelope;
  const rows = luxeebEnvelopeRows(derived.envelope);
  S('envelope').tables.push({
    key: 'envelope',
    columns: [col('element', E.element), col('count', E.count), col('length', E.length), col('widthOrArea', E.widthOrArea), col('orientation', E.orientation), col('u', E.u), col('fx', E.fx), col('deduct', E.deduct), col('area', E.area), col('label', L('Beschreibung', 'Repère'))],
    rows: rows.map((r) => envelopeRow(r, model, lang)),
  });

  // ── Zones et volumes ──
  const Z = LUXEEB_COLUMNS.zones;
  S('zones').tables.push({
    key: 'zones',
    columns: [col('name', Z.name), col('count', Z.count), col('length', Z.length), col('widthOrArea', Z.widthOrArea), col('height', Z.height), col('ventilation', Z.ventilation)],
    rows: derived.zones.map((z) => ({
      id: z.id,
      cells: [text(z.label, 'plan'), num(1, 'calc', 0), EMPTY, num(z.area, z.from), num(z.clearHeight, z.from), text(a.ventilationUnit ?? null)],
    })),
  });
  const V = LUXEEB_COLUMNS.volumes;
  S('volumes').tables.push({
    key: 'volumes',
    columns: [col('name', V.name), col('count', V.count), col('length', V.length), col('widthOrArea', V.widthOrArea), col('height', V.height)],
    rows: derived.volumes.map((v) => ({ id: v.id, cells: [text(v.label, 'plan'), num(1, 'calc', 0), EMPTY, num(v.area, v.from), num(v.height, v.from)] })),
  });

  // ── Ventilation, autres paramètres, installations ──
  const VT = LUXEEB_COLUMNS.ventilation;
  S('ventilation').fields.push(
    field('kind', L('Lüftung', 'Ventilation'), text(enumText(lang, 'ventilation', a.ventilation))),
    field('unit', VT.unit, text(a.ventilationUnit ?? null)),
    field('flow', VT.flow, num(a.ventilationFlow, 'user', 1)),
    field('recovery', VT.recovery, num(a.heatRecovery, 'user', 2)),
    field('power', VT.power, num(a.fanPower, 'user', 2)),
    field('airtightness', VT.airtightness, text(a.airtightness ? t(lang, AIRTIGHTNESS_KEY[a.airtightness]) : null)),
    field('n50', VT.n50, a.airtightness === 'class-a-with-ventilation' ? num(0.6, 'user') : num(a.n50, 'user')),
  );
  const O = LUXEEB_COLUMNS.other;
  S('other').fields.push(
    field('thermalBridges', O.thermalBridges, text(a.thermalBridges ? t(lang, BRIDGES_KEY[a.thermalBridges]) : null)),
    field('construction', O.construction, text(a.thermalMass ? t(lang, MASS_KEY[a.thermalMass]) : null)),
    field('regulation', O.regulation, val(LUXEEB_REGULATION, 'calc', { source: t(lang, 'export.dossier.regulationSource') })),
  );
  S('heating').fields.push(
    field('generator', L('Wärmeerzeuger', 'Générateur'), text(enumText(lang, 'generator', a.heatGenerator))),
    field('emission', L('Wärmeübergabe', 'Émission'), text(enumText(lang, 'emission', a.heatEmission))),
    field('temps', L('Auslegungstemperaturen', 'Températures'), text(a.emissionTemps ?? null)),
  );
  S('hotWater').fields.push(
    field('hotWater', L('Warmwassererzeugung', 'Production d’eau chaude'), text(enumText(lang, 'hotWater', a.hotWater))),
    field('storageInside', L('Speicher im beheizten Bereich', 'Ballon dans le volume chauffé'), text(yesNoText(lang, a.hotWaterStorageInside))),
  );
  S('auxiliary').notes.push(t(lang, 'export.dossier.note.auxiliary'));
  S('photovoltaic').fields.push(field('pv', L('Photovoltaik', 'Photovoltaïque'), text(yesNoText(lang, a.photovoltaic))));
  S('summer').notes.push(t(lang, 'export.dossier.note.summer'));

  // ── Hypothèses du modèle : hauteurs, nord, échelle ──
  for (const st of model.storeys) assume(`height:${st.id}`, 'envelope', t(lang, 'export.dossier.assumption.height', { storey: st.name, value: luxeebNumber(st.grossHeight.value) }), st.grossHeight);
  assume('north', 'envelope', t(lang, 'export.dossier.assumption.north', { value: luxeebNumber(model.northAngle.value, 0) }), model.northAngle);

  // ── Contrôle de plausibilité ──
  const plausibility = plausibilityChecks(project, derived, lang);
  const P = S('plausibility');
  P.tables.push({
    key: 'plausibility',
    columns: [col('label', L('Kennwert', 'Grandeur')), col('value', L('Wert', 'Valeur')), col('range', L('übliche Werte', 'valeurs usuelles')), col('check', L('Check', 'Contrôle'))],
    rows: plausibility.map((c) => ({
      id: c.key,
      cells: [val(c.label, 'calc'), c.value === null ? EMPTY : num(c.value, 'calc', c.max < 5 ? 2 : 0), val(`${luxeebNumber(c.min, c.min < 5 ? 2 : 0)}–${luxeebNumber(c.max, c.max < 5 ? 2 : 0)} ${c.unit}`, 'calc'), val(c.status === 'n/a' ? '' : c.status === 'P' ? 'P' : '!', 'calc')],
    })),
  });
  if (plausibility.find((c) => c.key === 'aOverVe')?.status === 'n/a') P.notes.push(t(lang, 'export.dossier.note.aOverVeNotComputed'));
  if (plausibility.find((c) => c.key === 'meanU')?.status === 'n/a') P.notes.push(t(lang, 'export.dossier.note.meanUNotComputed'));

  // ── Questions encore ouvertes ──
  if (options.reading !== undefined || sheets.length > 0) {
    for (const d of collectDoubts(options.reading, project, sheets, lang)) {
      S(d.sheet).notes.push(t(lang, 'export.dossier.note.question', { question: d.question }));
    }
  }

  return {
    version: 2,
    lang,
    tool: { version: LUXEEB_TOOL_VERSION, regulation: LUXEEB_REGULATION },
    sections: SHEETS_625.map((s) => S(s.key)),
    plausibility,
    assumptions,
  };
}

function windowRow(
  w: WindowType,
  derived: LuxeebSheets,
  lang: Lang,
  assume: (key: string, sheet: DossierSheetKey, what: string, s: { from: Provenance; source?: string; note?: string } | null | undefined) => void,
): { id: string; cells: DossierValue[] } {
  const g = w.geometry;
  const summary = derived.windows.find((x) => x.windowTypeId === w.id);
  const pre = precalculatedUw(w);
  const uw = w.uw ?? (pre ? { value: pre.value, from: pre.from, confidence: pre.confidence ?? 0 } : null);
  for (const [k, s] of [['ug', w.ug], ['uf', w.uf], ['psi', w.psiG], ['g', w.g]] as const) assume(`window:${w.id}:${k}`, 'windows', `${w.name} : ${k} ${s ? luxeebNumber(s.value, 3) : '?'}`, s);
  if (g) assume(`window:${w.id}:type`, 'windows', `${w.name} : ${g.fensterTyp.value}`, g.fensterTyp);
  return {
    id: w.id,
    cells: [
      text(w.name, 'calc'),
      val('Gegen außenluft', 'default', { source: t(lang, 'export.dossier.mountingObserved') }),
      num(g?.width ?? summary?.typicalWidth, 'plan'),
      num(g?.height ?? summary?.typicalHeight, 'plan'),
      g ? sourced(g.frameWidth, 3) : EMPTY,
      g ? val(g.fensterTyp.value, g.fensterTyp.from, { ...(g.fensterTyp.confidence !== undefined ? { confidence: g.fensterTyp.confidence } : {}), doubt: g.fensterTyp.doubt ?? null }) : EMPTY,
      g ? num(g.panes, g.fensterTyp.from, 0) : EMPTY,
      sourced(w.ug),
      sourced(w.uf),
      sourced(w.psiG, 3),
      sourced(w.g),
      sourced(uw),
    ],
  };
}

function envelopeRow(r: EnvelopeRow, model: Project['model'], lang: Lang): { id: string; cells: DossierValue[] } {
  const construction = r.constructionId ? model.constructions.find((c) => c.id === r.constructionId) : undefined;
  const type = construction ? (construction.luxeebType ?? luxeebTypeOf(construction.category, r.boundary)) : null;
  const windowType = r.windowTypeId ? model.windowTypes.find((w) => w.id === r.windowTypeId) : undefined;
  const u = construction?.u ?? windowType?.uw ?? (windowType ? (precalculatedUw(windowType) ?? null) : null);
  const fx = type !== null ? FX_OBSERVED[type] : r.kind === 'window' ? 1 : undefined;
  const area = r.entry === 'area';
  return {
    id: r.id,
    cells: [
      text(r.elementName, r.from),
      num(r.count, r.from, 0),
      area ? EMPTY : num(r.length, r.from),
      num(area ? r.grossArea : r.width, r.from),
      // L'outil ne demande l'orientation que vers l'extérieur.
      r.boundary === 'outside' ? val(luxeebOrientation(r.orientation), r.from) : EMPTY,
      u ? { ...sourced(u, 3), text: luxeebUValue(u.value) } : EMPTY,
      fx !== undefined ? num(fx, 'default', 2, { source: t(lang, 'export.dossier.fxObserved') }) : EMPTY,
      r.deduct ? val('x', r.from) : EMPTY,
      num(r.deduct ? r.grossArea : r.netArea, r.from),
      text(r.label, r.from),
    ],
  };
}

// ───────────────────────────── Plausibilitätscheck ─────────────────────────────

/** Les plages imprimées par l'outil appliquées au relevé : 'P' dans la plage, 'out' hors plage, 'n/a' non calculable. */
export function plausibilityChecks(project: Project, derived: LuxeebSheets, lang: Lang): PlausibilityCheck[] {
  const tt = derived.totals;
  const an = tt.an;
  const rows = derived.envelope.filter((r) => !r.deduct);
  const sum = (list: readonly EnvelopeRow[]): number => list.reduce((s, r) => s + r.grossArea, 0);
  const roof = sum(rows.filter((r) => r.kind === 'roof' || r.kind === 'ceiling'));
  const floor = sum(rows.filter((r) => r.kind === 'floor'));
  const facade = sum(rows.filter((r) => r.kind === 'wall' && r.boundary === 'outside'));
  const storeys = Math.max(1, project.model.storeys.length);
  const model = project.model;
  // Surfaces de l'enveloppe avec U et facteur Fx, comme l'outil : Ai = Σ A·Fx et H_T / A = Σ U·A·Fx / A + ΔU_WB.
  // Un Fx que l'outil calcule lui-même (sol, B') n'est pas connu ici : les deux grandeurs restent alors « n/a ».
  const areaU = derived.envelope
    .filter((r) => r.deduct || r.netArea > 0)
    .map((r) => {
      const c = r.constructionId ? model.constructions.find((x) => x.id === r.constructionId) : undefined;
      const w = r.windowTypeId ? model.windowTypes.find((x) => x.id === r.windowTypeId) : undefined;
      const u = c?.u?.value ?? w?.uw?.value ?? (w ? (precalculatedUw(w)?.value ?? null) : null);
      const type = c ? (c.luxeebType ?? luxeebTypeOf(c.category, r.boundary)) : null;
      const fx = type !== null ? (FX_OBSERVED[type] ?? null) : r.kind === 'window' ? 1 : null;
      return { area: r.deduct ? r.grossArea : r.netArea, u, fx };
    });
  const fxKnown = areaU.length > 0 && areaU.every((x) => x.fx !== null);
  const ai = fxKnown ? areaU.reduce((s, x) => s + x.area * (x.fx ?? 0), 0) : null;
  const a = project.answers;
  const wb = a.thermalBridges === '0.10' || a.thermalBridges === '0.05' || a.thermalBridges === '0.03' ? Number(a.thermalBridges) : null;
  const uFx = fxKnown ? meanU(areaU.map((x) => ({ area: x.area, u: x.u === null ? null : x.u * (x.fx ?? 0) }))) : null;
  const values: Record<string, number | null> = {
    anPerStorey: an > 0 ? an / storeys : null,
    roofPerAn: an > 0 ? roof / an : null,
    floorPerAn: an > 0 ? floor / an : null,
    facadePerAn: an > 0 ? facade / an : null,
    windowPerAn: an > 0 ? tt.windowArea / an : null,
    envelopePerAn: an > 0 ? tt.envelopeArea / an : null,
    aOverVe: tt.ve > 0 && ai !== null && ai > 0 ? ai / tt.ve : null,
    windowShare: facade > 0 ? tt.windowArea / facade : null,
    meanU: uFx !== null && wb !== null ? uFx + wb : null,
    vnOverVe: tt.ve > 0 && tt.vn > 0 ? tt.vn / tt.ve : null,
    n50: a.airtightness === 'class-a-with-ventilation' ? 0.6 : a.n50,
    heatRecovery: a.ventilation === 'balanced-hr' ? (a.heatRecovery ?? null) : null,
  };
  return PLAUSIBILITY_625.map((p) => {
    const v = p.computable ? (values[p.key] ?? null) : null;
    const status: PlausibilityCheck['status'] = v === null ? 'n/a' : v >= p.min - 1e-9 && v <= p.max + 1e-9 ? 'P' : 'out';
    return { key: p.key, label: bilingual(p, lang), value: v, min: p.min, max: p.max, unit: p.unit, status };
  });
}

// ───────────────────────────── Mise à plat (CSV, rapport) ─────────────────────────────

