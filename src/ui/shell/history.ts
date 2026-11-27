/**
 * Historique annuler / rétablir, générique et pur.
 *
 * Fusion (« coalescing ») : deux modifications qui portent la même clé et se suivent de près (glisser un sommet,
 * taper un nombre chiffre après chiffre) ne font qu'UN pas d'historique. Sans clé, chaque modification est un pas.
 */

/** Nombre de pas conservés. */
export const HISTORY_LIMIT = 120;
/** Délai par défaut (ms) en dessous duquel deux modifications de même clé fusionnent. */
export const COALESCE_MS = 900;

export interface HistoryEntry<T> {
  state: T;
  /** Nom (clé de traduction) de l'action qui a remplacé cet état, pour dire à l'utilisateur ce qui est annulé. */
  label: string | null;
}

export interface History<T> {
  past: HistoryEntry<T>[];
  present: T;
  future: HistoryEntry<T>[];
  /** Clé et instant de la dernière modification, pour la fusion. */
  lastKey: string | null;
  lastAt: number;
}

export interface CommitOptions {
  /** Clé de fusion ; absente = toujours un nouveau pas. */
  key?: string;
  /** Nom de l'action (clé de traduction). */
  label?: string;
  /** Instant de la modification (ms). */
  now: number;
  /** Fenêtre de fusion (ms). */
  window?: number;
}

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null, lastAt: 0 };
}

/** Enregistre un nouvel état. Sans effet si l'état est le même objet que l'état courant. */
export function commit<T>(history: History<T>, next: T, options: CommitOptions): History<T> {
  if (next === history.present) return history;
  const window = options.window ?? COALESCE_MS;
  const merges =
    options.key !== undefined &&
    history.lastKey === options.key &&
    history.past.length > 0 &&
    options.now - history.lastAt <= window;
  if (merges) {
    // Même geste qui continue : on remplace l'état courant, le pas précédent reste le point de retour.
    return { ...history, present: next, future: [], lastAt: options.now };
  }
  const past = [...history.past, { state: history.present, label: options.label ?? null }];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: options.key ?? null, lastAt: options.now };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

/** Revient d'un pas. `label` = nom de l'action annulée. */
export function undo<T>(history: History<T>): { history: History<T>; label: string | null; changed: boolean } {
  const entry = history.past[history.past.length - 1];
  if (!entry) return { history, label: null, changed: false };
  return {
    history: {
      past: history.past.slice(0, -1),
      present: entry.state,
      future: [{ state: history.present, label: entry.label }, ...history.future],
      lastKey: null,
      lastAt: 0,
    },
    label: entry.label,
    changed: true,
  };
}

/** Refait le pas annulé. `label` = nom de l'action rétablie. */
export function redo<T>(history: History<T>): { history: History<T>; label: string | null; changed: boolean } {
  const entry = history.future[0];
  if (!entry) return { history, label: null, changed: false };
  return {
    history: {
      past: [...history.past, { state: history.present, label: entry.label }],
      present: entry.state,
      future: history.future.slice(1),
      lastKey: null,
      lastAt: 0,
    },
    label: entry.label,
    changed: true,
  };
}

/** Interrompt la fusion : la prochaine modification ouvrira un nouveau pas, même avec la même clé. */
export function sealHistory<T>(history: History<T>): History<T> {
  return history.lastKey === null ? history : { ...history, lastKey: null, lastAt: 0 };
}
