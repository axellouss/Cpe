/**
 * Éléments communs au CSV et au dossier imprimable : grandeurs principales avec leur provenance,
 * et texte des contrôles de plausibilité (clés « finding.<code> » enregistrées par le moteur).
 */
import type { Finding, Lang, LuxeebSheets, Project, Provenance, Severity } from '../core/types';
import { t } from '../i18n';
import { enumText } from './answers';
import { termLabel, weakestProvenance } from './format';
import { LUXEEB_OVERVIEW } from './luxeeb-terms';
import './messages';

// ───────────────────────────── Grandeurs principales ─────────────────────────────

export interface TotalFact {
  key: string;
  label: string;
  value: number;
  unit: string;
  from: Provenance;
}

/** Les totaux du moteur, chacun avec la provenance la plus faible des données dont il dépend. */
export function totalsFacts(sheets: LuxeebSheets, project: Project, lang: Lang): TotalFact[] {
  const T = sheets.totals;
  const V = LUXEEB_OVERVIEW;
  const lossRows = sheets.envelope.filter((r) => r.boundary !== 'heated');
  const envelopeFrom = weakestProvenance(lossRows.map((r) => r.from));
  const facadeFrom = weakestProvenance(
    lossRows.filter((r) => r.boundary === 'outside' && (r.kind === 'wall' || r.kind === 'window' || r.kind === 'door')).map((r) => r.from),
  );
  const windowFrom = weakestProvenance(lossRows.filter((r) => r.kind === 'window').map((r) => r.from));
  const vnFrom = weakestProvenance(sheets.zones.map((z) => z.from));
  // Surface brute de plancher : calculée à partir des contours ; elle ne vaut pas mieux que l'échelle des étages.
  const scaleFrom = weakestProvenance(['calc', ...project.model.storeys.map((s) => s.metresPerUnit.from)]);

  return [
    { key: 'an', label: termLabel(lang, `${V.an} An`, 'export.tr.an'), value: T.an, unit: 'm²', from: T.anFrom },
    { key: 'vn', label: termLabel(lang, `${V.vn} Vn`, 'export.tr.vn'), value: T.vn, unit: 'm³', from: vnFrom },
    { key: 've', label: termLabel(lang, `${V.ve} Ve`, 'export.tr.ve'), value: T.ve, unit: 'm³', from: T.veFrom },
    { key: 'envelopeArea', label: t(lang, 'export.label.envelopeArea'), value: T.envelopeArea, unit: 'm²', from: envelopeFrom },
    { key: 'aOverVe', label: termLabel(lang, 'A/Ve', 'export.tr.aOverVe'), value: T.aOverVe, unit: '1/m', from: weakestProvenance([envelopeFrom, T.veFrom]) },
    { key: 'grossFloorArea', label: t(lang, 'export.label.grossFloorArea'), value: T.grossFloorArea, unit: 'm²', from: scaleFrom },
    { key: 'windowArea', label: termLabel(lang, V.windowArea, 'export.tr.windowArea'), value: T.windowArea, unit: 'm²', from: windowFrom },
    { key: 'facadeArea', label: t(lang, 'export.label.facadeArea'), value: T.facadeArea, unit: 'm²', from: facadeFrom },
  ];
}

// ───────────────────────────── Contrôles de plausibilité ─────────────────────────────

export interface FindingLine {
  severity: Severity;
  severityLabel: string;
  code: string;
  text: string;
  /** Faux si la clé « finding.<code> » n'était pas enregistrée : `text` est alors un repli générique. */
  translated: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = { block: 0, warn: 1, info: 2 };

/** Nombres des variables au format local (virgule décimale, 2 décimales au plus). */
function localParams(params: Finding['params'] | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, v] of Object.entries(params ?? {})) {
    if (typeof v === 'number') {
      out[name] = !Number.isFinite(v) ? '–' : Number.isInteger(v) ? v : String(Number(v.toFixed(2))).replace('.', ',');
    } else {
      out[name] = String(v);
    }
  }
  return out;
}

/** Texte d'un contrôle dans la langue demandée ; repli lisible si le moteur n'a pas enregistré la clé. */
export function findingLine(finding: Finding, lang: Lang): FindingLine {
  const code = String(finding.code ?? '');
  const severity: Severity = Object.prototype.hasOwnProperty.call(SEVERITY_RANK, finding.severity) ? finding.severity : 'info';
  const severityLabel = enumText(lang, 'severity', severity) ?? severity;
  const params = localParams(finding.params);
  const key = `finding.${code}`;
  const text = t(lang, key, params);
  if (text !== key) return { severity, severityLabel, code, text, translated: true };

  const head = t(lang, 'export.report.finding.fallback', { code });
  const details = Object.entries(params)
    .map(([name, v]) => `${name} = ${v}`)
    .join(' ; ');
  return {
    severity,
    severityLabel,
    code,
    text: details ? `${head} (${t(lang, 'export.report.finding.details', { details })})` : head,
    translated: false,
  };
}

/** Tous les contrôles, les plus graves d'abord (ordre du moteur conservé à gravité égale). */
export function findingLines(findings: readonly Finding[], lang: Lang): FindingLine[] {
  return findings
    .map((f, index) => ({ line: findingLine(f, lang), index }))
    .sort((a, b) => SEVERITY_RANK[a.line.severity] - SEVERITY_RANK[b.line.severity] || a.index - b.index)
    .map((x) => x.line);
}
