/**
 * Outil « façades » : dire ce qu'il y a derrière chaque arête (extérieur, voisin chauffé, local non chauffé, terre).
 * Deux gestes, jamais de surprise : un toucher DÉSIGNE la façade et ouvre les quatre choix, le choix actuel marqué ;
 * rien ne change tant qu'un choix n'a pas été touché. Le choix fait, la bulle se referme : on passe à la façade
 * suivante. Chaque état a sa couleur ET son motif de trait (lisible sans distinguer les couleurs).
 */
import { useRef, useState } from 'react';
import { edgeLength } from '../../../core/geometry';
import type { Boundary, Vec2 } from '../../../core/types';
import { hitEdge, hitRadius } from '../hitTest';
import { BoundarySwatch, ChoiceList, Hint, Popover } from '../hud';
import { formatDecimal } from '../numbers';
import { BOUNDARY_CYCLE, pointOnEdge, setBoundary, syncedEdges } from '../outlineOps';
import { EdgeLengthLabels, EdgeLines, GhostOutlines, OpeningMarks, OutlineFill } from '../shapes';
import { AreaCounters, BottomBar, CounterRow, Overlay, ScaleWarning, TopBar, scaleIsGuess, useController } from '../toolShared';
import type { ToolContext } from '../toolTypes';
import { sheetToScreen } from '../view';

export function BoundaryTool({ ctx }: { ctx: ToolContext }) {
  const { storey, view, tr } = ctx;
  const [picked, setPicked] = useState<{ edge: number; at: Vec2 } | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  /** Élément du plan (façade atteinte au clavier) à qui rendre le clavier quand la bulle se referme. */
  const returnFocus = useRef<Element | null>(null);
  const edges = syncedEdges(storey);
  const mpu = storey.metresPerUnit.value;
  const approx = scaleIsGuess(storey);
  const hasOutline = storey.outline.length >= 3;
  const current = picked && picked.edge < edges.length ? picked : null;

  const boundaryOf = (edge: number): Boundary => edges[edge]?.boundary ?? 'outside';
  const lengthOf = (edge: number): number => edgeLength(storey.outline, edge) * mpu;

  /** Désigne une façade et ouvre les choix. Ne modifie rien. */
  const select = (edge: number, at: Vec2, from: Element | null): void => {
    returnFocus.current = from;
    setPicked({ edge, at });
  };

  const close = (): void => {
    setPicked(null);
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el instanceof SVGElement && el.isConnected) el.focus({ preventScroll: true });
    else ctx.focusSurface();
  };

  /** Le seul endroit où la façade change : un choix touché dans la bulle. */
  const choose = (boundary: Boundary): void => {
    if (current) {
      const next = setBoundary(storey, current.edge, boundary);
      if (next !== storey) ctx.commit(next);
    }
    close();
  };

  useController(ctx, {
    tap(p) {
      if (!hasOutline) return;
      const hit = hitEdge(storey.outline, view, p.screen, hitRadius(p.pointerType) * 1.3);
      if (hit) select(hit.index, hit.point, null);
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
        close();
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
            activate: (i) => select(i, pointOnEdge(storey.outline, i, 0.5), typeof document === 'undefined' ? null : document.activeElement),
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
          key={current.edge}
          anchor={sheetToScreen(view, current.at)}
          size={ctx.size}
          compact={ctx.compact}
          label={tr('plan.boundary.title')}
          onClose={close}
          className="p2c-plan__popover--choices"
          testId="plan-boundary-popover"
          focus={current.at}
          cover={ctx.cover}
        >
          <p className="p2c-plan__popover-title">
            {tr('plan.boundary.title')} <span className="p2c-plan__muted">· {formatDecimal(lengthOf(current.edge), 2)} m</span>
          </p>
          <ChoiceList<Boundary>
            label={tr('plan.boundary.title')}
            value={boundaryOf(current.edge)}
            options={BOUNDARY_CYCLE.map((b) => ({ value: b, label: tr(`plan.boundary.${b}`), swatch: <BoundarySwatch boundary={b} /> }))}
            onChoose={choose}
            currentLabel={tr('plan.boundary.current')}
            testId="plan-boundary-choices"
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
          <AreaCounters ctx={ctx} storey={storey} secondary />
          <ScaleWarning ctx={ctx} storey={storey} />
        </CounterRow>
      </BottomBar>
    </>
  );
}
