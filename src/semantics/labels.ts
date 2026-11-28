/**
 * Lecture du TEXTE des plans (FR / DE / LU) : surfaces, échelles, noms de pièces, niveaux, dimensions d'ouvertures.
 * Fonctions pures, communes aux lecteurs DWG/DXF, PDF et IFC.
 *
 * Règle pour An (RGD 2021, annexe I, ch. 5.1.2) : seules comptent les pièces dont l'usage normal demande
 * du chauffage et qui sont dans l'enveloppe thermique. Le classement ci-dessous n'est qu'une PROPOSITION :
 * les pièces ambiguës (cave, buanderie, grenier, hobby…) sont rendues 'ask' et l'expert tranche.
 */
import type { ReadGlazingBox, ReadView } from '../core/reading';
import type { BBox, DetectedRoom, Lang, PlanText, Vec2 } from '../core/types';
import { registerMessages, t, type Dictionary } from '../i18n';

/** Supprime accents et casse pour comparer des libellés. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    // Apostrophes typographiques : « Salle d’eau » et « Salle d'eau » sont le même libellé.
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
    .trim();
}

/** Nombre écrit à la française ou à l'allemande (« 1.234,56 », « 32,45 », « 32.45 », « −0,05 »). */
export function parseDecimal(raw: string): number {
  return toNumber(raw.replace(/[−–]/g, '-'));
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

// Le dénominateur ne doit être suivi ni d'une décimale ni d'une unité : « Étage 1 : 100,5 m² » n'est pas une échelle.
const SCALE_RE = /(?:^|[^\d])1\s*([:/])\s*(\d{1,4})(?!\d)(?![.,]\d)(?!\s*(?:m|cm|mm|qm)(?:[²2]|\b))/;
const SCALE_WORD_RE = /(echelle|\bech\b\.?|massstab|\bmst\b\.?|scale)/;
/** « M 1:200 », « M=1:50 », « M. 1:100 » : la lettre M majuscule collée au rapport écrit avec « : ». */
const SCALE_M_RE = /(?:^|[^A-Za-zÀ-ÿ])M\.?\s*=?\s*1\s*:/;
/** Rapport nu précédé d'un mot (« Étage 1 : 100 », « Phase 1:20 », « N° 1:25 ») : une numérotation, pas une échelle. */
const NUMBERED_RE = /[A-Za-zÀ-ÿ°.]\s+1\s*[:/]\s*\d/;
/** Sans mot « échelle », un rapport nu n'est une échelle de plan que s'il est écrit avec « : » et vaut au moins 1:10. */
const MIN_BARE_SCALE = 10;
const COMMON_SCALES = new Set([1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 2000, 2500, 5000]);

/**
 * « Échelle 1:100 », « Maßstab 1/50 », « M 1:200 » → dénominateur (100, 50, 200).
 * Un « 1:100 » nu n'est accepté que pour les échelles courantes. null sinon.
 * ATTENTION : l'échelle du cartouche n'est qu'un INDICE (un PDF « ajusté à la page » la rend fausse).
 */
export function parseScaleText(text: string): number | null {
  const m = SCALE_RE.exec(text);
  if (!m) return null;
  const denom = Number(m[2]);
  if (!Number.isFinite(denom) || denom < 1) return null;
  const hasWord = SCALE_WORD_RE.test(fold(text)) || SCALE_M_RE.test(text);
  // « Page 1/2 », « Blatt 1/5 » : une fraction nue n'est pas une échelle ; « Étage 1 : 100 » non plus.
  if (!hasWord && (m[1] !== ':' || denom < MIN_BARE_SCALE || !COMMON_SCALES.has(denom) || NUMBERED_RE.test(text))) return null;
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
  { re: /terrasse|balcon|balkon|loggia|veranda|wintergarten|jardin d'hiver|\babri\b|remise|schuppen/, guess: 'no' },
  {
    re: /buanderie|waschkuche|wasch|laundry|hobby|loisir|fitness|atelier|werkstatt|bricolage|\bhwr\b|hauswirtschaft|lingerie|kinderwagen|speisekammer|\bspeis\b|\bkammer\b/,
    guess: 'ask',
  },
  {
    re: /sejour|salon|living|wohn|stube|salle a manger|\bess|\brepas\b|piece de vie|chambre|\bch\.? ?\d|suite parentale|schlaf|zimmer|bureau|\bburo|\bbuero|arbeiten|bibliotheque|bibliothek|salle de jeux|spielzimmer|cuisine|kuche|kochen|kitchen|\bsdb\b|\bs\.d\.b|\bsde\b|\bsdd\b|\bs\.d\.d|salle de bain|salle d'eau|salle de douche|\bbain\b|\bbad|douche|dusch|\bwc\b|\bw\.c|toilet|dressing|ankleide|\bkind\b|\bkind ?\d|kinderzimmer|enfant|parents|eltern|gast|\bamis?\b|mezzanine|studio|galerie|empore/,
    guess: 'yes',
  },
  {
    re: /cave|keller|cellier|vorrat|abstell|debarras|rangement|lager|grenier|speicher|combles|dachboden|reserve|archiv/,
    guess: 'ask',
  },
  {
    re: /hall|entree|eingang|couloir|korridor|flur|\bgang\b|diele|vorraum|degagement|circulation|palier|escalier|treppe|cage|sas|windfang|vestiaire|garderobe/,
    guess: 'yes',
  },
];

/** Proposition « comptée dans An ? » d'après le nom de la pièce. */
export function classifyRoomName(name: string): HeatedGuess {
  const f = fold(name);
  if (!f) return 'ask';
  for (const rule of ROOM_RULES) if (rule.re.test(f)) return rule.guess;
  return 'ask';
}

/**
 * Locaux qui sont, PAR NATURE, hors de l'enveloppe thermique (garage, abri, terrasse, local explicitement « non
 * chauffé »). Une chaufferie ou un local technique n'en fait pas partie : non compté dans An d'office, il peut
 * très bien se trouver à l'intérieur de l'enveloppe isolée — c'est à l'expert de trancher.
 */
const OUTSIDE_ENVELOPE_RE =
  /non[- ]chauff|unbeheizt|nicht beheizt|kaltraum|garage|carport|car-port|parking|stellplatz|\babri\b|remise|schuppen|terrasse|balcon|balkon|loggia/;

export function isOutsideEnvelopeName(name: string): boolean {
  return OUTSIDE_ENVELOPE_RE.test(fold(name));
}

const ROOM_WORD_RE = new RegExp(ROOM_RULES.map((r) => r.re.source).join('|'));

/** Vrai si le texte ressemble à un nom de pièce (et non à une cote, un titre de plan…). */
/**
 * Textes de cartouche ou de légende qui contiennent un mot de pièce sans en être une : « Bureau d'études Schmit »,
 * « Einfamilienwohnhaus », « Kindergarten », « Plan des combles », « Voir détail cuisine », « Mur entre garage et séjour ».
 */
const NOT_A_ROOM_RE = new RegExp(
  [
    // bureaux d'études, entreprises, programmes
    "bureau d'etudes|d'architecture|architekt|architecte|ingenieur|\\bgmbh\\b|\\bsarl\\b|\\bs\\.a\\b|wohnbau|zimmerei",
    'einfamilien|mehrfamilien|zweifamilien|wohnhaus|wohnanlage|kindergarten|kinderspielplatz',
    // totaux de surfaces et libellés de logements : « Wohnfläche EG 69,39 m² » compterait deux fois dans An
    'wohnflache|nutzflache|grundflache|surface habitable|surface utile|surface totale|surface nette|\\btotal\\b|\\bgesamt|\\bsumme\\b',
    '\\bwohnung\\b|\\bappartement\\b|\\blogement\\b',
    // légendes et renvois
    '^plan\\b|^grundriss\\b|^voir\\b|^siehe\\b|^detail\\b|^hauteur\\b|^hohe\\b|^mur\\b|^wand\\b|parking public|^bad [a-z]+$',
    // code postal : « Essen 45127 », « L-1234 Luxembourg »
    '\\b\\d{5}\\b|\\bl-\\d{4}\\b',
  ].join('|'),
);

/** Mots de liaison : un texte qui commence ou finit par l'un d'eux est un bout de phrase, pas un nom de pièce. */
const LINK_WORD_RE = /^(?:and|or|the|between|with|et|ou|avec|entre|und|oder|mit|zwischen)$/;

export function looksLikeRoomName(text: string): boolean {
  const f = fold(text);
  if (f.length < 2 || f.length > 40) return false;
  if (/^[\d\s.,x×/+\-±:='"]+$/.test(f)) return false;
  // « AND WALL BETWEEN GARAGE AND » : une note de plan contient un mot de pièce sans en être une.
  const words = f.split(/\s+/).filter(Boolean);
  if (words.length > 5) return false;
  if (LINK_WORD_RE.test(words[0]!) || LINK_WORD_RE.test(words[words.length - 1]!)) return false;
  if (NOT_A_ROOM_RE.test(f)) return false;
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

/** Désignations sans ambiguïté d'un niveau enterré ou d'un niveau de stationnement. */
const BASEMENT_STRONG_RE =
  /sous[- ]?sol|kellergeschoss|untergeschoss|\bug\b|\bss\b|basement|souterrain|sockelgeschoss|tiefgarage|\bgarage\b|\bparking\b|(?:niveau|etage|ebene|\bn|\br|\be|\bu)\s?-\s?\d|^-\s?\d|\bu\d\b/;
/** « KG » vaut Kellergeschoss… sauf dans une raison sociale (« Müller GmbH & Co KG »). */
const BASEMENT_KG_RE = /\bkg\b/;
const COMPANY_RE = /gmbh|& ?co\b|\bco\.? kg\b/;
/** « Keller », « cave » : un sous-sol dans un titre de plan, mais aussi un nom de famille dans un nom de fichier. */
const BASEMENT_WEAK_RE = /\bcave\b|keller/;
const PLAN_WORD_RE = /grundriss|\bplan\b|niveau|ebene|geschoss|etage/;
const ABOVE_GROUND_RE = /rez[- ]de[- ]chaussee|\brdc\b|erdgeschoss|\beg\b|\bog\b|obergeschoss|\betage\b|dachgeschoss|\bdg\b|combles/;

function isBasementText(f: string): boolean {
  if (BASEMENT_STRONG_RE.test(f)) return true;
  if (BASEMENT_KG_RE.test(f) && !COMPANY_RE.test(f)) return true;
  if (!BASEMENT_WEAK_RE.test(f)) return false;
  // Un niveau hors sol nommé dans le même texte l'emporte (« Haus Keller EG »).
  if (ABOVE_GROUND_RE.test(f)) return false;
  // Seul, ou à côté d'un mot de plan (« Grundriss Keller ») : un sous-sol. « Wohnhaus Keller » : un nom.
  const words = f.split(/[\s_\-.]+/).filter(Boolean);
  return words.length <= 1 || PLAN_WORD_RE.test(f) || /kellerplan|kellerraum/.test(f);
}

const STOREY_RULES: StoreyRule[] = [
  { re: /rez[- ]de[- ]jardin|gartengeschoss/, fr: 'Rez-de-jardin', de: 'Gartengeschoss', rank: -0.5 },
  { re: /rez[- ]de[- ]chaussee|\brdc\b|\br\.d\.c|erdgeschoss|\beg\b|ground floor|parterre/, fr: 'Rez-de-chaussée', de: 'Erdgeschoss', rank: 0 },
  { re: /combles|dachgeschoss|\bdg\b|grenier|speicher|attic|mansarde/, fr: 'Combles', de: 'Dachgeschoss', rank: 9 },
  { re: /(?:2|ii)\s*(?:e|eme|ieme|nd)?\s*etage|etage\s*2|2\.\s*(?:og|obergeschoss)|\b2\.?\s?og\b|zweites obergeschoss|\br\+2\b/, fr: '2e étage', de: '2. Obergeschoss', rank: 2 },
  { re: /(?:1|i)\s*(?:er|e)?\s*etage|etage\s*1|1\.\s*(?:og|obergeschoss)|\b1\.?\s?og\b|erstes obergeschoss|\br\+1\b|premier etage/, fr: '1er étage', de: '1. Obergeschoss', rank: 1 },
  { re: /\betage\b|obergeschoss|\bog\b|upper floor|first floor/, fr: 'Étage', de: 'Obergeschoss', rank: 1 },
];

const ROOF_LEVEL_RE = /\broof\b|\btoit\b|toiture|\bdach\b|dachaufsicht|dachdraufsicht|dachebene|\bfirst\b.*\bridge\b|\bfaitage\b/;

/**
 * Vrai si le nom désigne un plan de TOITURE (« Roof », « Roof Line », « Plan de toiture », « Dachaufsicht ») :
 * un tel niveau n'est pas un étage. « Dachgeschoss » et « Combles » sont des étages et ne sont pas concernés.
 */
export function isRoofLevelName(name: string): boolean {
  return ROOF_LEVEL_RE.test(fold(name));
}

/** Reconnaît un nom de niveau dans un titre de plan ou un nom de calque/feuille. */
const UPPER_STOREY_RE = /\b(\d{1,2})\s*(?:e|eme|ieme)\s*etage\b|\betage\s*(\d{1,2})\b|\b(\d{1,2})\.\s*(?:og\b|obergeschoss)|\b(\d{1,2})\s?og\b|\br\+(\d{1,2})\b/;

export function guessStorey(text: string): { fr: string; de: string; rank: number } | null {
  const f = fold(text);
  // Une cote de niveau (« ±0,00 », « -0,02 », « +2,80 m ») n'est pas un nom d'étage : « -0,02 » passait pour un sous-sol.
  if (/^\s*[+\-±−]?\s?\d{1,2}[.,]\d{1,3}\s*m?\s*$/.test(text)) return null;
  // Étages 3 et plus (« 3e étage », « 4. Obergeschoss », « R+5 ») : une seule règle, le rang est le numéro.
  if (isBasementText(f)) return { fr: 'Sous-sol', de: 'Kellergeschoss', rank: -1 };
  const upper = UPPER_STOREY_RE.exec(f);
  const n = upper ? Number(upper[1] ?? upper[2] ?? upper[3] ?? upper[4] ?? upper[5]) : 0;
  if (n >= 3 && n <= 60) return { fr: `${n}e étage`, de: `${n}. Obergeschoss`, rank: n };
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

// ───────────────────────────── Lignes de texte placées ─────────────────────────────

/**
 * Ligne de texte PLACÉE sur une feuille : ce que les lecteurs (PDF, plus tard DXF) donnent aux fonctions de lecture
 * de texte ci-dessous et dans semantics/compositions, levels, siteareas, equipment. Une ligne réunit les morceaux de
 * même direction, même corps et même ligne de base (lecteur PDF : readers/pdf/textlines.ts).
 *
 * Repère local de la ligne : u le long du sens de lecture, v vers le HAUT du texte. Pour un texte horizontal,
 * u = x et v = −y ; pour un texte lu de bas en haut (angle 90), u = −y et v = −x. `base` est la position v de la
 * ligne de base : une ligne écrite SOUS une autre a un `base` plus petit.
 */
export interface SheetLine {
  text: string;
  /** Page, à partir de 1. */
  page: number;
  /** Sens de lecture, degrés, sens trigonométrique à l'écran (0 = vers la droite, 90 = vers le haut). */
  angle: number;
  /** Corps du texte (unités de feuille). */
  size: number;
  box: BBox;
  /** Étendue le long de la lecture et ligne de base, dans le repère local de la ligne. */
  u0: number;
  u1: number;
  base: number;
}

/** Axes du repère local d'un sens de lecture : d le long de la lecture, up vers le haut du texte (page y vers le bas). */
export function readingFrame(angle: number): { d: Vec2; up: Vec2 } {
  const a = (angle * Math.PI) / 180;
  return { d: { x: Math.cos(a), y: -Math.sin(a) }, up: { x: -Math.sin(a), y: -Math.cos(a) } };
}

/** Coordonnées (u, v) d'un point de la feuille dans le repère local d'un sens de lecture. */
export function toReadingFrame(angle: number, p: Vec2): { u: number; v: number } {
  const { d, up } = readingFrame(angle);
  return { u: p.x * d.x + p.y * d.y, v: p.x * up.x + p.y * up.y };
}

/** Vrai si deux sens de lecture sont les mêmes à `tol` degrés près. */
export function sameDirection(a: number, b: number, tol = 2): boolean {
  const d = Math.abs(((((a - b) % 360) + 540) % 360) - 180);
  return d <= tol;
}

export function lineCenter(l: { box: BBox }): Vec2 {
  return { x: (l.box.minX + l.box.maxX) / 2, y: (l.box.minY + l.box.maxY) / 2 };
}

export function inBox(b: BBox, p: Vec2, pad = 0): boolean {
  return p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad;
}

/** Vue de la page qui contient le point : la plus petite (une vue peut en contenir une autre, cartouche dans un cadre). */
export function viewAt(views: readonly ReadView[], page: number, p: Vec2): ReadView | null {
  let best: ReadView | null = null;
  let bestArea = Infinity;
  for (const v of views) {
    if (v.page !== page || !inBox(v.box, p)) continue;
    const area = (v.box.maxX - v.box.minX) * (v.box.maxY - v.box.minY);
    if (area < bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

/** Position v, dans le repère local de `ref`, de la ligne de base d'une autre ligne de même sens. */
export function baseIn(ref: SheetLine, o: SheetLine): number {
  if (sameDirection(ref.angle, o.angle, 0.01)) return o.base;
  const { d, up } = readingFrame(o.angle);
  const p = { x: o.u0 * d.x + o.base * up.x, y: o.u0 * d.y + o.base * up.y };
  return toReadingFrame(ref.angle, p).v;
}

// ───────────────────────────── Pièces écrites sur les plans ─────────────────────────────

const ROOM_MESSAGES: Dictionary = {
  fr: {
    'read.room.ask': '« {name} » ({area} m²) : dans le volume chauffé, comptée dans An ?',
    'read.room.technical': '« {name} » ({area} m²) : local technique ; dans l’isolation (compté dans An) ou dehors ?',
    'read.room.basement': '« {name} » ({area} m²) au sous-sol : dans le volume chauffé, comptée dans An ?',
  },
  de: {
    'read.room.ask': '„{name}“ ({area} m²): im beheizten Volumen, zählt zu An?',
    'read.room.technical': '„{name}“ ({area} m²): Technikraum; innerhalb der Dämmung (zählt zu An) oder außerhalb?',
    'read.room.basement': '„{name}“ ({area} m²) im Untergeschoss: im beheizten Volumen, zählt zu An?',
  },
};
registerMessages(ROOM_MESSAGES);

/** Pièce lue sur un plan : un NOM et, juste en dessous, sa surface écrite (« S: 28,40 m² »). */
export interface RoomLine {
  name: string;
  statedArea: number;
  /** Centre du nom (uf). */
  at: Vec2;
  page: number;
  viewId: string | null;
  heatedGuess: HeatedGuess;
  /** Espace à l'air libre (terrasse, balcon, loggia) : jamais une pièce du bâtiment. */
  exterior: boolean;
  /** Hors de l'enveloppe thermique par nature (garage, abri, terrasse…) : voir isOutsideEnvelopeName. */
  outsideEnvelope: boolean;
  confidence: number;
  doubt: string | null;
}

/** Ligne de surface d'une étiquette de pièce : « S: 28,40 m² », « F: 32,50 m² », « NF = 12,10 m² », « Fläche: 7,8 ». */
const AREA_LINE_RE = /^(?:s|surf\.?|surface|sh|sn|nf|ngf|wf|f|fl\.?|flache|a)\s*[:=]\s*(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:m\s?[²2]|m\^2|qm|m)?\s*$/;
/** Surface seule : « 21,95 m² ». */
const AREA_ONLY_RE = /^(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:m\s?[²2]|m\^2|qm|㎡)$/;
/** Espaces à l'air libre. */
const EXTERIOR_RE = /terrasse|balcon|balkon|loggia|jardin|garten(?!geschoss)|\bcour\b|pergola|auvent|vordach/;
/** Intitulés qui ne nomment pas une pièce (encadrés d'éclairement, tableaux, totaux, niveaux, renvois). */
const NOT_A_ROOM_LINE_RE =
  /^(?:surface|surf\.|flache|coefficient|total|gesamt|summe|somme|hsp|okff|ok ff|niveau|niv\.|nf\b|coupe|schnitt|facade|fassade|ansicht|plan\b|grundriss|voir|siehe|echelle|massstab|composition|aufbau)|[:=]\s*$|^[+\-±−]?\s?\d/;
const TOTAL_WORD_RE =
  /\b(?:total|totale|gesamt|summe|somme|wohnflache|nutzflache|surface habitable|surface utile|surface nette|surface brute|emprise|terrain|grundstuck|parcelle|parzelle)\b/;

/** Nom de pièce lisible dans une ligne (sans surface ni numéro de local) ; null si la ligne n'en est pas un. */
export function roomNameOf(text: string): string | null {
  let s = text.replace(/\s+/g, ' ').trim();
  if (parseClearHeight(s) !== null) return null;
  s = s.replace(AREA_RE, ' ').replace(/[\s=\-–—|/]+$/g, '').replace(/^[\s:=\-–—|/]+/g, '').trim();
  s = s.replace(/^\d{1,2}[.\-]\d{1,3}\s+/, '').trim();
  if (s.length < 2 || s.length > 40) return null;
  const f = fold(s);
  if ((f.match(/[a-z]/g) ?? []).length < 2) return null;
  if (f.split(/\s+/).length > 5) return null;
  if (/^[a-z]\s?\d+[a-z]?$/.test(f)) return null; // « F1 », « T 02 » : repère de menuiserie
  if (NOT_A_ROOM_LINE_RE.test(f) || TOTAL_WORD_RE.test(f) || NOT_A_ROOM_RE.test(f)) return null;
  if (/\b1\s*[:/]\s*\d/.test(f) || parseOpeningSize(s) !== null) return null;
  return s;
}

function areaOfLine(text: string): number | null {
  const f = fold(text).replace(/\s+/g, ' ');
  const m = AREA_LINE_RE.exec(f) ?? AREA_ONLY_RE.exec(f);
  if (!m) return null;
  const v = toNumber(m[1]!);
  return v > 0.5 && v < 2000 ? v : null;
}

function roomLine(name: string, area: number, at: Vec2, page: number, view: ReadView | null, lang: Lang): RoomLine {
  let guess = classifyRoomName(name);
  const outside = isOutsideEnvelopeName(name);
  const exterior = EXTERIOR_RE.test(fold(name));
  const areaText = area.toFixed(2).replace('.', ',');
  let doubt: string | null = null;
  // Au sous-sol, même un dégagement ou une pièce « de vie » peut être hors du volume chauffé : on demande.
  const basement = view?.kind === 'floor-plan' && view.storeyRank !== null && view.storeyRank < 0;
  if (basement && guess === 'yes') {
    guess = 'ask';
    doubt = t(lang, 'read.room.basement', { name, area: areaText });
  } else if (guess === 'ask') doubt = t(lang, 'read.room.ask', { name, area: areaText });
  else if (guess === 'no' && !outside) doubt = t(lang, 'read.room.technical', { name, area: areaText });
  return {
    name,
    statedArea: area,
    at,
    page,
    viewId: view?.id ?? null,
    heatedGuess: guess,
    exterior,
    outsideEnvelope: outside,
    // Nom et surface écrits : une seule source (le texte) ; un classement à demander abaisse la confiance.
    confidence: doubt ? 0.5 : 0.75,
    doubt,
  };
}

/**
 * Pièces écrites sur les plans : une ligne de SURFACE (« S: 28,40 m² », ou « 21,95 m² » seul) et la ligne de NOM
 * juste au-dessus (ligne de base 0,5 à 2,2 corps plus haut, alignée à gauche ou centrée à 1 corps près).
 * Une ligne qui finit par « : » est un intitulé (encadré d'éclairement, tableau) : jamais un nom. Repli : une ligne
 * « Séjour 28,40 m² » d'un seul tenant. Les lignes « Surface … : » des encadrés d'éclairement ne créent jamais de pièce.
 */
export function roomsFromLines(lines: readonly SheetLine[], views: readonly ReadView[], lang: Lang = 'fr'): RoomLine[] {
  const out: RoomLine[] = [];
  const used = new Set<SheetLine>();
  for (const a of lines) {
    const area = areaOfLine(a.text);
    if (area === null) continue;
    let best: SheetLine | null = null;
    let bestDv = Infinity;
    for (const o of lines) {
      if (o === a || o.page !== a.page || used.has(o) || !sameDirection(o.angle, a.angle)) continue;
      const dv = baseIn(a, o) - a.base;
      if (dv < 0.5 * a.size || dv > 2.2 * a.size) continue;
      const leftAligned = Math.abs(o.u0 - a.u0) < a.size;
      const centred = Math.abs((o.u0 + o.u1) / 2 - (a.u0 + a.u1) / 2) < a.size;
      if (!leftAligned && !centred) continue;
      if (/:\s*$/.test(o.text)) continue;
      if (dv < bestDv) {
        best = o;
        bestDv = dv;
      }
    }
    if (!best) continue;
    const name = roomNameOf(best.text);
    if (!name) continue;
    used.add(best);
    used.add(a);
    out.push(roomLine(name, area, lineCenter(best), a.page, viewAt(views, a.page, lineCenter(a)), lang));
  }
  // Repli : « Séjour 28,40 m² » sur une seule ligne (étiquettes Revit, Allplan).
  for (const l of lines) {
    if (used.has(l) || l.text.includes(':')) continue;
    if (/^(?:surface|flache|surf\.|total|gesamt)/.test(fold(l.text))) continue;
    const parsed = parseRoomLabel(l.text);
    if (!parsed || parsed.area === undefined || !parsed.name) continue;
    const name = roomNameOf(parsed.name);
    if (!name) continue;
    out.push(roomLine(name, parsed.area, lineCenter(l), l.page, viewAt(views, l.page, lineCenter(l)), lang));
  }
  return out;
}

// ───────────────────────────── Encadrés d'éclairement naturel ─────────────────────────────

const GLAZED_RE = /^(surface vitree|surface de vitrage|surface eclairante|surface des baies|fensterflache|glasflache|belichtungsflache)\b/;

function areaAfterColon(text: string): number | null {
  const a = parseArea(text);
  if (a !== null) return a;
  const m = /[:=]\s*(\d+(?:[.,]\d+)?)\s*m?\s*$/.exec(text);
  return m ? toNumber(m[1]!) : null;
}

/**
 * Encadrés d'éclairement d'une pièce de vie (« Surface vitrée : 6,20 m² » / « Surface séjour : 32,50 m² » /
 * « 1/8 surface du plancher : 4,06 m² ») : la ligne « surface vitrée » et les lignes alignées à gauche (à 1 corps)
 * dans les 5 corps en dessous. Ne crée AUCUNE pièce ; sert à recouper les baies lues pièce par pièce.
 */
export function glazingBoxes(lines: readonly SheetLine[], views: readonly ReadView[]): ReadGlazingBox[] {
  const out: ReadGlazingBox[] = [];
  for (const v of lines) {
    if (!GLAZED_RE.test(fold(v.text))) continue;
    const group = lines
      .filter((o) => o !== v && o.page === v.page && sameDirection(o.angle, v.angle) && Math.abs(o.u0 - v.u0) < v.size)
      .filter((o) => {
        const dv = v.base - baseIn(v, o);
        return dv > 0.2 * v.size && dv < 5 * v.size;
      })
      .sort((a, b) => b.base - a.base);
    // Une autre ligne « surface vitrée » plus bas ouvre l'encadré suivant : on s'arrête avant.
    const next = group.findIndex((l) => GLAZED_RE.test(fold(l.text)));
    const own = next >= 0 ? group.slice(0, next) : group;
    const roomRow = own.find((l) => /^(surface|flache)\s+(?!vitree|de vitrage|eclairante|du plancher|des baies)\S/.test(fold(l.text)) && !/coefficient|1\/\d/.test(fold(l.text)));
    const reqRow = own.find((l) => /1\/\d+|coefficient|erforderlich|requis|exige/.test(fold(l.text)) && areaAfterColon(l.text) !== null);
    const room = roomRow ? roomRow.text.replace(/^(surface|fl(?:ä|a)che)\s+/i, '').replace(/\s*[:=].*$/, '').trim() || null : null;
    const at = lineCenter(v);
    out.push({
      viewId: viewAt(views, v.page, at)?.id ?? null,
      room,
      glazedArea: areaAfterColon(v.text),
      floorArea: roomRow ? areaAfterColon(roomRow.text) : null,
      required: reqRow ? areaAfterColon(reqRow.text) : null,
      page: v.page,
      at,
    });
  }
  return out;
}
