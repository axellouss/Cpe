/**
 * Reconnaissance du cartouche d'une page : son vocabulaire (« Projet », « Plan », « Date », « Échelle »…) et sa
 * place habituelle, dans un angle du cadre de la feuille. Un cartouche dessiné au trait de mur ressemble à une
 * vue fermée ; ses intitulés de case (« Plan ») ressemblent à des titres de vue. Ni l'un ni l'autre n'en est un.
 */
import type { Read, ReadTitleBlock } from '../../core/reading';
import type { BBox, BuildingType, Lang, Occasion } from '../../core/types';
import { registerMessages, t, type Dictionary } from '../../i18n';
import { fold, inBox, lineCenter, parseScaleText, type SheetLine } from '../../semantics/labels';
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

// ───────────────────────────── Lecture des champs du cartouche ─────────────────────────────

const MESSAGES: Dictionary = {
  fr: {
    'read.tb.type': 'Type de bâtiment (maison unifamiliale ou immeuble collectif) et nombre de logements ?',
    'read.tb.dwellings': 'Immeuble collectif : combien de logements ?',
    'read.tb.twoFamily': 'Maison à deux logements : la traiter comme immeuble collectif (2 logements) ?',
    'read.tb.existing': 'Projet sur un bâtiment existant : CPE « bâtiment neuf » (partie neuve) ou « bâtiment existant » ?',
    'read.tb.occasion': 'Type de preuve : bâtiment neuf (autorisation de bâtir) ou bâtiment existant ?',
    'read.tb.occasionWeak': 'Objet « construction » sans phase écrite : bâtiment neuf, à confirmer.',
    'read.tb.address': 'Adresse du bâtiment ?',
    'read.tb.addressOther': 'Adresse du bâtiment : aucune sous « Adresse » ; {n} adresse(s) lue(s) sous d’autres intitulés (maître d’ouvrage, commune, architecte). Laquelle ?',
    'read.tb.addressFree': 'Adresse du bâtiment lue sans intitulé : à confirmer.',
  },
  de: {
    'read.tb.type': 'Gebäudeart (Einfamilienhaus oder Mehrfamilienhaus) und Anzahl Wohnungen?',
    'read.tb.dwellings': 'Mehrfamilienhaus: wie viele Wohnungen?',
    'read.tb.twoFamily': 'Zweifamilienhaus: als Mehrfamilienhaus (2 Wohnungen) behandeln?',
    'read.tb.existing': 'Projekt an einem Bestandsgebäude: Energiepass „Neubau“ (neuer Teil) oder „Bestand“?',
    'read.tb.occasion': 'Art des Nachweises: Neubau (Baugenehmigung) oder Bestandsgebäude?',
    'read.tb.occasionWeak': 'Vorhaben „Neubau“ ohne angegebene Planungsphase: Neubau, bitte bestätigen.',
    'read.tb.address': 'Adresse des Gebäudes?',
    'read.tb.addressOther': 'Adresse des Gebäudes: keine unter „Adresse“; {n} Adresse(n) unter anderen Überschriften (Bauherr, Gemeinde, Architekt). Welche?',
    'read.tb.addressFree': 'Adresse des Gebäudes ohne Überschrift gelesen: bitte bestätigen.',
  },
};
registerMessages(MESSAGES);

export type TitleBlockRole =
  | 'project'
  | 'phase'
  | 'address'
  | 'parcel'
  | 'date'
  | 'format'
  | 'scale'
  | 'index'
  | 'titles'
  | 'owner'
  | 'commune'
  | 'architect'
  | 'drawer'
  | 'changes'
  | 'number';

/** Intitulés de case (texte replié, sans le deux-points final). */
const KEYS: { role: TitleBlockRole; re: RegExp }[] = [
  { role: 'number', re: /^(?:n° de projet|no de projet|n° projet|projet n°|n° du projet|projekt-?nr\.?|projektnummer|plan n°|n° de plan|plan-?nr\.?|blatt-?nr\.?)$/ },
  { role: 'project', re: /^(?:projet|objet|objet du projet|objekt|bauvorhaben|projekt|vorhaben|affaire|intitule)$/ },
  { role: 'phase', re: /^(?:phase|leistungsphase|planungsphase|stade|planstand)$/ },
  { role: 'address', re: /^(?:adresse|adresse du projet|adresse du chantier|lieu|situation|bauort|baustelle|lage|emplacement|standort)$/ },
  { role: 'parcel', re: /^(?:parcelles?|parzellen?|flur|kataster|cadastre|n° cadastral|flurstuck)$/ },
  { role: 'date', re: /^(?:date|datum|date du plan)$/ },
  { role: 'format', re: /^(?:format|blattgrosse|blattformat)$/ },
  { role: 'scale', re: /^(?:echelle|massstab|ech\.?|m)$/ },
  { role: 'index', re: /^(?:indice|index|revision|rev\.?)$/ },
  { role: 'titles', re: /^(?:titres?|plan|planinhalt|inhalt|contenu)$/ },
  { role: 'owner', re: /^(?:maitres? d'ouvrage|maitre de l'ouvrage|mo|bauherr|bauherrschaft|auftraggeber|client|proprietaire)$/ },
  { role: 'commune', re: /^(?:administration|administration communale|commune|gemeinde)$/ },
  { role: 'architect', re: /^(?:architectes?|architekt(?:en)?|planverfasser|entwurfsverfasser|auteur du projet)$/ },
  { role: 'drawer', re: /^(?:dessinateur\(trice\)|dessinateur|dessinatrice|dessine|dessine par|gezeichnet|zeichner)$/ },
  { role: 'changes', re: /^(?:modifications?|anderungen?|aenderungen?|revisions)$/ },
];

const FULL_DATE_RE = /(?<![\d.,/])(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?![\d.,/])/;
const POSTCODE_RE = /\b(L)\s?-?\s?(\d{4})\s+(\p{L}[\p{L}'’ .-]*)$/iu;
const FOREIGN_POSTCODE_RE = /^(?:[A-Z]{1,2}-)?(\d{4,5})\s+(\p{Lu}[\p{L}'’ .-]*)$/u;
/**
 * Rue : numéro en tête (« 3, rue … »), mot de voie (« rue », « Strasse »…), ou nom composé allemand ou luxembourgeois
 * suivi du numéro (« Musterstraße 4 », « Haaptstrooss 12a ») ; le texte est replié (ß → ss).
 */
const STREET_RE =
  /^\d{1,4}\s?[a-z]?\s*,?\s+\p{L}|\b(?:rue|route|avenue|allee|place|chemin|boulevard|impasse|quai|cite|op der|um|an der|strasse|str\.|weg|gaass|platz|ring)\b|\p{L}(?:strasse|str\.?|weg|gasse|gaass|strooss|platz|plaz|ring|allee|damm|ufer|pfad|steig|wee)\s*\d{1,4}\s?[a-z]?\b/u;
/** Intitulés dont la valeur peut continuer sur les lignes du dessous quand elle commence sur la ligne de l'intitulé. */
const MULTILINE_ROLES: ReadonlySet<TitleBlockRole> = new Set<TitleBlockRole>(['project', 'address', 'parcel', 'owner', 'commune', 'architect']);

function roleOfKey(text: string): TitleBlockRole | null {
  const f = fold(text).replace(/\s*:\s*$/, '').trim();
  return KEYS.find((k) => k.re.test(f))?.role ?? null;
}

/** Champ du cartouche : son intitulé et les valeurs écrites dessous (ou à sa suite sur la même ligne). */
export interface TitleBlockField {
  role: TitleBlockRole;
  key: string;
  /** Boîte de l'intitulé. */
  keyBox: BBox;
  values: string[];
}

/** Ce que le cartouche dit en plus du contrat : champs, et toutes les adresses avec leur intitulé. */
export interface TitleBlockDetails {
  fields: TitleBlockField[];
  addresses: { under: TitleBlockRole | 'free'; street: string | null; postcode: string; locality: string }[];
  /** Confiance de l'adresse du projet (0 si aucune). */
  addressConfidence: number;
  owner: string[];
  commune: string | null;
  architect: string[];
  /** Doutes à poser (adresse, type, preuve), dans la langue demandée. */
  doubts: string[];
}

function rd<T>(value: T, confidence: number, sources: string[], doubt: string | null, box?: BBox, page?: number): Read<T> {
  const ev = sources.map((source) => {
    const e: { source: string; box?: BBox; page?: number } = { source };
    if (box) e.box = box;
    if (page !== undefined) e.page = page;
    return e;
  });
  return { value, confidence, evidence: ev, doubt };
}

interface KeyLine {
  line: SheetLine;
  role: TitleBlockRole;
  inline: string | null;
}

/**
 * Champs du cartouche. Intitulé = ligne horizontale dont le texte (sans le deux-points final) est un intitulé connu,
 * finie par « : » ou courte ; ou « Intitulé : valeur » sur une seule ligne. Valeurs d'un intitulé seul : les lignes
 * de sa COLONNE (de son bord gauche − 1 corps jusqu'au prochain intitulé à sa droite sur la même rangée) dont le
 * centre est plus bas, jusqu'au prochain intitulé en dessous ; la première à moins de 4 corps, puis tant que
 * l'interligne reste sous 2,5 corps.
 */
export function titleBlockFields(lines: readonly SheetLine[], box: BBox | null): TitleBlockField[] {
  const inTb = lines.filter((l) => !box || inBox(box, lineCenter(l)));
  const keys: KeyLine[] = [];
  for (const l of inTb) {
    if (Math.abs(l.angle) > 1) continue;
    const whole = roleOfKey(l.text);
    if (whole && (/:\s*$/.test(l.text) || l.text.length < 20)) {
      keys.push({ line: l, role: whole, inline: null });
      continue;
    }
    const m = /^([^:]{1,30}?)\s*:\s*(.+)$/.exec(l.text);
    if (m) {
      const role = roleOfKey(m[1]!);
      if (role) keys.push({ line: l, role, inline: m[2]!.trim() });
    }
  }
  const keySet = new Set(keys.map((k) => k.line));
  const fields: TitleBlockField[] = [];
  for (const k of keys) {
    const kl = k.line;
    const s = kl.size;
    const keyText = k.inline === null ? kl.text : kl.text.slice(0, kl.text.indexOf(':') + 1);
    if (k.inline !== null && !MULTILINE_ROLES.has(k.role)) {
      fields.push({ role: k.role, key: keyText.trim(), keyBox: kl.box, values: [k.inline] });
      continue;
    }
    const right = keys.filter((o) => o !== k && o.line.box.minX > kl.box.minX + s && Math.abs(o.line.box.minY - kl.box.minY) < 3 * s).map((o) => o.line.box.minX);
    const xMax = right.length > 0 ? Math.min(...right) - 0.5 * s : Infinity;
    const below = keys
      .filter((o) => o !== k && o.line.box.minY > kl.box.maxY && o.line.box.minX < xMax && o.line.box.maxX > kl.box.minX - s)
      .map((o) => o.line.box.minY);
    const yMax = below.length > 0 ? Math.min(...below) : kl.box.maxY + 60 * s;
    const candidates = inTb
      .filter((o) => !keySet.has(o) && o.box.minX >= kl.box.minX - s && o.box.minX < xMax)
      .filter((o) => lineCenter(o).y > lineCenter(kl).y + 0.3 * s && o.box.minY < yMax - 0.3 * s && o.box.minY - kl.box.maxY < 40 * s)
      .sort((a, b) => a.box.minY - b.box.minY || a.box.minX - b.box.minX);
    // « Adresse: Musterstraße 4 » puis « L-1234 Ort » dessous : la valeur commencée sur la ligne continue.
    const values: string[] = k.inline !== null ? [k.inline] : [];
    let prevBottom = kl.box.maxY;
    for (let i = 0; i < candidates.length; i++) {
      const o = candidates[i]!;
      const gap = o.box.minY - prevBottom;
      const limit = i === 0 ? (k.inline !== null ? 2.5 : 4) * Math.max(s, o.size) : 2.5 * Math.max(o.size, candidates[i - 1]!.size);
      if (gap > limit) break;
      values.push(o.text);
      prevBottom = Math.max(prevBottom, o.box.maxY);
    }
    fields.push({ role: k.role, key: (k.inline !== null ? keyText : kl.text).trim(), keyBox: kl.box, values });
  }
  return fields;
}

function postcodeOf(v: string): { postcode: string; locality: string } | null {
  const m = POSTCODE_RE.exec(v.trim());
  if (m) return { postcode: `L-${m[2]!}`, locality: m[3]!.trim() };
  const f = FOREIGN_POSTCODE_RE.exec(v.trim());
  return f ? { postcode: f[1]!, locality: f[2]!.trim() } : null;
}

/**
 * Cartouche lu : objet, phase, type de bâtiment et logements, bâtiment neuf ou existant, adresse du PROJET (distincte
 * de celles du maître d'ouvrage, de la commune et de l'architecte), date et année, indice, échelle, format.
 */
export function readTitleBlock(lines: readonly SheetLine[], box: BBox | null, opts: { lang?: Lang; page?: number } = {}): { titleBlock: ReadTitleBlock; details: TitleBlockDetails } {
  const lang = opts.lang ?? 'fr';
  const fields = titleBlockFields(lines, box);
  const doubts: string[] = [];
  const get = (r: TitleBlockRole): string[] => fields.filter((f) => f.role === r).flatMap((f) => f.values);
  const page = opts.page ?? lines[0]?.page ?? null;

  // Adresses : toutes les lignes « L-dddd Localité », avec l'intitulé sous lequel elles sont écrites.
  const addresses: TitleBlockDetails['addresses'] = [];
  for (const f of fields) {
    f.values.forEach((v, i) => {
      const pc = postcodeOf(v);
      if (!pc) return;
      const prev = i > 0 ? f.values[i - 1]! : null;
      const street = prev && STREET_RE.test(fold(prev)) ? prev : null;
      addresses.push({ under: f.role, street, ...pc });
    });
  }
  const tbLines = lines.filter((l) => !box || inBox(box, lineCenter(l)));
  const fieldValues = new Set(fields.flatMap((f) => f.values));
  for (const l of tbLines) {
    if (fieldValues.has(l.text)) continue;
    const pc = postcodeOf(l.text);
    if (pc) addresses.push({ under: 'free', street: null, ...pc });
  }

  // Objet du projet : les valeurs de l'intitulé « projet » avant l'adresse éventuelle qui y est écrite.
  const projectValues = get('project');
  const streetIdx = projectValues.findIndex((v) => STREET_RE.test(fold(v)) || postcodeOf(v) !== null);
  // La ligne juste avant la rue est le nom du projet ou du lot (« Maison Exemple – Lot 7 ») quand l'objet la précède.
  const objectLines = streetIdx < 0 ? projectValues : streetIdx >= 2 ? projectValues.slice(0, streetIdx - 1) : projectValues.slice(0, streetIdx);
  const project = objectLines.join(' ').replace(/\s+/g, ' ').trim() || null;
  const phase = get('phase').join(' ').trim() || null;

  // Type de bâtiment et logements.
  const pf = fold(`${project ?? ''} ${get('titles').join(' ')}`);
  let buildingType: Read<BuildingType> | null = null;
  let dwellings: Read<number> | null = null;
  const nUnits = /(\d{1,3})\s*(?:logements|unites d'habitation|unites|appartements|wohnungen|wohneinheiten|\bwe\b)/.exec(pf);
  if (/unifamil|einfamilien|maison individuelle|single[- ]family/.test(pf) || (/\bmaison\b/.test(pf) && !/bifamil|plurifamil|multifamil|\bmaisons\b|appartement|logements/.test(pf))) {
    buildingType = rd<BuildingType>('EFH', 0.9, ['title-block-object'], null, box ?? undefined, page ?? undefined);
    dwellings = rd(1, 0.9, ['title-block-object'], null, box ?? undefined, page ?? undefined);
  } else if (/bifamil|zweifamilien|deux logements|2 logements/.test(pf)) {
    const d = t(lang, 'read.tb.twoFamily');
    buildingType = rd<BuildingType>('MFH', 0.6, ['title-block-object'], d, box ?? undefined, page ?? undefined);
    dwellings = rd(2, 0.85, ['title-block-object'], null, box ?? undefined, page ?? undefined);
    doubts.push(d);
  } else if (nUnits || /residence|immeuble|plurifamil|multifamil|mehrfamilien|appartements|collectif|wohnanlage/.test(pf)) {
    buildingType = rd<BuildingType>('MFH', nUnits ? 0.85 : 0.7, ['title-block-object'], null, box ?? undefined, page ?? undefined);
    if (nUnits) dwellings = rd(Number(nUnits[1]), 0.85, ['title-block-object'], null, box ?? undefined, page ?? undefined);
    else doubts.push(t(lang, 'read.tb.dwellings'));
  } else doubts.push(t(lang, 'read.tb.type'));

  // Bâtiment neuf ou existant.
  const objectFold = fold(project ?? '');
  const phaseFold = fold(`${phase ?? ''} ${get('changes').join(' ')} ${project ?? ''}`);
  const existing = /transformation|renovation|agrandissement|extension|transformer|reamenagement|reconversion|rehabilitation|umbau|sanierung|anbau|aufstockung|modernisierung|erweiterung/.test(objectFold);
  const permit = /autorisation de (?:batir|construire)|permis de (?:batir|construire)|baugenehmigung|bauantrag|genehmigungsplanung|eingabeplan/.test(phaseFold);
  const newWork = /construction|nouvelle construction|neubau|neu ?bau|errichtung/.test(objectFold);
  let occasion: Read<Occasion> | null = null;
  if (existing) {
    const d = t(lang, 'read.tb.existing');
    occasion = rd<Occasion>('existing', 0.5, ['title-block-object'], d, box ?? undefined, page ?? undefined);
    doubts.push(d);
  } else if (permit) {
    occasion = rd<Occasion>('new', newWork ? 0.9 : 0.75, newWork ? ['title-block-phase', 'title-block-object'] : ['title-block-phase'], null, box ?? undefined, page ?? undefined);
  } else if (newWork) {
    const d = t(lang, 'read.tb.occasionWeak');
    occasion = rd<Occasion>('new', 0.65, ['title-block-object'], d, box ?? undefined, page ?? undefined);
  } else doubts.push(t(lang, 'read.tb.occasion'));

  // Adresse du projet : sous « Adresse », sinon sous l'objet du projet, sinon sans intitulé (à confirmer).
  const own = addresses.find((a) => a.under === 'address') ?? addresses.find((a) => a.under === 'project') ?? null;
  const free = addresses.filter((a) => a.under === 'free' || a.under === 'parcel');
  let street: string | null = null;
  let postcode: string | null = null;
  let locality: string | null = null;
  let addressConfidence = 0;
  if (own) {
    ({ street, postcode, locality } = own);
    addressConfidence = own.under === 'address' ? 0.9 : 0.8;
  } else if (free.length === 1) {
    ({ street, postcode, locality } = free[0]!);
    addressConfidence = 0.5;
    doubts.push(t(lang, 'read.tb.addressFree'));
  } else {
    const others = addresses.filter((a) => a.under !== 'address' && a.under !== 'project').length;
    doubts.push(others > 0 ? t(lang, 'read.tb.addressOther', { n: others }) : t(lang, 'read.tb.address'));
  }

  // Date : sous « Date », hors du tableau des modifications (même rangée qu'un intitulé « Modifications »).
  const dateFields = fields.filter((f) => f.role === 'date' && f.values.some((v) => FULL_DATE_RE.test(v)));
  const changeKeys = tbLines.filter((l) => roleOfKey(l.text) === 'changes');
  const inChanges = (f: TitleBlockField): boolean => changeKeys.some((c) => Math.abs(c.box.minY - f.keyBox.minY) < 2 * c.size);
  const dateField = dateFields.find((f) => !inChanges(f)) ?? dateFields[0] ?? null;
  const date = dateField ? dateField.values.find((v) => FULL_DATE_RE.test(v))!.match(FULL_DATE_RE)![0] : null;
  const ym = date ? FULL_DATE_RE.exec(date) : null;
  const year = ym ? (ym[4]!.length === 2 ? 2000 + Number(ym[4]) : Number(ym[4])) : null;
  const index = get('index').map((v) => v.trim()).find((v) => /^[A-Z]{1,2}\d?$|^\d{1,2}$/.test(v)) ?? null;
  const scaleDen = get('scale').map((v) => parseScaleText(/[:/]/.test(v) ? `échelle ${v}` : v)).find((v) => v !== null) ?? null;
  const format = get('format').map((v) => /^(A[0-4])\b/i.exec(v.trim())?.[1]?.toUpperCase() ?? null).find((v) => v !== null) ?? null;
  const commune = get('commune').join(' ').replace(/.*administration communale\s*(?:de |d'|d’|du )?/i, '').replace(/\s+\d.*$/, '').trim() || null;

  const found = new Set(fields.filter((f) => f.values.length > 0).map((f) => f.role));
  const n = ['project', 'date', 'scale', 'index', 'address', 'owner', 'phase', 'format'].filter((r) => found.has(r as TitleBlockRole)).length;
  const confidence = n >= 4 ? 0.9 : n >= 2 ? 0.7 : n === 1 ? 0.5 : 0.2;
  let tbBox = box;
  if (!tbBox && fields.length > 0) {
    const used = lines.filter((l) => fields.some((f) => f.key === l.text.trim() || f.values.includes(l.text)));
    if (used.length > 0) {
      tbBox = { minX: Math.min(...used.map((l) => l.box.minX)), minY: Math.min(...used.map((l) => l.box.minY)), maxX: Math.max(...used.map((l) => l.box.maxX)), maxY: Math.max(...used.map((l) => l.box.maxY)) };
    }
  }
  const titleBlock: ReadTitleBlock = {
    project,
    phase,
    buildingType,
    dwellings,
    occasion,
    street,
    postcode,
    locality,
    date,
    year,
    index,
    scaleDen,
    format,
    page,
    box: tbBox ?? null,
    confidence,
  };
  return {
    titleBlock,
    details: { fields, addresses, addressConfidence, owner: get('owner'), commune, architect: get('architect'), doubts },
  };
}
