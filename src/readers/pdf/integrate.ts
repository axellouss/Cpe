/**
 * LECTURE COMPLÈTE d'une planche : fait travailler ensemble les morceaux déjà vérifiés séparément (fonction PURE,
 * ni pdf.js ni DOM) :
 *
 *   vues (sheetviews.ts, déjà découpées par l'analyse) → textes (sheettext.ts : cartouche, tableau, niveaux,
 *   compositions, nord, équipements, cotes de baies, pièces) → géométrie de chaque plan d'étage (geometry/ :
 *   pièces, emprise, contour chauffé, mitoyenneté, baies) → bâtiment (toiture, façades, calage des plans,
 *   plancher au-dessus du non chauffé) → hauteurs libres des coupes → RECOUPEMENTS entre morceaux.
 *
 * Repli, morceau par morceau : quand la géométrie d'un plan ne donne pas de contour, la feuille garde la détection du
 * chemin habituel (murs, faces) ; quand le texte ne donne rien, les champs restent vides ; un morceau qui lève une
 * erreur est noté au journal et laissé de côté — jamais de plantage, jamais de valeur silencieusement fausse : chaque
 * désaccord entre deux morceaux devient un doute porté par la donnée (note de la feuille, doute de la vue, confiance
 * abaissée).
 */
import { CONFIDENCE_CROSS_CHECKED, type Evidence, type ReadView, type SheetReading } from '../../core/reading';
import type { DetectedRoom, Lang, PlanDocument, PlanSheet, SheetDetection, Vec2 } from '../../core/types';
import type { ReadProgress } from '../index';
import { readClearHeights } from './clearheights';
import { analyseFloorPlan, applyOpeningUpdates, readBuildingGeometry, type FloorPlanEntry, type FloorPlanGeometry } from './geometry';
import { msg } from './messages';
import { pointInPoly, ringArea } from './planar';
import { METRES_PER_POINT, type RawPage } from './raw';
import { readSheetText, type SheetRoomText, type SheetTextRead } from './sheettext';

const fmt = (v: number, d = 2): string => v.toFixed(d).replace('.', ',');
const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;

/** Pièces techniques qu'on range volontiers « non chauffé » par leur nom, mais qui, DANS l'isolant, sont chauffées. */
const TECH_RE = /local\s*tech|buanderie|technik|hausanschluss|waschk|hauswirtschaft|\bhwr\b|chaufferie|heizraum/i;

export interface IntegrateOptions {
  lang: Lang;
  /** Échelle annoncée par page (dénominateur), quand elle est connue. */
  declaredDen: (page: number) => number | null;
  onProgress?: (p: ReadProgress) => void;
}

export interface IntegrateResult {
  /** Avertissements à ajouter au document (déjà dans la langue de lecture). */
  warnings: string[];
  /** Avertissements du chemin habituel devenus faux (à retirer). */
  obsolete: (w: string) => boolean;
  /** Géométrie par feuille (diagnostic, tests). */
  geometry: Map<string, FloorPlanGeometry>;
  text: SheetTextRead | null;
  ms: Record<string, number>;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function textRoom(r: SheetRoomText): DetectedRoom {
  const room: DetectedRoom = { name: r.name, statedArea: r.statedArea, at: { x: r.at.x, y: r.at.y }, heatedGuess: r.heatedGuess };
  if (r.exterior) room.exterior = true;
  return room;
}

const ring = (r: readonly Vec2[] | undefined): Vec2[] | null => (r && r.length >= 3 ? [...r] : null);
const inRing = (p: Vec2, r: readonly Vec2[]): boolean => pointInPoly(p.x, p.y, { outer: [...r], holes: [] });
const inBox = (b: ReadView['box'], p: Vec2): boolean => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;

/** Partie fixe la plus longue d'un message (hors paramètres), pour reconnaître ses occurrences. */
function stem(lang: Lang, key: string): string {
  const s = msg(lang, key, { where: '\u0000', rooms: '\u0000', length: '\u0000' });
  return s
    .split(/\u0000|\{[^}]*\}/)
    .map((x) => x.trim().toLowerCase())
    .sort((a, b) => b.length - a.length)[0]!;
}

/** Les notes du chemin habituel qui parlent du contour, devenues fausses quand la géométrie en donne un. */
function outlineNote(lang: Lang): (n: string) => boolean {
  const stems = ['pdf.note.outline.none', 'pdf.note.outline.leak', 'pdf.note.outline.unsupported', 'pdf.note.outline.unheated', 'pdf.note.outline']
    .map((k) => stem(lang, k))
    .filter((s) => s.length >= 8);
  return (n) => stems.some((s) => n.toLowerCase().includes(s));
}

/**
 * Remplace la détection du chemin habituel par celle de la géométrie quand elle donne un contour ; sinon complète
 * seulement (pièces mesurées, si l'ancienne n'en a pas). Les notes sans rapport avec le contour sont gardées.
 */
/**
 * La géométrie vaut-elle mieux que le chemin habituel pour cette feuille ? Il faut un contour, une échelle recoupée
 * (surfaces écrites ou faces de murs, ≥ 0,85) d'accord avec celle de la feuille quand celle-ci est sûre, des murs
 * reconnus par leur matière (hachure ou remplissage), et ni moins de pièces mesurées ni beaucoup moins de baies.
 * Sinon la feuille garde sa lecture d'aujourd'hui.
 */
export function geometryIsBetter(sheet: PlanSheet, g: FloorPlanGeometry): boolean {
  const d = g.detection;
  const old = sheet.detected;
  if (ring(d.outline) === null || g.mpp === null || !g.scale || g.scale.confidence < CONFIDENCE_CROSS_CHECKED) return false;
  if (g.materials === 'none') return false;
  const cur = sheet.metresPerUnit;
  if (cur && cur.from === 'plan' && Math.abs(cur.value / g.mpp - 1) > 0.01) return false;
  // Pièces NOMMÉES et mesurées (les surfaces « à classer » sans nom du chemin habituel ne comptent pas).
  const measured = (rs: readonly DetectedRoom[]): number => rs.filter((r) => !r.exterior && r.name.trim() !== '' && r.polygon && r.polygon.length >= 3).length;
  if (measured(d.rooms) < measured(old.rooms)) return false;
  if (ring(old.outline) !== null && d.openings.length < 0.75 * old.openings.length) return false;
  return true;
}

function adoptGeometry(sheet: PlanSheet, g: FloorPlanGeometry, lang: Lang): boolean {
  const d = g.detection;
  const old = sheet.detected;
  if (!geometryIsBetter(sheet, g)) {
    // Repli : la lecture habituelle reste ; la géométrie n'apporte que ses doutes (portés par la vue).
    return false;
  }
  const isOutlineNote = outlineNote(lang);
  const kept = old.notes.filter((n) => !isOutlineNote(n));
  const next: SheetDetection = {
    ...d,
    // Confiance du contour : celle de l'emprise recoupée (cotes hors tout) et de l'échelle, la plus faible des deux.
    outlineConfidence: d.outlineConfidence ?? round(Math.min(d.footprintSize?.confidence ?? 0.65, g.scale?.confidence ?? 0.65), 2),
    notes: [...d.notes, ...kept.filter((n) => !d.notes.includes(n))],
  };
  // Emprise : la géométrie la mesure ; la lecture des vues (cotes hors tout) reste si la géométrie ne la donne pas.
  if (!next.footprintSize && old.footprintSize) next.footprintSize = old.footprintSize;
  for (const k of ['storeyHeight', 'clearHeight', 'elevation', 'eavesHeight', 'storeyHeightToWallTop', 'roofWindows'] as const) {
    if (next[k] === undefined && old[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = old[k];
  }
  sheet.detected = next;
  return true;
}

/** Surface des baies (fenêtres et portes-fenêtres) qui bordent une pièce, en m². */
function glazedNear(sheet: PlanSheet, room: DetectedRoom, mpp: number): number | null {
  const poly = ring(room.polygon);
  if (!poly) return null;
  const reach = 0.8 / mpp;
  let sum = 0;
  for (const o of sheet.detected.openings) {
    if (o.kind !== 'window' && o.detail !== 'french-window') continue;
    if (o.width === undefined || o.height === undefined) return null;
    const m = { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 };
    // Le milieu de la baie est sur le mur : à moins d'une épaisseur de mur du contour de la pièce.
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((m.x - p.x) * dx + (m.y - p.y) * dy) / l2));
      best = Math.min(best, Math.hypot(m.x - (p.x + t * dx), m.y - (p.y + t * dy)));
    }
    if (best <= reach) sum += o.width * o.height;
  }
  return sum;
}

export function integrateReading(pages: readonly RawPage[], doc: PlanDocument, opts: IntegrateOptions): IntegrateResult {
  const lang = opts.lang;
  const say = (key: string, params?: Record<string, string | number>): string => msg(lang, key, params);
  const emit = (p: ReadProgress): void => {
    try {
      opts.onProgress?.(p);
    } catch {
      // Le suivi ne doit jamais interrompre la lecture.
    }
  };
  const reading: SheetReading = doc.reading!;
  const views = reading.views;
  const log = reading.log;
  const warnings: string[] = [];
  const partial: string[] = [];
  const ms: Record<string, number> = {};
  const geometry = new Map<string, FloorPlanGeometry>();
  const sheetOf = new Map(doc.sheets.map((s) => [s.id, s]));
  const pageOf = new Map(pages.map((p) => [p.number, p]));

  emit({
    stage: 'views',
    status: views.length > 0 ? 'done' : 'skipped',
    counts: {
      plans: views.filter((v) => v.kind === 'floor-plan').length,
      sections: views.filter((v) => v.kind === 'section').length,
      elevations: views.filter((v) => v.kind === 'elevation').length,
      sheets: doc.sheets.length,
    },
  });

  // ── Textes ──
  let t0 = now();
  let text: SheetTextRead | null = null;
  if (pages.some((p) => p.texts.length > 0)) {
    try {
      text = readSheetText(pages, views, { lang });
    } catch (error) {
      log.push(`lecture des textes en échec : ${String(error)}`);
    }
  }
  ms.text = now() - t0;
  if (text) {
    reading.titleBlock = text.titleBlock;
    reading.siteAreas = text.siteAreas;
    reading.levels = text.levels;
    reading.compositions = text.compositions;
    reading.north = text.north;
    reading.equipment = text.equipment;
    reading.systems = text.systems;
    reading.openingPairs = text.openingPairs;
    reading.glazing = text.glazing;
    log.push(...text.log);
    for (const d of text.doubts) {
      const v = d.ref ? views.find((x) => x.id === d.ref) : undefined;
      if (v && !v.doubts.includes(d.text)) v.doubts.push(d.text);
    }
  }

  // Plans d'étage reconnus par le découpage mais restés sans feuille (page lue par le chemin habituel, vues sans
  // titre) : rattachés à la feuille de la même page qui couvre la même étendue, une feuille par vue au plus.
  linkOrphanViews(views, doc.sheets);

  // ── Géométrie de chaque plan d'étage ──
  t0 = now();
  const entries: FloorPlanEntry[] = [];
  const floorViews = views.filter((v) => v.kind === 'floor-plan' && v.sheetId !== null && sheetOf.has(v.sheetId));
  let roomCount = 0;
  let outlines = 0;
  reattachPairs(reading, floorViews, (v) => {
    const s = sheetOf.get(v.sheetId!);
    const den = opts.declaredDen(v.page) ?? text?.titleBlock?.scaleDen ?? null;
    return s?.metresPerUnit?.value ?? (den !== null ? den * METRES_PER_POINT : null);
  });
  for (const view of floorViews) {
    const sheet = sheetOf.get(view.sheetId!)!;
    const page = pageOf.get(view.page);
    if (!page) continue;
    const den = opts.declaredDen(view.page) ?? text?.titleBlock?.scaleDen ?? null;
    const declaredMpp = sheet.metresPerUnit?.value ?? (den !== null ? den * METRES_PER_POINT : null);
    // Paires « largeur / hauteur » : celles de la vue, écrites dans sa boîte.
    const pairs = reading.openingPairs.filter((p) => p.page === view.page && p.viewId === view.id);
    // Pièces écrites : seulement celles qui portent un nom (une surface seule n'est pas une pièce).
    const rooms = (text?.rooms[view.id] ?? []).filter((r) => r.name.trim() !== '' && inBox(view.box, r.at)).map(textRoom);
    const glazing = (text?.glazing ?? []).filter((g) => g.page === view.page && (g.viewId === view.id || g.viewId === null) && inBox(view.box, g.at));
    let g: FloorPlanGeometry;
    try {
      // La boîte de la vue s'étend jusqu'à ses cotes de baies (une chaîne de cotes déborde souvent du découpage).
      const box = pairs.reduce((b, p) => ({ minX: Math.min(b.minX, p.at.x - 2), minY: Math.min(b.minY, p.at.y - 2), maxX: Math.max(b.maxX, p.at.x + 2), maxY: Math.max(b.maxY, p.at.y + 2) }), view.box);
      g = analyseFloorPlan(page, { id: view.id, box, storeyRank: view.storeyRank }, { declaredMpp, openingPairs: pairs, rooms, glazing, lang });
    } catch (error) {
      log.push(`géométrie de ${view.id} en échec : ${String(error)}`);
      continue;
    }
    geometry.set(sheet.id, g);
    log.push(`géométrie ${view.id} : ${g.detection.rooms.length} pièce(s), contour ${g.detection.outline ? 'oui' : 'non'}, ${g.detection.openings.length} baie(s), ${Math.round(g.ms)} ms`);
    const adopted = adoptGeometry(sheet, g, lang);
    if (adopted) for (const d of g.doubts) if (!view.doubts.includes(d)) view.doubts.push(d);
    // Échelle de la feuille : recoupée par les surfaces écrites (la géométrie la mesure par leur mode).
    if (adopted && g.mpp !== null && g.scale && g.scale.confidence >= CONFIDENCE_CROSS_CHECKED) {
      const cur = sheet.metresPerUnit;
      const agrees = cur !== null && Math.abs(cur.value / g.mpp - 1) <= 0.005;
      if (!cur || cur.from !== 'plan' || !agrees) {
        const denG = Math.round(g.mpp / METRES_PER_POINT);
        sheet.metresPerUnit = { value: g.mpp, from: 'plan', note: say('pdf.int.scale.areas', { scale: `1:${denG}`, rooms: g.scale.support }), confidence: g.scale.confidence };
      }
    }
    if (adopted) {
      outlines++;
      entries.push({ view, detection: sheet.detected, mpp: sheet.metresPerUnit?.value ?? g.mpp! });
      if (!view.buildingBox && sheet.detected.outline) {
        const xs = sheet.detected.outline.map((p) => p.x);
        const ys = sheet.detected.outline.map((p) => p.y);
        view.buildingBox = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
        view.sources = [...view.sources, 'geometry-outline'];
      }
    } else {
      if (!ring(sheet.detected.outline)) partial.push(say('pdf.int.reason.noOutline', { view: sheet.name }));
      // Le contour du chemin habituel reste proposé ; il sert aussi au bâtiment (toiture, façades) s'il existe.
      if (ring(sheet.detected.outline) && sheet.metresPerUnit) entries.push({ view, detection: sheet.detected, mpp: sheet.metresPerUnit.value });
    }
    roomCount += sheet.detected.rooms.filter((r) => !r.exterior).length;
    if (sheet.detected.rooms.length === 0) partial.push(say('pdf.int.reason.noRooms', { view: sheet.name }));
  }
  ms.geometry = now() - t0;
  emit({ stage: 'rooms', status: floorViews.length > 0 ? 'done' : 'skipped', counts: { rooms: roomCount, plans: floorViews.length } });

  // ── Bâtiment : toiture, façades, calage, plancher au-dessus du non chauffé ──
  t0 = now();
  if (entries.length > 0 || views.some((v) => v.kind === 'roof-plan' || v.kind === 'elevation')) {
    try {
      const b = readBuildingGeometry(pages, views, entries, { north: reading.north, lang });
      applyOpeningUpdates(entries, b.openingUpdates);
      reading.roof = b.roof;
      reading.elevations = b.elevations;
      reading.alignment = b.alignment;
      reading.floorOverUnheated = b.floorOverUnheated.map((f) => ({ sheetId: f.sheetId, belowSheetId: f.belowSheetId, areaM2: f.areaM2, polygon: f.polygon, confidence: f.confidence }));
      reading.floorOverOutside = b.floorOverOutside.map((f) => ({ sheetId: f.sheetId, belowSheetId: null, areaM2: f.areaM2, confidence: 0.65 }));
      for (const d of b.doubts) log.push(`doute bâtiment : ${d}`);
      if (b.alignment.length > 0) doc.storeysAligned = false;
      log.push(`bâtiment : toiture ${b.roof ? 'oui' : 'non'}, ${b.elevations.length} façade(s), ${b.alignment.length} calage(s), ${b.floorOverUnheated.length} plancher(s) sur non chauffé`);
    } catch (error) {
      log.push(`bâtiment en échec : ${String(error)}`);
    }
  }
  // Toiture plate sans signal propre au plan de toiture : l'acrotère coté (sommet « top ») recoupé par une
  // composition de toiture sans pente écrite. Une seule source chacune : à confirmer (0,65), jamais plus.
  const levels = reading.levels;
  if (levels?.top?.role === 'top' && levels.eaves === null && (!reading.roof || reading.roof.flat === null)) {
    const roofComp = reading.compositions.some((c) => c.element === 'roof');
    // Sans plan de toiture, la toiture n'est connue que par ces signaux : pas de contour ni de dimensions inventés.
    reading.roof ??= { sheetId: null, outline: null, widthM: null, depthM: null, areaM2: null, flat: null, pitchDeg: null };
    reading.roof.flat = { value: true, confidence: roofComp ? 0.65 : 0.5, evidence: [{ source: 'parapet-level', detail: `+${fmt(levels.top.rel)}` }, ...(roofComp ? [{ source: 'roof-composition' }] : [])], doubt: null };
  }
  ms.building = now() - t0;

  // ── Recoupements entre morceaux ──
  const sheetsOrdered = floorViews.map((v) => sheetOf.get(v.sheetId!)!).sort((a, b) => (a.storeyRank ?? 0) - (b.storeyRank ?? 0));
  let checks = 0;
  for (const sheet of sheetsOrdered) {
    const det = sheet.detected;
    const view = floorViews.find((v) => v.sheetId === sheet.id)!;
    const mpp = sheet.metresPerUnit?.value ?? null;
    const heated = ring(det.heatedOutline);
    // Local technique / buanderie DANS l'enveloppe isolée → chauffé.
    if (heated) {
      for (const r of det.rooms) {
        if (r.exterior || !TECH_RE.test(r.name)) continue;
        const at = r.at ?? (r.polygon ? r.polygon[0] : undefined);
        if (!at || !inRing(at, heated)) continue;
        if ((det.unheatedZones ?? []).some((z) => z.polygon.length >= 3 && inRing(at, z.polygon))) continue;
        checks++;
        // Deux signaux indépendants : le nom (local technique, buanderie) et l'isolant qui l'entoure. Le doute du
        // texte sur cette pièce (« dans l'isolation ou dehors ? ») est levé par le dessin.
        const before = view.doubts.length;
        view.doubts = view.doubts.filter((x) => !x.includes(`« ${r.name} »`) && !x.includes(`„${r.name}“`));
        if (r.heatedGuess === 'yes' && view.doubts.length === before) continue;
        r.heatedGuess = 'yes';
        r.confidence = Math.max(r.confidence ?? 0, CONFIDENCE_CROSS_CHECKED);
        det.notes.push(say('pdf.int.heated.tech', { room: r.name }));
      }
    }
    // Surface vitrée écrite (encadré d'éclairement) face aux baies trouvées le long de la pièce.
    if (mpp !== null) {
      for (const gbox of reading.glazing.filter((g) => g.page === view.page && inBox(view.box, g.at) && g.glazedArea !== null)) {
        const room = det.rooms.find((r) => gbox.room !== null && r.name.toLowerCase() === gbox.room.toLowerCase()) ?? det.rooms.find((r) => r.polygon && inRing(gbox.at, r.polygon));
        if (!room) continue;
        room.glazedArea ??= gbox.glazedArea!;
        const found = glazedNear(sheet, room, mpp);
        if (found === null) continue;
        checks++;
        const stated = gbox.glazedArea!;
        if (Math.abs(found - stated) > Math.max(0.5, 0.15 * stated)) {
          const text = say('pdf.int.glazing.doubt', { room: room.name, stated: fmt(stated), found: fmt(found) });
          det.notes.push(text);
          view.doubts.push(text);
          room.confidence = Math.min(room.confidence ?? 1, 0.6);
        } else log.push(`surface vitrée ${room.name} : écrite ${stated}, baies ${round(found)} (accord)`);
      }
    }
  }
  // Emprise mesurée face au tableau des surfaces (emprise au sol).
  const table = reading.siteAreas?.footprint?.value;
  const ground = sheetsOrdered.find((s) => (s.storeyRank ?? 0) === 0) ?? sheetsOrdered[0];
  if (table !== undefined && ground) {
    const mpp = ground.metresPerUnit?.value ?? null;
    const out = ring(ground.detected.outline);
    const fp = ground.detected.footprintSize;
    const area = out && mpp !== null ? ringArea(out) * mpp * mpp : fp ? fp.width * fp.depth : null;
    if (area !== null) {
      checks++;
      const view = floorViews.find((v) => v.sheetId === ground.id)!;
      if (Math.abs(area / table - 1) <= 0.03) {
        ground.detected.notes.push(say('pdf.int.footprint.agree', { area: fmt(area), table: fmt(table) }));
        if (ground.detected.outlineConfidence !== undefined) ground.detected.outlineConfidence = Math.max(ground.detected.outlineConfidence, CONFIDENCE_CROSS_CHECKED);
        if (fp) fp.confidence = Math.max(fp.confidence, CONFIDENCE_CROSS_CHECKED);
      } else {
        const text = say('pdf.int.footprint.doubt', { area: fmt(area), table: fmt(table) });
        ground.detected.notes.push(text);
        view.doubts.push(text);
        if (ground.detected.outlineConfidence !== undefined) ground.detected.outlineConfidence = Math.min(ground.detected.outlineConfidence, 0.6);
        if (fp) fp.confidence = Math.min(fp.confidence, 0.6);
      }
    }
  }

  // ── Niveaux et hauteurs, d'après les niveaux lus (coupes, plans) ──
  const floors = levels ? [...levels.floors].sort((a, b) => a.rel - b.rel) : [];
  if (levels && floors.length > 0 && sheetsOrdered.length > 0) {
    // Appariement : par la vue (niveau écrit sur le plan), sinon dans l'ordre quand les nombres concordent.
    const byView = sheetsOrdered.map((s) => {
      const vid = floorViews.find((v) => v.sheetId === s.id)?.id;
      return floors.find((f) => vid !== undefined && f.viewIds.includes(vid));
    });
    // Plans sous le premier niveau fini lu (sous-sol non coté) : on n'apparie que dans l'ordre si les comptes concordent.
    const paired = byView.every((f) => f !== undefined) && new Set(byView).size === byView.length ? byView : floors.length === sheetsOrdered.length ? sheetsOrdered.map((_, i) => floors[i]) : null;
    if (!paired) {
      checks++;
      const text = say('pdf.int.storeys.doubt', { plans: sheetsOrdered.length, levels: floors.length });
      log.push(text);
      for (const s of sheetsOrdered) {
        const v = floorViews.find((x) => x.sheetId === s.id);
        if (v && !v.doubts.includes(text)) v.doubts.push(text);
      }
    } else {
      checks++;
      paired.forEach((f, i) => {
        if (!f) return;
        const s = sheetsOrdered[i]!;
        s.detected.elevation = f.rel;
        const fi = floors.indexOf(f);
        const next = floors[fi + 1];
        if (next) s.detected.storeyHeight = round(next.rel - f.rel, 3);
      });
    }
  }
  // Hauteurs libres : chaînes de cotes des coupes entre deux niveaux finis, mentions « HSP ».
  try {
    const ch = readClearHeights(pages, views, levels, (v) => {
      const den = opts.declaredDen(v.page) ?? text?.titleBlock?.scaleDen ?? null;
      return den !== null ? den * METRES_PER_POINT : null;
    });
    log.push(...ch.log);
    if (ch.byFloor.length > 0) {
      reading.clearHeightsByFloor = ch.byFloor;
      if (levels) {
        // ReadLevels.clearHeights : une valeur par niveau rattaché, dans l'ordre des niveaux (le moteur s'en sert
        // quand il y en a une par étage, ou une seule pour tous).
        const tied = ch.byFloor.filter((c) => c.floorIndex !== null);
        const values = tied.length > 0 ? tied.map((c) => c.value) : [...new Set(ch.byFloor.map((c) => c.value))];
        if (levels.clearHeights.length === 0) levels.clearHeights = values;
      }
      for (const c of ch.byFloor) {
        const f = c.floorIndex !== null ? floors[c.floorIndex] : undefined;
        const targets = f
          ? sheetsOrdered.filter((s) => s.detected.elevation !== undefined && Math.abs(s.detected.elevation - f.rel) < 0.011)
          : ch.byFloor.length === 1
            ? sheetsOrdered
            : [];
        for (const s of targets) {
          s.detected.clearHeight = c.value;
          s.detected.notes.push(say('pdf.int.clear.note', { value: fmt(c.value) }));
        }
      }
    }
  } catch (error) {
    log.push(`hauteurs libres en échec : ${String(error)}`);
  }
  emit({ stage: 'envelope', status: floorViews.length > 0 ? 'done' : 'skipped', counts: { outlines, openings: sheetsOrdered.reduce((n, s) => n + s.detected.openings.length, 0), elevations: reading.elevations.length, roof: reading.roof ? 1 : 0 } });
  emit({ stage: 'layers', status: text ? 'done' : 'skipped', counts: { compositions: reading.compositions.length, levels: floors.length } });

  // ── Nord : la flèche lue (texte NORD + symbole) prime sur l'ancienne détection (lettre N près d'un cercle) ──
  if (reading.north) {
    const n = reading.north;
    const note = say(n.marginDeg < 10 ? 'pdf.int.north.doubt' : 'pdf.int.north.note', { deg: fmt(n.sheetUpAzimuth, 0), margin: fmt(n.marginDeg, 0) });
    doc.northAngle = { value: round(n.sheetUpAzimuth, 1), from: n.confidence >= CONFIDENCE_CROSS_CHECKED ? 'plan' : 'estimate', note, confidence: n.confidence };
  }

  // ── Preuves : page et endroit partout où on les connaît (l'interface montre « où ») ──
  const tb = reading.titleBlock;
  if (tb) {
    for (const r of [tb.buildingType, tb.dwellings, tb.occasion]) fillEvidence(r?.evidence, tb.page, tb.box);
  }
  const systems = reading.systems;
  if (systems) {
    for (const r of [systems.heatGenerator, systems.hotWater, systems.ventilation, systems.photovoltaic, systems.solarThermal]) {
      if (!r) continue;
      const eq = reading.equipment[0];
      fillEvidence(r.evidence, eq?.page ?? null, null);
    }
  }
  if (reading.north) fillEvidence(reading.north.evidence, reading.north.page, reading.north.box);
  if (reading.roof?.flat) {
    const rv = views.find((v) => v.kind === 'roof-plan');
    fillEvidence(reading.roof.flat.evidence, rv?.page ?? null, rv?.box ?? null);
  }
  for (const e of reading.elevations) {
    const ev = views.find((v) => v.id === e.viewId);
    if (e.planSideDeg && ev) fillEvidence(e.planSideDeg.evidence, ev.page, ev.box);
  }

  // ── Avertissements ──
  const noOutline = stem(lang, 'pdf.warn.noOutline');
  const allOutlined = floorViews.length > 0 && floorViews.every((v) => ring(sheetOf.get(v.sheetId!)!.detected.outline) !== null);
  const obsolete = (w: string): boolean => allOutlined && noOutline.length >= 8 && w.toLowerCase().includes(noOutline);
  const reasons = [...new Set(partial)];
  if (reasons.length > 0) warnings.push(say('pdf.int.partial', { reasons: reasons.join(' ; ') }));
  emit({ stage: 'check', status: 'done', counts: { checks, doubts: views.reduce((n, v) => n + v.doubts.length, 0), warnings: warnings.length } });
  return { warnings, obsolete, geometry, text, ms };
}

/**
 * Une cote de baie « largeur / hauteur » appartient au plan d'étage dont le BÂTIMENT est le plus proche, à moins de
 * 4 m de son mur : le découpage en vues peut couper une chaîne de cotes et la donner au plan voisin. Sans emprise du
 * bâtiment, on garde la vue où elle est écrite. Une paire trop loin de tout bâtiment ne sert à aucun plan.
 */
function reattachPairs(reading: SheetReading, floors: readonly ReadView[], mppOf: (v: ReadView) => number | null): void {
  const gap = (b: ReadView['box'], p: Vec2): number => Math.hypot(Math.max(b.minX - p.x, 0, p.x - b.maxX), Math.max(b.minY - p.y, 0, p.y - b.maxY));
  for (const pair of reading.openingPairs) {
    const own = floors.filter((v) => v.page === pair.page);
    const near = own
      .filter((v) => v.buildingBox !== null)
      .map((v) => ({ v, d: gap(v.buildingBox!, pair.at), m: mppOf(v) }))
      .filter((x) => x.m !== null && x.d * x.m <= 4)
      .sort((a, b) => a.d - b.d)[0];
    if (near) {
      if (pair.viewId !== near.v.id) reading.log.push(`cote de baie ${pair.width}/${pair.height} rattachée à ${near.v.id} (écrite dans ${pair.viewId ?? 'aucune vue'})`);
      pair.viewId = near.v.id;
      continue;
    }
    const inside = own.find((v) => inBox(v.box, pair.at) && v.buildingBox === null);
    pair.viewId = inside ? inside.id : pair.viewId !== null && own.some((v) => v.id === pair.viewId && v.buildingBox === null) ? pair.viewId : null;
  }
}

function linkOrphanViews(views: ReadView[], sheets: readonly PlanSheet[]): void {
  const taken = new Set(views.map((v) => v.sheetId).filter((x): x is string => x !== null));
  const area = (b: ReadView['box']): number => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
  for (const v of views) {
    if (v.kind !== 'floor-plan' || v.sheetId !== null) continue;
    const cands = sheets
      .filter((s) => s.page === v.page && !taken.has(s.id) && (s.role ?? 'floor-plan') === 'floor-plan')
      .map((s) => {
        const b = s.bbox;
        const inter = { minX: Math.max(b.minX, v.box.minX), minY: Math.max(b.minY, v.box.minY), maxX: Math.min(b.maxX, v.box.maxX), maxY: Math.min(b.maxY, v.box.maxY) };
        return { s, share: area(inter) / Math.max(1e-9, Math.min(area(b), area(v.box))), ratio: area(b) / Math.max(1e-9, area(v.box)) };
      })
      // Même étendue à peu près : une feuille « page entière » ne se rattache pas à une vue.
      .filter((c) => c.share >= 0.6 && c.ratio <= 2.5 && c.ratio >= 0.4)
      .sort((a, b) => b.share - a.share);
    const best = cands[0];
    if (!best) continue;
    v.sheetId = best.s.id;
    v.sources = [...v.sources, 'sheet-overlap'];
    taken.add(best.s.id);
    if ((best.s.storeyRank === undefined || best.s.storeyRank === null) && v.storeyRank !== null) best.s.storeyRank = v.storeyRank;
  }
}

function fillEvidence(list: Evidence[] | undefined, page: number | null, box: Evidence['box'] | null): void {
  if (!list) return;
  for (const e of list) {
    if (e.page === undefined && page !== null) e.page = page;
    if (e.box === undefined && box) e.box = { ...box };
  }
}
