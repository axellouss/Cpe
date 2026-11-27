import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, commit, createHistory, HISTORY_LIMIT, redo, sealHistory, undo } from '../../../src/ui/shell/history';

describe('historique annuler / rétablir', () => {
  it('enregistre un pas par modification et revient en arrière', () => {
    let h = createHistory('a');
    h = commit(h, 'b', { now: 0, label: 'un' });
    h = commit(h, 'c', { now: 10, label: 'deux' });
    expect(h.present).toBe('c');
    expect(canUndo(h)).toBe(true);

    const first = undo(h);
    expect(first.changed).toBe(true);
    expect(first.label).toBe('deux');
    expect(first.history.present).toBe('b');

    const second = undo(first.history);
    expect(second.label).toBe('un');
    expect(second.history.present).toBe('a');
    expect(canUndo(second.history)).toBe(false);
    expect(undo(second.history).changed).toBe(false);
  });

  it('rétablit dans l’ordre, avec le nom de l’action', () => {
    let h = createHistory(1);
    h = commit(h, 2, { now: 0, label: 'x' });
    h = commit(h, 3, { now: 1, label: 'y' });
    h = undo(undo(h).history).history;
    expect(h.present).toBe(1);
    expect(canRedo(h)).toBe(true);
    const r1 = redo(h);
    expect(r1.label).toBe('x');
    expect(r1.history.present).toBe(2);
    const r2 = redo(r1.history);
    expect(r2.label).toBe('y');
    expect(r2.history.present).toBe(3);
    expect(redo(r2.history).changed).toBe(false);
  });

  it('une nouvelle modification efface ce qui pouvait être rétabli', () => {
    let h = createHistory(1);
    h = commit(h, 2, { now: 0 });
    h = undo(h).history;
    h = commit(h, 5, { now: 1 });
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe(5);
  });

  it('fusionne les modifications de même clé qui se suivent de près', () => {
    let h = createHistory(0);
    // Un glissement : dix versions en 150 ms.
    for (let i = 1; i <= 10; i++) h = commit(h, i, { now: i * 15, key: 'drag', window: 250 });
    expect(h.present).toBe(10);
    expect(h.past).toHaveLength(1);
    expect(undo(h).history.present).toBe(0);
  });

  it('ne fusionne ni après le délai, ni avec une autre clé, ni sans clé', () => {
    let h = createHistory(0);
    h = commit(h, 1, { now: 0, key: 'a', window: 250 });
    h = commit(h, 2, { now: 1000, key: 'a', window: 250 }); // trop tard
    h = commit(h, 3, { now: 1010, key: 'b', window: 250 }); // autre clé
    h = commit(h, 4, { now: 1020 }); // sans clé
    h = commit(h, 5, { now: 1030 });
    expect(h.past.map((e) => e.state)).toEqual([0, 1, 2, 3, 4]);
  });

  it('la fenêtre de fusion se mesure depuis la DERNIÈRE modification (un geste long reste un seul pas)', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 40; i++) h = commit(h, i, { now: i * 100, key: 'drag', window: 250 });
    expect(h.past).toHaveLength(1);
  });

  it('annuler interrompt la fusion', () => {
    let h = createHistory(0);
    h = commit(h, 1, { now: 0, key: 'k' });
    h = commit(h, 2, { now: 10, key: 'k' });
    h = undo(h).history;
    h = commit(h, 3, { now: 20, key: 'k' });
    h = commit(h, 4, { now: 30, key: 'k' });
    // 0 → 4 en un pas (3 et 4 fusionnés), mais pas fusionné avec le pas annulé.
    expect(h.past.map((e) => e.state)).toEqual([0]);
    expect(h.present).toBe(4);
  });

  it('sceller force un nouveau pas même avec la même clé', () => {
    let h = createHistory(0);
    h = commit(h, 1, { now: 0, key: 'k' });
    h = sealHistory(h);
    h = commit(h, 2, { now: 5, key: 'k' });
    expect(h.past).toHaveLength(2);
  });

  it('ignore un état identique et borne la longueur de l’historique', () => {
    let h = createHistory(0);
    expect(commit(h, 0, { now: 0 })).toBe(h);
    for (let i = 1; i <= HISTORY_LIMIT + 30; i++) h = commit(h, i, { now: i });
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.present).toBe(HISTORY_LIMIT + 30);
  });
});
