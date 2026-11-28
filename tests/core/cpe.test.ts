/**
 * Types du dossier CPE (core/cpe) : correspondance entre types d'éléments LuxEeB et catégories du modèle.
 */
import { describe, expect, it } from 'vitest';
import { LUXEEB_ELEMENT_LABEL, categoryOfLuxeebType, luxeebTypeOf, type LuxeebElementType } from '../../src/core/cpe';

describe('types d’éléments LuxEeB', () => {
  it('catégorie et milieu d’un type redonnent ce type (aller-retour)', () => {
    for (const type of Object.keys(LUXEEB_ELEMENT_LABEL) as LuxeebElementType[]) {
      const { category, boundary } = categoryOfLuxeebType(type);
      expect(luxeebTypeOf(category, boundary), type).toBe(type);
    }
  });
});
