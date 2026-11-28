/**
 * Bandeaux autour des écrans existants :
 *  - « Vous corrigez : … » au-dessus de l'éditeur de plan ouvert depuis une donnée ou une question, avec
 *    « Terminé, revenir » qui ramène à l'écran d'origine (les questions s'y recalculent) ;
 *  - pourquoi une planche part dans le parcours guidé plutôt que dans les cartes de doute.
 */
import { useShell, useShellStore } from '../store';
import { useT } from './common';
import { Icon } from './icons';

export function FixBanner() {
  const tr = useT();
  const store = useShellStore();
  const fix = useShell((s) => s.fixReturn);
  if (!fix) return null;
  return (
    <div className="fix-banner" role="region" aria-label={tr('shell.fix.label')} data-testid="fix-banner">
      <Icon name="edit" size={18} />
      <span className="fix-banner__text">
        <strong>{tr('shell.fix.what')}</strong> {tr(fix.what)}
      </span>
      <button type="button" className="btn btn--primary btn--small" onClick={() => store.getState().closeFix()} data-testid="fix-done">
        <Icon name="check" size={16} />
        <span>{tr('shell.fix.done')}</span>
      </button>
    </div>
  );
}

export function GuidedReason() {
  const tr = useT();
  const reasons = useShell((s) => s.guidedReason);
  const lang = useShell((s) => s.lang);
  if (!reasons) return null;
  // La raison du moteur dans la langue de l'utilisateur ; à défaut, la raison générique (jamais l'autre langue).
  const reason = reasons[lang] ?? tr('shell.auto.guided.generic');
  return (
    <div className="notice notice--info guided-reason" role="status" data-testid="guided-reason">
      <Icon name="info" />
      <div className="notice__body">
        <strong>{tr('shell.auto.guided.title')}</strong>
        <span>{reason}</span>
      </div>
    </div>
  );
}
