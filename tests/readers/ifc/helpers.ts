/**
 * Aides des tests du lecteur IFC : chargement des modèles d'essai (texte STEP importé par Vite, sans accès disque)
 * et accès facultatif aux modèles réels de la recherche (hors dépôt).
 */
import type { PlanDocument, PlanSheet, Vec2 } from '../../../src/core/types';

export function toBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function sheetNamed(doc: PlanDocument, name: string): PlanSheet {
  const sheet = doc.sheets.find((s) => s.name === name);
  if (!sheet) throw new Error(`feuille « ${name} » absente (feuilles : ${doc.sheets.map((s) => s.name).join(', ')})`);
  return sheet;
}

/** Distance d'un point au contour (polygone fermé). */
export function distanceToRing(p: Vec2, ring: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

// ── Accès disque sous Node, sans dépendre des types de Node (absents du projet) ──

interface FsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
}

export async function nodeFs(): Promise<FsLike> {
  const name = 'node:fs';
  return (await import(/* @vite-ignore */ name)) as FsLike;
}

/** Dossier des modèles IFC réels (téléchargements tiers, jamais copiés dans le dépôt), ou null s'il n'est pas indiqué. */
export function samplesDir(): string | null {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const dir = env?.PLAN2CPE_IFC_SAMPLES;
  return dir && dir.trim() !== '' ? dir.replace(/\/+$/, '') : null;
}
