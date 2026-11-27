/**
 * Lecture hors du fil principal (offthread.ts) avec un faux worker : chien de garde, plantage, résultat,
 * worker qui ne démarre pas. Le vrai worker n'existe que dans le navigateur (contrôlé à part avec le build).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDocument } from '../../../src/core/types';
import { decodeBudgetMs, watchdogMs } from '../../../src/readers/cad';
import type { CadReadDetails } from '../../../src/readers/cad';
import { CadWorkerUnavailableError, readCadOffThread } from '../../../src/readers/cad/offthread';
import type { CadWorkerPort, CadWorkerReply, CadWorkerRequest } from '../../../src/readers/cad/offthread';

interface FakePort extends CadWorkerPort {
  posted: CadWorkerRequest[];
  terminated: number;
  reply(r: CadWorkerReply): void;
  crash(): void;
}

function fakePort(): FakePort {
  const port: FakePort = {
    posted: [],
    terminated: 0,
    onReply: null,
    onCrash: null,
    post: (request) => port.posted.push(request),
    terminate: () => {
      port.terminated++;
    },
    reply: (r) => port.onReply?.(r),
    crash: () => port.onCrash?.(),
  };
  return port;
}

const request: CadWorkerRequest = { data: new ArrayBuffer(8), fileName: 'plan.dwg', kind: 'dwg', options: { lang: 'fr' } };
const options = { timeoutMs: 1000, unreadableMessage: 'Ce fichier DWG est illisible ou abîmé.' };
const doc: PlanDocument = { fileName: 'plan.dwg', kind: 'dwg', sheets: [], storeysAligned: false, warnings: [] };
const details = { version: 'AC1032' } as CadReadDetails;

describe('readCadOffThread', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rend le résultat du worker puis l’arrête', async () => {
    const port = fakePort();
    const pending = readCadOffThread(() => port, request, options);
    expect(port.posted).toEqual([request]);
    port.reply({ type: 'started' });
    port.reply({ type: 'done', doc, details });
    await expect(pending).resolves.toEqual({ doc, details });
    expect(port.terminated).toBe(1);
  });

  it('worker bloqué (décodeur qui boucle) : arrêté au bout du délai, message « illisible » traduit', async () => {
    const port = fakePort();
    const pending = readCadOffThread(() => port, request, options);
    port.reply({ type: 'started' });
    const verdict = expect(pending).rejects.toThrow('Ce fichier DWG est illisible ou abîmé.');
    await vi.advanceTimersByTimeAsync(999);
    expect(port.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await verdict;
    expect(port.terminated).toBe(1);
    // Une réponse tardive du worker arrêté est ignorée.
    port.reply({ type: 'done', doc, details });
    expect(port.terminated).toBe(1);
  });

  it('après un arrêt par le chien de garde, un second fichier se lit avec un worker neuf', async () => {
    const ports: FakePort[] = [];
    const create = (): FakePort => {
      const p = fakePort();
      ports.push(p);
      return p;
    };
    const first = readCadOffThread(create, request, options);
    ports[0]!.reply({ type: 'started' });
    const verdict = expect(first).rejects.toThrow(/illisible/);
    await vi.advanceTimersByTimeAsync(1000);
    await verdict;
    const second = readCadOffThread(create, request, options);
    expect(ports).toHaveLength(2);
    ports[1]!.reply({ type: 'started' });
    ports[1]!.reply({ type: 'done', doc, details });
    await expect(second).resolves.toMatchObject({ doc });
  });

  it('erreur rédigée par le worker : transmise telle quelle', async () => {
    const port = fakePort();
    const pending = readCadOffThread(() => port, request, options);
    port.reply({ type: 'started' });
    port.reply({ type: 'failed', message: 'Ce fichier DWG ne contient aucun dessin dans l’espace objet.' });
    await expect(pending).rejects.toThrow('aucun dessin');
    expect(port.terminated).toBe(1);
  });

  it('plantage du worker en cours de lecture (mémoire…) → « illisible »', async () => {
    const port = fakePort();
    const pending = readCadOffThread(() => port, request, options);
    port.reply({ type: 'started' });
    port.crash();
    await expect(pending).rejects.toThrow(/illisible/);
  });

  it('worker jamais démarré (script introuvable, création refusée, envoi impossible) → CadWorkerUnavailableError', async () => {
    const neverStarted = fakePort();
    const a = readCadOffThread(() => neverStarted, request, options);
    neverStarted.crash();
    await expect(a).rejects.toBeInstanceOf(CadWorkerUnavailableError);

    await expect(
      readCadOffThread(
        () => {
          throw new Error('Worker interdit');
        },
        request,
        options,
      ),
    ).rejects.toBeInstanceOf(CadWorkerUnavailableError);

    const refusing = fakePort();
    refusing.post = () => {
      throw new Error('DataCloneError');
    };
    await expect(readCadOffThread(() => refusing, request, options)).rejects.toBeInstanceOf(CadWorkerUnavailableError);

    // Silence total : le délai passe sans « started ».
    const silent = fakePort();
    const d = readCadOffThread(() => silent, request, options);
    const verdict = expect(d).rejects.toBeInstanceOf(CadWorkerUnavailableError);
    await vi.advanceTimersByTimeAsync(1000);
    await verdict;
  });
});

describe('délais', () => {
  it('le chien de garde laisse toujours parler le garde-fou du décodeur avant lui', () => {
    for (const bytes of [0, 20_000, 1_048_576, 10 * 1_048_576, 200 * 1_048_576]) {
      expect(watchdogMs(bytes)).toBeGreaterThan(decodeBudgetMs(bytes));
    }
  });
});
