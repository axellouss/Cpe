/**
 * Mitoyenneté lue sur les plans : côtés du contour chauffé lus comme murs mitoyens, et façades « ouvertes ».
 *
 * Un côté se repère par la normale EXTÉRIEURE de son arête, arrondie au quart de tour dans le repère de la feuille :
 * elle ne dépend pas du sens de parcours du polygone (horaire ou anti-horaire), contrairement à la direction de
 * l'arête. Deux arêtes mitoyennes d'un même mur, parcourues en sens contraires sur deux plans, comptent donc pour
 * un seul côté.
 *
 * Façade « ouverte » : un côté du contour qui porte au moins une baie extérieure, ou dont l'arête est lue comme
 * façade isolée (signal « insulation »). Quand tous les côtés le sont sur au moins un plan, et qu'aucun mur
 * mitoyen n'est lu, le bâtiment est isolé : la question de la mitoyenneté n'a pas lieu d'être.
 *
 * Repli : sans contour chauffé ni arêtes lus, rien n'est conclu (`sawEdges` faux).
 *
 * Fonction pure.
 */
import { closestOnSegment, edgeEnds, edgeOutwardNormal, polygonArea } from '../core/geometry';
import type { PlanSheet, Vec2 } from '../core/types';

/** Une arête mitoyenne lue à moins de 0,5 de confiance ne compte pas. */
const PARTY_MIN_CONFIDENCE = 0.5;
/** Côté trop court pour être une façade (décroché, about) : ignoré pour les façades ouvertes (m). */
const MIN_SIDE_M = 1;
/** Une baie à plus de 0,6 m de l'arête (ou 5 % de sa longueur) n'est pas portée par elle. */
const OPENING_NEAR_M = 0.6;
const OPENING_NEAR_RATIO = 0.05;

export interface PartyEvidence {
  /** Au moins un plan avec contour chauffé et arêtes lues. */
  sawEdges: boolean;
  /** Côtés mitoyens distincts (0..3 : normale extérieure au quart de tour). */
  sides: Set<number>;
  /** Plus faible confiance des arêtes mitoyennes retenues (1 sans arête). */
  confidence: number;
  /** Longueur totale des arêtes mitoyennes, tous étages (m). */
  length: number;
  /** Côtés du contour qui portent une baie extérieure ou une façade isolée, réunis sur tous les plans. */
  openSides: Set<number>;
  /** Côtés présents dans les contours (longueur ≥ 1 m). */
  allSides: Set<number>;
}

const isFloorPlan = (s: PlanSheet): boolean => !s.role || s.role === 'floor-plan';
const finite = (p: Vec2): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

/** Côté (0..3) de l'arête i : normale extérieure arrondie au quart de tour. */
export function outwardSide(poly: readonly Vec2[], i: number): number {
  const n = edgeOutwardNormal(poly, i);
  const deg = (Math.atan2(n.y, n.x) * 180) / Math.PI;
  return ((Math.round(deg / 90) % 4) + 4) % 4;
}

export function partyEvidence(sheets: readonly PlanSheet[]): PartyEvidence {
  const out: PartyEvidence = { sawEdges: false, sides: new Set(), confidence: 1, length: 0, openSides: new Set(), allSides: new Set() };
  for (const s of sheets) {
    if (!isFloorPlan(s)) continue;
    const poly = (s.detected.heatedOutline ?? []).filter(finite);
    const edges = s.detected.heatedEdges;
    if (poly.length < 3 || poly.length !== (s.detected.heatedOutline ?? []).length || !(polygonArea(poly) > 0)) continue;
    if (!edges || edges.length !== poly.length) continue;
    out.sawEdges = true;
    const mpu = s.metresPerUnit && Number.isFinite(s.metresPerUnit.value) && s.metresPerUnit.value > 0 ? s.metresPerUnit.value : 0;
    const exterior = s.detected.openings.filter((o) => o.exterior !== false && o.toUnheated !== true && o.detail !== 'garage-door' && finite(o.a) && finite(o.b));
    edges.forEach((e, i) => {
      const [a, b] = edgeEnds(poly, i);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const side = outwardSide(poly, i);
      if (e.boundary === 'heated') {
        if (e.confidence < PARTY_MIN_CONFIDENCE) return;
        out.sides.add(side);
        out.length += len * mpu;
        out.confidence = Math.min(out.confidence, e.confidence);
        return;
      }
      if (e.boundary !== 'outside') return;
      if (mpu > 0 && len * mpu < MIN_SIDE_M) return;
      out.allSides.add(side);
      if ((e.sources ?? []).includes('insulation')) out.openSides.add(side);
      const tol = mpu > 0 ? Math.max(OPENING_NEAR_M / mpu, OPENING_NEAR_RATIO * len) : OPENING_NEAR_RATIO * len;
      if (exterior.some((o) => Math.max(closestOnSegment(o.a, a, b).distance, closestOnSegment(o.b, a, b).distance) <= tol)) out.openSides.add(side);
    });
  }
  return out;
}

/** Vrai si le bâtiment se lit isolé : aucun mur mitoyen lu, et chaque côté porte une baie ou une façade isolée. */
export function readsDetached(p: PartyEvidence): boolean {
  return p.sawEdges && p.sides.size === 0 && p.allSides.size >= 3 && [...p.allSides].every((x) => p.openSides.has(x));
}
