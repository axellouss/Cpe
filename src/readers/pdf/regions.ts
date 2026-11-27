/**
 * Découpage d'une page en régions de dessin, SANS échelle ni hiérarchie d'épaisseurs de trait : il sert quand
 * les murs ne se distinguent pas (export « tout en trait fin ») et à repérer le cartouche.
 *
 *  - composantes : groupes de traits qui se touchent (grille de 4 pt, cadre de la feuille écarté) ;
 *  - régions : les composantes assez grandes pour être une vue (plan, coupe, façade), celles dont les rectangles
 *    se recouvrent étant réunies — les chaînes de cotes, la flèche du nord, les symboles n'en sont pas ;
 *  - cartouche : la composante qui porte le vocabulaire d'un cartouche, ou qui tient dans un angle du cadre.
 *
 * Limites : deux vues reliées par un trait (axe, trait de coupe prolongé) ou dont les rectangles se
 * recouvrent ne font qu'une région ; l'appelant doit alors dire que rien n'a pu être séparé.
 */
import type { BBox } from '../../core/types';
import { fold } from '../../semantics/labels';
import type { RawPage, RawText } from './raw';
import { isFrameSegment } from './walls';

/** Maille de la grille de voisinage (pt) : deux traits distants de moins d'une maille se touchent. */
const CELL = 4;
/** Au-delà, la page est trop chargée pour ce découpage (hachures, nuages de points) : on y renonce. */
const MAX_REGION_SEGMENTS = 80_000;
/** Une vue mesure au moins 14 mm de côté sur le papier… */
const MIN_REGION_SIDE = 40;
/** … et couvre au moins 0,4 % de la page. */
const MIN_REGION_SHARE = 0.004;

export interface Component {
  bbox: BBox;
  /** Nombre de traits. */
  segs: number;
}

/** Vocabulaire d'un cartouche, dans une phrase ou seul dans sa case. */
export const TITLE_BLOCK_RE = /\b(projet|maitre d'ouvrage|bauherr|bauvorhaben|architecte|architekt|planinhalt|echelle|massstab|plan n|plan-nr|indice|index|gezeichnet|dessine|phase|datum)\b/;
/** Intitulés de case d'un cartouche : le mot SEUL (« Plan », « Date », « Objet »), suivi au plus d'un deux-points. */
const TITLE_BLOCK_KEY_RE =
  /^(plan|date|objet|objekt|projekt|bauteil|format|blatt|blatt-nr\.?|feuille|dossier|affaire|adresse|lieu|commune|gemeinde|parcelle|parzelle|client|auftraggeber|bauort|planer|planverfasser|gepruft|verifie|controle|visa|freigabe|dessinateur|zeichner|n°|nr\.?)\s*[:.]?$/;
/** Date écrite en chiffres (« 12.03.2024 », « 3/7/24 ») : il n'y en a que dans un cartouche. */
const DATE_RE = /(?<!\d)\d{1,2}[./]\d{1,2}[./](?:\d{4}|\d{2})(?!\d)/;

/** Vrai si le texte appartient au vocabulaire d'un cartouche (mot-clé, intitulé de case ou date). */
export function isTitleBlockText(text: string): boolean {
  const f = fold(text).replace(/[’`]/g, "'");
  if (TITLE_BLOCK_RE.test(f) || DATE_RE.test(f)) return true;
  // « Échelle / Date », « Plan n° / Indice » : chaque moitié est un intitulé.
  return f.split('/').every((part) => TITLE_BLOCK_KEY_RE.test(part.trim())) && f.length > 0;
}

export function boxContains(b: BBox, x: number, y: number, pad = 0): boolean {
  return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
}

function boxesOverlap(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * Composantes connexes des traits de la page (cadre exclu). null si la page est trop chargée.
 * Deux traits sont voisins si une extrémité de l'un tombe à moins d'une maille de l'autre, ou s'ils se croisent.
 */
export function drawingComponents(page: RawPage): Component[] | null {
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
    if (!(len >= 0)) continue;
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
  const byRoot = new Map<number, Component>();
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    const s = page.segs[i]!;
    const root = find(i);
    let c = byRoot.get(root);
    if (!c) byRoot.set(root, (c = { bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, segs: 0 }));
    c.segs++;
    c.bbox.minX = Math.min(c.bbox.minX, s.x0, s.x1);
    c.bbox.maxX = Math.max(c.bbox.maxX, s.x0, s.x1);
    c.bbox.minY = Math.min(c.bbox.minY, s.y0, s.y1);
    c.bbox.maxY = Math.max(c.bbox.maxY, s.y0, s.y1);
  }
  return [...byRoot.values()];
}

/** Rectangle du cadre de la feuille (longs traits proches des bords) ; null s'il n'est pas dessiné. */
function frameBox(page: RawPage): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const s of page.segs) {
    if (!isFrameSegment(s, page.width, page.height)) continue;
    count++;
    minX = Math.min(minX, s.x0, s.x1);
    maxX = Math.max(maxX, s.x0, s.x1);
    minY = Math.min(minY, s.y0, s.y1);
    maxY = Math.max(maxY, s.y0, s.y1);
  }
  return count >= 2 ? { minX, minY, maxX, maxY } : null;
}

/**
 * Rectangles des cartouches de la page. Un cartouche est une composante compacte (moins de 30 % de la page) qui
 *  - porte au moins trois textes du vocabulaire d'un cartouche (« Projet », « Plan », « Date », « Échelle »…) ; ou
 *  - tient dans un ANGLE du cadre (deux côtés adjacents sur le cadre) et en porte au moins un.
 * Les textes qui s'y trouvent ne sont ni des titres de vue ni des pièces.
 */
export function titleBlockBoxes(page: RawPage, components: readonly Component[]): BBox[] {
  const words = page.texts.filter((t) => isTitleBlockText(t.s));
  if (words.length === 0) return [];
  const frame = frameBox(page);
  const pageArea = page.width * page.height;
  const out: BBox[] = [];
  for (const c of components) {
    const b = c.bbox;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (w < 20 || h < 12 || w * h > 0.3 * pageArea) continue;
    const count = words.reduce((k, t) => k + (boxContains(b, t.cx, t.cy, 1) ? 1 : 0), 0);
    if (count === 0) continue;
    let corner = false;
    if (frame) {
      const tol = 3;
      const left = Math.abs(b.minX - frame.minX) <= tol;
      const right = Math.abs(b.maxX - frame.maxX) <= tol;
      const top = Math.abs(b.minY - frame.minY) <= tol;
      const bottom = Math.abs(b.maxY - frame.maxY) <= tol;
      corner = (left || right) && (top || bottom) && !(left && right) && !(top && bottom);
    }
    if (count >= 3 || corner) out.push({ ...b });
  }
  return out;
}

/** Vrai si le texte est écrit dans un cartouche. */
export function inTitleBlock(t: RawText, blocks: readonly BBox[]): boolean {
  return blocks.some((b) => boxContains(b, t.cx, t.cy, 1));
}

/**
 * Régions de dessin de la page : rectangles des vues probables (plans, coupes, façades), cartouches exclus.
 * Les composantes trop petites ou filiformes (chaînes de cotes, symboles) ne sont pas des régions.
 */
export function drawingRegions(page: RawPage, components: readonly Component[], blocks: readonly BBox[]): BBox[] {
  const pageArea = page.width * page.height;
  let boxes: BBox[] = [];
  for (const c of components) {
    const b = c.bbox;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (Math.min(w, h) < MIN_REGION_SIDE || w * h < MIN_REGION_SHARE * pageArea) continue;
    // Une composante qui couvre presque toute la page est un cadre intérieur, pas une vue.
    if (w * h > 0.8 * pageArea) continue;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    if (blocks.some((k) => boxContains(k, cx, cy))) continue;
    boxes.push({ ...b });
  }
  // Morceaux d'une même vue (murs non raccordés) : leurs rectangles se recouvrent, on les réunit.
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
  return boxes;
}
