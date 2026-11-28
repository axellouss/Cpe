/**
 * Tout le relevé en CSV pour Excel : séparateur « ; », virgule décimale, CRLF, UTF-8 avec BOM.
 * Un seul fichier, plusieurs tableaux séparés par une ligne vide et précédés de leur titre,
 * dans l'ordre de saisie de LuxEeB-Tool (les tableaux sont ceux du guide, avec provenance et remarque).
 */
import { bilingual, type DossierValue } from '../core/cpe';
import type { Lang, LuxeebSheets, Project, Provenance } from '../core/types';
import { t } from '../i18n';
import { projectFacts, yesNoText } from './answers';
import { buildDossier } from './dossier';
import { excelSafeText, luxeebNumber, provenanceLabel, roomAreaNote, weakestProvenance } from './format';
import { buildGuide } from './guide';
import type { GuideTable } from './index';
import { LUXEEB_SHEET } from './luxeeb-terms';
import './messages';
import { findingLines, totalsFacts } from './summary';

const SEPARATOR = ';';
const EOL = '\r\n';
/** Marque d'ordre des octets : sans elle, Excel lit le fichier en ANSI et abîme les accents. */
const BOM = '\uFEFF';

/** Un nombre déjà mis en forme (« 12,50 », « -3 ») : laissé tel quel pour qu'Excel le lise comme un nombre. */
const NUMERIC = /^-?\d+(?:,\d+)?$/;

function cell(value: string): string {
  const text = NUMERIC.test(value) ? value : excelSafeText(value);
  return /[;"\n\r]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function line(cells: readonly string[]): string {
  return cells.map(cell).join(SEPARATOR);
}

/** Titre CSV d'un tableau du guide : nom allemand de la feuille suivi de notre titre. */
function tableTitle(table: GuideTable, lang: Lang): string {
  const titles: Record<string, [string, string]> = {
    constructions: [LUXEEB_SHEET.opaque, 'export.csv.section.constructions'],
    windowTypes: [LUXEEB_SHEET.windows, 'export.csv.section.windows'],
    envelope: [LUXEEB_SHEET.envelope, 'export.csv.section.envelope'],
    zones: [LUXEEB_SHEET.zones, 'export.csv.section.zones'],
    volumes: [LUXEEB_SHEET.volumes, 'export.csv.section.volumes'],
  };
  const entry = titles[table.key];
  return entry ? `${entry[0]} — ${t(lang, entry[1])}` : table.key;
}

/** Tout le relevé en CSV (séparateur « ; », virgule décimale, UTF-8 avec BOM pour Excel). */
export function sheetsToCsv(sheets: LuxeebSheets, project: Project, lang: Lang): string {
  const lines: string[] = [];
  const blank = (): void => {
    lines.push('');
  };
  const provenanceHeader = t(lang, 'export.common.provenance');
  const noteHeader = t(lang, 'export.common.note');

  lines.push(line([t(lang, 'export.csv.title')]));
  lines.push(line([t(lang, 'export.csv.responsibility')]));
  blank();

  // Données du projet
  lines.push(line([t(lang, 'export.csv.section.project')]));
  lines.push(line([t(lang, 'export.common.field'), t(lang, 'export.common.value'), provenanceHeader]));
  for (const fact of projectFacts(project, lang)) {
    lines.push(line([fact.label, fact.value || t(lang, 'export.common.missing'), provenanceLabel(fact.from, lang)]));
  }
  blank();

  // Grandeurs principales
  lines.push(line([t(lang, 'export.csv.section.totals')]));
  lines.push(line([t(lang, 'export.common.field'), t(lang, 'export.common.value'), t(lang, 'export.common.unit'), provenanceHeader]));
  for (const total of totalsFacts(sheets, project, lang)) {
    lines.push(line([total.label, luxeebNumber(total.value), total.unit, provenanceLabel(total.from, lang)]));
  }
  blank();

  // Tableaux du guide, dans l'ordre de saisie de l'outil
  for (const section of buildGuide(sheets, project, lang)) {
    for (const table of section.tables) {
      lines.push(line([tableTitle(table, lang)]));
      lines.push(line([...table.columns, provenanceHeader, noteHeader]));
      for (const row of table.rows) {
        lines.push(line([...row.cells, provenanceLabel(row.from, lang), row.note ?? '']));
      }
      blank();
    }
  }

  // Pièces : le détail de la surface de référence énergétique, étage par étage
  lines.push(line([t(lang, 'export.report.section.rooms')]));
  lines.push(
    line([
      t(lang, 'export.report.storey.name'),
      t(lang, 'export.report.room.name'),
      t(lang, 'export.report.room.area'),
      t(lang, 'export.report.room.heated'),
      t(lang, 'export.report.room.review'),
      provenanceHeader,
      noteHeader,
    ]),
  );
  for (const storey of project.model.storeys) {
    for (const room of storey.rooms) {
      lines.push(
        line([
          storey.name,
          room.name.trim() || t(lang, 'export.report.room.unnamed'),
          luxeebNumber(room.area.value),
          yesNoText(lang, room.heated) ?? '',
          room.needsReview ? (yesNoText(lang, true) ?? '') : '',
          provenanceLabel(room.area.from, lang),
          roomAreaNote(room.area.note, lang),
        ]),
      );
    }
  }
  blank();

  // Contrôles de plausibilité
  lines.push(line([t(lang, 'export.csv.section.findings')]));
  lines.push(line([t(lang, 'export.col.severity'), t(lang, 'export.col.code'), t(lang, 'export.col.message')]));
  for (const finding of findingLines(sheets.findings, lang)) {
    lines.push(line([finding.severityLabel, finding.code, finding.text]));
  }

  // Dossier CPE : un tableau par feuille de LuxEeB-Tool, colonnes de l'outil, puis provenance, confiance, source, doute.
  const dossier = buildDossier(project, [], lang, { derived: sheets });
  const extra = [provenanceHeader, t(lang, 'export.dossier.col.confidence'), t(lang, 'export.dossier.col.source'), t(lang, 'export.dossier.col.doubt')];
  const meta = (cells: readonly DossierValue[]): string[] => {
    const from = weakestProvenance(cells.map((c) => c.from).filter((f): f is Provenance => f !== null));
    const confidences = cells.map((c) => c.confidence).filter((c): c is number => c !== null);
    const unique = (list: (string | undefined | null)[]): string => [...new Set(list.filter((x): x is string => !!x))].join(' | ');
    return [
      provenanceLabel(cells.some((c) => c.from !== null) ? from : null, lang),
      confidences.length > 0 ? luxeebNumber(Math.min(...confidences)) : '',
      unique(cells.map((c) => c.source)),
      unique(cells.map((c) => c.doubt)),
    ];
  };
  blank();
  lines.push(line([t(lang, 'export.dossier.title')]));
  for (const section of dossier.sections) {
    const heading = section.luxeebName === section.title ? section.title : `${section.luxeebName} — ${section.title}`;
    if (section.fields.length > 0) {
      blank();
      lines.push(line([`${heading} — ${t(lang, 'export.common.field')}`]));
      lines.push(line([t(lang, 'export.common.field'), t(lang, 'export.common.value'), ...extra]));
      for (const f of section.fields) lines.push(line([bilingual(f, lang), f.value.text, ...meta([f.value])]));
    }
    for (const table of section.tables) {
      blank();
      lines.push(line([`${heading} (${table.key})`]));
      lines.push(line([...table.columns.map((c) => bilingual(c, lang)), ...extra]));
      for (const row of table.rows) lines.push(line([...row.cells.map((c) => c.text), ...meta(row.cells)]));
    }
  }
  blank();
  lines.push(line([t(lang, 'export.csv.section.dossierAssumptions')]));
  lines.push(line([t(lang, 'export.common.value'), t(lang, 'export.dossier.col.source')]));
  for (const a of dossier.assumptions) lines.push(line([a.text, a.source]));
  if ((dossier.answeredDoubts ?? []).length > 0) {
    blank();
    lines.push(line([t(lang, 'export.dossier.doubts.title')]));
    lines.push(line([t(lang, 'export.dossier.doubts.col.datum'), t(lang, 'export.dossier.doubts.col.status')]));
    for (const d of dossier.answeredDoubts ?? []) lines.push(line([d.label, d.status]));
  }

  return BOM + lines.join(EOL) + EOL;
}
