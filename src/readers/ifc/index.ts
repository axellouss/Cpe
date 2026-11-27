import type { PlanDocument } from '../../core/types';

/** À IMPLÉMENTER (contrat : voir src/core/types.ts → PlanDocument). */
export async function readIfc(_data: ArrayBuffer, _fileName: string): Promise<PlanDocument> {
  throw new Error('readIfc: pas encore implémenté');
}
