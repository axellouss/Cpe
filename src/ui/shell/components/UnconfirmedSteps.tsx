/**
 * Page de résultat : rappel des étapes du plan que l'expert n'a jamais validées, étage par étage, avec un bouton
 * qui ramène à la première d'entre elles. Il lit les mêmes états que la liste guidée (repères de validation et
 * provenances) : aller au résultat sans rien confirmer ne fait pas passer les propositions du lecteur pour sûres.
 * N'affiche rien quand tout est validé.
 */
import { useMemo } from 'react';
import { unconfirmedSteps } from '../checklist';
import { selectMarks, selectProject, useShell, useShellStore } from '../store';
import { useT } from './common';
import { Icon } from './icons';

export function UnconfirmedSteps() {
  const tr = useT();
  const store = useShellStore();
  const project = useShell(selectProject);
  const marks = useShell(selectMarks);
  const documents = useShell((s) => s.documents);
  const open = useMemo(() => unconfirmedSteps(project, marks, documents), [project, marks, documents]);
  if (open.length === 0) return null;
  const count = open.reduce((n, entry) => n + entry.steps.length, 0);

  return (
    <section className="card unconfirmed" aria-labelledby="unconfirmed-title" data-testid="unconfirmed">
      <h2 id="unconfirmed-title" className="card__title unconfirmed__title">
        <Icon name="warning" size={20} />
        <span>{tr('shell.unconfirmed.title', { count })}</span>
      </h2>
      <p className="unconfirmed__text">{tr('shell.unconfirmed.text')}</p>
      <ul className="unconfirmed__list">
        {open.map(({ storey, steps }) => {
          const name = storey.name || tr('shell.plan.storey.unnamed');
          // Une étape « après le contour » attend le contour : on ouvre la première sur laquelle on peut agir.
          const first = steps.find((s) => s.state !== 'blocked') ?? steps[0]!;
          return (
            <li key={storey.id} className="unconfirmed__row" data-testid="unconfirmed-storey">
              <span className="unconfirmed__where">
                <strong className="unconfirmed__storey">{name}</strong>
                <span className="unconfirmed__steps">{steps.map((s) => tr(`shell.plan.step.${s.key}`)).join(' · ')}</span>
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--small unconfirmed__jump"
                onClick={() => store.getState().jumpTo({ step: 'plan', storeyId: storey.id, planStep: first.key, focus: null })}
                aria-label={tr('shell.unconfirmed.jump.label', { name })}
                data-testid="unconfirmed-jump"
              >
                <span>{tr('shell.unconfirmed.jump')}</span>
                <Icon name="arrowRight" size={16} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
