/**
 * Éléments d'une vue : remplissages, hachures, traits et textes de la page qui sont VISIBLES et dont le centre tombe
 * dans la boîte de la vue.
 *
 * Visible : un élément peint sous une zone de découpe n'apparaît qu'à l'intérieur de celle-ci (et de ses zones
 * englobantes). Sur une planche dont les plans répètent le même cadre de situation (parcelle, rue) découpé dans la
 * boîte de chaque plan, le cadre entier est peint sous chaque vue : seule la partie dans la découpe est vue, le reste
 * est ignoré. La boîte retenue pour un élément est donc sa boîte rognée par sa découpe.
 */
import type { ReadView } from '../../../core/reading';
import { ringsToPolys } from '../planar';
import type { RawBox, RawPage, RawSeg, RawText } from '../raw';
import type { FillShape, HatchShape, ViewInput } from './types';

/** Marge (pt) autour de la boîte de la vue : les éléments posés sur son bord restent à elle. */
const VIEW_MARGIN = 0.5;

export function intersectBox(a: RawBox, b: RawBox): RawBox | null {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  return minX <= maxX && minY <= maxY ? { minX, minY, maxX, maxY } : null;
}

/** Boîtes effectives des zones de découpe (rognées par leurs zones englobantes), par identifiant. */
export function clipBoxes(page: RawPage): Map<number, RawBox | null> {
  const byId = new Map(page.clips.map((c) => [c.id, c]));
  const memo = new Map<number, RawBox | null>();
  const resolve = (id: number, depth: number): RawBox | null => {
    if (memo.has(id)) return memo.get(id)!;
    const c = byId.get(id);
    let out: RawBox | null;
    if (!c) out = null;
    else if (c.parent < 0 || depth > 64) out = c.bbox;
    else {
      const parent = resolve(c.parent, depth + 1);
      out = parent ? intersectBox(c.bbox, parent) : null;
    }
    memo.set(id, out);
    return out;
  };
  for (const c of page.clips) resolve(c.id, 0);
  return memo;
}

/** Boîte visible d'un élément de boîte `b` peint sous la découpe `clip` ; null s'il est entièrement masqué. */
export function visibleBox(b: RawBox, clip: number | undefined, clips: Map<number, RawBox | null>): RawBox | null {
  if (!clip) return b;
  if (!clips.has(clip)) return b;
  const c = clips.get(clip);
  return c ? intersectBox(b, c) : null;
}

function centreIn(b: RawBox, box: RawBox, margin = VIEW_MARGIN): boolean {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return cx >= box.minX - margin && cx <= box.maxX + margin && cy >= box.minY - margin && cy <= box.maxY + margin;
}

function segBox(s: RawSeg): RawBox {
  return { minX: Math.min(s.x0, s.x1), minY: Math.min(s.y0, s.y1), maxX: Math.max(s.x0, s.x1), maxY: Math.max(s.y0, s.y1) };
}

/** Éléments d'une vue (boîte `view.box`). */
export function viewInput(page: RawPage, view: Pick<ReadView, 'id' | 'box'>, clips = clipBoxes(page)): ViewInput {
  const box = view.box;
  const fills: FillShape[] = [];
  for (const f of page.fills) {
    const vb = visibleBox(f.bbox, f.clip, clips);
    if (!vb || !centreIn(vb, box)) continue;
    const polys = ringsToPolys(f.rings);
    if (polys.length === 0) continue;
    fills.push({ polys, bbox: f.bbox, color: f.color, alpha: f.alpha, stroked: f.stroked });
  }
  const hatches: HatchShape[] = [];
  for (const h of page.hatches) {
    const vb = visibleBox(h.bbox, h.clip, clips);
    if (!vb || !centreIn(vb, box)) continue;
    const polys = ringsToPolys(h.rings);
    if (polys.length === 0) continue;
    hatches.push({ polys, bbox: h.bbox, angles: h.angles, color: h.color, spacing: h.spacing });
  }
  const segs: RawSeg[] = [];
  for (const s of page.segs) {
    const vb = visibleBox(segBox(s), s.clip, clips);
    if (!vb || !centreIn(vb, box)) continue;
    segs.push(s);
  }
  const texts: RawText[] = page.texts.filter(
    (t) => t.cx >= box.minX - VIEW_MARGIN && t.cx <= box.maxX + VIEW_MARGIN && t.cy >= box.minY - VIEW_MARGIN && t.cy <= box.maxY + VIEW_MARGIN,
  );
  return { page: page.number, viewId: view.id, box, fills, hatches, segs, texts };
}
