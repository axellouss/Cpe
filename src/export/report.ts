/**
 * Dossier de relevé : page HTML autonome (aucune ressource externe, aucun script), imprimable en PDF depuis
 * le navigateur. C'est la trace que l'expert garde pour un contrôle : données du projet, hypothèses, tous les
 * tableaux, provenance de chaque valeur avec sa légende, contrôles de plausibilité, rappel de sa responsabilité.
 *
 * TOUT texte qui vient du projet ou des plans passe par `escapeHtml` : un nom de pièce lu dans un DXF ne doit
 * jamais pouvoir injecter du HTML dans le dossier.
 */
import type { EnvelopeRow, Lang, LuxeebSheets, Project, Provenance, Sourced, Storey } from '../core/types';
import { t } from '../i18n';
import { enumText, projectFacts, yesNoText } from './answers';
import { cleanText, compactNumber, escapeHtml, isProvenance, luxeebNumber, luxeebOrientation, provenanceLabel, PROVENANCES, provenanceTag, roomAreaNote, weakestProvenance } from './format';
import { buildGuide, ENVELOPE_AZIMUTH_COLUMN, guideDisclaimer } from './guide';
import type { GuideTable } from './index';
import { LUXEEB_ENVELOPE, LUXEEB_SHEET } from './luxeeb-terms';
import './messages';
import { luxeebEnvelopeRows } from './paste';
import { findingLines, totalsFacts } from './summary';

/** Options du dossier. La date n'est jamais lue de l'horloge ici : c'est l'appelant qui la fournit. */
export interface ReportOptions {
  /** Date du dossier. Une chaîne est reprise telle quelle ; absente → une ligne à remplir à la main. */
  date?: Date | string;
  /** Noms des fichiers de plans utilisés, pour la trace. */
  sources?: readonly string[];
}

const e = escapeHtml;
/** Deux-points selon la typographie de la langue (espace avant en français, pas en allemand). */
const colon = (lang: Lang): string => (lang === 'de' ? ': ' : ' : ');
const NUMERIC = /^-?\d+(?:,\d+)?$/;
const BLANK_LINE = '<span class="blank"></span>';

function formatDate(date: Date | string | undefined, lang: Lang): string | null {
  if (date === undefined || date === null) return null;
  if (typeof date === 'string') return cleanText(date) || null;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  return lang === 'de' ? `${dd}.${mm}.${yyyy}` : `${dd}/${mm}/${yyyy}`;
}

function tag(from: Provenance | null, lang: Lang): string {
  // Le nom de classe ne vient jamais tel quel des données : seulement d'une provenance reconnue.
  const known = isProvenance(from) ? from : null;
  return `<span class="tag tag-${known ?? 'none'}" title="${e(provenanceLabel(known, lang))}">${e(provenanceTag(known, lang))}</span>`;
}

/** Valeur avec provenance et remarque éventuelle. */
function sourcedHtml(value: string, from: Provenance | null, lang: Lang, note?: string): string {
  const extra = cleanText(note ?? '');
  return `${e(value)} ${tag(from, lang)}${extra ? `<span class="note">${e(extra)}</span>` : ''}`;
}

function sourcedNumber(s: Sourced<number>, lang: Lang, format: (v: number) => string = luxeebNumber): string {
  return sourcedHtml(format(s.value), s.from, lang, s.note);
}

/** En-tête : le terme de l'outil en gras, sa traduction (après le tiret long) en plus petit dessous. */
function th(text: string): string {
  const cut = text.indexOf(' — ');
  if (cut < 0) return `<th>${e(text)}</th>`;
  return `<th>${e(text.slice(0, cut))}<span class="tr">${e(text.slice(cut + 3))}</span></th>`;
}

function td(text: string): string {
  return `<td${NUMERIC.test(text) ? ' class="num"' : ''}>${e(text)}</td>`;
}

function tdHtml(html: string): string {
  return `<td>${html}</td>`;
}

function tableHtml(headers: readonly string[], rows: readonly string[], emptyText: string): string {
  if (rows.length === 0) return `<p class="empty">${e(emptyText)}</p>`;
  // Les tableaux à nombreuses colonnes (enveloppe) sont composés plus petit pour tenir sur une page A4.
  const cls = headers.length >= 10 ? ' class="wide"' : '';
  return `<table${cls}><thead><tr>${headers.map(th).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function section(title: string, body: string, cls = ''): string {
  return `<section${cls ? ` class="${cls}"` : ''}><h2>${e(title)}</h2>${body}</section>`;
}

// ───────────────────────────── Blocs du dossier ─────────────────────────────

function projectBlock(project: Project, lang: Lang): string {
  const rows = projectFacts(project, lang).map(
    (f) => `<tr>${td(f.label)}${tdHtml(sourcedHtml(f.value || t(lang, 'export.common.missing'), f.from, lang))}</tr>`,
  );
  return tableHtml([t(lang, 'export.common.field'), t(lang, 'export.common.value')], rows, t(lang, 'export.report.empty'));
}

function totalsBlock(sheets: LuxeebSheets, project: Project, lang: Lang): string {
  const rows = totalsFacts(sheets, project, lang).map(
    (f) => `<tr>${td(f.label)}<td class="num">${sourcedHtml(`${luxeebNumber(f.value) || '–'} ${f.unit}`, f.from, lang)}</td></tr>`,
  );
  return tableHtml([t(lang, 'export.common.field'), t(lang, 'export.common.value')], rows, t(lang, 'export.report.empty'));
}

function constructionName(project: Project, id: string | null, lang: Lang): string {
  if (id === null) return t(lang, 'export.label.defaultType');
  return project.model.constructions.find((c) => c.id === id)?.name ?? id;
}

function storeySides(storey: Storey, lang: Lang): string {
  const counts = new Map<string, number>();
  for (const edge of storey.edges) counts.set(edge.boundary, (counts.get(edge.boundary) ?? 0) + 1);
  return [...counts.entries()]
    .map(([boundary, count]) => t(lang, 'export.report.storey.sidesValue', { count, boundary: enumText(lang, 'boundary', boundary) ?? boundary }))
    .join(', ');
}

function assumptionsBlock(project: Project, lang: Lang): string {
  const m = project.model;
  const top = m.top;
  const topParts = [enumText(lang, 'top', top.kind) ?? top.kind];
  if (top.kind === 'pitched-roof') {
    topParts.push(`${t(lang, 'export.label.pitch')} ${compactNumber(top.pitchDeg)}°`);
    topParts.push(`${t(lang, 'export.label.roofShape')}${colon(lang)}${enumText(lang, 'roofShape', top.shape) ?? top.shape}`);
    topParts.push(`${t(lang, 'export.label.kneeWall')} ${luxeebNumber(top.kneeWallHeight)} m`);
  }
  topParts.push(`${t(lang, 'export.label.construction')}${colon(lang)}${constructionName(project, top.constructionId, lang)}`);
  const bottomParts = [
    enumText(lang, 'bottom', m.bottom.kind) ?? m.bottom.kind,
    `${t(lang, 'export.label.construction')}${colon(lang)}${constructionName(project, m.bottom.constructionId, lang)}`,
  ];

  const general = [
    `<tr>${td(t(lang, 'export.label.north'))}${tdHtml(sourcedHtml(`${compactNumber(m.northAngle.value)}°`, m.northAngle.from, lang, m.northAngle.note))}</tr>`,
    `<tr>${td(t(lang, 'export.label.top'))}${tdHtml(sourcedHtml(topParts.join(' · '), top.from, lang))}</tr>`,
    `<tr>${td(t(lang, 'export.label.bottom'))}${tdHtml(sourcedHtml(bottomParts.join(' · '), m.bottom.from, lang))}</tr>`,
  ];

  const storeyRows = m.storeys.map((s) => {
    const openingCount = s.openings.reduce((sum, o) => sum + (Number.isFinite(o.count) ? o.count : 0), 0);
    const openings = s.openings.length > 0 ? sourcedHtml(String(openingCount), weakestProvenance(s.openings.map((o) => o.from)), lang) : e('0');
    const netArea = s.netAreaOverride ? sourcedNumber(s.netAreaOverride, lang) : e(t(lang, 'export.report.storey.noOverride'));
    return `<tr>${td(s.name)}${tdHtml(sourcedNumber(s.metresPerUnit, lang, (v) => compactNumber(v, 6)))}${tdHtml(sourcedNumber(s.grossHeight, lang))}${tdHtml(
      sourcedNumber(s.clearHeight, lang),
    )}${tdHtml(netArea)}${td(storeySides(s, lang))}${tdHtml(openings)}</tr>`;
  });

  return (
    tableHtml([t(lang, 'export.common.field'), t(lang, 'export.common.value')], general, t(lang, 'export.report.empty')) +
    `<h3>${e(t(lang, 'export.report.section.storeys'))}</h3>` +
    tableHtml(
      [
        t(lang, 'export.report.storey.name'),
        t(lang, 'export.report.storey.scale'),
        t(lang, 'export.report.storey.grossHeight'),
        t(lang, 'export.report.storey.clearHeight'),
        t(lang, 'export.report.storey.netArea'),
        t(lang, 'export.report.storey.sides'),
        t(lang, 'export.report.storey.openings'),
      ],
      storeyRows,
      t(lang, 'export.report.empty'),
    )
  );
}

function roomsBlock(project: Project, lang: Lang): string {
  const headers = [t(lang, 'export.report.room.name'), t(lang, 'export.report.room.area'), t(lang, 'export.report.room.heated'), t(lang, 'export.report.room.review')];
  return project.model.storeys
    .map((s) => {
      const rows = s.rooms.map(
        (r) =>
          `<tr>${td(r.name.trim() || t(lang, 'export.report.room.unnamed'))}<td class="num">${sourcedNumber(r.area.note ? { ...r.area, note: roomAreaNote(r.area.note, lang) } : r.area, lang)}</td>${td(yesNoText(lang, r.heated) ?? '')}${td(r.needsReview ? (yesNoText(lang, true) ?? '') : '')}</tr>`,
      );
      return `<h3>${e(s.name)}</h3>${tableHtml(headers, rows, t(lang, 'export.report.room.none'))}`;
    })
    .join('');
}

/**
 * Tableau du guide, avec une colonne de provenance et, s'il y a lieu, une colonne de remarque.
 * `omit` : indices des colonnes du guide à ne pas imprimer ; `silentNote` : remarque trop évidente pour être imprimée.
 */
function guideTableBlock(table: GuideTable, lang: Lang, omit: readonly number[] = [], silentNote = ''): string {
  const keep = <T>(values: readonly T[]): T[] => values.filter((_, i) => !omit.includes(i));
  const noteOf = (r: GuideTable['rows'][number]): string => (r.note && r.note !== silentNote ? r.note : '');
  const hasNotes = table.rows.some((r) => noteOf(r) !== '');
  const headers = [...keep(table.columns), t(lang, 'export.common.provenance'), ...(hasNotes ? [t(lang, 'export.common.note')] : [])];
  const rows = table.rows.map(
    (r) =>
      `<tr${r.deduct ? ' class="deduct"' : ''}>${keep(r.cells).map(td).join('')}${tdHtml(tag(r.from, lang))}${hasNotes ? `<td class="small">${e(noteOf(r))}</td>` : ''}</tr>`,
  );
  return tableHtml(headers, rows, t(lang, 'export.report.empty'));
}

/** Lignes du moteur écartées du tableau de saisie (parois vers un local chauffé) : montrées pour la trace. */
function excludedRowsBlock(all: readonly EnvelopeRow[], kept: readonly EnvelopeRow[], lang: Lang): string {
  const keptSet = new Set(kept);
  const excluded = all.filter((r) => !keptSet.has(r));
  if (excluded.length === 0) return '';
  const E = LUXEEB_ENVELOPE;
  const rows = excluded.map(
    (r) =>
      `<tr>${td(cleanText(r.label))}${td(cleanText(r.elementName))}${td(luxeebNumber(r.count))}${td(luxeebNumber(r.length))}${td(luxeebNumber(r.width))}${td(
        luxeebOrientation(r.orientation),
      )}${td(enumText(lang, 'boundary', r.boundary) ?? '')}${tdHtml(tag(r.from, lang))}</tr>`,
  );
  return (
    `<p class="small">${e(t(lang, 'export.report.outsideEnvelope'))}</p>` +
    tableHtml(
      [t(lang, 'export.col.label'), E.element, E.count, `${E.length} [m]`, `${E.width} [m]`, E.orientation, t(lang, 'export.col.boundary'), t(lang, 'export.common.provenance')],
      rows,
      '',
    )
  );
}

function findingsBlock(sheets: LuxeebSheets, lang: Lang): string {
  const lines = findingLines(sheets.findings, lang);
  if (lines.length === 0) return `<p class="empty">${e(t(lang, 'export.report.noFindings'))}</p>`;
  const rows = lines.map(
    (f) => `<tr class="sev-${f.severity}"><td><span class="sev">${e(f.severityLabel)}</span></td><td>${e(f.text)}<span class="note">${e(f.code)}</span></td></tr>`,
  );
  return tableHtml([t(lang, 'export.col.severity'), t(lang, 'export.col.message')], rows, '');
}

function legendBlock(lang: Lang): string {
  const entries: (Provenance | null)[] = [...PROVENANCES, null];
  const rows = entries.map((p) => `<tr>${tdHtml(tag(p, lang))}${td(provenanceLabel(p, lang))}</tr>`);
  return (
    `<p>${e(t(lang, 'export.report.legend.intro'))} ${e(t(lang, 'export.report.legend.attention'))}</p>` +
    `<table class="legend"><tbody>${rows.join('')}</tbody></table>`
  );
}

const STYLE = `
@page { size: A4; margin: 15mm; }
* { box-sizing: border-box; }
body { font: 10pt/1.4 "Segoe UI", Arial, Helvetica, sans-serif; color: #1b1b1b; margin: 0 auto; padding: 12mm; max-width: 210mm; }
h1 { font-size: 18pt; margin: 0 0 2pt; }
h2 { font-size: 12.5pt; margin: 16pt 0 5pt; padding-bottom: 2pt; border-bottom: 1.5pt solid #1b1b1b; break-after: avoid; }
h3 { font-size: 10.5pt; margin: 10pt 0 3pt; break-after: avoid; }
p { margin: 3pt 0; }
.sub { color: #444; margin: 0 0 8pt; }
.proj { font-size: 11.5pt; }
.meta { color: #333; }
.resp { border: 1.5pt solid #1b1b1b; padding: 6pt 9pt; margin-top: 10pt; break-inside: avoid; }
.resp h2 { border: 0; margin: 0 0 3pt; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 3pt 0 6pt; font-size: 8.5pt; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
table.wide { font-size: 7.5pt; }
th, td { border: 0.5pt solid #888; padding: 2pt 4pt; text-align: left; vertical-align: top; overflow-wrap: break-word; }
th { background: #ececec; font-weight: 600; }
th .tr { display: block; font-weight: 400; font-size: 0.88em; color: #444; hyphens: auto; }
table.wide th, table.wide td { padding: 2pt 3pt; }
td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.small, .small { font-size: 8pt; color: #333; }
td.small { hyphens: auto; min-width: 30mm; }
table.wide td.small { font-size: 7pt; min-width: 22mm; }
tr.deduct td { font-style: italic; }
.note { display: block; font-size: 7.5pt; color: #555; }
.empty { color: #555; font-style: italic; }
.tag { display: inline-block; font-size: 7pt; line-height: 1.3; padding: 0 3pt; border: 0.75pt solid #555; border-radius: 2pt; white-space: nowrap; vertical-align: 1pt; }
.tag-plan { background: #e3f0ff; }
.tag-calc { background: #f1f1f1; border-style: dotted; }
.tag-user { background: #e1f5e5; }
.tag-default { background: #fff0c2; border-width: 1.5pt; font-weight: 700; }
.tag-estimate { background: #ffd9d2; border-width: 1.5pt; border-style: dashed; font-weight: 700; }
.tag-none { background: #fff; border-style: dashed; color: #555; }
.sev { font-weight: 600; white-space: nowrap; }
tr.sev-block td { background: #ffe9e5; }
tr.sev-warn td { background: #fff8e0; }
table.legend { width: auto; }
.sign { display: flex; gap: 14pt; margin-top: 8pt; break-inside: avoid; }
.sign div { flex: 1; }
.blank { display: inline-block; min-width: 45mm; border-bottom: 0.75pt solid #1b1b1b; height: 12pt; vertical-align: bottom; }
.sign .blank { display: block; width: 100%; height: 22pt; }
footer { margin-top: 14pt; padding-top: 4pt; border-top: 0.5pt solid #888; font-size: 7.5pt; color: #444; }
@media screen { section { overflow-x: auto; } }
@media print { body { padding: 0; max-width: none; } }
`;

/**
 * Dossier de relevé autonome en HTML, avec options (date fournie par l'appelant, plans utilisés).
 * `reportHtml` est la même fonction sans option.
 */
export function buildReportHtml(sheets: LuxeebSheets, project: Project, lang: Lang, options: ReportOptions = {}): string {
  const a = project.answers;
  const name = cleanText(a.projectName ?? '') || t(lang, 'export.report.unnamed');
  const address = [cleanText(a.street ?? ''), [cleanText(a.postcode ?? ''), cleanText(a.locality ?? '')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const date = formatDate(options.date, lang);
  const sources = (options.sources ?? []).map((s) => cleanText(s)).filter(Boolean);

  const guide = buildGuide(sheets, project, lang);
  const tables = new Map<string, GuideTable>();
  for (const s of guide) for (const table of s.tables) tables.set(table.key, table);
  const guideTable = (key: string, omit: readonly number[] = [], silentNote = ''): string => {
    const table = tables.get(key);
    return table ? guideTableBlock(table, lang, omit, silentNote) : '';
  };
  const titled = (term: string, key: string): string => `${term} — ${t(lang, key)}`;

  const body = [
    `<header><h1>${e(t(lang, 'export.report.title'))}</h1><p class="sub">${e(t(lang, 'export.report.subtitle'))}</p>` +
      `<p class="proj"><strong>${e(name)}</strong>${address ? ` — ${e(address)}` : ''}</p>` +
      `<p class="meta">${e(t(lang, 'export.report.date'))}${colon(lang)}${date ? e(date) : BLANK_LINE}` +
      `${sources.length > 0 ? ` · ${e(t(lang, 'export.report.sources'))}${colon(lang)}${e(sources.join(', '))}` : ''}</p></header>`,
    section(t(lang, 'export.report.responsibility.title'), `<p>${e(t(lang, 'export.report.responsibility.text'))}</p>`, 'resp'),
    section(t(lang, 'export.report.section.project'), projectBlock(project, lang)),
    section(t(lang, 'export.report.section.totals'), totalsBlock(sheets, project, lang)),
    section(t(lang, 'export.report.section.assumptions'), assumptionsBlock(project, lang)),
    section(t(lang, 'export.report.section.rooms'), roomsBlock(project, lang) || `<p class="empty">${e(t(lang, 'export.report.empty'))}</p>`),
    section(titled(LUXEEB_SHEET.opaque, 'export.report.section.constructions'), guideTable('constructions')),
    section(titled(LUXEEB_SHEET.windows, 'export.report.section.windows'), guideTable('windowTypes')),
    section(
      titled(LUXEEB_SHEET.envelope, 'export.report.section.envelope'),
      // Sur papier : sans la colonne « azimut » (le repère nomme déjà l'orientation) ni la remarque que le « x » rend évidente.
      guideTable('envelope', [ENVELOPE_AZIMUTH_COLUMN], t(lang, 'export.note.deductRow')) +
        excludedRowsBlock(sheets.envelope, luxeebEnvelopeRows(sheets.envelope), lang),
    ),
    section(titled(LUXEEB_SHEET.zones, 'export.report.section.zones'), guideTable('zones')),
    section(titled(LUXEEB_SHEET.volumes, 'export.report.section.volumes'), guideTable('volumes')),
    section(t(lang, 'export.report.section.findings'), findingsBlock(sheets, lang)),
    section(t(lang, 'export.report.section.legend'), legendBlock(lang)),
    section(
      t(lang, 'export.report.section.signature'),
      `<div class="sign"><div>${e(t(lang, 'export.report.signature.name'))}${BLANK_LINE}</div><div>${e(t(lang, 'export.report.date'))}${BLANK_LINE}</div><div>${e(
        t(lang, 'export.report.signature.sign'),
      )}${BLANK_LINE}</div></div>`,
    ),
    `<footer><p>${e(t(lang, 'export.report.footer'))}</p><p>${e(guideDisclaimer(lang))}</p></footer>`,
  ].join('\n');

  return (
    `<!DOCTYPE html>\n<html lang="${lang === 'de' ? 'de' : 'fr'}">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${e(`${t(lang, 'export.report.title')} — ${name}`)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`
  );
}

/** Dossier de relevé autonome en HTML (sans date : la ligne « Date » reste à remplir à la main). */
export function reportHtml(sheets: LuxeebSheets, project: Project, lang: Lang): string {
  return buildReportHtml(sheets, project, lang);
}
