/**
 * Enregistrement automatique : un projet écrit par une version précédente (format 1) se relit, se réenregistre au
 * format 2 et donne le même relevé. La clé de stockage ne change pas (c'est un emplacement, pas un format).
 */
import { describe, expect, it } from 'vitest';
import { deriveSheets } from '../../../src/engine';
import { STORAGE_KEYS, loadWorkspace, memoryStorage, saveWorkspace } from '../../../src/ui/shell/autosave';
import { emptyMarks } from '../../../src/ui/shell/types';
import { makeProject } from '../../export/fixtures';

describe('enregistrement automatique — projet de format 1', () => {
  it('se relit, se réenregistre en format 2, relevé inchangé', () => {
    const original = makeProject();
    const v1 = JSON.stringify({ app: 'Plan2CPE', version: 1, model: original.model, answers: original.answers });
    const storage = memoryStorage({ [STORAGE_KEYS.project]: v1 });

    const loaded = loadWorkspace(storage);
    expect(loaded).not.toBeNull();
    expect(loaded!.project.version).toBe(2);
    expect(loaded!.project.model).toEqual(original.model);
    expect(loaded!.project.answers).toEqual(original.answers);

    expect(saveWorkspace(storage, { project: loaded!.project, marks: emptyMarks() }).ok).toBe(true);
    const written = JSON.parse(storage.dump()[STORAGE_KEYS.project]!) as { version: number };
    expect(written.version).toBe(2);
    expect(STORAGE_KEYS.project).toBe('plan2cpe.project.v1');

    const again = loadWorkspace(storage)!;
    expect(deriveSheets(again.project, 'fr')).toEqual(deriveSheets(original, 'fr'));
  });
});
