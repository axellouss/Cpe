/**
 * Thème clair / sombre : l'application suit le système, et un thème imposé par la page hôte
 * (data-theme="dark" ou "light" sur la racine) l'emporte dans les deux sens.
 * Les valeurs sombres sont écrites deux fois (sous la requête du système et sous data-theme) :
 * ce test garantit que les deux copies restent identiques et complètes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(__dirname, '../../..', path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Corps du bloc qui suit `selector {`, accolades imbriquées comprises. */
function blockAfter(css: string, opener: string): string {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error(`bloc introuvable : ${opener}`);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(css.indexOf('{', at) + 1, i);
    }
  }
  throw new Error(`bloc non refermé : ${opener}`);
}

/** Déclarations « nom: valeur » d'un corps de bloc, sans les blocs imbriqués. */
function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.replace(/\{[\s\S]*\}/g, '').split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim().replace(/\s+/g, ' ');
  }
  return out;
}

describe('jetons de couleur de l’application', () => {
  const css = read('src/styles/tokens.css');
  const light = declarations(blockAfter(css, ':root {'));
  const systemDark = declarations(blockAfter(blockAfter(css, '@media (prefers-color-scheme: dark)'), ":root:not([data-theme='light'])"));
  const forcedDark = declarations(blockAfter(css, ":root[data-theme='dark']"));

  it('donne les mêmes valeurs sombres sous le réglage du système et sous le thème imposé', () => {
    expect(forcedDark).toEqual(systemDark);
    expect(Object.keys(forcedDark).length).toBeGreaterThan(20);
  });

  it('ne définit en sombre que des jetons déjà définis en clair', () => {
    for (const name of Object.keys(systemDark)) expect(light, name).toHaveProperty(name);
  });

  it('redéfinit en sombre chaque jeton de couleur du clair', () => {
    const colours = Object.entries(light).filter(([name, value]) => name.startsWith('--') && /#[0-9a-f]{3,8}\b|rgba?\(/i.test(value));
    expect(colours.length).toBeGreaterThan(20);
    for (const [name] of colours) expect(systemDark, name).toHaveProperty(name);
  });

  it('laisse le thème imposé gagner dans les deux sens', () => {
    expect(systemDark['color-scheme']).toBe('dark');
    expect(forcedDark['color-scheme']).toBe('dark');
    expect(declarations(blockAfter(css, ":root[data-theme='light']"))['color-scheme']).toBe('light');
    // Le sombre du système ne s'applique pas quand la page hôte impose le clair.
    expect(blockAfter(css, '@media (prefers-color-scheme: dark)')).not.toMatch(/(^|\})\s*:root\s*\{/);
  });
});
