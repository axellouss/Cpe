import { describe, expect, it } from 'vitest';
import { EXPORT_MESSAGES } from '../../src/export/messages';
import { knownKeys, t } from '../../src/i18n';

/** Sources du module, lues telles quelles pour y retrouver les clés utilisées. */
const SOURCES = import.meta.glob('../../src/export/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Familles de clés construites à l'exécution (`export.enum.${groupe}.${valeur}`…) : comptées comme utilisées. */
const DYNAMIC_PREFIXES = [
  'export.orient.',
  'export.prov.',
  'export.enum.',
  'export.note.ventilation.',
  'export.file.expected.',
  'export.file.found.',
];

const fr = EXPORT_MESSAGES.fr;
const de = EXPORT_MESSAGES.de;

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

describe('dictionnaire de l’export', () => {
  it('est enregistré dès l’import du module', () => {
    expect(knownKeys('fr')).toContain('export.guide.project.title');
    expect(knownKeys('de')).toContain('export.guide.project.title');
    expect(t('de', 'export.guide.remaining.title')).toBe('Noch von Hand im Tool einzugeben');
    expect(t('fr', 'export.value.slots', { count: 21, max: 20 })).toBe('21 types pour 20 emplacements');
  });

  it('a exactement les mêmes clés en français et en allemand', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(fr).sort());
    expect(Object.keys(fr).length).toBeGreaterThan(300);
    for (const key of Object.keys(fr)) expect(key.startsWith('export.'), key).toBe(true);
  });

  it('n’a aucun texte vide, sauf les traductions allemandes inutiles après un terme allemand', () => {
    for (const [key, text] of Object.entries(fr)) expect(text.trim(), key).not.toBe('');
    for (const [key, text] of Object.entries(de)) {
      if (!key.startsWith('export.tr.')) expect(text.trim(), key).not.toBe('');
    }
  });

  it('utilise les mêmes variables dans les deux langues', () => {
    for (const key of Object.keys(fr)) {
      expect(placeholders(de[key] ?? ''), key).toEqual(placeholders(fr[key]!));
    }
  });

  it('respecte la typographie de chaque langue pour les termes cités', () => {
    for (const [key, text] of Object.entries(fr)) {
      expect(text, key).not.toMatch(/[„“]/);
    }
    for (const [key, text] of Object.entries(de)) {
      expect(text, key).not.toMatch(/[«»]/);
      // pas d'espace avant deux-points ou point-virgule en allemand
      expect(text, key).not.toMatch(/\s[:;](\s|$)/);
    }
  });

  it('ne promet nulle part un transfert ou un remplissage automatique', () => {
    for (const text of [...Object.values(fr), ...Object.values(de)]) {
      expect(text.toLowerCase()).not.toMatch(/automati/);
    }
  });

  it('contient toutes les clés que le code utilise', () => {
    const used = new Set<string>();
    for (const [path, source] of Object.entries(SOURCES)) {
      if (path.endsWith('messages.ts')) continue;
      // une chaîne terminée par un point est un préfixe (clé construite à l'exécution), pas une clé
      for (const m of source.matchAll(/['"`](export\.[A-Za-z0-9_.-]*[A-Za-z0-9])['"`]/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(150);
    const missing = [...used].filter((key) => !(key in fr));
    expect(missing).toEqual([]);
  });

  it('ne garde aucune clé que le code n’utilise plus', () => {
    const code = Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith('messages.ts'))
      .map(([, source]) => source)
      .join('\n');
    const unused = Object.keys(fr).filter((key) => !DYNAMIC_PREFIXES.some((p) => key.startsWith(p)) && !code.includes(`'${key}'`));
    expect(unused).toEqual([]);
  });

  it('couvre toutes les valeurs des familles de clés construites à l’exécution', () => {
    const expected = [
      ...['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'H'].map((o) => `export.orient.${o}`),
      ...['plan', 'calc', 'default', 'estimate', 'user', 'none'].flatMap((p) => [`export.prov.${p}`, `export.prov.short.${p}`]),
      ...['EFH', 'MFH'].map((v) => `export.enum.buildingType.${v}`),
      ...['new', 'existing'].map((v) => `export.enum.occasion.${v}`),
      ...[
        'gas-condensing',
        'gas-low-temp',
        'oil-condensing',
        'oil-low-temp',
        'old-boiler',
        'heat-pump-air',
        'heat-pump-ground',
        'pellets',
        'wood-logs',
        'district-heating',
        'electric-direct',
        'other',
      ].map((v) => `export.enum.generator.${v}`),
      ...['radiators', 'floor-heating', 'mixed', 'air'].map((v) => `export.enum.emission.${v}`),
      ...['with-heating', 'separate-electric', 'separate-heat-pump', 'separate-other'].map((v) => `export.enum.hotWater.${v}`),
      ...['windows', 'exhaust', 'balanced-hr'].flatMap((v) => [`export.enum.ventilation.${v}`, `export.note.ventilation.${v}`]),
      'export.note.ventilation.missing',
      ...['single', 'double-old', 'double-lowe', 'triple'].map((v) => `export.enum.windowGeneration.${v}`),
      ...['flat-roof', 'pitched-roof', 'attic-ceiling'].map((v) => `export.enum.top.${v}`),
      ...['gable', 'hip', 'mono'].map((v) => `export.enum.roofShape.${v}`),
      ...['slab-on-ground', 'above-unheated', 'above-outside'].map((v) => `export.enum.bottom.${v}`),
      ...['outside', 'ground', 'unheated', 'heated'].map((v) => `export.enum.boundary.${v}`),
      ...['wall', 'roof', 'ceiling', 'floor', 'door'].map((v) => `export.enum.category.${v}`),
      ...['info', 'warn', 'block'].map((v) => `export.enum.severity.${v}`),
      ...['string', 'number', 'index', 'boolean', 'object', 'array'].map((v) => `export.file.expected.${v}`),
      ...['string', 'number', 'nonFinite', 'boolean', 'object', 'array', 'null', 'undefined', 'other'].map((v) => `export.file.found.${v}`),
    ];
    for (const key of expected) {
      expect(key in fr, key).toBe(true);
      expect(key in de, key).toBe(true);
    }
    const dynamic = Object.keys(fr).filter((key) => DYNAMIC_PREFIXES.some((p) => key.startsWith(p)));
    expect(dynamic.filter((key) => !expected.includes(key))).toEqual([]);
  });
});
