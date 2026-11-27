/**
 * Outil « contour » : accepter ou corriger le contour proposé, ou le tracer point par point.
 * Rappel permanent : le trait suit la FACE EXTÉRIEURE des murs (tracer la face intérieure coûte ~17 % de surface).
 */
import { useId, useRef, useState } from 'react';
import { isSelfIntersecting, polygonArea } from '../../../core/geometry';
import type { Storey, Vec2 } from '../../../core/types';
import { hitMidpoint, hitRadius, hitVertex } from '../hitTest';
import { Button, Counter, Hint, Popover } from '../hud';
import { formatDecimal } from '../numbers';
import { dedupeOutline, deleteVertex, insertVertex, moveVertex, replaceOutline } from '../outlineOps';
import {
  EdgeLengthLabels,
  EdgeLines,
  GhostOutlines,
  Label,
  MidpointHandles,
  OutlineFill,
  RightAngleMarks,
  SnapOverlay,
  VertexHandles,
  WallBand,
  outsideLabel,
  toPoints,
} from '../shapes';
import { dragGuides, traceGuides } from '../snapping';
import type { SnapResult } from '../snapping';
import {
  Actions,
  AreaCounters,
  BottomBar,
  CounterRow,
  Overlay,
  ScaleWarning,
  TopBar,
  blankGridStep,
  scaleIsGuess,
  snapPointer,
  useController,
} from '../toolShared';
import type { DragSession, PointerInfo, ToolContext, Translate } from '../toolTypes';
import { sheetToScreen } from '../view';

type Mode = 'edit' | 'trace' | 'proposal';

/** Épaisseur de mur figurée par la bande intérieure (m). */
const WALL_BAND_METRES = 0.4;

function snapHint(tr: Translate, snap: SnapResult | null): string | null {
  if (!snap) return null;
  const parts: string[] = [];
  if (snap.kind === 'close') parts.push(tr('plan.snap.close'));
  else if (snap.kind === 'endpoint') parts.push(tr('plan.snap.endpoint'));
  else if (snap.kind === 'intersection') parts.push(tr('plan.snap.intersection'));
  else if (snap.kind === 'vertex') parts.push(tr('plan.snap.vertex'));
  // Les guides sur lesquels tombe le point : « angle droit », « dans l'axe », « aligné ».
  const kinds = new Set(snap.guides.map((g) => g.kind));
  if (kinds.has('ortho')) parts.push(tr('plan.snap.ortho'));
  if (kinds.has('straight')) parts.push(tr('plan.snap.straight'));
  if (kinds.has('align')) parts.push(tr('plan.snap.align'));
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function OutlineTool({ ctx }: { ctx: ToolContext }) {
  const { storey, view, sheet, tr } = ctx;
  const clipId = useId().replace(/:/g, '');
  const detected = sheet?.detected.outline && sheet.detected.outline.length >= 3 ? sheet.detected.outline : null;

  const [mode, setMode] = useState<Mode>(() => (storey.outline.length >= 3 ? 'edit' : detected ? 'proposal' : 'trace'));
  const [trace, setTrace] = useState<Vec2[]>([]);
  const [hover, setHoverState] = useState<SnapResult | null>(null);
  const [draft, setDraft] = useState<Storey | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const [moving, setMoving] = useState<number | null>(null);
  const nudging = useRef(false);

  /** Affiche le point d'accrochage et le signale à l'éditeur (loupe du pointage tactile). */
  const show = (snap: SnapResult | null): void => {
    setHoverState(snap);
    ctx.aim(snap ? snap.point : null);
  };

  const shown = draft ?? storey;
  const hasOutline = shown.outline.length >= 3;
  // L'étage peut changer sous nos pieds (annuler/rétablir du shell) : le mode suit ce qui existe réellement.
  const effMode: Mode =
    mode === 'trace' ? 'trace' : hasOutline ? 'edit' : detected ? 'proposal' : 'trace';
  const selectedIndex = selected !== null && selected < shown.outline.length ? selected : null;

  const ghostVertices = ctx.ghostStoreys.flatMap((g) => g.outline);
  const mpu = shown.metresPerUnit.value;
  const approx = scaleIsGuess(shown);

  // ───────────── Tracé ─────────────

  const traceSnap = (p: PointerInfo): SnapResult =>
    snapPointer(ctx, p, {
      guides: traceGuides(trace),
      vertices: [...storey.outline, ...ghostVertices],
      closePoint: trace.length >= 3 ? trace[0]! : null,
    });

  const finishTrace = (points: readonly Vec2[]): void => {
    const pts = dedupeOutline(points, 0.5 / view.scale);
    if (pts.length < 3 || !(polygonArea(pts) > 0)) return;
    ctx.commit(replaceOutline(storey, pts));
    setTrace([]);
    show(null);
    setMode('edit');
    setSelected(null);
    ctx.done();
  };

  const undoPoint = (): void => {
    if (trace.length > 0) setTrace(trace.slice(0, -1));
    else if (storey.outline.length >= 3) setMode('edit');
    show(null);
  };

  const startTrace = (): void => {
    setMode('trace');
    setTrace([]);
    show(null);
    setSelected(null);
    setMenu(false);
    setMoving(null);
    ctx.focusSurface();
  };

  const cancelTrace = (): void => {
    setTrace([]);
    show(null);
    setMode('edit');
    ctx.focusSurface();
  };

  // ───────────── Correction ─────────────

  const vertexSession = (base: Storey, index: number): DragSession => {
    const guides = dragGuides(base.outline, index);
    let current = base;
    const apply = (p: PointerInfo): void => {
      const s = snapPointer(ctx, p, { guides, vertices: ghostVertices });
      current = moveVertex(base, index, s.point);
      setDraft(current);
      show(s);
    };
    return {
      move(p) {
        setSelected(index);
        setMenu(false);
        apply(p);
      },
      end(p) {
        apply(p);
        ctx.commit(current);
        setDraft(null);
        show(null);
        setSelected(index);
      },
      cancel() {
        setDraft(null);
        show(null);
      },
    };
  };

  const removeVertex = (index: number): void => {
    const next = deleteVertex(storey, index);
    if (next !== storey) ctx.commit(next);
    setSelected(null);
    setMenu(false);
    ctx.focusSurface();
  };

  const insertAt = (edge: number): void => {
    ctx.commit(insertVertex(storey, edge));
    setSelected(edge + 1);
    setMenu(false);
  };

  const commitNudge = (): void => {
    if (nudging.current && draft) ctx.commit(draft);
    nudging.current = false;
    setDraft(null);
  };

  /** Pose le point visé (ou ferme le contour s'il s'agit du premier point). */
  const placeTracePoint = (p: PointerInfo): void => {
    const s = traceSnap(p);
    if (s.kind === 'close') {
      finishTrace(trace);
      return;
    }
    const last = trace[trace.length - 1];
    // Second clic au même endroit (double-clic) : ignoré.
    if (last && Math.hypot(last.x - s.point.x, last.y - s.point.y) * view.scale < 2) return;
    setTrace([...trace, s.point]);
    show(p.pointerType === 'mouse' ? s : null);
  };

  /** Au doigt ou au stylet : poser, glisser pour viser (la loupe montre le point), relâcher pour poser. */
  const aimSession = (): DragSession => ({
    move(p) {
      show(traceSnap(p));
    },
    end(p) {
      placeTracePoint(p);
    },
    cancel() {
      show(null);
    },
  });

  useController(ctx, {
    dragStart(p) {
      if (effMode === 'trace') return p.pointerType === 'mouse' ? null : aimSession();
      if (effMode !== 'edit' || moving !== null) return null;
      const r = hitRadius(p.pointerType);
      const v = hitVertex(storey.outline, view, p.screen, r);
      if (v !== null) return vertexSession(storey, v);
      const m = hitMidpoint(storey.outline, view, p.screen, r);
      if (m !== null) return vertexSession(insertVertex(storey, m), m + 1);
      return null;
    },
    tap(p) {
      if (effMode === 'trace') {
        placeTracePoint(p);
        return;
      }
      if (effMode !== 'edit') return;
      if (moving !== null) {
        const s = snapPointer(ctx, p, { guides: dragGuides(storey.outline, moving), vertices: ghostVertices });
        ctx.commit(moveVertex(storey, moving, s.point));
        setDraft(null);
        show(null);
        setSelected(moving);
        setMoving(null);
        return;
      }
      const r = hitRadius(p.pointerType);
      const v = hitVertex(storey.outline, view, p.screen, r);
      if (v !== null) {
        setSelected(v);
        setMenu(true);
        return;
      }
      const m = hitMidpoint(storey.outline, view, p.screen, r);
      if (m !== null) {
        insertAt(m);
        return;
      }
      setSelected(null);
      setMenu(false);
    },
    hover(p) {
      if (!p) {
        show(null);
        if (moving !== null) setDraft(null);
        return;
      }
      if (effMode === 'trace') {
        show(traceSnap(p));
      } else if (effMode === 'edit' && moving !== null) {
        const s = snapPointer(ctx, p, { guides: dragGuides(storey.outline, moving), vertices: ghostVertices });
        setDraft(moveVertex(storey, moving, s.point));
        show(s);
      }
    },
    context(p) {
      if (effMode !== 'edit') return false;
      const v = hitVertex(storey.outline, view, p.screen, hitRadius(p.pointerType));
      if (v === null) return false;
      setSelected(v);
      setMenu(true);
      return true;
    },
    key(e) {
      if (effMode === 'trace') {
        if (e.key === 'Enter') {
          finishTrace(trace);
          return true;
        }
        if (e.key === 'Escape' || e.key === 'Backspace') {
          undoPoint();
          return true;
        }
        return false;
      }
      if (effMode !== 'edit') return false;
      if (e.key === 'Escape') {
        if (moving !== null || selectedIndex !== null || menu) {
          setMoving(null);
          setDraft(null);
          show(null);
          setSelected(null);
          setMenu(false);
          return true;
        }
        return false;
      }
      if (selectedIndex === null) return false;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        removeVertex(selectedIndex);
        return true;
      }
      const dir: Record<string, Vec2> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      };
      const d = dir[e.key];
      if (!d) return false;
      // Pas : 1 px écran (10 avec Maj) ; sur la feuille vierge, le pas de la grille.
      const step = sheet ? (e.shiftKey ? 10 : 1) / view.scale : blankGridStep(view.scale) * (e.shiftKey ? 10 : 1);
      const base = draft ?? storey;
      const cur = base.outline[selectedIndex]!;
      nudging.current = true;
      setMenu(false);
      setDraft(moveVertex(base, selectedIndex, { x: cur.x + d.x * step, y: cur.y + d.y * step }));
      return true;
    },
    keyUp(e) {
      if (e.key.startsWith('Arrow')) commitNudge();
    },
    blur() {
      if (nudging.current) commitNudge();
    },
  });

  // ───────────── Affichage ─────────────

  const bandPx = Math.min(48, Math.max(4, approx || !(mpu > 0) ? 8 : (WALL_BAND_METRES / mpu) * view.scale));
  const crossing = hasOutline && isSelfIntersecting(shown.outline);
  const magnetButton = (
    <Button onClick={() => ctx.setMagnet(!ctx.magnet)} pressed={ctx.magnet} title={tr('plan.magnet.title')} testId="plan-magnet">
      {tr('plan.magnet')}
    </Button>
  );

  if (effMode === 'proposal' && detected) {
    return (
      <>
        <Overlay ctx={ctx}>
          <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
          <polygon className="p2c-plan__proposal" points={toPoints(view, detected)} />
        </Overlay>
        <TopBar>
          <Hint tone="warn">{tr('plan.outline.proposal')}</Hint>
          <Actions>
            <Button
              variant="primary"
              testId="plan-outline-use"
              onClick={() => {
                ctx.commit(replaceOutline(storey, detected));
                setMode('edit');
                ctx.done();
                ctx.focusSurface();
              }}
            >
              {tr('plan.outline.useProposal')}
            </Button>
            <Button onClick={startTrace} testId="plan-outline-trace">
              {tr('plan.outline.traceMyself')}
            </Button>
          </Actions>
        </TopBar>
      </>
    );
  }

  if (effMode === 'trace') {
    const last = trace[trace.length - 1] ?? null;
    const tip = hover?.point ?? null;
    const preview = tip ? [...trace, tip] : trace;
    const previewStorey: Storey = { ...storey, outline: preview };
    const rubber =
      last && tip
        ? (() => {
            const a = sheetToScreen(view, last);
            const b = sheetToScreen(view, tip);
            const px = Math.hypot(b.x - a.x, b.y - a.y);
            const metres = (px / view.scale) * mpu;
            // Étiquette du côté « haut / gauche » du trait, pour ne pas la poser sur lui.
            let normal = px > 0 ? { x: (b.y - a.y) / px, y: -(b.x - a.x) / px } : { x: 0, y: -1 };
            if (normal.y > 0.01 || (Math.abs(normal.y) <= 0.01 && normal.x > 0)) normal = { x: -normal.x, y: -normal.y };
            return { a, b, px, metres, normal, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
          })()
        : null;
    const first = trace[0] ? sheetToScreen(view, trace[0]) : null;
    const tipScreen = tip ? sheetToScreen(view, tip) : null;
    return (
      <>
        <Overlay ctx={ctx}>
          <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
          {storey.outline.length >= 3 ? <polygon className="p2c-plan__previous" points={toPoints(view, storey.outline)} /> : null}
          {preview.length >= 3 ? <polygon className="p2c-plan__fill p2c-plan__fill--draft" points={toPoints(view, preview)} /> : null}
          {trace.length >= 2 ? <polyline className="p2c-plan__edge p2c-plan__trace" points={toPoints(view, trace)} /> : null}
          <RightAngleMarks outline={preview} view={view} closed={false} />
          {rubber ? <line className="p2c-plan__rubber" x1={rubber.a.x} y1={rubber.a.y} x2={rubber.b.x} y2={rubber.b.y} /> : null}
          {first && tipScreen && trace.length >= 2 ? (
            <line className="p2c-plan__rubber p2c-plan__rubber--closing" x1={tipScreen.x} y1={tipScreen.y} x2={first.x} y2={first.y} />
          ) : null}
          {trace.map((p, i) => {
            const s = sheetToScreen(view, p);
            const closing = i === 0 && trace.length >= 3;
            return <circle key={i} className={`p2c-plan__vertex ${closing ? 'is-closing' : ''}`} cx={s.x} cy={s.y} r={closing ? 7.5 : 4.5} />;
          })}
          <SnapOverlay snap={hover} view={view} size={ctx.size} hint={snapHint(tr, hover)} />
          {rubber && rubber.px > 28 ? (
            <Label {...outsideLabel(rubber.mid, rubber.normal, 10)} className="p2c-plan__label--live">
              {(approx ? '≈ ' : '') + formatDecimal(rubber.metres, 2) + ' m'}
            </Label>
          ) : null}
        </Overlay>
        <TopBar>
          <Hint tone="warn" icon="▣">
            <strong>{tr('plan.outline.outerFaceTrace')}</strong>
            {ctx.coarse ? (
              <span className="p2c-plan__hint-sub"> {tr('plan.touch.aim')}</span>
            ) : ctx.compact ? null : (
              <span className="p2c-plan__hint-sub"> {tr('plan.outline.traceKeys')}</span>
            )}
          </Hint>
          <Actions>
            <Button onClick={undoPoint} disabled={trace.length === 0} testId="plan-trace-undo">
              {tr('plan.outline.undoPoint')}
            </Button>
            <Button variant="primary" onClick={() => finishTrace(trace)} disabled={trace.length < 3} testId="plan-trace-close">
              {tr('plan.outline.close')}
            </Button>
            {storey.outline.length >= 3 ? (
              <Button onClick={cancelTrace} testId="plan-trace-cancel">
                {tr('plan.cancel')}
              </Button>
            ) : null}
            {magnetButton}
          </Actions>
        </TopBar>
        <BottomBar>
          <CounterRow ctx={ctx}>
            <Counter label={tr('plan.counter.points')} value={String(trace.length)} />
            <AreaCounters ctx={ctx} storey={previewStorey} />
            <ScaleWarning ctx={ctx} storey={storey} />
          </CounterRow>
        </BottomBar>
      </>
    );
  }

  // Mode correction.
  const selectedScreen = selectedIndex !== null ? sheetToScreen(view, shown.outline[selectedIndex]!) : null;
  return (
    <>
      <Overlay ctx={ctx}>
        <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
        <OutlineFill outline={shown.outline} view={view} className={crossing ? 'is-invalid' : ''} />
        <WallBand outline={shown.outline} view={view} widthPx={bandPx} id={`p2c-band-${clipId}`} />
        <EdgeLines outline={shown.outline} edges={shown.edges} view={view} className="p2c-plan__edge--outline" />
        <RightAngleMarks outline={shown.outline} view={view} closed />
        <EdgeLengthLabels outline={shown.outline} view={view} metresPerUnit={mpu} approx={approx} />
        {draft === null && moving === null ? (
          <MidpointHandles outline={shown.outline} view={view} label={(e) => tr('plan.outline.insertAria', { n: e + 1 })} activate={insertAt} />
        ) : null}
        <VertexHandles
          outline={shown.outline}
          view={view}
          selected={selectedIndex}
          label={(i) => tr('plan.outline.vertexAria', { n: i + 1, count: shown.outline.length })}
          onFocus={(i) => setSelected(i)}
        />
        <SnapOverlay snap={hover} view={view} size={ctx.size} hint={snapHint(tr, hover)} />
      </Overlay>
      <TopBar>
        <Hint tone="warn" icon="▣">
          {moving !== null ? (
            tr('plan.outline.moveHint')
          ) : (
            <>
              <strong>{tr('plan.outline.outerFaceEdit')}</strong>
              {ctx.compact || ctx.coarse ? null : <span className="p2c-plan__hint-sub"> {tr('plan.outline.editKeys')}</span>}
            </>
          )}
        </Hint>
        <Actions>
          <Button variant="primary" onClick={() => ctx.done()} testId="plan-outline-accept">
            {tr('plan.outline.accept')}
          </Button>
          <Button onClick={startTrace} testId="plan-outline-redraw">
            {tr('plan.outline.redraw')}
          </Button>
          {magnetButton}
        </Actions>
      </TopBar>
      {menu && selectedIndex !== null && selectedScreen && moving === null ? (
        <Popover
          anchor={selectedScreen}
          size={ctx.size}
          compact={false}
          label={tr('plan.outline.vertexAria', { n: selectedIndex + 1, count: shown.outline.length })}
          onClose={() => setMenu(false)}
          className="p2c-plan__popover--menu"
          testId="plan-vertex-menu"
          passive
        >
          <Button
            onClick={() => {
              setMoving(selectedIndex);
              setMenu(false);
              ctx.focusSurface();
            }}
            testId="plan-vertex-move"
          >
            {tr('plan.outline.moveVertex')}
          </Button>
          <Button variant="danger" onClick={() => removeVertex(selectedIndex)} disabled={shown.outline.length <= 3} testId="plan-vertex-delete">
            {tr('plan.outline.deleteVertex')}
          </Button>
        </Popover>
      ) : null}
      <BottomBar>
        {crossing ? <Hint tone="warn">{tr('plan.outline.selfIntersecting')}</Hint> : null}
        <CounterRow ctx={ctx}>
          <AreaCounters ctx={ctx} storey={shown} />
          <ScaleWarning ctx={ctx} storey={shown} />
        </CounterRow>
      </BottomBar>
    </>
  );
}
