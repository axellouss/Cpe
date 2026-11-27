/**
 * Initialisation de web-ifc dans le NAVIGATEUR (page ou web worker).
 * Le WebAssembly mono-fil est servi comme une ressource du build (URL fournie par Vite) ; la version multi-fil
 * n'est jamais utilisée : elle exige des en-têtes COOP/COEP et met ~10 s à démarrer sans rien accélérer.
 */
import { IfcAPI, LogLevel } from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';

export async function createIfcApi(): Promise<IfcAPI> {
  const api = new IfcAPI();
  // L'URL du build contient une empreinte : on la donne telle quelle au chargeur, quel que soit le nom demandé.
  const absolute = new URL(wasmUrl, globalThis.location?.href ?? import.meta.url).href;
  api.SetWasmPath(absolute.slice(0, absolute.lastIndexOf('/') + 1), true);
  await api.Init((path: string, prefix: string) => (path.endsWith('.wasm') ? absolute : prefix + path), true);
  api.SetLogLevel(LogLevel.LOG_LEVEL_OFF);
  return api;
}
