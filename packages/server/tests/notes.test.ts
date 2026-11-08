import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteStore, NoteChangeEvent } from '../src/NoteStore';

function setup() {
  const db = openDatabase(':memory:');
  const users = new UserStore(db);
  const events: NoteChangeEvent[] = [];
  const notes = new NoteStore(db, new DataCipher(crypto.randomBytes(32)), (e) => events.push(e));
  const anna = users.createUser('anna');
  const ben = users.createUser('ben');
  return { db, users, notes, anna, ben, events };
}

const change = (id: string, content: string, baseVersion = 0, path = 'Inbox/Test.md') => ({
  id,
  baseVersion,
  path,
  content,
  deleted: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('NoteStore', () => {
  it('stores notes encrypted and syncs them by cursor', () => {
    const { db, notes, anna } = setup();
    expect(notes.push(anna.id, [change('note-0001', 'geheimer Text')])).toEqual([{ id: 'note-0001', status: 'ok', version: 1 }]);
    const raw = db.prepare('SELECT payload FROM notes').get() as { payload: Uint8Array };
    expect(Buffer.from(raw.payload).toString('utf8')).not.toContain('geheim');
    const first = notes.pull(anna.id, 0);
    expect(first.notes.map((n) => n.content)).toEqual(['geheimer Text']);
    expect(notes.pull(anna.id, first.cursor).notes).toHaveLength(0);
  });

  it('reports conflicts on a stale base version', () => {
    const { notes, anna } = setup();
    notes.push(anna.id, [change('note-0001', 'v1')]);
    notes.push(anna.id, [change('note-0001', 'v2', 1)]);
    const [result] = notes.push(anna.id, [change('note-0001', 'v2b', 1)]);
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') expect(result.server.content).toBe('v2');
  });

  it('keeps spaces apart and honours shares', () => {
    const { notes, anna, ben } = setup();
    notes.push(anna.id, [change('note-0001', 'von Anna')]);
    expect(notes.pull(ben.id, 0).notes).toHaveLength(0);
    expect(notes.push(ben.id, [change('note-0001', 'Ben war hier', 1)])[0].status).toBe('forbidden');

    notes.share(anna.id, 'note-0001', ben.id, false);
    const shared = notes.pull(ben.id, 0);
    expect(shared.notes[0]).toMatchObject({ access: 'read', owner: 'anna' });
    expect(notes.push(ben.id, [change('note-0001', 'Ben war hier', 1)])[0].status).toBe('forbidden');

    notes.share(anna.id, 'note-0001', ben.id, true);
    expect(notes.push(ben.id, [change('note-0001', 'Ben war hier', 1, 'Ben/Umbenannt.md')])[0].status).toBe('ok');
    const annaView = notes.pull(anna.id, 0).notes[0];
    expect(annaView).toMatchObject({ content: 'Ben war hier', path: 'Inbox/Test.md' });

    const cursor = notes.pull(ben.id, 0).cursor;
    notes.unshare(anna.id, 'note-0001', ben.id);
    expect(notes.pull(ben.id, cursor).revoked).toEqual(['note-0001']);
  });

  it('public links are read-only and can be withdrawn', () => {
    const { notes, anna } = setup();
    notes.push(anna.id, [change('note-0001', 'öffentlich')]);
    const token = notes.setPublic(anna.id, 'note-0001', true)!;
    expect(notes.publicNote(token)).toMatchObject({ content: 'öffentlich', owner: 'anna' });
    notes.setPublic(anna.id, 'note-0001', false);
    expect(notes.publicNote(token)).toBeNull();
  });

  it('rejects path traversal', () => {
    const { notes, anna } = setup();
    notes.push(anna.id, [change('note-0001', 'x', 0, '../../etc/passwd')]);
    expect(notes.pull(anna.id, 0).notes[0].path).toBe('etc/passwd');
  });
});

describe('UserStore', () => {
  it('invites work once', () => {
    const { users } = setup();
    const invite = users.createInvite('Test');
    const code = users.checkInvite(invite.code.toLowerCase());
    users.useInvite(code, users.createUser('carla').id);
    expect(() => users.checkInvite(invite.code)).toThrow();
  });

  it('device links expire and sessions resolve users', () => {
    const { users, anna } = setup();
    const link = users.createDeviceLink(anna.id, 0);
    expect(() => users.userForDeviceLink(link.code, 16 * 60 * 1000)).toThrow();
    const token = users.createSession(anna.id);
    expect(users.userForSession(token)?.username).toBe('anna');
    users.setBanned(anna.id, true);
    expect(users.userForSession(token)).toBeNull();
  });
});
