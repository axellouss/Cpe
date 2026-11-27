/**
 * Boîte de dialogue modale et panneau latéral : rôle « dialog », Échap pour fermer, focus retenu à l'intérieur
 * puis rendu à l'élément d'origine. (Pas d'élément <dialog> natif : même comportement partout, tests compris.)
 */
import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useT } from './common';
import { Icon } from './icons';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  /** 'modal' : centré ; 'drawer' : panneau à droite (mode expert). */
  variant?: 'modal' | 'drawer';
  /** Sous-titre court sous le titre. */
  subtitle?: string;
  testId?: string;
  footer?: ReactNode;
}

export function Dialog(props: DialogProps) {
  const tr = useT();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const variant = props.variant ?? 'modal';

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current;
    first?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={`overlay overlay--${variant}`} onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={panel}
        className={`dialog dialog--${variant}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-testid={props.testId}
      >
        <header className="dialog__head">
          <div>
            <h2 id={titleId} className="dialog__title">
              {props.title}
            </h2>
            {props.subtitle ? <p className="dialog__subtitle">{props.subtitle}</p> : null}
          </div>
          <button type="button" className="btn btn--icon" onClick={props.onClose} aria-label={tr('shell.close')} title={tr('shell.close')} data-testid="dialog-close">
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog__body">{props.children}</div>
        {props.footer ? <footer className="dialog__foot">{props.footer}</footer> : null}
      </div>
    </div>
  );
}
