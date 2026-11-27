/**
 * Résultat : tout ce qu'il faut reporter dans LuxEeB-Tool, dans l'ordre de sa saisie.
 *  - en haut, les contrôles de plausibilité, les bloquants d'abord, chacun avec un bouton qui mène à l'endroit à corriger ;
 *  - par valeur, « copier » (avec confirmation visible et annoncée) et l'étiquette de provenance ;
 *  - par tableau, « copier le bloc », la copie ligne par ligne ou cellule par cellule, et une coche « saisie » ;
 *    la grille ne montre que les colonnes de LuxEeB-Tool, dans son ordre : les aides de lecture et la remarque
 *    passent sous la ligne, et sur un écran étroit chaque ligne devient une carte (voir result.css) ;
 *  - téléchargements : CSV, projet, dossier imprimable.
 * Volontairement absents : toute classe énergétique (seul LuxEeB-Tool la calcule) et toute promesse de saisie
 * automatique (l'outil n'a pas de fonction d'import : l'expert copie, colle et relit).
 */
import { useMemo } from 'react';
import type { Finding, LuxeebSheets, Project, Severity } from '../../../core/types';
import { findingText } from '../../../engine';
import { buildReportHtml, exportFileName, EXPORT_MIME, guideDisclaimer, PASTE_EOL, projectFileErrorMessage, sheetsToCsv } from '../../../export';
import type { ExportFileKind, GuideItem, GuideRow, GuideSection, GuideTable } from '../../../export';
import { serializeWorkspace } from '../autosave';
import { isHosted, openPrintable, saveText } from '../browser';
import { derive, guide } from '../compute';
import { jumpLabelKey, jumpTargetFor } from '../jump';
import { selectMarks, selectProject, useShell, useShellStore } from '../store';
import { AnimatedNumber, Badge, CopyButton, ProvenanceTag, useT } from './common';
import type { BadgeTone } from './common';
import { Icon } from './icons';
import type { IconName } from './icons';
import { UnconfirmedSteps } from './UnconfirmedSteps';
import './result.css';

const SEVERITIES: readonly Severity[] = ['block', 'warn', 'info'];
const SEVERITY_TONE: Record<Severity, BadgeTone> = { block: 'bad', warn: 'warn', info: 'info' };
const SEVERITY_ICON: Record<Severity, IconName> = { block: 'block', warn: 'warning', info: 'info' };

/** Empreinte courte d'un texte (pour reconnaître une ligne déjà cochée ; une ligne qui change se décoche). */
export function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Clé d'une coche « saisie dans LuxEeB-Tool » : l'identifiant stable de la ligne et l'empreinte de ce qui s'y
 * saisit (nombres et termes de l'outil). Aucun texte traduit n'y entre : la coche survit au changement de langue,
 * et tombe dès qu'une valeur à saisir sur cette ligne change.
 */
export function rowKey(sectionKey: string, tableKey: string, row: Pick<GuideRow, 'id' | 'stamp'>): string {
  return `${sectionKey}/${tableKey}/${row.id}/${shortHash(row.stamp)}`;
}

/**
 * Texte copié pour une ligne : sa ligne du bloc à coller. Un tableau sans bloc (types de parois, de fenêtres) n'a
 * PAS de copie de ligne : ses colonnes ne sont pas celles de l'outil, et une ligne collée telle quelle décalerait
 * les valeurs dans de mauvaises cellules sans qu'aucune erreur ne s'affiche. Il reste la copie cellule par cellule.
 */
export function rowCopyText(table: GuideTable, index: number): string {
  if (!table.pasteBlock) return '';
  const lines = table.pasteBlock.split(PASTE_EOL);
  return lines.length === table.rows.length ? (lines[index] ?? '') : '';
}

/** « Terme allemand — traduction » → les deux moitiés (la seconde vide s'il n'y a pas de traduction). */
function splitTerm(label: string): [string, string] {
  const cut = label.indexOf(' — ');
  return cut < 0 ? [label, ''] : [label.slice(0, cut), label.slice(cut + 3)];
}

const NUMERIC = /^-?\d+(?:,\d+)?$/;

/** Répartition des colonnes d'un tableau entre la grille (colonnes de l'outil) et la seconde ligne (aides). */
export interface TableLayout {
  /** Indices des colonnes de LuxEeB-Tool, dans son ordre : ce sont les seules de la grille. */
  grid: number[];
  /** Indices des colonnes d'aide à la lecture, montrées sous la ligne. */
  aside: number[];
  /** Par colonne : toutes ses cellules remplies sont des nombres (en-tête et valeurs alignés à droite). */
  numeric: boolean[];
  /** Première colonne de texte de la grille — le nom de la ligne —, ou -1 : elle prend la largeur d'une carte. */
  lead: number;
  /** Par colonne : texte long de l'outil (Einbausituation…), qui prend deux places sur une carte. */
  wide: boolean[];
}

/** Au-delà, un texte ne tient plus dans une case de carte d'un tiers de téléphone (« Horizontal » y tient). */
const WIDE_TEXT = 12;

export function tableLayout(table: GuideTable): TableLayout {
  const helper = new Set(table.aside);
  const all = table.columns.map((_, c) => c);
  const filled = (c: number): string[] => table.rows.map((row) => row.cells[c] ?? '').filter((cell) => cell !== '');
  const numeric = all.map((c) => filled(c).length > 0 && filled(c).every((cell) => NUMERIC.test(cell)));
  const grid = all.filter((c) => !helper.has(c));
  const lead = grid.find((c) => filled(c).some((cell) => !NUMERIC.test(cell))) ?? -1;
  return {
    grid,
    aside: all.filter((c) => helper.has(c)),
    numeric,
    lead,
    wide: all.map((c) => c !== lead && !helper.has(c) && filled(c).some((cell) => cell.length > WIDE_TEXT)),
  };
}

// ───────────────────────────── Contrôles ─────────────────────────────

function FindingRow({ finding, project }: { finding: Finding; project: Project }) {
  const tr = useT();
  const store = useShellStore();
  const lang = useShell((s) => s.lang);
  const target = jumpTargetFor(finding, project);
  const key = `finding.${finding.code}`;
  let text = findingText(finding, lang);
  if (text === key) text = tr('shell.findings.unknown', { code: finding.code });
  return (
    <li className={`finding finding--${finding.severity}`} data-testid="finding" data-code={finding.code}>
      <span className="finding__icon" aria-hidden="true">
        <Icon name={SEVERITY_ICON[finding.severity]} size={18} />
      </span>
      <span className="finding__text">{text}</span>
      {target ? (
        <button type="button" className="btn btn--ghost btn--small finding__jump" onClick={() => store.getState().jumpTo(target)} data-testid="finding-jump">
          <span>{tr(jumpLabelKey(target))}</span>
          <Icon name="arrowRight" size={16} />
        </button>
      ) : null}
    </li>
  );
}

function FindingsPanel({ findings, project }: { findings: readonly Finding[]; project: Project }) {
  const tr = useT();
  const groups = SEVERITIES.map((severity) => ({ severity, items: findings.filter((f) => f.severity === severity) })).filter((g) => g.items.length > 0);
  if (groups.length === 0) {
    return (
      <section className="card findings findings--clear" aria-label={tr('shell.findings.title')}>
        <p className="findings__clear">
          <Icon name="check" />
          <span>{tr('shell.findings.none')}</span>
        </p>
      </section>
    );
  }
  return (
    <section className="card findings" aria-labelledby="findings-title" data-testid="findings">
      <header className="findings__head">
        <h2 id="findings-title" className="card__title">
          {tr('shell.findings.title')}
        </h2>
        <span className="findings__counts">
          {groups.map((g) => (
            <Badge key={g.severity} tone={SEVERITY_TONE[g.severity]}>
              {tr(`shell.findings.count.${g.severity}`, { count: g.items.length })}
            </Badge>
          ))}
        </span>
      </header>
      {groups.map((g) => {
        const list = (
          <ul className="findings__list">
            {g.items.map((f, i) => (
              <FindingRow key={`${f.code}-${i}`} finding={f} project={project} />
            ))}
          </ul>
        );
        // Les simples informations sont repliées : elles ne doivent pas noyer ce qui bloque.
        return g.severity === 'info' ? (
          <details className="findings__group findings__group--info" key={g.severity}>
            <summary>{tr('shell.findings.group.info', { count: g.items.length })}</summary>
            {list}
          </details>
        ) : (
          <div className={`findings__group findings__group--${g.severity}`} key={g.severity}>
            <h3 className="findings__group-title">{tr(`shell.findings.group.${g.severity}`)}</h3>
            {list}
          </div>
        );
      })}
    </section>
  );
}

// ───────────────────────────── Chiffres de contrôle ─────────────────────────────

function KeyFigures({ sheets }: { sheets: LuxeebSheets }) {
  const tr = useT();
  const T = sheets.totals;
  const figures: { key: string; value: number; unit: string; digits: number; from?: 'an' | 've' }[] = [
    { key: 'an', value: T.an, unit: 'm²', digits: 1, from: 'an' },
    { key: 've', value: T.ve, unit: 'm³', digits: 1, from: 've' },
    { key: 'envelope', value: T.envelopeArea, unit: 'm²', digits: 1 },
    { key: 'windows', value: T.windowArea, unit: 'm²', digits: 1 },
    { key: 'aOverVe', value: T.aOverVe, unit: '1/m', digits: 2 },
  ];
  return (
    <dl className="figures" aria-label={tr('shell.result.figures')}>
      {figures.map((f) => (
        <div className="figures__item" key={f.key}>
          <dt>{tr(`shell.total.${f.key}`)}</dt>
          <dd>
            <AnimatedNumber value={f.value} digits={f.digits} />
            <span className="metric__unit"> {f.unit}</span>
            {f.from ? <ProvenanceTag from={f.from === 'an' ? T.anFrom : T.veFrom} /> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ───────────────────────────── Valeurs isolées ─────────────────────────────

function ItemRow({ item }: { item: GuideItem }) {
  const tr = useT();
  const [term, translation] = splitTerm(item.label);
  return (
    <li className={`gitem ${item.from === null ? 'is-missing' : ''}`} data-testid="guide-item" data-key={item.key}>
      <div className="gitem__label">
        <span className="gitem__term">{term}</span>
        {translation ? <span className="gitem__translation">{translation}</span> : null}
      </div>
      <div className="gitem__value">
        <span className="gitem__text">{item.value}</span>
        <ProvenanceTag from={item.from} />
      </div>
      <div className="gitem__copy">
        {item.copy && item.copyIsMark ? (
          // Ce bouton ne copie pas la valeur affichée (la liste des lignes) mais la marque à y poser : il la nomme.
          <CopyButton
            text={item.copy}
            label={tr('shell.copy.mark', { value: item.copy })}
            ariaLabel={tr('shell.copy.mark.aria', { value: item.copy, name: term })}
            testId="copy-item"
          />
        ) : item.copy ? (
          <CopyButton text={item.copy} ariaLabel={tr('shell.copy.aria', { name: term })} testId="copy-item" />
        ) : item.from === 'user' || item.from === 'default' ? (
          // Réponse en clair pour une liste déroulante de l'outil : rien à coller, l'expert choisit l'entrée.
          <span className="gitem__nocopy">{tr('shell.result.nocopy')}</span>
        ) : null}
      </div>
      {item.note ? <p className="gitem__note">{item.note}</p> : null}
    </li>
  );
}

// ───────────────────────────── Tableaux ─────────────────────────────

function TableBlock({ section, table }: { section: GuideSection; table: GuideTable }) {
  const tr = useT();
  const store = useShellStore();
  const entered = useShell((s) => selectMarks(s).entered);
  const keys = table.rows.map((row) => rowKey(section.key, table.key, row));
  const done = keys.filter((k) => entered[k]).length;
  const layout = tableLayout(table);
  const terms = table.columns.map(splitTerm);
  // Sans bloc à coller, pas de copie de ligne (voir rowCopyText) : la colonne elle-même disparaît.
  const hasRowCopy = table.rows.some((_, i) => rowCopyText(table, i) !== '');
  const leadPosition = layout.grid.indexOf(layout.lead);
  const nameKey = `shell.result.table.${table.key}`;
  const name = tr(nameKey) === nameKey ? table.key : tr(nameKey);
  const titleId = `gtable-${section.key}-${table.key}`;

  return (
    <div className="gtable" data-testid="guide-table" data-key={table.key}>
      <div className="gtable__bar">
        <h3 className="gtable__name" id={titleId}>
          {name}
        </h3>
        <span className="gtable__count">
          {tr('shell.result.rows', { count: table.rows.length })}
          {table.rows.length > 0 ? ` · ${tr('shell.result.entered', { done, total: table.rows.length })}` : ''}
        </span>
        <span className="actions__spacer" />
        {table.pasteBlock ? <CopyButton text={table.pasteBlock} label={tr('shell.result.copyBlock')} variant="solid" testId="copy-block" /> : null}
      </div>
      {table.pasteHint ? <p className={`gtable__hint ${table.pasteBlock ? 'gtable__hint--try' : ''}`}>{table.pasteHint}</p> : null}

      {table.rows.length > 0 ? (
        <div className="gtable__frame">
          {/* Les rôles sont écrits en toutes lettres : la mise en cartes (result.css) change l'affichage des
              éléments du tableau, et il doit rester un tableau pour un lecteur d'écran. */}
          <table className="gtable__table" role="table" aria-labelledby={titleId}>
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader" className="gtable__check">
                  <span className="visually-hidden">{tr('shell.result.enteredColumn')}</span>
                  <Icon name="check" size={15} />
                </th>
                {layout.grid.map((c) => {
                  const [term, translation] = terms[c]!;
                  return (
                    <th
                      scope="col"
                      role="columnheader"
                      key={c}
                      className={`gtable__head ${c === layout.lead ? 'gtable__head--lead' : ''} ${layout.numeric[c] ? 'num' : ''} ${translation ? 'has-translation' : ''}`}
                    >
                      {/* Avec une traduction à côté, le terme est celui de l'outil : de l'allemand, à prononcer comme tel. */}
                      <span className="gtable__term" lang={translation ? 'de' : undefined}>
                        {term}
                      </span>
                      {translation ? <span className="gtable__translation">{translation}</span> : null}
                    </th>
                  );
                })}
                <th scope="col" role="columnheader" className="gtable__source">
                  {tr('shell.result.source')}
                </th>
                {hasRowCopy ? (
                  <th scope="col" role="columnheader" className="gtable__rowcopy">
                    <span className="visually-hidden">{tr('shell.result.copyRow')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            {table.rows.map((row, i) => {
              const key = keys[i]!;
              const isEntered = entered[key] === true;
              const lineCopy = rowCopyText(table, i);
              const previous = table.rows[i - 1];
              // Une même remarque sur des lignes à déduire qui se suivent n'est dite qu'une fois.
              const note = row.note && !(row.deduct && previous?.deduct && previous.note === row.note) ? row.note : '';
              const helpers = layout.aside.filter((c) => (row.cells[c] ?? '') !== '');
              return (
                <tbody
                  key={row.id}
                  role="rowgroup"
                  className={`gtable__row ${row.deduct ? 'is-deduct' : ''} ${isEntered ? 'is-entered' : ''}`}
                  data-testid="guide-row"
                  data-row={row.id}
                >
                  <tr role="row" className="gtable__main">
                    <td role="cell" className="gtable__check">
                      <label className="gtable__tick">
                        <input
                          type="checkbox"
                          checked={isEntered}
                          onChange={() => store.getState().toggleEntered(key)}
                          aria-label={tr('shell.result.enteredRow', { n: i + 1 })}
                          data-testid="row-entered"
                        />
                      </label>
                    </td>
                    {layout.grid.map((c, position) => {
                      const cell = row.cells[c] ?? '';
                      const [term, translation] = terms[c]!;
                      const place =
                        c === layout.lead
                          ? 'gtable__cell--lead'
                          : leadPosition > 0 && position < leadPosition
                            ? 'gtable__cell--index'
                            : layout.wide[c]
                              ? 'gtable__cell--wide'
                              : '';
                      return (
                        <td role="cell" key={c} className={`gtable__cell ${place} ${NUMERIC.test(cell) ? 'num' : ''}`} data-testid="row-cell">
                          {/* Nom de la colonne dans l'outil, visible sur chaque carte ; en grille, l'en-tête le donne déjà. */}
                          <span className="gtable__label" aria-hidden="true" lang={translation ? 'de' : undefined}>
                            {term}
                          </span>
                          {cell ? (
                            <CopyButton text={cell} variant="cell" ariaLabel={tr('shell.copy.cell', { value: cell, column: term })}>
                              {cell}
                            </CopyButton>
                          ) : (
                            <span className="gtable__none" aria-hidden="true">
                              –
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td role="cell" className="gtable__source">
                      <ProvenanceTag from={row.from} />
                    </td>
                    {hasRowCopy ? (
                      <td role="cell" className="gtable__rowcopy">
                        {lineCopy ? (
                          <CopyButton text={lineCopy} label={tr('shell.result.copyRow.short')} ariaLabel={tr('shell.result.copyRow.aria', { n: i + 1 })} testId="copy-row" />
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                  {helpers.length > 0 || note ? (
                    <tr role="row" className="gtable__aside" data-testid="row-aside">
                      <td role="cell" className="gtable__check" />
                      <td role="cell" colSpan={layout.grid.length + (hasRowCopy ? 2 : 1)}>
                        {helpers.length > 0 ? (
                          <dl className="gtable__more">
                            {helpers.map((c) => (
                              <div key={c}>
                                <dt>{table.columns[c]}</dt>
                                <dd>{row.cells[c]}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                        {note ? <p className="gtable__note">{note}</p> : null}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              );
            })}
          </table>
        </div>
      ) : null}
    </div>
  );
}

function SectionBlock({ section, index }: { section: GuideSection; index: number }) {
  const tr = useT();
  return (
    <section className="card gsection" id={`section-${section.key}`} aria-labelledby={`section-title-${section.key}`} data-testid="guide-section" data-key={section.key}>
      <header className="gsection__head">
        <span className="gsection__num" aria-hidden="true">
          {index + 1}
        </span>
        <div>
          <h2 id={`section-title-${section.key}`} className="gsection__title" tabIndex={-1}>
            {section.title}
          </h2>
          <p className="gsection__luxeeb">
            {tr('shell.result.inLuxeeb')} <span lang="de">{section.luxeebName}</span>
          </p>
        </div>
      </header>
      {section.help ? <p className="gsection__help">{section.help}</p> : null}
      {section.items.length > 0 ? (
        <ul className="gitems">
          {section.items.map((item) => (
            <ItemRow key={item.key} item={item} />
          ))}
        </ul>
      ) : null}
      {section.tables.map((table) => (
        <TableBlock key={table.key} section={section} table={table} />
      ))}
    </section>
  );
}

// ───────────────────────────── Téléchargements ─────────────────────────────

function Downloads({ sheets, project }: { sheets: LuxeebSheets; project: Project }) {
  const tr = useT();
  const store = useShellStore();
  const lang = useShell((s) => s.lang);
  const marks = useShell(selectMarks);
  const documents = useShell((s) => s.documents);
  const toast = store.getState().showToast;

  /**
   * Enregistre un fichier et dit ce qui s'est réellement passé. Dans une page hôte (essai publié), l'hôte demande
   * confirmation : un refus ne dit rien ; s'il ne sait pas enregistrer, le texte est copié plutôt que de prétendre
   * à un téléchargement qui n'a pas eu lieu.
   */
  const save = async (kind: ExportFileKind, build: () => string, copyFallback: boolean, savedKey: string, savedTone: 'ok' | 'info'): Promise<void> => {
    try {
      const outcome = await saveText(exportFileName(project, kind), EXPORT_MIME[kind], build(), copyFallback);
      if (outcome === 'saved') toast(tr(savedKey), savedTone);
      else if (outcome === 'copied') toast(tr('shell.result.download.copied'), 'info');
      else if (outcome === 'failed') toast(tr('shell.result.download.failed'), 'warn');
    } catch (error) {
      toast(projectFileErrorMessage(error, lang), 'warn');
    }
  };

  const csv = (): void => void save('csv', () => sheetsToCsv(sheets, project, lang), true, 'shell.result.download.done', 'ok');
  const json = (): void => void save('project', () => serializeWorkspace({ project, marks }), true, 'shell.result.download.done', 'ok');
  const report = (): void => {
    try {
      const html = buildReportHtml(sheets, project, lang, { date: new Date(), sources: documents.map((d) => d.doc.fileName) });
      // Dans une page hôte, aucune fenêtre ne s'ouvre : le dossier est enregistré, à ouvrir puis imprimer.
      const hosted = isHosted();
      if (!hosted && openPrintable(html)) return;
      // Ailleurs, on n'arrive ici que si le navigateur a bloqué la fenêtre : le dossier est alors téléchargé.
      void save('report', () => html, false, hosted ? 'shell.result.report.saved' : 'shell.result.report.blocked', 'info');
    } catch (error) {
      toast(projectFileErrorMessage(error, lang), 'warn');
    }
  };

  return (
    <div className="downloads" role="group" aria-label={tr('shell.result.downloads')}>
      <button type="button" className="btn btn--ghost" onClick={report} data-testid="download-report">
        <Icon name="print" size={18} />
        <span>{tr('shell.result.report')}</span>
      </button>
      <button type="button" className="btn btn--ghost" onClick={csv} data-testid="download-csv">
        <Icon name="download" size={18} />
        <span>{tr('shell.result.csv')}</span>
      </button>
      <button type="button" className="btn btn--ghost" onClick={json} data-testid="download-json">
        <Icon name="download" size={18} />
        <span>{tr('shell.result.json')}</span>
      </button>
    </div>
  );
}

// ───────────────────────────── Écran ─────────────────────────────

export function ResultScreen() {
  const tr = useT();
  const store = useShellStore();
  const project = useShell(selectProject);
  const lang = useShell((s) => s.lang);
  const entered = useShell((s) => selectMarks(s).entered);
  const derived = derive(project, lang);
  const sheets = derived.sheets;
  const built = useMemo(() => (sheets ? guide(sheets, project, lang) : null), [sheets, project, lang]);

  if (!sheets) {
    return (
      <section className="result">
        <h1>{tr('shell.result.title')}</h1>
        <div className="notice notice--warn" role="alert">
          <div className="notice__body">
            <strong>{tr('shell.error.engine.title')}</strong>
            <span>{tr('shell.error.text')}</span>
            {derived.error ? <code className="crash__detail">{derived.error}</code> : null}
          </div>
        </div>
      </section>
    );
  }

  const sections = built?.sections ?? null;
  const progress = (section: GuideSection): { done: number; total: number } => {
    let done = 0;
    let total = 0;
    for (const table of section.tables) {
      for (const row of table.rows) {
        total++;
        if (entered[rowKey(section.key, table.key, row)]) done++;
      }
    }
    return { done, total };
  };

  const scrollTo = (key: string): void => {
    document.getElementById(`section-${key}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    document.getElementById(`section-title-${key}`)?.focus({ preventScroll: true });
  };

  return (
    <section className="result" aria-labelledby="result-title">
      <header className="screen-head">
        <h1 id="result-title">{tr('shell.result.title')}</h1>
        <p className="lead">{tr('shell.result.lead')}</p>
        <Downloads sheets={sheets} project={project} />
      </header>

      <UnconfirmedSteps />
      <FindingsPanel findings={sheets.findings} project={project} />
      <KeyFigures sheets={sheets} />

      {sections ? (
        <div className="result__layout">
          <nav className="toc" aria-label={tr('shell.result.toc')}>
            <ol className="toc__list">
              {sections.map((section, i) => {
                const p = progress(section);
                return (
                  <li key={section.key}>
                    <button type="button" className="toc__link" onClick={() => scrollTo(section.key)} data-testid="toc-link">
                      <span className="toc__num" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span className="toc__text">
                        <span className="toc__title">{section.title}</span>
                        {p.total > 0 ? <span className={`toc__progress ${p.done === p.total ? 'is-done' : ''}`}>{tr('shell.result.entered', p)}</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="result__sections">
            {sections.map((section, i) => (
              <SectionBlock key={section.key} section={section} index={i} />
            ))}
          </div>
        </div>
      ) : (
        <div className="notice notice--warn" role="alert">
          <div className="notice__body">
            <strong>{tr('shell.error.guide.title')}</strong>
            <span>{tr('shell.error.text')}</span>
            {built?.error ? <code className="crash__detail">{built.error}</code> : null}
          </div>
        </div>
      )}

      <p className="disclaimer">{guideDisclaimer(lang)}</p>

      <footer className="actions">
        <button type="button" className="btn btn--ghost" onClick={() => store.getState().goTo('questions')}>
          <Icon name="arrowLeft" size={18} />
          <span>{tr('shell.result.backQuestions')}</span>
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => store.getState().goTo('plan')} disabled={project.model.storeys.length === 0}>
          <Icon name="arrowLeft" size={18} />
          <span>{tr('shell.result.backPlan')}</span>
        </button>
      </footer>
    </section>
  );
}
