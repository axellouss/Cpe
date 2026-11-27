/**
 * D'un contrôle de plausibilité à l'endroit où le corriger.
 */
import { describe, expect, it } from 'vitest';
import type { Finding, Project } from '../../../src/core/types';
import { createEmptyProject, createStorey, FINDING_CODES } from '../../../src/engine';
import { t } from '../../../src/i18n';
import { JUMP_CODES, jumpLabelKey, jumpTargetFor } from '../../../src/ui/shell/jump';
import '../../../src/ui/shell/messages';
import { relevantQuestions } from '../../../src/ui/shell/questions';
import { EXPERT_TABS, PLAN_STEP_KEYS } from '../../../src/ui/shell/types';

function twoStoreys(): Project {
  const project = createEmptyProject('fr');
  const lower = createStorey(null, 'Rez-de-chaussée', project.model);
  project.model.storeys.push(lower);
  const upper = createStorey(null, 'Étage', project.model);
  project.model.storeys.push(upper);
  return project;
}

const finding = (code: string, params: Finding['params'] = {}, severity: Finding['severity'] = 'warn'): Finding => ({ code, severity, params });

describe('du constat à l’endroit à corriger', () => {
  it('chaque code émis par le moteur mène quelque part de valide', () => {
    const project = twoStoreys();
    for (const code of FINDING_CODES) {
      const target = jumpTargetFor(finding(code), project);
      expect(target, code).not.toBeNull();
      if (!target) continue;
      if (target.step === 'plan') {
        expect(PLAN_STEP_KEYS, code).toContain(target.planStep);
        expect(project.model.storeys.map((s) => s.id), code).toContain(target.storeyId);
      } else if (target.step === 'questions') {
        expect(relevantQuestions(project), code).toContain(target.question);
      } else {
        expect(EXPERT_TABS, code).toContain(target.tab);
      }
      // Le bouton a un libellé dans les deux langues.
      const key = jumpLabelKey(target);
      expect(t('fr', key), `${code} → ${key}`).not.toBe(key);
      expect(t('de', key), `${code} → ${key}`).not.toBe(key);
    }
  });

  it('ne connaît que des codes que le moteur peut émettre', () => {
    const known: readonly string[] = FINDING_CODES;
    for (const code of JUMP_CODES) expect(known, code).toContain(code);
  });

  it('ouvre l’étage nommé par le constat (identifiant, sinon nom)', () => {
    const project = twoStoreys();
    const [lower, upper] = project.model.storeys as [Project['model']['storeys'][number], Project['model']['storeys'][number]];

    expect(jumpTargetFor(finding('scale.unconfirmed', { storey: 'Étage', storeyId: upper.id }), project)).toEqual({
      step: 'plan',
      storeyId: upper.id,
      planStep: 'scale',
      focus: null,
    });
    // Identifiant inconnu (étage renommé ou supprimé depuis) : on retombe sur le nom.
    expect(jumpTargetFor(finding('storey.outlineInvalid', { storey: 'Étage', storeyId: 'disparu' }), project)).toMatchObject({ storeyId: upper.id, planStep: 'outline' });
    // Constat entre deux étages : celui du haut d'abord.
    expect(jumpTargetFor(finding('stepback.byAreas', { lower: lower.name, upper: upper.name }), project)).toMatchObject({ storeyId: upper.id });
    // Personne de nommé : le premier étage.
    expect(jumpTargetFor(finding('north.default', { angle: 0 }), project)).toMatchObject({ step: 'plan', storeyId: lower.id, planStep: 'north' });
  });

  it('met en avant le bon champ du panneau pour les hauteurs et la surface nette', () => {
    const project = twoStoreys();
    const upper = project.model.storeys[1]!;
    // La hauteur d'étage brute est une étape de la liste guidée ; la hauteur libre, facultative, reste dans le panneau.
    expect(jumpTargetFor(finding('height.default', { storeyId: upper.id }), project)).toEqual({ step: 'plan', storeyId: upper.id, planStep: 'height', focus: null });
    expect(jumpTargetFor(finding('clearHeight.aboveGross', { storeyId: upper.id }), project)).toMatchObject({ planStep: 'height', focus: 'heights' });
    expect(jumpTargetFor(finding('clearHeight.default', { storeyId: upper.id }), project)).toMatchObject({ planStep: 'height', focus: 'heights' });
    expect(jumpTargetFor(finding('an.estimated', { storeyId: upper.id }), project)).toMatchObject({ planStep: 'rooms', focus: 'netArea', storeyId: upper.id });
    expect(jumpLabelKey(jumpTargetFor(finding('height.default'), project)!)).toBe('shell.jump.plan.height');
    expect(jumpLabelKey(jumpTargetFor(finding('clearHeight.default'), project)!)).toBe('shell.jump.plan.heights');
  });

  it('va à l’étage qui a des pièces à trancher', () => {
    const project = twoStoreys();
    const upper = project.model.storeys[1]!;
    upper.rooms.push({ id: 'r1', name: 'Grenier', area: { value: 20, from: 'plan' }, heated: false, needsReview: true });
    expect(jumpTargetFor(finding('rooms.needReview', { count: 1 }), project)).toMatchObject({ storeyId: upper.id, planStep: 'rooms' });
  });

  it('renvoie la toiture et le plancher bas aux questions, les types et lignes manuelles au mode expert', () => {
    const project = twoStoreys();
    expect(jumpTargetFor(finding('top.default'), project)).toEqual({ step: 'questions', question: 'closure', part: 'top' });
    expect(jumpTargetFor(finding('bottom.default'), project)).toEqual({ step: 'questions', question: 'closure', part: 'bottom' });
    expect(jumpTargetFor(finding('roof.pitchImplausible'), project)).toMatchObject({ question: 'closure', part: 'top' });
    expect(jumpTargetFor(finding('uvalues.missing', { count: 3 }, 'info'), project)).toEqual({ step: 'expert', tab: 'constructions' });
    expect(jumpTargetFor(finding('abzug.dangling', { count: 1 }), project)).toEqual({ step: 'expert', tab: 'manual' });
    expect(jumpLabelKey({ step: 'questions', question: 'year', part: null })).toBe('shell.jump.question');
  });

  it('sans étage, le constat bloquant mène au plan (étage à créer) ; un code inconnu ne propose rien', () => {
    const project = createEmptyProject('fr');
    expect(jumpTargetFor(finding('model.noStorey', {}, 'block'), project)).toEqual({ step: 'plan', storeyId: null, planStep: 'outline', focus: null });
    expect(jumpTargetFor(finding('code.inventé'), project)).toBeNull();
  });
});
