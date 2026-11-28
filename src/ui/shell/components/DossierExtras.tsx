/**
 * Ce que le dossier du parcours automatique ajoute à l'écran de résultat :
 *  - en tête, les questions de doute encore ouvertes (on peut aller au dossier sans y répondre : il le rappelle) ;
 *  - le dossier feuille par feuille dans l'ordre de LuxEeB-Tool (export/dossier `buildDossier`), libellés de l'outil
 *    en regard : champs, couches des parois, fenêtres, enveloppe, zones, contrôles de plausibilité ;
 *  - les hypothèses à confirmer, avec leur source ;
 *  - un encadré honnête : ce qui reste à faire dans LuxEeB-Tool. Le passeport officiel et ses classes sortent de
 *    l'outil, signés par l'expert : aucune classe n'est estimée ici.
 */
import { useMemo } from 'react';
import type { Dossier, DossierColumn, DossierSection, DossierValue } from '../../../core/cpe';
import type { Lang } from '../../../core/types';
import { buildDossier } from '../../../export/dossier';
import { sheetOf, trustOfProvenance } from '../auto';
import type { Doubt } from '../../../engine';
import { selectOpenDoubts, selectProject, selectReading, useShell, useShellStore } from '../store';
import { useT } from './common';
import { Icon } from './icons';
import { TrustBadge } from './OverviewScreen';

let lastDossier: { key: unknown[]; result: Dossier | null } | null = null;

/** Dossier mémorisé pour le dernier état ; null si l'export a échoué (l'écran le dit sans s'effondrer). */
function useDossier(): Dossier | null {
  const project = useShell(selectProject);
  const lang = useShell((s) => s.lang);
  const documents = useShell((s) => s.documents);
  const { reading } = useShell(selectReading);
  return useMemo(() => {
    const key = [project, lang, documents, reading];
    if (lastDossier && lastDossier.key.every((k, i) => k === key[i])) return lastDossier.result;
    let result: Dossier | null;
    try {
      result = buildDossier(project, documents.flatMap((d) => d.doc.sheets), lang, reading ? { reading } : {});
    } catch {
      result = null;
    }
    lastDossier = { key, result };
    return result;
  }, [project, lang, documents, reading]);
}

/** Les questions encore ouvertes, rappelées en tête du dossier. */
/** Au-delà, la liste des questions ouvertes est repliée (le titre dit combien il en reste). */
const OPEN_FOLD = 4;

export function OpenDoubts() {
  const tr = useT();
  const open = useShell(selectOpenDoubts);
  if (open.length === 0) return null;
  const list = <OpenDoubtList open={open} />;
  return (
    <section className="card unconfirmed open-doubts" aria-labelledby="open-doubts-title" data-testid="open-doubts">
      <h2 id="open-doubts-title" className="card__title unconfirmed__title">
        <Icon name="warning" size={20} />
        <span>{tr('shell.dossier.open.title', { count: open.length })}</span>
      </h2>
      <p className="unconfirmed__text">{tr('shell.dossier.open.text')}</p>
      {open.length > OPEN_FOLD ? (
        <details className="open-doubts__fold" data-testid="open-doubts-fold">
          <summary className="open-doubts__summary">{tr('shell.dossier.open.fold', { count: open.length })}</summary>
          {list}
        </details>
      ) : (
        list
      )}
    </section>
  );
}

function OpenDoubtList({ open }: { open: readonly Doubt[] }) {
  const tr = useT();
  const store = useShellStore();
  const lang = useShell((s) => s.lang);
  return (
      <ul className="unconfirmed__list">
        {open.map((d) => (
          <li key={d.id} className="unconfirmed__row" data-testid="open-doubt">
            <span className="unconfirmed__where">
              <strong className="unconfirmed__storey">{d.question}</strong>
              <span className="unconfirmed__steps">
                {d.proposal ? tr('shell.dossier.open.kept', { value: d.proposal.label }) : tr('shell.dossier.open.empty')} · {sheetOf(d.sheet, lang).title}
              </span>
            </span>
            <button type="button" className="btn btn--ghost btn--small unconfirmed__jump" onClick={() => store.getState().showDoubt(d.id)} data-testid="open-doubt-answer">
              <span>{tr('shell.dossier.open.answer')}</span>
              <Icon name="arrowRight" size={16} />
            </button>
          </li>
        ))}
      </ul>
  );
}

const colLabel = (c: Pick<DossierColumn, 'de' | 'fr'>, lang: Lang): string => (lang === 'de' ? c.de : c.fr);

function ValueCell({ value }: { value: DossierValue }) {
  if (!value.text) return <span className="dossier__empty">–</span>;
  return <span title={value.source ?? value.doubt ?? undefined}>{value.text}</span>;
}

function hasContent(section: DossierSection): boolean {
  return section.fields.length > 0 || section.tables.some((t) => t.rows.length > 0) || section.notes.length > 0;
}

function SectionPanel({ section, index }: { section: DossierSection; index: number }) {
  const tr = useT();
  const lang = useShell((s) => s.lang);
  const values = [...section.fields.map((f) => f.value), ...section.tables.flatMap((t) => t.rows.flatMap((r) => r.cells))].filter((v) => v.text !== '');
  const assumed = values.filter((v) => v.from === 'default' || v.from === 'estimate').length;
  const empty = section.fields.filter((f) => !f.value.text).length;
  return (
    <details className="dossier__sheet" data-testid="dossier-sheet" data-sheet={section.key} open={index < 1}>
      <summary className="dossier__summary">
        <span className="dossier__num" aria-hidden="true">
          {index + 1}
        </span>
        <span className="dossier__name">
          <span className="dossier__title">{section.title}</span>
          {section.luxeebName !== section.title ? <span className="term">{section.luxeebName}</span> : null}
        </span>
        <span className="dossier__state">
          {assumed > 0 ? <span className="pill pill--assumption">{tr('shell.ov.count.assumption', { count: assumed })}</span> : null}
          {empty > 0 ? <span className="pill pill--missing">{tr('shell.dossier.toFill', { count: empty })}</span> : null}
        </span>
      </summary>
      <div className="dossier__body">
        {section.fields.length > 0 ? (
          <dl className="dossier__fields">
            {section.fields.map((f) => (
              <div key={f.key} className="dossier__field">
                <dt>
                  {colLabel(f, lang)}
                  {lang === 'fr' ? <span className="term">{f.de}</span> : null}
                </dt>
                <dd>
                  <ValueCell value={f.value} />
                  <TrustBadge trust={f.value.text ? trustOfProvenance(f.value.from, f.value.confidence) : 'missing'} />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {section.tables
          .filter((t) => t.rows.length > 0)
          .map((t) => (
            <div key={t.key} className="dossier__table-wrap" role="region" aria-label={tr(`shell.dossier.table.${t.key}`)} tabIndex={0}>
              <table className="dossier__table" data-testid="dossier-table" data-table={t.key}>
                <caption className="dossier__caption">{tr(`shell.dossier.table.${t.key}`)}</caption>
                <thead>
                  <tr>
                    {t.columns.map((c) => (
                      <th key={c.key} scope="col">
                        {colLabel(c, lang)}
                        {lang === 'fr' && c.de !== c.fr ? <span className="term">{c.de}</span> : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r) => (
                    <tr key={r.id}>
                      {r.cells.map((cell, i) => (
                        <td key={i} className={cell.from === 'default' || cell.from === 'estimate' ? 'is-assumed' : ''}>
                          <ValueCell value={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {section.notes.length > 0 ? (
          <ul className="dossier__notes">
            {section.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

/** Le dossier feuille par feuille, dans l'ordre de LuxEeB-Tool, et les hypothèses à confirmer. */
export function DossierSheets() {
  const tr = useT();
  const dossier = useDossier();
  if (!dossier) {
    return (
      <div className="notice notice--warn" role="alert">
        <div className="notice__body">
          <strong>{tr('shell.dossier.failed')}</strong>
          <span>{tr('shell.error.text')}</span>
        </div>
      </div>
    );
  }
  const sections = dossier.sections.filter(hasContent);
  return (
    <>
      <section className="card dossier" aria-labelledby="dossier-sheets-title" data-testid="dossier-sheets">
        <h2 id="dossier-sheets-title" className="card__title">
          {tr('shell.dossier.sheets.title')}
        </h2>
        <p className="dossier__lead">{tr('shell.dossier.sheets.lead', { version: dossier.tool.version })}</p>
        {sections.map((s, i) => (
          <SectionPanel key={s.key} section={s} index={i} />
        ))}
      </section>
      {dossier.assumptions.length > 0 ? (
        <section className="card assumptions" aria-labelledby="assumptions-title" data-testid="dossier-assumptions">
          <h2 id="assumptions-title" className="card__title">
            {tr('shell.dossier.assumptions.title', { count: dossier.assumptions.length })}
          </h2>
          <p className="dossier__lead">{tr('shell.dossier.assumptions.lead')}</p>
          <ul className="assumptions__list">
            {dossier.assumptions.map((a) => (
              <li key={a.key}>
                <span>{a.text}</span>
                <span className="assumptions__source">{a.source}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** « Ce qui reste à faire dans LuxEeB-Tool » : le dossier prépare la saisie, l'outil et l'expert font le reste. */
export function StillInLuxeeb() {
  const tr = useT();
  return (
    <section className="card still" aria-labelledby="still-title" data-testid="still-in-luxeeb">
      <h2 id="still-title" className="card__title still__title">
        <Icon name="table" size={20} />
        <span>{tr('shell.dossier.still.title')}</span>
      </h2>
      <p>{tr('shell.dossier.still.lead')}</p>
      <ol className="still__list">
        {[1, 2, 3].map((n) => (
          <li key={n}>{tr(`shell.dossier.still.${n}`)}</li>
        ))}
      </ol>
    </section>
  );
}
