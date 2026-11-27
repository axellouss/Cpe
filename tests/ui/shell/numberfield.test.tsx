// @vitest-environment jsdom
/**
 * Champ numérique : rien n'est transmis frappe par frappe ; une saisie refusée laisse la valeur d'avant intacte.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NumberField } from '../../../src/ui/shell/components/common';
import '../../../src/ui/shell/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function input(): HTMLInputElement {
  return host.querySelector('input')!;
}

async function typeText(text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    input().focus();
  });
  // Frappe par frappe, comme au clavier.
  for (let i = 1; i <= text.length; i++) {
    await act(async () => {
      setter.call(input(), text.slice(0, i));
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

async function leave(): Promise<void> {
  await act(async () => {
    input().blur();
  });
}

describe('NumberField', () => {
  it('« 280 » dans une hauteur de 1 à 15 m : rien n’est transmis, la valeur d’avant reste, la plage est indiquée', async () => {
    const onCommit = vi.fn();
    await act(async () => root.render(<NumberField id="h" value={2.8} min={1} max={15} digits={2} unit="m" onCommit={onCommit} />));
    await typeText('280');
    expect(onCommit).not.toHaveBeenCalled(); // ni « 2 », ni « 28 » au passage
    expect(input().getAttribute('aria-invalid')).toBe('true');
    await leave();
    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe('2,8');
    const alert = host.querySelector('[role=alert]');
    expect(alert?.textContent).toContain('de 1 à 15 m');
    expect(input().getAttribute('aria-describedby')).toBe('h-error');
  });

  it('une valeur valide est transmise une seule fois, à la sortie du champ ou sur Entrée', async () => {
    const onCommit = vi.fn();
    await act(async () => root.render(<NumberField id="h" value={2.8} min={1} max={15} digits={2} unit="m" onCommit={onCommit} />));
    await typeText('2,65');
    expect(onCommit).not.toHaveBeenCalled();
    await leave();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(2.65);
    expect(host.querySelector('[role=alert]')).toBeNull();
  });

  it('sortir sans rien changer ne transmet rien ; Échap annule la frappe', async () => {
    const onCommit = vi.fn();
    await act(async () => root.render(<NumberField id="h" value={2.8} min={1} max={15} digits={2} onCommit={onCommit} />));
    await act(async () => {
      input().focus();
    });
    await leave();
    expect(onCommit).not.toHaveBeenCalled();
    await typeText('3');
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await leave();
    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe('2,8');
  });

  it('champ vidé : transmis comme « non renseigné » seulement si c’est permis', async () => {
    const onCommit = vi.fn();
    await act(async () => root.render(<NumberField id="n" value={60} min={0} max={1000} allowEmpty onCommit={onCommit} />));
    await typeText('6');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input(), '');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await leave();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(null);
  });
});
