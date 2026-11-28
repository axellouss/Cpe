/**
 * Hauteurs libres rattachées à leur niveau (src/readers/pdf/clearheights.ts) et suivi de lecture de readPlanFile.
 * Pages synthétiques (données inventées) : une coupe au 1:100 avec deux niveaux finis cotés et une chaîne de cotes
 * verticale, une mention « HSP » dans un plan.
 */
import { describe, expect, it } from 'vitest';
import type { ReadLevels, ReadView } from '../../../src/core/reading';
import { readPlanFile, type ReadProgress } from '../../../src/readers';
import { readClearHeights } from '../../../src/readers/pdf/clearheights';
import { METRES_PER_POINT } from '../../../src/readers/pdf/raw';
import { fixtureBytes, page, text } from './helpers';

const MPP = 100 * METRES_PER_POINT;
const box = (minX: number, minY: number, maxX: number, maxY: number): ReadView['box'] => ({ minX, minY, maxX, maxY });

function view(id: string, kind: ReadView['kind'], b: ReadView['box']): ReadView {
  return { id, page: 1, kind, title: null, titleBox: null, storeyRank: kind === 'floor-plan' ? 0 : null, sides: null, box: b, buildingBox: null, sheetId: null, confidence: 0.9, sources: [], doubts: [] };
}

/** Coupe : niveau fini +0,20 à y0, +3,10 à y0 − 2,90 m, acrotère +6,40 ; marques dessinées à leur hauteur. */
function sectionLevels(y0: number, viewId: string, drift = 1): ReadLevels {
  const y = (rel: number): number => y0 - ((rel - 0.2) / MPP) * drift;
  const mark = (rel: number, role: 'finished-floor' | 'top') => ({ rel, abs: null, raw: `+${rel}`, label: null, role, viewId, page: 1, at: { x: 300, y: y(rel) } });
  return {
    referenceAbs: null,
    floors: [
      { rel: 0.2, abs: null, label: null, viewIds: [viewId], confidence: 0.9 },
      { rel: 3.1, abs: null, label: null, viewIds: [viewId], confidence: 0.9 },
    ],
    storeyHeights: [2.9],
    top: { rel: 6.4, role: 'top', confidence: 0.9 },
    eaves: null,
    clearHeights: [],
    marks: [mark(0.2, 'finished-floor'), mark(3.1, 'finished-floor'), mark(6.4, 'top')],
    checks: { checked: 0, failed: 0 },
  };
}

describe('hauteurs libres lues dans les coupes', () => {
  const y0 = 600;
  const mid1 = y0 - 1.45 / MPP;
  const mid2 = y0 - (2.9 + 1.5) / MPP;

  it('cote de la chaîne verticale entre deux niveaux finis → hauteur libre du niveau du bas', () => {
    const sec = view('s1', 'section', box(100, 300, 500, 700));
    const p = page([], [text('2,58', 250, mid1, 8, 90), text('2,61', 250, mid2, 8, 90)]);
    const { byFloor } = readClearHeights([p], [sec], sectionLevels(y0, 's1'), () => MPP);
    expect(byFloor).toEqual([
      { floorIndex: 0, value: 2.58, confidence: 0.65, viewId: 's1' },
      { floorIndex: 1, value: 2.61, confidence: 0.65, viewId: 's1' },
    ]);
  });

  it('une hauteur d’étage ou une cote trop petite n’est pas une hauteur libre', () => {
    const sec = view('s1', 'section', box(100, 300, 500, 700));
    // 2,90 = hauteur d'étage (pas d'épaisseur de plancher) ; 1,95 : bien moins que l'étage moins un plancher.
    const p = page([], [text('2,90', 250, mid1, 8, 90), text('1,95', 250, mid1 + 10, 8, 90)]);
    expect(readClearHeights([p], [sec], sectionLevels(y0, 's1'), () => MPP).byFloor).toEqual([]);
  });

  it('marques de niveau qui ne sont pas dessinées à leur hauteur (échelle incohérente) : rien n’est rattaché', () => {
    const sec = view('s1', 'section', box(100, 300, 500, 700));
    const p = page([], [text('2,58', 250, y0 - 1.45 / MPP / 2, 8, 90)]);
    expect(readClearHeights([p], [sec], sectionLevels(y0, 's1', 0.5), () => MPP).byFloor).toEqual([]);
  });

  it('même valeur dans deux coupes : recoupée (0,85) ; deux valeurs différentes : en doute (0,5)', () => {
    const a = view('s1', 'section', box(100, 300, 500, 700));
    const b = view('s2', 'section', box(600, 300, 1000, 700));
    const levels = sectionLevels(y0, 's1');
    levels.marks.push(...levels.marks.map((m) => ({ ...m, viewId: 's2', at: { x: 800, y: m.at.y } })));
    const same = page([], [text('2,58', 250, mid1, 8, 90), text('2,58', 750, mid1, 8, 90)]);
    expect(readClearHeights([same], [a, b], levels, () => MPP).byFloor[0]).toMatchObject({ floorIndex: 0, value: 2.58, confidence: 0.85 });
    const differ = page([], [text('2,58', 250, mid1, 8, 90), text('2,50', 750, mid1, 8, 90)]);
    expect(readClearHeights([differ], [a, b], levels, () => MPP).byFloor[0]!.confidence).toBe(0.5);
  });

  it('mention « HSP 2,50 » dans un plan d’étage → hauteur libre de ce niveau', () => {
    const plan = view('f0', 'floor-plan', box(100, 100, 500, 400));
    const levels = sectionLevels(y0, 'f0');
    levels.marks = [];
    const p = page([], [text('HSP 2,50', 300, 200)]);
    expect(readClearHeights([p], [plan], levels, () => MPP).byFloor).toEqual([{ floorIndex: 0, value: 2.5, confidence: 0.65, viewId: 'f0' }]);
  });
});

describe('suivi de lecture (readPlanFile)', () => {
  const file = (name: string, data: ArrayBuffer) => ({ name, arrayBuffer: async () => data });

  it('PDF : étapes open, views, rooms, envelope, layers, check dans l’ordre, avec leurs comptes', async () => {
    const seen: ReadProgress[] = [];
    await readPlanFile(file('planche.pdf', fixtureBytes('planche/planche_2pages.pdf')), { onProgress: (p) => seen.push(p) });
    expect(seen[0]).toEqual({ stage: 'open', status: 'running' });
    expect(seen.filter((p) => p.status !== 'running').map((p) => p.stage)).toEqual(['open', 'views', 'rooms', 'envelope', 'layers', 'check']);
    expect(seen.find((p) => p.stage === 'views')!.counts).toMatchObject({ plans: 2, sections: 1, elevations: 2 });
  });

  it('un suivi qui lève une erreur n’interrompt pas la lecture', async () => {
    const doc = await readPlanFile(file('planche.pdf', fixtureBytes('planche/planche_sans_titres.pdf')), {
      onProgress: () => {
        throw new Error('suivi en panne');
      },
    });
    expect(doc.sheets.length).toBe(2);
  });

  it('autres lecteurs : au moins l’ouverture', async () => {
    const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as { readFileSync(p: URL): Uint8Array };
    const buf = fs.readFileSync(new URL('../../fixtures/cad/fixture_rdc_cm.dxf', import.meta.url));
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const seen: ReadProgress[] = [];
    await readPlanFile(file('rdc.dxf', data), { onProgress: (p) => seen.push(p) });
    expect(seen.map((p) => `${p.stage}:${p.status}`)).toEqual(['open:running', 'open:done']);
  });
});
