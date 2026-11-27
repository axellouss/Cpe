/**
 * État de l'application : UN magasin zustand (projet, documents chargés, écran courant, langue, historique
 * annuler / rétablir avec fusion, état d'interface).
 *
 * Règles :
 *  - le projet et les repères d'avancement ne changent QUE par `apply` : chaque changement passe par l'historique ;
 *  - le projet (jamais les plans) est enregistré tout seul dans le navigateur, avec repli silencieux ;
 *  - les adresses d'objets des fonds de plan sont libérées dès qu'un document est retiré ou remplacé.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { createContext, useContext } from 'react';
import type { BottomKind, Lang, Project, ProjectAnswers, Storey, TopClosure } from '../../core/types';
import { carryOverFromPrevious, createEmptyProject } from '../../engine';
import { projectFileErrorMessage } from '../../export';
import { t } from '../../i18n';
import { readPlanFile, UnsupportedFormatError } from '../../readers';
import type { FileLike } from '../../readers';
import type { PlanTool } from '../plan';
import { browserStorage, clearWorkspace, dropLegacyEntered, initialLang, loadPosition, loadWorkspace, parseWorkspace, saveLang, savePosition, saveWorkspace } from './autosave';
import type { StorageLike, StoredWorkspace } from './autosave';
import { dropStoreyMarks, firstOpenStep, markPlanStep, nextOpenStep, sameScaleStoreyIds, stepOfTool, storeySteps } from './checklist';
import {
  applyProposal,
  defaultStoreyName,
  distinctFileName,
  documentSignature,
  findSheet,
  includedSheets,
  proposeStoreys,
  relocalizeProposal,
  toLoadedDocument,
} from './documents';
import type { Proposal } from './documents';
import { canRedo, canUndo, commit, createHistory, redo as redoHistory, sealHistory, undo as undoHistory } from './history';
import type { History } from './history';
import type { JumpTarget } from './jump';
import './messages';
import {
  addStorey as addStoreyOp,
  assignSheet as assignSheetOp,
  confirmNorth,
  confirmScale,
  confirmStoreyHeight,
  duplicateStorey as duplicateStoreyOp,
  findStorey,
  moveStorey as moveStoreyOp,
  removeStorey as removeStoreyOp,
  renameStorey as renameStoreyOp,
  relocalizeDefaults,
  replaceStorey,
  setAnswers,
  setBottom as setBottomOp,
  setNorth,
  setTop as setTopOp,
} from './modelOps';
import {
  clearedAnswers,
  firstOpenQuestion,
  hasAnyAnswer,
  isQuestionComplete,
  markQuestion,
  nextQuestion,
  previousQuestion,
  QUESTION_ORDER,
  relevantQuestions,
  REQUIRED_QUESTIONS,
} from './questions';

/** Première question du parcours : la seule indispensable. */
const FIRST_QUESTION: QuestionId = QUESTION_ORDER[0]!;
import { emptyMarks } from './types';
import type { ClosedFile, ExpertTab, LoadedDocument, Marks, PlanStepKey, QuestionId, ReadingItem, Step, Toast, Workspace } from './types';

// ───────────────────────────── Dépendances injectables ─────────────────────────────

export interface ShellDeps {
  storage: StorageLike | null;
  now: () => number;
  revokeUrl: (url: string) => void;
  /** Délai de l'enregistrement automatique (ms) ; 0 = immédiat (tests). */
  autosaveDelay: number;
  /** Va chercher le plan d'exemple ; lève une erreur s'il est absent. */
  fetchSample: () => Promise<FileLike>;
  languages: readonly string[];
}

const SAMPLE_PATH = './samples/maison-exemple.dxf';
/** Nom du plan d'exemple fourni avec l'application : un projet né de lui peut le recharger d'un geste. */
export const SAMPLE_NAME = 'maison-exemple.dxf';

async function fetchSampleFromServer(): Promise<FileLike> {
  const response = await fetch(SAMPLE_PATH);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.arrayBuffer();
  // Un serveur qui renvoie la page d'accueil pour toute adresse inconnue ne doit pas passer pour un plan.
  const head = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(64, data.byteLength))).trimStart().toLowerCase();
  if (data.byteLength < 200 || head.startsWith('<!doctype') || head.startsWith('<html')) throw new Error('sample-missing');
  return { name: SAMPLE_NAME, arrayBuffer: async () => data };
}

function defaultDeps(): ShellDeps {
  return {
    storage: browserStorage(),
    now: () => Date.now(),
    revokeUrl: (url) => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Adresse déjà libérée ou environnement sans URL : sans conséquence.
      }
    },
    autosaveDelay: 400,
    fetchSample: fetchSampleFromServer,
    languages: typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [],
  };
}

// ───────────────────────────── État ─────────────────────────────

export interface ApplyOptions {
  /** Clé de fusion : les changements de même clé qui se suivent de près ne font qu'un pas d'historique. */
  key?: string;
  /** Nom de l'action (clé de traduction « shell.undo.* ») dit à l'utilisateur quand il annule. */
  label?: string;
  window?: number;
  /**
   * Changement invisible (question marquée « vue ») : l'état courant est remplacé sans ouvrir de pas d'historique,
   * pour qu'« annuler » ne paraisse jamais sans effet.
   */
  silent?: boolean;
}

export interface SavedProjectInfo {
  name: string;
  storeys: number;
}

export interface ShellState {
  lang: Lang;
  step: Step;
  history: History<Workspace>;
  documents: LoadedDocument[];
  /** Proposition en cours sur l'écran « Voici ce que j'ai lu ». */
  proposal: Proposal | null;
  reading: ReadingItem[];
  busy: boolean;
  closedFiles: ClosedFile[];

  storeyId: string | null;
  planStep: PlanStepKey;
  planFocus: 'heights' | 'netArea' | null;
  /** Dernière étape validée (déclenche la petite coche animée). */
  celebrate: { key: string; id: number } | null;

  question: QuestionId;
  questionPart: 'top' | 'bottom' | null;

  expertOpen: boolean;
  expertTab: ExpertTab;
  /** Lignes du résultat cochées « saisies dans LuxEeB-Tool ». */

  toast: Toast | null;
  /** Projet retrouvé dans le navigateur au démarrage, pas encore repris. */
  saved: SavedProjectInfo | null;
  /** État de l'enregistrement automatique. */
  saveState: 'idle' | 'saved' | 'failed' | 'off';

  setLang(lang: Lang): void;
  goTo(step: Step): void;
  apply(updater: (workspace: Workspace) => Workspace, options?: ApplyOptions): void;
  updateProject(updater: (project: Project) => Project, options?: ApplyOptions): void;
  undo(): void;
  redo(): void;
  showToast(text: string, tone?: Toast['tone']): void;
  dismissToast(): void;

  ingestFiles(files: readonly FileLike[]): Promise<void>;
  loadSample(): Promise<void>;
  startBlank(): void;
  openProjectText(json: string): boolean;
  resumeSaved(): void;
  discardSaved(): void;
  newProject(): void;
  removeDocument(id: string): void;
  /** Relit un document dont le fichier d'origine est encore sous la main (remarques dans la langue actuelle). */
  rereadDocument(id: string): Promise<void>;
  dismissClosedFiles(): void;

  setProposal(proposal: Proposal): void;
  setProposalMode(mode: Proposal['mode']): void;
  acceptProposal(): void;

  selectStorey(storeyId: string): void;
  selectPlanStep(key: PlanStepKey): void;
  confirmPlanStep(key: PlanStepKey): void;
  toolDone(tool: PlanTool): void;
  storeyChanged(next: Storey): void;
  northChanged(angle: number): void;
  addStorey(sheetId: string | null): void;
  duplicateStorey(storeyId: string): void;
  removeStorey(storeyId: string): void;
  moveStorey(storeyId: string, delta: -1 | 1): void;
  renameStorey(storeyId: string, name: string): void;
  assignSheet(storeyId: string, sheetId: string | null): void;
  clearPlanFocus(): void;

  openQuestion(id: QuestionId, part?: 'top' | 'bottom' | null): void;
  answer(patch: Partial<ProjectAnswers>, key?: string): void;
  answerYear(year: number | null, fromPeriod: boolean): void;
  /** `confirmed = false` : détails d'un toit incliné encore à confirmer (voir `modelOps.setTop`). */
  setTop(patch: Partial<Omit<TopClosure, 'from'>>, key?: string, confirmed?: boolean): void;
  setBottom(kind: BottomKind): void;
  continueQuestion(): void;
  /** Marque la question courante comme vue et va droit au résultat (les notes de visite restent facultatives). */
  finishQuestions(): void;
  skipQuestion(): void;
  backQuestion(): void;

  toggleEntered(key: string): void;
  jumpTo(target: JumpTarget): void;
  setExpert(open: boolean, tab?: ExpertTab): void;

  /** Écrit tout de suite l'enregistrement en attente (fermeture de la page, tests). */
  flushAutosave(): void;
  /** Arrête les minuteries (tests, démontage). */
  dispose(): void;
}

export type ShellStore = StoreApi<ShellState>;

// ───────────────────────────── Sélecteurs ─────────────────────────────

export const selectWorkspace = (s: ShellState): Workspace => s.history.present;
export const selectProject = (s: ShellState): Project => s.history.present.project;
export const selectMarks = (s: ShellState): Marks => s.history.present.marks;
export const selectCanUndo = (s: ShellState): boolean => canUndo(s.history);
export const selectCanRedo = (s: ShellState): boolean => canRedo(s.history);

/** Étage affiché sur l'écran « Plan » : celui choisi s'il existe encore, sinon le premier. */
export function currentStorey(state: ShellState): Storey | null {
  const project = selectProject(state);
  return findStorey(project, state.storeyId) ?? project.model.storeys[0] ?? null;
}

/** Vrai si l'écran est accessible depuis la barre d'étapes. */
export function canGoTo(state: ShellState, step: Step): boolean {
  switch (step) {
    case 'home':
      return true;
    case 'read':
      return state.documents.length > 0;
    case 'plan':
      return selectProject(state).model.storeys.length > 0;
    case 'questions':
    case 'result':
      return true;
  }
}

function isEmptyWorkspace(workspace: Workspace): boolean {
  const { model, answers } = workspace.project;
  if (model.storeys.length > 0 || model.manualRows.length > 0) return false;
  return Object.values(answers).every((v) => v === null || v === '');
}

function savedInfo(workspace: Workspace): SavedProjectInfo {
  return { name: workspace.project.answers.projectName.trim(), storeys: workspace.project.model.storeys.length };
}

/** Pas d'historique qui remplacent le bâtiment : les annuler ou les rétablir ramène un autre projet, avec ses coches. */
const PROJECT_SWAP_LABELS: ReadonlySet<string> = new Set(['shell.undo.openProject', 'shell.undo.newProject', 'shell.undo.acceptProposal']);

/**
 * Annuler ou rétablir ne touche pas aux lignes cochées « saisies dans LuxEeB-Tool » : ce que l'expert a déjà
 * reporté dans l'outil reste reporté. (Une ligne dont une valeur change perd de toute façon sa coche : sa clé
 * porte l'empreinte des valeurs à saisir.) Exception : le pas qui ramène un autre projet reprend ses coches à lui.
 */
function keepEntered(history: History<Workspace>, before: Workspace, label: string | null | undefined): History<Workspace> {
  const present = history.present;
  if (present.marks.entered === before.marks.entered || (label && PROJECT_SWAP_LABELS.has(label))) return history;
  return { ...history, present: { ...present, marks: { ...present.marks, entered: before.marks.entered } } };
}

// ───────────────────────────── Fabrique ─────────────────────────────

export function createShellStore(overrides: Partial<ShellDeps> = {}): ShellStore {
  const deps: ShellDeps = { ...defaultDeps(), ...overrides };
  const lang = initialLang(deps.storage, deps.languages);
  dropLegacyEntered(deps.storage);
  const found = loadWorkspace(deps.storage);
  const saved = found && !isEmptyWorkspace(found) ? savedInfo(found) : null;

  /**
   * Fichiers d'origine des documents lus pendant cette session (références du navigateur, pas leur contenu) :
   * ils permettent de relire un plan d'un geste, par exemple dans l'autre langue. Jamais enregistrés.
   */
  const sources = new Map<string, FileLike>();
  let toastSerial = 0;
  let celebrateSerial = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSave: Workspace | null = null;
  /** Dernier état écrit avec succès : évite de réécrire le même, et dit s'il existe déjà un enregistrement de cette session. */
  let lastSaved: Workspace | null = null;

  const store = createStore<ShellState>()((set, get) => {
    const toast = (text: string, tone: Toast['tone'] = 'info'): void => {
      set({ toast: { id: ++toastSerial, text, tone } });
    };
    const tr = (key: string, params?: Record<string, string | number>): string => t(get().lang, key, params);

    const writeSave = (): void => {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const workspace = pendingSave;
      pendingSave = null;
      if (!workspace || workspace === lastSaved) return;
      if (!deps.storage) {
        set({ saveState: 'off' });
        return;
      }
      const result = saveWorkspace(deps.storage, workspace, get().lang);
      if (result.ok) {
        lastSaved = workspace;
        if (get().saveState !== 'saved') set({ saveState: 'saved' });
      } else {
        if (get().saveState !== 'failed') {
          set({ saveState: 'failed' });
          toast(result.error instanceof Error && result.error.name === 'ProjectFileError' ? projectFileErrorMessage(result.error, get().lang) : tr('shell.save.failed.title'), 'warn');
        }
      }
    };

    const scheduleSave = (workspace: Workspace): void => {
      // Un projet vide n'écrase pas un projet enregistré que l'utilisateur n'a pas encore repris ou écarté.
      if (isEmptyWorkspace(workspace) && (get().saved !== null || lastSaved === null)) return;
      pendingSave = workspace;
      if (deps.autosaveDelay <= 0) {
        writeSave();
        return;
      }
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(writeSave, deps.autosaveDelay);
    };

    const apply = (updater: (workspace: Workspace) => Workspace, options: ApplyOptions = {}): void => {
      const state = get();
      const current = state.history.present;
      const next = updater(current);
      if (next === current || (next.project === current.project && next.marks === current.marks)) return;
      if (options.silent) {
        set({ history: { ...state.history, present: next } });
        scheduleSave(next);
        return;
      }
      const commitOptions: Parameters<typeof commit>[2] = { now: deps.now() };
      if (options.key !== undefined) commitOptions.key = options.key;
      if (options.label !== undefined) commitOptions.label = options.label;
      if (options.window !== undefined) commitOptions.window = options.window;
      const history = commit(state.history, next, commitOptions);
      // Commencer un autre travail remplace le projet retrouvé au démarrage.
      set(state.saved !== null && !isEmptyWorkspace(next) ? { history, saved: null } : { history });
      scheduleSave(next);
    };

    const updateProject = (updater: (project: Project) => Project, options?: ApplyOptions): void => {
      apply((ws) => {
        const project = updater(ws.project);
        return project === ws.project ? ws : { ...ws, project };
      }, options);
    };

    const stepsOf = (storey: Storey): ReturnType<typeof storeySteps> => {
      const state = get();
      return storeySteps(selectProject(state), storey, selectMarks(state), state.documents);
    };

    /** Après une validation : petite coche, puis on passe à la prochaine étape ouverte de l'étage. */
    const advanceAfter = (storeyId: string, key: PlanStepKey): void => {
      const storey = findStorey(selectProject(get()), storeyId);
      if (!storey) return;
      const steps = stepsOf(storey);
      const next = nextOpenStep(steps, key);
      set({ celebrate: { key: `${storeyId}:${key}`, id: ++celebrateSerial }, planStep: next ?? key });
    };

    const revokeAll = (documents: readonly LoadedDocument[]): void => {
      for (const d of documents) for (const url of d.urls) deps.revokeUrl(url);
    };

    const enterPlan = (storeyId: string | null): void => {
      const state = get();
      const project = selectProject(state);
      const storey = findStorey(project, storeyId) ?? project.model.storeys[0] ?? null;
      set({
        step: 'plan',
        storeyId: storey?.id ?? null,
        planStep: storey ? firstOpenStep(stepsOf(storey)) : 'outline',
        planFocus: null,
      });
    };

    /**
     * Noms par défaut (niveaux reconnus, types de parois) d'un projet enregistré dans une AUTRE langue, mis dans la
     * langue actuelle. `from` = langue enregistrée avec le projet ; inconnue (ancien fichier) ou identique : on ne
     * touche à rien — sinon un étage que l'expert a lui-même nommé « Obergeschoss » serait rebaptisé à chaque reprise.
     */
    const inCurrentLang = (workspace: Workspace, from: Lang | null): Workspace => {
      const lang = get().lang;
      if (from === null || from === lang) return workspace;
      const project = relocalizeDefaults(workspace.project, from, lang);
      return project === workspace.project ? workspace : { ...workspace, project };
    };

    const replaceWorkspace = (workspace: Workspace, label: string): void => {
      apply(() => workspace, { label });
      set((s) => ({ history: sealHistory(s.history) }));
    };

    return {
      lang,
      step: 'home',
      history: createHistory<Workspace>({ project: createEmptyProject(lang), marks: emptyMarks() }),
      documents: [],
      proposal: null,
      reading: [],
      busy: false,
      closedFiles: [],
      storeyId: null,
      planStep: 'scale',
      planFocus: null,
      celebrate: null,
      question: FIRST_QUESTION,
      questionPart: null,
      expertOpen: false,
      expertTab: 'constructions',
      toast: null,
      saved,
      saveState: deps.storage ? 'idle' : 'off',

      setLang(next) {
        const previous = get().lang;
        if (next === previous) return;
        saveLang(deps.storage, next);
        // Les noms par défaut (types de parois, niveaux reconnus) suivent la langue, sans effet s'il n'y en a pas.
        // Ce n'est pas un pas à annuler : tout l'historique est traduit, pour qu'« annuler » défasse la dernière
        // vraie action sans ramener des noms dans l'ancienne langue.
        const relocalise = (ws: Workspace): Workspace => {
          const project = relocalizeDefaults(ws.project, previous, next);
          return project === ws.project ? ws : { ...ws, project };
        };
        const state = get();
        const history: History<Workspace> = {
          ...state.history,
          past: state.history.past.map((entry) => ({ ...entry, state: relocalise(entry.state) })),
          present: relocalise(state.history.present),
          future: state.history.future.map((entry) => ({ ...entry, state: relocalise(entry.state) })),
        };
        // Les étages proposés à l'écran de lecture suivent aussi.
        set({ lang: next, history, proposal: state.proposal ? relocalizeProposal(state.proposal, previous, next) : null });
        if (history.present !== state.history.present) scheduleSave(history.present);
      },

      goTo(step) {
        const state = get();
        if (!canGoTo(state, step)) return;
        if (step === 'plan') {
          enterPlan(state.storeyId);
          return;
        }
        if (step === 'read' && !state.proposal) {
          set({ step, proposal: proposeStoreys(state.documents, selectProject(state), state.lang) });
          return;
        }
        if (step === 'questions') {
          const project = selectProject(state);
          // D'abord la question indispensable tant qu'elle n'est pas répondue ; ensuite la première note pas encore vue.
          const required = REQUIRED_QUESTIONS.find((q) => !isQuestionComplete(q, project));
          const open = firstOpenQuestion(project, selectMarks(state));
          const question = required ?? open ?? (relevantQuestions(project).includes(state.question) ? state.question : FIRST_QUESTION);
          set({ step, question, questionPart: null });
          return;
        }
        set({ step });
      },

      apply,
      updateProject,

      undo() {
        const result = undoHistory(get().history);
        if (!result.changed) {
          toast(tr('shell.undo.nothing'));
          return;
        }
        const history = keepEntered(result.history, get().history.present, result.label);
        set({ history });
        scheduleSave(history.present);
        toast(result.label ? tr('shell.undo.done', { what: tr(result.label) }) : tr('shell.undo.doneBare'));
      },

      redo() {
        const result = redoHistory(get().history);
        if (!result.changed) {
          toast(tr('shell.redo.nothing'));
          return;
        }
        const history = keepEntered(result.history, get().history.present, result.label);
        set({ history });
        scheduleSave(history.present);
        toast(result.label ? tr('shell.redo.done', { what: tr(result.label) }) : tr('shell.redo.doneBare'));
      },

      showToast: toast,
      dismissToast() {
        if (get().toast !== null) set({ toast: null });
      },

      async ingestFiles(files) {
        if (files.length === 0 || get().busy) return;
        set({ busy: true, reading: files.map((f) => ({ name: f.name, status: 'reading' })) });
        const closed: ClosedFile[] = [];
        const readIds: string[] = [];
        let read = 0;
        for (let i = 0; i < files.length; i++) {
          const file = files[i]!;
          const mark = (status: ReadingItem['status'], message?: string): void => {
            set((s) => ({
              reading: s.reading.map((r, k) => (k === i ? (message === undefined ? { name: r.name, status } : { name: r.name, status, message }) : r)),
            }));
          };
          try {
            const doc = await readPlanFile(file, { lang: get().lang });
            const signature = documentSignature(doc, (file as { size?: number }).size);
            let loaded = toLoadedDocument(doc, signature, get().lang);
            const sameName = get().documents.find((d) => d.id === loaded.id);
            if (sameName && sameName.signature !== undefined && sameName.signature !== signature) {
              // Un AUTRE fichier du même nom (plan.pdf d'un second dossier) : il ne doit pas prendre la place du
              // premier ni glisser son dessin sous des étages déjà tracés. On le garde à côté, sous un nom distinct.
              const renamed = distinctFileName(doc.fileName, get().documents.map((d) => d.id));
              loaded = toLoadedDocument({ ...doc, fileName: renamed }, signature, get().lang);
              toast(tr('shell.read.sameName', { name: doc.fileName, renamed }), 'warn');
            }
            // Le fichier reste relisible tant qu'il porte son propre nom (pas celui, distinct, d'un homonyme).
            if (loaded.id === file.name) {
              sources.set(loaded.id, file);
              loaded = { ...loaded, rereadable: true };
            }
            const previous = get().documents.find((d) => d.id === loaded.id);
            // Le même fichier redéposé remplace l'ancien : ses adresses d'objets sont libérées (sauf celles reprises).
            if (previous) for (const url of previous.urls) if (!loaded.urls.includes(url)) deps.revokeUrl(url);
            set((s) => ({ documents: [...s.documents.filter((d) => d.id !== loaded.id), loaded] }));
            readIds.push(loaded.id);
            read++;
            mark('done');
          } catch (error) {
            if (error instanceof UnsupportedFormatError) {
              closed.push({ format: error.format, fileName: error.fileName });
              mark('unsupported');
            } else {
              mark('error', error instanceof Error ? error.message : String(error));
            }
          }
        }
        const state = get();
        const project = selectProject(state);
        const patch: Partial<ShellState> = { busy: false, closedFiles: closed };
        if (read > 0) {
          const proposal = proposeStoreys(state.documents, project, state.lang);
          patch.proposal = proposal;
          // Fichiers de ce dépôt dont une feuille sert déjà de fond à un étage du projet.
          const justRead = state.documents.filter((d) => readIds.includes(d.id));
          const known = justRead.filter((d) => project.model.storeys.some((s) => s.sheetId !== null && d.doc.sheets.some((sh) => sh.id === s.sheetId)));
          const rebound = project.model.storeys.filter((s) => findSheet(known, s.sheetId) !== null).length;
          if (proposal.mode === 'append' && rebound > 0 && known.length === justRead.length && state.step !== 'read') {
            // Projet rouvert dont on redépose les plans : les fonds retrouvent leurs étages, inutile de reconfirmer.
            // (Un fichier réellement nouveau, lui, passe par l'écran de lecture.)
            set(patch);
            enterPlan(state.storeyId);
            toast(tr('shell.read.rebound', { count: rebound }), 'ok');
            return;
          }
          patch.step = 'read';
        }
        set(patch);
      },

      async loadSample() {
        if (get().busy) return;
        let file: FileLike;
        try {
          file = await deps.fetchSample();
        } catch {
          toast(tr('shell.home.sample.missing'), 'warn');
          return;
        }
        await get().ingestFiles([file]);
      },

      startBlank() {
        const state = get();
        const project = selectProject(state);
        if (project.model.storeys.length === 0) {
          let createdId: string | null = null;
          updateProject(
            (p) => {
              const result = addStoreyOp(p, null, defaultStoreyName(0, state.lang));
              createdId = result.storey.id;
              return result.project;
            },
            { label: 'shell.undo.addStorey' },
          );
          enterPlan(createdId);
        } else {
          enterPlan(state.storeyId);
        }
      },

      openProjectText(json) {
        let opened: Workspace;
        let stored: StoredWorkspace;
        try {
          stored = parseWorkspace(json);
        } catch (error) {
          toast(projectFileErrorMessage(error, get().lang), 'warn');
          return false;
        }
        // Un projet enregistré dans l'autre langue prend les noms par défaut de la langue actuelle.
        opened = inCurrentLang({ project: stored.project, marks: stored.marks }, stored.lang);
        const project = opened.project;
        // Les coches « saisi dans LuxEeB-Tool » viennent du fichier ouvert, avec ses autres repères.
        replaceWorkspace(opened, 'shell.undo.openProject');
        set({ saved: null, proposal: null });
        const state = get();
        if (project.model.storeys.length > 0) enterPlan(null);
        else set({ step: 'questions', question: FIRST_QUESTION, questionPart: null });
        toast(tr(state.documents.length === 0 && project.model.storeys.some((s) => s.sheetId !== null) ? 'shell.home.opened.noPlans' : 'shell.home.opened'), 'ok');
        return true;
      },

      resumeSaved() {
        const workspace = loadWorkspace(deps.storage);
        if (!workspace) {
          set({ saved: null });
          toast(tr('shell.home.saved.unreadable'), 'warn');
          return;
        }
        lastSaved = workspace;
        // Lue AVANT de changer d'écran : l'abonnement qui retient la position réécrirait la clé.
        const position = loadPosition(deps.storage);
        // Projet enregistré dans l'autre langue : ses noms par défaut suivent la langue actuelle.
        const asSaved: Workspace = { project: workspace.project, marks: workspace.marks };
        const current = inCurrentLang(asSaved, workspace.lang);
        set({ history: createHistory(current), saved: null, proposal: null, saveState: 'saved' });
        // Langue changée (ou jamais enregistrée) : on réécrit le projet avec la langue actuelle.
        if (current !== asSaved || workspace.lang !== get().lang) scheduleSave(current);
        const storeys = workspace.project.model.storeys;
        if (storeys.length === 0) {
          set({ step: 'questions', question: position?.step === 'questions' ? position.question : FIRST_QUESTION, questionPart: null });
          return;
        }
        // On reprend là où l'on s'était arrêté : résultat, question en cours, ou plan de l'étage affiché.
        const storeyId = storeys.some((s) => s.id === position?.storeyId) ? position!.storeyId : null;
        enterPlan(storeyId);
        if (position?.step === 'result') set({ step: 'result' });
        else if (position?.step === 'questions') set({ step: 'questions', question: position.question, questionPart: null });
      },

      discardSaved() {
        clearWorkspace(deps.storage);
        lastSaved = null;
        set({ saved: null });
      },

      newProject() {
        const state = get();
        revokeAll(state.documents);
        sources.clear();
        replaceWorkspace({ project: createEmptyProject(state.lang), marks: emptyMarks() }, 'shell.undo.newProject');
        clearWorkspace(deps.storage);
        lastSaved = null;
        pendingSave = null;
        set({
          step: 'home',
          documents: [],
          proposal: null,
          reading: [],
          closedFiles: [],
          storeyId: null,
          planStep: 'scale',
          planFocus: null,
          question: FIRST_QUESTION,
          questionPart: null,
          saved: null,
        });
      },

      removeDocument(id) {
        const state = get();
        const doc = state.documents.find((d) => d.id === id);
        if (!doc) return;
        for (const url of doc.urls) deps.revokeUrl(url);
        sources.delete(id);
        const documents = state.documents.filter((d) => d.id !== id);
        const project = selectProject(state);
        set({
          documents,
          proposal: documents.length > 0 ? proposeStoreys(documents, project, state.lang, state.proposal?.mode) : null,
          step: documents.length === 0 && state.step === 'read' ? 'home' : state.step,
        });
      },

      async rereadDocument(id) {
        const file = sources.get(id);
        if (!file || get().busy) return;
        // Même fichier, même empreinte : la lecture remplace le document, dans la langue actuelle.
        await get().ingestFiles([file]);
      },

      dismissClosedFiles() {
        set({ closedFiles: [] });
      },

      setProposal(proposal) {
        set({ proposal });
      },

      setProposalMode(mode) {
        const state = get();
        set({ proposal: proposeStoreys(state.documents, selectProject(state), state.lang, mode) });
      },

      acceptProposal() {
        const state = get();
        const proposal = state.proposal;
        if (!proposal) return;
        const before = selectProject(state);
        const existing = new Set(before.model.storeys.map((s) => s.id));
        const included = includedSheets(proposal).length;
        if (included === 0 && (proposal.mode === 'replace' || before.model.storeys.length === 0)) {
          toast(tr('shell.read.noStorey'), 'warn');
          return;
        }
        if (included > 0) {
          apply(
            (ws) => ({
              project: applyProposal(proposal, state.documents, ws.project, state.lang),
              // Autre bâtiment : ni les étapes validées ni les lignes cochées « saisies » du précédent ne valent encore.
              marks: proposal.mode === 'replace' ? { ...ws.marks, plan: {}, entered: {} } : ws.marks,
            }),
            { label: 'shell.undo.acceptProposal' },
          );
        }
        const after = selectProject(get());
        const firstNew = after.model.storeys.find((s) => !existing.has(s.id));
        set({ proposal: null });
        enterPlan(firstNew?.id ?? get().storeyId);
      },

      selectStorey(storeyId) {
        const storey = findStorey(selectProject(get()), storeyId);
        if (!storey) return;
        set({ storeyId, planStep: firstOpenStep(stepsOf(storey)), planFocus: null });
      },

      selectPlanStep(key) {
        set({ planStep: key, planFocus: null });
      },

      confirmPlanStep(key) {
        const storey = currentStorey(get());
        if (!storey) return;
        const storeyId = storey.id;
        apply(
          (ws) => {
            // Un dessin n'a qu'une unité : l'échelle confirmée ici l'est aussi pour les étages du même fichier qui la partagent.
            if (key === 'scale') return { ...ws, project: [storeyId, ...sameScaleStoreyIds(ws.project, storeyId)].reduce(confirmScale, ws.project) };
            if (key === 'height') return { ...ws, project: confirmStoreyHeight(ws.project, storeyId, 'gross') };
            if (key === 'north') return { ...ws, project: confirmNorth(ws.project) };
            return { ...ws, marks: markPlanStep(ws.marks, storeyId, key) };
          },
          { label: `shell.undo.confirm.${key}` },
        );
        advanceAfter(storeyId, key);
      },

      toolDone(tool) {
        const key = stepOfTool(tool);
        if (key) get().confirmPlanStep(key);
      },

      storeyChanged(next) {
        const tool = get().planStep;
        // Contour retracé ou sommet supprimé : les réglages de façade et les ouvertures de l'ancien contour sont
        // reportés sur le nouveau quand le mur est resté en place ; ce qui est réellement perdu est dit.
        const previous = findStorey(selectProject(get()), next.id);
        const carried = previous ? carryOverFromPrevious(previous, next) : { storey: next, lostOpenings: 0, lostBoundaries: 0 };
        const lost = carried.lostOpenings > 0 || carried.lostBoundaries > 0;
        // Un glissement envoie des dizaines de versions par seconde : elles fusionnent en un seul pas.
        apply(
          (ws) => {
            const project = replaceStorey(ws.project, carried.storey);
            if (!lost) return project === ws.project ? ws : { ...ws, project };
            // Des façades ou des ouvertures ont disparu : ces deux étapes ne sont plus « faites ».
            const steps = { ...ws.marks.plan[next.id] };
            delete steps.boundary;
            delete steps.opening;
            return { project, marks: { ...ws.marks, plan: { ...ws.marks.plan, [next.id]: steps } } };
          },
          { key: `storey:${next.id}:${tool}`, label: `shell.undo.plan.${tool}`, window: 250 },
        );
        if (lost) toast(tr('shell.plan.outline.lost', { openings: carried.lostOpenings, boundaries: carried.lostBoundaries }), 'warn');
      },

      northChanged(angle) {
        updateProject((p) => setNorth(p, angle), { key: 'north', label: 'shell.undo.plan.north', window: 400 });
      },

      addStorey(sheetId) {
        const state = get();
        const project = selectProject(state);
        const sheet = findSheet(state.documents, sheetId);
        const name = defaultStoreyName(project.model.storeys.length, state.lang, project.model.storeys.map((s) => s.name));
        let createdId: string | null = null;
        updateProject(
          (p) => {
            const result = addStoreyOp(p, sheet, name);
            createdId = result.storey.id;
            return result.project;
          },
          { label: 'shell.undo.addStorey' },
        );
        if (createdId) enterPlan(createdId);
      },

      duplicateStorey(storeyId) {
        const state = get();
        const project = selectProject(state);
        const name = defaultStoreyName(project.model.storeys.length, state.lang, project.model.storeys.map((s) => s.name));
        let createdId: string | null = null;
        updateProject(
          (p) => {
            const result = duplicateStoreyOp(p, storeyId, name);
            createdId = result.storey?.id ?? null;
            return result.project;
          },
          { label: 'shell.undo.duplicateStorey' },
        );
        if (createdId) enterPlan(createdId);
      },

      removeStorey(storeyId) {
        const state = get();
        const project = selectProject(state);
        const index = project.model.storeys.findIndex((s) => s.id === storeyId);
        if (index < 0) return;
        const name = project.model.storeys[index]!.name;
        apply((ws) => ({ project: removeStoreyOp(ws.project, storeyId), marks: dropStoreyMarks(ws.marks, storeyId) }), { label: 'shell.undo.removeStorey' });
        const remaining = selectProject(get()).model.storeys;
        const neighbour = remaining[Math.min(index, remaining.length - 1)] ?? null;
        if (neighbour) {
          enterPlan(neighbour.id);
        } else {
          // Plus aucun étage : retour à la lecture des plans s'il y en a, sinon à l'accueil.
          const s = get();
          if (s.documents.length > 0) set({ storeyId: null, step: 'read', proposal: proposeStoreys(s.documents, selectProject(s), s.lang) });
          else set({ storeyId: null, step: 'home' });
        }
        toast(tr('shell.plan.storey.removed', { name }));
      },

      moveStorey(storeyId, delta) {
        updateProject((p) => moveStoreyOp(p, storeyId, delta), { label: 'shell.undo.moveStorey' });
      },

      renameStorey(storeyId, name) {
        updateProject((p) => renameStoreyOp(p, storeyId, name), { key: `rename:${storeyId}`, label: 'shell.undo.renameStorey', window: 1500 });
      },

      assignSheet(storeyId, sheetId) {
        const sheet = findSheet(get().documents, sheetId);
        updateProject((p) => assignSheetOp(p, storeyId, sheet), { label: 'shell.undo.assignSheet' });
        const storey = findStorey(selectProject(get()), storeyId);
        if (storey && get().storeyId === storeyId) set({ planStep: firstOpenStep(stepsOf(storey)) });
      },

      clearPlanFocus() {
        if (get().planFocus !== null) set({ planFocus: null });
      },

      openQuestion(id, part = null) {
        const project = selectProject(get());
        if (!relevantQuestions(project).includes(id)) return;
        set({ step: 'questions', question: id, questionPart: part });
      },

      answer(patch, key) {
        const options: ApplyOptions = { label: 'shell.undo.answer' };
        if (key !== undefined) {
          options.key = `answer:${key}`;
          options.window = 1500;
        }
        updateProject((p) => setAnswers(p, patch), options);
      },

      answerYear(year, fromPeriod) {
        apply(
          (ws) => {
            const project = setAnswers(ws.project, { yearBuilt: year });
            const marks = ws.marks.yearFromPeriod === fromPeriod ? ws.marks : { ...ws.marks, yearFromPeriod: fromPeriod };
            return project === ws.project && marks === ws.marks ? ws : { project, marks };
          },
          fromPeriod ? { label: 'shell.undo.answer' } : { label: 'shell.undo.answer', key: 'answer:yearBuilt', window: 1500 },
        );
      },

      setTop(patch, key, confirmed = true) {
        const options: ApplyOptions = { label: 'shell.undo.top' };
        if (key !== undefined) {
          options.key = `top:${key}`;
          options.window = 1500;
        }
        updateProject((p) => setTopOp(p, patch, confirmed), options);
      },

      setBottom(kind) {
        updateProject((p) => setBottomOp(p, kind), { label: 'shell.undo.bottom' });
      },

      continueQuestion() {
        const state = get();
        const id = state.question;
        const project = selectProject(state);
        const value = isQuestionComplete(id, project) || hasAnyAnswer(id, project) ? 'answered' : 'skipped';
        apply((ws) => ({ ...ws, marks: markQuestion(ws.marks, id, value) }), { silent: true });
        const next = nextQuestion(id, selectProject(get()));
        if (next) set({ question: next, questionPart: null });
        else set({ step: 'result' });
      },

      finishQuestions() {
        const state = get();
        const id = state.question;
        const project = selectProject(state);
        if (isQuestionComplete(id, project) || hasAnyAnswer(id, project)) {
          apply((ws) => ({ ...ws, marks: markQuestion(ws.marks, id, 'answered') }), { silent: true });
        }
        set({ step: 'result' });
      },

      skipQuestion() {
        const id = get().question;
        const cleared = setAnswers(selectProject(get()), clearedAnswers(id));
        apply(
          (ws) => ({
            project: setAnswers(ws.project, clearedAnswers(id)),
            marks: markQuestion(id === 'year' && ws.marks.yearFromPeriod ? { ...ws.marks, yearFromPeriod: false } : ws.marks, id, 'skipped'),
          }),
          // Rien n'était renseigné : seul le repère « vue » change, sans pas d'historique.
          cleared === selectProject(get()) ? { silent: true } : { label: 'shell.undo.skip' },
        );
        const next = nextQuestion(id, selectProject(get()));
        if (next) set({ question: next, questionPart: null });
        else set({ step: 'result' });
      },

      backQuestion() {
        const state = get();
        const previous = previousQuestion(state.question, selectProject(state));
        if (previous) set({ question: previous, questionPart: null });
        else if (canGoTo(state, 'plan')) enterPlan(state.storeyId);
        else set({ step: 'home' });
      },

      toggleEntered(key) {
        // Une coche fait partie des repères du projet (enregistrement automatique, fichier de projet), sans créer
        // d'étape à annuler : « annuler » ne décoche rien (voir keepEntered).
        apply(
          (ws) => {
            const entered = { ...ws.marks.entered };
            if (entered[key]) delete entered[key];
            else entered[key] = true;
            return { ...ws, marks: { ...ws.marks, entered } };
          },
          { silent: true },
        );
      },

      jumpTo(target) {
        const state = get();
        if (target.step === 'expert') {
          set({ expertOpen: true, expertTab: target.tab });
          return;
        }
        if (target.step === 'questions') {
          get().openQuestion(target.question, target.part);
          return;
        }
        const project = selectProject(state);
        if (project.model.storeys.length === 0) {
          // Rien à corriger sans étage : on revient à la lecture des plans s'il y en a, sinon on ouvre une grille vierge.
          if (state.documents.length > 0) get().goTo('read');
          else get().startBlank();
          return;
        }
        const storey = findStorey(project, target.storeyId) ?? project.model.storeys[0]!;
        set({ step: 'plan', storeyId: storey.id, planStep: target.planStep, planFocus: target.focus });
      },

      setExpert(open, tab) {
        set(tab ? { expertOpen: open, expertTab: tab } : { expertOpen: open });
      },

      flushAutosave() {
        writeSave();
      },

      dispose() {
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = null;
        pendingSave = null;
      },
    };
  });

  // La position dans le parcours accompagne le projet enregistré (jamais celle de l'accueil avant une reprise).
  store.subscribe((state, previous) => {
    if (state.step === previous.step && state.storeyId === previous.storeyId && state.question === previous.question) return;
    if (state.saved !== null || isEmptyWorkspace(state.history.present)) return;
    savePosition(deps.storage, { step: state.step, storeyId: state.storeyId, question: state.question });
  });

  return store;
}

// ───────────────────────────── Accès depuis React ─────────────────────────────

let singleton: ShellStore | null = null;

/** Magasin unique de l'application (créé au premier appel). */
export function getShellStore(): ShellStore {
  singleton ??= createShellStore();
  return singleton;
}

/** Permet de fournir un autre magasin à un sous-arbre (tests). */
export const ShellStoreContext = createContext<ShellStore | null>(null);

export function useShellStore(): ShellStore {
  return useContext(ShellStoreContext) ?? getShellStore();
}

/** Lit une partie de l'état. Le sélecteur doit renvoyer une valeur stable (primitive ou référence de l'état). */
export function useShell<T>(selector: (state: ShellState) => T): T {
  return useStore(useShellStore(), selector);
}
