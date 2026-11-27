/**
 * Opérations booléennes sur polygones (différence) — SEUL fichier du moteur qui touche à jsts.
 * jsts est typé en `any` : on l'isole ici derrière des fonctions typées.
 */
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
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
