/**
 * Reconnaître certaines remarques des lecteurs, pour que l'interface n'affiche pas une consigne déjà suivie.
 *
 * Les lecteurs DWG/DXF et PDF signalent un local non chauffé englobé par le contour (« à retirer du contour si hors
 * volume chauffé »). Or l'application propose ensuite elle-même le contour chauffé SANS ce local : la remarque,
 * laissée telle quelle, contredisait la ligne suivante de l'écran de lecture.
 *
 * Module sans dépendance lourde (uniquement les textes des lecteurs) : il peut être importé par l'interface sans
 * charger les bibliothèques de lecture.
 */
import { CAD_MESSAGES } from './cad/messages';
import { PDF_MESSAGES } from './pdf/messages';

const UNHEATED_KEYS = ['cad.note.outline.unheated', 'pdf.note.outline.unheated'] as const;
/** « Pas de flèche du nord trouvée » : l'écran de lecture le dit déjà lui-même, à sa place (ligne du nord). */
const NO_NORTH_KEYS = ['cad.warn.north.none'] as const;

function templates(keys: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const dictionary of [CAD_MESSAGES, PDF_MESSAGES]) {
    for (const texts of Object.values(dictionary)) {
      for (const key of keys) {
        const text = (texts as Record<string, string | undefined>)[key];
        if (!text) continue;
        // Un paramètre ({rooms}, {where}…) vaut n'importe quel texte, vide compris.
        const escaped = text.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '.*');
        out.push(new RegExp(`^${escaped}$`, 'i'));
      }
    }
  }
  return out;
}

let unheated: RegExp[] | null = null;
let noNorth: RegExp[] | null = null;

/** Vrai pour la remarque « le contour englobe un local probablement non chauffé », en français ou en allemand. */
export function isOutlineUnheatedNote(note: string): boolean {
  unheated ??= templates(UNHEATED_KEYS);
  return unheated.some((re) => re.test(note));
}

/** Vrai pour l'avertissement « pas de flèche du nord trouvée », en français ou en allemand. */
export function isNoNorthNote(note: string): boolean {
  noNorth ??= templates(NO_NORTH_KEYS);
  return noNorth.some((re) => re.test(note));
}
