/**
 * Blocs à coller dans LuxEeB-Tool : texte tabulé, une ligne par ligne de tableau, dans l'ORDRE des colonnes
 * de saisie de l'outil. Format : tabulation entre cellules, CRLF entre lignes (comme le presse-papiers d'Excel),
 * virgule décimale, 2 décimales, pas d'en-tête, pas de fin de ligne après la dernière ligne.
 *
 * ATTENTION : personne n'a encore vérifié qu'un collage multi-cellules passe dans le classeur protégé.
 * Ces blocs sont donc présentés à l'utilisateur comme « à essayer » ; la recopie ligne par ligne reste la voie sûre.
 */
import type { Construction, EnvelopeRow, VolumeRow, WindowType, ZoneRow } from '../core/types';
import { excelSafeText, luxeebNumber, luxeebOrientation } from './format';

/** Séparateur de lignes des blocs (celui du presse-papiers d'Excel sous Windows). */
export const PASTE_EOL = '\r\n';
const TAB = '\t';

function block(lines: readonly (readonly string[])[]): string {
  return lines.map((cells) => cells.join(TAB)).join(PASTE_EOL);
}

/**
 * « Flächeneingabe der Gebäudehülle », à partir de la colonne « Anzahl » :
 * Anzahl ⇥ Länge ⇥ Breite ⇥ Orientierung. Les lignes à déduire sont incluses à leur place : le « x » de la
 * colonne « Abzug » (séparée du bloc par deux colonnes calculées) se saisit à la main, voir `envelopeDeductLines`.
 */
export function envelopePasteBlock(rows: readonly EnvelopeRow[]): string {
  return block(
    rows.map((r) =>
      // Saisie par surface (ordre « expert ») : « Länge » vide, la surface dans « Breite [m] od. Fläche [m²] ».
      r.entry === 'area'
        ? [luxeebNumber(r.count), '', luxeebNumber(r.grossArea / Math.max(1, r.count)), luxeebOrientation(r.orientation)]
        : [luxeebNumber(r.count), luxeebNumber(r.length), luxeebNumber(r.width), luxeebOrientation(r.orientation)],
    ),
  );
}

/**
 * Couches d'un élément pour « Berechnung der U-Werte von Bauteilen », de l'intérieur vers l'extérieur :
 * Baustoff ⇥ λ ⇥ Dicke [cm], une ligne par couche (10 au plus dans l'outil). Une λ inconnue laisse la cellule vide.
 */
export function layersPasteBlock(construction: Pick<Construction, 'layers'>): string {
  return block(
    (construction.layers ?? []).map((l) => [excelSafeText(l.name), l.lambda ? luxeebNumber(l.lambda.value, 3) : '', l.thicknessUnknown ? '' : luxeebNumber(l.thicknessCm.value, 1)]),
  );
}

/**
 * Types de fenêtres pour « Berechnung der U-Werte von transparenten Bauteilen » : Bezeichnung ⇥ Breite ⇥ Höhe ⇥
 * Rahmenbreite ⇥ Fenstertyp ⇥ Scheibenzahl ⇥ U-Wert Glas ⇥ U-Wert Rahmen ⇥ Ψg ⇥ g-Wert. La colonne « Einbauart »
 * (liste) est laissée à l'expert. Une valeur inconnue laisse sa cellule vide.
 */
export function windowsPasteBlock(types: readonly WindowType[]): string {
  const n = (s: { value: number } | null | undefined, digits = 2): string => (s ? luxeebNumber(s.value, digits) : '');
  return block(
    types.map((w) => {
      const g = w.geometry;
      return [
        excelSafeText(w.name),
        g ? luxeebNumber(g.width) : '',
        g ? luxeebNumber(g.height) : '',
        n(g?.frameWidth, 3),
        g ? g.fensterTyp.value : '',
        g ? luxeebNumber(g.panes, 0) : '',
        n(w.ug),
        n(w.uf),
        n(w.psiG, 3),
        n(w.g),
      ];
    }),
  );
}

/** Numéros (à partir de 1) des lignes du bloc d'enveloppe qui doivent recevoir un « x » dans la colonne « Abzug ». */
export function envelopeDeductLines(rows: readonly EnvelopeRow[]): number[] {
  const lines: number[] = [];
  rows.forEach((r, i) => {
    if (r.deduct) lines.push(i + 1);
  });
  return lines;
}

/**
 * Lignes d'enveloppe réellement à saisir dans LuxEeB-Tool : une paroi vers un local chauffé ne perd rien et ne
 * doit pas y figurer. Elle est retirée avec les lignes « Abzug » qui s'y rapportaient (sinon leur « x » se
 * reporterait sur la paroi suivante). L'ordre des autres lignes est conservé.
 */
export function luxeebEnvelopeRows(rows: readonly EnvelopeRow[]): EnvelopeRow[] {
  const out: EnvelopeRow[] = [];
  let pending: EnvelopeRow[] = [];
  for (const row of rows) {
    if (row.deduct) {
      pending.push(row);
      continue;
    }
    if (row.boundary !== 'heated') out.push(...pending, row);
    pending = [];
  }
  // Lignes à déduire restées sans paroi : gardées (le guide les signale), sauf celles vers un local chauffé.
  out.push(...pending.filter((r) => r.boundary !== 'heated'));
  return out;
}

/**
 * « Energiebezugsflächen / Zonen » : Raumbezeichnung ⇥ Anzahl ⇥ Breite ⇥ Länge.
 * Comme dans l'exemple du manuel, la surface est portée par une seule cellule (1,00 × 1,00 × surface).
 */
export function zonesPasteBlock(rows: readonly ZoneRow[]): string {
  const one = luxeebNumber(1);
  return block(rows.map((r) => [excelSafeText(r.label), one, one, luxeebNumber(r.area)]));
}

/** « Gebäudevolumen Ve » : Bezeichnung ⇥ Anzahl ⇥ Breite ⇥ Länge ⇥ Höhe (surface portée par Länge). */
export function volumesPasteBlock(rows: readonly VolumeRow[]): string {
  const one = luxeebNumber(1);
  return block(rows.map((r) => [excelSafeText(r.label), one, one, luxeebNumber(r.area), luxeebNumber(r.height)]));
}
