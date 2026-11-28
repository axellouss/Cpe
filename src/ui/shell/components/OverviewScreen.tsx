/**
 * « Voici ce que j'ai lu » : la planche en miniature avec ses vues reconnues, et les données lues regroupées comme les
 * feuilles de LuxEeB-Tool. Chaque donnée dit à quel point elle est sûre (lu et recoupé, lu, hypothèse, manquant,
 * vous) et, quand la lecture sait où elle l'a trouvée, « voir sur la planche » allume la vue et l'endroit.
 * Un gros bouton mène aux seules questions de doute, ou directement au dossier s'il n'y en a pas.
 * Après un rechargement, la planche n'est plus là (elle n'est jamais enregistrée) : on montre les données du projet et
 * on propose de la redéposer.
 */
import { useMemo, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { OVERVIEW_GROUPS, overviewCounts, sameAnchor, overviewFields, pageThumbs } from '../auto';
import type { OverviewField, OverviewGroup, Trust } from '../auto';
import { derive } from '../compute';
import { selectMarks, selectOpenDoubts, selectProject, selectReading, useShell, useShellStore } from '../store';
import { useT } from './common';
import { Icon } from './icons';
import { SheetThumb } from './SheetThumb';

/** Terme de LuxEeB-Tool de chaque groupe (allemand de l'outil). */
const GROUP_TERM: Record<OverviewGroup, string> = {
  project: 'Allgemeine Projektdaten',
  areas: 'Energiebezugsflächen / Zonen',
  envelope: 'Gebäudehülle · Ve',
  layers: 'U-Werte von Bauteilen',
  windows: 'transparente Bauteile',
  systems: 'Lüftung · Heizung · Warmwasser',
};

export function TrustBadge({ trust, check }: { trust: Trust; check?: boolean }) {
  const tr = useT();
  return (
    <span className={`trust trust--${trust} ${check ? 'trust--check' : ''}`} title={tr(`shell.trust.${trust}.title`)} data-testid="trust" data-trust={trust}>
      {tr(`shell.trust.${trust}`)}
      {check ? <span className="trust__check"> · {tr('shell.trust.toCheck')}</span> : null}
    </span>
  );
}

function FieldRow({ field, canLocate }: { field: OverviewField; canLocate: boolean }) {
  const tr = useT();
  const store = useShellStore();
  const lit = useShell((s) => sameAnchor(s.locate, field.anchor));
  return (
    <li className={`ov-field ${lit ? 'is-lit' : ''}`} data-testid="field" data-field={field.id} data-trust={field.trust}>
      <div className="ov-field__head">
        <span className="ov-field__label">
          {field.label}
          {field.term ? <span className="term">{field.term}</span> : null}
        </span>
        <TrustBadge trust={field.trust} check={field.doubt !== null} />
      </div>
      <div className="ov-field__value">{field.value || <span className="ov-field__missing">{tr('shell.ov.missing')}</span>}</div>
      {(canLocate && field.anchor) || field.doubt ? (
        <div className="ov-field__actions">
          {canLocate && field.anchor ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => store.getState().setLocate(lit ? null : field.anchor)}
              aria-pressed={lit}
              data-testid="locate"
            >
              <Icon name="target" size={15} />
              {tr('shell.ov.locate')}
            </button>
          ) : null}
          {field.doubt ? (
            <button type="button" className="link-btn" onClick={() => store.getState().showDoubt(field.doubt)} data-testid="field-question">
              <Icon name="help" size={15} />
              {tr('shell.ov.question')}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function GroupBlock({ group, fields, canLocate }: { group: OverviewGroup; fields: readonly OverviewField[]; canLocate: boolean }) {
  const tr = useT();
  if (fields.length === 0) return null;
  const counts = overviewCounts(fields);
  const shown: Trust[] = ['crossChecked', 'read', 'user', 'assumption', 'missing'];
  return (
    <section className="ov-group" aria-labelledby={`ov-${group}`} data-testid="ov-group" data-group={group}>
      <h2 id={`ov-${group}`} className="ov-group__title">
        <span>{tr(`shell.ov.group.${group}`)}</span>
        <span className="term">{GROUP_TERM[group]}</span>
      </h2>
      <p className="ov-group__counts">
        {shown
          .filter((t) => counts[t] > 0)
          .map((t) => (
            <span key={t} className={`pill pill--${t}`}>
              {tr(`shell.ov.count.${t}`, { count: counts[t] })}
            </span>
          ))}
      </p>
      <ul className="ov-group__list">
        {fields.map((f) => (
          <FieldRow key={f.id} field={f} canLocate={canLocate} />
        ))}
      </ul>
    </section>
  );
}

export function OverviewScreen() {
  const tr = useT();
  const store = useShellStore();
  const project = useShell(selectProject);
  const marks = useShell(selectMarks);
  const lang = useShell((s) => s.lang);
  const documents = useShell((s) => s.documents);
  const { reading } = useShell(selectReading);
  const open = useShell(selectOpenDoubts);
  const locate = useShell((s) => s.locate);
  const busy = useShell((s) => s.busy);
  const input = useRef<HTMLInputElement>(null);
  const sheets = useMemo(() => documents.flatMap((d) => d.doc.sheets), [documents]);
  const derived = derive(project, lang).sheets;
  const fields = useMemo(() => overviewFields({ project, derived, reading, sheets, open, marks, lang }), [project, derived, reading, sheets, open, marks, lang]);
  const pages = useMemo(() => pageThumbs(reading, sheets), [reading, sheets]);
  const counts = overviewCounts(fields);
  const canLocate = pages.length > 0;

  const onPick = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) void store.getState().ingestFiles(files);
  };

  return (
    <section className="overview" aria-labelledby="ov-title">
      <header className="screen-head">
        <h1 id="ov-title">{tr('shell.ov.title')}</h1>
        <p className="lead" data-testid="ov-lead">
          {tr('shell.ov.lead', { total: counts.total, sure: counts.sure, assumed: counts.assumption })}
          {counts.missing > 0 ? ` ${tr('shell.ov.lead.missing', { count: counts.missing })}` : ''}
          {counts.user > 0 ? ` ${tr('shell.ov.lead.user', { count: counts.user })}` : ''}
        </p>
      </header>

      <div className="overview__layout">
        <div className="overview__sheet">
          {canLocate ? (
            <SheetThumb pages={pages} locate={locate} />
          ) : (
            <div className="notice notice--info overview__nosheet" data-testid="redrop">
              <Icon name="file" />
              <div className="notice__body">
                <strong>{tr('shell.ov.nosheet.title')}</strong>
                <span>{tr('shell.ov.nosheet.text')}</span>
              </div>
              <div className="notice__actions">
                <button type="button" className="btn btn--ghost btn--small" onClick={() => input.current?.click()} disabled={busy}>
                  <Icon name="upload" size={16} />
                  <span>{tr('shell.ov.nosheet.button')}</span>
                </button>
              </div>
              <input ref={input} className="visually-hidden" type="file" accept=".pdf,application/pdf" onChange={onPick} tabIndex={-1} aria-hidden="true" data-testid="redrop-input" />
            </div>
          )}
        </div>

        <div className="overview__data">
          {OVERVIEW_GROUPS.map((g) => (
            <GroupBlock key={g} group={g} fields={fields.filter((f) => f.group === g)} canLocate={canLocate} />
          ))}

          <div className="overview__go">
            {open.length > 0 ? (
              <>
                <button type="button" className="btn btn--primary btn--large" onClick={() => store.getState().goTo('doubts')} data-testid="answer-doubts">
                  <span>{tr('shell.ov.answer', { count: open.length })}</span>
                  <Icon name="arrowRight" size={18} />
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => store.getState().goTo('dossier')} data-testid="ov-dossier-anyway">
                  {tr('shell.ov.dossierAnyway')}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn--primary btn--large" onClick={() => store.getState().goTo('dossier')} data-testid="see-dossier">
                <span>{tr('shell.ov.dossier')}</span>
                <Icon name="arrowRight" size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
