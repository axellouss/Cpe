/**
 * Outil « se déplacer » : rien à saisir, on regarde le plan. Le contour, les ouvertures et les compteurs restent
 * affichés pour se repérer.
 */
import { syncedEdges } from '../outlineOps';
import { EdgeLines, GhostOutlines, OpeningMarks, OutlineFill } from '../shapes';
import { Hint } from '../hud';
import { AreaCounters, BottomBar, CounterRow, Overlay, ScaleWarning, TopBar, useController } from '../toolShared';
import type { ToolContext } from '../toolTypes';

export function PanTool({ ctx }: { ctx: ToolContext }) {
  const { storey, view, tr } = ctx;
  useController(ctx, {});
  return (
    <>
      <Overlay ctx={ctx}>
        <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
        <OutlineFill outline={storey.outline} view={view} className="p2c-plan__fill--muted" />
        <EdgeLines outline={storey.outline} edges={syncedEdges(storey)} view={view} colored className="p2c-plan__edge--thin" />
        <OpeningMarks outline={storey.outline} openings={storey.openings} metresPerUnit={storey.metresPerUnit.value} view={view} />
      </Overlay>
      <TopBar>
        <Hint>{tr('plan.pan.hint')}</Hint>
      </TopBar>
      <BottomBar>
        <CounterRow ctx={ctx}>
          <AreaCounters ctx={ctx} storey={storey} secondary />
          <ScaleWarning ctx={ctx} storey={storey} />
        </CounterRow>
      </BottomBar>
    </>
  );
}
