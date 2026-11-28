/**
 * Compositions de parois ÉCRITES sur une planche : blocs « Composition mur : » / « Composition dalle : » /
 * « Composition toiture : » (DE : Wandaufbau, Bodenaufbau, Deckenaufbau, Dachaufbau, Aufbau…) suivis d'une couche
 * par ligne (« 24cm Béton », « Stahlbeton 25 cm », « 200 mm Mineralwolle », « Film PE »).
 *
 * Ce module LIT : couches (texte d'origine, libellé, famille de matériau, épaisseur), ordre intérieur → extérieur,
 * rôle thermique de la paroi, couches hors calcul, doutes. Il ne donne AUCUNE conductivité ni valeur U : la
 * bibliothèque de matériaux et le calcul U appartiennent au moteur (engine/materials, engine/uvalue).
 *
 * Le rôle de la paroi recoupe des signaux indépendants : le titre du bloc, les matériaux (marqueurs de sol, isolant
 * en tête ou en sous-face, chape), la vue où se trouve le bloc et les pièces voisines (garage). Un même bloc répété
 * sur plusieurs vues (et plusieurs pages) ne donne qu'une composition, dont la confiance monte avec les répétitions.
 */
import type { ElementType, MaterialKey, ReadComposition, ReadLayer, ReadView, ViewKind } from '../core/reading';
import type { BBox, Lang, Vec2 } from '../core/types';
import { registerMessages, t, type Dictionary } from '../i18n';
import { baseIn, fold, isOutsideEnvelopeName, lineCenter, looksLikeRoomName, parseDecimal, sameDirection, viewAt, type SheetLine } from './labels';

const MESSAGES: Dictionary = {
  fr: {
    'read.comp.mixed': 'Couche mixte (« {label} ») : préciser le matériau et la part de chacun.',
    'read.comp.genericInsulation': 'Isolant sans type (« {label} ») : EPS, laine minérale, PUR… ?',
    'read.comp.plainConcrete': '« {label} » : blocs de béton ou béton armé coulé ?',
    'read.comp.noThickness': 'Épaisseur non écrite pour « {label} ».',
    'read.comp.floorBelow': 'Plancher isolé en sous-face : au-dessus d’un local non chauffé (garage, cave) ou de l’extérieur ?',
    'read.comp.titleConflict': 'Bloc titré « {header} », mais ses couches sont celles d’un autre élément : lequel ?',
    'read.comp.unknown': 'Composition « {header} » : à quelle paroi correspond-elle ?',
    'read.comp.untitled': 'Couches lues sans titre de bloc : à quelle paroi correspondent-elles ?',
    'read.comp.unknownMaterial': 'Matériau non reconnu : « {label} ». Lequel est-ce ?',
  },
  de: {
    'read.comp.mixed': 'Gemischte Schicht („{label}“): Material und Anteile angeben.',
    'read.comp.genericInsulation': 'Dämmung ohne Typ („{label}“): EPS, Mineralwolle, PUR …?',
    'read.comp.plainConcrete': '„{label}“: Betonsteine oder Ortbeton (Stahlbeton)?',
    'read.comp.noThickness': 'Keine Dicke angegeben für „{label}“.',
    'read.comp.floorBelow': 'Decke mit Dämmung unterseitig: über einem unbeheizten Raum (Garage, Keller) oder über Außenluft?',
    'read.comp.titleConflict': 'Block „{header}“, aber die Schichten passen zu einem anderen Bauteil: zu welchem?',
    'read.comp.unknown': 'Aufbau „{header}“: zu welchem Bauteil gehört er?',
    'read.comp.untitled': 'Schichten ohne Überschrift gelesen: zu welchem Bauteil gehören sie?',
    'read.comp.unknownMaterial': 'Material nicht erkannt: „{label}“. Welches ist es?',
  },
};
registerMessages(MESSAGES);

// ───────────────────────────── Matériaux ─────────────────────────────

interface MatRule {
  key: MaterialKey;
  re: RegExp;
  insulation?: boolean;
  specific?: boolean;
}

/** Vocabulaire FR / DE replié (sans accents, minuscules). À position égale, la règle la plus précise l'emporte. */
const MATERIALS: MatRule[] = [
  { key: 'beton-maigre', re: /beton de proprete|beton maigre|sauberkeitsschicht|magerbeton/, specific: true },
  { key: 'bloc-beton', re: /blocs? (?:de |en )?beton|parpaing|betonstein|hohlblock|betonblock|betonblockstein/, specific: true },
  { key: 'beton-arme', re: /dalle (?:en |de )?beton|beton arme|\bradier\b|stahlbeton|\bstb\b|bodenplatte|ortbeton|betondecke|\bdalle\b/, specific: true },
  { key: 'beton', re: /\bbeton\b/ },
  { key: 'silico-calcaire', re: /kalksandstein|\bks\b|silico[- ]calcaire/, specific: true },
  { key: 'bardage', re: /bardage|verkleidung|vetage|veture|\btuiles?\b|ardoise|dachziegel|dachstein|schiefer|eindeckung|couverture/ },
  { key: 'brique', re: /brique|ziegel|terre cuite|poroton|mauerwerk/, specific: true },
  { key: 'fibre-bois', re: /fibre de bois|holzfaser/, insulation: true, specific: true },
  { key: 'bois', re: /\bbois\b|holz|\bosb\b|\bclt\b|lamelle|brettsperrholz|ossature|lattung|\blattes?\b|lattage|liteau|contre-latte|chevron|sparren/ },
  { key: 'eps', re: /\beps\b|polystyrene expanse|styropor/, insulation: true, specific: true },
  { key: 'xps', re: /\bxps\b|jackodur|styrodur|roofmate|polystyrene extrude|perimeterdammung/, insulation: true, specific: true },
  { key: 'pir', re: /\bpir\b|polyiso/, insulation: true, specific: true },
  { key: 'pur', re: /\bpur\b|polyurethane|mousse pu\b|\bpu\b|\bpu-/, insulation: true, specific: true },
  { key: 'laine-minerale', re: /laine (?:de )?(?:roche|verre|minerale)|mineralwolle|steinwolle|glaswolle|\bmw\b/, insulation: true, specific: true },
  { key: 'isolant', re: /isolation|isolant|dammung|daemmung|dammplatte|warmedamm|trittschall/, insulation: true },
  { key: 'chape', re: /\bchape\b|estrich/ },
  { key: 'revetement-sol', re: /revetement|carrelage|parquet|bodenbelag|fliesen|\bbelag\b/ },
  { key: 'enduit-facade', re: /enduit (?:de )?facade|enduit exterieur|crepi|aussenputz|fassadenputz|oberputz/, specific: true },
  { key: 'enduit-platre', re: /platre|gypse|innenputz|gipsputz|gipskarton|gipsplatte|placo|fermacell|\benduit\b|\bputz\b/ },
  { key: 'etancheite', re: /etancheite|bitum|abdichtung|membrane|epdm|dachbahn|dachabdichtung/ },
  { key: 'film', re: /\bfilm\b|\bpe\b|polyethylene|pare[- ]?vapeur|frein[- ]?vapeur|pare[- ]?pluie|ecran (?:de )?sous[- ]toiture|sous[- ]toiture|\becran\b|unterspannbahn|unterdeckbahn|unterdach|dampfbremse|dampfsperre|\bfolie\b|trennlage|\bfeutre\b|\bvlies|geotextile|\bnatte\b/ },
  { key: 'empierrement', re: /empierrement|gravier|herisson|schotter|\bkies|tout[- ]venant|\bgrave\b|frostschutz|lestage|galets/ },
  { key: 'lame-air', re: /lame d'air|vide d'air|vide ventile|luftschicht|hinterluftung/ },
];

/** Famille de matériau d'un libellé de couche (le texte d'origine est gardé à côté). */
export function materialKey(label: string): MaterialKey {
  const f = fold(label);
  const hits = MATERIALS.map((m) => ({ m, i: f.search(m.re) })).filter((h) => h.i >= 0);
  if (hits.length === 0) return 'inconnu';
  // Un isolant PRÉCIS (« Isolation type EPS », « Mousse PUR ») l'emporte sur le mot générique « isolation ».
  const first = Math.min(...hits.map((h) => h.i));
  const precise = hits.filter((h) => h.m.insulation && h.m.specific).sort((a, b) => a.i - b.i);
  if (precise.length > 0 && hits.some((h) => h.m.key === 'isolant' && h.i === first)) return precise[0]!.m.key;
  // Sinon le premier mot reconnu (« Chape + ravoirage » → chape) ; à position égale, le plus précis.
  hits.sort((a, b) => a.i - b.i || Number(!!b.m.specific) - Number(!!a.m.specific));
  return hits[0]!.m.key;
}

export function isInsulationKey(k: MaterialKey): boolean {
  return k === 'eps' || k === 'xps' || k === 'pur' || k === 'pir' || k === 'laine-minerale' || k === 'fibre-bois' || k === 'isolant';
}

export function isStructureKey(k: MaterialKey): boolean {
  return k === 'beton-arme' || k === 'beton' || k === 'bloc-beton' || k === 'silico-calcaire' || k === 'brique' || k === 'bois';
}

// ───────────────────────────── Une couche ─────────────────────────────

/** « 24cm Béton », « 1,5 cm Enduit », « 200 mm Mineralwolle », « d=20cm EPS ». */
const LAYER_HEAD_RE = /^(?:d\s*=\s*|ep\.?\s*)?(\d{1,3}(?:[.,]\d{1,2})?)\s*(mm|cm|m)?\.?\s+(.{2,})$/i;
/** « Béton armé 24 cm », « Stahlbeton Bodenplatte 25cm ». */
const LAYER_TAIL_RE = /^(.{2,}?)\s+(?:d\s*=\s*|ep\.?\s*)?(\d{1,3}(?:[.,]\d{1,2})?)\s*(mm|cm)$/i;
/** Couches minces écrites sans épaisseur. */
const THIN_LAYER_RE =
  /^(hinterluftung|lame d'air|vide ventile|luftschicht|film|feuille|pare[- ]?vapeur|frein[- ]?vapeur|pare[- ]?pluie|ecran|etancheite|membrane|natte|geotextile|feutre|dampfbremse|dampfsperre|unterspannbahn|unterdeckbahn|abdichtung|folie|pe-folie|trennlage|vlies|bitume)/;
const THICKNESS_RE = /\d{1,3}(?:[.,]\d{1,2})?\s*(?:mm|cm)\b/g;

/** Épaisseur en cm ; unité absente : cm jusqu'à 60, mm au-delà. */
function toCm(value: number, unit: string): number {
  const u = unit.toLowerCase();
  const cm = u === 'mm' ? value / 10 : u === 'm' ? value * 100 : u === 'cm' ? value : value > 60 ? value / 10 : value;
  return Math.round(cm * 100) / 100;
}

/**
 * Une ligne de couche → libellé et épaisseur (cm, null si non écrite) ; null si la ligne n'est pas une couche.
 * `inBlock` : la ligne est sous un titre de composition ; une couche sans épaisseur y est acceptée si son matériau
 * est reconnu (« Dachziegel », « Film PE »).
 */
export function parseLayer(text: string, inBlock = false): { label: string; thicknessCm: number | null } | null {
  const s = text.replace(/\s+/g, ' ').trim();
  let m = LAYER_HEAD_RE.exec(s);
  if (m) {
    const cm = toCm(parseDecimal(m[1]!), m[2] ?? '');
    if (cm > 0 && cm <= 120 && /\p{L}{2}/u.test(m[3]!)) return { label: m[3]!.trim(), thicknessCm: cm };
  }
  m = LAYER_TAIL_RE.exec(s);
  if (m && materialKey(m[1]!) !== 'inconnu') {
    const cm = toCm(parseDecimal(m[2]!), m[3]!);
    if (cm > 0 && cm <= 120) return { label: m[1]!.trim(), thicknessCm: cm };
  }
  const f = fold(s);
  if (s.length < 40 && THIN_LAYER_RE.test(f)) return { label: s, thicknessCm: null };
  if (inBlock && s.length < 40 && !/\d/.test(s) && materialKey(s) !== 'inconnu') return { label: s, thicknessCm: null };
  return null;
}

/** « 24 béton + 20 EPS + 2 enduit » : plusieurs couches écrites sur une ligne (au moins deux épaisseurs). */
export function parseLayers(text: string, inBlock = false): { label: string; thicknessCm: number | null }[] | null {
  const thick = text.match(THICKNESS_RE) ?? [];
  if (thick.length >= 2) {
    const parts = text.split(/\s*[+/;]\s*|\s+-\s+/).filter((p) => p.trim().length > 0);
    const layers = parts.map((p) => parseLayer(p, true));
    if (layers.length >= 2 && layers.every((l) => l !== null)) return layers as { label: string; thicknessCm: number | null }[];
  }
  const one = parseLayer(text, inBlock);
  return one ? [one] : null;
}

function makeLayer(raw: string, p: { label: string; thicknessCm: number | null }): ReadLayer {
  return { raw, label: p.label, material: materialKey(p.label), thicknessCm: p.thicknessCm, counted: true, doubt: null };
}

// ───────────────────────────── Blocs ─────────────────────────────

export type HeaderKind = 'wall' | 'slab' | 'roof' | 'generic' | 'none';

export interface CompositionBlock {
  /** Titre tel qu'écrit (« Composition mur : ») ; vide pour un bloc sans titre. */
  header: string;
  headerKind: HeaderKind;
  /** Couches dans l'ordre ÉCRIT (de haut en bas). */
  layers: ReadLayer[];
  box: BBox;
  page: number;
  viewId: string | null;
  viewKind: ViewKind | null;
  /** Corps du titre (ou de la première couche). */
  size: number;
}

const HEADER_RE =
  /^(?:composition|compo\.?|constitution|complexe|structure|detail|aufbau|wandaufbau|aussenwandaufbau|bodenaufbau|fussbodenaufbau|deckenaufbau|dachaufbau|schichtaufbau)\b([^:]{0,40})(?::(.*))?$/;
const HEADER_WALL_RE = /\b(?:mur|murs|paroi|facade|wand|aussenwand|wandaufbau|aussenwandaufbau|innenwand|kellerwand)\b/;
const HEADER_ROOF_RE = /\b(?:toiture|toit|couverture|dach|dachaufbau|flachdach|steildach)\b/;
const HEADER_SLAB_RE = /\b(?:dalle|plancher|sol|radier|boden|bodenaufbau|fussbodenaufbau|decke|deckenaufbau|bodenplatte|plafond)\b/;

/** Vrai si la ligne est un titre de composition. */
export function isCompositionHeader(text: string): boolean {
  return HEADER_RE.test(fold(text).trim());
}

function headerKindOf(f: string): HeaderKind {
  if (HEADER_WALL_RE.test(f)) return 'wall';
  if (HEADER_ROOF_RE.test(f)) return 'roof';
  if (HEADER_SLAB_RE.test(f)) return 'slab';
  return 'generic';
}

function grow(box: BBox, b: BBox): BBox {
  return { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) };
}

/**
 * Lignes empilées sous `start` : même sens, corps à 25 % près, ligne de base suivante 0,5 à 3 corps sous la
 * précédente, chevauchement le long de la lecture avec le bloc élargi de 3 corps (pas d'exigence d'alignement à
 * gauche : certains blocs sont alignés à droite). Arrêt à la première ligne voisine qui n'est pas une couche ; au-delà
 * de 2 corps d'interligne, on ne continue que si la ligne est une couche.
 */
function stackBelow(start: SheetLine, lines: readonly SheetLine[], used: Set<SheetLine>): { line: SheetLine; layers: { label: string; thicknessCm: number | null }[] }[] {
  const out: { line: SheetLine; layers: { label: string; thicknessCm: number | null }[] }[] = [];
  const s = start.size;
  let prev = start;
  const pending: SheetLine[] = [];
  let u0 = start.u0;
  let u1 = start.u1;
  for (;;) {
    let next: SheetLine | null = null;
    let bestDv = Infinity;
    for (const o of lines) {
      if (o === prev || o === start || used.has(o) || o.page !== start.page || !sameDirection(o.angle, start.angle)) continue;
      if (o.size / s < 0.75 || o.size / s > 1.33) continue;
      const dv = baseIn(start, prev) - baseIn(start, o);
      if (dv < 0.5 * s || dv > 3 * s) continue;
      if (o.u1 < u0 - 3 * s || o.u0 > u1 + 3 * s) continue;
      if (dv < bestDv) {
        next = o;
        bestDv = dv;
      }
    }
    if (!next || isCompositionHeader(next.text)) break;
    const layers = parseLayers(next.text, true);
    if (!layers) {
      // Libellé non reconnu (membrane ou produit hors vocabulaire) : gardé en attente ; il n'entre dans le bloc que si
      // une couche reconnue le suit (sinon le bloc s'arrête avant lui). Au plus deux de suite.
      if (pending.length >= MAX_UNKNOWN_RUN || !looksLikeUnknownLayer(next.text)) break;
      pending.push(next);
      prev = next;
      continue;
    }
    for (const p of pending) {
      out.push({ line: p, layers: [{ label: p.text.replace(/\s+/g, ' ').trim(), thicknessCm: null }] });
      used.add(p);
      u0 = Math.min(u0, p.u0);
      u1 = Math.max(u1, p.u1);
    }
    pending.length = 0;
    out.push({ line: next, layers });
    used.add(next);
    prev = next;
    u0 = Math.min(u0, next.u0);
    u1 = Math.max(u1, next.u1);
  }
  return out;
}

/** Renvois et notes écrits dans un bloc (« voir détail », « siehe Plan ») : jamais une couche. */
const NOTE_RE = /\b(?:voir|cf|selon|suivant|siehe|gemass|laut|detail|details|echelle|massstab|coupe|schnitt|plan)\b/;

/** Lignes non reconnues tolérées de suite à l'intérieur d'un bloc. */
const MAX_UNKNOWN_RUN = 2;

/** Une ligne qui pourrait être le libellé d'une couche hors vocabulaire : courte, des lettres, aucun chiffre, pas une pièce. */
function looksLikeUnknownLayer(text: string): boolean {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length >= 3 && s.length < 40 && /^\p{L}/u.test(s) && /\p{L}{3}/u.test(s) && !/\d/.test(s) && !s.includes(':') && !looksLikeRoomName(s) && !NOTE_RE.test(fold(s));
}

/**
 * Blocs de composition d'une liste de lignes : chaque titre « Composition … : » et les couches empilées dessous
 * (une couche par ligne, ou plusieurs sur la ligne du titre « Composition mur : 24 béton + 20 EPS »). Repli : une
 * pile d'au moins 3 lignes de couches avec épaisseur, dont un isolant et une structure, forme un bloc SANS titre.
 */
export function compositionBlocks(lines: readonly SheetLine[], views: readonly ReadView[]): CompositionBlock[] {
  const out: CompositionBlock[] = [];
  const used = new Set<SheetLine>();
  const make = (header: string, kind: HeaderKind, first: SheetLine, rows: { line: SheetLine; layers: { label: string; thicknessCm: number | null }[] }[], inline: ReadLayer[]): void => {
    const layers = [...inline, ...rows.flatMap((r) => r.layers.map((p) => makeLayer(r.layers.length > 1 ? p.label : r.line.text, p)))];
    if (layers.length === 0) return;
    let box = first.box;
    for (const r of rows) box = grow(box, r.line.box);
    const view = viewAt(views, first.page, lineCenter(first));
    out.push({ header, headerKind: kind, layers, box, page: first.page, viewId: view?.id ?? null, viewKind: view?.kind ?? null, size: first.size });
  };
  for (const h of lines) {
    const f = fold(h.text).trim();
    const m = HEADER_RE.exec(f);
    if (!m) continue;
    used.add(h);
    // Couches écrites sur la ligne du titre, après le deux-points.
    const after = h.text.includes(':') ? h.text.slice(h.text.indexOf(':') + 1).trim() : '';
    const inline = after ? (parseLayers(after, true) ?? []).map((p) => makeLayer(p.label, p)) : [];
    const rows = stackBelow(h, lines, used);
    make(h.text.trim(), headerKindOf(fold(h.text.split(':')[0] ?? h.text)), h, rows, inline);
  }
  // Repli : pile de couches sans titre.
  const ordered = [...lines].sort((a, b) => b.base - a.base);
  for (const l of ordered) {
    if (used.has(l)) continue;
    const p = parseLayer(l.text);
    if (!p || p.thicknessCm === null) continue;
    const tmp = new Set(used);
    tmp.add(l);
    const rows = stackBelow(l, lines, tmp);
    const all = [{ line: l, layers: [p] }, ...rows];
    const keys = all.flatMap((r) => r.layers.map((x) => materialKey(x.label)));
    const thick = all.filter((r) => r.layers.every((x) => x.thicknessCm !== null)).length;
    if (all.length < 3 || thick < 3 || !keys.some(isInsulationKey) || !keys.some(isStructureKey)) continue;
    for (const r of all) used.add(r.line);
    make('', 'none', l, rows, [makeLayer(l.text, p)]);
  }
  return out;
}

// ───────────────────────────── Rôle de la paroi ─────────────────────────────

/** Contexte de typage : pièces écrites près du bloc (même vue) et indices tirés des plans. */
export interface CompositionContext {
  /** Pièces nommées près du bloc, dans la même vue, avec leur distance (uf). */
  roomsNear?: { name: string; dist: number }[];
  /** Les plans montrent un local non chauffé sous des pièces chauffées (garage dans l'emprise, sous-sol). */
  unheatedBelow?: boolean;
  lang?: Lang;
}

export interface ClassifiedComposition {
  element: ElementType;
  /** Couches de l'intérieur vers l'extérieur (plancher : du haut vers le bas), avec `counted` et les doutes. */
  layers: ReadLayer[];
  confidence: number;
  sources: string[];
  doubt: string | null;
}

const GROUND_KEYS: readonly MaterialKey[] = ['empierrement', 'beton-maigre'];
const GROUND_WORD_RE = /radier|sur sol|sur terre|contre terre|bodenplatte|erdreich|gegen erd|erdberuhrt|sauberkeit|empierrement|schotter/;
const PARTY_RE = /mitoyen|trennwand|brandwand|gebaudetrennwand|haustrennwand/;
const UNHEATED_RE = /garage|non chauff|unbeheizt|cave|keller|local technique|technikraum/;
const WALL_GROUND_RE = /contre terre|enterre|gegen erd|erdberuhrt|perimeter|sous-sol|kellerwand|kelleraussenwand/;
const OUTSIDE_FLOOR_RE = /porte-a-faux|sur exterieur|sur l'exterieur|auskragung|gegen aussenluft|uber aussenluft|passage couvert|durchfahrt/;
const CEILING_RE = /combles|grenier|dachboden|speicher|spitzboden/;
const PITCHED_RE = /chevron|sparren|tuile|ardoise|ziegel|liteau|lattung/;
const MIXED_RE = /\s\+\s|\bzw\.|\bzwischen\b|\bentre\b|\bet\b|\bund\b/;
const ACOUSTIC_RE = /acoustique|phonique|trittschall|bruit|akustik/;

const ENVELOPE: readonly ElementType[] = [
  'external-wall',
  'wall-to-unheated',
  'wall-to-ground',
  'floor-on-ground',
  'floor-to-unheated',
  'floor-to-outside',
  'roof',
  'ceiling-to-unheated',
];

/**
 * Rôle thermique d'un bloc et couches remises dans l'ordre du contrat :
 * - titre « mur » → mur extérieur (mitoyen, vers local non chauffé ou contre terre selon les mots du titre) ;
 * - marqueurs de sol (empierrement, béton de propreté, radier) → plancher sur sol ;
 * - isolant, étanchéité ou couverture en tête sans chape au-dessus de la structure (ou chevrons, tuiles) → toiture ;
 * - chape au-dessus, isolant SOUS la structure → plancher sur local non chauffé (garage voisin ou sous-sol sur les
 *   plans), sinon question « local non chauffé ou extérieur ? » ;
 * - chape sur dalle sans isolant dessous → plancher intermédiaire (hors enveloppe).
 */
export function classifyComposition(b: CompositionBlock, ctx: CompositionContext = {}): ClassifiedComposition {
  const lang = ctx.lang ?? 'fr';
  const ballast = ballastIndex(b);
  const keys = b.layers.map((l) => l.material);
  const all = fold(`${b.layers.map((l) => l.label).join(' | ')} ${b.header}`);
  const head = fold(b.header);
  const sources: string[] = [];
  const structIdx = keys.findIndex(isStructureKey);
  const insIdx = keys.flatMap((k, i) => (isInsulationKey(k) ? [i] : []));
  let element: ElementType = 'unknown';
  let confidence = 0.5;
  let doubt: string | null = null;

  const isWallByLayers = b.headerKind !== 'slab' && b.headerKind !== 'roof' && (keys.includes('enduit-facade') || (keys.includes('bardage') && !PITCHED_RE.test(all))) && !keys.includes('chape') && structIdx >= 0;
  if (b.headerKind === 'wall' || isWallByLayers) {
    const titled = b.headerKind === 'wall';
    if (PARTY_RE.test(all)) element = 'party-wall';
    else if (WALL_GROUND_RE.test(all)) element = 'wall-to-ground';
    else if (UNHEATED_RE.test(head)) element = 'wall-to-unheated';
    else if (/cloison|interieur|innenwand/.test(head)) element = 'internal-wall';
    else element = 'external-wall';
    if (titled) {
      sources.push('title-wall');
      confidence = 0.7;
    } else {
      sources.push('layers-wall');
      confidence = 0.6;
    }
    if (insIdx.length > 0 && (keys.includes('enduit-facade') || keys.includes('bardage'))) {
      sources.push('insulation-and-render');
      confidence += 0.2;
    }
  } else {
    // Le lestage de gravier d'une toiture plate n'est pas un marqueur de sol.
    const ground = keys.some((k, i) => GROUND_KEYS.includes(k) && i !== ballast) || GROUND_WORD_RE.test(all);
    const insBelow = structIdx >= 0 && insIdx.some((i) => i > structIdx);
    const k0 = ballast === 0 ? keys[1] : keys[0];
    if (ballast >= 0) sources.push('ballast-on-top');
    const outerKey = (k: MaterialKey | undefined): boolean => k !== undefined && (isInsulationKey(k) || k === 'etancheite' || k === 'bardage');
    // Écrite de haut en bas (extérieur en tête), ou de l'intérieur (plâtre en tête) vers l'extérieur.
    const kLast = ballast === keys.length - 1 ? keys[keys.length - 2] : keys[keys.length - 1];
    // Dans ce second cas, un isolant en queue peut être celui d'un mur : il faut l'étanchéité ou un titre « toiture ».
    const topIsOuter = outerKey(k0) || (keys[0] === 'enduit-platre' && (kLast === 'etancheite' || (b.headerKind === 'roof' && outerKey(kLast))));
    const hasScreed = keys.slice(0, Math.max(0, structIdx)).includes('chape');
    const pitched = PITCHED_RE.test(all);
    if (b.headerKind === 'roof') sources.push('title-roof');
    if (b.viewKind === 'roof-plan') sources.push('view-roof-plan');
    if (ground) {
      element = 'floor-on-ground';
      sources.push('ground-markers');
      confidence = 0.9;
    } else if ((topIsOuter || pitched) && !hasScreed && (structIdx >= 0 || insIdx.length > 0)) {
      element = CEILING_RE.test(head) && !pitched ? 'ceiling-to-unheated' : 'roof';
      sources.push(pitched ? 'pitched-roof-layers' : 'insulation-on-top');
      confidence = b.headerKind === 'roof' ? 0.95 : 0.8;
    } else if (hasScreed && insBelow) {
      if (OUTSIDE_FLOOR_RE.test(all)) {
        element = 'floor-to-outside';
        sources.push('insulation-below', 'title-outside');
        confidence = 0.8;
      } else {
        element = 'floor-to-unheated';
        sources.push('insulation-below');
        const near = (ctx.roomsNear ?? []).filter((r) => isOutsideEnvelopeName(r.name) || UNHEATED_RE.test(fold(r.name))).sort((x, y) => x.dist - y.dist)[0];
        if (near) {
          sources.push('unheated-room-near');
          confidence = 0.8;
        } else if (ctx.unheatedBelow) {
          sources.push('unheated-room-on-plans');
          confidence = 0.7;
        } else {
          confidence = 0.5;
          doubt = t(lang, 'read.comp.floorBelow');
        }
      }
    } else if (hasScreed && structIdx >= 0) {
      element = 'intermediate-floor';
      sources.push('screed-on-slab');
      confidence = 0.8;
    }
    if (b.headerKind === 'roof' && element !== 'roof' && element !== 'ceiling-to-unheated') {
      doubt = t(lang, 'read.comp.titleConflict', { header: b.header });
      confidence = 0.4;
    } else if (element === 'roof' && b.headerKind === 'slab') {
      // Titre « dalle » contredit par les matériaux : les matériaux décident, la confiance reste celle d'une source.
      sources.push('title-contradicted');
    }
  }
  if (element === 'unknown') {
    confidence = 0.3;
    doubt = b.header ? t(lang, 'read.comp.unknown', { header: b.header }) : t(lang, 'read.comp.untitled');
  } else if (b.headerKind === 'none') {
    confidence = Math.min(confidence, 0.6);
    doubt ??= t(lang, 'read.comp.untitled');
  }

  // Ordre du contrat : mur et toiture de l'intérieur vers l'extérieur, plancher du haut vers le bas.
  let layers = b.layers.map((l) => ({ ...l }));
  if (element.endsWith('wall')) layers = outerRender(layers);
  const first = layers[0]?.material;
  const last = layers[layers.length - 1]?.material;
  const outer = (k: MaterialKey | undefined): boolean => k === 'enduit-facade' || k === 'bardage' || k === 'etancheite' || k === 'empierrement';
  if (element === 'roof' || element === 'ceiling-to-unheated') {
    // Écrite de haut en bas (extérieur d'abord) : on la retourne, sauf si elle commence déjà par la finition intérieure.
    if (first !== undefined && first !== 'enduit-platre' && (outer(first) || isInsulationKey(first) || first === 'lame-air' || last === 'enduit-platre')) layers.reverse();
  } else if (element.endsWith('wall')) {
    if (outer(first) || (last === 'enduit-platre' && first !== 'enduit-platre')) layers.reverse();
  } else if (element === 'floor-on-ground' || element.startsWith('floor') || element === 'intermediate-floor') {
    // Écrit de bas en haut (empierrement d'abord) : on le retourne.
    if (first === 'empierrement' || first === 'beton-maigre' || (last === 'revetement-sol' && first !== 'revetement-sol')) layers.reverse();
  }

  // Couches hors calcul thermique.
  if (element === 'floor-on-ground') {
    const lastIns = layers.reduce((acc, l, i) => (isInsulationKey(l.material) ? i : acc), -1);
    if (lastIns >= 0) layers = layers.map((l, i) => (i > lastIns ? { ...l, counted: false } : l));
  }
  layers = layers.map((l) => (l.material === 'film' && l.thicknessCm === null ? { ...l, counted: false } : l));
  const air = layers.findIndex((l) => l.material === 'lame-air');
  if (air >= 0) layers = layers.map((l, i) => (i >= air ? { ...l, counted: false } : l));
  // Couverture ventilée (tuiles, bardage) en face extérieure : elle et ses lattes, jusqu'au dernier isolant, ne
  // comptent pas (lame d'air sous la couverture).
  // Lestage (gravier) sur l'étanchéité d'une toiture plate : hors calcul.
  if (element === 'roof' && ballast >= 0) {
    const outerIdx = layers.length - 1;
    const o = layers[outerIdx];
    if (o && o.material === 'empierrement') layers = layers.map((l, i) => (i === outerIdx ? { ...l, counted: false } : l));
  }
  const lastLayer = layers[layers.length - 1];
  if (air < 0 && lastLayer && lastLayer.material === 'bardage' && (element === 'roof' || element.endsWith('wall'))) {
    const lastIns = layers.reduce((acc, l, i) => (isInsulationKey(l.material) ? i : acc), -1);
    layers = layers.map((l, i) => (i > lastIns && !isInsulationKey(l.material) ? { ...l, counted: false } : l));
  }

  // Matériau non reconnu : toujours une question (même hors calcul : c'est peut-être un isolant).
  layers = layers.map((l) => (l.material === 'inconnu' ? { ...l, doubt: t(lang, 'read.comp.unknownMaterial', { label: l.label }) } : l));
  // Autres doutes par couche (seulement pour les parois de l'enveloppe et les couches comptées).
  if (ENVELOPE.includes(element)) {
    layers = layers.map((l) => {
      if (!l.counted || l.doubt) return l;
      const f = fold(l.label);
      let d: string | null = null;
      if (MIXED_RE.test(f) && materialCount(l.label) >= 2) d = t(lang, 'read.comp.mixed', { label: l.label });
      else if (MIXED_RE.test(f) && /\bzw\.|zwischen|entre/.test(f)) d = t(lang, 'read.comp.mixed', { label: l.label });
      else if (l.material === 'isolant' && !ACOUSTIC_RE.test(f)) d = t(lang, 'read.comp.genericInsulation', { label: l.label });
      else if (l.material === 'beton' && element.endsWith('wall')) d = t(lang, 'read.comp.plainConcrete', { label: l.label });
      else if (l.thicknessCm === null && l.material !== 'film' && l.material !== 'etancheite' && l.material !== 'lame-air') d = t(lang, 'read.comp.noThickness', { label: l.label });
      return d ? { ...l, doubt: d } : l;
    });
  }
  return { element, layers, confidence: Math.min(0.98, confidence), sources, doubt };
}

const BALLAST_RE = /gravier|\bkies|lestage|galets|auflast|rundkies/;
const FLOOR_FINISH: readonly MaterialKey[] = ['chape', 'revetement-sol'];

/**
 * Indice (0 ou dernier) d'une couche de gravier qui LESTE une toiture plate, −1 sinon. Le gravier est à une extrémité
 * de la pile, l'autre extrémité n'est pas une finition de sol (chape, revêtement) et rien d'autre n'indique un sol
 * (béton de propreté, radier…). Il faut en plus un signal de toiture indépendant : l'étanchéité posée contre le
 * gravier, ou un titre « toiture » avec un isolant ou une étanchéité contre lui.
 */
function ballastIndex(b: CompositionBlock): number {
  const n = b.layers.length;
  if (n < 3) return -1;
  const ks = b.layers.map((l) => l.material);
  if (ks.includes('beton-maigre') || GROUND_WORD_RE.test(fold(`${b.layers.filter((l) => l.material !== 'empierrement').map((l) => l.label).join(' | ')} ${b.header}`))) return -1;
  for (const [i, j, far] of [
    [0, 1, n - 1],
    [n - 1, n - 2, 0],
  ] as const) {
    const l = b.layers[i]!;
    const nb = ks[j]!;
    if (l.material !== 'empierrement' || !BALLAST_RE.test(fold(l.label)) || FLOOR_FINISH.includes(ks[far]!)) continue;
    if (ks.some((k, x) => x !== i && k === 'empierrement')) continue;
    if (nb === 'etancheite' || (b.headerKind === 'roof' && (isInsulationKey(nb) || nb === 'film'))) return i;
  }
  return -1;
}

/**
 * Mur : un « Enduit » générique (sans « plâtre », « intérieur »…) à une extrémité est l'enduit de FAÇADE quand
 * l'autre extrémité est une finition intérieure précise ou quand un isolant est posé contre lui (isolation par
 * l'extérieur enduite). Repli : rien ne change.
 */
function outerRender(layers: ReadLayer[]): ReadLayer[] {
  const n = layers.length;
  if (n < 2) return layers;
  const generic = (l: ReadLayer): boolean => l.material === 'enduit-platre' && /\benduit\b|\bputz\b/.test(fold(l.label)) && !/platre|gyps|gips|interieur|innen|placo/.test(fold(l.label));
  const interior = (l: ReadLayer): boolean => l.material === 'enduit-platre' && !generic(l);
  for (const [i, j, far] of [
    [0, 1, n - 1],
    [n - 1, n - 2, 0],
  ] as const) {
    const l = layers[i]!;
    if (!generic(l)) continue;
    if (interior(layers[far]!) || isInsulationKey(layers[j]!.material)) return layers.map((x, k) => (k === i ? { ...x, material: 'enduit-facade' } : x));
  }
  return layers;
}

/** Nombre de familles de matériaux différentes citées dans un libellé (« Chape + béton cellulaire » → 2). */
function materialCount(label: string): number {
  const f = fold(label);
  const keys = new Set<MaterialKey>();
  for (const m of MATERIALS) if (m.re.test(f)) keys.add(m.key);
  // « Isolation type EPS » : le mot générique et le type précis sont un seul matériau.
  if (keys.has('isolant') && [...keys].some((k) => k !== 'isolant' && isInsulationKey(k))) keys.delete('isolant');
  if (keys.has('beton') && (keys.has('beton-arme') || keys.has('bloc-beton') || keys.has('beton-maigre'))) keys.delete('beton');
  if (keys.has('enduit-platre') && keys.has('enduit-facade')) keys.delete('enduit-platre');
  if (keys.has('bois') && keys.has('fibre-bois')) keys.delete('bois');
  return keys.size;
}

// ───────────────────────────── Dédoublonnage ─────────────────────────────

const signature = (l: ReadLayer): string => `${l.material}:${l.thicknessCm ?? '-'}`;

/** `small` est-elle une suite contiguë de `big` ? */
function isSubRun(small: readonly string[], big: readonly string[]): boolean {
  if (small.length > big.length) return false;
  for (let i = 0; i + small.length <= big.length; i++) if (small.every((s, j) => s === big[i + j])) return true;
  return false;
}

/**
 * Un même bloc répété (plans, coupes, pages) → une composition : même rôle ET mêmes couches (famille + épaisseur),
 * ou l'une suite contiguë de l'autre (un plan omet souvent l'enduit intérieur) ; on garde la plus complète, chaque
 * répétition ajoute 0,05 à la confiance (plafond 0,98). Des couches différentes restent des variantes distinctes.
 */
export function dedupeCompositions(items: readonly { block: CompositionBlock; classified: ClassifiedComposition }[]): ReadComposition[] {
  const out: ReadComposition[] = [];
  const sorted = [...items].sort((a, b) => b.classified.layers.length - a.classified.layers.length);
  for (const it of sorted) {
    const sig = it.classified.layers.map(signature);
    const occurrence = { viewId: it.block.viewId, header: it.block.header, page: it.block.page, box: it.block.box };
    const host = out.find((o) => o.element === it.classified.element && isSubRun(sig, o.layers.map(signature)));
    if (host) {
      host.occurrences.push(occurrence);
      host.confidence = Math.min(0.98, Math.round((host.confidence + 0.05) * 100) / 100);
      // Un titre qui ne doute pas l'emporte : la répétition confirme le rôle.
      if (host.doubt && !it.classified.doubt) {
        host.doubt = null;
        host.confidence = Math.max(host.confidence, it.classified.confidence);
      }
      continue;
    }
    out.push({ id: '', element: it.classified.element, layers: it.classified.layers, occurrences: [occurrence], confidence: it.classified.confidence, doubt: it.classified.doubt });
  }
  // Ordre de lecture stable : par page puis de haut en bas ; identifiants dans cet ordre.
  out.sort((a, b) => (a.occurrences[0]!.page ?? 0) - (b.occurrences[0]!.page ?? 0) || (a.occurrences[0]!.box?.minY ?? 0) - (b.occurrences[0]!.box?.minY ?? 0));
  out.forEach((c, i) => {
    c.id = `comp-${i + 1}-${c.element}`;
    c.occurrences.sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || (a.box?.minY ?? 0) - (b.box?.minY ?? 0));
  });
  return out;
}

// ───────────────────────────── Lecture complète ─────────────────────────────

/** Distance au-delà de laquelle une pièce n'est plus « voisine » d'un bloc, en corps du bloc. */
const ROOM_NEAR_SIZES = 25;

export interface RoomHint {
  name: string;
  at: Vec2;
  page: number;
  viewId: string | null;
}

/**
 * Compositions écrites sur un ensemble de lignes (toutes pages confondues) : blocs, rôle, ordre, couches hors calcul,
 * doutes, dédoublonnage. `rooms` : pièces lues sur les plans (garage dans l'emprise → plancher sur local non chauffé).
 */
export function readCompositions(lines: readonly SheetLine[], views: readonly ReadView[], opts: { lang?: Lang; rooms?: readonly RoomHint[] } = {}): ReadComposition[] {
  const blocks = compositionBlocks(lines, views);
  // Pièces nommées dans les vues (coupes comprises) : les textes courts du vocabulaire des pièces.
  const named = lines.filter((l) => looksLikeRoomName(l.text) && !parseLayer(l.text) && !isCompositionHeader(l.text)).map((l) => ({ name: l.text, at: lineCenter(l), page: l.page, viewId: viewAt(views, l.page, lineCenter(l))?.id ?? null }));
  const rooms = opts.rooms ?? [];
  const planIds = new Set(views.filter((v) => v.kind === 'floor-plan').map((v) => v.id));
  const garageOnPlans = rooms.some((r) => r.viewId !== null && planIds.has(r.viewId) && UNHEATED_RE.test(fold(r.name)) && !/terrasse|balcon|balkon|loggia/.test(fold(r.name)));
  const basement = views.some((v) => v.kind === 'floor-plan' && v.storeyRank !== null && v.storeyRank < 0);
  const items = blocks.map((block) => {
    const c = { x: (block.box.minX + block.box.maxX) / 2, y: (block.box.minY + block.box.maxY) / 2 };
    const roomsNear = named
      .filter((r) => r.page === block.page && r.viewId === block.viewId)
      .map((r) => ({ name: r.name, dist: Math.hypot(r.at.x - c.x, r.at.y - c.y) }))
      .filter((r) => r.dist < ROOM_NEAR_SIZES * block.size);
    const ctx: CompositionContext = { roomsNear, unheatedBelow: garageOnPlans || basement };
    if (opts.lang) ctx.lang = opts.lang;
    return { block, classified: classifyComposition(block, ctx) };
  });
  return dedupeCompositions(items);
}
