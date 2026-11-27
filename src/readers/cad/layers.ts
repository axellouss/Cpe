/**
 * Classement des calques d'après leur NOM (FR / DE / EN / AIA). Fonctions pures.
 * Les noms de calques sont libres : ce classement n'est qu'un indice, le repli géométrique est dans walls.ts.
 */

export type LayerCategory =
  | 'hatch'
  | 'dim'
  | 'frame'
  | 'foundation'
  | 'roof'
  | 'stair'
  | 'axis'
  | 'furniture'
  | 'door'
  | 'window'
  | 'wall'
  | 'text'
  | 'symbol';

const B = '(?<![a-z])';
const E = '(?![a-z])';

// L'ORDRE COMPTE : « S-STEM-WALL » est une fondation avant d'être un mur, « MUR-HACHURE » une hachure.
const RULES: [LayerCategory, RegExp][] = (
  [
    ['hatch', 'hach\\w*|hatch\\w*|schraff\\w*|patt|poche|rempl\\w*|fuell\\w*|fill'],
    ['dim', 'cot|cote|cotes|cotation\\w*|dim|dims|dimension\\w*|bemass\\w*|bemas\\w*|masskette\\w*|masse|mass'],
    ['frame', 'cartouche|cadre|ttlb|title\\w*|plankopf|rahmen|border|blatt|sheet|viewport\\w*|view port|defpoints'],
    ['foundation', 'stem|found\\w*|fondation\\w*|footer\\w*|footing\\w*|fundament\\w*|semelle\\w*|slab|dalle'],
    ['roof', 'roof\\w*|toit\\w*|toiture|dach\\w*|truss|overhang|charpente|joist\\w*|beam\\w*|header'],
    ['stair', 'escal\\w*|stair\\w*|strs|trepp\\w*'],
    ['axis', 'axe|axes|axis|achs\\w*|grid|raster|trame'],
    [
      'furniture',
      'mobil\\w*|meubl\\w*|furn\\w*|moeb\\w*|mobel\\w*|sanit\\w*|equip\\w*|fixt\\w*|fixture\\w*|case|casework|appareil\\w*|einricht\\w*',
    ],
    ['door', 'porte|portes|door|doors|tuer|tueren|tur|ture|turen'],
    [
      'window',
      'fen|fenetre\\w*|fenster\\w*|window\\w*|wind|glaz\\w*|vitr\\w*|baie\\w*|chassis|menuis\\w*|opening\\w*|ouverture\\w*|oeffnung\\w*',
    ],
    [
      'wall',
      'mur|murs|wall|walls|wand|wande|waende|mauer\\w*|maconn\\w*|voile|voiles|paroi\\w*|cloison\\w*|trennwand\\w*|aussenwand\\w*|innenwand\\w*|rohbau|gros ?oeuvre|porteur\\w*',
    ],
    [
      'text',
      'textes?|txt|text\\w*|room\\w*|raum\\w*|piece\\w*|local|locaux|iden|area\\w*|surface\\w*|flaeche\\w*|flache\\w*|beschrift\\w*|label\\w*|nom|noms|note|notes|anno\\w*',
    ],
    ['symbol', 'symb\\w*|nord|north|legend\\w*'],
  ] as [LayerCategory, string][]
).map(([cat, body]) => [cat, new RegExp(`${B}(${body})${E}`)]);

/** Nom de calque normalisé : préfixes de xref retirés, sans accents ni casse, séparateurs → espaces. */
export function normalizeLayerName(name: string): string {
  let s = name.split('|').pop() ?? name; // xref attaché : « fichier|calque »
  s = s.replace(/^.*\$\d+\$/, ''); // xref lié : « fichier$0$calque »
  s = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase();
  return s.replace(/[_\-./]+/g, ' ').trim();
}

/** Catégorie d'un calque (ou d'un nom de bloc) d'après son nom ; null si rien de reconnu. */
export function classifyLayer(name: string): LayerCategory | null {
  const n = normalizeLayerName(name);
  for (const [cat, re] of RULES) if (re.test(n)) return cat;
  return null;
}
