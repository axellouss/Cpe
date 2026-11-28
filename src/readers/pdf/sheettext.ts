/**
 * Tout ce que la planche ÉCRIT, lu en une fois sur toutes les pages : cartouche, tableau des surfaces, niveaux,
 * compositions de parois, nord, équipements et installations proposées, cotes de baies, encadrés d'éclairement et
 * pièces par vue. Fonction PURE : elle reçoit les pages extraites et les vues déjà découpées, ne touche ni à pdf.js
 * ni au DOM, et ne modifie rien de ce qu'elle reçoit.
 *
 * Les doutes (questions à poser) sont rassemblés dans `doubts`, dans la langue demandée ; le journal `log` sert au
 * diagnostic et n'est jamais montré tel quel.
 */
import type { ReadComposition, ReadEquipment, ReadGlazingBox, ReadLevels, ReadNorth, ReadOpeningPair, ReadSiteAreas, ReadSystems, ReadTitleBlock, ReadView } from '../../core/reading';
import type { Lang, Vec2 } from '../../core/types';
import { readCompositions } from '../../semantics/compositions';
import { equipmentMentions, proposeSystems } from '../../semantics/equipment';
import { glazingBoxes, roomsFromLines, type HeatedGuess, type RoomLine } from '../../semantics/labels';
import { grossHeightEstimate, readLevels } from '../../semantics/levels';
import { siteAreaTable } from '../../semantics/siteareas';
import { readNorthDetailed } from './north';
import type { RawPage } from './raw';
import { dimensionTokens, openingPairs, textLines, type TextLine } from './textlines';
import { readTitleBlock, type TitleBlockDetails } from './titleblock';

/** Pièce écrite dans une vue (nom + surface inscrite). */
export interface SheetRoomText {
  name: string;
  statedArea: number;
  at: Vec2;
  heatedGuess: HeatedGuess;
  /** Espace à l'air libre (terrasse, balcon, loggia). */
  exterior: boolean;
  /** Hors de l'enveloppe thermique par nature (garage, abri, terrasse). */
  outsideEnvelope: boolean;
  confidence: number;
  doubt: string | null;
}

export interface SheetTextDoubt {
  topic: 'title-block' | 'composition' | 'layer' | 'level' | 'height' | 'north' | 'systems' | 'room';
  text: string;
  /** Référence de l'objet concerné (id de composition, de vue…), quand il y en a une. */
  ref?: string;
}

export interface SheetTextRead {
  titleBlock: ReadTitleBlock | null;
  /** Ce que le cartouche dit en plus du contrat (champs, toutes les adresses avec leur intitulé). */
  titleBlockDetails: TitleBlockDetails | null;
  siteAreas: ReadSiteAreas | null;
  levels: ReadLevels | null;
  compositions: ReadComposition[];
  north: ReadNorth | null;
  equipment: ReadEquipment[];
  systems: ReadSystems | null;
  openingPairs: ReadOpeningPair[];
  glazing: ReadGlazingBox[];
  /** Pièces par vue : clé = ReadView.id, ou `p{page}` pour une pièce hors de toute vue connue. */
  rooms: Record<string, SheetRoomText[]>;
  /** Hauteur brute du volume chauffé, de deux façons (compositions, sommet − niveau fini bas). */
  grossHeight: { fromLayers: number | null; fromTop: number | null } | null;
  doubts: SheetTextDoubt[];
  log: string[];
}

function roomEntry(r: RoomLine): SheetRoomText {
  return { name: r.name, statedArea: r.statedArea, at: r.at, heatedGuess: r.heatedGuess, exterior: r.exterior, outsideEnvelope: r.outsideEnvelope, confidence: r.confidence, doubt: r.doubt };
}

/**
 * Lecture du texte de toutes les pages. `views` : vues découpées par l'analyse (une vue porte sa page) ; sans vue,
 * la lecture se fait quand même sur la page entière (pièces rangées sous `p{page}`, cartouche cherché partout).
 */
export function readSheetText(pages: readonly RawPage[], views: readonly ReadView[], opts: { lang: Lang }): SheetTextRead {
  const lang = opts.lang;
  const log: string[] = [];
  const doubts: SheetTextDoubt[] = [];
  const all: TextLine[] = [];
  const pairs: ReadOpeningPair[] = [];
  for (const page of pages) {
    const { tokens, lines } = textLines(page.texts, page.number);
    const sups = tokens.reduce((n, k) => n + (k.parts.length > 1 && k.sup ? 1 : 0), 0);
    log.push(`p${page.number} : ${page.texts.length} textes → ${tokens.length} jetons (${sups} avec exposant) → ${lines.length} lignes`);
    all.push(...lines);
    pairs.push(...openingPairs(dimensionTokens(tokens), lines, views, page.number));
  }

  // Cartouche : dans la vue « cartouche » de chaque page qui en a une, sinon sur toute la page ; le plus riche gagne.
  let titleBlock: ReadTitleBlock | null = null;
  let titleBlockDetails: TitleBlockDetails | null = null;
  let bestFields = 0;
  for (const page of pages) {
    const lines = all.filter((l) => l.page === page.number);
    const boxes = views.filter((v) => v.page === page.number && v.kind === 'title-block').map((v) => v.box);
    for (const box of boxes.length > 0 ? boxes : [null]) {
      const r = readTitleBlock(lines, box, { lang, page: page.number });
      const n = r.details.fields.filter((f) => f.values.length > 0).length;
      if (n > bestFields) {
        bestFields = n;
        titleBlock = r.titleBlock;
        titleBlockDetails = r.details;
      }
    }
  }
  if (titleBlockDetails) for (const d of titleBlockDetails.doubts) doubts.push({ topic: 'title-block', text: d });
  log.push(`cartouche : ${bestFields} champ(s) lu(s)`);

  // Pièces par vue et encadrés d'éclairement.
  const roomLines = roomsFromLines(all, views, lang);
  const rooms: Record<string, SheetRoomText[]> = {};
  for (const r of roomLines) {
    const key = r.viewId ?? `p${r.page}`;
    (rooms[key] ??= []).push(roomEntry(r));
    if (r.doubt) doubts.push({ topic: 'room', text: r.doubt, ref: key });
  }
  const glazing = glazingBoxes(all, views);
  log.push(`pièces : ${roomLines.length} ; encadrés d'éclairement : ${glazing.length} ; paires de baies : ${pairs.length}`);

  // Compositions (toutes pages, dédoublonnées).
  const compositions = readCompositions(all, views, { lang, rooms: roomLines });
  for (const c of compositions) {
    if (c.doubt) doubts.push({ topic: 'composition', text: c.doubt, ref: c.id });
    for (const l of c.layers) if (l.doubt) doubts.push({ topic: 'layer', text: l.doubt, ref: c.id });
  }
  log.push(`compositions : ${compositions.reduce((n, c) => n + c.occurrences.length, 0)} bloc(s) → ${compositions.length}`);

  // Niveaux et hauteur brute.
  const { levels, doubts: levelDoubts } = readLevels(all, views, lang);
  for (const d of levelDoubts) doubts.push({ topic: 'level', text: d.text });
  let grossHeight: SheetTextRead['grossHeight'] = null;
  if (levels && levels.floors.length > 0) {
    const g = grossHeightEstimate(levels, compositions, lang);
    grossHeight = { fromLayers: g.fromLayers, fromTop: g.fromTop };
    if (g.doubt) doubts.push({ topic: 'height', text: g.doubt });
  }
  if (levels) log.push(`niveaux : ${levels.marks.length} cote(s), ${levels.floors.length} niveau(x) fini(s), contrôles ${levels.checks.checked - levels.checks.failed}/${levels.checks.checked}`);

  // Tableau des surfaces.
  const siteAreas = siteAreaTable(all);

  // Nord : la page qui porte une vue « nord » d'abord, puis les autres.
  let north: ReadNorth | null = null;
  const order = [...pages].sort((a, b) => Number(views.some((v) => v.page === b.number && v.kind === 'north-arrow')) - Number(views.some((v) => v.page === a.number && v.kind === 'north-arrow')));
  for (const page of order) {
    const r = readNorthDetailed(page, { lines: all.filter((l) => l.page === page.number), lang });
    if (!r) continue;
    north = r.north;
    if (r.doubt) doubts.push({ topic: 'north', text: r.doubt });
    log.push(`nord : haut de la feuille à ${r.north.sheetUpAzimuth}° (marge ${r.north.marginDeg}°), page ${page.number}`);
    break;
  }

  // Équipements et installations proposées.
  const equipment = equipmentMentions(all, views);
  const systems = proposeSystems(equipment, views, lang);
  for (const r of [systems.heatGenerator, systems.hotWater, systems.ventilation, systems.photovoltaic, systems.solarThermal]) if (r?.doubt) doubts.push({ topic: 'systems', text: r.doubt });
  log.push(`équipements : ${equipment.map((e) => e.kind).join(', ') || 'aucun'}`);

  return { titleBlock, titleBlockDetails, siteAreas, levels, compositions, north, equipment, systems, openingPairs: pairs, glazing, rooms, grossHeight, doubts, log };
}
