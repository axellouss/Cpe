/**
 * Garde-fous du décodage DWG (guard.ts) : décompression R2004+ contrôlée et carte des sections.
 * Ce fichier n'importe PAS le lecteur (load.ts installe les garde-fous) : la décompression d'origine d'acad-ts
 * reste disponible pour comparer.
 */
import { describe, expect, it } from 'vitest';
import { DwgLZ77AC18Decompressor, DwgReader } from '@node-projects/acad-ts';
import { DwgGuardError, checkSectionMap, guardedDecompressToDest } from '../../../src/readers/cad/guard';
import { fixtureBytes } from './helpers';

type Decompress = (src: Uint8Array, offset: number, dst: Uint8Array) => void;
const lz = DwgLZ77AC18Decompressor as unknown as { decompressToDest: Decompress };
const original: Decompress = lz.decompressToDest.bind(DwgLZ77AC18Decompressor);

/**
 * Flux LZ77 : 19 littéraux « A », puis `ops` fois le code 0x20 suivi de `zeros` octets nuls (copie annoncée de
 * 255 × `zeros` octets, motif d'un octet), puis le code de fin 0x11.
 */
function hugeCopy(zeros: number, ops: number): Uint8Array {
  const opLength = zeros + 4;
  const out = new Uint8Array(21 + ops * opLength + 1); // octets nuls par défaut
  out[1] = 0x01; // code 0x00 puis 0x01 : 0x0F + 1 + 3 = 19 littéraux
  out.fill(0x41, 2, 21);
  for (let i = 0; i < ops; i++) {
    const at = 21 + i * opLength;
    out[at] = 0x20;
    out[at + zeros + 1] = 0x01; // fin du nombre étendu ; les deux octets suivants (décalage) restent nuls
  }
  out[out.length - 1] = 0x11;
  return out;
}

describe('décompression R2004+ contrôlée', () => {
  it('mêmes octets que la décompression d’acad-ts sur tous les flux du DWG 2018 d’essai', () => {
    let calls = 0;
    let different = 0;
    lz.decompressToDest = (src, offset, dst) => {
      calls++;
      original(src, offset, dst);
      const mine = new Uint8Array(dst.length);
      guardedDecompressToDest(src, offset, mine);
      // Compté et non vérifié ici : acad-ts rattrape les erreurs levées pendant certaines lectures.
      if (mine.some((v, i) => v !== dst[i])) different++;
    };
    try {
      DwgReader.readFromStream(fixtureBytes('fixture_rdc_cm.dwg'), () => {});
    } finally {
      lz.decompressToDest = original;
    }
    expect(calls).toBeGreaterThan(5);
    expect(different).toBe(0);
  });

  it('copie annoncée bien plus longue que la zone : même résultat que l’original, travail borné', () => {
    const stream = hugeCopy(40, 3); // 3 copies d'environ 10 000 octets dans une zone de 64
    const expected = new Uint8Array(64);
    original(stream, 0, expected);
    const mine = new Uint8Array(64);
    guardedDecompressToDest(stream, 0, mine);
    expect(mine).toEqual(expected);
    expect(mine[0]).toBe(0x41);
  });

  it('flux abîmé dont les copies annoncent des centaines de millions d’octets : fini en un instant', () => {
    // 40 copies de 64 Mo chacune : l'original recopierait 2,6 milliards d'octets un à un.
    const stream = hugeCopy(260_000, 40);
    const t0 = Date.now();
    guardedDecompressToDest(stream, 0, new Uint8Array(30_000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('flux qui se termine avant le code de fin → DwgGuardError', () => {
    const stream = hugeCopy(4, 2);
    expect(() => guardedDecompressToDest(stream.subarray(0, stream.length - 3), 0, new Uint8Array(64))).toThrow(DwgGuardError);
  });
});

/** Carte des sections : en-tête de 20 octets, descriptions de 96 octets, pages de 16 octets. */
function sectionMap(sections: { size: number; pageSize: number; offsets: number[] }[]): Uint8Array {
  const bytes = new Uint8Array(20 + sections.reduce((n, s) => n + 96 + 16 * s.offsets.length, 0));
  const view = new DataView(bytes.buffer);
  view.setInt32(0, sections.length, true);
  let pos = 20;
  for (const s of sections) {
    view.setUint32(pos, s.size % 0x100000000, true);
    view.setUint32(pos + 4, Math.floor(s.size / 0x100000000), true);
    view.setInt32(pos + 8, s.offsets.length, true);
    view.setInt32(pos + 12, s.pageSize, true);
    view.setInt32(pos + 20, 2, true);
    pos += 96;
    s.offsets.forEach((offset, i) => {
      view.setInt32(pos, i + 1, true);
      view.setInt32(pos + 4, 100, true);
      view.setUint32(pos + 8, offset % 0x100000000, true);
      view.setUint32(pos + 12, Math.floor(offset / 0x100000000), true);
      pos += 16;
    });
  }
  return bytes;
}

describe('carte des sections contrôlée avant qu’acad-ts ne la parcoure', () => {
  const MAX = 64 * 1_048_576;

  it('carte saine (pages consécutives, page vide intercalée) : acceptée', () => {
    expect(() => checkSectionMap(sectionMap([{ size: 3 * 0x7400, pageSize: 0x7400, offsets: [0, 2 * 0x7400] }]), MAX)).not.toThrow();
  });

  it('taille de page nulle avec un décalage à combler : refusée (acad-ts bouclerait sans fin)', () => {
    expect(() => checkSectionMap(sectionMap([{ size: 0x7400, pageSize: 0, offsets: [0x7400] }]), MAX)).toThrow(DwgGuardError);
    expect(() => checkSectionMap(sectionMap([{ size: 0x7400, pageSize: -4, offsets: [64] }]), MAX)).toThrow(DwgGuardError);
  });

  it('décalage démesuré (des millions de pages vides) : refusé', () => {
    expect(() => checkSectionMap(sectionMap([{ size: 0x7400, pageSize: 0x7400, offsets: [2 ** 40] }]), MAX)).toThrow(DwgGuardError);
    expect(() => checkSectionMap(sectionMap([{ size: 2 ** 45, pageSize: 1, offsets: [] }]), MAX)).toThrow(DwgGuardError);
  });

  it('carte tronquée : laissée à acad-ts, qui lève sa propre erreur', () => {
    const map = sectionMap([{ size: 0x7400, pageSize: 0, offsets: [0x7400] }]);
    expect(() => checkSectionMap(map.subarray(0, 60), MAX)).not.toThrow();
  });
});
