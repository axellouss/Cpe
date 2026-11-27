import type { PlanDocument } from '../../core/types';

/** À IMPLÉMENTER (contrat : voir src/core/types.ts → PlanDocument). */
export async function readImage(_data: ArrayBuffer, _fileName: string): Promise<PlanDocument> {
  throw new Error('readImage: pas encore implémenté');
}
