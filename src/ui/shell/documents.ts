/**
 * Documents lus : espace de noms des feuilles, proposition d'étages (« voici ce que j'ai lu ») et construction du
 * bâtiment une fois la proposition acceptée ou ajustée. Fonctions pures (aucun accès au navigateur).
 *
 * Pourquoi un espace de noms : chaque lecteur numérote ses feuilles à sa façon (« p1 », « cad-1 », « image »), et
 * deux fichiers déposés ensemble (un PDF par étage) auraient les mêmes identifiants. Ici, l'identifiant d'une
 * feuille devient « nom du fichier#identifiant » : il reste stable si l'on redépose le même fichier plus tard,
 * ce qui permet de retrouver le fond de plan d'un projet rouvert.
 */
import type { BottomKind, Lang, PlanDocument, PlanSheet, Project, Sourced } from '../../core/types';
import { basementSheetIds, createEmptyProject, createStorey, modelFromDocument, proposeHeatedOutline, proposeTopClosure } from '../../engine';
import { t } from '../../i18n';
import { isOutlineUnheatedNote } from '../../readers/notes';
import { guessStorey } from '../../semantics/labels';
import type { LoadedDocument } from './types';

const SEPARATOR = '#';

export function sheetKey(fileName: string, sheetId: string): string {
  return `${fileName}${SEPARATOR}${sheetId}`;
}

/** Copie du document dont les feuilles portent un identifiant unique entre fichiers. Idempotent. */
export function namespaceDocument(doc: PlanDocument): PlanDocument {
  const prefix = `${doc.fileName}${SEPARATOR}`;
  return {
    ...doc,
    sheets: doc.sheets.map((s) => (s.id.startsWith(prefix) ? s : { ...s, id: sheetKey(doc.fileName, s.id) })),
  };
}

/** Adresses d'objets (blob:) créées par le lecteur pour les fonds matriciels : à libérer quand le document part. */
export function collectObjectUrls(doc: PlanDocument): string[] {
  const urls: string[] = [];
  for (const sheet of doc.sheets) {
    const url = sheet.image?.url;
    if (url && url.startsWith('blob:') && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

export function toLoadedDocument(doc: PlanDocument, signature?: string): LoadedDocument {
  const spaced = namespaceDocument(doc);
  const loaded: LoadedDocument = { id: spaced.fileName, doc: spaced, urls: collectObjectUrls(spaced) };
  if (signature !== undefined) loaded.signature = signature;
  return loaded;
}

/**
 * Empreinte peu coûteuse d'un document lu : taille du fichier si elle est connue, nombre de feuilles, étendue et
 * nombre de traits de chacune. Deux lectures du même fichier donnent la même ; deux plans différents, presque jamais.
 */
export function documentSignature(doc: PlanDocument, byteLength?: number): string {
  const r = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '?');
  const sheets = doc.sheets.map((s) => {
    const b = s.bbox;
    return [s.name, r(b.minX), r(b.minY), r(b.maxX), r(b.maxY), s.segments?.length ?? 0, s.detected.outline?.length ?? 0, s.detected.rooms.length].join(',');
  });
  return [byteLength ?? '?', doc.kind, doc.sheets.length, ...sheets].join('|');
}

/** Nom libre pour un second fichier qui porte le nom d'un fichier déjà chargé : « plan.pdf (2) ». */
export function distinctFileName(fileName: string, taken: readonly string[]): string {
  for (let n = 2; ; n++) {
    const candidate = `${fileName} (${n})`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export interface SheetRef {
  sheet: PlanSheet;
  doc: PlanDocument;
}

export function allSheets(documents: readonly LoadedDocument[]): SheetRef[] {
  return documents.flatMap((d) => d.doc.sheets.map((sheet) => ({ sheet, doc: d.doc })));
}

export function findSheet(documents: readonly LoadedDocument[], sheetId: string | null): PlanSheet | null {
  if (sheetId === null) return null;
  for (const d of documents) {
    const found = d.doc.sheets.find((s) => s.id === sheetId);
    if (found) return found;
  }
  return null;
}

/** Nom du fichier d'où vient une feuille, d'après son identifiant (utile quand le fichier n'est plus chargé). */
export function fileNameOfSheetId(sheetId: string): string {
  const cut = sheetId.lastIndexOf(SEPARATOR);
  return cut > 0 ? sheetId.slice(0, cut) : sheetId;
}

/** Tous les fichiers vus comme un seul document : le moteur trie alors les étages entre fichiers. */
export function combineDocuments(documents: readonly LoadedDocument[]): PlanDocument {
  const docs = documents.map((d) => d.doc);
  const north = docs.find((d) => d.northAngle)?.northAngle;
  const combined: PlanDocument = {
    fileName: docs.map((d) => d.fileName).join(' + '),
    kind: docs[0]?.kind ?? 'manual',
    sheets: docs.flatMap((d) => d.sheets),
    storeysAligned: docs.length === 1 && docs[0]!.storeysAligned,
    warnings: docs.flatMap((d) => d.warnings),
  };
  if (north) combined.northAngle = { ...north };
  return combined;
}

// ───────────────────────────── Proposition d'étages ─────────────────────────────

/**
 * Rôle proposé pour une feuille :
 *  - storey    : étage chauffé (contour trouvé) ;
 *  - basement  : sous-sol reconnu à son nom → proposé NON chauffé (hors volume) ;
 *  - noOutline : pas de contour trouvé → à tracer à la main si c'est bien un étage ;
 *  - used      : déjà utilisée par un étage du projet en cours.
 */
export type SheetRole = 'storey' | 'basement' | 'noOutline' | 'used';

export interface SheetProposal {
  sheetId: string;
  fileName: string;
  sheetName: string;
  role: SheetRole;
  /** Devient un étage chauffé si la proposition est acceptée. */
  include: boolean;
  /** Nom de l'étage proposé (modifiable). */
  name: string;
  /** Nom de l'étage existant qui utilise déjà la feuille (rôle 'used'). */
  usedBy?: string;
  /** Altitude du niveau si le fichier la donne (IFC) : sert à ranger une feuille cochée après coup. */
  elevation?: number;
}

export interface Proposal {
  /**
   * 'replace' : le bâtiment est reconstruit à partir des feuilles cochées.
   * 'append'  : les étages existants sont gardés ; les feuilles cochées s'ajoutent au-dessus.
   */
  mode: 'replace' | 'append';
  /** Feuilles dans l'ordre du bâtiment, du BAS vers le HAUT pour celles qui sont cochées. */
  sheets: SheetProposal[];
  north: Sourced<number> | null;
  storeysAligned: boolean;
}

function proposedName(sheet: PlanSheet, lang: Lang): string {
  const guess = guessStorey(sheet.name);
  return guess ? guess[lang] : sheet.name.trim() || t(lang, 'shell.storey.default.0');
}

/** Nom par défaut d'un étage d'après son rang (0 = le plus bas). */
export function defaultStoreyName(index: number, lang: Lang, taken: readonly string[] = []): string {
  const base = index <= 0 ? t(lang, 'shell.storey.default.0') : index === 1 ? t(lang, 'shell.storey.default.1') : t(lang, 'shell.storey.default.n', { n: index });
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * Proposition à montrer sur l'écran « Voici ce que j'ai lu ».
 * Projet sans étage : on reprend le premier jet du moteur (ordre, noms, sous-sol écarté).
 * Projet déjà tracé : rien n'est coché ; les feuilles servent de fond, l'expert coche celles à ajouter.
 */
export function proposeStoreys(documents: readonly LoadedDocument[], project: Project, lang: Lang, mode?: 'replace' | 'append'): Proposal {
  const refs = allSheets(documents);
  const combined = combineDocuments(documents);
  const effectiveMode = mode ?? (project.model.storeys.length > 0 ? 'append' : 'replace');
  // Sous-sols par leur nom, et niveaux enterrés d'une maquette par leur altitude : proposés non chauffés.
  const basements = basementSheetIds(combined.sheets);

  // Premier jet du moteur ; s'il échoue (module en cours d'écriture), on retombe sur les feuilles avec contour.
  let draft: { sheetId: string; name: string }[];
  try {
    draft = modelFromDocument(combined, lang).storeys.flatMap((s) => (s.sheetId === null ? [] : [{ sheetId: s.sheetId, name: s.name }]));
  } catch {
    draft = refs
      .filter((r) => !basements.has(r.sheet.id) && (r.sheet.detected.outline?.length ?? 0) >= 3)
      .map((r) => ({ sheetId: r.sheet.id, name: proposedName(r.sheet, lang) }));
  }

  const usedBy = new Map<string, string>();
  if (effectiveMode === 'append') {
    for (const s of project.model.storeys) if (s.sheetId !== null) usedBy.set(s.sheetId, s.name);
  }

  const byId = new Map(refs.map((r) => [r.sheet.id, r]));
  const sheets: SheetProposal[] = [];
  const seen = new Set<string>();

  const push = (ref: SheetRef, role: SheetRole, include: boolean, name: string): void => {
    seen.add(ref.sheet.id);
    const used = usedBy.get(ref.sheet.id);
    if (used !== undefined) {
      sheets.push({ sheetId: ref.sheet.id, fileName: ref.doc.fileName, sheetName: ref.sheet.name, role: 'used', include: false, name: used, usedBy: used });
      return;
    }
    const entry: SheetProposal = {
      sheetId: ref.sheet.id,
      fileName: ref.doc.fileName,
      sheetName: ref.sheet.name,
      role,
      include: effectiveMode === 'append' ? false : include,
      name,
    };
    if (ref.sheet.detected.elevation !== undefined) entry.elevation = ref.sheet.detected.elevation;
    sheets.push(entry);
  };

  for (const d of draft) {
    const ref = byId.get(d.sheetId);
    if (ref) push(ref, 'storey', true, d.name);
  }
  // Aucun contour trouvé nulle part (scan, image) : on propose quand même la première feuille, à tracer.
  const nothingFound = draft.length === 0;
  let firstTaken = false;
  for (const ref of refs) {
    if (seen.has(ref.sheet.id)) continue;
    if (basements.has(ref.sheet.id)) {
      push(ref, 'basement', false, proposedName(ref.sheet, lang));
      continue;
    }
    const include = nothingFound && !firstTaken;
    if (include) firstTaken = true;
    push(ref, 'noOutline', include, proposedName(ref.sheet, lang));
  }

  return {
    mode: effectiveMode,
    sheets,
    north: combined.northAngle ? { ...combined.northAngle } : null,
    storeysAligned: combined.storeysAligned,
  };
}

/** Fermeture basse qui découle de la proposition : un sous-sol écarté = plancher sur local non chauffé. */
export function proposedBottomKind(proposal: Proposal): BottomKind {
  return proposal.sheets.some((s) => s.role === 'basement' && !s.include) ? 'above-unheated' : 'slab-on-ground';
}

export function includedSheets(proposal: Proposal): SheetProposal[] {
  return proposal.sheets.filter((s) => s.include);
}

/** Vrai si le niveau `a` est au-dessus du niveau `b`, d'après les altitudes ou, à défaut, les noms reconnus. */
function isAbove(a: SheetProposal, b: SheetProposal): boolean {
  if (a.elevation !== undefined && b.elevation !== undefined) return a.elevation > b.elevation;
  const ra = guessStorey(a.sheetName)?.rank;
  const rb = guessStorey(b.sheetName)?.rank;
  return ra !== undefined && rb !== undefined && ra > rb;
}

/**
 * Coche ou décoche une feuille. Une feuille cochée après coup (sous-sol chauffé, niveau sans contour) prend sa
 * place dans la pile — sous le premier étage coché qui est au-dessus d'elle — au lieu de se poser sur la toiture.
 */
export function toggleProposalSheet(proposal: Proposal, sheetId: string, include: boolean): Proposal {
  const sheets = proposal.sheets.map((s) => (s.sheetId === sheetId && s.role !== 'used' ? { ...s, include } : s));
  const moved = sheets.find((s) => s.sheetId === sheetId);
  if (include && moved && moved.include) {
    const others = sheets.filter((s) => s !== moved);
    const at = others.findIndex((s) => s.include && isAbove(s, moved));
    if (at >= 0) {
      others.splice(at, 0, moved);
      return { ...proposal, sheets: others };
    }
  }
  return { ...proposal, sheets };
}

export function renameProposalSheet(proposal: Proposal, sheetId: string, name: string): Proposal {
  return { ...proposal, sheets: proposal.sheets.map((s) => (s.sheetId === sheetId ? { ...s, name } : s)) };
}

/** Monte (+1) ou descend (−1) une feuille cochée parmi les feuilles cochées. */
export function moveProposalSheet(proposal: Proposal, sheetId: string, delta: -1 | 1): Proposal {
  const included = proposal.sheets.filter((s) => s.include);
  const from = included.findIndex((s) => s.sheetId === sheetId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= included.length) return proposal;
  const a = included[from]!;
  const b = included[to]!;
  const ia = proposal.sheets.indexOf(a);
  const ib = proposal.sheets.indexOf(b);
  const sheets = [...proposal.sheets];
  sheets[ia] = b;
  sheets[ib] = a;
  return { ...proposal, sheets };
}

/**
 * Construit le projet à partir de la proposition acceptée.
 * Les réponses déjà données, les types d'éléments et tout ce que l'expert a confirmé (toiture, plancher, nord) sont gardés.
 */
export function applyProposal(proposal: Proposal, documents: readonly LoadedDocument[], base: Project, lang: Lang): Project {
  const fresh = createEmptyProject(lang).model;
  const model = {
    ...base.model,
    storeys: proposal.mode === 'append' ? [...base.model.storeys] : [],
  };
  if (model.constructions.length === 0) model.constructions = fresh.constructions;
  if (model.windowTypes.length === 0) model.windowTypes = fresh.windowTypes;

  for (const p of includedSheets(proposal)) {
    const sheet = findSheet(documents, p.sheetId);
    if (!sheet) continue;
    const taken = model.storeys.map((s) => s.name);
    const wanted = p.name.trim() || defaultStoreyName(model.storeys.length, lang, taken);
    const name = taken.includes(wanted) ? uniqueAmong(wanted, taken) : wanted;
    model.storeys = [...model.storeys, createStorey(sheet, name, model)];
  }

  if (proposal.mode === 'replace') {
    model.storeysAligned = proposal.storeysAligned;
    if (base.model.bottom.from !== 'user') {
      model.bottom = { kind: proposedBottomKind(proposal), constructionId: base.model.bottom.constructionId, from: 'default' };
    }
    if (base.model.top.from !== 'user') {
      // Dernier étage aux murs de hauteurs inégales (maquette) : la toiture inclinée proposée par le moteur, à confirmer.
      const last = model.storeys[model.storeys.length - 1] ?? null;
      const proposedTop = proposeTopClosure(last ? findSheet(documents, last.sheetId) : null, last);
      model.top = proposedTop ?? { ...fresh.top, constructionId: base.model.top.constructionId };
    }
  } else if (includedSheets(proposal).length > 0) {
    // Des étages venus d'autres fichiers ne sont pas forcément superposables.
    model.storeysAligned = false;
  }
  if (proposal.north && base.model.northAngle.from !== 'user') model.northAngle = { ...proposal.north };

  return { ...base, model };
}

function uniqueAmong(name: string, taken: readonly string[]): string {
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.includes(candidate)) return candidate;
  }
}

// ───────────────────────────── Résumés pour l'affichage ─────────────────────────────

export type ScaleBadge = 'confirmed' | 'toCheck' | 'unknown';

/** Échelle : confirmée (indices concordants ou validée), à vérifier (indice isolé), inconnue. */
export function scaleBadge(scale: Sourced<number> | null): ScaleBadge {
  if (!scale || !(scale.value > 0)) return 'unknown';
  return scale.from === 'estimate' || scale.from === 'default' ? 'toCheck' : 'confirmed';
}

/** Mètres par point PDF (1/72 de pouce). */
const METRES_PER_POINT = 0.0254 / 72;
const USUAL_SCALES = [10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000];

/**
 * Dénominateur d'échelle papier (« 1:100 ») quand la feuille est un PDF et que la valeur tombe sur une échelle
 * courante à 1,5 % près ; null sinon.
 */
export function paperScale(kind: PlanDocument['kind'], metresPerUnit: number): number | null {
  if (kind !== 'pdf' || !(metresPerUnit > 0)) return null;
  const denominator = metresPerUnit / METRES_PER_POINT;
  for (const usual of USUAL_SCALES) if (Math.abs(denominator - usual) / usual <= 0.015) return usual;
  return null;
}

export interface SheetSummary {
  roomCount: number;
  /** Somme des surfaces de pièces connues (m²). */
  roomArea: number;
  roomsToDecide: number;
  windowCount: number;
  doorCount: number;
  hasOutline: boolean;
  /** Locaux que le contour chauffé proposé laisse dehors (garage accolé…). */
  leftOutside: string[];
  /** Locaux non chauffés d'après leur nom, restés dans le contour : à trancher par l'expert. */
  keptInside: string[];
  /** Nombre de points du contour qui sera proposé : le contour chauffé s'il diffère de l'emprise lue. */
  outlinePoints: number;
  /** Remarques du lecteur à montrer : sans celle qui demande de retirer un local que la proposition retire déjà. */
  notes: string[];
}

export function summarizeSheet(sheet: PlanSheet): SheetSummary {
  const d = sheet.detected;
  const proposal = d.outline && sheet.metresPerUnit ? proposeHeatedOutline(d.outline, d.rooms, sheet.metresPerUnit.value) : null;
  return {
    roomCount: d.rooms.length,
    roomArea: d.rooms.reduce((sum, r) => sum + (r.statedArea ?? r.measuredArea ?? 0), 0),
    roomsToDecide: d.rooms.filter((r) => r.heatedGuess === 'ask').length,
    windowCount: d.openings.filter((o) => o.kind !== 'door' && o.exterior !== false).length,
    doorCount: d.openings.filter((o) => o.kind === 'door' && o.exterior !== false).length,
    hasOutline: (d.outline?.length ?? 0) >= 3,
    leftOutside: proposal?.removed.map((r) => r.name || '?') ?? [],
    keptInside: proposal?.kept.map((name) => name || '?') ?? [],
    outlinePoints: (proposal?.outline ?? d.outline)?.length ?? 0,
    // La consigne « à retirer du contour » est déjà suivie quand la proposition laisse ces locaux dehors
    // et qu'il n'en reste aucun à trancher à l'intérieur.
    notes: proposal && proposal.removed.length > 0 && proposal.kept.length === 0 ? d.notes.filter((note) => !isOutlineUnheatedNote(note)) : d.notes,
  };
}
