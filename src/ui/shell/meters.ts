/**
 * Les deux jauges de la barre du haut. Elles comptent exactement les cases de la liste guidée du plan — chaque
 * étape de chaque étage — plus les deux réponses indispensables (toiture, plancher bas) :
 *  - complet  : part des cases où une valeur exploitable existe (lue sur le plan, saisie ou validée). Une valeur
 *               par défaut — hauteur d'étage de 2,80 m, toiture ou plancher supposés, nord « en haut » — n'en est pas une ;
 *  - confirmé : part des cases que l'expert a validées, ou pour lesquelles il n'y a rien à valider (grille vierge,
 *               maquette en vraie grandeur, hauteur lue sur une coupe).
 * « Confirmé » ne dépasse donc jamais « complet », et il ne bouge que lorsque l'expert confirme quelque chose.
 *
 * Les notes de visite (année, isolation, installations…) n'en font pas partie : facultatives, elles ne changent
 * aucune valeur calculée, et les laisser de côté ne doit pas faire paraître le relevé « incomplet ». La hauteur
 * libre non plus : elle ne sert qu'à un Vn indicatif.
 */
import type { Project, Provenance } from '../../core/types';
import { allStoreysDone, storeySteps } from './checklist';
import { findSheet } from './documents';
import { isQuestionComplete, REQUIRED_QUESTIONS } from './questions';
import type { LoadedDocument, Marks, GuidedStep } from './types';
import { PLAN_STEP_KEYS } from './types';

export interface MeterSlot {
  key: string;
  /** Une valeur exploitable existe (proposée par le lecteur, saisie ou validée). */
  filled: boolean;
  /** Validée par l'expert, ou rien à valider. */
  confirmed: boolean;
}

export interface Meters {
  /** 0..1 */
  complete: number;
  /** 0..1 */
  confirmed: number;
  slots: MeterSlot[];
}

/** Toiture ou plancher bas : supposé par défaut (rien), proposé (à confirmer), répondu par l'expert (confirmé). */
function closureSlot(key: string, from: Provenance): MeterSlot {
  return { key, filled: from !== 'default', confirmed: from === 'user' };
}

/** Toutes les cases attendues, avec leur état. */
export function meterSlots(project: Project, marks: Marks, documents: readonly LoadedDocument[] = []): MeterSlot[] {
  const slots: MeterSlot[] = [];
  const { model } = project;

  if (model.storeys.length === 0) {
    // Rien de tracé : les étapes d'un premier étage sont attendues et manquent toutes.
    for (const key of PLAN_STEP_KEYS) slots.push({ key: `storey.${key}`, filled: false, confirmed: false });
  } else {
    for (const storey of model.storeys) {
      for (const step of storeySteps(project, storey, marks, documents)) {
        slots.push({ key: `${storey.id}.${step.key}`, filled: step.state === 'toConfirm' || step.state === 'done', confirmed: step.state === 'done' });
      }
    }
  }
  slots.push(closureSlot('top', model.top.from));
  slots.push(closureSlot('bottom', model.bottom.from));
  return slots;
}

export function computeMeters(project: Project, marks: Marks, documents: readonly LoadedDocument[] = []): Meters {
  const slots = meterSlots(project, marks, documents);
  const total = slots.length || 1;
  const filled = slots.filter((s) => s.filled).length;
  const confirmed = slots.filter((s) => s.confirmed).length;
  return { complete: filled / total, confirmed: confirmed / total, slots };
}

/**
 * Ce qui est réellement FAIT à chaque écran du parcours. L'indicateur d'étapes de la barre du haut ne coche que
 * cela : être passé par un écran ne suffit pas (on peut aller au résultat sans rien avoir validé sur le plan).
 *  - home      : un plan est chargé ou un étage existe ;
 *  - read      : la lecture d'un plan chargé a donné au moins un étage ;
 *  - plan      : toutes les étapes de tous les étages sont faites ;
 *  - questions : la seule question indispensable (toiture et plancher bas) est répondue ;
 *  - result    : jamais — c'est la destination, pas un travail.
 */
export function stepsDone(project: Project, marks: Marks, documents: readonly LoadedDocument[] = []): Record<GuidedStep, boolean> {
  const storeys = project.model.storeys;
  return {
    home: documents.length > 0 || storeys.length > 0,
    read: storeys.some((s) => findSheet(documents, s.sheetId) !== null),
    plan: allStoreysDone(project, marks, documents),
    questions: REQUIRED_QUESTIONS.every((q) => isQuestionComplete(q, project)),
    result: false,
  };
}

/** Pourcentage entier pour l'affichage. « 100 % » n'apparaît que lorsque tout y est vraiment, « 0 % » que s'il n'y a rien. */
export function percent(ratio: number): number {
  const rounded = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  if (ratio < 1 && rounded === 100) return 99;
  if (ratio > 0 && rounded === 0) return 1;
  return rounded;
}
