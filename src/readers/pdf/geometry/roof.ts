/**
 * Toiture lue sur un plan de toiture : contour = ANNEAU EXTÉRIEUR du remplissage de toiture (jamais son aire
 * pair-impair : une toiture plate dessinée avec son acrotère est un anneau percé, dont l'aire n'est que la bande
 * d'acrotère). Toiture plate : acrotère dessiné (anneau intérieur ou remplissage intérieur parallèle au bord, à
 * 0,1–0,8 m) et/ou mention écrite ; pente : degrés écrits.
 */
import type { Vec2 } from '../../../core/types';
import type { ReadRoof } from '../../../core/reading';
import { ringArea } from '../planar';
import type { RawBox } from '../raw';
import type { FillShape, ViewInput } from './types';
import { boxContains, boxH, boxW, rectangularity, ringBox, round } from './util';

const FLAT_RE = /toit(?:ure)?\s+plat|toiture[- ]terrasse|flachdach|acrot[eè]re|attika|dachterrasse|gr[üu]ndach|v[ée]g[ée]talis/i;
const PITCHED_RE = /fa[iî]tage|\bfirst\b|\bridge\b|satteldach|walmdach|pultdach|deux pans|quatre pans|tuiles?\b|dachziegel/i;
const PITCH_RE = /(\d{1,2}(?:[.,]\d)?)\s*°/;
/** Pente d'écoulement écrite en pour cent (« pente 1,5% », « Gefälle 2 % ») : au plus 5 %, c'est un toit plat. */
const DRAIN_RE = /(?:pente|gef[äa]lle)\s*:?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%/i;

export interface RoofRead {
  ring: Vec2[];
  widthM: number;
  depthM: number;
  areaM2: number;
  /** Acrotère dessiné (anneau intérieur parallèle au bord). */
  parapet: boolean;
  /** Confiance du contour (0..1). */
  confidence: number;
}

function uniformInset(outer: RawBox, inner: RawBox, mpp: number): boolean {
  const d = [inner.minX - outer.minX, inner.minY - outer.minY, outer.maxX - inner.maxX, outer.maxY - inner.maxY].map((x) => x * mpp);
  const lo = Math.min(...d);
  const hi = Math.max(...d);
  if (lo < 0.1 || hi > 0.8) return false;
  // Acrotère de même épaisseur sur au moins trois côtés : le quatrième (mur mitoyen partagé) est souvent plus mince.
  const sorted = [...d].sort((a, b) => a - b);
  return sorted[3]! - sorted[1]! <= 0.1 || sorted[2]! - sorted[0]! <= 0.1;
}

/**
 * Contour de toiture : le remplissage le plus grand (3 à 80 m de côté) qui ne touche pas le bord de la vue (un
 * cadre de situation découpé, lui, le touche), le plus proche des dimensions attendues si on les connaît.
 */
export function roofOutline(v: ViewInput, mpp: number, expected?: { widthM: number; depthM: number } | null): RoofRead | null {
  const edgeTol = 1;
  const cands: { f: FillShape; ring: Vec2[]; b: RawBox; area: number }[] = [];
  for (const f of v.fills) {
    for (const p of f.polys) {
      const b = ringBox(p.outer);
      const w = boxW(b) * mpp;
      const h = boxH(b) * mpp;
      if (w < 3 || h < 3 || w > 80 || h > 80) continue;
      if (b.minX <= v.box.minX + edgeTol || b.minY <= v.box.minY + edgeTol || b.maxX >= v.box.maxX - edgeTol || b.maxY >= v.box.maxY - edgeTol) continue;
      cands.push({ f, ring: p.outer, b, area: ringArea(p.outer) * mpp * mpp });
    }
  }
  if (cands.length === 0) return null;
  const score = (c: (typeof cands)[number]): number => {
    if (expected) return Math.abs(Math.log((boxW(c.b) * mpp) / expected.widthM)) + Math.abs(Math.log((boxH(c.b) * mpp) / expected.depthM));
    return -c.area;
  };
  cands.sort((a, b) => score(a) - score(b));
  const best = cands[0]!;
  const hole = best.f.polys.some((p) => p.holes.some((h) => uniformInset(best.b, ringBox(h), mpp)));
  const innerFill = cands.some((c) => c !== best && boxContains(best.b, c.b, 0) && uniformInset(best.b, c.b, mpp));
  const innerAny = v.fills.some((f) => f.polys.some((p) => p !== best.f.polys[0] && boxContains(best.b, ringBox(p.outer), 0) && uniformInset(best.b, ringBox(p.outer), mpp)));
  let confidence = 0.65;
  if (expected) {
    const okW = Math.abs((boxW(best.b) * mpp) / expected.widthM - 1) <= 0.015;
    const okD = Math.abs((boxH(best.b) * mpp) / expected.depthM - 1) <= 0.015;
    confidence = okW && okD ? 0.9 : okW || okD ? 0.7 : 0.45;
  } else if (rectangularity(best.ring) < 0.9) confidence = 0.55;
  return {
    ring: best.ring,
    widthM: boxW(best.b) * mpp,
    depthM: boxH(best.b) * mpp,
    areaM2: best.area,
    parapet: hole || innerFill || innerAny,
    confidence,
  };
}

export function readRoof(v: ViewInput, sheetId: string | null, mpp: number, expected?: { widthM: number; depthM: number } | null): ReadRoof | null {
  const r = roofOutline(v, mpp, expected);
  const texts = v.texts.map((t) => t.s).join(' \n ');
  const drain = DRAIN_RE.exec(texts);
  const flatText = FLAT_RE.test(texts) || (drain !== null && Number(drain[1]!.replace(',', '.')) <= 5);
  const pitchedText = PITCHED_RE.test(texts);
  const pitch = PITCH_RE.exec(texts);
  if (!r && !flatText && !pitchedText && !pitch) return null;
  const evidence: { source: string; detail?: string }[] = [];
  let flat: ReadRoof['flat'] = null;
  if (flatText || r?.parapet) {
    if (flatText) evidence.push({ source: 'roof-text' });
    if (r?.parapet) evidence.push({ source: 'parapet-drawn' });
    const conf = flatText && r?.parapet ? 0.9 : 0.7;
    flat = { value: !pitchedText || !!r?.parapet, confidence: pitchedText ? 0.5 : conf, evidence, doubt: pitchedText ? 'flat-or-pitched' : null };
  } else if (pitchedText || pitch) {
    flat = { value: false, confidence: 0.7, evidence: [{ source: pitch ? 'pitch-text' : 'roof-text' }] };
  }
  const pitchDeg: ReadRoof['pitchDeg'] = pitch ? { value: Number(pitch[1]!.replace(',', '.')), confidence: 0.7, evidence: [{ source: 'pitch-text' }] } : null;
  return {
    sheetId,
    outline: r ? r.ring.map((p) => ({ x: p.x, y: p.y })) : null,
    widthM: r ? round(r.widthM, 3) : null,
    depthM: r ? round(r.depthM, 3) : null,
    areaM2: r ? round(r.areaM2, 2) : null,
    flat,
    pitchDeg,
  };
}
