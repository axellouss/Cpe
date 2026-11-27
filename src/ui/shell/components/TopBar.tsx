/**
 * Barre du haut, toujours visible : nom du produit, indicateur d'étapes, les deux jauges, annuler / rétablir,
 * choix de la langue et mode expert.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Lang } from '../../../core/types';
import { computeMeters, percent, stepsDone } from '../meters';
import { selectCanRedo, selectCanUndo, selectMarks, selectProject, useShell, useShellStore } from '../store';
import { STEPS } from '../types';
import type { Step } from '../types';
import { Meter, useT } from './common';
import { Icon, Logo } from './icons';

const LANGS: readonly Lang[] = ['fr', 'de'];

export function TopBar() {
  const tr = useT();
  const store = useShellStore();
  const step = useShell((s) => s.step);
  const lang = useShell((s) => s.lang);
  const project = useShell(selectProject);
  const canUndo = useShell(selectCanUndo);
  const canRedo = useShell(selectCanRedo);
  const expertOpen = useShell((s) => s.expertOpen);
  const marks = useShell(selectMarks);
  const documents = useShell((s) => s.documents);
  const documentCount = documents.length;
  const saveState = useShell((s) => s.saveState);

  // Jauges et coches lisent les mêmes états que la liste guidée du plan : ce que l'expert a réellement validé.
  const meters = useMemo(() => computeMeters(project, marks, documents), [project, marks, documents]);
  const done = useMemo(() => stepsDone(project, marks, documents), [project, marks, documents]);
  const bar = useRef<HTMLElement>(null);

  // La barre passe sur deux rangées sur petit écran : sa hauteur réelle cale les éléments collants placés dessous.
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = (): void => {
      const height = Math.round(el.getBoundingClientRect().height);
      if (height > 0) document.documentElement.style.setProperty('--topbar-h', `${height}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const current = STEPS.indexOf(step);
  // Mêmes règles que `canGoTo` du magasin, exprimées sur ce que ce composant observe déjà.
  const reachable = (target: Step): boolean =>
    target === 'read' ? documentCount > 0 : target === 'plan' ? project.model.storeys.length > 0 : true;

  return (
    <header className="topbar" ref={bar}>
      <div className="topbar__brand">
        <Logo />
        <span className="topbar__name">Plan2CPE</span>
        <span className={`topbar__save topbar__save--${saveState}`} title={tr(`shell.save.${saveState}.title`)}>
          {saveState === 'saved' ? <Icon name="check" size={14} /> : null}
          <span>{tr(`shell.save.${saveState}`)}</span>
        </span>
      </div>

      <nav className="steps" aria-label={tr('shell.steps.label')}>
        <ol className="steps__list">
          {STEPS.map((s, i) => {
            const state = i === current ? 'current' : i < current ? 'past' : 'future';
            const enabled = reachable(s);
            // La coche dit « fait », jamais « déjà vu » : une étape traversée sans rien valider garde son numéro,
            // et le plan ou la question indispensable laissés ouverts derrière soi sont signalés « à compléter ».
            const work: 'done' | 'pending' | 'none' =
              i === current ? 'none' : done[s] ? 'done' : i < current && enabled && (s === 'plan' || s === 'questions') ? 'pending' : 'none';
            const title = enabled ? tr(`shell.steps.${s}.title`) : tr('shell.steps.locked');
            return (
              <li key={s} className={`steps__item steps__item--${state} ${work === 'none' ? '' : `is-${work}`}`} data-work={work}>
                <button
                  type="button"
                  className="steps__button"
                  aria-current={i === current ? 'step' : undefined}
                  disabled={!enabled}
                  onClick={() => store.getState().goTo(s)}
                  data-testid={`step-${s}`}
                  title={work === 'none' ? title : `${title} — ${tr(`shell.steps.state.${work}`)}`}
                >
                  <span className="steps__num" aria-hidden="true">
                    {work === 'done' ? <Icon name="check" size={13} /> : i + 1}
                  </span>
                  <span className="steps__text">{tr(`shell.steps.${s}`)}</span>
                  {work === 'none' ? null : <span className="visually-hidden"> — {tr(`shell.steps.state.${work}`)}</span>}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="topbar__meters">
        <Meter tone="complete" label={tr('shell.meter.complete')} percent={percent(meters.complete)} title={tr('shell.meter.complete.title')} />
        <Meter tone="confirmed" label={tr('shell.meter.confirmed')} percent={percent(meters.confirmed)} title={tr('shell.meter.confirmed.title')} />
      </div>

      <div className="topbar__actions">
        <div className="btn-group" role="group" aria-label={tr('shell.undo.group')}>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => store.getState().undo()}
            disabled={!canUndo}
            aria-label={tr('shell.undo')}
            title={tr('shell.undo.title')}
            data-testid="undo"
          >
            <Icon name="undo" />
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => store.getState().redo()}
            disabled={!canRedo}
            aria-label={tr('shell.redo')}
            title={tr('shell.redo.title')}
            data-testid="redo"
          >
            <Icon name="redo" />
          </button>
        </div>

        <div className="lang" role="group" aria-label={tr('shell.lang.label')}>
          {LANGS.map((l) => (
            <button
              key={l}
              type="button"
              className={`lang__btn ${lang === l ? 'is-active' : ''}`}
              aria-pressed={lang === l}
              lang={l}
              onClick={() => store.getState().setLang(l)}
              title={l === 'fr' ? 'Français' : 'Deutsch'}
              data-testid={`lang-${l}`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={`btn btn--toggle ${expertOpen ? 'is-active' : ''}`}
          aria-pressed={expertOpen}
          onClick={() => store.getState().setExpert(!expertOpen)}
          title={tr('shell.expert.title')}
          data-testid="expert-toggle"
        >
          <Icon name="table" size={18} />
          <span className="btn__text">{tr('shell.expert')}</span>
        </button>
      </div>
    </header>
  );
}
