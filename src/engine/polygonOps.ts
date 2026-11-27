/**
 * Opérations booléennes sur polygones (différence, retrait de régions) — SEUL fichier du moteur qui touche à jsts.
 * jsts est typé en `any` : on l'isole ici derrière des fonctions typées.
 */
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import BufferParameters from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import SnapIfNeededOverlayOp from 'jsts/org/locationtech/jts/operation/overlay/snap/SnapIfNeededOverlayOp.js';
import type { Vec2 } from '../core/types';

/** Ce dont on a besoin d'une géométrie jsts. */
interface AreaGeometry {
  getArea(): number;
}

const factory = new GeometryFactory();

function toPolygon(poly: readonly Vec2[]): AreaGeometry {
  const ring = poly.map((p) => new Coordinate(p.x, p.y));
  const first = poly[0]!;
  ring.push(new Coordinate(first.x, first.y));
  return factory.createPolygon(factory.createLinearRing(ring)) as AreaGeometry;
}

/**
 * Aire de (a − b) : la partie de `a` qui n'est pas couverte par `b`.
 * Renvoie null si jsts échoue (polygone croisé, cas dégénéré) : l'appelant se replie sur une différence d'aires.
 */
export function differenceArea(a: readonly Vec2[], b: readonly Vec2[]): number | null {
  if (a.length < 3) return 0;
  if (b.length < 3) return null;
  try {
    const result = SnapIfNeededOverlayOp.overlayOp(toPolygon(a), toPolygon(b), OverlayOp.DIFFERENCE) as AreaGeometry;
    const area = result.getArea();
    return Number.isFinite(area) ? Math.max(0, area) : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── Retrait de régions (contour chauffé) ─────────────────────────────

interface JCoord {
  x: number;
  y: number;
}

/** Ce dont on a besoin d'une géométrie jsts pour en relire les polygones. */
interface PolyGeometry extends AreaGeometry {
  getNumGeometries(): number;
  getGeometryN(i: number): PolyGeometry;
  getGeometryType(): string;
  isEmpty(): boolean;
  getExteriorRing(): PolyGeometry;
  getNumInteriorRing(): number;
  getCoordinates(): JCoord[];
}

export interface PolygonPiece {
  outer: Vec2[];
  /** Nombre de trous (un contour d'étage n'en admet aucun). */
  holes: number;
  area: number;
}

function mitre(): BufferParameters {
  const p = new BufferParameters();
  p.setJoinStyle(BufferParameters.JOIN_MITRE);
  p.setMitreLimit(5);
  return p;
}

function grow(geom: unknown, distance: number): PolyGeometry {
  return BufferOp.bufferOp(geom, distance, mitre()) as PolyGeometry;
}

function collectPieces(geom: PolyGeometry, out: PolygonPiece[] = []): PolygonPiece[] {
  if (!geom || geom.isEmpty()) return out;
  const type = geom.getGeometryType();
  if (type === 'Polygon') {
    const cs = geom.getExteriorRing().getCoordinates();
    const outer: Vec2[] = [];
    for (let i = 0; i < cs.length - 1; i++) outer.push({ x: cs[i]!.x, y: cs[i]!.y });
    if (outer.length >= 3) out.push({ outer, holes: geom.getNumInteriorRing(), area: geom.getArea() });
  } else if (type === 'MultiPolygon' || type === 'GeometryCollection') {
    for (let i = 0; i < geom.getNumGeometries(); i++) collectPieces(geom.getGeometryN(i), out);
  }
  return out;
}

/**
 * `outline` privé de l'union des polygones `regions`, puis débarrassé des bavures plus étroites que 2 × `clean`
 * (ouverture morphologique à angles vifs). Renvoie les morceaux restants, du plus grand au plus petit,
 * ou null si jsts échoue.
 */
export function subtractRegions(
  outline: readonly Vec2[],
  regions: readonly (readonly Vec2[])[],
  clean: number,
): PolygonPiece[] | null {
  if (outline.length < 3) return null;
  try {
    // buffer(0) : remet d'aplomb un anneau mal orienté ou à sommets doublés.
    let rest: unknown = BufferOp.bufferOp(toPolygon(outline), 0);
    for (const region of regions) {
      if (region.length < 3) continue;
      rest = SnapIfNeededOverlayOp.overlayOp(rest, BufferOp.bufferOp(toPolygon(region), 0), OverlayOp.DIFFERENCE);
    }
    if (clean > 0) rest = grow(grow(rest, -clean), clean);
    return collectPieces(rest as PolyGeometry).sort((a, b) => b.area - a.area);
  } catch {
    return null;
  }
}
