/**
 * Noms et types des fichiers produits par l'export (le téléchargement lui-même est l'affaire de l'interface).
 */
import type { Lang, Project } from '../core/types';

export type ExportFileKind = 'project' | 'csv' | 'report';

/** Type MIME à donner au Blob de chaque fichier. */
export const EXPORT_MIME: Record<ExportFileKind, string> = {
  project: 'application/json',
  csv: 'text/csv;charset=utf-8',
  report: 'text/html;charset=utf-8',
};

/** Fin du nom de chaque fichier, dans la langue de l'interface (ASCII : sans accent ni « ß »). */
const SUFFIX: Record<Lang, Record<ExportFileKind, string>> = {
  fr: { project: '.json', csv: '-releve.csv', report: '-dossier.html' },
  de: { project: '.json', csv: '-aufmass.csv', report: '-akte.html' },
};

/** Nom donné au fichier d'un projet sans nom. */
const UNNAMED: Record<Lang, string> = { fr: 'projet', de: 'projekt' };

/** « Maison Müller – Rue de l'Église 12 » → « maison-muller-rue-de-l-eglise-12 » (ASCII, sans caractère interdit). */
function slug(text: string): string {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Nom de fichier proposé pour un export, d'après le nom du projet (« plan2cpe-maison-muller-releve.csv »),
 * dans la langue de l'interface (« plan2cpe-haus-mueller-aufmass.csv » en allemand).
 */
export function exportFileName(project: Project, kind: ExportFileKind, lang: Lang = 'fr'): string {
  const name = slug(project.answers?.projectName ?? '') || UNNAMED[lang];
  return `plan2cpe-${name}${SUFFIX[lang][kind]}`;
}
