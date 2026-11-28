/**
 * Réponse de l'utilisateur à une question de doute (engine/doubts) : la valeur touchée prend la provenance 'user',
 * la question est notée tranchée (`answers.resolvedDoubts`) et n'est plus posée.
 *
 * Trois sortes de réponses :
 *  - un des choix proposés (`doubt.options[].value`), ou DOUBT_CONFIRM pour accepter la proposition ;
 *  - une saisie libre pour les questions qui en attendent une (nombre écrit avec une virgule ou un point : échelle
 *    1:N, hauteur d'étage, hauteur de baie, surface, nord, année ; texte pour l'adresse) ;
 *  - DOUBT_UNKNOWN (« je ne sais pas ») : la proposition est gardée, étiquetée HYPOTHÈSE (provenance 'default',
 *    confiance 0, source citée), et la question ne revient plus.
 * Une réponse incomprise laisse le projet tel quel (la question reste posée). Fonction pure.
 */
import { centroid, pointInPolygon, sectorOfAzimuth } from '../core/geometry';
import type {
  BottomKind,
  BuildingModel,
  Construction,
  HeatGenerator,
  Lang,
  Opening,
  PlanSheet,
  Project,
  ProjectAnswers,
  Provenance,
  Room,
  Sourced,
  Storey,
  TopKind,
  WindowType,
} from '../core/types';
import { CONFIDENCE_SINGLE_SOURCE } from '../core/reading';
import { t } from '../i18n';
import { DEFAULT_WINDOW_TYPE_ID } from './defaults';
import { withExpertWindowTypes } from './derive';
import type { Doubt, DoubtId } from './doubts';
import './messages';
import { heightFromOf, weakest, type OpeningHeights } from './provenance';
import { precalculatedU, precalculatedUw } from './uvalue';
import { rescaleStorey, restoreFootprint } from './storey';

/** Réponse spéciale « je ne sais pas » : la proposition est gardée, étiquetée hypothèse, et la question n'est plus posée. */
export const DOUBT_UNKNOWN = 'unknown';
/** Accepter la proposition de la question telle qu'elle est (questions sans choix, ou regroupées). */
export const DOUBT_CONFIRM = 'confirm';

const PDF_POINT_M = 0.0254 / 72;

type Mode = 'user' | 'unknown';

interface Step {
  project: Project;
  lang: Lang;
  mode: Mode;
}

/**
 * Applique la réponse à une question de doute : `value` est la valeur d'un des choix de `doubt.options`, une saisie
 * libre (nombre écrit avec une virgule ou un point) ou DOUBT_UNKNOWN. La question ne doit plus revenir ensuite
 * (collectDoubts la considère comme tranchée), sauf si la lecture change.
 */
export function applyDoubtAnswer(project: Project, doubt: Doubt, value: string, lang: Lang): Project {
  const raw = (value ?? '').trim();
  if (raw === '') return project;
  const unknown = raw === DOUBT_UNKNOWN;
  // « Je ne sais pas » : on applique la proposition, étiquetée hypothèse.
  const v = unknown ? (doubt.proposal?.value ?? DOUBT_CONFIRM) : raw === DOUBT_CONFIRM && doubt.proposal ? doubt.proposal.value : raw;
  const step: Step = { project: clone(project), lang, mode: unknown ? 'unknown' : 'user' };
  const handler = HANDLERS[doubt.id];
  const ok = handler(step, v, doubt);
  if (!ok && !unknown) return project;
  const answers = step.project.answers;
  return { ...step.project, answers: { ...answers, resolvedDoubts: { ...(answers.resolvedDoubts ?? {}), [doubt.id]: unknown ? 'unknown' : 'user' } } };
}

function clone(p: Project): Project {
  return structuredClone(p);
}

// ───────────────────────────── Outils ─────────────────────────────

/** Nombre écrit avec une virgule ou un point ; null sinon. */
function parseNumber(text: string): number | null {
  const s = text.replace(/\s+/g, '').replace(',', '.');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseNumbers(text: string): number[] | null {
  const parts = text.split(/\s*[;/|]\s*|\s+(?=\d)/).filter((x) => x.trim() !== '');
  const out = parts.map(parseNumber);
  return out.length > 0 && out.every((x): x is number => x !== null) ? out : null;
}

const isConfirm = (v: string): boolean => v === DOUBT_CONFIRM;

function hypothesisSource(lang: Lang): string {
  return t(lang, 'doubt.unknown.source');
}

/** Pose une réponse : confirmée (retirée des propositions) ou hypothèse (proposition de confiance 0). */
function setAnswer<K extends keyof ProjectAnswers>(s: Step, key: K, value: ProjectAnswers[K]): void {
  const a = s.project.answers;
  a[key] = value;
  const proposed = { ...(a.proposed ?? {}) };
  if (s.mode === 'user') delete proposed[key];
  else proposed[key] = { confidence: 0, source: hypothesisSource(s.lang) };
  if (Object.keys(proposed).length > 0) a.proposed = proposed;
  else delete a.proposed;
}

/**
 * Valeur SUGGÉRÉE par la carte (et non donnée par l'utilisateur) : posée comme proposition, avec sa confiance et sa
 * source, jamais en provenance utilisateur ; une réponse déjà donnée par l'utilisateur n'est pas écrasée.
 */
function suggestAnswer<K extends keyof ProjectAnswers>(s: Step, key: K, value: ProjectAnswers[K], confidence: number, source: string): void {
  const a = s.project.answers;
  const current = a[key];
  // Déjà renseignée (par l'utilisateur, ou proposée par la lecture avec sa propre confiance) : gardée telle quelle.
  if (current !== null && current !== undefined && current !== '') return;
  a[key] = value;
  a.proposed = { ...(a.proposed ?? {}), [key]: { confidence: s.mode === 'user' ? confidence : 0, source } };
}

/** Provenance d'une valeur touchée : 'user', ou hypothèse étiquetée pour « je ne sais pas ». */
function touched<T>(s: Step, value: T, keep?: Sourced<T>): Sourced<T> {
  if (s.mode === 'user') {
    const out: Sourced<T> = { value, from: 'user' };
    if (keep?.note) out.note = keep.note;
    return out;
  }
  return { value, from: 'default', confidence: 0, source: hypothesisSource(s.lang) };
}

// ───────────────────────────── Une fonction par question ─────────────────────────────

type Handler = (s: Step, v: string, doubt: Doubt) => boolean;

const OPTION = <T extends string>(allowed: readonly T[], v: string): T | null => (allowed as readonly string[]).includes(v) ? (v as T) : null;

const HANDLERS: Record<DoubtId, Handler> = {
  occasion: (s, v) => {
    const o = OPTION(['new', 'existing'] as const, v);
    if (!o) return false;
    setAnswer(s, 'occasion', o);
    return true;
  },

  attached: (s, v) => {
    const o = OPTION(['one-side', 'other'] as const, v);
    if (!o) return false;
    setAnswer(s, 'attachment', o);
    return true;
  },

  scale: (s, v) => {
    const m = s.project.model;
    if (isConfirm(v)) {
      const mark = (st: Storey): Storey => ({ ...st, metresPerUnit: touched(s, st.metresPerUnit.value, st.metresPerUnit) });
      m.storeys = m.storeys.map(mark);
      if (m.unheatedStoreys) m.unheatedStoreys = m.unheatedStoreys.map(mark);
      return true;
    }
    // Saisie libre : « 1:100 » ou « 100 ». Seulement pour une feuille en points PDF à une échelle ronde.
    const den = parseNumber(v.replace(/^1\s*[:/]\s*/, ''));
    if (den === null || !(den >= 1 && den <= 5000)) return false;
    const rescale = (st: Storey): Storey | null => {
      const den0 = st.metresPerUnit.value / PDF_POINT_M;
      if (!(den0 > 0) || Math.abs(den0 - Math.round(den0)) > 0.02 * den0) return null;
      return rescaleStorey(st, { ...touched(s, PDF_POINT_M * den), note: `1:${formatDen(den)}` });
    };
    const next = m.storeys.map(rescale);
    if (next.some((x) => x === null)) return false;
    m.storeys = next as Storey[];
    if (m.unheatedStoreys) m.unheatedStoreys = m.unheatedStoreys.map((st) => rescale(st) ?? st);
    return true;
  },

  top: (s, v) => {
    const kinds: Record<string, TopKind> = { flat: 'flat-roof', pitched: 'pitched-roof', attic: 'attic-ceiling' };
    const kind = kinds[v];
    if (!kind) return false;
    s.project.model.top = { ...s.project.model.top, kind, from: s.mode === 'user' ? 'user' : 'default' };
    return true;
  },

  bottom: (s, v) => {
    const m = s.project.model;
    const kinds: Record<string, BottomKind> = { ground: 'slab-on-ground', 'basement-unheated': 'above-unheated', 'basement-heated': 'slab-on-ground' };
    const kind = kinds[v];
    if (!kind) return false;
    m.bottom = { ...m.bottom, kind, from: s.mode === 'user' ? 'user' : 'default' };
    // Sous-sol chauffé : les niveaux lus sous le rez reviennent dans le volume chauffé, murs contre terre.
    if (v === 'basement-heated' && (m.unheatedStoreys ?? []).length > 0) {
      const back = m.unheatedStoreys!.map((st) => ({
        ...st,
        edges: st.edges.map((e) => ({ ...e, boundary: e.boundary === 'heated' ? e.boundary : ('ground' as const) })),
        rooms: st.rooms.map((r) => (r.unlabelled ? r : { ...r, heated: true, needsReview: false })),
      }));
      m.storeys = [...back, ...m.storeys];
      delete m.unheatedStoreys;
    }
    return true;
  },

  'unheated-zone': (s, v) => {
    if (v === 'unheated') return true;
    if (v !== 'heated') return false;
    // Le local est dans le volume chauffé : l'emprise entière redevient le contour, le local compte dans An.
    const m = s.project.model;
    m.storeys = m.storeys.map((st) => {
      if (!st.footprint || !st.edges.some((e) => e.boundary === 'unheated')) return st;
      const sheet: PlanSheet = {
        id: st.sheetId ?? st.id,
        name: st.name,
        bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        metresPerUnit: st.metresPerUnit,
        detected: {
          outline: st.footprint.outline,
          rooms: [],
          openings: st.footprint.openings.map((o) => ({ kind: o.kind, a: o.a, b: o.b, width: o.width, height: o.height, exterior: true })),
          notes: [],
        },
      };
      const restored = restoreFootprint(st, sheet);
      if (!restored) return st;
      const old = st.outline;
      const rooms = restored.rooms.map((r): Room => {
        if (r.heated || r.unlabelled || !r.polygon || r.polygon.length < 3) return r;
        const c = centroid(r.polygon);
        return pointInPolygon(c, st.footprint!.outline) && !pointInPolygon(c, old) ? { ...r, heated: true, needsReview: false, area: touched(s, r.area.value, r.area) } : r;
      });
      const { footprint: _f, ...rest } = restored;
      return { ...rest, rooms };
    });
    return true;
  },

  'an-unlabelled': (s, v) => {
    const m = s.project.model;
    const unlabelled = m.storeys.flatMap((st) => st.rooms.filter((r) => r.unlabelled));
    const total = unlabelled.reduce((a, r) => a + (r.area.value > 0 ? r.area.value : 0), 0);
    const count = (st: Storey, heated: boolean): Storey => ({
      ...st,
      rooms: st.rooms.map((r) => (r.unlabelled ? { ...r, heated, needsReview: false, area: touched(s, r.area.value, r.area) } : r)),
    });
    if (v === 'include' || v === 'exclude') {
      m.storeys = m.storeys.map((st) => count(st, v === 'include'));
      return true;
    }
    // Niveau par niveau : « only:<niveau> » (ce niveau seulement) ou « <niveau>=include;<niveau>=exclude ».
    const levels = new Set(m.storeys.filter((st) => st.rooms.some((r) => r.unlabelled)).map((st) => st.id));
    let choice: Map<string, boolean> | null = null;
    if (v.startsWith('only:')) {
      const id = v.slice(5);
      if (levels.has(id)) choice = new Map([...levels].map((x) => [x, x === id]));
    } else if (v.includes('=')) {
      const map = new Map<string, boolean>();
      for (const part of v.split(/\s*;\s*/).filter(Boolean)) {
        const [id, how] = part.split('=').map((x) => x.trim());
        if (!id || !levels.has(id) || (how !== 'include' && how !== 'exclude')) return false;
        map.set(id, how === 'include');
      }
      if (map.size > 0) choice = map;
    }
    if (choice) {
      const c = choice;
      m.storeys = m.storeys.map((st) => (c.has(st.id) ? count(st, c.get(st.id)!) : st));
      return true;
    }
    // Saisie libre : surface (m²) à compter en plus des pièces étiquetées, répartie comme les surfaces mesurées.
    const area = parseNumber(v);
    if (area === null || !(area >= 0) || area > 10000) return false;
    if (total > 0) {
      m.storeys = m.storeys.map((st) => ({
        ...st,
        rooms: st.rooms.map((r) => (r.unlabelled ? { ...r, heated: area > 0, needsReview: false, area: touched(s, Math.round(((area * r.area.value) / total) * 100) / 100) } : r)),
      }));
      return true;
    }
    const first = m.storeys[0];
    if (!first) return false;
    const room: Room = { id: `${first.id}-unlabelled`, name: t(s.lang, 'auto.room.unlabelled'), area: touched(s, area), heated: area > 0, needsReview: false, unlabelled: true };
    m.storeys = [{ ...first, rooms: [...first.rooms, room] }, ...m.storeys.slice(1)];
    return true;
  },

  materials: (s, v) => {
    if (!isConfirm(v)) return false;
    if (s.mode === 'unknown') return true; // déjà des hypothèses étiquetées
    s.project.model.constructions = s.project.model.constructions.map((c): Construction => {
      if (c.category === 'door' || !(c.layers && c.layers.length > 0)) return c;
      const layers = c.layers.map((l) => {
        if (!l.lambda) return l; // aucune λ proposée : reste à choisir dans l'outil
        const { doubt: _d, ...rest } = l;
        return { ...rest, lambda: { value: l.lambda.value, from: 'user' as const }, thicknessCm: l.thicknessUnknown ? l.thicknessCm : { value: l.thicknessCm.value, from: 'user' as const } };
      });
      const next: Construction = { ...c, layers };
      next.u = precalculatedU(next);
      return next;
    });
    return true;
  },

  windows: (s, v) => {
    if (!(isConfirm(v) || v === 'triple-new')) return false;
    if (s.mode === 'unknown') return true;
    const m = s.project.model;
    const mine = <T>(x: Sourced<T> | null | undefined): Sourced<T> | null | undefined => (x ? { value: x.value, from: 'user' } : x);
    m.windowTypes = m.windowTypes.map((w): WindowType => {
      const next: WindowType = { ...w, g: mine(w.g) ?? null };
      if (w.ug !== undefined) next.ug = mine(w.ug) ?? null;
      if (w.uf !== undefined) next.uf = mine(w.uf) ?? null;
      if (w.psiG !== undefined) next.psiG = mine(w.psiG) ?? null;
      if (w.geometry) next.geometry = { ...w.geometry, frameWidth: { value: w.geometry.frameWidth.value, from: 'user' }, fensterTyp: { value: w.geometry.fensterTyp.value, from: 'user' } };
      const uw = precalculatedUw(next);
      if (uw) {
        const { detail: _detail, ...value } = uw;
        next.uw = value;
      } else if (w.uw) next.uw = { value: w.uw.value, from: 'user' };
      return next;
    });
    m.constructions = m.constructions.map((c) => (c.category === 'door' && c.u ? { ...c, u: { value: c.u.value, from: 'user' } } : c));
    return true;
  },

  ventilation: (s, v) => {
    const o = OPTION(['windows', 'exhaust', 'balanced-hr'] as const, v);
    if (!o) return false;
    setAnswer(s, 'ventilation', o);
    return true;
  },

  heating: (s, v) => {
    const generators: readonly HeatGenerator[] = ['gas-condensing', 'gas-low-temp', 'oil-condensing', 'oil-low-temp', 'old-boiler', 'heat-pump-air', 'heat-pump-ground', 'pellets', 'wood-logs', 'district-heating', 'electric-direct', 'other'];
    const g = OPTION(generators, v);
    if (!g) return false;
    setAnswer(s, 'heatGenerator', g);
    // La carte SUGGÈRE aussi l'émission et l'eau chaude (plancher chauffant basse température pour une pompe à
    // chaleur, eau chaude par le même générateur, ballon dans le volume chauffé) : l'utilisateur ne les a pas
    // données, elles restent des hypothèses (confiance 0) à confirmer dans le dossier.
    const usual = t(s.lang, 'doubt.suggested.source');
    if (g === 'heat-pump-air' || g === 'heat-pump-ground') {
      suggestAnswer(s, 'heatEmission', 'floor-heating', 0, usual);
      suggestAnswer(s, 'emissionTemps', '35/28', 0, usual);
    }
    suggestAnswer(s, 'hotWater', 'with-heating', 0, usual);
    suggestAnswer(s, 'hotWaterStorageInside', true, 0, usual);
    return true;
  },

  'thermal-bridges': (s, v) => {
    const o = OPTION(['0.10', '0.05', '0.03', 'detailed'] as const, v);
    if (!o) return false;
    setAnswer(s, 'thermalBridges', o);
    // Construction lourde : béton ou maçonnerie lus dans les compositions.
    const heavy = s.project.model.constructions.some((c) => (c.layers ?? []).some((l) => ['beton', 'beton-arme', 'bloc-beton', 'brique', 'silico-calcaire'].includes(l.material ?? '')));
    // Lue dans les compositions, pas donnée par l'utilisateur : une proposition, avec la confiance d'une source.
    if (heavy) suggestAnswer(s, 'thermalMass', 'heavy', CONFIDENCE_SINGLE_SOURCE, t(s.lang, 'doubt.suggested.compositions'));
    return true;
  },

  openings: (_s, v) => isConfirm(v),

  'building-type': (s, v) => {
    const o = OPTION(['EFH', 'MFH'] as const, v);
    if (!o) return false;
    setAnswer(s, 'buildingType', o);
    const a = s.project.answers;
    if (o === 'EFH') setAnswer(s, 'dwellings', 1);
    else if (a.dwellings !== null && a.dwellings > 1) setAnswer(s, 'dwellings', a.dwellings);
    else if (a.dwellings === 1) a.dwellings = null; // un immeuble collectif n'a pas un seul logement : à saisir
    return true;
  },

  heights: (s, v) => {
    const m = s.project.model;
    if (isConfirm(v)) {
      m.storeys = m.storeys.map((st) => ({ ...st, grossHeight: touched(s, st.grossHeight.value, st.grossHeight) }));
      return true;
    }
    const values = parseNumbers(v);
    if (!values || !values.every((h) => h > 1 && h < 20) || !(values.length === 1 || values.length === m.storeys.length)) return false;
    m.storeys = m.storeys.map((st, i) => ({ ...st, grossHeight: touched(s, values.length === 1 ? values[0]! : values[i]!) }));
    return true;
  },

  'room-heated': (s, v) => {
    if (v !== 'heated' && v !== 'unheated') return false;
    const heated = v === 'heated';
    const m = s.project.model;
    // « Je ne sais pas » : la pièce est comptée comme proposé, mais reste signalée à trancher (hypothèse).
    const review = s.mode === 'unknown';
    m.storeys = m.storeys.map((st) => ({
      ...st,
      rooms: st.rooms.map((r) => (r.needsReview && !r.unlabelled && r.area.value > 0 ? { ...r, heated, needsReview: review } : r)),
    }));
    return true;
  },

  'opening-heights': (s, v, doubt) => {
    const m = s.project.model;
    // Hauteur donnée par l'utilisateur (ou hypothèse étiquetée) : la largeur garde sa provenance ; la baie entière
    // prend la plus faible des deux (une largeur supposée reste « estimate », jamais confirmée par ricochet).
    const heightMark: Provenance = s.mode === 'user' ? 'user' : 'default';
    const setHeight = (o: OpeningHeights, height: number): OpeningHeights => {
      const widthFrom: Provenance = o.from === 'default' ? 'plan' : o.from;
      return { ...o, height, heightFrom: heightMark, from: s.mode === 'user' ? weakest(widthFrom, 'user') : o.from };
    };
    // Convention de hauteur pour tout le projet : cote du plan, cote du plan + 5 cm, ou hauteur vue en façade.
    if (doubt.options.some((o) => o.value === 'elevation')) {
      if (v !== 'plan' && v !== 'plan+5' && v !== 'elevation') return false;
      const pick = (o: OpeningHeights): number | null => {
        if (o.heightPlan === undefined || o.heightElevation === undefined) return null;
        if (v === 'plan') return o.heightPlan;
        if (v === 'plan+5') return Math.round((o.heightPlan + 0.05) * 1000) / 1000;
        return o.heightElevation;
      };
      m.storeys = m.storeys.map((st) => ({
        ...st,
        openings: st.openings.map((o) => {
          const h = pick(o as OpeningHeights);
          return h === null ? o : setHeight(o as OpeningHeights, h);
        }),
      }));
      return true;
    }
    // Seules les FENÊTRES dont la hauteur est une valeur d'usage sont visées : une hauteur lue n'est jamais remplacée,
    // une porte garde sa hauteur de porte.
    const target = (o: Opening): boolean => o.kind === 'window' && heightFromOf(o) === 'default';
    if (isConfirm(v)) {
      if (s.mode === 'unknown') return true;
      m.storeys = m.storeys.map((st) => ({ ...st, openings: st.openings.map((o) => (target(o) ? setHeight(o as OpeningHeights, o.height) : o)) }));
      return true;
    }
    const h = parseNumber(v);
    if (h === null || !(h > 0.2 && h < 6)) return false;
    if (!m.storeys.some((st) => st.openings.some(target))) return false;
    m.storeys = m.storeys.map((st) => ({ ...st, openings: st.openings.map((o) => (target(o) ? setHeight(o as OpeningHeights, h) : o)) }));
    return true;
  },

  renewables: (s, v) => {
    if (v !== 'none' && v !== 'pv' && v !== 'solar-thermal') return false;
    setAnswer(s, 'photovoltaic', v === 'pv');
    setAnswer(s, 'solarThermal', v === 'solar-thermal');
    return true;
  },

  north: (s, v) => {
    const m = s.project.model;
    if (isConfirm(v)) {
      if (s.mode === 'unknown') {
        m.northAngle = touched(s, m.northAngle.value);
        return true;
      }
      m.northAngle = touched(s, m.northAngle.value, m.northAngle);
      return true;
    }
    const a = parseNumber(v.replace(/°$/, ''));
    if (a === null || Math.abs(a) > 3600) return false;
    s.project.model = reorient({ ...m, northAngle: touched(s, ((a % 360) + 360) % 360) }, s.lang);
    return true;
  },

  year: (s, v) => {
    const y = parseNumber(v);
    if (y === null || !Number.isInteger(y) || y < 1800 || y > 2200) return false;
    setAnswer(s, 'yearBuilt', y);
    return true;
  },

  identity: (s, v) => {
    const a = s.project.answers;
    if (isConfirm(v)) {
      if (!(a.street.trim() && a.locality.trim())) return false;
      for (const key of ['projectName', 'street', 'postcode', 'locality'] as const) if (a[key].trim()) setAnswer(s, key, a[key]);
      return true;
    }
    // « 12, rue des Essais, L-0000 Exempleville » : la partie avec le code postal donne la localité.
    const parts = v.split(/\s*[,;\n]\s*/).filter(Boolean);
    const at = parts.findIndex((p) => /^(L-?\s?)?\d{4}\b/i.test(p));
    if (at < 0) {
      setAnswer(s, 'street', v);
      return true;
    }
    const m = /^((?:L-?\s?)?\d{4})\s+(.+)$/i.exec(parts[at]!);
    if (m) {
      setAnswer(s, 'postcode', m[1]!.replace(/\s/g, '').toUpperCase());
      setAnswer(s, 'locality', m[2]!.trim());
    } else setAnswer(s, 'postcode', parts[at]!.toUpperCase());
    const street = parts.slice(0, at).join(', ');
    if (street) setAnswer(s, 'street', street);
    return true;
  },
};

function formatDen(den: number): string {
  return Number.isInteger(den) ? String(den) : String(den).replace('.', ',');
}

/**
 * Nord corrigé : l'orientation des façades dessinées suit (côté du plan + nouveau nord), et les types de fenêtres
 * nommés par façade sont refaits. Les valeurs confirmées d'un type sont reportées sur le type de mêmes dimensions.
 */
function reorient(model: BuildingModel, lang: Lang): BuildingModel {
  const north = model.northAngle.value;
  const facadeViews = model.facadeViews?.map((f) =>
    f.planSideDeg !== undefined ? { ...f, orientation: sectorOfAzimuth((((north + f.planSideDeg) % 360) + 360) % 360) } : f,
  );
  const auto = /^window-(N|NE|E|SE|S|SW|W|NW)-\d+-\d+$/;
  const old = model.windowTypes.filter((w) => auto.test(w.id));
  const reset: BuildingModel = {
    ...model,
    ...(facadeViews ? { facadeViews } : {}),
    windowTypes: model.windowTypes.filter((w) => !auto.test(w.id)),
    storeys: model.storeys.map((st) => ({
      ...st,
      openings: st.openings.map((o) => (o.windowTypeId !== null && auto.test(o.windowTypeId) ? { ...o, windowTypeId: null } : o)),
    })),
  };
  const next = withExpertWindowTypes(reset, lang);
  // Report des valeurs confirmées par dimensions (largeur × hauteur en cm).
  const dims = (id: string): string => id.replace(/^window-[A-Z]+-/, '');
  return {
    ...next,
    windowTypes: next.windowTypes.map((w) => {
      if (!auto.test(w.id) || w.id === DEFAULT_WINDOW_TYPE_ID) return w;
      const before = old.find((o) => dims(o.id) === dims(w.id) && (o.ug?.from === 'user' || o.uw?.from === 'user'));
      return before ? { ...before, id: w.id, name: w.name } : w;
    }),
  };
}
