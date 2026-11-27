/**
 * Textes du moteur (FR / DE) : contrôles de plausibilité (« finding.<code> »), noms des types par défaut
 * et libellés des lignes. Enregistrés dans src/i18n dès l'import du moteur.
 *
 * Règle d'écriture des contrôles : court, concret, et dire à l'expert QUOI FAIRE.
 * Aucune valeur réglementaire n'est citée ici : les bornes sont de simples seuils de plausibilité de l'outil.
 */
import type { Finding, Lang } from '../core/types';
import { registerMessages, t, type Dictionary } from '../i18n';

/** Tous les codes de contrôle que le moteur peut émettre. */
export const FINDING_CODES = [
  'model.noStorey',
  'storey.outlineInvalid',
  'scale.unconfirmed',
  'height.default',
  'clearHeight.default',
  'height.implausible',
  'clearHeight.aboveGross',
  'an.estimated',
  'an.grossLike',
  'an.low',
  'rooms.needReview',
  'outline.containsUnheated',
  'outline.unconditionedInside',
  'north.default',
  'orientation.borderline',
  'windows.none',
  'windows.exceedWall',
  'windows.share',
  'opening.onHeatedWall',
  'opening.orphan',
  'opening.inRoof',
  'opening.roofWindowsUnplaced',
  'opening.exceedsFacade',
  'opening.tallerThanWall',
  'neighbours.heatedExcluded',
  'top.default',
  'bottom.default',
  'aOverVe.implausible',
  'roof.estimated',
  'roof.monoDirection',
  'roof.ridgeAssumed',
  'roof.pitchImplausible',
  'attic.heightRule',
  'stepback.byAreas',
  'manual.heatedIgnored',
  'manual.deductMismatch',
  'abzug.dangling',
  'constructions.overLimit',
  'uvalues.missing',
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

export const ENGINE_MESSAGES: Dictionary = {
  fr: {
    // ── Contrôles ──
    'finding.model.noStorey': "Aucun étage chauffé. Tracez le contour d'au moins un étage.",
    'finding.storey.outlineInvalid':
      '{storey} : contour inutilisable (moins de 3 points, lignes qui se croisent ou surface sous 4 m² — ici {area} m²). Retracez le contour.',
    'finding.scale.unconfirmed': '{storey} : échelle non confirmée. Posez la règle sur une cote connue du plan.',
    'finding.height.default':
      "{storey} : hauteur d'étage brute par défaut ({height} m). Remplacez-la par la hauteur de dalle à dalle lue sur la coupe.",
    'finding.clearHeight.default':
      '{storey} : hauteur libre par défaut ({height} m). Indiquez la hauteur sous plafond réelle (elle sert à Vn).',
    'finding.height.implausible':
      "{storey} : hauteur d'étage brute de {height} m inhabituelle (attendu : 2,20 à 4,50 m). Vérifiez la valeur.",
    'finding.clearHeight.aboveGross':
      "{storey} : la hauteur libre ({clear} m) dépasse la hauteur d'étage brute ({gross} m). Corrigez l'une des deux.",
    'finding.an.estimated':
      '{storey} : surface nette inconnue, estimée à 80 % de la surface brute ({area} m²). Validez les pièces ou saisissez la surface nette chauffée.',
    'finding.an.grossLike':
      "An = {an} m², soit {ratio} % de la surface brute ({gross} m²) : cela ressemble à des dimensions brutes. An se mesure au nu intérieur des murs ; vérifiez les surfaces des pièces.",
    'finding.an.low':
      "An = {an} m², soit seulement {ratio} % de la surface brute ({gross} m²). Vérifiez qu'aucune pièce chauffée ne manque.",
    'finding.rooms.needReview': '{count} pièce(s) à trancher : comptée(s) dans An ou non ? Touchez-les sur le plan.',
    'finding.outline.containsUnheated':
      "{storey} : {rooms} — à l'intérieur du contour chauffé, alors qu'un tel local est en principe hors de l'enveloppe thermique. Retirez-le du contour ; s'il est réellement dans l'enveloppe isolée, laissez-le (il compte dans A et Ve, pas dans An).",
    'finding.outline.unconditionedInside':
      "{storey} : {rooms} — non compté(s) dans An mais dans le contour : correct pour un local non conditionné situé dans l'enveloppe thermique (chaufferie, local technique). S'il est hors de l'enveloppe, retirez-le du contour.",
    'finding.north.default':
      'Nord non confirmé : le haut du plan est supposé pointer vers l’azimut {angle}° (0 = nord). Tournez la boussole, les orientations des façades en dépendent.',
    'finding.orientation.borderline':
      "Façade de {length} m à l'azimut {azimuth}° : classée {orientation}, à moins de 5° de la limite avec {other}. Vérifiez le nord.",
    'finding.windows.none': 'Aucune fenêtre saisie. Touchez les façades pour y poser les fenêtres.',
    'finding.windows.exceedWall':
      '{wall} : les ouvertures ({openingArea} m²) dépassent la surface de la paroi ({wallArea} m²). Corrigez leurs dimensions ou la façade qui les porte.',
    'finding.windows.share':
      'Les fenêtres représentent {share} % des façades extérieures ({windowArea} m² sur {facadeArea} m²) : inhabituel (attendu : 5 à 45 %). Vérifiez le relevé des fenêtres.',
    'finding.opening.onHeatedWall':
      '{storey} : {count} ouverture(s) sur un mur mitoyen chauffé, ignorée(s). Déplacez-les ou changez le type du mur.',
    'finding.opening.orphan':
      '{storey} : {count} ouverture(s) sans mur valable (arête supprimée ou mur de hauteur nulle), ignorée(s). Reposez-les sur une façade.',
    'finding.opening.inRoof':
      '{storey} : {count} ouverture(s) sur un mur sans hauteur sous la toiture : comptée(s) comme fenêtres de toit et déduite(s) du pan de même orientation. Vérifiez.',
    'finding.opening.roofWindowsUnplaced':
      '{storey} : {count} fenêtre(s) de toit ({sizes} m) vue(s) dans le fichier ne figure(nt) pas dans le relevé, car aucune façade ne les porte. Ajoutez-les en lignes manuelles « à déduire », juste avant le pan de toiture concerné.',
    'finding.opening.exceedsFacade':
      '{storey}, façade {orientation} : les ouvertures totalisent {widths} m de large pour {length} m de façade. Corrigez leurs largeurs ou la façade qui les porte.',
    'finding.opening.tallerThanWall':
      '{storey} : {count} ouverture(s) plus haute(s) que le mur qui les porte. Corrigez leur hauteur ou la hauteur du mur (jambette, hauteur d’étage).',
    'finding.neighbours.heatedExcluded':
      '{length} m de murs mitoyens contre un voisin chauffé : hors enveloppe, aucune ligne dans le tableau.',
    'finding.top.default':
      'Fermeture haute non confirmée (hypothèse : {kind}). Confirmez la toiture — et, pour un toit incliné, sa pente, sa jambette et le sens du faîtage.',
    'finding.bottom.default':
      "Fermeture basse non confirmée (hypothèse : {kind}). Indiquez ce qu'il y a sous le premier étage chauffé.",
    'finding.aOverVe.implausible':
      "A/Ve = {value} 1/m est inhabituel (attendu : 0,25 à 1,30). Vérifiez l'échelle, les hauteurs et les murs mitoyens.",
    'finding.roof.estimated':
      "{storey} : contour non rectangulaire sous une toiture inclinée. Les pans (total de {area} m² conservé), la hauteur des murs sous toiture et le volume Ve ne sont qu'approchés : vérifiez-les et complétez par des lignes manuelles si nécessaire.",
    'finding.roof.monoDirection':
      "Toit monopente : sens de la pente supposé (pan orienté {orientation}). Indiquez vers où descend le pan dans la question sur la toiture ; la hauteur moyenne est appliquée aux deux murs d'égout.",
    'finding.roof.ridgeAssumed':
      'Sens du faîtage supposé : pans orientés {a} et {b}. Confirmez-le dans la question sur la toiture — murs sous toiture, pans et volume Ve en dépendent.',
    'finding.roof.pitchImplausible': 'Pente de toiture de {pitch}° inhabituelle (attendu : 3 à 75°). Vérifiez la valeur.',
    'finding.attic.heightRule':
      '{storey} sous rampants : seule la surface dont la hauteur libre dépasse 1,00 m compte dans An. Vérifiez la surface nette retenue.',
    'finding.stepback.byAreas':
      'Entre {lower} et {upper} : décalage de {area} m² calculé par simple différence de surfaces (plans non superposables). Vérifiez toitures-terrasses et surplombs.',
    'finding.manual.heatedIgnored':
      '{count} ligne(s) manuelle(s) contre un local chauffé : hors enveloppe, non reprise(s) dans le tableau.',
    'finding.manual.deductMismatch':
      "{count} ligne(s) manuelle(s) « à déduire » placée(s) devant une paroi d'une autre orientation ou d'un autre milieu : dans LuxEeB-Tool, une ligne marquée « x » se déduit de la ligne suivante. Réordonnez les lignes.",
    'finding.abzug.dangling':
      "{count} ligne(s) manuelle(s) « à déduire » sans paroi à la suite : rien n'est déduit. Placez-les juste avant la paroi concernée.",
    'finding.constructions.overLimit':
      "{count} types d'éléments opaques utilisés, LuxEeB-Tool n'offre que {limit} emplacements. Regroupez les parois de même valeur U.",
    'finding.uvalues.missing':
      "{count} type(s) d'élément sans valeur U : à définir dans LuxEeB-Tool (composition des couches, ou fenêtre des valeurs U typiques pour l'existant).",

    // ── Types par défaut ──
    'engine.construction.wall-outside': 'Mur extérieur',
    'engine.construction.wall-ground': 'Mur contre terre',
    'engine.construction.wall-unheated': 'Mur contre local non chauffé',
    'engine.construction.roof': 'Toiture',
    'engine.construction.ceiling-attic': 'Plancher haut sous grenier non chauffé',
    'engine.construction.floor-ground': 'Dalle sur terre-plein',
    'engine.construction.floor-unheated': 'Plancher sur cave non chauffée',
    'engine.construction.floor-outside': 'Plancher sur extérieur',
    'engine.construction.door': 'Porte opaque',
    'engine.windowType.default': 'Fenêtre',

    // ── Orientations (en toutes lettres : « O » serait Ouest en français mais Ost en allemand) ──
    'engine.orientation.N': 'Nord',
    'engine.orientation.NE': 'Nord-Est',
    'engine.orientation.E': 'Est',
    'engine.orientation.SE': 'Sud-Est',
    'engine.orientation.S': 'Sud',
    'engine.orientation.SW': 'Sud-Ouest',
    'engine.orientation.W': 'Ouest',
    'engine.orientation.NW': 'Nord-Ouest',
    'engine.orientation.H': 'horizontal',

    // ── Précision ajoutée au nom d'un type utilisé contre plusieurs milieux ──
    'engine.against.outside': 'contre extérieur',
    'engine.against.ground': 'contre terre',
    'engine.against.unheated': 'contre non chauffé',
    'engine.against.heated': 'contre chauffé',

    // ── Fermetures haute et basse ──
    'engine.top.flat-roof': 'toiture plate',
    'engine.top.pitched-roof': 'toiture inclinée, combles chauffés',
    'engine.top.attic-ceiling': 'plancher haut vers grenier non chauffé',
    'engine.bottom.slab-on-ground': 'dalle sur terre-plein',
    'engine.bottom.above-unheated': 'plancher sur cave ou local non chauffé',
    'engine.bottom.above-outside': 'plancher sur extérieur',

    // ── Libellés des lignes ──
    'engine.row.wall': '{element} – {orientation} ({storeys})',
    'engine.row.window': 'Fenêtre {width} × {height} m – {orientation} ({storeys})',
    'engine.row.door': 'Porte {width} × {height} m – {orientation} ({storeys})',
    'engine.row.roofFlat': 'Toiture plate ({storey})',
    'engine.row.roofSlope': 'Pan de toiture {orientation}, {pitch}° ({storey})',
    'engine.row.roofTerrace': 'Toiture-terrasse au-dessus de {storey}',
    'engine.row.ceiling': 'Plancher haut vers grenier non chauffé ({storey})',
    'engine.row.floor.slab-on-ground': 'Dalle sur terre-plein ({storey})',
    'engine.row.floor.above-unheated': 'Plancher sur cave ou local non chauffé ({storey})',
    'engine.row.floor.above-outside': 'Plancher sur extérieur ({storey})',
    'engine.row.floorOverhang': 'Plancher en surplomb de {storey} (sur extérieur)',
    'engine.row.floorOverUnheated': 'Plancher de {storey} au-dessus d’un local non chauffé ({rooms})',
    'engine.storeys.join': ' + ',
  },
  de: {
    // ── Kontrollen ──
    'finding.model.noStorey': 'Kein beheiztes Geschoss. Zeichnen Sie den Umriss mindestens eines Geschosses.',
    'finding.storey.outlineInvalid':
      '{storey}: Umriss unbrauchbar (weniger als 3 Punkte, sich kreuzende Linien oder Fläche unter 4 m² – hier {area} m²). Zeichnen Sie den Umriss neu.',
    'finding.scale.unconfirmed': '{storey}: Maßstab nicht bestätigt. Legen Sie das Lineal an ein bekanntes Maß im Plan.',
    'finding.height.default':
      '{storey}: Geschosshöhe ist ein Standardwert ({height} m). Ersetzen Sie ihn durch das Maß von Oberkante Decke bis Oberkante Decke aus dem Schnitt.',
    'finding.clearHeight.default':
      '{storey}: lichte Raumhöhe ist ein Standardwert ({height} m). Tragen Sie die tatsächliche lichte Höhe ein (sie bestimmt Vn).',
    'finding.height.implausible':
      '{storey}: Geschosshöhe von {height} m ist ungewöhnlich (erwartet: 2,20 bis 4,50 m). Prüfen Sie den Wert.',
    'finding.clearHeight.aboveGross':
      '{storey}: Die lichte Höhe ({clear} m) ist größer als die Geschosshöhe ({gross} m). Korrigieren Sie einen der beiden Werte.',
    'finding.an.estimated':
      '{storey}: Nettofläche unbekannt, auf 80 % der Bruttofläche geschätzt ({area} m²). Bestätigen Sie die Räume oder geben Sie die beheizte Nettofläche ein.',
    'finding.an.grossLike':
      'An = {an} m², das sind {ratio} % der Bruttofläche ({gross} m²): Das sieht nach Außenmaßen aus. An wird zwischen den Innenseiten der Wände gemessen; prüfen Sie die Raumflächen.',
    'finding.an.low':
      'An = {an} m², das sind nur {ratio} % der Bruttofläche ({gross} m²). Prüfen Sie, ob beheizte Räume fehlen.',
    'finding.rooms.needReview': '{count} Raum/Räume noch zu entscheiden: Teil von An oder nicht? Tippen Sie sie im Plan an.',
    'finding.outline.containsUnheated':
      '{storey}: {rooms} – innerhalb des beheizten Umrisses, obwohl ein solcher Raum in der Regel außerhalb der thermischen Hülle liegt. Aus dem Umriss entfernen; liegt er tatsächlich in der gedämmten Hülle, belassen (zählt zu A und Ve, nicht zu An).',
    'finding.outline.unconditionedInside':
      '{storey}: {rooms} – nicht in An gezählt, aber im Umriss: richtig für einen nicht konditionierten Raum innerhalb der thermischen Hülle (Heizraum, Technikraum). Liegt er außerhalb der Hülle, aus dem Umriss entfernen.',
    'finding.north.default':
      'Norden nicht bestätigt: Es wird angenommen, dass die Planoberseite nach Azimut {angle}° zeigt (0 = Norden). Drehen Sie den Kompass, davon hängen die Orientierungen der Fassaden ab.',
    'finding.orientation.borderline':
      'Fassade von {length} m mit Azimut {azimuth}°: als {orientation} eingestuft, weniger als 5° von der Grenze zu {other}. Prüfen Sie die Nordrichtung.',
    'finding.windows.none': 'Keine Fenster erfasst. Tippen Sie die Fassaden an, um Fenster zu setzen.',
    'finding.windows.exceedWall':
      '{wall}: Die Öffnungen ({openingArea} m²) sind größer als die Bauteilfläche ({wallArea} m²). Korrigieren Sie ihre Maße oder die Fassade, der sie zugeordnet sind.',
    'finding.windows.share':
      'Die Fenster machen {share} % der Außenfassaden aus ({windowArea} m² von {facadeArea} m²): ungewöhnlich (erwartet: 5 bis 45 %). Prüfen Sie die Fensterliste.',
    'finding.opening.onHeatedWall':
      '{storey}: {count} Öffnung(en) in einer Wand zum beheizten Nachbarn, nicht berücksichtigt. Verschieben Sie sie oder ändern Sie die Wandart.',
    'finding.opening.orphan':
      '{storey}: {count} Öffnung(en) ohne gültige Wand (Kante gelöscht oder Wandhöhe null), nicht berücksichtigt. Setzen Sie sie erneut auf eine Fassade.',
    'finding.opening.inRoof':
      '{storey}: {count} Öffnung(en) an einer Wand ohne Höhe unter dem Dach: als Dachfenster gezählt und von der Dachfläche gleicher Orientierung abgezogen. Bitte prüfen.',
    'finding.opening.roofWindowsUnplaced':
      '{storey}: {count} Dachfenster ({sizes} m) aus der Datei fehlen im Aufmaß, weil keine Fassade sie trägt. Ergänzen Sie sie als manuelle Abzugszeilen direkt vor der betreffenden Dachfläche.',
    'finding.opening.exceedsFacade':
      '{storey}, Fassade {orientation}: Die Öffnungen sind zusammen {widths} m breit bei {length} m Fassade. Korrigieren Sie die Breiten oder die Fassade, an der sie sitzen.',
    'finding.opening.tallerThanWall':
      '{storey}: {count} Öffnung(en) höher als die Wand, in der sie sitzen. Korrigieren Sie ihre Höhe oder die Wandhöhe (Kniestock, Geschosshöhe).',
    'finding.neighbours.heatedExcluded':
      '{length} m Wände zu beheizten Nachbarn: nicht Teil der Hülle, keine Zeile in der Tabelle.',
    'finding.top.default':
      'Oberer Abschluss nicht bestätigt (Annahme: {kind}). Bestätigen Sie das Dach – beim geneigten Dach auch Neigung, Kniestock und Firstrichtung.',
    'finding.bottom.default':
      'Unterer Abschluss nicht bestätigt (Annahme: {kind}). Geben Sie an, was unter dem untersten beheizten Geschoss liegt.',
    'finding.aOverVe.implausible':
      'A/Ve = {value} 1/m ist ungewöhnlich (erwartet: 0,25 bis 1,30). Prüfen Sie Maßstab, Höhen und Wände zu Nachbarn.',
    'finding.roof.estimated':
      '{storey}: Umriss nicht rechteckig unter einem geneigten Dach. Dachflächen (Summe von {area} m² bleibt erhalten), Wandhöhen unter dem Dach und das Volumen Ve sind nur Näherungen: prüfen und bei Bedarf mit manuellen Zeilen ergänzen.',
    'finding.roof.monoDirection':
      'Pultdach: Gefällerichtung angenommen (Dachfläche nach {orientation}). Geben Sie in der Frage zum Dach an, wohin die Dachfläche fällt; für beide Traufwände wird die mittlere Höhe angesetzt.',
    'finding.roof.ridgeAssumed':
      'Firstrichtung angenommen: Dachflächen nach {a} und {b}. Bestätigen Sie sie in der Frage zum Dach – Wände unter dem Dach, Dachflächen und Volumen Ve hängen davon ab.',
    'finding.roof.pitchImplausible': 'Dachneigung von {pitch}° ist ungewöhnlich (erwartet: 3 bis 75°). Prüfen Sie den Wert.',
    'finding.attic.heightRule':
      '{storey} unter Dachschrägen: Nur die Fläche mit einer lichten Höhe über 1,00 m zählt zu An. Prüfen Sie die angesetzte Nettofläche.',
    'finding.stepback.byAreas':
      'Zwischen {lower} und {upper}: Versatz von {area} m² nur aus der Flächendifferenz berechnet (Pläne nicht deckungsgleich). Prüfen Sie Dachterrassen und Auskragungen.',
    'finding.manual.heatedIgnored':
      '{count} manuelle Zeile(n) gegen beheizte Räume: nicht Teil der Hülle, nicht in die Tabelle übernommen.',
    'finding.manual.deductMismatch':
      '{count} manuelle Abzugszeile(n) vor einem Bauteil anderer Orientierung oder anderer Umgebung: In LuxEeB-Tool wird eine mit „x“ markierte Zeile von der folgenden Zeile abgezogen. Ordnen Sie die Zeilen neu.',
    'finding.abzug.dangling':
      '{count} manuelle Abzugszeile(n) ohne nachfolgendes Bauteil: Es wird nichts abgezogen. Setzen Sie sie direkt vor das betreffende Bauteil.',
    'finding.constructions.overLimit':
      '{count} opake Bauteiltypen verwendet, LuxEeB-Tool bietet nur {limit} Plätze. Fassen Sie Bauteile mit gleichem U-Wert zusammen.',
    'finding.uvalues.missing':
      '{count} Bauteiltyp(en) ohne U-Wert: in LuxEeB-Tool festlegen (Schichtaufbau oder Fenster der typischen U-Werte für Bestandsgebäude).',

    // ── Standardtypen ──
    'engine.construction.wall-outside': 'Außenwand',
    'engine.construction.wall-ground': 'Wand gegen Erdreich',
    'engine.construction.wall-unheated': 'Wand gegen unbeheizten Raum',
    'engine.construction.roof': 'Dach',
    'engine.construction.ceiling-attic': 'Oberste Geschossdecke (unbeheizter Dachboden)',
    'engine.construction.floor-ground': 'Bodenplatte auf Erdreich',
    'engine.construction.floor-unheated': 'Kellerdecke (unbeheizter Keller)',
    'engine.construction.floor-outside': 'Boden gegen Außenluft',
    'engine.construction.door': 'Tür (opak)',
    'engine.windowType.default': 'Fenster',

    // ── Orientierungen ──
    'engine.orientation.N': 'Nord',
    'engine.orientation.NE': 'Nordost',
    'engine.orientation.E': 'Ost',
    'engine.orientation.SE': 'Südost',
    'engine.orientation.S': 'Süd',
    'engine.orientation.SW': 'Südwest',
    'engine.orientation.W': 'West',
    'engine.orientation.NW': 'Nordwest',
    'engine.orientation.H': 'horizontal',

    'engine.against.outside': 'gegen Außenluft',
    'engine.against.ground': 'gegen Erdreich',
    'engine.against.unheated': 'gegen unbeheizt',
    'engine.against.heated': 'gegen beheizt',

    // ── Oberer und unterer Abschluss ──
    'engine.top.flat-roof': 'Flachdach',
    'engine.top.pitched-roof': 'Steildach, beheiztes Dachgeschoss',
    'engine.top.attic-ceiling': 'oberste Geschossdecke zum unbeheizten Dachboden',
    'engine.bottom.slab-on-ground': 'Bodenplatte auf Erdreich',
    'engine.bottom.above-unheated': 'Decke über unbeheiztem Keller oder Raum',
    'engine.bottom.above-outside': 'Boden gegen Außenluft',

    // ── Zeilenbezeichnungen ──
    'engine.row.wall': '{element} – {orientation} ({storeys})',
    'engine.row.window': 'Fenster {width} × {height} m – {orientation} ({storeys})',
    'engine.row.door': 'Tür {width} × {height} m – {orientation} ({storeys})',
    'engine.row.roofFlat': 'Flachdach ({storey})',
    'engine.row.roofSlope': 'Dachfläche {orientation}, {pitch}° ({storey})',
    'engine.row.roofTerrace': 'Flachdach / Terrasse über {storey}',
    'engine.row.ceiling': 'Oberste Geschossdecke zum unbeheizten Dachboden ({storey})',
    'engine.row.floor.slab-on-ground': 'Bodenplatte auf Erdreich ({storey})',
    'engine.row.floor.above-unheated': 'Decke über unbeheiztem Keller oder Raum ({storey})',
    'engine.row.floor.above-outside': 'Boden gegen Außenluft ({storey})',
    'engine.row.floorOverhang': 'Auskragender Boden von {storey} (gegen Außenluft)',
    'engine.row.floorOverUnheated': 'Boden von {storey} über einem unbeheizten Raum ({rooms})',
    'engine.storeys.join': ' + ',
  },
};

registerMessages(ENGINE_MESSAGES);

/** Texte d'un contrôle dans la langue voulue (les variables de `params` sont déjà mises en forme : virgule décimale). */
export function findingText(finding: Finding, lang: Lang): string {
  return t(lang, `finding.${finding.code}`, finding.params);
}
