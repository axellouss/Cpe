/**
 * Outil « ouvertures » : toucher une façade pour y poser une fenêtre ou une porte, toucher une ouverture pour la
 * corriger ou la supprimer. Dimensions = baie BRUTE du gros œuvre (« Rohbaumaß »), rappelé une fois.
 */
import { useState } from 'react';
import { edgeLength, round } from '../../../core/geometry';
import type { Opening, Vec2 } from '../../../core/types';
import { DEFAULT_WINDOW_TYPE_ID } from '../../../engine';
import { hitEdge, hitOpening, hitRadius } from '../hitTest';
import { Button, Counter, Hint, Popover, QuickChips, Segmented, Stepper } from '../hud';
import { formatDecimal, parseOpeningDimension } from '../numbers';
import { DEFAULT_SIZE, OPENING_LIMITS, QUICK_SIZES, checkOpening, isBlocking, openingMark, openingTotals } from '../openings';
import type { OpeningKind } from '../openings';
import { addOpening, pointOnEdge, removeOpening, syncedEdges, updateOpening } from '../outlineOps';
import { EdgeLines, GhostOutlines, OpeningMarks, OutlineFill, openingLabel } from '../shapes';
import { BottomBar, CounterRow, Overlay, ScaleWarning, TopBar, scaleIsGuess, useController } from '../toolShared';
import type { ToolContext } from '../toolTypes';
import { sheetToScreen } from '../view';

type Editor = { mode: 'new'; edge: number; position: number } | { mode: 'edit'; id: string };

interface Form {
  kind: OpeningKind;
  widthText: string;
  heightText: string;
  count: number;
  windowTypeId: string | null;
}

/**
 * Mémoire de la séance : un expert saisit souvent dix fois la même fenêtre. La dernière taille validée de chaque
 * type sert de point de départ à la suivante. (État de module, volontairement partagé et non persistant.)
 */
const memory: { kind: OpeningKind; sizes: Record<OpeningKind, { width: number; height: number }>; windowTypeId: string | null; reminded: boolean } = {
  kind: 'window',
  sizes: { window: { ...DEFAULT_SIZE.window }, door: { ...DEFAULT_SIZE.door } },
  windowTypeId: null,
  reminded: false,
};

const PREVIEW_ID = '__p2c-preview__';

export function OpeningTool({ ctx }: { ctx: ToolContext }) {
  const { storey, view, tr } = ctx;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [form, setForm] = useState<Form>({ kind: 'window', widthText: '', heightText: '', count: 1, windowTypeId: null });
  const [hot, setHot] = useState<{ edge: number } | { opening: string } | null>(null);
  const [showReminder] = useState(() => !memory.reminded);

  const edges = syncedEdges(storey);
  const mpu = storey.metresPerUnit.value;
  const hasOutline = storey.outline.length >= 3;
  const defaultTypeId = ctx.windowTypes.find((w) => w.id === DEFAULT_WINDOW_TYPE_ID)?.id ?? ctx.windowTypes[0]?.id ?? null;
  const knownType = (id: string | null): string | null => (id !== null && ctx.windowTypes.some((w) => w.id === id) ? id : null);

  // L'ouverture en cours d'édition peut disparaître (annuler du shell) : la bulle se ferme alors d'elle-même.
  const editing = editor?.mode === 'edit' ? (storey.openings.find((o) => o.id === editor.id) ?? null) : null;
  const active: Editor | null =
    editor === null ? null : editor.mode === 'edit' ? (editing ? editor : null) : editor.edge < storey.outline.length ? editor : null;
  const activeEdge = active ? (active.mode === 'new' ? active.edge : editing!.edgeIndex) : null;
  const edgeMetres = activeEdge !== null ? edgeLength(storey.outline, activeEdge) * mpu : null;

  const width = parseOpeningDimension(form.widthText);
  const height = parseOpeningDimension(form.heightText);
  const issues = checkOpening({ kind: form.kind, width, height, count: form.count }, scaleIsGuess(storey) ? null : edgeMetres);
  const blocked = isBlocking(issues);

  const openNew = (edge: number, position: number): void => {
    const size = memory.sizes[memory.kind];
    setForm({
      kind: memory.kind,
      widthText: formatDecimal(size.width, 2),
      heightText: formatDecimal(size.height, 2),
      count: 1,
      windowTypeId: knownType(memory.windowTypeId),
    });
    setEditor({ mode: 'new', edge, position });
  };

  const openEdit = (o: Opening): void => {
    setForm({
      kind: o.kind,
      widthText: formatDecimal(o.width, 2),
      heightText: formatDecimal(o.height, 2),
      count: o.count,
      windowTypeId: knownType(o.windowTypeId),
    });
    setEditor({ mode: 'edit', id: o.id });
  };

  const close = (): void => {
    setEditor(null);
    ctx.focusSurface();
  };

  const setKind = (kind: OpeningKind): void => {
    if (kind === form.kind) return;
    const size = memory.sizes[kind];
    setForm({ ...form, kind, widthText: formatDecimal(size.width, 2), heightText: formatDecimal(size.height, 2) });
  };

  const save = (): void => {
    if (!active || blocked || width === null || height === null) return;
    const values = {
      kind: form.kind,
      width: round(width, 3),
      height: round(height, 3),
      count: form.count,
      windowTypeId: form.kind === 'window' && form.windowTypeId !== defaultTypeId ? form.windowTypeId : null,
    };
    if (active.mode === 'new') ctx.commit(addOpening(storey, { edgeIndex: active.edge, position: active.position, ...values }));
    else ctx.commit(updateOpening(storey, active.id, values));
    memory.kind = values.kind;
    memory.sizes[values.kind] = { width: values.width, height: values.height };
    memory.windowTypeId = values.windowTypeId;
    memory.reminded = true;
    close();
  };

  const remove = (id: string): void => {
    ctx.commit(removeOpening(storey, id));
    close();
  };

  const pick = (p: { screen: Vec2; pointerType: string }): { opening: Opening } | { edge: number; t: number } | null => {
    const r = hitRadius(p.pointerType);
    const id = hitOpening(storey.outline, storey.openings, mpu, view, p.screen, r);
    if (id !== null) {
      const o = storey.openings.find((x) => x.id === id);
      if (o) return { opening: o };
    }
    const hit = hitEdge(storey.outline, view, p.screen, r * 1.3);
    return hit ? { edge: hit.index, t: hit.t } : null;
  };

  useController(ctx, {
    tap(p) {
      if (!hasOutline) return;
      const hit = pick(p);
      if (!hit) setEditor(null);
      else if ('opening' in hit) openEdit(hit.opening);
      else openNew(hit.edge, hit.t);
    },
    hover(p) {
      if (!p || !hasOutline) {
        setHot(null);
        return;
      }
      const hit = pick(p);
      setHot(!hit ? null : 'opening' in hit ? { opening: hit.opening.id } : { edge: hit.edge });
    },
    key(e) {
      if (e.key === 'Escape' && active) {
        setEditor(null);
        return true;
      }
      return false;
    },
  });

  // Ouvertures affichées : la saisie en cours est rendue en direct (aperçu de la largeur sur la façade).
  const live = { kind: form.kind, width: width ?? 0.01, height: height ?? 0.01, count: form.count };
  let shown: Opening[] = storey.openings;
  let anchorSheet: Vec2 | null = null;
  if (active?.mode === 'edit' && editing) {
    shown = storey.openings.map((o) => (o.id === editing.id ? { ...o, ...live, from: 'user' } : o));
    anchorSheet = openingMark(storey.outline, { ...editing, width: live.width }, mpu)?.centre ?? null;
  } else if (active?.mode === 'new') {
    const preview: Opening = { id: PREVIEW_ID, edgeIndex: active.edge, position: active.position, windowTypeId: null, from: 'user', ...live };
    shown = [...storey.openings, preview];
    anchorSheet = openingMark(storey.outline, preview, mpu)?.centre ?? pointOnEdge(storey.outline, active.edge, active.position);
  }
  const selectedId = active ? (active.mode === 'edit' ? active.id : PREVIEW_ID) : hot && 'opening' in hot ? hot.opening : null;

  const windows = openingTotals(storey.openings, 'window');
  const doors = openingTotals(storey.openings, 'door');
  const kindLabel = (k: OpeningKind): string => tr(k === 'window' ? 'plan.opening.window' : 'plan.opening.door');
  const sizes = QUICK_SIZES[form.kind];
  const title = active?.mode === 'edit' ? tr('plan.opening.editTitle') : tr('plan.opening.newTitle');

  return (
    <>
      <Overlay ctx={ctx}>
        <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
        <OutlineFill outline={storey.outline} view={view} className="p2c-plan__fill--muted" />
        <EdgeLines
          outline={storey.outline}
          edges={edges}
          view={view}
          colored
          className="p2c-plan__edge--thin"
          highlight={activeEdge ?? (hot && 'edge' in hot ? hot.edge : null)}
          interaction={{
            label: (i) => tr('plan.opening.edgeAria', { n: i + 1, length: formatDecimal(edgeLength(storey.outline, i) * mpu, 2) }),
            activate: (i) => openNew(i, 0.5),
          }}
        />
        <OpeningMarks
          outline={storey.outline}
          openings={shown}
          metresPerUnit={mpu}
          view={view}
          labels
          selectedId={selectedId}
          interaction={{
            label: (o) => tr('plan.opening.markAria', { kind: kindLabel(o.kind), size: openingLabel(o) }),
            activate: (o) => {
              if (o.id !== PREVIEW_ID) openEdit(o);
            },
            remove: (o) => {
              if (o.id !== PREVIEW_ID) remove(o.id);
            },
          }}
        />
      </Overlay>
      <TopBar>
        <Hint>{tr(hasOutline ? 'plan.opening.hint' : 'plan.needOutline')}</Hint>
      </TopBar>
      {active && anchorSheet ? (
        <Popover
          key={active.mode === 'edit' ? active.id : `new-${active.edge}-${active.position.toFixed(4)}`}
          anchor={sheetToScreen(view, anchorSheet)}
          size={ctx.size}
          compact={ctx.compact}
          label={title}
          onClose={close}
          className="p2c-plan__popover--opening"
          testId="plan-opening-popover"
        >
          <form
            className="p2c-plan__form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <p className="p2c-plan__popover-title">
              {title}
              {edgeMetres !== null && !scaleIsGuess(storey) ? (
                <span className="p2c-plan__muted"> · {tr('plan.opening.onFacade', { length: formatDecimal(edgeMetres, 2) })}</span>
              ) : null}
            </p>
            <Segmented<OpeningKind>
              name="p2c-opening-kind"
              label={tr('plan.opening.kind')}
              value={form.kind}
              options={[
                { value: 'window', label: kindLabel('window') },
                { value: 'door', label: kindLabel('door') },
              ]}
              onChange={setKind}
            />
            <div className="p2c-plan__pair">
              <div className="p2c-plan__field">
                <label className="p2c-plan__field-label" htmlFor="p2c-opening-width">
                  {tr('plan.opening.width')}
                </label>
                <span className="p2c-plan__input-row">
                  <input
                    id="p2c-opening-width"
                    className="p2c-plan__input"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={form.widthText}
                    onChange={(e) => setForm({ ...form, widthText: e.target.value })}
                    aria-invalid={issues.includes('width')}
                    data-autofocus=""
                    data-testid="plan-opening-width"
                  />
                  <span className="p2c-plan__unit">m</span>
                </span>
                <QuickChips values={sizes.widths} current={width} label={tr('plan.opening.widthChips')} onPick={(v) => setForm({ ...form, widthText: formatDecimal(v, 2) })} />
              </div>
              <div className="p2c-plan__field">
                <label className="p2c-plan__field-label" htmlFor="p2c-opening-height">
                  {tr('plan.opening.height')}
                </label>
                <span className="p2c-plan__input-row">
                  <input
                    id="p2c-opening-height"
                    className="p2c-plan__input"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={form.heightText}
                    onChange={(e) => setForm({ ...form, heightText: e.target.value })}
                    aria-invalid={issues.includes('height')}
                    data-testid="plan-opening-height"
                  />
                  <span className="p2c-plan__unit">m</span>
                </span>
                <QuickChips values={sizes.heights} current={height} label={tr('plan.opening.heightChips')} onPick={(v) => setForm({ ...form, heightText: formatDecimal(v, 2) })} />
              </div>
            </div>
            <div className="p2c-plan__pair">
              <div className="p2c-plan__field">
                <span className="p2c-plan__field-label">{tr('plan.opening.count')}</span>
                <Stepper
                  value={form.count}
                  min={1}
                  max={OPENING_LIMITS.maxCount}
                  onChange={(count) => setForm({ ...form, count })}
                  label={tr('plan.opening.count')}
                  lessLabel={tr('plan.opening.less')}
                  moreLabel={tr('plan.opening.more')}
                />
              </div>
              {form.kind === 'window' && ctx.windowTypes.length > 1 ? (
                <label className="p2c-plan__field">
                  <span className="p2c-plan__field-label">{tr('plan.opening.type')}</span>
                  <select
                    className="p2c-plan__select"
                    value={form.windowTypeId ?? defaultTypeId ?? ''}
                    onChange={(e) => setForm({ ...form, windowTypeId: e.target.value })}
                    data-testid="plan-opening-type"
                  >
                    {ctx.windowTypes.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {issues.includes('width') || issues.includes('height') ? (
              <p className="p2c-plan__note is-warn" role="alert">
                {tr('plan.opening.invalid')}
              </p>
            ) : issues.includes('widerThanEdge') && edgeMetres !== null ? (
              <p className="p2c-plan__note is-warn" role="alert">
                {tr('plan.opening.tooWide', { length: formatDecimal(edgeMetres, 2) })}
              </p>
            ) : null}
            {showReminder ? <p className="p2c-plan__note">{tr('plan.opening.roughReminder')}</p> : null}
            <div className="p2c-plan__form-actions">
              <button type="submit" className="p2c-plan__btn p2c-plan__btn--primary" disabled={blocked} data-testid="plan-opening-save">
                {tr(active.mode === 'edit' ? 'plan.opening.save' : 'plan.opening.add')}
              </button>
              {active.mode === 'edit' ? (
                <Button variant="danger" onClick={() => remove(active.id)} testId="plan-opening-delete">
                  {tr('plan.opening.delete')}
                </Button>
              ) : null}
              <Button onClick={close}>{tr('plan.cancel')}</Button>
            </div>
          </form>
        </Popover>
      ) : null}
      <BottomBar>
        <CounterRow ctx={ctx}>
          <Counter
            label={tr('plan.counter.windows')}
            value={`${windows.count} · ${formatDecimal(windows.area, 2)}`}
            unit="m²"
            testId="plan-counter-windows"
          />
          <Counter label={tr('plan.counter.doors')} value={`${doors.count} · ${formatDecimal(doors.area, 2)}`} unit="m²" testId="plan-counter-doors" />
          <ScaleWarning ctx={ctx} storey={storey} />
        </CounterRow>
      </BottomBar>
    </>
  );
}
