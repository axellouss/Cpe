/**
 * Tableau des SURFACES d'une planche d'autorisation (« Calcul des surfaces ») : surface du terrain, surface scellée,
 * emprise au sol, surface construite brute, avec leurs maxima réglementaires (« max 96 m² »). En allemand :
 * Grundstücksfläche, versiegelte Fläche, Grundfläche / überbaute Fläche, Bruttogeschossfläche (BGF).
 *
 * Structure : une ligne d'intitulé, puis les cellules à sa droite sur la même ligne de base (0,4 corps) : la cellule
 * qui dit « max » donne le maximum, l'autre la valeur. La valeur peut aussi suivre l'intitulé sur la même ligne.
 */
import type { ReadAreaLine, ReadSiteAreas } from '../core/reading';
import type { BBox } from '../core/types';
import { baseIn, fold, parseArea, parseDecimal, sameDirection, type SheetLine } from './labels';

type Row = 'terrain' | 'sealed' | 'footprint' | 'grossFloor';

const ROWS: { key: Row; re: RegExp }[] = [
  { key: 'terrain', re: /^surfaces? (?:du |de )?terrain|^surface de la parcelle|^contenance|^grundstucksflache|^grundstuck\b|^grundstucksgrosse/ },
  { key: 'sealed', re: /^surfaces? scellee|^surface impermeabilisee|^surface imperméabilisée|^versiegelte flache|^versiegelung|^flache versiegelt/ },
  { key: 'footprint', re: /^surfaces? (?:d'|de l')?emprise|^emprise au sol|^grundflache|^bebaute flache|^uberbaute flache/ },
  { key: 'grossFloor', re: /^surfaces? construites? brutes?|^surface brute|^bruttogeschossflache|^geschossflache|^bgf\b|^surface de plancher/ },
];

const MAX_RE = /\bmax\b|\bmaxi|maximum|zulassig|hochst|\bmax\.|autorise/;

function cellArea(text: string): number | null {
  // Une surface négative n'existe pas : « -5 m² » n'est pas lu (et surtout pas comme 5).
  if (/[-−–]\s*\d/.test(text) && !/\d\s*[-−–]\s*\d/.test(text)) return null;
  const a = parseArea(text);
  if (a !== null) return a;
  const m = /(\d+(?:[.,]\d+)?)\s*m\s*$/.exec(text);
  return m ? parseDecimal(m[1]!) : null;
}

function grow(box: BBox | undefined, b: BBox): BBox {
  if (!box) return { ...b };
  return { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) };
}

/** Tableau des surfaces lu dans un ensemble de lignes ; null s'il n'y en a pas. La première ligne trouvée l'emporte. */
export function siteAreaTable(lines: readonly SheetLine[]): ReadSiteAreas | null {
  const out: ReadSiteAreas = {};
  let box: BBox | undefined;
  let page: number | undefined;
  for (const l of lines) {
    const f = fold(l.text);
    const row = ROWS.find((r) => r.re.test(f));
    if (!row || out[row.key]) continue;
    if (page !== undefined && l.page !== page) continue;
    const right = lines
      .filter((o) => o !== l && o.page === l.page && sameDirection(o.angle, l.angle) && Math.abs(baseIn(l, o) - l.base) < 0.4 * l.size && o.u0 > l.u0 && o.u0 - l.u1 < 30 * l.size)
      .sort((a, b) => a.u0 - b.u0);
    const own = l.text.includes(':') ? l.text.slice(l.text.indexOf(':') + 1) : '';
    const cells = [own, ...right.map((o) => o.text)];
    let value: number | undefined;
    let max: number | undefined;
    for (const c of cells) {
      // « 210,30 m² (max 300,00 m²) » : valeur et maximum dans la même cellule, séparés au mot « max ».
      const f = fold(c);
      const at = f.search(MAX_RE);
      const parts: [string, boolean][] = at > 0 && cellArea(c.slice(0, at).replace(/[(\[]\s*$/, '')) !== null ? [[c.slice(0, at), false], [c.slice(at), true]] : [[c, at >= 0]];
      for (const [text, isMax] of parts) {
        const a = cellArea(text);
        if (a === null) continue;
        if (isMax) max ??= a;
        else value ??= a;
      }
    }
    if (value === undefined) continue;
    const line: ReadAreaLine = max !== undefined ? { value, max } : { value };
    out[row.key] = line;
    page = l.page;
    box = grow(box, l.box);
    for (const o of right) box = grow(box, o.box);
  }
  if (page === undefined) return null;
  out.page = page;
  if (box) out.box = box;
  return out;
}
