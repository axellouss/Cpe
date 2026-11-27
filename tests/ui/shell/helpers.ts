/**
 * Constructeurs pour les tests de l'application : feuilles et documents « lus » fabriqués à la main
 * (les vrais lecteurs sont testés ailleurs), stockage en mémoire, horloge réglable.
 */
import type { PlanDocument, PlanSheet, SheetDetection, Sourced, Vec2 } from '../../../src/core/types';
import { memoryStorage } from '../../../src/ui/shell/autosave';
import { createShellStore } from '../../../src/ui/shell/store';
import type { ShellDeps, ShellStore } from '../../../src/ui/shell/store';

/** Rectangle largeur × profondeur en unités de feuille (sens horaire à l'écran). */
export function rect(width: number, depth: number): Vec2[] {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: depth },
    { x: 0, y: depth },
  ];
}

export interface SheetOptions {
  outline?: Vec2[] | null;
  scale?: Sourced<number> | null;
  detected?: Partial<SheetDetection>;
  imageUrl?: string;
}

/** Feuille de 10 m × 8 m dessinée en centimètres, échelle lue sur le plan, sauf indication contraire. */
export function sheet(id: string, name: string, options: SheetOptions = {}): PlanSheet {
  const outline = options.outline === undefined ? rect(1000, 800) : options.outline;
  const detected: SheetDetection = { rooms: [], openings: [], notes: [], ...options.detected };
  if (outline) detected.outline = outline;
  const result: PlanSheet = {
    id,
    name,
    bbox: { minX: 0, minY: 0, maxX: 1200, maxY: 1000 },
    metresPerUnit: options.scale === undefined ? { value: 0.01, from: 'plan', note: 'Unité du dessin : centimètres.' } : options.scale,
    detected,
  };
  if (options.imageUrl) result.image = { url: options.imageUrl, x: 0, y: 0, width: 1200, height: 1000 };
  return result;
}

export function doc(fileName: string, sheets: PlanSheet[], extra: Partial<PlanDocument> = {}): PlanDocument {
  return { fileName, kind: 'dxf', sheets, storeysAligned: false, warnings: [], ...extra };
}

/** Maison de deux niveaux avec des pièces au rez-de-chaussée, dont une à trancher. */
export function houseDoc(fileName = 'maison.dxf'): PlanDocument {
  return doc(
    fileName,
    [
      sheet('cad-1', 'Rez-de-chaussée', {
        detected: {
          rooms: [
            { name: 'Séjour', statedArea: 37, heatedGuess: 'yes' },
            { name: 'Cuisine', statedArea: 11, heatedGuess: 'yes' },
            { name: 'Buanderie', statedArea: 4.5, heatedGuess: 'ask' },
          ],
          openings: [
            { kind: 'window', a: { x: 200, y: 0 }, b: { x: 320, y: 0 }, width: 1.2, exterior: true },
            { kind: 'door', a: { x: 600, y: 800 }, b: { x: 700, y: 800 }, width: 1.0, height: 2.1, exterior: true },
          ],
          notes: ['Calque des murs : MUR.'],
        },
      }),
      sheet('cad-2', 'Étage'),
    ],
    { northAngle: { value: 340, from: 'plan', note: 'Flèche du nord lue sur le plan.' }, warnings: ['2 plans trouvés dans le même dessin.'] },
  );
}

export interface TestStore {
  store: ShellStore;
  storage: ReturnType<typeof memoryStorage>;
  revoked: string[];
  /** Avance l'horloge (ms). */
  tick(ms: number): void;
}

/** Magasin isolé : stockage en mémoire, enregistrement immédiat, horloge à la main. */
export function testStore(overrides: Partial<ShellDeps> = {}, initial: Record<string, string> = {}): TestStore {
  let now = 1_000_000;
  const storage = memoryStorage(initial);
  const revoked: string[] = [];
  const store = createShellStore({
    storage,
    now: () => now,
    revokeUrl: (url) => {
      revoked.push(url);
    },
    autosaveDelay: 0,
    fetchSample: async () => {
      throw new Error('sample-missing');
    },
    languages: ['fr-LU'],
    ...overrides,
  });
  return {
    store,
    storage,
    revoked,
    tick: (ms) => {
      now += ms;
    },
  };
}

/** Faux fichier déposé. */
export function file(name: string): { name: string; arrayBuffer(): Promise<ArrayBuffer> } {
  return { name, arrayBuffer: async () => new ArrayBuffer(8) };
}
