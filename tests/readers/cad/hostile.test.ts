/**
 * DWG abîmés (revue : readers-dwg-corrupt-hang) : un DWG tronqué ou dont quelques octets ont changé faisait
 * boucler acad-ts sans fin. Les fichiers abîmés sont fabriqués ICI à partir des plans d'essai du dépôt
 * (mêmes altérations que les fichiers de la revue) : la lecture doit échouer vite, avec le message traduit,
 * et la lecture suivante doit marcher.
 *
 * Ces lectures se font dans le fil courant (comme sous Node) : elles ne sont protégées que par les garde-fous
 * de guard.ts, pas par le chien de garde du worker. Un échec ici signifie donc un gel de l'onglet en repli.
 */
import { describe, expect, it } from 'vitest';
import { readCad } from '../../../src/readers/cad';
import { dxfLine, dxfRect, dxfText, fixtureBytes, miniDxf } from './helpers';

/** Suite pseudo-aléatoire reproductible (générateur congruentiel). */
function pseudoRandom(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

/** Inverse `count` octets choisis au hasard (après les 200 premiers). */
function flipped(name: string, seed: number, count: number): ArrayBuffer {
  const bytes = new Uint8Array(fixtureBytes(name));
  const r = pseudoRandom(count * 2, seed);
  for (let i = 0; i < count; i++) {
    const pos = 200 + ((((r[2 * i]! << 8) | r[2 * i + 1]!) * 7919) % Math.max(1, bytes.length - 200));
    bytes[pos] = bytes[pos]! ^ 0xff;
  }
  return bytes.buffer;
}

/** Change un bit d'un octet du plan d'essai. */
function bitFlipped(name: string, offset: number, mask: number): ArrayBuffer {
  const bytes = new Uint8Array(fixtureBytes(name));
  bytes[offset] = bytes[offset]! ^ mask;
  return bytes.buffer;
}

function truncated(name: string, fraction: number): ArrayBuffer {
  const bytes = fixtureBytes(name);
  return bytes.slice(0, Math.floor(bytes.byteLength * fraction));
}

const UNREADABLE_FR = 'Ce fichier DWG est illisible ou abîmé. Essayez de l’enregistrer en DXF depuis votre logiciel de dessin.';

const cases: [string, () => ArrayBuffer][] = [
  // DWG 2018 (AC1032) : la décompression R2004+ recopiait sans fin des octets hors de la zone à remplir.
  ['200 octets inversés (DWG 2018)', () => flipped('fixture_rdc_cm.dwg', 11, 200)],
  ['1 octet inversé (DWG 2018)', () => flipped('fixture_rdc_cm.dwg', 21, 1)],
  ['5 octets inversés (DWG 2018)', () => flipped('fixture_rdc_cm.dwg', 25, 5)],
  ['20 octets inversés (DWG 2018)', () => flipped('fixture_rdc_cm.dwg', 40, 20)],
  ['DWG 2018 tronqué à 50 %', () => truncated('fixture_rdc_cm.dwg', 0.5)],
  // DWG 2000 (AC1015) : lecture des poignées au-delà de la fin des données (« while (true) »).
  ['DWG 2000 tronqué à 30 %', () => truncated('fixture_etage_mm.dwg', 0.3)],
  ['DWG 2000 tronqué à 90 %', () => truncated('fixture_etage_mm.dwg', 0.9)],
];

describe('DWG abîmés : échec rapide et clair, jamais de boucle sans fin', () => {
  for (const [label, make] of cases) {
    it(label, async () => {
      const t0 = Date.now();
      await expect(readCad(make(), 'plan.dwg', 'dwg')).rejects.toThrow(UNREADABLE_FR);
      expect(Date.now() - t0).toBeLessThan(5000);
    }, 30_000);
  }

  it('200 octets inversés dans un DWG 2000 : échec clair (« aucun dessin ») ou lecture, jamais de gel', async () => {
    const t0 = Date.now();
    await readCad(flipped('fixture_etage_mm.dwg', 12, 200), 'plan.dwg', 'dwg').catch((err: Error) => {
      expect(err.message).toMatch(/illisible|aucun dessin/);
    });
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 30_000);

  it('message en allemand quand la lecture est demandée en allemand', async () => {
    await expect(readCad(flipped('fixture_rdc_cm.dwg', 11, 200), 'plan.dwg', 'dwg', { lang: 'de' })).rejects.toThrow(/Diese DWG-Datei ist nicht lesbar oder beschädigt/);
  }, 30_000);

  it('après un fichier abîmé, le fichier intact se lit normalement', async () => {
    await expect(readCad(flipped('fixture_rdc_cm.dwg', 11, 200), 'plan.dwg', 'dwg')).rejects.toThrow(/illisible/);
    const doc = await readCad(fixtureBytes('fixture_rdc_cm.dwg'), 'fixture_rdc_cm.dwg', 'dwg');
    expect(doc.sheets[0]!.detected.rooms.map((r) => r.name).sort()).toEqual(['Buanderie', 'Cuisine', 'Garage', 'Hall', 'Séjour', 'WC']);
  }, 30_000);
});

describe('DWG abîmé mais lisible : le dessin incomplet est signalé, pas présenté comme sain', () => {
  it('un objet dont le décodage déborde → avertissement « fichier abîmé, objets manquants »', async () => {
    const doc = await readCad(bitFlipped('fixture_etage_mm.dwg', 26122, 8), 'plan.dwg', 'dwg');
    expect(doc.warnings.join('\n')).toMatch(/Ce fichier DWG semble abîmé : 1 objet\(s\) n’ont pas pu être lus/);
    const de = await readCad(bitFlipped('fixture_etage_mm.dwg', 26122, 8), 'plan.dwg', 'dwg', { lang: 'de' });
    expect(de.warnings.join('\n')).toMatch(/Diese DWG-Datei scheint beschädigt: 1 Objekt\(e\)/);
  }, 30_000);

  it('coordonnées aberrantes lues dans des octets changés → objets écartés et signalés', async () => {
    const doc = await readCad(bitFlipped('fixture_etage_mm.dwg', 19905, 1), 'plan.dwg', 'dwg');
    expect(doc.warnings.join('\n')).toMatch(/2 objet\(s\) aux coordonnées aberrantes/);
  }, 30_000);

  it('le fichier intact ne donne aucun de ces avertissements', async () => {
    for (const name of ['fixture_etage_mm.dwg', 'fixture_rdc_cm.dwg']) {
      const doc = await readCad(fixtureBytes(name), name, 'dwg');
      expect(doc.warnings.join('\n')).not.toMatch(/abîmé|aberrantes/);
    }
  }, 30_000);

  it('des milliers de traits de murs aux coordonnées aberrantes n’enlisent pas l’analyse et n’abîment pas le plan', async () => {
    // Dans un DWG abîmé : 10⁸⁰, 10²⁷⁷… Tous tombaient dans la même case des index spatiaux (analyse quadratique).
    const far: string[] = [];
    for (let i = 0; i < 6000; i++) far.push(...dxfLine('MUR', 1e80 * (1 + i), 3e81, 1e80 * (2 + i), 3e81 + 1e79));
    const room = [...dxfRect('MUR', 0, 0, 460, 560), ...dxfRect('MUR', 30, 30, 430, 530), ...dxfText('TEXTE', 150, 280, 12, 'Séjour 20,00 m²')];
    // Mobilier dessiné (traits sains, plus nombreux) : l'origine du dessin reste sur le plan.
    for (let i = 0; i < 7000; i++) room.push(...dxfLine('MOBILIER', 100 + (i % 200), 100 + Math.floor(i / 200), 101 + (i % 200), 100 + Math.floor(i / 200)));
    const t0 = Date.now();
    const doc = await readCad(miniDxf(5, [...room, ...far]), 'plan.dxf', 'dxf');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(doc.warnings.join('\n')).toMatch(/6000 objet\(s\) aux coordonnées aberrantes/);
    expect(doc.sheets[0]!.detected.rooms[0]).toMatchObject({ name: 'Séjour', measuredArea: 20 });
  }, 30_000);
});
