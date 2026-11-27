/**
 * Reconnaissance du cartouche d'une page : son vocabulaire (« Projet », « Plan », « Date », « Échelle »…) et sa
 * place habituelle, dans un angle du cadre de la feuille. Un cartouche dessiné au trait de mur ressemble à une
 * vue fermée ; ses intitulés de case (« Plan ») ressemblent à des titres de vue. Ni l'un ni l'autre n'en est un.
 */
import type { BBox } from '../../core/types';
import { fold } from '../../semantics/labels';
import type { RawPage } from './raw';
import { isFrameSegment } from './walls';

/** Vocabulaire d'un cartouche, dans une phrase ou seul dans sa case. */
export const TITLE_BLOCK_RE =
  /\b(projet|maitre d'ouvrage|bauherr|bauvorhaben|architecte|architekt|planinhalt|echelle|massstab|plan n|plan-nr|indice|index|gezeichnet|dessine|phase|datum)\b/;
/** Intitulés de case d'un cartouche : le mot SEUL (« Plan », « Date », « Objet »), suivi au plus d'un deux-points. */
const TITLE_BLOCK_KEY_RE =
  /^(plan|date|objet|objekt|projekt|bauteil|format|blatt|blatt-nr\.?|feuille|dossier|affaire|adresse|lieu|commune|gemeinde|parcelle|parzelle|client|auftraggeber|bauort|planer|planverfasser|gepruft|verifie|controle|visa|freigabe|dessinateur|zeichner|n°|nr\.?)\s*[:.]?$/;
/**
 * Date écrite en chiffres (« 12.03.2024 », « 3/7/24 ») : il n'y en a guère que dans un cartouche.
 * Trois groupes séparés par le MÊME signe, sans autre chiffre ni séparateur autour : une étiquette de fenêtre
 * (« 1.20/1.35 », « 0.90/2.10 ») mêle point et barre et n'est pas une date — prise pour telle, elle faisait
 * passer un plan entier pour un cartouche.
 */
const DATE_RE = /(?<![\d.,/])\d{1,2}([./])\d{1,2}\1(?:\d{4}|\d{2})(?![\d.,/])/;

/** Vrai si le texte appartient au vocabulaire d'un cartouche (mot-clé, intitulé de case ou date). */
export function isTitleBlockText(text: string): boolean {
  const f = fold(text).replace(/[’`]/g, "'").trim();
  if (f.length === 0) return false;
  if (TITLE_BLOCK_RE.test(f) || DATE_RE.test(f)) return true;
  // « Échelle / Date », « Plan n° / Indice » : chaque moitié est un intitulé.
  return f.split('/').every((part) => TITLE_BLOCK_KEY_RE.test(part.trim()));
}

/** Rectangle du cadre de la feuille (longs traits proches des bords) ; null s'il n'est pas dessiné. */
export function frameBox(page: RawPage): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const s of page.segs) {
    if (!isFrameSegment(s, page.width, page.height)) continue;
    count++;
    minX = Math.min(minX, s.x0, s.x1);
    maxX = Math.max(maxX, s.x0, s.x1);
    minY = Math.min(minY, s.y0, s.y1);
    maxY = Math.max(maxY, s.y0, s.y1);
  }
  return count >= 2 ? { minX, minY, maxX, maxY } : null;
}

/**
 * Vrai si le rectangle tient dans un ANGLE du cadre : deux côtés adjacents sur le cadre (à `tol` près), sans en
 * occuper toute la largeur ni toute la hauteur. C'est la place d'un cartouche, pas celle d'une vue.
 */
export function inFrameCorner(b: BBox, frame: BBox | null, tol = 4): boolean {
  if (!frame) return false;
  const left = Math.abs(b.minX - frame.minX) <= tol;
  const right = Math.abs(b.maxX - frame.maxX) <= tol;
  const top = Math.abs(b.minY - frame.minY) <= tol;
  const bottom = Math.abs(b.maxY - frame.maxY) <= tol;
  return (left || right) && (top || bottom) && !(left && right) && !(top && bottom);
}
