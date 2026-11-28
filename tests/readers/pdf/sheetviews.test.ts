/**
 * Découpage d'une planche en vues (sheetviews.ts) et emprise du bâtiment (building.ts) : cas synthétiques, un signal
 * à la fois. Repère de la feuille (points, y vers le bas).
 */
import { describe, expect, it } from 'vitest';
import type { BBox } from '../../../src/core/types';
import { analysePdf, METRES_PER_POINT } from '../../../src/readers/pdf';
import type { ClipZone, FillArea, RawPage, RawSeg, RawText } from '../../../src/readers/pdf/raw';
import { cotaMetres, decideDims, OUTDOOR_RE, repeatedFrame, zoneArea } from '../../../src/readers/pdf/building';
import { clipFrames, elevationSide, matchTitlesToBlocks, splitSheet, titleKind, titleLines, visiblePage } from '../../../src/readers/pdf/sheetviews';
import type { SheetTitle } from '../../../src/readers/pdf/sheetviews';
import { fold } from '../../../src/semantics/labels';
import { page, rect, seg, text } from './helpers';

const PPM = 1 / (100 * METRES_PER_POINT); // points par mètre au 1:100

/** Texte dont le bord gauche est en x0 (le helper `text` centre). */
function at(s: string, x0: number, cy: number, size: number): RawText {
  return text(s, x0 + (s.length * size * 0.5) / 2, cy, size);
}

function title(s: string, b: BBox, size = 12): SheetTitle {
  return { text: s, box: b, size, parts: 1 };
}

function fill(b: BBox, color: number, clip = 0): FillArea {
  const ring: [number, number][] = [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ];
  return { rings: [ring], bbox: b, color, alpha: 1, clip, stroked: false, area: (b.maxX - b.minX) * (b.maxY - b.minY) };
}

/** Un plan d'étage au 1:100 : murs épais d'un rectangle w × d m en (x, y), pièces écrites avec leur surface. */
function floorPlan(x: number, y: number, w: number, d: number, rooms: [string, string][]): { segs: RawSeg[]; texts: RawText[] } {
  const x1 = x + w * PPM;
  const y1 = y + d * PPM;
  const t = 0.3 * PPM;
  const segs = [...rect(x, y, x1, y1, 1.4), ...rect(x + t, y + t, x1 - t, y1 - t, 1.4), seg((x + x1) / 2, y + t, (x + x1) / 2, y1 - t, 0.7)];
  // Mobilier et cotes en trait fin : la hiérarchie d'épaisseurs d'un vrai plan.
  for (let k = 1; k < 6; k++) segs.push(seg(x + k * 0.1 * (x1 - x), y1 + 12, x + (k + 1) * 0.1 * (x1 - x), y1 + 12, 0.25));
  const texts: RawText[] = [];
  rooms.forEach(([name, area], i) => {
    const cx = x + ((i % 2) + 0.5) * ((x1 - x) / 2);
    const cy = y + (Math.floor(i / 2) + 0.5) * ((y1 - y) / Math.ceil(rooms.length / 2));
    texts.push(text(name, cx, cy, 6), text(area, cx, cy + 8, 5));
  });
  return { segs, texts };
}

describe('titres des vues', () => {
  it('recolle un titre écrit en trois morceaux avec un exposant : « PLAN 1 » + « ER » + « ÉTAGE »', () => {
    const a = at('PLAN 1', 100, 300, 17);
    const sup = at('ER', a.x1 + 0.3, 295, 10);
    const b = at('ÉTAGE', sup.x1 + 2, 300, 17);
    const body = [text('Séjour', 400, 400, 6), text('12,00 m²', 400, 410, 6), text('Cuisine', 500, 400, 6)];
    const titles = titleLines([a, sup, b, ...body], 6);
    expect(titles).toHaveLength(1);
    expect(titles[0]!.text).toBe('PLAN 1ER ÉTAGE');
    expect(titles[0]!.parts).toBe(3);
  });

  it('un texte modérément plus gros n’est un titre que s’il porte le vocabulaire des vues', () => {
    const texts = [text('COUPE A-A', 200, 100, 7.5), text('Maison', 400, 100, 7.5), text('x', 10, 10, 6), text('y', 20, 20, 6), text('z', 30, 30, 6)];
    expect(titleLines(texts, 6).map((t) => t.text)).toEqual(['COUPE A-A']);
  });

  it('genre annoncé par le titre, en français et en allemand', () => {
    const k = (s: string): string | null => titleKind(fold(s));
    expect(k('PLAN REZ-DE-CHAUSSÉE')).toBe('floor-plan');
    expect(k('GRUNDRISS OBERGESCHOSS')).toBe('floor-plan');
    expect(k('PLAN TOITURE')).toBe('roof-plan');
    expect(k('Dachaufsicht')).toBe('roof-plan');
    expect(k('COUPE BB')).toBe('section');
    expect(k('SCHNITT A-A')).toBe('section');
    expect(k('FAÇADE ARRIÈRE')).toBe('elevation');
    expect(k('Gartenansicht')).toBe('elevation');
    expect(k('Plan de situation')).toBe('site-plan');
    expect(k('TABLEAU DES SURFACES')).toBe('table');
    expect(k('PHOTO DU SITE')).toBe('photo');
    expect(k('Maison Exemple')).toBeNull();
  });

  it('côté d’une façade lu dans son titre', () => {
    expect(elevationSide(fold('FAÇADE AVANT'))).toEqual(['front']);
    expect(elevationSide(fold('FAÇADE ARRIÈRE'))).toEqual(['back']);
    expect(elevationSide(fold('FAÇADE LATÉRALE'))).toEqual(['side']);
    expect(elevationSide(fold('ANSICHT SÜD'))).toEqual(['south']);
    expect(elevationSide(fold('Straßenansicht'))).toEqual(['front']);
  });
});

describe('association titre ↔ bloc', () => {
  // Trois blocs en colonne, 30 pt d'écart : un titre placé juste au-dessus d'un bloc est aussi, plus loin, sous le
  // bloc précédent. La convention de la page départage.
  const blocks: BBox[] = [0, 1, 2].map((i) => ({ minX: 100, minY: 100 + i * 230, maxX: 400, maxY: 300 + i * 230 }));

  it('titres AU-DESSUS des vues : chacun va au bloc qu’il surmonte', () => {
    const titles = blocks.map((b, i) => title(`Plan ${i}`, { minX: 110, minY: b.minY - 14, maxX: 180, maxY: b.minY - 2 }));
    const pairs = matchTitlesToBlocks(titles, blocks);
    expect(pairs.map((p) => [p.t, p.b, p.at])).toEqual(
      expect.arrayContaining([
        [0, 0, 'above'],
        [1, 1, 'above'],
        [2, 2, 'above'],
      ]),
    );
    expect(pairs).toHaveLength(3);
  });

  it('titres SOUS les vues : chacun va au bloc qu’il souligne', () => {
    const titles = blocks.map((b, i) => title(`Plan ${i}`, { minX: 110, minY: b.maxY + 2, maxX: 180, maxY: b.maxY + 14 }));
    const pairs = matchTitlesToBlocks(titles, blocks);
    expect(pairs.map((p) => [p.t, p.b, p.at]).sort()).toEqual([
      [0, 0, 'below'],
      [1, 1, 'below'],
      [2, 2, 'below'],
    ]);
  });
});

describe('zones de découpe', () => {
  const W0 = 1190;
  const H0 = 842;
  const sheet: ClipZone = { id: 0, parent: -1, bbox: { minX: 0, minY: 0, maxX: W0, maxY: H0 }, rect: true, ops: 0 };

  it('une même fenêtre réappliquée à de nombreux éléments est une vue ; un cadre de même taille aligné aussi', () => {
    const win: BBox = { minX: 50, minY: 50, maxX: 400, maxY: 500 };
    const roof: BBox = { minX: 450, minY: 50, maxX: 800, maxY: 500 };
    const clips: ClipZone[] = [sheet];
    for (let i = 1; i <= 6; i++) clips.push({ id: i, parent: 0, bbox: win, rect: true, ops: 8 });
    clips.push({ id: 7, parent: 0, bbox: roof, rect: true, ops: 25 });
    // Petite découpe d'un détail : ignorée.
    clips.push({ id: 8, parent: 0, bbox: { minX: 900, minY: 600, maxX: 910, maxY: 610 }, rect: true, ops: 300 });
    const p: RawPage = { ...page([], [], W0, H0), clips };
    expect(clipFrames(p).map((f) => f.box)).toEqual([win, roof]);
  });

  it('un trait peint sous une découpe mais hors de sa boîte est invisible : retiré', () => {
    const clips: ClipZone[] = [sheet, { id: 1, parent: 0, bbox: { minX: 100, minY: 100, maxX: 300, maxY: 300 }, rect: true, ops: 2 }];
    const inside = seg(120, 150, 280, 150, 0.5, { clip: 1 });
    const outside = seg(500, 150, 700, 150, 0.5, { clip: 1 });
    const free = seg(500, 400, 700, 400, 0.5);
    const p: RawPage = { ...page([inside, outside, free], [], W0, H0), clips };
    expect(visiblePage(p).segs).toEqual([inside, free]);
  });
});

describe('emprise du bâtiment', () => {
  it('cadre de situation répété : mêmes remplissages décalés d’une vue à l’autre', () => {
    const a: BBox = { minX: 0, minY: 0, maxX: 400, maxY: 800 };
    const b: BBox = { minX: 500, minY: 0, maxX: 900, maxY: 800 };
    const frame = [
      fill({ minX: 10, minY: 10, maxX: 390, maxY: 200 }, 0xd8f0c8),
      fill({ minX: 10, minY: 600, maxX: 390, maxY: 700 }, 0xcccccc),
      fill({ minX: 10, minY: 700, maxX: 390, maxY: 790 }, 0x999999),
      fill({ minX: 20, minY: 220, maxX: 60, maxY: 580 }, 0xd8f0c8),
      fill({ minX: 340, minY: 220, maxX: 380, maxY: 580 }, 0xd8f0c8),
    ];
    const moved = frame.map((f) => fill({ minX: f.bbox.minX + 500, minY: f.bbox.minY, maxX: f.bbox.maxX + 500, maxY: f.bbox.maxY }, f.color));
    const p: RawPage = { ...page([], []), fills: [...frame, ...moved] };
    expect(repeatedFrame(p, a, b)).toBe(1);
    // Vues de tailles différentes : pas le même cadre.
    expect(repeatedFrame(p, a, { ...b, maxX: 950 })).toBe(0);
    // Couleurs différentes : pas le même cadre.
    const other: RawPage = { ...p, fills: [...frame, ...moved.map((f) => ({ ...f, color: 0x123456 }))] };
    expect(repeatedFrame(other, a, b)).toBe(0);
  });

  it('nombres de cotes et lignes de surface', () => {
    expect(cotaMetres('8,00')).toBe(8);
    expect(cotaMetres('1100')).toBe(11);
    expect(cotaMetres('8,00 m²')).toBeNull();
    expect(zoneArea('S: 27,40 m')).toBe(27.4);
    expect(zoneArea('12,40 m²')).toBe(12.4);
  });

  it('une cote d’ensemble qui prolonge la boîte sur une pièce intérieure lève une question', () => {
    const mpp = METRES_PER_POINT * 100;
    const view: BBox = { minX: 0, minY: 0, maxX: 800, maxY: 800 };
    const box: BBox = { minX: 100, minY: 100, maxX: 100 + 8 / mpp, maxY: 100 + 6.08 / mpp };
    const ext = 2.76 / mpp; // la pièce manquée, sous la boîte
    const texts = [
      // Cote de largeur qui confirme la boîte.
      text('8,00', (box.minX + box.maxX) / 2, box.minY - 20, 6),
      // Chaîne d'ensemble verticale : du haut de la boîte au bas de la pièce manquée.
      text('8,84', box.minX - 30, box.minY + (6.08 + 2.76) / mpp / 2, 6, 90),
      text('Bureau', (box.minX + box.maxX) / 2, box.maxY + ext / 2, 6),
      text('9,40 m²', (box.minX + box.maxX) / 2, box.maxY + ext / 2 + 8, 6),
    ];
    const d = decideDims(page([], texts), view, [{ box, source: 'walls' }], mpp, 'fr');
    expect(d.width.value).toBe(8);
    expect(d.width.confidence).toBeGreaterThanOrEqual(0.8);
    expect(d.depth.confidence).toBeLessThan(0.5);
    expect(d.depth.doubt).toMatch(/8,84/);
  });
});

describe('espaces extérieurs (liste commune des lecteurs PDF)', () => {
  it('terrasse, balcon, carport et parcelle sont extérieurs ; un jardin d’hiver est une pièce', () => {
    for (const n of ['Terrasse', 'Balkon', 'Carport', 'Car-port', 'Parcelle', 'Trottoir']) expect(OUTDOOR_RE.test(fold(n)), n).toBe(true);
    for (const n of ['Jardin d’hiver', "Jardin d'hiver", 'Wintergarten', 'Séjour', 'Garage']) expect(OUTDOOR_RE.test(fold(n)), n).toBe(false);
  });
});

describe('découpage d’une page', () => {
  it('un tableau à côté d’un plan reste une vue à part, le plan garde ses pièces', () => {
    const plan = floorPlan(100, 100, 10, 8, [
      ['Séjour', '30,00 m²'],
      ['Cuisine', '12,00 m²'],
      ['Chambre', '14,00 m²'],
      ['Bain', '6,00 m²'],
    ]);
    const texts = [...plan.texts, at('PLAN REZ-DE-CHAUSSÉE', 100, 100 + 8 * PPM + 30, 14)];
    // Tableau des surfaces : une grille de textes, à droite du plan.
    const rows = ['Séjour', 'Cuisine', 'Chambre', 'Bain', 'Total'];
    rows.forEach((r, i) => texts.push(at(r, 600, 140 + i * 12, 6), at(`${10 + i},00 m²`, 640, 140 + i * 12, 6), at('chauffé', 690, 140 + i * 12, 6)));
    texts.push(at('TABLEAU DES SURFACES', 600, 120, 14));
    const split = splitSheet(page(plan.segs, texts), { den: 100, lang: 'fr' });
    const fp = split.views.find((v) => v.kind === 'floor-plan')!;
    const table = split.views.find((v) => v.kind === 'table')!;
    expect(fp).toBeDefined();
    expect(table).toBeDefined();
    expect(fp.title).toBe('PLAN REZ-DE-CHAUSSÉE');
    expect(fp.storeyRank).toBe(0);
    expect(fp.box.maxX).toBeLessThan(table.box.minX);
    expect(table.title).toBe('TABLEAU DES SURFACES');
    expect(fp.id).toBe('p1-floor-plan1');
    expect(table.id).toBe('p1-table1');
    // Les étiquettes de pièces en grille 2 × 2 ne font pas du plan un tableau : titre et contenu s'accordent.
    expect(fp.confidence).toBeGreaterThanOrEqual(0.9);
    expect(fp.doubts).toEqual([]);
    // Les quatre étiquettes de pièces sont dans la boîte du plan, aucune dans celle du tableau (page trop maigre
    // pour être lue en entier ici : la lecture des pièces est vérifiée sur les pages à trois plans ci-dessous).
    for (const t of plan.texts) {
      expect(t.cx >= fp.box.minX && t.cx <= fp.box.maxX && t.cy >= fp.box.minY && t.cy <= fp.box.maxY).toBe(true);
      expect(t.cx >= table.box.minX && t.cx <= table.box.maxX && t.cy >= table.box.minY && t.cy <= table.box.maxY).toBe(false);
    }
  });

  it('trois plans dont un sans titre : le plan sans titre reste une feuille, avec son doute', () => {
    const a = floorPlan(40, 120, 8, 8, [
      ['Séjour', '30,00 m²'],
      ['Cuisine', '12,00 m²'],
    ]);
    const b = floorPlan(420, 120, 8, 8, [
      ['Chambre 1', '14,00 m²'],
      ['Bain', '6,00 m²'],
    ]);
    const c = floorPlan(800, 120, 8, 8, [
      ['Cave', '20,00 m²'],
      ['Buanderie', '9,00 m²'],
    ]);
    const y1 = 120 + 8 * PPM;
    const texts = [...a.texts, ...b.texts, ...c.texts, at('PLAN REZ-DE-CHAUSSÉE', 40, y1 + 30, 14), at('PLAN ÉTAGE', 420, y1 + 30, 14), at('Échelle 1:100', 1000, 800, 7)];
    const { doc } = analysePdf([page([...a.segs, ...b.segs, ...c.segs], texts)], 'x.pdf');
    expect(doc.sheets).toHaveLength(3);
    const lost = doc.sheets.find((s) => s.detected.rooms.some((r) => r.name === 'Cave'))!;
    expect(lost).toBeDefined();
    expect(lost.detected.rooms.map((r) => r.name).sort()).toEqual(['Buanderie', 'Cave']);
    expect(lost.storeyRank ?? null).toBeNull();
    expect(lost.detected.notes.some((n) => /sans titre/i.test(n))).toBe(true);
    const v = doc.reading!.views.find((x) => x.sheetId === lost.id)!;
    expect(v.confidence).toBeLessThan(0.65);
    expect(v.doubts.some((d) => /sans titre/i.test(d))).toBe(true);
    // Les deux plans titrés gardent leur niveau.
    expect(doc.sheets.filter((s) => s.storeyRank !== null && s.storeyRank !== undefined).map((s) => s.storeyRank).sort()).toEqual([0, 1]);
  });

  it('un plan titré dont les quatre pièces tombent en grille garde son niveau et ses pièces', () => {
    const a = floorPlan(40, 120, 8, 8, [
      ['Séjour', '30,00 m²'],
      ['Cuisine', '12,00 m²'],
    ]);
    const b = floorPlan(420, 120, 8, 8, [
      ['Chambre 1', '14,00 m²'],
      ['Bain', '6,00 m²'],
    ]);
    const c = floorPlan(800, 120, 8, 8, [
      ['Cave', '20,00 m²'],
      ['Buanderie', '9,00 m²'],
      ['Cellier', '5,00 m²'],
      ['Chaufferie', '6,00 m²'],
    ]);
    const y1 = 120 + 8 * PPM;
    const texts = [...a.texts, ...b.texts, ...c.texts, at('PLAN REZ-DE-CHAUSSÉE', 40, y1 + 30, 14), at('PLAN ÉTAGE', 420, y1 + 30, 14), at('PLAN SOUS-SOL', 800, y1 + 30, 14), at('Échelle 1:100', 1000, 800, 7)];
    const pg = page([...a.segs, ...b.segs, ...c.segs], texts);
    const split = splitSheet(pg, { den: 100, lang: 'fr' });
    const basement = split.views.find((v) => v.title === 'PLAN SOUS-SOL')!;
    expect(basement.kind).toBe('floor-plan');
    expect(basement.confidence).toBeGreaterThanOrEqual(0.9);
    expect(split.views.some((v) => v.kind === 'table')).toBe(false);
    const { doc } = analysePdf([pg], 'x.pdf');
    expect(doc.sheets).toHaveLength(3);
    const s = doc.sheets.find((x) => x.storeyRank === -1)!;
    expect(s).toBeDefined();
    expect(s.detected.rooms.map((r) => r.name).sort()).toEqual(['Buanderie', 'Cave', 'Cellier', 'Chaufferie']);
  });

  it('un cartouche touché par une chaîne de cotes reste à sa taille et ne mange pas le plan', () => {
    const plan = floorPlan(100, 300, 10, 8, [
      ['Séjour', '30,00 m²'],
      ['Cuisine', '12,00 m²'],
    ]);
    const texts = [...plan.texts, at('PLAN ÉTAGE', 100, 300 + 8 * PPM + 30, 14)];
    // Cartouche dans le coin bas droit.
    const tbx = 850;
    const tby = 650;
    const tbSegs = rect(tbx, tby, 1170, 830, 0.5);
    ['Projet : Maison Exemple', 'Maître d’ouvrage : M. Test', 'Architecte : Atelier Modèle', 'Échelle 1:100', 'Indice B', 'Date : 01.01.2026'].forEach((s, i) =>
      texts.push(at(s, tbx + 10, tby + 15 + i * 12, 6)),
    );
    // Chaîne de cotes du plan, prolongée jusqu'au bord du cartouche.
    const dim = seg(100, 300 + 8 * PPM + 12, tbx + 2, 300 + 8 * PPM + 12, 0.25);
    const split = splitSheet(page([...plan.segs, ...tbSegs, dim], texts), { den: 100, lang: 'fr' });
    const tb = split.views.find((v) => v.kind === 'title-block')!;
    const fp = split.views.find((v) => v.kind === 'floor-plan')!;
    expect(tb).toBeDefined();
    expect(fp).toBeDefined();
    expect(tb.box.minX).toBeGreaterThan(tbx - 20);
    expect(tb.box.minY).toBeGreaterThan(tby - 20);
    expect(fp.box.minX).toBeLessThan(110);
    expect(fp.title).toBe('PLAN ÉTAGE');
  });

  it('un grand dessin sans titre ni contenu reconnu (façade non titrée) : vue « autre », avec une question', () => {
    const plan = floorPlan(100, 100, 10, 8, [
      ['Séjour', '30,00 m²'],
      ['Cuisine', '12,00 m²'],
    ]);
    const texts = [...plan.texts, at('PLAN REZ-DE-CHAUSSÉE', 100, 100 + 8 * PPM + 30, 14)];
    // Façade : un rectangle et des fenêtres, sans aucun texte.
    const facade: RawSeg[] = [...rect(650, 400, 1000, 600, 0.7)];
    for (let k = 0; k < 4; k++) facade.push(...rect(680 + k * 80, 450, 720 + k * 80, 500, 0.35));
    const split = splitSheet(page([...plan.segs, ...facade], texts), { den: 100, lang: 'fr' });
    const other = split.views.find((v) => v.kind === 'other')!;
    expect(other).toBeDefined();
    expect(other.confidence).toBeLessThan(0.5);
    expect(other.doubts.length).toBeGreaterThan(0);
    expect(split.views.filter((v) => v.kind === 'floor-plan')).toHaveLength(1);
  });

  it('page sans texte : aucune vue titrée, rien n’est inventé', () => {
    const plan = floorPlan(100, 100, 10, 8, []);
    const split = splitSheet(page(plan.segs, []), { den: 100, lang: 'fr' });
    expect(split.views.every((v) => v.title === null)).toBe(true);
    expect(split.views.some((v) => v.kind === 'floor-plan')).toBe(false);
  });
});
