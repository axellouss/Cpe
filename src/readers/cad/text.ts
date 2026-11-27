/**
 * Décodage des textes AutoCAD : codes « %% » des TEXT, codes de mise en forme des MTEXT.
 * Fonctions pures.
 */

/** Codes communs aux TEXT et MTEXT : %%u, %%d, %%nnn, \U+XXXX. */
function decodeCommon(raw: string): string {
  return raw
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\M\+\d[0-9A-Fa-f]{4}/g, '')
    .replace(/%%(\d{3})/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, '⌀')
    .replace(/%%%/g, '%');
}

/** Texte d'une entité TEXT / ATTRIB, sans les codes de soulignement et avec les caractères spéciaux résolus. */
export function decodeText(raw: string): string {
  return decodeCommon(raw).replace(/\s+/g, ' ').trim();
}

/**
 * Texte brut d'un MTEXT : « {\fArial|b1;Séjour}\P32,45 m² » → « Séjour\n32,45 m² ».
 * Les lignes sont séparées par « \n ».
 */
export function decodeMText(raw: string): string {
  let out = '';
  const n = raw.length;
  let i = 0;
  while (i < n) {
    const ch = raw[i]!;
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === undefined) break;
      if (next === '\\' || next === '{' || next === '}') {
        out += next;
        i += 2;
      } else if (next === 'P' || next === 'N' || next === 'X') {
        out += '\n';
        i += 2;
      } else if (next === '~') {
        out += ' ';
        i += 2;
      } else if (next === 'U' && raw[i + 2] === '+') {
        // Laissé à decodeCommon.
        out += '\\U+';
        i += 3;
      } else if (next === 'S') {
        // Empilement : « \S1^2; » → « 1/2 ».
        const end = raw.indexOf(';', i + 2);
        const body = end < 0 ? raw.slice(i + 2) : raw.slice(i + 2, end);
        out += body.replace(/[\^#]/g, '/').replace(/\\/g, '');
        i = end < 0 ? n : end + 1;
      } else if ('LlOoKk'.includes(next)) {
        i += 2;
      } else if ('AaCcFfHhQqTtWwp'.includes(next)) {
        // Code avec paramètre terminé par « ; ».
        const end = raw.indexOf(';', i + 2);
        i = end < 0 ? n : end + 1;
      } else {
        i += 2;
      }
    } else if (ch === '{' || ch === '}') {
      i += 1;
    } else if (ch === '\r') {
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return decodeCommon(out)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, idx, all) => line.length > 0 || (idx > 0 && idx < all.length - 1))
    .join('\n')
    .trim();
}
