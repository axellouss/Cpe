/**
 * Pièces SANS nom reconnu : une face fermée du plan dont le texte n'est pas dans le vocabulaire (« Kind 1 »,
 * « Kochen », « Ch. 2 ») ou qui ne porte aucun texte reste une pièce — elle ne doit pas disparaître en silence,
 * sinon la surface nette An est trop basse sans que rien ne le dise.
 *
 * Ce fichier ne décide de rien quant au chauffage : ces pièces sont toujours rendues « à classer » ('ask').
 */
import type { Vec2 } from '../../core/types';
import { fold, parseArea, parseClearHeight, parseOpeningSize } from '../../semantics/labels';
import { pointInPoly } from './planar';
import type { Poly } from './planar';

/** Même écriture d'une surface que dans semantics/labels.ts (« 17,54 m² », « 12 qm ») : sert à l'ôter d'un nom. */
const AREA_PART_RE = /(?<![\d.,])\d{1,4}(?:[.,]\d{1,3})?\s*(?:m\s?[²2]|m\^2|qm|㎡)(?![a-z0-9])/i;

/** Textes qui ne nomment pas une pièce : niveaux, hauteurs, repères, renvois, nord, mentions de cartouche. */
const NOT_A_NAME_RE =
  /^(?:hsp|h\.s\.p|rh|lrh|lh|ok|uk|okff|okrf|okfb|ukd|brh|bh|all|allege|niveau|niv|coupe|schnitt|section|facade|fassade|ansicht|detail|voir|siehe|nord|norden|north|echelle|massstab|ech|plan|grundriss|vide|leer|pente|gefalle|ep|d|h|l|b|t)\b|^[+\-±−]\s?\d/;

/** Totaux et surfaces d'ensemble : ce ne sont pas des pièces (« Total 131,56 m² », « Wohnfläche gesamt »). */
const TOTAL_RE =
  /\b(?:total|totale|totaux|gesamt|gesamtflache|summe|somme|wohnflache|nutzflache|nettoflache|bruttoflache|grundflache|geschossflache|surface habitable|surface utile|surface nette|surface brute|surface de reference|energiebezugsflache|shab|shon|shob|ngf|bgf|nrf|emprise|terrain|grundstuck|parcelle|parzelle)\b/;

/** Vrai si le texte annonce un total ou une surface d'ensemble, pas la surface d'une pièce. */
export function isTotalLabel(text: string): boolean {
  return TOTAL_RE.test(fold(text));
}

/**
 * Nom libre d'une pièce, tel qu'écrit dans sa face : le texte débarrassé de sa surface et de son numéro de
 * local. null si le texte ne peut pas être un nom (nombre, cote, niveau, hauteur, repère de menuiserie « F1 »,
 * renvoi, phrase). Aucun vocabulaire n'est exigé : c'est justement le texte que le vocabulaire ne connaît pas.
 */
export function freeRoomName(raw: string): string | null {
  let s = raw.replace(/\s+/g, ' ').trim();
  if (parseClearHeight(s) !== null) return null;
  s = s
    .replace(AREA_PART_RE, ' ')
    .replace(/\b(?:S|A|SH|Surf(?:ace)?|Fl(?:ä|a)che|NGF|WF)\s*[:=]\s*$/i, '')
    .replace(/[\s:=\-–—|/]+$/g, '')
    .replace(/^[\s:=\-–—|/]+/g, '')
    .trim();
  s = s.replace(/^\d{1,2}[.\-]\d{1,3}\s+/, '').trim();
  if (s.length < 2 || s.length > 40) return null;
  const f = fold(s);
  if ((f.match(/[a-z]/g) ?? []).length < 2) return null;
  if (f.split(/\s+/).length > 5) return null;
  // « F1 », « T 02 », « P3a » : repère de menuiserie ou d'axe, pas un nom.
  if (/^[a-z]\s?\d+[a-z]?$/.test(f)) return null;
  if (/\b1\s*[:/]\s*\d/.test(f) || parseOpeningSize(s) !== null) return null;
  if (NOT_A_NAME_RE.test(f) || isTotalLabel(s)) return null;
  return s;
}

/** Surface écrite dans un texte qui n'est pas un total ; null sinon. */
export function roomAreaOf(text: string): number | null {
  const area = parseArea(text);
  return area !== null && !isTotalLabel(text) ? area : null;
}

/**
 * Point intérieur d'une face situé à plus de `clear` de tous ses bords — le plus éloigné trouvé sur une grille.
 * null si la face n'en a pas : c'est un corps de mur (ruban entre les deux faces d'un mur), un tableau
 * d'ouverture ou un placard trop étroit, pas une pièce. Trouve à coup sûr toute pièce large d'au moins 2,7 × clear.
 */
export function roomyPoint(face: Poly, clear: number, maxSamples = 1600): Vec2 | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of face.outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX - 2 * clear;
  const h = maxY - minY - 2 * clear;
  if (!(w >= 0 && h >= 0 && clear > 0)) return null;
  let step = clear / 2;
  const samples = (w / step + 1) * (h / step + 1);
  if (samples > maxSamples) step *= Math.sqrt(samples / maxSamples);
  const nx = Math.floor(w / step) + 1;
  const ny = Math.floor(h / step) + 1;
  const x0 = minX + clear + (w - (nx - 1) * step) / 2;
  const y0 = minY + clear + (h - (ny - 1) * step) / 2;
  const rings = [face.outer, ...face.holes];
  let best: Vec2 | null = null;
  let bestD2 = clear * clear;
  for (let iy = 0; iy < ny; iy++) {
    const y = y0 + iy * step;
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ix * step;
      // Distance au bord, abandonnée dès qu'un côté est plus près que le meilleur point déjà trouvé.
      let d2 = Infinity;
      scan: for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[j]!;
          const b = ring[i]!;
          const ex = b.x - a.x;
          const ey = b.y - a.y;
          const l2 = ex * ex + ey * ey;
          let t = l2 < 1e-18 ? 0 : ((x - a.x) * ex + (y - a.y) * ey) / l2;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const qx = x - (a.x + ex * t);
          const qy = y - (a.y + ey * t);
          const q = qx * qx + qy * qy;
          if (q < d2) {
            d2 = q;
            if (d2 <= bestD2) break scan;
          }
        }
      }
      if (d2 > bestD2 && pointInPoly(x, y, face)) {
        bestD2 = d2;
        best = { x, y };
      }
    }
  }
  return best;
}
