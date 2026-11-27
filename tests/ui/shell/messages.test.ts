/**
 * Textes de l'application : français et allemand complets, toutes les clés utilisées par le code existent,
 * et rien n'y promet une classe énergétique ou une saisie automatique dans LuxEeB-Tool.
 */
import { describe, expect, it } from 'vitest';
import { FINDING_CODES } from '../../../src/engine';
import { t } from '../../../src/i18n';
import { SHELL_MESSAGES } from '../../../src/ui/shell/messages';
import { PERIODS } from '../../../src/ui/shell/questions';
import { EXPERT_TABS, PLAN_STEP_KEYS, STEPS } from '../../../src/ui/shell/types';

/** Tout le code de l'application (sauf le dictionnaire lui-même), lu comme du texte. */
const RAW = import.meta.glob(['../../../src/ui/shell/**/*.ts', '../../../src/ui/shell/**/*.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const SOURCES: [string, string][] = Object.entries(RAW)
  .filter(([path]) => !path.endsWith('/messages.ts'))
  .map(([path, text]) => [path.replace(/^.*\/src\/ui\/shell\//, ''), text]);

const fr = SHELL_MESSAGES.fr;
const de = SHELL_MESSAGES.de;
const frKeys = Object.keys(fr);

describe('dictionnaire de l’application', () => {
  it('a exactement les mêmes clés en français et en allemand, toutes préfixées « shell. »', () => {
    expect(Object.keys(de).sort()).toEqual([...frKeys].sort());
    for (const key of frKeys) expect(key.startsWith('shell.'), key).toBe(true);
  });

  it('n’a aucun texte vide et garde les mêmes variables dans les deux langues', () => {
    const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const key of frKeys) {
      expect(fr[key]!.trim().length, key).toBeGreaterThan(0);
      expect(de[key]!.trim().length, key).toBeGreaterThan(0);
      expect(vars(de[key]!), key).toEqual(vars(fr[key]!));
    }
  });

  it('est enregistré dans src/i18n', () => {
    expect(t('fr', 'shell.q.skip')).toBe('Je ne sais pas');
    expect(t('de', 'shell.q.skip')).toBe('Weiß ich nicht');
    expect(t('de', 'shell.plan.step.rooms.why')).toContain('1,00 m');
  });

  it('contient toutes les clés écrites en toutes lettres dans le code', () => {
    const missing: string[] = [];
    expect(SOURCES.length).toBeGreaterThan(20);
    for (const [path, text] of SOURCES) {
      for (const match of text.matchAll(/'(shell\.[A-Za-z0-9_.-]+)'/g)) {
        const key = match[1]!;
        // Un préfixe de famille (« shell.q.generator ») est valable s'il a des clés filles.
        if (!(key in fr) && !frKeys.some((k) => k.startsWith(`${key}.`))) missing.push(`${key}  (${path})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('contient toutes les clés composées à l’exécution', () => {
    const families: Record<string, readonly string[]> = {
      'shell.steps': STEPS,
      'shell.plan.step': PLAN_STEP_KEYS,
      'shell.undo.plan': PLAN_STEP_KEYS,
      'shell.undo.confirm': PLAN_STEP_KEYS,
      'shell.jump.plan': [...PLAN_STEP_KEYS, 'heights', 'netArea'],
      'shell.jump.expert': EXPERT_TABS,
      'shell.expert.tab': EXPERT_TABS,
      'shell.jump.question': ['top', 'bottom'],
      'shell.plan.state': ['todo', 'toConfirm', 'done', 'blocked'],
      'shell.prov': ['plan', 'calc', 'default', 'estimate', 'user', 'none'],
      'shell.prov.long': ['plan', 'calc', 'default', 'estimate', 'user', 'none'],
      'shell.top': ['flat-roof', 'pitched-roof', 'attic-ceiling'],
      'shell.bottom': ['slab-on-ground', 'above-unheated', 'above-outside'],
      'shell.roofShape': ['gable', 'hip', 'mono'],
      'shell.boundary': ['outside', 'ground', 'unheated', 'heated'],
      'shell.category': ['wall', 'roof', 'ceiling', 'floor', 'door'],
      'shell.orientation': ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'H'],
      'shell.kind': ['ifc', 'dwg', 'dxf', 'pdf', 'image', 'manual'],
      'shell.total': ['an', 've', 'envelope', 'windows', 'aOverVe'],
      'shell.save': ['idle', 'saved', 'failed', 'off'],
      'shell.home.reading': ['reading', 'done', 'error', 'unsupported'],
      'shell.findings.count': ['block', 'warn', 'info'],
      'shell.findings.group': ['block', 'warn', 'info'],
      'shell.read.scale.badge': ['confirmed', 'toCheck', 'unknown'],
      'shell.read.scale.next': ['toCheck', 'unknown'],
      'shell.plan.height': ['gross', 'clear'],
      'shell.plan.metrics.net': ['override', 'rooms', 'estimate'],
      'shell.result.table': ['constructions', 'windowTypes', 'envelope', 'zones', 'volumes'],
      'shell.q.status': ['open', 'partial', 'answered', 'skipped'],
      'shell.q.identity': ['name', 'street', 'postcode', 'locality'],
      'shell.q.insulation': ['walls', 'roof', 'floor'],
      'shell.q.occasion': ['existing', 'new'],
      'shell.q.buildingType': ['EFH', 'MFH'],
      'shell.q.windowGeneration': ['single', 'double-old', 'double-lowe', 'triple'],
      'shell.q.generator': ['gas-condensing', 'gas-low-temp', 'oil-condensing', 'oil-low-temp', 'old-boiler', 'heat-pump-air', 'heat-pump-ground', 'pellets', 'wood-logs', 'district-heating', 'electric-direct', 'other'],
      'shell.q.emission': ['radiators', 'floor-heating', 'mixed', 'air'],
      'shell.q.hotWaterKind': ['with-heating', 'separate-electric', 'separate-heat-pump', 'separate-other'],
      'shell.q.ventilationKind': ['windows', 'exhaust', 'balanced-hr'],
      'shell.closed.mail.recipe': ['pln', 'rvt', 'skp', 'other'],
    };
    const missing: string[] = [];
    for (const [prefix, values] of Object.entries(families)) for (const v of values) if (!(`${prefix}.${v}` in fr)) missing.push(`${prefix}.${v}`);
    for (const id of ['context', 'year', 'closure', 'insulation', 'windows', 'heating', 'hotWater', 'ventilation', 'solar', 'identity']) {
      for (const part of ['title', 'why', 'short']) if (!(`shell.q.${id}.${part}` in fr)) missing.push(`shell.q.${id}.${part}`);
    }
    for (const key of PLAN_STEP_KEYS) if (!(`shell.plan.step.${key}.why` in fr)) missing.push(`shell.plan.step.${key}.why`);
    for (const step of STEPS) if (!(`shell.steps.${step}.title` in fr)) missing.push(`shell.steps.${step}.title`);
    for (const kind of ['top', 'bottom']) for (const k of families[`shell.${kind}`]!) if (!(`shell.${kind}.${k}.sub` in fr)) missing.push(`shell.${kind}.${k}.sub`);
    for (const s of ['idle', 'saved', 'failed', 'off']) if (!(`shell.save.${s}.title` in fr)) missing.push(`shell.save.${s}.title`);
    for (const k of ['gross', 'clear']) if (!(`shell.plan.height.${k}.hint` in fr)) missing.push(`shell.plan.height.${k}.hint`);
    for (const k of ['override', 'rooms', 'estimate']) if (!(`shell.plan.metrics.net.${k}.title` in fr)) missing.push(`shell.plan.metrics.net.${k}.title`);
    for (const n of [1, 2, 3]) for (const part of ['title', 'text']) if (!(`shell.home.how.${n}.${part}` in fr)) missing.push(`shell.home.how.${n}.${part}`);
    for (const format of ['pln', 'rvt', 'skp', 'other']) {
      for (const part of ['title', 'why', 'step1', 'step2', 'step3']) if (!(`shell.closed.${format}.${part}` in fr)) missing.push(`shell.closed.${format}.${part}`);
    }
    expect(missing).toEqual([]);
    expect(PERIODS.length).toBeGreaterThan(5);
  });

  it('ne laisse aucune clé orpheline (définie mais jamais utilisée)', () => {
    const code = SOURCES.map(([, text]) => text).join('\n');
    const prefixes = [...code.matchAll(/[`'](shell\.[A-Za-z0-9_.-]*?)(?:\$\{|['`])/g)].map((m) => m[1]!);
    const orphans = frKeys.filter((key) => !prefixes.some((p) => key === p || (p.endsWith('.') ? key.startsWith(p) : key.startsWith(`${p}.`))));
    expect(orphans).toEqual([]);
  });

  it('ne promet ni classe énergétique ni saisie automatique', () => {
    for (const dict of [fr, de]) {
      for (const [key, text] of Object.entries(dict)) {
        const lower = text.toLowerCase();
        // La seule mention d'une classe est la phrase qui dit qu'on n'en calcule pas.
        if (/classe énergétique|energieklasse|effizienzklasse/.test(lower)) expect(key).toBe('shell.home.note');
        expect(lower, key).not.toMatch(/remplit automatiquement|saisie automatique|automatisch (übertragen|eingetragen|ausgefüllt)|import(e|iert) dans luxeeb/);
      }
    }
    expect(fr['shell.home.note']).toContain('ne calcule aucune classe énergétique');
    expect(de['shell.home.note']).toContain('berechnet keine Energieklasse');
    expect(fr['shell.result.lead']).toContain('Rien n’est transmis');
    expect(de['shell.result.lead']).toContain('Nichts wird an LuxEeB-Tool übertragen');
  });

  it('dit que les fichiers restent sur le poste, dans les deux langues', () => {
    expect(fr['shell.home.privacy.title']).toMatch(/ne quittent jamais/);
    expect(de['shell.home.privacy.title']).toMatch(/verlassen diesen Rechner nie/);
  });

  it('le moteur fournit un texte pour chaque contrôle affiché sur l’écran de résultat', () => {
    for (const code of FINDING_CODES) {
      expect(t('fr', `finding.${code}`), code).not.toBe(`finding.${code}`);
      expect(t('de', `finding.${code}`), code).not.toBe(`finding.${code}`);
    }
  });
});
