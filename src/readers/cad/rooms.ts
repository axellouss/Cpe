/**
 * Pièces d'un plan : TOUTE face fermée par les murs à l'intérieur du contour est une pièce, qu'elle porte ou
 * non un nom que le vocabulaire connaît (semantics/labels.ts).
 *
 *  - un nom RECONNU dans la face → la pièce comme avant (proposition chauffée / non chauffée d'après le nom) ;
 *  - un texte NON reconnu (« Zone 3 », « Kind 1 »…) → ce texte comme nom, `heatedGuess: 'ask'` ;
 *  - AUCUN texte → nom vide, `heatedGuess: 'ask'`.
 *
 * Sans cela, une pièce au nom inconnu disparaissait sans un mot : la surface nette An sortait trop basse, avec
 * la provenance « lue sur le plan ». Le lecteur ne devine pas pour autant : ces pièces sont « à trancher ».
 *
 * Ne sont PAS des pièces :
 *  - les faces minces (vides de mur, doublages) : le modèle de murs les a déjà rangées parmi les murs pleins ;
 *  - les faces de moins de 1 m² sans nom reconnu (gaines, conduits) ;
 *  - une face qui épouse le contour du bâtiment en enveloppant les autres pièces (clôture, cour) ;
 *  - une face hors du contour.
 */
import type { DetectedRoom, PlanText, Vec2 } from '../../core/types';
import { guessStorey, parseArea, parseClearHeight, parseOpeningSize, parseRoomLabel, parseScaleText, roomsFromTexts } from '../../semantics/labels';
import { pointInRing, ringArea, ringBox, simplifyRing } from './planar';
import type { Box } from './planar';

/** Surface minimale (m²) d'une face sans nom reconnu pour être rendue comme pièce. */
export const MIN_UNNAMED_ROOM_M2 = 1;
/** Une face sans nom reconnu qui couvre cette part du contour ET contient d'autres faces est une enceinte. */
const ENCLOSURE_SHARE = 0.9;

export interface LabelText extends PlanText {
  /** Indice du calque du texte. */
  layer: number;
}

export interface RoomFace {
  ring: Vec2[];
  /** Surface en unités de dessin au carré. */
  area: number;
  box: Box;
}

export interface RoomDetection {
  rooms: DetectedRoom[];
  /** Groupes de pièces reconnues que le dessin ne sépare pas. */
  mergedRooms: string[][];
  /** Écarts entre surface écrite et surface mesurée : [nom, écrite, mesurée]. */
  areaMismatches: [string, number, number][];
  /** Rapports surface mesurée / surface écrite des pièces RECONNUES (contrôle de l'unité). */
  ratios: number[];
  /** Noms des pièces rendues sans nom reconnu : le texte lu, ou '' quand la face ne porte aucun texte. */
  unrecognised: string[];
}

// Même forme que la surface lue par `parseArea` : sert à retirer la surface d'une étiquette au nom inconnu.
const AREA_PART = /(?<![\d.,])\d{1,4}(?:[.,]\d{1,3})?\s*(?:m\s?[²2]|m\^2|qm|㎡)(?![a-z0-9])/i;

/** « Zone 3 12,40 m² » → { name: 'Zone 3', area: 12.4 } — sans contrôle du vocabulaire. */
export function splitFreeLabel(text: string): { name: string; area: number | null } {
  const flat = text.replace(/\s+/g, ' ').trim();
  const area = parseArea(flat);
  const m = AREA_PART.exec(flat);
  let name = (m ? flat.slice(0, m.index) + ' ' + flat.slice(m.index + m[0].length) : flat)
    .replace(/\b(?:S|A|SH|Surf(?:ace)?|Fl(?:ä|a)che|NGF|WF)\s*[:=]\s*$/i, '')
    .replace(/[\s:=\-–—|/]+$/g, '')
    .replace(/^[\s:=\-–—|/]+/g, '')
    .trim();
  name = name.replace(/^\d{1,2}[.\-]\d{1,3}\s+/, '').trim();
  return { name, area };
}

/**
 * Vrai si le texte peut servir de nom à une pièce que le vocabulaire ne connaît pas : court, avec au moins deux
 * lettres, et ni une cote, ni une échelle, ni une hauteur, ni un titre de niveau ou de vue.
 */
export function looksLikeFreeName(name: string, isViewTitle: (text: string) => boolean): boolean {
  if (name.length < 2 || name.length > 40) return false;
  if (name.split(/\s+/).length > 5) return false;
  if (!/\p{L}[^\p{L}]*\p{L}/u.test(name)) return false;
  if (parseScaleText(name) !== null || parseClearHeight(name) !== null || parseOpeningSize(name) !== null) return false;
  if (guessStorey(name) !== null || isViewTitle(name)) return false;
  return true;
}

/** Un point à l'intérieur de l'anneau : le barycentre des sommets s'il convient, sinon le milieu de la plus large traversée. */
export function interiorPoint(ring: readonly Vec2[]): Vec2 {
  let sx = 0;
  let sy = 0;
  for (const p of ring) {
    sx += p.x;
    sy += p.y;
  }
  const c = { x: sx / ring.length, y: sy / ring.length };
  if (pointInRing(c.x, c.y, ring)) return c;
  const box = ringBox(ring);
  let best = c;
  let bestWidth = 0;
  for (const f of [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875]) {
    const y = box.minY + (box.maxY - box.minY) * f;
    const xs: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1]! - xs[i]!;
      if (width > bestWidth) {
        bestWidth = width;
        best = { x: (xs[i]! + xs[i + 1]!) / 2, y };
      }
    }
  }
  return best;
}

function inBox(x: number, y: number, b: Box): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

export interface RoomInput {
  /** Textes du plan situés dans le contour (hors cotes et axes). */
  texts: readonly LabelText[];
  /** Faces fermées par les murs (trous du modèle de murs), de la plus petite à la plus grande. */
  faces: readonly RoomFace[];
  /** Contour du bâtiment (ou emprise grossière à défaut), repère d'analyse. */
  boundary: readonly Vec2[];
  /** Unités de dessin par mètre. */
  u: number;
  /** Tolérance d'accrochage (unités de dessin). */
  tol: number;
  /** Vrai si le texte est un titre de coupe, de façade, de détail… */
  isViewTitle: (text: string) => boolean;
}

export function detectRooms(input: RoomInput): RoomDetection {
  const { texts, faces, boundary, u, tol } = input;
  const rooms = roomsFromTexts(texts);
  const mergedRooms: string[][] = [];
  const areaMismatches: [string, number, number][] = [];
  const ratios: number[] = [];
  const unrecognised: string[] = [];

  const faceAt = (x: number, y: number): number => {
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i]!;
      if (inBox(x, y, f.box) && pointInRing(x, y, f.ring)) return i;
    }
    return -1;
  };
  const metres = (area: number): number => Math.round((area / (u * u)) * 1000) / 1000;
  const mismatch = (stated: number, measured: number): boolean => Math.abs(stated - measured) > Math.max(0.3, 0.03 * measured);

  // ── Pièces au nom reconnu : chacune prend la plus petite face qui contient son étiquette ──
  const faceOfRoom = rooms.map((r) => (r.at ? faceAt(r.at.x, r.at.y) : -1));
  const recognisedIn = new Int32Array(faces.length);
  faceOfRoom.forEach((f) => {
    if (f >= 0) recognisedIn[f] = recognisedIn[f]! + 1;
  });
  faces.forEach((face, i) => {
    const inside = rooms.filter((_r, ri) => faceOfRoom[ri] === i);
    if (inside.length === 1) {
      const room = inside[0]!;
      room.polygon = simplifyRing(face.ring, tol * 0.2);
      room.measuredArea = metres(face.area);
      if (room.statedArea !== undefined && room.statedArea > 0) {
        ratios.push(room.measuredArea / room.statedArea);
        if (mismatch(room.statedArea, room.measuredArea)) areaMismatches.push([room.name, room.statedArea, room.measuredArea]);
      }
    } else if (inside.length > 1) {
      mergedRooms.push(inside.map((r) => r.name));
    }
  });

  // ── Faces sans nom reconnu ──
  if (faces.some((_f, i) => recognisedIn[i] === 0)) {
    // Textes libres : ni nom reconnu, ni surface déjà prise par une pièce reconnue.
    interface Free {
      t: LabelText;
      name: string;
      area: number | null;
      face: number;
      used: boolean;
    }
    const free: Free[] = [];
    for (const t of texts) {
      if (parseRoomLabel(t.text)?.name) continue;
      const split = splitFreeLabel(t.text);
      const name = looksLikeFreeName(split.name, input.isViewTitle) ? split.name : '';
      if (!name && split.area === null) continue;
      free.push({ t, name, area: split.area, face: faceAt(t.x, t.y), used: false });
    }
    // Une surface seule déjà associée à une pièce reconnue voisine (« Séjour » + « 32,45 m² ») n'est plus libre.
    for (const r of rooms) {
      if (r.statedArea === undefined || !r.at) continue;
      let best: Free | null = null;
      let bestD = Infinity;
      for (const f of free) {
        if (f.name || f.used || f.area !== r.statedArea) continue;
        const d = Math.hypot(f.t.x - r.at.x, f.t.y - r.at.y);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      if (best) best.used = true;
    }
    // Calques qui portent les noms de pièces reconnus : un texte libre du même calque est sans doute un nom lui aussi.
    const nameLayers = new Set<number>();
    for (const t of texts) if (parseRoomLabel(t.text)?.name) nameLayers.add(t.layer);

    const outlineArea = ringArea(boundary);
    const minArea = MIN_UNNAMED_ROOM_M2 * u * u;
    // `inner` est-elle dans `outer` ? Les faces sont des trous disjoints ou emboîtés : un sommet suffit à le dire.
    const within = (inner: RoomFace, outer: RoomFace): boolean => {
      const v = inner.ring[0]!;
      return inBox(v.x, v.y, outer.box) && pointInRing(v.x, v.y, outer.ring);
    };
    // Enceinte : face sans nom reconnu qui épouse le contour et enveloppe d'autres faces (triées par surface).
    const enclosure = faces.map(
      (face, i) => recognisedIn[i] === 0 && face.area >= ENCLOSURE_SHARE * outlineArea && faces.some((other, j) => j < i && other.area >= minArea && within(other, face)),
    );
    const extra: { room: DetectedRoom; at: Vec2 }[] = [];
    faces.forEach((face, i) => {
      if (recognisedIn[i] !== 0 || enclosure[i] || face.area < minArea) return;
      const centre = interiorPoint(face.ring);
      if (!pointInRing(centre.x, centre.y, boundary)) return;
      // Îlot dans une pièce (noyau, gaine, meuble dessiné en double trait) : sa surface est déjà dans celle de la pièce.
      if (faces.some((outer, k) => k > i && !enclosure[k] && within(face, outer))) return;
      const here = free.filter((f) => f.face === i && !f.used);
      const names = here.filter((f) => f.name);
      names.sort(
        (p, q) =>
          Number(nameLayers.has(q.t.layer)) - Number(nameLayers.has(p.t.layer)) ||
          Number(q.area !== null) - Number(p.area !== null) ||
          (q.t.height ?? 0) - (p.t.height ?? 0) ||
          Math.hypot(p.t.x - centre.x, p.t.y - centre.y) - Math.hypot(q.t.x - centre.x, q.t.y - centre.y),
      );
      const label = names[0] ?? null;
      const at = label ? { x: label.t.x, y: label.t.y } : centre;
      // Surface écrite : celle de l'étiquette, sinon la surface seule la plus proche dans la même face.
      let stated: number | null = label?.area ?? null;
      if (stated === null) {
        const alone = here.filter((f) => !f.name && f.area !== null);
        alone.sort((p, q) => Math.hypot(p.t.x - at.x, p.t.y - at.y) - Math.hypot(q.t.x - at.x, q.t.y - at.y));
        // Sans nom pour l'ancrer, une surface n'est retenue que si elle est seule dans la face.
        if (alone.length > 0 && (label || alone.length === 1)) stated = alone[0]!.area;
      }
      const room: DetectedRoom = { name: label?.name ?? '', at, heatedGuess: 'ask' };
      if (stated !== null) room.statedArea = stated;
      room.polygon = simplifyRing(face.ring, tol * 0.2);
      room.measuredArea = metres(face.area);
      if (label && stated !== null && mismatch(stated, room.measuredArea)) areaMismatches.push([room.name, stated, room.measuredArea]);
      extra.push({ room, at });
    });
    // Ordre de lecture : de haut en bas (y vers le haut dans le repère d'analyse), puis de gauche à droite.
    extra.sort((p, q) => q.at.y - p.at.y || p.at.x - q.at.x);
    for (const e of extra) {
      rooms.push(e.room);
      unrecognised.push(e.room.name);
    }
  }

  return { rooms, mergedRooms, areaMismatches, ratios, unrecognised };
}
