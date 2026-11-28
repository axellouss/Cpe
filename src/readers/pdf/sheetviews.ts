/**
 * Découpage d'une PLANCHE en vues : plans d'étage, plan de toiture, coupes, façades, plan de situation, tableau des
 * surfaces, cartouche, photo, légende, flèche du nord. Analyse pure (aucune dépendance à pdf.js) sur la page extraite
 * (raw.ts). Repère : points PDF, y vers le bas.
 *
 * Signaux, tous formulés par leur STRUCTURE (jamais par une couleur ou une coordonnée d'une planche précise) :
 *  1. corps courant = médiane des corps des textes horizontaux ;
 *  2. titres = textes nettement plus gros que le corps courant (≥ 1,6 ×), ou modérément plus gros (≥ 1,15 ×) s'ils
 *     portent le vocabulaire des vues (FR / DE), recollés avec leurs morceaux de ligne (exposant « 1 » + « ER ») ;
 *  3. blocs de contenu = fenêtres de découpe qui portent beaucoup de dessin, images, composantes d'encre regroupées
 *     (dessin + chaînes de cotes), paquets de texte (légendes, tableaux), cartouche ;
 *  4. association titre ↔ bloc (dessous, dessus, côté, dedans), la convention majoritaire de la page l'emportant ;
 *  5. genre d'après le titre ET d'après le contenu (surfaces de pièces, cotes de niveau, grille de tableau) : la
 *     confiance vient de leur accord (0,9), d'un seul des deux (0,7 titre, 0,5 contenu), ou de leur désaccord (0,4).
 *
 * Un trait peint sous une zone de découpe mais hors de sa boîte est invisible (cadre de situation répété sous chaque
 * vue) : il n'est compté nulle part. Seuils repris du prototype mesuré sur une vraie planche d'autorisation.
 */
import type { BBox, Lang } from '../../core/types';
import type { ElevationSide, ReadView, ViewKind } from '../../core/reading';
import { fold, guessStorey, isRoofLevelName } from '../../semantics/labels';
import { buildingFootprints } from './building';
import type { BuildingFootprint } from './building';
import { msg } from './messages';
import type { RawPage, RawSeg, RawText } from './raw';
import { isTitleBlockText } from './titleblock';

// ───────────────────────────── Boîtes ─────────────────────────────

export const W = (b: BBox): number => b.maxX - b.minX;
export const H = (b: BBox): number => b.maxY - b.minY;
export const boxArea = (b: BBox): number => Math.max(0, W(b)) * Math.max(0, H(b));
export const inBox = (b: BBox, x: number, y: number, pad = 0): boolean => x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
export const containsBox = (o: BBox, i: BBox, pad = 0): boolean => i.minX >= o.minX - pad && i.maxX <= o.maxX + pad && i.minY >= o.minY - pad && i.maxY <= o.maxY + pad;
export const overlapArea = (a: BBox, b: BBox): number =>
  Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
export const unionBox = (a: BBox, b: BBox): BBox => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) });
export const textBox = (t: RawText): BBox => ({ minX: t.x0, minY: t.y0, maxX: t.x1, maxY: t.y1 });
export const segBox = (s: RawSeg): BBox => ({ minX: Math.min(s.x0, s.x1), minY: Math.min(s.y0, s.y1), maxX: Math.max(s.x0, s.x1), maxY: Math.max(s.y0, s.y1) });
export const median = (a: readonly number[]): number => (a.length ? [...a].sort((p, q) => p - q)[a.length >> 1]! : 0);

// ───────────────────────────── Visibilité (zones de découpe) ─────────────────────────────

/**
 * Boîte VISIBLE de chaque zone de découpe : intersection de sa boîte et de celles de ses zones englobantes. Indice =
 * identifiant de zone (RawSeg.clip, FillArea.clip). Une zone vide a une boîte d'aire nulle ou négative.
 */
export function visibleClipBoxes(page: RawPage): BBox[] {
  const out: BBox[] = [];
  const pageBox: BBox = { minX: 0, minY: 0, maxX: page.width, maxY: page.height };
  for (let i = 0; i < page.clips.length; i++) {
    const c = page.clips[i]!;
    const parent = c.parent >= 0 && c.parent < i ? out[c.parent]! : pageBox;
    out.push({ minX: Math.max(parent.minX, c.bbox.minX), minY: Math.max(parent.minY, c.bbox.minY), maxX: Math.min(parent.maxX, c.bbox.maxX), maxY: Math.min(parent.maxY, c.bbox.maxY) });
  }
  return out;
}

/** Tolérance de visibilité (pt) : un trait qui affleure le bord de sa découpe reste visible. */
const VISIBLE_TOL = 0.5;

/** Vrai si une boîte peinte sous la zone `clip` en touche la partie visible. */
export function isVisible(clips: readonly BBox[], clip: number | undefined, b: BBox): boolean {
  if (!clip) return true;
  const c = clips[clip];
  if (!c) return true;
  return b.maxX >= c.minX - VISIBLE_TOL && b.minX <= c.maxX + VISIBLE_TOL && b.maxY >= c.minY - VISIBLE_TOL && b.minY <= c.maxY + VISIBLE_TOL;
}

/** Page dont les traits, remplissages et hachures invisibles (hors de leur découpe) sont retirés. */
export function visiblePage(page: RawPage): RawPage {
  if (page.clips.length <= 1) return page;
  const clips = visibleClipBoxes(page);
  const segs = page.segs.filter((s) => isVisible(clips, s.clip, segBox(s)));
  const fills = page.fills.filter((f) => isVisible(clips, f.clip, f.bbox));
  const hatches = page.hatches.filter((h) => isVisible(clips, h.clip, h.bbox));
  const stipples = page.stipples.filter((s) => isVisible(clips, s.clip, s.bbox));
  if (segs.length === page.segs.length && fills.length === page.fills.length && hatches.length === page.hatches.length && stipples.length === page.stipples.length) return page;
  return { ...page, segs, fills, hatches, stipples };
}

// ───────────────────────────── Vocabulaire des titres (FR / DE / EN, texte replié) ─────────────────────────────

const RE = {
  section: /\b(coupe|coupes|schnitt|querschnitt|langsschnitt|section)\b/,
  elevation: /\b(facade|facades|fassade|ansicht|ansichten|elevation|vue (?:nord|sud|est|ouest|de face|laterale|arriere|avant)|pignon)\b|(nord|sud|ost|west|strassen|garten|seiten|vorder|ruck)ansicht/,
  site: /\b(plan de situation|situation|plan d'implantation|implantation|plan de masse|lageplan|ubersichtsplan|katasterplan|plan cadastral|site plan)\b/,
  roof: /\b(toiture|toitures|plan de toit|dachaufsicht|dachdraufsicht|dachplan|dachebene|roof plan)\b/,
  plan: /\b(plan|grundriss|niveau|ebene|geschoss|floor plan)\b/,
  table: /\b(calculs?|tableau|surfaces|flachen(?:berechnung)?|berechnung|tabelle|legende des surfaces|wohnflache|bilan)\b/,
  photo: /\b(photo|photos|foto|luftbild|perspective|perspectives|vue 3d|visuels?|visualisierung|rendering|3d)\b/,
  legend: /\b(legende|legend|zeichenerklarung|notes?|remarques?|hinweise?|anmerkungen)\b/,
};

/** Genre de vue annoncé par un titre (texte replié) ; null s'il n'en annonce aucun. */
export function titleKind(f: string): ViewKind | null {
  // La coupe ou la façade l'emporte sur « plan » (« plan de coupe ») ; la toiture et la situation avant l'étage.
  if (RE.section.test(f)) return 'section';
  if (RE.elevation.test(f)) return 'elevation';
  if (RE.site.test(f)) return 'site-plan';
  if (RE.roof.test(f) || (RE.plan.test(f) && isRoofLevelName(f))) return 'roof-plan';
  if (guessStorey(f) !== null) return 'floor-plan';
  if (RE.photo.test(f)) return 'photo';
  if (RE.table.test(f)) return 'table';
  if (RE.legend.test(f)) return 'legend';
  if (RE.plan.test(f)) return 'floor-plan';
  return null;
}

/** Côtés d'une façade nommés dans son titre (texte replié). */
export function elevationSide(f: string): ElevationSide[] {
  const out: ElevationSide[] = [];
  if (/\b(avant|principale|rue|entree|vorder|strassen|front)\b|vorderansicht|strassenansicht/.test(f)) out.push('front');
  if (/\b(arriere|jardin|ruck|garten|back|rear)\b|ruckansicht|gartenansicht/.test(f)) out.push('back');
  if (/\b(laterale|lateral|seiten|side)\b|seitenansicht/.test(f)) out.push('side');
  if (/\b(gauche|links|left)\b/.test(f)) out.push('left');
  if (/\b(droite|rechts|right)\b/.test(f)) out.push('right');
  if (/\b(nord|north)\b|nordansicht|nordfassade/.test(f)) out.push('north');
  if (/\b(sud|south)\b|sudansicht|sudfassade/.test(f)) out.push('south');
  if (/\b(est|east|ost)\b|ostansicht|ostfassade/.test(f)) out.push('east');
  if (/\b(ouest|west)\b|westansicht|westfassade/.test(f)) out.push('west');
  return out;
}

// ───────────────────────────── Titres ─────────────────────────────

export interface SheetTitle {
  text: string;
  box: BBox;
  size: number;
  /** Nombre de morceaux recollés. */
  parts: number;
}

/** Corps du texte courant : médiane des corps des textes horizontaux (8 pt sans texte). */
export function bodySize(texts: readonly RawText[]): number {
  return median(texts.filter((t) => Math.abs(t.angle) < 1).map((t) => t.size)) || 8;
}

/** Un titre ne finit pas par « : » (« Composition toiture : ») et tient en six mots au plus. */
const shortTitle = (s: string): boolean => s.trim().split(/\s+/).length <= 6 && !/:\s*$/.test(s);

/**
 * Titres de la page : textes horizontaux nettement plus gros que le texte courant (≥ 1,6 ×), ou modérément plus gros
 * (≥ 1,15 ×) s'ils portent le vocabulaire des vues, recollés avec leurs voisins de ligne (morceaux, exposants).
 */
export function titleLines(texts: readonly RawText[], body: number): SheetTitle[] {
  const horiz = texts.map((t, i) => ({ t, i })).filter((x) => Math.abs(x.t.angle) < 1 && x.t.s.trim().length > 0);
  const used = new Set<number>();
  const out: SheetTitle[] = [];
  const vocab = (t: RawText): boolean => t.size >= 1.15 * body && titleKind(fold(t.s)) !== null && shortTitle(t.s);
  const seeds = horiz.filter((x) => x.t.size >= 1.6 * body || vocab(x.t)).sort((a, b) => b.t.size - a.t.size || a.t.x0 - b.t.x0);
  for (const seed of seeds) {
    if (used.has(seed.i)) continue;
    used.add(seed.i);
    const parts = [seed.t];
    let box = textBox(seed.t);
    const size = seed.t.size;
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of horiz) {
        if (used.has(x.i) || x.t.size < 0.5 * size || x.t.size > 1.6 * size) continue;
        const vo = Math.min(box.maxY, x.t.y1) - Math.max(box.minY, x.t.y0);
        if (vo < 0.4 * Math.min(H(box), x.t.y1 - x.t.y0)) continue;
        const gap = x.t.x0 - box.maxX;
        const gapL = box.minX - x.t.x1;
        if ((gap >= -0.2 * size && gap <= 0.8 * size) || (gapL >= -0.2 * size && gapL <= 0.8 * size)) {
          used.add(x.i);
          parts.push(x.t);
          box = unionBox(box, textBox(x.t));
          grew = true;
        }
      }
    }
    parts.sort((a, b) => a.x0 - b.x0);
    let text = '';
    const sup = (x: RawText): boolean => x.size < 0.8 * size;
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k]!;
      const prev = parts[k - 1];
      // Exposant (« 1 » + « ER ») collé au mot d'avant ; le mot qui SUIT un exposant en est séparé dès un petit blanc
      // (« ER » + « ÉTAGE ») : l'écart typographique après un exposant est plus court qu'une espace normale.
      if (k > 0 && prev) {
        const gap = p.x0 - prev.x1;
        text += sup(p) ? '' : sup(prev) ? (gap > 0.05 * size ? ' ' : '') : gap < 0.25 * size ? '' : ' ';
      }
      text += p.s.trim();
    }
    out.push({ text, box, size, parts: parts.length });
  }
  return out;
}

// ───────────────────────────── Blocs de contenu ─────────────────────────────

export type BlockSource = 'clip-frame' | 'ink-block' | 'image' | 'text-cluster';

export interface Block {
  box: BBox;
  source: BlockSource;
  /** Paquet de texte en grille (tableau). */
  table?: boolean;
}

/**
 * Fenêtres de vue données par les découpes : la même boîte réappliquée à de nombreux éléments (≥ 5 fois, ≥ 20
 * opérations de peinture), ou une découpe rectangulaire unique qui porte beaucoup de dessin (≥ 200 opérations).
 */
export function clipFrames(page: RawPage): Block[] {
  const pageArea = page.width * page.height;
  const subtree = new Map<number, number>();
  for (let i = page.clips.length - 1; i >= 1; i--) {
    const c = page.clips[i]!;
    const n = (subtree.get(c.id) ?? 0) + c.ops;
    subtree.set(c.id, n);
    if (c.parent >= 0) subtree.set(c.parent, (subtree.get(c.parent) ?? 0) + n);
  }
  interface Cand extends Block {
    ops: number;
    instances: number;
    rect: boolean;
  }
  const byBox = new Map<string, Cand>();
  const sheet: BBox = { minX: 0, minY: 0, maxX: page.width, maxY: page.height };
  for (const c of page.clips) {
    if (c.id === 0) continue;
    const a = boxArea(c.bbox);
    if (a < 0.003 * pageArea || a > 0.5 * pageArea) continue;
    // Une découpe qui déborde largement de la feuille est celle d'un motif, pas d'une vue.
    if (overlapArea(c.bbox, sheet) < 0.9 * a) continue;
    const key = [c.bbox.minX, c.bbox.minY, c.bbox.maxX, c.bbox.maxY].map((v) => Math.round(v / 2)).join(',');
    const prev = byBox.get(key);
    if (prev) {
      prev.ops += subtree.get(c.id) ?? 0;
      prev.instances++;
    } else byBox.set(key, { box: { ...c.bbox }, source: 'clip-frame', ops: subtree.get(c.id) ?? 0, instances: 1, rect: c.rect });
  }
  const all = [...byBox.values()];
  const strong = all.filter((c) => c.instances >= 5 && c.ops >= 20);
  const weak = all.filter((c) => c.instances < 5 && c.rect && c.ops >= 200 && !strong.some((o) => overlapArea(o.box, c.box) > 0 && !containsBox(o.box, c.box, 1)));
  // Cadre répété : une découpe rectangulaire de même taille (± 3 pt) qu'une fenêtre reconnue, alignée sur elle
  // (même haut ou même gauche), qui porte du dessin (≥ 20 opérations) — le plan de toiture dessiné dans le même cadre
  // de situation que les plans d'étage, avec bien moins d'éléments.
  const sure = [...strong, ...weak];
  const repeated = all.filter(
    (c) =>
      !sure.includes(c) &&
      c.rect &&
      c.ops >= 20 &&
      sure.some((o) => Math.abs(W(o.box) - W(c.box)) <= 3 && Math.abs(H(o.box) - H(c.box)) <= 3 && (Math.abs(o.box.minY - c.box.minY) <= 3 || Math.abs(o.box.minX - c.box.minX) <= 3) && overlapArea(o.box, c.box) === 0),
  );
  let frames: Cand[] = [...sure, ...repeated];
  // Une découpe contenue dans une autre en est un détail (hachure, pièce).
  frames = frames.filter((f) => !frames.some((o) => o !== f && containsBox(o.box, f.box, 1) && boxArea(o.box) > boxArea(f.box) * 1.05));
  const out: Block[] = [];
  for (const f of frames.sort((a, b) => boxArea(b.box) - boxArea(a.box))) if (!out.some((o) => overlapArea(o.box, f.box) > 0.5 * boxArea(f.box))) out.push({ box: f.box, source: 'clip-frame' });
  return out;
}

function isSheetFrameSeg(s: RawSeg, w: number, h: number): boolean {
  const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
  if (len <= 0.6 * Math.min(w, h)) return false;
  return Math.min(s.x0, s.x1) < 0.06 * w || Math.max(s.x0, s.x1) > 0.94 * w || Math.min(s.y0, s.y1) < 0.06 * h || Math.max(s.y0, s.y1) > 0.94 * h;
}

/**
 * Composantes connexes d'encre (traits, zones hachurées ou tramées) sur une grille de `cell` pt, hors des fenêtres
 * `exclude` (élargies de 3 % : leurs cotes et niveaux débordent). Le cadre de la feuille n'en fait pas partie.
 */
export function inkBlocks(page: RawPage, exclude: readonly BBox[], cell = 6, minSide = 40): Block[] {
  const nx = Math.ceil(page.width / cell) + 2;
  const ny = Math.ceil(page.height / cell) + 2;
  const grid = new Uint8Array(nx * ny);
  const pads = exclude.map((b) => Math.max(4, 0.03 * Math.max(W(b), H(b))));
  const excluded = (x: number, y: number): boolean => exclude.some((b, i) => inBox(b, x, y, pads[i]!));
  const mark = (x: number, y: number): void => {
    const ix = Math.floor(x / cell);
    const iy = Math.floor(y / cell);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return;
    const k = iy * nx + ix;
    if (grid[k]) return;
    if (!excluded(x, y)) grid[k] = 1;
  };
  const longLimit = 0.6 * Math.min(page.width, page.height);
  for (const s of page.segs) {
    if (isSheetFrameSeg(s, page.width, page.height)) continue;
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    if (len > longLimit) continue;
    const steps = Math.max(1, Math.ceil(len / (cell / 2)));
    for (let k = 0; k <= steps; k++) mark(s.x0 + ((s.x1 - s.x0) * k) / steps, s.y0 + ((s.y1 - s.y0) * k) / steps);
  }
  const fillBox = (b: BBox): void => {
    if (boxArea(b) > 0.25 * page.width * page.height) return;
    for (let x = b.minX; x <= b.maxX; x += cell / 2) for (let y = b.minY; y <= b.maxY; y += cell / 2) mark(x, y);
  };
  for (const h of page.hatches) fillBox(h.bbox);
  for (const s of page.stipples) fillBox(s.bbox);
  // Composantes 8-connexes.
  const label = new Int32Array(nx * ny).fill(-1);
  const boxes: BBox[] = [];
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i] || label[i]! >= 0) continue;
    const id = boxes.length;
    const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const stack = [i];
    label[i] = id;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % nx;
      const y = (j / nx) | 0;
      if (x * cell < b.minX) b.minX = x * cell;
      if ((x + 1) * cell > b.maxX) b.maxX = (x + 1) * cell;
      if (y * cell < b.minY) b.minY = y * cell;
      if ((y + 1) * cell > b.maxY) b.maxY = (y + 1) * cell;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
          const k = yy * nx + xx;
          if (grid[k] && label[k]! < 0) {
            label[k] = id;
            stack.push(k);
          }
        }
    }
    boxes.push(b);
  }
  return boxes.filter((b) => Math.max(W(b), H(b)) >= minSide && boxArea(b) < 0.8 * page.width * page.height).map((box) => ({ box, source: 'ink-block' as const }));
}

/**
 * Regroupe les composantes d'encre d'une même vue, jusqu'à stabilité : B contenu dans A (à 2 pt près) ; ou B mince
 * (petit côté ≤ max(30 pt, 0,15 × grand côté)), à moins de max(4 corps, 8 % du grand côté de A), recouvrant A sur
 * ≥ 50 % de sa longueur (chaîne de cotes, trait de sol).
 */
export function mergeInk(blocks: readonly Block[], body: number): Block[] {
  const out = blocks.map((b) => ({ ...b, box: { ...b.box } }));
  for (let changed = true; changed; ) {
    changed = false;
    out.sort((a, b) => boxArea(b.box) - boxArea(a.box));
    outer: for (let i = 0; i < out.length; i++) {
      const A = out[i]!;
      for (let j = i + 1; j < out.length; j++) {
        const B = out[j]!;
        let merge = containsBox(A.box, B.box, 2);
        if (!merge) {
          const long = Math.max(W(B.box), H(B.box));
          const thin = Math.min(W(B.box), H(B.box)) <= Math.max(30, 0.15 * long);
          const gx = Math.max(0, Math.max(A.box.minX, B.box.minX) - Math.min(A.box.maxX, B.box.maxX));
          const gy = Math.max(0, Math.max(A.box.minY, B.box.minY) - Math.min(A.box.maxY, B.box.maxY));
          const reach = Math.max(4 * body, 0.08 * Math.max(W(A.box), H(A.box)));
          const horizontal = W(B.box) >= H(B.box);
          const ov = horizontal ? Math.min(A.box.maxX, B.box.maxX) - Math.max(A.box.minX, B.box.minX) : Math.min(A.box.maxY, B.box.maxY) - Math.max(A.box.minY, B.box.minY);
          merge = thin && Math.max(gx, gy) <= reach && ov >= 0.5 * long;
        }
        if (merge) {
          A.box = unionBox(A.box, B.box);
          out.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return out;
}

function rowsOf(g: readonly RawText[]): RawText[][] {
  const rows: RawText[][] = [];
  for (const t of [...g].sort((p, q) => p.cy - q.cy)) {
    const row = rows.find((r) => Math.abs(r[0]!.cy - t.cy) < 0.5 * t.size);
    if (row) row.push(t);
    else rows.push([t]);
  }
  return rows;
}

/**
 * Textes en tableau : ≥ 3 lignes (≤ 40), ≥ 60 % des lignes à ≥ 2 cellules, ≥ 50 % avec un chiffre, textes courts ;
 * ET des colonnes : ≥ 60 % des textes alignés (début ou fin à un corps près) sur au moins deux autres lignes. Des
 * étiquettes de pièces (nom + surface) n'alignent que deux lignes : pas un tableau.
 */
export function isTable(g: readonly RawText[]): boolean {
  if (g.length < 6) return false;
  const rows = rowsOf(g);
  const multi = rows.filter((r) => r.length >= 2).length;
  const numeric = rows.filter((r) => r.some((t) => /\d/.test(t.s))).length;
  const meanLen = g.reduce((n, t) => n + t.s.length, 0) / g.length;
  if (!(rows.length >= 3 && multi >= 0.6 * rows.length && numeric >= 0.5 * rows.length && rows.length <= 40 && meanLen <= 20)) return false;
  const rowOf = new Map<RawText, number>();
  rows.forEach((r, i) => r.forEach((t) => rowOf.set(t, i)));
  const aligned = g.filter((t) => {
    const others = new Set<number>();
    for (const u of g) if (rowOf.get(u) !== rowOf.get(t) && (Math.abs(u.x0 - t.x0) <= t.size || Math.abs(u.x1 - t.x1) <= t.size)) others.add(rowOf.get(u)!);
    return others.size >= 2;
  }).length;
  return aligned >= 0.6 * g.length;
}

/** Au-delà, le regroupement des textes libres (quadratique) se fait par cases d'une grille. */
const CLUSTER_GRID = 40;

/**
 * Paquets de texte hors fenêtres de vue : légendes, notes, TABLEAUX. Lien si l'écart horizontal ≤ 6 corps et
 * l'écart vertical ≤ 1,2 corps ; au moins 5 textes. Les titres (> 2,5 × le corps courant, ou ≥ 1,6 × s'ils portent le
 * vocabulaire des vues) n'en font pas partie : un titre écrit juste au-dessus d'un tableau reste le titre du tableau.
 */
export function textClusters(texts: readonly RawText[], frames: readonly BBox[], body: number): Block[] {
  const isTitle = (t: RawText): boolean => t.size >= 2.5 * body || (t.size >= 1.6 * body && shortTitle(t.s) && titleKind(fold(t.s)) !== null);
  const free = texts.filter((t) => Math.abs(t.angle) < 1 && !isTitle(t) && !frames.some((b) => inBox(b, t.cx, t.cy, 2)));
  const parent = free.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  // Grille : on ne compare que les textes de cases voisines (portée max ≈ 6 corps + longueur de texte).
  const cells = new Map<string, number[]>();
  free.forEach((t, i) => {
    const key = `${Math.floor(t.cx / (CLUSTER_GRID * body))},${Math.floor(t.cy / (CLUSTER_GRID * body))}`;
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  });
  free.forEach((a, i) => {
    const gx = Math.floor(a.cx / (CLUSTER_GRID * body));
    const gy = Math.floor(a.cy / (CLUSTER_GRID * body));
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of cells.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (j <= i) continue;
          const b = free[j]!;
          const s = Math.max(a.size, b.size);
          const ox = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
          const oy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
          if (ox <= 6 * s && oy <= 1.2 * s) parent[find(i)] = find(j);
        }
  });
  const groups = new Map<number, RawText[]>();
  free.forEach((t, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(t);
    else groups.set(r, [t]);
  });
  const out: Block[] = [];
  for (const g of groups.values()) {
    if (g.length < 5) continue;
    let b = textBox(g[0]!);
    for (const t of g) b = unionBox(b, textBox(t));
    out.push({ box: b, source: 'text-cluster', table: isTable(g) });
  }
  return out;
}

const NORTH_WORD_RE = /^(n|nord|north|norden)$/i;

/**
 * Flèche du nord : le mot « N / Nord » et, autour (4 corps + 20 pt), un petit dessin : des traits courbes, ou un
 * remplissage dont un anneau a ≥ 16 sommets (cercle déjà aplati en polygone), de boîte carrée, de 10 à 150 pt.
 */
export function northArrow(page: RawPage): BBox | null {
  let best: BBox | null = null;
  let bestScore = 7;
  for (const t of page.texts.filter((x) => NORTH_WORD_RE.test(x.s.trim()))) {
    const r = 4 * t.size + 20;
    const zone: BBox = { minX: t.cx - r, minY: t.cy - r, maxX: t.cx + r, maxY: t.cy + r };
    const near = page.segs.filter((s) => (s.stroke || s.fill) && inBox(zone, s.x0, s.y0) && inBox(zone, s.x1, s.y1));
    let score = near.filter((s) => s.curve).length;
    let b = textBox(t);
    for (const f of page.fills) {
      const w = W(f.bbox);
      const h = H(f.bbox);
      if (w < 10 || w > 150 || Math.abs(w - h) > 0.1 * w || !f.rings.some((ring) => ring.length >= 16)) continue;
      const d = Math.hypot((f.bbox.minX + f.bbox.maxX) / 2 - t.cx, (f.bbox.minY + f.bbox.maxY) / 2 - t.cy);
      if (d > 4 * (w / 2)) continue;
      score += 100;
      b = unionBox(b, f.bbox);
    }
    if (score <= bestScore) continue;
    for (const s of near) b = unionBox(b, segBox(s));
    best = b;
    bestScore = score;
  }
  return best;
}

// ───────────────────────────── Contenu d'un bloc ─────────────────────────────

const LEVEL_MARK_RE = /(?:^|[\s=])[+\-±−]\s?\d{1,3}[.,]\d{2,3}\b/;
/** Ligne de surface d'une pièce : « 12,40 m² », « 12.4 qm », « S: 27,40 ». */
export const AREA_RE = /\d+[.,]\d{1,2}\s*(?:m(?:²|2)?|qm)(?![a-z])|\bS\s*[:=]\s*\d/i;
const NUMBER_UNIT_RE = /\d+(?:[.,]\d+)?\s*(?:m²|m2|m|%)\b|\d+(?:[.,]\d+)?m$/;

interface Content {
  texts: RawText[];
  areas: number;
  levels: number;
  numberUnits: number;
}

function contentOf(page: RawPage, b: BBox): Content {
  const texts = page.texts.filter((t) => inBox(b, t.cx, t.cy));
  return {
    texts,
    areas: texts.filter((t) => AREA_RE.test(t.s)).length,
    levels: texts.filter((t) => LEVEL_MARK_RE.test(t.s)).length,
    numberUnits: texts.filter((t) => NUMBER_UNIT_RE.test(t.s.trim())).length,
  };
}

// ───────────────────────────── Cartouche ─────────────────────────────

/**
 * Cartouche : le bloc qui porte le plus de mots de cartouche (> 2), collé à un bord de la feuille (3 %) ou dense ;
 * ramené au paquet de textes relié (≤ 4 corps) à partir de ces mots, plus 2 corps de marge, sans dépasser le bloc ;
 * prolongé par bandes de 40 pt tant qu'une bande de sa largeur porte un mot de cartouche.
 */
export function findTitleBlock(page: RawPage, blocks: readonly Block[], body: number): BBox | null {
  const words = page.texts.filter((t) => isTitleBlockText(t.s));
  if (words.length < 3) return null;
  const frame: BBox = { minX: 0.03 * page.width, minY: 0.03 * page.height, maxX: 0.97 * page.width, maxY: 0.97 * page.height };
  let best: BBox | null = null;
  let bestN = 2;
  for (const b of blocks) {
    if (b.source === 'clip-frame' || b.source === 'image') continue;
    const n = words.filter((t) => inBox(b.box, t.cx, t.cy)).length;
    const atEdge = b.box.maxX >= frame.maxX || b.box.maxY >= frame.maxY || b.box.minX <= frame.minX || b.box.minY <= frame.minY;
    if (n > bestN && (atEdge || n / Math.max(1, boxArea(b.box)) > 1 / 20000)) {
      best = b.box;
      bestN = n;
    }
  }
  if (!best) return null;
  const outer: BBox = best;
  const inB = page.texts.filter((t) => inBox(outer, t.cx, t.cy));
  const seed = inB.filter((t) => isTitleBlockText(t.s));
  const taken = new Set(seed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of inB) {
      if (taken.has(t)) continue;
      for (const u of taken) {
        if (Math.max(0, Math.max(t.x0, u.x0) - Math.min(t.x1, u.x1)) <= 4 * body && Math.max(0, Math.max(t.y0, u.y0) - Math.min(t.y1, u.y1)) <= 4 * body) {
          taken.add(t);
          grew = true;
          break;
        }
      }
    }
  }
  let tb = textBox(seed[0]!);
  for (const t of taken) tb = unionBox(tb, textBox(t));
  const m = 2 * body;
  const box: BBox = { minX: Math.max(outer.minX, tb.minX - m), minY: Math.max(outer.minY, tb.minY - m), maxX: Math.min(outer.maxX, tb.maxX + m), maxY: Math.min(outer.maxY, tb.maxY + m) };
  for (let k = 0; k < 12; k++) {
    let grew = false;
    for (const up of [true, false]) {
      const band = page.texts.filter((t) => t.cx >= box.minX && t.cx <= box.maxX && (up ? t.cy < box.minY && t.cy >= box.minY - 40 : t.cy > box.maxY && t.cy <= box.maxY + 40));
      if (!band.some((t) => isTitleBlockText(t.s))) continue;
      for (const t of band) {
        box.minY = Math.min(box.minY, t.y0);
        box.maxY = Math.max(box.maxY, t.y1);
      }
      grew = true;
    }
    if (!grew) break;
  }
  extendToFrame(page, box, outer, body);
  return box;
}

/**
 * Cadre tracé autour du cartouche : un trait vertical posé sur un bord de la boîte (à 3 corps près) et qui la
 * traverse sur au moins la moitié de sa hauteur en donne la vraie hauteur ; de même un trait horizontal pour la
 * largeur. Sans cela, un logo ou des cases vides en bas du cartouche (loin des mots) restent dehors. Borné au bloc
 * d'origine ; le cadre de la feuille n'en est jamais un.
 */
function extendToFrame(page: RawPage, box: BBox, outer: BBox, body: number): void {
  const tol = 3 * body;
  const segs = page.segs.filter((s) => !isSheetFrameSeg(s, page.width, page.height));
  for (let k = 0; k < 3; k++) {
    let grew = false;
    for (const s of segs) {
      const vertical = Math.abs(s.x1 - s.x0) < 0.5 && Math.abs(s.y1 - s.y0) > 0;
      const horizontal = Math.abs(s.y1 - s.y0) < 0.5 && Math.abs(s.x1 - s.x0) > 0;
      if (vertical) {
        const x = s.x0;
        const y0 = Math.max(outer.minY, Math.min(s.y0, s.y1));
        const y1 = Math.min(outer.maxY, Math.max(s.y0, s.y1));
        const onEdge = Math.abs(x - box.minX) <= tol || Math.abs(x - box.maxX) <= tol;
        const across = Math.min(y1, box.maxY) - Math.max(y0, box.minY) >= 0.5 * (box.maxY - box.minY);
        if (!onEdge || !across || x < outer.minX - 1 || x > outer.maxX + 1) continue;
        if (y0 < box.minY - 0.5 || y1 > box.maxY + 0.5) {
          box.minY = Math.min(box.minY, y0);
          box.maxY = Math.max(box.maxY, y1);
          grew = true;
        }
        if (x < box.minX - 0.5 || x > box.maxX + 0.5) {
          box.minX = Math.min(box.minX, x);
          box.maxX = Math.max(box.maxX, x);
          grew = true;
        }
      } else if (horizontal) {
        const y = s.y0;
        const x0 = Math.max(outer.minX, Math.min(s.x0, s.x1));
        const x1 = Math.min(outer.maxX, Math.max(s.x0, s.x1));
        const onEdge = Math.abs(y - box.minY) <= tol || Math.abs(y - box.maxY) <= tol;
        const across = Math.min(x1, box.maxX) - Math.max(x0, box.minX) >= 0.5 * (box.maxX - box.minX);
        if (!onEdge || !across || y < outer.minY - 1 || y > outer.maxY + 1) continue;
        if (x0 < box.minX - 0.5 || x1 > box.maxX + 0.5) {
          box.minX = Math.min(box.minX, x0);
          box.maxX = Math.max(box.maxX, x1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
}

// ───────────────────────────── Association titre ↔ bloc ─────────────────────────────

export type TitlePlace = 'below' | 'above' | 'side' | 'inside';

export interface TitlePair {
  t: number;
  b: number;
  cost: number;
  at: TitlePlace;
}

function relations(t: SheetTitle, b: BBox): { cost: number; at: TitlePlace }[] {
  const s = t.size;
  const out: { cost: number; at: TitlePlace }[] = [];
  const w = W(b);
  const reach = Math.max(6 * s, 0.15 * H(b));
  const xOk = t.box.minX >= b.minX - 3 * s && t.box.minX <= b.maxX - 0.1 * w && t.box.maxX <= b.maxX + 0.5 * w;
  const align = Math.min(Math.abs(t.box.minX - b.minX) / Math.max(w, 1), Math.abs((t.box.minX + t.box.maxX) / 2 - (b.minX + b.maxX) / 2) / Math.max(w, 1));
  const below = t.box.minY - b.maxY;
  if (xOk && below >= -0.5 * s && below <= reach) out.push({ cost: Math.max(0, below) / s + 3 * align, at: 'below' });
  const above = b.minY - t.box.maxY;
  if (xOk && above >= -0.5 * s && above <= reach) out.push({ cost: Math.max(0, above) / s + 3 * align, at: 'above' });
  const side = t.box.minX - b.maxX;
  if (side >= 0 && side <= 4 * s && Math.abs(t.box.maxY - b.maxY) <= 2.5 * s) out.push({ cost: 2 + side / s, at: 'side' });
  if (containsBox(b, t.box, 1) && (t.box.minY >= b.maxY - 0.15 * H(b) || t.box.maxY <= b.minY + 0.15 * H(b))) out.push({ cost: 1.5 + 3 * align, at: 'inside' });
  return out;
}

/**
 * Associe titres et blocs : coût = distance en corps + 3 × désalignement ; la convention majoritaire de la page
 * (dessous ou dessus) rend l'autre plus chère de 1,5 ; affectation gloutonne, un titre par bloc.
 */
export function matchTitlesToBlocks(titles: readonly SheetTitle[], blocks: readonly BBox[]): TitlePair[] {
  const all: TitlePair[] = [];
  titles.forEach((t, i) => blocks.forEach((b, j) => relations(t, b).forEach((r) => all.push({ ...r, t: i, b: j }))));
  const bestOf = new Map<number, TitlePair>();
  for (const p of all) if (!bestOf.has(p.t) || bestOf.get(p.t)!.cost > p.cost) bestOf.set(p.t, p);
  const nBelow = [...bestOf.values()].filter((p) => p.at === 'below').length;
  const nAbove = [...bestOf.values()].filter((p) => p.at === 'above').length;
  const dominant = nBelow >= nAbove ? 'below' : 'above';
  for (const p of all) if ((p.at === 'below' || p.at === 'above') && p.at !== dominant) p.cost += 1.5;
  all.sort((a, b) => a.cost - b.cost);
  const takenT = new Set<number>();
  const takenB = new Set<number>();
  const out: TitlePair[] = [];
  for (const p of all) {
    if (takenT.has(p.t) || takenB.has(p.b)) continue;
    takenT.add(p.t);
    takenB.add(p.b);
    out.push(p);
  }
  return out;
}

// ───────────────────────────── Bloc qui porte plusieurs titres ─────────────────────────────

/** Points d'encre d'un bloc (traits échantillonnés tous les 3 pt, emprises des hachures et trames). */
function inkPoints(page: RawPage, b: BBox): { x: number; y: number; spanX: number; spanY: number }[] {
  const out: { x: number; y: number; spanX: number; spanY: number }[] = [];
  for (const s of page.segs) {
    const mx = (s.x0 + s.x1) / 2;
    const my = (s.y0 + s.y1) / 2;
    if (!inBox(b, mx, my)) continue;
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const steps = Math.max(1, Math.ceil(len / 3));
    const spanX = Math.abs(s.x1 - s.x0);
    const spanY = Math.abs(s.y1 - s.y0);
    for (let k = 0; k <= steps; k++) {
      const x = s.x0 + ((s.x1 - s.x0) * k) / steps;
      const y = s.y0 + ((s.y1 - s.y0) * k) / steps;
      if (inBox(b, x, y)) out.push({ x, y, spanX, spanY });
    }
  }
  for (const z of [...page.hatches, ...page.stipples]) {
    if (!containsBox(b, z.bbox, 2)) continue;
    for (let x = z.bbox.minX; x <= z.bbox.maxX; x += 3) for (let y = z.bbox.minY; y <= z.bbox.maxY; y += 3) out.push({ x, y, spanX: W(z.bbox), spanY: H(z.bbox) });
  }
  return out;
}

/**
 * Coupe un bloc d'encre qui porte plusieurs titres (deux façades reliées par la ligne de sol, deux vues dont les
 * cotes se touchent) : le long de la colonne (ou de la ligne) la moins encrée entre deux titres voisins, les traits
 * qui traversent plus de la moitié du bloc (ligne de sol, axe) ne comptant pas. La coupe n'est faite que si cette
 * colonne est presque vide (≤ 10 % de la plus encrée) ; chaque part est ramenée à son encre.
 */
export function cutBlock(page: RawPage, b: BBox, titles: readonly SheetTitle[]): BBox[] | null {
  if (titles.length < 2) return null;
  const pts = inkPoints(page, b);
  if (pts.length === 0) return null;
  const cell = 3;
  const tryAxis = (axis: 'x' | 'y'): BBox[] | null => {
    const lo = axis === 'x' ? b.minX : b.minY;
    const len = axis === 'x' ? W(b) : H(b);
    const n = Math.max(1, Math.ceil(len / cell));
    const prof = new Float64Array(n);
    for (const p of pts) {
      if ((axis === 'x' ? p.spanX : p.spanY) > 0.5 * len) continue;
      const k = Math.min(n - 1, Math.max(0, Math.floor(((axis === 'x' ? p.x : p.y) - lo) / cell)));
      prof[k]!++;
    }
    let peak = 0;
    for (const v of prof) if (v > peak) peak = v;
    if (peak === 0) return null;
    const centre = (t: SheetTitle): number => (axis === 'x' ? (t.box.minX + t.box.maxX) / 2 : (t.box.minY + t.box.maxY) / 2);
    const sorted = [...titles].sort((p, q) => centre(p) - centre(q));
    // Les titres doivent se suivre sans se chevaucher sur cet axe.
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const c = sorted[i]!;
      if ((axis === 'x' ? c.box.minX - a.box.maxX : c.box.minY - a.box.maxY) <= 0) return null;
    }
    const cuts: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const from = Math.max(0, Math.floor((centre(sorted[i - 1]!) - lo) / cell));
      const to = Math.min(n - 1, Math.ceil((centre(sorted[i]!) - lo) / cell));
      let best = -1;
      let bestV = Infinity;
      // Colonne la moins encrée ; à égalité, la plus au milieu de la plus longue suite de colonnes aussi vides.
      for (let k = from + 1; k < to; k++) {
        const v = prof[k]!;
        if (v < bestV) {
          bestV = v;
          best = k;
        }
      }
      if (best < 0 || bestV > 0.1 * peak) return null;
      let a = best;
      let c = best;
      while (a - 1 > from && prof[a - 1]! <= bestV) a--;
      while (c + 1 < to && prof[c + 1]! <= bestV) c++;
      cuts.push(lo + (((a + c) / 2 + 0.5) * cell));
    }
    const bounds = [lo, ...cuts, lo + len];
    const parts: BBox[] = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const p0 = bounds[i]!;
      const p1 = bounds[i + 1]!;
      let box: BBox | null = null;
      for (const p of pts) {
        const v = axis === 'x' ? p.x : p.y;
        if (v < p0 || v > p1) continue;
        const pb: BBox = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
        box = box ? unionBox(box, pb) : pb;
      }
      if (!box || Math.max(W(box), H(box)) < 20) return null;
      parts.push(box);
    }
    return parts;
  };
  return tryAxis('x') ?? tryAxis('y');
}

// ───────────────────────────── Découpage ─────────────────────────────

/** Vue trouvée, avec ce qui ne figure pas dans le contrat ReadView (titre détaillé, place du titre). */
export interface SheetView {
  kind: ViewKind;
  title: SheetTitle | null;
  titleAt: TitlePlace | null;
  storeyRank: number | null;
  sides: ElevationSide[] | null;
  box: BBox;
  confidence: number;
  sources: string[];
  doubts: string[];
}

export interface SheetSplit {
  /** Vues au format du contrat (sheetId vide : c'est l'analyse qui crée les feuilles). */
  views: ReadView[];
  /** Mêmes vues, même ordre, avec leurs détails. */
  details: SheetView[];
  /** Emprise du bâtiment par identifiant de vue (plans et toiture), avec ses dimensions recoupées. */
  footprints: Map<string, BuildingFootprint>;
  body: number;
  titles: SheetTitle[];
  titleBlock: BBox | null;
  /** Titres de niveau qu'aucun bloc n'a pris (vue manquée, ou titre de page). */
  orphanTitles: SheetTitle[];
  log: string[];
}

export interface SplitOptions {
  /** Dénominateur d'échelle de la page, s'il est connu (sert aux seuils en mètres de l'emprise). */
  den: number | null;
  lang: Lang;
}

/** Genres de vues dessinées : un bloc titré ainsi n'est jamais un tableau. */
const DRAWN_TITLE_KINDS = new Set<ViewKind>(['floor-plan', 'roof-plan', 'section', 'elevation', 'site-plan']);

/**
 * Étiquettes posées dans un dessin : la boîte des textes (hors titres, plus gros que le corps courant) couvre moins
 * de la moitié du bloc ; un tableau, lui, remplit son cadre.
 */
function labelsInDrawing(texts: readonly RawText[], box: BBox): boolean {
  const body = bodySize(texts);
  const small = texts.filter((t) => t.size <= 1.5 * body);
  if (small.length === 0) return false;
  const tb: BBox = {
    minX: Math.min(...small.map((t) => t.x0)),
    minY: Math.min(...small.map((t) => t.y0)),
    maxX: Math.max(...small.map((t) => t.x1)),
    maxY: Math.max(...small.map((t) => t.y1)),
  };
  return boxArea(tb) < 0.5 * boxArea(box);
}

/** Ordre des genres dans la liste des vues. */
const KIND_ORDER: ViewKind[] = ['floor-plan', 'roof-plan', 'section', 'elevation', 'site-plan', 'table', 'title-block', 'photo', 'legend', 'north-arrow', 'other'];

/** Façade et coupe portent toutes deux des niveaux ; toiture et situation pas de pièces : genres compatibles. */
function compatible(a: ViewKind, x: ViewKind): boolean {
  return a === x || (a === 'elevation' && x === 'section') || (a === 'site-plan' && x === 'floor-plan') || (a === 'roof-plan' && x === 'section');
}

/**
 * Découpe une page en vues. Entrée : la page extraite (les éléments invisibles hors de leur découpe sont écartés
 * ici). Sortie : vues au format du contrat, dans l'ordre plans (par rang), toiture, coupes, façades, situation,
 * tableaux, cartouche, photos, légendes, nord, autres.
 */
export function splitSheet(input: RawPage, opts: SplitOptions): SheetSplit {
  const page = visiblePage(input);
  const lang = opts.lang;
  const log: string[] = [];
  const body = bodySize(page.texts);
  const mpp = ((opts.den ?? 100) * 0.0254) / 72;
  const pageArea = page.width * page.height;
  const frames = clipFrames(page);
  const images: Block[] = page.imageAreas.filter((im) => boxArea(im.bbox) >= 0.002 * pageArea && boxArea(im.bbox) < 0.8 * pageArea).map((im) => ({ box: { ...im.bbox }, source: 'image' as const }));
  const frameBoxes = [...frames, ...images].map((f) => f.box);
  // Encre hors fenêtres ; une composante qui recouvre une fenêtre en est un débord (cotes, titres) : écartée.
  let ink = inkBlocks(page, frameBoxes).filter((b) => !frameBoxes.some((f) => overlapArea(f, b.box) > 0.3 * boxArea(b.box)));
  const nInk = ink.length;
  // Cartouche cherché AVANT le regroupement : sinon un trait de sol ou une chaîne de cotes voisine l'agrandit.
  const tb0 = findTitleBlock(page, [...frames, ...images, ...ink], body);
  ink = mergeInk(
    ink.filter((b) => !(tb0 && containsBox(tb0, b.box, 2))),
    body,
  );
  if (tb0) ink.push({ box: tb0, source: 'ink-block' });
  let blocks: Block[] = [...frames, ...images, ...ink];
  const tb = findTitleBlock(page, blocks, body);
  const clusters = textClusters(page.texts, frameBoxes, body).filter((c) => !(tb && containsBox(tb, c.box, 2)));
  blocks.push(...clusters);
  const tableBoxes = clusters.filter((c) => c.table).map((c) => c.box);
  // Bloc d'encre qui englobe un tableau : le tableau le remplace (le reste n'est que débord des vues voisines).
  blocks = blocks.filter((b) => !(b.source === 'ink-block' && tableBoxes.some((t) => containsBox(b.box, t, 2))));
  const titlesAll = titleLines(page.texts, body);
  log.push(`corps ${body.toFixed(1)} | cadres ${frames.length} | images ${images.length} | encre ${nInk} → ${ink.length} | titres ${titlesAll.length} | cartouche ${tb ? 'oui' : 'non'}`);

  // Titre de vue : hors cartouche, du vocabulaire des vues, ou très gros (≥ 2,5 × le corps) sans chiffre.
  const tbCentre = (t: SheetTitle): boolean => !!tb && inBox(tb, (t.box.minX + t.box.maxX) / 2, (t.box.minY + t.box.maxY) / 2);
  const titles = titlesAll.filter((t) => !tbCentre(t) && (titleKind(fold(t.text)) !== null || (t.size >= 2.5 * body && !/\d/.test(t.text))));
  // Le bloc d'origine du cartouche disparaît ; un bloc réduit à un titre (titre souligné) n'est pas une vue.
  blocks = blocks.filter((b) => !(tb && (containsBox(tb, b.box, 2) || (b.source === 'ink-block' && overlapArea(tb, b.box) > 0.5 * boxArea(tb)))) && !titles.some((t) => containsBox(t.box, b.box, 2)));
  // Un bloc d'encre qui est le meilleur parti de plusieurs titres de vues dessinées est coupé entre eux.
  const drawn = (t: SheetTitle): boolean => {
    const k = titleKind(fold(t.text));
    return k === 'floor-plan' || k === 'roof-plan' || k === 'section' || k === 'elevation' || k === 'site-plan';
  };
  for (let it = 0; it < 8; it++) {
    const owner = titles.map((t) => {
      let best = -1;
      let cost = Infinity;
      blocks.forEach((b, j) => {
        for (const r of relations(t, b.box)) if (r.cost < cost) {
          cost = r.cost;
          best = j;
        }
      });
      return best;
    });
    let changed = false;
    for (let j = 0; j < blocks.length && !changed; j++) {
      const b = blocks[j]!;
      if (b.source !== 'ink-block') continue;
      const mine = titles.filter((t, i) => owner[i] === j && drawn(t));
      if (mine.length < 2) continue;
      const parts = cutBlock(page, b.box, mine);
      if (!parts) continue;
      log.push(`bloc coupé en ${parts.length} entre ${mine.map((t) => `« ${t.text} »`).join(', ')}`);
      blocks.splice(j, 1, ...parts.map((box) => ({ box, source: 'ink-block' as const })));
      changed = true;
    }
    if (!changed) break;
  }
  const pairs = matchTitlesToBlocks(
    titles,
    blocks.map((b) => b.box),
  ).filter((p) => !(p.at === 'inside' && blocks[p.b]!.source === 'text-cluster'));

  const views: SheetView[] = [];
  if (tb) views.push({ kind: 'title-block', title: null, titleAt: null, storeyRank: null, sides: null, box: tb, confidence: 0.8, sources: ['title-block-words', 'ink-block'], doubts: [] });
  blocks.forEach((b, j) => {
    const p = pairs.find((q) => q.b === j);
    const title = p ? titles[p.t]! : null;
    const f = title ? fold(title.text) : '';
    const tk = title ? titleKind(f) : null;
    const c = contentOf(page, b.box);
    let ck: ViewKind | null = null;
    if (b.source === 'image') ck = 'photo';
    else if (b.source === 'text-cluster') ck = b.table ? 'table' : 'legend';
    // Un bloc dont les textes forment une grille est un tableau, même s'il porte des surfaces ; sauf un bloc titré
    // comme une vue dessinée (plan, coupe, façade) ou dont les textes ne couvrent qu'une partie du dessin : ce sont
    // alors des étiquettes de pièces posées dans les murs, en grille par hasard.
    else if (b.source === 'ink-block' && c.texts.length >= 6 && c.areas >= 0.2 * c.texts.length && !(tk && DRAWN_TITLE_KINDS.has(tk)) && !labelsInDrawing(c.texts, b.box) && isTable(c.texts)) ck = 'table';
    else if (c.areas >= 2 && c.levels <= c.areas) ck = 'floor-plan';
    else if (c.levels >= 2 && c.areas === 0 && b.source !== 'ink-block') ck = 'section';
    else if (c.numberUnits >= 4 && c.texts.length <= 40 && Math.max(W(b.box), H(b.box)) < 0.3 * Math.max(page.width, page.height)) ck = 'table';
    else if (c.texts.some((t) => NORTH_WORD_RE.test(t.s.trim())) && Math.max(W(b.box), H(b.box)) < 0.06 * Math.max(page.width, page.height)) ck = 'north-arrow';
    const sources: string[] = [b.source];
    if (title) sources.push('title');
    const kind: ViewKind = tk ?? ck ?? 'other';
    let confidence = 0.3;
    const doubts: string[] = [];
    if (tk && ck) {
      if (compatible(tk, ck)) {
        confidence = 0.9;
        sources.push(ck === 'floor-plan' ? 'content-rooms' : ck === 'section' ? 'content-levels' : `content-${ck}`);
      } else {
        confidence = 0.4;
        doubts.push(msg(lang, 'pdf.view.doubt.mismatch', { title: title!.text, kind: msg(lang, `pdf.view.kind.${ck}`) }));
      }
    } else if (tk) confidence = 0.7;
    else if (ck) {
      confidence = ck === 'photo' || ck === 'legend' ? 0.6 : 0.5;
      if (ck === 'floor-plan') doubts.push(msg(lang, 'pdf.view.doubt.untitledPlan'));
    }
    if (!tk && !ck && boxArea(b.box) < 0.004 * pageArea) return; // petit dessin isolé sans titre : ignoré
    // Bloc d'encre sans titre ni contenu propre : débord d'annotations des vues voisines ; sauf un grand bloc
    // (≥ 1 % de la page) qui ne touche aucun autre bloc : une vue sans titre (façade non titrée), avec un doute.
    if (!title && b.source === 'ink-block' && ck === null) {
      const lone = boxArea(b.box) >= 0.01 * pageArea && !blocks.some((o) => o !== b && overlapArea(o.box, b.box) > 0);
      if (lone) views.push({ kind: 'other', title: null, titleAt: null, storeyRank: null, sides: null, box: b.box, confidence: 0.3, sources: [b.source], doubts: [msg(lang, 'pdf.view.doubt.unknown')] });
      else log.push(`bloc d'encre sans titre ignoré : ${[b.box.minX, b.box.minY, b.box.maxX, b.box.maxY].map(Math.round).join(',')}`);
      return;
    }
    const storeyRank = kind === 'floor-plan' && title ? (guessStorey(title.text)?.rank ?? null) : null;
    if (kind === 'floor-plan' && storeyRank === null && title && tk === 'floor-plan') doubts.push(msg(lang, 'pdf.view.doubt.level', { title: title.text }));
    const sides = kind === 'elevation' && title ? elevationSide(f) : null;
    if (kind === 'elevation' && (!sides || sides.length === 0)) doubts.push(msg(lang, 'pdf.view.doubt.side'));
    views.push({ kind, title, titleAt: p?.at ?? null, storeyRank, sides: sides && sides.length > 0 ? sides : null, box: b.box, confidence, sources, doubts });
  });
  // Un paquet de texte (hors tableau) écrit DANS une vue titrée en est une annotation (composition, note) : pas une
  // légende à part.
  for (let i = views.length - 1; i >= 0; i--) {
    const v = views[i]!;
    if (v.kind === 'legend' && !v.title && views.some((o) => o !== v && o.title && o.kind !== 'legend' && o.kind !== 'table' && containsBox(o.box, v.box, 2))) views.splice(i, 1);
  }
  const north = northArrow(page);
  if (north && !views.some((v) => v.kind === 'north-arrow' && overlapArea(v.box, north) > 0)) views.push({ kind: 'north-arrow', title: null, titleAt: null, storeyRank: null, sides: null, box: north, confidence: 0.8, sources: ['north-word', 'north-symbol'], doubts: [] });

  // Titres orphelins ; un seul plan sans titre et un seul rang de niveau libre hors de tout bloc : il lui revient.
  const orphans = titles.filter((_, i) => !pairs.some((p) => p.t === i));
  for (const t of orphans) log.push(`titre sans bloc : « ${t.text} » (${titleKind(fold(t.text)) ?? '?'})`);
  const untitledPlans = views.filter((v) => v.kind === 'floor-plan' && !v.title);
  const freeLevels = orphans.filter((t) => titleKind(fold(t.text)) === 'floor-plan' && guessStorey(t.text) && !blocks.some((b) => containsBox(b.box, t.box, 1)));
  const ranks = new Set(freeLevels.map((t) => guessStorey(t.text)!.rank));
  if (untitledPlans.length === 1 && ranks.size === 1) {
    const v = untitledPlans[0]!;
    const t = freeLevels[0]!;
    v.title = t;
    v.storeyRank = guessStorey(t.text)!.rank;
    v.confidence = 0.6;
    v.sources.push('orphan-title');
    v.doubts = [msg(lang, 'pdf.view.doubt.orphanTitle', { title: t.text })];
    log.push(`titre libre « ${t.text} » attribué au seul plan sans titre`);
  }

  // Ordre : genre, puis rang (plans), puis position.
  views.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (a.storeyRank ?? 99) - (b.storeyRank ?? 99) ||
      Math.round((a.box.minY - b.box.minY) / Math.max(1, 0.5 * Math.min(H(a.box), H(b.box)))) ||
      a.box.minX - b.box.minX,
  );
  const counters = new Map<ViewKind, number>();
  const ids = views.map((v) => {
    const k = (counters.get(v.kind) ?? 0) + 1;
    counters.set(v.kind, k);
    return `p${page.number}-${v.kind}${k}`;
  });

  // Emprise du bâtiment dans les plans et la toiture, recoupée d'une vue à l'autre.
  const footprints = buildingFootprints(
    page,
    views.map((v, i) => ({ id: ids[i]!, kind: v.kind, box: v.box, label: v.title?.text ?? ids[i]! })),
    body,
    mpp,
    lang,
    log,
  );

  const read: ReadView[] = views.map((v, i) => ({
    id: ids[i]!,
    page: page.number,
    kind: v.kind,
    title: v.title?.text ?? null,
    titleBox: v.title ? { ...v.title.box } : null,
    storeyRank: v.storeyRank,
    sides: v.sides,
    box: { ...v.box },
    buildingBox: footprints.get(ids[i]!)?.box ?? null,
    sheetId: null,
    confidence: v.confidence,
    sources: [...v.sources],
    doubts: [...v.doubts, ...(footprints.get(ids[i]!)?.doubts ?? [])],
  }));
  return { views: read, details: views, footprints, body, titles: titlesAll, titleBlock: tb, orphanTitles: orphans, log };
}
