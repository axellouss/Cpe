/**
 * Placement des étiquettes posées autour du contour (logique pure, en pixels écran) :
 *  - les longueurs de côtés, dessinées en pastilles qu'on peut toucher pour saisir la valeur exacte ;
 *  - les dimensions des ouvertures, qui ne doivent pas se recouvrir.
 * Les mêmes fonctions servent au dessin et au test de toucher : la cible est toujours ce qui est affiché.
 * Les largeurs de texte sont ESTIMÉES (pas de mesure dans le DOM), légèrement par excès.
 */
import { edgeOutwardNormal } from '../../core/geometry';
import type { Vec2 } from '../../core/types';
import { formatDecimal } from './numbers';
import type { View } from './view';
import { sheetToScreen } from './view';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Largeur estimée (px) d'un texte en police système demi-grasse, chiffres à chasse fixe. */
export function textWidth(text: string, fontPx: number): number {
  let em = 0;
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') em += 0.6;
    else if (ch === ' ' || ch === ',' || ch === '.' || ch === ':' || ch === ';' || ch === "'" || ch === '’') em += 0.28;
    else if (ch === '°') em += 0.42;
    else if (ch === '?') em += 0.5;
    else if (ch === '×' || ch === '≈' || ch === '·') em += 0.6;
    else if (ch >= 'A' && ch <= 'Z') em += 0.7;
    else em += 0.58;
  }
  return em * fontPx;
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

/** Distance (px) d'un point à un rectangle ; 0 à l'intérieur. */
export function distanceToRect(p: Vec2, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/** Vrai si la normale est plutôt horizontale : l'arête est « raide » (mur de gauche ou de droite). */
export function isSteep(normal: Vec2): boolean {
  return Math.abs(normal.x) > 0.5;
}

// ───────────────────────────── Longueurs des côtés ─────────────────────────────

/**
 * Pastille d'une longueur : hauteur, marge intérieure, écart au trait (px) et corps du texte.
 * L'écart laisse libre la poignée « + » du milieu du côté (rayon 6,5 px).
 */
export const LENGTH_PILL = { height: 17, padX: 6, gap: 8, font: 11.5 };

export interface LengthLabel {
  /** Indice du côté (points[edge] → point suivant). */
  edge: number;
  text: string;
  /** Longueur du côté en mètres (avec l'échelle fournie). */
  metres: number;
  /** Centre de la pastille. */
  x: number;
  y: number;
  /** −90 quand le texte suit un côté raide (présentation téléphone), 0 sinon. */
  rotate: number;
  /** Emprise de la pastille à l'écran. */
  box: Rect;
}

export interface LengthLabelOptions {
  /** Échelle supposée : les valeurs sont précédées de « ≈ ». */
  approx?: boolean;
  /** Longueur minimale du côté à l'écran pour afficher sa pastille. */
  minPx?: number;
  /** Vrai = le texte suit les côtés raides (il ne déborde plus sur les côtés : utile sur un écran étroit). */
  along?: boolean;
  /** Faux = tracé ouvert : pas de côté de fermeture, pastilles du côté « haut / gauche » du trait. */
  closed?: boolean;
}

/**
 * Pastilles des longueurs, posées à l'extérieur du contour, tangentes au trait à `LENGTH_PILL.gap` px.
 * Les côtés trop courts à l'écran n'en ont pas (il suffit de zoomer).
 */
export function lengthLabels(outline: readonly Vec2[], view: View, metresPerUnit: number, options: LengthLabelOptions = {}): LengthLabel[] {
  const closed = options.closed ?? true;
  const n = outline.length;
  if (closed ? n < 3 : n < 2) return [];
  const count = closed ? n : n - 1;
  const minPx = options.minPx ?? 44;
  const out: LengthLabel[] = [];
  for (let i = 0; i < count; i++) {
    const a = sheetToScreen(view, outline[i]!);
    const b = sheetToScreen(view, outline[(i + 1) % n]!);
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    if (px < minPx) continue;
    let normal: Vec2;
    if (closed) normal = edgeOutwardNormal(outline, i);
    else {
      normal = { x: (b.y - a.y) / px, y: -(b.x - a.x) / px };
      if (normal.y > 0.01 || (Math.abs(normal.y) <= 0.01 && normal.x > 0)) normal = { x: -normal.x, y: -normal.y };
    }
    const metres = (px / view.scale) * metresPerUnit;
    const text = (options.approx ? '≈ ' : '') + formatDecimal(metres, 2);
    const long = textWidth(text, LENGTH_PILL.font) + 2 * LENGTH_PILL.padX;
    const turned = Boolean(options.along) && isSteep(normal);
    const width = turned ? LENGTH_PILL.height : long;
    const height = turned ? long : LENGTH_PILL.height;
    // Demi-emprise de la pastille dans la direction de la normale : elle reste tangente au trait à tout angle.
    const reach = (Math.abs(normal.x) * width) / 2 + (Math.abs(normal.y) * height) / 2;
    const x = (a.x + b.x) / 2 + normal.x * (LENGTH_PILL.gap + reach);
    const y = (a.y + b.y) / 2 + normal.y * (LENGTH_PILL.gap + reach);
    out.push({ edge: i, text, metres, x, y, rotate: turned ? -90 : 0, box: { x: x - width / 2, y: y - height / 2, width, height } });
  }
  return out;
}

/** Pastille sous le point écran (ou à moins de `pad` px) : la plus proche, avec sa distance. */
export function hitLengthLabel(labels: readonly LengthLabel[], screen: Vec2, pad: number): { edge: number; distance: number } | null {
  let best: { edge: number; distance: number } | null = null;
  for (const l of labels) {
    const d = distanceToRect(screen, l.box);
    if (d <= pad && (!best || d < best.distance)) best = { edge: l.edge, distance: d };
  }
  return best;
}

// ───────────────────────────── Dimensions des ouvertures ─────────────────────────────

export const OPENING_LABEL = { font: 11.5, height: 14, gap: 12, row: 16 };

export interface OpeningLabelInput {
  id: string;
  text: string;
  /** Centre de la marque à l'écran. */
  centre: Vec2;
  /** Normale extérieure de la façade. */
  normal: Vec2;
  /** Étiquette à montrer coûte que coûte (ouverture sélectionnée, dimensions à confirmer). */
  priority: boolean;
}

export interface OpeningLabelPlacement {
  id: string;
  text: string;
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  /** Rotation du texte autour de (x, y), en degrés. */
  rotate: number;
  /** Trait de rappel entre la marque et une étiquette déplacée ; null si l'étiquette est à sa place. */
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
  box: Rect;
}

export interface OpeningLabelOptions {
  /** Vrai = le texte suit les façades raides (écran étroit) ; faux = texte horizontal ancré du côté du mur. */
  along: boolean;
  /** Nombre de positions essayées avant de renoncer à une étiquette non prioritaire. */
  maxTries: number;
}

interface Candidate {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  rotate: number;
  box: Rect;
}

function openingCandidate(item: OpeningLabelInput, width: number, along: boolean, k: number): Candidate {
  const { centre, normal } = item;
  const h = OPENING_LABEL.height;
  if (!isSteep(normal)) {
    // Façade du haut ou du bas : texte horizontal, rangées successives vers l'extérieur.
    const d = OPENING_LABEL.gap + 5 + k * OPENING_LABEL.row;
    const x = centre.x + normal.x * d;
    const y = centre.y + normal.y * d;
    return { x, y, anchor: 'middle', rotate: 0, box: { x: x - width / 2, y: y - h / 2, width, height: h } };
  }
  if (along) {
    // Façade raide, écran étroit : le texte suit le mur, rangées successives vers l'extérieur.
    const d = OPENING_LABEL.gap + 5 + k * OPENING_LABEL.row;
    const x = centre.x + normal.x * d;
    const y = centre.y + normal.y * d;
    return { x, y, anchor: 'middle', rotate: -90, box: { x: x - h / 2, y: y - width / 2, width: h, height: width } };
  }
  // Façade raide, texte horizontal : on décale le long du mur (0, +1, −1, +2, −2 rangées).
  const step = k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * OPENING_LABEL.row;
  const x = centre.x + normal.x * OPENING_LABEL.gap - normal.y * step;
  const y = centre.y + normal.y * OPENING_LABEL.gap + normal.x * step;
  const anchor = normal.x > 0 ? 'start' : 'end';
  return { x, y, anchor, rotate: 0, box: { x: normal.x > 0 ? x : x - width, y: y - h / 2, width, height: h } };
}

/**
 * Place les étiquettes des ouvertures sans recouvrement : chacune prend la première position libre (à sa place,
 * puis décalée avec un trait de rappel). Les prioritaires sont servies d'abord et toujours affichées ; une
 * étiquette ordinaire qui ne trouve pas de place est omise (elle réapparaît en zoomant, ou en touchant l'ouverture).
 */
export function layoutOpeningLabels(items: readonly OpeningLabelInput[], options: OpeningLabelOptions): OpeningLabelPlacement[] {
  const order = items.map((item, i) => ({ item, i })).sort((p, q) => Number(q.item.priority) - Number(p.item.priority) || p.i - q.i);
  const placed: { i: number; placement: OpeningLabelPlacement }[] = [];
  for (const { item, i } of order) {
    const width = textWidth(item.text, OPENING_LABEL.font) + 4;
    let chosen: Candidate | null = null;
    let tries = 0;
    for (let k = 0; k < Math.max(1, options.maxTries); k++) {
      const cand = openingCandidate(item, width, options.along, k);
      if (!placed.some((p) => rectsOverlap(p.placement.box, cand.box, 2))) {
        chosen = cand;
        tries = k;
        break;
      }
    }
    if (!chosen) {
      if (!item.priority) continue;
      chosen = openingCandidate(item, width, options.along, 0);
    }
    const from = { x: item.centre.x + item.normal.x * 5, y: item.centre.y + item.normal.y * 5 };
    const to = {
      x: Math.min(Math.max(from.x, chosen.box.x), chosen.box.x + chosen.box.width),
      y: Math.min(Math.max(from.y, chosen.box.y), chosen.box.y + chosen.box.height),
    };
    placed.push({
      i,
      placement: {
        id: item.id,
        text: item.text,
        x: chosen.x,
        y: chosen.y,
        anchor: chosen.anchor,
        rotate: chosen.rotate,
        leader: tries > 0 ? { x1: from.x, y1: from.y, x2: to.x, y2: to.y } : null,
        box: chosen.box,
      },
    });
  }
  return placed.sort((p, q) => p.i - q.i).map((p) => p.placement);
}
