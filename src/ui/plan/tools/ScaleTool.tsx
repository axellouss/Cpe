/**
 * Outil « poser la règle » : deux points sur une cote connue, puis sa longueur réelle → échelle de l'étage.
 *
 * L'erreur d'échelle domine toutes les autres (une cote de 1 m donne ~8 % d'erreur de surface, la plus longue
 * cote ~0,6 %) : l'outil pousse donc vers la cote la plus longue et montre aussitôt la taille obtenue.
 * Le contour reste en unités de feuille : rien n'est redimensionné, seule `metresPerUnit` change.
 */
import { useState } from 'react';
import { bboxOf, closestOnSegment } from '../../../core/geometry';
import type { Vec2 } from '../../../core/types';
import { rescaleStorey } from '../../../engine';
import { hitRadius } from '../hitTest';
import { Button, Counter, Hint, Popover } from '../hud';
import { formatDecimal, parseLengthMetres } from '../numbers';
import { EdgeLines, GhostOutlines, Label, OutlineFill, SnapOverlay } from '../shapes';
import type { GuideLine, SnapResult } from '../snapping';
import { Actions, BottomBar, CounterRow, Overlay, TopBar, scaleIsGuess, snapPointer, useController } from '../toolShared';
import type { DragSession, PointerInfo, ToolContext } from '../toolTypes';
import { screenToSheet, sheetToScreen } from '../view';

/** En dessous de cette part de la plus grande dimension du plan, la cote est jugée « courte ». */
const SHORT_RULER_RATIO = 0.5;
/** Dimensions hors desquelles un contour de bâtiment d'habitation mérite un second regard (m). */
const PLAUSIBLE_MIN = 4;
const PLAUSIBLE_MAX = 60;

function axisGuides(origin: Vec2): GuideLine[] {
  return [
    { origin, dir: { x: 1, y: 0 }, kind: 'ortho' },
    { origin, dir: { x: 0, y: 1 }, kind: 'ortho' },
  ];
}

export function ScaleTool({ ctx }: { ctx: ToolContext }) {
  const { storey, view, sheet, tr } = ctx;
  const [a, setA] = useState<Vec2 | null>(null);
  const [b, setB] = useState<Vec2 | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [hover, setHoverState] = useState<SnapResult | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const guess = scaleIsGuess(storey);
  const currentMpu = storey.metresPerUnit.value;

  /** Affiche le point d'accrochage et le signale à l'éditeur (loupe du pointage tactile). */
  const show = (s: SnapResult | null): void => {
    setHoverState(s);
    ctx.aim(s ? s.point : null);
  };

  const snap = (p: PointerInfo, anchor: Vec2 | null): SnapResult =>
    snapPointer(ctx, p, { guides: anchor ? axisGuides(anchor) : [], vertices: storey.outline });

  // Étendue de référence pour juger la cote et montrer la taille obtenue : le contour s'il existe, sinon la feuille.
  const extent = (() => {
    if (storey.outline.length >= 3) {
      const bb = bboxOf(storey.outline);
      return { w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, kind: 'outline' as const };
    }
    const bb = ctx.index && ctx.index.count > 0 ? ctx.index.bbox : sheet ? sheet.bbox : null;
    if (!bb) return null;
    return { w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, kind: 'sheet' as const };
  })();

  const rulerUnits = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  const typed = parseLengthMetres(text);
  const currentMetres = rulerUnits * currentMpu;
  const newMpu = typed !== null && rulerUnits > 0 ? typed / rulerUnits : null;
  const short = !!extent && rulerUnits > 0 && rulerUnits < SHORT_RULER_RATIO * Math.max(extent.w, extent.h);
  const deviation = !guess && typed !== null && currentMetres > 0 ? Math.abs(typed - currentMetres) / currentMetres : null;
  const resultMpu = newMpu ?? (guess ? null : currentMpu);
  const resultSize = extent && resultMpu !== null ? { w: extent.w * resultMpu, h: extent.h * resultMpu } : null;
  const implausible =
    !!resultSize &&
    extent?.kind === 'outline' &&
    (Math.max(resultSize.w, resultSize.h) > PLAUSIBLE_MAX || Math.max(resultSize.w, resultSize.h) < PLAUSIBLE_MIN);

  const openEditor = (pa: Vec2, pb: Vec2): void => {
    const metres = Math.hypot(pb.x - pa.x, pb.y - pa.y) * currentMpu;
    setText(guess ? '' : formatDecimal(metres, 2));
    setOpen(true);
  };

  const restart = (): void => {
    setA(null);
    setB(null);
    setOpen(false);
    setApplied(null);
    show(null);
    ctx.focusSurface();
  };

  const apply = (): void => {
    if (typed === null || !(rulerUnits > 0)) return;
    const next = rescaleStorey(storey, {
      value: typed / rulerUnits,
      from: 'user',
      note: tr('plan.scale.note', { length: formatDecimal(typed, 2) }),
    });
    ctx.commit(next);
    setApplied(typed);
    setOpen(false);
    ctx.done();
    ctx.focusSurface();
  };

  const endSession = (which: 'a' | 'b'): DragSession => {
    const other = which === 'a' ? b! : a!;
    const start = which === 'a' ? a! : b!;
    let current = start;
    const place = (p: PointerInfo): void => {
      const s = snap(p, other);
      current = s.point;
      if (which === 'a') setA(current);
      else setB(current);
      show(s);
    };
    return {
      move(p) {
        setDragging(true);
        setApplied(null);
        setOpen(false);
        place(p);
      },
      end(p) {
        place(p);
        setDragging(false);
        show(null);
        if (which === 'a') openEditor(current, other);
        else openEditor(other, current);
      },
      cancel() {
        setDragging(false);
        show(null);
        if (which === 'a') setA(start);
        else setB(start);
      },
    };
  };

  /** Toucher : première extrémité, seconde extrémité, puis réouverture de la saisie ou nouvelle règle. */
  const place = (p: PointerInfo): void => {
    if (!a) {
      setA(snap(p, null).point);
      show(null);
      return;
    }
    if (!b) {
      const s = snap(p, a);
      if (Math.hypot(s.point.x - a.x, s.point.y - a.y) * view.scale < 8) return; // deux points confondus
      setB(s.point);
      show(null);
      openEditor(a, s.point);
      return;
    }
    if (open) {
      setOpen(false);
      return;
    }
    // Règle posée : toucher la règle rouvre la saisie, toucher ailleurs recommence une règle.
    const onRuler = closestOnSegment(screenToSheet(view, p.screen), a, b).distance * view.scale <= hitRadius(p.pointerType);
    if (onRuler) {
      openEditor(a, b);
      return;
    }
    setA(snap(p, null).point);
    setB(null);
    setApplied(null);
  };

  /** Au doigt ou au stylet : poser, glisser pour viser (la loupe montre le point), relâcher pour poser l'extrémité. */
  const aimSession = (): DragSession => ({
    move(p) {
      show(snap(p, a));
    },
    end(p) {
      place(p);
    },
    cancel() {
      show(null);
    },
  });

  useController(ctx, {
    dragStart(p) {
      if (!a || !b) return p.pointerType === 'mouse' ? null : aimSession();
      const r = hitRadius(p.pointerType);
      const sa = sheetToScreen(view, a);
      const sb = sheetToScreen(view, b);
      const da = Math.hypot(sa.x - p.screen.x, sa.y - p.screen.y);
      const db = Math.hypot(sb.x - p.screen.x, sb.y - p.screen.y);
      if (Math.min(da, db) > r) return null;
      return endSession(da <= db ? 'a' : 'b');
    },
    tap(p) {
      place(p);
    },
    hover(p) {
      if (!p || (a && b)) {
        if (!dragging) show(null);
        return;
      }
      show(snap(p, a));
    },
    key(e) {
      if (e.key === 'Escape') {
        if (open) setOpen(false);
        else if (b) {
          setB(null);
          setApplied(null);
        } else if (a) setA(null);
        else return false;
        return true;
      }
      return false;
    },
  });

  // ───────────── Affichage ─────────────

  const tip = b ?? (a && hover ? hover.point : null);
  const sa = a ? sheetToScreen(view, a) : null;
  const sb = tip ? sheetToScreen(view, tip) : null;
  let ruler = null;
  if (sa && sb) {
    const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
    const nx = len > 0 ? -(sb.y - sa.y) / len : 0;
    const ny = len > 0 ? (sb.x - sa.x) / len : 0;
    const units = len / view.scale;
    const caption =
      applied !== null && b
        ? `${formatDecimal(applied, 2)} m ✓`
        : guess
          ? b
            ? '? m'
            : ''
          : `${formatDecimal(units * currentMpu, 2)} m`;
    ruler = (
      <g className={`p2c-plan__ruler ${applied !== null ? 'is-applied' : ''}`}>
        <line className="p2c-plan__ruler-halo" x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} />
        <line className="p2c-plan__ruler-line" x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} />
        <line className="p2c-plan__ruler-line" x1={sa.x - nx * 9} y1={sa.y - ny * 9} x2={sa.x + nx * 9} y2={sa.y + ny * 9} />
        <line className="p2c-plan__ruler-line" x1={sb.x - nx * 9} y1={sb.y - ny * 9} x2={sb.x + nx * 9} y2={sb.y + ny * 9} />
        <circle className="p2c-plan__ruler-end" cx={sa.x} cy={sa.y} r={5} />
        {b ? <circle className="p2c-plan__ruler-end" cx={sb.x} cy={sb.y} r={5} /> : null}
        {caption && len > 36 ? (
          <Label x={(sa.x + sb.x) / 2 + nx * 16} y={(sa.y + sb.y) / 2 + ny * 16} className="p2c-plan__label--live">
            {caption}
          </Label>
        ) : null}
      </g>
    );
  }

  const hintKey = applied !== null ? 'plan.scale.hintDone' : !a ? 'plan.scale.hint1' : !b ? 'plan.scale.hint2' : 'plan.scale.hint3';
  const statusKey =
    storey.metresPerUnit.from === 'user'
      ? 'plan.scale.status.user'
      : storey.metresPerUnit.from === 'plan'
        ? 'plan.scale.status.plan'
        : guess
          ? 'plan.scale.status.unknown'
          : 'plan.scale.status.other';
  const sizeText = (s: { w: number; h: number }): string => `${formatDecimal(s.w, 2)} × ${formatDecimal(s.h, 2)} m`;
  const anchor = sa && sb && b ? { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 } : null;
  const currentSize = extent && !guess ? { w: extent.w * currentMpu, h: extent.h * currentMpu } : null;

  return (
    <>
      <Overlay ctx={ctx}>
        <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
        <OutlineFill outline={storey.outline} view={view} className="p2c-plan__fill--muted" />
        <EdgeLines outline={storey.outline} edges={storey.edges} view={view} className="p2c-plan__edge--muted" />
        {ruler}
        {!b || dragging ? <SnapOverlay snap={hover} view={view} size={ctx.size} /> : null}
      </Overlay>
      <TopBar>
        <Hint icon="↔">
          {!a && applied === null ? <strong>{tr('plan.scale.longest')} </strong> : null}
          {tr(hintKey)}
          {ctx.coarse && !b ? <span className="p2c-plan__hint-sub"> {tr(ctx.compact ? 'plan.touch.aimShort' : 'plan.touch.aim')}</span> : null}
        </Hint>
        {a ? (
          <Actions>
            <Button onClick={restart} testId="plan-scale-restart">
              {tr('plan.scale.restart')}
            </Button>
            <Button onClick={() => ctx.setMagnet(!ctx.magnet)} pressed={ctx.magnet} title={tr('plan.magnet.title')}>
              {tr('plan.magnet')}
            </Button>
          </Actions>
        ) : null}
      </TopBar>
      {open && anchor ? (
        <Popover anchor={anchor} size={ctx.size} compact={ctx.compact} label={tr('plan.scale.title')} onClose={() => setOpen(false)} testId="plan-scale-popover">
          <form
            className="p2c-plan__form"
            onSubmit={(e) => {
              e.preventDefault();
              apply();
            }}
          >
            <label className="p2c-plan__field">
              <span className="p2c-plan__field-label">{tr('plan.scale.title')}</span>
              <span className="p2c-plan__input-row">
                <input
                  className="p2c-plan__input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={text}
                  placeholder="12,50"
                  onChange={(e) => setText(e.target.value)}
                  aria-invalid={text !== '' && typed === null}
                  data-autofocus=""
                  data-testid="plan-scale-input"
                />
                <span className="p2c-plan__unit">m</span>
              </span>
            </label>
            {resultSize ? (
              <p className={`p2c-plan__result ${implausible ? 'is-warn' : ''}`} data-testid="plan-scale-result">
                {tr(extent?.kind === 'outline' ? 'plan.scale.resultOutline' : 'plan.scale.resultSheet', { size: sizeText(resultSize) })}
                {implausible ? <span className="p2c-plan__result-note"> {tr('plan.scale.implausible')}</span> : null}
              </p>
            ) : null}
            {short ? <p className="p2c-plan__note is-warn">{tr('plan.scale.short')}</p> : null}
            {!guess && rulerUnits > 0 ? (
              <p className="p2c-plan__note">
                {tr('plan.scale.current', { length: formatDecimal(currentMetres, 2) })}
                {deviation !== null && typed !== null
                  ? deviation < 0.01
                    ? ` ${tr('plan.scale.agree')}`
                    : ` ${tr('plan.scale.deviation', { percent: formatDecimal(deviation * 100, 1) })}`
                  : ''}
              </p>
            ) : null}
            <div className="p2c-plan__form-actions">
              <button type="submit" className="p2c-plan__btn p2c-plan__btn--primary" disabled={typed === null} data-testid="plan-scale-apply">
                {tr('plan.scale.apply')}
              </button>
              <Button onClick={() => setOpen(false)}>{tr('plan.cancel')}</Button>
            </div>
          </form>
        </Popover>
      ) : null}
      <BottomBar>
        <CounterRow ctx={ctx}>
          <Counter
            label={tr('plan.counter.scale')}
            value={tr(statusKey)}
            tone={storey.metresPerUnit.from === 'user' ? 'accent' : guess ? 'warn' : 'plain'}
            title={storey.metresPerUnit.note}
            testId="plan-scale-status"
          />
          {currentSize ? (
            <Counter label={tr(extent?.kind === 'outline' ? 'plan.counter.outlineSize' : 'plan.counter.sheetSize')} value={sizeText(currentSize)} testId="plan-scale-size" />
          ) : null}
        </CounterRow>
      </BottomBar>
    </>
  );
}
