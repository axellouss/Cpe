/**
 * La planche en miniature (image de fond de la page, déjà rendue par le lecteur) avec ses vues reconnues encadrées et
 * nommées ; carrousel s'il y a plusieurs pages. « Voir sur la planche » allume la vue et l'endroit.
 * Et l'extrait d'une carte de doute : la même image, recadrée sur l'endroit ; un toucher l'agrandit.
 * Rien n'est rendu à nouveau ni enregistré : l'image vit tant que la planche est chargée.
 */
import { useEffect, useState } from 'react';
import type { BBox } from '../../../core/types';
import { snippetBox, viewLabel } from '../auto';
import type { Anchor, PageThumb } from '../auto';
import { useShell } from '../store';
import { useT } from './common';
import { Dialog } from './Dialog';
import { Icon } from './icons';

/** Rapport largeur / hauteur de l'extrait d'une carte. */
const SNIPPET_ASPECT = 2.5;

const vb = (b: BBox): string => `${b.minX} ${b.minY} ${b.maxX - b.minX} ${b.maxY - b.minY}`;

export function SheetThumb({ pages, locate }: { pages: readonly PageThumb[]; locate: Anchor | null }) {
  const tr = useT();
  const lang = useShell((s) => s.lang);
  const [index, setIndex] = useState(0);
  // « Voir sur la planche » sur une autre page : le carrousel y va.
  useEffect(() => {
    if (!locate) return;
    const at = pages.findIndex((p) => p.page === locate.page);
    if (at >= 0) setIndex(at);
  }, [locate, pages]);
  const page = pages[Math.min(index, pages.length - 1)];
  if (!page) return null;
  const w = page.frame.maxX - page.frame.minX;
  const font = Math.max(8, w / 70);
  const lit = locate && locate.page === page.page ? locate : null;

  return (
    <figure className="thumb" data-testid="sheet-thumb">
      <div className="thumb__frame">
        <svg
          className="thumb__svg"
          viewBox={vb(page.frame)}
          role="img"
          aria-label={tr('shell.ov.thumb.label', { page: page.page, count: page.views.length })}
          preserveAspectRatio="xMidYMid meet"
        >
          <rect x={page.frame.minX} y={page.frame.minY} width={w} height={page.frame.maxY - page.frame.minY} className="thumb__paper" />
          {page.image ? <image href={page.image.url} x={page.image.x} y={page.image.y} width={page.image.width} height={page.image.height} preserveAspectRatio="none" /> : null}
          {page.views.map((v) => {
            const on = lit?.viewId === v.id;
            return (
              <g key={v.id} className={`thumb__view ${on ? 'is-lit' : ''}`} data-testid="thumb-view" data-view={v.id} data-lit={on ? 'true' : undefined}>
                <rect x={v.box.minX} y={v.box.minY} width={v.box.maxX - v.box.minX} height={v.box.maxY - v.box.minY} className="thumb__box" vectorEffect="non-scaling-stroke" />
                <text x={v.box.minX + font * 0.4} y={v.box.minY + font * 1.2} className="thumb__name" fontSize={font}>
                  {viewLabel(v, lang)}
                </text>
              </g>
            );
          })}
          {lit ? (
            <rect
              x={lit.box.minX}
              y={lit.box.minY}
              width={lit.box.maxX - lit.box.minX}
              height={lit.box.maxY - lit.box.minY}
              className="thumb__spot"
              vectorEffect="non-scaling-stroke"
              data-testid="thumb-spot"
            />
          ) : null}
        </svg>
      </div>
      <figcaption className="thumb__caption">
        {pages.length > 1 ? (
          <span className="thumb__pager" role="group" aria-label={tr('shell.ov.thumb.pages')}>
            <button type="button" className="btn btn--icon btn--small" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} aria-label={tr('shell.ov.thumb.prev')} data-testid="thumb-prev">
              <Icon name="arrowLeft" size={16} />
            </button>
            <span data-testid="thumb-page">{tr('shell.ov.thumb.page', { page: index + 1, count: pages.length })}</span>
            <button type="button" className="btn btn--icon btn--small" onClick={() => setIndex((i) => Math.min(pages.length - 1, i + 1))} disabled={index >= pages.length - 1} aria-label={tr('shell.ov.thumb.next')} data-testid="thumb-next">
              <Icon name="arrowRight" size={16} />
            </button>
          </span>
        ) : null}
        <span className="thumb__hint">{lit ? tr('shell.ov.thumb.lit') : tr('shell.ov.thumb.hint')}</span>
      </figcaption>
      <ul className="thumb__views" aria-label={tr('shell.ov.thumb.views')}>
        {page.views.map((v) => (
          <li key={v.id} className={lit?.viewId === v.id ? 'is-lit' : ''}>
            <span className="thumb__dot" aria-hidden="true" />
            <span>{viewLabel(v, lang)}</span>
            {v.title ? <span className="thumb__title">{v.title}</span> : null}
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Extrait de la planche autour d'un endroit ; un toucher l'agrandit. Rien s'il n'y a pas d'image de la page. */
export function Snippet({ anchor, page, label }: { anchor: Anchor; page: PageThumb | undefined; label: string }) {
  const tr = useT();
  const [big, setBig] = useState(false);
  if (!page?.image) return null;
  // Même rapport que le cadre de l'extrait (auto.css : aspect-ratio 5 / 2).
  const box = snippetBox(anchor, page.frame, SNIPPET_ASPECT);
  const art = (
    <svg className="snippet__svg" viewBox={vb(box)} role="img" aria-label={tr('shell.doubt.snippet.label', { what: label })} preserveAspectRatio="xMidYMid meet">
      <image href={page.image.url} x={page.image.x} y={page.image.y} width={page.image.width} height={page.image.height} preserveAspectRatio="none" />
      <rect x={anchor.box.minX} y={anchor.box.minY} width={anchor.box.maxX - anchor.box.minX} height={anchor.box.maxY - anchor.box.minY} className="snippet__spot" vectorEffect="non-scaling-stroke" />
    </svg>
  );
  return (
    <>
      <button type="button" className="snippet" onClick={() => setBig(true)} data-testid="doubt-snippet" aria-label={tr('shell.doubt.snippet.open', { what: label })}>
        {art}
        <span className="snippet__hint">
          <Icon name="target" size={14} />
          {tr('shell.doubt.snippet.hint')}
        </span>
      </button>
      {big ? (
        <Dialog title={tr('shell.doubt.snippet.title')} subtitle={label} onClose={() => setBig(false)} testId="snippet-dialog">
          <div className="snippet snippet--big">{art}</div>
        </Dialog>
      ) : null}
    </>
  );
}
