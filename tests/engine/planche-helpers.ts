/**
 * Lectures « parfaites » fabriquées à partir de la VÉRITÉ des planches synthétiques (tests/fixtures/pdf/planche) :
 * ce que le lecteur de planches devrait rendre. Elles servent à tester le modèle du dossier CPE indépendamment du
 * lecteur (autre lot). Données inventées uniquement.
 */
import type { ElementType, MaterialKey, ReadComposition, ReadLayer } from '../../src/core/reading';

export interface TruthLayer {
  thickness_cm: number | null;
  text: string;
  material_key: string;
}

export interface TruthComposition {
  key: string;
  title: string;
  element: string;
  to_unheated?: boolean | null;
  layers: TruthLayer[];
}

/** Familles de la vérité → familles du contrat de lecture. */
const MATERIAL: Record<string, MaterialKey> = {
  concrete: 'beton',
  eps: 'eps',
  xps: 'xps',
  pur: 'pur',
  pir: 'pir',
  render_exterior: 'enduit-facade',
  plaster: 'enduit-platre',
  plasterboard: 'inconnu',
  floor_finish: 'revetement-sol',
  screed: 'chape',
  pe_film: 'film',
  vapour_barrier: 'film',
  lean_concrete: 'beton-maigre',
  gravel: 'empierrement',
  impact_sound_insulation: 'isolant',
  waterproofing: 'etancheite',
  sand_lime_brick: 'silico-calcaire',
  wood_fibre: 'fibre-bois',
  mineral_wool: 'laine-minerale',
  battens: 'bois',
  roof_tiles: 'bardage',
};

function elementOf(c: TruthComposition): ElementType {
  switch (c.element) {
    case 'wall':
      return c.to_unheated ? 'wall-to-unheated' : 'external-wall';
    case 'ground-floor':
      return 'floor-on-ground';
    case 'floor-over-unheated':
      return 'floor-to-unheated';
    case 'intermediate-floor':
      return 'intermediate-floor';
    case 'roof':
      return 'roof';
    default:
      return 'unknown';
  }
}

const EXCLUDED: readonly MaterialKey[] = ['film', 'beton-maigre', 'empierrement'];
const INSULATION: readonly MaterialKey[] = ['eps', 'xps', 'pur', 'pir', 'laine-minerale', 'fibre-bois', 'isolant'];

/** Composition de la vérité → composition lue (couches de l'intérieur vers l'extérieur, comme le contrat). */
export function readCompositionOf(c: TruthComposition, confidence = 0.9): ReadComposition {
  const element = elementOf(c);
  let layers: ReadLayer[] = c.layers.map((l) => {
    const material = MATERIAL[l.material_key] ?? 'inconnu';
    return {
      raw: l.thickness_cm === null ? l.text : `${String(l.thickness_cm).replace('.', ',')}cm ${l.text}`,
      label: l.text,
      material,
      thicknessCm: l.thickness_cm,
      counted: l.thickness_cm !== null && !EXCLUDED.includes(material),
      doubt: null,
    };
  });
  // Toiture : la note se lit de haut en bas, donc de l'extérieur vers l'intérieur.
  if (element === 'roof') layers = layers.reverse();
  // Plancher sur terre : ce qui est sous le dernier isolant et exclu ne compte pas (déjà fait par EXCLUDED).
  if (element === 'floor-on-ground') {
    const last = layers.map((l) => INSULATION.includes(l.material)).lastIndexOf(true);
    layers = layers.map((l, i) => (i > last && EXCLUDED.includes(l.material) ? { ...l, counted: false } : l));
  }
  return { id: `comp-${c.key}`, element, layers, occurrences: [{ viewId: null, header: c.title }], confidence, doubt: null };
}

// Accès disque sous Node, sans dépendre des types de Node (absents du projet), comme tests/readers/pdf/helpers.ts.
interface FsLike {
  readFileSync(path: string | URL, encoding: 'utf-8'): string;
}
const fsModule = 'node:fs';

export async function readTruth(name: string): Promise<Record<string, unknown>> {
  const fs = (await import(/* @vite-ignore */ fsModule)) as FsLike;
  const url = new URL(`../fixtures/pdf/planche/${name}.truth.json`, import.meta.url);
  return JSON.parse(fs.readFileSync(url, 'utf-8')) as Record<string, unknown>;
}

export function truthCompositions(truth: Record<string, unknown>): TruthComposition[] {
  const pages = truth['pages'] as { compositions?: TruthComposition[] }[];
  return pages.flatMap((p) => p.compositions ?? []);
}
