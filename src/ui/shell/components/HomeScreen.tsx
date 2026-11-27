/**
 * Accueil : grande zone de dépôt, exemple, grille vierge, reprise d'un projet.
 * Dit clairement que les fichiers ne quittent jamais l'ordinateur.
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { t } from '../../../i18n';
import { readFileText } from '../browser';
import { useShell, useShellStore } from '../store';
import type { ShellStore } from '../store';
import { useT } from './common';
import { Icon } from './icons';

/** Extensions proposées par le sélecteur de fichiers : les formats lisibles, et les formats fermés pour pouvoir les expliquer. */
export const PLAN_ACCEPT = '.ifc,.dwg,.dxf,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.pln,.pla,.rvt,.skp,.json';

/** Répartit des fichiers déposés : les .json sont des projets Plan2CPE, le reste des plans. */
export async function handleDroppedFiles(store: ShellStore, files: readonly File[]): Promise<void> {
  if (files.length === 0) return;
  const projects = files.filter((f) => /\.json$/i.test(f.name));
  const plans = files.filter((f) => !/\.json$/i.test(f.name));
  const first = projects[0];
  if (first) {
    try {
      store.getState().openProjectText(await readFileText(first));
    } catch {
      store.getState().showToast(t(store.getState().lang, 'shell.home.open.failed', { file: first.name }), 'warn');
    }
  }
  if (plans.length > 0) await store.getState().ingestFiles(plans);
}

export function ReadingList() {
  const tr = useT();
  const reading = useShell((s) => s.reading);
  const busy = useShell((s) => s.busy);
  const visible = reading.filter((r) => busy || r.status === 'error');
  if (visible.length === 0) return null;
  return (
    <ul className="reading" aria-live="polite">
      {visible.map((r, i) => (
        <li key={`${r.name}-${i}`} className={`reading__item reading__item--${r.status}`}>
          {r.status === 'reading' ? <span className="spinner" aria-hidden="true" /> : <Icon name={r.status === 'done' ? 'check' : r.status === 'error' ? 'warning' : 'info'} size={16} />}
          <span className="reading__name">{r.name}</span>
          <span className="reading__status">
            {tr(`shell.home.reading.${r.status}`)}
            {r.status === 'error' && r.message ? ` — ${r.message}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function HomeScreen() {
  const tr = useT();
  const store = useShellStore();
  const busy = useShell((s) => s.busy);
  const saved = useShell((s) => s.saved);
  const hasWork = useShell((s) => s.history.present.project.model.storeys.length > 0);
  const [over, setOver] = useState(false);
  // « Effacer » le projet retrouvé demande une confirmation dans la page : c'est parfois la seule copie du travail.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const keepButton = useRef<HTMLButtonElement>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
  /** Où remettre le focus quand la confirmation se referme : sur « Effacer » (on garde), ou sur le choix de fichiers (effacé). */
  const focusAfter = useRef<'discard' | 'pick' | null>(null);
  const depth = useRef(0);
  const planInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (confirmDiscard) {
      keepButton.current?.focus();
      return;
    }
    if (focusAfter.current === 'discard') discardButton.current?.focus();
    if (focusAfter.current === 'pick') planInput.current?.focus();
    focusAfter.current = null;
  }, [confirmDiscard]);
  useEffect(() => {
    if (!saved) setConfirmDiscard(false);
  }, [saved]);
  const keepProject = (): void => {
    focusAfter.current = 'discard';
    setConfirmDiscard(false);
  };
  const projectInput = useRef<HTMLInputElement>(null);

  const onPick = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    void handleDroppedFiles(store, files);
  };

  const onDrop = (e: DragEvent): void => {
    // Pas de stopPropagation : l'écouteur global (App) voit que le dépôt est déjà traité et range son propre état.
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    void handleDroppedFiles(store, Array.from(e.dataTransfer.files));
  };

  return (
    <section className="home" aria-labelledby="home-title">
      <div className="home__hero">
        <h1 id="home-title">{tr('shell.home.title')}</h1>
        <p className="lead">{tr('shell.home.lead')}</p>
      </div>

      {saved ? (
        <div
          className="notice notice--info home__saved"
          role="region"
          aria-label={tr('shell.home.saved.title')}
          // Échap pendant la confirmation : on garde le projet.
          onKeyDown={(e) => {
            if (e.key === 'Escape' && confirmDiscard) {
              e.stopPropagation();
              keepProject();
            }
          }}
        >
          <Icon name="folder" />
          {confirmDiscard ? (
            <>
              <div className="notice__body" role="alert" data-testid="discard-confirm">
                <strong>{tr('shell.home.saved.discard.ask', { name: saved.name || tr('shell.home.saved.unnamed') })}</strong>
                <span>{tr('shell.home.saved.discard.warn')}</span>
              </div>
              <div className="notice__actions">
                <button type="button" className="btn btn--primary" onClick={keepProject} ref={keepButton} data-testid="discard-cancel">
                  {tr('shell.home.saved.discard.keep')}
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    focusAfter.current = 'pick';
                    store.getState().discardSaved();
                    store.getState().showToast(tr('shell.home.saved.discarded'), 'info');
                  }}
                  data-testid="discard-yes"
                >
                  {tr('shell.home.saved.discard.yes')}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="notice__body">
                <strong>{tr('shell.home.saved.title')}</strong>
                <span>{tr('shell.home.saved.text', { name: saved.name || tr('shell.home.saved.unnamed'), count: saved.storeys })}</span>
              </div>
              <div className="notice__actions">
                <button type="button" className="btn btn--primary" onClick={() => store.getState().resumeSaved()} data-testid="resume-saved">
                  {tr('shell.home.saved.resume')}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setConfirmDiscard(true)} ref={discardButton} data-testid="discard-saved">
                  {tr('shell.home.saved.discard')}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {hasWork ? (
        <div className="notice notice--info" role="region" aria-label={tr('shell.home.current.title')}>
          <Icon name="layers" />
          <div className="notice__body">
            <strong>{tr('shell.home.current.title')}</strong>
            <span>{tr('shell.home.current.text')}</span>
          </div>
          <div className="notice__actions">
            <button type="button" className="btn btn--primary" onClick={() => store.getState().goTo('plan')}>
              {tr('shell.home.current.back')}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => store.getState().newProject()} data-testid="new-project">
              {tr('shell.home.current.new')}
            </button>
          </div>
        </div>
      ) : null}

      <div
        className={`dropzone ${over ? 'is-over' : ''} ${busy ? 'is-busy' : ''}`}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current += 1;
          setOver(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={onDrop}
        data-testid="dropzone"
      >
        <input
          ref={planInput}
          id="plan-files"
          className="visually-hidden"
          type="file"
          multiple
          accept={PLAN_ACCEPT}
          onChange={onPick}
          disabled={busy}
          data-testid="plan-input"
        />
        <span className="dropzone__icon" aria-hidden="true">
          <Icon name="upload" size={34} />
        </span>
        <p className="dropzone__title">{tr(over ? 'shell.home.drop.over' : 'shell.home.drop.title')}</p>
        <label htmlFor="plan-files" className="btn btn--primary btn--large dropzone__button">
          {tr('shell.home.drop.choose')}
        </label>
        <p className="dropzone__formats">{tr('shell.home.drop.formats')}</p>
        <p className="dropzone__hint">{tr('shell.home.drop.hint')}</p>
      </div>

      <ReadingList />

      <p className="privacy">
        <Icon name="lock" size={18} />
        <span>
          <strong>{tr('shell.home.privacy.title')}</strong> {tr('shell.home.privacy.text')}
        </span>
      </p>

      <div className="home__alt">
        <button type="button" className="choice choice--row" onClick={() => void store.getState().loadSample()} disabled={busy} data-testid="try-sample">
          <span className="choice__icon" aria-hidden="true">
            <Icon name="sparkle" />
          </span>
          <span className="choice__body">
            <span className="choice__title">{tr('shell.home.sample')}</span>
            <span className="choice__sub">{tr('shell.home.sample.sub')}</span>
          </span>
        </button>
        <button type="button" className="choice choice--row" onClick={() => store.getState().startBlank()} disabled={busy} data-testid="start-blank">
          <span className="choice__icon" aria-hidden="true">
            <Icon name="grid" />
          </span>
          <span className="choice__body">
            <span className="choice__title">{tr('shell.home.blank')}</span>
            <span className="choice__sub">{tr('shell.home.blank.sub')}</span>
          </span>
        </button>
        <button type="button" className="choice choice--row" onClick={() => projectInput.current?.click()} disabled={busy} data-testid="open-project">
          <span className="choice__icon" aria-hidden="true">
            <Icon name="folder" />
          </span>
          <span className="choice__body">
            <span className="choice__title">{tr('shell.home.open')}</span>
            <span className="choice__sub">{tr('shell.home.open.sub')}</span>
          </span>
        </button>
        <input ref={projectInput} className="visually-hidden" type="file" accept=".json,application/json" onChange={onPick} tabIndex={-1} aria-hidden="true" data-testid="project-input" />
      </div>

      <ol className="home__how" aria-label={tr('shell.home.how.label')}>
        {[1, 2, 3].map((n) => (
          <li key={n} className="home__how-item">
            <span className="home__how-num" aria-hidden="true">
              {n}
            </span>
            <span>
              <strong>{tr(`shell.home.how.${n}.title`)}</strong>
              <span className="home__how-text">{tr(`shell.home.how.${n}.text`)}</span>
            </span>
          </li>
        ))}
      </ol>

      <p className="home__note">{tr('shell.home.note')}</p>
    </section>
  );
}
