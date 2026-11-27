/**
 * Ce que tous les outils ont en commun : enregistrement du contrôleur, calque SVG, zones de l'interface,
 * compteurs de surface, réglages d'accrochage.
 */
import { useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { storeyMetrics } from '../../engine';
import type { Storey, Vec2 } from '../../core/types';
import { Counter } from './hud';
import { formatDecimal } from './numbers';
import type { SnapContext, GuideLine, SnapResult } from './snapping';
import { resolveSnap } from './snapping';
import type { PointerInfo, ToolContext, ToolController } from './toolTypes';
import { niceStep } from './view';

/** Publie le contrôleur de l'outil (réécrit à chaque rendu pour que ses fermetures voient l'état courant). */
export function useController(ctx: ToolContext, controller: ToolController): void {
  const slot = ctx.controller;
  useLayoutEffect(() => {
    slot.current = controller;
    return () => {
      if (slot.current === controller) slot.current = null;
    };
  });
}

/** Rayon d'accrochage (px) selon le pointeur. */
export function snapRadiusPx(pointerType: string): number {
  return pointerType === 'touch' ? 20 : pointerType === 'pen' ? 14 : 11;
}

/** Pas d'accrochage sur la feuille vierge (1 unité = 1 m) : rond, et d'au moins 7 px à l'écran. */
export function blankGridStep(scale: number): number {
  return Math.max(0.01, niceStep(scale, 7));
}

/** Accrochage standard d'un outil pour la position du pointeur. */
export function snapPointer(
  ctx: ToolContext,
  p: PointerInfo,
  options: { guides?: readonly GuideLine[]; vertices?: readonly Vec2[]; closePoint?: Vec2 | null } = {},
): SnapResult {
  const context: SnapContext = {
    index: ctx.index,
    radius: snapRadiusPx(p.pointerType) / ctx.view.scale,
    vertices: options.vertices ?? [],
    closePoint: options.closePoint ?? null,
    guides: options.guides ?? [],
    gridStep: ctx.sheet ? null : blankGridStep(ctx.view.scale),
    enabled: ctx.magnet && !p.altKey,
  };
  return resolveSnap(p.sheet, context);
}

/** Vrai tant que l'échelle n'est qu'une supposition : les mètres affichés sont alors précédés de « ≈ ». */
export function scaleIsGuess(storey: Pick<Storey, 'metresPerUnit'>): boolean {
  return storey.metresPerUnit.from === 'estimate';
}

/** Calque SVG de l'outil, à la taille de la zone de plan. */
export function Overlay(props: { ctx: ToolContext; children: ReactNode }) {
  const { width, height } = props.ctx.size;
  return (
    <svg className="p2c-plan__overlay" width={width} height={height} viewBox={`0 0 ${width} ${height}`} focusable="false">
      {props.children}
    </svg>
  );
}

/** Zone haute : rappel de l'outil et boutons d'action. */
export function TopBar(props: { children: ReactNode }) {
  return (
    <div className="p2c-plan__top" data-p2c-ui="">
      {props.children}
    </div>
  );
}

export function Actions(props: { children: ReactNode }) {
  return <div className="p2c-plan__actions">{props.children}</div>;
}

/** Zone basse : légende, compteurs en direct. */
export function BottomBar(props: { children: ReactNode }) {
  return (
    <div className="p2c-plan__bottom" data-p2c-ui="">
      {props.children}
    </div>
  );
}

/** Longueur « ronde » (1, 2, 5 × 10^n m) la plus proche de la cible. */
export function niceLength(target: number): number {
  if (!(target > 0) || !Number.isFinite(target)) return 1;
  const pow = 10 ** Math.floor(Math.log10(target));
  const f = target / pow;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
}

/** Barre d'échelle graphique : un repère de plus pour voir d'un coup d'œil une échelle aberrante. */
export function ScaleBar(props: { ctx: ToolContext }) {
  const { storey, view } = props.ctx;
  const mpu = storey.metresPerUnit.value;
  if (scaleIsGuess(storey) || !(mpu > 0)) return null;
  const pxPerMetre = view.scale / mpu;
  const metres = niceLength(84 / pxPerMetre);
  const width = metres * pxPerMetre;
  if (!(width > 8) || width > 400) return null;
  const text = metres >= 1 ? `${formatDecimal(metres, 0)} m` : metres >= 0.01 ? `${formatDecimal(metres * 100, 0)} cm` : `${formatDecimal(metres * 1000, 1)} mm`;
  return (
    <div className="p2c-plan__scalebar" aria-hidden="true" data-testid="plan-scalebar">
      <span className="p2c-plan__scalebar-line" style={{ width }} />
      <span>{text}</span>
    </div>
  );
}

/** Dernière ligne de la zone basse : compteurs en direct à gauche, barre d'échelle à droite. */
export function CounterRow(props: { ctx: ToolContext; children?: ReactNode }) {
  return (
    <div className="p2c-plan__status">
      <div className="p2c-plan__counters">{props.children}</div>
      <ScaleBar ctx={props.ctx} />
    </div>
  );
}

/**
 * Surface brute et périmètre du contour affiché (y compris pendant un glissement).
 * `secondary` : l'outil ne les modifie pas (façades, déplacement) — simple rappel, masqué sur téléphone.
 */
export function AreaCounters(props: { ctx: ToolContext; storey: Storey; secondary?: boolean }) {
  const { ctx, storey } = props;
  if (storey.outline.length < 3) return null;
  const m = storeyMetrics(storey);
  const approx = scaleIsGuess(storey) ? '≈ ' : '';
  return (
    <>
      <Counter
        label={ctx.tr('plan.counter.grossArea')}
        value={approx + formatDecimal(m.grossArea, 2)}
        unit="m²"
        testId="plan-counter-area"
        secondary={props.secondary}
      />
      <Counter
        label={ctx.tr('plan.counter.perimeter')}
        value={approx + formatDecimal(m.perimeter, 2)}
        unit="m"
        testId="plan-counter-perimeter"
        secondary={props.secondary}
      />
    </>
  );
}

/** Avertissement « échelle non confirmée » à glisser dans les compteurs. */
export function ScaleWarning(props: { ctx: ToolContext; storey: Storey }) {
  if (!scaleIsGuess(props.storey)) return null;
  return <Counter tone="warn" label={props.ctx.tr('plan.counter.scale')} value={props.ctx.tr('plan.counter.scaleUnknown')} />;
}
