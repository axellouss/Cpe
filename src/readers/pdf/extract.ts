/**
 * Extraction d'une page avec pdf.js : textes (avec position, corps et sens de lecture) et traits vectoriels
 * (avec leur épaisseur réelle). Fonctionne à l'identique dans le navigateur et sous Node.
 *
 * Points d'attention de pdf.js 6.x (vérifiés par exécution, voir les notes de recherche) :
 *  - `constructPath` reçoit [opérateur de peinture, [Float32Array], boîte] ; le tableau mêle codes de tracé
 *    (0 moveTo, 1 lineTo, 2 curveTo, 3 quadraticCurveTo, 4 closePath) et coordonnées ;
 *  - il faut suivre soi-même save / restore / transform / setLineWidth / setDash et les Form XObjects ;
 *    épaisseur réelle = lineWidth × √|det CTM| ;
 *  - `item.transform` d'un texte reste dans le repère NATIF de la page : le sens de lecture se transforme
 *    avec la matrice de la vue (qui contient la rotation).
 *
 * C'est le seul fichier qui manipule les listes d'opérateurs non typées de pdf.js.
 */
import type { OpCodes, PDFPageProxy } from './pdfjs';
import type { RawPage, RawSeg, RawText } from './raw';

type Matrix = [number, number, number, number, number, number];

/** Au-delà, la page est lue en partie seulement (plans très lourds : hachures, fonds de carte). */
export const MAX_PAGE_SEGMENTS = 400_000;
const MAX_PAGE_TEXTS = 30_000;
/** Nombre de cordes par courbe de Bézier. */
const CURVE_STEPS = 8;

const DRAW_MOVE = 0;
const DRAW_LINE = 1;
const DRAW_CURVE = 2;
const DRAW_QUAD = 3;
const DRAW_CLOSE = 4;

function mul(m: Matrix, n: Matrix): Matrix {
  // m après n (on applique n puis m) : sémantique de l'opérateur « cm » du PDF.
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function isNumberList(v: unknown, length: number): v is number[] {
  if (!Array.isArray(v) && !ArrayBuffer.isView(v)) return false;
  const list = v as ArrayLike<unknown>;
  if (list.length < length) return false;
  for (let i = 0; i < length; i++) if (typeof list[i] !== 'number' || !Number.isFinite(list[i] as number)) return false;
  return true;
}

function toMatrix(v: unknown): Matrix | null {
  return isNumberList(v, 6) ? [v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!] : null;
}

interface TextItemLike {
  str: string;
  transform: unknown;
  width: number;
}

function isTextItem(v: unknown): v is TextItemLike {
  const o = v as Partial<TextItemLike> | null;
  return !!o && typeof o.str === 'string' && typeof o.width === 'number' && o.transform !== undefined;
}

/** Quart de tour (0, 90, 180, 270) du sens de lecture dominant, pondéré par le nombre de caractères. */
function dominantReading(items: readonly TextItemLike[], view: Matrix): number {
  const weight = [0, 0, 0, 0];
  let total = 0;
  for (const it of items) {
    const m = toMatrix(it.transform);
    const n = it.str.trim().length;
    if (!m || n === 0) continue;
    const dx = view[0] * m[0] + view[2] * m[1];
    const dy = view[1] * m[0] + view[3] * m[1];
    if (Math.hypot(dx, dy) < 1e-9) continue;
    const deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
    const quarter = ((Math.round(deg / 90) % 4) + 4) % 4;
    weight[quarter]! += n;
    total += n;
  }
  if (total === 0) return 0;
  let best = 0;
  for (let q = 1; q < 4; q++) if (weight[q]! > weight[best]!) best = q;
  // On ne tourne la page que si le sens dominant est net.
  return weight[best]! >= 0.6 * total ? best * 90 : 0;
}

export interface ExtractOptions {
  /** Dit si un groupe de contenu optionnel (calque PDF) est affiché ; absent = tout est affiché. */
  isVisible?: (group: unknown) => boolean;
  maxSegments?: number;
}

export async function extractPage(page: PDFPageProxy, ops: OpCodes, options: ExtractOptions = {}): Promise<RawPage> {
  const maxSegments = options.maxSegments ?? MAX_PAGE_SEGMENTS;

  // ───────────── Textes bruts, puis choix de la vue où le texte dominant est droit ─────────────
  const content = await page.getTextContent();
  const items: TextItemLike[] = [];
  for (const it of content.items as unknown[]) if (isTextItem(it)) items.push(it);

  const fileRotation = (((page.rotate % 360) + 360) % 360) || 0;
  const firstView = toMatrix(page.getViewport({ scale: 1 }).transform) ?? [1, 0, 0, -1, 0, 0];
  const turned = dominantReading(items, firstView);
  const rotation = (fileRotation + turned) % 360;
  const viewport = page.getViewport({ scale: 1, rotation });
  const V = toMatrix(viewport.transform) ?? firstView;
  const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  const texts: RawText[] = [];
  for (const it of items) {
    const s = it.str.trim();
    const m = toMatrix(it.transform);
    if (!s || !m) continue;
    if (texts.length >= MAX_PAGE_TEXTS) break;
    const size = Math.hypot(m[0], m[1]);
    if (!(size > 0)) continue;
    const ux = m[0] / size;
    const uy = m[1] / size;
    // Boîte du texte dans le repère natif : origine sur la ligne de base, largeur selon u, hauteur selon n.
    const nx = -uy;
    const ny = ux;
    const e = m[4];
    const f = m[5];
    const w = it.width;
    const corners: [number, number][] = [
      apply(V, e, f),
      apply(V, e + ux * w, f + uy * w),
      apply(V, e + ux * w + nx * size, f + uy * w + ny * size),
      apply(V, e + nx * size, f + ny * size),
    ];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of corners) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (!Number.isFinite(x0 + y0 + x1 + y1)) continue;
    // Sens de lecture À L'ÉCRAN : on transforme le vecteur directeur par la vue (rotation comprise).
    const dx = V[0] * ux + V[2] * uy;
    const dy = V[1] * ux + V[3] * uy;
    const angle = Math.round((Math.atan2(-dy, dx) * 1800) / Math.PI) / 10;
    texts.push({
      s,
      x0,
      y0,
      x1,
      y1,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      bx: corners[0]![0],
      by: corners[0]![1],
      angle: angle === -180 ? 180 : angle,
      size,
    });
  }

  // ───────────── Traits vectoriels ─────────────
  const list = await page.getOperatorList();
  const fnArray = list.fnArray as readonly number[];
  const argsArray = list.argsArray as readonly unknown[];

  const strokeOps = new Set([ops.stroke, ops.closeStroke, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const fillOps = new Set([ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const closeOps = new Set([ops.closeStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const imageOps = new Set([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageXObjectRepeat]);

  const segs: RawSeg[] = [];
  let truncated = false;
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;
  let dash = false;
  const stack: { ctm: Matrix; lineWidth: number; dash: boolean }[] = [];
  /** Pile des contenus balisés : vrai = calque masqué. */
  const marked: boolean[] = [];
  let hidden = 0;
  let pid = 0;
  let images = 0;
  let imageCoverage = 0;
  let imagePixelsPerPoint = 0;
  const pageArea = Math.max(1, viewport.width * viewport.height);

  const save = (): void => {
    stack.push({ ctm, lineWidth, dash });
  };
  const restore = (): void => {
    const s = stack.pop();
    if (s) ({ ctm, lineWidth, dash } = s);
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]!;
    const args = (argsArray[i] ?? []) as readonly unknown[];
    if (fn === ops.save) save();
    else if (fn === ops.restore) restore();
    else if (fn === ops.transform) {
      const m = toMatrix(args);
      if (m) ctm = mul(ctm, m);
    } else if (fn === ops.setLineWidth) {
      if (typeof args[0] === 'number') lineWidth = args[0];
    } else if (fn === ops.setDash) {
      const pattern = args[0];
      dash = (Array.isArray(pattern) || ArrayBuffer.isView(pattern)) && (pattern as ArrayLike<unknown>).length > 0;
    } else if (fn === ops.paintFormXObjectBegin) {
      save();
      const m = toMatrix(args[0]);
      if (m) ctm = mul(ctm, m);
    } else if (fn === ops.paintFormXObjectEnd) restore();
    else if (fn === ops.beginMarkedContent || fn === ops.beginMarkedContentProps) {
      let off = false;
      if (fn === ops.beginMarkedContentProps && args[0] === 'OC' && options.isVisible) {
        try {
          off = !options.isVisible(args[1]);
        } catch {
          off = false;
        }
      }
      marked.push(off);
      if (off) hidden++;
    } else if (fn === ops.endMarkedContent) {
      if (marked.pop()) hidden--;
    } else if (imageOps.has(fn)) {
      if (hidden > 0) continue;
      images++;
      // Une image occupe le carré unité de son repère : son emprise sur la page est celle du CTM.
      const a = Math.hypot(ctm[0], ctm[1]);
      const b = Math.hypot(ctm[2], ctm[3]);
      const coverage = Math.min(1, Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / pageArea);
      if (coverage > imageCoverage) {
        imageCoverage = coverage;
        const pw = typeof args[1] === 'number' ? args[1] : 0;
        const ph = typeof args[2] === 'number' ? args[2] : 0;
        imagePixelsPerPoint = a > 0 && b > 0 ? Math.max(pw / a, ph / b) : 0;
      }
    } else if (fn === ops.constructPath) {
      const paintOp = args[0];
      const holder = args[1];
      const data = Array.isArray(holder) ? (holder[0] as unknown) : undefined;
      if (typeof paintOp !== 'number' || !(data instanceof Float32Array)) continue;
      const stroke = strokeOps.has(paintOp);
      const fill = fillOps.has(paintOp);
      if ((!stroke && !fill) || hidden > 0) continue; // tracé de découpe, ou calque masqué
      if (segs.length >= maxSegments) {
        truncated = true;
        continue;
      }
      const M = mul(V, ctm);
      const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
      const w = stroke ? lineWidth * scale : 0;
      const id = pid++;
      let cur: [number, number] | null = null;
      let start: [number, number] | null = null;
      const push = (p: [number, number], q: [number, number], curve: boolean): void => {
        if (p[0] === q[0] && p[1] === q[1]) return;
        if (!Number.isFinite(p[0] + p[1] + q[0] + q[1])) return;
        segs.push({ x0: p[0], y0: p[1], x1: q[0], y1: q[1], w, curve, stroke, fill, dash, pid: id });
      };
      const cubic = (p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number]): void => {
        let prev = p0;
        for (let k = 1; k <= CURVE_STEPS; k++) {
          const t = k / CURVE_STEPS;
          const mt = 1 - t;
          const a = mt * mt * mt;
          const b = 3 * mt * mt * t;
          const c = 3 * mt * t * t;
          const d = t * t * t;
          const next: [number, number] = [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
          push(prev, next, true);
          prev = next;
        }
      };
      for (let k = 0; k < data.length; ) {
        const op = data[k++]!;
        if (op === DRAW_MOVE) {
          // Un remplissage referme implicitement chaque sous-tracé.
          if (fill && !stroke && cur && start) push(cur, start, false);
          cur = start = apply(M, data[k]!, data[k + 1]!);
          k += 2;
        } else if (op === DRAW_LINE) {
          const p = apply(M, data[k]!, data[k + 1]!);
          k += 2;
          if (cur) push(cur, p, false);
          cur = p;
        } else if (op === DRAW_CURVE) {
          const p1 = apply(M, data[k]!, data[k + 1]!);
          const p2 = apply(M, data[k + 2]!, data[k + 3]!);
          const p3 = apply(M, data[k + 4]!, data[k + 5]!);
          k += 6;
          if (cur) cubic(cur, p1, p2, p3);
          cur = p3;
        } else if (op === DRAW_QUAD) {
          const p1 = apply(M, data[k]!, data[k + 1]!);
          const p2 = apply(M, data[k + 2]!, data[k + 3]!);
          k += 4;
          if (cur) {
            const c1: [number, number] = [cur[0] + (2 / 3) * (p1[0] - cur[0]), cur[1] + (2 / 3) * (p1[1] - cur[1])];
            const c2: [number, number] = [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])];
            cubic(cur, c1, c2, p2);
          }
          cur = p2;
        } else if (op === DRAW_CLOSE) {
          if (cur && start) push(cur, start, false);
          cur = start;
        } else {
          // Code inconnu (autre version de pdf.js) : on abandonne ce tracé plutôt que de lire n'importe quoi.
          break;
        }
      }
      // Un remplissage, ou un tracé « fermer puis tracer », referme implicitement le contour.
      if ((closeOps.has(paintOp) || (fill && !stroke)) && cur && start) push(cur, start, false);
    }
  }

  return {
    number: page.pageNumber,
    width: viewport.width,
    height: viewport.height,
    rotation,
    turned,
    texts,
    segs,
    images,
    imageCoverage,
    imagePixelsPerPoint,
    truncated,
    fills: [],
    hatches: [],
    stipples: [],
    clips: [],
    imageAreas: [],
    lightening: { rawStrokeSegs: segs.length, stippleSegs: 0, hatchSegs: 0 },
  };
}
