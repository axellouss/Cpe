/**
 * Lecture d'une planche, étape par étape : « J'ouvre la planche », « Je repère les vues »… Chaque ligne dit ce qui a
 * été trouvé. Une étape sans objet (pas de coupe dans un dessin) est dite « rien de tel ici », jamais « échouée ».
 */
import { useShell } from '../store';
import { useT } from './common';
import { Icon } from './icons';

export function ReadingProgress() {
  const tr = useT();
  const stages = useShell((s) => s.stages);
  const busy = useShell((s) => s.busy);
  if (!busy || stages.length === 0) return null;
  return (
    <section className="card progress" aria-labelledby="progress-title" data-testid="reading-progress">
      <h2 id="progress-title" className="progress__title">
        {tr('shell.reading.title')}
      </h2>
      <p className="progress__lead">{tr('shell.reading.lead')}</p>
      <ol className="progress__list" aria-live="polite">
        {stages.map((s) => (
          <li key={s.key} className={`progress__item progress__item--${s.status}`} data-testid={`stage-${s.key}`} data-status={s.status}>
            <span className="progress__mark" aria-hidden="true">
              {s.status === 'done' ? <Icon name="check" size={14} /> : s.status === 'running' ? <span className="spinner" /> : null}
            </span>
            <span className="progress__text">
              <span className="progress__label">{tr(`shell.reading.stage.${s.key}`)}</span>
              {s.status === 'done' && s.detail ? <span className="progress__detail">{tr(s.detail.key, s.detail.params)}</span> : null}
              {s.status === 'skipped' ? <span className="progress__detail">{tr('shell.reading.skipped')}</span> : null}
              <span className="visually-hidden"> — {tr(`shell.reading.status.${s.status}`)}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
