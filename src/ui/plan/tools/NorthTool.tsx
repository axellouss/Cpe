/**
 * Outil « nord » : une rose des vents à tourner (glisser l'aiguille), avec ses alternatives sans glissement —
 * boutons ±45° / ±5°, champ numérique, flèches du clavier. Chaque façade extérieure affiche son secteur
 * (N, NE, E, SE, S, SW, W, NW) TOUJOURS accompagné de l'azimut en degrés : « O » veut dire ouest en français
 * et est en allemand, on écrit donc W/E et on donne les degrés ; le nom complet localisé est en infobulle.
 */
import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { edgeOutwardNormal, normDeg } from '../../../core/geometry';
import type { Orientation } from '../../../core/types';
import { facadeOrientation, needleScreenAngle, northFromPointer, rotateNeedle, settleAngle, topSector } from '../compass';
import { Button, Hint } from '../hud';
import { parseAngle } from '../numbers';
import { syncedEdges } from '../outlineOps';
import { EdgeLines, GhostOutlines, Label, OpeningMarks, OutlineFill, outsideLabel } from '../shapes';
import { BottomBar, CounterRow, Overlay, TopBar, useController } from '../toolShared';
import type { ToolContext } from '../toolTypes';
import { sheetToScreen } from '../view';

const TICKS = [0, 45, 90, 135, 180, 225, 270, 315];

export function NorthTool({ ctx }: { ctx: ToolContext }) {
  const { storey, view, tr } = ctx;
  const [draft, setDraft] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const roseRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  const angle = normDeg(draft ?? ctx.northAngle);
  const rounded = normDeg(Math.round(angle));
  const edges = syncedEdges(storey);
  const sectorName = (s: Orientation): string => tr(`plan.sector.${s}`);

  const commit = (next: number): void => {
    const value = normDeg(next) + 0; // « + 0 » : jamais de −0 émis
    if (Math.abs(value - normDeg(ctx.northAngle)) > 1e-9) ctx.changeNorth(value);
  };

  useController(ctx, {});

  // ───────────── Rose : glisser l'aiguille ─────────────

  const angleFromEvent = (e: PointerEvent): number | null => {
    const el = roseRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const raw = northFromPointer({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, { x: e.clientX, y: e.clientY });
    if (raw === null) return null;
    // Alt : pas d'aimant sur les multiples de 45°.
    return e.altKey ? normDeg(Math.round(raw)) : settleAngle(raw);
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    const a = angleFromEvent(e);
    if (a !== null) setDraft(a);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>): void => {
    if (!dragging.current) return;
    const a = angleFromEvent(e);
    if (a !== null) setDraft(a);
  };
  const onPointerUp = (e: PointerEvent<SVGSVGElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    const a = angleFromEvent(e) ?? draft;
    setDraft(null);
    if (a !== null) commit(a);
  };
  const onPointerCancel = (): void => {
    dragging.current = false;
    setDraft(null);
  };

  const onRoseKey = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 5 : 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = rotateNeedle(ctx.northAngle, step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = rotateNeedle(ctx.northAngle, -step);
    else if (e.key === 'Home') next = 0;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    commit(next);
  };

  const turn = (delta: number): void => commit(rotateNeedle(ctx.northAngle, delta));

  const commitText = (): void => {
    if (text === null) return;
    const parsed = parseAngle(text);
    setText(null);
    if (parsed !== null) commit(parsed);
  };

  // ───────────── Façades ─────────────

  const facades = [];
  if (storey.outline.length >= 3) {
    for (let i = 0; i < storey.outline.length; i++) {
      if ((edges[i]?.boundary ?? 'outside') !== 'outside') continue;
      const a = sheetToScreen(view, storey.outline[i]!);
      const b = sheetToScreen(view, storey.outline[(i + 1) % storey.outline.length]!);
      if (Math.hypot(b.x - a.x, b.y - a.y) < 14) continue;
      const o = facadeOrientation(storey.outline, i, angle);
      const n = edgeOutwardNormal(storey.outline, i);
      facades.push(
        <Label
          key={i}
          {...outsideLabel({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, n, 12)}
          className={`p2c-plan__label--facade ${o.borderline ? 'is-borderline' : ''}`}
          title={tr(o.borderline ? 'plan.north.facadeTitleBorderline' : 'plan.north.facadeTitle', { name: sectorName(o.sector), azimuth: o.azimuth })}
        >
          <tspan className="p2c-plan__facade-sector">{o.sector}</tspan>
          <tspan dx="4">{o.azimuth}°</tspan>
        </Label>,
      );
    }
  }

  const needle = needleScreenAngle(angle);
  const top = topSector(angle);
  const tipAngle = (needle * Math.PI) / 180;
  const letter = { x: Math.sin(tipAngle) * 47, y: -Math.cos(tipAngle) * 47 };

  return (
    <>
      <Overlay ctx={ctx}>
        <GhostOutlines ghosts={ctx.ghostStoreys} view={view} />
        <OutlineFill outline={storey.outline} view={view} className="p2c-plan__fill--muted" />
        <EdgeLines outline={storey.outline} edges={edges} view={view} colored className="p2c-plan__edge--thin" />
        <OpeningMarks outline={storey.outline} openings={storey.openings} metresPerUnit={storey.metresPerUnit.value} view={view} />
        <g>{facades}</g>
      </Overlay>
      <TopBar>
        <Hint>{tr('plan.north.hint')}</Hint>
      </TopBar>
      <div className="p2c-plan__compass" data-p2c-ui="" data-testid="plan-compass">
        <svg
          ref={roseRef}
          className="p2c-plan__rose"
          viewBox="-64 -64 128 128"
          role="slider"
          tabIndex={0}
          aria-label={tr('plan.north.roseAria')}
          aria-valuemin={0}
          aria-valuemax={359}
          aria-valuenow={rounded}
          aria-valuetext={tr('plan.north.sentence', { sector: top, azimuth: rounded, name: sectorName(top) })}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={onRoseKey}
          data-testid="plan-rose"
        >
          <circle className="p2c-plan__rose-ring" r={56} />
          {TICKS.map((tick) => (
            <line key={tick} className="p2c-plan__rose-tick" x1={0} y1={-56} x2={0} y2={tick % 90 === 0 ? -47 : -51} transform={`rotate(${tick})`} />
          ))}
          {/* La feuille, immobile au centre : son haut est en haut. */}
          <rect className="p2c-plan__rose-sheet" x={-13} y={-17} width={26} height={34} rx={2} />
          <path className="p2c-plan__rose-sheet-top" d="M-6,-10 L0,-16 L6,-10" />
          <g transform={`rotate(${needle})`}>
            <path className="p2c-plan__rose-south" d="M0,40 L7,0 L-7,0 Z" />
            <path className="p2c-plan__rose-north" d="M0,-40 L8,0 L-8,0 Z" />
            <circle className="p2c-plan__rose-hub" r={3} />
          </g>
          <text className="p2c-plan__rose-letter" x={letter.x} y={letter.y} textAnchor="middle" dominantBaseline="central">
            N
          </text>
        </svg>
        <div className="p2c-plan__compass-controls">
          <div className="p2c-plan__turns" role="group" aria-label={tr('plan.north.turnGroup')}>
            <Button onClick={() => turn(-45)} title={tr('plan.north.turnLeft', { deg: 45 })} testId="plan-north-l45">
              ↺ 45°
            </Button>
            <Button onClick={() => turn(-5)} title={tr('plan.north.turnLeft', { deg: 5 })} testId="plan-north-l5">
              ↺ 5°
            </Button>
            <Button onClick={() => turn(5)} title={tr('plan.north.turnRight', { deg: 5 })} testId="plan-north-r5">
              5° ↻
            </Button>
            <Button onClick={() => turn(45)} title={tr('plan.north.turnRight', { deg: 45 })} testId="plan-north-r45">
              45° ↻
            </Button>
          </div>
          <div className="p2c-plan__compass-info">
            <label className="p2c-plan__field p2c-plan__field--inline">
              <span className="p2c-plan__field-label">{tr('plan.north.field')}</span>
              <span className="p2c-plan__input-row">
                <input
                  className="p2c-plan__input p2c-plan__input--short"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={text ?? String(rounded)}
                  onFocus={(e) => {
                    setText(String(rounded));
                    e.target.select();
                  }}
                  onChange={(e) => setText(e.target.value)}
                  onBlur={commitText}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitText();
                    }
                  }}
                  aria-invalid={text !== null && parseAngle(text) === null}
                  data-testid="plan-north-input"
                />
                <span className="p2c-plan__unit">°</span>
              </span>
            </label>
            <p className="p2c-plan__compass-sentence" data-testid="plan-north-sentence" title={sectorName(top)}>
              {tr('plan.north.sentence', { sector: top, azimuth: rounded, name: sectorName(top) })}
            </p>
          </div>
          <Button variant="primary" onClick={() => ctx.done()} testId="plan-north-ok">
            {tr('plan.north.confirm')}
          </Button>
        </div>
      </div>
      <BottomBar>
        <CounterRow ctx={ctx} />
      </BottomBar>
    </>
  );
}
