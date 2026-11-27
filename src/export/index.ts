/**
 * Export : mise en forme des résultats pour LuxEeB-Tool (blocs à coller), fichiers et dossier imprimable.
 * API PUBLIQUE (contrat) — l'implémentation vit dans les autres fichiers de src/export/.
 *
 * LuxEeB-Tool est un classeur Excel (interface en allemand) sans fonction d'import connue : on fournit donc
 * les valeurs dans l'ORDRE et le FORMAT de ses tableaux, prêtes à être copiées-collées, avec virgule décimale.
 *
 * Ce que l'interface doit savoir :
 *  - Rien n'est transmis à LuxEeB-Tool : l'expert copie, colle et relit. Ne jamais écrire le contraire.
 *  - Les blocs à coller n'ont PAS été essayés sur le classeur protégé : les présenter comme « à essayer »
 *    (c'est ce que dit `GuideTable.pasteHint`) et garder la recopie ligne par ligne comme voie sûre.
 *  - `GuideItem.copy` vide = rien à coller (liste déroulante de l'outil, ou valeur non renseignée).
 *  - `GuideItem.copyIsMark` = le bouton ne copie pas la valeur affichée : il doit dire ce qu'il copie.
 *  - `GuideTable.pasteBlock` vide = pas de bloc pour ce tableau.
 *  - `GuideTable.aside` = colonnes d'aide à la lecture, absentes de l'outil : à montrer sous la ligne, pas dans la grille.
 *  - `GuideRow.id` + `GuideRow.stamp` = de quoi reconnaître une ligne déjà saisie, quelle que soit la langue.
 *  - Les cellules des tableaux sont prêtes à copier : nombres sans unité, virgule décimale, textes sûrs pour Excel.
 *  - `serializeProject` et `parseProject` lèvent une `ProjectFileError` : à attraper autour de l'enregistrement
 *    (y compris automatique) et de l'ouverture ; `projectFileErrorMessage(err, lang)` donne le texte à afficher.
 */
import type { EnvelopeRow, Lang, LuxeebSheets, OrientationOrHorizontal, Project, VolumeRow, ZoneRow } from '../core/types';
import * as csv from './csv';
import * as format from './format';
import * as guide from './guide';
import './messages';
import * as paste from './paste';
import * as projectFile from './project-file';
import * as report from './report';

/** Libellé d'orientation tel qu'il apparaît dans la liste « Orientierung » de LuxEeB-Tool (allemand). */
export function luxeebOrientation(o: OrientationOrHorizontal): string {
  return format.luxeebOrientation(o);
}

/** Libellé d'orientation pour l'utilisateur, avec l'azimut pour lever l'ambiguïté O = Ouest (FR) / Ost (DE). */
export function orientationLabel(o: OrientationOrHorizontal, lang: Lang): string {
  return format.orientationLabel(o, lang);
}

/**
 * Bloc tabulé à coller dans « Flächeneingabe der Gebäudehülle », à partir de la colonne « Anzahl » :
 * Anzahl ⇥ Länge ⇥ Breite ⇥ Orientierung, une ligne par élément, virgule décimale, sans en-tête.
 * Les lignes à déduire sont incluses à leur place ; voir `envelopeDeductLines` pour les « x » à poser.
 */
export function envelopePasteBlock(rows: readonly EnvelopeRow[]): string {
  return paste.envelopePasteBlock(rows);
}

/** Bloc tabulé pour « Energiebezugsflächen / Zonen » : Raumbezeichnung ⇥ Anzahl ⇥ Breite ⇥ Länge (surface portée par Länge). */
export function zonesPasteBlock(rows: readonly ZoneRow[]): string {
  return paste.zonesPasteBlock(rows);
}

/** Bloc tabulé pour « Gebäudevolumen Ve » : Bezeichnung ⇥ Anzahl ⇥ Breite ⇥ Länge ⇥ Höhe (surface portée par Länge). */
export function volumesPasteBlock(rows: readonly VolumeRow[]): string {
  return paste.volumesPasteBlock(rows);
}

/** Une valeur seule au format LuxEeB (virgule décimale, 2 décimales par défaut). Valeur non finie → chaîne vide. */
export function luxeebNumber(value: number, digits?: number): string {
  return format.luxeebNumber(value, digits);
}

/** Tout le relevé en CSV (séparateur « ; », virgule décimale, UTF-8 avec BOM pour Excel). */
export function sheetsToCsv(sheets: LuxeebSheets, project: Project, lang: Lang): string {
  return csv.sheetsToCsv(sheets, project, lang);
}

/**
 * Projet → JSON (sauvegarde). Lève une `ProjectFileError` si le projet contient une valeur que la relecture
 * refuserait (nombre non fini, champ obligatoire manquant) : le fichier écrit est toujours relisible.
 */
export function serializeProject(project: Project): string {
  return projectFile.serializeProject(project);
}

/** JSON → projet, avec validation ; lève une Error au message clair (français) si le fichier n'est pas un projet valide. */
export function parseProject(json: string): Project {
  return projectFile.parseProject(json);
}

/**
 * Dossier de relevé autonome en HTML (imprimable en PDF depuis le navigateur) : hypothèses, tableaux, provenance de
 * chaque valeur, contrôles — la trace que l'expert garde pour un contrôle du ministère.
 * Sans date ; pour en mettre une, voir `buildReportHtml`.
 */
export function reportHtml(sheets: LuxeebSheets, project: Project, lang: Lang): string {
  return report.reportHtml(sheets, project, lang);
}

// ───────────────────────────── Guide de saisie LuxEeB-Tool ─────────────────────────────

/** Une valeur isolée à reporter dans LuxEeB-Tool. */
export interface GuideItem {
  key: string;
  /** Nom du champ : terme allemand de LuxEeB-Tool suivi de sa traduction. */
  label: string;
  /** Valeur lisible (avec unité). */
  value: string;
  /** Texte placé dans le presse-papiers par « Copier » (sans unité, virgule décimale). */
  copy: string;
  /**
   * Vrai quand `copy` n'est PAS la valeur affichée mais la marque à poser (le « x » des lignes à déduire, dont
   * `value` donne la liste) : le bouton doit alors nommer ce qu'il copie.
   */
  copyIsMark?: boolean;
  from: import('../core/types').Provenance | null;
  note?: string;
}

/** Une ligne d'un tableau du guide. */
export interface GuideRow {
  /**
   * Identifiant stable de la ligne, indépendant de la langue et unique dans son tableau : ligne d'enveloppe,
   * zone, volume, type d'élément + milieu, type de fenêtre.
   */
  id: string;
  /** Une cellule par colonne de `GuideTable.columns`, prête à copier. */
  cells: string[];
  /**
   * Empreinte de ce qui se saisit sur cette ligne, sans aucun texte traduit : ses nombres, les termes de l'outil
   * (orientation, « x », Einbausituation) et le type choisi. Si elle change, la ligne est à ressaisir.
   */
  stamp: string;
  from: import('../core/types').Provenance;
  deduct?: boolean;
  note?: string;
}

/** Un tableau à reporter ligne par ligne, ou d'un bloc par copier-coller. */
export interface GuideTable {
  key: string;
  columns: string[];
  /**
   * Indices des colonnes d'aide à la lecture (repère du relevé, azimut, « contre », surface totale…) : ce ne sont
   * pas des colonnes de l'outil. Les autres colonnes sont celles de LuxEeB-Tool, dans son ordre.
   * L'écran place les aides sous la ligne ; le CSV et le dossier imprimable gardent toutes les colonnes.
   */
  aside: number[];
  rows: GuideRow[];
  /** Bloc tabulé prêt à coller dans le classeur. */
  pasteBlock: string;
  /** Où placer le curseur avant de coller. */
  pasteHint: string;
}

/** Une étape de la saisie dans LuxEeB-Tool, dans l'ordre de sa barre de navigation. */
export interface GuideSection {
  key: string;
  /** Nom de la feuille dans LuxEeB-Tool (allemand, tel qu'affiché). */
  luxeebName: string;
  /** Titre traduit. */
  title: string;
  help: string;
  items: GuideItem[];
  tables: GuideTable[];
}

/** Tout ce qu'il faut saisir dans LuxEeB-Tool, dans l'ordre de sa procédure de saisie. */
export function buildGuide(sheets: LuxeebSheets, project: Project, lang: Lang): GuideSection[] {
  return guide.buildGuide(sheets, project, lang);
}

// ───────────────────────────── Compléments (hors contrat initial) ─────────────────────────────

export { envelopeProvenance, GUIDE_SECTION_KEYS, guideDisclaimer } from './guide';
export type { GuideSectionKey } from './guide';
export { envelopeDeductLines, luxeebEnvelopeRows, PASTE_EOL } from './paste';
export { buildReportHtml } from './report';
export type { ReportOptions } from './report';
export { PROJECT_FILE_APP, PROJECT_FILE_VERSION, ProjectFileError, projectFileErrorMessage } from './project-file';
export { excelSafeText, provenanceLabel, provenanceTag } from './format';
export { exportFileName, EXPORT_MIME } from './files';
export type { ExportFileKind } from './files';
