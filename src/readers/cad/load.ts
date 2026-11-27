/**
 * Lecture brute d'un DWG / DXF avec @node-projects/acad-ts — SEUL fichier du lecteur qui touche à cette bibliothèque.
 *
 * Résultat : l'espace objet « mis à plat » (références de blocs développées récursivement, arcs / splines /
 * polylignes à bulges discrétisés) sous une forme neutre : segments, arcs, textes, insertions de blocs.
 *
 * Repère d'ANALYSE : repère CAO (y vers le HAUT) décalé de `origin` pour garder de petits nombres
 * (les plans géoréférencés ont des coordonnées de plusieurs millions d'unités).
 */
import {
  Arc,
  AttributeDefinition,
  AttributeEntity,
  BlockTypeFlags,
  Circle,
  Dimension,
  DwgReader,
  DxfReader,
  Ellipse,
  Face3D,
  Hatch,
  HatchBoundaryPathArc,
  HatchBoundaryPathLine,
  HatchBoundaryPathPolyline,
  Insert,
  LayerFlags,
  Leader,
  Line,
  LwPolyline,
  MLine,
  MText,
  Polyline,
  Solid,
  Spline,
  TextEntity,
  Vertex,
} from '@node-projects/acad-ts';
import * as acadNamespace from '@node-projects/acad-ts';
import type { BlockRecord, CadDocument, Entity } from '@node-projects/acad-ts';
import type { Vec2 } from '../../core/types';
import { decodeMText, decodeText } from './text';

/**
 * acad-ts retrouve ses tables et ses descriptions DXF par le NOM des classes (`constructor.name`). Un build de
 * production qui raccourcit les noms (minification) casse donc la lecture des DXF — vérifié dans Chromium.
 * Les noms d'export, eux, survivent : on les réattribue aux classes dont le nom a été raccourci.
 * Sans effet quand les noms sont intacts (développement, tests, build avec `keepNames`).
 */
export function restoreClassNames(namespace: Record<string, unknown>): number {
  let restored = 0;
  for (const [exportName, value] of Object.entries(namespace)) {
    if (typeof value !== 'function' || value.name === exportName) continue;
    // Un nom raccourci fait 1 à 4 caractères ; un vrai nom différent de l'export (alias) est laissé tel quel.
    if (value.name.length > 4) continue;
    try {
      Object.defineProperty(value, 'name', { value: exportName, configurable: true });
      restored++;
    } catch {
      // Propriété verrouillée : rien à faire.
    }
  }
  return restored;
}

restoreClassNames(acadNamespace as unknown as Record<string, unknown>);

/** Nature d'un segment (sert à alléger l'affichage et à choisir les traits de murs). */
export const SEG_LINE = 0;
export const SEG_POLY = 1;
export const SEG_CURVE = 2;
export const SEG_HATCH = 3;
export const SEG_DIM = 4;
export const SEG_FILL = 5;

/** Transformation affine 2D : x' = a·x + c·y + e ; y' = b·x + d·y + f. */
export type Mat = readonly [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function compose(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export interface RawTextLine {
  text: string;
  /** Départ de la ligne de base (repère d'analyse). */
  x: number;
  y: number;
}

export interface RawText {
  /** Texte décodé ; les lignes d'un MTEXT sont séparées par « \n ». */
  text: string;
  /** Centre approximatif du texte. */
  cx: number;
  cy: number;
  height: number;
  layer: number;
  /** Insertion de bloc d'où vient le texte (−1 = directement dans l'espace objet). */
  insert: number;
  /** Texte de cote (valeur mesurée) : ignoré pour les noms de pièces. */
  dim: boolean;
  /** Attribut de bloc invisible : conservé pour les dimensions d'ouvertures, jamais affiché. */
  hidden: boolean;
  lines: RawTextLine[];
}

export interface RawArc {
  cx: number;
  cy: number;
  radius: number;
  /** Angle balayé en degrés (0..360). */
  sweep: number;
  layer: number;
  insert: number;
}

export interface RawInsert {
  name: string;
  layer: number;
  /** Insertion parente (−1 = espace objet). */
  parent: number;
  depth: number;
  /** Point d'insertion (repère d'analyse). */
  x: number;
  y: number;
  /** Direction de l'axe +Y du bloc dans le dessin (vecteur unitaire) : sert à lire une flèche du nord. */
  upX: number;
  upY: number;
  attribs: Record<string, string>;
  /** Segments et arcs produits par ce bloc et ses sous-blocs : intervalles [start, end). */
  segStart: number;
  segEnd: number;
  arcStart: number;
  arcEnd: number;
}

export interface RawDrawing {
  version: string;
  /** $INSUNITS de l'en-tête (0 = sans unité). */
  insUnits: number;
  layers: string[];
  segCount: number;
  /** [x1, y1, x2, y2, …] */
  segXY: Float64Array;
  segLayer: Int32Array;
  segKind: Uint8Array;
  /** Insertion de bloc la plus profonde d'où vient le segment (−1 = espace objet). */
  segInsert: Int32Array;
  arcs: RawArc[];
  texts: RawText[];
  inserts: RawInsert[];
  /** Décalage retiré des coordonnées CAO. */
  origin: Vec2;
  stats: {
    entities: number;
    hiddenLayerEntities: number;
    unsupported: Record<string, number>;
    truncated: boolean;
    missingXrefs: string[];
    readerNotes: number;
  };
}

export class CadReadError extends Error {
  constructor(
    message: string,
    public readonly reason: 'empty' | 'unreadable',
  ) {
    super(message);
    this.name = 'CadReadError';
  }
}

const MAX_SEGMENTS = 3_000_000;
const MAX_DEPTH = 8;
const MAX_ARRAY_CELLS = 2_500;

class SegStore {
  xy = new Float64Array(4 * 4096);
  layer = new Int32Array(4096);
  kind = new Uint8Array(4096);
  insert = new Int32Array(4096);
  count = 0;

  push(x1: number, y1: number, x2: number, y2: number, layer: number, kind: number, insert: number): void {
    if (!(Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2))) return;
    if (x1 === x2 && y1 === y2) return;
    if (this.count === this.layer.length) this.grow();
    const i = this.count * 4;
    this.xy[i] = x1;
    this.xy[i + 1] = y1;
    this.xy[i + 2] = x2;
    this.xy[i + 3] = y2;
    this.layer[this.count] = layer;
    this.kind[this.count] = kind;
    this.insert[this.count] = insert;
    this.count++;
  }

  private grow(): void {
    const cap = this.layer.length * 2;
    const xy = new Float64Array(cap * 4);
    xy.set(this.xy);
    this.xy = xy;
    const layer = new Int32Array(cap);
    layer.set(this.layer);
    this.layer = layer;
    const kind = new Uint8Array(cap);
    kind.set(this.kind);
    this.kind = kind;
    const insert = new Int32Array(cap);
    insert.set(this.insert);
    this.insert = insert;
  }
}

interface Ctx {
  m: Mat;
  /** Calque hérité par le contenu dessiné sur le calque « 0 » d'un bloc (−1 = aucun). */
  layerCtx: number;
  insert: number;
  depth: number;
  /** Nature imposée aux segments (cotes, hachures) ; −1 = selon l'entité. */
  kind: number;
  dim: boolean;
  path: string[];
}

/** Nombre de cordes pour un arc d'angle `sweep` (radians). */
function arcSteps(sweep: number): number {
  return Math.max(2, Math.min(96, Math.ceil(Math.abs(sweep) / (Math.PI / 24))));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

class Flattener {
  readonly segs = new SegStore();
  readonly arcs: RawArc[] = [];
  readonly texts: RawText[] = [];
  readonly inserts: RawInsert[] = [];
  readonly layers: string[] = [];
  readonly unsupported: Record<string, number> = {};
  readonly missingXrefs = new Set<string>();
  entities = 0;
  hiddenLayerEntities = 0;
  truncated = false;

  private readonly layerIndex = new Map<string, number>();
  private readonly hiddenLayers = new Set<string>();

  constructor(doc: CadDocument, offLayers: ReadonlySet<string>) {
    for (const name of offLayers) this.hiddenLayers.add(name);
    if (doc.layers) {
      for (const layer of doc.layers) {
        if (!layer.isOn || (layer.layerFlags & LayerFlags.Frozen) !== 0) this.hiddenLayers.add(layer.name);
      }
    }
  }

  private layerId(name: string): number {
    let id = this.layerIndex.get(name);
    if (id === undefined) {
      id = this.layers.length;
      this.layers.push(name);
      this.layerIndex.set(name, id);
    }
    return id;
  }

  private tx(m: Mat, x: number, y: number): [number, number] {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  private seg(ctx: Ctx, layer: number, kind: number, x1: number, y1: number, x2: number, y2: number): void {
    const m = ctx.m;
    this.segs.push(
      m[0] * x1 + m[2] * y1 + m[4],
      m[1] * x1 + m[3] * y1 + m[5],
      m[0] * x2 + m[2] * y2 + m[4],
      m[1] * x2 + m[3] * y2 + m[5],
      layer,
      ctx.kind >= 0 ? ctx.kind : kind,
      ctx.insert,
    );
  }

  private path(ctx: Ctx, layer: number, kind: number, pts: readonly (readonly [number, number])[], closed: boolean): void {
    for (let i = 0; i + 1 < pts.length; i++) this.seg(ctx, layer, kind, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1]);
    if (closed && pts.length > 2) {
      const a = pts[pts.length - 1]!;
      const b = pts[0]!;
      this.seg(ctx, layer, kind, a[0], a[1], b[0], b[1]);
    }
  }

  /** Arc de cercle local (centre, rayon, angles en radians, sens trigonométrique de a0 vers a1). */
  private arc(ctx: Ctx, layer: number, cx: number, cy: number, r: number, a0: number, a1: number, mirror: boolean, record: boolean): void {
    if (!(r > 0) || !isFiniteNumber(a0) || !isFiniteNumber(a1)) return;
    let sweep = a1 - a0;
    while (sweep <= 1e-9) sweep += 2 * Math.PI;
    while (sweep > 2 * Math.PI + 1e-9) sweep -= 2 * Math.PI;
    const n = arcSteps(sweep);
    const sx = mirror ? -1 : 1;
    let px = sx * (cx + r * Math.cos(a0));
    let py = cy + r * Math.sin(a0);
    for (let i = 1; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      const qx = sx * (cx + r * Math.cos(a));
      const qy = cy + r * Math.sin(a);
      this.seg(ctx, layer, SEG_CURVE, px, py, qx, qy);
      px = qx;
      py = qy;
    }
    if (record) {
      const [wx, wy] = this.tx(ctx.m, sx * cx, cy);
      const [ex, ey] = this.tx(ctx.m, sx * (cx + r * Math.cos(a0)), cy + r * Math.sin(a0));
      this.arcs.push({ cx: wx, cy: wy, radius: Math.hypot(ex - wx, ey - wy), sweep: (sweep * 180) / Math.PI, layer, insert: ctx.insert });
    }
  }

  /** Suite de sommets avec bulges (polyligne) → segments ; les arcs de bulge sont discrétisés. */
  private bulgePath(ctx: Ctx, layer: number, kind: number, pts: readonly { x: number; y: number; bulge: number }[], closed: boolean): void {
    const n = pts.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % n]!;
      if (Math.abs(p.bulge) < 1e-9 || !isFiniteNumber(p.bulge)) {
        this.seg(ctx, layer, kind, p.x, p.y, q.x, q.y);
        continue;
      }
      const chord = Math.hypot(q.x - p.x, q.y - p.y);
      if (chord < 1e-12) continue;
      const theta = 4 * Math.atan(p.bulge);
      const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
      // Centre : sur la médiatrice, à gauche de la corde pour un bulge positif.
      const mx = (p.x + q.x) / 2;
      const my = (p.y + q.y) / 2;
      const h = r * Math.cos(Math.abs(theta) / 2) * Math.sign(p.bulge);
      const cx = mx - ((q.y - p.y) / chord) * h;
      const cy = my + ((q.x - p.x) / chord) * h;
      const a0 = Math.atan2(p.y - cy, p.x - cx);
      const steps = arcSteps(theta);
      let px = p.x;
      let py = p.y;
      for (let k = 1; k <= steps; k++) {
        const a = a0 + (theta * k) / steps;
        const qx = k === steps ? q.x : cx + r * Math.cos(a);
        const qy = k === steps ? q.y : cy + r * Math.sin(a);
        this.seg(ctx, layer, SEG_CURVE, px, py, qx, qy);
        px = qx;
        py = qy;
      }
      const [wx, wy] = this.tx(ctx.m, cx, cy);
      const [ex, ey] = this.tx(ctx.m, p.x, p.y);
      this.arcs.push({ cx: wx, cy: wy, radius: Math.hypot(ex - wx, ey - wy), sweep: (Math.abs(theta) * 180) / Math.PI, layer, insert: ctx.insert });
    }
  }

  private pushText(
    ctx: Ctx,
    layer: number,
    lines: { text: string; x: number; y: number }[],
    text: string,
    cx: number,
    cy: number,
    height: number,
    upX: number,
    upY: number,
    hidden: boolean,
  ): void {
    if (!text) return;
    const m = ctx.m;
    const [wx, wy] = this.tx(m, cx, cy);
    // Hauteur transformée : longueur de l'image du vecteur « haut » du texte.
    const hx = m[0] * upX + m[2] * upY;
    const hy = m[1] * upX + m[3] * upY;
    const h = height * Math.hypot(hx, hy);
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    this.texts.push({
      text,
      cx: wx,
      cy: wy,
      height: Number.isFinite(h) ? h : 0,
      layer,
      insert: ctx.insert,
      dim: ctx.dim,
      hidden,
      lines: lines.map((l) => {
        const [x, y] = this.tx(m, l.x, l.y);
        return { text: l.text, x, y };
      }),
    });
  }

  private textEntity(ctx: Ctx, layer: number, e: TextEntity, hidden: boolean): void {
    const text = decodeText(e.value ?? '');
    if (!text) return;
    const h = e.height > 0 ? e.height : 0;
    const mirror = e.normal.z < 0 ? -1 : 1;
    const rot = isFiniteNumber(e.rotation) ? e.rotation : 0;
    const dx = Math.cos(rot);
    const dy = Math.sin(rot);
    const nx = -dy;
    const ny = dx;
    const wf = e.widthFactor > 0.2 && e.widthFactor < 3 ? e.widthFactor : 1;
    const w = 0.6 * h * text.length * wf;
    const hAlign = Number(e.horizontalAlignment) || 0;
    const vAlign = Number(e.verticalAlignment) || 0;
    let lx = e.insertPoint.x;
    let ly = e.insertPoint.y;
    if ((hAlign !== 0 || vAlign !== 0) && hAlign !== 3 && hAlign !== 5) {
      // Point d'alignement = référence ; on en déduit le départ de la ligne de base.
      const fx = hAlign === 1 || hAlign === 4 ? 0.5 : hAlign === 2 ? 1 : 0;
      const fy = hAlign === 4 || vAlign === 2 ? 0.5 : vAlign === 3 ? 1 : 0;
      lx = e.alignmentPoint.x - dx * fx * w - nx * fy * h;
      ly = e.alignmentPoint.y - dy * fx * w - ny * fy * h;
    }
    const cx = lx + (dx * w) / 2 + (nx * h) / 2;
    const cy = ly + (dy * w) / 2 + (ny * h) / 2;
    this.pushText(ctx, layer, [{ text, x: mirror * lx, y: ly }], text, mirror * cx, cy, h, mirror * nx, ny, hidden);
  }

  private mtext(ctx: Ctx, layer: number, e: MText): void {
    const text = decodeMText(e.value ?? '');
    if (!text) return;
    const lines = text.split('\n');
    const h = e.height > 0 ? e.height : 0;
    const mirror = e.normal.z < 0 ? -1 : 1;
    const rot = isFiniteNumber(e.rotation) ? e.rotation : 0;
    const dx = Math.cos(rot);
    const dy = Math.sin(rot);
    const nx = -dy;
    const ny = dx;
    const lineStep = 1.66 * h;
    const width = 0.6 * h * Math.max(...lines.map((l) => l.length));
    const total = h + (lines.length - 1) * lineStep;
    const ap = Number(e.attachmentPoint) || 1;
    const col = (ap - 1) % 3;
    const row = Math.floor((ap - 1) / 3);
    // Coin haut-gauche du pavé de texte.
    const tlx = e.insertPoint.x - (dx * col * width) / 2 + (nx * row * total) / 2;
    const tly = e.insertPoint.y - (dy * col * width) / 2 + (ny * row * total) / 2;
    const cx = tlx + (dx * width) / 2 - (nx * total) / 2;
    const cy = tly + (dy * width) / 2 - (ny * total) / 2;
    const out = lines.map((line, i) => {
      const shift = ((width - 0.6 * h * line.length) * col) / 2;
      const down = h + i * lineStep;
      return { text: line, x: mirror * (tlx + dx * shift - nx * down), y: tly + dy * shift - ny * down };
    });
    this.pushText(ctx, layer, out.filter((l) => l.text.length > 0), text, mirror * cx, cy, h, mirror * nx, ny, false);
  }

  private hatch(ctx: Ctx, layer: number, e: Hatch): void {
    const kind = e.isSolid ? SEG_FILL : SEG_HATCH;
    for (const path of e.paths) {
      for (const edge of path.edges) {
        if (edge instanceof HatchBoundaryPathPolyline) {
          const bulges = edge.hasBulge ? edge.bulges : [];
          const pts = edge.vertices.map((v, i) => ({ x: v.x, y: v.y, bulge: bulges[i] ?? 0 }));
          const before = this.segs.count;
          const arcsBefore = this.arcs.length;
          this.bulgePath(ctx, layer, kind, pts, edge.isClosed);
          // Les arcs de hachure ne sont pas des débattements de porte.
          this.arcs.length = arcsBefore;
          for (let i = before; i < this.segs.count; i++) this.segs.kind[i] = ctx.kind >= 0 ? ctx.kind : kind;
        } else if (edge instanceof HatchBoundaryPathLine) {
          this.seg(ctx, layer, kind, edge.start.x, edge.start.y, edge.end.x, edge.end.y);
        } else if (edge instanceof HatchBoundaryPathArc) {
          const before = this.segs.count;
          if (edge.counterClockWise) this.arc(ctx, layer, edge.center.x, edge.center.y, edge.radius, edge.startAngle, edge.endAngle, false, false);
          else this.arc(ctx, layer, edge.center.x, edge.center.y, edge.radius, -edge.endAngle, -edge.startAngle, false, false);
          for (let i = before; i < this.segs.count; i++) this.segs.kind[i] = ctx.kind >= 0 ? ctx.kind : kind;
        }
      }
    }
  }

  private insertEntity(ctx: Ctx, layer: number, e: Insert): void {
    const block = e.block;
    if (!block) return;
    const name = block.name;
    const mirror = e.normal.z < 0;
    const rot = isFiniteNumber(e.rotation) ? e.rotation : 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const sx = isFiniteNumber(e.xScale) && e.xScale !== 0 ? e.xScale : 1;
    const sy = isFiniteNumber(e.yScale) && e.yScale !== 0 ? e.yScale : 1;
    const base = block.blockEntity?.basePoint;
    const bx = base ? base.x : 0;
    const by = base ? base.y : 0;
    const ocs: Mat = mirror ? [-1, 0, 0, 1, 0, 0] : IDENTITY;
    const cols = Math.max(1, Math.min(200, Math.round(e.columnCount) || 1));
    const rows = Math.max(1, Math.min(200, Math.round(e.rowCount) || 1));
    const cells = cols * rows > MAX_ARRAY_CELLS ? 1 : cols * rows;

    const attribs: Record<string, string> = {};
    for (const a of e.attributes) {
      if (!(a instanceof AttributeEntity)) continue;
      const value = decodeText(a.value ?? '');
      if (a.tag && value) attribs[a.tag] = value;
    }

    const flags = block.blockEntity?.flags ?? BlockTypeFlags.None;
    const isXref = (flags & (BlockTypeFlags.XRef | BlockTypeFlags.XRefOverlay)) !== 0;

    for (let cell = 0; cell < cells; cell++) {
      const col = cell % cols;
      const row = Math.floor(cell / cols);
      const ox = col * e.columnSpacing;
      const oy = row * e.rowSpacing;
      // T(point) · R(rot) · T(décalage du réseau) · S(sx, sy) · T(−base), précédé du miroir OCS.
      const local: Mat = [
        cos * sx,
        sin * sx,
        -sin * sy,
        cos * sy,
        e.insertPoint.x + cos * (ox - sx * bx) - sin * (oy - sy * by),
        e.insertPoint.y + sin * (ox - sx * bx) + cos * (oy - sy * by),
      ];
      const m = compose(ctx.m, compose(ocs, local));
      const [px, py] = this.tx(m, bx, by);
      const upX = m[2];
      const upY = m[3];
      const upLen = Math.hypot(upX, upY) || 1;
      const index = this.inserts.length;
      const record: RawInsert = {
        name,
        layer,
        parent: ctx.insert,
        depth: ctx.depth,
        x: px,
        y: py,
        upX: upX / upLen,
        upY: upY / upLen,
        attribs,
        segStart: this.segs.count,
        segEnd: this.segs.count,
        arcStart: this.arcs.length,
        arcEnd: this.arcs.length,
      };
      this.inserts.push(record);

      // Attributs : positions exprimées dans l'espace du parent.
      if (cell === 0) {
        const attCtx: Ctx = { ...ctx, insert: index };
        for (const a of e.attributes) {
          if (!(a instanceof AttributeEntity)) continue;
          const aLayerName = a.layer?.name ?? '0';
          if (this.hiddenLayers.has(aLayerName)) continue;
          const aLayer = aLayerName === '0' ? layer : this.layerId(aLayerName);
          const hidden = a.isInvisible || (a.flags & 1) !== 0;
          this.textEntity(attCtx, aLayer, a, hidden);
        }
      }

      if (isXref && block.entities.count === 0) {
        this.missingXrefs.add(block.blockEntity?.xRefPath || name);
      } else if (ctx.depth < MAX_DEPTH && !ctx.path.includes(name)) {
        const child: Ctx = { m, layerCtx: layer, insert: index, depth: ctx.depth + 1, kind: ctx.kind, dim: ctx.dim, path: [...ctx.path, name] };
        this.block(block, child);
      }
      record.segEnd = this.segs.count;
      record.arcEnd = this.arcs.length;
    }
  }

  block(block: BlockRecord, ctx: Ctx): void {
    for (const e of block.entities) {
      if (this.segs.count >= MAX_SEGMENTS) {
        this.truncated = true;
        return;
      }
      this.entity(e, ctx);
    }
  }

  entity(e: Entity, ctx: Ctx): void {
    if (ctx.depth === 0) this.entities++;
    if (e.isInvisible) return;
    const layerName = e.layer?.name ?? '0';
    if (this.hiddenLayers.has(layerName)) {
      this.hiddenLayerEntities++;
      return;
    }
    const layer = layerName === '0' && ctx.layerCtx >= 0 ? ctx.layerCtx : this.layerId(layerName);

    if (e instanceof Line) {
      this.seg(ctx, layer, SEG_LINE, e.startPoint.x, e.startPoint.y, e.endPoint.x, e.endPoint.y);
    } else if (e instanceof LwPolyline) {
      const sx = e.normal.z < 0 ? -1 : 1;
      const pts = e.vertices.map((v) => ({ x: sx * v.location.x, y: v.location.y, bulge: sx * v.bulge }));
      this.bulgePath(ctx, layer, SEG_POLY, pts, e.isClosed);
    } else if (e instanceof Polyline) {
      const sx = e.normal.z < 0 ? -1 : 1;
      const pts: { x: number; y: number; bulge: number }[] = [];
      for (const v of e.vertices) {
        if (v instanceof Vertex) pts.push({ x: sx * v.location.x, y: v.location.y, bulge: sx * (v.bulge || 0) });
      }
      this.bulgePath(ctx, layer, SEG_POLY, pts, e.isClosed);
    } else if (e instanceof Arc) {
      this.arc(ctx, layer, e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle, e.normal.z < 0, true);
    } else if (e instanceof Circle) {
      this.arc(ctx, layer, e.center.x, e.center.y, e.radius, 0, 2 * Math.PI, e.normal.z < 0, false);
    } else if (e instanceof Ellipse) {
      const mx = e.majorAxisEndPoint.x;
      const my = e.majorAxisEndPoint.y;
      const ratio = e.radiusRatio;
      const sign = e.normal.z < 0 ? -1 : 1;
      const nxm = -my * ratio * sign;
      const nym = mx * ratio * sign;
      let sweep = e.endParameter - e.startParameter;
      if (!isFiniteNumber(sweep) || sweep <= 1e-9) sweep += 2 * Math.PI;
      const n = arcSteps(sweep);
      const pts: [number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const t = e.startParameter + (sweep * i) / n;
        pts.push([e.center.x + mx * Math.cos(t) + nxm * Math.sin(t), e.center.y + my * Math.cos(t) + nym * Math.sin(t)]);
      }
      this.path(ctx, layer, SEG_CURVE, pts, false);
    } else if (e instanceof Spline) {
      let pts: [number, number][] = [];
      const res = e.tryPolygonalVertexes(Math.max(16, Math.min(128, e.controlPoints.length * 8)));
      if (res.success && res.points.length >= 2) pts = res.points.map((p) => [p.x, p.y]);
      else if (e.fitPoints.length >= 2) pts = e.fitPoints.map((p) => [p.x, p.y]);
      else pts = e.controlPoints.map((p) => [p.x, p.y]);
      this.path(ctx, layer, SEG_CURVE, pts, false);
    } else if (e instanceof Dimension) {
      const block = e.block;
      if (block && ctx.depth < MAX_DEPTH) {
        this.block(block, { ...ctx, layerCtx: layer, depth: ctx.depth + 1, kind: SEG_DIM, dim: true });
      }
    } else if (e instanceof Insert) {
      this.insertEntity(ctx, layer, e);
    } else if (e instanceof AttributeDefinition || e instanceof AttributeEntity) {
      // Les définitions d'attributs sont des gabarits ; les attributs sont lus avec leur insertion.
    } else if (e instanceof TextEntity) {
      this.textEntity(ctx, layer, e, false);
    } else if (e instanceof MText) {
      this.mtext(ctx, layer, e);
    } else if (e instanceof Hatch) {
      this.hatch(ctx, layer, e);
    } else if (e instanceof Solid || e instanceof Face3D) {
      const sx = e instanceof Solid && e.normal.z < 0 ? -1 : 1;
      // Ordre des coins d'un SOLID : 1, 2, 4, 3.
      const pts: [number, number][] = [
        [sx * e.firstCorner.x, e.firstCorner.y],
        [sx * e.secondCorner.x, e.secondCorner.y],
        e instanceof Solid ? [sx * e.fourthCorner.x, e.fourthCorner.y] : [e.thirdCorner.x, e.thirdCorner.y],
        e instanceof Solid ? [sx * e.thirdCorner.x, e.thirdCorner.y] : [e.fourthCorner.x, e.fourthCorner.y],
      ];
      this.path(ctx, layer, SEG_FILL, pts, true);
    } else if (e instanceof MLine) {
      const count = Math.max(1, ...e.vertices.map((v) => v.segments.length));
      for (let k = 0; k < count; k++) {
        const pts: [number, number][] = [];
        for (const v of e.vertices) {
          const offset = v.segments[k]?.parameters[0] ?? 0;
          pts.push([v.position.x + v.miter.x * offset, v.position.y + v.miter.y * offset]);
        }
        this.path(ctx, layer, SEG_POLY, pts, (Number(e.flags) & 2) !== 0);
      }
    } else if (e instanceof Leader) {
      this.path(ctx, layer, SEG_DIM, e.vertices.map((p): [number, number] => [p.x, p.y]), false);
    } else {
      const name = e.objectName || 'INCONNU';
      this.unsupported[name] = (this.unsupported[name] ?? 0) + 1;
    }
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)]!;
}

/** Vrai si les octets ressemblent à un DWG (« AC10xx » en tête) quel que soit le type annoncé. */
function looksLikeDwg(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const head = String.fromCharCode(...bytes.subarray(0, 6));
  return /^AC1\d\d\d/.test(head) || /^AC2\.\d/.test(head) || /^MC0\.0/.test(head);
}

/**
 * Calques ÉTEINTS d'un DXF texte (couleur négative, code 62 de la table LAYER).
 * Contournement : acad-ts 3.10.0 lit ce code comme un entier non signé (−7 → 65529) et ne voit donc pas
 * qu'un calque est éteint dans un DXF (il le voit dans un DWG). On relit donc la table nous-mêmes.
 */
export function dxfOffLayers(bytes: Uint8Array): Set<string> {
  const off = new Set<string>();
  const limit = Math.min(bytes.length, 8_000_000);
  if (limit < 20 || bytes[0] === 0x41 /* « AutoCAD Binary DXF » */ && bytes[8] === 0x42) return off;
  // La table des calques précède les blocs et les entités : inutile de décoder tout le fichier.
  let text: string;
  const head = bytes.subarray(0, limit);
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(head);
  } catch {
    text = new TextDecoder('windows-1252').decode(head);
  }
  const stop = text.search(/\n\s*2\s*\r?\n\s*(BLOCKS|ENTITIES)\s*\r?\n/);
  const lines = (stop >= 0 ? text.slice(0, stop) : text).split(/\r?\n/);
  let inLayerTable = false;
  let name: string | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i]!.trim();
    const value = lines[i + 1]!.trim();
    if (code === '0') {
      name = null;
      if (value === 'TABLE') inLayerTable = lines[i + 2]?.trim() === '2' && lines[i + 3]?.trim() === 'LAYER';
      else if (value === 'ENDTAB') inLayerTable = false;
    } else if (inLayerTable && code === '2') {
      name = value;
    } else if (inLayerTable && code === '62' && name !== null && Number(value) < 0) {
      off.add(name);
    }
  }
  return off;
}

/**
 * Lit le fichier et met l'espace objet à plat. `pause` rend la main à la boucle d'événements.
 * Lève `CadReadError` si le fichier est illisible ou vide.
 */
export async function readDrawing(data: ArrayBuffer, kind: 'dwg' | 'dxf', pause: () => Promise<void>): Promise<RawDrawing> {
  const bytes = new Uint8Array(data);
  let readerNotes = 0;
  const notify = (): void => {
    readerNotes++;
  };
  await pause();
  let doc: CadDocument;
  let offLayers = new Set<string>();
  try {
    const asDwg = kind === 'dwg' || looksLikeDwg(bytes);
    doc = asDwg ? DwgReader.readFromStream(data, notify) : DxfReader.readFromStream(bytes, notify);
    if (!asDwg) offLayers = dxfOffLayers(bytes);
  } catch (err) {
    throw new CadReadError(err instanceof Error ? err.message : String(err), 'unreadable');
  }
  await pause();

  const model = doc.modelSpace;
  if (!model) throw new CadReadError('espace objet absent', 'empty');

  const flat = new Flattener(doc, offLayers);
  const root: Ctx = { m: IDENTITY, layerCtx: -1, insert: -1, depth: 0, kind: -1, dim: false, path: [] };
  let lastPause = Date.now();
  for (const e of model.entities) {
    if (flat.segs.count >= MAX_SEGMENTS) {
      flat.truncated = true;
      break;
    }
    try {
      flat.entity(e, root);
    } catch {
      const name = e.objectName || 'INCONNU';
      flat.unsupported[name] = (flat.unsupported[name] ?? 0) + 1;
    }
    if (Date.now() - lastPause > 40) {
      await pause();
      lastPause = Date.now();
    }
  }

  // Origine robuste : médiane des milieux de segments (insensible aux entités perdues très loin).
  const n = flat.segs.count;
  const xy = flat.segs.xy.subarray(0, n * 4);
  const step = Math.max(1, Math.floor(n / 20_000));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i += step) {
    xs.push((xy[i * 4]! + xy[i * 4 + 2]!) / 2);
    ys.push((xy[i * 4 + 1]! + xy[i * 4 + 3]!) / 2);
  }
  if (n === 0) {
    for (const t of flat.texts) {
      xs.push(t.cx);
      ys.push(t.cy);
    }
  }
  const origin = { x: Math.round(median(xs)), y: Math.round(median(ys)) };
  for (let i = 0; i < n * 4; i += 2) {
    xy[i] = xy[i]! - origin.x;
    xy[i + 1] = xy[i + 1]! - origin.y;
  }
  for (const a of flat.arcs) {
    a.cx -= origin.x;
    a.cy -= origin.y;
  }
  for (const t of flat.texts) {
    t.cx -= origin.x;
    t.cy -= origin.y;
    for (const l of t.lines) {
      l.x -= origin.x;
      l.y -= origin.y;
    }
  }
  for (const ins of flat.inserts) {
    ins.x -= origin.x;
    ins.y -= origin.y;
  }

  return {
    version: doc.header?.versionString ?? '',
    insUnits: Number(doc.header?.insUnits ?? 0) || 0,
    layers: flat.layers,
    segCount: n,
    segXY: xy,
    segLayer: flat.segs.layer.subarray(0, n),
    segKind: flat.segs.kind.subarray(0, n),
    segInsert: flat.segs.insert.subarray(0, n),
    arcs: flat.arcs,
    texts: flat.texts,
    inserts: flat.inserts,
    origin,
    stats: {
      entities: flat.entities,
      hiddenLayerEntities: flat.hiddenLayerEntities,
      unsupported: flat.unsupported,
      truncated: flat.truncated,
      missingXrefs: [...flat.missingXrefs],
      readerNotes,
    },
  };
}
