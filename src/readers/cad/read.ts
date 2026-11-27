/**
 * Lecture COMPLÈTE d'un DWG / DXF dans le fil courant : décodage (load.ts), analyse (analyse.ts), feuilles.
 * C'est ce module que le worker exécute dans le navigateur (cad.worker.ts) ; sous Node (tests) et en repli,
 * index.ts l'appelle directement. Il embarque acad-ts et jsts : le fil principal ne le charge qu'en repli.
 *
 * Ce que la lecture produit est décrit dans index.ts (et dans PlanDocument, core/types.ts).
 */
import type { DetectedOpening, DetectedRoom, PlanDocument, PlanSheet, PlanText, Sourced, Vec2 } from '../../core/types';
import { formatNumber } from '../../i18n';
import { guessStorey, parseArea } from '../../semantics/labels';
import { analyse } from './analyse';
import type { Analysis, PlanAnalysis } from './analyse';
import { classifyLayer } from './layers';
import type { CadRead, CadReadOptions } from './details';
import { thinSegments } from './display';
import { readDrawing } from './load';
import { cadLang, msg, setCadLang } from './messages';
import { CadReadError } from './raw';
import type { RawDrawing } from './raw';
import { ringArea } from './planar';
import type { Box } from './planar';
import { nearestUnit, unitDef } from './units';
import type { UnitEvidence } from './units';

const MAX_DISPLAY_TEXTS = 20_000;

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '');
}

// ───────────────────────────── Unité ─────────────────────────────

function unitName(perMetre: number): string {
  return msg(unitDef(perMetre).key);
}

function buildScale(perMetre: number | null, evidence: readonly UnitEvidence[]): Sourced<number> | null {
  if (perMetre === null) return null;
  const value = unitDef(perMetre).metres;
  const unit = unitName(perMetre);
  const distinct = new Set(evidence.map((e) => unitDef(e.perMetre).perMetre));
  if (distinct.size > 1) {
    const details = evidence.map((e) => `${msg(`cad.unit.source.${e.source}`)} : ${unitName(e.perMetre)}`).join(' ; ');
    return { value, from: 'estimate', note: msg('cad.unit.note.conflict', { details, unit }) };
  }
  const sources = [...new Set(evidence.map((e) => e.source))];
  if (sources.length === 0) return { value, from: 'estimate', note: msg('cad.unit.note.weak', { unit }) };
  const list = sources.map((s) => msg(`cad.unit.source.${s}`)).join(', ');
  // Un indice isolé (en-tête laissé par défaut, épaisseur des murs…) ne suffit pas : il en faut deux concordants.
  if (sources.length === 1) return { value, from: 'estimate', note: msg('cad.unit.note.single', { unit, source: list }) };
  return { value, from: 'plan', note: msg('cad.unit.note.agreed', { unit, sources: list }) };
}

// ───────────────────────────── Feuilles ─────────────────────────────

interface Territory {
  /** Indice du plan dans l'analyse ; −1 = feuille unique sans plan détecté. */
  plan: number;
  box: Box | null;
  margin: number;
}

interface SheetContent {
  segIdx: number[];
  textIdx: number[];
}

/** Répartit traits et textes entre les feuilles : chaque objet va au plan le plus proche, s'il n'en est pas trop loin. */
function distribute(raw: RawDrawing, territories: readonly Territory[]): SheetContent[] {
  // Plusieurs plans : le cadre et le cartouche communs n'appartiennent à aucun d'eux.
  const frameLayers = new Set<number>();
  if (territories.length > 1) raw.layers.forEach((name, i) => classifyLayer(name) === 'frame' && frameLayers.add(i));
  const out: SheetContent[] = territories.map(() => ({ segIdx: [], textIdx: [] }));
  const pick = (x: number, y: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < territories.length; i++) {
      const t = territories[i]!;
      if (!t.box) return i;
      const dx = Math.max(t.box.minX - x, 0, x - t.box.maxX);
      const dy = Math.max(t.box.minY - y, 0, y - t.box.maxY);
      const dist = Math.hypot(dx, dy);
      if (dist <= t.margin && dist < bestD) {
        bestD = dist;
        best = i;
      }
    }
    return best;
  };
  const within = (x: number, y: number, t: Territory): boolean =>
    !t.box || (x >= t.box.minX - t.margin && x <= t.box.maxX + t.margin && y >= t.box.minY - t.margin && y <= t.box.maxY + t.margin);
  for (let i = 0; i < raw.segCount; i++) {
    if (frameLayers.has(raw.segLayer[i]!)) continue;
    const x1 = raw.segXY[4 * i]!;
    const y1 = raw.segXY[4 * i + 1]!;
    const x2 = raw.segXY[4 * i + 2]!;
    const y2 = raw.segXY[4 * i + 3]!;
    const k = pick((x1 + x2) / 2, (y1 + y2) / 2);
    // Un long trait qui déborde du voisinage du plan (cadre commun à plusieurs plans) n'appartient à aucune feuille.
    if (k >= 0 && within(x1, y1, territories[k]!) && within(x2, y2, territories[k]!)) out[k]!.segIdx.push(i);
  }
  raw.texts.forEach((t, i) => {
    if (t.hidden) return;
    const k = pick(t.cx, t.cy);
    if (k >= 0) out[k]!.textIdx.push(i);
  });
  return out;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

function sheetNames(plans: readonly PlanAnalysis[], order: readonly number[], fileName: string): string[] {
  const names = order.map((k, pos) => {
    const p = plans[k]!;
    if (p.storey) return p.storey[cadLang()];
    if (p.viewTitle) return p.viewTitle;
    if (order.length === 1) {
      const fromFile = guessStorey(baseName(fileName).replace(/[_\-.]+/g, ' '));
      return fromFile ? fromFile[cadLang()] : baseName(fileName) || msg('cad.sheet.all');
    }
    return msg('cad.sheet.plan', { n: pos + 1 });
  });
  // Deux plans du même niveau (« Étage aile A », « Étage aile B ») : leurs titres sont plus parlants.
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const refined = names.map((n, pos) => {
    const p = plans[order[pos]!]!;
    return (counts.get(n) ?? 0) > 1 && p.title ? p.title : n;
  });
  return uniqueNames(refined);
}

function planNotes(p: PlanAnalysis, a: Analysis, u: number): string[] {
  const notes: string[] = [];
  if (p.viewTitle) {
    notes.push(msg('cad.note.view', { title: p.viewTitle }));
    return notes;
  }
  if (a.wallLayers.length > 0) notes.push(msg('cad.note.walls', { layers: a.wallLayers.join(', ') }));
  if (p.outline) {
    const area = formatNumber(ringArea(p.outline) / (u * u), 1);
    const gap = formatNumber(2 * p.closeRadius, 1);
    if (p.outlineMode === 'exact') notes.push(msg('cad.note.outline.exact', { area }));
    else if (p.outlineMode === 'stable') notes.push(msg('cad.note.outline.stable', { area, gap }));
    else notes.push(msg('cad.note.outline.approx', { area, gap, count: p.unpairedJambs }));
    if (p.unheatedInside.length > 0) notes.push(msg('cad.note.outline.unheated', { rooms: p.unheatedInside.map((r) => `« ${r} »`).join(', ') }));
  } else {
    notes.push(msg('cad.note.outline.none'));
  }
  for (const group of p.mergedRooms) notes.push(msg('cad.note.rooms.merged', { rooms: group.join(' + ') }));
  if (p.unrecognisedRooms.length > 0) {
    // Les textes lus sont cités ; les faces sans aucun texte sont comptées à part.
    const named = p.unrecognisedRooms.filter((n) => n !== '').map((name) => msg('cad.note.rooms.quoted', { name }));
    const blank = p.unrecognisedRooms.length - named.length;
    if (blank > 0) named.push(msg('cad.note.rooms.blank', { count: blank }));
    notes.push(msg('cad.note.rooms.unrecognised', { count: p.unrecognisedRooms.length, rooms: named.join(', ') }));
  }
  for (const [room, stated, measured] of p.areaMismatches) {
    notes.push(msg('cad.note.rooms.mismatch', { room, stated: formatNumber(stated), measured: formatNumber(measured) }));
  }
  const unknown = p.openings.filter((o) => o.kind === 'unknown').length;
  if (unknown > 0) notes.push(msg('cad.note.openings.unknown', { count: unknown }));
  if (p.rejectedOpenings > 0) notes.push(msg('cad.note.openings.rejected', { count: p.rejectedOpenings }));
  return notes;
}

// ───────────────────────────── Lecture ─────────────────────────────

/**
 * Lit un DWG ou un DXF dans le fil courant. Lève une erreur (message dans la langue demandée) si le fichier
 * est illisible, abîmé ou vide.
 */
export async function readCadInProcess(data: ArrayBuffer, fileName: string, kind: 'dwg' | 'dxf', options: CadReadOptions = {}): Promise<CadRead> {
  setCadLang(options.lang ?? 'fr');
  const t0 = Date.now();
  let raw: RawDrawing;
  try {
    raw = await readDrawing(data, kind, pause, options.decodeBudgetMs === undefined ? {} : { budgetMs: options.decodeBudgetMs });
  } catch (err) {
    if (err instanceof CadReadError) {
      const key = err.reason === 'empty' ? 'cad.error.empty' : `cad.error.unreadable.${kind}`;
      throw new Error(msg(key, { kind: kind.toUpperCase(), detail: err.message.slice(0, 80) }));
    }
    throw err;
  }
  const t1 = Date.now();
  if (raw.segCount === 0 && raw.texts.length === 0) {
    // Rien de lu ET des objets endommagés : le fichier est abîmé, pas vide.
    throw new Error(msg(raw.stats.damagedObjects > 0 ? `cad.error.unreadable.${kind}` : 'cad.error.empty', { kind: kind.toUpperCase() }));
  }

  const warnings: string[] = [];

  // ── Analyse, puis contrôle de l'unité par les surfaces écrites dans les pièces ──
  let a: Analysis;
  try {
    a = await analyse(raw, {}, pause);
  } catch {
    // Géométrie pathologique : on rend quand même le dessin, l'expert tracera le contour à la main.
    a = { perMetre: null, evidence: [], agreed: false, wallLayers: [], wallSource: 'none', walls: null, plans: [], droppedPlans: 0, north: null, areaRatios: [] };
    warnings.push(msg('cad.warn.analysis'));
  }
  const evidence = [...a.evidence];
  if (a.perMetre !== null && a.areaRatios.length > 0) {
    const ratio = median(a.areaRatios);
    if (ratio >= 0.8 && ratio <= 1.25) {
      evidence.push({ source: 'areas', perMetre: a.perMetre, weight: 2, detail: String(a.areaRatios.length) });
    } else {
      const fixed = nearestUnit(a.perMetre * Math.sqrt(ratio));
      let corrected = false;
      if (fixed !== null && unitDef(fixed).perMetre !== unitDef(a.perMetre).perMetre) {
        let second: Analysis | null = null;
        try {
          second = await analyse(raw, { forcedPerMetre: fixed }, pause);
        } catch {
          second = null;
        }
        const ratio2 = second && second.areaRatios.length > 0 ? median(second.areaRatios) : 0;
        if (second && ratio2 >= 0.8 && ratio2 <= 1.25) {
          a = second;
          corrected = true;
          evidence.push({ source: 'areas', perMetre: fixed, weight: 2, detail: String(second.areaRatios.length) });
          warnings.push(msg('cad.warn.unit.corrected', { unit: unitName(fixed) }));
        }
      }
      if (!corrected) warnings.push(msg('cad.warn.unit.areas', { ratio: formatNumber(ratio) }));
    }
  }
  // ── Sondage : rien ne se referme (ou unité inconnue) alors que des surfaces sont écrites sur le plan ──
  // Cas type : en-tête laissé en mm par le gabarit, dessin en cm ou en m, sans porte pour le contredire.
  {
    const sources = new Set(evidence.map((e) => e.source));
    const units = new Set(evidence.map((e) => unitDef(e.perMetre).perMetre));
    const confirmed = units.size === 1 && sources.size >= 2;
    const nothingFound = a.perMetre === null || (a.areaRatios.length === 0 && !a.plans.some((p) => p.outline));
    const hasAreas = raw.texts.some((t) => !t.dim && !t.hidden && parseArea(t.text) !== null);
    if (!confirmed && nothingFound && hasAreas && raw.segCount <= 400_000) {
      for (const candidate of [100, 1000, 1]) {
        if (a.perMetre !== null && unitDef(a.perMetre).perMetre === candidate) continue;
        let trial: Analysis | null = null;
        try {
          trial = await analyse(raw, { forcedPerMetre: candidate }, pause);
        } catch {
          trial = null;
        }
        const ratio = trial && trial.areaRatios.length > 0 ? median(trial.areaRatios) : 0;
        if (trial && ratio >= 0.8 && ratio <= 1.25) {
          if (a.perMetre !== null) warnings.push(msg('cad.warn.unit.corrected', { unit: unitName(candidate) }));
          a = trial;
          evidence.push({ source: 'areas', perMetre: candidate, weight: 2, detail: String(trial.areaRatios.length) });
          break;
        }
      }
    }
  }
  const t2 = Date.now();
  const u = a.perMetre;
  const scale = buildScale(u, evidence);
  if (!scale) warnings.push(msg('cad.warn.unit.unknown'));
  else if (scale.from !== 'plan' && scale.note) warnings.push(scale.note);

  if (a.tooHeavy !== undefined) warnings.push(msg('cad.warn.heavy', { count: a.tooHeavy }));
  if (a.wallSource === 'geometry') warnings.push(msg('cad.warn.walls.guessed', { layers: a.wallLayers.join(', ') }));
  else if (a.wallSource === 'none' && u !== null) warnings.push(msg('cad.warn.walls.none'));

  // ── Ordre des feuilles : niveaux reconnus du bas vers le haut, puis de gauche à droite ──
  const order = a.plans.map((_p, i) => i);
  order.sort((i, j) => {
    const p = a.plans[i]!;
    const q = a.plans[j]!;
    const rp = p.viewTitle ? 2 : p.storey ? 0 : 1;
    const rq = q.viewTitle ? 2 : q.storey ? 0 : 1;
    if (rp !== rq) return rp - rq;
    if (p.storey && q.storey && p.storey.rank !== q.storey.rank) return p.storey.rank - q.storey.rank;
    return p.box.minX - q.box.minX || q.box.maxY - p.box.maxY;
  });

  const territories: Territory[] =
    order.length === 0
      ? [{ plan: -1, box: null, margin: Infinity }]
      : order.map((k) => {
          const p = a.plans[k]!;
          const size = Math.max(p.box.maxX - p.box.minX, p.box.maxY - p.box.minY);
          const metres = u ?? 1;
          const margin = order.length === 1 ? Math.max(15 * metres, 1.5 * size) : Math.max(4 * metres, 0.5 * size);
          return { plan: k, box: p.box, margin };
        });
  const contents = distribute(raw, territories);
  const names =
    order.length === 0
      ? [guessStorey(baseName(fileName).replace(/[_\-.]+/g, ' '))?.[cadLang()] ?? (baseName(fileName) || msg('cad.sheet.all'))]
      : sheetNames(a.plans, order, fileName);
  const wallLayerSet = new Set(a.wallLayers.map((name) => raw.layers.indexOf(name)));

  const sheets: PlanSheet[] = [];
  const sheetOrigins: { x0: number; y0: number }[] = [];
  for (let s = 0; s < territories.length; s++) {
    const territory = territories[s]!;
    const content = contents[s]!;
    const plan = territory.plan >= 0 ? a.plans[territory.plan]! : null;
    const name = names[s]!;
    const light = thinSegments(raw, content.segIdx, wallLayerSet);
    if (light.dropped > 0) warnings.push(msg('cad.warn.display', { sheet: name, total: content.segIdx.length, dropped: light.dropped }));

    // Étendue du contenu dans le repère d'analyse.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const grow = (x: number, y: number): void => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    for (const i of light.kept) {
      grow(raw.segXY[4 * i]!, raw.segXY[4 * i + 1]!);
      grow(raw.segXY[4 * i + 2]!, raw.segXY[4 * i + 3]!);
    }
    const textIdx = content.textIdx.slice(0, MAX_DISPLAY_TEXTS);
    for (const i of textIdx) for (const line of raw.texts[i]!.lines) grow(line.x, line.y);
    if (plan) for (const p of plan.hull) grow(p.x, p.y);
    if (!Number.isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = 0;
      maxY = 0;
    }
    const x0 = minX;
    const y0 = maxY;
    sheetOrigins.push({ x0: x0 + raw.origin.x, y0: y0 + raw.origin.y });
    const toSheet = (p: Vec2): Vec2 => ({ x: p.x - x0, y: y0 - p.y });

    const segments = new Float32Array(light.kept.length * 4);
    light.kept.forEach((i, n) => {
      segments[4 * n] = raw.segXY[4 * i]! - x0;
      segments[4 * n + 1] = y0 - raw.segXY[4 * i + 1]!;
      segments[4 * n + 2] = raw.segXY[4 * i + 2]! - x0;
      segments[4 * n + 3] = y0 - raw.segXY[4 * i + 3]!;
    });
    const texts: PlanText[] = [];
    for (const i of textIdx) {
      const t = raw.texts[i]!;
      for (const line of t.lines) {
        const pt: PlanText = { text: line.text, x: line.x - x0, y: y0 - line.y };
        if (t.height > 0) pt.height = t.height;
        texts.push(pt);
      }
    }

    const rooms: DetectedRoom[] = [];
    const openings: DetectedOpening[] = [];
    let outline: Vec2[] | undefined;
    let notes: string[] = [];
    if (plan && u !== null) {
      notes = planNotes(plan, a, u);
      if (!plan.viewTitle) {
        outline = plan.outline?.map(toSheet);
        for (const r of plan.rooms) {
          const room: DetectedRoom = { name: r.name, heatedGuess: r.heatedGuess };
          if (r.statedArea !== undefined) room.statedArea = r.statedArea;
          if (r.measuredArea !== undefined) room.measuredArea = r.measuredArea;
          if (r.polygon) room.polygon = r.polygon.map(toSheet);
          if (r.at) room.at = toSheet(r.at);
          rooms.push(room);
        }
        for (const o of plan.openings) {
          const opening: DetectedOpening = { kind: o.kind, a: toSheet(o.a), b: toSheet(o.b), exterior: true };
          opening.width = Math.round((o.width / u) * 1000) / 1000;
          if (o.height !== undefined) opening.height = o.height;
          openings.push(opening);
        }
        if (plan.outlineMode === 'approx') warnings.push(msg('cad.warn.outline.approx', { sheet: name }));
        if (!plan.outline) warnings.push(msg('cad.warn.outline.none', { sheet: name }));
      }
    }
    if (a.walls && s === 0) {
      if (a.walls.healed > 0) notes.push(msg('cad.note.healed', { count: a.walls.healed }));
      if (a.walls.jambsAdded > 0) notes.push(msg('cad.note.jambs', { count: a.walls.jambsAdded }));
      if (a.walls.layer0Adopted > 0) notes.push(msg('cad.note.layer0', { count: a.walls.layer0Adopted }));
    }

    const sheet: PlanSheet = {
      id: `cad-${s + 1}`,
      name,
      bbox: { minX: 0, minY: 0, maxX: maxX - minX, maxY: maxY - minY },
      segments,
      texts,
      metresPerUnit: scale ? { ...scale } : null,
      detected: { rooms, openings, notes },
    };
    if (outline) sheet.detected.outline = outline;
    sheets.push(sheet);
    await pause();
  }

  // ── Avertissements d'ensemble ──
  const planSheets = sheets.filter((sh) => sh.detected.outline);
  if (u !== null && a.wallSource !== 'none' && a.tooHeavy === undefined && planSheets.length === 0) warnings.push(msg('cad.warn.plans.none'));
  if (order.length > 1) warnings.push(msg('cad.warn.plans.several', { count: order.length }));
  if (a.droppedPlans > 0) warnings.push(msg('cad.warn.plans.dropped', { count: a.droppedPlans }));
  {
    // Pièces au nom reconnu : celles que l'analyse n'a pas rangées parmi les faces sans nom reconnu.
    const total = sheets.reduce((n, sh) => n + sh.detected.rooms.length, 0);
    const unrecognised = order.reduce((n, k) => n + (a.plans[k]!.viewTitle ? 0 : a.plans[k]!.unrecognisedRooms.length), 0);
    if (total === 0) warnings.push(msg('cad.warn.rooms.none'));
    else if (unrecognised >= total) warnings.push(msg('cad.warn.rooms.unnamedOnly', { count: total }));
  }
  if (!a.north) warnings.push(msg('cad.warn.north.none'));
  if (raw.stats.missingXrefs.length > 0) warnings.push(msg('cad.warn.xrefs', { names: raw.stats.missingXrefs.slice(0, 4).join(', ') }));
  if (raw.stats.hiddenLayerEntities > 0) warnings.push(msg('cad.warn.hidden', { count: raw.stats.hiddenLayerEntities }));
  if (raw.stats.truncated) warnings.push(msg('cad.warn.truncated'));
  // Objets d'un DWG dont le décodage a débordé de ses données : le fichier est abîmé, le dessin incomplet.
  if (raw.stats.damagedObjects > 0) warnings.push(msg('cad.warn.damaged', { count: raw.stats.damagedObjects }));
  if (raw.stats.farEntities > 0) warnings.push(msg('cad.warn.far', { count: raw.stats.farEntities }));
  {
    const list = Object.entries(raw.stats.unsupported)
      .filter(([name]) => name !== 'POINT' && name !== 'VIEWPORT')
      .sort((p, q) => q[1] - p[1])
      .slice(0, 5)
      .map(([name, count]) => `${count} ${name}`);
    if (list.length > 0) warnings.push(msg('cad.warn.unsupported', { list: list.join(', ') }));
  }

  const doc: PlanDocument = { fileName, kind, sheets, storeysAligned: false, warnings };
  if (a.north) {
    doc.northAngle = {
      value: a.north.angle,
      from: 'plan',
      note: msg(a.north.count > 1 ? 'cad.north.note.several' : 'cad.north.note', { block: a.north.block, count: a.north.count }),
    };
  }
  const t3 = Date.now();
  return {
    doc,
    details: {
      unitsPerMetre: u,
      unitEvidence: evidence,
      wallLayers: a.wallLayers,
      wallSource: a.wallSource,
      sheetOrigins,
      version: raw.version,
      entities: raw.stats.entities,
      segments: raw.segCount,
      timing: { read: t1 - t0, analyse: t2 - t1, total: t3 - t0 },
    },
  };
}
