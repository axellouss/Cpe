/**
 * Outils communs aux tests du lecteur DWG / DXF : lecture des plans d'essai, vérité terrain, mesures.
 */
import { edgeAzimuth, nearestEdge, polygonArea } from '../../../src/core/geometry';
import type { DetectedOpening, PlanDocument, PlanSheet, Vec2 } from '../../../src/core/types';
import { readCadDetailed } from '../../../src/readers/cad';
import type { CadReadDetails } from '../../../src/readers/cad';

// ── Accès disque sous Node, sans dépendre des types de Node (absents du projet) ──

interface FsLike {
  existsSync(path: string | URL): boolean;
  readFileSync(path: string | URL): Uint8Array;
}

const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as FsLike;

const FIXTURE_DIR = new URL('../../fixtures/cad/', import.meta.url);
const SAMPLE_DIR = new URL('../../../public/samples/', import.meta.url);

export function bytesOf(path: string | URL): ArrayBuffer {
  const buf = fs.readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function fileExists(path: string | URL): boolean {
  return fs.existsSync(path);
}

export function fixtureBytes(name: string): ArrayBuffer {
  return bytesOf(new URL(name, FIXTURE_DIR));
}

/** Texte d'un plan d'essai DXF encodé en UTF-8 (R2007 et suivants). */
export function fixtureText(name: string): string {
  return new TextDecoder('utf-8').decode(fixtureBytes(name));
}

export function sampleBytes(name: string): ArrayBuffer {
  return bytesOf(new URL(name, SAMPLE_DIR));
}

/**
 * Dossier de fichiers réels de tiers (jamais copiés dans le dépôt), indiqué par la variable d'environnement
 * PLAN2CPE_CAD_SAMPLES ; null si elle n'est pas définie.
 */
export function realSamplesDir(): string | null {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const dir = env?.PLAN2CPE_CAD_SAMPLES;
  return dir && dir.trim() !== '' ? dir.replace(/\/+$/, '') : null;
}

export function textBytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

export interface Read {
  doc: PlanDocument;
  details: CadReadDetails;
}

export async function readFixture(name: string): Promise<Read> {
  const kind = name.toLowerCase().endsWith('.dwg') ? 'dwg' : 'dxf';
  return readCadDetailed(fixtureBytes(name), name.replace(/^.*\//, ''), kind);
}

// ───────────────────────────── Vérité terrain ─────────────────────────────

export interface TruthRoom {
  floor: string;
  key: string;
  name: string;
  area_m2: number;
  stated_m2: number | null;
  heated: boolean;
  centroid_cm: [number, number];
}

export interface TruthOpening {
  floor: string;
  id: string;
  width_cm: number;
  height_cm?: number;
  centre_cm: [number, number];
  azimuth_deg?: number;
  exterior: boolean;
}

export interface TruthFloor {
  floor: string;
  footprint_all_m2: number;
  footprint_all_perimeter_m: number;
  heated_gross_m2: number;
}

export interface TruthFile {
  units_per_m: number;
  origin?: [number, number];
  origins?: Record<string, [number, number]>;
  rooms: TruthRoom[];
  windows: TruthOpening[];
  doors: TruthOpening[];
  floors: TruthFloor[];
}

interface Truth {
  north_bearing_deg_clockwise_from_plusY: number;
  files: Record<string, TruthFile>;
}

export const TRUTH = JSON.parse(fixtureText('fixture_truth.json')) as Truth;

export function truthOf(file: string): TruthFile {
  const t = TRUTH.files[file];
  if (!t) throw new Error(`pas de vérité terrain pour ${file}`);
  return t;
}

/** Azimut du HAUT de la feuille attendu : le nord pointe 20° à droite de la verticale → le haut regarde à 340°. */
export const EXPECTED_NORTH_ANGLE = (360 - TRUTH.north_bearing_deg_clockwise_from_plusY) % 360;

// ───────────────────────────── Mesures ─────────────────────────────

export function scaleOf(sheet: PlanSheet): number {
  if (!sheet.metresPerUnit) throw new Error('échelle inconnue');
  return sheet.metresPerUnit.value;
}

/** Surface du contour détecté, en m². */
export function outlineArea(sheet: PlanSheet): number {
  const outline = sheet.detected.outline;
  if (!outline) throw new Error(`pas de contour sur « ${sheet.name} »`);
  const m = scaleOf(sheet);
  return polygonArea(outline) * m * m;
}

export function sortedWidths(openings: readonly DetectedOpening[], kind?: DetectedOpening['kind']): number[] {
  return openings
    .filter((o) => kind === undefined || o.kind === kind)
    .map((o) => Math.round((o.width ?? 0) * 100) / 100)
    .sort((a, b) => a - b);
}

/** Largeurs attendues (m), triées. */
export function truthWidths(openings: readonly TruthOpening[], floor?: string): number[] {
  return openings
    .filter((o) => o.exterior && (floor === undefined || o.floor === floor))
    .map((o) => o.width_cm / 100)
    .sort((a, b) => a - b);
}

/** Position d'un point de la vérité terrain (cm depuis l'origine du plan) dans le repère de la feuille. */
export function truthToSheet(point: [number, number], planOrigin: [number, number], unitsPerCm: number, sheetOrigin: { x0: number; y0: number }): Vec2 {
  const cadX = planOrigin[0] + point[0] * unitsPerCm;
  const cadY = planOrigin[1] + point[1] * unitsPerCm;
  return { x: cadX - sheetOrigin.x0, y: sheetOrigin.y0 - cadY };
}

/** Azimut (0 = nord, sens horaire) de la façade qui porte l'ouverture, d'après le contour détecté et le nord lu. */
export function openingAzimuth(opening: DetectedOpening, outline: readonly Vec2[], northAngle: number): number {
  const mid = { x: (opening.a.x + opening.b.x) / 2, y: (opening.a.y + opening.b.y) / 2 };
  const edge = nearestEdge(mid, outline);
  if (!edge) throw new Error('contour vide');
  return edgeAzimuth(outline, edge.index, northAngle);
}

export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ───────────────────────────── DXF écrits à la main ─────────────────────────────

/** Petit DXF ASCII (UTF-8, version 2010) : en-tête minimal + entités. */
export function miniDxf(insUnits: number, entities: string[], extraSections: string[] = [], version = 'AC1024'): ArrayBuffer {
  const lines = [
    '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', version, '9', '$INSUNITS', '70', String(insUnits), '0', 'ENDSEC',
    ...extraSections,
    '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF',
  ];
  return textBytes(lines.join('\n') + '\n');
}

export function dxfLine(layer: string, x1: number, y1: number, x2: number, y2: number): string[] {
  return ['0', 'LINE', '8', layer, '10', String(x1), '20', String(y1), '11', String(x2), '21', String(y2)];
}

export function dxfRect(layer: string, x0: number, y0: number, x1: number, y1: number): string[] {
  return [...dxfLine(layer, x0, y0, x1, y0), ...dxfLine(layer, x1, y0, x1, y1), ...dxfLine(layer, x1, y1, x0, y1), ...dxfLine(layer, x0, y1, x0, y0)];
}

export function dxfText(layer: string, x: number, y: number, height: number, text: string): string[] {
  return ['0', 'TEXT', '8', layer, '10', String(x), '20', String(y), '40', String(height), '1', text];
}

/** Une pièce fermée de 4,00 × 5,00 (en unités `k` par cm) entourée de murs de 30 cm, avec son étiquette. */
export function oneRoom(k: number, wallLayer = 'MUR'): string[] {
  return [
    ...dxfRect(wallLayer, 0, 0, 460 * k, 560 * k),
    ...dxfRect(wallLayer, 30 * k, 30 * k, 430 * k, 530 * k),
    ...dxfText('TEXTE', 150 * k, 280 * k, 12 * k, 'Séjour 20,00 m²'),
  ];
}
