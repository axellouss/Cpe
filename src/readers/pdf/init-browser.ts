/**
 * pdf.js dans le NAVIGATEUR : worker servi comme une ressource du build, décodeurs d'images (JBIG2, JPEG 2000,
 * profils ICC) et polices standard embarqués eux aussi. Rien n'est téléchargé d'un CDN : l'application reste
 * utilisable hors ligne et le plan ne quitte pas le poste.
 */
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist';
import foxitDingbats from 'pdfjs-dist/standard_fonts/FoxitDingbats.pfb?url';
import foxitFixed from 'pdfjs-dist/standard_fonts/FoxitFixed.pfb?url';
import foxitFixedBold from 'pdfjs-dist/standard_fonts/FoxitFixedBold.pfb?url';
import foxitFixedBoldItalic from 'pdfjs-dist/standard_fonts/FoxitFixedBoldItalic.pfb?url';
import foxitFixedItalic from 'pdfjs-dist/standard_fonts/FoxitFixedItalic.pfb?url';
import foxitSerif from 'pdfjs-dist/standard_fonts/FoxitSerif.pfb?url';
import foxitSerifBold from 'pdfjs-dist/standard_fonts/FoxitSerifBold.pfb?url';
import foxitSerifBoldItalic from 'pdfjs-dist/standard_fonts/FoxitSerifBoldItalic.pfb?url';
import foxitSerifItalic from 'pdfjs-dist/standard_fonts/FoxitSerifItalic.pfb?url';
import foxitSymbol from 'pdfjs-dist/standard_fonts/FoxitSymbol.pfb?url';
import liberationBold from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url';
import liberationBoldItalic from 'pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf?url';
import liberationItalic from 'pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf?url';
import liberationRegular from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url';
import jbig2Wasm from 'pdfjs-dist/wasm/jbig2.wasm?url';
import openjpegWasm from 'pdfjs-dist/wasm/openjpeg.wasm?url';
import qcmsWasm from 'pdfjs-dist/wasm/qcms_bg.wasm?url';
import type { OpCodes, PdfEngine } from './pdfjs';

/** Fichiers annexes que pdf.js demande par leur nom → adresse dans le build. */
const BUNDLED: Readonly<Record<string, string>> = {
  'jbig2.wasm': jbig2Wasm,
  'openjpeg.wasm': openjpegWasm,
  'qcms_bg.wasm': qcmsWasm,
  'FoxitDingbats.pfb': foxitDingbats,
  'FoxitFixed.pfb': foxitFixed,
  'FoxitFixedBold.pfb': foxitFixedBold,
  'FoxitFixedBoldItalic.pfb': foxitFixedBoldItalic,
  'FoxitFixedItalic.pfb': foxitFixedItalic,
  'FoxitSerif.pfb': foxitSerif,
  'FoxitSerifBold.pfb': foxitSerifBold,
  'FoxitSerifBoldItalic.pfb': foxitSerifBoldItalic,
  'FoxitSerifItalic.pfb': foxitSerifItalic,
  'FoxitSymbol.pfb': foxitSymbol,
  'LiberationSans-Bold.ttf': liberationBold,
  'LiberationSans-BoldItalic.ttf': liberationBoldItalic,
  'LiberationSans-Italic.ttf': liberationItalic,
  'LiberationSans-Regular.ttf': liberationRegular,
};

/**
 * Remplace le chargeur de fichiers annexes de pdf.js (qui attend un dossier à noms fixes) :
 * les noms sont traduits vers les adresses à empreinte du build.
 */
class BundledBinaryDataFactory {
  async fetch({ filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = BUNDLED[filename];
    // Tables CMap asiatiques, etc. : non embarquées, pdf.js sait s'en passer.
    if (!url) throw new Error(`Ressource pdf.js non embarquée : ${filename}`);
    // L'adresse fournie par le build est absolue, ou relative à la page (jamais à ce module).
    const response = await fetch(new URL(url, globalThis.location?.href ?? import.meta.url));
    if (!response.ok) throw new Error(`Ressource pdf.js introuvable : ${filename}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

let workerReady = false;

export function createPdfEngine(): PdfEngine {
  if (!workerReady) {
    GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
    workerReady = true;
  }
  return {
    ops: OPS as unknown as OpCodes,
    canRender: true,
    open: async (data) => {
      const task = getDocument({
        // pdf.js transfère le tampon à son worker : on lui en donne une copie.
        data: data.slice(),
        BinaryDataFactory: BundledBinaryDataFactory,
        useWorkerFetch: false,
        // Polices non incorporées : on prend les polices standard embarquées plutôt que celles du poste,
        // pour que le plan s'affiche partout de la même façon.
        useSystemFonts: false,
        verbosity: 0,
      });
      const doc = await task.promise;
      return { doc, close: () => task.destroy() };
    },
  };
}
