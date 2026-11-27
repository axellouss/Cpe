/**
 * Fichier d'un format fermé (Archicad .pln, Revit .rvt, SketchUp .skp…) : personne ne peut le lire hors du logiciel
 * qui l'a écrit. On l'explique simplement, on donne la recette d'export (IFC avec trois options du traducteur,
 * ou DWG / DXF / PDF) et un e-mail prêt à envoyer à l'architecte, en français ou en allemand.
 */
import { useState } from 'react';
import type { Lang } from '../../../core/types';
import { t } from '../../../i18n';
import type { ClosedFormat } from '../../../readers';
import { useShell, useShellStore } from '../store';
import type { ClosedFile } from '../types';
import { CopyButton, useT } from './common';
import { Dialog } from './Dialog';
import { Icon } from './icons';

/** Logiciel d'origine nommé dans les textes, selon le format. */
const SOFTWARE: Record<ClosedFormat, string> = { pln: 'Archicad', rvt: 'Revit', skp: 'SketchUp', other: '' };

/** E-mail à l'architecte : objet et corps, dans la langue demandée. */
export function architectMail(file: ClosedFile, lang: Lang): { subject: string; body: string } {
  const software = SOFTWARE[file.format] || t(lang, 'shell.closed.software.other');
  const recipe = t(lang, `shell.closed.mail.recipe.${file.format}`);
  return {
    subject: t(lang, 'shell.closed.mail.subject'),
    body: t(lang, 'shell.closed.mail.body', { file: file.fileName, software, recipe }),
  };
}

export function ClosedFormatDialog() {
  const tr = useT();
  const store = useShellStore();
  const files = useShell((s) => s.closedFiles);
  // D'autres fichiers du même dépôt ont-ils été lus ? Sinon la phrase qui le dit serait fausse.
  const othersRead = useShell((s) => s.reading.some((r) => r.status === 'done'));
  const lang = useShell((s) => s.lang);
  const [mailLang, setMailLang] = useState<Lang>(lang);
  const file = files[0];
  if (!file) return null;

  const mail = architectMail(file, mailLang);
  const mailto = `mailto:?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}`;
  const names = files.map((f) => f.fileName).join(', ');
  const steps = [1, 2, 3].map((n) => tr(`shell.closed.${file.format}.step${n}`));

  return (
    <Dialog
      title={tr(`shell.closed.${file.format}.title`)}
      subtitle={names}
      onClose={() => store.getState().dismissClosedFiles()}
      testId="closed-dialog"
      footer={
        <button type="button" className="btn btn--primary" onClick={() => store.getState().dismissClosedFiles()} data-autofocus>
          {tr('shell.closed.ok')}
        </button>
      }
    >
      <p>{tr(`shell.closed.${file.format}.why`)}</p>

      <h3 className="dialog__h3">{tr('shell.closed.recipe.title', { software: SOFTWARE[file.format] || tr('shell.closed.software.other') })}</h3>
      <ol className="recipe">
        {steps.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ol>
      {file.format === 'pln' || file.format === 'rvt' ? (
        <ul className="recipe__options" aria-label={tr('shell.closed.options.label')}>
          <li>
            <code>IFC Base Quantities</code> — {tr('shell.closed.option.quantities')}
          </li>
          <li>
            <code>IFC Space boundaries</code> — {tr('shell.closed.option.boundaries')}
          </li>
          <li>
            <code>Building Material properties</code> — {tr('shell.closed.option.materials')}
          </li>
        </ul>
      ) : null}

      <h3 className="dialog__h3">{tr('shell.closed.mail.title')}</h3>
      <p className="muted">{tr('shell.closed.mail.intro')}</p>
      <div className="mail">
        <div className="mail__bar">
          <div className="lang" role="group" aria-label={tr('shell.closed.mail.lang')}>
            {(['fr', 'de'] as const).map((l) => (
              <button key={l} type="button" className={`lang__btn ${mailLang === l ? 'is-active' : ''}`} aria-pressed={mailLang === l} onClick={() => setMailLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <CopyButton text={`${mail.subject}\n\n${mail.body}`} label={tr('shell.closed.mail.copy')} variant="solid" testId="copy-mail" />
          <a className="btn btn--ghost" href={mailto}>
            <Icon name="mail" size={16} />
            <span>{tr('shell.closed.mail.open')}</span>
          </a>
        </div>
        <p className="mail__subject" lang={mailLang}>
          <span className="muted">{tr('shell.closed.mail.subjectLabel')}</span> {mail.subject}
        </p>
        <textarea className="mail__body" readOnly rows={12} value={mail.body} lang={mailLang} aria-label={tr('shell.closed.mail.title')} data-testid="mail-body" />
      </div>
      {othersRead ? (
        <p className="muted" data-testid="closed-others-read">
          {tr('shell.closed.honest')}
        </p>
      ) : null}
    </Dialog>
  );
}
