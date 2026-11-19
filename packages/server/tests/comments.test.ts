import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CommentThread, CommentThreadList, NotificationList } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { CommentStore } from '../src/CommentStore';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { GroupStore } from '../src/GroupStore';
import { NoteStore } from '../src/NoteStore';
import { NotificationStore } from '../src/NotificationStore';
import { UserStore } from '../src/UserStore';

// Comments on passages of notes (#68)

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

describe('comments API (#68)', () => {
  const db = openDatabase(':memory:');
  const cipher = new DataCipher(crypto.randomBytes(32));
  const users = new UserStore(db);
  const notifications = new NotificationStore(db, cipher, users);
  const notes = new NoteStore(db, cipher, (e) => notifications.mentions(e));
  const comments = new CommentStore(db, cipher, users);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-comments-test-'));
  tmpDirs.push(dir);
  const files = new FileStore(db, cipher, dir);
  const anna = users.createUser('anna');
  const ben = users.createUser('ben');
  users.createUser('cleo');
  const cookie = (name: string) => `kladde_session=${users.createSession(users.findByUsername(name)!.id)}`;
  const live = new LiveUpdates();
  const sent: { event: string; data: unknown }[] = [];
  live.send = (_ids, event, data) => void sent.push({ event, data });
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use('/api', (req, res, next) => (req.path === '/sync' ? next() : express.json({ limit: '256kb' })(req, res, next)));
    app.use('/api', apiRouter(users, notes, files, live, { groups: new GroupStore(db), notifications, comments }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  const call = (who: string, url: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${url}`, { method, headers: { Cookie: cookie(who), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const anchor = { quote: 'Termin', prefix: 'Der ', suffix: ' ist am Montag', pos: 4 };

  it('lets everybody who sees a note comment, reply and resolve, and notifies the people concerned', async () => {
    notes.push(anna.id, [note('comment-note-01', 'Der Termin ist am Montag', 'Plan.md')]);
    await call('anna', '/notes/comment-note-01/shares', 'PUT', { username: 'ben', canWrite: false });
    // Cleo cannot see the note
    expect((await call('cleo', '/notes/comment-note-01/comments')).status).toBe(404);
    expect((await call('cleo', '/notes/comment-note-01/comments', 'POST', { anchor, text: 'x' })).status).toBe(404);
    expect((await call('ben', '/notes/comment-note-01/comments', 'POST', { anchor, text: '   ' })).status).toBe(400);
    expect((await call('ben', '/notes/comment-note-01/comments', 'POST', { anchor: { quote: '' }, text: 'x' })).status).toBe(400);

    // A reader comments: the owner hears about it
    const thread = (await (await call('ben', '/notes/comment-note-01/comments', 'POST', { anchor, text: 'Welcher Montag?' })).json()) as CommentThread;
    expect(thread).toMatchObject({ noteId: 'comment-note-01', anchor, resolved: false, comments: [{ author: 'ben', text: 'Welcher Montag?' }] });
    expect(sent.at(-1)).toEqual({ event: 'comments', data: { noteId: 'comment-note-01' } });
    let annaList = notifications.list(anna.id);
    expect(annaList.items[0]).toMatchObject({ kind: 'comment', actor: 'ben', noteId: 'comment-note-01', threadId: thread.id, text: 'Welcher Montag?' });

    // Anna answers and mentions Ben: he gets the mention (not a second notification for the reply)
    const replied = (await (await call('anna', `/notes/comment-note-01/comments/${thread.id}/replies`, 'POST', { text: 'Dem 3. – @ben passt das?' })).json()) as CommentThread;
    expect(replied.comments.map((c) => c.author)).toEqual(['ben', 'anna']);
    const benList = notifications.list(ben.id);
    expect(benList.items.map((i) => i.kind)).toEqual(['mention']);

    // Resolving and the next answer that opens it again
    expect(((await (await call('ben', `/notes/comment-note-01/comments/${thread.id}`, 'PATCH', { resolved: true })).json()) as CommentThread)).toMatchObject({ resolved: true, resolvedBy: 'ben' });
    const reopened = (await (await call('ben', `/notes/comment-note-01/comments/${thread.id}/replies`, 'POST', { text: 'Doch noch was' })).json()) as CommentThread;
    expect(reopened.resolved).toBe(false);
    annaList = notifications.list(anna.id);
    expect(annaList.items[0]).toMatchObject({ kind: 'reply', actor: 'ben' });

    // Only the author edits or deletes a comment; the note's owner may delete any
    const own = reopened.comments[2];
    expect((await call('anna', `/notes/comment-note-01/comments/${thread.id}/replies/${own.id}`, 'PUT', { text: 'x' })).status).toBe(403);
    expect(((await (await call('ben', `/notes/comment-note-01/comments/${thread.id}/replies/${own.id}`, 'PUT', { text: 'Doch noch etwas' })).json()) as CommentThread).comments[2]).toMatchObject({ text: 'Doch noch etwas', editedAt: expect.any(Number) });
    expect((await call('ben', `/notes/comment-note-01/comments/${thread.id}/replies/${replied.comments[1].id}`, 'DELETE')).status).toBe(403);
    expect((await call('anna', `/notes/comment-note-01/comments/${thread.id}/replies/${own.id}`, 'DELETE')).status).toBe(200);
    const list = (await (await call('ben', '/notes/comment-note-01/comments')).json()) as CommentThreadList;
    expect(list.threads[0].comments.map((c) => c.text)).toEqual(['Welcher Montag?', 'Dem 3. – @ben passt das?']);

    // Comments are not part of the note, and they are stored encrypted
    const synced = (await (await call('ben', '/sync?since=0')).json()) as { notes: { id: string; content: string }[] };
    expect(synced.notes.find((n) => n.id === 'comment-note-01')?.content).toBe('Der Termin ist am Montag');
    const raw = db.prepare('SELECT payload FROM comment_threads').all() as { payload: Uint8Array }[];
    expect(raw.some((r) => Buffer.from(r.payload).toString('latin1').includes('Montag'))).toBe(false);

    // Deleting the thread: only the note's manager or the one who started it
    expect((await call('anna', `/notes/comment-note-01/comments/${thread.id}`, 'DELETE')).status).toBe(200);
    expect(((await (await call('anna', '/notes/comment-note-01/comments')).json()) as CommentThreadList).threads).toEqual([]);
    expect(((await (await call('ben', '/notifications')).json()) as NotificationList).unread).toBe(1);
  });

  it('removes the threads when the note is purged from the trash', async () => {
    notes.push(anna.id, [note('comment-note-02', 'Text', 'Weg.md')]);
    await call('anna', '/notes/comment-note-02/comments', 'POST', { anchor: { quote: 'Text', prefix: '', suffix: '', pos: 0 }, text: 'hm' });
    notes.push(anna.id, [note('comment-note-02', 'Text', 'Weg.md', 1, { deleted: true })]);
    notes.purge(anna.id, ['comment-note-02']);
    expect(comments.list('comment-note-02')).toEqual([]);
  });
});
