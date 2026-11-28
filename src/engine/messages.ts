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
  'stepback.overhangUncertain',
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
    'finding.stepback.overhangUncertain':
      "{upper} dépasse de {area} m² au-dessus de {lower}, qui a un mur contre un local non chauffé : ce plancher donne peut-être sur ce local plutôt que sur l'extérieur. Vérifiez, et corrigez l'élément (plancher sur local non chauffé) si c'est le cas.",
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
    'engine.row.floorOverUnheatedPlain': 'Plancher de {storey} au-dessus d’un local non chauffé',
    // Ordre « expert » : noms courts comme l'expert les saisit (« AV 94*125 X2 »)
    'engine.row.expert.door': 'Porte d’entrée',
    'engine.row.wallInside': '{element} ({storeys})',
    'engine.row.expert.doorUnheated': 'Porte vers local non chauffé',
    'engine.short.N': 'N',
    'engine.short.NE': 'NE',
    'engine.short.E': 'E',
    'engine.short.SE': 'SE',
    'engine.short.S': 'S',
    'engine.short.SW': 'SO',
    'engine.short.W': 'O',
    'engine.short.NW': 'NO',
    'engine.short.front': 'AV',
    'engine.short.back': 'ARR',
    'engine.short.left': 'GAU',
    'engine.short.right': 'DR',
    'engine.short.side': 'LAT',
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
    'finding.stepback.overhangUncertain':
      '{upper} kragt um {area} m² über {lower} aus, das eine Wand zu einem unbeheizten Raum hat: Dieser Boden grenzt möglicherweise an diesen Raum statt an Außenluft. Prüfen und das Bauteil (Boden über unbeheiztem Raum) gegebenenfalls korrigieren.',
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
    'engine.row.floorOverUnheatedPlain': 'Boden von {storey} über einem unbeheizten Raum',
    // Reihenfolge „Experte“: Kurzbezeichnungen wie im Pass („VO 94*125 X2“)
    'engine.row.expert.door': 'Eingangstür',
    'engine.row.wallInside': '{element} ({storeys})',
    'engine.row.expert.doorUnheated': 'Tür zu unbeheizt',
    'engine.short.N': 'N',
    'engine.short.NE': 'NO',
    'engine.short.E': 'O',
    'engine.short.SE': 'SO',
    'engine.short.S': 'S',
    'engine.short.SW': 'SW',
    'engine.short.W': 'W',
    'engine.short.NW': 'NW',
    'engine.short.front': 'VO',
    'engine.short.back': 'RÜ',
    'engine.short.left': 'LI',
    'engine.short.right': 'RE',
    'engine.short.side': 'SEI',
    'engine.storeys.join': ' + ',
  },
};

registerMessages(ENGINE_MESSAGES);

/**
 * Questions de doute (engine/doubts) : courtes, simples, une seule chose à trancher. « {x} » = valeurs lues.
 * Les choix sont ceux du modèle, attestés par un CPE réel ou les notes de recherche : aucun n'est inventé.
 */
export const DOUBT_MESSAGES: Dictionary = {
  fr: {
    'doubt.unknown.source': 'Hypothèse de l’outil : réponse « je ne sais pas », à confirmer avant de signer',
    'doubt.occasion.datum': 'Type de preuve',
    'doubt.occasion.question': 'Construction neuve ou bâtiment existant ?',
    'doubt.attached.datum': 'Situation d’accolement',
    'doubt.attached.question': 'Le bâtiment est-il accolé à un voisin chauffé ?',
    'doubt.attached.effect': 'Mur mitoyen de {area} m² exclu de l’enveloppe ({pct} % de la surface)',
    'doubt.scale.datum': 'Échelle',
    'doubt.scale.question': 'L’échelle du plan est-elle juste ? Posez la règle sur une cote connue.',
    'doubt.top.datum': 'Fermeture haute',
    'doubt.top.question': 'Toiture plate, toiture inclinée habitée, ou comble non chauffé ?',
    'doubt.bottom.datum': 'Fermeture basse',
    'doubt.bottom.question': 'Le rez-de-chaussée est-il sur terre-plein, ou sur un sous-sol ?',
    'doubt.unheated-zone.datum': 'Locaux non chauffés',
    'doubt.unheated-zone.question': '« {names} » est-il hors du volume chauffé ?',
    'doubt.unheated-zone.questionUnnamed': 'La zone sans nom laissée hors du contour isolé est-elle non chauffée ?',
    'doubt.an-unlabelled.datum': 'Surface de référence An',
    'doubt.an-unlabelled.question': 'Surfaces chauffées sans étiquette ({area} m² : escalier, dégagement…) : comptent-elles dans An ?',
    'doubt.an-unlabelled.detail': '{level} : {area} m² sans étiquette',
    'doubt.an-unlabelled.effect': '+{area} m² d’An, soit +{pct} %',
    'doubt.an-unlabelled.questionEstimate': 'Pièces étiquetées : {labelled} m² sur {gross} m² de contour. Des surfaces chauffées sans étiquette comptent-elles dans An ?',
    'doubt.an-unlabelled.option.include': 'Oui, surface mesurée',
    'doubt.an-unlabelled.option.exclude': 'Non',
    'doubt.materials.datum': 'Couches des parois : matériaux et λ',
    'doubt.materials.question': 'Confirmez les matériaux ({layers} couches, {doubtful} à vérifier). Les λ proposées sont des valeurs d’usage.',
    'doubt.materials.questionMissing': 'Aucune composition lue : saisissez les couches des parois.',
    'doubt.materials.effect': 'λ de l’isolant +10 % : U du mur +{pct} %',
    'doubt.materials.missing': '{element} : aucune composition lue, couches à saisir',
    'doubt.materials.element.wall': 'Mur extérieur',
    'doubt.materials.element.wallUnheated': 'Mur vers local non chauffé',
    'doubt.materials.element.floorGround': 'Dalle sur sol',
    'doubt.materials.element.floorUnheated': 'Plancher sur local non chauffé',
    'doubt.materials.element.roof': 'Toiture',
    'doubt.windows.datum': 'Menuiseries',
    'doubt.windows.question': 'Menuiseries ({count} type(s)) : triple vitrage neuf, valeurs d’usage à remplacer par celles du fabricant ?',
    'doubt.windows.effect': 'Fenêtres : {pct} % de la surface d’enveloppe',
    'doubt.windows.detail.values': 'Ug 0,50 · Uf 1,00 · Ψg 0,035 · g 0,50 · cadre 0,112 m (valeurs d’usage)',
    'doubt.windows.detail.heights': 'Dimensions de baies : celles du plan (gros œuvre)',
    'doubt.windows.detail.doors': 'Portes : U 1,30 (valeur d’usage)',
    'doubt.windows.questionExisting': 'Menuiseries existantes ({count} type(s)) : Ug, Uf, Ψg, g et U des portes à relever. Aucune valeur proposée.',
    'doubt.windows.detail.existing': 'Valeurs à relever sur place ou dans la documentation des menuiseries',
    'doubt.windows.option.triple-new': 'Triple vitrage neuf (valeurs d’usage)',
    'doubt.ventilation.datum': 'Ventilation et étanchéité',
    'doubt.ventilation.question': 'Quelle ventilation ? Et quelle étanchéité à l’air viser ?',
    'doubt.ventilation.detail.device': 'Double flux : appareil, débit (m³/h), rendement, puissance (W/(m³/h))',
    'doubt.ventilation.detail.airtightness': 'Étanchéité : option « classe A+ ou A avec ventilation » (n50 = 0,6) ou valeur mesurée',
    'doubt.heating.datum': 'Chauffage et eau chaude',
    'doubt.heating.question': 'Chauffage : {generator} ? Émission, températures et eau chaude à confirmer.',
    'doubt.heating.questionNone': 'Quel générateur de chaleur ? Émission, températures et eau chaude à préciser.',
    'doubt.heating.detail.emission': 'Émission : plancher chauffant 35/28 ?',
    'doubt.heating.detail.tank': 'Eau chaude : par le même générateur, ballon dans le volume chauffé ?',
    'doubt.heating.detail.tankRead': 'Eau chaude : ballon lu sur le plan ; dans le volume chauffé ?',
    'doubt.thermal-bridges.datum': 'Ponts thermiques et construction',
    'doubt.thermal-bridges.question': 'Ponts thermiques : forfait 0,10 W/(m²K) sans justification, ou mieux ?',
    'doubt.thermal-bridges.effect': '0,03 au lieu de 0,10 : −{wk} W/K de pertes',
    'doubt.thermal-bridges.detail.heavy': 'Construction lourde (béton ou maçonnerie lus)',
    'doubt.thermal-bridges.detail.mass': 'Construction : à choisir dans l’outil',
    'doubt.openings.datum': 'Fenêtres et portes',
    'doubt.openings.question': 'Aucune fenêtre lue. Où sont les baies ? Marquez-les sur le plan.',
    'doubt.building-type.datum': 'Type de bâtiment',
    'doubt.building-type.question': 'Maison unifamiliale ou immeuble à plusieurs logements ?',
    'doubt.heights.datum': 'Hauteurs d’étage',
    'doubt.heights.question': 'Hauteurs d’étage brutes : lisez-les sur la coupe.',
    'doubt.room-heated.datum': 'Pièce à trancher',
    'doubt.room-heated.question': '« {names} » : chauffé(s) ?',
    'doubt.opening-heights.datum': 'Hauteurs des baies',
    'doubt.opening-heights.question': '{count} baie(s) sans hauteur écrite : quelle hauteur ?',
    'doubt.renewables.datum': 'Solaire et photovoltaïque',
    'doubt.renewables.question': 'Panneaux solaires ou photovoltaïques prévus ?',
    'doubt.north.datum': 'Nord',
    'doubt.north.question': 'Où est le nord ?',
    'doubt.year.datum': 'Année de construction',
    'doubt.year.question': 'Année de construction ?',
    'doubt.identity.datum': 'Adresse',
    'doubt.identity.question': 'Adresse du bâtiment ?',
    'doubt.option.new': 'Construction neuve',
    'doubt.option.existing': 'Bâtiment existant',
    'doubt.option.one-side': 'Accolé d’un côté (einseitig angebaut)',
    'doubt.option.other': 'Autre : à choisir dans LuxEeB-Tool',
    'doubt.option.flat': 'Toiture plate',
    'doubt.option.pitched': 'Toiture inclinée, combles chauffés',
    'doubt.option.attic': 'Comble non chauffé',
    'doubt.option.ground': 'Sur terre-plein',
    'doubt.option.basement-unheated': 'Sous-sol non chauffé',
    'doubt.option.basement-heated': 'Sous-sol chauffé',
    'doubt.option.unheated': 'Non chauffé',
    'doubt.option.heated': 'Chauffé',
    'doubt.option.windows': 'Par les fenêtres',
    'doubt.option.exhaust': 'Simple flux',
    'doubt.option.balanced-hr': 'Double flux avec récupération',
    'doubt.option.0.10': 'Forfait 0,10',
    'doubt.option.0.05': 'Forfait 0,05',
    'doubt.option.0.03': '0,03 selon DIN 4108',
    'doubt.option.detailed': 'Calcul détaillé',
    'doubt.option.EFH': 'Maison unifamiliale',
    'doubt.option.MFH': 'Plusieurs logements',
    'doubt.option.none': 'Aucun',
    'doubt.option.pv': 'Photovoltaïque',
    'doubt.option.solar-thermal': 'Solaire thermique',
    'doubt.generator.heat-pump-air': 'pompe à chaleur air/eau',
    'doubt.generator.heat-pump-ground': 'pompe à chaleur sol/eau',
    'doubt.generator.gas-condensing': 'chaudière gaz à condensation',
    'doubt.generator.oil-condensing': 'chaudière fioul à condensation',
    'doubt.generator.pellets': 'chaudière à granulés',
    'doubt.generator.district-heating': 'réseau de chaleur',
    'doubt.generator.other': 'autre générateur',
    'doubt.option.heat-pump-air': 'Pompe à chaleur air/eau',
    'doubt.option.heat-pump-ground': 'Pompe à chaleur sol/eau',
    'doubt.option.gas-condensing': 'Chaudière gaz à condensation',
    'doubt.option.pellets': 'Chaudière à granulés',
    'doubt.option.district-heating': 'Réseau de chaleur',
  },
  de: {
    'doubt.unknown.source': 'Annahme des Werkzeugs: Antwort „weiß nicht“, vor der Unterschrift bestätigen',
    'doubt.occasion.datum': 'Nachweisart',
    'doubt.occasion.question': 'Neubau oder Bestandsgebäude?',
    'doubt.attached.datum': 'Anbausituation',
    'doubt.attached.question': 'Grenzt das Gebäude an einen beheizten Nachbarn?',
    'doubt.attached.effect': 'Trennwand mit {area} m² nicht in der Hülle ({pct} % der Fläche)',
    'doubt.scale.datum': 'Maßstab',
    'doubt.scale.question': 'Stimmt der Maßstab? Legen Sie das Lineal an ein bekanntes Maß.',
    'doubt.top.datum': 'Oberer Abschluss',
    'doubt.top.question': 'Flachdach, bewohntes Steildach oder unbeheizter Dachraum?',
    'doubt.bottom.datum': 'Unterer Abschluss',
    'doubt.bottom.question': 'Steht das Erdgeschoss auf dem Erdreich oder über einem Keller?',
    'doubt.unheated-zone.datum': 'Unbeheizte Räume',
    'doubt.unheated-zone.question': 'Liegt „{names}“ außerhalb des beheizten Volumens?',
    'doubt.unheated-zone.questionUnnamed': 'Ist die Zone ohne Namen außerhalb der Dämmung unbeheizt?',
    'doubt.an-unlabelled.datum': 'Energiebezugsfläche An',
    'doubt.an-unlabelled.question': 'Beheizte Flächen ohne Beschriftung ({area} m²: Treppe, Flur…): zählen sie zu An?',
    'doubt.an-unlabelled.detail': '{level}: {area} m² ohne Beschriftung',
    'doubt.an-unlabelled.effect': '+{area} m² An, also +{pct} %',
    'doubt.an-unlabelled.questionEstimate': 'Beschriftete Räume: {labelled} m² von {gross} m² Umriss. Zählen beheizte Flächen ohne Beschriftung zu An?',
    'doubt.an-unlabelled.option.include': 'Ja, gemessene Fläche',
    'doubt.an-unlabelled.option.exclude': 'Nein',
    'doubt.materials.datum': 'Bauteilschichten: Baustoffe und λ',
    'doubt.materials.question': 'Bestätigen Sie die Baustoffe ({layers} Schichten, {doubtful} zu prüfen). Die λ sind Erfahrungswerte.',
    'doubt.materials.questionMissing': 'Kein Aufbau gelesen: bitte die Schichten der Bauteile eingeben.',
    'doubt.materials.effect': 'λ der Dämmung +10 %: U der Wand +{pct} %',
    'doubt.materials.missing': '{element}: kein Aufbau gelesen, Schichten eingeben',
    'doubt.materials.element.wall': 'Außenwand',
    'doubt.materials.element.wallUnheated': 'Wand zu unbeheizt',
    'doubt.materials.element.floorGround': 'Bodenplatte',
    'doubt.materials.element.floorUnheated': 'Decke über unbeheizt',
    'doubt.materials.element.roof': 'Dach',
    'doubt.windows.datum': 'Fenster und Türen',
    'doubt.windows.question': 'Fenster ({count} Typ(en)): neue Dreifachverglasung, Erfahrungswerte durch Herstellerwerte ersetzen?',
    'doubt.windows.effect': 'Fenster: {pct} % der Hüllfläche',
    'doubt.windows.detail.values': 'Ug 0,50 · Uf 1,00 · Ψg 0,035 · g 0,50 · Rahmen 0,112 m (Erfahrungswerte)',
    'doubt.windows.detail.heights': 'Fenstermaße: die des Plans (Rohbaumaß)',
    'doubt.windows.detail.doors': 'Türen: U 1,30 (Erfahrungswert)',
    'doubt.windows.questionExisting': 'Bestehende Fenster ({count} Typ(en)): Ug, Uf, Ψg, g und U der Türen aufnehmen. Kein Wert vorgeschlagen.',
    'doubt.windows.detail.existing': 'Werte vor Ort oder aus den Unterlagen der Fenster aufnehmen',
    'doubt.windows.option.triple-new': 'Neue Dreifachverglasung (Erfahrungswerte)',
    'doubt.ventilation.datum': 'Lüftung und Luftdichtheit',
    'doubt.ventilation.question': 'Welche Lüftung? Und welche Luftdichtheit?',
    'doubt.ventilation.detail.device': 'Lüftungsanlage: Gerät, Volumenstrom (m³/h), WRG, Leistung (W/(m³/h))',
    'doubt.ventilation.detail.airtightness': 'Luftdichtheit: Option „Klasse A+ oder A mit Lüftung“ (n50 = 0,6) oder Messwert',
    'doubt.heating.datum': 'Heizung und Warmwasser',
    'doubt.heating.question': 'Heizung: {generator}? Übergabe, Temperaturen und Warmwasser bestätigen.',
    'doubt.heating.questionNone': 'Welcher Wärmeerzeuger? Übergabe, Temperaturen und Warmwasser angeben.',
    'doubt.heating.detail.emission': 'Übergabe: Fußbodenheizung 35/28?',
    'doubt.heating.detail.tank': 'Warmwasser: gleicher Erzeuger, Speicher im beheizten Volumen?',
    'doubt.heating.detail.tankRead': 'Warmwasser: Speicher im Plan gelesen; im beheizten Volumen?',
    'doubt.thermal-bridges.datum': 'Wärmebrücken und Bauweise',
    'doubt.thermal-bridges.question': 'Wärmebrücken: pauschal 0,10 W/(m²K) ohne Nachweis, oder besser?',
    'doubt.thermal-bridges.effect': '0,03 statt 0,10: −{wk} W/K Verluste',
    'doubt.thermal-bridges.detail.heavy': 'Schwere Bauweise (Beton oder Mauerwerk gelesen)',
    'doubt.thermal-bridges.detail.mass': 'Bauweise: im Werkzeug wählen',
    'doubt.openings.datum': 'Fenster und Türen',
    'doubt.openings.question': 'Kein Fenster gelesen. Wo sind die Öffnungen? Markieren Sie sie im Plan.',
    'doubt.building-type.datum': 'Gebäudetyp',
    'doubt.building-type.question': 'Einfamilienhaus oder Mehrfamilienhaus?',
    'doubt.heights.datum': 'Geschosshöhen',
    'doubt.heights.question': 'Brutto-Geschosshöhen: bitte aus dem Schnitt ablesen.',
    'doubt.room-heated.datum': 'Raum zu entscheiden',
    'doubt.room-heated.question': '„{names}“: beheizt?',
    'doubt.opening-heights.datum': 'Fensterhöhen',
    'doubt.opening-heights.question': '{count} Öffnung(en) ohne Höhenangabe: welche Höhe?',
    'doubt.renewables.datum': 'Solar und Photovoltaik',
    'doubt.renewables.question': 'Sind Solar- oder Photovoltaikanlagen geplant?',
    'doubt.north.datum': 'Norden',
    'doubt.north.question': 'Wo ist Norden?',
    'doubt.year.datum': 'Baujahr',
    'doubt.year.question': 'Baujahr?',
    'doubt.identity.datum': 'Adresse',
    'doubt.identity.question': 'Adresse des Gebäudes?',
    'doubt.option.new': 'Neubau',
    'doubt.option.existing': 'Bestandsgebäude',
    'doubt.option.one-side': 'Einseitig angebaut',
    'doubt.option.other': 'Andere: in LuxEeB-Tool wählen',
    'doubt.option.flat': 'Flachdach',
    'doubt.option.pitched': 'Steildach, Dachgeschoss beheizt',
    'doubt.option.attic': 'Unbeheizter Dachraum',
    'doubt.option.ground': 'Auf Erdreich',
    'doubt.option.basement-unheated': 'Unbeheizter Keller',
    'doubt.option.basement-heated': 'Beheizter Keller',
    'doubt.option.unheated': 'Unbeheizt',
    'doubt.option.heated': 'Beheizt',
    'doubt.option.windows': 'Fensterlüftung',
    'doubt.option.exhaust': 'Abluftanlage',
    'doubt.option.balanced-hr': 'Zu- und Abluft mit WRG',
    'doubt.option.0.10': 'Pauschal 0,10',
    'doubt.option.0.05': 'Pauschal 0,05',
    'doubt.option.0.03': '0,03 nach DIN 4108',
    'doubt.option.detailed': 'Detaillierter Nachweis',
    'doubt.option.EFH': 'Einfamilienhaus',
    'doubt.option.MFH': 'Mehrfamilienhaus',
    'doubt.option.none': 'Keine',
    'doubt.option.pv': 'Photovoltaik',
    'doubt.option.solar-thermal': 'Solarthermie',
    'doubt.generator.heat-pump-air': 'Luft-Wasser-Wärmepumpe',
    'doubt.generator.heat-pump-ground': 'Sole-Wasser-Wärmepumpe',
    'doubt.generator.gas-condensing': 'Gas-Brennwertkessel',
    'doubt.generator.oil-condensing': 'Öl-Brennwertkessel',
    'doubt.generator.pellets': 'Pelletkessel',
    'doubt.generator.district-heating': 'Fernwärme',
    'doubt.generator.other': 'anderer Erzeuger',
    'doubt.option.heat-pump-air': 'Luft-Wasser-Wärmepumpe',
    'doubt.option.heat-pump-ground': 'Sole-Wasser-Wärmepumpe',
    'doubt.option.gas-condensing': 'Gas-Brennwertkessel',
    'doubt.option.pellets': 'Pelletkessel',
    'doubt.option.district-heating': 'Fernwärme',
  },
};

registerMessages(DOUBT_MESSAGES);

/** Projet construit automatiquement à partir d'une planche (engine/auto) : sources citées et remarques. */
export const AUTO_MESSAGES: Dictionary = {
  fr: {
    'auto.source.titleBlock': 'Lu dans le cartouche',
    'auto.source.systems': 'Proposé d’après les équipements écrits sur le plan',
    'auto.source.party': 'Déduit des murs mitoyens lus sur les plans',
    'auto.source.north': 'Flèche du nord lue sur la planche',
    'auto.doubt.northBorderline': 'à moins de 5° d’une limite de secteur',
    'auto.height.external': 'Cotes extérieures : niveaux et compositions lus',
    'auto.height.levels': 'De niveau fini à niveau fini (niveaux lus)',
    'auto.height.eaves': 'Du niveau fini à l’égout (niveaux lus)',
    'auto.clear.levels': 'Hauteur libre lue sur la coupe',
    'auto.source.floorOverUnheated': 'Plancher sur local non chauffé mesuré sur les plans superposés',
    'auto.source.roofPlanEmpty': 'Plan de toiture sans panneau',
    'auto.room.unlabelled': 'Surface sans étiquette (escalier, dégagement)',
    'auto.storey.rank-1': 'Sous-sol',
    'auto.storey.rank0': 'Rez-de-chaussée',
    'auto.storey.rank1': '1er étage',
    'auto.storey.rankN': '{n}e étage',
    'auto.note.legacy': 'Aucune lecture de planche : le plan se trace étape par étape.',
    'auto.note.noFloorPlan': 'Aucun plan d’étage avec un contour chauffé lu.',
    'auto.note.scale': 'Échelle non recoupée : posez la règle sur une cote connue.',
    'auto.note.top': 'Toiture non lue : fermeture haute à préciser.',
    'auto.note.bottom': 'Plancher bas non lu : fermeture basse à préciser.',
    'auto.note.tooManyDoubts': '{count} questions : trop pour les cartes de doute.',
    'auto.note.basement': '« {name} » : sous-sol non chauffé, hors du volume chauffé.',
    'auto.note.skipped': '« {name} » : pas de contour lu, feuille écartée.',
    'auto.note.edges': '« {name} » : nature des murs non lue, tous supposés en façade.',
  },
  de: {
    'auto.source.titleBlock': 'Im Schriftfeld gelesen',
    'auto.source.systems': 'Aus den im Plan genannten Anlagen vorgeschlagen',
    'auto.source.party': 'Aus den gelesenen Trennwänden abgeleitet',
    'auto.source.north': 'Nordpfeil auf dem Plan gelesen',
    'auto.doubt.northBorderline': 'weniger als 5° von einer Sektorgrenze',
    'auto.height.external': 'Außenmaße: Höhenkoten und Aufbauten gelesen',
    'auto.height.levels': 'Von Fertigfußboden zu Fertigfußboden (Koten gelesen)',
    'auto.height.eaves': 'Vom Fertigfußboden bis zur Traufe (Koten gelesen)',
    'auto.clear.levels': 'Lichte Höhe im Schnitt gelesen',
    'auto.source.floorOverUnheated': 'Boden über unbeheiztem Raum auf den überlagerten Plänen gemessen',
    'auto.source.roofPlanEmpty': 'Dachdraufsicht ohne Paneele',
    'auto.room.unlabelled': 'Fläche ohne Beschriftung (Treppe, Flur)',
    'auto.storey.rank-1': 'Untergeschoss',
    'auto.storey.rank0': 'Erdgeschoss',
    'auto.storey.rank1': 'Obergeschoss',
    'auto.storey.rankN': '{n}. Obergeschoss',
    'auto.note.legacy': 'Kein Plan gelesen: der Grundriss wird Schritt für Schritt erfasst.',
    'auto.note.noFloorPlan': 'Kein Grundriss mit beheiztem Umriss gelesen.',
    'auto.note.scale': 'Maßstab nicht abgeglichen: Lineal an ein bekanntes Maß legen.',
    'auto.note.top': 'Dach nicht gelesen: oberen Abschluss angeben.',
    'auto.note.bottom': 'Boden nicht gelesen: unteren Abschluss angeben.',
    'auto.note.tooManyDoubts': '{count} Fragen: zu viele für die Zweifelskarten.',
    'auto.note.basement': '„{name}“: unbeheizter Keller, außerhalb des beheizten Volumens.',
    'auto.note.skipped': '„{name}“: kein Umriss gelesen, Blatt nicht verwendet.',
    'auto.note.edges': '„{name}“: Art der Wände nicht gelesen, alle als Außenwand angenommen.',
  },
};

registerMessages(AUTO_MESSAGES);

/** Texte d'un contrôle dans la langue voulue (les variables de `params` sont déjà mises en forme : virgule décimale). */
export function findingText(finding: Finding, lang: Lang): string {
  return t(lang, `finding.${finding.code}`, finding.params);
}
