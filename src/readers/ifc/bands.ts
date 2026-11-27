/**
 * Découpe du bâtiment en TRANCHES de hauteur, une par étage réel.
 *
 * Pourquoi ne pas se fier au rattachement « mur → étage » du fichier : dans les exports Revit, un mur de 15 m
 * n'est rattaché qu'à son niveau de base et les étages supérieurs paraissent vides ; s'y ajoutent des niveaux
 * auxiliaires qui ne sont pas des étages (« T/FDN », « Ceiling », « Roof Line »…). On retient donc les niveaux
 * qui portent vraiment quelque chose (bases de murs, sols de locaux), distants d'au moins MIN_BAND, puis chaque
 * élément est affecté à toutes les tranches qu'il recouvre assez. Fonctions pures.
 */

export interface LevelInput {
  id: number;
  name: string;
  /** Altitude de découpe (m). */
  z: number;
  /** Altitude nominale à afficher (m). */
  elevation: number;
  /** Éléments rattachés au niveau par le fichier (indice faible). */
  contained: number;
}

export interface ZRange {
  zMin: number;
  zMax: number;
}

export interface Band {
  level: LevelInput;
  /** Bornes de la tranche ; −∞ pour la première, +∞ pour la dernière. */
  zFrom: number;
  zTo: number;
  /** Niveaux auxiliaires absorbés par la tranche. */
  absorbed: LevelInput[];
}

/** Deux niveaux plus proches que cela ne font qu'un étage (m). */
export const MIN_BAND = 1.8;
/** Un niveau à moins de cela sous le sommet des murs ne porte pas d'étage (niveau de toiture, m). */
const TOP_MARGIN = 1.0;
/** Tolérance « posé sur le niveau » pour les bases de murs et les sols de locaux (m). */
const BASE_TOL = 0.35;
/**
 * Poids d'un élément rattaché au niveau par le fichier. Ce rattachement ne décrit pas les étages (un mur Revit de
 * 15 m n'est rattaché qu'à sa base) mais distingue bien les niveaux principaux des plans de référence :
 * « Level 1 » 117 éléments contre 31 pour « Level 1 Living Rm. », « Level 2 » 72 contre 5 pour « Ceiling ».
 */
const CONTAINED_WEIGHT = 0.25;
const CONTAINED_CAP = 200;

export interface BandSelection {
  bands: Band[];
  /** Niveaux écartés parce que rien ne s'élève au-dessus (toiture). */
  dropped: LevelInput[];
}

/**
 * Choisit les niveaux qui sont de vrais étages et en déduit les tranches.
 * @param levels  niveaux du fichier
 * @param walls   étendue verticale de chaque mur
 * @param spaces  étendue verticale de chaque local
 */
export function selectBands(levels: readonly LevelInput[], walls: readonly ZRange[], spaces: readonly ZRange[]): BandSelection {
  const sorted = [...levels].sort((a, b) => a.z - b.z || a.id - b.id);
  if (sorted.length === 0) return { bands: [], dropped: [] };
  const solids = walls.length > 0 ? walls : spaces;
  let top = -Infinity;
  for (const s of solids) if (s.zMax > top) top = s.zMax;

  // 1. Niveaux de toiture : rien de consistant au-dessus.
  const dropped: LevelInput[] = [];
  let candidates = sorted;
  if (Number.isFinite(top)) {
    const kept = sorted.filter((l) => l.z < top - TOP_MARGIN);
    if (kept.length > 0) {
      for (const l of sorted) if (!kept.includes(l)) dropped.push(l);
      candidates = kept;
    }
  }

  // 2. Indices géométriques : ce qui est posé sur le niveau.
  const score = new Map<LevelInput, number>();
  for (const l of candidates) {
    let s = 0;
    for (const w of walls) if (Math.abs(w.zMin - l.z) <= BASE_TOL) s += 1;
    for (const sp of spaces) if (Math.abs(sp.zMin - l.z) <= BASE_TOL) s += 2;
    s += Math.min(l.contained, CONTAINED_CAP) * CONTAINED_WEIGHT;
    score.set(l, s);
  }

  // 3. Les mieux notés d'abord ; un niveau trop proche d'un niveau déjà retenu est absorbé, de même qu'un niveau
  //    sur lequel rien n'est posé alors que d'autres portent quelque chose (plan de référence).
  const byScore = [...candidates].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || a.z - b.z);
  const someEvidence = byScore.some((l) => (score.get(l) ?? 0) > 0);
  const accepted: LevelInput[] = [];
  for (const l of byScore) {
    if (someEvidence && (score.get(l) ?? 0) <= 0) continue;
    if (accepted.every((a) => Math.abs(a.z - l.z) >= MIN_BAND)) accepted.push(l);
  }
  accepted.sort((a, b) => a.z - b.z);

  const bands: Band[] = accepted.map((level, k) => ({
    level,
    zFrom: k === 0 ? -Infinity : level.z,
    zTo: k === accepted.length - 1 ? Infinity : accepted[k + 1]!.z,
    absorbed: [],
  }));
  for (const l of candidates) {
    if (accepted.includes(l)) continue;
    // Rattaché à la tranche qui le contient.
    const band = bands.find((b) => l.z >= b.zFrom && l.z < b.zTo) ?? bands[0];
    band?.absorbed.push(l);
  }
  return { bands, dropped };
}

/**
 * Recouvrement vertical exigé pour qu'un élément appartienne à une tranche bornée à [lo, hi]
 * (bornes déjà ramenées à l'étendue réelle du bâtiment).
 */
export function overlapNeeded(lo: number, hi: number): number {
  return Math.min(1.0, 0.5 * Math.max(hi - lo, 0));
}

/**
 * Vrai si l'élément appartient à la tranche : il la recouvre assez, ou il y tient pour plus de la moitié de sa
 * propre hauteur (murs de jambette de 50 cm sous une toiture inclinée).
 */
export function belongsToBand(range: ZRange, lo: number, hi: number): boolean {
  const overlap = Math.min(hi, range.zMax) - Math.max(lo, range.zMin);
  if (overlap <= 0) return false;
  if (overlap >= overlapNeeded(lo, hi) - 1e-6) return true;
  return overlap > 0.5 * (range.zMax - range.zMin);
}
