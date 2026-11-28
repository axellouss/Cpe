/**
 * Emprise du BÂTIMENT dans une vue en plan qui montre aussi la parcelle, la rue, les voisins (cadre de situation
 * découpé sous chaque plan). Analyse pure, repère de la page (points PDF, y vers le bas).
 *
 * Signaux indépendants, recoupés :
 *  - zones de pièces : remplissages clairs, unis, opaques, qui portent un nom et une ligne de surface (germe) ;
 *  - murs : polygones creux remplis (L, T, anneau), hachures étroites, remplissages sombres étroits, traits épais
 *    gris ou noirs, qui prolongent le germe de proche en proche ;
 *  - cadre répété : le même cadre de situation dessiné sous plusieurs vues (mêmes remplissages décalés) reporte
 *    l'emprise d'une vue à l'autre ;
 *  - remplissage de toiture : un grand aplat dont les quatre bords tombent sur l'emprise reportée ;
 *  - cotes écrites parallèles à l'axe, autour de la boîte.
 * Largeur et profondeur sont retenues quand deux sources distinctes concordent à 5 cm près ; sinon la confiance
 * est basse et un doute est posé. Une cote d'ensemble plus longue qui prolonge la boîte sur une pièce intérieure
 * signale une boîte trop petite (doute).
 */
import type { BBox, Lang } from '../../core/types';
import type { ViewKind } from '../../core/reading';
import { formatNumber } from '../../i18n';
import { fold } from '../../semantics/labels';
import { msg } from './messages';
import type { FillArea, RawPage, RawText } from './raw';
import { AREA_RE, boxArea, containsBox, H, inBox, median, textBox, unionBox, W } from './sheetviews';

/**
 * Espaces extérieurs ou étiquettes de parcelle (texte replié par `fold`) : jamais une pièce du bâtiment. Liste
 * unique des lecteurs PDF. Un jardin d'hiver (Wintergarten) est une pièce, souvent chauffée : il n'en fait pas partie.
 */
const OUTDOOR_WORDS_RE = /terrasse|balcon|balkon|loggia|jardin|garten|\bcour\b|\bhof\b|pergola|car-?port|parking|stellplatz|zufahrt|acces|trottoir|rue\b|strasse|parcelle|parzelle|\blot\b/;
const INDOOR_GARDEN_RE = /jardin d\W?\s?hiver|wintergarten/;
export const OUTDOOR_RE = { test: (folded: string): boolean => OUTDOOR_WORDS_RE.test(folded) && !INDOOR_GARDEN_RE.test(folded) };

export type FootprintSource = 'room-zones' | 'walls' | 'wall-ring' | 'repeat-frame' | 'roof-fill';

export interface DimVote {
  value: number;
  source: string;
}

export interface DimDecision {
  /** Mètres. */
  value: number;
  confidence: number;
  votes: DimVote[];
  /** Raison du doute (langue de lecture) ; null si les sources concordent. */
  doubt: string | null;
}

export interface BuildingFootprint {
  box: BBox;
  confidence: number;
  sources: FootprintSource[];
  /** Largeur (x) et profondeur (y) recoupées, en mètres. */
  width?: DimDecision;
  depth?: DimDecision;
  /** Doutes à montrer (langue de lecture). */
  doubts: string[];
}

function isLight(color: number): boolean {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  return Math.min(r, g, b) >= 200 && Math.max(r, g, b) - Math.min(r, g, b) <= 40 && !(r === 255 && g === 255 && b === 255);
}

function pointInRing(r: readonly [number, number][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!;
    const [xj, yj] = r[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * Zones de pièces de la vue : remplissages clairs, unis, opaques (pas le blanc), d'au moins 15 pt de côté, qui
 * portent une ligne de surface et, juste au-dessus, un nom (ni intitulé « … : », ni cote).
 */
export interface RoomZone {
  fill: FillArea;
  label: string;
  /** Texte du nom et ligne de surface. */
  nameText: RawText;
  areaText: RawText;
  /** Surface écrite (m²), premier nombre décimal de la ligne de surface ; null si illisible. */
  area: number | null;
}

/** Surface écrite sur la ligne d'une zone (« S: 27,40 m », exposant « 2 » à part ; « 12,40 m² »). */
export function zoneArea(s: string): number | null {
  const m = /(\d{1,4}[.,]\d{1,2})/.exec(s);
  if (!m) return null;
  const v = Number(m[1]!.replace(',', '.'));
  return v > 0 && v < 10000 ? v : null;
}

export function roomZones(page: RawPage, view: BBox, body: number): RoomZone[] {
  const out: RoomZone[] = [];
  const texts = page.texts.filter((t) => inBox(view, t.cx, t.cy) && Math.abs(t.angle) < 1);
  const areaLines = texts.filter((t) => AREA_RE.test(t.s));
  if (areaLines.length === 0) return out;
  const labels = texts.filter((t) => /[a-zA-ZÀ-ÿ]{2}/.test(t.s) && t.s.length <= 40 && t.size <= 2.5 * body && !AREA_RE.test(t.s) && !/[:=]/.test(t.s));
  for (const f of page.fills) {
    if (f.alpha < 0.99 || !isLight(f.color) || !containsBox(view, f.bbox, 1)) continue;
    if (Math.min(W(f.bbox), H(f.bbox)) < 15) continue;
    // Dans le polygone de la zone (règle pair-impair sur ses anneaux), pas seulement dans sa boîte : la boîte d'un hall
    // en L couvre souvent l'étiquette du vestiaire voisin.
    const inFill = (t: RawText): boolean => inBox(f.bbox, t.cx, t.cy) && f.rings.filter((ring) => pointInRing(ring, t.cx, t.cy)).length % 2 === 1;
    let found: { name: RawText; at: RawText } | null = null;
    for (const at of areaLines) {
      if (!inFill(at)) continue;
      const above = labels
        .filter((t) => inFill(t) && t.cy < at.cy && at.y0 - t.y1 <= 2 * at.size && Math.min(t.x1, at.x1) - Math.max(t.x0, at.x0) > -at.size)
        .sort((p, q) => q.cy - p.cy)[0];
      if (above) {
        found = { name: above, at };
        break;
      }
    }
    if (!found) continue;
    const { name, at } = found;
    // Une même zone peinte deux fois (fond, puis contour) n'est qu'une pièce.
    if (out.some((z) => z.nameText === name && z.areaText === at)) continue;
    out.push({ fill: f, label: name.s.trim(), nameText: name, areaText: at, area: zoneArea(at.s) });
  }
  return out;
}

/**
 * Boîte du bâtiment dans une vue en plan : union des zones de pièces intérieures, prolongée par les murs en polygones
 * creux (écart ≤ 1,2 m, tant que la boîte reste < 2 × le germe), puis par les éléments de mur (écart ≤ 0,6 m, un
 * élément qui agrandit de plus de 1,5 m est refusé). Ce qui touche le bord de la vue (voisin, rue) est écarté.
 * null sans zone de pièce (plans tout en trait fin).
 */
export function buildingBox(page: RawPage, view: BBox, body: number, mpp: number): { box: BBox; confidence: number; sources: FootprintSource[]; zones: number } | null {
  const zones = roomZones(page, view, body).filter((z) => !OUTDOOR_RE.test(fold(z.label)));
  if (zones.length === 0) return null;
  let seed = zones[0]!.fill.bbox;
  for (const z of zones) seed = unionBox(seed, z.fill.bbox);
  const narrow = 0.8 / mpp;
  const inner: BBox = { minX: view.minX + 2, minY: view.minY + 2, maxX: view.maxX - 2, maxY: view.maxY - 2 };
  const viewSegs = page.segs.filter((s) => s.stroke && inBox(inner, s.x0, s.y0) && inBox(inner, s.x1, s.y1));
  const thinW = median(viewSegs.map((s) => s.w));
  const walls: BBox[] = [];
  for (const h of page.hatches) if (containsBox(inner, h.bbox) && Math.min(W(h.bbox), H(h.bbox)) <= narrow) walls.push(h.bbox);
  for (const f of page.fills) {
    if (f.alpha >= 0.99 && !isLight(f.color) && f.color !== 0xffffff && containsBox(inner, f.bbox) && Math.min(W(f.bbox), H(f.bbox)) <= narrow && Math.max(W(f.bbox), H(f.bbox)) >= 0.5 / mpp) walls.push(f.bbox);
  }
  for (const s of viewSegs) {
    if (s.dash || s.w < 1.6 * thinW) continue;
    // Un trait épais COLORÉ (limite, ligne de construction) n'est pas un mur : on garde les gris et les noirs.
    const c = s.color ?? 0;
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40) continue;
    walls.push({ minX: Math.min(s.x0, s.x1), minY: Math.min(s.y0, s.y1), maxX: Math.max(s.x0, s.x1), maxY: Math.max(s.y0, s.y1) });
  }
  // Murs en polygones remplis creux (surface < 50 % de leur boîte), sans étiquette de surface dedans : la couleur ne
  // départage pas murs et pièces, la forme oui.
  const areaTexts = page.texts.filter((t) => AREA_RE.test(t.s) && inBox(inner, t.cx, t.cy));
  const ringWalls = page.fills.filter(
    (f) => f.alpha >= 0.99 && f.color !== 0xffffff && containsBox(inner, f.bbox) && f.area < 0.5 * boxArea(f.bbox) && !areaTexts.some((t) => inBox(f.bbox, t.cx, t.cy) && f.rings.some((ring) => pointInRing(ring, t.cx, t.cy))),
  );
  let box = { ...seed };
  let ringUsed = 0;
  const rt = 1.2 / mpp;
  for (let grew = true, it = 0; grew && it < 50; it++) {
    grew = false;
    for (const f of ringWalls) {
      const b = f.bbox;
      const near = b.minX <= box.maxX + rt && b.maxX >= box.minX - rt && b.minY <= box.maxY + rt && b.maxY >= box.minY - rt;
      if (!near || containsBox(box, b)) continue;
      const nb = unionBox(box, b);
      if (boxArea(nb) > 2 * boxArea(seed)) continue;
      box = nb;
      ringUsed++;
      grew = true;
    }
  }
  const tol = 0.6 / mpp;
  for (let grew = true, it = 0; grew && it < 20; it++) {
    grew = false;
    for (const w of walls) {
      const near = w.minX <= box.maxX + tol && w.maxX >= box.minX - tol && w.minY <= box.maxY + tol && w.maxY >= box.minY - tol;
      if (!near || containsBox(box, w)) continue;
      const nb = unionBox(box, w);
      if (W(nb) > W(box) + 1.5 / mpp || H(nb) > H(box) + 1.5 / mpp) continue;
      box = nb;
      grew = true;
    }
  }
  const sources: FootprintSource[] = ['room-zones'];
  if (walls.filter((w) => containsBox(box, w, 1)).length >= 4) sources.push('walls');
  if (ringUsed > 0) sources.push('wall-ring');
  return { box, confidence: sources.length >= 2 ? 0.8 : 0.5, sources, zones: zones.length };
}

/**
 * Même cadre répété ? Part des remplissages de A (> 50 pt²) retrouvés dans B, même couleur, décalés de l'écart des
 * coins des vues (à 1 pt près) ; 0 si les vues n'ont pas la même taille (± 3 pt) ou si A en porte moins de 5.
 */
export function repeatedFrame(page: RawPage, a: BBox, b: BBox, ignore: readonly BBox[] = []): number {
  if (Math.abs(W(a) - W(b)) > 3 || Math.abs(H(a) - H(b)) > 3) return 0;
  const dx = b.minX - a.minX;
  const dy = b.minY - a.minY;
  // Les remplissages du bâtiment (pièces, murs), différents d'un étage à l'autre, ne disent rien du cadre : écartés.
  const kept = (f: FillArea): boolean => boxArea(f.bbox) > 50 && !ignore.some((g) => containsBox(g, f.bbox, 1));
  const inA = page.fills.filter((f) => containsBox(a, f.bbox, 1) && kept(f));
  if (inA.length < 5) return 0;
  const inB = page.fills.filter((f) => containsBox(b, f.bbox, 1) && kept(f));
  // Part en nombre ET part en surface : les grands aplats du cadre (parcelle, pelouse, rue) se retrouvent d'une vue à
  // l'autre même quand les pièces, nombreuses et différentes d'un étage à l'autre, dominent le compte.
  let hit = 0;
  let hitArea = 0;
  let allArea = 0;
  for (const f of inA) {
    allArea += f.area;
    if (inB.some((g) => g.color === f.color && Math.abs(g.bbox.minX - f.bbox.minX - dx) < 1 && Math.abs(g.bbox.minY - f.bbox.minY - dy) < 1 && Math.abs(W(g.bbox) - W(f.bbox)) < 1 && Math.abs(H(g.bbox) - H(f.bbox)) < 1)) {
      hit++;
      hitArea += f.area;
    }
  }
  return Math.max(hit / inA.length, allArea > 0 ? hitArea / allArea : 0);
}

/** Nombre écrit d'une cote, en mètres (« 8,00 » → 8 ; « 800 » → 8, en cm) ; null sinon. */
export function cotaMetres(s: string): number | null {
  const t = s.trim();
  let m = /^(\d{1,2})[.,](\d{2})$/.exec(t);
  if (m) return Number(m[1]) + Number(m[2]) / 100;
  m = /^(\d{3,4})$/.exec(t);
  if (m) return Number(m[1]) / 100;
  return null;
}

/**
 * Portée des cotes autour de la boîte (m) : la chaîne d'ensemble passe souvent au-delà d'une terrasse dessinée
 * devant la façade (3 à 4 m de profondeur), à plus de 4 m du mur.
 */
const DIM_REACH_M = 6;

const shift = (b: BBox, dx: number, dy: number): BBox => ({ minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy });
const kindOf = (source: string): string => source.replace(/#.*/, '');

/**
 * Largeur (x) et profondeur (y) du bâtiment : candidats (boîte des murs de chaque plan, remplissage de toiture,
 * ramenés dans la vue) et cotes écrites à ± 4 % d'un candidat, parallèles à l'axe, à moins de 6 m de la boîte.
 * Groupe retenu = le plus de SOURCES distinctes d'accord à 5 cm près ; la cote fait foi quand elle en est.
 * Confiance : ≥ 2 sources sans dissidente 0,95 ; avec une dissidente 0,8 ; une seule 0,5 (doute) ; cote
 * d'ensemble contraire 0,4 (doute).
 */
export function decideDims(page: RawPage, view: BBox, candidates: readonly { box: BBox; source: string }[], mpp: number, lang: Lang): { width: DimDecision; depth: DimDecision } {
  const ref = candidates[0]!.box;
  const reach = DIM_REACH_M / mpp;
  const zone: BBox = { minX: ref.minX - reach, minY: ref.minY - reach, maxX: ref.maxX + reach, maxY: ref.maxY + reach };
  const cotes = page.texts
    .filter((t) => containsBox(view, textBox(t)) && inBox(zone, t.cx, t.cy))
    .map((t) => ({ t, v: cotaMetres(t.s) }))
    .filter((x): x is { t: RawText; v: number } => x.v !== null);
  const decide = (axis: 'x' | 'y'): DimDecision => {
    const parallel = (t: RawText): boolean => (axis === 'x' ? Math.abs(t.angle) < 1 : Math.abs(Math.abs(t.angle) - 90) < 1);
    const votes: DimVote[] = candidates.map((c) => ({ value: (axis === 'x' ? W(c.box) : H(c.box)) * mpp, source: c.source }));
    for (const c of [...votes]) {
      for (const h of cotes) if (parallel(h.t) && Math.abs(h.v - c.value) <= 0.04 * c.value && !votes.some((v) => v.source === 'cote' && v.value === h.v)) votes.push({ value: h.v, source: 'cote' });
    }
    let best: DimVote[] = [];
    for (const v of votes) {
      const group = votes.filter((o) => Math.abs(o.value - v.value) <= 0.05);
      const kinds = new Set(group.map((g) => kindOf(g.source)));
      const bk = new Set(best.map((g) => kindOf(g.source)));
      if (kinds.size > bk.size || (kinds.size === bk.size && group.length > best.length)) best = group;
    }
    const kinds = new Set(best.map((g) => kindOf(g.source)));
    const cote = best.find((b) => b.source === 'cote');
    const value = cote ? cote.value : best.reduce((n, b) => n + b.value, 0) / Math.max(1, best.length);
    const others = votes.filter((v) => Math.abs(v.value - value) > 0.05);
    let confidence = kinds.size >= 2 ? (others.length === 0 ? 0.95 : 0.8) : 0.5;
    // Cote d'ensemble : sa chaîne (longueur v, centrée sur son texte) part d'un bord de la boîte (± 0,3 m) et la
    // prolonge sur une zone qui porte la surface d'une pièce INTÉRIEURE : la boîte a manqué une partie du bâtiment.
    const lo0 = axis === 'x' ? ref.minX : ref.minY;
    const hi0 = axis === 'x' ? ref.maxX : ref.maxY;
    const tol = 0.3 / mpp;
    let overall = 0;
    for (const x of cotes) {
      if (!parallel(x.t) || !(x.v > 1.04 * value && x.v < 2 * value)) continue;
      const L = x.v / mpp;
      const c = axis === 'x' ? x.t.cx : x.t.cy;
      const lo = c - L / 2;
      const hi = c + L / 2;
      let ext: [number, number] | null = null;
      if (Math.abs(lo - lo0) <= tol && hi > hi0 + tol) ext = [hi0, hi];
      else if (Math.abs(hi - hi0) <= tol && lo < lo0 - tol) ext = [lo, lo0];
      if (!ext) continue;
      const zoneExt: BBox = axis === 'x' ? { minX: ext[0], maxX: ext[1], minY: ref.minY, maxY: ref.maxY } : { minX: ref.minX, maxX: ref.maxX, minY: ext[0], maxY: ext[1] };
      const inExt = page.texts.filter((t) => inBox(zoneExt, t.cx, t.cy));
      if (inExt.some((t) => OUTDOOR_RE.test(fold(t.s))) || !inExt.some((t) => AREA_RE.test(t.s))) continue;
      overall = Math.max(overall, x.v);
    }
    const what = msg(lang, axis === 'x' ? 'pdf.building.width' : 'pdf.building.depth');
    let doubt: string | null = null;
    if (overall > 0) {
      confidence = 0.4;
      votes.push({ value: overall, source: 'cote-ensemble' });
      doubt = msg(lang, 'pdf.building.doubt.overall', { what, value: formatNumber(value, 2), overall: formatNumber(overall, 2) });
    } else if (kinds.size < 2) doubt = msg(lang, 'pdf.building.doubt.single', { what, value: formatNumber(value, 2) });
    return { value: Math.round(value * 1000) / 1000, confidence, votes, doubt };
  };
  return { width: decide('x'), depth: decide('y') };
}

/** Vue à examiner : plans d'étage et toiture seulement. */
export interface FootprintView {
  id: string;
  kind: ViewKind;
  box: BBox;
  /** Nom pour le journal. */
  label: string;
}

/**
 * Emprise du bâtiment pour chaque plan d'étage et plan de toiture de la page : boîte par vue, report d'une vue à
 * l'autre par le cadre répété (concordance ≤ 0,3 m : confiance 0,9), confirmation par le remplissage de toiture,
 * dimensions par recoupement.
 */
export function buildingFootprints(page: RawPage, views: readonly FootprintView[], body: number, mpp: number, lang: Lang, log: string[]): Map<string, BuildingFootprint> {
  const out = new Map<string, BuildingFootprint>();
  const plans = views.filter((v) => v.kind === 'floor-plan' || v.kind === 'roof-plan');
  if (plans.length === 0) return out;
  for (const v of plans) {
    const b = buildingBox(page, v.box, body, mpp);
    if (!b) continue;
    out.set(v.id, { box: b.box, confidence: b.confidence, sources: b.sources, doubts: [] });
    log.push(`bâtiment « ${v.label} » : ${(W(b.box) * mpp).toFixed(2)} × ${(H(b.box) * mpp).toFixed(2)} m, ${b.zones} zones, ${b.sources.join('+')}`);
  }
  // Cadres répétés (calculés une fois par paire).
  const repeat = new Map<string, number>();
  const repeatOf = (a: FootprintView, b: FootprintView): number => {
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    let r = repeat.get(key);
    if (r === undefined) {
      const ignore = [out.get(a.id)?.box, out.get(b.id)?.box].filter((x): x is BBox => !!x);
      r = Math.max(repeatedFrame(page, a.box, b.box, ignore), repeatedFrame(page, b.box, a.box, ignore));
      repeat.set(key, r);
    }
    return r;
  };
  for (const v of plans) {
    for (const o of plans) {
      if (o === v) continue;
      const r = repeatOf(o, v);
      if (r < 0.5) continue;
      const src = out.get(o.id);
      if (!src || !src.sources.includes('room-zones')) continue;
      const moved = shift(src.box, v.box.minX - o.box.minX, v.box.minY - o.box.minY);
      const mine = out.get(v.id);
      if (!mine) {
        out.set(v.id, { box: moved, confidence: 0.6, sources: ['repeat-frame'], doubts: [] });
        log.push(`emprise reportée de « ${o.label} » sur « ${v.label} » (${Math.round(r * 100)} % des remplissages)`);
      } else {
        const d = Math.max(Math.abs(moved.minX - mine.box.minX), Math.abs(moved.minY - mine.box.minY), Math.abs(moved.maxX - mine.box.maxX), Math.abs(moved.maxY - mine.box.maxY)) * mpp;
        if (d <= 0.3) {
          mine.confidence = Math.max(mine.confidence, 0.9);
          if (!mine.sources.includes('repeat-frame')) mine.sources.push('repeat-frame');
        }
      }
    }
  }
  // Toiture : un grand remplissage dont les quatre bords tombent sur l'emprise (± 0,3 m) la confirme.
  const roofFill = new Map<string, BBox>();
  for (const v of plans) {
    const fp = out.get(v.id);
    if (v.kind !== 'roof-plan' || !fp) continue;
    const bb = fp.box;
    const fit = page.fills.find(
      (f) => containsBox(v.box, f.bbox, 1) && Math.max(Math.abs(f.bbox.minX - bb.minX), Math.abs(f.bbox.minY - bb.minY), Math.abs(f.bbox.maxX - bb.maxX), Math.abs(f.bbox.maxY - bb.maxY)) * mpp <= 0.3 && boxArea(f.bbox) > 0.5 * boxArea(bb),
    );
    if (!fit) continue;
    fp.confidence = Math.max(fp.confidence, 0.9);
    if (!fp.sources.includes('roof-fill')) fp.sources.push('roof-fill');
    roofFill.set(v.id, fit.bbox);
  }
  // Dimensions : boîte de chaque plan (la sienne d'abord) et remplissage de toiture, ramenés dans la vue.
  for (const v of plans) {
    const fp = out.get(v.id);
    if (!fp) continue;
    const cands: { box: BBox; source: string }[] = [];
    for (const o of plans) {
      const ofp = out.get(o.id);
      if (!ofp) continue;
      if (o !== v && repeatOf(o, v) < 0.5) continue;
      const dx = v.box.minX - o.box.minX;
      const dy = v.box.minY - o.box.minY;
      const fill = roofFill.get(o.id);
      if (fill) cands.push({ box: shift(fill, dx, dy), source: 'roof-fill' });
      else if (ofp.sources.includes('room-zones')) cands.push({ box: shift(ofp.box, dx, dy), source: `walls#${o.id}` });
    }
    if (cands.length === 0) continue;
    cands.sort((a, b) => (a.source === `walls#${v.id}` ? -1 : b.source === `walls#${v.id}` ? 1 : 0));
    const d = decideDims(page, v.box, cands, mpp, lang);
    fp.width = d.width;
    fp.depth = d.depth;
    // La boîte de CETTE vue est l'isolée (mur voisin accolé, annexe) et une autre source, ramenée dans la vue, porte la
    // valeur retenue : la boîte prend les bords de cette source sur cet axe.
    for (const axis of ['x', 'y'] as const) {
      const dec = axis === 'x' ? d.width : d.depth;
      const own = (axis === 'x' ? W(fp.box) : H(fp.box)) * mpp;
      if (dec.confidence < 0.8 || Math.abs(own - dec.value) <= 0.05) continue;
      const other = cands.find((c) => c.source !== `walls#${v.id}` && Math.abs((axis === 'x' ? W(c.box) : H(c.box)) * mpp - dec.value) <= 0.05);
      if (!other) continue;
      if (axis === 'x') fp.box = { ...fp.box, minX: other.box.minX, maxX: other.box.maxX };
      else fp.box = { ...fp.box, minY: other.box.minY, maxY: other.box.maxY };
      log.push(`boîte « ${v.label} » recalée sur ${axis} d'après ${other.source}`);
    }
    for (const x of [d.width, d.depth]) if (x.doubt) fp.doubts.push(x.doubt);
    log.push(`dimensions « ${v.label} » : ${d.width.value.toFixed(2)} (${d.width.confidence}) × ${d.depth.value.toFixed(2)} (${d.depth.confidence})`);
  }
  return out;
}
