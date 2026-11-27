/**
 * Tout le relevé en CSV pour Excel : séparateur « ; », virgule décimale, CRLF, UTF-8 avec BOM.
 * Un seul fichier, plusieurs tableaux séparés par une ligne vide et précédés de leur titre,
 * dans l'ordre de saisie de LuxEeB-Tool (les tableaux sont ceux du guide, avec provenance et remarque).
 */
import type { Lang, LuxeebSheets, Project } from '../core/types';
import { t } from '../i18n';
import { projectFacts, yesNoText } from './answers';
import { excelSafeText, luxeebNumber, provenanceLabel } from './format';
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
          room.area.note ?? '',
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

  return BOM + lines.join(EOL) + EOL;
}
