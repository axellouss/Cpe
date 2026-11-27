/**
 * Export : mise en forme des résultats pour LuxEeB-Tool (blocs à coller), fichiers et dossier imprimable.
 * API PUBLIQUE (contrat) — l'implémentation vit dans les autres fichiers de src/export/.
 *
 * LuxEeB-Tool est un classeur Excel (interface en allemand) sans fonction d'import connue : on fournit donc
 * les valeurs dans l'ORDRE et le FORMAT de ses tableaux, prêtes à être copiées-collées, avec virgule décimale.
 */
import type { EnvelopeRow, Lang, LuxeebSheets, OrientationOrHorizontal, Project, VolumeRow, ZoneRow } from '../core/types';

/** Libellé d'orientation tel qu'il apparaît dans la liste « Orientierung » de LuxEeB-Tool (allemand). */
export function luxeebOrientation(_o: OrientationOrHorizontal): string {
  throw new Error('export.luxeebOrientation: pas encore implémenté');
}

/** Libellé d'orientation pour l'utilisateur, avec l'azimut pour lever l'ambiguïté O = Ouest (FR) / Ost (DE). */
export function orientationLabel(_o: OrientationOrHorizontal, _lang: Lang): string {
  throw new Error('export.orientationLabel: pas encore implémenté');
}

/**
 * Bloc tabulé à coller dans « Flächeneingabe der Gebäudehülle », à partir de la colonne « Anzahl » :
 * Anzahl ⇥ Länge ⇥ Breite ⇥ Orientierung, une ligne par élément, virgule décimale, sans en-tête.
 */
export function envelopePasteBlock(_rows: readonly EnvelopeRow[]): string {
  throw new Error('export.envelopePasteBlock: pas encore implémenté');
}

/** Bloc tabulé pour « Energiebezugsflächen / Zonen » : Raumbezeichnung ⇥ Anzahl ⇥ Breite ⇥ Länge (surface portée par Länge). */
export function zonesPasteBlock(_rows: readonly ZoneRow[]): string {
  throw new Error('export.zonesPasteBlock: pas encore implémenté');
}

/** Bloc tabulé pour « Gebäudevolumen Ve » : Bezeichnung ⇥ Anzahl ⇥ Breite ⇥ Länge ⇥ Höhe (surface portée par Länge). */
export function volumesPasteBlock(_rows: readonly VolumeRow[]): string {
  throw new Error('export.volumesPasteBlock: pas encore implémenté');
}

/** Une valeur seule au format LuxEeB (virgule décimale, 2 décimales par défaut). */
export function luxeebNumber(_value: number, _digits?: number): string {
  throw new Error('export.luxeebNumber: pas encore implémenté');
}

/** Tout le relevé en CSV (séparateur « ; », virgule décimale, UTF-8 avec BOM pour Excel). */
export function sheetsToCsv(_sheets: LuxeebSheets, _project: Project, _lang: Lang): string {
  throw new Error('export.sheetsToCsv: pas encore implémenté');
}

/** Projet → JSON (sauvegarde). */
export function serializeProject(_project: Project): string {
  throw new Error('export.serializeProject: pas encore implémenté');
}

/** JSON → projet, avec validation ; lève une Error au message clair (français) si le fichier n'est pas un projet valide. */
export function parseProject(_json: string): Project {
  throw new Error('export.parseProject: pas encore implémenté');
}

/**
 * Dossier de relevé autonome en HTML (imprimable en PDF depuis le navigateur) : hypothèses, tableaux, provenance de
 * chaque valeur, contrôles — la trace que l'expert garde pour un contrôle du ministère.
 */
export function reportHtml(_sheets: LuxeebSheets, _project: Project, _lang: Lang): string {
  throw new Error('export.reportHtml: pas encore implémenté');
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
  from: import('../core/types').Provenance | null;
  note?: string;
}

/** Un tableau à reporter ligne par ligne, ou d'un bloc par copier-coller. */
export interface GuideTable {
  key: string;
  columns: string[];
  rows: { cells: string[]; from: import('../core/types').Provenance; deduct?: boolean; note?: string }[];
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
export function buildGuide(_sheets: LuxeebSheets, _project: Project, _lang: Lang): GuideSection[] {
  throw new Error('export.buildGuide: pas encore implémenté');
}
