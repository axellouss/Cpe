/**
 * Briques SVG partagées par les outils : contour, arêtes colorées, cotes, ouvertures, guides d'accrochage.
 * Tout est dessiné en coordonnées ÉCRAN (px CSS) : poignées et textes gardent leur taille quel que soit le zoom.
 * Le SVG ne reçoit aucun événement de pointeur (c'est la zone de plan qui les traite) ; seuls le clavier et le
 * focus passent par ces éléments.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { edgeOutwardNormal } from '../../core/geometry';
import type { Opening, Storey, StoreyEdge, Vec2 } from '../../core/types';
import { MIDPOINT_MIN_EDGE_PX } from './hitTest';
import { formatDecimal } from './numbers';
import { openingMark } from './openings';
import { isRightAngle } from './snapping';
import type { SnapResult } from './snapping';
import type { Size, View } from './view';
import { sheetToScreen } from './view';

export function toPoints(view: View, points: readonly Vec2[]): string {
  let s = '';
  for (const p of points) {
    const q = sheetToScreen(view, p);
    s += `${q.x.toFixed(1)},${q.y.toFixed(1)} `;
  }
  return s;
}

/** Texte lisible sur n'importe quel fond (liseré de la couleur du papier). */
export function Label(props: { x: number; y: number; className?: string; anchor?: 'start' | 'middle' | 'end'; title?: string; children: ReactNode }) {
  return (
    <text
      x={props.x}
      y={props.y}
      className={`p2c-plan__label ${props.className ?? ''}`}
      textAnchor={props.anchor ?? 'middle'}
      dominantBaseline="central"
    >
      {props.title ? <title>{props.title}</title> : null}
      {props.children}
    </text>
  );
}

/**
 * Position d'une étiquette posée à l'extérieur d'une arête : décalée le long de la normale, et ancrée du côté
 * de l'arête quand la normale est plutôt horizontale (le texte ne revient alors jamais mordre sur le trait).
 */
export function outsideLabel(mid: Vec2, normal: Vec2, gap: number): { x: number; y: number; anchor: 'start' | 'middle' | 'end' } {
  if (Math.abs(normal.x) > 0.5) {
    return { x: mid.x + normal.x * gap, y: mid.y + normal.y * gap, anchor: normal.x > 0 ? 'start' : 'end' };
  }
  return { x: mid.x + normal.x * (gap + 5), y: mid.y + normal.y * (gap + 5), anchor: 'middle' };
}

/** Contours des autres étages tracés sur la même feuille, en filigrane. */
export function GhostOutlines(props: { ghosts: readonly Storey[]; view: View }) {
  return (
    <g className="p2c-plan__ghosts" aria-hidden="true">
      {props.ghosts.map((g) =>
        g.outline.length >= 2 ? <polygon key={g.id} className="p2c-plan__ghost" points={toPoints(props.view, g.outline)} /> : null,
      )}
    </g>
  );
}

/** Surface du contour (remplissage léger). */
export function OutlineFill(props: { outline: readonly Vec2[]; view: View; className?: string }) {
  if (props.outline.length < 3) return null;
  return <polygon className={`p2c-plan__fill ${props.className ?? ''}`} points={toPoints(props.view, props.outline)} />;
}

/**
 * Bande intérieure le long du contour : elle figure l'épaisseur du mur et rappelle que le trait suit la FACE
 * EXTÉRIEURE. Réalisée par un trait épais découpé par le polygone lui-même.
 */
export function WallBand(props: { outline: readonly Vec2[]; view: View; widthPx: number; id: string }) {
  if (props.outline.length < 3) return null;
  const points = toPoints(props.view, props.outline);
  return (
    <g aria-hidden="true">
      <clipPath id={props.id}>
        <polygon points={points} />
      </clipPath>
      <polygon className="p2c-plan__wallband" points={points} strokeWidth={props.widthPx * 2} clipPath={`url(#${props.id})`} />
    </g>
  );
}

export interface EdgeInteraction {
  label(index: number): string;
  activate(index: number): void;
}

function activationKey(e: KeyboardEvent): boolean {
  return e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
}

/** Arêtes du contour, une ligne par arête ; colorées selon ce qu'il y a derrière si `colored`. */
export function EdgeLines(props: {
  outline: readonly Vec2[];
  edges: readonly StoreyEdge[];
  view: View;
  colored?: boolean;
  highlight?: number | null;
  className?: string;
  interaction?: EdgeInteraction;
}) {
  const { outline, view } = props;
  const n = outline.length;
  if (n < 2) return null;
  const lines: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    if (n === 2 && i === 1) break;
    const a = sheetToScreen(view, outline[i]!);
    const b = sheetToScreen(view, outline[(i + 1) % n]!);
    const boundary = props.edges[i]?.boundary ?? 'outside';
    const cls = [
      'p2c-plan__edge',
      props.colored ? `p2c-plan__edge--${boundary}` : '',
      props.highlight === i ? 'is-hot' : '',
      props.className ?? '',
    ].join(' ');
    const it = props.interaction;
    lines.push(
      <line
        key={i}
        className={cls}
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        {...(it
          ? {
              tabIndex: 0,
              role: 'button',
              'aria-label': it.label(i),
              onKeyDown: (e: KeyboardEvent) => {
                if (!activationKey(e)) return;
                e.preventDefault();
                e.stopPropagation();
                it.activate(i);
              },
            }
          : {})}
      />,
    );
  }
  return <g>{lines}</g>;
}

/** Longueur de chaque arête (m), posée à l'extérieur du contour. Masquée sur les arêtes trop courtes à l'écran. */
export function EdgeLengthLabels(props: { outline: readonly Vec2[]; view: View; metresPerUnit: number; approx: boolean; minPx?: number }) {
  const { outline, view } = props;
  const n = outline.length;
  if (n < 3) return null;
  const labels: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const a = sheetToScreen(view, outline[i]!);
    const b = sheetToScreen(view, outline[(i + 1) % n]!);
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    if (px < (props.minPx ?? 44)) continue;
    const normal = edgeOutwardNormal(outline, i);
    const metres = (px / view.scale) * props.metresPerUnit;
    const at = outsideLabel({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, normal, 11);
    labels.push(
      <Label key={i} x={at.x} y={at.y} anchor={at.anchor} className="p2c-plan__label--length">
        {(props.approx ? '≈ ' : '') + formatDecimal(metres, 2)}
      </Label>,
    );
  }
  return <g aria-hidden="true">{labels}</g>;
}

/** Petits carrés d'équerre aux angles droits du contour. */
export function RightAngleMarks(props: { outline: readonly Vec2[]; view: View; closed: boolean }) {
  const { outline, view } = props;
  const n = outline.length;
  if (n < 3) return null;
  const marks: ReactNode[] = [];
  const size = 7;
  for (let i = 0; i < n; i++) {
    if (!props.closed && (i === 0 || i === n - 1)) continue;
    const prev = outline[(i - 1 + n) % n]!;
    const cur = outline[i]!;
    const next = outline[(i + 1) % n]!;
    if (!isRightAngle(prev, cur, next)) continue;
    const c = sheetToScreen(view, cur);
    const p = sheetToScreen(view, prev);
    const q = sheetToScreen(view, next);
    const lp = Math.hypot(p.x - c.x, p.y - c.y);
    const lq = Math.hypot(q.x - c.x, q.y - c.y);
    if (lp < 26 || lq < 26) continue;
    const u = { x: ((p.x - c.x) / lp) * size, y: ((p.y - c.y) / lp) * size };
    const v = { x: ((q.x - c.x) / lq) * size, y: ((q.y - c.y) / lq) * size };
    marks.push(
      <polyline
        key={i}
        className="p2c-plan__square"
        points={`${c.x + u.x},${c.y + u.y} ${c.x + u.x + v.x},${c.y + u.y + v.y} ${c.x + v.x},${c.y + v.y}`}
      />,
    );
  }
  return <g aria-hidden="true">{marks}</g>;
}

/** Poignées des sommets. */
export function VertexHandles(props: {
  outline: readonly Vec2[];
  view: View;
  selected: number | null;
  label?(index: number): string;
  onFocus?(index: number): void;
}) {
  return (
    <g>
      {props.outline.map((p, i) => {
        const s = sheetToScreen(props.view, p);
        return (
          <circle
            key={i}
            className={`p2c-plan__vertex ${props.selected === i ? 'is-selected' : ''}`}
            cx={s.x}
            cy={s.y}
            r={props.selected === i ? 7 : 5.5}
            {...(props.label
              ? { tabIndex: 0, role: 'button', 'aria-label': props.label(i), onFocus: () => props.onFocus?.(i) }
              : {})}
          />
        );
      })}
    </g>
  );
}

/** Poignées « + » au milieu des arêtes assez longues : un toucher insère un sommet. */
export function MidpointHandles(props: { outline: readonly Vec2[]; view: View; label?(edge: number): string; activate?(edge: number): void }) {
  const { outline, view } = props;
  const n = outline.length;
  if (n < 3) return null;
  const handles: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const a = sheetToScreen(view, outline[i]!);
    const b = sheetToScreen(view, outline[(i + 1) % n]!);
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIDPOINT_MIN_EDGE_PX) continue;
    const x = (a.x + b.x) / 2;
    const y = (a.y + b.y) / 2;
    handles.push(
      <g
        key={i}
        className="p2c-plan__mid"
        {...(props.label && props.activate
          ? {
              tabIndex: 0,
              role: 'button',
              'aria-label': props.label(i),
              onKeyDown: (e: KeyboardEvent) => {
                if (!activationKey(e)) return;
                e.preventDefault();
                e.stopPropagation();
                props.activate?.(i);
              },
            }
          : {})}
      >
        <circle cx={x} cy={y} r={6.5} />
        <path d={`M${x - 3},${y}H${x + 3}M${x},${y - 3}V${y + 3}`} />
      </g>,
    );
  }
  return <g>{handles}</g>;
}

export function openingLabel(o: Pick<Opening, 'width' | 'height' | 'count'>): string {
  const size = `${formatDecimal(o.width, 2)} × ${formatDecimal(o.height, 2)}`;
  return o.count > 1 ? `${o.count} × ${size}` : size;
}

export interface OpeningInteraction {
  label(o: Opening): string;
  activate(o: Opening): void;
  remove?(o: Opening): void;
}

/** Marques des ouvertures sur les façades : trait épais à l'échelle + dimensions. */
export function OpeningMarks(props: {
  outline: readonly Vec2[];
  openings: readonly Opening[];
  metresPerUnit: number;
  view: View;
  labels?: boolean;
  selectedId?: string | null;
  interaction?: OpeningInteraction;
}) {
  const { outline, view } = props;
  if (outline.length < 2) return null;
  const marks: ReactNode[] = [];
  for (const o of props.openings) {
    const mark = openingMark(outline, o, props.metresPerUnit);
    if (!mark) continue;
    let a = sheetToScreen(view, mark.a);
    let b = sheetToScreen(view, mark.b);
    const c = sheetToScreen(view, mark.centre);
    // Une marque minuscule (échelle inconnue, zoom arrière) reste visible : au moins 10 px.
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 10) {
      a = { x: c.x - mark.dir.x * 5, y: c.y - mark.dir.y * 5 };
      b = { x: c.x + mark.dir.x * 5, y: c.y + mark.dir.y * 5 };
    }
    const normal = outline.length >= 3 ? edgeOutwardNormal(outline, o.edgeIndex) : { x: -mark.dir.y, y: mark.dir.x };
    const toConfirm = o.from === 'default' || o.from === 'estimate';
    const cls = [
      'p2c-plan__opening',
      `p2c-plan__opening--${o.kind}`,
      toConfirm ? 'is-unconfirmed' : '',
      props.selectedId === o.id ? 'is-selected' : '',
    ].join(' ');
    const it = props.interaction;
    marks.push(
      <g
        key={o.id}
        className={cls}
        {...(it
          ? {
              tabIndex: 0,
              role: 'button',
              'aria-label': it.label(o),
              onKeyDown: (e: KeyboardEvent) => {
                if (activationKey(e)) {
                  e.preventDefault();
                  e.stopPropagation();
                  it.activate(o);
                } else if ((e.key === 'Delete' || e.key === 'Backspace') && it.remove) {
                  e.preventDefault();
                  e.stopPropagation();
                  it.remove(o);
                }
              },
            }
          : {})}
      >
        <line className="p2c-plan__opening-halo" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        <line className="p2c-plan__opening-bar" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        {o.kind === 'window' ? <line className="p2c-plan__opening-glass" x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> : null}
        {props.labels ? (
          <Label {...outsideLabel(c, normal, 12)} className="p2c-plan__label--opening">
            {openingLabel(o) + (toConfirm ? ' ?' : '')}
          </Label>
        ) : null}
      </g>,
    );
  }
  return <g>{marks}</g>;
}

/** Marqueur du point d'accrochage et guides actifs (angle droit, alignement). */
export function SnapOverlay(props: { snap: SnapResult | null; view: View; size: Size; hint?: string | null }) {
  const snap = props.snap;
  if (!snap) return null;
  const p = sheetToScreen(props.view, snap.point);
  const reach = Math.hypot(props.size.width, props.size.height);
  let marker: ReactNode = null;
  switch (snap.kind) {
    case 'endpoint':
      marker = <rect x={p.x - 5} y={p.y - 5} width={10} height={10} />;
      break;
    case 'intersection':
      marker = <path d={`M${p.x - 5},${p.y - 5}L${p.x + 5},${p.y + 5}M${p.x - 5},${p.y + 5}L${p.x + 5},${p.y - 5}`} />;
      break;
    case 'vertex':
    case 'close':
      marker = <circle cx={p.x} cy={p.y} r={snap.kind === 'close' ? 9 : 6} />;
      break;
    case 'online':
      marker = <path d={`M${p.x - 5},${p.y + 4}L${p.x},${p.y - 5}L${p.x + 5},${p.y + 4}Z`} />;
      break;
    case 'guide':
      marker = <path d={`M${p.x},${p.y - 5}L${p.x + 5},${p.y}L${p.x},${p.y + 5}L${p.x - 5},${p.y}Z`} />;
      break;
    default:
      marker = null;
  }
  return (
    <g className="p2c-plan__snap" aria-hidden="true">
      {snap.guides.map((g, i) => {
        const o = sheetToScreen(props.view, g.origin);
        return (
          <line
            key={i}
            className={`p2c-plan__guide p2c-plan__guide--${g.kind}`}
            x1={o.x - g.dir.x * reach}
            y1={o.y - g.dir.y * reach}
            x2={o.x + g.dir.x * reach}
            y2={o.y + g.dir.y * reach}
          />
        );
      })}
      {marker ? <g className={`p2c-plan__snap-mark p2c-plan__snap-mark--${snap.kind}`}>{marker}</g> : null}
      {props.hint ? (
        <Label x={p.x + 12} y={p.y - 14} anchor="start" className="p2c-plan__label--hint">
          {props.hint}
        </Label>
      ) : null}
    </g>
  );
}
