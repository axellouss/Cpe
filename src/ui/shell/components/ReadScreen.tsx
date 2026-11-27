/**
 * « Voici ce que j'ai lu » : une carte par document (feuilles, échelle et son indice, pièces, nord, remarques du
 * lecteur) puis le bâtiment proposé (étages du bas vers le haut, sous-sol proposé non chauffé).
 * Un toucher pour accepter ; tout reste ajustable ici même, et plus tard sur le plan.
 */
import { useRef } from 'react';
import type { Lang, PlanDocument, PlanSheet } from '../../../core/types';
import {
  includedSheets,
  moveProposalSheet,
  paperScale,
  proposedBottomKind,
  renameProposalSheet,
  scaleBadge,
  summarizeSheet,
  toggleProposalSheet,
} from '../documents';
import { isNoNorthNote } from '../../../readers/notes';
import type { Proposal, SheetProposal } from '../documents';
import { fixed, rounded, unitLength } from '../numbers';
import { selectProject, useShell, useShellStore } from '../store';
import type { LoadedDocument } from '../types';
import { Badge, useT } from './common';
import type { BadgeTone, Translate } from './common';
import { handleDroppedFiles, PLAN_ACCEPT, ReadingList } from './HomeScreen';
import { Icon } from './icons';

const SCALE_TONE: Record<ReturnType<typeof scaleBadge>, BadgeTone> = { confirmed: 'ok', toCheck: 'warn', unknown: 'bad' };

function scaleText(doc: PlanDocument, sheet: PlanSheet, tr: Translate): string {
  const scale = sheet.metresPerUnit;
  if (!scale || !(scale.value > 0)) return tr('shell.read.scale.unknown');
  const paper = paperScale(doc.kind, scale.value);
  if (paper !== null) return tr('shell.read.scale.paper', { scale: paper });
  if (doc.kind === 'ifc') return tr('shell.read.scale.model');
  return tr('shell.read.scale.unit', { length: unitLength(scale.value) });
}

function SheetRow({ doc, sheet, proposal, notesLang }: { doc: PlanDocument; sheet: PlanSheet; proposal: Proposal; notesLang: Lang }) {
  const tr = useT();
  const store = useShellStore();
  const entry = proposal.sheets.find((s) => s.sheetId === sheet.id);
  const summary = summarizeSheet(sheet);
  const badge = scaleBadge(sheet.metresPerUnit);
  const d = sheet.detected;
  const checkboxId = `include-${sheet.id}`;

  const roleBadge = (): { tone: BadgeTone; text: string } => {
    if (!entry) return { tone: 'muted', text: tr('shell.read.role.noOutline') };
    switch (entry.role) {
      case 'storey':
        return { tone: 'ok', text: tr('shell.read.role.storey') };
      case 'basement':
        return { tone: 'info', text: tr('shell.read.role.basement') };
      case 'used':
        return { tone: 'muted', text: tr('shell.read.role.used', { name: entry.usedBy ?? '' }) };
      default:
        return { tone: 'warn', text: tr('shell.read.role.noOutline') };
    }
  };
  const role = roleBadge();

  return (
    <li className={`sheet ${entry?.include ? 'is-included' : ''}`} data-testid="sheet-row">
      <div className="sheet__head">
        <span className="sheet__name">{sheet.name || tr('shell.read.sheet.unnamed')}</span>
        <Badge tone={role.tone}>{role.text}</Badge>
        {entry && entry.role !== 'used' ? (
          <label className="switch" htmlFor={checkboxId}>
            <input
              id={checkboxId}
              type="checkbox"
              checked={entry.include}
              onChange={(e) => store.getState().setProposal(toggleProposalSheet(proposal, sheet.id, e.target.checked))}
              data-testid="sheet-include"
            />
            <span>{tr('shell.read.sheet.include')}</span>
          </label>
        ) : null}
      </div>

      <dl className="facts">
        <div className="facts__row">
          <dt>{tr('shell.read.scale')}</dt>
          <dd>
            <span className="facts__value">{scaleText(doc, sheet, tr)}</span>
            <Badge tone={SCALE_TONE[badge]}>{tr(`shell.read.scale.badge.${badge}`)}</Badge>
            {sheet.metresPerUnit?.note ? <span className="facts__note">{sheet.metresPerUnit.note}</span> : null}
            {badge !== 'confirmed' ? <span className="facts__note">{tr(`shell.read.scale.next.${badge}`)}</span> : null}
          </dd>
        </div>
        <div className="facts__row">
          <dt>{tr('shell.read.outline')}</dt>
          <dd>
            <span className="facts__value">{summary.hasOutline ? tr('shell.read.outline.found', { points: summary.outlinePoints }) : tr('shell.read.outline.none')}</span>
            {summary.leftOutside.length > 0 ? (
              <span className="facts__note" data-testid="read-left-outside">
                {tr('shell.read.outline.heated', { rooms: summary.leftOutside.join(', ') })}
              </span>
            ) : null}
            {summary.keptInside.length > 0 ? (
              <span className="facts__note" data-testid="read-kept-inside">
                {tr('shell.read.outline.inside', { rooms: summary.keptInside.join(', ') })}
              </span>
            ) : null}
          </dd>
        </div>
        <div className="facts__row">
          <dt>{tr('shell.read.rooms')}</dt>
          <dd>
            {summary.roomCount > 0 ? (
              <>
                <span className="facts__value">{tr('shell.read.rooms.found', { count: summary.roomCount, area: rounded(summary.roomArea, 1) })}</span>
                {summary.roomsToDecide > 0 ? <Badge tone="warn">{tr('shell.read.rooms.toDecide', { count: summary.roomsToDecide })}</Badge> : null}
              </>
            ) : (
              <span className="facts__value muted">{tr('shell.read.rooms.none')}</span>
            )}
          </dd>
        </div>
        <div className="facts__row">
          <dt>{tr('shell.read.openings')}</dt>
          <dd>
            <span className={`facts__value ${summary.windowCount + summary.doorCount === 0 ? 'muted' : ''}`}>
              {summary.windowCount + summary.doorCount > 0
                ? tr('shell.read.openings.found', { windows: summary.windowCount, doors: summary.doorCount })
                : tr('shell.read.openings.none')}
            </span>
          </dd>
        </div>
        {d.storeyHeight !== undefined || d.clearHeight !== undefined ? (
          <div className="facts__row">
            <dt>{tr('shell.read.heights')}</dt>
            <dd>
              <span className="facts__value">
                {[
                  d.storeyHeight !== undefined ? tr('shell.read.heights.gross', { value: fixed(d.storeyHeight, 2) }) : null,
                  d.clearHeight !== undefined ? tr('shell.read.heights.clear', { value: fixed(d.clearHeight, 2) }) : null,
                ]
                  .filter((x): x is string => x !== null)
                  .join(' · ')}
              </span>
            </dd>
          </div>
        ) : null}
      </dl>

      {summary.notes.length > 0 ? (
        <details className="sheet__notes">
          <summary>{tr('shell.read.notes', { count: summary.notes.length })}</summary>
          <ul lang={notesLang}>
            {summary.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function DocumentCard({ loaded, proposal }: { loaded: LoadedDocument; proposal: Proposal }) {
  const tr = useT();
  const store = useShellStore();
  const doc = loaded.doc;
  const lang = useShell((s) => s.lang);
  const busy = useShell((s) => s.busy);
  // Les remarques du lecteur sont rédigées dans la langue de l'interface AU MOMENT de la lecture.
  const notesLang: Lang = loaded.readLang ?? lang;
  // « Pas de flèche du nord » : dit une seule fois, à la ligne du nord ci-dessous.
  const warnings = doc.northAngle ? doc.warnings : doc.warnings.filter((w) => !isNoNorthNote(w));
  return (
    <article className="card doc" aria-label={doc.fileName} data-testid="doc-card">
      <header className="doc__head">
        <span className="doc__icon" aria-hidden="true">
          <Icon name="file" />
        </span>
        <h2 className="doc__name">{doc.fileName}</h2>
        <Badge tone="muted">{tr(`shell.kind.${doc.kind}`)}</Badge>
        <span className="doc__count">{tr('shell.read.sheets', { count: doc.sheets.length })}</span>
        <button type="button" className="btn btn--ghost btn--small doc__remove" onClick={() => store.getState().removeDocument(loaded.id)}>
          <Icon name="trash" size={16} />
          <span>{tr('shell.read.remove')}</span>
        </button>
      </header>

      {warnings.length > 0 ? (
        <ul className="notice notice--warn doc__warnings" lang={notesLang} aria-label={tr('shell.read.warnings')}>
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      {doc.northAngle ? (
        <p className="doc__north">
          <span className="doc__north-arrow" aria-hidden="true" style={{ transform: `rotate(${-doc.northAngle.value}deg)` }}>
            <Icon name="arrowUp" size={18} />
          </span>
          <span>
            <strong>{tr('shell.read.north')}</strong> {tr('shell.read.north.value', { angle: Math.round(doc.northAngle.value) })}{' '}
            <Badge tone={doc.northAngle.from === 'estimate' || doc.northAngle.from === 'default' ? 'warn' : 'ok'}>
              {tr(doc.northAngle.from === 'estimate' || doc.northAngle.from === 'default' ? 'shell.read.north.weak' : 'shell.read.north.read')}
            </Badge>
            {doc.northAngle.note ? <span className="facts__note">{doc.northAngle.note}</span> : null}
          </span>
        </p>
      ) : (
        <p className="doc__north muted">{tr('shell.read.north.none')}</p>
      )}

      {notesLang !== lang ? (
        <p className="doc__lang muted" data-testid="read-notes-lang">
          <span>{tr(`shell.read.notesLang.${notesLang}`)}</span>{' '}
          {loaded.rereadable ? (
            <button type="button" className="linklike" onClick={() => void store.getState().rereadDocument(loaded.id)} disabled={busy} data-testid="reread-doc">
              {tr('shell.read.reread')}
            </button>
          ) : null}
        </p>
      ) : null}

      {doc.sheets.length === 0 ? (
        <p className="muted">{tr('shell.read.sheets.none')}</p>
      ) : (
        <ul className="sheets">
          {doc.sheets.map((sheet) => (
            <SheetRow key={sheet.id} doc={doc} sheet={sheet} proposal={proposal} notesLang={notesLang} />
          ))}
        </ul>
      )}
    </article>
  );
}

/** Le bâtiment proposé, dessiné comme une coupe : le dernier étage en haut, ce qu'il y a dessous en bas. */
function BuildingStack({ proposal }: { proposal: Proposal }) {
  const tr = useT();
  const store = useShellStore();
  const project = useShell(selectProject);
  const included = includedSheets(proposal);
  const existing = proposal.mode === 'append' ? project.model.storeys : [];
  const bottomKind = proposal.mode === 'append' || project.model.bottom.from === 'user' ? project.model.bottom.kind : proposedBottomKind(proposal);
  const bottomConfirmed = project.model.bottom.from === 'user';
  const total = existing.length + included.length;

  const row = (entry: SheetProposal, index: number) => (
    <li key={entry.sheetId} className="stack__row" data-testid="stack-row">
      <span className="stack__level" aria-hidden="true">
        {existing.length + index + 1}
      </span>
      <label className="visually-hidden" htmlFor={`name-${entry.sheetId}`}>
        {tr('shell.read.stack.name', { n: existing.length + index + 1 })}
      </label>
      <input
        id={`name-${entry.sheetId}`}
        className="input stack__name"
        type="text"
        value={entry.name}
        onChange={(e) => store.getState().setProposal(renameProposalSheet(proposal, entry.sheetId, e.target.value))}
        data-testid="stack-name"
      />
      <span className="stack__source">
        {entry.fileName} › {entry.sheetName || tr('shell.read.sheet.unnamed')}
        {entry.role === 'noOutline' ? ` — ${tr('shell.read.stack.toTrace')}` : ''}
      </span>
      <span className="stack__moves">
        <button
          type="button"
          className="btn btn--icon btn--small"
          onClick={() => store.getState().setProposal(moveProposalSheet(proposal, entry.sheetId, 1))}
          disabled={index === included.length - 1}
          aria-label={tr('shell.read.stack.up', { name: entry.name })}
          title={tr('shell.read.stack.up', { name: entry.name })}
        >
          <Icon name="arrowUp" size={16} />
        </button>
        <button
          type="button"
          className="btn btn--icon btn--small"
          onClick={() => store.getState().setProposal(moveProposalSheet(proposal, entry.sheetId, -1))}
          disabled={index === 0}
          aria-label={tr('shell.read.stack.down', { name: entry.name })}
          title={tr('shell.read.stack.down', { name: entry.name })}
        >
          <Icon name="arrowDown" size={16} />
        </button>
      </span>
    </li>
  );

  return (
    <section className="card stack" aria-labelledby="stack-title">
      <h2 id="stack-title" className="card__title">
        {tr('shell.read.stack.title')}
      </h2>
      <p className="muted">{tr(total > 0 ? 'shell.read.stack.sub' : 'shell.read.stack.empty', { count: total })}</p>
      <ol className="stack__list" reversed>
        {/* Du haut vers le bas, comme une coupe du bâtiment. */}
        {[...included].map((entry, index) => ({ entry, index })).reverse().map(({ entry, index }) => row(entry, index))}
        {[...existing].reverse().map((s, i) => (
          <li key={s.id} className="stack__row stack__row--existing">
            <span className="stack__level" aria-hidden="true">
              {existing.length - i}
            </span>
            <span className="stack__fixed">{s.name}</span>
            <span className="stack__source">{tr('shell.read.stack.existing')}</span>
          </li>
        ))}
      </ol>
      <p className={`stack__ground stack__ground--${bottomKind}`}>
        <span className="stack__ground-label">{tr('shell.read.stack.below')}</span>
        <strong>{tr(`shell.bottom.${bottomKind}`)}</strong>
        <Badge tone={bottomConfirmed ? 'ok' : 'warn'}>{tr(bottomConfirmed ? 'shell.read.stack.below.confirmed' : bottomKind === 'above-unheated' ? 'shell.read.stack.below.basement' : 'shell.read.stack.below.default')}</Badge>
      </p>
    </section>
  );
}

export function ReadScreen() {
  const tr = useT();
  const store = useShellStore();
  const documents = useShell((s) => s.documents);
  const proposal = useShell((s) => s.proposal);
  const busy = useShell((s) => s.busy);
  const hasStoreys = useShell((s) => s.history.present.project.model.storeys.length > 0);
  const input = useRef<HTMLInputElement>(null);

  if (!proposal || documents.length === 0) {
    return (
      <section className="read">
        <h1>{tr('shell.read.title')}</h1>
        <p className="lead">{tr('shell.read.nothing')}</p>
        <button type="button" className="btn btn--primary" onClick={() => store.getState().goTo('home')}>
          {tr('shell.read.backHome')}
        </button>
      </section>
    );
  }

  const included = includedSheets(proposal).length;
  const canAccept = included > 0 || (proposal.mode === 'append' && hasStoreys);

  return (
    <section className="read" aria-labelledby="read-title">
      <header className="screen-head">
        <h1 id="read-title">{tr('shell.read.title')}</h1>
        <p className="lead">{tr('shell.read.lead')}</p>
      </header>

      {hasStoreys ? (
        <div className="notice notice--info">
          <Icon name="layers" />
          <div className="notice__body">
            <strong>{tr(proposal.mode === 'append' ? 'shell.read.mode.append.title' : 'shell.read.mode.replace.title')}</strong>
            <span>{tr(proposal.mode === 'append' ? 'shell.read.mode.append.text' : 'shell.read.mode.replace.text')}</span>
          </div>
          <div className="notice__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => store.getState().setProposalMode(proposal.mode === 'append' ? 'replace' : 'append')}
              data-testid="proposal-mode"
            >
              {tr(proposal.mode === 'append' ? 'shell.read.mode.toReplace' : 'shell.read.mode.toAppend')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="read__docs">
        {documents.map((d) => (
          <DocumentCard key={d.id} loaded={d} proposal={proposal} />
        ))}
      </div>

      <ReadingList />
      <BuildingStack proposal={proposal} />

      <footer className="actions actions--sticky">
        <input
          ref={input}
          className="visually-hidden"
          type="file"
          multiple
          accept={PLAN_ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void handleDroppedFiles(store, files);
          }}
        />
        <button type="button" className="btn btn--ghost" onClick={() => input.current?.click()} disabled={busy}>
          <Icon name="plus" size={18} />
          <span>{tr('shell.read.addFile')}</span>
        </button>
        <span className="actions__spacer" />
        {!canAccept ? <span className="actions__hint">{tr('shell.read.needOne')}</span> : null}
        <button type="button" className="btn btn--primary btn--large" onClick={() => store.getState().acceptProposal()} disabled={!canAccept || busy} data-testid="accept-read">
          <span>{tr(proposal.mode === 'append' && included === 0 ? 'shell.read.accept.keep' : 'shell.read.accept')}</span>
          <Icon name="arrowRight" size={18} />
        </button>
      </footer>
    </section>
  );
}
