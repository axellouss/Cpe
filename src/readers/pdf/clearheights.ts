/**
 * Hauteurs libres écrites sur une planche, rattachées à leur niveau (fonction PURE) :
 *  - dans une COUPE : une cote de la chaîne verticale posée ENTRE deux niveaux finis cotés de la même vue, plus
 *    petite que la hauteur d'étage de ces deux niveaux (de 5 à 90 cm de moins : l'épaisseur du plancher) ;
 *  - mention « HSP 2,50 » (ou « lichte Höhe ») dans un plan d'étage ou une coupe.
 *
 * Signaux par la STRUCTURE seulement : position entre deux marques de niveau, cohérence de l'écart vertical des
 * marques avec l'échelle de la vue, valeur plausible. Une même valeur lue deux fois (deux coupes, ou coupe + HSP)
 * est recoupée (confiance 0,85) ; une seule lecture reste à 0,65 ; deux valeurs différentes pour un niveau → 0,5.
 */
import type { ReadClearHeight, ReadLevels, ReadView } from '../../core/reading';
import { parseClearHeight } from '../../semantics/labels';
import type { RawPage, RawText } from './raw';
import { METRES_PER_POINT } from './raw';

const NUMBER_RE = /^\s*(\d)[,.](\d{2})(\d?)\s*$/;

function value(t: RawText): number | null {
  const m = NUMBER_RE.exec(t.s);
  if (!m) return null;
  const v = Number(`${m[1]}.${m[2]}${m[3] ?? ''}`);
  return v >= 1.9 && v <= 4.5 ? v : null;
}

const inside = (v: ReadView, x: number, y: number): boolean => x >= v.box.minX && x <= v.box.maxX && y >= v.box.minY && y <= v.box.maxY;

interface Found {
  floorIndex: number | null;
  value: number;
  viewId: string | null;
  source: 'section-chain' | 'hsp';
}

/**
 * Hauteurs libres par niveau. `mppOf(view)` donne l'échelle d'une vue (m par point) quand elle est connue.
 * Renvoie une liste par niveau (au plus une valeur par niveau, la plus soutenue) et le journal.
 */
export function readClearHeights(
  pages: readonly RawPage[],
  views: readonly ReadView[],
  levels: ReadLevels | null,
  mppOf: (view: ReadView) => number | null,
): { byFloor: ReadClearHeight[]; log: string[] } {
  const log: string[] = [];
  const found: Found[] = [];
  const floors = levels?.floors ?? [];
  const floorIndexOf = (rel: number): number => floors.findIndex((f) => Math.abs(f.rel - rel) <= 0.011);

  for (const view of views) {
    const page = pages.find((p) => p.number === view.page);
    if (!page) continue;
    // Mention « HSP » : sur un plan d'étage, elle vaut pour ce niveau.
    if (view.kind === 'floor-plan' || view.kind === 'section') {
      for (const t of page.texts) {
        if (!inside(view, t.cx, t.cy)) continue;
        const v = parseClearHeight(t.s);
        if (v === null) continue;
        let floorIndex: number | null = null;
        if (view.kind === 'floor-plan') {
          const fi = floors.findIndex((f) => f.viewIds.includes(view.id));
          floorIndex = fi >= 0 ? fi : null;
        }
        found.push({ floorIndex, value: v, viewId: view.id, source: 'hsp' });
      }
    }
    if (view.kind !== 'section' || !levels) continue;
    // Marques de niveau fini de cette coupe, une par cote relative, avec leur hauteur sur la feuille.
    const marks = levels.marks.filter((m) => m.viewId === view.id && m.rel !== null && (m.role === 'finished-floor' || m.role === 'top'));
    const byRel = new Map<number, { rel: number; y: number; top: boolean }>();
    for (const m of marks) {
      const key = Math.round(m.rel! * 100);
      if (!byRel.has(key)) byRel.set(key, { rel: m.rel!, y: m.at.y, top: m.role === 'top' });
    }
    const steps = [...byRel.values()].sort((a, b) => a.rel - b.rel);
    if (steps.length < 2) continue;
    const mpp = mppOf(view);
    const texts = page.texts.filter((t) => inside(view, t.cx, t.cy));
    for (let i = 0; i + 1 < steps.length; i++) {
      const lo = steps[i]!;
      const hi = steps[i + 1]!;
      if (lo.top) continue;
      const storey = hi.rel - lo.rel;
      if (storey < 2.0 || storey > 6) continue;
      // Les marques doivent être dessinées à leur hauteur : écart vertical cohérent avec l'échelle (±15 %).
      const dy = lo.y - hi.y;
      if (dy <= 0) continue;
      if (mpp !== null && Math.abs((dy * mpp) / storey - 1) > 0.15) continue;
      const fi = floorIndexOf(lo.rel);
      for (const t of texts) {
        const v = value(t);
        if (v === null) continue;
        if (t.cy < hi.y - 0.02 * dy || t.cy > lo.y + 0.02 * dy) continue;
        const gap = storey - v;
        if (gap < 0.05 || gap > 0.9) continue;
        found.push({ floorIndex: fi >= 0 ? fi : null, value: v, viewId: view.id, source: 'section-chain' });
      }
    }
  }

  // Une valeur par niveau : la plus lue ; recoupée si lue au moins deux fois, en doute si plusieurs valeurs.
  const byFloor: ReadClearHeight[] = [];
  const keys = [...new Set(found.map((f) => f.floorIndex))];
  for (const fi of keys) {
    const mine = found.filter((f) => f.floorIndex === fi);
    const counts = new Map<number, Found[]>();
    for (const f of mine) {
      const k = Math.round(f.value * 1000);
      const list = counts.get(k) ?? [];
      list.push(f);
      counts.set(k, list);
    }
    const ranked = [...counts.values()].sort((a, b) => b.length - a.length);
    const best = ranked[0]!;
    const sources = new Set(best.map((f) => `${f.source}:${f.viewId}`));
    const confidence = ranked.length > 1 ? 0.5 : sources.size >= 2 ? 0.85 : 0.65;
    byFloor.push({ floorIndex: fi, value: best[0]!.value, confidence, viewId: best[0]!.viewId });
    log.push(`hauteur libre ${best[0]!.value} m (niveau ${fi ?? '?'}) : ${best.length} lecture(s), ${ranked.length} valeur(s)`);
  }
  byFloor.sort((a, b) => (a.floorIndex ?? 99) - (b.floorIndex ?? 99));
  return { byFloor, log };
}

/** Échelle d'une coupe sans autre indication : celle annoncée sur sa page. */
export function declaredMpp(den: number | null): number | null {
  return den !== null && den > 0 ? den * METRES_PER_POINT : null;
}
