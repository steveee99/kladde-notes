import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { advanceRun, normalizeProcess, serializeRun, startRun, type ProcessModel, type ProcessRun } from '@kladde/shared';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteStore } from '../src/NoteStore';
import { GroupStore } from '../src/GroupStore';
import { NotificationStore } from '../src/NotificationStore';
import { ProcessActions } from '../src/process/ProcessActions';

// Stage scripts only write actions into the run; the server carries out notifications and new notes once, as the
// person who saved the run, inside the run's space and only towards people who can see it

const db = openDatabase(':memory:');
const cipher = new DataCipher(crypto.randomBytes(32));
const users = new UserStore(db);
let actions: ProcessActions;
const notes = new NoteStore(db, cipher, (e) => actions?.onNoteChange(e));
const notifications = new NotificationStore(db, cipher, users);
actions = new ProcessActions({ db, cipher, notes, users, notifications });
const groups = new GroupStore(db);
const anna = users.createUser('anna');
const ben = users.createUser('ben');
const cara = users.createUser('cara');
afterAll(() => db.close());

const settings = (userId: string, extra: Record<string, unknown> = {}) => ({
  id: `syssettings-${userId}`,
  baseVersion: notes.ownedNotes(userId).find((n) => n.id === `syssettings-${userId}`)?.version ?? 0,
  path: '.kladde/settings.json',
  content: JSON.stringify({ features: { cockpit: { enabled: true } }, ...extra }),
  deleted: false,
  createdAt: 1,
  updatedAt: Date.now(),
});
notes.push(anna.id, [settings(anna.id, { templates: [{ id: 'tpl1', label: 'Testprotokoll', folder: '', content: '# {{title}}\n\n- [ ] Fälle durchgehen\n' }] })]);
notes.push(ben.id, [settings(ben.id)]);

const model: ProcessModel = normalizeProcess({
  key: 'test',
  title: 'Test',
  stages: [
    { id: 'start', title: 'Start', steps: [], next: [{ to: 'test' }] },
    {
      id: 'test',
      title: 'Test',
      onEnter: ['protokoll = note("Tests/{{run.ticket}} Protokoll", "Testprotokoll")', 'notify("all", "Bitte testen: {{run.title}}")', 'notify("@cara @niemand", "Hallo")', 'log("Test begonnen")'],
      steps: [],
      next: [{ to: 'ende' }],
    },
    { id: 'ende', kind: 'end', title: 'Ende' },
  ],
})!;
const all = new Map([[model.key, model]]);

let version = 0;
function save(userId: string, noteId: string, run: ProcessRun, group?: string) {
  const [r] = notes.push(userId, [{ id: noteId, baseVersion: version, path: `_process-run-${noteId.padEnd(8, '0')}.md`, content: serializeRun(run), deleted: false, createdAt: 1, updatedAt: Date.now(), ...(group ? { group } : {}) }]);
  expect(r.status).toBe('ok');
  version = r.version;
}

describe('process actions', () => {
  it('creates the note from the template, notifies the people who see the run, once', async () => {
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'editor');
    const id = 'aaaaaaaa1111';
    let run = startRun(model, all, { title: 'Login', ticket: 'ABC-1', target: 'main', repos: [] }, { by: 'anna', now: Date.now() });
    version = 0;
    save(anna.id, id, run, g.id);
    run = advanceRun(run, all, {}, { by: 'anna', now: Date.now() });
    expect(run.vars.protokoll).toBe('Tests/ABC-1 Protokoll');
    save(anna.id, id, run, g.id);
    await actions.idle();
    const created = notes.groupNotes(anna.id).find((n) => n.path === 'Tests/ABC-1 Protokoll.md');
    expect(created?.content).toContain('# ABC-1 Protokoll');
    expect(created?.content).toContain('Fälle durchgehen');
    const forBen = notifications.list(ben.id).items;
    expect(forBen).toMatchObject([{ kind: 'process', noteId: id, path: 'Login', text: 'Bitte testen: Login' }]);
    // anna moved the run herself, cara cannot see it
    expect(notifications.list(anna.id).items).toEqual([]);
    expect(notifications.list(cara.id).items).toEqual([]);
    const outcomes = actions.outcomes(id);
    expect(outcomes.map((o) => o.status)).toEqual(['done', 'done', 'failed']);
    expect(outcomes[0]).toMatchObject({ detail: 'Team/Tests/ABC-1 Protokoll', noteId: created!.id });
    expect(outcomes[2].detail).toContain('Nicht erreicht: @cara, @niemand');
    // Saving the run again does nothing twice
    save(ben.id, id, { ...run, title: 'Login 2' }, g.id);
    await actions.idle();
    expect(notifications.list(ben.id).items).toHaveLength(1);
    expect(notes.groupNotes(anna.id).filter((n) => n.path.startsWith('Tests/'))).toHaveLength(1);
  });

  it('leaves an existing note alone and skips old actions', async () => {
    const id = 'bbbbbbbb2222';
    const now = Date.now();
    notes.push(anna.id, [{ id: 'existing0001', baseVersion: 0, path: 'Tests/X-1 Protokoll.md', content: 'schon da', deleted: false, createdAt: 1, updatedAt: now }]);
    let run = startRun(model, all, { title: 'X', ticket: 'X-1', target: 'main', repos: [] }, { by: 'anna', now });
    run = advanceRun(run, all, {}, { by: 'anna', now });
    run.actions.push({ id: 'old-1', kind: 'notify', stage: 'test', on: 'enter', at: now - 30 * 86_400_000, by: 'anna', to: 'me', text: 'alt' });
    version = 0;
    save(anna.id, id, run);
    await actions.idle();
    expect(notes.ownedNotes(anna.id).find((n) => n.id === 'existing0001')?.content).toBe('schon da');
    const outcomes = actions.outcomes(id);
    expect(outcomes[0]).toMatchObject({ status: 'skipped', noteId: 'existing0001' });
    expect(outcomes.some((o) => o.id === 'old-1')).toBe(false);
    expect(notifications.list(anna.id).items).toEqual([]);
  });
});
