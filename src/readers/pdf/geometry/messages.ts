/**
 * Textes de la lecture géométrique (remarques et doutes), en français et en allemand : courts, simples.
 */
import type { Lang } from '../../../core/types';
import { registerMessages, t, type Dictionary } from '../../../i18n';

export const GEOMETRY_MESSAGES: Dictionary = {
  fr: {
    'geo.scale.areas': 'Échelle 1:{den} retrouvée par les surfaces écrites de {rooms} pièces.',
    'geo.scale.areas.agree': 'Échelle 1:{den} : les surfaces écrites de {rooms} pièces confirment l’échelle annoncée.',
    'geo.scale.areas.contradict': 'Les surfaces écrites donnent 1:{den}, l’échelle annoncée 1:{declared} : laquelle est juste ?',
    'geo.scale.declared': 'Échelle 1:{den} annoncée, non recoupée par les surfaces.',
    'geo.scale.none': 'Échelle inconnue : posez la règle sur une cote.',
    'geo.rooms.found': '{found} pièce(s) sur {total} retrouvée(s) sur le dessin ; écart maximal {gap} %.',
    'geo.rooms.fallback': 'Pièces sans remplissage : contours pris entre les murs, moins sûrs.',
    'geo.room.approx': 'Contour approximatif ({measured} m² mesurés pour {stated} m² écrits).',
    'geo.room.missing': 'Contour non retrouvé.',
    'geo.room.ask': 'Pièce « {name} » : chauffée ?',
    'geo.walls.fallback': 'Murs non reconnus (ni hachures ni poché) : emprise approximative.',
    'geo.walls.solid': 'Murs en poché plein, isolant en hachure simple.',
    'geo.outline': 'Emprise {w} × {d} m ({area} m²).',
    'geo.outline.dims': 'Emprise {w} × {d} m, confirmée par les cotes hors tout.',
    'geo.outline.dims.contradict': 'Emprise mesurée {w} × {d} m, cotes hors tout {cw} × {cd} m : à vérifier.',
    'geo.party': 'Mur mitoyen côté {side} ({length} m).',
    'geo.party.ask': 'Le mur côté {side} ({length} m) est-il mitoyen ?',
    'geo.unheated': 'Local non chauffé : {names} ({area} m²), séparé par l’isolant.',
    'geo.unheated.unsealed': 'Le local « {name} » n’est pas séparé du logement par l’isolant : est-il chauffé ?',
    'geo.unheated.basement': 'Sous-sol sans isolant dessiné : tout le niveau est proposé non chauffé.',
    'geo.heated': 'Contour chauffé : {area} m².',
    'geo.unlabelled': 'Surface sans étiquette de {area} m² dans le volume chauffé (escalier ?) : à compter ?',
    'geo.wallToUnheated': 'Parois vers le non chauffé : {length} m.',
    'geo.openings': 'Baies des murs extérieurs : {windows} fenêtre(s), {doors} porte(s), {unknown} incertaine(s).',
    'geo.opening.unknown': 'Ouverture de {width} m côté {side} : porte, fenêtre ou rien ?',
    'geo.opening.noHeight': 'Porte de {width} m sans hauteur écrite : quelle hauteur ?',
    'geo.door.unheated': 'Porte de {width} m entre « {room} » et le local non chauffé.',
    'geo.side.top': 'haut',
    'geo.side.right': 'droit',
    'geo.side.bottom': 'bas',
    'geo.side.left': 'gauche',
    'geo.side.oblique': 'oblique',
    'geo.elev.side': 'Façade rattachée au côté {side} du plan.',
    'geo.elev.side.ask': 'La façade « {name} » correspond-elle au côté {side} du plan ?',
    'geo.elev.north.contradict': 'La flèche du nord ne correspond pas au côté trouvé pour la façade « {name} ».',
    'geo.height.ask': 'Hauteur de baie : plan {plan} m, façade {elev} m. Laquelle retenir ?',
    'geo.align.ask': 'Les plans des niveaux ne se superposent pas sûrement : vérifiez leur calage.',
  },
  de: {
    'geo.scale.areas': 'Maßstab 1:{den} aus den Flächenangaben von {rooms} Räumen ermittelt.',
    'geo.scale.areas.agree': 'Maßstab 1:{den}: die Flächenangaben von {rooms} Räumen bestätigen den angegebenen Maßstab.',
    'geo.scale.areas.contradict': 'Die Flächenangaben ergeben 1:{den}, angegeben ist 1:{declared}: welcher stimmt?',
    'geo.scale.declared': 'Angegebener Maßstab 1:{den}, nicht durch Flächen bestätigt.',
    'geo.scale.none': 'Maßstab unbekannt: bitte an einem Maß das Lineal anlegen.',
    'geo.rooms.found': '{found} von {total} Räumen in der Zeichnung gefunden; größte Abweichung {gap} %.',
    'geo.rooms.fallback': 'Räume ohne Füllung: Umrisse zwischen den Wänden ermittelt, weniger sicher.',
    'geo.room.approx': 'Umriss ungefähr ({measured} m² gemessen, {stated} m² angegeben).',
    'geo.room.missing': 'Umriss nicht gefunden.',
    'geo.room.ask': 'Raum „{name}“: beheizt?',
    'geo.walls.fallback': 'Wände nicht erkannt (weder Schraffur noch Füllung): Grundfläche ungefähr.',
    'geo.walls.solid': 'Wände als Vollfüllung, Dämmung als einfache Schraffur.',
    'geo.outline': 'Grundfläche {w} × {d} m ({area} m²).',
    'geo.outline.dims': 'Grundfläche {w} × {d} m, durch die Außenmaße bestätigt.',
    'geo.outline.dims.contradict': 'Gemessen {w} × {d} m, Außenmaße {cw} × {cd} m: bitte prüfen.',
    'geo.party': 'Gemeinsame Wand (Nachbar) auf der Seite {side} ({length} m).',
    'geo.party.ask': 'Ist die Wand auf der Seite {side} ({length} m) eine gemeinsame Wand mit dem Nachbarn?',
    'geo.unheated': 'Unbeheizter Raum: {names} ({area} m²), durch die Dämmung getrennt.',
    'geo.unheated.unsealed': 'Der Raum „{name}“ ist nicht durch Dämmung von der Wohnung getrennt: ist er beheizt?',
    'geo.unheated.basement': 'Untergeschoss ohne gezeichnete Dämmung: das ganze Geschoss gilt als unbeheizt.',
    'geo.heated': 'Beheizter Umriss: {area} m².',
    'geo.unlabelled': 'Fläche ohne Beschriftung von {area} m² im beheizten Volumen (Treppe?): mitzählen?',
    'geo.wallToUnheated': 'Wände zum unbeheizten Bereich: {length} m.',
    'geo.openings': 'Öffnungen der Außenwände: {windows} Fenster, {doors} Tür(en), {unknown} unklar.',
    'geo.opening.unknown': 'Öffnung von {width} m auf der Seite {side}: Tür, Fenster oder nichts?',
    'geo.opening.noHeight': 'Tür von {width} m ohne Höhenangabe: welche Höhe?',
    'geo.door.unheated': 'Tür von {width} m zwischen „{room}“ und dem unbeheizten Raum.',
    'geo.side.top': 'oben',
    'geo.side.right': 'rechts',
    'geo.side.bottom': 'unten',
    'geo.side.left': 'links',
    'geo.side.oblique': 'schräg',
    'geo.elev.side': 'Ansicht der Seite {side} des Grundrisses zugeordnet.',
    'geo.elev.side.ask': 'Gehört die Ansicht „{name}“ zur Seite {side} des Grundrisses?',
    'geo.elev.north.contradict': 'Der Nordpfeil passt nicht zur gefundenen Seite der Ansicht „{name}“.',
    'geo.height.ask': 'Fensterhöhe: Grundriss {plan} m, Ansicht {elev} m. Welche gilt?',
    'geo.align.ask': 'Die Grundrisse der Geschosse liegen nicht sicher übereinander: bitte Lage prüfen.',
  },
};

registerMessages(GEOMETRY_MESSAGES);

export function gmsg(lang: Lang, key: string, params?: Record<string, string | number>): string {
  return t(lang, key, params);
}

/** Nom du côté d'une normale de la feuille (haut, droit, bas, gauche, oblique). */
export function sideName(lang: Lang, deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  const k = d < 10 || d > 350 ? 'top' : Math.abs(d - 90) < 10 ? 'right' : Math.abs(d - 180) < 10 ? 'bottom' : Math.abs(d - 270) < 10 ? 'left' : 'oblique';
  return gmsg(lang, `geo.side.${k}`);
}
