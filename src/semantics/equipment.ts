/**
 * Équipements ÉCRITS sur une planche (« PAC », « Boiler », « VMC », « Wärmepumpe », « Lüftungsgerät KWL »…) et
 * installations PROPOSÉES d'après eux. Une planche d'autorisation n'écrit presque rien des installations : tout ce
 * qui est proposé ici reste à confirmer (confiance < 0,85), et l'absence de mention n'est jamais une réponse.
 *
 * Signaux : le mot (FR / DE, mots entiers, sur une ligne courte), la vue (plan, façade) et la position par rapport
 * au bâtiment (une pompe à chaleur dessinée DEHORS est une unité extérieure, donc air/eau).
 */
import type { EquipmentKind, Read, ReadEquipment, ReadSystems, ReadView } from '../core/reading';
import type { HeatGenerator, HotWater, Lang, Ventilation } from '../core/types';
import { registerMessages, t, type Dictionary } from '../i18n';
import { isCompositionHeader, parseLayer } from './compositions';
import { fold, inBox, lineCenter, viewAt, type SheetLine } from './labels';

const MESSAGES: Dictionary = {
  fr: {
    'read.equip.hpAir': 'Pompe à chaleur air/eau (unité extérieure dessinée) : à confirmer, avec le régime (35/28 pour un plancher chauffant ?).',
    'read.equip.hpType': 'Pompe à chaleur écrite sur le plan : air/eau ou sol/eau ?',
    'read.equip.gas': 'Mention « gaz » : chaudière gaz à condensation ?',
    'read.equip.oil': 'Mention « mazout » : chaudière fioul à condensation ?',
    'read.equip.pellets': 'Mention « pellets » : chaudière à pellets ?',
    'read.equip.district': 'Raccordement à un réseau de chaleur : à confirmer.',
    'read.equip.dhw': 'Eau chaude : ballon chauffé par le générateur de chauffage, sans appoint électrique ?',
    'read.equip.dhwAlone': 'Ballon d’eau chaude écrit, sans générateur : comment est-il chauffé ?',
    'read.equip.ventBalanced': 'Ventilation mécanique écrite : double flux avec récupération de chaleur ? Modèle, débit, rendement ?',
    'read.equip.ventExhaust': 'Ventilation mécanique simple flux (extraction) : à confirmer.',
    'read.equip.pv': 'Panneaux photovoltaïques écrits : puissance crête ?',
    'read.equip.noPv': 'Aucun panneau photovoltaïque écrit sur le plan : confirmer qu’il n’y en a pas.',
    'read.equip.solar': 'Capteurs solaires thermiques écrits : surface et usage (eau chaude, chauffage) ?',
    'read.equip.noSolar': 'Aucun capteur solaire thermique écrit sur le plan : confirmer qu’il n’y en a pas.',
  },
  de: {
    'read.equip.hpAir': 'Luft/Wasser-Wärmepumpe (Außengerät gezeichnet): bitte bestätigen, mit Temperaturen (35/28 bei Fußbodenheizung?).',
    'read.equip.hpType': 'Wärmepumpe im Plan: Luft/Wasser oder Sole/Wasser?',
    'read.equip.gas': 'Erwähnung „Gas“: Gas-Brennwertkessel?',
    'read.equip.oil': 'Erwähnung „Heizöl“: Öl-Brennwertkessel?',
    'read.equip.pellets': 'Erwähnung „Pellets“: Pelletkessel?',
    'read.equip.district': 'Anschluss an ein Wärmenetz: bitte bestätigen.',
    'read.equip.dhw': 'Warmwasser: Speicher vom Heizungserzeuger beheizt, ohne Elektro-Zusatzheizung?',
    'read.equip.dhwAlone': 'Warmwasserspeicher im Plan, ohne Erzeuger: wie wird er beheizt?',
    'read.equip.ventBalanced': 'Lüftungsanlage im Plan: mit Wärmerückgewinnung? Modell, Luftmenge, Wirkungsgrad?',
    'read.equip.ventExhaust': 'Abluftanlage (ohne Zuluft): bitte bestätigen.',
    'read.equip.pv': 'Photovoltaik im Plan: Spitzenleistung?',
    'read.equip.noPv': 'Keine Photovoltaik im Plan: bitte bestätigen, dass keine vorgesehen ist.',
    'read.equip.solar': 'Solarthermie im Plan: Fläche und Nutzung (Warmwasser, Heizung)?',
    'read.equip.noSolar': 'Keine Solarthermie im Plan: bitte bestätigen, dass keine vorgesehen ist.',
  },
};
registerMessages(MESSAGES);

/** Vocabulaire replié, mots entiers. L'ordre compte : une ligne ne donne qu'un équipement, le premier reconnu. */
const EQUIP: { kind: EquipmentKind; re: RegExp }[] = [
  { kind: 'heat-pump', re: /\bpac\b|pompe a chaleur|warmepumpe|\bwp\b|luft-wasser|air[/ -]eau|sole[/ -]eau|sole-wasser|geotherm/ },
  { kind: 'ventilation-unit', re: /\bvmc\b|double flux|simple flux|(?<!hinter)luftungsgerat|\bkwl\b|wohnraumluftung|(?<!hinter)luftungsanlage|groupe de ventilation|centrale de ventilation|recuperateur de chaleur/ },
  { kind: 'hot-water-tank', re: /\bboiler\b|ballon|\becs\b|chauffe[- ]eau|warmwasserspeicher|\bww-?speicher|trinkwasserspeicher|pufferspeicher|\bpuffer\b/ },
  { kind: 'district-heating', re: /reseau de chaleur|chauffage urbain|fernwarme|nahwarme|warmenetz/ },
  { kind: 'pellets', re: /pellet|granules|plaquettes|hackschnitzel|holzkessel/ },
  { kind: 'oil', re: /mazout|fioul|heizol|olkessel|olheizung|oltank/ },
  { kind: 'gas', re: /chaudiere(?: a)? gaz|\bgaz\b|gastherme|gasbrennwert|gaskessel|\bgas\b/ },
  { kind: 'boiler', re: /chaudiere|chaufferie|heizkessel|\bkessel\b|brennwert|\btherme\b/ },
  { kind: 'solar-thermal', re: /solaire thermique|capteurs? solaires?|panneaux? solaires? thermiques?|solarthermie|sonnenkollektor|\bkollektor/ },
  { kind: 'photovoltaic', re: /photovolta|\bpv\b|panneaux? pv|solarmodul|pv-anlage|solaranlage/ },
  { kind: 'stove', re: /\bpoele\b|cheminee|kaminofen|\bofen\b|insert/ },
  { kind: 'cistern', re: /citerne|cuve|\btank\b|regenwasser|zisterne|eau de pluie/ },
];

/** Vues où un mot n'est pas un équipement dessiné (cartouche, tableau, légende, notes). */
const NOT_DRAWING: readonly string[] = ['title-block', 'table', 'legend', 'photo'];

/** Équipements écrits sur les plans et façades. `outside` : texte d'un plan hors de l'emprise du bâtiment. */
export function equipmentMentions(lines: readonly SheetLine[], views: readonly ReadView[]): ReadEquipment[] {
  const out: ReadEquipment[] = [];
  for (const l of lines) {
    const f = fold(l.text);
    if (f.length > 60) continue; // une phrase de mentions générales n'est pas un équipement
    // Une couche de paroi (« Hinterlüftung », « Isolation ») ou un titre de composition n'est pas un équipement.
    if (parseLayer(l.text) || isCompositionHeader(l.text)) continue;
    const rule = EQUIP.find((e) => e.re.test(f));
    if (!rule) continue;
    const at = lineCenter(l);
    const view = viewAt(views, l.page, at);
    if (view && NOT_DRAWING.includes(view.kind)) continue;
    let outside: boolean | null = null;
    if (view?.buildingBox && (view.kind === 'floor-plan' || view.kind === 'roof-plan')) {
      const b = view.buildingBox;
      // Emprise rétrécie d'un demi-point : un texte posé sur le mur extérieur reste dedans.
      outside = !inBox(b, at, -0.5);
    }
    out.push({ kind: rule.kind, raw: l.text, viewId: view?.id ?? null, outside, page: l.page, at });
  }
  return out;
}

function read<T>(value: T, confidence: number, sources: string[], doubt: string | null): Read<T> {
  return { value, confidence, evidence: sources.map((source) => ({ source })), doubt };
}

/**
 * Installations proposées d'après les équipements écrits. Toujours à confirmer : une pompe à chaleur dessinée dehors
 * ou en façade → air/eau (0,75) ; type écrit (« sol/eau », « Luft-Wasser ») → 0,9 ; un ballon avec un générateur →
 * eau chaude par le générateur (0,6). Rien d'écrit sur la ventilation → null (la question revient au moteur).
 */
export function proposeSystems(eq: readonly ReadEquipment[], views: readonly ReadView[] = [], lang: Lang = 'fr'): ReadSystems {
  const kindOf = new Map(views.map((v) => [v.id, v.kind]));
  const of = (k: EquipmentKind): ReadEquipment[] => eq.filter((e) => e.kind === k);
  const hp = of('heat-pump');
  let heatGenerator: Read<HeatGenerator> | null = null;
  if (hp.length > 0) {
    const explicit = hp.find((e) => /air|luft|sole|geotherm|erdwarme|sonde/.test(fold(e.raw)));
    if (explicit) {
      const ground = /sole|geotherm|erdwarme|sonde/.test(fold(explicit.raw));
      heatGenerator = read<HeatGenerator>(ground ? 'heat-pump-ground' : 'heat-pump-air', 0.9, ['equipment-text', 'heat-pump-type-written'], null);
    } else {
      const outdoor = hp.some((e) => e.outside === true || (e.viewId !== null && kindOf.get(e.viewId) === 'elevation'));
      const sources = ['equipment-text', ...(outdoor ? ['drawn-outside'] : [])];
      heatGenerator = outdoor
        ? read<HeatGenerator>('heat-pump-air', 0.75, sources, t(lang, 'read.equip.hpAir'))
        : read<HeatGenerator>('heat-pump-air', 0.5, sources, t(lang, 'read.equip.hpType'));
    }
  } else if (of('district-heating').length > 0) heatGenerator = read<HeatGenerator>('district-heating', 0.7, ['equipment-text'], t(lang, 'read.equip.district'));
  else if (of('pellets').length > 0) heatGenerator = read<HeatGenerator>('pellets', 0.6, ['equipment-text'], t(lang, 'read.equip.pellets'));
  else if (of('gas').length > 0) heatGenerator = read<HeatGenerator>('gas-condensing', 0.55, ['equipment-text'], t(lang, 'read.equip.gas'));
  else if (of('oil').length > 0) heatGenerator = read<HeatGenerator>('oil-condensing', 0.5, ['equipment-text'], t(lang, 'read.equip.oil'));

  const tank = of('hot-water-tank');
  let hotWater: Read<HotWater> | null = null;
  if (tank.length > 0) {
    hotWater = heatGenerator
      ? read<HotWater>('with-heating', 0.6, ['equipment-text', 'tank-and-generator'], t(lang, 'read.equip.dhw'))
      : read<HotWater>('with-heating', 0.4, ['equipment-text'], t(lang, 'read.equip.dhwAlone'));
  }

  const vent = of('ventilation-unit');
  let ventilation: Read<Ventilation> | null = null;
  if (vent.length > 0) {
    const f = fold(vent.map((v) => v.raw).join(' '));
    if (/simple flux|abluft|extraction/.test(f)) ventilation = read<Ventilation>('exhaust', 0.6, ['equipment-text'], t(lang, 'read.equip.ventExhaust'));
    else {
      const explicit = /double flux|\bkwl\b|recuperat|warmeruckgewinnung|\bwrg\b/.test(f);
      ventilation = read<Ventilation>('balanced-hr', explicit ? 0.7 : 0.55, ['equipment-text'], t(lang, 'read.equip.ventBalanced'));
    }
  }

  const pv = of('photovoltaic');
  const photovoltaic = pv.length > 0 ? read(true, 0.7, ['equipment-text'], t(lang, 'read.equip.pv')) : read(false, 0.5, ['no-mention'], t(lang, 'read.equip.noPv'));
  const st = of('solar-thermal');
  const solarThermal = st.length > 0 ? read(true, 0.7, ['equipment-text'], t(lang, 'read.equip.solar')) : read(false, 0.5, ['no-mention'], t(lang, 'read.equip.noSolar'));
  return { heatGenerator, hotWater, ventilation, photovoltaic, solarThermal };
}
