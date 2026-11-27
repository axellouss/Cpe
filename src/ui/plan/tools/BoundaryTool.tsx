/**
 * Outil « façades » : toucher une arête pour dire ce qu'il y a derrière
 * (extérieur → voisin chauffé → local non chauffé → terre), ou choisir dans la bulle.
 * Chaque état a sa couleur ET son motif de trait (lisible sans distinguer les couleurs).
 */
import { useState } from 'react';
import { edgeLength } from '../../../core/geometry';
import type { Boundary, Vec2 } from '../../../core/types';
import { hitEdge, hitRadius } from '../hitTest';
import { BoundarySwatch, Hint, Popover, Segmented } from '../hud';
import { formatDecimal } from '../numbers';
import { BOUNDARY_CYCLE, nextBoundary, pointOnEdge, setBoundary, syncedEdges } from '../outlineOps';
import { EdgeLengthLabels, EdgeLines, GhostOutlines, OpeningMarks, OutlineFill } from '../shapes';
import { AreaCounters, BottomBar, CounterRow, Overlay, ScaleWarning, TopBar, scaleIsGuess, useController } from '../toolShared';
import type { ToolContext } from '../toolTypes';
import { sheetToScreen } from '../view';

export function BoundaryTool({ ctx }: { ctx: ToolContext }) {
  const { storey, view, tr } = ctx;
  const [picked, setPicked] = useState<{ edge: number; at: Vec2 } | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  const edges = syncedEdges(storey);
  const mpu = storey.metresPerUnit.value;
  const approx = scaleIsGuess(storey);
  const hasOutline = storey.outline.length >= 3;
  const current = picked && picked.edge < edges.length ? picked : null;

  const boundaryOf = (edge: number): Boundary => edges[edge]?.boundary ?? 'outside';
  const lengthOf = (edge: number): number => edgeLength(storey.outline, edge) * mpu;

  const cycle = (edge: number, at: Vec2): void => {
    ctx.commit(setBoundary(storey, edge, nextBoundary(boundaryOf(edge))));
    setPicked({ edge, at });
  };

  useController(ctx, {
    tap(p) {
      if (!hasOutline) return;
      const hit = hitEdge(storey.outline, view, p.screen, hitRadius(p.pointerType) * 1.3);
      if (hit) cycle(hit.index, hit.point);
      else setPicked(null);
    },
    hover(p) {
      if (!p || !hasOutline) {
        setHot(null);
        return;
      }
      const hit = hitEdge(storey.outline, view, p.screen, hitRadius(p.pointerType) * 1.3);
      setHot(hit ? hit.index : null);
    },
    key(e) {
      if (e.key === 'Escape' && current) {
        setPicked(null);
        return true;
      }
      return false;
    },
  });

  const totals = new Map<Boundary, number>();
  for (let i = 0; i < storey.outline.length; i++) totals.set(boundaryOf(i), (totals.get(boundaryOf(i)) ?? 0) + lengthOf(i));

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
          highlight={current ? current.edge : hot}
          interaction={{
            label: (i) =>
              tr('plan.boundary.edgeAria', {
                n: i + 1,
                length: formatDecimal(lengthOf(i), 2),
                boundary: tr(`plan.boundary.${boundaryOf(i)}`),
              }),
            activate: (i) => cycle(i, pointOnEdge(storey.outline, i, 0.5)),
          }}
        />
        <OpeningMarks outline={storey.outline} openings={storey.openings} metresPerUnit={mpu} view={view} />
        <EdgeLengthLabels outline={storey.outline} view={view} metresPerUnit={mpu} approx={approx} />
      </Overlay>
      <TopBar>
        <Hint>{tr(hasOutline ? 'plan.boundary.hint' : 'plan.needOutline')}</Hint>
      </TopBar>
      {current ? (
        <Popover
          anchor={sheetToScreen(view, current.at)}
          size={ctx.size}
          compact={ctx.compact}
          label={tr('plan.boundary.title')}
          onClose={() => {
            setPicked(null);
            ctx.focusSurface();
          }}
          testId="plan-boundary-popover"
        >
          <p className="p2c-plan__popover-title">
            {tr('plan.boundary.title')} <span className="p2c-plan__muted">· {formatDecimal(lengthOf(current.edge), 2)} m</span>
          </p>
          <Segmented<Boundary>
            name="p2c-boundary"
            label={tr('plan.boundary.title')}
            value={boundaryOf(current.edge)}
            options={BOUNDARY_CYCLE.map((b) => ({ value: b, label: tr(`plan.boundary.${b}`), swatch: <BoundarySwatch boundary={b} /> }))}
            onChange={(b) => ctx.commit(setBoundary(storey, current.edge, b))}
            vertical
            autoFocus
          />
        </Popover>
      ) : null}
      <BottomBar>
        {hasOutline ? (
          <ul className="p2c-plan__legend" aria-label={tr('plan.boundary.legend')} data-testid="plan-boundary-legend">
            {BOUNDARY_CYCLE.map((b) => (
              <li key={b} className={totals.get(b) ? '' : 'is-empty'}>
                <BoundarySwatch boundary={b} />
                <span>{tr(`plan.boundary.${b}`)}</span>
                <span className="p2c-plan__legend-value">{formatDecimal(totals.get(b) ?? 0, 2)} m</span>
              </li>
            ))}
          </ul>
        ) : null}
        <CounterRow ctx={ctx}>
          <AreaCounters ctx={ctx} storey={storey} />
          <ScaleWarning ctx={ctx} storey={storey} />
        </CounterRow>
      </BottomBar>
    </>
  );
}
