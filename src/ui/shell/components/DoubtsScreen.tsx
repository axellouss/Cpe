/**
 * Les seules questions où la lecture a un doute, une carte à la fois, dans l'ordre du moteur (engine/doubts) :
 *  - compteur (« 4 questions, environ 2 minutes ») et barre d'avancement ;
 *  - la proposition DÉJÀ choisie, « pourquoi je demande », l'effet chiffré quand il est connu, un extrait de la
 *    planche quand l'endroit est connu (un toucher l'agrandit) ;
 *  - les choix, ou une saisie ; « Je ne sais pas » (la proposition reste, étiquetée hypothèse) ; « Corriger sur le
 *    plan » quand la donnée s'y corrige ; « Précédent » ;
 *  - une question regroupée (matériaux, menuiseries, ventilation…) montre ses lignes de détail ; quand il ne reste que
 *    ces hypothèses d'usage, « Tout confirmer » les règle d'un geste.
 * Chaque réponse est UN pas d'annulation ; les questions se recalculent après chaque changement du projet.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DOUBT_UNKNOWN } from '../../../engine';
import type { Doubt } from '../../../engine';
import { budget, choicesOf, doubtAnchor, fixStepOf, inputKindOf, isAnswered, isUsual, pageThumbs, sheetOf, whyOf } from '../auto';
import { parseNumber } from '../numbers';
import { selectDeck, selectMarks, selectOpenDoubts, selectReading, useShell, useShellStore } from '../store';
import { useT } from './common';
import { Icon } from './icons';
import { Snippet } from './SheetThumb';

function Counter({ open, deck }: { open: readonly Doubt[]; deck: readonly Doubt[] }) {
  const tr = useT();
  const b = budget(open);
  const done = deck.length - open.length;
  const pct = deck.length > 0 ? Math.round((done / deck.length) * 100) : 100;
  return (
    <div className="counter">
      <p className="counter__text" data-testid="doubt-counter">
        {open.length === 0 ? tr('shell.doubt.counter.none') : tr('shell.doubt.counter', { count: b.count, minutes: b.minutes })}
      </p>
      <div className="counter__track" role="progressbar" aria-valuemin={0} aria-valuemax={deck.length} aria-valuenow={done} aria-label={tr('shell.doubt.progress', { done, total: deck.length })}>
        <div className="counter__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DoubtCard({ doubt, index, total, usualOnly, openUsual }: { doubt: Doubt; index: number; total: number; usualOnly: boolean; openUsual: readonly Doubt[] }) {
  const tr = useT();
  const store = useShellStore();
  const lang = useShell((s) => s.lang);
  const marks = useShell(selectMarks);
  const documents = useShell((s) => s.documents);
  const { reading } = useShell(selectReading);
  const sheets = useMemo(() => documents.flatMap((d) => d.doc.sheets), [documents]);
  const choices = choicesOf(doubt);
  const input = inputKindOf(doubt);
  const previous = marks.doubts?.[doubt.id];
  const answered = isAnswered(doubt, marks);
  const initial = answered && previous && previous.value !== DOUBT_UNKNOWN ? previous.value : (doubt.proposal?.value ?? choices[0]?.value ?? '');
  const [choice, setChoice] = useState(initial);
  const [text, setText] = useState(input && answered && previous ? previous.value : (doubt.proposal?.value ?? ''));
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    head.current?.focus({ preventScroll: true });
  }, [doubt.id]);

  const anchor = useMemo(() => doubtAnchor(doubt.id, reading, sheets), [doubt.id, reading, sheets]);
  const page = useMemo(() => (anchor ? pageThumbs(reading, sheets).find((p) => p.page === anchor.page) : undefined), [anchor, reading, sheets]);
  const sheet = sheetOf(doubt.sheet, lang);
  const fix = fixStepOf(doubt.id);
  const numberOk = input !== 'number' || parseNumber(text) !== null;
  const value = input ? text.trim() : choice;
  const canSend = value !== '' && numberOk;
  const send = (): void => {
    if (!canSend) return;
    store.getState().answerDoubt(doubt, input === 'number' ? String(parseNumber(text)) : value);
  };

  return (
    <article className={`dcard ${isUsual(doubt) ? 'dcard--usual' : ''}`} aria-labelledby={`dq-${doubt.id}`} data-testid="doubt-card" data-doubt={doubt.id}>
      <p className="dcard__kicker">
        {tr('shell.doubt.kicker', { index, total })} · {sheet.title}
        {sheet.luxeeb !== sheet.title ? <span className="term">{sheet.luxeeb}</span> : null}
      </p>
      <h2 id={`dq-${doubt.id}`} className="dcard__question" tabIndex={-1} ref={head}>
        {doubt.question}
      </h2>
      <p className="dcard__why">
        <strong>{tr('shell.doubt.why')}</strong> {tr(whyOf(doubt))}
      </p>
      {doubt.effect ? (
        <p className="dcard__effect" data-testid="doubt-effect">
          <Icon name="info" size={16} />
          <span>{doubt.effect}</span>
        </p>
      ) : null}
      {anchor ? <Snippet anchor={anchor} page={page} label={doubt.datum} /> : null}
      {doubt.details.length > 0 ? (
        <ul className="dcard__details" data-testid="doubt-details">
          {doubt.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      ) : null}

      {answered && previous ? (
        <p className="dcard__answered" data-testid="doubt-answered">
          <Icon name="check" size={16} />
          {previous.value === DOUBT_UNKNOWN ? tr('shell.doubt.answered.unknown') : tr('shell.doubt.answered')}
        </p>
      ) : null}

      {choices.length > 0 ? (
        <fieldset className="dcard__choices">
          <legend className="visually-hidden">{doubt.question}</legend>
          {choices.map((c) => (
            <label key={c.value} className={`dchoice ${choice === c.value ? 'is-selected' : ''}`} data-testid="doubt-choice" data-value={c.value}>
              <input type="radio" name={`doubt-${doubt.id}`} value={c.value} checked={choice === c.value} onChange={() => setChoice(c.value)} />
              <span className="dchoice__label">{c.label}</span>
              {doubt.proposal?.value === c.value ? <span className="pill pill--proposed">{tr('shell.doubt.proposed')}</span> : null}
            </label>
          ))}
        </fieldset>
      ) : input ? (
        <label className="dcard__input">
          <span className="dcard__input-label">{doubt.datum}</span>
          <input
            className="input"
            type="text"
            inputMode={input === 'number' ? 'decimal' : 'text'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
            aria-invalid={!numberOk}
            data-testid="doubt-input"
          />
        </label>
      ) : null}

      <div className="dcard__actions">
        {usualOnly && openUsual.length > 1 ? (
          <button type="button" className="btn btn--primary" onClick={() => store.getState().confirmAllDoubts(openUsual)} data-testid="confirm-all">
            <Icon name="check" size={18} />
            <span>{tr('shell.doubt.confirmAll', { count: openUsual.length })}</span>
          </button>
        ) : null}
        <button type="button" className={`btn ${usualOnly && openUsual.length > 1 ? 'btn--ghost' : 'btn--primary'}`} onClick={send} disabled={!canSend} data-testid="doubt-ok">
          <span>{isUsual(doubt) && choices.length === 0 ? tr('shell.doubt.confirm') : tr('shell.doubt.ok')}</span>
          <Icon name="arrowRight" size={18} />
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => store.getState().answerDoubt(doubt, DOUBT_UNKNOWN)} data-testid="doubt-unknown">
          {tr('shell.doubt.unknown')}
        </button>
        {fix ? (
          <button type="button" className="btn btn--ghost" onClick={() => store.getState().openFix({ planStep: fix, what: `doubt.${doubt.id}.datum` })} data-testid="doubt-fix">
            <Icon name="edit" size={16} />
            <span>{tr('shell.doubt.fix')}</span>
          </button>
        ) : null}
        <button type="button" className="link-btn dcard__back" onClick={() => store.getState().previousDoubt()} data-testid="doubt-previous">
          <Icon name="arrowLeft" size={16} />
          {tr('shell.doubt.previous')}
        </button>
      </div>
      <p className="dcard__unknown-hint">{tr(doubt.proposal ? 'shell.doubt.unknown.hint' : 'shell.doubt.unknown.hintNone')}</p>
    </article>
  );
}

export function DoubtsScreen() {
  const tr = useT();
  const store = useShellStore();
  const open = useShell(selectOpenDoubts);
  const deck = useShell(selectDeck);
  const doubtId = useShell((s) => s.doubtId);
  const current = deck.find((d) => d.id === doubtId) ?? open[0] ?? null;
  const openUsual = open.filter(isUsual);
  const usualOnly = open.length > 0 && openUsual.length === open.length;

  return (
    <section className="doubts" aria-labelledby="doubts-title">
      <header className="screen-head doubts__head">
        <h1 id="doubts-title">{tr('shell.doubt.title')}</h1>
        <Counter open={open} deck={deck} />
      </header>
      {current ? (
        <DoubtCard key={current.id} doubt={current} index={Math.max(1, deck.findIndex((d) => d.id === current.id) + 1)} total={deck.length} usualOnly={usualOnly} openUsual={openUsual} />
      ) : (
        <div className="card doubts__none" data-testid="doubts-none">
          <p className="doubts__none-text">
            <Icon name="check" />
            <span>{tr('shell.doubt.none')}</span>
          </p>
          <button type="button" className="btn btn--primary btn--large" onClick={() => store.getState().goTo('dossier')} data-testid="doubts-dossier">
            <span>{tr('shell.ov.dossier')}</span>
            <Icon name="arrowRight" size={18} />
          </button>
        </div>
      )}
      {current ? (
        <footer className="actions doubts__foot">
          <button type="button" className="btn btn--ghost btn--small" onClick={() => store.getState().goTo('overview')}>
            <Icon name="arrowLeft" size={16} />
            <span>{tr('shell.doubt.backOverview')}</span>
          </button>
          <span className="actions__spacer" />
          <button type="button" className="btn btn--ghost btn--small" onClick={() => store.getState().goTo('dossier')} data-testid="doubts-skip-dossier">
            <span>{tr('shell.doubt.toDossier')}</span>
            <Icon name="arrowRight" size={16} />
          </button>
        </footer>
      ) : null}
    </section>
  );
}
