import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { ActivityList, ActivityNews, GroupInfo } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { ActivityStore } from '../src/ActivityStore';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { GroupStore } from '../src/GroupStore';
import { NoteStore } from '../src/NoteStore';
import { UserStore } from '../src/UserStore';

// Activity feed for groups and shared folders (#70)

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
  const activity = new ActivityStore(db, cipher);
  const notes = new NoteStore(db, cipher, (e) => activity.record(e));
  const groups = new GroupStore(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-activity-test-'));
  tmpDirs.push(dir);
  const files = new FileStore(db, cipher, dir);
  return { db, cipher, users, notes, groups, files, activity, anna: users.createUser('anna'), ben: users.createUser('ben'), cleo: users.createUser('cleo') };
}

describe('activity store (#70)', () => {
  it('records changes to notes others see, groups edits per person and hour, and keeps paths encrypted', () => {
    const { db, notes, groups, activity, anna, ben } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'editor');
    notes.push(anna.id, [note('act-note-0001', 'a', 'Plan.md', 0, { group: g.id })]);
    // Anna's own edits right after creating belong to "created"
    notes.push(anna.id, [note('act-note-0001', 'ab', 'Plan.md', 1)]);
    notes.push(ben.id, [note('act-note-0001', 'abc', 'Plan.md', 2)]);
    notes.push(ben.id, [note('act-note-0001', 'abcd', 'Plan.md', 3)]);
    notes.push(ben.id, [note('act-note-0001', 'abcd', 'Archiv/Plan.md', 4)]);
    notes.push(ben.id, [note('act-note-0001', 'abcd', 'Archiv/Plan.md', 5, { deleted: true })]);
    notes.restore(ben.id, ['act-note-0001']);
    // A private note leaves no trace
    notes.push(anna.id, [note('act-private-01', 'geheim', 'Tagebuch.md')]);
    const feed = activity.ofOwner(g.id);
    expect(feed.map((e) => [e.kind, e.actor, e.count, e.path])).toEqual([
      ['restored', 'ben', 1, 'Archiv/Plan.md'],
      ['deleted', 'ben', 1, 'Archiv/Plan.md'],
      ['moved', 'ben', 1, 'Archiv/Plan.md'],
      ['edited', 'ben', 2, 'Plan.md'],
      ['created', 'anna', 1, 'Plan.md'],
    ]);
    expect(feed[2].previousPath).toBe('Plan.md');
    expect(activity.ofOwner(anna.id)).toEqual([]);
    const raw = db.prepare('SELECT payload FROM activity').all() as { payload: Uint8Array }[];
    expect(raw.some((r) => Buffer.from(r.payload).toString('latin1').includes('Plan'))).toBe(false);
  });

  it('lists notes changed by others since the user last opened them', () => {
    const { notes, groups, activity, anna, ben } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'editor');
    notes.push(anna.id, [note('act-news-0001', 'a', 'A.md', 0, { group: g.id }), note('act-news-0002', 'b', 'B.md', 0, { group: g.id })]);
    const can = () => true;
    expect(activity.news(ben.id, can).notes.map((n) => [n.id, n.by]).sort()).toEqual([
      ['act-news-0001', 'anna'],
      ['act-news-0002', 'anna'],
    ]);
    expect(activity.news(anna.id, can).notes).toEqual([]);
    activity.seen(ben.id, 'act-news-0001', Date.now() + 1);
    expect(activity.news(ben.id, can).notes.map((n) => n.id)).toEqual(['act-news-0002']);
    expect(activity.news(ben.id, () => false).notes).toEqual([]);
  });

  it('drops old entries', () => {
    const { notes, groups, activity, anna, ben } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'reader');
    notes.push(anna.id, [note('act-old-00001', 'a', 'A.md', 0, { group: g.id })]);
    activity.prune(Date.now() + 365 * 86_400_000);
    expect(activity.ofOwner(g.id)).toEqual([]);
  });
});

describe('activity API (#70)', () => {
  const ctx = setup();
  const { users, notes, files, anna, ben, cleo } = ctx;
  const cookie = (id: string) => `kladde_session=${users.createSession(id)}`;
  const annaCookie = cookie(anna.id);
  const benCookie = cookie(ben.id);
  const cleoCookie = cookie(cleo.id);
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use('/api', (req, res, next) => (req.path === '/sync' ? next() : express.json({ limit: '256kb' })(req, res, next)));
    app.use('/api', apiRouter(users, notes, files, new LiveUpdates(), { groups: ctx.groups, activity: ctx.activity }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  const call = (c: string, url: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${url}`, { method, headers: { Cookie: c, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  it('shows a group its activity, membership changes included, and nobody else', async () => {
    const group = (await (await call(annaCookie, '/groups', 'POST', { name: 'Reise' })).json()) as GroupInfo;
    await call(annaCookie, `/groups/${group.id}/members`, 'PUT', { username: 'ben', role: 'editor' });
    await call(annaCookie, `/groups/${group.id}/members`, 'PUT', { username: 'ben', role: 'reader' });
    notes.push(anna.id, [note('api-act-0001', 'x', 'Route.md', 0, { group: group.id })]);
    const feed = (await (await call(benCookie, `/activity?group=${group.id}`)).json()) as ActivityList;
    expect(feed.entries.map((e) => [e.kind, e.actor, e.member ?? e.path, e.role ?? null])).toEqual([
      ['created', 'anna', 'Route.md', null],
      ['member_role', 'anna', 'ben', 'reader'],
      ['member_added', 'anna', 'ben', 'editor'],
    ]);
    expect((await call(cleoCookie, `/activity?group=${group.id}`)).status).toBe(404);
    // News for ben until he opens the note
    expect(((await (await call(benCookie, '/activity/news')).json()) as ActivityNews).notes.map((n) => n.id)).toEqual(['api-act-0001']);
    await call(benCookie, '/activity/seen', 'POST', { noteId: 'api-act-0001' });
    expect(((await (await call(benCookie, '/activity/news')).json()) as ActivityNews).notes).toEqual([]);
  });

  it('shows a shared folder its activity to the owner and the recipients only', async () => {
    notes.push(anna.id, [note('api-fold-0001', 'x', 'Projekt/Plan.md'), note('api-fold-0002', 'y', 'Privat/Geheim.md')]);
    await call(annaCookie, '/folders/shares', 'PUT', { folder: 'Projekt', username: 'cleo', canWrite: true });
    notes.push(cleo.id, [note('api-fold-0001', 'xy', 'Projekt/Plan.md', 1)]);
    notes.push(anna.id, [note('api-fold-0002', 'yz', 'Privat/Geheim.md', 1)]);
    const feed = (await (await call(cleoCookie, '/activity?owner=anna&folder=Projekt')).json()) as ActivityList;
    expect(feed.entries.map((e) => [e.kind, e.actor, e.path ?? e.folder])).toEqual([
      ['edited', 'cleo', 'Projekt/Plan.md'],
      ['folder_shared', 'anna', 'Projekt'],
    ]);
    expect((await call(annaCookie, '/activity?owner=anna&folder=Projekt')).status).toBe(200);
    // Slashes around the folder are trimmed without a backtracking regex
    expect((await call(cleoCookie, `/activity?owner=anna&folder=/Projekt${'/'.repeat(5000)}`)).status).toBe(200);
    expect((await call(benCookie, '/activity?owner=anna&folder=Projekt')).status).toBe(404);
    expect((await call(cleoCookie, '/activity?owner=anna&folder=Privat')).status).toBe(404);
  });
});
