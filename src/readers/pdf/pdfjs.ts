/**
 * Frontière avec pdf.js : ce que le lecteur utilise de la bibliothèque, et rien d'autre.
 * Deux initialisations existent (init-browser.ts avec un worker, init-node.ts sans) ; toutes deux
 * rendent un `PdfEngine`.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

export type { PDFDocumentProxy, PDFPageProxy };

/** Codes d'opérateurs de pdf.js (nom → numéro). */
export type OpCodes = Readonly<Record<string, number>>;

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  /** Libère le document (et son worker). */
  close(): Promise<void>;
}

export interface PdfEngine {
  /** Ouvre un document à partir de ses octets (le tampon est copié : l'appelant garde le sien). */
  open(data: Uint8Array): Promise<OpenedPdf>;
  ops: OpCodes;
  /** Vrai si l'environnement sait dessiner une page (navigateur). */
  canRender: boolean;
}

/** Erreur de lecture d'un PDF, avec un message déjà rédigé pour l'utilisateur. */
export class PdfReadError extends Error {
  constructor(
    message: string,
    public readonly reason: 'password' | 'invalid' | 'other',
  ) {
    super(message);
    this.name = 'PdfReadError';
  }
}
