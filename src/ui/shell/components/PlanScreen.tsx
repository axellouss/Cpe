/**
 * Écran « Plan » : onglets d'étages, liste guidée (qui choisit l'outil de l'éditeur), éditeur de plan, et panneau
 * latéral vivant (hauteurs avec leur provenance, mesures de l'étage, totaux du bâtiment calculés par le moteur).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PlanSheet, Project, Sourced, Storey } from '../../../core/types';
import { excludeRoomFromOutline, roomsOutsideOutline, unheatedRoomsInsideOutline } from '../../../engine';
import { isOutsideEnvelopeName } from '../../../semantics/labels';
import { PlanEditor } from '../../plan';
import { allStoreysDone, countDone, nextOpenStep, planSteps, STEP_TOOL } from '../checklist';
import type { PlanStepInfo, StepState } from '../checklist';
import { derive, safeStoreyMetrics } from '../compute';
import { allSheets, fileNameOfSheetId, findSheet } from '../documents';
import { confirmStoreyHeight, excludeRoomFromEnvelope, restoreStoreyFootprint, setNetArea, setStoreyHeight } from '../modelOps';
import type { HeightKind } from '../modelOps';
import { fixed, unitLength } from '../numbers';
import { isQuestionComplete, REQUIRED_QUESTIONS } from '../questions';
import { currentStorey, selectMarks, selectProject, useShell, useShellStore } from '../store';
import { AnimatedNumber, Badge, NumberField, ProvenanceTag, useAnnounce, useT } from './common';
import type { BadgeTone, Translate } from './common';
import { ErrorBoundary } from './ErrorBoundary';
import { handleDroppedFiles, PLAN_ACCEPT } from './HomeScreen';
import { Icon } from './icons';

const STATE_TONE: Record<StepState, BadgeTone> = { todo: 'bad', toConfirm: 'warn', done: 'ok', blocked: 'muted' };

/** Variables de la ligne d'état mises en forme pour l'affichage (échelle lisible, virgule décimale). */
function statusText(step: PlanStepInfo, tr: Translate): string {
  const params: Record<string, string | number> = { ...step.status.params };
  if (step.key === 'scale' && typeof params.value === 'number') params.unit = unitLength(params.value);
  if (typeof params.area === 'number') params.area = fixed(params.area, 2);
  return tr(step.status.key, params);
}

// ───────────────────────────── Onglets d'étages ─────────────────────────────

function StoreyTabs({ project, storey }: { project: Project; storey: Storey }) {
  const tr = useT();
  const store = useShellStore();
  const marks = useShell(selectMarks);
  const documents = useShell((s) => s.documents);
  const [editing, setEditing] = useState(false);
  const storeys = project.model.storeys;
  const index = storeys.findIndex((s) => s.id === storey.id);
  const sheets = allSheets(documents);
  const used = new Set(storeys.map((s) => s.sheetId));
  const firstFree = sheets.find((r) => !used.has(r.sheet.id))?.sheet.id ?? null;
  const missingSheet = storey.sheetId !== null && !sheets.some((r) => r.sheet.id === storey.sheetId);

  return (
    <div className="storeys">
      <div className="tabs">
        <div className="tabs__list" role="tablist" aria-label={tr('shell.plan.storeys.label')}>
        {storeys.map((s) => {
          const steps = planSteps(project, s, marks, findSheet(documents, s.sheetId));
          const done = countDone(steps);
          const selected = s.id === storey.id;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              id={`tab-${s.id}`}
              aria-selected={selected}
              aria-controls="plan-panel"
              tabIndex={selected ? 0 : -1}
              className={`tabs__tab ${selected ? 'is-active' : ''} ${done === steps.length ? 'is-done' : ''}`}
              onClick={() => store.getState().selectStorey(s.id)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                const next = storeys[storeys.indexOf(s) + (e.key === 'ArrowRight' ? 1 : -1)];
                if (!next) return;
                e.preventDefault();
                store.getState().selectStorey(next.id);
                document.getElementById(`tab-${next.id}`)?.focus();
              }}
              data-testid="storey-tab"
            >
              <span className="tabs__name">{s.name || tr('shell.plan.storey.unnamed')}</span>
              <span className="tabs__progress" title={tr('shell.plan.storey.progress', { done, total: steps.length })}>
                {done === steps.length ? <Icon name="check" size={13} /> : `${done}/${steps.length}`}
              </span>
            </button>
          );
        })}
        </div>
        <button type="button" className="tabs__add" onClick={() => store.getState().addStorey(firstFree)} title={tr('shell.plan.storey.add.title')} data-testid="add-storey">
          <Icon name="plus" size={16} />
          <span>{tr('shell.plan.storey.add')}</span>
        </button>
        <button type="button" className={`tabs__manage ${editing ? 'is-active' : ''}`} aria-expanded={editing} aria-controls="storey-edit" onClick={() => setEditing(!editing)} data-testid="manage-storey">
          <Icon name="edit" size={16} />
          <span>{tr('shell.plan.storey.manage')}</span>
        </button>
      </div>

      {editing ? (
        <div className="storey-edit" id="storey-edit" role="group" aria-label={tr('shell.plan.storey.manage.label', { name: storey.name })}>
          <label className="storey-edit__field">
            <span>{tr('shell.plan.storey.name')}</span>
            <input className="input" type="text" value={storey.name} onChange={(e) => store.getState().renameStorey(storey.id, e.target.value)} data-testid="storey-name" />
          </label>
          <label className="storey-edit__field">
            <span>{tr('shell.plan.storey.sheet')}</span>
            <select
              className="input"
              value={missingSheet ? '__missing__' : (storey.sheetId ?? '')}
              onChange={(e) => {
                if (e.target.value !== '__missing__') store.getState().assignSheet(storey.id, e.target.value === '' ? null : e.target.value);
              }}
              data-testid="storey-sheet"
            >
              <option value="">{tr('shell.plan.storey.sheet.none')}</option>
              {missingSheet ? <option value="__missing__">{tr('shell.plan.storey.sheet.missing', { file: fileNameOfSheetId(storey.sheetId ?? '') })}</option> : null}
              {sheets.map((r) => (
                <option key={r.sheet.id} value={r.sheet.id}>
                  {r.doc.fileName} › {r.sheet.name || tr('shell.read.sheet.unnamed')}
                </option>
              ))}
            </select>
          </label>
          <div className="storey-edit__buttons">
            <button type="button" className="btn btn--ghost btn--small" onClick={() => store.getState().moveStorey(storey.id, -1)} disabled={index <= 0} data-testid="storey-down">
              <Icon name="arrowDown" size={16} />
              <span>{tr('shell.plan.storey.down')}</span>
            </button>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => store.getState().moveStorey(storey.id, 1)} disabled={index >= storeys.length - 1} data-testid="storey-up">
              <Icon name="arrowUp" size={16} />
              <span>{tr('shell.plan.storey.up')}</span>
            </button>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => store.getState().duplicateStorey(storey.id)} data-testid="storey-duplicate">
              <Icon name="copy" size={16} />
              <span>{tr('shell.plan.storey.duplicate')}</span>
            </button>
            <button type="button" className="btn btn--ghost btn--small btn--danger" onClick={() => store.getState().removeStorey(storey.id)} data-testid="storey-remove">
              <Icon name="trash" size={16} />
              <span>{tr('shell.plan.storey.remove')}</span>
            </button>
          </div>
          <p className="storey-edit__hint">{tr('shell.plan.storey.order', { n: index + 1, total: storeys.length })}</p>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────── Liste guidée ─────────────────────────────

function confirmLabel(step: PlanStepInfo, tr: Translate): string {
  if (step.key === 'opening' && step.state === 'todo') return tr('shell.plan.confirm.noOpening');
  if (step.key === 'scale' && step.state === 'todo') return tr('shell.plan.confirm.scaleAnyway');
  if (step.key === 'north' && step.state === 'todo') return tr('shell.plan.confirm.northAnyway');
  return tr('shell.plan.confirm');
}

/**
 * Où passe l'enveloppe thermique : locaux laissés hors du contour chauffé (garage accolé retiré d'office), et
 * locaux non comptés dans An restés à l'intérieur. Un geste suffit pour corriger dans un sens ou dans l'autre.
 */
function EnvelopeNote({ storey, sheet }: { storey: Storey; sheet: PlanSheet | null }) {
  const tr = useT();
  const store = useShellStore();
  const outside = useMemo(() => roomsOutsideOutline(storey, sheet), [storey, sheet]);
  const inside = useMemo(
    () => unheatedRoomsInsideOutline(storey).map((room) => ({ room, removable: excludeRoomFromOutline(storey, room.id) !== null })),
    [storey],
  );
  if (outside.length === 0 && inside.length === 0) return null;
  const update = store.getState().updateProject;
  return (
    <div className="envelope-note" data-testid="envelope-note">
      {outside.length > 0 ? (
        <div className="notice notice--info" data-testid="envelope-outside">
          <p className="notice__body">
            <strong>{tr('shell.plan.envelope.outside.title', { rooms: outside.map((r) => r.name || '?').join(', ') })}</strong>
            <span>{tr('shell.plan.envelope.outside.text')}</span>
          </p>
          <div className="notice__actions">
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => update((p) => restoreStoreyFootprint(p, storey.id, sheet), { label: 'shell.undo.envelope' })}
              data-testid="envelope-restore"
            >
              {tr('shell.plan.envelope.restore')}
            </button>
          </div>
        </div>
      ) : null}
      {inside.map(({ room, removable }) => (
        <div className={`notice ${isOutsideEnvelopeName(room.name) ? 'notice--warn' : 'notice--info'}`} key={room.id} data-testid="envelope-inside">
          <p className="notice__body">
            <strong>{tr('shell.plan.envelope.inside.title', { room: room.name || '?' })}</strong>
            <span>{tr(removable ? 'shell.plan.envelope.inside.text' : 'shell.plan.envelope.inside.manual')}</span>
          </p>
          <div className="notice__actions">
            {removable ? (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => update((p) => excludeRoomFromEnvelope(p, storey.id, room.id), { label: 'shell.undo.envelope' })}
                data-testid="envelope-exclude"
              >
                {tr('shell.plan.envelope.exclude')}
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function Checklist({ project, storey, steps, sheet }: { project: Project; storey: Storey; steps: PlanStepInfo[]; sheet: PlanSheet | null }) {
  const tr = useT();
  const store = useShellStore();
  const announce = useAnnounce();
  const planStep = useShell((s) => s.planStep);
  const celebrate = useShell((s) => s.celebrate);
  const marks = useShell(selectMarks);
  const done = countDone(steps);
  const storeyDone = done === steps.length;
  const everything = allStoreysDone(project, marks);
  const nextStorey = storeyDone ? project.model.storeys.find((s) => s.id !== storey.id && planSteps(project, s, marks, null).some((x) => x.state !== 'done')) : undefined;
  const active = steps.find((s) => s.key === planStep) ?? null;
  const following = active ? nextOpenStep(steps, active.key) : null;
  const closureDone = REQUIRED_QUESTIONS.every((q) => isQuestionComplete(q, project));

  useEffect(() => {
    if (!celebrate) return;
    const key = celebrate.key.split(':').pop() ?? '';
    announce(tr('shell.plan.announce.done', { step: tr(`shell.plan.step.${key}`) }));
    // Une seule annonce par validation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [celebrate?.id]);

  return (
    <nav className="guide" aria-label={tr('shell.plan.guide.label')}>
      <header className="guide__head">
        <h2 className="guide__title">{tr('shell.plan.guide.title')}</h2>
        <span className="guide__count" aria-label={tr('shell.plan.storey.progress', { done, total: steps.length })}>
          {done}/{steps.length}
        </span>
      </header>
      <ol className="checklist">
        {steps.map((step, i) => {
          const isActive = step.key === planStep;
          const justDone = celebrate?.key === `${storey.id}:${step.key}`;
          return (
            <li key={step.key} className={`checklist__item is-${step.state} ${isActive ? 'is-active' : ''}`} data-testid={`plan-step-${step.key}`} data-state={step.state}>
              <button
                type="button"
                className="checklist__head"
                aria-current={isActive ? 'step' : undefined}
                onClick={() => store.getState().selectPlanStep(step.key)}
                data-testid={`plan-step-button-${step.key}`}
              >
                <span className={`checklist__mark ${justDone ? 'is-pop' : ''}`} key={justDone ? celebrate?.id : 'static'} aria-hidden="true">
                  {step.state === 'done' ? <Icon name="check" size={15} /> : i + 1}
                </span>
                <span className="checklist__text">
                  <span className="checklist__title">{tr(`shell.plan.step.${step.key}`)}</span>
                  <span className={`checklist__state checklist__state--${STATE_TONE[step.state]}`}>{tr(`shell.plan.state.${step.state}`)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {active ? (
        <div className={`guide__detail is-${active.state}`} data-testid="plan-step-detail">
          <h3 className="guide__detail-title">{tr(`shell.plan.step.${active.key}`)}</h3>
          <p className="guide__why">{tr(`shell.plan.step.${active.key}.why`)}</p>
          <p className="guide__status">{statusText(active, tr)}</p>
          {active.key === 'outline' || active.key === 'rooms' ? <EnvelopeNote storey={storey} sheet={sheet} /> : null}
          <div className="guide__actions">
            {active.canConfirm && active.state !== 'done' ? (
              <button type="button" className="btn btn--primary btn--small" onClick={() => store.getState().confirmPlanStep(active.key)} data-testid={`plan-confirm-${active.key}`}>
                <Icon name="check" size={16} />
                <span>{confirmLabel(active, tr)}</span>
              </button>
            ) : null}
            {following !== null && following !== active.key ? (
              <button type="button" className="btn btn--ghost btn--small" onClick={() => store.getState().selectPlanStep(following)} data-testid="plan-next-step">
                <span>{tr('shell.plan.next')}</span>
                <Icon name="arrowRight" size={16} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <footer className="guide__foot">
        {storeyDone ? (
          <p className="guide__done">
            <Icon name="check" size={18} />
            <span>{tr('shell.plan.storeyDone', { name: storey.name })}</span>
          </p>
        ) : null}
        {nextStorey ? (
          <button type="button" className="btn btn--primary" onClick={() => store.getState().selectStorey(nextStorey.id)} data-testid="next-storey">
            <span>{tr('shell.plan.nextStorey', { name: nextStorey.name })}</span>
            <Icon name="arrowRight" size={18} />
          </button>
        ) : null}
        {/* Toiture et plancher bas déjà confirmés : plus aucune question indispensable, le résultat est prêt. */}
        <button
          type="button"
          className={`btn ${everything || (storeyDone && !nextStorey) ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => store.getState().goTo(closureDone ? 'result' : 'questions')}
          data-testid="to-questions"
        >
          <span>{tr(closureDone ? 'shell.plan.toResult' : everything ? 'shell.plan.toQuestions' : 'shell.plan.toQuestions.early')}</span>
          <Icon name="arrowRight" size={18} />
        </button>
      </footer>
    </nav>
  );
}

// ───────────────────────────── Panneau latéral ─────────────────────────────

function HeightRow({ storey, kind, focus }: { storey: Storey; kind: HeightKind; focus: boolean }) {
  const tr = useT();
  const store = useShellStore();
  const value: Sourced<number> = kind === 'gross' ? storey.grossHeight : storey.clearHeight;
  const weak = value.from === 'default' || value.from === 'estimate';
  const id = `height-${kind}-${storey.id}`;
  return (
    <div className={`panel__row ${weak ? 'is-weak' : ''}`}>
      <label htmlFor={id} className="panel__label">
        {tr(`shell.plan.height.${kind}`)}
        <span className="panel__hint">{tr(`shell.plan.height.${kind}.hint`)}</span>
      </label>
      <div className="panel__control">
        <NumberField
          id={id}
          value={value.value}
          min={1}
          max={15}
          digits={2}
          unit="m"
          onCommit={(v) => {
            if (v !== null) store.getState().updateProject((p) => setStoreyHeight(p, storey.id, kind, v), { key: `height:${storey.id}:${kind}`, label: 'shell.undo.height', window: 1500 });
          }}
          testId={`height-${kind}`}
          className={focus ? 'is-focus' : ''}
        />
        <ProvenanceTag from={value.from} {...(value.note ? { note: value.note } : {})} />
        {weak ? (
          <button
            type="button"
            className="btn btn--ghost btn--small panel__confirm"
            onClick={() => store.getState().updateProject((p) => confirmStoreyHeight(p, storey.id, kind), { label: 'shell.undo.height' })}
            title={tr('shell.plan.height.confirm.title')}
            aria-label={`${tr('shell.plan.height.confirm')} — ${tr(`shell.plan.height.${kind}`)}`}
            data-testid={`height-confirm-${kind}`}
          >
            <Icon name="check" size={16} />
            <span className="panel__confirm-text">{tr('shell.plan.height.confirm')}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Metric({ label, value, unit, digits = 1, title, children }: { label: string; value: number | null; unit: string; digits?: number; title?: string; children?: ReactNode }) {
  return (
    <div className="metric" title={title}>
      <dt className="metric__label">{label}</dt>
      <dd className="metric__value">
        <AnimatedNumber value={value} digits={digits} />
        <span className="metric__unit"> {unit}</span>
        {children}
      </dd>
    </div>
  );
}

function SidePanel({ project, storey }: { project: Project; storey: Storey }) {
  const tr = useT();
  const store = useShellStore();
  const lang = useShell((s) => s.lang);
  const focus = useShell((s) => s.planFocus);
  const heights = useRef<HTMLDivElement>(null);
  const netArea = useRef<HTMLDivElement>(null);
  const metrics = safeStoreyMetrics(storey);
  const derived = derive(project, lang);
  const totals = derived.sheets?.totals ?? null;
  const findings = derived.sheets?.findings ?? [];
  const blocking = findings.filter((f) => f.severity === 'block').length;
  const warnings = findings.filter((f) => f.severity === 'warn').length;

  useEffect(() => {
    if (!focus) return;
    const target = focus === 'heights' ? heights.current : netArea.current;
    target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    target?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    const timer = setTimeout(() => store.getState().clearPlanFocus(), 2600);
    return () => clearTimeout(timer);
  }, [focus, store]);

  const netFrom = metrics?.netAreaFrom ?? 'estimate';
  return (
    <aside className="panel" aria-label={tr('shell.plan.panel.label')}>
      <section className={`panel__group ${focus === 'heights' ? 'is-flash' : ''}`} ref={heights} aria-labelledby="panel-heights">
        <h2 id="panel-heights" className="panel__title">
          {tr('shell.plan.heights.title', { name: storey.name })}
        </h2>
        <HeightRow storey={storey} kind="gross" focus={focus === 'heights'} />
        <HeightRow storey={storey} kind="clear" focus={false} />
        {storey.clearHeight.value > storey.grossHeight.value ? <p className="panel__warn">{tr('shell.plan.height.inverted')}</p> : null}
      </section>

      <section className="panel__group" aria-labelledby="panel-storey">
        <h2 id="panel-storey" className="panel__title">
          {tr('shell.plan.metrics.title')}
        </h2>
        {metrics ? (
          <dl className="metrics" aria-live="off">
            <Metric label={tr('shell.plan.metrics.gross')} value={metrics.grossArea} unit="m²" />
            <Metric label={tr('shell.plan.metrics.perimeter')} value={metrics.perimeter} unit="m" />
            <Metric label={tr('shell.plan.metrics.net')} value={metrics.netArea} unit="m²">
              <span className={`tag tag--${netFrom === 'estimate' ? 'estimate' : netFrom === 'override' ? 'user' : 'plan'}`} title={tr(`shell.plan.metrics.net.${netFrom}.title`)}>
                {tr(`shell.plan.metrics.net.${netFrom}`)}
              </span>
            </Metric>
            <Metric label={tr('shell.plan.metrics.volume')} value={metrics.grossVolume} unit="m³" />
          </dl>
        ) : (
          <p className="muted">{tr('shell.plan.metrics.unavailable')}</p>
        )}
        <div className={`panel__row ${focus === 'netArea' ? 'is-flash' : ''}`} ref={netArea}>
          <label htmlFor={`net-${storey.id}`} className="panel__label">
            {tr('shell.plan.netArea')}
            <span className="panel__hint">{tr('shell.plan.netArea.hint')}</span>
          </label>
          <div className="panel__control">
            <NumberField
              id={`net-${storey.id}`}
              value={storey.netAreaOverride?.value ?? null}
              min={0}
              max={100000}
              digits={2}
              unit="m²"
              allowEmpty
              placeholder={tr('shell.plan.netArea.placeholder')}
              onCommit={(v) => store.getState().updateProject((p) => setNetArea(p, storey.id, v), { key: `net:${storey.id}`, label: 'shell.undo.netArea', window: 1500 })}
              testId="net-area"
              className="field--wide"
            />
          </div>
        </div>
      </section>

      <section className="panel__group panel__group--totals" aria-labelledby="panel-totals">
        <h2 id="panel-totals" className="panel__title">
          {tr('shell.plan.totals.title', { count: project.model.storeys.length })}
        </h2>
        {totals ? (
          <dl className="metrics metrics--totals" data-testid="totals">
            <Metric label={tr('shell.total.short.an')} title={tr('shell.total.an')} value={totals.an} unit="m²">
              <ProvenanceTag from={totals.anFrom} />
            </Metric>
            <Metric label={tr('shell.total.short.ve')} title={tr('shell.total.ve')} value={totals.ve} unit="m³">
              <ProvenanceTag from={totals.veFrom} />
            </Metric>
            <Metric label={tr('shell.total.short.envelope')} title={tr('shell.total.envelope')} value={totals.envelopeArea} unit="m²" />
            <Metric label={tr('shell.total.short.windows')} title={tr('shell.total.windows')} value={totals.windowArea} unit="m²" />
            <Metric label={tr('shell.total.short.aOverVe')} title={tr('shell.total.aOverVe')} value={totals.aOverVe} unit="1/m" digits={2} />
          </dl>
        ) : (
          <p className="muted">
            {tr('shell.plan.totals.unavailable')}
            {derived.error ? <code className="crash__detail">{derived.error}</code> : null}
          </p>
        )}
        {findings.length > 0 ? (
          <button type="button" className="panel__findings" onClick={() => store.getState().goTo('result')} data-testid="panel-findings">
            {blocking > 0 ? <Badge tone="bad">{tr('shell.findings.count.block', { count: blocking })}</Badge> : null}
            {warnings > 0 ? <Badge tone="warn">{tr('shell.findings.count.warn', { count: warnings })}</Badge> : null}
            <span>{tr('shell.plan.totals.findings')}</span>
            <Icon name="arrowRight" size={16} />
          </button>
        ) : null}
      </section>
    </aside>
  );
}

// ───────────────────────────── Écran ─────────────────────────────

export function PlanScreen() {
  const tr = useT();
  const store = useShellStore();
  const project = useShell(selectProject);
  const marks = useShell(selectMarks);
  const lang = useShell((s) => s.lang);
  const documents = useShell((s) => s.documents);
  const storey = useShell(currentStorey);
  const planStep = useShell((s) => s.planStep);
  const busy = useShell((s) => s.busy);
  const fileInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const storeyId = storey?.id ?? null;

  // Écran étroit : le détail de l'étape est SOUS le plan. Après une validation, on ramène le haut de l'écran
  // (bandeau des étapes puis plan) sous les yeux, sinon l'étape suivante se jouerait hors champ.
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    if (!window.matchMedia('(max-width: 999px)').matches) return;
    body.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [planStep, storeyId]);

  const sheet = storey ? findSheet(documents, storey.sheetId) : null;
  const steps = useMemo(() => (storey ? planSteps(project, storey, marks, sheet) : []), [project, storey, marks, sheet]);
  const ghosts = useMemo(() => {
    if (!storey) return [];
    return project.model.storeys.filter(
      (s) => s.id !== storey.id && s.outline.length >= 3 && (project.model.storeysAligned || s.sheetId === storey.sheetId),
    );
  }, [project.model.storeys, project.model.storeysAligned, storey]);

  if (!storey) {
    return (
      <section className="plan plan--empty">
        <h1>{tr('shell.plan.empty.title')}</h1>
        <p className="lead">{tr('shell.plan.empty.text')}</p>
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={() => store.getState().startBlank()}>
            {tr('shell.home.blank')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => store.getState().goTo('home')}>
            {tr('shell.read.backHome')}
          </button>
        </div>
      </section>
    );
  }

  const missingSheet = storey.sheetId !== null && sheet === null;
  const state = store.getState();

  return (
    <section className="plan" aria-label={tr('shell.steps.plan')}>
      <h1 className="visually-hidden">{tr('shell.plan.title', { name: storey.name })}</h1>
      <StoreyTabs project={project} storey={storey} />
      <div className="plan__body" id="plan-panel" role="tabpanel" aria-labelledby={`tab-${storey.id}`} ref={body}>
        <div className="plan__guide">
          <Checklist project={project} storey={storey} steps={steps} sheet={sheet} />
        </div>

        <div className="plan__stage">
          {missingSheet ? (
            <div className="notice notice--info plan__missing">
              <Icon name="file" />
              <div className="notice__body">
                <strong>{tr('shell.plan.missing.title')}</strong>
                <span>{tr('shell.plan.missing.text', { file: fileNameOfSheetId(storey.sheetId ?? '') })}</span>
              </div>
              <div className="notice__actions">
                <input
                  ref={fileInput}
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
                <button type="button" className="btn btn--ghost btn--small" onClick={() => fileInput.current?.click()} disabled={busy}>
                  {tr('shell.plan.missing.pick')}
                </button>
              </div>
            </div>
          ) : null}
          <div className="plan__editor-wrap" data-testid="plan-stage">
            <ErrorBoundary
              title={tr('shell.error.editor.title')}
              text={tr('shell.error.text')}
              retryLabel={tr('shell.error.retry')}
              undoLabel={tr('shell.undo')}
              onUndo={state.undo}
              resetKey={`${storey.id}:${planStep}`}
            >
              <PlanEditor
                key={storey.id}
                sheet={sheet}
                storey={storey}
                ghostStoreys={ghosts}
                northAngle={project.model.northAngle.value}
                tool={STEP_TOOL[planStep]}
                lang={lang}
                constructions={project.model.constructions}
                windowTypes={project.model.windowTypes}
                onStoreyChange={state.storeyChanged}
                onNorthChange={state.northChanged}
                onToolDone={state.toolDone}
                className="plan__editor"
              />
            </ErrorBoundary>
          </div>
        </div>

        <div className="plan__side">
          <SidePanel project={project} storey={storey} />
        </div>
      </div>
    </section>
  );
}
