import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { NotePerson, NotificationList } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { GroupStore } from '../src/GroupStore';
import { NoteStore } from '../src/NoteStore';
import { NotificationStore, type Delivery } from '../src/NotificationStore';
import { UserStore } from '../src/UserStore';

// @mentions with notifications (#69)

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const note = (id: string, content: string, path: string, baseVersion = 0, extra: object = {}) => ({
  id,
  baseVersion,
  path,
  content,
  deleted: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...extra,
});

function setup() {
  const db = openDatabase(':memory:');
  const cipher = new DataCipher(crypto.randomBytes(32));
  const users = new UserStore(db);
  const delivered: { userId: string; d: Delivery }[] = [];
  const notifications = new NotificationStore(db, cipher, users, (userId, d) => delivered.push({ userId, d }));
  const notes = new NoteStore(db, cipher, (e) => notifications.mentions(e));
  const groups = new GroupStore(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-mentions-test-'));
  tmpDirs.push(dir);
  const files = new FileStore(db, cipher, dir);
  return { db, users, notes, groups, files, notifications, delivered, anna: users.createUser('anna'), ben: users.createUser('ben'), cleo: users.createUser('cleo') };
}

describe('mentions (#69)', () => {
  it('notifies people newly mentioned who can see the note, with the passage', () => {
    const { db, notes, groups, notifications, delivered, anna, ben, cleo } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'editor');
    notes.push(anna.id, [note('mention-note-01', '# Plan\n\nBitte prüfen @ben und @cleo und @anna', 'Plan.md', 0, { group: g.id })]);
    // Cleo cannot see the note, Anna wrote it herself
    expect(notifications.list(cleo.id).items).toEqual([]);
    expect(notifications.list(anna.id).items).toEqual([]);
    const list = notifications.list(ben.id);
    expect(list.unread).toBe(1);
    expect(list.items[0]).toMatchObject({ kind: 'mention', actor: 'anna', noteId: 'mention-note-01', path: 'Plan.md', line: 2, text: 'Bitte prüfen @ben und @cleo und @anna', read: false });
    expect(delivered).toEqual([{ userId: ben.id, d: { kind: 'mention', actor: 'anna', name: 'Plan', url: '/n/mention-note-01?line=3' } }]);
    // Editing elsewhere does not mention Ben again
    notes.push(anna.id, [note('mention-note-01', '# Plan\n\nBitte prüfen @ben und @cleo und @anna\nNoch was', 'Plan.md', 1)]);
    expect(notifications.list(ben.id).items).toHaveLength(1);
    notifications.markRead(ben.id, { noteId: 'mention-note-01' });
    expect(notifications.list(ben.id).unread).toBe(0);
    const raw = db.prepare('SELECT payload FROM notifications').all() as { payload: Uint8Array }[];
    expect(raw.some((r) => Buffer.from(r.payload).toString('latin1').includes('prüfen'))).toBe(false);
  });
});

describe('mentions API (#69)', () => {
  const ctx = setup();
  const { users, notes, files, anna, ben } = ctx;
  const annaCookie = `kladde_session=${users.createSession(anna.id)}`;
  const benCookie = `kladde_session=${users.createSession(ben.id)}`;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use('/api', (req, res, next) => (req.path === '/sync' ? next() : express.json({ limit: '256kb' })(req, res, next)));
    app.use('/api', apiRouter(users, notes, files, new LiveUpdates(), { groups: ctx.groups, notifications: ctx.notifications }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  const call = (c: string, url: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${url}`, { method, headers: { Cookie: c, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  it('lists the people of a note and the notifications, and marks them read', async () => {
    notes.push(anna.id, [note('api-mention-01', 'Privat', 'Privat.md')]);
    expect(await (await call(annaCookie, '/notes/api-mention-01/people')).json()).toEqual([{ username: 'anna', avatarUrl: null }]);
    expect((await call(benCookie, '/notes/api-mention-01/people')).status).toBe(404);
    // Mentioning Ben in a private note does not reach him
    notes.push(anna.id, [note('api-mention-01', 'Privat @ben', 'Privat.md', 1)]);
    expect(((await (await call(benCookie, '/notifications')).json()) as NotificationList).items).toEqual([]);
    await call(annaCookie, '/notes/api-mention-01/shares', 'PUT', { username: 'ben', canWrite: false });
    expect(((await (await call(annaCookie, '/notes/api-mention-01/people')).json()) as NotePerson[]).map((p) => p.username)).toEqual(['anna', 'ben']);
    notes.push(anna.id, [note('api-mention-01', 'Privat @ben\n\n@ben schau mal', 'Privat.md', 2)]);
    // Ben was already mentioned in the previous text: no new notification
    expect(((await (await call(benCookie, '/notifications')).json()) as NotificationList).items).toEqual([]);
    // Taken out and written again, the mention counts as new
    notes.push(anna.id, [note('api-mention-01', 'Neu', 'Privat.md', 3)]);
    notes.push(anna.id, [note('api-mention-01', 'Neu: @Ben', 'Privat.md', 4)]);
    notes.push(anna.id, [note('api-mention-01', 'x', 'Privat.md', 5)]);
    notes.push(anna.id, [note('api-mention-01', 'wieder @ben', 'Privat.md', 6)]);
    const list = (await (await call(benCookie, '/notifications')).json()) as NotificationList;
    expect(list.items.map((i) => i.text)).toEqual(['wieder @ben', 'Neu: @Ben']);
    expect(list.unread).toBe(2);
    expect(await (await call(benCookie, '/notifications/read', 'POST', { ids: [list.items[1].id] })).json()).toEqual({ unread: 1 });
    expect(await (await call(benCookie, '/notifications/read', 'POST', {})).json()).toEqual({ unread: 0 });
  });

  it('tells people they were added to a group, once', async () => {
    const g = ctx.groups.create(anna.id, 'Verein');
    expect((await call(annaCookie, `/groups/${g.id}/members`, 'PUT', { username: 'ben', role: 'editor' })).status).toBe(200);
    // A new role is no news
    await call(annaCookie, `/groups/${g.id}/members`, 'PUT', { username: 'ben', role: 'reader' });
    const list = (await (await call(benCookie, '/notifications')).json()) as NotificationList;
    const added = list.items.filter((i) => i.kind === 'group_added');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ actor: 'anna', path: 'Verein', text: 'editor', groupId: g.id, noteId: '', read: false });
    expect(ctx.delivered.at(-1)).toEqual({ userId: ben.id, d: { kind: 'group_added', actor: 'anna', name: 'Verein', url: `/groups/${g.id}` } });
    // Anna added nobody but Ben
    expect(((await (await call(annaCookie, '/notifications')).json()) as NotificationList).items.filter((i) => i.kind === 'group_added')).toEqual([]);
  });

  it('pages through the notifications', async () => {
    for (let i = 0; i < 12; i++) ctx.notifications.add({ userId: anna.id, kind: 'comment', noteId: 'api-mention-01', actorId: ben.id, path: 'Privat.md', text: `c${i}` }, 1_000 + i);
    const first = (await (await call(annaCookie, '/notifications?limit=5')).json()) as NotificationList;
    expect(first.items.map((i) => i.text)).toEqual(['c11', 'c10', 'c9', 'c8', 'c7']);
    expect(first.next).toBeTruthy();
    // One arriving in between does not shift the next page
    ctx.notifications.add({ userId: anna.id, kind: 'comment', noteId: 'api-mention-01', actorId: ben.id, path: 'Privat.md', text: 'new' }, 5_000);
    const second = (await (await call(annaCookie, `/notifications?limit=5&before=${first.next}`)).json()) as NotificationList;
    expect(second.items.map((i) => i.text)).toEqual(['c6', 'c5', 'c4', 'c3', 'c2']);
    const third = (await (await call(annaCookie, `/notifications?limit=5&before=${second.next}`)).json()) as NotificationList;
    expect(third.items.map((i) => i.text)).toEqual(['c1', 'c0']);
    expect(third.next).toBeNull();
  });
});
