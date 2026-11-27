/**
 * Mode expert : les tableaux bruts, modifiables à tout moment — types d'éléments (valeur U facultative), types de
 * fenêtres, lignes d'enveloppe manuelles, pièces (surfaces, comptées ou non dans An), données de chaque étage.
 * C'est une autre VUE du même projet : chaque modification passe par le même historique (annuler / rétablir).
 */
import type { ReactNode } from 'react';
import type { Boundary, Construction, ConstructionCategory, ManualRow, Opening, OrientationOrHorizontal, Project, Storey } from '../../../core/types';
import { ORIENTATIONS } from '../../../core/types';
import { DEFAULT_WINDOW_TYPE_ID } from '../../../engine';
import { safeStoreyMetrics } from '../compute';
import { allSheets, fileNameOfSheetId } from '../documents';
import {
  addConstruction,
  addManualRow,
  addRoom,
  addWindowType,
  BOUNDARIES,
  CONSTRUCTION_CATEGORIES,
  confirmScale,
  isDefaultConstruction,
  removeConstruction,
  removeManualRow,
  removeOpening,
  removeRoom,
  removeWindowType,
  setEdge,
  setNetArea,
  setStoreyHeight,
  updateConstruction,
  updateManualRow,
  updateOpening,
  updateRoom,
  updateWindowType,
} from '../modelOps';
import { fixed, unitLength } from '../numbers';
import { selectProject, useShell, useShellStore } from '../store';
import type { ApplyOptions } from '../store';
import { EXPERT_TABS } from '../types';
import type { ExpertTab } from '../types';
import { Badge, NumberField, ProvenanceTag, useT } from './common';
import type { Translate } from './common';
import { Dialog } from './Dialog';
import { Icon } from './icons';

const ORIENTATION_CHOICES: readonly OrientationOrHorizontal[] = [...ORIENTATIONS, 'H'];
/** LuxEeB-Tool n'offre que 20 emplacements d'éléments opaques (manuel, ch. 2.2.2). */
const OPAQUE_SLOTS = 20;

type Update = (updater: (project: Project) => Project, options?: ApplyOptions) => void;

interface TabProps {
  project: Project;
  update: Update;
  tr: Translate;
}

/** Options de fusion pour un champ saisi au clavier : les frappes successives ne font qu'un pas d'historique. */
function typing(key: string): ApplyOptions {
  return { key: `expert:${key}`, label: 'shell.undo.expert', window: 1500 };
}

const ONCE: ApplyOptions = { label: 'shell.undo.expert' };

function DeleteButton({ label, onClick, disabled }: { label: string; onClick(): void; disabled?: boolean }) {
  return (
    <button type="button" className="btn btn--icon btn--small btn--danger" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      <Icon name="trash" size={16} />
    </button>
  );
}

function constructionOptions(constructions: readonly Construction[], categories: readonly ConstructionCategory[], tr: Translate) {
  return (
    <>
      <option value="">{tr('shell.expert.defaultType')}</option>
      {constructions
        .filter((c) => categories.includes(c.category))
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </>
  );
}

// ───────────────────────────── Types d'éléments ─────────────────────────────

function ConstructionsTab({ project, update, tr }: TabProps) {
  const list = project.model.constructions;
  return (
    <div className="xtab">
      <p className="xtab__intro">{tr('shell.expert.constructions.intro')}</p>
      <p className={`xtab__count ${list.length > OPAQUE_SLOTS ? 'is-over' : ''}`}>{tr('shell.expert.constructions.count', { count: list.length, max: OPAQUE_SLOTS })}</p>
      <div className="xtable-wrap">
        <table className="xtable" data-testid="x-constructions">
          <thead>
            <tr>
              <th scope="col">{tr('shell.expert.col.name')}</th>
              <th scope="col">{tr('shell.expert.col.category')}</th>
              <th scope="col">{tr('shell.expert.col.u')}</th>
              <th scope="col">{tr('shell.result.source')}</th>
              <th scope="col">
                <span className="visually-hidden">{tr('shell.expert.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td>
                  <input
                    className="input"
                    type="text"
                    value={c.name}
                    aria-label={tr('shell.expert.col.name')}
                    onChange={(e) => update((p) => updateConstruction(p, c.id, { name: e.target.value }), typing(`c-name:${c.id}`))}
                  />
                </td>
                <td>
                  {isDefaultConstruction(c.id) ? (
                    tr(`shell.category.${c.category}`)
                  ) : (
                    <select
                      className="input"
                      value={c.category}
                      aria-label={tr('shell.expert.col.category')}
                      onChange={(e) => update((p) => updateConstruction(p, c.id, { category: e.target.value as ConstructionCategory }), ONCE)}
                    >
                      {CONSTRUCTION_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {tr(`shell.category.${cat}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  <NumberField
                    value={c.u?.value ?? null}
                    min={0.01}
                    max={10}
                    digits={3}
                    allowEmpty
                    placeholder="–"
                    ariaLabel={tr('shell.expert.col.u.aria', { name: c.name })}
                    onCommit={(u) => update((p) => updateConstruction(p, c.id, { u }), typing(`c-u:${c.id}`))}
                    testId="x-u"
                  />
                </td>
                <td>{c.u ? <ProvenanceTag from={c.u.from} /> : <span className="muted">{tr('shell.expert.u.inTool')}</span>}</td>
                <td>
                  {isDefaultConstruction(c.id) ? null : (
                    <DeleteButton label={tr('shell.expert.remove', { name: c.name })} onClick={() => update((p) => removeConstruction(p, c.id), ONCE)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="xtab__add" role="group" aria-label={tr('shell.expert.constructions.add')}>
        <span>{tr('shell.expert.constructions.add')}</span>
        {CONSTRUCTION_CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => update((p) => addConstruction(p, cat, tr('shell.expert.constructions.new', { category: tr(`shell.category.${cat}`) })), ONCE)}
            data-testid={`x-add-${cat}`}
          >
            <Icon name="plus" size={14} />
            <span>{tr(`shell.category.${cat}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── Types de fenêtres ─────────────────────────────

function WindowTypesTab({ project, update, tr }: TabProps) {
  return (
    <div className="xtab">
      <p className="xtab__intro">{tr('shell.expert.windowTypes.intro')}</p>
      <div className="xtable-wrap">
        <table className="xtable" data-testid="x-window-types">
          <thead>
            <tr>
              <th scope="col">{tr('shell.expert.col.name')}</th>
              <th scope="col">{tr('shell.expert.col.uw')}</th>
              <th scope="col">{tr('shell.expert.col.g')}</th>
              <th scope="col">
                <span className="visually-hidden">{tr('shell.expert.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {project.model.windowTypes.map((w) => (
              <tr key={w.id}>
                <td>
                  <input
                    className="input"
                    type="text"
                    value={w.name}
                    aria-label={tr('shell.expert.col.name')}
                    onChange={(e) => update((p) => updateWindowType(p, w.id, { name: e.target.value }), typing(`w-name:${w.id}`))}
                  />
                </td>
                <td>
                  <NumberField value={w.uw?.value ?? null} min={0.1} max={7} digits={2} allowEmpty placeholder="–" ariaLabel={tr('shell.expert.col.uw')} onCommit={(uw) => update((p) => updateWindowType(p, w.id, { uw }), typing(`w-uw:${w.id}`))} />
                </td>
                <td>
                  <NumberField value={w.g?.value ?? null} min={0.01} max={1} digits={2} allowEmpty placeholder="–" ariaLabel={tr('shell.expert.col.g')} onCommit={(g) => update((p) => updateWindowType(p, w.id, { g }), typing(`w-g:${w.id}`))} />
                </td>
                <td>
                  {w.id === DEFAULT_WINDOW_TYPE_ID ? null : (
                    <DeleteButton label={tr('shell.expert.remove', { name: w.name })} onClick={() => update((p) => removeWindowType(p, w.id), ONCE)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="xtab__add">
        <button type="button" className="btn btn--ghost btn--small" onClick={() => update((p) => addWindowType(p, tr('shell.expert.windowTypes.new')), ONCE)} data-testid="x-add-window-type">
          <Icon name="plus" size={14} />
          <span>{tr('shell.expert.windowTypes.add')}</span>
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────── Lignes manuelles ─────────────────────────────

function ManualTab({ project, update, tr }: TabProps) {
  const { constructions, windowTypes, manualRows } = project.model;
  const typeValue = (row: ManualRow): string => (row.windowTypeId !== null ? `w:${row.windowTypeId}` : row.constructionId !== null ? `c:${row.constructionId}` : '');
  const setType = (row: ManualRow, value: string): void => {
    const patch: Partial<ManualRow> = value.startsWith('w:')
      ? { windowTypeId: value.slice(2), constructionId: null }
      : value.startsWith('c:')
        ? { constructionId: value.slice(2), windowTypeId: null }
        : { constructionId: null, windowTypeId: null };
    update((p) => updateManualRow(p, row.id, patch), ONCE);
  };
  const number = (row: ManualRow, field: 'count' | 'length' | 'width', label: string) => (
    <NumberField
      value={row[field]}
      min={0}
      max={100000}
      digits={2}
      ariaLabel={label}
      onCommit={(v) => v !== null && update((p) => updateManualRow(p, row.id, { [field]: v }), typing(`m-${field}:${row.id}`))}
    />
  );

  return (
    <div className="xtab">
      <p className="xtab__intro">{tr('shell.expert.manual.intro')}</p>
      {manualRows.length === 0 ? <p className="muted">{tr('shell.expert.manual.empty')}</p> : null}
      {manualRows.length > 0 ? (
        <div className="xtable-wrap">
          <table className="xtable" data-testid="x-manual">
            <thead>
              <tr>
                <th scope="col">{tr('shell.expert.col.label')}</th>
                <th scope="col">{tr('shell.expert.col.type')}</th>
                <th scope="col">{tr('shell.expert.col.count')}</th>
                <th scope="col">{tr('shell.expert.col.length')}</th>
                <th scope="col">{tr('shell.expert.col.width')}</th>
                <th scope="col">{tr('shell.expert.col.orientation')}</th>
                <th scope="col">{tr('shell.expert.col.boundary')}</th>
                <th scope="col">{tr('shell.expert.col.deduct')}</th>
                <th scope="col">
                  <span className="visually-hidden">{tr('shell.expert.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {manualRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      className="input"
                      type="text"
                      value={row.label}
                      aria-label={tr('shell.expert.col.label')}
                      onChange={(e) => update((p) => updateManualRow(p, row.id, { label: e.target.value }), typing(`m-label:${row.id}`))}
                    />
                  </td>
                  <td>
                    <select className="input" value={typeValue(row)} aria-label={tr('shell.expert.col.type')} onChange={(e) => setType(row, e.target.value)}>
                      <option value="">{tr('shell.expert.defaultType')}</option>
                      <optgroup label={tr('shell.expert.tab.constructions')}>
                        {constructions.map((c) => (
                          <option key={c.id} value={`c:${c.id}`}>
                            {c.name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label={tr('shell.expert.tab.windowTypes')}>
                        {windowTypes.map((w) => (
                          <option key={w.id} value={`w:${w.id}`}>
                            {w.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </td>
                  <td>{number(row, 'count', tr('shell.expert.col.count'))}</td>
                  <td>{number(row, 'length', tr('shell.expert.col.length'))}</td>
                  <td>{number(row, 'width', tr('shell.expert.col.width'))}</td>
                  <td>
                    <select
                      className="input"
                      value={row.orientation}
                      aria-label={tr('shell.expert.col.orientation')}
                      onChange={(e) => update((p) => updateManualRow(p, row.id, { orientation: e.target.value as OrientationOrHorizontal }), ONCE)}
                    >
                      {ORIENTATION_CHOICES.map((o) => (
                        <option key={o} value={o}>
                          {tr(`shell.orientation.${o}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="input"
                      value={row.boundary}
                      aria-label={tr('shell.expert.col.boundary')}
                      onChange={(e) => update((p) => updateManualRow(p, row.id, { boundary: e.target.value as Boundary }), ONCE)}
                    >
                      {BOUNDARIES.map((b) => (
                        <option key={b} value={b}>
                          {tr(`shell.boundary.${b}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="xtable__center">
                    <input type="checkbox" checked={row.deduct} aria-label={tr('shell.expert.col.deduct')} onChange={(e) => update((p) => updateManualRow(p, row.id, { deduct: e.target.checked }), ONCE)} />
                  </td>
                  <td>
                    <DeleteButton label={tr('shell.expert.remove', { name: row.label })} onClick={() => update((p) => removeManualRow(p, row.id), ONCE)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="xtab__add">
        <button type="button" className="btn btn--ghost btn--small" onClick={() => update((p) => addManualRow(p, tr('shell.expert.manual.new')), ONCE)} data-testid="x-add-manual">
          <Icon name="plus" size={14} />
          <span>{tr('shell.expert.manual.add')}</span>
        </button>
      </div>
      <p className="xtab__note">{tr('shell.expert.manual.deductNote')}</p>
    </div>
  );
}

// ───────────────────────────── Pièces ─────────────────────────────

function RoomsTab({ project, update, tr }: TabProps) {
  if (project.model.storeys.length === 0) return <p className="muted">{tr('shell.expert.noStorey')}</p>;
  return (
    <div className="xtab">
      <p className="xtab__intro">{tr('shell.expert.rooms.intro')}</p>
      {project.model.storeys.map((storey) => {
        const heated = storey.rooms.filter((r) => r.heated).reduce((sum, r) => sum + r.area.value, 0);
        return (
          <section key={storey.id} className="xgroup" aria-label={storey.name}>
            <h3 className="xgroup__title">
              {storey.name}
              <span className="xgroup__meta">{tr('shell.expert.rooms.sum', { area: fixed(heated, 2) })}</span>
              {storey.netAreaOverride ? <Badge tone="info">{tr('shell.expert.rooms.override', { area: fixed(storey.netAreaOverride.value, 2) })}</Badge> : null}
            </h3>
            {storey.rooms.length > 0 ? (
              <div className="xtable-wrap">
                <table className="xtable" data-testid="x-rooms">
                  <thead>
                    <tr>
                      <th scope="col">{tr('shell.expert.col.name')}</th>
                      <th scope="col">{tr('shell.expert.col.area')}</th>
                      <th scope="col">{tr('shell.expert.col.heated')}</th>
                      <th scope="col">{tr('shell.result.source')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{tr('shell.expert.col.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {storey.rooms.map((room) => (
                      <tr key={room.id} className={room.needsReview ? 'is-review' : ''}>
                        <td>
                          <input
                            className="input"
                            type="text"
                            value={room.name}
                            aria-label={tr('shell.expert.col.name')}
                            onChange={(e) => update((p) => updateRoom(p, storey.id, room.id, { name: e.target.value }), typing(`r-name:${room.id}`))}
                          />
                        </td>
                        <td>
                          <NumberField
                            value={room.area.value}
                            min={0}
                            max={100000}
                            digits={2}
                            unit="m²"
                            ariaLabel={tr('shell.expert.col.area.aria', { name: room.name })}
                            onCommit={(area) => area !== null && update((p) => updateRoom(p, storey.id, room.id, { area }), typing(`r-area:${room.id}`))}
                            testId="x-room-area"
                          />
                        </td>
                        <td className="xtable__center">
                          <input
                            type="checkbox"
                            checked={room.heated}
                            aria-label={tr('shell.expert.col.heated.aria', { name: room.name })}
                            onChange={(e) => update((p) => updateRoom(p, storey.id, room.id, { heated: e.target.checked }), ONCE)}
                            data-testid="x-room-heated"
                          />
                          {room.needsReview ? <Badge tone="warn">{tr('shell.expert.rooms.review')}</Badge> : null}
                        </td>
                        <td>
                          <ProvenanceTag from={room.area.from} />
                        </td>
                        <td>
                          <DeleteButton label={tr('shell.expert.remove', { name: room.name })} onClick={() => update((p) => removeRoom(p, storey.id, room.id), ONCE)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">{tr('shell.expert.rooms.empty')}</p>
            )}
            <div className="xtab__add">
              <button type="button" className="btn btn--ghost btn--small" onClick={() => update((p) => addRoom(p, storey.id, tr('shell.expert.rooms.new')), ONCE)} data-testid="x-add-room">
                <Icon name="plus" size={14} />
                <span>{tr('shell.expert.rooms.add')}</span>
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ───────────────────────────── Étages (données brutes) ─────────────────────────────

function OpeningRow({ storey, opening, project, update, tr }: TabProps & { storey: Storey; opening: Opening }) {
  const field = (name: 'width' | 'height', label: string) => (
    <NumberField
      value={opening[name]}
      min={0.05}
      max={30}
      digits={3}
      unit="m"
      ariaLabel={label}
      onCommit={(v) => v !== null && update((p) => updateOpening(p, storey.id, opening.id, { [name]: v }), typing(`o-${name}:${opening.id}`))}
    />
  );
  return (
    <tr>
      <td>
        <select
          className="input"
          value={opening.kind}
          aria-label={tr('shell.expert.col.kind')}
          onChange={(e) => update((p) => updateOpening(p, storey.id, opening.id, { kind: e.target.value === 'door' ? 'door' : 'window' }), ONCE)}
        >
          <option value="window">{tr('shell.expert.opening.window')}</option>
          <option value="door">{tr('shell.expert.opening.door')}</option>
        </select>
      </td>
      <td>
        <select
          className="input"
          value={opening.edgeIndex}
          aria-label={tr('shell.expert.col.edge')}
          onChange={(e) => update((p) => updateOpening(p, storey.id, opening.id, { edgeIndex: Number(e.target.value) }), ONCE)}
        >
          {storey.outline.map((_, i) => (
            <option key={i} value={i}>
              {tr('shell.expert.edge', { n: i + 1 })}
            </option>
          ))}
        </select>
      </td>
      <td>{field('width', tr('shell.expert.col.width'))}</td>
      <td>{field('height', tr('shell.expert.col.height'))}</td>
      <td>
        <NumberField
          value={opening.count}
          integer
          min={1}
          max={99}
          ariaLabel={tr('shell.expert.col.count')}
          onCommit={(v) => v !== null && update((p) => updateOpening(p, storey.id, opening.id, { count: v }), typing(`o-count:${opening.id}`))}
        />
      </td>
      <td>
        {opening.kind === 'window' ? (
          <select
            className="input"
            value={opening.windowTypeId ?? ''}
            aria-label={tr('shell.expert.col.type')}
            onChange={(e) => update((p) => updateOpening(p, storey.id, opening.id, { windowTypeId: e.target.value === '' ? null : e.target.value, from: opening.from }), ONCE)}
          >
            <option value="">{tr('shell.expert.defaultType')}</option>
            {project.model.windowTypes.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted">–</span>
        )}
      </td>
      <td>
        <ProvenanceTag from={opening.from} />
      </td>
      <td>
        <DeleteButton label={tr('shell.expert.opening.remove')} onClick={() => update((p) => removeOpening(p, storey.id, opening.id), ONCE)} />
      </td>
    </tr>
  );
}

function StoreysTab({ project, update, tr }: TabProps) {
  const documents = useShell((s) => s.documents);
  const sheets = allSheets(documents);
  if (project.model.storeys.length === 0) return <p className="muted">{tr('shell.expert.noStorey')}</p>;
  return (
    <div className="xtab">
      <p className="xtab__intro">{tr('shell.expert.storeys.intro')}</p>
      {project.model.storeys.map((storey, index) => {
        const metrics = safeStoreyMetrics(storey);
        const sheetRef = sheets.find((r) => r.sheet.id === storey.sheetId);
        return (
          <section key={storey.id} className="xgroup" aria-label={storey.name} data-testid="x-storey">
            <h3 className="xgroup__title">
              {index + 1}. {storey.name}
              <span className="xgroup__meta">
                {storey.sheetId === null
                  ? tr('shell.plan.storey.sheet.none')
                  : sheetRef
                    ? `${sheetRef.doc.fileName} › ${sheetRef.sheet.name}`
                    : tr('shell.plan.storey.sheet.missing', { file: fileNameOfSheetId(storey.sheetId) })}
              </span>
            </h3>
            <dl className="xfacts">
              <div>
                <dt>{tr('shell.expert.storeys.scale')}</dt>
                <dd>
                  {tr('shell.read.scale.unit', { length: unitLength(storey.metresPerUnit.value) })} <ProvenanceTag from={storey.metresPerUnit.from} />
                  {storey.metresPerUnit.from !== 'user' ? (
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => update((p) => confirmScale(p, storey.id), ONCE)}>
                      {tr('shell.plan.height.confirm')}
                    </button>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>{tr('shell.plan.height.gross')}</dt>
                <dd>
                  <NumberField
                    value={storey.grossHeight.value}
                    min={1}
                    max={15}
                    digits={2}
                    unit="m"
                    ariaLabel={tr('shell.plan.height.gross')}
                    onCommit={(v) => v !== null && update((p) => setStoreyHeight(p, storey.id, 'gross', v), typing(`s-gross:${storey.id}`))}
                  />
                  <ProvenanceTag from={storey.grossHeight.from} />
                </dd>
              </div>
              <div>
                <dt>{tr('shell.plan.height.clear')}</dt>
                <dd>
                  <NumberField
                    value={storey.clearHeight.value}
                    min={1}
                    max={15}
                    digits={2}
                    unit="m"
                    ariaLabel={tr('shell.plan.height.clear')}
                    onCommit={(v) => v !== null && update((p) => setStoreyHeight(p, storey.id, 'clear', v), typing(`s-clear:${storey.id}`))}
                  />
                  <ProvenanceTag from={storey.clearHeight.from} />
                </dd>
              </div>
              <div>
                <dt>{tr('shell.plan.netArea')}</dt>
                <dd>
                  <NumberField
                    value={storey.netAreaOverride?.value ?? null}
                    min={0}
                    max={100000}
                    digits={2}
                    unit="m²"
                    allowEmpty
                    placeholder={tr('shell.plan.netArea.placeholder')}
                    ariaLabel={tr('shell.plan.netArea')}
                    className="field--wide"
                    onCommit={(v) => update((p) => setNetArea(p, storey.id, v), typing(`s-net:${storey.id}`))}
                  />
                </dd>
              </div>
              {metrics ? (
                <div>
                  <dt>{tr('shell.plan.metrics.gross')}</dt>
                  <dd>
                    {fixed(metrics.grossArea, 2)} m² · {tr('shell.plan.metrics.perimeter')} {fixed(metrics.perimeter, 2)} m
                  </dd>
                </div>
              ) : null}
            </dl>

            {storey.outline.length >= 3 ? (
              <details className="xdetails">
                <summary>{tr('shell.expert.storeys.edges', { count: storey.edges.length })}</summary>
                <div className="xtable-wrap">
                  <table className="xtable" data-testid="x-edges">
                    <thead>
                      <tr>
                        <th scope="col">{tr('shell.expert.col.edge')}</th>
                        <th scope="col">{tr('shell.expert.col.length')}</th>
                        <th scope="col">{tr('shell.expert.col.boundary')}</th>
                        <th scope="col">{tr('shell.expert.col.type')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {storey.edges.map((edge, i) => (
                        <tr key={i}>
                          <td>{tr('shell.expert.edge', { n: i + 1 })}</td>
                          <td className="num">{metrics ? fixed(metrics.edgeLengths[i] ?? Number.NaN, 2) : '–'}</td>
                          <td>
                            <select
                              className="input"
                              value={edge.boundary}
                              aria-label={tr('shell.expert.col.boundary')}
                              onChange={(e) => update((p) => setEdge(p, storey.id, i, { boundary: e.target.value as Boundary }), ONCE)}
                            >
                              {BOUNDARIES.map((b) => (
                                <option key={b} value={b}>
                                  {tr(`shell.boundary.${b}`)}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              className="input"
                              value={edge.constructionId ?? ''}
                              aria-label={tr('shell.expert.col.type')}
                              onChange={(e) => update((p) => setEdge(p, storey.id, i, { constructionId: e.target.value === '' ? null : e.target.value }), ONCE)}
                            >
                              {constructionOptions(project.model.constructions, ['wall'], tr)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : (
              <p className="muted">{tr('shell.plan.status.outline.none')}</p>
            )}

            {storey.openings.length > 0 ? (
              <details className="xdetails">
                <summary>{tr('shell.expert.storeys.openings', { count: storey.openings.length })}</summary>
                <div className="xtable-wrap">
                  <table className="xtable" data-testid="x-openings">
                    <thead>
                      <tr>
                        <th scope="col">{tr('shell.expert.col.kind')}</th>
                        <th scope="col">{tr('shell.expert.col.edge')}</th>
                        <th scope="col">{tr('shell.expert.col.width')}</th>
                        <th scope="col">{tr('shell.expert.col.height')}</th>
                        <th scope="col">{tr('shell.expert.col.count')}</th>
                        <th scope="col">{tr('shell.expert.col.type')}</th>
                        <th scope="col">{tr('shell.result.source')}</th>
                        <th scope="col">
                          <span className="visually-hidden">{tr('shell.expert.col.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {storey.openings.map((o) => (
                        <OpeningRow key={o.id} storey={storey} opening={o} project={project} update={update} tr={tr} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

const TABS: Record<ExpertTab, (props: TabProps) => ReactNode> = {
  constructions: ConstructionsTab,
  windowTypes: WindowTypesTab,
  manual: ManualTab,
  rooms: RoomsTab,
  storeys: StoreysTab,
};

export function ExpertPanel() {
  const tr = useT();
  const store = useShellStore();
  const open = useShell((s) => s.expertOpen);
  const tab = useShell((s) => s.expertTab);
  const project = useShell(selectProject);
  if (!open) return null;
  const Tab = TABS[tab];

  return (
    <Dialog variant="drawer" title={tr('shell.expert')} subtitle={tr('shell.expert.subtitle')} onClose={() => store.getState().setExpert(false)} testId="expert-panel">
      <div className="xtabs" role="tablist" aria-label={tr('shell.expert')}>
        {EXPERT_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`xtab-${id}`}
            aria-selected={tab === id}
            aria-controls="xtab-panel"
            className={`xtabs__tab ${tab === id ? 'is-active' : ''}`}
            onClick={() => store.getState().setExpert(true, id)}
            data-testid={`x-tab-${id}`}
            {...(tab === id ? { 'data-autofocus': '' } : {})}
          >
            {tr(`shell.expert.tab.${id}`)}
          </button>
        ))}
      </div>
      <div id="xtab-panel" role="tabpanel" aria-labelledby={`xtab-${tab}`}>
        <Tab project={project} update={store.getState().updateProject} tr={tr} />
      </div>
    </Dialog>
  );
}
