// Réécrit les octets de contrôle bruts d'un fichier JavaScript en séquences \xNN, sans en changer le sens,
// puis le PROUVE : les deux textes sont analysés (oxc, l'analyseur du bundler) et leurs arbres comparés,
// valeurs « cuites » des chaînes comprises.
//
//   node tools/page-essai/echapper_controles.cjs <fichier.js|.mjs> [...]
//
// Pourquoi : l'hébergement de la page d'essai refuse un fichier texte qui contient un octet ESC brut ;
// le worker de pdf.js et le lecteur DWG en portent dans des chaînes (tables de décodage, sentinelle DXF binaire).
const fs = require('fs');
// L'analyseur est celui du bundler du projet : lancer ce script depuis la racine du dépôt.
const { parseSync } = require('module').createRequire(require('path').join(process.cwd(), 'package.json'))('rolldown/experimental');

const isControl = (code) => (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 0x7f;

function escapeControls(src) {
  let out = '';
  let changed = 0;
  for (let i = 0; i < src.length; i += 1) {
    const code = src.charCodeAt(i);
    if (!isControl(code)) {
      out += src[i];
      continue;
    }
    // Barres obliques inverses qui précèdent, déjà recopiées dans `out`.
    let slashes = 0;
    while (slashes < out.length && out[out.length - 1 - slashes] === '\\') slashes += 1;
    // Nombre impair : « \<contrôle> » est déjà un échappement (du caractère lui-même) : on le remplace en entier.
    if (slashes % 2 === 1) out = out.slice(0, -1);
    out += '\\x' + code.toString(16).padStart(2, '0');
    changed += 1;
  }
  return { out, changed };
}

const SKIP = new Set(['start', 'end', 'raw', 'range', 'loc']);

/** Forme comparable d'un arbre : sans positions ni texte brut ; les motifs d'expressions régulières normalisés. */
function canonical(node, tagged) {
  if (Array.isArray(node)) return node.map((n) => canonical(n, tagged));
  if (node === null || typeof node !== 'object') return typeof node === 'bigint' ? `${node}n` : node;
  const out = {};
  const isTagged = node.type === 'TaggedTemplateExpression';
  for (const key of Object.keys(node)) {
    if (SKIP.has(key)) continue;
    const value = node[key];
    if (node.type === 'TemplateElement' && key === 'value') {
      // Gabarit ordinaire : seule la valeur cuite compte. Gabarit étiqueté : le texte brut compte aussi.
      out.value = tagged ? { cooked: value.cooked, raw: value.raw } : { cooked: value.cooked };
    } else if (key === 'regex' && value && typeof value === 'object') {
      out.regex = { pattern: escapeControls(String(value.pattern)).out, flags: value.flags };
    } else if (node.type === 'Literal' && key === 'value' && node.regex) {
      out.value = null; // l'objet RegExp lui-même n'est pas comparable ; son motif l'est (ci-dessus)
    } else {
      out[key] = canonical(value, isTagged && key === 'quasi' ? true : key === 'quasis' ? tagged : false);
    }
  }
  return out;
}

function parse(file, text) {
  const result = parseSync(file, text, { sourceType: 'module' });
  if (result.errors && result.errors.length) throw new Error('analyse impossible : ' + JSON.stringify(result.errors[0]).slice(0, 300));
  return result.program;
}

let failed = false;
for (const file of process.argv.slice(2)) {
  const name = file.split('/').pop();
  const src = fs.readFileSync(file, 'utf8');
  const { out, changed } = escapeControls(src);
  if (changed === 0) {
    console.log(name, ': aucun octet de contrôle');
    continue;
  }
  const before = JSON.stringify(canonical(parse(file, src), false));
  const after = JSON.stringify(canonical(parse(file, out), false));
  const left = [...out].filter((ch) => isControl(ch.charCodeAt(0))).length;
  if (before !== after || left > 0) {
    failed = true;
    let at = 0;
    while (at < before.length && before[at] === after[at]) at += 1;
    console.log(name, ': ÉCHEC — arbres différents', { restants: left, avant: before.slice(Math.max(0, at - 120), at + 120), après: after.slice(Math.max(0, at - 120), at + 120) });
    continue;
  }
  fs.writeFileSync(file, out, 'utf8');
  console.log(name, ':', changed, 'octets réécrits ; arbres identiques (', before.length, 'caractères comparés )');
}
process.exit(failed ? 1 : 0);
