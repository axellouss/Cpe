/**
 * Compositions de parois écrites sur une planche : couches, familles de matériaux, rôle de la paroi, ordre intérieur →
 * extérieur, couches hors calcul, doutes, dédoublonnage. Phrases inventées, en français et en allemand.
 */
import { describe, expect, it } from 'vitest';
import type { ReadComposition } from '../../src/core/reading';
import { classifyComposition, compositionBlocks, materialKey, parseLayer, parseLayers, readCompositions } from '../../src/semantics/compositions';
import { box, lines, mk, split, stack, view } from './lines';

const section = view('coupe', 'section', box(0, 0, 1000, 1000));

function read(rows: string[], extra: ReturnType<typeof mk>[] = [], opts: Parameters<typeof readCompositions>[2] = {}): ReadComposition[] {
  return readCompositions(lines([...stack(rows, 100, 100), ...extra]), [section], opts);
}

describe('parseLayer', () => {
  it('lit l’épaisseur en tête, en queue, en millimètres, avec « d = »', () => {
    expect(parseLayer('24cm Béton')).toEqual({ label: 'Béton', thicknessCm: 24 });
    expect(parseLayer('1,5 cm Enduit plâtre')).toEqual({ label: 'Enduit plâtre', thicknessCm: 1.5 });
    expect(parseLayer('200 mm Mineralwolle WLG 035')).toEqual({ label: 'Mineralwolle WLG 035', thicknessCm: 20 });
    expect(parseLayer('d=16cm Holzfaser')).toEqual({ label: 'Holzfaser', thicknessCm: 16 });
    expect(parseLayer('Stahlbeton Bodenplatte 25 cm')).toEqual({ label: 'Stahlbeton Bodenplatte', thicknessCm: 25 });
    expect(parseLayer('120 Isolation laine de verre')).toEqual({ label: 'Isolation laine de verre', thicknessCm: 12 });
  });
  it('accepte une couche mince sans épaisseur, et un matériau sans épaisseur sous un titre', () => {
    expect(parseLayer('Film PE')).toEqual({ label: 'Film PE', thicknessCm: null });
    expect(parseLayer('Dampfbremse')).toEqual({ label: 'Dampfbremse', thicknessCm: null });
    expect(parseLayer('Tuiles en terre cuite')).toBeNull();
    expect(parseLayer('Tuiles en terre cuite', true)).toEqual({ label: 'Tuiles en terre cuite', thicknessCm: null });
  });
  it('refuse ce qui n’est pas une couche', () => {
    expect(parseLayer('Garage')).toBeNull();
    expect(parseLayer('S: 12,40 m²')).toBeNull();
    expect(parseLayer('Coupe AA')).toBeNull();
  });
  it('découpe une ligne qui porte plusieurs couches', () => {
    expect(parseLayers('24cm béton + 20cm EPS + 2cm enduit de façade')).toEqual([
      { label: 'béton', thicknessCm: 24 },
      { label: 'EPS', thicknessCm: 20 },
      { label: 'enduit de façade', thicknessCm: 2 },
    ]);
    expect(parseLayers('7cm Chape + ravoirage')).toEqual([{ label: 'Chape + ravoirage', thicknessCm: 7 }]);
  });
});

describe('materialKey', () => {
  it('reconnaît les familles en français et en allemand', () => {
    const cases: [string, string][] = [
      ['Isolation type EPS', 'eps'],
      ['Isolation mousse PUR', 'pur'],
      ['Panneau Styrodur', 'xps'],
      ['Isolation type PIR', 'pir'],
      ['Wärmedämmung EPS', 'eps'],
      ['Mineralwolle zw. Sparren', 'laine-minerale'],
      ['Holzfaserdämmplatte', 'fibre-bois'],
      ['Isolation', 'isolant'],
      ['Chape + ravoirage', 'chape'],
      ['Radier', 'beton-arme'],
      ['Dalle béton', 'beton-arme'],
      ['Béton', 'beton'],
      ['Blocs de béton', 'bloc-beton'],
      ['Béton de propreté', 'beton-maigre'],
      ['Kalksandstein', 'silico-calcaire'],
      ['Enduit de façade', 'enduit-facade'],
      ['Außenputz', 'enduit-facade'],
      ['Enduit plâtre', 'enduit-platre'],
      ['Gipskarton', 'enduit-platre'],
      ['Estrich', 'chape'],
      ['Fliesen', 'revetement-sol'],
      ['Étanchéité bitumineuse', 'etancheite'],
      ['Film PE', 'film'],
      ['Schotter', 'empierrement'],
      ['Hinterlüftung', 'lame-air'],
      ['Dachziegel', 'bardage'],
      ['Lattung', 'bois'],
      ['Matériau X', 'inconnu'],
    ];
    for (const [label, key] of cases) expect(materialKey(label), label).toBe(key);
  });
});

describe('compositions : rôle, ordre et couches comptées', () => {
  it('mur extérieur FR, couches de l’intérieur vers l’extérieur, doute sur « Béton » sans précision', () => {
    const [c] = read(['Composition mur :', '24cm Béton', '18cm Isolation type EPS', '2cm Enduit de façade']);
    expect(c!.element).toBe('external-wall');
    expect(c!.layers.map((l) => [l.material, l.thicknessCm])).toEqual([['beton', 24], ['eps', 18], ['enduit-facade', 2]]);
    expect(c!.layers[0]!.raw).toBe('24cm Béton');
    expect(c!.layers[0]!.doubt).toMatch(/blocs de béton/);
    expect(c!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(c!.occurrences[0]!.viewId).toBe('coupe');
  });

  it('mur écrit de l’extérieur vers l’intérieur : retourné', () => {
    const [c] = read(['Composition façade :', '2cm Enduit de façade', '16cm Isolation laine de roche', '20cm Blocs de béton', '1cm Enduit plâtre']);
    expect(c!.layers.map((l) => l.material)).toEqual(['enduit-platre', 'bloc-beton', 'laine-minerale', 'enduit-facade']);
  });

  it('Wandaufbau allemand avec lame d’air ventilée : la lame et le bardage ne comptent pas', () => {
    const [c] = read(['Wandaufbau Außenwand:', '1,5 cm Innenputz', '17,5 cm Kalksandstein', '200 mm Mineralwolle WLG 035', 'Hinterlüftung', '2 cm Holzschalung']);
    expect(c!.element).toBe('external-wall');
    expect(c!.layers.map((l) => l.material)).toEqual(['enduit-platre', 'silico-calcaire', 'laine-minerale', 'lame-air', 'bois']);
    expect(c!.layers.map((l) => l.counted)).toEqual([true, true, true, false, false]);
  });

  it('mur vers garage, mur mitoyen, mur contre terre', () => {
    expect(read(['Composition mur garage :', '24cm Béton', '12cm Isolation type EPS'])[0]!.element).toBe('wall-to-unheated');
    expect(read(['Composition mur mitoyen :', '24cm Béton armé', '4cm Laine minérale'])[0]!.element).toBe('party-wall');
    expect(read(['Wandaufbau Kellerwand gegen Erdreich:', '30cm Stahlbeton', '12cm XPS Perimeterdämmung'])[0]!.element).toBe('wall-to-ground');
  });

  it('Bodenaufbau sur sol : épaisseur en queue, couches sous le dernier isolant non comptées', () => {
    const [c] = read(['Bodenaufbau EG:', '1,5 cm Fliesen', '6,5 cm Estrich', 'PE-Folie', '12 cm PUR-Dämmung', 'Stahlbeton Bodenplatte 25 cm', '10 cm XPS Perimeterdämmung', '15 cm Schotter']);
    expect(c!.element).toBe('floor-on-ground');
    expect(c!.layers.map((l) => l.material)).toEqual(['revetement-sol', 'chape', 'film', 'pur', 'beton-arme', 'xps', 'empierrement']);
    expect(c!.layers.map((l) => l.counted)).toEqual([true, true, false, true, true, true, false]);
    expect(c!.layers[4]!.thicknessCm).toBe(25);
  });

  it('plancher écrit de bas en haut : retourné', () => {
    const [c] = read(['Composition radier :', '20cm Empierrement', '5cm Béton de propreté', '10cm Isolation XPS', '25cm Radier', '7cm Chape', '2cm Carrelage']);
    expect(c!.element).toBe('floor-on-ground');
    expect(c!.layers[0]!.material).toBe('revetement-sol');
    expect(c!.layers.filter((l) => !l.counted).map((l) => l.material)).toEqual(['beton-maigre', 'empierrement']);
  });

  it('toiture plate écrite de haut en bas : remise de l’intérieur vers l’extérieur', () => {
    const [c] = read(['Dachaufbau:', 'Abdichtung 2-lagig', '20 cm EPS-Gefälledämmung', 'Dampfsperre', '22 cm Stahlbetondecke', '1 cm Gipsputz']);
    expect(c!.element).toBe('roof');
    expect(c!.layers.map((l) => l.material)).toEqual(['enduit-platre', 'beton-arme', 'film', 'eps', 'etancheite']);
    expect(c!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('toiture titrée « dalle » : les matériaux décident', () => {
    const [c] = read(['Composition dalle :', '16cm Isolation type PIR', '20cm Dalle béton', '1cm Finition plâtre']);
    expect(c!.element).toBe('roof');
    expect(c!.layers[0]!.material).toBe('enduit-platre');
  });

  it('toiture inclinée en tuiles : couverture et lattes ventilées non comptées, couche mixte signalée', () => {
    const [c] = read(['Dachaufbau:', 'Dachziegel', '3cm Lattung', '8cm Holzfaserdämmplatte', '20cm Mineralwolle zw. Sparren', 'Dampfbremse', '1,25cm Gipskarton']);
    expect(c!.element).toBe('roof');
    expect(c!.layers.map((l) => [l.material, l.counted])).toEqual([
      ['enduit-platre', true],
      ['film', false],
      ['laine-minerale', true],
      ['fibre-bois', true],
      ['bois', false],
      ['bardage', false],
    ]);
    expect(c!.layers[2]!.doubt).toMatch(/mixte/i);
  });

  it('toiture inclinée avec écran de sous-toiture et lattes sans épaisseur : le bloc va jusqu’à la finition intérieure', () => {
    const de = read(['Dachaufbau:', 'Dachziegel', 'Lattung', 'Konterlattung', 'Unterspannbahn', '24 cm Mineralwolle zw. Sparren', 'Dampfbremse', '1,25 cm Gipskarton']);
    expect(de).toHaveLength(1);
    expect(de[0]!.element).toBe('roof');
    expect(de[0]!.layers.map((l) => [l.material, l.thicknessCm, l.counted])).toEqual([
      ['enduit-platre', 1.25, true],
      ['film', null, false],
      ['laine-minerale', 24, true],
      ['film', null, false],
      ['bois', null, false],
      ['bois', null, false],
      ['bardage', null, false],
    ]);
    const fr = read(['Composition toiture :', 'Tuiles', 'Lattes', 'Pare-vapeur', '24cm Laine minérale entre chevrons', '1,25cm Plaque de plâtre']);
    expect(fr[0]!.element).toBe('roof');
    expect(fr[0]!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(fr[0]!.layers.map((l) => l.material)).toEqual(['enduit-platre', 'laine-minerale', 'film', 'bois', 'bardage']);
    for (const membrane of ['Écran sous-toiture', 'Pare-pluie', 'Feutre', 'Unterdeckbahn']) {
      const [c] = read(['Composition toiture :', 'Tuiles', 'Lattes', membrane, '24cm Laine minérale entre chevrons', 'Pare-vapeur', '1,25cm Plaque de plâtre']);
      expect(c!.element, membrane).toBe('roof');
      expect(c!.layers.some((l) => l.material === 'laine-minerale' && l.thicknessCm === 24), membrane).toBe(true);
      expect(c!.layers[0]!.material, membrane).toBe('enduit-platre');
    }
  });

  it('toiture écrite du haut avec une lame d’air en tête : retournée, seule la lame (et l’extérieur) hors calcul', () => {
    const [c] = read(['Composition toiture :', 'Lame d’air', '24cm Laine minérale entre chevrons', '1,25cm Plaque de plâtre']);
    expect(c!.layers.map((l) => [l.material, l.counted])).toEqual([['enduit-platre', true], ['laine-minerale', true], ['lame-air', false]]);
  });

  it('une ligne hors vocabulaire au milieu d’un bloc devient une couche « inconnu » avec une question, pas une fin de bloc', () => {
    const [c] = read(['Composition toiture :', 'Tuiles', 'Lattes', 'Sarking Xylotherm', '24cm Laine minérale entre chevrons', '1,25cm Plaque de plâtre']);
    expect(c!.element).toBe('roof');
    const odd = c!.layers.find((l) => l.raw === 'Sarking Xylotherm')!;
    expect(odd.material).toBe('inconnu');
    expect(odd.doubt).toMatch(/non reconnu/);
    expect(c!.layers.some((l) => l.material === 'laine-minerale')).toBe(true);
    // Un renvoi (« Voir détail ») arrête le bloc ; une ligne inconnue sans couche reconnue après elle n'y entre pas.
    const [d] = read(['Composition mur :', '24cm Béton', '16cm Isolation type EPS', 'Voir détail', '2cm Enduit de façade']);
    expect(d!.layers.map((l) => l.raw)).toEqual(['24cm Béton', '16cm Isolation type EPS']);
    const blocks = compositionBlocks(lines(stack(['Composition mur :', '24cm Béton', '16cm Isolation type EPS', 'Teinte au choix'], 100, 100)), [section]);
    expect(blocks[0]!.layers).toHaveLength(2);
  });

  it('toiture plate lestée de gravier : toiture, gravier hors calcul côté extérieur', () => {
    const [c] = read(['Composition toiture :', '5cm Gravier', 'Étanchéité bicouche', '20cm Isolation PIR', 'Pare-vapeur', '22cm Dalle béton', '1cm Enduit plâtre']);
    expect(c!.element).toBe('roof');
    expect(c!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(c!.doubt ?? null).toBeNull();
    expect(c!.layers.map((l) => [l.material, l.counted])).toEqual([
      ['enduit-platre', true],
      ['beton-arme', true],
      ['film', false],
      ['pir', true],
      ['etancheite', true],
      ['empierrement', false],
    ]);
    const [d] = read(['Composition toiture plate :', '6cm Lestage gravier', '20cm PIR', 'Pare-vapeur', '20cm Dalle béton']);
    expect(d!.element).toBe('roof');
    expect(d!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(d!.layers[d!.layers.length - 1]!.counted).toBe(false);
    // En allemand, écrite de l'intérieur vers l'extérieur et sans titre de toiture : l'étanchéité contre le gravier suffit.
    const [e] = read(['Aufbau:', '1 cm Gipsputz', '22 cm Stahlbetondecke', 'Dampfsperre', '20 cm EPS', 'Abdichtung', '5 cm Kiesschüttung']);
    expect(e!.element).toBe('roof');
    expect(e!.layers.map((l) => l.material)).toEqual(['enduit-platre', 'beton-arme', 'film', 'eps', 'etancheite', 'empierrement']);
  });

  it('le gravier reste un marqueur de sol sous un plancher (finition de sol à l’autre bout, ou pas d’étanchéité contre lui)', () => {
    expect(read(['Composition dalle :', '2cm Carrelage', '7cm Chape', '25cm Radier', 'Étanchéité', '20cm Gravier'])[0]!.element).toBe('floor-on-ground');
    expect(read(['Composition plancher :', '20cm Dalle béton', '10cm XPS', 'Film PE', '15cm Gravier'])[0]!.element).toBe('floor-on-ground');
  });

  it('mur : un « Enduit » générique contre l’isolant extérieur est l’enduit de façade', () => {
    const [c] = read(['Composition mur :', '1,5cm Enduit plâtre', '24cm Blocs de béton', '20cm Isolation type EPS', '2cm Enduit']);
    expect(c!.layers.map((l) => l.material)).toEqual(['enduit-platre', 'bloc-beton', 'eps', 'enduit-facade']);
    const [d] = read(['Composition mur :', '2cm Enduit', '20cm EPS', '24cm Blocs de béton', '1,5cm Enduit plâtre']);
    expect(d!.layers.map((l) => l.material)).toEqual(['enduit-platre', 'bloc-beton', 'eps', 'enduit-facade']);
    const [g] = read(['Wandaufbau:', '1,5 cm Innenputz', '17,5 cm Kalksandstein', '16 cm Mineralwolle', '1 cm Putz']);
    expect(g!.layers[3]!.material).toBe('enduit-facade');
  });

  it('plancher isolé en sous-face : sur garage si une pièce non chauffée est voisine, sinon question', () => {
    const rows = ['Composition dalle :', '2cm Revêtement de sol', '6cm Chape', '20cm Dalle béton', '10cm Isolation type EPS en sous-face'];
    const near = read(rows, [mk('Garage', 100, 160)]);
    expect(near[0]!.element).toBe('floor-to-unheated');
    expect(near[0]!.confidence).toBe(0.8);
    expect(near[0]!.doubt ?? null).toBeNull();
    const alone = read(rows);
    expect(alone[0]!.element).toBe('floor-to-unheated');
    expect(alone[0]!.confidence).toBe(0.5);
    expect(alone[0]!.doubt).toMatch(/non chauffé.*extérieur/);
    const hint = read(rows, [], { rooms: [{ name: 'Garage', at: { x: 0, y: 0 }, page: 1, viewId: 'plan' }] });
    expect(hint[0]!.confidence).toBe(0.5); // la pièce n'est pas sur un plan d'étage connu
  });

  it('plancher intermédiaire : chape et isolant acoustique sur dalle, sans doute sur l’isolant', () => {
    const [c] = read(['Composition dalle :', '2cm Revêtement de sol', '6cm Chape', '3cm Isolation acoustique', '20cm Dalle béton', '1cm Enduit plâtre']);
    expect(c!.element).toBe('intermediate-floor');
    expect(c!.layers.every((l) => !l.doubt)).toBe(true);
  });

  it('isolant sans type et couche mixte dans un plancher sur sol : doutes par couche', () => {
    const [c] = read(['Composition dalle sur sol :', '2cm Revêtement', '7cm Chape + béton cellulaire', '12cm Isolation', '25cm Radier', '20cm Empierrement']);
    expect(c!.layers[1]!.doubt).toMatch(/mixte/i);
    expect(c!.layers[2]!.doubt).toMatch(/sans type/);
  });

  it('doutes en allemand', () => {
    const [c] = read(['Wandaufbau:', '24cm Beton', '9cm Dämmung', '2cm Außenputz'], [], { lang: 'de' });
    expect(c!.layers[0]!.doubt).toMatch(/Betonsteine/);
    expect(c!.layers[1]!.doubt).toMatch(/Dämmung ohne Typ/);
  });
});

describe('blocs', () => {
  it('lit les couches écrites sur la ligne du titre', () => {
    const [c] = read(['Composition mur : 24cm béton + 20cm EPS + 2cm enduit de façade']);
    expect(c!.element).toBe('external-wall');
    expect(c!.layers.map((l) => l.thicknessCm)).toEqual([24, 20, 2]);
  });

  it('épaisseur et libellé écrits en deux textes, et texte découpé par caractère', () => {
    const texts = [mk('Composition plancher :', 100, 100), mk('3cm', 100, 106.25), mk('Parquet', 112, 106.25), mk('7cm', 100, 112.5), mk('Chape', 112, 112.5), mk('25cm', 100, 118.75), mk('Dalle béton armé', 114, 118.75)];
    const blocks = compositionBlocks(lines(texts.flatMap((t) => split(t, 'char'))), [section]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.layers.map((l) => [l.label, l.thicknessCm])).toEqual([['Parquet', 3], ['Chape', 7], ['Dalle béton armé', 25]]);
  });

  it('s’arrête à la première ligne qui n’est pas une couche', () => {
    const blocks = compositionBlocks(lines(stack(['Composition mur :', '24cm Béton', '16cm Isolation type EPS', 'Garage', '2cm Enduit de façade'], 100, 100)), [section]);
    expect(blocks[0]!.layers).toHaveLength(2);
  });

  it('repli : une pile de couches sans titre forme un bloc, avec une question', () => {
    const [c] = read(['1,5cm Enduit plâtre', '24cm Blocs de béton', '16cm Isolation type EPS', '2cm Enduit de façade']);
    expect(c!.element).toBe('external-wall');
    expect(c!.confidence).toBeLessThan(0.65);
    expect(c!.doubt).toMatch(/sans titre/);
  });

  it('dédoublonne un bloc répété ; un plan qui omet l’enduit intérieur rejoint la version complète', () => {
    const plan = view('plan', 'floor-plan', box(0, 0, 1000, 400));
    const coupe = view('coupe', 'section', box(0, 500, 1000, 1000));
    const texts = [
      ...stack(['Composition mur :', '24cm Béton', '16cm Isolation type EPS', '2cm Enduit de façade'], 100, 100),
      ...stack(['Composition mur :', '24cm Béton', '16cm Isolation type EPS', '2cm Enduit de façade'], 500, 100),
      ...stack(['Composition mur :', '1,5cm Enduit plâtre', '24cm Béton', '16cm Isolation type EPS', '2cm Enduit de façade'], 100, 600),
      ...stack(['Composition mur garage :', '24cm Béton', '12cm Isolation type EPS'], 100, 800),
    ];
    const comps = readCompositions(lines(texts), [plan, coupe]);
    expect(comps.map((c) => c.element).sort()).toEqual(['external-wall', 'wall-to-unheated']);
    const wall = comps.find((c) => c.element === 'external-wall')!;
    expect(wall.layers).toHaveLength(4);
    expect(wall.occurrences).toHaveLength(3);
    expect(new Set(wall.occurrences.map((o) => o.viewId))).toEqual(new Set(['plan', 'coupe']));
    expect(wall.confidence).toBe(0.98);
    expect(comps.every((c) => /^comp-\d+-/.test(c.id))).toBe(true);
  });

  it('classifyComposition seul : un bloc titré toiture dont les couches disent plancher reste douteux', () => {
    const [b] = compositionBlocks(lines(stack(['Composition toiture :', '2cm Carrelage', '6cm Chape', '20cm Dalle béton', '1cm Enduit plâtre'], 0, 50)), []);
    const c = classifyComposition(b!);
    expect(c.confidence).toBeLessThan(0.65);
    expect(c.doubt).toMatch(/autre élément/);
  });
});
