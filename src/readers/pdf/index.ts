import type { PlanDocument } from '../../core/types';

/** À IMPLÉMENTER (contrat : voir src/core/types.ts → PlanDocument). */
export async function readPdf(_data: ArrayBuffer, _fileName: string): Promise<PlanDocument> {
  throw new Error('readPdf: pas encore implémenté');
}
