/**
 * Initialisation de web-ifc sous NODE (tests Vitest, scripts) : le paquet résout alors vers sa version Node,
 * qui lit « web-ifc-node.wasm » à côté d'elle sur le disque.
 */
import { IfcAPI, LogLevel } from 'web-ifc';

export async function createIfcApi(): Promise<IfcAPI> {
  const api = new IfcAPI();
  await api.Init();
  api.SetLogLevel(LogLevel.LOG_LEVEL_OFF);
  return api;
}
