/**
 * Application autour de l'éditeur de plan : écrans, état, questions, résultat.
 * API PUBLIQUE du module src/ui/shell — src/main.tsx n'a besoin que de `App`.
 *
 * Importer ce module enregistre aussi ses textes (« shell.* », FR et DE) dans src/i18n.
 */
import './messages';

export { App } from './App';
export { SHELL_MESSAGES } from './messages';

// État
export { canGoTo, createShellStore, currentStorey, getShellStore, selectMarks, selectProject, ShellStoreContext, useShell, useShellStore } from './store';
export type { ApplyOptions, ShellDeps, ShellState, ShellStore } from './store';
export { STEPS } from './types';
export type { ExpertTab, LoadedDocument, Marks, PlanStepKey, QuestionId, Step, Workspace } from './types';

// Logique pure, réutilisable et testée
export { commit, createHistory, redo, undo } from './history';
export type { History } from './history';
export { planSteps } from './checklist';
export type { PlanStepInfo, StepState } from './checklist';
export { isQuestionComplete, QUESTION_ORDER, questionStatus, relevantQuestions } from './questions';
export { computeMeters } from './meters';
export type { Meters } from './meters';
export { jumpTargetFor } from './jump';
export type { JumpTarget } from './jump';
export { applyProposal, namespaceDocument, proposeStoreys } from './documents';
export type { Proposal, SheetProposal } from './documents';
