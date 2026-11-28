/**
 * Application Plan2CPE : barre du haut toujours visible, écran courant, mode expert, messages brefs.
 * Raccourcis : Ctrl+Z annule, Ctrl+Maj+Z (ou Ctrl+Y) rétablit. Un fichier déposé n'importe où est pris en charge.
 */
import { useEffect, useRef, useState } from 'react';
import { ClosedFormatDialog } from './components/ClosedFormatDialog';
import { AnnounceProvider, useT } from './components/common';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DoubtsScreen } from './components/DoubtsScreen';
import { ExpertPanel } from './components/ExpertPanel';
import { FixBanner, GuidedReason } from './components/FixBanner';
import { handleDroppedFiles, HomeScreen } from './components/HomeScreen';
import { Icon } from './components/icons';
import { PlanScreen } from './components/PlanScreen';
import { OverviewScreen } from './components/OverviewScreen';
import { QuestionsScreen } from './components/QuestionsScreen';
import { ReadScreen } from './components/ReadScreen';
import { ResultScreen } from './components/ResultScreen';
import { TopBar } from './components/TopBar';
import './messages';
import { getShellStore, ShellStoreContext, useShell, useShellStore } from './store';
import type { ShellStore } from './store';
import type { Step } from './types';

const TOAST_MS = 5000;

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true;
  if (target.tagName !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'file', 'range', 'submit'].includes(type);
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

function ToastView() {
  const tr = useT();
  const store = useShellStore();
  const toast = useShell((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => store.getState().dismissToast(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, store]);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast ? (
        <div className={`toast toast--${toast.tone}`} key={toast.id} data-testid="toast">
          <span>{toast.text}</span>
          <button type="button" className="toast__close" onClick={() => store.getState().dismissToast()} aria-label={tr('shell.close')}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Screen({ step }: { step: Step }) {
  switch (step) {
    case 'home':
      return <HomeScreen />;
    case 'read':
      return (
        <>
          <GuidedReason />
          <ReadScreen />
        </>
      );
    case 'plan':
      return (
        <>
          <FixBanner />
          <PlanScreen />
        </>
      );
    case 'questions':
      return <QuestionsScreen />;
    case 'result':
      return <ResultScreen />;
    case 'overview':
      return <OverviewScreen />;
    case 'doubts':
      return <DoubtsScreen />;
    case 'dossier':
      return <ResultScreen variant="dossier" />;
  }
}

function Shell() {
  const tr = useT();
  const store = useShellStore();
  const step = useShell((s) => s.step);
  const lang = useShell((s) => s.lang);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const main = useRef<HTMLElement>(null);

  // Langue du document et titre de l'onglet.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = tr('shell.title');
  }, [lang, tr]);

  // Annuler / rétablir au clavier (hors champs de texte, où le navigateur garde son propre annuler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      if (isTextEntry(e.target)) return;
      e.preventDefault();
      if (key === 'y' || e.shiftKey) store.getState().redo();
      else store.getState().undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  // Dépôt de fichiers n'importe où dans la fenêtre (et jamais de navigation vers le fichier déposé).
  useEffect(() => {
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      dragDepth.current += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onOver = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent): void => {
      dragDepth.current = 0;
      setDragging(false);
      if (!hasFiles(e)) return;
      const handled = e.defaultPrevented;
      e.preventDefault();
      if (!handled) void handleDroppedFiles(store, Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [store]);

  // L'enregistrement en attente est écrit avant que la page ne se ferme ou ne passe en arrière-plan.
  useEffect(() => {
    const flush = (): void => store.getState().flushAutosave();
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [store]);

  // Nouvel écran : on repart du haut, et le focus suit (clavier et lecteurs d'écran ne restent pas sur un bouton disparu).
  const shownStep = useRef(step);
  useEffect(() => {
    // Rien au premier affichage (ni au double passage des effets en mode strict) : seulement quand l'écran change.
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (step !== 'questions' && step !== 'doubts') main.current?.focus({ preventScroll: true });
    if (typeof window.scrollTo !== 'function') return;
    try {
      window.scrollTo({ top: 0 });
    } catch {
      // Environnement sans défilement (tests).
    }
  }, [step]);

  return (
    <div className={`app app--${step}`}>
      <a className="skip-link" href="#main">
        {tr('shell.skip')}
      </a>
      <TopBar />
      <main id="main" ref={main} className="app__main" tabIndex={-1}>
        <ErrorBoundary
          title={tr('shell.error.screen.title')}
          text={tr('shell.error.text')}
          retryLabel={tr('shell.error.retry')}
          undoLabel={tr('shell.undo')}
          onUndo={() => store.getState().undo()}
          resetKey={step}
        >
          <Screen step={step} />
        </ErrorBoundary>
      </main>
      <ExpertPanel />
      <ClosedFormatDialog />
      <ToastView />
      {dragging && step !== 'home' ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay__box">
            <Icon name="upload" size={34} />
            <span>{tr('shell.drop.anywhere')}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Racine de l'application. `store` permet de fournir un magasin isolé (tests). */
export function App({ store }: { store?: ShellStore }) {
  return (
    <ShellStoreContext.Provider value={store ?? getShellStore()}>
      <AnnounceProvider>
        <Shell />
      </AnnounceProvider>
    </ShellStoreContext.Provider>
  );
}
