import type { PlanDocument } from '../../core/types';

/** À IMPLÉMENTER (contrat : voir src/core/types.ts → PlanDocument). */
export async function readCad(_data: ArrayBuffer, _fileName: string, _kind: 'dwg' | 'dxf'): Promise<PlanDocument> {
  throw new Error('readCad: pas encore implémenté');
}
