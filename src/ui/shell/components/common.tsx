/**
 * Briques communes aux écrans : traduction, étiquette de provenance, jauge, compteur animé, bouton « copier »,
 * champ numérique (virgule ou point), annonces pour lecteurs d'écran.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Provenance } from '../../../core/types';
import { t } from '../../../i18n';
import { copyText, prefersReducedMotion } from '../browser';
import { fixed, inputNumber, parseNumber } from '../numbers';
import { useShell } from '../store';
import { Icon } from './icons';
import type { IconName } from './icons';

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Fonction de traduction liée à la langue courante. */
export function useT(): Translate {
  const lang = useShell((s) => s.lang);
  return useCallback((key, params) => t(lang, key, params), [lang]);
}

// ───────────────────────────── Annonces (aria-live) ─────────────────────────────

const AnnounceContext = createContext<(text: string) => void>(() => undefined);

/** Région « polie » unique : les confirmations de copie et les validations y sont annoncées. */
export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const flip = useRef(false);
  const announce = useCallback((text: string) => {
    // Un même texte répété doit être réannoncé : on alterne un caractère invisible.
    flip.current = !flip.current;
    setMessage(flip.current ? text : `${text}​`);
  }, []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="announcer">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): (text: string) => void {
  return useContext(AnnounceContext);
}

// ───────────────────────────── Provenance ─────────────────────────────

/** Étiquette « plan / calcul / défaut / estimation / vous » ; null = valeur absente, à saisir. */
export function ProvenanceTag({ from, note }: { from: Provenance | null; note?: string }) {
  const tr = useT();
  const kind = from ?? 'none';
  const full = tr(`shell.prov.long.${kind}`);
  return (
    <span className={`tag tag--${kind}`} title={note ? `${full} — ${note}` : full}>
      {tr(`shell.prov.${kind}`)}
    </span>
  );
}

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'muted' | 'info';

export function Badge({ tone, children, icon }: { tone: BadgeTone; children: ReactNode; icon?: IconName }) {
  return (
    <span className={`badge badge--${tone}`}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}

// ───────────────────────────── Jauge ─────────────────────────────

export function Meter({ label, percent, tone, title }: { label: string; percent: number; tone: 'complete' | 'confirmed'; title: string }) {
  return (
    <div className={`meter meter--${tone}`} title={title}>
      <div className="meter__head">
        <span className="meter__label">{label}</span>
        <span className="meter__value">
          <AnimatedNumber value={percent} digits={0} /> %
        </span>
      </div>
      <div className="meter__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={label}>
        <div className="meter__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

// ───────────────────────────── Compteur animé ─────────────────────────────

/** Nombre qui glisse vers sa nouvelle valeur (300 ms) : le bâtiment « réagit » sous les doigts. */
export function AnimatedNumber({ value, digits = 1 }: { value: number | null; digits?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const frame = useRef(0);

  useEffect(() => {
    const start = from.current;
    from.current = value;
    const canAnimate =
      value !== null && start !== null && Number.isFinite(value) && Number.isFinite(start) && start !== value && typeof requestAnimationFrame === 'function' && !prefersReducedMotion();
    if (!canAnimate) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    const duration = 320;
    const tick = (now: number): void => {
      const k = Math.min(1, (now - t0) / duration);
      const eased = 1 - (1 - k) ** 3;
      setShown(start + (value - start) * eased);
      if (k < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value]);

  return <span className="num">{fixed(shown, digits)}</span>;
}

// ───────────────────────────── Copier ─────────────────────────────

export interface CopyButtonProps {
  /** Texte placé dans le presse-papiers. */
  text: string;
  /** Libellé du bouton (« Copier » par défaut). */
  label?: string;
  /** Nom de la valeur pour les lecteurs d'écran (« Copier Länge »). */
  ariaLabel?: string;
  variant?: 'ghost' | 'solid' | 'cell';
  testId?: string;
  children?: ReactNode;
}

/** Bouton « copier » : passe à « Copié ✓ » pendant deux secondes et l'annonce aux lecteurs d'écran. */
export function CopyButton(props: CopyButtonProps) {
  const tr = useT();
  const announce = useAnnounce();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = async (): Promise<void> => {
    const ok = await copyText(props.text);
    setState(ok ? 'copied' : 'failed');
    announce(ok ? tr('shell.copy.announce', { value: props.text.length > 60 ? `${props.text.slice(0, 57)}…` : props.text }) : tr('shell.copy.failed'));
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };

  const variant = props.variant ?? 'ghost';
  const label = props.label ?? tr('shell.copy');
  return (
    <button
      type="button"
      className={`copy copy--${variant} ${state === 'copied' ? 'is-copied' : ''} ${state === 'failed' ? 'is-failed' : ''}`}
      onClick={() => void onClick()}
      aria-label={props.ariaLabel}
      data-testid={props.testId}
      data-state={state}
    >
      {variant === 'cell' ? (
        <>
          <span className="copy__content">{props.children}</span>
          <span className="copy__flash" aria-hidden="true">
            {state === 'copied' ? <Icon name="check" size={14} /> : null}
          </span>
        </>
      ) : (
        <>
          <Icon name={state === 'copied' ? 'check' : 'copy'} size={16} />
          <span>{state === 'copied' ? tr('shell.copy.done') : state === 'failed' ? tr('shell.copy.retry') : label}</span>
        </>
      )}
    </button>
  );
}

// ───────────────────────────── Champ numérique ─────────────────────────────

export interface NumberFieldProps {
  value: number | null;
  /** Appelé à chaque valeur valide ; null quand le champ est vidé (si `allowEmpty`). */
  onCommit(value: number | null): void;
  id?: string;
  ariaLabel?: string;
  min?: number;
  max?: number;
  /** Décimales affichées au plus. */
  digits?: number;
  allowEmpty?: boolean;
  placeholder?: string;
  /** Unité affichée à droite du champ. */
  unit?: string;
  /** Entier attendu (année, nombre de logements). */
  integer?: boolean;
  className?: string;
  testId?: string;
  describedBy?: string;
}

/** Champ de nombre : accepte la virgule et le point, ne transmet que des valeurs valides, se remet en forme en sortant. */
export function NumberField(props: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const formatted = inputNumber(props.value, props.integer ? 0 : (props.digits ?? 3));
  const shown = draft ?? formatted;

  const valid = (text: string): boolean => {
    if (text.trim() === '') return props.allowEmpty === true;
    const v = parseNumber(text);
    if (v === null) return false;
    if (props.integer && !Number.isInteger(v)) return false;
    if (props.min !== undefined && v < props.min) return false;
    if (props.max !== undefined && v > props.max) return false;
    return true;
  };

  const onChange = (text: string): void => {
    setDraft(text);
    if (!valid(text)) return;
    props.onCommit(text.trim() === '' ? null : parseNumber(text));
  };

  const invalid = draft !== null && draft.trim() !== '' && !valid(draft);
  return (
    <span className={`field ${props.className ?? ''} ${invalid ? 'is-invalid' : ''}`}>
      <input
        id={props.id}
        className="field__input"
        type="text"
        inputMode={props.integer ? 'numeric' : 'decimal'}
        autoComplete="off"
        value={shown}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={props.describedBy}
        data-testid={props.testId}
        onFocus={(e) => {
          setDraft(formatted);
          e.currentTarget.select();
        }}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {props.unit ? <span className="field__unit">{props.unit}</span> : null}
    </span>
  );
}
