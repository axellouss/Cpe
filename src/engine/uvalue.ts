/**
 * PRÉ-CALCUL des valeurs U (éléments opaques par couches homogènes, EN ISO 6946 simplifiée) et Uw (fenêtres,
 * EN ISO 10077-1 avec la géométrie de vitrage de LuxEeB-Tool). LuxEeB-Tool fait foi : ces valeurs servent à
 * contrôler la saisie et à montrer l'effet d'une hypothèse, jamais à la remplacer.
 *
 * Vérifié sur un CPE réel (LuxEeB-Tool 6.25) : les six U et les six Uw retombent à l'arrondi près (voir les tests).
 * Résistances superficielles : celles observées dans ce CPE ; les autres (mur contre terre, plancher sous comble)
 * sont celles de la norme pour le sens du flux, marquées « à vérifier » (core/cpe `SURFACE_RESISTANCES`).
 *
 * Fonctions pures.
 */
import {
  LUXEEB_ELEMENT_LABEL,
  SURFACE_RESISTANCES,
  luxeebTypeOf,
  type ConstructionLayer,
  type FensterTyp,
  type LuxeebElementType,
  type WindowGeometry,
} from '../core/cpe';
import type { Boundary, Construction, ConstructionCategory, Provenance, Sourced, WindowType } from '../core/types';
import { weakest } from './provenance';

// ───────────────────────────── Éléments opaques ─────────────────────────────

export interface UResult {
  type: LuxeebElementType;
  rsi: number;
  rse: number;
  /** Vrai si Rsi / Rse ont été observés dans l'outil ; faux = valeur de la norme, à vérifier. */
  resistancesObserved: boolean;
  /** Somme des d/λ des couches comptées (m²K/W). */
  rLayers: number;
  rTotal: number;
  /** U = 1 / R_total + ΔU (W/m²K) ; null si une couche comptée n'a pas de λ ou pas d'épaisseur connue. */
  u: number | null;
  /** Épaisseur totale des couches comptées (cm) : « épaisseur de l'élément » de l'outil. */
  thicknessCm: number;
  /** Couches sans λ (indices dans `layers`). */
  missingLambda: number[];
  /** Couches dont l'épaisseur est inconnue ou invalide (indices dans `layers`). */
  missingThickness: number[];
  /** Provenance la plus faible des λ et des épaisseurs (une λ d'usage → 'default'). */
  from: Provenance;
  /** Confiance la plus faible des λ et des épaisseurs (absente = 1). */
  confidence: number;
}

/** Type LuxEeB effectif d'un élément : le sien, sinon déduit de la catégorie et du milieu. */
export function elementTypeOf(c: Pick<Construction, 'category' | 'luxeebType'>, boundary?: Boundary): LuxeebElementType {
  return c.luxeebType ?? luxeebTypeOf(c.category, boundary ?? defaultBoundary(c.category));
}

function defaultBoundary(category: ConstructionCategory): Boundary {
  return category === 'floor' ? 'ground' : category === 'ceiling' ? 'unheated' : 'outside';
}

/**
 * U d'un élément à couches homogènes. Seule une couche d'épaisseur explicitement nulle (film) est sautée. Une couche
 * dont l'épaisseur est inconnue (`thicknessUnknown`), non finie ou négative, ou une couche sans λ, empêche le calcul
 * (u = null, confiance 0) au lieu d'être ignorée en silence.
 */
export function computeU(
  c: { layers?: readonly ConstructionLayer[]; deltaU?: number; category: ConstructionCategory; luxeebType?: LuxeebElementType },
  boundary?: Boundary,
): UResult {
  const type = elementTypeOf(c, boundary);
  const own = LUXEEB_ELEMENT_LABEL[type].ownValue;
  const res = own ? { rsi: 0, rse: 0, observed: false } : SURFACE_RESISTANCES[type as keyof typeof SURFACE_RESISTANCES];
  let r = 0;
  let thickness = 0;
  const missing: number[] = [];
  const missingThickness: number[] = [];
  const sources: Provenance[] = [];
  let confidence = 1;
  (c.layers ?? []).forEach((layer, i) => {
    const d = layer.thicknessCm.value;
    if (layer.thicknessUnknown === true || !Number.isFinite(d) || d < 0) {
      missingThickness.push(i);
      confidence = 0;
      return;
    }
    if (d === 0) return;
    thickness += d;
    sources.push(layer.thicknessCm.from);
    confidence = Math.min(confidence, layer.thicknessCm.confidence ?? 1);
    const lambda = layer.lambda;
    if (!lambda || !(lambda.value > 0)) {
      missing.push(i);
      confidence = 0;
      return;
    }
    r += d / 100 / lambda.value;
    sources.push(lambda.from);
    confidence = Math.min(confidence, lambda.confidence ?? 1);
  });
  const rTotal = res.rsi + r + res.rse;
  const hasLayers = thickness > 0;
  const blocked = missing.length > 0 || missingThickness.length > 0;
  const u = own || !hasLayers || blocked ? null : 1 / rTotal + (c.deltaU ?? 0);
  return {
    type,
    rsi: res.rsi,
    rse: res.rse,
    resistancesObserved: res.observed,
    rLayers: r,
    rTotal,
    u,
    thicknessCm: Math.round(thickness * 100) / 100,
    missingLambda: missing,
    missingThickness,
    from: weakest(...sources),
    confidence: hasLayers && !blocked ? confidence : 0,
  };
}

/**
 * Valeur U pré-calculée à ranger dans `Construction.u` : provenance 'calc' affaiblie par la plus faible des λ et des
 * épaisseurs (une λ d'usage la rend « à confirmer »). null si le calcul est impossible.
 */
export function precalculatedU(
  c: { layers?: readonly ConstructionLayer[]; deltaU?: number; category: ConstructionCategory; luxeebType?: LuxeebElementType },
  boundary?: Boundary,
): Sourced<number> | null {
  const r = computeU(c, boundary);
  if (r.u === null) return null;
  const u: Sourced<number> = {
    value: Math.round(r.u * 1000) / 1000,
    from: weakest('calc', r.from),
    confidence: r.confidence,
    note: 'Pré-calcul par couches — LuxEeB-Tool fait foi',
  };
  if (!r.resistancesObserved) u.doubt = 'Rsi / Rse de la norme, non vérifiées dans LuxEeB-Tool';
  return u;
}

// ───────────────────────────── Fenêtres ─────────────────────────────

export interface UwResult {
  /** Surface de la fenêtre (m²). */
  aw: number;
  /** Surface vitrée (m²). */
  ag: number;
  /** Surface du cadre (m²). */
  af: number;
  /** Longueur de bord de vitrage (m). */
  lg: number;
  glassShare: number;
  uw: number;
}

/**
 * Uw = (Ag·Ug + Af·Uf + lg·Ψg) / Aw avec la géométrie de LuxEeB-Tool : n vitrages côte à côte (n = 1 pour
 * « einfach »), séparés par des montants de la largeur du cadre ; vitrage = (L − (n+1)·f) × (H − 2f) ;
 * lg = somme des périmètres des n vitrages.
 */
export function computeUw(g: Pick<WindowGeometry, 'width' | 'height' | 'panes'> & { frameWidth: number; fensterTyp: FensterTyp }, ug: number, uf: number, psiG: number): UwResult {
  const W = g.width;
  const H = g.height;
  const f = g.frameWidth;
  const n = Math.max(1, g.fensterTyp === 'einfach' ? 1 : Math.round(g.panes));
  const gw = Math.max(0, W - (n + 1) * f);
  const gh = Math.max(0, H - 2 * f);
  const ag = gw * gh;
  const aw = W * H;
  const af = aw - ag;
  const lg = gw > 0 && gh > 0 ? 2 * (gw + n * gh) : 0;
  const uw = aw > 0 ? (ag * ug + af * uf + lg * psiG) / aw : NaN;
  return { aw, ag, af, lg, glassShare: aw > 0 ? ag / aw : 0, uw };
}

/** Largeur au-delà de laquelle on propose « mehrfach » à 2 vitrages (signal FAIBLE : la largeur seule). */
export const MEHRFACH_WIDTH = 1.6;

/** « einfach / mehrfach » proposé d'après la largeur : une hypothèse, jamais une lecture. */
export function proposeFensterTyp(widthM: number): { fensterTyp: Sourced<FensterTyp>; panes: number } {
  const multiple = widthM > MEHRFACH_WIDTH;
  return {
    fensterTyp: {
      value: multiple ? 'mehrfach' : 'einfach',
      from: 'default',
      confidence: 0.4,
      doubt: 'Déduit de la largeur seule',
    },
    panes: multiple ? 2 : 1,
  };
}

/**
 * Uw pré-calculé d'un type de fenêtre qui porte sa géométrie et Ug, Uf, Ψg ; null s'il en manque un.
 * Provenance : 'calc' affaiblie par la plus faible des entrées.
 */
export function precalculatedUw(w: Pick<WindowType, 'geometry' | 'ug' | 'uf' | 'psiG'>): (Sourced<number> & { detail: UwResult }) | null {
  const g = w.geometry;
  if (!g || !w.ug || !w.uf || !w.psiG) return null;
  const r = computeUw({ ...g, frameWidth: g.frameWidth.value, fensterTyp: g.fensterTyp.value }, w.ug.value, w.uf.value, w.psiG.value);
  if (!Number.isFinite(r.uw)) return null;
  const parts = [w.ug, w.uf, w.psiG, g.frameWidth, g.fensterTyp];
  return {
    value: Math.round(r.uw * 100) / 100,
    from: weakest('calc', ...parts.map((p) => p.from)),
    confidence: Math.min(...parts.map((p) => p.confidence ?? 1)),
    note: 'Pré-calcul EN ISO 10077-1 — LuxEeB-Tool fait foi',
    detail: r,
  };
}

// ───────────────────────────── Contrôle global (pas un bilan) ─────────────────────────────

/** Une surface et sa valeur U, pour le contrôle « U moyen » (sans facteurs de température). */
export interface AreaU {
  area: number;
  u: number | null;
}

/** U moyen pondéré par les surfaces (W/m²K), sans facteurs Fx ; null si une valeur U manque. */
export function meanU(items: readonly AreaU[]): number | null {
  let a = 0;
  let au = 0;
  for (const it of items) {
    if (!(it.area > 0)) continue;
    if (it.u === null || !Number.isFinite(it.u)) return null;
    a += it.area;
    au += it.area * it.u;
  }
  return a > 0 ? au / a : null;
}
