/**
 * Lecteur IFC de bout en bout (web-ifc sous Node) sur les deux maisons d'essai de tests/fixtures/ifc,
 * dont toutes les dimensions sont connues (voir make_fixtures.py).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { distance, edgeLength, polygonArea } from '../../../src/core/geometry';
import type { DetectedOpening, PlanDocument, Vec2 } from '../../../src/core/types';
import { knownKeys } from '../../../src/i18n';
import { IFC_MESSAGES, analyseIfc, createIfcApi, readIfc } from '../../../src/readers/ifc';
import maisonText from '../../fixtures/ifc/maison-test.ifc?raw';
import pavillonText from '../../fixtures/ifc/pavillon-mm.ifc?raw';
import { distanceToRing, sheetNamed, toBuffer } from './helpers';

/** Décalage du bâtiment dans maison-test.ifc. */
const OX = 1.013;
const OY = 2.007;
/** Point du repère du bâtiment (y vers le haut) → point de feuille (y vers le bas). */
const sheetPoint = (x: number, y: number): Vec2 => ({ x: OX + x, y: -(OY + y) });

function nearestVertex(p: Vec2, ring: readonly Vec2[]): number {
  return Math.min(...ring.map((q) => distance(p, q)));
}

function sizes(openings: readonly DetectedOpening[]): string[] {
  return openings.map((o) => `${o.kind} ${o.width?.toFixed(2)}x${o.height?.toFixed(2)}`).sort();
}

describe('maison-test.ifc — deux niveaux, mètres, nord tourné', () => {
  let doc: PlanDocument;
  beforeAll(async () => {
    doc = await readIfc(toBuffer(maisonText), 'maison-test.ifc');
  });

  it('document : type, feuilles du bas vers le haut, repère commun', () => {
    expect(doc.kind).toBe('ifc');
    expect(doc.fileName).toBe('maison-test.ifc');
    expect(doc.storeysAligned).toBe(true);
    expect(doc.sheets.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage']);
    expect(new Set(doc.sheets.map((s) => s.id)).size).toBe(2);
    for (const s of doc.sheets) {
      expect(s.metresPerUnit).toMatchObject({ value: 1, from: 'plan' });
      expect(s.image).toBeUndefined();
    }
  });

  it('nord : TrueNorth à 30° dans le sens horaire de +Y → le haut de la feuille regarde 330°', () => {
    expect(doc.northAngle?.from).toBe('plan');
    expect(doc.northAngle?.value).toBeCloseTo(330, 3);
    expect(doc.warnings.some((w) => /boussole/.test(w))).toBe(false);
  });

  it('rez-de-chaussée : contour en L de 68,00 m², 6 sommets exacts, en repère y vers le bas', () => {
    const outline = sheetNamed(doc, 'Rez-de-chaussée').detected.outline!;
    expect(outline).toHaveLength(6);
    expect(polygonArea(outline)).toBeCloseTo(68, 2);
    for (const [x, y] of [[0, 0], [10, 0], [10, 8], [4, 8], [4, 5], [0, 5]] as const) {
      expect(nearestVertex(sheetPoint(x, y), outline)).toBeLessThan(0.002);
    }
    // La dalle de toiture débordante et la dalle de sol ne comptent pas dans l'emprise.
    expect(Math.max(...outline.map((p) => p.x))).toBeCloseTo(OX + 10, 3);
  });

  it('étage : rectangle de 48,00 m² (tranche de hauteur propre à l’étage)', () => {
    const outline = sheetNamed(doc, 'Étage').detected.outline!;
    expect(outline).toHaveLength(4);
    expect(polygonArea(outline)).toBeCloseTo(48, 2);
    for (const [x, y] of [[4, 0], [10, 0], [10, 8], [4, 8]] as const) {
      expect(nearestVertex(sheetPoint(x, y), outline)).toBeLessThan(0.002);
    }
  });

  it('hauteurs : de niveau à niveau, puis jusqu’au sommet des murs ; hauteur libre des locaux', () => {
    const rdc = sheetNamed(doc, 'Rez-de-chaussée').detected;
    const etage = sheetNamed(doc, 'Étage').detected;
    expect(rdc.elevation).toBeCloseTo(0, 6);
    expect(rdc.storeyHeight).toBeCloseTo(2.8, 6);
    expect(rdc.clearHeight).toBeCloseTo(2.5, 6);
    expect(etage.elevation).toBeCloseTo(2.8, 6);
    expect(etage.storeyHeight).toBeCloseTo(2.6, 6);
    expect(etage.clearHeight).toBeCloseTo(2.4, 6);
  });

  it('niveau de toiture sans mur : pas de feuille, mais un avertissement', () => {
    expect(doc.warnings.some((w) => w.includes('« Toiture »'))).toBe(true);
  });

  it('rez-de-chaussée : 4 fenêtres et 2 portes extérieures, 1 porte intérieure, dimensions hors tout', () => {
    const openings = sheetNamed(doc, 'Rez-de-chaussée').detected.openings;
    expect(openings).toHaveLength(7);
    const exterior = openings.filter((o) => o.exterior === true);
    expect(sizes(exterior)).toEqual(['door 1.00x2.10', 'door 2.40x2.10', 'window 0.80x0.60', 'window 1.00x1.20', 'window 1.20x1.40', 'window 2.00x2.20']);
    const inner = openings.filter((o) => o.exterior === false);
    expect(sizes(inner)).toEqual(['door 0.90x2.00']);
  });

  it('étage : 3 fenêtres extérieures ; la coupole de toit n’est rattachée à aucune façade', () => {
    const openings = sheetNamed(doc, 'Étage').detected.openings;
    expect(sizes(openings.filter((o) => o.exterior === true))).toEqual(['window 0.90x1.20', 'window 1.20x1.40', 'window 1.60x1.20']);
    // Fenêtre de toit sans réservation (lue sur son propre maillage) : listée, mais pas « extérieure » au sens du contour.
    expect(sizes(openings.filter((o) => o.exterior === false))).toEqual(['window 1.00x1.00']);
    expect(doc.warnings.filter((w) => /1 fenêtre\(s\) de toit/.test(w))).toHaveLength(1);
  });

  it('les ouvertures extérieures sont posées SUR le contour, à leur vraie place', () => {
    for (const sheet of doc.sheets) {
      const outline = sheet.detected.outline!;
      for (const o of sheet.detected.openings.filter((x) => x.exterior)) {
        expect(distanceToRing(o.a, outline)).toBeLessThan(0.002);
        expect(distanceToRing(o.b, outline)).toBeLessThan(0.002);
        expect(distance(o.a, o.b)).toBeCloseTo(o.width!, 3);
      }
    }
    const rdc = sheetNamed(doc, 'Rez-de-chaussée').detected.openings;
    const mid = (o: DetectedOpening): Vec2 => ({ x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 });
    const at = (w: number, h: number): Vec2 => mid(rdc.find((o) => o.width === w && o.height === h)!);
    // F1 : façade sud (y = 0), milieu à x = 1,5.
    expect(distance(at(1.2, 1.4), sheetPoint(1.5, 0))).toBeLessThan(0.003);
    // F3 : façade est (x = 10), milieu à y = 2,0.
    expect(distance(at(0.8, 0.6), sheetPoint(10, 2))).toBeLessThan(0.003);
    // F4 : façade de l'encoche (y = 5), milieu à x = 2,0.
    expect(distance(at(1, 1.2), sheetPoint(2, 5))).toBeLessThan(0.003);
    // Porte d'entrée : façade ouest (x = 0), milieu à y = 2,5.
    expect(distance(at(1, 2.1), sheetPoint(0, 2.5))).toBeLessThan(0.003);
    // Porte intérieure : dans la cloison (x = 6,0), milieu à y = 3,0.
    expect(distance(at(0.9, 2), sheetPoint(6, 3))).toBeLessThan(0.003);
  });

  it('la remarque sur la baie brute (plus grande que la menuiserie) est donnée une seule fois', () => {
    expect(doc.warnings.filter((w) => /baie brute/.test(w))).toHaveLength(1);
  });

  it('pièces : noms, surfaces mesurées et déclarées, proposition « chauffé »', () => {
    const rdc = sheetNamed(doc, 'Rez-de-chaussée').detected.rooms;
    expect(rdc.map((r) => r.name).sort()).toEqual(['Garage', 'Séjour']);
    const sejour = rdc.find((r) => r.name === 'Séjour')!;
    expect(sejour.heatedGuess).toBe('yes');
    expect(sejour.measuredArea).toBeCloseTo(29.81, 2);
    expect(sejour.statedArea).toBeCloseTo(29.81, 2);
    expect(sejour.polygon).toHaveLength(6);
    expect(polygonArea(sejour.polygon!)).toBeCloseTo(29.81, 2);
    expect(nearestVertex(sheetPoint(0.3, 0.3), sejour.polygon!)).toBeLessThan(0.002);
    const garage = rdc.find((r) => r.name === 'Garage')!;
    expect(garage.heatedGuess).toBe('no');
    expect(garage.measuredArea).toBeCloseTo(27.01, 2);

    const etage = sheetNamed(doc, 'Étage').detected.rooms;
    const chambre = etage.find((r) => r.name === 'Chambre 1')!;
    // Surface déclarée par l'architecte (avec déduction) ≠ surface mesurée sur la géométrie.
    expect(chambre.statedArea).toBeCloseTo(19.38, 2);
    expect(chambre.measuredArea).toBeCloseTo(19.98, 2);
    const bain = etage.find((r) => r.name === 'Salle de bain')!;
    expect(bain.statedArea).toBeUndefined();
    expect(bain.measuredArea).toBeCloseTo(19.44, 2);
    expect(bain.heatedGuess).toBe('yes');
    // Local sans géométrie : repris avec sa seule surface déclarée, à trancher par l'expert.
    const debarras = etage.find((r) => r.name === 'Débarras')!;
    expect(debarras.statedArea).toBeCloseTo(3.5, 6);
    expect(debarras.measuredArea).toBeUndefined();
    expect(debarras.polygon).toBeUndefined();
    expect(debarras.heatedGuess).toBe('ask');
    expect(etage).toHaveLength(3);
    expect(sheetNamed(doc, 'Étage').detected.notes.some((n) => /surface déclarée/.test(n))).toBe(true);
    expect(doc.warnings.some((w) => /Aucun local/.test(w))).toBe(false);
  });

  it('traits du plan : coupe des murs avec les baies ouvertes, étendue cohérente', () => {
    const sheet = sheetNamed(doc, 'Rez-de-chaussée');
    const seg = sheet.segments!;
    expect(seg).toBeInstanceOf(Float32Array);
    expect(seg.length % 4).toBe(0);
    expect(seg.length / 4).toBeGreaterThan(40);
    expect(seg.length / 4).toBeLessThan(1000);
    // Face extérieure du mur sud : y_feuille = −OY. À mi-fenêtre F1 (x = 1,5) le mur est coupé à 1,10 m → pas de trait de mur
    // plus long que la baie à cet endroit, alors qu'il y en a un entre F1 et F2 (x = 2,6).
    const coversSouthFace = (x: number): boolean => {
      for (let i = 0; i + 3 < seg.length; i += 4) {
        const onFace = Math.abs(seg[i + 1]! + OY) < 0.002 && Math.abs(seg[i + 3]! + OY) < 0.002;
        const lo = Math.min(seg[i]!, seg[i + 2]!);
        const hi = Math.max(seg[i]!, seg[i + 2]!);
        if (onFace && lo <= OX + x && OX + x <= hi && hi - lo > 1.3) return true;
      }
      return false;
    };
    expect(coversSouthFace(2.6)).toBe(false); // trumeau de 0,90 m entre les deux baies : trait court
    expect(coversSouthFace(1.5)).toBe(false);
    const wallAt = (x: number): boolean => {
      for (let i = 0; i + 3 < seg.length; i += 4) {
        const onFace = Math.abs(seg[i + 1]! + OY) < 0.002 && Math.abs(seg[i + 3]! + OY) < 0.002;
        if (onFace && Math.min(seg[i]!, seg[i + 2]!) <= OX + x && OX + x <= Math.max(seg[i]!, seg[i + 2]!)) return true;
      }
      return false;
    };
    expect(wallAt(0.5)).toBe(true);
    expect(wallAt(2.6)).toBe(true);
    const b = sheet.bbox;
    for (const p of sheet.detected.outline!) {
      expect(p.x).toBeGreaterThanOrEqual(b.minX - 1e-3);
      expect(p.x).toBeLessThanOrEqual(b.maxX + 1e-3);
      expect(p.y).toBeGreaterThanOrEqual(b.minY - 1e-3);
      expect(p.y).toBeLessThanOrEqual(b.maxY + 1e-3);
    }
    expect(b.maxY).toBeLessThan(0); // tout le plan est en y négatif : l'axe y a bien été retourné
  });
});

describe('pavillon-mm.ifc — millimètres, bâtiment tourné de 25°, sans local, nord par défaut', () => {
  let doc: PlanDocument;
  beforeAll(async () => {
    doc = await readIfc(toBuffer(pavillonText), 'pavillon-mm.ifc');
  });

  it('une seule feuille : le plan de plafond n’est pas un étage', () => {
    expect(doc.sheets.map((s) => s.name)).toEqual(['RDC']);
    expect(doc.warnings.some((w) => w.includes('« Plafond »'))).toBe(true);
  });

  it('contour : rectangle 9 × 7 m tourné, 63,00 m², converti des millimètres', () => {
    const sheet = sheetNamed(doc, 'RDC');
    const outline = sheet.detected.outline!;
    expect(outline).toHaveLength(4);
    expect(polygonArea(outline)).toBeCloseTo(63, 2);
    const lengths = outline.map((_, i) => edgeLength(outline, i)).sort((a, b) => a - b);
    expect(lengths[0]).toBeCloseTo(7, 2);
    expect(lengths[1]).toBeCloseTo(7, 2);
    expect(lengths[2]).toBeCloseTo(9, 2);
    expect(lengths[3]).toBeCloseTo(9, 2);
    // Coin d'origine du bâtiment : (15 ; 8) m dans l'IFC → (15 ; −8) sur la feuille.
    expect(nearestVertex({ x: 15, y: -8 }, outline)).toBeLessThan(0.002);
    // Un grand côté est incliné de 25° (vers le haut de la feuille, donc y décroissant).
    const a = { x: 15, y: -8 };
    const b = { x: 15 + 9 * Math.cos((25 * Math.PI) / 180), y: -(8 + 9 * Math.sin((25 * Math.PI) / 180)) };
    expect(nearestVertex(b, outline)).toBeLessThan(0.002);
    expect(distance(a, b)).toBeCloseTo(9, 6);
    expect(sheet.metresPerUnit?.note).toContain('mm');
  });

  it('hauteur : niveau unique, mesurée jusqu’au sommet des murs', () => {
    const d = sheetNamed(doc, 'RDC').detected;
    expect(d.storeyHeight).toBeCloseTo(2.75, 6);
    expect(d.clearHeight).toBeUndefined();
    expect(d.rooms).toHaveLength(0);
  });

  it('ouvertures : 2 fenêtres et 1 porte extérieures en mètres ; la porte de l’abri n’est pas reprise', () => {
    const d = sheetNamed(doc, 'RDC').detected;
    expect(sizes(d.openings)).toEqual(['door 1.00x2.10', 'window 1.00x1.00', 'window 1.50x1.30']);
    for (const o of d.openings) {
      expect(o.exterior).toBe(true);
      expect(distanceToRing(o.a, d.outline!)).toBeLessThan(0.002);
      expect(distanceToRing(o.b, d.outline!)).toBeLessThan(0.002);
    }
    expect(doc.warnings.some((w) => /autre volume/.test(w))).toBe(true);
  });

  it('avertissements : nord par défaut, aucun local, plusieurs volumes, zone chauffée à vérifier', () => {
    expect(doc.northAngle).toBeUndefined();
    expect(doc.warnings.some((w) => /Nord non renseigné/.test(w))).toBe(true);
    expect(doc.warnings.some((w) => /Aucun local/.test(w))).toBe(true);
    expect(doc.warnings.some((w) => /Plusieurs volumes/.test(w) && w.includes('« RDC »'))).toBe(true);
    expect(doc.warnings.some((w) => /zone chauffée/.test(w))).toBe(true);
    expect(sheetNamed(doc, 'RDC').detected.notes.some((n) => /2 volumes/.test(n) && /15,0/.test(n))).toBe(true);
  });
});

describe('cas limites et langue', () => {
  it('fichier qui n’est pas un IFC : erreur en français', async () => {
    await expect(readIfc(toBuffer('ceci n’est pas un fichier IFC'), 'faux.ifc')).rejects.toThrow(/IFC illisible/);
  });

  it('IFC sans mur ni local : aucune feuille et un avertissement clair', async () => {
    const empty =
      "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n" +
      "#1=IFCPROJECT('0000000000000000000001',$,'vide',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    const doc = await readIfc(toBuffer(empty), 'vide.ifc');
    expect(doc.sheets).toHaveLength(0);
    expect(doc.kind).toBe('ifc');
    expect(doc.warnings[0]).toMatch(/Aucun mur ni local/);
  });

  it('coordonnées très éloignées de l’origine (repère national) : plan recentré, mêmes dimensions', async () => {
    // Le pavillon posé à (75 015 ; 95 008) m au lieu de (15 ; 8) m.
    const far = pavillonText.replace('IFCCARTESIANPOINT((15000.,8000.,0.))', 'IFCCARTESIANPOINT((75015000.,95008000.,0.))');
    expect(far).not.toBe(pavillonText);
    const doc = await readIfc(toBuffer(far), 'pavillon-loin.ifc');
    const outline = doc.sheets[0]!.detected.outline!;
    expect(outline).toHaveLength(4);
    expect(polygonArea(outline)).toBeCloseTo(63, 2);
    expect(Math.min(...outline.map((p) => distance(p, { x: 15, y: -8 })))).toBeLessThan(0.002);
    expect(doc.warnings.some((w) => /recentré de \(75000 ; 95000\) m/.test(w))).toBe(true);
    expect(doc.storeysAligned).toBe(true);
  });

  it('niveau sans aucun mur : les locaux sont réunis en un contour, et c’est dit', async () => {
    // Deux locaux de 4 × 3 m et 3,8 × 3 m séparés par 20 cm (l'épaisseur d'une cloison absente du fichier).
    const space = (n: number, x0: number, x1: number, name: string): string => {
      const b = 100 * n;
      return [
        `#${b + 1}=IFCCARTESIANPOINT((${x0},0.));`,
        `#${b + 2}=IFCCARTESIANPOINT((${x1},0.));`,
        `#${b + 3}=IFCCARTESIANPOINT((${x1},3.));`,
        `#${b + 4}=IFCCARTESIANPOINT((${x0},3.));`,
        `#${b + 5}=IFCPOLYLINE((#${b + 1},#${b + 2},#${b + 3},#${b + 4},#${b + 1}));`,
        `#${b + 6}=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${b + 5});`,
        `#${b + 7}=IFCEXTRUDEDAREASOLID(#${b + 6},#2,#3,2.5);`,
        `#${b + 8}=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#${b + 7}));`,
        `#${b + 9}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${b + 8}));`,
        `#${b + 10}=IFCSPACE('000000000000000000000${n}',$,'${n}',$,$,#8,#${b + 9},'${name}',.ELEMENT.,.INTERNAL.,$);`,
      ].join('\n');
    };
    const text = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION((''),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      '#1=IFCCARTESIANPOINT((0.,0.,0.));',
      '#2=IFCAXIS2PLACEMENT3D(#1,$,$);',
      '#3=IFCDIRECTION((0.,0.,1.));',
      '#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      '#5=IFCUNITASSIGNMENT((#4));',
      "#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#2,$);",
      "#7=IFCPROJECT('0000000000000000000007',$,'locaux seuls',$,$,$,$,(#6),#5);",
      '#8=IFCLOCALPLACEMENT($,#2);',
      "#9=IFCBUILDINGSTOREY('0000000000000000000009',$,'Niveau 0',$,$,#8,$,$,.ELEMENT.,0.);",
      space(1, 0, 4, 'Sejour'),
      space(2, 4.2, 8, 'Cuisine'),
      "#10=IFCRELAGGREGATES('0000000000000000000010',$,$,$,#9,(#110,#210));",
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n');
    const doc = await readIfc(toBuffer(text), 'locaux-seuls.ifc');
    expect(doc.sheets).toHaveLength(1);
    const d = doc.sheets[0]!.detected;
    expect(d.outline).toHaveLength(4);
    expect(polygonArea(d.outline!)).toBeCloseTo(24, 2);
    expect(d.rooms.map((r) => `${r.name} ${r.measuredArea} ${r.heatedGuess}`).sort()).toEqual(['Cuisine 11.4 yes', 'Sejour 12 yes']);
    expect(d.notes.some((n) => /seuls locaux/.test(n))).toBe(true);
    expect(d.clearHeight).toBeCloseTo(2.5, 6);
    expect(doc.warnings.some((w) => /Aucun nord/.test(w))).toBe(true);
    // Sans mur, les traits du plan se réduisent au contour proposé.
    expect(doc.sheets[0]!.segments!.length / 4).toBe(4);
  });

  it('analyse pure avec une instance web-ifc fournie, messages en allemand sur demande', async () => {
    const api = await createIfcApi();
    try {
      const de = await analyseIfc(api, new Uint8Array(toBuffer(pavillonText)), 'pavillon-mm.ifc', { lang: 'de' });
      expect(de.warnings.some((w) => /Kompass/.test(w))).toBe(true);
      expect(de.sheets[0]!.detected.outline).toHaveLength(4);
      // La même instance relit un second fichier.
      const fr = await analyseIfc(api, new Uint8Array(toBuffer(maisonText)), 'maison-test.ifc');
      expect(fr.sheets).toHaveLength(2);
    } finally {
      api.Dispose();
    }
  });

  it('une maille plus grossière garde les mêmes sommets (accrochage aux coins des murs)', async () => {
    const api = await createIfcApi();
    try {
      const doc = await analyseIfc(api, new Uint8Array(toBuffer(maisonText)), 'maison-test.ifc', { cell: 0.06 });
      const outline = sheetNamed(doc, 'Rez-de-chaussée').detected.outline!;
      expect(outline).toHaveLength(6);
      expect(polygonArea(outline)).toBeCloseTo(68, 1);
    } finally {
      api.Dispose();
    }
  });

  it('dictionnaires FR et DE complets et enregistrés', () => {
    const fr = Object.keys(IFC_MESSAGES.fr).sort();
    const de = Object.keys(IFC_MESSAGES.de).sort();
    expect(de).toEqual(fr);
    for (const key of fr) {
      expect(knownKeys('fr')).toContain(key);
      expect(knownKeys('de')).toContain(key);
      const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
      expect(vars(IFC_MESSAGES.de[key]!)).toEqual(vars(IFC_MESSAGES.fr[key]!));
    }
  });
});
