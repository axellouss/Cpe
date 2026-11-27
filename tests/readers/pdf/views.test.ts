/**
 * Lecteur PDF sur des pages SYNTHÉTIQUES qui portent plusieurs vues ou des pièces sans nom reconnu :
 *  - échelle décidée PAR VUE quand la page en porte plusieurs (plan au 1:100 à côté d'une coupe au 1:50) ;
 *  - surfaces écrites qui contredisent l'échelle retenue : estimation signalée ;
 *  - pièces sans nom du vocabulaire, ou sans texte : proposées « à classer », jamais passées sous silence ;
 *  - cotes en millimètres sans échelle annoncée, cartouche à traits forts dans l'angle du cadre.
 * Unités : points PDF.
 */
import { describe, expect, it } from 'vitest';
import type { DetectedRoom, PlanSheet } from '../../../src/core/types';
import { analysePdf, METRES_PER_POINT } from '../../../src/readers/pdf';
import type { RawSeg, RawText } from '../../../src/readers/pdf';
import { closeOutline, ringArea } from '../../../src/readers/pdf/planar';
import { calibrateByDimensions, chooseDimensionScale } from '../../../src/readers/pdf/scale';
import { areaM2, dimensionChain, page, rect, scaleDen, seg, text } from './helpers';

const WALL = 1.4;
const THIN = 0.25;

/** Points par mètre à l'échelle 1:den. */
const ppm = (den: number): number => 1 / (den * METRES_PER_POINT);

/** Traits fins d'habillage : sans eux la page n'aurait qu'une épaisseur de trait et pas de classe de murs. */
function dressing(): RawSeg[] {
  const out: RawSeg[] = [];
  for (let i = 0; i < 30; i++) out.push(seg(900, 60 + 4 * i, 1100, 60 + 4 * i, THIN));
  return out;
}

/** Rectangle de murs (faces extérieure et intérieure) de `w` × `d` m, murs de 40 cm, à l'échelle 1:den. */
function shell(x: number, y: number, w: number, d: number, den: number): RawSeg[] {
  const k = ppm(den);
  const t = 0.4 * k;
  return [...rect(x, y, x + w * k, y + d * k, WALL), ...rect(x + t, y + t, x + w * k - t, y + d * k - t, WALL)];
}

/** Mur intérieur de 12 cm (deux traits) entre deux points de la face intérieure, coordonnées en m depuis l'origine de la vue. */
function partition(x: number, y: number, den: number, a: [number, number], b: [number, number]): RawSeg[] {
  const k = ppm(den);
  const [ax, ay] = a;
  const [bx, by] = b;
  if (ax === bx) return [seg(x + ax * k, y + ay * k, x + bx * k, y + by * k, WALL), seg(x + (ax + 0.12) * k, y + ay * k, x + (bx + 0.12) * k, y + by * k, WALL)];
  return [seg(x + ax * k, y + ay * k, x + bx * k, y + by * k, WALL), seg(x + ax * k, y + (ay + 0.12) * k, x + bx * k, y + (by + 0.12) * k, WALL)];
}

/** Chaîne de cotes horizontale en cm, posée `above` pt au-dessus de l'ordonnée y ; `breaks` en m depuis x. */
function chain(x: number, y: number, den: number, breaks: number[], unit: 'cm' | 'mm' = 'cm'): { segs: RawSeg[]; texts: RawText[] } {
  const k = ppm(den);
  const xs = breaks.map((b) => x + b * k);
  const labels = breaks.slice(1).map((b, i) => String(Math.round((b - breaks[i]!) * (unit === 'cm' ? 100 : 1000))));
  return dimensionChain(xs, y, labels, THIN);
}

/**
 * Page A3 : rez-de-chaussée 10 × 8 m au 1:100 (à gauche) et coupe A-A au 1:50 (à droite, 8,5 × 5,6 m), chacune
 * avec son titre ; la coupe porte bien plus de cotes que le plan. Le cartouche annonce les deux échelles.
 */
function mixedPage(opts: { planCaption: boolean; planDims: boolean; roomAreas: boolean; blockScales?: string }): ReturnType<typeof page> {
  const px = 60;
  const py = 160;
  const k100 = ppm(100);
  const sx = 520;
  const sy = 205;
  const k50 = ppm(50);
  const segs: RawSeg[] = [...shell(px, py, 10, 8, 100), ...partition(px, py, 100, [6, 0.4], [6, 7.6]), ...shell(sx, sy, 8.5, 5.6, 50), ...dressing()];
  const texts: RawText[] = [];
  if (opts.planDims) {
    const c1 = chain(px, py - 15, 100, [0, 10]);
    const c2 = chain(px, py - 30, 100, [0, 4, 10]);
    segs.push(...c1.segs, ...c2.segs);
    texts.push(...c1.texts, ...c2.texts);
  }
  const s1 = chain(sx, sy - 15, 50, [0, 2, 4.5, 6.5, 8.5]);
  const s2 = chain(sx, sy - 32, 50, [0, 8.5]);
  segs.push(...s1.segs, ...s2.segs);
  texts.push(...s1.texts, ...s2.texts);
  // Pièces du plan : Séjour 5,60 × 7,20 = 40,32 m² ; Bureau 3,48 × 7,20 = 25,06 m².
  texts.push(text('Séjour', px + 3.2 * k100, py + 3.8 * k100), text('Bureau', px + 7.86 * k100, py + 3.8 * k100));
  if (opts.roomAreas) texts.push(text('40,32 m²', px + 3.2 * k100, py + 4.3 * k100, 7), text('25,06 m²', px + 7.86 * k100, py + 4.3 * k100, 7));
  texts.push(text('Rez-de-chaussée', px + 5 * k100, py + 8 * k100 + 30, 12));
  if (opts.planCaption) texts.push(text('Échelle 1:100', px + 5 * k100, py + 8 * k100 + 44, 7));
  texts.push(text('Coupe A-A', sx + 4.25 * k50, sy + 5.6 * k50 + 30, 12), text('Échelle 1:50', sx + 4.25 * k50, sy + 5.6 * k50 + 44, 7));
  texts.push(text('±0,00', sx + 9 * k50, sy + 5.2 * k50, 6), text('+2,80', sx + 9 * k50, sy + 2.4 * k50, 6));
  texts.push(text(opts.blockScales ?? 'Échelles 1:100 / 1:50', 1000, 790, 9));
  return page(segs, texts);
}

function planSheet(sheets: PlanSheet[]): PlanSheet {
  const s = sheets.find((x) => x.name === 'Rez-de-chaussée');
  if (!s) throw new Error(`pas de feuille Rez-de-chaussée (${sheets.map((x) => x.name).join(', ')})`);
  return s;
}

describe('échelle décidée par vue sur une page qui en porte plusieurs', () => {
  it('plan au 1:100 à côté d’une coupe au 1:50 plus cotée : le plan est mesuré au 1:100, d’après son intitulé et ses cotes', () => {
    const { doc } = analysePdf([mixedPage({ planCaption: true, planDims: true, roomAreas: false })], 'mixte.pdf');
    const sheet = planSheet(doc.sheets);
    expect(scaleDen(sheet)).toBeCloseTo(100, 6);
    expect(sheet.metresPerUnit!.from).toBe('plan');
    expect(sheet.metresPerUnit!.note).toMatch(/intitulé de la vue/);
    expect(Math.abs(areaM2(sheet, sheet.detected.outline!) / 80 - 1)).toBeLessThan(0.01);
    const sejour = sheet.detected.rooms.find((r) => r.name === 'Séjour')!;
    expect(Math.abs(sejour.measuredArea! / 40.32 - 1)).toBeLessThan(0.01);
  });

  it('plan sans intitulé ni cote propre : l’échelle de la page n’est qu’une estimation, et l’avertissement nomme les échelles candidates', () => {
    const { doc } = analysePdf([mixedPage({ planCaption: false, planDims: false, roomAreas: false })], 'mixte.pdf');
    const sheet = planSheet(doc.sheets);
    expect(sheet.metresPerUnit).not.toBeNull();
    expect(sheet.metresPerUnit!.from).toBe('estimate');
    const warning = doc.warnings.find((w) => /plusieurs échelles/i.test(w));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/1:50/);
    expect(warning).toMatch(/1:100/);
    expect(warning).toMatch(/Rez-de-chaussée/);
  });

  it('sans intitulé ni cote propre, mais avec les surfaces écrites des pièces : celles-ci donnent l’échelle de la vue', () => {
    const { doc } = analysePdf([mixedPage({ planCaption: false, planDims: false, roomAreas: true })], 'mixte.pdf');
    const sheet = planSheet(doc.sheets);
    // Deux pièces seulement : trop peu pour un calibrage par les surfaces, la page reste une estimation…
    expect(sheet.metresPerUnit!.from).toBe('estimate');
    // … mais jamais confirmée à tort au 1:50.
    expect(doc.warnings.join('\n')).toMatch(/plusieurs échelles/i);
  });

  it('plan sans intitulé avec trois cotes à lui : 1:100 retenu, mais en estimation, et l’avertissement nomme les échelles de la page', () => {
    const { doc } = analysePdf([mixedPage({ planCaption: false, planDims: true, roomAreas: false })], 'mixte.pdf');
    const sheet = planSheet(doc.sheets);
    expect(scaleDen(sheet)).toBeCloseTo(100, 6);
    expect(sheet.metresPerUnit!.from).toBe('estimate');
    expect(doc.warnings.some((w) => /plusieurs échelles/i.test(w) && /1:50/.test(w) && /1:100/.test(w))).toBe(true);
  });

  it('en allemand, l’avertissement est en allemand', () => {
    const { doc } = analysePdf([mixedPage({ planCaption: false, planDims: false, roomAreas: false })], 'mixte.pdf', { lang: 'de' });
    expect(doc.warnings.some((w) => /mehrere Maßstäbe/i.test(w) && /1:50/.test(w) && /1:100/.test(w))).toBe(true);
  });

  it('une seule échelle annoncée et des cotes d’accord : rien ne change (« confirmée »)', () => {
    const p = mixedPage({ planCaption: false, planDims: true, roomAreas: false, blockScales: 'Échelle 1:100' });
    // Sans la coupe au 1:50 : une seule vue, une seule échelle.
    const segs = p.segs.filter((s) => Math.min(s.x0, s.x1) < 480 || s.w === THIN);
    const texts = p.texts.filter((t) => t.cx < 480 || t.cy > 780);
    const { doc } = analysePdf([{ ...p, segs: segs.filter((s) => !(s.w === THIN && Math.min(s.x0, s.x1) >= 480 && s.y0 < 160)), texts }], 'simple.pdf');
    const sheet = planSheet(doc.sheets);
    expect(sheet.metresPerUnit!.from).toBe('plan');
    expect(doc.warnings.some((w) => /plusieurs échelles/i.test(w))).toBe(false);
  });
});

describe('surfaces écrites qui contredisent l’échelle retenue', () => {
  it('cotes au 1:50 confirmant le cartouche, surfaces écrites d’un plan au 1:100 : estimation, et on le dit', () => {
    // Plan 10 × 8 m dessiné au 1:100, mais cartouche et cotes disent 1:50 (cotes écrites pour 1:50).
    const px = 60;
    const py = 160;
    const k = ppm(100);
    const segs: RawSeg[] = [...shell(px, py, 10, 8, 100), ...partition(px, py, 100, [6, 0.4], [6, 7.6]), ...dressing()];
    const texts: RawText[] = [text('Échelle 1:50', 1000, 790, 9), text('Rez-de-chaussée', px + 5 * k, py + 8 * k + 30, 12)];
    // Cotes lues au 1:50 : les longueurs sur la feuille valent la moitié des valeurs écrites.
    const c1 = chain(px, py - 15, 50, [0, 2, 4, 5]);
    const c2 = chain(px, py - 30, 50, [0, 5]);
    segs.push(...c1.segs, ...c2.segs);
    texts.push(...c1.texts, ...c2.texts);
    texts.push(text('Séjour', px + 3.2 * k, py + 3.8 * k), text('40,32 m²', px + 3.2 * k, py + 4.3 * k, 7));
    texts.push(text('Bureau', px + 7.86 * k, py + 3.8 * k), text('25,06 m²', px + 7.86 * k, py + 4.3 * k, 7));
    const { doc } = analysePdf([page(segs, texts)], 'faux.pdf');
    const sheet = doc.sheets[0]!;
    expect(scaleDen(sheet)).toBeCloseTo(50, 6);
    expect(sheet.metresPerUnit!.from).toBe('estimate');
    expect(sheet.metresPerUnit!.note).toMatch(/surfaces écrites/);
    expect(doc.warnings.some((w) => /surfaces écrites/.test(w) && /1:50/.test(w))).toBe(true);
  });
});

/** Maison 10 × 8 m au 1:100 : Séjour à gauche, deux pièces à droite, une gaine de 60 × 60 cm dans la pièce du bas. */
function unnamedPage(rightTop: RawText[], rightBottom: RawText[], extra: RawText[] = []): ReturnType<typeof page> {
  const px = 200;
  const py = 200;
  const k = ppm(100);
  const segs: RawSeg[] = [
    ...shell(px, py, 10, 8, 100),
    ...partition(px, py, 100, [6, 0.4], [6, 7.6]),
    ...partition(px, py, 100, [6.12, 4], [9.6, 4]),
    // Gaine technique : deux murs fermant un carré de 60 cm dans l'angle de la pièce du bas.
    seg(px + 9 * k, py + 7 * k, px + 9.6 * k, py + 7 * k, WALL),
    seg(px + 9 * k, py + 7 * k, px + 9 * k, py + 7.6 * k, WALL),
    ...dressing(),
  ];
  const texts: RawText[] = [text('Échelle 1:100', 1000, 790, 9), text('Rez-de-chaussée', px + 5 * k, py + 8 * k + 30, 12)];
  texts.push(text('Séjour', px + 3.2 * k, py + 3.8 * k), text('40,32 m²', px + 3.2 * k, py + 4.3 * k, 7));
  const c = chain(px, py - 15, 100, [0, 6, 10]);
  const c2 = chain(px, py - 30, 100, [0, 10]);
  segs.push(...c.segs, ...c2.segs);
  texts.push(...c.texts, ...c2.texts, ...rightTop, ...rightBottom, ...extra);
  return page(segs, texts);
}

const K = ppm(100);
const TOP = { x: 200 + 7.86 * K, y: 200 + 2.2 * K };
const BOTTOM = { x: 200 + 7.5 * K, y: 200 + 5.5 * K };

function byName(rooms: DetectedRoom[], name: string): DetectedRoom | undefined {
  return rooms.find((r) => r.name === name);
}

describe('pièces sans nom reconnu', () => {
  it('texte hors vocabulaire dans une face, face sans texte : deux pièces « à classer », mesurées, et une remarque qui les compte', () => {
    const { doc } = analysePdf([unnamedPage([text('Werkraum', TOP.x, TOP.y)], [])], 'maison.pdf');
    const sheet = doc.sheets[0]!;
    expect(sheet.detected.outline).toBeDefined();
    const rooms = sheet.detected.rooms;
    // Séjour (reconnu) + Werkraum (texte inconnu) + une pièce sans texte ; ni la gaine, ni les corps de murs, ni le contour.
    expect(rooms).toHaveLength(3);
    expect(byName(rooms, 'Séjour')!.heatedGuess).toBe('yes');
    const werkraum = byName(rooms, 'Werkraum')!;
    expect(werkraum.heatedGuess).toBe('ask');
    // 3,48 × 3,60 m.
    expect(werkraum.measuredArea).toBeCloseTo(12.53, 1);
    expect(Math.abs(areaM2(sheet, werkraum.polygon!) / 12.528 - 1)).toBeLessThan(0.01);
    const blank = byName(rooms, '')!;
    expect(blank.heatedGuess).toBe('ask');
    // 3,48 × 3,48 m moins la gaine de 0,60 × 0,60 m.
    expect(blank.measuredArea).toBeCloseTo(12.11 - 0.36, 1);
    expect(blank.polygon).toBeDefined();
    expect(blank.at).toBeDefined();
    expect(sheet.detected.notes.some((n) => /^2 pièce\(s\) sans nom de pièce reconnu/.test(n) && /Werkraum/.test(n))).toBe(true);
  });

  it('une surface écrite sans nom reconnu est gardée avec la pièce (« Loft » 12,53 m²)', () => {
    const { doc } = analysePdf([unnamedPage([text('Loft', TOP.x, TOP.y), text('12,53 m²', TOP.x, TOP.y + 10, 7)], [text('Zone A', BOTTOM.x, BOTTOM.y)])], 'maison.pdf');
    const rooms = doc.sheets[0]!.detected.rooms;
    expect(rooms).toHaveLength(3);
    const loft = byName(rooms, 'Loft')!;
    expect(loft.statedArea).toBeCloseTo(12.53, 6);
    expect(loft.measuredArea).toBeCloseTo(12.53, 1);
    expect(byName(rooms, 'Zone A')!.heatedGuess).toBe('ask');
  });

  it('remarque en allemand', () => {
    const { doc } = analysePdf([unnamedPage([text('Werkraum', TOP.x, TOP.y)], [])], 'haus.pdf', { lang: 'de' });
    expect(doc.sheets[0]!.detected.notes.some((n) => /^2 Raum\/Räume ohne erkannten Raumnamen/.test(n) && /ohne Text/.test(n))).toBe(true);
  });

  it('toutes les pièces nommées : aucune pièce ajoutée, aucune remarque', () => {
    const { doc } = analysePdf([unnamedPage([text('Cuisine', TOP.x, TOP.y)], [text('Chambre', BOTTOM.x, BOTTOM.y)])], 'maison.pdf');
    const sheet = doc.sheets[0]!;
    expect(sheet.detected.rooms.map((r) => r.name).sort()).toEqual(['Chambre', 'Cuisine', 'Séjour']);
    expect(sheet.detected.notes.some((n) => /sans nom de pièce reconnu/.test(n))).toBe(false);
  });
});

describe('cotes en millimètres et cartouche', () => {
  /** Plan 10 × 8 m au 1:50 coté en mm, sans échelle écrite ; cartouche à traits forts dans l'angle du cadre. */
  function mmPage(): ReturnType<typeof page> {
    const px = 100;
    const py = 150;
    const k = ppm(50);
    const segs: RawSeg[] = [...shell(px, py, 10, 8, 50), ...partition(px, py, 50, [6, 0.4], [6, 7.6]), ...dressing()];
    const c1 = chain(px, py - 15, 50, [0, 1.5, 4, 7.5, 8.5, 10], 'mm');
    const c2 = chain(px, py - 32, 50, [0, 10], 'mm');
    segs.push(...c1.segs, ...c2.segs);
    // Cadre (trait de 2 pt) et cartouche dans l'angle inférieur droit, au trait de mur.
    segs.push(...rect(28, 28, 1162, 814, 2), ...rect(800, 700, 1162, 814, WALL));
    const texts: RawText[] = [...c1.texts, ...c2.texts, text('Rez-de-chaussée', px + 5 * k, py + 8 * k + 30, 12)];
    texts.push(text('Séjour', px + 3 * k, py + 4 * k), text('Bureau', px + 7.9 * k, py + 4 * k));
    texts.push(text('Projet', 830, 715, 6), text('Plan', 830, 745, 6), text('Séjour', 980, 750, 10), text('Date', 830, 785, 6), text('12.03.2024', 980, 790, 8));
    return page(segs, texts);
  }

  it('des cotes entières presque toutes ≥ 1000 sont des millimètres quand elles donnent une échelle de plan usuelle', () => {
    const cal = calibrateByDimensions(mmPage());
    const choice = chooseDimensionScale(cal, [], null)!;
    expect(choice.unit).toBe('mm');
    expect(choice.den).toBeCloseTo(50, 3);
    // Rien ne le dit sur le plan : le doute reste signalé.
    expect(choice.ambiguous).toBe(true);
  });

  it('plan au 1:50 coté en mm sans échelle annoncée : 1:50 estimé, contour de 80 m², et le cartouche n’est pas une vue', () => {
    const { doc } = analysePdf([mmPage()], 'mm.pdf');
    expect(doc.sheets).toHaveLength(1);
    const sheet = doc.sheets[0]!;
    expect(sheet.name).toBe('Rez-de-chaussée');
    expect(scaleDen(sheet)).toBeCloseTo(50, 3);
    expect(sheet.metresPerUnit!.from).toBe('estimate');
    expect(sheet.metresPerUnit!.note).toMatch(/mm/);
    expect(Math.abs(areaM2(sheet, sheet.detected.outline!) / 80 - 1)).toBeLessThan(0.01);
  });

  it('un cartouche à traits forts dans l’angle du cadre n’est pas proposé comme plan, même à la bonne échelle', () => {
    const p = mmPage();
    // Échelle écrite dans le cartouche : le plan est lu au 1:50 sans hésitation, le cartouche fait alors 12,8 m².
    const { doc, pages } = analysePdf([{ ...p, texts: [...p.texts, text('Échelle 1:50', 980, 770, 8)] }], 'mm.pdf');
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée']);
    expect(pages[0]!.views.map((v) => v.kind)).toEqual(['plan']);
  });
});

describe('fermeture du contour (tampon jsts)', () => {
  it('rectangle de 10 × 8 m au 1:50, rayon de 1,30 m : contour exact, sans angle rogné ni triangle parasite', () => {
    // Valeurs en flottants qui faisaient dérailler jsts en double précision (mesuré : un angle coupé en biais
    // et un triangle de 300 pt inventé au-dessus du plan).
    const k = ppm(50);
    const x = 100;
    const y = 150;
    const w = 10 * k;
    const d = 8 * k;
    const segs = [
      { ax: x, ay: y, bx: x + w, by: y },
      { ax: x + w, ay: y, bx: x + w, by: y + d },
      { ax: x + w, ay: y + d, bx: x, by: y + d },
      { ax: x, ay: y + d, bx: x, by: y },
    ];
    const rings = closeOutline(segs, 1.3 * k, 6 * k * k);
    expect(rings).toHaveLength(1);
    expect(Math.abs(ringArea(rings[0]!) / (w * d) - 1)).toBeLessThan(1e-4);
  });
});

