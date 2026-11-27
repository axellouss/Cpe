/**
 * Petits pictogrammes en coupe pour les questions sur la toiture et le plancher bas.
 * Convention de couleur (la même que sur le plan) : chaud = volume chauffé, froid = non chauffé.
 * Décoratifs : le texte du choix porte le sens.
 */
import type { ReactNode } from 'react';
import type { BottomKind, RoofShape, TopKind } from '../../../core/types';

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg className="picto" viewBox="0 0 96 72" width="96" height="72" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** Fermeture haute : toiture plate, combles chauffés sous rampants, grenier non chauffé. */
export function TopPicto({ kind }: { kind: TopKind }) {
  switch (kind) {
    case 'flat-roof':
      return (
        <Frame>
          <rect x="22" y="26" width="52" height="34" className="picto__heated" />
          <path d="M18 26h60" className="picto__strong" />
          <path d="M22 26v34h52V26" className="picto__line" />
          <path d="M10 60h76" className="picto__ground" />
        </Frame>
      );
    case 'pitched-roof':
      return (
        <Frame>
          <path d="M22 60V32L48 10l26 22v28z" className="picto__heated" />
          <path d="M16 37L48 10l32 27" className="picto__strong" />
          <path d="M22 32v28h52V32" className="picto__line" />
          <path d="M22 38h52" className="picto__dash" />
          <path d="M10 60h76" className="picto__ground" />
        </Frame>
      );
    case 'attic-ceiling':
      return (
        <Frame>
          <rect x="22" y="34" width="52" height="26" className="picto__heated" />
          <path d="M22 34L48 12l26 22z" className="picto__unheated" />
          <path d="M16 39L48 12l32 27" className="picto__line" />
          <path d="M22 34h52" className="picto__strong" />
          <path d="M22 34v26h52V34" className="picto__line" />
          <path d="M10 60h76" className="picto__ground" />
        </Frame>
      );
  }
}

/** Fermeture basse : terre-plein, cave non chauffée, air extérieur. */
export function BottomPicto({ kind }: { kind: BottomKind }) {
  switch (kind) {
    case 'slab-on-ground':
      return (
        <Frame>
          <rect x="22" y="14" width="52" height="34" className="picto__heated" />
          <path d="M22 48V14h52v34" className="picto__line" />
          <path d="M22 48h52" className="picto__strong" />
          <path d="M8 48h14M74 48h14" className="picto__ground" />
          <path d="M12 54l6-6M24 58l8-8M38 58l8-8M52 58l8-8M66 58l8-8M80 54l6-6" className="picto__hatch" />
        </Frame>
      );
    case 'above-unheated':
      return (
        <Frame>
          <rect x="22" y="8" width="52" height="28" className="picto__heated" />
          <rect x="22" y="36" width="52" height="24" className="picto__unheated" />
          <path d="M22 36V8h52v28" className="picto__line" />
          <path d="M22 36v24h52V36" className="picto__line" />
          <path d="M22 36h52" className="picto__strong" />
          <path d="M8 44h14M74 44h14" className="picto__ground" />
          <path d="M10 52l6-6M12 62l8-8M76 62l8-8M80 52l6-6" className="picto__hatch" />
        </Frame>
      );
    case 'above-outside':
      return (
        <Frame>
          <rect x="22" y="10" width="52" height="28" className="picto__heated" />
          <path d="M22 38V10h52v28" className="picto__line" />
          <path d="M22 38h52" className="picto__strong" />
          <path d="M28 38v20M68 38v20" className="picto__line" />
          <path d="M8 58h80" className="picto__ground" />
          <path d="M38 48h20M54 44l4 4-4 4" className="picto__air" />
        </Frame>
      );
  }
}

/** Forme de la toiture, vue de dessus. */
export function ShapePicto({ shape }: { shape: RoofShape }) {
  switch (shape) {
    case 'gable':
      return (
        <Frame>
          <rect x="16" y="16" width="64" height="40" className="picto__roof" />
          <path d="M16 36h64" className="picto__strong" />
          <path d="M48 24v6M48 42v6" className="picto__air" />
        </Frame>
      );
    case 'hip':
      return (
        <Frame>
          <rect x="16" y="16" width="64" height="40" className="picto__roof" />
          <path d="M36 36h24" className="picto__strong" />
          <path d="M16 16l20 20-20 20M80 16L60 36l20 20" className="picto__line" />
        </Frame>
      );
    case 'mono':
      return (
        <Frame>
          <rect x="16" y="16" width="64" height="40" className="picto__roof" />
          <path d="M16 16h64" className="picto__strong" />
          <path d="M48 24v22M42 40l6 6 6-6" className="picto__air" />
        </Frame>
      );
  }
}
