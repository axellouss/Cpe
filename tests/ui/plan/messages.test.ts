import { describe, expect, it } from 'vitest';
import { t } from '../../../src/i18n';
import { PLAN_MESSAGES } from '../../../src/ui/plan/messages';

/** Sources de l'éditeur (hors banc d'essai et hors dictionnaire), lues comme du texte par Vite. */
const SOURCES = import.meta.glob(
  ['../../../src/ui/plan/**/*.{ts,tsx}', '!../../../src/ui/plan/dev/**', '!../../../src/ui/plan/messages.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

describe('textes de l’éditeur de plan', () => {
  const fr = PLAN_MESSAGES.fr;
  const de = PLAN_MESSAGES.de;

  it('mêmes clés en français et en allemand, toutes préfixées « plan. »', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(fr).sort());
    for (const key of Object.keys(fr)) expect(key.startsWith('plan.')).toBe(true);
  });

  it('aucun texte vide, mêmes variables dans les deux langues', () => {
    for (const key of Object.keys(fr)) {
      expect(fr[key]!.trim().length, key).toBeGreaterThan(0);
      expect(de[key]!.trim().length, key).toBeGreaterThan(0);
      expect(placeholders(de[key]!), key).toEqual(placeholders(fr[key]!));
    }
  });

  it('enregistrés dans i18n à l’import', () => {
    expect(t('fr', 'plan.outline.close')).toBe('Fermer le contour');
    expect(t('de', 'plan.outline.close')).toBe('Umriss schließen');
    expect(t('de', 'plan.north.sentence', { sector: 'SW', azimuth: 225, name: 'Südwesten' })).toBe('Die Planoberkante zeigt nach SW · 225° (Südwesten)');
  });

  it('le rappel « face extérieure » et le conseil « plus longue cote » existent dans les deux langues', () => {
    expect(fr['plan.outline.outerFaceTrace']).toMatch(/FACE EXTÉRIEURE/);
    expect(de['plan.outline.outerFaceTrace']).toMatch(/AUSSENKANTE/);
    expect(fr['plan.scale.longest']).toMatch(/LONGUE/);
    expect(de['plan.scale.longest']).toMatch(/LÄNGSTE/);
    expect(fr['plan.opening.roughReminder']).toMatch(/Rohbaumaß/);
    expect(de['plan.opening.roughReminder']).toMatch(/Rohbaumaß/);
  });

  it('les orientations ne sont jamais abrégées par un « O » ambigu', () => {
    // Les secteurs affichés sont N/NE/E/SE/S/SW/W/NW (codes) ; seuls les noms complets sont traduits.
    expect(fr['plan.sector.W']).toBe('Ouest');
    expect(de['plan.sector.E']).toBe('Osten');
    for (const lang of [fr, de]) {
      for (const [key, text] of Object.entries(lang)) {
        expect(/\b(SO|NO|O)\b ?·? ?\{?azimuth/.test(text), key).toBe(false);
      }
    }
  });

  it('toute clé utilisée dans le code est définie, et toute clé définie est utilisée', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(15);
    const code = Object.values(SOURCES).join('\n');
    const used = new Set<string>();
    for (const m of code.matchAll(/'(plan\.[A-Za-z0-9_.]+)'/g)) used.add(m[1]!);
    // Clés construites : `plan.boundary.${b}`, `plan.sector.${s}`.
    const dynamic = [...new Set([...code.matchAll(/`(plan\.[A-Za-z0-9_.]+\.)\$\{/g)].map((m) => m[1]!))];
    expect(dynamic.sort()).toEqual(['plan.boundary.', 'plan.sector.']);
    for (const key of used) expect(fr[key], `clé utilisée mais absente : ${key}`).toBeDefined();
    for (const key of Object.keys(fr)) {
      const viaPrefix = dynamic.some((p) => key.startsWith(p));
      expect(used.has(key) || viaPrefix, `clé définie mais jamais utilisée : ${key}`).toBe(true);
    }
    for (const b of ['outside', 'heated', 'unheated', 'ground']) expect(fr[`plan.boundary.${b}`]).toBeDefined();
    for (const s of ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']) expect(fr[`plan.sector.${s}`]).toBeDefined();
  });
});
