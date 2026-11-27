/**
 * Questions : une par écran, de gros choix à toucher, « je ne sais pas » là où c'est une réponse honnête, et pour
 * chacune une ligne qui dit pourquoi le plan ne peut pas répondre. Les réponses sur la toiture et le plancher bas
 * modifient le bâtiment (provenance « vous ») : les totaux affichés en bas réagissent aussitôt.
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type {
  BottomKind,
  BuildingType,
  HeatEmission,
  HeatGenerator,
  HotWater,
  Occasion,
  Orientation,
  Project,
  ProjectAnswers,
  RoofShape,
  TopKind,
  Ventilation,
  WindowGeneration,
} from '../../../core/types';
import { ORIENTATIONS } from '../../../core/types';
import { roofRidgeChoices } from '../../../engine';
import { derive } from '../compute';
import { fixed } from '../numbers';
import {
  CAN_SKIP,
  countedQuestions,
  isPlausibleYear,
  isQuestionComplete,
  isVisitNote,
  OPTIONAL_QUESTIONS,
  periodLabel,
  periodOfYear,
  PERIODS,
  questionStatus,
  relevantQuestions,
  visitNoteRank,
} from '../questions';
import { selectMarks, selectProject, useShell, useShellStore } from '../store';
import type { QuestionId } from '../types';
import { AnimatedNumber, NumberField, ProvenanceTag, useT } from './common';
import { Icon } from './icons';
import { BottomPicto, ShapePicto, TopPicto } from './pictos';

// ───────────────────────────── Choix ─────────────────────────────

interface Option<T> {
  value: T;
  title: string;
  sub?: string;
  picto?: ReactNode;
}

interface ChoiceGroupProps<T> {
  legend: string;
  options: readonly Option<T>[];
  value: T | null;
  onPick(value: T): void;
  /** Les touches 1 à 9 choisissent dans ce groupe. */
  hot?: boolean;
  /** 'cards' : grands choix ; 'chips' : petites pastilles (valeurs numériques). */
  variant?: 'cards' | 'chips';
  hideLegend?: boolean;
  testId?: string;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
}

function ChoiceGroup<T extends string | number | boolean>(props: ChoiceGroupProps<T>) {
  const { options, onPick, hot } = props;
  const latest = useRef({ options, onPick });
  latest.current = { options, onPick };

  useEffect(() => {
    if (!hot) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1) return;
      const option = latest.current.options[n - 1];
      if (!option) return;
      e.preventDefault();
      latest.current.onPick(option.value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hot]);

  const variant = props.variant ?? 'cards';
  return (
    <fieldset className={`choices choices--${variant}`} data-testid={props.testId}>
      <legend className={props.hideLegend ? 'visually-hidden' : 'choices__legend'}>{props.legend}</legend>
      <div className="choices__grid">
        {options.map((o, i) => {
          const selected = props.value === o.value;
          return (
            <button
              key={String(o.value)}
              type="button"
              className={`choice ${selected ? 'is-selected' : ''} ${o.picto ? 'choice--picto' : ''}`}
              aria-pressed={selected}
              onClick={() => onPick(o.value)}
              data-value={String(o.value)}
            >
              {o.picto ? <span className="choice__picto">{o.picto}</span> : null}
              <span className="choice__body">
                <span className="choice__title">{o.title}</span>
                {o.sub ? <span className="choice__sub">{o.sub}</span> : null}
              </span>
              {hot && variant === 'cards' && i < 9 ? (
                <kbd className="choice__key" aria-hidden="true">
                  {i + 1}
                </kbd>
              ) : null}
              {selected ? (
                <span className="choice__tick" aria-hidden="true">
                  <Icon name="check" size={16} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

// ───────────────────────────── Parties communes ─────────────────────────────

type Tr = ReturnType<typeof useT>;
type Actions = ReturnType<ReturnType<typeof useShellStore>['getState']>;

interface PartProps {
  project: Project;
  tr: Tr;
  actions: Actions;
  /** Passe à la question suivante après un court instant (choix unique qui complète l'écran). */
  advanceSoon(): void;
}

/** Choix d'une énumération : titre « préfixe.valeur », sous-titre « préfixe.valeur.sub » s'il existe. */
function options<T extends string>(tr: Tr, prefix: string, values: readonly T[]): Option<T>[] {
  return values.map((value) => {
    const title = tr(`${prefix}.${value}`);
    const subKey = `${prefix}.${value}.sub`;
    const sub = tr(subKey);
    return sub !== subKey ? { value, title, sub } : { value, title };
  });
}

// ───────────────────────────── 1. Contexte ─────────────────────────────

const OCCASIONS: readonly Occasion[] = ['existing', 'new'];
const BUILDING_TYPES: readonly BuildingType[] = ['EFH', 'MFH'];

function ContextPart({ project, tr, actions }: PartProps) {
  const a = project.answers;
  return (
    <>
      <ChoiceGroup
        legend={tr('shell.q.context.occasion')}
        options={options(tr, 'shell.q.occasion', OCCASIONS)}
        value={a.occasion}
        onPick={(occasion) => actions.answer({ occasion })}
        hot={a.occasion === null}
        testId="q-occasion"
      />
      {a.occasion !== null ? (
        <ChoiceGroup
          legend={tr('shell.q.context.type')}
          options={options(tr, 'shell.q.buildingType', BUILDING_TYPES)}
          value={a.buildingType}
          onPick={(buildingType) =>
            actions.answer({ buildingType, dwellings: buildingType === 'EFH' ? 1 : a.buildingType === 'MFH' ? a.dwellings : null })
          }
          hot={a.buildingType === null}
          testId="q-building-type"
        />
      ) : null}
      {a.buildingType !== null ? (
        <div className="q-field">
          <label htmlFor="q-dwellings" className="q-field__label">
            {tr('shell.q.context.dwellings')}
          </label>
          <NumberField
            id="q-dwellings"
            value={a.dwellings}
            integer
            min={1}
            max={999}
            allowEmpty
            onCommit={(dwellings) => actions.answer({ dwellings }, 'dwellings')}
            testId="q-dwellings"
            className="field--large"
          />
          {a.buildingType === 'MFH' && a.dwellings === null ? <span className="q-field__hint">{tr('shell.q.context.dwellings.hint')}</span> : null}
        </div>
      ) : null}
    </>
  );
}

// ───────────────────────────── 2. Année ─────────────────────────────

function YearPart({ project, tr, actions }: PartProps) {
  const marks = useShell(selectMarks);
  const year = project.answers.yearBuilt;
  const period = marks.yearFromPeriod ? periodOfYear(year) : null;
  const thisYear = new Date().getFullYear();
  return (
    <>
      <div className="q-field">
        <label htmlFor="q-year" className="q-field__label">
          {tr('shell.q.year.exact')}
        </label>
        <NumberField
          id="q-year"
          value={year}
          integer
          min={1500}
          max={thisYear + 3}
          allowEmpty
          placeholder={tr('shell.q.year.placeholder')}
          onCommit={(v) => actions.answerYear(v !== null && isPlausibleYear(v, thisYear) ? v : null, false)}
          testId="q-year"
          className="field--large"
        />
        {year !== null && marks.yearFromPeriod ? <span className="q-field__hint q-field__hint--warn">{tr('shell.q.year.approx', { year })}</span> : null}
      </div>
      <ChoiceGroup
        legend={tr('shell.q.year.period')}
        variant="chips"
        options={PERIODS.map((p) => ({ value: p.id, title: periodLabel(p) }))}
        value={period?.id ?? null}
        onPick={(id) => {
          const picked = PERIODS.find((p) => p.id === id);
          if (picked) actions.answerYear(picked.year, true);
        }}
        testId="q-period"
      />
    </>
  );
}

// ───────────────────────────── 3. Toiture et plancher bas ─────────────────────────────

const TOP_KINDS: readonly TopKind[] = ['flat-roof', 'pitched-roof', 'attic-ceiling'];
const BOTTOM_KINDS: readonly BottomKind[] = ['slab-on-ground', 'above-unheated', 'above-outside'];
const ROOF_SHAPES: readonly RoofShape[] = ['gable', 'hip', 'mono'];
const PITCHES = [15, 25, 30, 35, 40, 45] as const;
const KNEE_WALLS = [0, 0.5, 1, 1.5] as const;

function ClosurePart({ project, tr, actions }: PartProps) {
  const lang = useShell((s) => s.lang);
  const part = useShell((s) => s.questionPart);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { top, bottom } = project.model;
  const topChosen = top.from === 'user';
  const bottomChosen = bottom.from === 'user';
  const totals = derive(project, lang).sheets?.totals ?? null;
  // Toit incliné : choisi (ou proposé par la maquette) mais pas encore confirmé dans ses détails.
  const pitchedPending = top.kind === 'pitched-roof' && top.from === 'estimate';
  const showPitched = top.kind === 'pitched-roof' && (topChosen || pitchedPending);
  const ridges = showPitched ? roofRidgeChoices(project.model) : [];
  const sameRidge = (a: number, b: number): boolean => {
    const turn = top.shape === 'mono' ? 360 : 180;
    const d = (((a - b) % turn) + turn) % turn;
    return Math.min(d, turn - d) < 0.5;
  };
  const pickedRidge = top.ridgeAngle === null ? null : (ridges.find((r) => sameRidge(r.ridgeAngle, top.ridgeAngle!))?.ridgeAngle ?? null);
  const assumedRidge = ridges.find((r) => r.assumed) ?? null;
  const ridgeTitle = (orientations: readonly Orientation[]): string =>
    [...orientations]
      .sort((a, b) => ORIENTATIONS.indexOf(a) - ORIENTATIONS.indexOf(b))
      .map((o) => tr(`shell.orientation.${o}`))
      .join(tr('shell.q.closure.ridge.and'));
  /** Un détail modifié garde la toiture confirmée si elle l'était, « à confirmer » sinon. */
  const detail = (patch: Parameters<typeof actions.setTop>[0], key?: string): void => actions.setTop(patch, key, topChosen);

  useEffect(() => {
    if (part === 'bottom') bottomRef.current?.scrollIntoView?.({ block: 'center' });
  }, [part]);

  return (
    <>
      <ChoiceGroup
        legend={tr('shell.q.closure.top')}
        options={TOP_KINDS.map((kind) => ({ value: kind, title: tr(`shell.top.${kind}`), sub: tr(`shell.top.${kind}.sub`), picto: <TopPicto kind={kind} /> }))}
        value={topChosen || pitchedPending ? top.kind : null}
        // Toit plat ou plafond sous grenier : un toucher suffit. Toit incliné : ses détails restent à confirmer.
        onPick={(kind) => (kind === 'pitched-roof' ? actions.setTop({ kind }, undefined, topChosen && top.kind === 'pitched-roof') : actions.setTop({ kind }))}
        hot={!topChosen && !pitchedPending}
        testId="q-top"
      />
      {!topChosen && !pitchedPending ? <p className="q-assumed">{tr('shell.q.closure.assumed', { kind: tr(`shell.top.${top.kind}`) })}</p> : null}

      {showPitched ? (
        <div className="q-sub">
          <ChoiceGroup
            legend={tr('shell.q.closure.pitch')}
            variant="chips"
            options={PITCHES.map((p) => ({ value: p, title: `${p}°` }))}
            value={(PITCHES as readonly number[]).includes(top.pitchDeg) ? top.pitchDeg : null}
            onPick={(pitchDeg) => detail({ pitchDeg })}
            testId="q-pitch"
          />
          <div className="q-field q-field--inline">
            <label htmlFor="q-pitch-exact" className="q-field__label">
              {tr('shell.q.closure.pitch.exact')}
            </label>
            <NumberField id="q-pitch-exact" value={top.pitchDeg} min={1} max={89} digits={1} unit="°" onCommit={(v) => v !== null && detail({ pitchDeg: v }, 'pitch')} testId="q-pitch-exact" />
          </div>
          <ChoiceGroup
            legend={tr('shell.q.closure.shape')}
            options={ROOF_SHAPES.map((shape) => ({ value: shape, title: tr(`shell.roofShape.${shape}`), picto: <ShapePicto shape={shape} /> }))}
            value={top.shape}
            onPick={(shape) => detail({ shape, ridgeAngle: null })}
            testId="q-shape"
          />
          <ChoiceGroup
            legend={tr('shell.q.closure.knee')}
            variant="chips"
            options={KNEE_WALLS.map((h) => ({ value: h, title: h === 0 ? tr('shell.q.closure.knee.none') : `${String(h).replace('.', ',')} m` }))}
            value={(KNEE_WALLS as readonly number[]).includes(top.kneeWallHeight) ? top.kneeWallHeight : null}
            onPick={(kneeWallHeight) => detail({ kneeWallHeight })}
            testId="q-knee"
          />
          <div className="q-field q-field--inline">
            <label htmlFor="q-knee-exact" className="q-field__label">
              {tr('shell.q.closure.knee.exact')}
            </label>
            <NumberField id="q-knee-exact" value={top.kneeWallHeight} min={0} max={4} digits={2} unit="m" onCommit={(v) => v !== null && detail({ kneeWallHeight: v }, 'knee')} testId="q-knee-exact" />
          </div>
          <p className="q-note">{tr('shell.q.closure.knee.note')}</p>
          {ridges.length > 0 ? (
            <>
              <ChoiceGroup
                legend={tr(top.shape === 'mono' ? 'shell.q.closure.ridge.mono' : 'shell.q.closure.ridge')}
                variant="chips"
                options={ridges.map((r) => ({ value: r.ridgeAngle, title: ridgeTitle(r.orientations) }))}
                value={pickedRidge}
                onPick={(ridgeAngle) => detail({ ridgeAngle })}
                testId="q-ridge"
              />
              {pickedRidge === null && assumedRidge ? (
                <p className="q-assumed">{tr('shell.q.closure.ridge.assumed', { slopes: ridgeTitle(assumedRidge.orientations) })}</p>
              ) : null}
            </>
          ) : null}
          {!topChosen ? (
            <div className="q-confirm">
              <p className="q-assumed">
                {tr('shell.q.closure.pitched.summary', {
                  pitch: fixed(top.pitchDeg, 0),
                  knee: fixed(top.kneeWallHeight, 2),
                  shape: tr(`shell.roofShape.${top.shape}`),
                })}
              </p>
              <button
                type="button"
                className="btn btn--primary"
                // Confirmer fige aussi le sens du faîtage affiché, s'il n'a pas été touché.
                onClick={() => actions.setTop(top.ridgeAngle === null && assumedRidge ? { ridgeAngle: assumedRidge.ridgeAngle } : {}, undefined, true)}
                data-testid="q-roof-confirm"
              >
                <Icon name="check" size={18} />
                <span>{tr('shell.q.closure.pitched.confirm')}</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div ref={bottomRef} className="q-stack">
        <ChoiceGroup
          legend={tr('shell.q.closure.bottom')}
          options={BOTTOM_KINDS.map((kind) => ({ value: kind, title: tr(`shell.bottom.${kind}`), sub: tr(`shell.bottom.${kind}.sub`), picto: <BottomPicto kind={kind} /> }))}
          value={bottomChosen ? bottom.kind : null}
          onPick={(kind) => actions.setBottom(kind)}
          hot={topChosen && !bottomChosen}
          testId="q-bottom"
        />
        {!bottomChosen ? <p className="q-assumed">{tr('shell.q.closure.assumed', { kind: tr(`shell.bottom.${bottom.kind}`) })}</p> : null}
      </div>

      {totals && project.model.storeys.length > 0 ? (
        <p className="q-live" aria-live="polite" data-testid="q-live">
          <span>
            {tr('shell.total.envelope')} <strong><AnimatedNumber value={totals.envelopeArea} /> m²</strong>
          </span>
          <span>
            {tr('shell.total.ve')} <strong><AnimatedNumber value={totals.ve} /> m³</strong> <ProvenanceTag from={totals.veFrom} />
          </span>
          <span>
            {tr('shell.total.aOverVe')} <strong><AnimatedNumber value={totals.aOverVe} digits={2} /></strong>
          </span>
        </p>
      ) : null}
    </>
  );
}

// ───────────────────────────── 4. Isolation ajoutée ─────────────────────────────

const INSULATION_CM = [0, 4, 6, 8, 10, 12, 16, 20] as const;
const INSULATION_FIELDS = [
  ['insulationWallsCm', 'walls'],
  ['insulationRoofCm', 'roof'],
  ['insulationFloorCm', 'floor'],
] as const;

function InsulationPart({ project, tr, actions }: PartProps) {
  const a = project.answers;
  return (
    <>
      {INSULATION_FIELDS.map(([field, name]) => {
        const value = a[field];
        return (
          <div className="q-block" key={field}>
            <ChoiceGroup
              legend={tr(`shell.q.insulation.${name}`)}
              variant="chips"
              options={INSULATION_CM.map((cm) => ({ value: cm, title: cm === 0 ? tr('shell.q.insulation.none') : `${cm} cm` }))}
              value={value !== null && (INSULATION_CM as readonly number[]).includes(value) ? value : null}
              onPick={(cm) => actions.answer({ [field]: cm } as Partial<ProjectAnswers>)}
              testId={`q-insulation-${name}`}
            />
            <div className="q-field q-field--inline">
              <label htmlFor={`q-ins-${name}`} className="q-field__label">
                {tr('shell.q.insulation.other')}
              </label>
              <NumberField
                id={`q-ins-${name}`}
                value={value}
                min={0}
                max={80}
                digits={1}
                unit="cm"
                allowEmpty
                placeholder={tr('shell.q.unknown.short')}
                onCommit={(cm) => actions.answer({ [field]: cm } as Partial<ProjectAnswers>, field)}
                testId={`q-insulation-${name}-exact`}
              />
            </div>
          </div>
        );
      })}
      <p className="q-note">{tr('shell.q.insulation.note')}</p>
    </>
  );
}

// ───────────────────────────── 5. Fenêtres ─────────────────────────────

const WINDOW_GENERATIONS: readonly WindowGeneration[] = ['single', 'double-old', 'double-lowe', 'triple'];

function WindowsPart({ project, tr, actions, advanceSoon }: PartProps) {
  const value = project.answers.windowGeneration;
  return (
    <ChoiceGroup
      legend={tr('shell.q.windows.title')}
      hideLegend
      options={options(tr, 'shell.q.windowGeneration', WINDOW_GENERATIONS)}
      value={value}
      onPick={(windowGeneration) => {
        actions.answer({ windowGeneration });
        if (value === null) advanceSoon();
      }}
      hot
      testId="q-windows"
    />
  );
}

// ───────────────────────────── 6. Chauffage ─────────────────────────────

const GENERATORS: readonly HeatGenerator[] = [
  'gas-condensing',
  'gas-low-temp',
  'oil-condensing',
  'oil-low-temp',
  'old-boiler',
  'heat-pump-air',
  'heat-pump-ground',
  'pellets',
  'wood-logs',
  'district-heating',
  'electric-direct',
  'other',
];
const EMISSIONS: readonly HeatEmission[] = ['radiators', 'floor-heating', 'mixed', 'air'];

function HeatingPart({ project, tr, actions }: PartProps) {
  const a = project.answers;
  const thisYear = new Date().getFullYear();
  return (
    <>
      <ChoiceGroup
        legend={tr('shell.q.heating.generator')}
        options={options(tr, 'shell.q.generator', GENERATORS)}
        value={a.heatGenerator}
        onPick={(heatGenerator) => actions.answer({ heatGenerator })}
        hot={a.heatGenerator === null}
        testId="q-generator"
      />
      {a.heatGenerator !== null ? (
        <>
          <div className="q-field">
            <label htmlFor="q-heat-year" className="q-field__label">
              {tr('shell.q.heating.year')}
            </label>
            <NumberField
              id="q-heat-year"
              value={a.heatGeneratorYear}
              integer
              min={1900}
              max={thisYear + 1}
              allowEmpty
              placeholder={tr('shell.q.unknown.short')}
              onCommit={(heatGeneratorYear) => actions.answer({ heatGeneratorYear }, 'heatGeneratorYear')}
              testId="q-heat-year"
              className="field--large"
            />
            <span className="q-field__hint">{tr('shell.q.heating.year.hint')}</span>
          </div>
          <ChoiceGroup
            legend={tr('shell.q.heating.emission')}
            options={options(tr, 'shell.q.emission', EMISSIONS)}
            value={a.heatEmission}
            onPick={(heatEmission) => actions.answer({ heatEmission })}
            hot={a.heatEmission === null}
            testId="q-emission"
          />
        </>
      ) : null}
    </>
  );
}

// ───────────────────────────── 7. Eau chaude ─────────────────────────────

const HOT_WATER: readonly HotWater[] = ['with-heating', 'separate-electric', 'separate-heat-pump', 'separate-other'];

function HotWaterPart({ project, tr, actions, advanceSoon }: PartProps) {
  const value = project.answers.hotWater;
  return (
    <ChoiceGroup
      legend={tr('shell.q.hotWater.title')}
      hideLegend
      options={options(tr, 'shell.q.hotWaterKind', HOT_WATER)}
      value={value}
      onPick={(hotWater) => {
        actions.answer({ hotWater });
        if (value === null) advanceSoon();
      }}
      hot
      testId="q-hot-water"
    />
  );
}

// ───────────────────────────── 8. Ventilation ─────────────────────────────

const VENTILATIONS: readonly Ventilation[] = ['windows', 'exhaust', 'balanced-hr'];

function VentilationPart({ project, tr, actions }: PartProps) {
  const a = project.answers;
  return (
    <>
      <ChoiceGroup
        legend={tr('shell.q.ventilation.system')}
        options={options(tr, 'shell.q.ventilationKind', VENTILATIONS)}
        value={a.ventilation}
        onPick={(ventilation) => actions.answer({ ventilation })}
        hot={a.ventilation === null}
        testId="q-ventilation"
      />
      {a.ventilation !== null ? (
        <div className="q-field">
          <label htmlFor="q-n50" className="q-field__label">
            {tr('shell.q.ventilation.n50')}
          </label>
          <NumberField
            id="q-n50"
            value={a.n50}
            min={0.05}
            max={30}
            digits={2}
            unit="1/h"
            allowEmpty
            placeholder={tr('shell.q.ventilation.n50.placeholder')}
            onCommit={(n50) => actions.answer({ n50 }, 'n50')}
            testId="q-n50"
            className="field--large"
          />
          <span className="q-field__hint">{tr('shell.q.ventilation.n50.hint')}</span>
        </div>
      ) : null}
    </>
  );
}

// ───────────────────────────── 9. Solaire ─────────────────────────────

function SolarPart({ project, tr, actions }: PartProps) {
  const a = project.answers;
  const yesNo: Option<'yes' | 'no'>[] = [
    { value: 'yes', title: tr('shell.yes') },
    { value: 'no', title: tr('shell.no') },
  ];
  const asChoice = (v: boolean | null): 'yes' | 'no' | null => (v === null ? null : v ? 'yes' : 'no');
  return (
    <>
      <div className="q-quick">
        <button
          type="button"
          className={`choice ${a.solarThermal === false && a.photovoltaic === false ? 'is-selected' : ''}`}
          aria-pressed={a.solarThermal === false && a.photovoltaic === false}
          onClick={() => actions.answer({ solarThermal: false, photovoltaic: false })}
          data-testid="q-solar-none"
        >
          <span className="choice__body">
            <span className="choice__title">{tr('shell.q.solar.none')}</span>
            <span className="choice__sub">{tr('shell.q.solar.none.sub')}</span>
          </span>
        </button>
      </div>
      <ChoiceGroup legend={tr('shell.q.solar.thermal')} variant="chips" options={yesNo} value={asChoice(a.solarThermal)} onPick={(v) => actions.answer({ solarThermal: v === 'yes' })} testId="q-solar-thermal" />
      <ChoiceGroup legend={tr('shell.q.solar.pv')} variant="chips" options={yesNo} value={asChoice(a.photovoltaic)} onPick={(v) => actions.answer({ photovoltaic: v === 'yes' })} testId="q-solar-pv" />
      <p className="q-note">{tr('shell.q.solar.note')}</p>
    </>
  );
}

// ───────────────────────────── Identité (facultatif) ─────────────────────────────

const IDENTITY_FIELDS = [
  ['projectName', 'name', 'off'],
  ['street', 'street', 'address-line1'],
  ['postcode', 'postcode', 'postal-code'],
  ['locality', 'locality', 'address-level2'],
] as const;

function IdentityPart({ project, tr, actions }: PartProps) {
  const a = project.answers;
  return (
    <div className="q-form">
      {IDENTITY_FIELDS.map(([field, name, autoComplete]) => (
        <label key={field} className={`q-form__field q-form__field--${name}`}>
          <span className="q-field__label">{tr(`shell.q.identity.${name}`)}</span>
          <input
            className="input input--large"
            type="text"
            value={a[field]}
            autoComplete={autoComplete}
            maxLength={120}
            onChange={(e) => actions.answer({ [field]: e.target.value } as Partial<ProjectAnswers>, field)}
            data-testid={`q-identity-${name}`}
          />
        </label>
      ))}
    </div>
  );
}

const PARTS: Record<QuestionId, (props: PartProps) => ReactNode> = {
  context: ContextPart,
  year: YearPart,
  closure: ClosurePart,
  insulation: InsulationPart,
  windows: WindowsPart,
  heating: HeatingPart,
  hotWater: HotWaterPart,
  ventilation: VentilationPart,
  solar: SolarPart,
  identity: IdentityPart,
};

// ───────────────────────────── Écran ─────────────────────────────

export function QuestionsScreen() {
  const tr = useT();
  const store = useShellStore();
  const project = useShell(selectProject);
  const marks = useShell(selectMarks);
  const asked = useShell((s) => s.question);
  const list = relevantQuestions(project);
  const id = list.includes(asked) ? asked : (list[0] ?? 'context');
  const title = useRef<HTMLHeadingElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // À chaque nouvelle question, le titre reçoit le focus : clavier et lecteur d'écran repartent du bon endroit.
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      try {
        window.scrollTo({ top: 0 });
      } catch {
        // Environnement sans défilement (tests).
      }
    }
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [id]);

  const actions = store.getState();
  const advanceSoon = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (store.getState().question === id && store.getState().step === 'questions') store.getState().continueQuestion();
    }, 380);
  };

  const note = visitNoteRank(id, project);
  const complete = isQuestionComplete(id, project);
  // La question indispensable est répondue : le résultat est prêt, les notes de visite sont un supplément.
  const fork = !isVisitNote(id) && complete;
  const canSkip = CAN_SKIP[id];
  // Sans « je ne sais pas », il faut une réponse complète pour continuer ; avec, on peut continuer sur une réponse partielle.
  const canContinue = complete || canSkip;
  const last = list[list.length - 1] === id;
  const Part = PARTS[id];

  return (
    <section className="question" aria-labelledby="question-title" data-testid={`question-${id}`}>
      <nav className="dots" aria-label={tr('shell.q.dots.label')}>
        <ol className="dots__list">
          {list.map((q, i) => {
            const status = questionStatus(q, project, marks);
            const current = q === id;
            return (
              <li key={q}>
                <button
                  type="button"
                  className={`dots__dot dots__dot--${status} ${OPTIONAL_QUESTIONS.includes(q) ? 'dots__dot--optional' : ''} ${current ? 'is-current' : ''}`}
                  aria-current={current ? 'step' : undefined}
                  aria-label={tr('shell.q.dots.item', { n: i + 1, title: tr(`shell.q.${q}.short`), status: tr(`shell.q.status.${status}`) })}
                  title={`${tr(`shell.q.${q}.short`)} — ${tr(`shell.q.status.${status}`)}`}
                  onClick={() => store.getState().openQuestion(q)}
                  data-testid={`dot-${q}`}
                >
                  {status === 'answered' ? <Icon name="check" size={13} /> : status === 'skipped' ? '?' : i + 1}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="card question__card">
        <p className="question__count">
          {!isVisitNote(id)
            ? tr('shell.q.count.required')
            : note
              ? tr('shell.q.count.note', { n: note.rank, total: note.total })
              : tr('shell.q.optional')}
        </p>
        <h1 id="question-title" ref={title} tabIndex={-1} className="question__title">
          {tr(`shell.q.${id}.title`)}
        </h1>
        <p className="question__why">
          <strong>{tr('shell.q.why')}</strong> {tr(`shell.q.${id}.why`)}
        </p>

        <div className="question__body">
          <Part project={project} tr={tr} actions={actions} advanceSoon={advanceSoon} />
        </div>

        <footer className="actions question__actions">
          <button type="button" className="btn btn--ghost" onClick={() => store.getState().backQuestion()} data-testid="q-back">
            <Icon name="arrowLeft" size={18} />
            <span>{tr('shell.back')}</span>
          </button>
          <span className="actions__spacer" />
          {canSkip && id !== 'identity' ? (
            <button type="button" className="btn btn--ghost" onClick={() => store.getState().skipQuestion()} data-testid="q-skip">
              <Icon name="help" size={18} />
              <span>{tr('shell.q.skip')}</span>
            </button>
          ) : null}
          {fork ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={() => store.getState().continueQuestion()} data-testid="q-notes">
                <span>{tr('shell.q.fork.notes')}</span>
              </button>
              <button type="button" className="btn btn--primary btn--large" onClick={() => store.getState().finishQuestions()} data-testid="q-continue">
                <span>{tr('shell.q.finish')}</span>
                <Icon name="arrowRight" size={18} />
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--primary btn--large" onClick={() => store.getState().continueQuestion()} disabled={!canContinue} data-testid="q-continue">
              <span>{tr(!last ? 'shell.continue' : id === 'identity' && !complete ? 'shell.q.identity.later' : 'shell.q.finish')}</span>
              <Icon name="arrowRight" size={18} />
            </button>
          )}
        </footer>
        {!canContinue ? <p className="question__need">{tr('shell.q.need')}</p> : null}
        {fork ? <p className="question__need">{tr('shell.q.fork.hint', { count: countedQuestions(project).filter(isVisitNote).length })}</p> : null}
        {isVisitNote(id) && id !== 'identity' ? (
          <p className="question__need">
            <button type="button" className="linklike" onClick={() => store.getState().finishQuestions()} data-testid="q-to-result">
              {tr('shell.q.note.toResult')}
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}
