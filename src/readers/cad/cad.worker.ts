/**
 * Worker de lecture DWG / DXF : décodage et analyse hors du fil principal (voir offthread.ts).
 * Un worker lit UN fichier puis est arrêté par le fil principal.
 */
import type { CadWorkerReply, CadWorkerRequest } from './offthread';
import { readCadInProcess } from './read';

/** Portée d'un worker dédié, réduite à ce qui sert ici (le projet est compilé avec les types du DOM). */
interface WorkerScope {
  onmessage: ((event: { data: CadWorkerRequest }) => void) | null;
  postMessage(reply: CadWorkerReply, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { data, fileName, kind, options } = event.data;
  // Envoyé AVANT tout calcul : le fil principal sait que le worker tourne, même si le décodage se bloque ensuite.
  scope.postMessage({ type: 'started' });
  readCadInProcess(data, fileName, kind, options).then(
    ({ doc, details }) => {
      // Les traits des feuilles sont cédés au fil principal, pas copiés.
      const transfer: Transferable[] = [];
      for (const sheet of doc.sheets) if (sheet.segments) transfer.push(sheet.segments.buffer as ArrayBuffer);
      scope.postMessage({ type: 'done', doc, details }, transfer);
    },
    (err: unknown) => {
      scope.postMessage({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
    },
  );
};
