/**
 * Analyse d'un modèle IFC → PlanDocument (une feuille par étage réel).
 *
 * Portage en TypeScript de la maquette éprouvée « webifc_spike.mjs » (notes de recherche IFC, partie 2) :
 *  1. lecture sémantique (unités, nord, niveaux, locaux, menuiseries) — model.ts ;
 *  2. triangulation des murs, des locaux et des RÉSERVATIONS des fenêtres et portes (jamais des menuiseries
 *     elles-mêmes, sauf si elles n'ont pas de réservation) ;
 *  3. découpe en tranches de hauteur (bands.ts) plutôt que par rattachement « élément → étage » ;
 *  4. par tranche : emprise au sol tramée (murs ∪ locaux, interstices fermés, trous remplis), contour du plus
 *     grand morceau raccroché aux sommets exacts, test géométrique « ouverture extérieure », pièces, traits du plan.
 *
 * Fonction PURE du point de vue de l'environnement : elle reçoit une instance web-ifc déjà initialisée
 * (voir init-browser.ts / init-node.ts) et ne touche ni au DOM ni au système de fichiers.
 *
 * Repères : IFC = x à droite, y vers le haut ; feuille = x à droite, y vers le BAS → y_feuille = −y_IFC.
 * Unité de feuille = le mètre (metresPerUnit = 1).
 */
import type { IfcAPI } from 'web-ifc';
import { isSelfIntersecting, polygonArea, round } from '../../core/geometry';
import type { BBox, DetectedOpening, DetectedRoom, Lang, PlanDocument, PlanSheet, Vec2 } from '../../core/types';
import { formatNumber, t } from '../../i18n';
import { classifyRoomName } from '../../semantics/labels';
import { belongsToBand, selectBands, type Band, type LevelInput } from './bands';
import { buildFootprint, type FootprintSettings } from './footprint';
import './messages';
import { readModel, type FillerInfo, type SpaceInfo } from './model';
import { northAngleFromTrueNorth, trueNorthBearing } from './north';
import { openingGeometry, probeExterior, type OpeningGeometry } from './openings';
import { PointIndex, cleanOutline } from './outline';
import { labelAt, makeGrid, traceOuterBoundary, type Grid } from './raster';
import { roomGeometry, type RoomGeometry } from './spaces';
import { IfcSource, type Origin } from './webifc';

export interface AnalyseOptions {
  /** Langue des avertissements et remarques (français par défaut, comme le veut le contrat). */
  lang?: Lang;
  /** Maille de la trame d'emprise (m). */
  cell?: number;
  /** Nombre maximal de cellules de la trame ; au-delà la maille est grossie. */
  maxCells?: number;
}

// ───────────────────────────── Réglages (issus de la maquette) ─────────────────────────────

const CELL = 0.025; // m
const MAX_CELLS = 4_000_000;
const CLOSE_GAP = 0.06; // m : rayon de fermeture des interstices entre murs
const MIN_PIECE_AREA = 4; // m² : en dessous, un morceau d'emprise est du bruit
const CUT_HEIGHT = 1.1; // m au-dessus du niveau : hauteur de coupe du plan
const MIN_CLEAR_HEIGHT = 1.0; // m : hauteur libre minimale pour compter dans An
const HEIGHT_RANGE = { min: 2.0, max: 6.0 }; // m : hors de cette plage, la hauteur d'étage est signalée
const PROBE_REACH = 1.0; // m : distance de sonde de part et d'autre d'une ouverture
const SMALL_STOREY_SHARE = 0.15; // part de la plus grande emprise sous laquelle un niveau est signalé
const SPACE_GAP = 0.5; // m : écart entre locaux fermé quand le niveau n'a aucun mur
const ARM_HALF_WIDTH = 0.25; // m : une saillie de moins de ~0,5 m de large (mur isolé accolé) est retirée de l'emprise
const CORE_RADIUS = 0.6; // m : un morceau d'emprise doit contenir un carré de 1,2 m (sinon c'est un mur isolé)
const MAX_SEGMENTS = 150_000; // par feuille

interface Solid {
  id: number;
  soup: Float32Array;
  zMin: number;
  zMax: number;
  kind: 'wall' | 'curtain';
}

interface SpaceSolid {
  info: SpaceInfo;
  soup: Float32Array;
  zMin: number;
  zMax: number;
}

interface PlacedOpening {
  kind: 'window' | 'door';
  geometry: OpeningGeometry;
  width: number | null;
  height: number | null;
  roof: boolean;
  curtain: boolean;
}

function zRange(soup: Float32Array): { zMin: number; zMax: number } {
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 2; i < soup.length; i += 3) {
    const z = soup[i]!;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  return { zMin, zMax };
}

function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0]!;
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Coupe horizontale d'un maillage à la cote z : segments [x1, y1, x2, y2] ajoutés en coordonnées de FEUILLE. */
function cutSoup(soup: Float32Array, z: number, out: number[]): void {
  for (let t0 = 0; t0 + 8 < soup.length; t0 += 9) {
    let d0 = soup[t0 + 2]! - z;
    let d1 = soup[t0 + 5]! - z;
    let d2 = soup[t0 + 8]! - z;
    if (d0 === 0) d0 = 1e-7;
    if (d1 === 0) d1 = 1e-7;
    if (d2 === 0) d2 = 1e-7;
    const s0 = d0 > 0;
    const s1 = d1 > 0;
    const s2 = d2 > 0;
    if (s0 === s1 && s1 === s2) continue;
    let px = 0;
    let py = 0;
    let qx = 0;
    let qy = 0;
    let found = 0;
    const cross = (ia: number, ib: number, da: number, db: number): void => {
      const k = da / (da - db);
      const x = soup[ia]! + k * (soup[ib]! - soup[ia]!);
      const y = soup[ia + 1]! + k * (soup[ib + 1]! - soup[ia + 1]!);
      if (found === 0) {
        px = x;
        py = y;
      } else {
        qx = x;
        qy = y;
      }
      found++;
    };
    if (s0 !== s1) cross(t0, t0 + 3, d0, d1);
    if (s1 !== s2) cross(t0 + 3, t0 + 6, d1, d2);
    if (s2 !== s0) cross(t0 + 6, t0, d2, d0);
    if (found === 2 && Math.hypot(qx - px, qy - py) > 1e-3) out.push(px, -py, qx, -qy);
  }
}

function weightedMedian(values: { value: number; weight: number }[]): number | null {
  const list = values.filter((v) => v.weight > 0 && Number.isFinite(v.value)).sort((a, b) => a.value - b.value);
  if (list.length === 0) return null;
  let total = 0;
  for (const v of list) total += v.weight;
  let acc = 0;
  for (const v of list) {
    acc += v.weight;
    if (acc >= total / 2) return v.value;
  }
  return list[list.length - 1]!.value;
}

function quote(names: readonly string[]): string {
  return names.map((n) => `« ${n} »`).join(', ');
}

/**
 * Lit un fichier IFC avec une instance web-ifc INITIALISÉE et renvoie les feuilles proposées.
 * Lève une erreur si le fichier n'est pas un IFC lisible ; un modèle sans mur ni local donne un document
 * sans feuille, avec un avertissement.
 */
export function analyseIfc(api: IfcAPI, data: Uint8Array, fileName: string, options: AnalyseOptions = {}): PlanDocument {
  const src = IfcSource.open(api, data);
  try {
    return analyse(src, fileName, options);
  } finally {
    src.close();
  }
}

function analyse(src: IfcSource, fileName: string, options: AnalyseOptions): PlanDocument {
  const lang: Lang = options.lang ?? 'fr';
  const msg = (key: string, params?: Record<string, string | number>): string => t(lang, key, params);
  const fmt = (v: number, digits = 2): string => formatNumber(v, digits);
  const model = readModel(src);
  const warnings: string[] = [];
  const doc: PlanDocument = { fileName, kind: 'ifc', sheets: [], storeysAligned: true, warnings };

  // ── Nord ──
  if (model.trueNorth) {
    const angle = northAngleFromTrueNorth(model.trueNorth.x, model.trueNorth.y);
    if (angle === null) warnings.push(msg('ifc.warn.northDefault'));
    else {
      const bearing = trueNorthBearing(model.trueNorth.x, model.trueNorth.y) ?? 0;
      doc.northAngle = { value: angle, from: 'plan', note: msg('ifc.north.note', { bearing: fmt(bearing, 1) }) };
    }
  } else {
    warnings.push(msg('ifc.warn.northMissing'));
  }

  // ── Géométrie : murs, murs-rideaux, locaux ──
  const origin: Origin = { x: 0, y: 0, decided: false };
  const solids: Solid[] = [];
  src.streamTriangles(model.wallIds, origin, (id, soup) => {
    solids.push({ id, soup, ...zRange(soup), kind: 'wall' });
  });
  if (model.curtainWalls.length > 0) {
    const ownerOf = new Map<number, number>();
    for (const cw of model.curtainWalls) for (const p of cw.partIds) ownerOf.set(p, cw.id);
    const parts = new Map<number, Float32Array[]>();
    src.streamTriangles([...ownerOf.keys()], origin, (id, soup) => {
      const owner = ownerOf.get(id);
      if (owner === undefined) return;
      const list = parts.get(owner) ?? [];
      list.push(soup);
      parts.set(owner, list);
    });
    for (const cw of model.curtainWalls) {
      const list = parts.get(cw.id);
      if (!list) continue;
      const soup = concat(list);
      solids.push({ id: cw.id, soup, ...zRange(soup), kind: 'curtain' });
    }
  }
  const spaceInfo = new Map<number, SpaceInfo>(model.spaces.map((s) => [s.id, s]));
  const spaces: SpaceSolid[] = [];
  const meshed = new Set<number>();
  src.streamTriangles([...spaceInfo.keys()], origin, (id, soup) => {
    const info = spaceInfo.get(id);
    if (!info) return;
    meshed.add(id);
    spaces.push({ info, soup, ...zRange(soup) });
  });

  // ── Géométrie : fenêtres et portes, par leur réservation ──
  const placed: PlacedOpening[] = [];
  let unplaced = 0;
  const fillerOfOpening = new Map<number, FillerInfo>();
  for (const f of model.fillers) if (f.openingId !== null && !fillerOfOpening.has(f.openingId)) fillerOfOpening.set(f.openingId, f);
  const done = new Set<number>();
  const place = (f: FillerInfo, soup: Float32Array): void => {
    const geometry = openingGeometry(soup, f.frame, f.width);
    if (!geometry) return;
    done.add(f.id);
    const roof = geometry.tilted || f.hostClass === 'IFCROOF' || f.hostClass === 'IFCSLAB';
    placed.push({ kind: f.kind, geometry, width: f.width, height: f.height, roof, curtain: false });
  };
  src.streamTriangles([...fillerOfOpening.keys()], origin, (id, soup) => {
    const f = fillerOfOpening.get(id);
    if (f) place(f, soup);
  });
  // Menuiseries sans réservation (fenêtres de toit Revit, portes de murs-rideaux…) : leur propre maillage.
  const orphans = new Map<number, FillerInfo>();
  for (const f of model.fillers) if (!done.has(f.id)) orphans.set(f.id, f);
  const curtainBoxes = solids.filter((s) => s.kind === 'curtain').map((s) => ({ geometry: openingGeometry(s.soup, null, null) }));
  src.streamTriangles([...orphans.keys()], origin, (id, soup) => {
    const f = orphans.get(id);
    if (!f) return;
    // Une porte ou un vantail pris dans un mur-rideau est déjà compté avec lui.
    const probe = openingGeometry(soup, f.frame, f.width);
    if (probe) {
      for (const cb of curtainBoxes) {
        const g = cb.geometry;
        if (!g) continue;
        const rx = probe.cx - g.cx;
        const ry = probe.cy - g.cy;
        const u = rx * g.dx + ry * g.dy;
        const v = -rx * g.dy + ry * g.dx;
        const zc = (probe.zMin + probe.zMax) / 2;
        if (Math.abs(u) <= g.along / 2 && Math.abs(v) <= g.depth / 2 + 0.3 && zc >= g.zMin && zc <= g.zMax) {
          done.add(f.id);
          return;
        }
      }
    }
    place(f, soup);
  });
  for (const f of model.fillers) if (!done.has(f.id)) unplaced++;
  for (const cb of curtainBoxes) {
    if (cb.geometry && cb.geometry.along > 0.3) {
      placed.push({ kind: 'window', geometry: cb.geometry, width: null, height: null, roof: cb.geometry.tilted, curtain: true });
    }
  }

  // ── Étendue et trame ──
  const footprintSoups: Float32Array[] = [...solids.map((s) => s.soup), ...spaces.map((s) => s.soup)];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const soup of footprintSoups) {
    for (let i = 0; i + 2 < soup.length; i += 3) {
      const x = soup[i]!;
      const y = soup[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) {
    warnings.unshift(msg('ifc.warn.empty'));
    return doc;
  }
  const grid: Grid = makeGrid({ minX, minY, maxX, maxY }, options.cell ?? CELL, options.maxCells ?? MAX_CELLS);
  const cell = grid.cell;
  const closeCells = Math.max(1, Math.ceil(CLOSE_GAP / cell));
  const footprintSettings: FootprintSettings = {
    closeCells,
    spaceCloseCells: Math.ceil(SPACE_GAP / 2 / cell),
    armCells: Math.max(1, Math.round(ARM_HALF_WIDTH / cell)),
    coreCells: Math.max(1, Math.round(CORE_RADIUS / cell)),
    minPieceCells: Math.ceil(MIN_PIECE_AREA / (cell * cell)),
  };

  // ── Tranches de hauteur ──
  const wallLike = solids.length > 0 ? solids : spaces;
  let zLow = Infinity;
  let zHigh = -Infinity;
  for (const s of wallLike) {
    if (s.zMin < zLow) zLow = s.zMin;
    if (s.zMax > zHigh) zHigh = s.zMax;
  }
  let levels: LevelInput[] = model.levels;
  if (levels.length === 0) {
    levels = [{ id: 0, name: msg('ifc.level.single'), z: zLow, elevation: zLow, contained: 0 }];
    warnings.push(msg('ifc.warn.noLevels'));
  }
  const selection = selectBands(levels, solids, spaces);
  // Un local posé sur un niveau de toiture (vide sous toiture, « Roof ») n'est ni une pièce ni un étage.
  const roofSpaces = spaces.filter((s) => selection.dropped.some((l) => Math.abs(s.zMin - l.z) <= 0.6));
  const rooms3d = spaces.filter((s) => !roofSpaces.includes(s));
  const ignored: LevelInput[] = [];
  // Une tranche sans mur ni local n'est pas un étage : on la retire et on recolle ses voisines.
  let kept: Band[] = selection.bands;
  for (let guard = 0; guard < 8; guard++) {
    const filtered = kept.filter((b) => {
      const lo = Math.max(b.zFrom, zLow);
      const hi = Math.min(b.zTo, zHigh);
      const alive = hi - lo > 0.05 && (solids.some((s) => belongsToBand(s, lo, hi)) || rooms3d.some((s) => belongsToBand(s, lo, hi)));
      if (!alive) ignored.push(b.level, ...b.absorbed);
      return alive;
    });
    if (filtered.length === kept.length) break;
    kept = filtered.map((b, k) => ({
      level: b.level,
      zFrom: k === 0 ? -Infinity : b.level.z,
      zTo: k === filtered.length - 1 ? Infinity : filtered[k + 1]!.level.z,
      absorbed: b.absorbed,
    }));
  }

  // ── Une feuille par tranche ──
  const absorbedNames: string[] = [];
  const pieceLevels: string[] = [];
  let roofWindows = 0;
  let curtainCount = 0;
  let measuredCount = 0;
  let offOutline = 0;
  let foreignOpenings = 0;
  let foreignRooms = 0;
  const sheetOf = new Map<Band, PlanSheet>();
  const planCentre = (soup: Float32Array): Vec2 => {
    let x = 0;
    let y = 0;
    for (let i = 0; i + 2 < soup.length; i += 3) {
      x += soup[i]!;
      y += soup[i + 1]!;
    }
    const n = Math.max(1, soup.length / 3);
    return { x: x / n, y: y / n };
  };

  kept.forEach((band, k) => {
    const lo = Math.max(band.zFrom, zLow);
    const hi = Math.min(band.zTo, zHigh);
    // Emprise : murs ∪ locaux, interstices fermés, trous remplis ; murs isolés ou en saillie et miettes écartés.
    const allSolids = solids.filter((s) => belongsToBand(s, lo, hi));
    const memberSpaces = rooms3d.filter((s) => belongsToBand(s, lo, hi));
    const footprint = buildFootprint(
      grid,
      allSolids.map((s) => s.soup),
      memberSpaces.map((s) => s.soup),
      footprintSettings,
    );
    const pieces = footprint.pieces;
    if (pieces.cells.length === 0) {
      ignored.push(band.level, ...band.absorbed);
      return;
    }
    // Les murs laissés hors de l'emprise restent dessinés sur le plan mais ne comptent plus pour le contour.
    const memberSolids = allSolids.filter((_, i) => !footprint.detached.has(i));
    const spacesOnly = footprint.spacesOnly;
    const armCells = footprint.armCells;

    // Ce que la tranche contient : ouvertures (par leur mi-hauteur) et locaux (par leur sol).
    const bandOpenings = placed.filter((p) => {
      const zc = (p.geometry.zMin + p.geometry.zMax) / 2;
      return zc >= band.zFrom && zc < band.zTo;
    });
    const bandRooms = rooms3d
      .filter((s) => {
        const probeZ = s.zMin + Math.min(0.5, (s.zMax - s.zMin) / 2);
        return probeZ >= band.zFrom && probeZ < band.zTo;
      })
      .map((s) => ({ space: s, geometry: roomGeometry(s.soup, MIN_CLEAR_HEIGHT) }));
    const roomPiece = (r: { space: SpaceSolid; geometry: RoomGeometry | null }): number => {
      const at = r.geometry?.at ?? planCentre(r.space.soup);
      return labelAt(grid, pieces.labels, at.x, at.y);
    };

    // Morceau proposé : celui qui porte le plus d'ouvertures et de locaux ; à égalité, le plus grand.
    let main = 1;
    if (pieces.cells.length > 1) {
      const evidence = new Float64Array(pieces.cells.length + 1);
      for (const p of bandOpenings) {
        const l = labelAt(grid, pieces.labels, p.geometry.cx, p.geometry.cy);
        if (l > 0) evidence[l] = (evidence[l] ?? 0) + 1;
      }
      for (const r of bandRooms) {
        const l = roomPiece(r);
        if (l > 0) evidence[l] = (evidence[l] ?? 0) + 2;
      }
      for (let l = 2; l < evidence.length; l++) if ((evidence[l] ?? 0) > (evidence[main] ?? 0)) main = l;
    }

    const notes: string[] = [];
    const stair = traceOuterBoundary(grid, pieces.labels, main);
    const ring: Vec2[] = [];
    for (let i = 0; i + 1 < stair.length; i += 2) ring.push({ x: stair[i]!, y: stair[i + 1]! });
    const exact = new PointIndex(3 * cell, grid.minX, grid.minY);
    for (const s of memberSolids) exact.addSoup(s.soup);
    for (const s of memberSpaces) exact.addSoup(s.soup);
    const outlineIfc = cleanOutline(ring, cell, exact);
    const outline: Vec2[] = outlineIfc.map((p) => ({ x: p.x, y: -p.y }));
    const outlineArea = polygonArea(outline);
    notes.push(
      msg('ifc.note.outline', {
        area: fmt(outlineArea, 1),
        walls: memberSolids.length,
        spaces: memberSpaces.length,
      }),
    );
    if (spacesOnly) notes.push(msg('ifc.note.spacesOnly'));
    if (armCells * cell * cell >= 0.5) notes.push(msg('ifc.note.arms', { area: fmt(armCells * cell * cell, 1) }));
    if (pieces.cells.length > 1) {
      pieceLevels.push(band.level.name);
      notes.push(
        msg('ifc.note.pieces', {
          n: pieces.cells.length,
          area: fmt((pieces.cells[main - 1] ?? 0) * cell * cell, 1),
          others: pieces.cells
            .filter((_, i) => i !== main - 1)
            .slice(0, 5)
            .map((c) => fmt(c * cell * cell, 1))
            .join(' ; '),
        }),
      );
      if (main !== 1) notes.push(msg('ifc.note.pieceChoice'));
    }
    if (isSelfIntersecting(outline)) notes.push(msg('ifc.note.selfIntersecting'));
    if (band.absorbed.length > 0) {
      notes.push(msg('ifc.note.absorbed', { names: quote(band.absorbed.map((l) => l.name)) }));
      for (const l of band.absorbed) absorbedNames.push(l.name);
    }

    // Hauteur d'étage : de niveau à niveau ; dernier niveau : jusqu'au sommet des murs du volume proposé.
    const isTop = k === kept.length - 1;
    let storeyHeight: number | undefined;
    let eavesHeight: number | undefined;
    if (!isTop) {
      storeyHeight = round(kept[k + 1]!.level.z - band.level.z, 2);
    } else {
      const ofMain = <T extends { soup: Float32Array }>(list: T[]): T[] =>
        pieces.cells.length === 1
          ? list
          : list.filter((s) => {
              const c = planCentre(s.soup);
              return labelAt(grid, pieces.labels, c.x, c.y) === main;
            });
      const walls = ofMain(memberSolids.filter((s) => s.kind === 'wall'));
      const tops = (walls.length > 0 ? walls : ofMain(memberSpaces)).filter((s) => s.zMax - s.zMin >= 0.3).map((s) => s.zMax - band.level.z);
      if (tops.length > 0) {
        const high = Math.max(...tops);
        const low = Math.min(...tops);
        storeyHeight = round(high, 2);
        notes.push(msg('ifc.note.topHeight'));
        if (high - low > 0.5) {
          // Murs pignons : `high` est le faîtage, `low` la jambette. Le moteur en fait une proposition de toiture.
          eavesHeight = round(low, 2);
          notes.push(msg('ifc.note.unevenWalls', { low: fmt(low), high: fmt(high) }));
        }
      }
    }
    if (storeyHeight !== undefined && (storeyHeight < HEIGHT_RANGE.min || storeyHeight > HEIGHT_RANGE.max)) {
      warnings.push(msg('ifc.warn.storeyHeight', { name: band.level.name, height: fmt(storeyHeight) }));
    }

    // Ouvertures.
    const openings: DetectedOpening[] = [];
    const symbols: number[] = [];
    let extWindows = 0;
    let extDoors = 0;
    let inner = 0;
    const edgeTol = Math.max(3 * cell, 0.1);
    for (const p of bandOpenings) {
      const g = p.geometry;
      const width = p.width ?? g.along;
      const height = p.height ?? g.zMax - g.zMin;
      if (!(width > 0.05 && height > 0.05)) continue;
      const piece = labelAt(grid, pieces.labels, g.cx, g.cy);
      if (piece !== main && !(p.roof && piece === 0)) {
        // Autre volume (abri, bâtiment voisin) ou élément isolé hors de toute emprise.
        foreignOpenings++;
        continue;
      }
      if (!p.curtain && (p.width === null || p.height === null)) measuredCount++;
      if (p.curtain) curtainCount++;
      let ax = g.cx - (g.dx * width) / 2;
      let ay = g.cy - (g.dy * width) / 2;
      let bx = g.cx + (g.dx * width) / 2;
      let by = g.cy + (g.dy * width) / 2;
      let exterior = false;
      let inwardX = 0;
      let inwardY = 0;
      if (p.roof) {
        roofWindows++;
      } else {
        const probe = probeExterior(grid, pieces.labels, g, Math.max(PROBE_REACH, g.depth / 2 + 0.5));
        if (probe.exterior) {
          // Arête du contour qui porte l'ouverture : proche du point de façade et à peu près parallèle.
          let best = -1;
          let bestD = edgeTol;
          for (let i = 0; i < outlineIfc.length; i++) {
            const a = outlineIfc[i]!;
            const b = outlineIfc[(i + 1) % outlineIfc.length]!;
            const ex = b.x - a.x;
            const ey = b.y - a.y;
            const el = Math.hypot(ex, ey);
            if (el < 1e-6 || Math.abs((ex * g.dx + ey * g.dy) / el) < 0.8) continue;
            const tt = Math.max(0, Math.min(1, ((probe.fx - a.x) * ex + (probe.fy - a.y) * ey) / (el * el)));
            const d = Math.hypot(probe.fx - (a.x + tt * ex), probe.fy - (a.y + tt * ey));
            if (d <= bestD) {
              bestD = d;
              best = i;
            }
          }
          if (best >= 0) {
            exterior = true;
            const a = outlineIfc[best]!;
            const b = outlineIfc[(best + 1) % outlineIfc.length]!;
            const el = Math.hypot(b.x - a.x, b.y - a.y);
            let ex = (b.x - a.x) / el;
            let ey = (b.y - a.y) / el;
            if (ex * g.dx + ey * g.dy < 0) {
              ex = -ex;
              ey = -ey;
            }
            // Centre de l'ouverture projeté sur la droite de l'arête : a et b sont SUR le contour.
            const s = (g.cx - a.x) * ex + (g.cy - a.y) * ey;
            const cx = a.x + s * ex;
            const cy = a.y + s * ey;
            ax = cx - (ex * width) / 2;
            ay = cy - (ey * width) / 2;
            bx = cx + (ex * width) / 2;
            by = cy + (ey * width) / 2;
            inwardX = -probe.nx;
            inwardY = -probe.ny;
          } else {
            offOutline++;
          }
        }
      }
      openings.push({
        kind: p.kind,
        a: { x: round(ax, 4), y: round(-ay, 4) },
        b: { x: round(bx, 4), y: round(-by, 4) },
        width: round(width, 3),
        height: round(height, 3),
        exterior,
      });
      if (exterior) {
        if (p.kind === 'door') extDoors++;
        else extWindows++;
      } else {
        inner++;
      }
      // Symbole : rectangle de la baie dans l'épaisseur du mur (et trait du vitrage pour une fenêtre).
      const depth = Math.min(Math.max(g.depth, 0.05), 0.8);
      let ox = -g.dy * depth;
      let oy = g.dx * depth;
      let sx = ax;
      let sy = ay;
      let ex2 = bx;
      let ey2 = by;
      if (exterior) {
        ox = inwardX * depth;
        oy = inwardY * depth;
      } else {
        sx -= ox / 2;
        sy -= oy / 2;
        ex2 -= ox / 2;
        ey2 -= oy / 2;
      }
      symbols.push(sx, -sy, ex2, -ey2, ex2, -ey2, ex2 + ox, -(ey2 + oy), ex2 + ox, -(ey2 + oy), sx + ox, -(sy + oy), sx + ox, -(sy + oy), sx, -sy);
      if (p.kind === 'window') symbols.push(sx + ox / 2, -(sy + oy / 2), ex2 + ox / 2, -(ey2 + oy / 2));
    }
    if (openings.length > 0) notes.push(msg('ifc.note.openings', { windows: extWindows, doors: extDoors, inner }));

    // Pièces du volume proposé.
    const rooms: DetectedRoom[] = [];
    const heights: { value: number; weight: number }[] = [];
    let statedMismatch = 0;
    for (const r of bandRooms) {
      if (roomPiece(r) !== main) {
        foreignRooms++;
        continue;
      }
      const info = r.space.info;
      const geo = r.geometry;
      const name = info.name !== '' ? info.name : msg('ifc.room.unnamed', { n: rooms.length + 1 });
      let guess = classifyRoomName(name);
      if (guess === 'ask' && info.altName) {
        const second = classifyRoomName(info.altName);
        if (second !== 'ask') guess = second;
      }
      const room: DetectedRoom = { name, heatedGuess: guess };
      if (info.statedArea !== null) room.statedArea = round(info.statedArea, 2);
      if (geo) {
        room.measuredArea = round(geo.usableArea, 2);
        room.at = { x: round(geo.at.x, 4), y: round(-geo.at.y, 4) };
        if (geo.polygon) room.polygon = geo.polygon.map((p) => ({ x: round(p.x, 4), y: round(-p.y, 4) }));
        if (geo.usableArea < 0.99 * geo.floorArea) {
          notes.push(msg('ifc.note.lowCeiling', { name, usable: fmt(geo.usableArea, 1), floor: fmt(geo.floorArea, 1) }));
        }
        heights.push({ value: geo.meanHeight, weight: geo.usableArea });
        if (room.statedArea !== undefined && Math.abs(room.statedArea - geo.usableArea) > Math.max(0.5, 0.02 * geo.usableArea)) statedMismatch++;
      } else if (info.statedHeight !== null && info.statedArea !== null) {
        heights.push({ value: info.statedHeight, weight: info.statedArea });
      }
      rooms.push(room);
    }
    // Locaux sans géométrie dans le fichier : repris par le niveau auquel ils sont rattachés, avec leur surface déclarée.
    const levelIds = new Set<number>([band.level.id, ...band.absorbed.map((l) => l.id)]);
    for (const info of model.spaces) {
      if (meshed.has(info.id) || info.levelId === null || !levelIds.has(info.levelId)) continue;
      const name = info.name !== '' ? info.name : msg('ifc.room.unnamed', { n: rooms.length + 1 });
      let guess = classifyRoomName(name);
      if (guess === 'ask' && info.altName) {
        const second = classifyRoomName(info.altName);
        if (second !== 'ask') guess = second;
      }
      const room: DetectedRoom = { name, heatedGuess: guess };
      if (info.statedArea !== null) room.statedArea = round(info.statedArea, 2);
      if (info.statedHeight !== null && info.statedArea !== null) heights.push({ value: info.statedHeight, weight: info.statedArea });
      rooms.push(room);
    }
    if (statedMismatch > 0) notes.push(msg('ifc.note.stated', { n: statedMismatch }));
    const clearHeight = weightedMedian(heights);
    if (clearHeight !== null) notes.push(msg('ifc.note.clearHeight'));

    // Traits du plan : coupe horizontale des murs à ~1,10 m, symboles des ouvertures.
    const lines: number[] = [];
    const cutZ = band.level.z + CUT_HEIGHT;
    for (const s of allSolids) {
      if (lines.length / 4 > MAX_SEGMENTS) break;
      const inside = cutZ > s.zMin + 0.02 && cutZ < s.zMax - 0.02 && cutZ > lo && cutZ < hi;
      cutSoup(s.soup, inside ? cutZ : (Math.max(s.zMin, lo) + Math.min(s.zMax, hi)) / 2, lines);
    }
    if (lines.length === 0) {
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i]!;
        const b = outline[(i + 1) % outline.length]!;
        lines.push(a.x, a.y, b.x, b.y);
      }
    }
    for (const v of symbols) lines.push(v);
    const segments = new Float32Array(lines);

    // Étendue du contenu.
    const bbox: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const grow = (x: number, y: number): void => {
      if (x < bbox.minX) bbox.minX = x;
      if (x > bbox.maxX) bbox.maxX = x;
      if (y < bbox.minY) bbox.minY = y;
      if (y > bbox.maxY) bbox.maxY = y;
    };
    for (const p of outline) grow(p.x, p.y);
    for (let i = 0; i + 1 < segments.length; i += 2) grow(segments[i]!, segments[i + 1]!);
    for (const r of rooms) for (const p of r.polygon ?? []) grow(p.x, p.y);

    const sheet: PlanSheet = {
      id: `ifc-${band.level.id}`,
      name: band.level.name,
      bbox,
      segments,
      metresPerUnit: { value: 1, from: 'plan', note: msg('ifc.scale.note', { unit: model.lengthUnit }) },
      detected: { outline, rooms, openings, elevation: round(band.level.elevation, 3), notes },
    };
    if (storeyHeight !== undefined) sheet.detected.storeyHeight = storeyHeight;
    // Dernier niveau : la hauteur s'arrête au sommet des murs, la toiture n'y est pas — à confirmer par l'expert.
    if (storeyHeight !== undefined && isTop) sheet.detected.storeyHeightToWallTop = true;
    if (eavesHeight !== undefined) sheet.detected.eavesHeight = eavesHeight;
    if (clearHeight !== null) sheet.detected.clearHeight = round(clearHeight, 2);
    sheetOf.set(band, sheet);
  });

  for (const band of kept) {
    const sheet = sheetOf.get(band);
    if (sheet) doc.sheets.push(sheet);
  }
  // Un niveau bien plus petit que les autres est rarement un étage (édicule, souche de cheminée, murs isolés).
  const areas = doc.sheets.map((s) => polygonArea(s.detected.outline ?? []));
  const largest = Math.max(0, ...areas);
  doc.sheets.forEach((s, i) => {
    const a = areas[i] ?? 0;
    if (a < SMALL_STOREY_SHARE * largest) warnings.push(msg('ifc.warn.smallStorey', { name: s.name, area: fmt(a, 1) }));
  });

  // ── Avertissements d'ensemble ──
  if (doc.sheets.length === 0) {
    warnings.unshift(msg('ifc.warn.empty'));
    return doc;
  }
  if (model.buildingCount > 1) warnings.push(msg('ifc.warn.buildings', { n: model.buildingCount }));
  if (pieceLevels.length > 0) warnings.push(msg('ifc.warn.pieces', { levels: quote(pieceLevels) }));
  if (foreignOpenings > 0 || foreignRooms > 0) warnings.push(msg('ifc.warn.otherPieces', { openings: foreignOpenings, rooms: foreignRooms }));
  const auxiliary = [...new Set([...absorbedNames, ...ignored.map((l) => l.name), ...selection.dropped.map((l) => l.name)])];
  if (auxiliary.length > 0) warnings.push(msg('ifc.warn.levelsAbsorbed', { names: quote(auxiliary) }));
  if (roofSpaces.length > 0) {
    warnings.push(msg('ifc.warn.roofSpaces', { n: roofSpaces.length, names: quote([...new Set(roofSpaces.map((s) => s.info.name))].slice(0, 4)) }));
  }
  if (model.spaces.length === roofSpaces.length) warnings.push(msg('ifc.warn.noSpaces'));
  warnings.push(msg('ifc.warn.zone'));
  if (placed.length > 0) warnings.push(msg('ifc.warn.overall'));
  if (measuredCount > 0) warnings.push(msg('ifc.warn.measured', { n: measuredCount }));
  if (unplaced > 0) warnings.push(msg('ifc.warn.unplaced', { n: unplaced }));
  if (roofWindows > 0) warnings.push(msg('ifc.warn.roofWindows', { n: roofWindows }));
  if (curtainCount > 0) warnings.push(msg('ifc.warn.curtainWalls', { n: curtainCount }));
  if (offOutline > 0) warnings.push(msg('ifc.warn.offOutline', { n: offOutline }));
  if (cell > (options.cell ?? CELL) * 1.01) warnings.push(msg('ifc.warn.coarse', { cell: fmt(cell * 100, 1) }));
  if (origin.x !== 0 || origin.y !== 0) warnings.push(msg('ifc.warn.shifted', { x: fmt(origin.x, 0), y: fmt(origin.y, 0) }));
  return doc;
}
