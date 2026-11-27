/**
 * Opérations sur le projet : étages, hauteurs, fermetures haute et basse, réponses, tableaux du mode expert.
 * Toutes PURES : elles renvoient un nouveau projet et ne modifient jamais celui qu'elles reçoivent.
 * Toute valeur saisie ou validée ici prend la provenance 'user' (« saisi ou confirmé par l'expert »).
 */
import type {
  BottomKind,
  Boundary,
  BuildingModel,
  Construction,
  ConstructionCategory,
  Lang,
  ManualRow,
  Opening,
  PlanSheet,
  Project,
  ProjectAnswers,
  Room,
  Sourced,
  Storey,
  StoreyEdge,
  TopClosure,
  WindowType,
} from '../../core/types';
import {
  createStorey,
  DEFAULT_CONSTRUCTION_IDS,
  DEFAULT_WINDOW_TYPE_ID,
  defaultConstructions,
  defaultWindowTypes,
  excludeRoomFromOutline,
  rescaleStorey,
  restoreFootprint,
} from '../../engine';
import { guessStorey } from '../../semantics/labels';

// ───────────────────────────── Outils ─────────────────────────────

function withModel(project: Project, model: BuildingModel): Project {
  return model === project.model ? project : { ...project, model };
}

/** Identifiant libre de la forme « préfixe-N ». */
export function uniqueId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const candidate = `${prefix}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function findStorey(project: Project, storeyId: string | null): Storey | null {
  if (storeyId === null) return null;
  return project.model.storeys.find((s) => s.id === storeyId) ?? null;
}

/** Nombre strictement positif et fini, sinon null. */
function positive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

// ───────────────────────────── Langue ─────────────────────────────

/**
 * Changement de langue : les noms que l'expert n'a pas touchés (types de parois et de fenêtres par défaut, niveaux
 * reconnus comme « Rez-de-chaussée ») passent dans la nouvelle langue. Un nom personnalisé n'est jamais modifié.
 */
export function relocalizeDefaults(project: Project, from: Lang, to: Lang): Project {
  if (from === to) return project;
  const model = project.model;
  const oldConstructions = new Map(defaultConstructions(from).map((c) => [c.id, c.name]));
  const newConstructions = new Map(defaultConstructions(to).map((c) => [c.id, c.name]));
  const oldWindows = new Map(defaultWindowTypes(from).map((w) => [w.id, w.name]));
  const newWindows = new Map(defaultWindowTypes(to).map((w) => [w.id, w.name]));
  const renamed = <T extends { id: string; name: string }>(items: readonly T[], before: Map<string, string>, after: Map<string, string>): T[] =>
    items.map((item) => (before.get(item.id) === item.name && after.has(item.id) ? { ...item, name: after.get(item.id)! } : item));
  const constructions = renamed(model.constructions, oldConstructions, newConstructions);
  const windowTypes = renamed(model.windowTypes, oldWindows, newWindows);
  // Noms déjà pris, y compris par les étages qui viennent APRÈS : jamais deux étages du même nom.
  const taken = new Set(model.storeys.map((s) => s.name));
  const storeys = model.storeys.map((s) => {
    const guess = guessStorey(s.name);
    if (!guess || guess[from] !== s.name || guess[to] === s.name || taken.has(guess[to])) return s;
    taken.delete(s.name);
    taken.add(guess[to]);
    return { ...s, name: guess[to] };
  });
  const same = (a: readonly { name: string }[], b: readonly { name: string }[]): boolean => a.every((x, i) => x.name === b[i]!.name);
  if (same(constructions, model.constructions) && same(windowTypes, model.windowTypes) && same(storeys, model.storeys)) return project;
  return withModel(project, { ...model, constructions, windowTypes, storeys });
}

// ───────────────────────────── Étages ─────────────────────────────

/** Applique une transformation à un étage ; projet inchangé si l'étage n'existe pas ou ne change pas. */
export function mapStorey(project: Project, storeyId: string, fn: (storey: Storey) => Storey): Project {
  let changed = false;
  const storeys = project.model.storeys.map((s) => {
    if (s.id !== storeyId) return s;
    const next = fn(s);
    if (next !== s) changed = true;
    return next;
  });
  return changed ? withModel(project, { ...project.model, storeys }) : project;
}

/** Remplace un étage par sa nouvelle version (même identifiant) — c'est ce que renvoie l'éditeur de plan. */
export function replaceStorey(project: Project, next: Storey): Project {
  return mapStorey(project, next.id, () => next);
}

/**
 * Ajoute un étage (au-dessus des autres par défaut). Avec une feuille, il reprend ce que le lecteur y propose.
 * `index` = position dans la liste, du bas vers le haut.
 */
export function addStorey(project: Project, sheet: PlanSheet | null, name: string, index?: number): { project: Project; storey: Storey } {
  const storey = createStorey(sheet, name, project.model);
  const storeys = [...project.model.storeys];
  const at = index === undefined ? storeys.length : Math.max(0, Math.min(storeys.length, index));
  storeys.splice(at, 0, storey);
  const storeysAligned = stillAligned(project.model.storeysAligned, storeys);
  return { project: withModel(project, { ...project.model, storeys, storeysAligned }), storey };
}

/** Fichier d'où vient une feuille, d'après son identifiant « fichier#feuille » ; null pour un tracé sans plan. */
function sourceOf(sheetId: string | null): string | null {
  if (sheetId === null) return null;
  const cut = sheetId.lastIndexOf('#');
  return cut > 0 ? sheetId.slice(0, cut) : sheetId;
}

/**
 * Des étages ne sont superposables (même repère) que s'ils viennent tous du même fichier : dès qu'un étage vient
 * d'ailleurs — autre fichier, ou tracé à la main —, les décalages entre étages se comparent par les surfaces.
 */
function stillAligned(aligned: boolean, storeys: readonly Storey[]): boolean {
  if (!aligned) return false;
  return new Set(storeys.map((s) => sourceOf(s.sheetId))).size <= 1;
}

/**
 * Copie un étage juste au-dessus de lui (même contour, mêmes façades, ouvertures et pièces) : le cas courant
 * de deux niveaux identiques dont on n'a qu'un plan. Renvoie aussi le nouvel étage.
 */
export function duplicateStorey(project: Project, storeyId: string, name: string): { project: Project; storey: Storey | null } {
  const index = project.model.storeys.findIndex((s) => s.id === storeyId);
  const source = project.model.storeys[index];
  if (!source) return { project, storey: null };
  const id = createStorey(null, name, project.model).id;
  const reId = (old: string): string => (old.startsWith(source.id) ? id + old.slice(source.id.length) : `${id}-${old}`);
  const storey: Storey = {
    ...source,
    id,
    name,
    outline: source.outline.map((p) => ({ x: p.x, y: p.y })),
    edges: source.edges.map((e) => ({ ...e })),
    metresPerUnit: { ...source.metresPerUnit },
    grossHeight: { ...source.grossHeight },
    clearHeight: { ...source.clearHeight },
    openings: source.openings.map((o) => ({ ...o, id: reId(o.id) })),
    rooms: source.rooms.map((r) => ({ ...r, id: reId(r.id), area: { ...r.area } })),
    netAreaOverride: source.netAreaOverride ? { ...source.netAreaOverride } : null,
  };
  const storeys = [...project.model.storeys];
  storeys.splice(index + 1, 0, storey);
  return { project: withModel(project, { ...project.model, storeys }), storey };
}

export function removeStorey(project: Project, storeyId: string): Project {
  const storeys = project.model.storeys.filter((s) => s.id !== storeyId);
  return storeys.length === project.model.storeys.length ? project : withModel(project, { ...project.model, storeys });
}

/** Déplace un étage d'un cran : +1 = plus haut dans le bâtiment, −1 = plus bas. */
export function moveStorey(project: Project, storeyId: string, delta: -1 | 1): Project {
  const storeys = [...project.model.storeys];
  const from = storeys.findIndex((s) => s.id === storeyId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= storeys.length) return project;
  const [moved] = storeys.splice(from, 1);
  if (!moved) return project;
  storeys.splice(to, 0, moved);
  return withModel(project, { ...project.model, storeys });
}

export function renameStorey(project: Project, storeyId: string, name: string): Project {
  return mapStorey(project, storeyId, (s) => (s.name === name ? s : { ...s, name }));
}

/**
 * Change la feuille d'un étage.
 *  - Étage encore vide : il adopte ce que le lecteur propose sur la feuille (contour, pièces, ouvertures, échelle),
 *    en gardant son nom, son identifiant et les hauteurs déjà confirmées.
 *  - Étage déjà tracé : seule la feuille de fond change, la géométrie reste telle quelle.
 */
export function assignSheet(project: Project, storeyId: string, sheet: PlanSheet | null): Project {
  const next = assignSheetOnly(project, storeyId, sheet);
  // Un fond venu d'un autre fichier : les étages ne partagent plus forcément le même repère.
  const aligned = stillAligned(next.model.storeysAligned, next.model.storeys);
  return aligned === next.model.storeysAligned ? next : withModel(next, { ...next.model, storeysAligned: aligned });
}

function assignSheetOnly(project: Project, storeyId: string, sheet: PlanSheet | null): Project {
  return mapStorey(project, storeyId, (s) => {
    if (!sheet) return s.sheetId === null ? s : { ...s, sheetId: null };
    if (s.sheetId === sheet.id) return s;
    if (s.outline.length > 0) return { ...s, sheetId: sheet.id };
    const fresh = createStorey(sheet, s.name, project.model);
    const reId = (id: string): string => (id.startsWith(fresh.id) ? s.id + id.slice(fresh.id.length) : id);
    return {
      ...fresh,
      id: s.id,
      name: s.name,
      grossHeight: s.grossHeight.from === 'user' ? s.grossHeight : fresh.grossHeight,
      clearHeight: s.clearHeight.from === 'user' ? s.clearHeight : fresh.clearHeight,
      netAreaOverride: s.netAreaOverride,
      openings: fresh.openings.map((o) => ({ ...o, id: reId(o.id) })),
      rooms: fresh.rooms.map((r) => ({ ...r, id: reId(r.id) })),
    };
  });
}

/** L'expert valide l'échelle telle qu'elle est : elle devient « confirmée », les largeurs estimées suivent. */
export function confirmScale(project: Project, storeyId: string): Project {
  return mapStorey(project, storeyId, (s) =>
    s.metresPerUnit.from === 'user' ? s : rescaleStorey(s, { ...s.metresPerUnit, from: 'user' }),
  );
}

export type HeightKind = 'gross' | 'clear';

function heightField(kind: HeightKind): 'grossHeight' | 'clearHeight' {
  return kind === 'gross' ? 'grossHeight' : 'clearHeight';
}

/** Hauteur saisie par l'expert (m). Valeur non positive ou non finie : ignorée. */
export function setStoreyHeight(project: Project, storeyId: string, kind: HeightKind, value: number): Project {
  const v = positive(value);
  if (v === null) return project;
  const field = heightField(kind);
  return mapStorey(project, storeyId, (s) => {
    const current = s[field];
    if (current.value === v && current.from === 'user') return s;
    return { ...s, [field]: { value: v, from: 'user' } satisfies Sourced<number> };
  });
}

/** L'expert valide la hauteur proposée sans la changer. */
export function confirmStoreyHeight(project: Project, storeyId: string, kind: HeightKind): Project {
  const field = heightField(kind);
  return mapStorey(project, storeyId, (s) => (s[field].from === 'user' ? s : { ...s, [field]: { value: s[field].value, from: 'user' } }));
}

/** Surface nette chauffée de l'étage saisie directement (m²) ; null = revenir à la somme des pièces. */
export function setNetArea(project: Project, storeyId: string, value: number | null): Project {
  return mapStorey(project, storeyId, (s) => {
    if (value === null) return s.netAreaOverride === null ? s : { ...s, netAreaOverride: null };
    if (!Number.isFinite(value) || value < 0) return s;
    if (s.netAreaOverride && s.netAreaOverride.value === value && s.netAreaOverride.from === 'user') return s;
    return { ...s, netAreaOverride: { value, from: 'user' } };
  });
}

export function setEdge(project: Project, storeyId: string, index: number, patch: Partial<StoreyEdge>): Project {
  return mapStorey(project, storeyId, (s) => {
    const current = s.edges[index];
    if (!current) return s;
    const edges = s.edges.map((e, i) => (i === index ? { ...e, ...patch } : e));
    return { ...s, edges };
  });
}

export function updateOpening(project: Project, storeyId: string, openingId: string, patch: Partial<Omit<Opening, 'id'>>): Project {
  return mapStorey(project, storeyId, (s) => ({
    ...s,
    openings: s.openings.map((o) => (o.id === openingId ? { ...o, ...patch, from: patch.from ?? 'user' } : o)),
  }));
}

export function removeOpening(project: Project, storeyId: string, openingId: string): Project {
  return mapStorey(project, storeyId, (s) => ({ ...s, openings: s.openings.filter((o) => o.id !== openingId) }));
}

// ───────────────────────────── Pièces ─────────────────────────────

export function updateRoom(
  project: Project,
  storeyId: string,
  roomId: string,
  patch: { name?: string; area?: number; heated?: boolean },
): Project {
  return mapStorey(project, storeyId, (s) => ({
    ...s,
    rooms: s.rooms.map((r): Room => {
      if (r.id !== roomId) return r;
      const next: Room = { ...r };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.area !== undefined && Number.isFinite(patch.area) && patch.area >= 0) next.area = { value: patch.area, from: 'user' };
      if (patch.heated !== undefined) {
        next.heated = patch.heated;
        // L'expert a tranché : la pièce n'est plus « à revoir » (sauf si sa surface manque encore).
        next.needsReview = !(next.area.value > 0);
      }
      if (patch.area !== undefined && next.area.value > 0 && r.needsReview && !(r.area.value > 0)) next.needsReview = false;
      return next;
    }),
  }));
}

/**
 * Retire du contour chauffé un local non chauffé qui touche l'extérieur (garage, local froid…), avec ses murs
 * extérieurs ; le mur mis à nu devient « contre un local non chauffé ». Sans effet si le retrait n'est pas sûr.
 */
export function excludeRoomFromEnvelope(project: Project, storeyId: string, roomId: string): Project {
  return mapStorey(project, storeyId, (s) => excludeRoomFromOutline(s, roomId) ?? s);
}

/** Remet dans le contour toute l'emprise lue sur la feuille (annexes comprises). */
export function restoreStoreyFootprint(project: Project, storeyId: string, sheet: PlanSheet | null): Project {
  return mapStorey(project, storeyId, (s) => restoreFootprint(s, sheet) ?? s);
}

export function addRoom(project: Project, storeyId: string, name: string): Project {
  return mapStorey(project, storeyId, (s) => ({
    ...s,
    rooms: [
      ...s.rooms,
      {
        id: uniqueId(`${s.id}-r`, s.rooms.map((r) => r.id)),
        name,
        area: { value: 0, from: 'user' },
        heated: true,
        needsReview: true,
      },
    ],
  }));
}

export function removeRoom(project: Project, storeyId: string, roomId: string): Project {
  return mapStorey(project, storeyId, (s) => ({ ...s, rooms: s.rooms.filter((r) => r.id !== roomId) }));
}

// ───────────────────────────── Nord, toiture, plancher bas ─────────────────────────────

function normAngle(angle: number): number {
  const r = angle % 360;
  return r < 0 ? r + 360 : r;
}

/** Nord réglé par l'expert : azimut vers lequel pointe le haut de la feuille. */
export function setNorth(project: Project, angle: number): Project {
  if (!Number.isFinite(angle)) return project;
  const value = normAngle(angle);
  const current = project.model.northAngle;
  if (current.value === value && current.from === 'user') return project;
  return withModel(project, { ...project.model, northAngle: { value, from: 'user' } });
}

/** L'expert valide le nord proposé tel quel. */
export function confirmNorth(project: Project): Project {
  const current = project.model.northAngle;
  if (current.from === 'user') return project;
  return withModel(project, { ...project.model, northAngle: { value: current.value, from: 'user' } });
}

/**
 * Fermeture haute choisie par l'expert (type de toiture, pente, forme, jambette, sens du faîtage).
 * `confirmed = false` : le type vient d'être choisi mais ses détails restent à confirmer (toit incliné) — la
 * fermeture reste « à confirmer » et le constat correspondant demeure.
 */
export function setTop(project: Project, patch: Partial<Omit<TopClosure, 'from'>>, confirmed = true): Project {
  const top: TopClosure = { ...project.model.top, ...patch, from: confirmed ? 'user' : 'estimate' };
  if (!Number.isFinite(top.pitchDeg)) top.pitchDeg = project.model.top.pitchDeg;
  if (!Number.isFinite(top.kneeWallHeight) || top.kneeWallHeight < 0) top.kneeWallHeight = project.model.top.kneeWallHeight;
  return withModel(project, { ...project.model, top });
}

/** Fermeture basse choisie par l'expert. */
export function setBottom(project: Project, kind: BottomKind): Project {
  const current = project.model.bottom;
  if (current.kind === kind && current.from === 'user') return project;
  return withModel(project, { ...project.model, bottom: { ...current, kind, from: 'user' } });
}

// ───────────────────────────── Réponses ─────────────────────────────

export function setAnswers(project: Project, patch: Partial<ProjectAnswers>): Project {
  const keys = Object.keys(patch) as (keyof ProjectAnswers)[];
  if (keys.every((k) => project.answers[k] === patch[k])) return project;
  return { ...project, answers: { ...project.answers, ...patch } };
}

// ───────────────────────────── Mode expert : types d'éléments ─────────────────────────────

const DEFAULT_IDS: ReadonlySet<string> = new Set(Object.values(DEFAULT_CONSTRUCTION_IDS));

/** Les types par défaut ne se suppriment pas (le moteur les recréerait de toute façon). */
export function isDefaultConstruction(id: string): boolean {
  return DEFAULT_IDS.has(id);
}

function sourcedOrNull(value: number | null): Sourced<number> | null {
  return value === null || !Number.isFinite(value) || value <= 0 ? null : { value, from: 'user' };
}

export function addConstruction(project: Project, category: ConstructionCategory, name: string): Project {
  const id = uniqueId(`custom-${category}`, project.model.constructions.map((c) => c.id));
  const construction: Construction = { id, name, category, u: null };
  return withModel(project, { ...project.model, constructions: [...project.model.constructions, construction] });
}

export function updateConstruction(
  project: Project,
  id: string,
  patch: { name?: string; category?: ConstructionCategory; u?: number | null },
): Project {
  const constructions = project.model.constructions.map((c): Construction => {
    if (c.id !== id) return c;
    const next: Construction = { ...c };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.category !== undefined && !isDefaultConstruction(c.id)) next.category = patch.category;
    if (patch.u !== undefined) next.u = sourcedOrNull(patch.u);
    return next;
  });
  const before = project.model.constructions.find((c) => c.id === id);
  const after = constructions.find((c) => c.id === id);
  let model = { ...project.model, constructions };
  if (before && after && before.category !== after.category) {
    // Le type change de catégorie : les parois qui l'utilisaient et ne lui conviennent plus reviennent au type par défaut
    // (un « mur ancien » devenu « toiture » ne peut plus habiller une façade).
    const keep = (category: ConstructionCategory): boolean => after.category === category;
    model = {
      ...model,
      storeys: model.storeys.map((s) =>
        s.edges.some((e) => e.constructionId === id) && !keep('wall')
          ? { ...s, edges: s.edges.map((e) => (e.constructionId === id ? { ...e, constructionId: null } : e)) }
          : s,
      ),
      top: model.top.constructionId === id && !keep('roof') && !keep('ceiling') ? { ...model.top, constructionId: null } : model.top,
      bottom: model.bottom.constructionId === id && !keep('floor') ? { ...model.bottom, constructionId: null } : model.bottom,
      manualRows: model.manualRows,
    };
  }
  return withModel(project, model);
}

/** Supprime un type ajouté par l'expert ; les parois qui l'utilisaient reviennent au type par défaut. */
export function removeConstruction(project: Project, id: string): Project {
  if (isDefaultConstruction(id)) return project;
  const model = project.model;
  if (!model.constructions.some((c) => c.id === id)) return project;
  const clear = (ref: string | null): string | null => (ref === id ? null : ref);
  return withModel(project, {
    ...model,
    constructions: model.constructions.filter((c) => c.id !== id),
    storeys: model.storeys.map((s) =>
      s.edges.some((e) => e.constructionId === id)
        ? { ...s, edges: s.edges.map((e) => (e.constructionId === id ? { ...e, constructionId: null } : e)) }
        : s,
    ),
    top: { ...model.top, constructionId: clear(model.top.constructionId) },
    bottom: { ...model.bottom, constructionId: clear(model.bottom.constructionId) },
    manualRows: model.manualRows.map((r) => (r.constructionId === id ? { ...r, constructionId: null } : r)),
  });
}

// ───────────────────────────── Mode expert : types de fenêtres ─────────────────────────────

export function addWindowType(project: Project, name: string): Project {
  const id = uniqueId('window', project.model.windowTypes.map((w) => w.id));
  const windowType: WindowType = { id, name, uw: null, g: null };
  return withModel(project, { ...project.model, windowTypes: [...project.model.windowTypes, windowType] });
}

export function updateWindowType(project: Project, id: string, patch: { name?: string; uw?: number | null; g?: number | null }): Project {
  const windowTypes = project.model.windowTypes.map((w): WindowType => {
    if (w.id !== id) return w;
    const next: WindowType = { ...w };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.uw !== undefined) next.uw = sourcedOrNull(patch.uw);
    if (patch.g !== undefined) next.g = patch.g !== null && patch.g > 1 ? w.g : sourcedOrNull(patch.g);
    return next;
  });
  return withModel(project, { ...project.model, windowTypes });
}

export function removeWindowType(project: Project, id: string): Project {
  if (id === DEFAULT_WINDOW_TYPE_ID) return project;
  const model = project.model;
  if (!model.windowTypes.some((w) => w.id === id)) return project;
  return withModel(project, {
    ...model,
    windowTypes: model.windowTypes.filter((w) => w.id !== id),
    storeys: model.storeys.map((s) =>
      s.openings.some((o) => o.windowTypeId === id)
        ? { ...s, openings: s.openings.map((o) => (o.windowTypeId === id ? { ...o, windowTypeId: null } : o)) }
        : s,
    ),
    manualRows: model.manualRows.map((r) => (r.windowTypeId === id ? { ...r, windowTypeId: null } : r)),
  });
}

// ───────────────────────────── Mode expert : lignes manuelles ─────────────────────────────

export function addManualRow(project: Project, label: string): Project {
  const row: ManualRow = {
    id: uniqueId('manual', project.model.manualRows.map((r) => r.id)),
    label,
    constructionId: null,
    windowTypeId: null,
    count: 1,
    length: 1,
    width: 1,
    orientation: 'N',
    boundary: 'outside',
    deduct: false,
  };
  return withModel(project, { ...project.model, manualRows: [...project.model.manualRows, row] });
}

export function updateManualRow(project: Project, id: string, patch: Partial<Omit<ManualRow, 'id'>>): Project {
  const clean: Partial<Omit<ManualRow, 'id'>> = { ...patch };
  for (const key of ['count', 'length', 'width'] as const) {
    const v = clean[key];
    if (v !== undefined && !(Number.isFinite(v) && v >= 0)) delete clean[key];
  }
  const manualRows = project.model.manualRows.map((r) => (r.id === id ? { ...r, ...clean } : r));
  return withModel(project, { ...project.model, manualRows });
}

export function removeManualRow(project: Project, id: string): Project {
  const manualRows = project.model.manualRows.filter((r) => r.id !== id);
  return manualRows.length === project.model.manualRows.length ? project : withModel(project, { ...project.model, manualRows });
}

export const BOUNDARIES: readonly Boundary[] = ['outside', 'ground', 'unheated', 'heated'];
export const CONSTRUCTION_CATEGORIES: readonly ConstructionCategory[] = ['wall', 'roof', 'ceiling', 'floor', 'door'];
