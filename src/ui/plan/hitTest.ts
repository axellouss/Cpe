/**
 * « Qu'y a-t-il sous le doigt ? » (logique pure). Les tolérances sont données en pixels CSS et converties avec la vue,
 * pour que la cible ait la même taille à l'écran quel que soit le zoom.
 */
import { closestOnSegment, pointInPolygon, polygonArea } from '../../core/geometry';
import type { Opening, Room, Vec2 } from '../../core/types';
import { openingMark } from './openings';
import type { View } from './view';
import { screenToSheet, sheetToScreen } from './view';

/** Rayons de capture (px) selon le pointeur : un doigt est moins précis qu'une souris. */
export function hitRadius(pointerType: string): number {
  return pointerType === 'touch' ? 22 : pointerType === 'pen' ? 14 : 10;
}

/** Sommet du contour le plus proche du point écran, dans le rayon. */
export function hitVertex(outline: readonly Vec2[], view: View, screen: Vec2, radiusPx: number): number | null {
  let best: number | null = null;
  let bestD = radiusPx;
  for (let i = 0; i < outline.length; i++) {
    const s = sheetToScreen(view, outline[i]!);
    const d = Math.hypot(s.x - screen.x, s.y - screen.y);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Longueur minimale d'une arête à l'écran pour afficher sa poignée de milieu (sinon elle gênerait les sommets). */
export const MIDPOINT_MIN_EDGE_PX = 56;

/** Poignée « + » au milieu d'une arête : renvoie l'indice de l'arête. */
export function hitMidpoint(outline: readonly Vec2[], view: View, screen: Vec2, radiusPx: number): number | null {
  let best: number | null = null;
  let bestD = radiusPx;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = sheetToScreen(view, outline[i]!);
    const b = sheetToScreen(view, outline[(i + 1) % n]!);
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIDPOINT_MIN_EDGE_PX) continue;
    const d = Math.hypot((a.x + b.x) / 2 - screen.x, (a.y + b.y) / 2 - screen.y);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export interface EdgeHit {
  index: number;
  /** Position le long de l'arête, 0..1. */
  t: number;
  /** Point de l'arête le plus proche (unités de feuille). */
  point: Vec2;
}

/** Arête du contour la plus proche du point écran, dans le rayon. */
export function hitEdge(outline: readonly Vec2[], view: View, screen: Vec2, radiusPx: number): EdgeHit | null {
  const n = outline.length;
  if (n < 2) return null;
  const p = screenToSheet(view, screen);
  const tol = radiusPx / view.scale;
  let best: EdgeHit | null = null;
  let bestD = tol;
  for (let i = 0; i < n; i++) {
    const c = closestOnSegment(p, outline[i]!, outline[(i + 1) % n]!);
    if (c.distance <= bestD) {
      bestD = c.distance;
      best = { index: i, t: c.t, point: c.point };
    }
  }
  return best;
}

/** Ouverture dont la marque passe sous le point écran. Une marque très courte garde une cible d'au moins 2 × rayon. */
export function hitOpening(
  outline: readonly Vec2[],
  openings: readonly Opening[],
  metresPerUnit: number,
  view: View,
  screen: Vec2,
  radiusPx: number,
): string | null {
  const p = screenToSheet(view, screen);
  const tol = radiusPx / view.scale;
  let best: string | null = null;
  let bestD = tol;
  for (const o of openings) {
    const mark = openingMark(outline, o, metresPerUnit);
    if (!mark) continue;
    const c = closestOnSegment(p, mark.a, mark.b);
    if (c.distance <= bestD) {
      bestD = c.distance;
      best = o.id;
    }
  }
  return best;
}

export interface TagSize {
  width: number;
  height: number;
}

/**
 * Taille (px) de l'étiquette d'une pièce sans polygone. Estimation à partir du nombre de caractères : la même
 * fonction sert au dessin et au test de toucher, donc la cible correspond toujours à ce qui est affiché.
 */
export function tagSize(label: string): TagSize {
  return { width: Math.max(44, Math.round(label.length * 6.6 + 20)), height: 26 };
}

/**
 * Pièce sous le point écran : d'abord les étiquettes (dessinées au-dessus), puis les polygones — le plus petit
 * d'abord, pour qu'une pièce contenue dans une autre reste accessible.
 */
export function hitRoom(rooms: readonly Room[], view: View, screen: Vec2, labelOf: (room: Room) => string): string | null {
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i]!;
    if (room.polygon && room.polygon.length >= 3) continue;
    if (!room.at) continue;
    const c = sheetToScreen(view, room.at);
    const size = tagSize(labelOf(room));
    if (Math.abs(screen.x - c.x) <= size.width / 2 && Math.abs(screen.y - c.y) <= size.height / 2) return room.id;
  }
  const p = screenToSheet(view, screen);
  let best: string | null = null;
  let bestArea = Infinity;
  for (const room of rooms) {
    if (!room.polygon || room.polygon.length < 3) continue;
    if (!pointInPolygon(p, room.polygon)) continue;
    const area = polygonArea(room.polygon);
    if (area < bestArea) {
      bestArea = area;
      best = room.id;
    }
  }
  return best;
}
