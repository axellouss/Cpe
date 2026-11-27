/**
 * pdf.js sous NODE (tests Vitest, scripts) : version « legacy », sans worker (pdf.js bascule seul sur son
 * faux worker dans le fil principal) et sans rendu d'image.
 */
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { OpCodes, PdfEngine } from './pdfjs';

export function createPdfEngine(): PdfEngine {
  return {
    ops: OPS as unknown as OpCodes,
    canRender: false,
    open: async (data) => {
      const task = getDocument({
        // pdf.js prend possession du tampon : on lui en donne une copie.
        data: data.slice(),
        useSystemFonts: true,
        verbosity: 0,
      });
      const doc = await task.promise;
      return { doc, close: () => task.destroy() };
    },
  };
}
