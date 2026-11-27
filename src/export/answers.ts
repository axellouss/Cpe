/**
 * Réponses de l'expert « en clair » (FR / DE) : textes communs au guide, au CSV et au dossier imprimable.
 * Ce sont NOS mots, pas les libellés des listes de LuxEeB-Tool.
 */
import type { Lang, Project, Provenance } from '../core/types';
import { t } from '../i18n';
import { cleanText, luxeebNumber, termLabel } from './format';
import { LUXEEB_PROJECT } from './luxeeb-terms';
import './messages';

/** Libellé traduit d'une valeur d'énumération ; null si la valeur est absente ; la valeur brute si elle est inconnue. */
export function enumText(lang: Lang, group: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const key = `export.enum.${group}.${value}`;
  const text = t(lang, key);
  return text === key ? String(value) : text;
}

export function yesNoText(lang: Lang, value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return t(lang, value ? 'export.common.yes' : 'export.common.no');
}

/** Entier lisible (année, nombre de logements) ; null si absent. */
export function integerText(value: number | null | undefined): string | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : String(Math.round(value));
}

/** « 12 cm », « aucune isolation ajoutée » (0) ou null (non renseigné). */
export function insulationText(lang: Lang, cm: number | null | undefined): string | null {
  if (cm === null || cm === undefined || !Number.isFinite(cm)) return null;
  if (cm <= 0) return t(lang, 'export.value.noInsulation');
  return t(lang, 'export.value.cm', { value: luxeebNumber(cm, Number.isInteger(cm) ? 0 : 1) });
}

/** Générateur de chauffage en clair, avec l'année de l'installation si elle est connue. */
export function generatorText(lang: Lang, project: Project): string | null {
  const a = project.answers;
  const generator = enumText(lang, 'generator', a.heatGenerator);
  if (generator === null) return null;
  const year = integerText(a.heatGeneratorYear);
  return year === null ? generator : t(lang, 'export.value.generatorYear', { generator, year });
}

/** Une donnée du projet, telle qu'elle figure dans le CSV et le dossier. */
export interface ProjectFact {
  key: string;
  label: string;
  /** Valeur lisible ; chaîne vide si elle n'est pas renseignée. */
  value: string;
  /** 'user' quand l'expert a répondu, 'default' pour une hypothèse par défaut, null si rien n'est renseigné. */
  from: Provenance | null;
}

/** Toutes les réponses de l'expert, dans l'ordre de la saisie LuxEeB-Tool (projet, enveloppe, installations). */
export function projectFacts(project: Project, lang: Lang): ProjectFact[] {
  const a = project.answers;
  const P = LUXEEB_PROJECT;
  const facts: ProjectFact[] = [];
  const add = (key: string, label: string, value: string | null, from: Provenance = 'user'): void => {
    const text = value === null ? '' : cleanText(value);
    facts.push({ key, label, value: text, from: text ? from : null });
  };

  add('name', termLabel(lang, P.designation, 'export.tr.designation'), a.projectName);
  add('street', termLabel(lang, P.street, 'export.tr.street'), a.street);
  add('postcode', termLabel(lang, P.postcodeLocality, 'export.tr.postcode'), a.postcode);
  add('locality', termLabel(lang, P.postcodeLocality, 'export.tr.locality'), a.locality);
  add('buildingType', termLabel(lang, P.buildingType, 'export.tr.buildingType'), enumText(lang, 'buildingType', a.buildingType));
  add('dwellings', termLabel(lang, P.dwellings, 'export.tr.dwellings'), integerText(a.dwellings));
  add('occasion', termLabel(lang, P.occasion, 'export.tr.occasion'), enumText(lang, 'occasion', a.occasion));
  add('yearBuilt', termLabel(lang, P.yearBuilt, 'export.tr.yearBuilt'), integerText(a.yearBuilt));
  add('insulationWalls', t(lang, 'export.label.insulationWalls'), insulationText(lang, a.insulationWallsCm));
  add('insulationRoof', t(lang, 'export.label.insulationRoof'), insulationText(lang, a.insulationRoofCm));
  add('insulationFloor', t(lang, 'export.label.insulationFloor'), insulationText(lang, a.insulationFloorCm));
  add('windowGeneration', t(lang, 'export.label.windowGeneration'), enumText(lang, 'windowGeneration', a.windowGeneration));
  add('heating', t(lang, 'export.fact.heating'), generatorText(lang, project));
  add('emission', t(lang, 'export.fact.emission'), enumText(lang, 'emission', a.heatEmission));
  add('hotWater', t(lang, 'export.fact.hotWater'), enumText(lang, 'hotWater', a.hotWater));
  add('ventilation', t(lang, 'export.fact.ventilation'), enumText(lang, 'ventilation', a.ventilation));
  if (a.n50 === null || !Number.isFinite(a.n50)) {
    // null = pas de test (contrat) : c'est une hypothèse par défaut tant que l'expert ne l'a pas confirmée.
    add('n50', t(lang, 'export.fact.n50'), t(lang, 'export.value.noTest'), 'default');
  } else {
    add('n50', t(lang, 'export.fact.n50'), `${luxeebNumber(a.n50)} 1/h`);
  }
  add('solarThermal', t(lang, 'export.fact.solarThermal'), yesNoText(lang, a.solarThermal));
  add('photovoltaic', t(lang, 'export.label.photovoltaic'), yesNoText(lang, a.photovoltaic));
  return facts;
}
