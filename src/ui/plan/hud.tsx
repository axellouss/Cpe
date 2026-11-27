/**
 * Éléments HTML posés par-dessus le plan : bulle (ou feuille en bas d'écran sur téléphone), pastilles de choix
 * rapide, compteur pas à pas, bandeau de rappel.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Boundary, Vec2 } from '../../core/types';
import { formatDecimal } from './numbers';
import type { Size } from './view';

/** Bandeau de rappel de l'outil (une ou deux lignes). `strong` = mise en garde à ne pas manquer. */
export function Hint(props: { children: ReactNode; tone?: 'info' | 'warn'; icon?: ReactNode }) {
  return (
    <div className={`p2c-plan__hint p2c-plan__hint--${props.tone ?? 'info'}`} role="note">
      {props.icon ? <span className="p2c-plan__hint-icon" aria-hidden="true">{props.icon}</span> : null}
      <span>{props.children}</span>
    </div>
  );
}

export function Button(props: {
  children: ReactNode;
  onClick(): void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  title?: string;
  pressed?: boolean;
  autoFocus?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`p2c-plan__btn p2c-plan__btn--${props.variant ?? 'ghost'}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      aria-pressed={props.pressed}
      data-autofocus={props.autoFocus ? '' : undefined}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}

/**
 * Bulle ancrée à un point de l'écran ; elle se replie pour rester dans la zone de plan.
 * En mode compact (téléphone) c'est une feuille collée en bas, pleine largeur.
 */
export function Popover(props: {
  anchor: Vec2 | null;
  size: Size;
  compact: boolean;
  label: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
  testId?: string;
  /** Vrai = simple bulle d'actions : elle ne prend pas le clavier (les flèches continuent d'agir sur le plan). */
  passive?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const { anchor, size, compact, passive } = props;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || compact || !anchor) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gapX = 30;
    const gapY = 18;
    let left = anchor.x + gapX;
    let top = anchor.y + gapY;
    if (left + w > size.width - 8) left = anchor.x - gapX - w;
    if (top + h > size.height - 8) top = anchor.y - gapY - h;
    left = Math.min(Math.max(8, left), Math.max(8, size.width - w - 8));
    top = Math.min(Math.max(8, top), Math.max(8, size.height - h - 8));
    setPos((prev) => (prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5 ? prev : { left, top }));
  });

  // À l'ouverture, le clavier va dans la bulle (premier champ marqué, sinon la bulle elle-même). On attend que la
  // bulle soit placée : tant qu'elle est masquée (visibility: hidden), le navigateur refuse de lui donner le focus.
  const placed = compact || !anchor || pos !== null;
  const focused = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || passive || !placed || focused.current) return;
    focused.current = true;
    const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el;
    target.focus({ preventScroll: true });
    if (target instanceof HTMLInputElement) target.select();
  }, [placed, passive]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  };

  const floating = !compact && anchor;
  return (
    <div
      ref={ref}
      className={`p2c-plan__popover ${compact || !anchor ? 'p2c-plan__popover--sheet' : ''} ${props.className ?? ''}`}
      style={floating ? { left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' } : undefined}
      role="dialog"
      aria-label={props.label}
      tabIndex={-1}
      data-p2c-ui=""
      onKeyDown={onKeyDown}
      data-testid={props.testId}
    >
      {props.children}
    </div>
  );
}

/** Échantillon de trait d'une façade, dessiné exactement comme sur le plan (même couleur, même motif). */
export function BoundarySwatch(props: { boundary: Boundary }) {
  return (
    <svg className="p2c-plan__line-swatch" width="36" height="10" viewBox="0 0 36 10" aria-hidden="true" focusable="false">
      <line className={`p2c-plan__edge p2c-plan__edge--${props.boundary}`} x1="3" y1="5" x2="33" y2="5" />
    </svg>
  );
}

/** Pastilles de valeurs courantes (m). La pastille égale à la valeur saisie est marquée. */
export function QuickChips(props: { values: readonly number[]; current: number | null; onPick(value: number): void; label: string }) {
  return (
    <div className="p2c-plan__chips" role="group" aria-label={props.label}>
      {props.values.map((v) => {
        const active = props.current !== null && Math.abs(props.current - v) < 0.0005;
        return (
          <button key={v} type="button" className={`p2c-plan__chip ${active ? 'is-active' : ''}`} aria-pressed={active} onClick={() => props.onPick(v)}>
            {formatDecimal(v, 2)}
          </button>
        );
      })}
    </div>
  );
}

/** Compteur − n + (jamais de curseur à glisser pour un nombre). */
export function Stepper(props: { value: number; min: number; max: number; onChange(value: number): void; label: string; lessLabel: string; moreLabel: string }) {
  const { value, min, max } = props;
  return (
    <div className="p2c-plan__stepper" role="group" aria-label={props.label}>
      <button type="button" className="p2c-plan__step" onClick={() => props.onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={props.lessLabel}>
        −
      </button>
      <output className="p2c-plan__step-value" aria-live="polite">
        {value}
      </output>
      <button type="button" className="p2c-plan__step" onClick={() => props.onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={props.moreLabel}>
        +
      </button>
    </div>
  );
}

/** Choix exclusif présenté comme des boutons accolés (vrais boutons radio pour le clavier et les lecteurs d'écran). */
export function Segmented<T extends string>(props: {
  name: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string; swatch?: ReactNode }[];
  onChange(value: T): void;
  vertical?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className={`p2c-plan__segmented ${props.vertical ? 'p2c-plan__segmented--vertical' : ''}`} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <label key={o.value} className={`p2c-plan__segment ${o.value === props.value ? 'is-active' : ''}`}>
          <input
            type="radio"
            name={props.name}
            value={o.value}
            checked={o.value === props.value}
            onChange={() => props.onChange(o.value)}
            data-autofocus={props.autoFocus && o.value === props.value ? '' : undefined}
          />
          {o.swatch ?? null}
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** Une mesure du bandeau de compteurs. */
export function Counter(props: { label: string; value: string; unit?: string; tone?: 'plain' | 'warn' | 'accent'; title?: string; testId?: string }) {
  return (
    <div className={`p2c-plan__counter p2c-plan__counter--${props.tone ?? 'plain'}`} title={props.title} data-testid={props.testId}>
      <span className="p2c-plan__counter-label">{props.label}</span>
      <span className="p2c-plan__counter-value">
        {props.value}
        {props.unit ? <span className="p2c-plan__counter-unit"> {props.unit}</span> : null}
      </span>
    </div>
  );
}
