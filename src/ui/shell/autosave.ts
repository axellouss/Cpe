/**
 * Enregistrement automatique dans le navigateur (localStorage) : le PROJET et les repères d'avancement, jamais
 * les fichiers de plans. Tout accès au stockage est protégé : navigation privée, quota dépassé ou stockage
 * désactivé ne doivent jamais bloquer l'application — on continue simplement sans enregistrement.
 */
import type { Lang } from '../../core/types';
import { parseProject, serializeProject } from '../../export';
import { emptyMarks } from './types';
import type { Marks, PlanStepKey, QuestionId, Step, Workspace } from './types';
import { PLAN_STEP_KEYS } from './types';

export const STORAGE_KEYS = {
  project: 'plan2cpe.project.v1',
  marks: 'plan2cpe.marks.v1',
  position: 'plan2cpe.position.v1',
  lang: 'plan2cpe.lang',
} as const;

/**
 * Ancienne clé des lignes cochées « saisies », du temps où elles vivaient à part du projet : les coches d'un
 * bâtiment réapparaissaient alors sur le suivant. Elles font maintenant partie des repères ; la clé est effacée.
 */
export const LEGACY_ENTERED_KEY = 'plan2cpe.entered.v1';

/** Garde-fous sur les coches relues d'un fichier ou du stockage. */
const MAX_ENTERED = 5000;
const MAX_ENTERED_KEY_LENGTH = 400;

/** Sous-ensemble de l'interface Storage dont on a besoin (facile à simuler dans les tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Stockage en mémoire : repli quand localStorage est indisponible, et pour les tests. */
export function memoryStorage(initial: Record<string, string> = {}): StorageLike & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

/** localStorage s'il est utilisable (un essai d'écriture le vérifie), sinon null. */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const probe = '__plan2cpe_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(storage: StorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Rien à faire : le stockage est indisponible.
  }
}

// ───────────────────────────── Repères ─────────────────────────────

const QUESTION_IDS: readonly QuestionId[] = ['context', 'year', 'closure', 'insulation', 'windows', 'heating', 'hotWater', 'ventilation', 'solar', 'identity'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reconstruit des repères sûrs à partir de données relues (jamais de confiance aveugle dans le stockage). */
export function sanitizeMarks(raw: unknown): Marks {
  const marks = emptyMarks();
  if (!isRecord(raw)) return marks;
  if (isRecord(raw.plan)) {
    for (const [storeyId, steps] of Object.entries(raw.plan)) {
      // Une clé venue d'un fichier ne doit jamais toucher au prototype de l'objet.
      if (storeyId === '__proto__' || storeyId === 'constructor' || storeyId === 'prototype') continue;
      if (!isRecord(steps)) continue;
      const clean: Partial<Record<PlanStepKey, true>> = {};
      for (const key of PLAN_STEP_KEYS) if (steps[key] === true) clean[key] = true;
      if (Object.keys(clean).length > 0) marks.plan[storeyId] = clean;
    }
  }
  if (isRecord(raw.questions)) {
    for (const id of QUESTION_IDS) {
      const v = raw.questions[id];
      if (v === 'answered' || v === 'skipped') marks.questions[id] = v;
    }
  }
  marks.yearFromPeriod = raw.yearFromPeriod === true;
  if (isRecord(raw.entered)) {
    let kept = 0;
    for (const [key, value] of Object.entries(raw.entered)) {
      if (kept >= MAX_ENTERED) break;
      if (value !== true || key.length === 0 || key.length > MAX_ENTERED_KEY_LENGTH) continue;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      marks.entered[key] = true;
      kept += 1;
    }
  }
  return marks;
}

// ───────────────────────────── Fichier projet (.json) ─────────────────────────────

/**
 * Texte du fichier projet téléchargé : le projet du contrat, plus les repères de validation (champ `marks`) pour
 * qu'un projet rouvert ne redemande pas de confirmer ce qui l'était déjà. Lève une ProjectFileError si le projet
 * n'est pas enregistrable.
 */
export function serializeWorkspace(workspace: Workspace, lang?: Lang): string {
  const data = JSON.parse(serializeProject(workspace.project)) as Record<string, unknown>;
  data.marks = workspace.marks;
  // Langue des noms par défaut (niveaux, types de parois) : sans elle, on ne saurait pas, à la réouverture dans
  // l'autre langue, distinguer un nom par défaut à traduire d'un nom choisi par l'expert.
  if (lang) data.lang = lang;
  return JSON.stringify(data, null, 2);
}

/** Espace de travail relu, avec la langue de ses noms par défaut quand elle a été enregistrée (sinon null). */
export interface StoredWorkspace extends Workspace {
  lang: Lang | null;
}

function storedLang(value: unknown): Lang | null {
  return value === 'fr' || value === 'de' ? value : null;
}

/**
 * Fichier projet → espace de travail. Le projet est validé par `parseProject` (qui lève une ProjectFileError) ;
 * les repères sont relus avec prudence et limités aux étages qui existent. Un fichier sans repères (ancien, ou
 * écrit à la main) s'ouvre avec tout « à confirmer ».
 */
export function parseWorkspace(json: string): StoredWorkspace {
  const project = parseProject(json);
  let marks = emptyMarks();
  let lang: Lang | null = null;
  try {
    const raw: unknown = JSON.parse(json.replace(/^\uFEFF/, ''));
    if (isRecord(raw)) {
      marks = sanitizeMarks(raw.marks);
      lang = storedLang(raw.lang);
    }
  } catch {
    marks = emptyMarks();
  }
  const known = new Set(project.model.storeys.map((s) => s.id));
  for (const id of Object.keys(marks.plan)) if (!known.has(id)) delete marks.plan[id];
  return { project, marks, lang };
}

// ───────────────────────────── Projet ─────────────────────────────

export interface SaveResult {
  ok: boolean;
  /** Erreur de sérialisation (ProjectFileError) ou d'écriture, s'il y en a une. */
  error: unknown;
}

/** Écrit le projet et ses repères. Ne lève jamais : le résultat dit si l'écriture a réussi. */
export function saveWorkspace(storage: StorageLike | null, workspace: Workspace, lang?: Lang): SaveResult {
  if (!storage) return { ok: false, error: null };
  let json: string;
  try {
    json = serializeProject(workspace.project);
  } catch (error) {
    return { ok: false, error };
  }
  // La langue des noms par défaut voyage avec les repères (voir serializeWorkspace).
  const marks = lang ? { ...workspace.marks, lang } : workspace.marks;
  const ok = write(storage, STORAGE_KEYS.project, json) && write(storage, STORAGE_KEYS.marks, JSON.stringify(marks));
  return { ok, error: ok ? null : new Error('storage-write-failed') };
}

/** Relit le projet enregistré ; null s'il n'y en a pas ou s'il est illisible (on repart alors d'un projet vide). */
export function loadWorkspace(storage: StorageLike | null): StoredWorkspace | null {
  const json = read(storage, STORAGE_KEYS.project);
  if (!json) return null;
  try {
    const project = parseProject(json);
    let marks = emptyMarks();
    let lang: Lang | null = null;
    const rawMarks = read(storage, STORAGE_KEYS.marks);
    if (rawMarks) {
      try {
        const parsed: unknown = JSON.parse(rawMarks);
        marks = sanitizeMarks(parsed);
        if (isRecord(parsed)) lang = storedLang(parsed.lang);
      } catch {
        marks = emptyMarks();
      }
    }
    return { project, marks, lang };
  } catch {
    return null;
  }
}

export function clearWorkspace(storage: StorageLike | null): void {
  remove(storage, STORAGE_KEYS.project);
  remove(storage, STORAGE_KEYS.marks);
  remove(storage, STORAGE_KEYS.position);
  remove(storage, LEGACY_ENTERED_KEY);
}

// ───────────────────────────── Position dans le parcours ─────────────────────────────

/** Où l'expert en était : « Reprendre » l'y ramène au lieu de rouvrir toujours le plan du premier étage. */
export interface SavedPosition {
  step: Step;
  storeyId: string | null;
  question: QuestionId;
  /** Étape du plan ouverte ; absente d'un ancien enregistrement. */
  planStep?: PlanStepKey;
}

const STEPS: readonly Step[] = ['home', 'read', 'plan', 'questions', 'result'];

export function savePosition(storage: StorageLike | null, position: SavedPosition): void {
  write(storage, STORAGE_KEYS.position, JSON.stringify(position));
}

/** Position relue avec prudence ; null si absente ou incohérente. */
export function loadPosition(storage: StorageLike | null): SavedPosition | null {
  const raw = read(storage, STORAGE_KEYS.position);
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data)) return null;
    const step = STEPS.find((s) => s === data.step);
    const question = QUESTION_IDS.find((q) => q === data.question);
    if (!step || !question) return null;
    const position: SavedPosition = { step, storeyId: typeof data.storeyId === 'string' && data.storeyId.length < 200 ? data.storeyId : null, question };
    const planStep = PLAN_STEP_KEYS.find((k) => k === data.planStep);
    if (planStep) position.planStep = planStep;
    return position;
  } catch {
    return null;
  }
}

/** Efface l'ancienne clé des coches (voir LEGACY_ENTERED_KEY). Sans effet si elle n'existe pas. */
export function dropLegacyEntered(storage: StorageLike | null): void {
  remove(storage, LEGACY_ENTERED_KEY);
}

// ───────────────────────────── Langue ─────────────────────────────

export function loadLang(storage: StorageLike | null): Lang | null {
  const v = read(storage, STORAGE_KEYS.lang);
  return v === 'fr' || v === 'de' ? v : null;
}

export function saveLang(storage: StorageLike | null, lang: Lang): void {
  write(storage, STORAGE_KEYS.lang, lang);
}

/** Langue de départ : celle retenue, sinon celle du navigateur si c'est l'allemand ou le luxembourgeois, sinon le français. */
export function initialLang(storage: StorageLike | null, navigatorLanguages: readonly string[] = []): Lang {
  const saved = loadLang(storage);
  if (saved) return saved;
  for (const tag of navigatorLanguages) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'fr') return 'fr';
    if (base === 'de' || base === 'lb') return 'de';
  }
  return 'fr';
}
