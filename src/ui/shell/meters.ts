/**
 * Les deux jauges de la barre du haut.
 *  - complet  : part des valeurs attendues qui sont renseignées ;
 *  - confirmé : part des valeurs attendues qui sont renseignées ET ne viennent ni d'une valeur par défaut
 *               ni d'une estimation (provenance 'plan', 'calc' ou 'user').
 * Les deux partagent le même dénominateur : « confirmé » ne dépasse donc jamais « complet ».
 *
 * La liste des valeurs attendues est volontairement courte et lisible : celles qui pèsent sur le résultat et que
 * l'application sait renseigner (géométrie par étage, fermetures, nord, réponses). Les champs que l'expert remplit
 * de toute façon dans LuxEeB-Tool (identité des intervenants, ponts thermiques…) n'en font pas partie.
 */
import type { Project, Provenance, Storey } from '../../core/types';
import { storeyMetrics } from '../../engine';

export interface MeterSlot {
  key: string;
  filled: boolean;
  /** Provenance de la valeur si elle est renseignée. */
  from: Provenance | null;
}

export interface Meters {
  /** 0..1 */
  complete: number;
  /** 0..1 */
  confirmed: number;
  slots: MeterSlot[];
}

const RANK: Record<Provenance, number> = { estimate: 0, default: 1, plan: 2, calc: 3, user: 4 };

function weakest(sources: readonly Provenance[]): Provenance {
  let best: Provenance | null = null;
  for (const s of sources) if (best === null || RANK[s] < RANK[best]) best = s;
  return best ?? 'calc';
}

export function isConfirmed(from: Provenance | null): boolean {
  return from !== null && from !== 'default' && from !== 'estimate';
}

/** Valeurs géométriques attendues pour un étage. */
const STOREY_SLOTS = ['outline', 'scale', 'grossHeight', 'clearHeight', 'netArea'] as const;

function netAreaFrom(storey: Storey): Provenance {
  if (storey.netAreaOverride) return storey.netAreaOverride.from;
  let source: 'override' | 'rooms' | 'estimate';
  try {
    source = storeyMetrics(storey).netAreaFrom;
  } catch {
    source = storey.rooms.some((r) => r.area.value > 0) ? 'rooms' : 'estimate';
  }
  if (source === 'estimate') return 'estimate';
  const heated = storey.rooms.filter((r) => r.heated);
  // Une pièce encore « à trancher » rend la somme provisoire.
  if (storey.rooms.some((r) => r.needsReview)) return 'estimate';
  return weakest(heated.map((r) => r.area.from));
}

function storeySlots(storey: Storey): MeterSlot[] {
  const hasOutline = storey.outline.length >= 3;
  return [
    // Un contour, qu'il vienne du lecteur ou de l'expert, est une mesure sur le plan.
    { key: `${storey.id}.outline`, filled: hasOutline, from: hasOutline ? 'plan' : null },
    { key: `${storey.id}.scale`, filled: true, from: storey.metresPerUnit.from },
    { key: `${storey.id}.grossHeight`, filled: true, from: storey.grossHeight.from },
    { key: `${storey.id}.clearHeight`, filled: true, from: storey.clearHeight.from },
    { key: `${storey.id}.netArea`, filled: hasOutline, from: hasOutline ? netAreaFrom(storey) : null },
  ];
}

/** Toutes les valeurs attendues, avec leur état. */
export function meterSlots(project: Project): MeterSlot[] {
  const slots: MeterSlot[] = [];
  const { model, answers: a } = project;

  if (model.storeys.length === 0) {
    // Rien de tracé : les valeurs d'un premier étage sont attendues et manquent toutes.
    for (const key of STOREY_SLOTS) slots.push({ key: `storey.${key}`, filled: false, from: null });
    slots.push({ key: 'windows', filled: false, from: null });
    slots.push({ key: 'north', filled: false, from: null });
    slots.push({ key: 'top', filled: false, from: null });
    slots.push({ key: 'bottom', filled: false, from: null });
  } else {
    for (const storey of model.storeys) slots.push(...storeySlots(storey));
    const openings = model.storeys.flatMap((s) => s.openings);
    slots.push({ key: 'windows', filled: openings.length > 0, from: openings.length > 0 ? weakest(openings.map((o) => o.from)) : null });
    slots.push({ key: 'north', filled: true, from: model.northAngle.from });
    slots.push({ key: 'top', filled: true, from: model.top.from });
    slots.push({ key: 'bottom', filled: true, from: model.bottom.from });
  }

  const answer = (key: string, value: unknown): void => {
    const filled = value !== null && value !== undefined;
    slots.push({ key: `answers.${key}`, filled, from: filled ? 'user' : null });
  };
  answer('occasion', a.occasion);
  answer('buildingType', a.buildingType);
  answer('dwellings', a.dwellings);
  answer('yearBuilt', a.yearBuilt);
  if (a.occasion !== 'new') {
    answer('insulationWallsCm', a.insulationWallsCm);
    answer('insulationRoofCm', a.insulationRoofCm);
    answer('insulationFloorCm', a.insulationFloorCm);
  }
  answer('windowGeneration', a.windowGeneration);
  answer('heatGenerator', a.heatGenerator);
  answer('heatEmission', a.heatEmission);
  answer('hotWater', a.hotWater);
  answer('ventilation', a.ventilation);
  answer('solarThermal', a.solarThermal);
  answer('photovoltaic', a.photovoltaic);
  return slots;
}

export function computeMeters(project: Project): Meters {
  const slots = meterSlots(project);
  const total = slots.length || 1;
  const filled = slots.filter((s) => s.filled).length;
  const confirmed = slots.filter((s) => s.filled && isConfirmed(s.from)).length;
  return { complete: filled / total, confirmed: confirmed / total, slots };
}

/** Pourcentage entier pour l'affichage. */
export function percent(ratio: number): number {
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}
