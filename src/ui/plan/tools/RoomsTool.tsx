/**
 * Outil « pièces » : chaque pièce est comptée ou non dans An (surface de référence énergétique).
 * Un toucher bascule ; les pièces que le plan ne permet pas de trancher (cave, buanderie, grenier…) palpitent
 * doucement jusqu'à ce que l'expert décide. Le compteur An réagit aussitôt.
 */
import type { KeyboardEvent } from 'react';
import { bboxOf, centroid } from '../../../core/geometry';
import type { Room } from '../../../core/types';
import { storeyMetrics } from '../../../engine';
import { hitRoom, roomMinTarget, roomTarget, tagSize } from '../hitTest';
import { Counter, Hint } from '../hud';
import { formatDecimal } from '../numbers';
import { roomsToReview, toggleRoom } from '../outlineOps';
import { EdgeLines, GhostOutlines, Label, toPoints } from '../shapes';
import { BottomBar, CounterRow, Overlay, TopBar, useController } from '../toolShared';
import type { ToolContext } from '../toolTypes';
import { sheetToScreen } from '../view';

function stateClass(room: Room): string {
  return room.needsReview ? 'is-review' : room.heated ? 'is-heated' : 'is-unheated';
}

export function RoomsTool({ ctx }: { ctx: ToolContext }) {
  const { storey, view, tr } = ctx;
  const toReview = roomsToReview(storey);

  const areaText = (room: Room): string => (room.area.value > 0 ? `${formatDecimal(room.area.value, 2)} m²` : '? m²');
  const tagLabel = (room: Room): string => `${room.needsReview ? '? ' : ''}${room.name || tr('plan.rooms.unnamed')} · ${areaText(room)}`;
  const stateText = (room: Room): string =>
    tr(room.needsReview ? 'plan.rooms.state.review' : room.heated ? 'plan.rooms.state.heated' : 'plan.rooms.state.unheated');
  const aria = (room: Room): string => tr('plan.rooms.aria', { name: room.name || tr('plan.rooms.unnamed'), area: areaText(room), state: stateText(room) });

  const toggle = (id: string): void => {
    const next = toggleRoom(storey, id);
    if (next === storey) return;
    ctx.commit(next);
    // La dernière pièce « à trancher » vient d'être décidée : l'action de l'outil est terminée.
    if (toReview > 0 && roomsToReview(next) === 0) ctx.done();
  };

  useController(ctx, {
    tap(p) {
      // Une petite pièce (WC, placard) garde une cible confortable : 44 px au doigt, 24 px à la souris.
      const id = hitRoom(storey.rooms, view, p.screen, tagLabel, roomMinTarget(p.pointerType));
      if (id !== null) toggle(id);
    },
  });
  /** Cible minimale dessinée dans le calque (repère des tests et des outils d'accessibilité). */
  const minTarget = roomMinTarget(ctx.coarse ? 'touch' : 'mouse');

  const keyToggle = (id: string) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    toggle(id);
  };

  const withPolygon = storey.rooms.filter((r) => r.polygon && r.polygon.length >= 3);
  const withTag = storey.rooms.filter((r) => !(r.polygon && r.polygon.length >= 3) && r.at);
  const unplaced = storey.rooms.filter((r) => !(r.polygon && r.polygon.length >= 3) && !r.at);

  const m = storeyMetrics(storey);
  const sourceKey = m.netAreaFrom === 'override' ? 'plan.rooms.source.override' : m.netAreaFrom === 'rooms' ? 'plan.rooms.source.rooms' : 'plan.rooms.source.estimate';

  return (
    <>
      <Overlay ctx={ctx}>
        <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
        <EdgeLines outline={storey.outline} edges={storey.edges} view={view} className="p2c-plan__edge--thin p2c-plan__edge--muted" />
        {withPolygon.map((room) => {
          const poly = room.polygon!;
          const bb = bboxOf(poly);
          const wPx = (bb.maxX - bb.minX) * view.scale;
          const hPx = (bb.maxY - bb.minY) * view.scale;
          const c = sheetToScreen(view, centroid(poly));
          const target = roomTarget(room, view, minTarget);
          return (
            <g
              key={room.id}
              className={`p2c-plan__room ${stateClass(room)}`}
              tabIndex={0}
              role="switch"
              aria-checked={room.heated}
              aria-label={aria(room)}
              onKeyDown={keyToggle(room.id)}
              data-room={room.id}
            >
              {target ? <rect className="p2c-plan__room-hit" x={target.x} y={target.y} width={target.width} height={target.height} /> : null}
              <polygon className="p2c-plan__room-shape" points={toPoints(view, poly)} />
              {wPx > 46 && hPx > 30 ? (
                <>
                  <Label x={c.x} y={c.y - 7} className="p2c-plan__label--room">
                    {(room.needsReview ? '? ' : '') + (room.name || tr('plan.rooms.unnamed'))}
                  </Label>
                  <Label x={c.x} y={c.y + 8} className="p2c-plan__label--room-area">
                    {areaText(room)}
                  </Label>
                </>
              ) : wPx > 16 && hPx > 14 && room.needsReview ? (
                <Label x={c.x} y={c.y} className="p2c-plan__label--room">
                  ?
                </Label>
              ) : null}
            </g>
          );
        })}
        {withTag.map((room) => {
          const label = tagLabel(room);
          const size = tagSize(label);
          const c = sheetToScreen(view, room.at!);
          return (
            <g
              key={room.id}
              className={`p2c-plan__room p2c-plan__tag ${stateClass(room)}`}
              tabIndex={0}
              role="switch"
              aria-checked={room.heated}
              aria-label={aria(room)}
              onKeyDown={keyToggle(room.id)}
              data-room={room.id}
            >
              <rect className="p2c-plan__room-shape" x={c.x - size.width / 2} y={c.y - size.height / 2} width={size.width} height={size.height} rx={size.height / 2} />
              <text className="p2c-plan__tag-text" x={c.x} y={c.y} textAnchor="middle" dominantBaseline="central">
                {label}
              </text>
            </g>
          );
        })}
      </Overlay>
      <TopBar>
        <Hint>{tr(storey.rooms.length === 0 ? 'plan.rooms.none' : ctx.compact ? 'plan.rooms.hintShort' : 'plan.rooms.hint')}</Hint>
      </TopBar>
      <BottomBar>
        {unplaced.length > 0 ? (
          <div className="p2c-plan__room-list" role="group" aria-label={tr('plan.rooms.unplaced')}>
            <span className="p2c-plan__muted">{tr('plan.rooms.unplaced')}</span>
            {unplaced.map((room) => (
              <button
                key={room.id}
                type="button"
                className={`p2c-plan__room-chip ${stateClass(room)}`}
                role="switch"
                aria-checked={room.heated}
                onClick={() => toggle(room.id)}
              >
                {tagLabel(room)}
              </button>
            ))}
          </div>
        ) : null}
        {storey.rooms.length > 0 ? (
          <ul className="p2c-plan__legend p2c-plan__legend--rooms" aria-label={tr('plan.rooms.legend')}>
            <li>
              <span className="p2c-plan__swatch p2c-plan__swatch--heated-room" aria-hidden="true" />
              <span>{tr('plan.rooms.state.heated')}</span>
            </li>
            <li>
              <span className="p2c-plan__swatch p2c-plan__swatch--unheated-room" aria-hidden="true" />
              <span>{tr('plan.rooms.state.unheated')}</span>
            </li>
            <li>
              <span className="p2c-plan__swatch p2c-plan__swatch--review-room" aria-hidden="true" />
              <span>{tr('plan.rooms.state.review')}</span>
            </li>
          </ul>
        ) : null}
        <CounterRow ctx={ctx}>
          <Counter
            label={tr('plan.counter.an')}
            value={(m.netAreaFrom === 'estimate' ? '≈ ' : '') + formatDecimal(m.netArea, 2)}
            unit="m²"
            tone={m.netAreaFrom === 'rooms' ? 'accent' : 'warn'}
            title={tr(sourceKey)}
            testId="plan-counter-an"
          />
          <Counter label={tr('plan.counter.anSource')} value={tr(sourceKey)} secondary />
          {toReview > 0 ? <Counter tone="warn" label={tr('plan.counter.toReview')} value={String(toReview)} testId="plan-counter-review" /> : null}
        </CounterRow>
      </BottomBar>
    </>
  );
}
