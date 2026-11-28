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
 * En plus des traits, l'extraction suit les zones de découpe (clip / eoClip, pile save / restore ; le cadre BBox
 * d'un Form XObject n'est PAS compté comme découpe, voir paintFormXObjectBegin), les couleurs de trait et de
 * remplissage, l'opacité de remplissage et les paramètres d'un ExtGState (LW, D, ca), et rend les remplissages
 * (anneaux, couleur, aire). Elle ALLÈGE la page (voir hatch.ts) : les trames de micro-traits et les hachures sont
 * retirées de `segs` et résumées en zones ; le plafond de traits s'applique ensuite seulement. Les bords de
 * remplissage restent dans `segs` (fill: true) comme avant.
 *
 * Mémoire : un tracé qu'aucune règle d'allègement ne peut retirer (remplissage, tracé hors petite découpe qui n'est
 * pas une hachure d'un seul tracé) est « sûr ». Dès que les traits sûrs atteignent le plafond, la suite serait
 * coupée de toute façon : comme l'ancienne lecture s'arrêtait au plafond, on ne lit plus les tracés seulement
 * tracés, et on ne garde plus les traits des remplissages (leurs anneaux restent lus).
 *
 * C'est le seul fichier qui manipule les listes d'opérateurs non typées de pdf.js.
 */
import { boxArea, emptyBox, groupHatches, growBox, HATCH_MAX_CLIP_SHARE, isMicroExtent, pathHatchOf, PATH_HATCH_MIN_SEGS, stippleZones } from './hatch';
import type { ClipStrokeStat, Ring } from './hatch';
import type { OpCodes, PDFPageProxy } from './pdfjs';
import type { ClipZone, FillArea, ImageArea, RawBox, RawPage, RawSeg, RawText } from './raw';

type Matrix = [number, number, number, number, number, number];

/** Au-delà (après allègement), la page est lue en partie seulement (plans très lourds, fonds de carte). */
export const MAX_PAGE_SEGMENTS = 400_000;
/** Pendant la lecture, on garde au plus ce multiple du plafond en traits ordinaires (avant allègement). */
const COLLECT_FACTOR = 3;
/** Micro-traits gardés en attente de la décision « trame » (stockage compact) ; au-delà ils sont comptés seulement. */
const MAX_MICRO_SEGS = 1_500_000;
const MAX_PAGE_FILLS = 50_000;
const MAX_PAGE_CLIPS = 100_000;
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

// ───────────── Couleurs ─────────────

const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/** Couleur RGB d'un opérateur pdf.js : « #rrggbb » (pdf.js 4 et plus) ou trois composantes 0..255. */
function rgbColor(args: readonly unknown[]): number | null {
  const a = args[0];
  if (typeof a === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(a);
    return m ? parseInt(m[1]!, 16) : null;
  }
  if (isNumberList(args, 3)) return (clampByte(args[0]!) << 16) | (clampByte(args[1]!) << 8) | clampByte(args[2]!);
  return null;
}

/** Gris 0..1 (si pdf.js ne l'a pas déjà converti en RGB). */
function grayColor(args: readonly unknown[]): number | null {
  if (typeof args[0] === 'string') return rgbColor(args);
  if (!isNumberList(args, 1)) return null;
  const v = clampByte(args[0]! * 255);
  return (v << 16) | (v << 8) | v;
}

/** CMJN 0..1, conversion naïve (si pdf.js ne l'a pas déjà convertie en RGB). */
function cmykColor(args: readonly unknown[]): number | null {
  if (typeof args[0] === 'string') return rgbColor(args);
  if (!isNumberList(args, 4)) return null;
  const k = 1 - args[3]!;
  return (clampByte(255 * (1 - args[0]!) * k) << 16) | (clampByte(255 * (1 - args[1]!) * k) << 8) | clampByte(255 * (1 - args[2]!) * k);
}

// ───────────── Anneaux ─────────────

/** Aire (valeur absolue, formule du lacet) d'un anneau. */
function ringArea(r: Ring): number {
  let a = 0;
  for (let k = 0; k < r.length; k++) {
    const p = r[k]!;
    const q = r[(k + 1) % r.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Anneaux utilisables : sans point de fermeture répété, au moins trois sommets. */
function cleanRings(rings: Ring[]): Ring[] {
  const out: Ring[] = [];
  for (const r of rings) {
    const a = r[0];
    const b = r[r.length - 1];
    if (r.length > 1 && a && b && a[0] === b[0] && a[1] === b[1]) r.pop();
    if (r.length >= 3) out.push(r);
  }
  return out;
}

function boxOfRings(rings: readonly Ring[]): RawBox {
  const b = emptyBox();
  for (const r of rings) for (const [x, y] of r) growBox(b, x, y);
  return b;
}

/** Un seul anneau de quatre sommets, tous sur les bords de sa boîte : un rectangle aligné sur les axes. */
function isAxisRect(rings: readonly Ring[], b: RawBox): boolean {
  const r = rings[0];
  if (rings.length !== 1 || !r || r.length !== 4) return false;
  if (!(b.maxX - b.minX > 0.5 && b.maxY - b.minY > 0.5)) return false;
  const near = (v: number, w: number): boolean => Math.abs(v - w) < 0.5;
  return r.every(([x, y]) => (near(x, b.minX) || near(x, b.maxX)) && (near(y, b.minY) || near(y, b.maxY)));
}

// ───────────── Micro-traits en attente ─────────────

/**
 * Micro-traits mis de côté pendant la lecture, en tableaux typés (une page réelle en porte des centaines de
 * milliers) ; chacun garde sa place dans la suite des traits pour être réinséré à l'identique s'il n'est pas
 * dans une trame.
 */
class MicroStore {
  n = 0;
  private f = new Float64Array(5 * 1024);
  private i = new Int32Array(4 * 1024);
  private b = new Uint8Array(1024);

  constructor(private readonly limit: number) {}

  /** Garde le trait ; faux si la réserve est pleine. */
  add(s: RawSeg, pos: number): boolean {
    if (this.n >= this.limit) return false;
    if (this.n >= this.b.length) {
      const cap = Math.min(this.limit, this.b.length * 2);
      const f = new Float64Array(5 * cap);
      f.set(this.f);
      const i = new Int32Array(4 * cap);
      i.set(this.i);
      const b = new Uint8Array(cap);
      b.set(this.b);
      this.f = f;
      this.i = i;
      this.b = b;
    }
    const k = this.n++;
    const f = this.f;
    const o = 5 * k;
    f[o] = s.x0;
    f[o + 1] = s.y0;
    f[o + 2] = s.x1;
    f[o + 3] = s.y1;
    f[o + 4] = s.w;
    const n = this.i;
    const j = 4 * k;
    n[j] = s.pid;
    n[j + 1] = s.clip ?? 0;
    n[j + 2] = s.color ?? 0;
    n[j + 3] = pos;
    this.b[k] = (s.curve ? 1 : 0) | (s.dash ? 2 : 0);
    return true;
  }

  pos(k: number): number {
    return this.i[4 * k + 3]!;
  }

  clip(k: number): number {
    return this.i[4 * k + 1]!;
  }

  seg(k: number): RawSeg {
    const f = this.f;
    const o = 5 * k;
    const flags = this.b[k]!;
    // Micro-traits : tracés seulement (jamais des bords de remplissage).
    return { x0: f[o]!, y0: f[o + 1]!, x1: f[o + 2]!, y1: f[o + 3]!, w: f[o + 4]!, curve: (flags & 1) !== 0, stroke: true, fill: false, dash: (flags & 2) !== 0, pid: this.i[4 * k]!, clip: this.i[4 * k + 1]!, color: this.i[4 * k + 2]! };
  }
}

export interface ExtractOptions {
  /** Dit si un groupe de contenu optionnel (calque PDF) est affiché ; absent = tout est affiché. */
  isVisible?: (group: unknown) => boolean;
  maxSegments?: number;
  /** Faux = ne rien retirer (ni trames ni hachures) : diagnostic et comparaison. Vrai par défaut. */
  lighten?: boolean;
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

  // ───────────── Traits vectoriels, remplissages, découpes ─────────────
  const list = await page.getOperatorList();
  const fnArray = list.fnArray as readonly number[];
  const argsArray = list.argsArray as readonly unknown[];

  const strokeOps = new Set([ops.stroke, ops.closeStroke, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const fillOps = new Set([ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const closeOps = new Set([ops.closeStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const imageOps = new Set([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageXObjectRepeat]);

  const lighten = options.lighten !== false;
  const collectLimit = COLLECT_FACTOR * maxSegments;
  /** Traits ordinaires (les micro-traits attendent à part, dans `micro`). */
  const segs: RawSeg[] = [];
  const micro = new MicroStore(lighten ? MAX_MICRO_SEGS : 0);
  /** Micro-traits non gardés faute de place, par découpe. */
  const lostMicro = new Map<number, number>();
  const stats: (ClipStrokeStat | undefined)[] = [];
  const fills: FillArea[] = [];
  const imageAreas: ImageArea[] = [];
  let truncated = false;
  let rawStrokeSegs = 0;
  /** Traits gardés qu'aucune règle d'allègement ne peut retirer (voir l'en-tête). */
  let sureSegs = 0;
  /** Tracés déjà jugés : pas des hachures d'un seul tracé (voir isSure). */
  const notPathHatch = new Set<number>();

  interface GraphicState {
    ctm: Matrix;
    lineWidth: number;
    dash: boolean;
    fillColor: number;
    strokeColor: number;
    fillAlpha: number;
    /** Zone de découpe active (indice dans `clips`). */
    clip: number;
  }
  let gs: GraphicState = { ctm: [1, 0, 0, 1, 0, 0], lineWidth: 1, dash: false, fillColor: 0, strokeColor: 0, fillAlpha: 1, clip: 0 };
  const stack: GraphicState[] = [];
  /** Pile des contenus balisés : vrai = calque masqué. */
  const marked: boolean[] = [];
  let hidden = 0;
  let pid = 0;
  let images = 0;
  let imageCoverage = 0;
  let imagePixelsPerPoint = 0;
  /** Un opérateur clip / eoClip attend le tracé qui suit (la découpe s'applique APRÈS sa peinture éventuelle). */
  let pendingClip = false;
  const pageArea = Math.max(1, viewport.width * viewport.height);

  const clips: ClipZone[] = [{ id: 0, parent: -1, bbox: { minX: 0, minY: 0, maxX: viewport.width, maxY: viewport.height }, rect: true, ops: 0 }];
  const clipRings: Ring[][] = [[]];
  const addClip = (rings: Ring[]): void => {
    if (clips.length >= MAX_PAGE_CLIPS) return;
    const b = boxOfRings(rings);
    if (!Number.isFinite(b.minX + b.minY + b.maxX + b.maxY)) return;
    const id = clips.length;
    clips.push({ id, parent: gs.clip, bbox: b, rect: isAxisRect(rings, b), ops: 0 });
    clipRings.push(rings);
    gs.clip = id;
  };
  const statOf = (clip: number): ClipStrokeStat => {
    let s = stats[clip];
    if (!s) stats[clip] = s = { all: 0, micro: 0, box: emptyBox(), color: 0 };
    return s;
  };

  /**
   * Les traits du tracé qui vient d'être lu (segs[from..]) sont-ils sûrs de rester ? Bords de remplissage : oui.
   * Sinon non sous une petite découpe (hachure possible), ni si le tracé a des micro-sous-tracés en attente, ni
   * s'il passe le repli « hachure d'un seul tracé » (mêmes critères que groupHatches).
   */
  const isSure = (fill: boolean, clip: number, hasMicro: boolean, from: number): boolean => {
    if (fill || !lighten) return true;
    if (clip !== 0 && boxArea(clips[clip]!.bbox) <= HATCH_MAX_CLIP_SHARE * pageArea) return false;
    if (hasMicro) return false;
    const straight: RawSeg[] = [];
    if (segs.length - from >= PATH_HATCH_MIN_SEGS) for (let k = from; k < segs.length; k++) if (!segs[k]!.curve) straight.push(segs[k]!);
    if (straight.length >= PATH_HATCH_MIN_SEGS && pathHatchOf(straight, pageArea) !== null) return false;
    // Jugé une fois pour toutes : groupHatches verra exactement ces traits (ni micro-traits, ni petite découpe).
    notPathHatch.add(segs[from]!.pid);
    return true;
  };

  const save = (): void => {
    stack.push({ ...gs });
  };
  const restore = (): void => {
    const s = stack.pop();
    if (s) gs = s;
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]!;
    const args = (argsArray[i] ?? []) as readonly unknown[];
    if (fn === ops.save) save();
    else if (fn === ops.restore) restore();
    else if (fn === ops.transform) {
      const m = toMatrix(args);
      if (m) gs.ctm = mul(gs.ctm, m);
    } else if (fn === ops.setLineWidth) {
      if (typeof args[0] === 'number') gs.lineWidth = args[0];
    } else if (fn === ops.setDash) {
      const pattern = args[0];
      gs.dash = (Array.isArray(pattern) || ArrayBuffer.isView(pattern)) && (pattern as ArrayLike<unknown>).length > 0;
    } else if (fn === ops.setFillRGBColor) gs.fillColor = rgbColor(args) ?? gs.fillColor;
    else if (fn === ops.setStrokeRGBColor) gs.strokeColor = rgbColor(args) ?? gs.strokeColor;
    else if (fn === ops.setFillGray) gs.fillColor = grayColor(args) ?? gs.fillColor;
    else if (fn === ops.setStrokeGray) gs.strokeColor = grayColor(args) ?? gs.strokeColor;
    else if (fn === ops.setFillCMYKColor) gs.fillColor = cmykColor(args) ?? gs.fillColor;
    else if (fn === ops.setStrokeCMYKColor) gs.strokeColor = cmykColor(args) ?? gs.strokeColor;
    else if (fn === ops.setGState) {
      // Paramètres d'un ExtGState : [[clé, valeur], …] (seuls ceux qui comptent pour la lecture).
      const entries = args[0];
      if (Array.isArray(entries)) {
        for (const kv of entries as unknown[]) {
          if (!Array.isArray(kv)) continue;
          const [key, value] = kv as [unknown, unknown];
          if (key === 'LW' && typeof value === 'number' && Number.isFinite(value)) gs.lineWidth = value;
          else if (key === 'ca' && typeof value === 'number' && Number.isFinite(value)) gs.fillAlpha = Math.max(0, Math.min(1, value));
          else if (key === 'D' && Array.isArray(value)) {
            const pattern = value[0] as unknown;
            gs.dash = (Array.isArray(pattern) || ArrayBuffer.isView(pattern)) && (pattern as ArrayLike<unknown>).length > 0;
          }
        }
      }
    } else if (fn === ops.paintFormXObjectBegin) {
      save();
      const m = toMatrix(args[0]);
      if (m) gs.ctm = mul(gs.ctm, m);
      // Le cadre (BBox) du formulaire n'est PAS compté comme découpe : les exports en peignent des milliers de
      // minuscules (un par symbole ou par point de trame), ce qui morcellerait les trames et les hachures ; le
      // contenu garde la découpe englobante, et la pile save / restore isole l'état du formulaire.
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
    } else if (fn === ops.clip || fn === ops.eoClip) pendingClip = true;
    else if (imageOps.has(fn)) {
      if (hidden > 0) continue;
      images++;
      const ctm = gs.ctm;
      // Une image occupe le carré unité de son repère : son emprise sur la page est celle du CTM.
      const a = Math.hypot(ctm[0], ctm[1]);
      const b = Math.hypot(ctm[2], ctm[3]);
      const pw = typeof args[1] === 'number' ? args[1] : 0;
      const ph = typeof args[2] === 'number' ? args[2] : 0;
      const ppp = a > 0 && b > 0 ? Math.max(pw / a, ph / b) : 0;
      const coverage = Math.min(1, Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / pageArea);
      if (coverage > imageCoverage) {
        imageCoverage = coverage;
        imagePixelsPerPoint = ppp;
      }
      const M = mul(V, ctm);
      const box = boxOfRings([[apply(M, 0, 0), apply(M, 1, 0), apply(M, 1, 1), apply(M, 0, 1)]]);
      if (Number.isFinite(box.minX + box.minY + box.maxX + box.maxY)) imageAreas.push({ bbox: box, pixelsPerPoint: ppp });
    } else if (fn === ops.constructPath) {
      const paintOp = args[0];
      const holder = args[1];
      const data = Array.isArray(holder) ? (holder[0] as unknown) : undefined;
      const clipNow = pendingClip;
      pendingClip = false;
      if (typeof paintOp !== 'number' || !(data instanceof Float32Array)) continue;
      const stroke = strokeOps.has(paintOp);
      const fill = fillOps.has(paintOp);
      let paint = (stroke || fill) && hidden === 0; // sinon : tracé de découpe seul, ou calque masqué
      // Collecte saturée : ce tracé serait au-delà du plafond. Un remplissage reste lu (anneaux, couleur), sans
      // garder ses traits ; un tracé seulement tracé est sauté, comme dans l'ancienne lecture.
      let keep = paint;
      if (paint && (sureSegs >= maxSegments || segs.length >= collectLimit)) {
        truncated = true;
        keep = false;
        if (!fill) paint = false;
      }
      if (!paint && !clipNow) continue;
      const M = mul(V, gs.ctm);
      const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]));
      const w = stroke ? gs.lineWidth * scale : 0;
      const id = paint ? pid++ : -1;
      const clip = gs.clip;
      const color = stroke ? gs.strokeColor : gs.fillColor;
      const dash = gs.dash;
      if (paint) clips[clip]!.ops++;
      // Un tracé seulement tracé est jugé sous-tracé par sous-tracé : un seul tracé peut porter des milliers de
      // points de trame (un sous-tracé par point).
      const judge = paint && stroke && !fill && lighten;
      const wantRings = (paint && fill) || clipNow;
      const rings: Ring[] = [];
      let ring: Ring | null = null;
      let ringClosed = false;
      let sub: RawSeg[] = [];
      let subN = 0;
      const firstSeg = segs.length;
      let hadMicro = false;
      let sx0 = Infinity;
      let sy0 = Infinity;
      let sx1 = -Infinity;
      let sy1 = -Infinity;
      const emit = (s: RawSeg): void => {
        if (keep) segs.push(s);
        if (stroke) {
          rawStrokeSegs++;
          statOf(clip).all++;
        }
      };
      const flush = (): void => {
        if (subN === 0) return;
        if (isMicroExtent(sx1 - sx0, sy1 - sy0)) {
          hadMicro = true;
          const st = statOf(clip);
          rawStrokeSegs += subN;
          st.all += subN;
          if (st.micro === 0) st.color = color;
          st.micro += subN;
          // L'emprise d'un sous-tracé est celle de ses extrémités.
          growBox(st.box, sx0, sy0);
          growBox(st.box, sx1, sy1);
          for (const s of sub) if (!micro.add(s, segs.length)) lostMicro.set(clip, (lostMicro.get(clip) ?? 0) + 1);
        } else if (keep) for (const s of sub) emit(s);
        else {
          rawStrokeSegs += subN;
          statOf(clip).all += subN;
        }
        sub = [];
        subN = 0;
        sx0 = sy0 = Infinity;
        sx1 = sy1 = -Infinity;
      };
      const push = (p: [number, number], q: [number, number], curve: boolean): void => {
        if (!paint) return;
        if (p[0] === q[0] && p[1] === q[1]) return;
        if (!Number.isFinite(p[0] + p[1] + q[0] + q[1])) return;
        if (!judge) {
          if (keep) emit({ x0: p[0], y0: p[1], x1: q[0], y1: q[1], w, curve, stroke, fill, dash, pid: id, clip, color });
          else if (stroke) {
            rawStrokeSegs++;
            statOf(clip).all++;
          }
          return;
        }
        subN++;
        if (keep) sub.push({ x0: p[0], y0: p[1], x1: q[0], y1: q[1], w, curve, stroke, fill, dash, pid: id, clip, color });
        if (p[0] < sx0) sx0 = p[0];
        if (p[0] > sx1) sx1 = p[0];
        if (p[1] < sy0) sy0 = p[1];
        if (p[1] > sy1) sy1 = p[1];
        if (q[0] < sx0) sx0 = q[0];
        if (q[0] > sx1) sx1 = q[0];
        if (q[1] < sy0) sy0 = q[1];
        if (q[1] > sy1) sy1 = q[1];
      };
      /** Sommet d'anneau (remplissage, découpe). */
      const vertex = (p: [number, number], start: [number, number] | null): void => {
        if (!wantRings) return;
        if (!ring || ringClosed) {
          ring = start && ringClosed ? [start] : [];
          rings.push(ring);
          ringClosed = false;
        }
        const last = ring[ring.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) ring.push(p);
      };
      let cur: [number, number] | null = null;
      let start: [number, number] | null = null;
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
          vertex(next, start);
          prev = next;
        }
      };
      for (let k = 0; k < data.length; ) {
        const op = data[k++]!;
        if (op === DRAW_MOVE) {
          // Un remplissage referme implicitement chaque sous-tracé.
          if (fill && !stroke && cur && start) push(cur, start, false);
          if (judge) flush();
          cur = start = apply(M, data[k]!, data[k + 1]!);
          k += 2;
          if (wantRings) {
            ring = [start];
            rings.push(ring);
            ringClosed = false;
          }
        } else if (op === DRAW_LINE) {
          const p = apply(M, data[k]!, data[k + 1]!);
          k += 2;
          if (cur) push(cur, p, false);
          vertex(p, start);
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
          ringClosed = true;
        } else {
          // Code inconnu (autre version de pdf.js) : on abandonne ce tracé plutôt que de lire n'importe quoi.
          break;
        }
      }
      // Un remplissage, ou un tracé « fermer puis tracer », referme implicitement le contour.
      if ((closeOps.has(paintOp) || (fill && !stroke)) && cur && start) push(cur, start, false);
      if (judge) flush();
      if (keep && segs.length > firstSeg && isSure(fill, clip, hadMicro, firstSeg)) sureSegs += segs.length - firstSeg;
      if (wantRings) {
        const clean = cleanRings(rings);
        if (paint && fill && clean.length > 0 && fills.length < MAX_PAGE_FILLS) {
          const bbox = boxOfRings(clean);
          if (Number.isFinite(bbox.minX + bbox.minY + bbox.maxX + bbox.maxY)) {
            let area = 0;
            for (const r of clean) area = Math.max(area, ringArea(r));
            fills.push({ rings: clean, bbox, color: gs.fillColor, alpha: gs.fillAlpha, clip, stroked: stroke, area });
          }
        }
        if (clipNow && clean.length > 0) addClip(clean);
      }
    }
  }

  // ───────────── Allègement : trames, puis hachures, puis plafond ─────────────
  const stipples = lighten ? stippleZones(clips, stats, pageArea) : [];
  const stippleClips = new Set(stipples.map((z) => z.clip));
  let stippleSegs = 0;
  for (const z of stipples) stippleSegs += z.count;
  // Des micro-traits perdus faute de place hors d'une trame : la page n'est pas complète.
  for (const clip of lostMicro.keys()) if (!stippleClips.has(clip)) truncated = true;
  let all = segs;
  if (micro.n > 0) {
    // Réinsertion des micro-traits qui ne sont pas dans une trame, à leur place d'origine.
    all = [];
    let k = 0;
    for (let i = 0; i <= segs.length; i++) {
      while (k < micro.n && micro.pos(k) <= i) {
        if (!stippleClips.has(micro.clip(k))) all.push(micro.seg(k));
        k++;
      }
      if (i < segs.length) all.push(segs[i]!);
    }
  }
  let hatchSegs = 0;
  let hatches: RawPage['hatches'] = [];
  if (lighten) {
    const grouping = groupHatches(all, clips, clipRings, pageArea, notPathHatch);
    hatches = grouping.zones;
    hatchSegs = grouping.count;
    if (grouping.count > 0) all = all.filter((_, i) => !grouping.drop[i]);
  }
  if (all.length > maxSegments) {
    // Comme avant l'allègement : on garde le tracé entamé au moment où le plafond est atteint.
    let cut = maxSegments;
    while (cut < all.length && all[cut]!.pid === all[cut - 1]!.pid) cut++;
    if (cut < all.length) {
      truncated = true;
      all = all.slice(0, cut);
    }
  }

  return {
    number: page.pageNumber,
    width: viewport.width,
    height: viewport.height,
    rotation,
    turned,
    texts,
    segs: all,
    images,
    imageCoverage,
    imagePixelsPerPoint,
    truncated,
    fills,
    hatches,
    stipples,
    clips,
    imageAreas,
    lightening: { rawStrokeSegs, stippleSegs, hatchSegs },
  };
}
