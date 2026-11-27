/**
 * Emprise au sol d'une tranche de hauteur : projection des murs et des locaux, interstices fermés, trous remplis,
 * puis nettoyage de ce qui n'enferme aucun volume — murs isolés (jardin, soutènement) et murs en saillie.
 *
 * Deux temps pour les saillies : les « bras » minces sont d'abord repérés sur la trame ; un mur dont l'essentiel
 * tombe dans un bras est alors retiré EN ENTIER et l'emprise recalculée sans lui (aucune trace sur le contour,
 * même pour un bâtiment tourné) ; ce qui dépasse encore (pignon plus large que le volume) est rogné sur la trame.
 * Fonction pure.
 */
import {
  erodeMask,
  flaggedShare,
  footprintMask,
  labelPieces,
  rasterizeOccupancy,
  removeThinArms,
  type Grid,
  type Pieces,
} from './raster';

export interface FootprintSettings {
  /** Rayon de fermeture des interstices entre murs (cellules). */
  closeCells: number;
  /** Rayon de fermeture quand il n'y a aucun mur : les locaux sont séparés par l'épaisseur des cloisons (cellules). */
  spaceCloseCells: number;
  /** Demi-largeur en dessous de laquelle une saillie est un « bras » (cellules). */
  armCells: number;
  /** Un morceau doit contenir un carré de ce demi-côté (cellules). */
  coreCells: number;
  /** Taille minimale d'un morceau (cellules). */
  minPieceCells: number;
}

export interface Footprint {
  pieces: Pieces;
  /** Indices (dans `walls`) des murs laissés hors de l'emprise. */
  detached: Set<number>;
  /** Cellules retirées comme saillies (murs détachés compris). */
  armCells: number;
  /** Vrai si l'emprise ne vient que des locaux (aucun mur). */
  spacesOnly: boolean;
}

/** Part d'un mur prise dans une saillie au-delà de laquelle il est tenu pour étranger au volume. */
const DETACHED_SHARE = 0.6;

export function buildFootprint(grid: Grid, walls: readonly Float32Array[], spaces: readonly Float32Array[], s: FootprintSettings): Footprint {
  const n = grid.nx * grid.ny;
  const spacesOnly = walls.length === 0;
  const close = spacesOnly ? Math.max(s.closeCells, s.spaceCloseCells) : s.closeCells;
  const build = (skip: ReadonlySet<number>): Uint8Array => {
    const occ = new Uint8Array(n);
    walls.forEach((w, i) => {
      if (!skip.has(i)) rasterizeOccupancy(grid, w, occ);
    });
    for (const sp of spaces) rasterizeOccupancy(grid, sp, occ);
    return footprintMask(grid, occ, close);
  };
  const detached = new Set<number>();
  let mask = build(detached);
  const flags = new Uint8Array(n);
  let armCells = removeThinArms(grid, mask, s.armCells, flags);
  if (armCells > 0) {
    walls.forEach((w, i) => {
      if (flaggedShare(grid, w, flags) > DETACHED_SHARE) detached.add(i);
    });
    if (detached.size > 0) {
      mask = build(detached);
      removeThinArms(grid, mask, s.armCells);
    }
  }
  const pieces = labelPieces(grid, mask, s.minPieceCells, erodeMask(grid, mask, s.coreCells));
  return { pieces, detached, armCells, spacesOnly };
}
