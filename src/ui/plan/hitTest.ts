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

/** Côté minimal (px) de la zone qui répond pour une pièce : 44 au doigt, 24 à la souris ou au stylet. */
export function roomMinTarget(pointerType: string): number {
  return pointerType === 'touch' ? 44 : 24;
}

export interface RoomTarget {
  /** Zone qui répond au toucher (px écran) : l'emprise du polygone, agrandie au besoin jusqu'à `min` px de côté. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Vrai si la pièce est plus petite que la cible minimale à l'écran : sa zone a été agrandie. */
  enlarged: boolean;
}

/** Zone de toucher d'une pièce dessinée ; null si elle n'a pas de polygone. */
export function roomTarget(room: Pick<Room, 'polygon'>, view: View, min: number): RoomTarget | null {
  const poly = room.polygon;
  if (!poly || poly.length < 3) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    const s = sheetToScreen(view, p);
    x0 = Math.min(x0, s.x);
    y0 = Math.min(y0, s.y);
    x1 = Math.max(x1, s.x);
    y1 = Math.max(y1, s.y);
  }
  const width = Math.max(x1 - x0, min);
  const height = Math.max(y1 - y0, min);
  return { x: (x0 + x1) / 2 - width / 2, y: (y0 + y1) / 2 - height / 2, width, height, enlarged: x1 - x0 < min || y1 - y0 < min };
}

/**
 * Pièce sous le point écran : d'abord les étiquettes (dessinées au-dessus), puis les polygones — le plus petit
 * d'abord, pour qu'une pièce contenue dans une autre reste accessible.
 *
 * `minTarget` (px) garantit une cible minimale aux petites pièces (WC, placard) : une pièce plus petite que cela à
 * l'écran répond aussi autour d'elle, dans un carré de ce côté centré sur elle. Un toucher DANS une petite pièce la
 * désigne toujours ; dans la marge de plusieurs petites pièces, la plus proche l'emporte.
 */
export function hitRoom(rooms: readonly Room[], view: View, screen: Vec2, labelOf: (room: Room) => string, minTarget = 0): string | null {
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i]!;
    if (room.polygon && room.polygon.length >= 3) continue;
    if (!room.at) continue;
    const c = sheetToScreen(view, room.at);
    const size = tagSize(labelOf(room));
    const halfW = Math.max(size.width, minTarget) / 2;
    const halfH = Math.max(size.height, minTarget) / 2;
    if (Math.abs(screen.x - c.x) <= halfW && Math.abs(screen.y - c.y) <= halfH) return room.id;
  }
  const p = screenToSheet(view, screen);
  let best: Room | null = null;
  let bestArea = Infinity;
  for (const room of rooms) {
    if (!room.polygon || room.polygon.length < 3) continue;
    if (!pointInPolygon(p, room.polygon)) continue;
    const area = polygonArea(room.polygon);
    if (area < bestArea) {
      bestArea = area;
      best = room;
    }
  }
  if (!(minTarget > 0)) return best ? best.id : null;
  // Toucher dans une petite pièce : c'est elle. Sinon, la petite pièce dont la zone agrandie contient le point.
  if (best && roomTarget(best, view, minTarget)?.enlarged) return best.id;
  let near: string | null = null;
  let nearD = Infinity;
  for (const room of rooms) {
    const t = roomTarget(room, view, minTarget);
    if (!t || !t.enlarged) continue;
    const cx = t.x + t.width / 2;
    const cy = t.y + t.height / 2;
    if (Math.abs(screen.x - cx) > t.width / 2 || Math.abs(screen.y - cy) > t.height / 2) continue;
    const d = Math.hypot(screen.x - cx, screen.y - cy);
    if (d < nearD) {
      nearD = d;
      near = room.id;
    }
  }
  return near ?? (best ? best.id : null);
}
