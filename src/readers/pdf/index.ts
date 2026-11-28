/**
 * Lecteur PDF (pdf.js pour l'extraction et le rendu, jsts pour la géométrie). Tout se passe sur le poste de
 * l'utilisateur : ni le fichier ni son contenu ne sont envoyés où que ce soit.
 *
 * Ce que le lecteur produit (voir PlanDocument dans core/types.ts) :
 *  - une feuille par VUE EN PLAN (une page porte souvent rez-de-chaussée, étage et coupe) ; coupes et façades
 *    ne sont pas des feuilles, mais leurs niveaux et hauteurs libres sont reportés sur les plans ;
 *  - unités de feuille = points PDF, y vers le bas, origine en haut à gauche de la page (redressée si le texte
 *    était couché) ; toutes les feuilles d'une même page partagent ce repère ;
 *  - traits vectoriels (courbes discrétisées) et textes, ancrés au début de leur ligne de base ; image de fond
 *    couvrant toute la page, partagée par les feuilles de la page (navigateur seulement) ;
 *  - échelle recoupée entre cartouche, cotes et surfaces écrites — jamais le cartouche seul ;
 *  - contour extérieur, pièces, ouvertures de façade : PROPOSÉS, avec une remarque disant d'où ils viennent.
 *
 * Organisation :
 *  - extract.ts       page pdf.js → textes + traits (seul fichier qui lit les listes d'opérateurs) ;
 *  - analyse.ts       analyse pure (aucune dépendance à pdf.js ni au navigateur) → PlanDocument ;
 *  - scale.ts, walls.ts, openings.ts, planar.ts   échelle, murs et faces, ouvertures, frontière jsts ;
 *  - render.ts        image de fond (canevas → adresse d'objet), navigateur seulement ;
 *  - init-browser.ts  pdf.js avec son worker et ses ressources embarquées ;
 *  - init-node.ts     pdf.js « legacy » sans worker (tests) ;
 *  - messages.ts      textes FR / DE.
 */
import type { Lang, PlanDocument } from '../../core/types';
import type { ReadProgress } from '../index';
import { analysePdf } from './analyse';
import type { PageReport } from './analyse';
import { extractPage } from './extract';
import { msg } from './messages';
import type { PDFPageProxy, PdfEngine } from './pdfjs';
import { PdfReadError } from './pdfjs';
import type { RawPage } from './raw';
import { canRenderImages, pageToObjectUrl, renderPage } from './render';

export { analysePdf, CLOSING_RADIUS_M, MAX_DISPLAY_SEGMENTS } from './analyse';
export type { AnalyseOptions, PageKind, PageReport, PdfAnalysis, SheetPlacement } from './analyse';
export { extractPage } from './extract';
export { PDF_MESSAGES } from './messages';
export { PdfReadError } from './pdfjs';
export type { RawPage, RawSeg, RawText } from './raw';
export { METRES_PER_POINT } from './raw';

/** Au-delà, les pages suivantes ne sont pas lues (un dossier de plans complet peut en compter des centaines). */
export const MAX_PAGES = 40;

export interface ReadPdfOptions {
  /** Langue des avertissements et remarques (français par défaut). */
  lang?: Lang;
  /** Produire l'image de fond quand l'environnement le permet (oui par défaut). */
  images?: boolean;
  /** Suivi de la lecture, étape par étape (open, views, rooms, envelope, layers, check). */
  onProgress?: (progress: ReadProgress) => void;
}

/** Détails de lecture utiles aux tests et au diagnostic (hors contrat PlanDocument). */
export interface PdfReadDetails {
  pageCount: number;
  pages: PageReport[];
  /** Pages extraites (représentation intermédiaire), dans l'ordre. */
  raw: RawPage[];
  /** Durées en millisecondes. */
  timing: { extract: number; analyse: number; render: number; total: number };
}

function runsUnderNode(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof p?.versions?.node === 'string';
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** pdf.js initialisé pour l'environnement courant. */
export async function createPdfEngine(): Promise<PdfEngine> {
  const init = runsUnderNode() ? await import('./init-node') : await import('./init-browser');
  return init.createPdfEngine();
}

/**
 * Lit un PDF et renvoie, en plus du document, le compte rendu d'analyse de chaque page.
 * Lève `PdfReadError` (message en clair) si le fichier est illisible ou protégé.
 */
export async function readPdfDetailed(data: ArrayBuffer, fileName: string, options: ReadPdfOptions = {}): Promise<{ doc: PlanDocument; details: PdfReadDetails }> {
  const lang: Lang = options.lang ?? 'fr';
  const t0 = now();
  const emit = (p: ReadProgress): void => {
    try {
      options.onProgress?.(p);
    } catch {
      // Le suivi ne doit jamais interrompre la lecture.
    }
  };
  emit({ stage: 'open', status: 'running' });
  const engine = await createPdfEngine();
  let opened;
  try {
    opened = await engine.open(new Uint8Array(data));
  } catch (error) {
    const name = (error as { name?: string } | null)?.name ?? '';
    if (name === 'PasswordException') throw new PdfReadError(msg(lang, 'pdf.error.password'), 'password');
    throw new PdfReadError(msg(lang, 'pdf.error.invalid'), name === 'InvalidPDFException' ? 'invalid' : 'other');
  }
  try {
    const { doc: pdf } = opened;
    const pageCount = pdf.numPages;
    if (pageCount < 1) throw new PdfReadError(msg(lang, 'pdf.error.empty'), 'invalid');
    const count = Math.min(pageCount, MAX_PAGES);

    // Calques PDF masqués : leur contenu n'est pas affiché, on ne le lit donc pas.
    let isVisible: ((group: unknown) => boolean) | undefined;
    try {
      const config = await pdf.getOptionalContentConfig();
      isVisible = (group) => config.isVisible(group) !== false;
    } catch {
      isVisible = undefined;
    }

    const proxies: PDFPageProxy[] = [];
    const raw: RawPage[] = [];
    for (let n = 1; n <= count; n++) {
      const page = await pdf.getPage(n);
      proxies.push(page);
      raw.push(await extractPage(page, engine.ops, isVisible ? { isVisible } : {}));
      await pause();
    }
    const t1 = now();
    emit({ stage: 'open', status: 'done', counts: { pages: count, texts: raw.reduce((n, p) => n + p.texts.length, 0) } });
    await pause();

    const analysis = analysePdf(raw, fileName, { lang, onProgress: emit });
    const doc = analysis.doc;
    if (pageCount > count) doc.warnings.push(msg(lang, 'pdf.warn.pages', { total: pageCount, kept: count }));
    const t2 = now();

    // Image de fond : la page entière, dessinée une seule fois et partagée par toutes les feuilles de la page.
    if (options.images !== false && engine.canRender && canRenderImages()) {
      const multiPage = count > 1;
      for (let p = 0; p < proxies.length; p++) {
        const page = proxies[p]!;
        const sheets = analysis.placements.map((placement, i) => ({ placement, sheet: doc.sheets[i]! })).filter((x) => x.placement.page === page.pageNumber);
        if (sheets.length === 0) continue;
        const first = sheets[0]!.placement;
        const rendered = await renderPage(page, { rotation: first.rotation, raster: first.raster, pixelsPerPoint: first.pixelsPerPoint });
        let failed = rendered === null;
        if (rendered) {
          const image = await pageToObjectUrl(rendered, first.pageWidth, first.pageHeight);
          if (image) for (const { sheet } of sheets) sheet.image = { ...image };
          else failed = true;
          // Rend la mémoire du grand canevas sans attendre le ramasse-miettes.
          rendered.canvas.width = 0;
          rendered.canvas.height = 0;
        }
        if (failed) {
          const where = multiPage ? msg(lang, 'pdf.page', { page: page.pageNumber }) : '';
          const text = msg(lang, 'pdf.warn.render', { where });
          doc.warnings.push(text.charAt(0).toUpperCase() + text.slice(1));
        }
        page.cleanup();
        await pause();
      }
    }
    const t3 = now();
    return {
      doc,
      details: { pageCount, pages: analysis.pages, raw, timing: { extract: t1 - t0, analyse: t2 - t1, render: t3 - t2, total: t3 - t0 } },
    };
  } finally {
    try {
      await opened.close();
    } catch {
      // Sans conséquence.
    }
  }
}

/**
 * Lit un fichier PDF (plan vectoriel, plan scanné, ou les deux). Voir l'en-tête du module pour ce qui est proposé.
 * Les adresses d'objet des images de fond (`sheet.image.url`) vivent tant que la page n'est pas fermée ;
 * `releasePdfImages` les libère.
 */
export async function readPdf(data: ArrayBuffer, fileName: string, options: ReadPdfOptions = {}): Promise<PlanDocument> {
  return (await readPdfDetailed(data, fileName, options)).doc;
}

/** Libère les images de fond d'un document lu par `readPdf` (à appeler quand le document est abandonné). */
export function releasePdfImages(doc: PlanDocument): void {
  const revoke = (globalThis as { URL?: { revokeObjectURL?: (url: string) => void } }).URL?.revokeObjectURL;
  if (typeof revoke !== 'function') return;
  // Les feuilles d'une même page partagent leur image : chaque adresse n'est libérée qu'une fois.
  const urls = new Set(doc.sheets.map((s) => s.image?.url).filter((u): u is string => typeof u === 'string' && u.startsWith('blob:')));
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Sans conséquence.
    }
  }
}
