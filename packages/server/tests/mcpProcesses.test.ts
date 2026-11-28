import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { exampleProcesses, isProcessModelPath, isProcessRunPath, parseProcessNote, parseRunNote, serializeProcess, type ProcessModel } from '@kladde/shared';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteStore } from '../src/NoteStore';
import { GroupStore } from '../src/GroupStore';
import { handleMessage } from '../src/mcp/protocol';

// MCP tools for guided processes: assistants create and extend models through the same checks and versioning as the
// app, and start and move runs; live checks stay with the app

const db = openDatabase(':memory:');
const users = new UserStore(db);
const notes = new NoteStore(db, new DataCipher(crypto.randomBytes(32)));
const groups = new GroupStore(db);
const anna = users.createUser('anna');
const ben = users.createUser('ben');

const settings = (userId: string, cockpit: boolean) => ({
  id: `syssettings-${userId}`,
  baseVersion: notes.ownedNotes(userId).find((n) => n.id === `syssettings-${userId}`)?.version ?? 0,
  path: '.kladde/settings.json',
  content: JSON.stringify({ features: { cockpit: { enabled: cockpit } } }),
  deleted: false,
  createdAt: 1,
  updatedAt: Date.now(),
});

let id = 0;
async function call(userId: string, name: string, args: Record<string, unknown> = {}, canWrite = true) {
  const answer = (await handleMessage({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, { userId, canWrite, notes, agent: 'claude' })) as {
    result: { isError?: boolean; content: { text: string }[]; structuredContent?: any };
  };
  return answer.result;
}
const ok = async (userId: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await call(userId, name, args);
  if (r.isError) throw new Error(r.content[0].text);
  return r.structuredContent;
};
const models = (userId: string) => notes.ownedNotes(userId).filter((n) => isProcessModelPath(n.path));

beforeAll(() => {
  notes.push(anna.id, [settings(anna.id, true)]);
  notes.push(ben.id, [settings(ben.id, false)]);
  const [waterfall, bugfix] = exampleProcesses('de');
  const now = Date.now();
  notes.push(anna.id, [
    { id: 'model-bugfix', baseVersion: 0, path: '_process-0b1c2d3e-0001.md', content: serializeProcess(bugfix), deleted: false, createdAt: now, updatedAt: now },
    { id: 'model-waterfall', baseVersion: 0, path: '_process-0b1c2d3e-0002.md', content: serializeProcess(waterfall), deleted: false, createdAt: now + 1, updatedAt: now },
  ]);
});
afterAll(() => db.close());

describe('process tools', () => {
  it('need the cockpit and are listed only for writers when they write', async () => {
    expect((await call(ben.id, 'process_list')).content[0].text).toContain('Cockpit');
    const list = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { userId: anna.id, canWrite: false, notes })) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name).filter((n) => n.startsWith('process_'));
    expect(names).toEqual(['process_guide', 'process_list', 'process_read']);
    const init = (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, { userId: anna.id, canWrite: true, notes })) as { result: { instructions: string } };
    expect(init.result.instructions).toContain('process_guide');
  });

  it('explains the format and lists and reads models', async () => {
    expect((await ok(anna.id, 'process_guide')).format).toContain('"kind"');
    const list = await ok(anna.id, 'process_list');
    expect(list.models.map((m: { key: string }) => m.key)).toEqual(['fehlerbehebung', 'wasserfall']);
    const read = await ok(anna.id, 'process_read', { model: 'Wasserfall-Entwicklung' });
    expect(read.model.stages.find((s: { id: string }) => s.id === 'fehler').process).toBe('fehlerbehebung');
  });

  it('creates a model, reports problems and refuses them unless accepted', async () => {
    const broken = { title: 'Hotfix', stages: [{ id: 'a', steps: [{ id: 'x', kind: 'link', label: 'ohne var' }], next: [{ to: 'nirgends' }] }] };
    const refused = await call(anna.id, 'process_save', { model: broken });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('ein Verweis braucht "var"');
    expect(refused.content[0].text).toContain('führt ins Leere');
    expect(refused.content[0].text).toContain('kind": "end"');
    expect(models(anna.id)).toHaveLength(2);

    const good = {
      key: 'hotfix',
      title: 'Hotfix',
      branchPrefix: 'hotfix',
      stages: [
        { id: 'fix', title: 'Fix', steps: [{ id: 'f1', kind: 'task', label: 'Fix gebaut' }, { id: 'f2', kind: 'branch', label: 'Branch da' }], next: [{ to: 'sub' }] },
        { id: 'sub', kind: 'sub', title: 'Bug', process: 'fehlerbehebung', next: [{ to: 'ende' }] },
        { id: 'ende', kind: 'end', title: 'Fertig' },
      ],
    };
    expect(await ok(anna.id, 'process_save', { model: good, dry_run: true })).toMatchObject({ key: 'hotfix', version: 1, created: true, dry_run: true });
    expect(models(anna.id)).toHaveLength(2);
    const saved = await ok(anna.id, 'process_save', { model: JSON.stringify(good) });
    expect(saved).toMatchObject({ key: 'hotfix', version: 1, created: true });
    const note = notes.ownedNotes(anna.id).find((n) => n.id === saved.id)!;
    expect(isProcessModelPath(note.path)).toBe(true);
    expect(parseProcessNote(note.content)?.stages).toHaveLength(3);
  });

  it('extends a model: the version goes up, new steps carry it, unchanged saves keep it', async () => {
    const before = (await ok(anna.id, 'process_read', { model: 'hotfix' })).model as ProcessModel;
    const same = await ok(anna.id, 'process_save', { model: before });
    expect(same).toMatchObject({ version: 1, changed: false, created: false });
    before.stages[0].steps.push({ id: 'f3', kind: 'task', label: 'Security-Review', retro: true } as ProcessModel['stages'][0]['steps'][0]);
    const next = await ok(anna.id, 'process_save', { model: before });
    expect(next).toMatchObject({ version: 2, changed: true, new_steps: ['fix/f3'] });
    const stored = parseProcessNote(notes.ownedNotes(anna.id).find((n) => n.id === next.id)!.content)!;
    expect(stored.stages[0].steps.map((s) => s.since)).toEqual([1, 1, 2]);
    expect(models(anna.id)).toHaveLength(3);
  });

  it('starts a run and moves it through a decision, refusing open steps', async () => {
    const run = await ok(anna.id, 'process_run_start', { model: 'fehlerbehebung', title: 'Falsche Summe', ticket: 'SHOP-9', target: 'release/2.31', repos: ['team/api', 'team/web'] });
    expect(run).toMatchObject({ branch: 'bugfix/SHOP-9-falsche-summe', target: 'release/2.31', repos: ['team/api', 'team/web'], run: { current: { id: 'bug' } } });
    expect(isProcessRunPath(notes.ownedNotes(anna.id).find((n) => n.id === run.id)!.path)).toBe(true);

    const blocked = await call(anna.id, 'process_run_update', { run: 'SHOP-9', action: 'next' });
    expect(blocked.content[0].text).toContain('Noch offen');
    expect((await call(anna.id, 'process_run_update', { run: run.id, action: 'link', step: 'b1', value: 'javascript:alert(1)' })).isError).toBe(true);
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'link', step: 'b1', value: 'https://jira.example.com/browse/SHOP-9' });
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'tick', step: 'b2' });
    let now = await ok(anna.id, 'process_run_update', { run: run.id, action: 'next' });
    expect(now.run.current).toMatchObject({ id: 'schwere', kind: 'choice' });
    expect((await call(anna.id, 'process_run_update', { run: run.id, action: 'next' })).content[0].text).toContain('Option');
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'pick', value: 'normal' });
    now = await ok(anna.id, 'process_run_update', { run: run.id, action: 'next' });
    expect(now.run.current.id).toBe('umsetzung');
    expect(now.run.ahead[0]).toBe('Hotfix-Freigabe (entfällt)');

    // Branch and merge request are checked live in the app: only with force, which the history keeps
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'tick', step: 'f3' });
    expect((await call(anna.id, 'process_run_update', { run: run.id, action: 'next' })).content[0].text).toContain('live');
    now = await ok(anna.id, 'process_run_update', { run: run.id, action: 'next', force: true });
    expect(now.run.current.id).toBe('abnahme');
    const stored = parseRunNote(notes.ownedNotes(anna.id).find((n) => n.id === run.id)!.content)!;
    expect(stored.hist.find((h) => h.stage === 'umsetzung')).toMatchObject({ forced: true, by: 'claude' });
    expect(stored.hist.find((h) => h.stage === 'hotfix')).toMatchObject({ skipped: true });

    now = await ok(anna.id, 'process_run_update', { run: run.id, action: 'back', value: 'umsetzung' });
    expect(now.run.current.id).toBe('umsetzung');
    expect(now.run.current.steps.find((s: { id: string }) => s.id === 'f3').done).toBe(false);
  });

  it('runs a sub-workflow and finishes a run, which then keeps its model', async () => {
    const run = await ok(anna.id, 'process_run_start', { model: 'hotfix', title: 'Login kaputt', target: 'main', repos: ['team/api'] });
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'tick', step: 'f1' });
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'tick', step: 'f3' });
    let now = await ok(anna.id, 'process_run_update', { run: run.id, action: 'next', force: true });
    expect(now.sub_workflow).toMatchObject({ model: { key: 'fehlerbehebung' }, current: { id: 'bug' } });
    // In a sub-workflow, the merge stage is skipped
    for (const step of ['b2']) await ok(anna.id, 'process_run_update', { run: run.id, action: 'tick', step });
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'link', step: 'b1', value: 'https://jira.example.com/browse/SHOP-10' });
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'next' });
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'pick', value: 'normal' });
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'next' });
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'next', force: true });
    await ok(anna.id, 'process_run_update', { run: run.id, action: 'tick', step: 'n1' });
    now = await ok(anna.id, 'process_run_update', { run: run.id, action: 'next' });
    expect(now.sub_workflow).toBeUndefined();
    expect(now.finished_sub_workflows).toMatchObject([{ model: 'fehlerbehebung', end: 'behoben', variables: { bug: 'https://jira.example.com/browse/SHOP-10' } }]);
    expect(now.run.current.id).toBe('ende');
    expect((await call(anna.id, 'process_run_update', { run: run.id, action: 'next' })).content[0].text).toContain('close');
    now = await ok(anna.id, 'process_run_update', { run: run.id, action: 'close' });
    expect(now).toMatchObject({ state: 'done', frozen_on_version: 2 });
    expect((await call(anna.id, 'process_run_update', { run: run.id, action: 'tick', step: 'f1' })).content[0].text).toContain('abgeschlossen');
    expect((await ok(anna.id, 'process_list', { state: 'done' })).runs.map((r: { title: string }) => r.title)).toEqual(['Login kaputt']);
  });

  it('works in a group only as owner or editor', async () => {
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'reader');
    expect(await ok(anna.id, 'process_save', { model: exampleProcesses('de')[1], group: 'Team' })).toMatchObject({ created: true });
    notes.push(ben.id, [settings(ben.id, true)]);
    const list = await ok(ben.id, 'process_list');
    expect(list.models).toMatchObject([{ key: 'fehlerbehebung', group: 'Team', read_only: true }]);
    const refused = await call(ben.id, 'process_run_start', { model: 'fehlerbehebung', group: 'Team', title: 'X', target: 'main', repos: ['a/b'] });
    expect(refused.content[0].text).toContain('nur lesen');
  });
});
