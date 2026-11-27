/**
 * Documents lus : espace de noms des feuilles, proposition d'étages, construction du bâtiment.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyProject, createStorey } from '../../../src/engine';
import {
  allSheets,
  applyProposal,
  collectObjectUrls,
  combineDocuments,
  defaultStoreyName,
  fileNameOfSheetId,
  findSheet,
  includedSheets,
  moveProposalSheet,
  namespaceDocument,
  paperScale,
  proposedBottomKind,
  proposeStoreys,
  renameProposalSheet,
  scaleBadge,
  summarizeSheet,
  toggleProposalSheet,
  toLoadedDocument,
} from '../../../src/ui/shell/documents';
import '../../../src/ui/shell/messages';
import { setBottom, setNorth } from '../../../src/ui/shell/modelOps';
import { doc, houseDoc, rect, sheet } from './helpers';

describe('espace de noms des feuilles', () => {
  it('rend les identifiants uniques entre fichiers, de façon stable et sans double préfixe', () => {
    const a = toLoadedDocument(doc('rdc.pdf', [sheet('p1', 'RDC')], { kind: 'pdf' }));
    const b = toLoadedDocument(doc('etage.pdf', [sheet('p1', 'Étage')], { kind: 'pdf' }));
    expect(a.doc.sheets[0]!.id).toBe('rdc.pdf#p1');
    expect(b.doc.sheets[0]!.id).toBe('etage.pdf#p1');
    expect(namespaceDocument(a.doc).sheets[0]!.id).toBe('rdc.pdf#p1');
    expect(fileNameOfSheetId('rdc.pdf#p1')).toBe('rdc.pdf');
    expect(fileNameOfSheetId('plan #2.pdf#p1')).toBe('plan #2.pdf');
    expect(findSheet([a, b], 'etage.pdf#p1')?.name).toBe('Étage');
    expect(findSheet([a, b], 'absent#p1')).toBeNull();
    expect(findSheet([a, b], null)).toBeNull();
    expect(allSheets([a, b])).toHaveLength(2);
  });

  it('ne retient que les adresses d’objets à libérer', () => {
    const d = doc('x.pdf', [sheet('p1', 'A', { imageUrl: 'blob:1' }), sheet('p2', 'B', { imageUrl: 'data:image/png;base64,AAAA' }), sheet('p3', 'C', { imageUrl: 'blob:1' })]);
    expect(collectObjectUrls(d)).toEqual(['blob:1']);
  });

  it('réunit plusieurs fichiers : nord du premier qui en a un, étages non superposables', () => {
    const a = toLoadedDocument(doc('a.ifc', [sheet('ifc-0', 'RDC')], { kind: 'ifc', storeysAligned: true }));
    const b = toLoadedDocument(doc('b.pdf', [sheet('p1', 'Étage')], { kind: 'pdf', northAngle: { value: 90, from: 'estimate' } }));
    expect(combineDocuments([a]).storeysAligned).toBe(true);
    const both = combineDocuments([a, b]);
    expect(both.storeysAligned).toBe(false);
    expect(both.northAngle).toEqual({ value: 90, from: 'estimate' });
    expect(both.sheets.map((s) => s.id)).toEqual(['a.ifc#ifc-0', 'b.pdf#p1']);
  });
});

describe('proposition d’étages', () => {
  it('reprend le premier jet du moteur : ordre du bas vers le haut entre fichiers, sous-sol proposé non chauffé', () => {
    const docs = [
      toLoadedDocument(doc('etage.pdf', [sheet('p1', 'Plan 1er étage')], { kind: 'pdf' })),
      toLoadedDocument(doc('rdc.pdf', [sheet('p1', 'Rez-de-chaussée')], { kind: 'pdf' })),
      toLoadedDocument(doc('cave.pdf', [sheet('p1', 'Sous-sol')], { kind: 'pdf' })),
    ];
    const proposal = proposeStoreys(docs, createEmptyProject('fr'), 'fr');
    expect(proposal.mode).toBe('replace');
    expect(includedSheets(proposal).map((s) => [s.fileName, s.name])).toEqual([
      ['rdc.pdf', 'Rez-de-chaussée'],
      ['etage.pdf', '1er étage'],
    ]);
    const basement = proposal.sheets.find((s) => s.fileName === 'cave.pdf')!;
    expect(basement).toMatchObject({ role: 'basement', include: false, name: 'Sous-sol' });
    expect(proposedBottomKind(proposal)).toBe('above-unheated');

    // L'expert décide que le sous-sol est chauffé : il devient un étage, la dalle repose alors sur le sol.
    const heated = toggleProposalSheet(proposal, basement.sheetId, true);
    expect(proposedBottomKind(heated)).toBe('slab-on-ground');
  });

  it('propose les noms dans la langue de l’interface', () => {
    const docs = [toLoadedDocument(doc('haus.dxf', [sheet('cad-1', 'EG'), sheet('cad-2', '1.OG')]))];
    expect(includedSheets(proposeStoreys(docs, createEmptyProject('de'), 'de')).map((s) => s.name)).toEqual(['Erdgeschoss', '1. Obergeschoss']);
  });

  it('une feuille sans contour n’est pas cochée, sauf si rien n’a été trouvé nulle part', () => {
    const mixed = [toLoadedDocument(doc('plans.pdf', [sheet('p1', 'Rez-de-chaussée'), sheet('p2', 'Coupe A-A', { outline: null })], { kind: 'pdf' }))];
    const p1 = proposeStoreys(mixed, createEmptyProject('fr'), 'fr');
    expect(p1.sheets.map((s) => [s.sheetName, s.role, s.include])).toEqual([
      ['Rez-de-chaussée', 'storey', true],
      ['Coupe A-A', 'noOutline', false],
    ]);

    const scans = [toLoadedDocument(doc('scan.pdf', [sheet('p1', 'page 1', { outline: null, scale: null }), sheet('p2', 'page 2', { outline: null, scale: null })], { kind: 'pdf' }))];
    const p2 = proposeStoreys(scans, createEmptyProject('fr'), 'fr');
    expect(p2.sheets.map((s) => s.include)).toEqual([true, false]);
  });

  it('renomme, réordonne et décoche sans toucher au reste', () => {
    const docs = [toLoadedDocument(houseDoc())];
    let proposal = proposeStoreys(docs, createEmptyProject('fr'), 'fr');
    const [rdc, etage] = includedSheets(proposal) as [(typeof proposal.sheets)[number], (typeof proposal.sheets)[number]];
    proposal = renameProposalSheet(proposal, etage.sheetId, 'Combles');
    proposal = moveProposalSheet(proposal, rdc.sheetId, 1);
    expect(includedSheets(proposal).map((s) => s.name)).toEqual(['Combles', 'Rez-de-chaussée']);
    // Déjà en haut : sans effet.
    expect(moveProposalSheet(proposal, rdc.sheetId, 1)).toBe(proposal);
    proposal = toggleProposalSheet(proposal, etage.sheetId, false);
    expect(includedSheets(proposal).map((s) => s.name)).toEqual(['Rez-de-chaussée']);
  });

  it('construit le bâtiment : étages dans l’ordre, nord lu, plancher sur cave si un sous-sol est écarté', () => {
    const docs = [
      toLoadedDocument(houseDoc()),
      toLoadedDocument(doc('cave.dxf', [sheet('cad-1', 'Kellergeschoss')])),
    ];
    const base = createEmptyProject('fr');
    base.answers.yearBuilt = 1974;
    const project = applyProposal(proposeStoreys(docs, base, 'fr'), docs, base, 'fr');
    expect(project.model.storeys.map((s) => [s.name, s.sheetId])).toEqual([
      ['Rez-de-chaussée', 'maison.dxf#cad-1'],
      ['Étage', 'maison.dxf#cad-2'],
    ]);
    expect(new Set(project.model.storeys.map((s) => s.id)).size).toBe(2);
    expect(project.model.northAngle).toMatchObject({ value: 340, from: 'plan' });
    expect(project.model.bottom).toMatchObject({ kind: 'above-unheated', from: 'default' });
    expect(project.model.storeys[0]!.openings.length).toBeGreaterThan(0);
    // Les réponses déjà données restent.
    expect(project.answers.yearBuilt).toBe(1974);
    // Le projet de départ n'est pas modifié.
    expect(base.model.storeys).toHaveLength(0);
  });

  it('ce que l’expert a confirmé (nord, plancher bas) n’est pas écrasé par une nouvelle lecture', () => {
    const docs = [toLoadedDocument(houseDoc()), toLoadedDocument(doc('cave.dxf', [sheet('cad-1', 'Sous-sol')]))];
    const base = setNorth(setBottom(createEmptyProject('fr'), 'slab-on-ground'), 15);
    const project = applyProposal(proposeStoreys(docs, base, 'fr'), docs, base, 'fr');
    expect(project.model.northAngle).toEqual({ value: 15, from: 'user' });
    expect(project.model.bottom).toMatchObject({ kind: 'slab-on-ground', from: 'user' });
  });

  it('projet déjà tracé : rien n’est coché, les feuilles utilisées sont reconnues, une feuille cochée s’ajoute au-dessus', () => {
    const first = [toLoadedDocument(houseDoc())];
    const base = applyProposal(proposeStoreys(first, createEmptyProject('fr'), 'fr'), first, createEmptyProject('fr'), 'fr');

    const docs = [...first, toLoadedDocument(doc('combles.pdf', [sheet('p1', 'Combles', { outline: rect(900, 700) })], { kind: 'pdf' }))];
    const proposal = proposeStoreys(docs, base, 'fr');
    expect(proposal.mode).toBe('append');
    expect(includedSheets(proposal)).toHaveLength(0);
    expect(proposal.sheets.filter((s) => s.role === 'used').map((s) => s.usedBy)).toEqual(['Rez-de-chaussée', 'Étage']);
    // Une feuille déjà utilisée ne se coche pas.
    const used = proposal.sheets.find((s) => s.role === 'used')!;
    expect(toggleProposalSheet(proposal, used.sheetId, true).sheets.find((s) => s.sheetId === used.sheetId)?.include).toBe(false);

    const attic = proposal.sheets.find((s) => s.fileName === 'combles.pdf')!;
    const project = applyProposal(toggleProposalSheet(proposal, attic.sheetId, true), docs, base, 'fr');
    expect(project.model.storeys.map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage', 'Combles']);
    expect(project.model.storeys.slice(0, 2)).toEqual(base.model.storeys);

    // « Repartir de ces plans » : tout est reproposé.
    const replace = proposeStoreys(docs, base, 'fr', 'replace');
    expect(includedSheets(replace).map((s) => s.name)).toEqual(['Rez-de-chaussée', 'Étage', 'Combles']);
    expect(applyProposal(replace, docs, base, 'fr').model.storeys).toHaveLength(3);
  });

  it('deux étages du même nom restent distincts', () => {
    const docs = [toLoadedDocument(houseDoc())];
    let proposal = proposeStoreys(docs, createEmptyProject('fr'), 'fr');
    for (const s of includedSheets(proposal)) proposal = renameProposalSheet(proposal, s.sheetId, 'Niveau');
    const project = applyProposal(proposal, docs, createEmptyProject('fr'), 'fr');
    expect(project.model.storeys.map((s) => s.name)).toEqual(['Niveau', 'Niveau (2)']);
  });
});

describe('résumés affichés', () => {
  it('classe l’échelle : confirmée, à vérifier, inconnue', () => {
    expect(scaleBadge({ value: 0.01, from: 'plan' })).toBe('confirmed');
    expect(scaleBadge({ value: 0.01, from: 'user' })).toBe('confirmed');
    expect(scaleBadge({ value: 0.0353, from: 'estimate' })).toBe('toCheck');
    expect(scaleBadge({ value: 1, from: 'default' })).toBe('toCheck');
    expect(scaleBadge(null)).toBe('unknown');
    expect(scaleBadge({ value: 0, from: 'plan' })).toBe('unknown');
  });

  it('reconnaît une échelle papier courante sur un PDF seulement', () => {
    const point = 0.0254 / 72;
    expect(paperScale('pdf', 100 * point)).toBe(100);
    expect(paperScale('pdf', 50.4 * point)).toBe(50);
    // « Ajusté à la page » : 1:141 n'est pas une échelle courante, on ne l'arrondit pas.
    expect(paperScale('pdf', 141 * point)).toBeNull();
    expect(paperScale('dxf', 100 * point)).toBeNull();
    expect(paperScale('pdf', 0)).toBeNull();
  });

  it('résume une feuille : pièces, surfaces, ouvertures extérieures', () => {
    const s = houseDoc().sheets[0]!;
    expect(summarizeSheet(s)).toEqual({
      roomCount: 3,
      roomArea: 52.5,
      roomsToDecide: 1,
      windowCount: 1,
      doorCount: 1,
      hasOutline: true,
      leftOutside: [],
      keptInside: [],
      outlinePoints: 4,
      notes: ['Calque des murs : MUR.'],
    });
    expect(summarizeSheet(sheet('x', 'vide', { outline: null }))).toMatchObject({ roomCount: 0, hasOutline: false, outlinePoints: 0, notes: [] });
  });

  it('garage accolé : annonce le contour chauffé proposé, et tait la consigne du lecteur déjà suivie', () => {
    // Maison 10 × 8 m avec un garage de 3 × 6 m accolé à droite, dessinée en centimètres.
    const footprint = [
      { x: 0, y: 0 },
      { x: 1300, y: 0 },
      { x: 1300, y: 600 },
      { x: 1000, y: 600 },
      { x: 1000, y: 800 },
      { x: 0, y: 800 },
    ];
    // Le garage s'appuie sur le mur de la maison (face extérieure à x = 1000) : pas de mur à lui de ce côté.
    const garage = [
      { x: 1000, y: 20 },
      { x: 1280, y: 20 },
      { x: 1280, y: 580 },
      { x: 1000, y: 580 },
    ];
    const living = [
      { x: 30, y: 30 },
      { x: 980, y: 30 },
      { x: 980, y: 770 },
      { x: 30, y: 770 },
    ];
    const notes = (lang: 'fr' | 'de'): string[] => [
      'Calque des murs : MUR.',
      lang === 'fr'
        ? 'Le contour englobe « Garage » (probablement non chauffé) : à retirer du contour si hors volume chauffé.'
        : 'Der Umriss schließt « Garage » ein (vermutlich unbeheizt): aus dem Umriss entfernen, falls außerhalb des beheizten Volumens.',
    ];
    for (const lang of ['fr', 'de'] as const) {
      const s = sheet('g', 'Rez-de-chaussée', {
        outline: footprint,
        detected: {
          rooms: [
            { name: 'Séjour', statedArea: 70, polygon: living, heatedGuess: 'yes' },
            { name: 'Garage', statedArea: 14.5, polygon: garage, heatedGuess: 'no' },
          ],
          notes: notes(lang),
        },
      });
      const summary = summarizeSheet(s);
      expect(summary.leftOutside, lang).toEqual(['Garage']);
      // Le contour annoncé est celui qui sera proposé, pas l'emprise lue (6 points) : un rectangle, avec un point
      // de plus là où le mur passe de « contre le garage » à « extérieur ».
      expect(summary.outlinePoints, lang).toBe(5);
      expect(summary.notes, lang).toEqual(['Calque des murs : MUR.']);
    }
    // Sans proposition de retrait (pas d'échelle), la remarque du lecteur reste : elle est encore à suivre.
    const noScale = sheet('g2', 'Rez-de-chaussée', { outline: footprint, scale: null, detected: { rooms: [{ name: 'Garage', polygon: garage, heatedGuess: 'no' }], notes: notes('fr') } });
    expect(summarizeSheet(noScale).notes).toHaveLength(2);
  });

  it('nomme les étages par défaut selon leur rang, sans doublon', () => {
    expect(defaultStoreyName(0, 'fr')).toBe('Rez-de-chaussée');
    expect(defaultStoreyName(1, 'fr')).toBe('1er étage');
    expect(defaultStoreyName(3, 'fr')).toBe('3e étage');
    expect(defaultStoreyName(2, 'de')).toBe('2. Obergeschoss');
    expect(defaultStoreyName(0, 'fr', ['Rez-de-chaussée'])).toBe('Rez-de-chaussée (2)');
    const project = createEmptyProject('fr');
    expect(createStorey(null, defaultStoreyName(0, 'fr'), project.model).name).toBe('Rez-de-chaussée');
  });
});
