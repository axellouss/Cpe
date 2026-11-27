/**
 * Textes du lecteur PDF (avertissements, remarques, noms de feuilles), en français et en allemand.
 * Le contrat (PlanDocument.warnings, SheetDetection.notes, Sourced.note) attend du français : `readPdf` produit
 * donc du français ; `analysePdf(…, { lang: 'de' })` donne les mêmes textes en allemand.
 */
import type { Lang } from '../../core/types';
import { registerMessages, t, type Dictionary } from '../../i18n';

export const PDF_MESSAGES: Dictionary = {
  fr: {
    'pdf.error.password': 'Ce PDF est protégé par un mot de passe : enregistrez-en une copie non protégée, puis réessayez.',
    'pdf.error.invalid': 'Ce fichier PDF est illisible ou abîmé : réexportez-le depuis le logiciel de dessin.',
    'pdf.error.empty': 'Ce PDF ne contient aucune page.',

    'pdf.sheet.page': 'Page {page}',
    'pdf.sheet.pagePlan': 'Page {page} – plan {n}',
    'pdf.page': 'Page {page} : ',

    'pdf.scale.agree.dims': 'Échelle {scale} : le cartouche est confirmé par {dims} cotes concordantes.',
    'pdf.scale.agree.dimsAreas': 'Échelle {scale} : le cartouche est confirmé par {dims} cotes concordantes et par les surfaces écrites de {rooms} pièces.',
    'pdf.scale.agree.areas': 'Échelle {scale} : le cartouche est confirmé par les surfaces écrites de {rooms} pièces.',
    'pdf.scale.near.dims': 'Échelle {scale} mesurée sur {dims} cotes concordantes (le cartouche annonce {declared}).',
    'pdf.scale.dims': 'Échelle {scale} déduite de {dims} cotes concordantes (cotes entières lues en {unit}).',
    'pdf.scale.dimsAreas': 'Échelle {scale} déduite de {dims} cotes concordantes et recoupée par les surfaces écrites de {rooms} pièces.',
    'pdf.scale.dims.contradict': 'Échelle {scale} d’après {dims} cotes concordantes ; le cartouche annonce {declared} (plan réduit ou agrandi à l’impression ?).',
    'pdf.scale.dims.ambiguous': 'Échelle {scale} d’après {dims} cotes, en supposant des cotes en {unit} : posez la règle sur une cote pour confirmer.',
    'pdf.scale.dims.weak': 'Échelle {scale} d’après {dims} cote(s) seulement : posez la règle sur une cote pour confirmer.',
    'pdf.scale.title': 'Échelle {scale} lue dans le cartouche, non vérifiée : posez la règle sur une cote pour la confirmer.',
    'pdf.scale.title.several': 'Échelle {scale} lue sur le plan, non vérifiée (plusieurs échelles annoncées : {list}) : posez la règle sur une cote pour la confirmer.',
    'pdf.scale.areas': 'Échelle ≈ {scale} d’après les surfaces écrites de {rooms} pièces : posez la règle sur une cote pour confirmer.',
    'pdf.scale.areas.contradict': 'Échelle ≈ {scale} d’après les surfaces écrites de {rooms} pièces ; le cartouche annonce {declared}. Posez la règle sur une cote pour confirmer.',

    'pdf.warn.scale.contradict': '{where}le cartouche annonce {declared} mais les cotes donnent {scale} : plan probablement imprimé « ajusté à la page ». Les cotes font foi.',
    'pdf.warn.scale.contradict.areas': '{where}le cartouche annonce {declared} mais les surfaces écrites donnent environ {scale} : vérifiez l’échelle avec la règle.',
    'pdf.warn.scale.areasDisagree': '{where}les surfaces écrites dans les pièces ne confirment pas l’échelle retenue ({scale} contre {areas} d’après les surfaces) : vérifiez avec la règle.',
    'pdf.warn.scale.none': '{where}échelle introuvable : posez la règle sur une longueur connue.',
    'pdf.warn.scale.estimate': '{where}échelle non vérifiée par les cotes : posez la règle sur une cote pour la confirmer.',
    'pdf.warn.scan': '{where}pas de dessin vectoriel (plan scanné ou image) : posez la règle sur une cote connue, puis tracez le contour à la main. En dessous de 200 dpi, la précision est limitée.',
    'pdf.warn.outlinedText': '{where}les textes de ce PDF sont des dessins, pas du texte (polices vectorisées) : ni échelle, ni cotes, ni noms de pièces ne peuvent être lus. Posez la règle sur une cote connue, puis tracez le contour ; les traits du plan restent accrochables.',
    'pdf.warn.noText': '{where}aucun texte lisible : posez la règle sur une cote connue, puis tracez le contour à la main.',
    'pdf.warn.empty': '{where}page sans dessin exploitable (ni tracé vectoriel, ni image) : rien à proposer.',
    'pdf.warn.hairline': '{where}tous les traits ont la même épaisseur : les murs ne se distinguent pas, le contour est à tracer à la main (les traits du plan restent accrochables).',
    'pdf.warn.noOutline': '{where}aucun contour de bâtiment fiable n’a pu être proposé : tracez-le à la main.',
    'pdf.warn.turned': '{where}page redressée d’un quart de tour pour lire le texte à l’endroit.',
    'pdf.warn.truncated': '{where}dessin très lourd, lu en partie seulement.',
    'pdf.warn.heavy': '{where}dessin très chargé ({count} traits au trait de mur) : le contour n’est pas recherché automatiquement, tracez-le à la main.',
    'pdf.warn.display': '{where}{total} traits, affichage allégé aux {kept} plus longs.',
    'pdf.warn.section': '{where}coupe ou façade « {title} » : non reprise comme plan.',
    'pdf.warn.section.heights': '{where}coupe ou façade « {title} » : non reprise comme plan ; hauteurs lues : {heights}.',
    'pdf.warn.onlySections': 'Aucun plan d’étage reconnu dans ce PDF : les pages sont proposées telles quelles.',
    'pdf.warn.pages': 'PDF de {total} pages : seules les {kept} premières ont été lues.',
    'pdf.warn.render': '{where}l’image de fond n’a pas pu être produite ; les traits du plan restent utilisables.',
    'pdf.warn.analysis': '{where}l’analyse automatique a échoué : le plan est affiché, échelle et contour sont à poser à la main.',
    'pdf.warn.noRooms': '{where}aucun nom de pièce reconnu : les surfaces nettes seront à saisir.',

    'pdf.note.outline': 'Contour extérieur proposé : {area} m², murs compris. Les ouvertures sont refermées et un renfoncement de moins de {gap} m de large serait comblé : à vérifier.',
    'pdf.note.outline.unheated': 'Le contour englobe {rooms} (probablement non chauffé) : à retirer du contour si hors volume chauffé.',
    'pdf.note.outline.leak': 'Pas de contour proposé : {rooms} se trouve(nt) hors du contour calculé (grande ouverture ou murs mal raccordés). À tracer à la main.',
    'pdf.note.outline.none': 'Pas de contour fiable sur cette vue : à tracer à la main.',
    'pdf.note.outline.unsupported': 'Pas de contour proposé : le tracé calculé coupe à travers le plan sur {length} m sans suivre aucun mur (grande ouverture restée ouverte ?). À tracer à la main.',
    'pdf.note.outline.noWalls': 'Les murs ne se distinguent pas des autres traits (même épaisseur) : pas de contour proposé.',
    'pdf.note.rooms.measured': '{n} pièce(s) mesurée(s) sur le dessin ; écart maximal avec les surfaces écrites : {gap} %.',
    'pdf.note.rooms.unmeasured': 'Pièces non mesurées (contour de pièce absent ou non recoupé) : {rooms}.',
    'pdf.note.rooms.mismatch': '« {room} » : {stated} m² écrits, {measured} m² mesurés.',
    'pdf.note.heights': 'Hauteurs lues sur la coupe : {heights}.',
    'pdf.note.title': 'Titre de la vue : « {title} ».',
    'pdf.note.openings': 'Ouvertures repérées sur les murs extérieurs : {windows} fenêtre(s), {doors} porte(s), {unknown} de type à préciser. Largeurs lues sur le plan, hauteurs à saisir.',

    'pdf.height.storey': 'hauteur d’étage {value} m',
    'pdf.height.clear': 'hauteur libre {value} m',

    'pdf.north.note': 'Flèche du nord repérée sur le plan (lettre N près d’un cercle) : à confirmer avec la boussole.',

    'pdf.unit.mm': 'mm',
    'pdf.unit.cm': 'cm',
    'pdf.unit.m': 'm',
  },
  de: {
    'pdf.error.password': 'Dieses PDF ist passwortgeschützt: bitte eine ungeschützte Kopie speichern und erneut versuchen.',
    'pdf.error.invalid': 'Diese PDF-Datei ist nicht lesbar oder beschädigt: bitte aus dem CAD-Programm neu exportieren.',
    'pdf.error.empty': 'Dieses PDF enthält keine Seite.',

    'pdf.sheet.page': 'Seite {page}',
    'pdf.sheet.pagePlan': 'Seite {page} – Plan {n}',
    'pdf.page': 'Seite {page}: ',

    'pdf.scale.agree.dims': 'Maßstab {scale}: das Schriftfeld wird durch {dims} übereinstimmende Maße bestätigt.',
    'pdf.scale.agree.dimsAreas': 'Maßstab {scale}: das Schriftfeld wird durch {dims} übereinstimmende Maße und die eingetragenen Flächen von {rooms} Räumen bestätigt.',
    'pdf.scale.agree.areas': 'Maßstab {scale}: das Schriftfeld wird durch die eingetragenen Flächen von {rooms} Räumen bestätigt.',
    'pdf.scale.near.dims': 'Maßstab {scale}, gemessen an {dims} übereinstimmenden Maßen (im Schriftfeld steht {declared}).',
    'pdf.scale.dims': 'Maßstab {scale}, abgeleitet aus {dims} übereinstimmenden Maßen (ganzzahlige Maße in {unit} gelesen).',
    'pdf.scale.dimsAreas': 'Maßstab {scale}, abgeleitet aus {dims} übereinstimmenden Maßen und bestätigt durch die eingetragenen Flächen von {rooms} Räumen.',
    'pdf.scale.dims.contradict': 'Maßstab {scale} nach {dims} übereinstimmenden Maßen; im Schriftfeld steht {declared} (Plan beim Drucken verkleinert oder vergrößert?).',
    'pdf.scale.dims.ambiguous': 'Maßstab {scale} nach {dims} Maßen, unter der Annahme von Maßen in {unit}: bitte das Lineal an ein Maß anlegen.',
    'pdf.scale.dims.weak': 'Maßstab {scale} nach nur {dims} Maß(en): bitte das Lineal an ein Maß anlegen.',
    'pdf.scale.title': 'Maßstab {scale} aus dem Schriftfeld, nicht überprüft: bitte das Lineal an ein Maß anlegen.',
    'pdf.scale.title.several': 'Maßstab {scale} vom Plan gelesen, nicht überprüft (mehrere Maßstäbe angegeben: {list}): bitte das Lineal an ein Maß anlegen.',
    'pdf.scale.areas': 'Maßstab ≈ {scale} nach den eingetragenen Flächen von {rooms} Räumen: bitte das Lineal an ein Maß anlegen.',
    'pdf.scale.areas.contradict': 'Maßstab ≈ {scale} nach den eingetragenen Flächen von {rooms} Räumen; im Schriftfeld steht {declared}. Bitte das Lineal an ein Maß anlegen.',

    'pdf.warn.scale.contradict': '{where}im Schriftfeld steht {declared}, die Maße ergeben aber {scale}: der Plan wurde vermutlich „an Seite angepasst“ gedruckt. Die Maße gelten.',
    'pdf.warn.scale.contradict.areas': '{where}im Schriftfeld steht {declared}, die eingetragenen Flächen ergeben aber etwa {scale}: bitte den Maßstab mit dem Lineal prüfen.',
    'pdf.warn.scale.areasDisagree': '{where}die eingetragenen Raumflächen bestätigen den gewählten Maßstab nicht ({scale} gegenüber {areas} nach den Flächen): bitte mit dem Lineal prüfen.',
    'pdf.warn.scale.none': '{where}kein Maßstab gefunden: bitte das Lineal an eine bekannte Länge anlegen.',
    'pdf.warn.scale.estimate': '{where}Maßstab nicht durch Maße bestätigt: bitte das Lineal an ein Maß anlegen.',
    'pdf.warn.scan': '{where}keine Vektorzeichnung (gescannter Plan oder Bild): bitte das Lineal an ein bekanntes Maß anlegen und den Umriss von Hand zeichnen. Unter 200 dpi ist die Genauigkeit begrenzt.',
    'pdf.warn.outlinedText': '{where}die Texte dieses PDF sind Zeichnungen, kein Text (in Kurven umgewandelte Schriften): weder Maßstab noch Maße noch Raumnamen sind lesbar. Bitte das Lineal an ein bekanntes Maß anlegen und den Umriss zeichnen; die Linien des Plans bleiben fangbar.',
    'pdf.warn.noText': '{where}kein lesbarer Text: bitte das Lineal an ein bekanntes Maß anlegen und den Umriss von Hand zeichnen.',
    'pdf.warn.empty': '{where}Seite ohne verwertbare Zeichnung (weder Vektorlinien noch Bild): kein Vorschlag möglich.',
    'pdf.warn.hairline': '{where}alle Linien haben dieselbe Strichstärke: die Wände sind nicht erkennbar, der Umriss ist von Hand zu zeichnen (die Linien des Plans bleiben fangbar).',
    'pdf.warn.noOutline': '{where}kein verlässlicher Gebäudeumriss gefunden: bitte von Hand zeichnen.',
    'pdf.warn.turned': '{where}Seite um eine Vierteldrehung gedreht, damit der Text aufrecht steht.',
    'pdf.warn.truncated': '{where}sehr umfangreiche Zeichnung, nur teilweise gelesen.',
    'pdf.warn.heavy': '{where}sehr dichte Zeichnung ({count} Linien in Wandstärke): der Umriss wird nicht automatisch gesucht, bitte von Hand zeichnen.',
    'pdf.warn.display': '{where}{total} Linien, Anzeige auf die {kept} längsten reduziert.',
    'pdf.warn.section': '{where}Schnitt oder Ansicht „{title}“: nicht als Grundriss übernommen.',
    'pdf.warn.section.heights': '{where}Schnitt oder Ansicht „{title}“: nicht als Grundriss übernommen; gelesene Höhen: {heights}.',
    'pdf.warn.onlySections': 'Kein Grundriss in diesem PDF erkannt: die Seiten werden unverändert angeboten.',
    'pdf.warn.pages': 'PDF mit {total} Seiten: nur die ersten {kept} wurden gelesen.',
    'pdf.warn.render': '{where}das Hintergrundbild konnte nicht erzeugt werden; die Linien des Plans bleiben nutzbar.',
    'pdf.warn.analysis': '{where}die automatische Auswertung ist fehlgeschlagen: der Plan wird angezeigt, Maßstab und Umriss sind von Hand zu setzen.',
    'pdf.warn.noRooms': '{where}kein Raumname erkannt: die Nettoflächen sind einzugeben.',

    'pdf.note.outline': 'Vorgeschlagener Außenumriss: {area} m², einschließlich Wände. Öffnungen sind geschlossen, ein Rücksprung von weniger als {gap} m Breite würde aufgefüllt: bitte prüfen.',
    'pdf.note.outline.unheated': 'Der Umriss umfasst {rooms} (vermutlich unbeheizt): bitte aus dem Umriss entfernen, falls außerhalb des beheizten Volumens.',
    'pdf.note.outline.leak': 'Kein Umriss vorgeschlagen: {rooms} liegt/liegen außerhalb des berechneten Umrisses (große Öffnung oder schlecht verbundene Wände). Bitte von Hand zeichnen.',
    'pdf.note.outline.none': 'Kein verlässlicher Umriss in dieser Ansicht: bitte von Hand zeichnen.',
    'pdf.note.outline.unsupported': 'Kein Umriss vorgeschlagen: die berechnete Linie schneidet auf {length} m quer durch den Plan, ohne einer Wand zu folgen (große, offen gebliebene Öffnung?). Bitte von Hand zeichnen.',
    'pdf.note.outline.noWalls': 'Die Wände unterscheiden sich nicht von den übrigen Linien (gleiche Strichstärke): kein Umriss vorgeschlagen.',
    'pdf.note.rooms.measured': '{n} Raum/Räume in der Zeichnung gemessen; größte Abweichung von den eingetragenen Flächen: {gap} %.',
    'pdf.note.rooms.unmeasured': 'Nicht gemessene Räume (Raumumriss fehlt oder nicht bestätigt): {rooms}.',
    'pdf.note.rooms.mismatch': '„{room}“: {stated} m² eingetragen, {measured} m² gemessen.',
    'pdf.note.heights': 'Im Schnitt gelesene Höhen: {heights}.',
    'pdf.note.title': 'Titel der Ansicht: „{title}“.',
    'pdf.note.openings': 'In den Außenwänden erkannte Öffnungen: {windows} Fenster, {doors} Tür(en), {unknown} mit unklarer Art. Breiten vom Plan gelesen, Höhen sind einzugeben.',

    'pdf.height.storey': 'Geschosshöhe {value} m',
    'pdf.height.clear': 'lichte Höhe {value} m',

    'pdf.north.note': 'Nordpfeil im Plan erkannt (Buchstabe N bei einem Kreis): bitte mit dem Kompass bestätigen.',

    'pdf.unit.mm': 'mm',
    'pdf.unit.cm': 'cm',
    'pdf.unit.m': 'm',
  },
};

registerMessages(PDF_MESSAGES);

/** Texte du lecteur dans la langue demandée. */
export function msg(lang: Lang, key: string, params?: Record<string, string | number>): string {
  return t(lang, key, params);
}
