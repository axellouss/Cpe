/**
 * Allègement de l'affichage d'une feuille très chargée. Sans dépendance lourde : utilisable sur le fil principal.
 */
import { SEG_FILL, SEG_HATCH } from './raw';
import type { RawDrawing } from './raw';

/** Nombre de traits au-delà duquel l'affichage d'une feuille est allégé. */
export const MAX_DISPLAY_SEGMENTS = 150_000;

/** Allège l'affichage : hachures et remplissages d'abord, puis les plus petits traits (jamais ceux des murs). */
export function thinSegments(
  raw: Pick<RawDrawing, 'segXY' | 'segKind' | 'segLayer'>,
  segIdx: readonly number[],
  wallLayers: ReadonlySet<number>,
): { kept: number[]; dropped: number } {
  if (segIdx.length <= MAX_DISPLAY_SEGMENTS) return { kept: [...segIdx], dropped: 0 };
  let kept = segIdx.filter((i) => raw.segKind[i] !== SEG_HATCH && raw.segKind[i] !== SEG_FILL);
  if (kept.length > MAX_DISPLAY_SEGMENTS) {
    const length = (i: number): number => Math.hypot(raw.segXY[4 * i + 2]! - raw.segXY[4 * i]!, raw.segXY[4 * i + 3]! - raw.segXY[4 * i + 1]!);
    const walls = kept.filter((i) => wallLayers.has(raw.segLayer[i]!));
    const others = kept.filter((i) => !wallLayers.has(raw.segLayer[i]!));
    const room = Math.max(0, MAX_DISPLAY_SEGMENTS - walls.length);
    if (others.length > room) {
      const lengths = Float64Array.from(others, length).sort();
      const threshold = lengths[others.length - room] ?? Infinity;
      const long = others.filter((i) => length(i) > threshold);
      kept = [...walls, ...long].sort((a, b) => a - b);
    }
  }
  return { kept, dropped: segIdx.length - kept.length };
}
