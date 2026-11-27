/**
 * Lecture du TEXTE des plans (FR / DE / LU) : surfaces, échelles, noms de pièces, niveaux, dimensions d'ouvertures.
 * Fonctions pures, communes aux lecteurs DWG/DXF, PDF et IFC.
 *
 * Règle pour An (RGD 2021, annexe I, ch. 5.1.2) : seules comptent les pièces dont l'usage normal demande
 * du chauffage et qui sont dans l'enveloppe thermique. Le classement ci-dessous n'est qu'une PROPOSITION :
 * les pièces ambiguës (cave, buanderie, grenier, hobby…) sont rendues 'ask' et l'expert tranche.
 */
import type { DetectedRoom, PlanText } from '../core/types';

/** Supprime accents et casse pour comparer des libellés. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .trim();
}

function toNumber(raw: string): number {
  // « 1.234,56 » ou « 1 234,56 » → 1234.56 ; « 32,45 » → 32.45 ; « 32.45 » → 32.45
  let s = raw.replace(/[\s  ']/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else {
    s = s.replace(',', '.');
  }
  return Number(s);
}

// ───────────────────────────── Surfaces ─────────────────────────────

const AREA_RE = /(?<![\d.,])(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:m\s?[²2]|m\^2|qm|㎡)(?![a-z0-9])/i;

/** « 32,45 m² », « 28.10 m2 », « 12 qm » → surface en m² ; null si le texte n'en contient pas. */
export function parseArea(text: string): number | null {
  const m = AREA_RE.exec(text);
  if (!m) return null;
  const v = toNumber(m[1]!);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ───────────────────────────── Échelle ─────────────────────────────

const SCALE_RE = /(?:^|[^\d])1\s*[:/]\s*(\d{1,4})(?!\d)/;
const SCALE_WORD_RE = /(echelle|ech\.?|massstab|mst\.?|m\s*=?|scale)/;
const COMMON_SCALES = new Set([1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 2000, 2500, 5000]);

/**
 * « Échelle 1:100 », « Maßstab 1/50 », « M 1:200 » → dénominateur (100, 50, 200).
 * Un « 1:100 » nu n'est accepté que pour les échelles courantes. null sinon.
 * ATTENTION : l'échelle du cartouche n'est qu'un INDICE (un PDF « ajusté à la page » la rend fausse).
 */
export function parseScaleText(text: string): number | null {
  const m = SCALE_RE.exec(text);
  if (!m) return null;
  const denom = Number(m[1]);
  if (!Number.isFinite(denom) || denom < 1) return null;
  const hasWord = SCALE_WORD_RE.test(fold(text));
  if (!hasWord && !COMMON_SCALES.has(denom)) return null;
  return denom;
}

// ───────────────────────────── Pièces ─────────────────────────────

export type HeatedGuess = 'yes' | 'no' | 'ask';

interface RoomRule {
  re: RegExp;
  guess: HeatedGuess;
}

// L'ORDRE COMPTE : « Waschküche » doit être vue comme buanderie avant « Küche » ;
// « Chambre 1 (combles) » comme pièce de vie avant « combles ».
const ROOM_RULES: RoomRule[] = [
  { re: /non[- ]chauff|unbeheizt|nicht beheizt|kaltraum|non amenag|nicht ausgebaut/, guess: 'no' },
  { re: /garage|carport|car-port|parking|stellplatz|abri voiture/, guess: 'no' },
  { re: /chaufferie|heizraum|heizung|chaudiere|local tech|technique|technik|hausanschluss|haustechnik/, guess: 'no' },
  { re: /poubelle|mull|gaine|schacht|citerne|tank|pellet|combustible|brennstoff|ollager/, guess: 'no' },
  { re: /terrasse|balcon|balkon|loggia|veranda|wintergarten|jardin d'hiver|abri|remise|schuppen/, guess: 'no' },
  { re: /buanderie|waschkuche|wasch|laundry|hobby|loisir|fitness|atelier|werkstatt|bricolage/, guess: 'ask' },
  {
    re: /sejour|salon|living|wohn|stube|salle a manger|\bess|chambre|schlaf|zimmer|bureau|\bburo|cuisine|kuche|kitchen|sdb|salle de bain|salle d'eau|\bbad|douche|dusch|\bwc\b|toilet|dressing|ankleide|kinder|enfant|parents|eltern|gast|ami|mezzanine|studio|galerie/,
    guess: 'yes',
  },
  {
    re: /cave|keller|cellier|vorrat|abstell|debarras|rangement|lager|grenier|speicher|combles|dachboden|reserve|archiv/,
    guess: 'ask',
  },
  { re: /hall|entree|couloir|flur|diele|degagement|palier|escalier|treppe|cage|sas|windfang|vestiaire|garderobe/, guess: 'yes' },
];

/** Proposition « comptée dans An ? » d'après le nom de la pièce. */
export function classifyRoomName(name: string): HeatedGuess {
  const f = fold(name);
  if (!f) return 'ask';
  for (const rule of ROOM_RULES) if (rule.re.test(f)) return rule.guess;
  return 'ask';
}

const ROOM_WORD_RE = new RegExp(ROOM_RULES.map((r) => r.re.source).join('|'));

/** Vrai si le texte ressemble à un nom de pièce (et non à une cote, un titre de plan…). */
export function looksLikeRoomName(text: string): boolean {
  const f = fold(text);
  if (f.length < 2 || f.length > 40) return false;
  if (/^[\d\s.,x×/+\-±:='"]+$/.test(f)) return false;
  return ROOM_WORD_RE.test(f);
}

/** « Séjour 32,45 m² » → { name: 'Séjour', area: 32.45 } ; « Cuisine » → { name: 'Cuisine' } ; null si rien d'utile. */
export function parseRoomLabel(text: string): { name: string; area?: number } | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  const area = parseArea(flat);
  const m = AREA_RE.exec(flat);
  let name = (m ? flat.slice(0, m.index) + ' ' + flat.slice(m.index + m[0].length) : flat)
    .replace(/\b(?:S|A|SH|Surf(?:ace)?|Fl(?:ä|a)che|NGF|WF)\s*[:=]\s*$/i, '')
    .replace(/[\s:=\-–—|/]+$/g, '')
    .replace(/^[\s:=\-–—|/]+/g, '')
    .trim();
  // Numéro de local en tête : « 1.02 Séjour » → « Séjour »
  name = name.replace(/^\d{1,2}[.\-]\d{1,3}\s+/, '').trim();
  if (!name && area === null) return null;
  if (name && !looksLikeRoomName(name)) {
    if (area === null) return null;
    name = '';
  }
  return area === null ? { name } : { name, area };
}

/**
 * Associe noms de pièces et surfaces écrits dans des textes séparés mais voisins
 * (« Séjour » et, juste en dessous, « 32,45 m² »).
 * `maxGap` = distance maximale entre les deux textes, en unités de feuille (défaut : 3 hauteurs de texte, ou 5 % du plan).
 */
export function roomsFromTexts(texts: readonly PlanText[], maxGap?: number): DetectedRoom[] {
  interface Item {
    t: PlanText;
    name: string;
    area?: number;
    used: boolean;
  }
  const items: Item[] = [];
  for (const t of texts) {
    const parsed = parseRoomLabel(t.text);
    if (!parsed) continue;
    items.push(parsed.area === undefined ? { t, name: parsed.name, used: false } : { t, name: parsed.name, area: parsed.area, used: false });
  }
  if (items.length === 0) return [];

  let gap = maxGap;
  if (gap === undefined) {
    const heights = items.map((i) => i.t.height ?? 0).filter((h) => h > 0);
    if (heights.length > 0) {
      heights.sort((a, b) => a - b);
      gap = heights[Math.floor(heights.length / 2)]! * 3.5;
    } else {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const t of texts) {
        minX = Math.min(minX, t.x);
        maxX = Math.max(maxX, t.x);
        minY = Math.min(minY, t.y);
        maxY = Math.max(maxY, t.y);
      }
      gap = Math.max(maxX - minX, maxY - minY) * 0.05;
    }
  }

  const rooms: DetectedRoom[] = [];
  const named = items.filter((i) => i.name);
  const areaOnly = items.filter((i) => !i.name && i.area !== undefined);

  for (const n of named) {
    let area = n.area;
    if (area === undefined) {
      let best: Item | null = null;
      let bestD = Infinity;
      for (const a of areaOnly) {
        if (a.used) continue;
        const d = Math.hypot(a.t.x - n.t.x, a.t.y - n.t.y);
        if (d <= gap && d < bestD) {
          best = a;
          bestD = d;
        }
      }
      if (best) {
        best.used = true;
        area = best.area;
      }
    }
    const room: DetectedRoom = { name: n.name, at: { x: n.t.x, y: n.t.y }, heatedGuess: classifyRoomName(n.name) };
    if (area !== undefined) room.statedArea = area;
    rooms.push(room);
  }
  return rooms;
}

// ───────────────────────────── Niveaux ─────────────────────────────

interface StoreyRule {
  re: RegExp;
  fr: string;
  de: string;
  /** Rang indicatif pour trier du bas vers le haut. */
  rank: number;
}

const STOREY_RULES: StoreyRule[] = [
  { re: /sous[- ]?sol|\bcave\b|kellergeschoss|untergeschoss|\bkg\b|\bug\b|\bss\b|basement|keller/, fr: 'Sous-sol', de: 'Kellergeschoss', rank: -1 },
  { re: /rez[- ]de[- ]jardin|gartengeschoss/, fr: 'Rez-de-jardin', de: 'Gartengeschoss', rank: -0.5 },
  { re: /rez[- ]de[- ]chaussee|\brdc\b|\br\.d\.c|erdgeschoss|\beg\b|ground floor|parterre/, fr: 'Rez-de-chaussée', de: 'Erdgeschoss', rank: 0 },
  { re: /combles|dachgeschoss|\bdg\b|grenier|speicher|attic|mansarde/, fr: 'Combles', de: 'Dachgeschoss', rank: 9 },
  { re: /(?:2|ii)\s*(?:e|eme|ieme|nd)?\s*etage|etage\s*2|2\.\s*(?:og|obergeschoss)|\b2\.?\s?og\b|zweites obergeschoss|\br\+2\b/, fr: '2e étage', de: '2. Obergeschoss', rank: 2 },
  { re: /(?:1|i)\s*(?:er|e)?\s*etage|etage\s*1|1\.\s*(?:og|obergeschoss)|\b1\.?\s?og\b|erstes obergeschoss|\br\+1\b|premier etage/, fr: '1er étage', de: '1. Obergeschoss', rank: 1 },
  { re: /\betage\b|obergeschoss|\bog\b|upper floor|first floor/, fr: 'Étage', de: 'Obergeschoss', rank: 1 },
];

/** Reconnaît un nom de niveau dans un titre de plan ou un nom de calque/feuille. */
export function guessStorey(text: string): { fr: string; de: string; rank: number } | null {
  const f = fold(text);
  for (const r of STOREY_RULES) if (r.re.test(f)) return { fr: r.fr, de: r.de, rank: r.rank };
  return null;
}

// ───────────────────────────── Ouvertures ─────────────────────────────

/**
 * Dimensions d'une ouverture écrites « largeur × hauteur » : « 1,40x1,35 », « 120/135 », « 90 x 210 », « F 1.26/1.385 ».
 * Renvoie des MÈTRES (les valeurs ≥ 30 sont prises pour des cm, ≥ 300 pour des mm). null si non reconnu ou implausible.
 */
export function parseOpeningSize(text: string): { width: number; height: number } | null {
  const m = /(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:x|×|\/)\s*(\d{1,4}(?:[.,]\d{1,3})?)/i.exec(text);
  if (!m) return null;
  const conv = (raw: string): number => {
    const v = toNumber(raw);
    if (v >= 300) return v / 1000;
    if (v >= 30) return v / 100;
    // Un petit entier sans décimale (« 1/2 », « 2x3 ») est une fraction ou un repère, pas une dimension en mètres.
    if (!/[.,]/.test(raw)) return Number.NaN;
    return v;
  };
  const width = conv(m[1]!);
  const height = conv(m[2]!);
  if (!(width >= 0.3 && width <= 8 && height >= 0.3 && height <= 4)) return null;
  return { width, height };
}

const NORTH_RE = /(^|[^a-z])(nord|north|norden|nordpfeil|n[_-]?arrow|fleche[_ -]?nord|boussole|kompass)([^a-z]|$)/;

/** Vrai si un nom de bloc/calque désigne une flèche du nord. */
export function isNorthArrowName(name: string): boolean {
  return NORTH_RE.test(fold(name));
}

// ───────────────────────────── Hauteurs ─────────────────────────────

const HSP_RE = /\b(hsp|h\.s\.p\.?|hauteur sous plafond|rh|lrh|lichte\s+(?:raum)?hohe|raumhohe|lh)\s*[:=]?\s*(\d[.,]\d{1,2})\s*m?\b/;

/** « HSP 2,50 », « lichte Raumhöhe = 2.55 m » → hauteur libre en m. */
export function parseClearHeight(text: string): number | null {
  const m = HSP_RE.exec(fold(text));
  if (!m) return null;
  const v = toNumber(m[2]!);
  return v >= 1.8 && v <= 5 ? v : null;
}
