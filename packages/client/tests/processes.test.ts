// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeNode, advanceRun, isHiddenPath, parseProcessNote, parseRunNote, pickOption, startRun } from '@kladde/shared';
import { startSyncServer } from './support/syncServer';

// Guided processes: models and runs are hidden notes of the own space that sync like any note; the examples are made
// once per account, even after the user deleted them

let s: Awaited<ReturnType<typeof startSyncServer>>;
beforeEach(async () => {
  s = await startSyncServer();
});
afterEach(() => s.stop());

describe('process notes on the device', () => {
  it('makes the two examples once, as hidden notes, and not again after they were deleted', async () => {
    const a = await s.device();
    const p = await import('../src/data/processes');
    await p.ensureExampleProcesses('de');
    const models = p.processModels();
    // Sorted by title for the list
    expect(models.map((m) => m.model.key)).toEqual(['fehlerbehebung', 'wasserfall']);
    expect(models.every((m) => isHiddenPath(a.vault.get(m.noteId)!.path))).toBe(true);
    await a.vault.sync();
    for (const m of models) expect(parseProcessNote(s.serverNote(m.noteId)!.content)?.key).toBe(m.model.key);

    for (const m of models) await p.deleteProcessNote(m.noteId);
    await p.ensureExampleProcesses('de');
    expect(p.processModels()).toEqual([]);
  });

  it('saves runs and raises the model version on edits, new steps carry it', async () => {
    const a = await s.device();
    const p = await import('../src/data/processes');
    await p.ensureExampleProcesses('en');
    const bug = p.processModels().find((m) => m.model.key === 'fehlerbehebung')!;
    const models = p.modelsOfSpace(undefined);
    let run = startRun(bug.model, models, { title: 'Wrong total', ticket: 'SHOP-9', target: 'release/2.31', repos: ['team/api'] }, { by: 'anna', now: 1 });
    expect(run.branch).toBe('bugfix/SHOP-9-wrong-total');
    const id = await p.createRun(run);
    expect(p.processRuns().map((r) => r.run.title)).toEqual(['Wrong total']);

    run = advanceRun(run, models, { forced: true }, { by: 'anna', now: 2 });
    run = advanceRun(pickOption(run, models, 'kritisch'), models, {}, { by: 'anna', now: 3 });
    await p.saveRun(id, run);
    expect(activeNode(p.processRuns()[0].run).stage).toBe('umsetzung');

    const edited = structuredClone(bug.model);
    edited.stages[0].steps.push({ ...edited.stages[0].steps[1], id: 'b3', label: 'Logs attached', retro: true });
    const saved = await p.saveModel(bug.noteId, edited);
    expect(saved.version).toBe(2);
    expect(saved.stages[0].steps.find((x) => x.id === 'b3')?.since).toBe(2);
    await a.vault.sync();
    expect(parseRunNote(s.serverNote(id)!.content)).toMatchObject({ ticket: 'SHOP-9', stage: 'umsetzung', vars: { schwere: 'kritisch' } });
  });
});
