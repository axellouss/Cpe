/**
 * Guide de saisie : tout ce que l'expert reporte dans LuxEeB-Tool, dans l'ordre de sa barre de navigation.
 *
 * Principes (notes de recherche luxeeb-tool §7, option D « assistant de copie ») :
 *  - on ne remplit jamais l'outil à la place de l'expert : il copie, colle et relit chaque valeur ;
 *  - le bloc à coller est « à essayer » (non vérifié sur le classeur protégé) ; les lignes du tableau sont la voie sûre ;
 *  - chaque valeur et chaque ligne porte sa provenance ;
 *  - les termes allemands viennent du manuel (luxeeb-terms.ts) ; pour les installations techniques, on donne
 *    la réponse de l'expert en clair, sans inventer les libellés des listes de l'outil.
 *
 * Convention des cellules de tableau : nombres sans unité (l'unité est dans l'en-tête), virgule décimale ;
 * cellule vide = rien à saisir ; les textes à recopier sont déjà sûrs pour Excel (voir excelSafeText).
 * Convention des valeurs isolées : `copy` vide = rien à coller (liste déroulante ou valeur absente).
 */
import type { ConstructionSummary, EnvelopeRow, Lang, LuxeebSheets, Project, Provenance, Sourced, WindowSummary } from '../core/types';
import { t } from '../i18n';
import { enumText, generatorText, insulationText, integerText, yesNoText } from './answers';
import {
  cleanText,
  excelSafeText,
  luxeebNumber,
  luxeebOrientation,
  luxeebUValue,
  orientationLabel,
  provenanceLabel,
  termLabel,
  weakestProvenance,
} from './format';
import type { GuideItem, GuideRow, GuideSection, GuideTable } from './index';
import {
  LUXEEB_AREAS,
  LUXEEB_ENVELOPE,
  LUXEEB_HEATING,
  LUXEEB_HOT_WATER,
  LUXEEB_MENU,
  LUXEEB_OPAQUE,
  LUXEEB_OVERVIEW,
  LUXEEB_PARAMETERS,
  LUXEEB_PROJECT,
  LUXEEB_SHEET,
  LUXEEB_VENTILATION,
  LUXEEB_WINDOWS,
  proposeSituation,
} from './luxeeb-terms';
import './messages';
import { envelopeDeductLines, envelopePasteBlock, luxeebEnvelopeRows, volumesPasteBlock, zonesPasteBlock } from './paste';

/** Affiché à la place d'une valeur isolée absente. */
const DASH = '—';

type Params = Record<string, string | number>;

/** Un nombre tel que le guide l'écrit (« 12,50 », « 3 », « -1,2 ») : identique dans les deux langues. */
const NUMERIC = /^-?\d+(?:,\d+)?$/;
const STAMP_SEPARATOR = '\u241F';

/**
 * Ligne en cours de construction. `id` : identifiant stable, jamais un texte traduit. `fixed` : ce qui se saisit
 * sur la ligne en plus de ses nombres et ne dépend pas de la langue (terme de l'outil, identifiant du type choisi).
 */
type RowDraft = Omit<GuideRow, 'stamp'> & { fixed?: readonly string[] };

/**
 * Assemble un tableau : rend les identifiants uniques (un doublon venu des données reçoit un suffixe) et calcule
 * l'empreinte de chaque ligne — les nombres des colonnes de l'outil et les termes fixes, rien de traduit. C'est
 * elle qui dit si une ligne déjà saisie a changé ; les colonnes d'aide (`aside`) n'y entrent pas.
 */
function guideTable(key: string, columns: string[], aside: number[], drafts: readonly RowDraft[], pasteBlock: string, pasteHint: string): GuideTable {
  const used = new Set<string>();
  const rows = drafts.map(({ fixed = [], ...row }): GuideRow => {
    let id = row.id;
    for (let n = 2; used.has(id); n++) id = `${row.id}#${n}`;
    used.add(id);
    const numbers = row.cells.filter((cell, c) => !aside.includes(c) && NUMERIC.test(cell));
    return { ...row, id, stamp: [...numbers, ...fixed].join(STAMP_SEPARATOR) };
  });
  return { key, columns, aside, rows, pasteBlock, pasteHint };
}

/** Indice de la colonne « orientation avec azimut » du tableau d'enveloppe (aide de lecture, absente de l'outil). */
export const ENVELOPE_AZIMUTH_COLUMN = 9;

/**
 * Colonnes d'aide à la lecture de chaque tableau (indices dans `columns`) : elles n'existent pas dans LuxEeB-Tool.
 *  - constructions : catégorie, « contre », surface totale ;
 *  - windowTypes : nombre de fenêtres, surface totale ;
 *  - envelope : repère du relevé, orientation avec azimut, « contre » ;
 *  - zones : hauteur libre.
 */
export const GUIDE_ASIDE_COLUMNS = {
  constructions: [1, 2, 5],
  windowTypes: [3, 4],
  envelope: [8, ENVELOPE_AZIMUTH_COLUMN, 10],
  zones: [4],
  volumes: [],
} as const satisfies Record<string, readonly number[]>;

/** Clés des sections, dans l'ordre renvoyé par `buildGuide`. */
export const GUIDE_SECTION_KEYS = ['project', 'opaque', 'windows', 'envelope', 'areas', 'check', 'remaining'] as const;
export type GuideSectionKey = (typeof GUIDE_SECTION_KEYS)[number];

// ───────────────────────────── Fabrique de valeurs isolées ─────────────────────────────

function item(key: string, label: string, value: string, copy: string, from: Provenance | null, note?: string): GuideItem {
  return note ? { key, label, value, copy, from, note } : { key, label, value, copy, from };
}

function missingItem(lang: Lang, key: string, label: string, note?: string): GuideItem {
  return item(key, label, DASH, '', null, note ?? t(lang, 'export.note.missing'));
}

/** Texte libre saisi par l'expert (nom, rue…) : à coller tel quel. */
function textItem(lang: Lang, key: string, label: string, raw: string | null | undefined, note?: string): GuideItem {
  const text = cleanText(raw ?? '');
  if (!text) return missingItem(lang, key, label);
  return item(key, label, text, excelSafeText(text), 'user', note);
}

function integerItem(lang: Lang, key: string, label: string, value: number | null, note?: string): GuideItem {
  const text = integerText(value);
  if (text === null) return missingItem(lang, key, label);
  return item(key, label, text, text, 'user', note);
}

/** Valeur numérique avec unité : « 186,00 m² » à l'écran, « 186,00 » dans le presse-papiers. */
function numberItem(key: string, label: string, value: number, unit: string, from: Provenance, note?: string): GuideItem {
  const copy = luxeebNumber(value);
  return item(key, label, copy ? `${copy} ${unit}`.trim() : DASH, copy, copy ? from : null, note);
}

/** Réponse en clair pour une liste déroulante de l'outil : rien à coller. */
function hintItem(lang: Lang, key: string, label: string, answer: string | null, note: string): GuideItem {
  return answer === null ? item(key, label, DASH, '', null, `${t(lang, 'export.note.missing')} ${note}`) : item(key, label, answer, '', 'user', note);
}

function quoteList(lang: Lang, terms: readonly string[]): string {
  return terms.map((term) => (lang === 'de' ? `„${term}“` : `« ${term} »`)).join(', ');
}

// ───────────────────────────── 1. Projet ─────────────────────────────

function projectSection(project: Project, lang: Lang): GuideSection {
  const a = project.answers;
  const P = LUXEEB_PROJECT;
  const listNote = t(lang, 'export.note.list');

  const postcodeLabel = termLabel(lang, P.postcodeLocality, 'export.tr.postcode');
  const postcode = cleanText(a.postcode ?? '');
  // Dans l'outil, la cellule du code postal est précédée d'un « L- » fixe.
  const postcodeDigits = postcode.replace(/^L\s*[-–]?\s*(?=\d)/i, '');
  const postcodeItem = postcode
    ? item('project.postcode', postcodeLabel, postcode, excelSafeText(postcodeDigits), 'user', t(lang, 'export.note.postcode'))
    : missingItem(lang, 'project.postcode', postcodeLabel);

  const buildingTypeLabel = termLabel(lang, P.buildingType, 'export.tr.buildingType');
  const buildingTypeItem =
    a.buildingType === 'EFH'
      ? item('project.buildingType', buildingTypeLabel, t(lang, 'export.value.efh', { term: P.buildingTypeEfh }), '', 'user', listNote)
      : a.buildingType === 'MFH'
        ? item('project.buildingType', buildingTypeLabel, t(lang, 'export.value.mfh'), '', 'user', listNote)
        : missingItem(lang, 'project.buildingType', buildingTypeLabel);

  const occasionLabel = termLabel(lang, P.occasion, 'export.tr.occasion');
  const occasionItem =
    a.occasion === 'new'
      ? item('project.occasion', occasionLabel, t(lang, 'export.value.occasionNew', { term: P.occasionNewExample }), '', 'user', listNote)
      : a.occasion === 'existing'
        ? item('project.occasion', occasionLabel, t(lang, 'export.value.occasionExisting'), '', 'user', listNote)
        : missingItem(lang, 'project.occasion', occasionLabel);

  return {
    key: 'project',
    luxeebName: LUXEEB_SHEET.project,
    title: t(lang, 'export.guide.project.title'),
    help: t(lang, 'export.guide.project.help', { menu: LUXEEB_MENU.project }),
    items: [
      textItem(lang, 'project.name', termLabel(lang, P.designation, 'export.tr.designation'), a.projectName),
      textItem(lang, 'project.street', termLabel(lang, P.street, 'export.tr.street'), a.street),
      postcodeItem,
      textItem(lang, 'project.locality', termLabel(lang, P.postcodeLocality, 'export.tr.locality'), a.locality),
      integerItem(lang, 'project.yearBuilt', termLabel(lang, P.yearBuilt, 'export.tr.yearBuilt'), a.yearBuilt),
      integerItem(lang, 'project.dwellings', termLabel(lang, P.dwellings, 'export.tr.dwellings'), a.dwellings),
      buildingTypeItem,
      occasionItem,
      item(
        'project.parties',
        termLabel(lang, `${P.issuer} / ${P.owner}`, 'export.tr.parties'),
        t(lang, 'export.common.toEnter'),
        '',
        null,
        t(lang, 'export.note.parties'),
      ),
    ],
    tables: [],
  };
}

// ───────────────────────────── 2. Éléments opaques ─────────────────────────────

/** Termine une remarque par un point, pour pouvoir en enchaîner plusieurs. */
function sentence(text: string): string {
  const clean = cleanText(text);
  return clean && !/[.!?…]$/.test(clean) ? `${clean}.` : clean;
}

/** Remarque sur une valeur U ou g : d'où elle vient, avec la note de l'expert ou du moteur s'il y en a une. */
function sourcedNote(lang: Lang, key: string, value: Sourced<number>): string {
  const base = t(lang, key, { provenance: provenanceLabel(value.from, lang) });
  const extra = sentence(value.note ?? '');
  return extra ? `${base} ${extra}` : base;
}

function uNote(lang: Lang, u: ConstructionSummary['u']): string {
  return u ? sourcedNote(lang, 'export.note.uFrom', u) : t(lang, 'export.note.uMissing');
}

function constructionRow(c: ConstructionSummary, lang: Lang, contributing: readonly Provenance[] = []): RowDraft {
  const proposal = proposeSituation(c.category, c.boundary);
  const notes: string[] = [];
  if (c.boundary === 'heated') notes.push(t(lang, 'export.note.heatedBoundary'));
  notes.push(uNote(lang, c.u));
  if (c.boundary === 'ground') notes.push(t(lang, c.category === 'wall' ? 'export.note.groundWall' : 'export.note.groundFloor'));
  if (proposal.toCheck) notes.push(t(lang, 'export.note.situationCheck'));
  return {
    // Un type d'élément donne une ligne par milieu : l'identifiant du type ne suffit pas.
    id: `${c.constructionId}|${c.boundary}`,
    // Ordre de l'outil (« Eigene Angaben ») : Bezeichnung, puis U-Wert, puis Einbausituation.
    cells: [
      excelSafeText(c.name),
      enumText(lang, 'category', c.category) ?? '',
      enumText(lang, 'boundary', c.boundary) ?? '',
      c.u ? luxeebUValue(c.u.value) : '',
      proposal.option ?? '',
      luxeebNumber(c.area),
      c.ground?.slabArea === undefined ? '' : luxeebNumber(c.ground.slabArea),
      c.ground?.perimeter === undefined ? '' : luxeebNumber(c.ground.perimeter),
    ],
    fixed: [proposal.option ?? ''],
    // Une surface calculée vaut ce que valent les lignes d'enveloppe dont elle est la somme.
    from: weakestProvenance(['calc', c.u?.from, ...contributing]),
    note: notes.join(' '),
  };
}

function opaqueSection(sheets: LuxeebSheets, project: Project, lang: Lang): GuideSection {
  const a = project.answers;
  const O = LUXEEB_OPAQUE;
  const items: GuideItem[] = [];

  const insulation: [string, string, number | null][] = [
    ['opaque.insulationWalls', 'export.label.insulationWalls', a.insulationWallsCm],
    ['opaque.insulationRoof', 'export.label.insulationRoof', a.insulationRoofCm],
    ['opaque.insulationFloor', 'export.label.insulationFloor', a.insulationFloorCm],
  ];
  for (const [key, labelKey, cm] of insulation) {
    const text = insulationText(lang, cm);
    if (text === null || cm === null) continue;
    items.push(item(key, t(lang, labelKey), text, cm > 0 ? luxeebNumber(cm, Number.isInteger(cm) ? 0 : 1) : '', 'user', t(lang, 'export.note.insulation')));
  }
  if (sheets.constructions.length > O.slots) {
    items.push(
      item(
        'opaque.slots',
        t(lang, 'export.label.slots'),
        t(lang, 'export.value.slots', { count: sheets.constructions.length, max: O.slots }),
        '',
        'calc',
        t(lang, 'export.note.slots', { max: O.slots }),
      ),
    );
  }

  const table = guideTable(
    'constructions',
    [
      termLabel(lang, O.designation, 'export.tr.designation'),
      t(lang, 'export.col.category'),
      t(lang, 'export.col.boundary'),
      termLabel(lang, O.uValue, 'export.tr.uValue', 'W/(m²K)'),
      termLabel(lang, O.situation, 'export.tr.situation'),
      t(lang, 'export.col.totalArea'),
      termLabel(lang, O.slabArea, 'export.tr.slabArea', 'm²'),
      termLabel(lang, O.perimeter, 'export.tr.perimeter', 'm'),
    ],
    [...GUIDE_ASIDE_COLUMNS.constructions],
    sheets.constructions.map((c) =>
      constructionRow(
        c,
        lang,
        sheets.envelope.filter((r) => r.constructionId === c.constructionId && r.boundary === c.boundary).map((r) => r.from),
      ),
    ),
    '',
    t(lang, sheets.constructions.length > 0 ? 'export.paste.none' : 'export.paste.empty'),
  );

  return {
    key: 'opaque',
    luxeebName: LUXEEB_SHEET.opaque,
    title: t(lang, 'export.guide.opaque.title'),
    help: t(lang, 'export.guide.opaque.help', { menu: LUXEEB_MENU.opaque, max: O.slots, manual: LUXEEB_SHEET.opaqueManual }),
    items,
    tables: [table],
  };
}

// ───────────────────────────── 3. Fenêtres ─────────────────────────────

function windowRow(w: WindowSummary, lang: Lang, contributing: readonly Provenance[] = []): RowDraft {
  const notes: string[] = [];
  if (w.uw) notes.push(uNote(lang, w.uw));
  else notes.push(t(lang, 'export.note.windowValues', { psi: LUXEEB_WINDOWS.psiDefault }));
  if (w.g) notes.push(sourcedNote(lang, 'export.note.gFrom', w.g));
  return {
    id: w.windowTypeId,
    cells: [
      excelSafeText(w.name),
      luxeebNumber(w.typicalWidth),
      luxeebNumber(w.typicalHeight),
      Number.isInteger(w.count) ? String(w.count) : luxeebNumber(w.count),
      luxeebNumber(w.area),
      // Ordre de l'outil : g-Wert avant U-Wert Fenster.
      w.g ? luxeebNumber(w.g.value) : '',
      w.uw ? luxeebUValue(w.uw.value) : '',
    ],
    from: weakestProvenance(['calc', w.uw?.from, w.g?.from, ...contributing]),
    note: notes.join(' '),
  };
}

function windowsSection(sheets: LuxeebSheets, project: Project, lang: Lang): GuideSection {
  const W = LUXEEB_WINDOWS;
  const items: GuideItem[] = [];
  const generation = enumText(lang, 'windowGeneration', project.answers.windowGeneration);
  if (generation !== null) {
    items.push(item('windows.generation', t(lang, 'export.label.windowGeneration'), generation, '', 'user', t(lang, 'export.note.windowGeneration')));
  }
  const table = guideTable(
    'windowTypes',
    [
      termLabel(lang, W.designation, 'export.tr.designation'),
      termLabel(lang, W.width, 'export.tr.typicalWidth', 'm'),
      termLabel(lang, W.height, 'export.tr.typicalHeight', 'm'),
      t(lang, 'export.col.windowCount'),
      t(lang, 'export.col.totalArea'),
      termLabel(lang, W.gValue, 'export.tr.gValue', '-'),
      termLabel(lang, W.uWindow, 'export.tr.uWindow', 'W/(m²K)'),
    ],
    [...GUIDE_ASIDE_COLUMNS.windowTypes],
    sheets.windows.map((w) => windowRow(w, lang, sheets.envelope.filter((r) => r.windowTypeId === w.windowTypeId).map((r) => r.from))),
    '',
    t(lang, sheets.windows.length > 0 ? 'export.paste.none' : 'export.paste.empty'),
  );
  return {
    key: 'windows',
    luxeebName: LUXEEB_SHEET.windows,
    title: t(lang, 'export.guide.windows.title'),
    help: t(lang, 'export.guide.windows.help', { menu: LUXEEB_MENU.windows, type: W.windowType, panes: W.paneCount }),
    items,
    tables: [table],
  };
}

// ───────────────────────────── 4. Enveloppe ─────────────────────────────

function envelopeSection(rows: readonly EnvelopeRow[], lang: Lang): GuideSection {
  const E = LUXEEB_ENVELOPE;
  const deductLines = envelopeDeductLines(rows);
  let lastTarget = -1;
  rows.forEach((r, i) => {
    if (!r.deduct) lastTarget = i;
  });

  const tableRows: RowDraft[] = rows.map((r, i) => {
    const cells = [
      String(i + 1),
      excelSafeText(r.elementName),
      luxeebNumber(r.count),
      luxeebNumber(r.length),
      luxeebNumber(r.width),
      luxeebOrientation(r.orientation),
      r.deduct ? E.deductMark : '',
      luxeebNumber(r.netArea),
      excelSafeText(r.label),
      orientationLabel(r.orientation, lang),
      enumText(lang, 'boundary', r.boundary) ?? '',
    ];
    // Changer le type d'une paroi change l'entrée à choisir dans la liste « Bauteil » sans toucher aux nombres.
    const fixed = [luxeebOrientation(r.orientation), r.deduct ? E.deductMark : '', r.constructionId ?? '', r.windowTypeId ?? ''];
    if (!r.deduct) return { id: r.id, cells, fixed, from: r.from, deduct: false };
    return { id: r.id, cells, fixed, from: r.from, deduct: true, note: t(lang, i > lastTarget ? 'export.note.deductOrphan' : 'export.note.deductRow') };
  });

  const blockColumns = [E.count, E.length, E.width, E.orientation];
  const table = guideTable(
    'envelope',
    [
      t(lang, 'export.col.line'),
      termLabel(lang, E.element, 'export.tr.element'),
      termLabel(lang, E.count, 'export.tr.count'),
      termLabel(lang, E.length, 'export.tr.lengthGross', 'm'),
      termLabel(lang, E.width, 'export.tr.widthGross', 'm'),
      termLabel(lang, E.orientation, 'export.tr.orientation'),
      termLabel(lang, E.deduct, 'export.tr.deduct'),
      termLabel(lang, E.area, 'export.tr.areaExpected', 'm²'),
      t(lang, 'export.col.label'),
      t(lang, 'export.col.azimuth'),
      t(lang, 'export.col.boundary'),
    ],
    [...GUIDE_ASIDE_COLUMNS.envelope],
    tableRows,
    envelopePasteBlock(rows),
    rows.length > 0
      ? t(lang, 'export.paste.envelope', { first: E.count, count: rows.length, columns: blockColumns.join(', '), deduct: E.deduct })
      : t(lang, 'export.paste.empty'),
  );

  const items: GuideItem[] = [
    item('envelope.rowCount', t(lang, 'export.label.rowCount'), String(rows.length), '', 'calc'),
    deductLines.length > 0
      ? {
          ...item(
            'envelope.deductLines',
            t(lang, 'export.label.deductLines'),
            deductLines.join(', '),
            E.deductMark,
            'calc',
            t(lang, 'export.note.deductLines', { column: E.deduct }),
          ),
          // Le bouton ne copie pas la liste affichée mais la marque à poser sur ces lignes : il doit le dire.
          copyIsMark: true,
        }
      : item('envelope.deductLines', t(lang, 'export.label.deductLines'), DASH, '', 'calc', t(lang, 'export.note.noDeduct')),
  ];

  return {
    key: 'envelope',
    luxeebName: LUXEEB_SHEET.envelope,
    title: t(lang, 'export.guide.envelope.title'),
    help: t(lang, 'export.guide.envelope.help', { menu: LUXEEB_MENU.envelope, columns: blockColumns.join(', '), deduct: E.deduct }),
    items,
    tables: [table],
  };
}

// ───────────────────────────── Totaux « tels que saisis » ─────────────────────────────

/** Valeur telle qu'elle sera saisie : arrondie à 2 décimales comme dans les blocs. */
function entered(value: number): number {
  const text = luxeebNumber(value);
  return text ? Number(text.replace(',', '.')) : 0;
}

/**
 * Totaux que LuxEeB-Tool affichera une fois les lignes saisies (produits des valeurs ARRONDIES des blocs) :
 * c'est à eux que l'expert compare l'écran de l'outil, pas aux totaux non arrondis du moteur.
 */
function enteredTotals(sheets: LuxeebSheets, envelope: readonly EnvelopeRow[]): { an: number; ve: number; gross: number; windows: number } {
  const product = (r: EnvelopeRow): number => entered(r.count) * entered(r.length) * entered(r.width);
  let gross = 0;
  let windows = 0;
  for (const r of envelope) {
    // Une ligne déduite est comptée dans la paroi qui la porte : la somme des parois non déduites suffit.
    if (!r.deduct) gross += product(r);
    if (r.kind === 'window') windows += product(r);
  }
  return {
    an: sheets.zones.reduce((s, z) => s + entered(z.area), 0),
    ve: sheets.volumes.reduce((s, v) => s + entered(v.area) * entered(v.height), 0),
    gross,
    windows,
  };
}

// ───────────────────────────── 5. Surfaces et volumes ─────────────────────────────

function areasSection(sheets: LuxeebSheets, envelope: readonly EnvelopeRow[], lang: Lang): GuideSection {
  const A = LUXEEB_AREAS;
  const one = luxeebNumber(1);
  const totals = enteredTotals(sheets, envelope);

  const zoneColumns = [A.roomName, A.count, A.width, A.length];
  const zones = guideTable(
    'zones',
    [
      termLabel(lang, A.roomName, 'export.tr.roomName'),
      termLabel(lang, A.count, 'export.tr.count'),
      termLabel(lang, A.width, 'export.tr.width', 'm'),
      termLabel(lang, A.length, 'export.tr.lengthArea', 'm'),
      t(lang, 'export.col.clearHeight'),
      termLabel(lang, A.vn, 'export.tr.vnIndicative', 'm³'),
    ],
    [...GUIDE_ASIDE_COLUMNS.zones],
    sheets.zones.map((z) => ({
      id: z.id,
      cells: [excelSafeText(z.label), one, one, luxeebNumber(z.area), luxeebNumber(z.clearHeight), luxeebNumber(z.airVolume)],
      from: z.from,
    })),
    zonesPasteBlock(sheets.zones),
    sheets.zones.length > 0
      ? t(lang, 'export.paste.zones', { first: A.roomName, count: sheets.zones.length, columns: zoneColumns.join(', ') })
      : t(lang, 'export.paste.empty'),
  );

  const volumeColumns = [A.designation, A.count, A.width, A.length, A.height];
  const volumes = guideTable(
    'volumes',
    [
      termLabel(lang, A.designation, 'export.tr.designation'),
      termLabel(lang, A.count, 'export.tr.count'),
      termLabel(lang, A.width, 'export.tr.width', 'm'),
      termLabel(lang, A.length, 'export.tr.lengthArea', 'm'),
      termLabel(lang, A.height, 'export.tr.height', 'm'),
      termLabel(lang, A.ve, 'export.tr.veExpected', 'm³'),
    ],
    [...GUIDE_ASIDE_COLUMNS.volumes],
    sheets.volumes.map((v) => ({
      id: v.id,
      cells: [excelSafeText(v.label), one, one, luxeebNumber(v.area), luxeebNumber(v.height), luxeebNumber(entered(v.area) * entered(v.height))],
      from: v.from,
    })),
    volumesPasteBlock(sheets.volumes),
    sheets.volumes.length > 0
      ? t(lang, 'export.paste.volumes', { first: A.designation, count: sheets.volumes.length, columns: volumeColumns.join(', ') })
      : t(lang, 'export.paste.empty'),
  );

  return {
    key: 'areas',
    luxeebName: `${LUXEEB_SHEET.zones} · ${LUXEEB_SHEET.volumes}`,
    title: t(lang, 'export.guide.areas.title'),
    help: t(lang, 'export.guide.areas.help', { menu: LUXEEB_MENU.areas, column: A.ventilationSystem }),
    items: [
      numberItem('areas.sumAn', termLabel(lang, `${A.sum} ${A.an}`, 'export.tr.an'), totals.an, 'm²', sheets.totals.anFrom, t(lang, 'export.note.sumAn', { term: A.sum })),
      numberItem('areas.sumVe', termLabel(lang, `${A.sum} ${A.ve}`, 'export.tr.ve'), totals.ve, 'm³', sheets.totals.veFrom, t(lang, 'export.note.sumVe', { term: A.sum })),
    ],
    tables: [zones, volumes],
  };
}

// ───────────────────────────── 6. Contrôle ─────────────────────────────

/**
 * Provenance des totaux de l'enveloppe : la plus faible des lignes qui les composent. Partagée par les valeurs de
 * contrôle du guide et par tous les écrans qui affichent A, la surface des fenêtres ou A/Ve — pour qu'une enveloppe
 * calculée sur des hauteurs par défaut ne passe nulle part pour un fait.
 */
export function envelopeProvenance(sheets: LuxeebSheets, rows: readonly EnvelopeRow[] = luxeebEnvelopeRows(sheets.envelope)): { envelope: Provenance; windows: Provenance; aOverVe: Provenance } {
  const envelope = weakestProvenance(rows.map((r) => r.from));
  const windows = weakestProvenance(rows.filter((r) => r.kind === 'window').map((r) => r.from));
  return { envelope, windows, aOverVe: weakestProvenance([envelope, sheets.totals.veFrom]) };
}

function checkSection(sheets: LuxeebSheets, envelope: readonly EnvelopeRow[], lang: Lang): GuideSection {
  const V = LUXEEB_OVERVIEW;
  const totals = enteredTotals(sheets, envelope);
  const { envelope: envelopeFrom, windows: windowFrom, aOverVe: ratioFrom } = envelopeProvenance(sheets, envelope);
  const vnFrom = weakestProvenance(sheets.zones.map((z) => z.from));
  const ratio = totals.ve > 0 ? totals.gross / totals.ve : Number.NaN;

  return {
    key: 'check',
    luxeebName: LUXEEB_SHEET.overview,
    title: t(lang, 'export.guide.check.title'),
    help: t(lang, 'export.guide.check.help', { menu: LUXEEB_MENU.overview }),
    items: [
      numberItem('check.envelopeGross', termLabel(lang, V.envelopeGross, 'export.tr.envelopeGross'), totals.gross, 'm²', envelopeFrom, t(lang, 'export.note.checkGross', { weighted: V.envelopeWeighted })),
      numberItem('check.ve', termLabel(lang, V.ve, 'export.tr.ve'), totals.ve, 'm³', sheets.totals.veFrom),
      numberItem('check.an', termLabel(lang, V.an, 'export.tr.an'), totals.an, 'm²', sheets.totals.anFrom),
      numberItem('check.vn', termLabel(lang, V.vn, 'export.tr.vn'), sheets.totals.vn, 'm³', vnFrom, t(lang, 'export.note.checkVn')),
      numberItem('check.windowArea', termLabel(lang, V.windowArea, 'export.tr.windowArea'), totals.windows, 'm²', windowFrom, t(lang, 'export.note.checkWindowArea')),
      numberItem('check.aOverVe', termLabel(lang, V.aOverV, 'export.tr.aOverVe'), ratio, '1/m', ratioFrom, t(lang, 'export.note.checkAOverVe')),
    ],
    tables: [],
  };
}

// ───────────────────────────── 7. Reste à saisir ─────────────────────────────

function remainingSection(project: Project, lang: Lang): GuideSection {
  const a = project.answers;
  const M = LUXEEB_MENU;
  const S = LUXEEB_SHEET;
  const H = LUXEEB_HEATING;
  const HW = LUXEEB_HOT_WATER;
  const PA = LUXEEB_PARAMETERS;
  const VE = LUXEEB_VENTILATION;
  const tr = (key: string, params?: Params): string => t(lang, key, params);
  const expertChoice = tr('export.common.expertChoice');
  const items: GuideItem[] = [];

  // Ponts thermiques
  items.push(
    item(
      'remaining.thermalBridges',
      termLabel(lang, M.thermalBridges, 'export.tr.thermalBridges'),
      expertChoice,
      '',
      null,
      tr('export.note.thermalBridges', { parameters: S.parameters, field: PA.thermalBridges, sheet: S.thermalBridges }),
    ),
  );

  // Ombrage des fenêtres (même feuille que l'enveloppe)
  items.push(
    item('remaining.shading', termLabel(lang, S.shading, 'export.tr.shading'), expertChoice, '', null, tr('export.note.shading', { sheet: S.envelope })),
  );

  // Ventilation
  const ventilationLabel = termLabel(lang, M.ventilation, 'export.tr.ventilation');
  const ventilationParams = { sheet: S.ventilation, column: LUXEEB_AREAS.ventilationSystem, none: LUXEEB_AREAS.noVentilation };
  items.push(
    a.ventilation === null
      ? item('remaining.ventilation', ventilationLabel, DASH, '', null, tr('export.note.ventilation.missing', ventilationParams))
      : item(
          'remaining.ventilation',
          ventilationLabel,
          enumText(lang, 'ventilation', a.ventilation) ?? DASH,
          '',
          'user',
          tr(`export.note.ventilation.${a.ventilation}`, ventilationParams),
        ),
  );

  // Étanchéité à l'air
  const n50Label = termLabel(lang, `${VE.airtightnessValue} n50`, 'export.tr.airtightness');
  const n50Params = { choice: VE.airtightnessChoice, field: VE.airtightnessValue };
  items.push(
    a.n50 !== null && Number.isFinite(a.n50)
      ? numberItem('remaining.n50', n50Label, a.n50, '1/h', 'user', tr('export.note.airtightness.value', n50Params))
      : item('remaining.n50', n50Label, tr('export.value.noTest'), '', 'default', tr('export.note.airtightness.none', n50Params)),
  );

  // Autres paramètres
  items.push(
    item(
      'remaining.parameters',
      termLabel(lang, M.parameters, 'export.tr.parameters'),
      expertChoice,
      '',
      null,
      tr('export.note.parameters', { fields: quoteList(lang, [PA.climate, PA.thermalBridges, PA.setback, PA.control, PA.construction]) }),
    ),
  );
  items.push(
    hintItem(
      lang,
      'remaining.emission',
      termLabel(lang, PA.control, 'export.tr.emission'),
      enumText(lang, 'emission', a.heatEmission),
      tr('export.note.emission', { field: PA.control }),
    ),
  );

  // Chauffage
  const heatingNote =
    a.occasion === 'existing'
      ? tr('export.note.heating.existing', { sheet: S.heatingExisting, fields: quoteList(lang, [H.existingKind, H.existingPipes, H.generator, H.carrier]) })
      : a.occasion === 'new'
        ? tr('export.note.heating.new', { sheet: S.heating, fields: quoteList(lang, [H.system, H.mainDistribution, H.risers, H.generator, H.subsystem, H.carrier]) })
        : tr('export.note.heating.unknown', { sheet: S.heating, sheetExisting: S.heatingExisting });
  items.push(hintItem(lang, 'remaining.heating', termLabel(lang, M.heating, 'export.tr.heating'), generatorText(lang, project), heatingNote));
  const heatingYear = integerText(a.heatGeneratorYear);
  if (heatingYear !== null) {
    items.push(item('remaining.heatingYear', tr('export.label.heatingYear'), heatingYear, heatingYear, 'user', tr('export.note.heatingYear')));
  }
  items.push(
    hintItem(
      lang,
      'remaining.solarThermal',
      termLabel(lang, H.solarThermal, 'export.tr.solarThermal'),
      yesNoText(lang, a.solarThermal),
      tr('export.note.solarThermal', { field: H.solarThermal }),
    ),
  );

  // Eau chaude sanitaire
  items.push(
    hintItem(
      lang,
      'remaining.hotWater',
      termLabel(lang, M.hotWater, 'export.tr.hotWater'),
      enumText(lang, 'hotWater', a.hotWater),
      tr('export.note.hotWater', { sheet: S.hotWater, fields: quoteList(lang, [HW.supply, HW.storageLocation, HW.storageKind, HW.generator, HW.subsystem]) }),
    ),
  );

  // Énergie auxiliaire
  items.push(item('remaining.auxiliary', termLabel(lang, M.auxiliary, 'export.tr.auxiliary'), expertChoice, '', null, tr('export.note.auxiliary')));

  // Photovoltaïque (absent du manuel v1.7)
  items.push(hintItem(lang, 'remaining.photovoltaic', tr('export.label.photovoltaic'), yesNoText(lang, a.photovoltaic), tr('export.note.photovoltaic')));

  return {
    key: 'remaining',
    luxeebName: [M.thermalBridges, M.ventilation, M.parameters, M.heating, M.hotWater, M.auxiliary].join(' · '),
    title: tr('export.guide.remaining.title'),
    help: tr('export.guide.remaining.help'),
    items,
    tables: [],
  };
}

// ───────────────────────────── Assemblage ─────────────────────────────

/** Tout ce qu'il faut saisir dans LuxEeB-Tool, dans l'ordre de sa procédure de saisie. */
export function buildGuide(sheets: LuxeebSheets, project: Project, lang: Lang): GuideSection[] {
  const envelope = luxeebEnvelopeRows(sheets.envelope);
  return [
    projectSection(project, lang),
    opaqueSection(sheets, project, lang),
    windowsSection(sheets, project, lang),
    envelopeSection(envelope, lang),
    areasSection(sheets, envelope, lang),
    checkSection(sheets, envelope, lang),
    remainingSection(project, lang),
  ];
}

/** Avertissement à afficher avec le guide : origine des noms, aucune transmission automatique, responsabilité. */
export function guideDisclaimer(lang: Lang): string {
  return t(lang, 'export.guide.disclaimer');
}
