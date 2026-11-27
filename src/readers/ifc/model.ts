/**
 * Lecture SÉMANTIQUE du modèle IFC (sans géométrie) : unités, nord, niveaux, locaux, fenêtres et portes,
 * murs-rideaux, relations utiles. Une seule passe par type de relation (voir NOTES de recherche, § 2.7).
 */
import { IfcSource, items, num, numbers, ref, str, type IfcLine } from './webifc';

export type Vec3 = [number, number, number];

/** Repère local d'un produit dans le repère global : origine (unités du fichier) et axes unitaires. */
export interface Frame {
  o: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export interface LevelInfo {
  id: number;
  name: string;
  /** Altitude servant à découper le modèle (m, repère de la géométrie). */
  z: number;
  /** Altitude nominale à afficher (attribut Elevation, m) si elle existe. */
  elevation: number;
  /** Nombre d'éléments rattachés au niveau par le fichier (simple indice). */
  contained: number;
}

export interface SpaceInfo {
  id: number;
  /** Nom affichable : LongName, sinon Name. */
  name: string;
  /** Second libellé (numéro de local en général), utile au classement chauffé / non chauffé. */
  altName: string | null;
  /** Surface déclarée dans les quantités (m²). */
  statedArea: number | null;
  /** Hauteur déclarée dans les quantités (m). */
  statedHeight: number | null;
  /** Niveau auquel le fichier rattache le local (utile seulement s'il n'a pas de géométrie). */
  levelId: number | null;
}

export interface FillerInfo {
  id: number;
  kind: 'window' | 'door';
  name: string | null;
  /** OverallWidth / OverallHeight en mètres. */
  width: number | null;
  height: number | null;
  /** IfcOpeningElement rempli par la menuiserie (réservation dans le mur). */
  openingId: number | null;
  hostId: number | null;
  /** Classe de l'élément porteur, en majuscules (« IFCWALL », « IFCROOF »…). */
  hostClass: string | null;
  frame: Frame | null;
}

export interface CurtainWallInfo {
  id: number;
  /** Le mur-rideau lui-même et ses panneaux / montants agrégés. */
  partIds: number[];
}

export interface IfcModelData {
  schema: string;
  /** Mètres par unité de longueur du fichier. */
  lengthScale: number;
  /** Nom lisible de l'unité de longueur (« mm », « m »…). */
  lengthUnit: string;
  /** m² par unité de surface du fichier. */
  areaScale: number;
  /** Direction du nord vrai dans le plan du modèle, si le fichier la donne. */
  trueNorth: { x: number; y: number } | null;
  buildingCount: number;
  levels: LevelInfo[];
  wallIds: number[];
  spaces: SpaceInfo[];
  fillers: FillerInfo[];
  curtainWalls: CurtainWallInfo[];
}

// ───────────────────────────── Unités ─────────────────────────────

const SI_PREFIX: Record<string, number> = {
  EXA: 1e18,
  PETA: 1e15,
  TERA: 1e12,
  GIGA: 1e9,
  MEGA: 1e6,
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
  NANO: 1e-9,
};

const PREFIX_SYMBOL: Record<string, string> = { KILO: 'k', DECI: 'd', CENTI: 'c', MILLI: 'm', MICRO: 'µ' };

interface UnitScale {
  scale: number;
  label: string;
}

/** Facteur vers l'unité SI de base (m, m²) d'une unité IfcSIUnit ou IfcConversionBasedUnit. */
function unitScale(src: IfcSource, unit: IfcLine | null, power: 1 | 2, depth = 0): UnitScale | null {
  if (!unit || depth > 4) return null;
  const cls = src.classOf(unit);
  if (cls === 'IFCSIUNIT') {
    const prefix = str(unit.Prefix);
    const p = prefix ? (SI_PREFIX[prefix] ?? 1) : 1;
    const base = power === 1 ? 'm' : 'm²';
    return { scale: power === 1 ? p : p * p, label: `${prefix ? (PREFIX_SYMBOL[prefix] ?? '') : ''}${base}` };
  }
  if (cls.startsWith('IFCCONVERSIONBASEDUNIT')) {
    const factor = src.line(ref(unit.ConversionFactor));
    const value = num(factor?.ValueComponent);
    const inner = unitScale(src, src.line(ref(factor?.UnitComponent)), power, depth + 1);
    if (value === null || value <= 0) return null;
    return { scale: value * (inner?.scale ?? 1), label: (str(unit.Name) ?? '?').toLowerCase() };
  }
  return null;
}

function readUnits(src: IfcSource): { length: UnitScale; area: UnitScale | null } {
  let length: UnitScale | null = null;
  let area: UnitScale | null = null;
  for (const id of src.ids('IFCUNITASSIGNMENT')) {
    for (const u of items(src.line(id)?.Units)) {
      const unit = src.line(ref(u));
      const type = str(unit?.UnitType);
      if (type === 'LENGTHUNIT' && !length) length = unitScale(src, unit, 1);
      if (type === 'AREAUNIT' && !area) area = unitScale(src, unit, 2);
    }
  }
  return { length: length ?? { scale: 1, label: 'm' }, area };
}

// ───────────────────────────── Placements ─────────────────────────────

function normalize3(v: Vec3): Vec3 | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function vec3(list: number[], fallback: Vec3): Vec3 {
  if (list.length < 2) return fallback;
  return [list[0] ?? 0, list[1] ?? 0, list[2] ?? 0];
}

const IDENTITY: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** IfcAxis2Placement3D (ou 2D) → repère local. */
function axisPlacement(src: IfcSource, id: number | null): Frame {
  const l = src.line(id);
  if (!l) return IDENTITY;
  const o = vec3(numbers(src.line(ref(l.Location))?.Coordinates), [0, 0, 0]);
  const zRaw = l.Axis ? vec3(numbers(src.line(ref(l.Axis))?.DirectionRatios), [0, 0, 1]) : ([0, 0, 1] as Vec3);
  const xRaw = l.RefDirection ? vec3(numbers(src.line(ref(l.RefDirection))?.DirectionRatios), [1, 0, 0]) : ([1, 0, 0] as Vec3);
  const z = normalize3(zRaw) ?? [0, 0, 1];
  // RefDirection n'est qu'approximatif : on le rend perpendiculaire à l'axe.
  const d = xRaw[0] * z[0] + xRaw[1] * z[1] + xRaw[2] * z[2];
  let x = normalize3([xRaw[0] - d * z[0], xRaw[1] - d * z[1], xRaw[2] - d * z[2]]);
  if (!x) x = normalize3(Math.abs(z[2]) < 0.9 ? cross3([0, 0, 1], z) : cross3([0, 1, 0], z)) ?? [1, 0, 0];
  return { o, x, y: cross3(z, x), z };
}

function compose(parent: Frame, local: Frame): Frame {
  const rot = (v: Vec3): Vec3 => [
    parent.x[0] * v[0] + parent.y[0] * v[1] + parent.z[0] * v[2],
    parent.x[1] * v[0] + parent.y[1] * v[1] + parent.z[1] * v[2],
    parent.x[2] * v[0] + parent.y[2] * v[1] + parent.z[2] * v[2],
  ];
  const o = rot(local.o);
  return { o: [o[0] + parent.o[0], o[1] + parent.o[1], o[2] + parent.o[2]], x: rot(local.x), y: rot(local.y), z: rot(local.z) };
}

/** Résout les chaînes IfcLocalPlacement (avec cache : les murs et étages sont partagés par beaucoup d'éléments). */
export class PlacementResolver {
  private readonly cache = new Map<number, Frame>();

  constructor(private readonly src: IfcSource) {}

  /** Repère global du placement, ou null s'il n'est pas un IfcLocalPlacement lisible. */
  frame(placementId: number | null, depth = 0): Frame | null {
    if (placementId === null) return null;
    const hit = this.cache.get(placementId);
    if (hit) return hit;
    if (depth > 64) return null;
    const l = this.src.line(placementId);
    if (!l || l.RelativePlacement === undefined) return null;
    const local = axisPlacement(this.src, ref(l.RelativePlacement));
    const parentId = ref(l.PlacementRelTo);
    const parent = parentId === null ? IDENTITY : (this.frame(parentId, depth + 1) ?? IDENTITY);
    const out = compose(parent, local);
    this.cache.set(placementId, out);
    return out;
  }
}

// ───────────────────────────── Lecture ─────────────────────────────

function readTrueNorth(src: IfcSource): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  // Sans les sous-contextes : ils héritent du contexte parent.
  for (const id of src.ids('IFCGEOMETRICREPRESENTATIONCONTEXT', false)) {
    const ctx = src.line(id);
    const dir = numbers(src.line(ref(ctx?.TrueNorth))?.DirectionRatios);
    if (dir.length < 2) continue;
    const x = dir[0] ?? 0;
    const y = dir[1] ?? 0;
    if (Math.hypot(x, y) < 1e-9) continue;
    if (!best || str(ctx?.ContextType) === 'Model') best = { x, y };
  }
  return best;
}

function spread(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}

export function readModel(src: IfcSource): IfcModelData {
  const units = readUnits(src);
  const scale = units.length.scale;
  const areaScale = units.area?.scale ?? scale * scale;
  const placements = new PlacementResolver(src);

  // ── Relations ──
  const containedCount = new Map<number, number>();
  const parentOf = new Map<number, number>();
  for (const id of src.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
    const l = src.line(id);
    const structure = ref(l?.RelatingStructure);
    if (structure === null) continue;
    const elements = items(l?.RelatedElements);
    containedCount.set(structure, (containedCount.get(structure) ?? 0) + elements.length);
    for (const e of elements) {
      const child = ref(e);
      if (child !== null) parentOf.set(child, structure);
    }
  }
  const childrenOf = new Map<number, number[]>();
  for (const id of src.ids('IFCRELAGGREGATES')) {
    const l = src.line(id);
    const parent = ref(l?.RelatingObject);
    if (parent === null) continue;
    const list = childrenOf.get(parent) ?? [];
    for (const o of items(l?.RelatedObjects)) {
      const child = ref(o);
      if (child !== null) {
        list.push(child);
        parentOf.set(child, parent);
      }
    }
    childrenOf.set(parent, list);
  }
  const hostOfOpening = new Map<number, number>();
  for (const id of src.ids('IFCRELVOIDSELEMENT')) {
    const l = src.line(id);
    const opening = ref(l?.RelatedOpeningElement);
    const host = ref(l?.RelatingBuildingElement);
    if (opening !== null && host !== null) hostOfOpening.set(opening, host);
  }
  const openingOfFiller = new Map<number, number>();
  for (const id of src.ids('IFCRELFILLSELEMENT')) {
    const l = src.line(id);
    const filler = ref(l?.RelatedBuildingElement);
    const opening = ref(l?.RelatingOpeningElement);
    if (filler !== null && opening !== null) openingOfFiller.set(filler, opening);
  }

  // ── Niveaux ──
  const buildingIds = src.ids('IFCBUILDING');
  let buildingZ = 0;
  if (buildingIds.length === 1) {
    const f = placements.frame(ref(src.line(buildingIds[0] ?? null)?.ObjectPlacement));
    if (f) buildingZ = f.o[2] * scale;
  }
  const rawLevels = src.ids('IFCBUILDINGSTOREY').map((id) => {
    const l = src.line(id);
    const frame = placements.frame(ref(l?.ObjectPlacement));
    const attr = num(l?.Elevation);
    return {
      id,
      name: str(l?.Name) ?? str(l?.LongName) ?? `#${id}`,
      placed: frame ? frame.o[2] * scale : null,
      attr: attr === null ? null : attr * scale,
      contained: (containedCount.get(id) ?? 0) + (childrenOf.get(id)?.length ?? 0),
    };
  });
  // Altitude de découpe : celle du placement (cohérente avec la géométrie) ; si tous les niveaux sont placés
  // à la même altitude alors que leurs attributs Elevation diffèrent, ce sont les attributs qui disent vrai.
  const placedAll = rawLevels.every((l) => l.placed !== null);
  const attrAll = rawLevels.every((l) => l.attr !== null);
  const usePlacement = placedAll && !(attrAll && spread(rawLevels.map((l) => l.placed ?? 0)) < 0.01 && spread(rawLevels.map((l) => l.attr ?? 0)) > 0.5);
  const levels: LevelInfo[] = rawLevels.map((l) => {
    const z = usePlacement ? (l.placed ?? 0) : l.attr !== null ? l.attr + buildingZ : (l.placed ?? 0);
    return { id: l.id, name: l.name, z, elevation: l.attr ?? z, contained: l.contained };
  });
  levels.sort((a, b) => a.z - b.z);

  // ── Murs ──
  const wallIds = src.ids('IFCWALL');

  // ── Locaux et leurs quantités ──
  const spaceIds = src.ids('IFCSPACE');
  const spaceSet = new Set(spaceIds);
  const stated = new Map<number, { net: number | null; gross: number | null; height: number | null }>();
  if (spaceIds.length > 0) {
    for (const id of src.ids('IFCRELDEFINESBYPROPERTIES')) {
      const l = src.line(id);
      const targets: number[] = [];
      for (const o of items(l?.RelatedObjects)) {
        const t = ref(o);
        if (t !== null && spaceSet.has(t)) targets.push(t);
      }
      if (targets.length === 0) continue;
      const defs = Array.isArray(l?.RelatingPropertyDefinition) ? items(l?.RelatingPropertyDefinition) : [l?.RelatingPropertyDefinition];
      for (const d of defs) {
        const set = src.line(ref(d));
        if (!set || src.classOf(set) !== 'IFCELEMENTQUANTITY') continue;
        for (const q of items(set.Quantities)) {
          const quantity = src.line(ref(q));
          const name = str(quantity?.Name);
          if (!quantity || !name) continue;
          const area = num(quantity.AreaValue);
          const length = num(quantity.LengthValue);
          for (const t of targets) {
            const entry = stated.get(t) ?? { net: null, gross: null, height: null };
            if (area !== null && area > 0) {
              if (name === 'NetFloorArea') entry.net = area * areaScale;
              else if (name === 'GrossFloorArea') entry.gross = area * areaScale;
            }
            if (length !== null && length > 0 && (name === 'Height' || name === 'FinishCeilingHeight') && entry.height === null) {
              entry.height = length * scale;
            }
            stated.set(t, entry);
          }
        }
      }
    }
  }
  const spaces: SpaceInfo[] = spaceIds.map((id) => {
    const l = src.line(id);
    const name = str(l?.Name);
    const longName = str(l?.LongName);
    const q = stated.get(id);
    return {
      id,
      name: longName ?? name ?? '',
      altName: longName && name ? name : null,
      statedArea: q?.net ?? q?.gross ?? null,
      statedHeight: q?.height ?? null,
      levelId: parentOf.get(id) ?? null,
    };
  });

  // ── Fenêtres et portes ──
  const fillers: FillerInfo[] = [];
  const readFillers = (cls: string, kind: 'window' | 'door'): void => {
    for (const id of src.ids(cls)) {
      const l = src.line(id);
      if (!l) continue;
      const w = num(l.OverallWidth);
      const h = num(l.OverallHeight);
      const openingId = openingOfFiller.get(id) ?? null;
      const hostId = openingId === null ? null : (hostOfOpening.get(openingId) ?? null);
      fillers.push({
        id,
        kind,
        name: str(l.Name),
        width: w !== null && w > 0 ? w * scale : null,
        height: h !== null && h > 0 ? h * scale : null,
        openingId,
        hostId,
        hostClass: hostId === null ? null : src.classOfId(hostId),
        frame: placements.frame(ref(l.ObjectPlacement)),
      });
    }
  };
  readFillers('IFCWINDOW', 'window');
  readFillers('IFCDOOR', 'door');

  // ── Murs-rideaux : la géométrie est portée par les panneaux et montants agrégés ──
  const curtainWalls: CurtainWallInfo[] = src.ids('IFCCURTAINWALL').map((id) => ({
    id,
    partIds: [id, ...(childrenOf.get(id) ?? [])],
  }));

  return {
    schema: src.schema(),
    lengthScale: scale,
    lengthUnit: units.length.label,
    areaScale,
    trueNorth: readTrueNorth(src),
    buildingCount: buildingIds.length,
    levels,
    wallIds,
    spaces,
    fillers,
    curtainWalls,
  };
}
