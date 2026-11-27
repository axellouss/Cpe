/**
 * Lecteur IFC face aux fichiers abîmés : IFC tronqué (téléchargement interrompu), étendue aberrante, erreur
 * interne de l'analyse. Aucun ne doit donner un bâtiment plus petit présenté comme complet, ni un texte brut anglais.
 */
import { describe, expect, it } from 'vitest';
import type { IfcAPI } from 'web-ifc';
import { IfcReadError, analyseIfc, createIfcApi, readIfc } from '../../../src/readers/ifc';
import { stepShape } from '../../../src/readers/ifc/webifc';
import maisonText from '../../fixtures/ifc/maison-test.ifc?raw';
import pavillonText from '../../fixtures/ifc/pavillon-mm.ifc?raw';
import { toBuffer } from './helpers';

const bytes = (text: string): Uint8Array => new Uint8Array(toBuffer(text));

describe('forme STEP vue aux deux bouts du fichier', () => {
  it('reconnaît en-tête et fin, malgré BOM, CRLF, blancs et NUL finaux, casse indifférente', () => {
    expect(stepShape(bytes(maisonText))).toEqual({ header: true, trailer: true });
    expect(stepShape(bytes('﻿ISO-10303-21;\r\nDATA;\r\nENDSEC;\r\nEND-ISO-10303-21;\r\n\r\n  \t'))).toEqual({ header: true, trailer: true });
    expect(stepShape(new Uint8Array([...bytes('ISO-10303-21;\nend-iso-10303-21;'), 0, 0, 0x1a]))).toEqual({ header: true, trailer: true });
    // Un commentaire ajouté après la fin par le logiciel d'export ne fait pas un fichier tronqué.
    expect(stepShape(bytes(`${maisonText.trimEnd()}\n/* exporté par l'outil X */\n`))).toEqual({ header: true, trailer: true });
    expect(stepShape(bytes(`${maisonText.trimEnd()}\n/* un */\r\n/* deux */  `))).toEqual({ header: true, trailer: true });
    // … mais un commentaire au bout d'un fichier coupé ne le rend pas complet.
    expect(stepShape(bytes(`${maisonText.slice(0, Math.floor(maisonText.length / 2))}\n/* fin */`))).toEqual({ header: true, trailer: false });
  });

  it('un fichier coupé a l’en-tête sans la fin ; un fichier quelconque n’a ni l’un ni l’autre', () => {
    for (const share of [0.5, 0.8, 0.99, 0.9999]) {
      const cut = maisonText.slice(0, Math.floor(maisonText.length * share));
      expect(stepShape(bytes(cut))).toEqual({ header: true, trailer: false });
    }
    // Coupé au milieu du mot final.
    expect(stepShape(bytes(maisonText.trimEnd().slice(0, -3)))).toEqual({ header: true, trailer: false });
    expect(stepShape(bytes('ceci n’est pas un fichier IFC'))).toEqual({ header: false, trailer: false });
    expect(stepShape(new Uint8Array(0))).toEqual({ header: false, trailer: false });
  });
});

describe('IFC tronqué : refusé, jamais lu comme un bâtiment plus petit', () => {
  it('maison d’essai coupée à 50, 80, 90 et 99 % : « fichier IFC incomplet » en français', async () => {
    for (const share of [0.5, 0.8, 0.9, 0.99]) {
      const cut = maisonText.slice(0, Math.floor(maisonText.length * share));
      const read = readIfc(toBuffer(cut), 'maison-coupee.ifc');
      await expect(read).rejects.toThrow(IfcReadError);
      await expect(readIfc(toBuffer(cut), 'maison-coupee.ifc')).rejects.toThrow(/Fichier IFC incomplet/);
    }
  });

  it('message en allemand sur demande', async () => {
    const cut = pavillonText.slice(0, Math.floor(pavillonText.length * 0.8));
    await expect(readIfc(toBuffer(cut), 'pavillon.ifc', { lang: 'de' })).rejects.toThrow(/IFC-Datei unvollständig/);
  });

  it('le fichier complet, même suivi de blancs, reste lu normalement', async () => {
    const doc = await readIfc(toBuffer(`${maisonText}\r\n\r\n   \n`), 'maison-test.ifc');
    expect(doc.sheets).toHaveLength(2);
  });

  it('un fichier qui n’est pas un IFC reste « illisible » (et non « incomplet »), en allemand aussi', async () => {
    await expect(readIfc(toBuffer('ceci n’est pas un fichier IFC'), 'faux.ifc')).rejects.toThrow(/Fichier IFC illisible/);
    await expect(readIfc(toBuffer('kein IFC'), 'falsch.ifc', { lang: 'de' })).rejects.toThrow(/IFC-Datei nicht lesbar/);
  });
});

describe('étendue aberrante et erreurs internes', () => {
  it('un mur déplacé à 50 km : refus clair, sans allouer de trame géante', async () => {
    const far = pavillonText.replace('#54=IFCCARTESIANPOINT((8635.,0.,0.));', '#54=IFCCARTESIANPOINT((50008635.,0.,0.));');
    expect(far).not.toBe(pavillonText);
    const started = Date.now();
    await expect(readIfc(toBuffer(far), 'pavillon-epars.ifc')).rejects.toThrow(/IFC illisible.*sur 45 km/); // bâtiment tourné de 25° : 50 km × cos 25°
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('RangeError de l’analyse (mémoire épuisée) : message localisé, jamais le texte brut du moteur', async () => {
    const api = await createIfcApi();
    try {
      // Même instance web-ifc, mais la triangulation échoue comme sur un fichier trop gros pour le poste.
      const failing = new Proxy(api, {
        get(target, prop, receiver) {
          if (prop === 'StreamMeshes') {
            return () => {
              throw new RangeError('Array buffer allocation failed');
            };
          }
          const v: unknown = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as IfcAPI;
      const fr = analyseIfc(failing, bytes(maisonText), 'maison-test.ifc');
      await expect(fr).rejects.toThrow(IfcReadError);
      await expect(analyseIfc(failing, bytes(maisonText), 'maison-test.ifc')).rejects.toThrow(/^Fichier IFC illisible : le modèle n’a pas pu être analysé/);
      await expect(analyseIfc(failing, bytes(maisonText), 'maison-test.ifc', { lang: 'de' })).rejects.toThrow(/^IFC-Datei nicht lesbar/);
      await expect(analyseIfc(failing, bytes(maisonText), 'maison-test.ifc')).rejects.not.toThrow(/Array buffer/);
    } finally {
      api.Dispose();
    }
  });
});

describe('analyse découpée en étapes', () => {
  it('rend la main à la boucle d’événements pendant l’analyse, avec le même résultat', async () => {
    const api = await createIfcApi();
    try {
      let ticks = 0;
      let running = true;
      const tick = (): void => {
        if (!running) return;
        ticks++;
        setTimeout(tick, 0);
      };
      setTimeout(tick, 0);
      const doc = await analyseIfc(api, bytes(maisonText), 'maison-test.ifc');
      running = false;
      // Avant : analyse d'un seul bloc, aucun minuteur ne passait pendant la lecture.
      expect(ticks).toBeGreaterThanOrEqual(3);
      expect(doc.sheets).toHaveLength(2);
      const again = await readIfc(toBuffer(maisonText), 'maison-test.ifc');
      expect(JSON.stringify({ ...again, sheets: again.sheets.map((s) => ({ ...s, segments: [...(s.segments ?? [])] })) })).toBe(
        JSON.stringify({ ...doc, sheets: doc.sheets.map((s) => ({ ...s, segments: [...(s.segments ?? [])] })) }),
      );
    } finally {
      api.Dispose();
    }
  });
});
