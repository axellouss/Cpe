/**
 * Découpage d'une page en régions de dessin SANS classe de murs : il sert quand tous les traits ont la même
 * épaisseur (export « tout en trait fin ») et que la page porte plusieurs vues (plans, coupe, façade).
 *
 *  - composantes : groupes de traits qui se touchent (grille de 4 pt, cadre de la feuille écarté) ;
 *  - régions : les composantes assez grandes pour être une vue, celles dont les rectangles se recouvrent étant
 *    réunies — chaînes de cotes, flèche du nord, symboles n'en sont pas ; le cartouche non plus.
 *
 * Limites : deux vues reliées par un trait (axe, trait de coupe prolongé) ou dont les rectangles se recouvrent
 * ne font qu'une région ; l'appelant le constate (une seule région pour plusieurs niveaux) et le dit.
 */
import type { BBox } from '../../core/types';
import type { RawPage } from './raw';
import { frameBox, inFrameCorner, isTitleBlockText } from './titleblock';
import { isFrameSegment } from './walls';

/** Maille de la grille de voisinage (pt) : deux traits distants de moins d'une maille se touchent. */
const CELL = 4;
/** Au-delà, la page est trop chargée pour ce découpage (hachures, nuages de points) : on y renonce. */
const MAX_REGION_SEGMENTS = 80_000;
/** Une vue mesure au moins 14 mm de côté sur le papier… */
const MIN_REGION_SIDE = 40;
/** … et couvre au moins 0,4 % de la page. */
const MIN_REGION_SHARE = 0.004;

function boxesOverlap(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

function contains(b: BBox, x: number, y: number, pad = 0): boolean {
  return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
}

/** Rectangles des composantes connexes des traits de la page (cadre exclu) ; null si la page est trop chargée. */
function componentBoxes(page: RawPage): BBox[] | null {
  const n = page.segs.length;
  if (n > MAX_REGION_SEGMENTS) return null;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[i] !== r) {
      const next = parent[i]!;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const cells = new Map<number, number>();
  const touch = (ix: number, iy: number, seg: number): void => {
    const key = (ix + 32768) * 65536 + (iy + 32768);
    const other = cells.get(key);
    if (other === undefined) cells.set(key, seg);
    else {
      const a = find(other);
      const b = find(seg);
      if (a !== b) parent[a] = b;
    }
  };
  const used = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = page.segs[i]!;
    if (isFrameSegment(s, page.width, page.height)) continue;
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const len = Math.hypot(dx, dy);
    if (!Number.isFinite(len)) continue;
    used[i] = 1;
    const steps = Math.max(1, Math.ceil(len / (CELL / 2)));
    for (let k = 0; k <= steps; k++) {
      const ix = Math.floor((s.x0 + (dx * k) / steps) / CELL);
      const iy = Math.floor((s.y0 + (dy * k) / steps) / CELL);
      if (k === 0 || k === steps) {
        // Une extrémité rejoint tout ce qui passe dans les mailles voisines : accrochage approximatif toléré.
        for (let jx = ix - 1; jx <= ix + 1; jx++) for (let jy = iy - 1; jy <= iy + 1; jy++) touch(jx, jy, i);
      } else touch(ix, iy, i);
    }
  }
  const byRoot = new Map<number, BBox>();
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    const s = page.segs[i]!;
    const root = find(i);
    let b = byRoot.get(root);
    if (!b) byRoot.set(root, (b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }));
    b.minX = Math.min(b.minX, s.x0, s.x1);
    b.maxX = Math.max(b.maxX, s.x0, s.x1);
    b.minY = Math.min(b.minY, s.y0, s.y1);
    b.maxY = Math.max(b.maxY, s.y0, s.y1);
  }
  return [...byRoot.values()];
}

/**
 * Régions de dessin de la page (vues probables : plans, coupes, façades), cartouche exclu, de gauche à droite.
 * null si la page est trop chargée pour être découpée.
 */
export function drawingRegions(page: RawPage): BBox[] | null {
  const components = componentBoxes(page);
  if (!components) return null;
  const pageArea = page.width * page.height;
  const frame = frameBox(page);
  const blockTexts = page.texts.filter((t) => isTitleBlockText(t.s));
  let boxes: BBox[] = [];
  for (const b of components) {
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (Math.min(w, h) < MIN_REGION_SIDE || w * h < MIN_REGION_SHARE * pageArea) continue;
    // Une composante qui couvre presque toute la page est un cadre intérieur, pas une vue.
    if (w * h > 0.8 * pageArea) continue;
    // Le cartouche : son vocabulaire, ou sa place dans un angle du cadre.
    const words = blockTexts.filter((t) => contains(b, t.cx, t.cy, 1)).length;
    if (words >= 3 || (words >= 1 && inFrameCorner(b, frame))) continue;
    boxes.push({ ...b });
  }
  // Morceaux d'une même vue (traits non raccordés) : leurs rectangles se recouvrent, on les réunit.
  for (let merged = true; merged; ) {
    merged = false;
    const next: BBox[] = [];
    for (const b of boxes) {
      const hit = next.find((o) => boxesOverlap(o, b));
      if (hit) {
        hit.minX = Math.min(hit.minX, b.minX);
        hit.minY = Math.min(hit.minY, b.minY);
        hit.maxX = Math.max(hit.maxX, b.maxX);
        hit.maxY = Math.max(hit.maxY, b.maxY);
        merged = true;
      } else next.push(b);
    }
    boxes = next;
  }
  return boxes.sort((a, b) => a.minX - b.minX || a.minY - b.minY);
}
