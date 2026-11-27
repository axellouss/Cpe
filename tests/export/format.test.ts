import { describe, expect, it } from 'vitest';
import type { OrientationOrHorizontal } from '../../src/core/types';
import { luxeebNumber, luxeebOrientation, orientationLabel, excelSafeText, provenanceLabel, provenanceTag } from '../../src/export';
import { cleanText, compactNumber, escapeHtml, luxeebUValue, termLabel, weakestProvenance } from '../../src/export/format';

describe('luxeebNumber', () => {
  it.each([
    [12.5, '12,50'],
    [0, '0,00'],
    [186, '186,00'],
    [1234.5, '1234,50'],
    [-3.456, '-3,46'],
    [0.004, '0,00'],
    [-0.004, '0,00'],
    [1e-9, '0,00'],
  ])('%s → %s', (value, expected) => {
    expect(luxeebNumber(value)).toBe(expected);
  });

  it('arrondit le demi vers l’extérieur, sans le piège binaire de toFixed', () => {
    expect((1.005).toFixed(2)).toBe('1.00'); // le piège que l'on évite
    expect(luxeebNumber(1.005)).toBe('1,01');
    expect(luxeebNumber(2.675)).toBe('2,68');
    expect(luxeebNumber(0.125)).toBe('0,13');
    expect(luxeebNumber(-0.125)).toBe('-0,13');
    expect(luxeebNumber(1234.565)).toBe('1234,57');
    expect(luxeebNumber(24.755)).toBe('24,76');
  });

  it('respecte le nombre de décimales demandé', () => {
    expect(luxeebNumber(2.5, 0)).toBe('3');
    expect(luxeebNumber(0.2064, 3)).toBe('0,206');
    expect(luxeebNumber(1978, 0)).toBe('1978');
    expect(luxeebNumber(1.5, 1)).toBe('1,5');
    // décimales absurdes : on retombe sur 2
    expect(luxeebNumber(1.5, 2.5)).toBe('1,50');
    expect(luxeebNumber(1.5, -3)).toBe('2');
  });

  it('rend une chaîne vide pour une valeur qui n’est pas un nombre fini', () => {
    expect(luxeebNumber(Number.NaN)).toBe('');
    expect(luxeebNumber(Number.POSITIVE_INFINITY)).toBe('');
    expect(luxeebNumber(undefined as unknown as number)).toBe('');
    expect(luxeebNumber('12' as unknown as number)).toBe('');
  });

  it('ne met jamais de point, d’espace ni de séparateur de milliers', () => {
    for (const v of [0.1, 1, 12.345, 999.999, 1000, 123456.789, -42.42]) {
      expect(luxeebNumber(v)).toMatch(/^-?\d+,\d{2}$/);
    }
  });
});

describe('luxeebUValue et compactNumber', () => {
  it('garde une troisième décimale seulement si elle existe', () => {
    expect(luxeebUValue(0.35)).toBe('0,35');
    expect(luxeebUValue(0.206)).toBe('0,206');
    expect(luxeebUValue(1.3)).toBe('1,30');
    expect(luxeebUValue(Number.NaN)).toBe('');
  });

  it('écrit les échelles avec virgule et chiffres significatifs', () => {
    expect(compactNumber(0.001)).toBe('0,001');
    expect(compactNumber(0.0352778, 6)).toBe('0,0352778');
    expect(compactNumber(45)).toBe('45');
    expect(compactNumber(Number.NaN)).toBe('');
  });
});

describe('orientations', () => {
  it('donne les libellés allemands de la liste « Orientierung »', () => {
    const expected: Record<OrientationOrHorizontal, string> = {
      N: 'Nord',
      NE: 'Nordost',
      E: 'Ost',
      SE: 'Südost',
      S: 'Süd',
      SW: 'Südwest',
      W: 'West',
      NW: 'Nordwest',
      H: 'Horizontal',
    };
    for (const [o, label] of Object.entries(expected)) {
      expect(luxeebOrientation(o as OrientationOrHorizontal)).toBe(label);
    }
  });

  it('rend une chaîne vide pour une orientation inconnue plutôt que « undefined »', () => {
    expect(luxeebOrientation('X' as unknown as OrientationOrHorizontal)).toBe('');
  });

  it('lève l’ambiguïté O = Ouest / Ost avec le nom complet et l’azimut', () => {
    expect(orientationLabel('E', 'fr')).toBe('Est (90°)');
    expect(orientationLabel('E', 'de')).toBe('Ost (90°)');
    expect(orientationLabel('W', 'fr')).toBe('Ouest (270°)');
    expect(orientationLabel('W', 'de')).toBe('West (270°)');
    expect(orientationLabel('N', 'fr')).toBe('Nord (0°)');
    expect(orientationLabel('SW', 'fr')).toBe('Sud-ouest (225°)');
    expect(orientationLabel('SW', 'de')).toBe('Südwest (225°)');
    expect(orientationLabel('NW', 'de')).toBe('Nordwest (315°)');
  });

  it('ne donne pas d’azimut à une surface horizontale', () => {
    expect(orientationLabel('H', 'fr')).toBe('Horizontal');
    expect(orientationLabel('H', 'de')).toBe('Horizontal');
  });
});

describe('textes sûrs', () => {
  it('ramène un texte sur une seule ligne', () => {
    expect(cleanText('  Séjour\t32,45 m²\r\n(RDC)  ')).toBe('Séjour 32,45 m² (RDC)');
    expect(cleanText('a\u0000b\u2028c')).toBe('a b c');
    expect(cleanText(undefined as unknown as string)).toBe('');
  });

  it('neutralise ce qu’Excel prendrait pour une formule', () => {
    expect(excelSafeText('=1+1')).toBe("'=1+1");
    expect(excelSafeText("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(excelSafeText('+33 4 00')).toBe("'+33 4 00");
    expect(excelSafeText('-1 Sous-sol')).toBe("'-1 Sous-sol");
    expect(excelSafeText('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(excelSafeText('\t=A1')).toBe("'=A1");
    expect(excelSafeText('＝A1')).toBe("'＝A1");
    // Un guillemet en tête ferait avaler tabulations et sauts de ligne par Excel au collage : il est écarté.
    expect(excelSafeText('"><script>alert(1)</script>')).toBe('><script>alert(1)</script>');
    expect(excelSafeText('"=1+1')).toBe("'=1+1");
    expect(excelSafeText('Chambre "parents"')).toBe('Chambre "parents"');
  });

  it('laisse les textes ordinaires intacts', () => {
    expect(excelSafeText('Rez-de-chaussée')).toBe('Rez-de-chaussée');
    expect(excelSafeText('Zone 1 = séjour')).toBe('Zone 1 = séjour');
    expect(excelSafeText('')).toBe('');
  });

  it('échappe les cinq caractères dangereux en HTML', () => {
    expect(escapeHtml(`<a href="x" title='y'>Tom & Jerry</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;');
    expect(escapeHtml('rien à faire')).toBe('rien à faire');
    expect(escapeHtml(null as unknown as string)).toBe('');
  });
});

describe('libellés', () => {
  it('place la traduction après le terme allemand, et l’omet quand elle est vide', () => {
    expect(termLabel('fr', 'Anzahl', 'export.tr.count')).toBe('Anzahl — nombre');
    expect(termLabel('de', 'Anzahl', 'export.tr.count')).toBe('Anzahl');
    expect(termLabel('fr', 'Breite', 'export.tr.width', 'm')).toBe('Breite [m] — largeur');
    expect(termLabel('fr', 'Anzahl', 'export.tr.cle-inexistante')).toBe('Anzahl');
  });

  it('nomme chaque provenance dans les deux langues', () => {
    expect(provenanceLabel('default', 'fr')).toBe('valeur par défaut — à confirmer');
    expect(provenanceLabel('default', 'de')).toBe('Standardwert — zu bestätigen');
    expect(provenanceLabel('estimate', 'fr')).toBe('estimation — à remplacer');
    expect(provenanceTag('plan', 'fr')).toBe('plan');
    expect(provenanceTag('user', 'de')).toBe('Experte');
    expect(provenanceTag(null, 'fr')).toBe('à saisir');
    expect(provenanceLabel(null, 'de')).toBe('keine Angabe — von Ihnen einzutragen');
  });

  it('retient la provenance la plus faible', () => {
    expect(weakestProvenance(['user', 'plan', 'calc'])).toBe('plan');
    expect(weakestProvenance(['user', 'default', 'estimate'])).toBe('estimate');
    expect(weakestProvenance(['calc', undefined, null, 'user'])).toBe('calc');
    expect(weakestProvenance([])).toBe('calc');
    expect(weakestProvenance(['user'])).toBe('user');
  });
});
