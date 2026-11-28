/**
 * Géométrie de planche : critères purs, un par un, sur des formes fabriquées (aucune planche).
 */
import { describe, expect, it } from 'vitest';
import { openingSymbol, type WallEdge } from '../../../../src/readers/pdf/geometry/bays';
import { elevationBays } from '../../../../src/readers/pdf/geometry/elevation';
import { unlabelledAreas, unlabelledKind } from '../../../../src/readers/pdf/geometry/envelope';
import { readRoof } from '../../../../src/readers/pdf/geometry/roof';
import { findRoomLabels, parseArea, type RoomZone } from '../../../../src/readers/pdf/geometry/rooms';
import type { FillShape, ViewInput } from '../../../../src/readers/pdf/geometry/types';
import {
  bufferPolys,
  closeOutline,
  differencePolys,
  mergeAxisSegments,
  ringArea,
  intersectPolys,
  polyArea,
  ringsToPolys,
  unionPolys,
  type Poly,
} from '../../../../src/readers/pdf/planar';
import { METRES_PER_POINT, type RawSeg } from '../../../../src/readers/pdf/raw';
import { analyseFloorPlan } from '../../../../src/readers/pdf/geometry';
import { page, seg, text } from '../helpers';

const MPP = METRES_PER_POINT * 100; // 1:100 : 1 m ≈ 28,35 pt
const M = 1 / MPP;

const sq = (x0: number, y0: number, x1: number, y1: number): Poly => ({
  outer: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
  holes: [],
});

function fill(p: Poly, color: number, alpha = 1): FillShape {
  const xs = p.outer.map((q) => q.x);
  const ys = p.outer.map((q) => q.y);
  return { polys: [p], bbox: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }, color, alpha, stroked: false };
}

function view(fills: FillShape[], texts = [] as ReturnType<typeof text>[], segs: RawSeg[] = []): ViewInput {
  return { page: 1, viewId: 'v', box: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 }, fills, hatches: [], segs, texts };
}

describe('planar : primitives ajoutées', () => {
  it('union, différence, intersection et tampon de carrés', () => {
    const a = sq(0, 0, 10, 10);
    const b = sq(5, 0, 15, 10);
    expect(unionPolys([a, b]).reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(150, 6);
    expect(differencePolys([a], [b]).reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(50, 6);
    expect(intersectPolys([a], [b]).reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(50, 6);
    // Angles vifs : le tampon d'un carré reste un carré.
    expect(bufferPolys([a], 1).reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(144, 6);
    expect(bufferPolys([a], -6)).toEqual([]);
  });

  it('traits d’une même droite fondus avant la fermeture : même contour, bien moins de traits', () => {
    // Carré de 100 pt dont chaque côté est découpé en 50 morceaux qui se touchent, plus une diagonale.
    const segs: { ax: number; ay: number; bx: number; by: number }[] = [];
    for (let i = 0; i < 50; i++) {
      const a = i * 2;
      const b = a + 2;
      segs.push({ ax: a, ay: 0, bx: b, by: 0 }, { ax: 100, ay: a, bx: 100, by: b }, { ax: b, ay: 100, bx: a, by: 100 }, { ax: 0, ay: b, bx: 0, by: a });
    }
    segs.push({ ax: 0, ay: 0, bx: 100, by: 100 }, { ax: 10, ay: 50, bx: 30, by: 50 }, { ax: 40, ay: 50, bx: 60, by: 50 });
    const merged = mergeAxisSegments(segs);
    expect(merged).toHaveLength(4 + 1 + 2);
    const a = closeOutline(segs, 3, 10);
    const b = closeOutline(merged, 3, 10);
    expect(b.length).toBe(a.length);
    expect(ringArea(b[0]!)).toBeCloseTo(ringArea(a[0]!), 3);
  });

  it('ouverture morphologique : la languette laissée entre un local et le bord de l’emprise disparaît', () => {
    // Emprise 10,3 × 10 ; local (garage) 4 × 8 qui s'arrête à 0,3 du bord droit : il reste une languette de 0,3 × 8
    // reliée au reste par un seul bout.
    const rest = differencePolys([sq(0, 0, 10.3, 10)], [sq(6, 2, 10, 10)]);
    expect(rest.reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(71, 6);
    const opened = bufferPolys(bufferPolys(rest, -0.5), 0.5);
    expect(opened.reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(68.6, 4);
  });

  it('sous-tracés → polygones à trous (règle pair-impair)', () => {
    const ps = ringsToPolys([
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      [
        [2, 2],
        [8, 2],
        [8, 8],
        [2, 8],
      ],
    ]);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.holes).toHaveLength(1);
    expect(polyArea(ps[0]!)).toBeCloseTo(64, 6);
  });
});

describe('pièces : étiquettes', () => {
  it('surfaces écrites, préfixées ou non', () => {
    expect(parseArea('S: 27,40 m²')).toBe(27.4);
    expect(parseArea('Fläche: 12,30 m²')).toBe(12.3);
    expect(parseArea('21,95 m²')).toBe(21.95);
    expect(parseArea('21,95')).toBeNull();
    expect(parseArea('+0,23')).toBeNull();
  });

  it('nom au-dessus de la surface ; une ligne « clé : valeur » d’encadré n’est pas une pièce', () => {
    const labels = findRoomLabels([
      text('Séjour', 100, 100, 8),
      text('S: 27,40 m²', 100, 110, 6),
      // Encadré d'éclairement : clé et valeur sur la même ligne.
      text('Surface de vitrage : ', 300, 100, 5),
      text('9,82m²', 333, 100, 5),
      text('Minimum exigé par le règlement', 320, 110, 5),
      text('3,16m²', 320, 118, 5),
    ]);
    expect(labels.map((l) => l.name)).toEqual(['Séjour', 'Minimum exigé par le règlement']);
    // Une clé « … : » n'est jamais retenue comme nom.
    expect(labels.some((l) => /:\s*$/.test(l.name))).toBe(false);
  });

  it('encadré écrit « clé : » puis la valeur sur la ligne du dessous : aucune pièce inventée', () => {
    const labels = findRoomLabels([
      text('Séjour', 100, 100, 8),
      text('S: 27,40 m²', 100, 110, 6),
      text('Chambre', 300, 60, 8),
      text('Surface de vitrage :', 300, 100, 5),
      text('9,82m²', 290, 107, 5),
      text('Surface du séjour :', 300, 120, 5),
      text('27,40m²', 290, 127, 5),
    ]);
    expect(labels.map((l) => `${l.name} ${l.stated}`)).toEqual(['Séjour 27.4']);
  });

  it('une cote « 3,45 m » n’est pas une surface ; « 3,45 m² » et « S: 3,45 m » le sont', () => {
    expect(parseArea('3,45 m')).toBeNull();
    expect(parseArea('3,45 m²')).toBe(3.45);
    expect(parseArea('S: 3,45 m')).toBe(3.45);
  });
});

describe('baies : symbole dans le trou du mur', () => {
  // Mur horizontal en y = 100, extérieur vers le bas (n = +y), trou de 1 m de x = 100 à x = 100 + 1 m.
  const w = 1 * M;
  const e: WallEdge = { a: { x: 100, y: 100 }, b: { x: 100 + 4 * M, y: 100 }, u: { x: 1, y: 0 }, n: { x: 0, y: 1 }, len: 4 * M, index: 0 };
  const depth = 0.6 * M;
  const glazing = [seg(100, 100 - 0.15 * M, 100 + w, 100 - 0.15 * M, 0.25), seg(100, 100 - 0.2 * M, 100 + w, 100 - 0.2 * M, 0.25)];
  /** Arc de centre c, rayon r, de a0 à a1 (radians), en morceaux de courbe. */
  function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 12): RawSeg[] {
    const out: RawSeg[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n;
      const t1 = a0 + ((a1 - a0) * (i + 1)) / n;
      out.push(seg(cx + r * Math.cos(t0), cy + r * Math.sin(t0), cx + r * Math.cos(t1), cy + r * Math.sin(t1), 0.25, { curve: true }));
    }
    return out;
  }

  it('quart de cercle posé sur le mur : vantail de porte', () => {
    // Charnière à l'angle intérieur du tableau gauche (mur de 0,4 m), arc vers la pièce (y décroissant).
    const hinge = { x: 100, y: 100 - 0.4 * M };
    const s = openingSymbol(arc(hinge.x, hinge.y, w, -Math.PI / 2, 0), e, 0, w, depth, MPP);
    expect(s.arc).toBe(true);
    expect(s.leaf).toBe(true);
  });

  it('cercle entier dans la pièce (lavabo) : pas une porte', () => {
    const s = openingSymbol([...glazing, ...arc(100 + 0.5 * M, 100 - 0.9 * M, 0.25 * M, 0, 2 * Math.PI, 24)], e, 0, w, depth, MPP);
    expect(s.arc).toBe(false);
    expect(s.leaf).toBe(false);
    expect(s.glazing).toBeGreaterThanOrEqual(2);
  });

  it('trait perpendiculaire resté dans l’épaisseur du mur (retour de tableau) : pas un vantail', () => {
    const s = openingSymbol([seg(100, 100, 100, 100 - 0.45 * M, 0.25)], e, 0, 0.6 * M, depth, MPP);
    expect(s.straightLeaf).toBe(false);
    expect(s.leaf).toBe(false);
  });

  it('vitrage + trait droit sans arc : fenêtre (le trait est une cloison), mais le trait reste signalé', () => {
    const s = openingSymbol([...glazing, seg(100, 100 - 0.4 * M, 100, 100 - 1.3 * M, 0.25)], e, 0, w, depth, MPP);
    expect(s.straightLeaf).toBe(true);
    expect(s.leaf).toBe(false);
  });
});

describe('façades : baies dessinées', () => {
  // Façade de 8 × 6 m, pied en y = 400.
  const foot = 400;
  const facade = fill(sq(100, foot - 6 * M, 100 + 8 * M, foot), 0xdddddd, 0.25);
  const rect = (x: number, y0: number, wM: number, hM: number): Poly => sq(x, foot - (y0 + hM) * M, x + wM * M, foot - y0 * M);

  it('porte pleine sous un voile translucide (ombre, auvent) : comptée une fois', () => {
    const door = fill(rect(150, 0, 0.93, 2.12), 0x404040, 0.75);
    const shade = fill(rect(120, 0, 4, 2.36), 0x6b6b6b, 0.5);
    const r = elevationBays(view([facade, shade, door]), MPP)!;
    expect(r.bays).toHaveLength(1);
    expect(r.bays[0]!.kind).toBe('door');
    expect(r.bays[0]!.widthM).toBeCloseTo(0.93, 2);
    expect(r.bays[0]!.heightM).toBeCloseTo(2.12, 2);
  });

  it('porte de garage à panneau de même teinte : porte, pas fenêtre ; fenêtre = cadre + vitre d’une autre teinte', () => {
    const gate = fill(rect(250, 0, 2.62, 2.12), 0x404040, 0.75);
    const panel = fill(rect(250 + 0.05 * M, 0.03, 2.52, 2.05), 0x404040, 0.75);
    const frame = fill(rect(120, 3.9, 1.12, 1.34), 0x404040, 0.75);
    const glass = fill(rect(120 + 0.1 * M, 4.0, 0.92, 1.12), 0xdedede, 0.5);
    const r = elevationBays(view([facade, gate, panel, frame, glass]), MPP)!;
    const kinds = r.bays.map((b) => `${b.kind} ${b.widthM}`);
    expect(kinds).toEqual(['wide-door 2.62', 'window 1.12']);
  });

  it('voile translucide sans rien dessous (unité extérieure, haie) : aucune baie', () => {
    const unit = fill(rect(300, 0.1, 1.5, 2.3), 0x6b6b6b, 0.25);
    expect(elevationBays(view([facade, unit]), MPP)!.bays).toEqual([]);
  });
});

describe('surfaces sans étiquette du volume chauffé', () => {
  // Niveau de 9 × 7 m (en mètres × M), une seule pièce étiquetée qui couvre la moitié gauche.
  const P = (x0: number, y0: number, x1: number, y1: number): Poly => sq(100 + x0 * M, 100 + y0 * M, 100 + x1 * M, 100 + y1 * M);
  const heated = P(0, 0, 9, 7);
  const room = { label: { name: 'Séjour', stated: 31.5, at: { x: 100 + 2 * M, y: 100 + 2 * M } }, poly: P(0, 0, 4.5, 7), source: null, agreeing: [], measured: 31.5 } as unknown as RoomZone;

  it('embrasure d’une baie de 3,60 m (bande de 0,42 m dans le mur) : jamais une surface sans étiquette', () => {
    // Remplissage de pièce sans étiquette dans l'épaisseur du mur, au droit d'une baie dont le centre est sur la façade.
    const band = P(5, 6.58, 8.6, 7);
    const bay = { x: 100 + 6.8 * M, y: 100 + 7 * M };
    const rest = [P(4.5, 0, 9, 6.58)];
    const out = unlabelledAreas(heated, [room], rest, [band], MPP, { bayCentres: [bay] });
    expect(out).toEqual([]);
  });

  it('bande plus mince qu’un passage (0,5 m), loin de toute baie : écartée aussi', () => {
    const band = P(5, 3, 8.5, 3.5);
    expect(unlabelledAreas(heated, [room], [P(4.5, 0, 9, 3), P(4.5, 3.5, 9, 7)], [band], MPP)).toEqual([]);
  });

  it('marches dessinées : escalier ; croix : trémie ; long et étroit : dégagement ; polygone toujours porté', () => {
    const stairs = P(5, 1, 6.1, 5.4);
    const treads: RawSeg[] = [];
    for (let k = 0; k < 15; k++) treads.push(seg(100 + 5 * M, 100 + (1.2 + k * 0.27) * M, 100 + 6.1 * M, 100 + (1.2 + k * 0.27) * M, 0.25));
    const hole = P(6.6, 1, 8.6, 3);
    const cross: RawSeg[] = [seg(100 + 6.6 * M, 100 + 1 * M, 100 + 8.6 * M, 100 + 3 * M, 0.25), seg(100 + 8.6 * M, 100 + 1 * M, 100 + 6.6 * M, 100 + 3 * M, 0.25)];
    const corridor = P(6.6, 3.6, 7.7, 6.8);
    const walls = differencePolys([P(4.5, 0, 9, 7)], [stairs, hole, corridor]);
    const out = unlabelledAreas(heated, [room], walls, [stairs, hole, corridor], MPP, { segs: [...treads, ...cross] });
    const byKind = Object.fromEntries(out.map((u) => [u.kind, u]));
    expect(Object.keys(byKind).sort()).toEqual(['passage', 'stairs', 'void']);
    expect(byKind.stairs!.areaM2).toBeCloseTo(1.1 * 4.4, 1);
    expect(byKind.void!.areaM2).toBeCloseTo(4, 1);
    expect(byKind.passage!.areaM2).toBeCloseTo(1.1 * 3.2, 1);
    for (const u of out) expect(u.poly.outer.length).toBeGreaterThanOrEqual(4);
    // Sans rien dedans : nature inconnue, la question reste générale.
    expect(unlabelledKind(P(0, 0, 2.5, 2.5), [], MPP)).toBe('unknown');
  });
});

describe('entrées hors bornes', () => {
  const pg = page([], [text('Séjour', 100, 100, 8), text('S: 27,40 m²', 100, 110, 6)]);
  const v = { id: 'v', box: { minX: 0, minY: 0, maxX: 800, maxY: 600 }, storeyRank: 0 };

  it('langue hors du français et de l’allemand : repli sur le français, sans erreur', () => {
    const g = analyseFloorPlan(pg, v, { lang: 'en' as unknown as 'fr' });
    expect(g.detection.notes.length).toBeGreaterThan(0);
    expect(g.detection.notes.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
  });

  it.each([-1, Infinity, 1e9, 1e-9, 0])('échelle annoncée absurde (%s m/pt) : écartée, jamais proposée en question', (mpp) => {
    const g = analyseFloorPlan(pg, v, { declaredMpp: mpp, lang: 'fr' });
    expect(g.doubts.some((q) => /1:-|Infinity|1:0\b|1:\d{7,}/.test(q))).toBe(false);
    expect(g.detection.notes).toContain('Échelle annoncée impossible : ignorée.');
  });

  it('page sans emprise : la remarque des murs non reconnus n’est pas répétée', () => {
    const g = analyseFloorPlan(pg, v, { declaredMpp: MPP, lang: 'fr' });
    const n = g.detection.notes.filter((x) => /Murs non reconnus/.test(x));
    expect(n.length).toBeLessThanOrEqual(1);
  });
});

describe('toiture', () => {
  it('anneau extérieur du remplissage ; acrotère plus mince côté mitoyen ; pente d’écoulement en % → toit plat', () => {
    // Toiture 7,4 × 12,6 m, acrotère de 0,52 m sur trois côtés et 0,31 m sur le quatrième.
    const W = 7.4 * M;
    const D = 12.6 * M;
    const roof: Poly = {
      outer: sq(200, 200, 200 + W, 200 + D).outer,
      holes: [sq(200 + 0.52 * M, 200 + 0.52 * M, 200 + W - 0.31 * M, 200 + D - 0.52 * M).outer],
    };
    const r = readRoof(view([fill(roof, 0x999999)], [text('pente 2,0%', 300, 400, 6)]), 'toit', MPP, { widthM: 7.4, depthM: 12.6 })!;
    expect(r.widthM).toBeCloseTo(7.4, 2);
    expect(r.depthM).toBeCloseTo(12.6, 2);
    // Jamais l'aire pair-impair (la bande d'acrotère seule).
    expect(r.areaM2).toBeCloseTo(93.24, 1);
    expect(r.flat?.value).toBe(true);
    expect(r.flat?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(r.flat?.evidence.map((x) => x.source).sort()).toEqual(['parapet-drawn', 'roof-text']);
  });

  it('pente en degrés écrite : toit en pente', () => {
    const r = readRoof(view([fill(sq(200, 200, 200 + 8 * M, 200 + 11 * M), 0x999999)], [text('Satteldach 35°', 300, 400, 6)]), null, MPP)!;
    expect(r.flat?.value).toBe(false);
    expect(r.pitchDeg?.value).toBe(35);
  });
});
