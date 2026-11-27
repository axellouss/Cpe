/**
 * D'un contrôle de plausibilité à l'endroit où le corriger : chaque constat du moteur porte un bouton « corriger »
 * qui ouvre le bon écran, le bon étage et le bon outil. Fonction pure.
 */
import type { Finding, Project } from '../../core/types';
import type { ExpertTab, PlanStepKey, QuestionId } from './types';

export type JumpTarget =
  | {
      step: 'plan';
      /** Étage à ouvrir ; null = le premier (ou création d'un étage s'il n'y en a aucun). */
      storeyId: string | null;
      planStep: PlanStepKey;
      /** Champ du panneau latéral à mettre en avant. */
      focus: 'heights' | 'netArea' | null;
    }
  | { step: 'questions'; question: QuestionId; part: 'top' | 'bottom' | null }
  | { step: 'expert'; tab: ExpertTab };

type Kind =
  | { plan: PlanStepKey; focus?: 'heights' | 'netArea' }
  | { question: QuestionId; part?: 'top' | 'bottom' }
  | { expert: ExpertTab };

/** Où mène chaque code de contrôle du moteur. */
const TARGETS: Record<string, Kind> = {
  'model.noStorey': { plan: 'outline' },
  'storey.outlineInvalid': { plan: 'outline' },
  'scale.unconfirmed': { plan: 'scale' },
  'height.default': { plan: 'outline', focus: 'heights' },
  'clearHeight.default': { plan: 'outline', focus: 'heights' },
  'height.implausible': { plan: 'outline', focus: 'heights' },
  'clearHeight.aboveGross': { plan: 'outline', focus: 'heights' },
  'an.estimated': { plan: 'rooms', focus: 'netArea' },
  'an.grossLike': { plan: 'rooms', focus: 'netArea' },
  'an.low': { plan: 'rooms', focus: 'netArea' },
  'rooms.needReview': { plan: 'rooms' },
  'outline.containsUnheated': { plan: 'outline' },
  'outline.unconditionedInside': { plan: 'outline' },
  'stepback.overhangUncertain': { plan: 'boundary' },
  'north.default': { plan: 'north' },
  'orientation.borderline': { plan: 'north' },
  'windows.none': { plan: 'opening' },
  'windows.exceedWall': { plan: 'opening' },
  'windows.share': { plan: 'opening' },
  'opening.onHeatedWall': { plan: 'opening' },
  'opening.orphan': { plan: 'opening' },
  'opening.inRoof': { plan: 'opening' },
  'opening.exceedsFacade': { plan: 'opening' },
  'opening.roofWindowsUnplaced': { expert: 'manual' },
  'opening.tallerThanWall': { plan: 'opening' },
  'neighbours.heatedExcluded': { plan: 'boundary' },
  'top.default': { question: 'closure', part: 'top' },
  'bottom.default': { question: 'closure', part: 'bottom' },
  'aOverVe.implausible': { plan: 'scale', focus: 'heights' },
  'roof.estimated': { question: 'closure', part: 'top' },
  'roof.monoDirection': { question: 'closure', part: 'top' },
  'roof.ridgeAssumed': { question: 'closure', part: 'top' },
  'roof.pitchImplausible': { question: 'closure', part: 'top' },
  'attic.heightRule': { plan: 'rooms', focus: 'netArea' },
  'stepback.byAreas': { plan: 'outline' },
  'manual.heatedIgnored': { expert: 'manual' },
  'manual.deductMismatch': { expert: 'manual' },
  'abzug.dangling': { expert: 'manual' },
  'constructions.overLimit': { expert: 'constructions' },
  'uvalues.missing': { expert: 'constructions' },
};

/** Codes connus (pour les tests de couverture). */
export const JUMP_CODES: readonly string[] = Object.keys(TARGETS);

/** Étage visé par un constat : par identifiant, sinon par nom, sinon aucun en particulier. */
function storeyOf(finding: Finding, project: Project): string | null {
  const storeys = project.model.storeys;
  const id = finding.params.storeyId;
  if (typeof id === 'string' && storeys.some((s) => s.id === id)) return id;
  for (const key of ['storey', 'upper', 'lower'] as const) {
    const name = finding.params[key];
    if (typeof name !== 'string') continue;
    const found = storeys.find((s) => s.name === name);
    if (found) return found.id;
  }
  return null;
}

/** Premier étage concerné quand le constat ne nomme personne. */
function fallbackStorey(finding: Finding, project: Project): string | null {
  const storeys = project.model.storeys;
  switch (finding.code) {
    case 'rooms.needReview':
      return storeys.find((s) => s.rooms.some((r) => r.needsReview))?.id ?? null;
    case 'windows.none':
      return storeys.find((s) => s.outline.length >= 3)?.id ?? null;
    case 'an.grossLike':
    case 'an.low':
      return storeys.find((s) => s.netAreaOverride === null)?.id ?? null;
    default:
      return null;
  }
}

/** Endroit où corriger un constat ; null si le code est inconnu (aucun bouton n'est alors proposé). */
export function jumpTargetFor(finding: Finding, project: Project): JumpTarget | null {
  const kind = TARGETS[finding.code];
  if (!kind) return null;
  if ('plan' in kind) {
    const storeyId = storeyOf(finding, project) ?? fallbackStorey(finding, project) ?? project.model.storeys[0]?.id ?? null;
    return { step: 'plan', storeyId, planStep: kind.plan, focus: kind.focus ?? null };
  }
  if ('question' in kind) return { step: 'questions', question: kind.question, part: kind.part ?? null };
  return { step: 'expert', tab: kind.expert };
}

/** Clé de traduction du libellé du bouton, selon la destination. */
export function jumpLabelKey(target: JumpTarget): string {
  if (target.step === 'plan') return target.focus ? `shell.jump.plan.${target.focus}` : `shell.jump.plan.${target.planStep}`;
  if (target.step === 'questions') return target.part ? `shell.jump.question.${target.part}` : 'shell.jump.question';
  return `shell.jump.expert.${target.tab}`;
}
