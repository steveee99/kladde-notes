import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { PullResponse, PushResult, TrashList } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { NoteStore } from '../src/NoteStore';
import { UserStore } from '../src/UserStore';
import { JobLog } from '../src/admin/JobLog';

// The note, sync, trash, sharing and file routes of api.ts over HTTP (offline mode, without the online indexes)

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const note = (id: string, content: string, notePath: string, baseVersion = 0, extra: object = {}) => ({
  id,
  baseVersion,
  path: notePath,
  content,
  deleted: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...extra,
});

describe('api routes', () => {
  const db = openDatabase(':memory:');
  const cipher = new DataCipher(crypto.randomBytes(32));
  const users = new UserStore(db);
  const notes = new NoteStore(db, cipher);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-api-routes-'));
  tmpDirs.push(dir);
  const files = new FileStore(db, cipher, dir);
  const anna = users.createUser('anna');
  const ben = users.createUser('ben');
  const cookies = new Map<string, string>();
  const cookie = (name: string) => {
    if (!cookies.has(name)) cookies.set(name, `kladde_session=${users.createSession(users.findByUsername(name)!.id)}`);
    return cookies.get(name)!;
  };
  const live = new LiveUpdates();
  const notified: string[][] = [];
  live.notify = (ids) => void notified.push([...ids]);
  const jobs = new JobLog();
  const transcribed: { mime: string; lang?: string }[] = [];
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use('/api', (req, res, next) => (req.path === '/sync' ? next() : express.json({ limit: '256kb' })(req, res, next)));
    app.use(
      '/api',
      apiRouter(users, notes, files, live, {
        jobs,
        trashDays: 14,
        transcriber: async (file, lang) => {
          transcribed.push({ mime: file.mime, lang });
          if (lang === 'xx') throw new Error('Sprache unbekannt');
          return 'Hallo Welt';
        },
      })
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  const call = (who: string | null, url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api${url}`, {
      method,
      headers: { ...(who ? { Cookie: cookie(who) } : {}), 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const push = async (who: string, changes: unknown[]) => ((await (await call(who, '/sync', 'POST', { changes })).json()) as { results: PushResult[] }).results;
  const versionOf = async (who: string, id: string) => ((await (await call(who, '/sync?since=0')).json()) as PullResponse).notes.find((n) => n.id === id)!.version;

  describe('sign-in', () => {
    it('answers 401 without a session', async () => {
      expect((await call(null, '/sync')).status).toBe(401);
      expect((await call(null, '/trash')).status).toBe(401);
    });
  });

  describe('files', () => {
    const data = Buffer.from('0123456789');
    let id = '';
    beforeAll(() => {
      id = files.save(anna.id, 'Sprachnotiz.webm', 'audio/webm', data).id;
    });

    it('serves files sandboxed and without a session', async () => {
      const res = await call(null, `/files/${id}`);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('0123456789');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      expect(res.headers.get('content-disposition')).toContain('Sprachnotiz.webm');
      expect((await call(null, '/files/nicht-da')).status).toBe(404);
    });

    it('answers byte ranges (Safari plays audio only with them)', async () => {
      const range = async (value: string) => {
        const res = await call(null, `/files/${id}`, 'GET', undefined, { Range: value });
        return { status: res.status, range: res.headers.get('content-range'), body: Buffer.from(await res.arrayBuffer()).toString() };
      };
      expect(await range('bytes=2-4')).toEqual({ status: 206, range: 'bytes 2-4/10', body: '234' });
      expect(await range('bytes=7-')).toEqual({ status: 206, range: 'bytes 7-9/10', body: '789' });
      expect(await range('bytes=-3')).toEqual({ status: 206, range: 'bytes 7-9/10', body: '789' });
      expect(await range('bytes=5-100')).toEqual({ status: 206, range: 'bytes 5-9/10', body: '56789' });
      expect((await range('bytes=20-30')).status).toBe(416);
      expect((await range('bytes=6-2')).status).toBe(416);
      // Not a range we understand: the whole file
      expect(await range('bytes=-')).toMatchObject({ status: 200, body: '0123456789' });
    });

    it('transcribes only own audio files and passes errors on', async () => {
      const ok = await call('anna', `/files/${id}/transcribe`, 'POST', { lang: 'de' });
      expect(await ok.json()).toEqual({ text: 'Hallo Welt' });
      expect(transcribed).toEqual([{ mime: 'audio/webm', lang: 'de' }]);
      expect((await call('ben', `/files/${id}/transcribe`, 'POST', {})).status).toBe(404);
      const image = files.save(anna.id, 'Bild.png', 'image/png', Buffer.from([1])).id;
      expect((await call('anna', `/files/${image}/transcribe`, 'POST', {})).status).toBe(404);
      const failed = await call('anna', `/files/${id}/transcribe`, 'POST', { lang: 'xx' });
      expect(failed.status).toBe(502);
      expect((await failed.json()).error).toBe('Sprache unbekannt');
    });
  });

  describe('sync', () => {
    it('pushes, pulls by cursor and logs the sync job', async () => {
      const [result] = await push('anna', [note('api-sync-0001', '# Eins', 'Eins.md')]);
      expect(result.status).toBe('ok');
      const all = (await (await call('anna', '/sync?since=0')).json()) as PullResponse;
      expect(all.notes.map((n) => n.path)).toContain('Eins.md');
      const later = (await (await call('anna', `/sync?since=${all.cursor}`)).json()) as PullResponse;
      expect(later.notes).toEqual([]);
      // Nonsense cursors start from the beginning
      expect(((await (await call('anna', '/sync?since=abc')).json()) as PullResponse).notes.length).toBe(all.notes.length);
      expect(jobs.list().some((j) => j.kind === 'sync' && j.user === 'anna' && j.count === 1)).toBe(true);
      // An empty or broken push changes nothing
      expect(await push('anna', [])).toEqual([]);
      expect((await (await call('anna', '/sync', 'POST', { changes: 'kaputt' })).json()).results).toEqual([]);
    });

    it('sends a light catalog without texts, gzipped when large', async () => {
      const big = 'x'.repeat(2000);
      await push('anna', Array.from({ length: 60 }, (_, i) => note(`api-light-${String(i).padStart(4, '0')}`, `# Notiz ${i} ${big}`, `Viele/Notiz ${i} ${big.slice(0, 40)}.md`)));
      const res = await call('anna', '/sync?since=0&light=1', 'GET', undefined, { 'Accept-Encoding': 'gzip' });
      expect(res.status).toBe(200);
      const pulled = (await res.json()) as PullResponse;
      const entry = pulled.notes.find((n) => n.id === 'api-light-0001')!;
      expect(entry.partial).toBe(true);
      expect(entry.content).toBe('');

      // fetch unpacks on its own: ask raw to see the encoding
      const raw = await new Promise<{ encoding?: string; body: Buffer }>((resolve, reject) => {
        import('http').then(({ get }) =>
          get(`${base}/api/sync?since=0&light=1`, { headers: { Cookie: cookie('anna'), 'Accept-Encoding': 'gzip' } }, (r) => {
            const chunks: Buffer[] = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => resolve({ encoding: r.headers['content-encoding'], body: Buffer.concat(chunks) }));
          }).on('error', reject)
        );
      });
      if (raw.encoding === 'gzip') expect(JSON.parse(zlib.gunzipSync(raw.body).toString()).notes.length).toBe(pulled.notes.length);
      else expect(JSON.parse(raw.body.toString()).notes.length).toBe(pulled.notes.length);
    });

    it('hands out full texts only of notes the user may see', async () => {
      await push('ben', [note('api-ben-0001', 'Bens Geheimnis', 'Ben.md')]);
      const res = await call('anna', '/sync/notes', 'POST', { ids: ['api-sync-0001', 'api-ben-0001', 42] });
      const { notes: list } = (await res.json()) as { notes: { id: string; content: string }[] };
      expect(list.map((n) => n.id)).toEqual(['api-sync-0001']);
      expect(list[0].content).toBe('# Eins');
      expect((await (await call('anna', '/sync/notes', 'POST', {})).json()).notes).toEqual([]);
    });

    it('rewrites links on the server after a rename and checks the input', async () => {
      await push('anna', [note('api-link-0001', 'Siehe [[Alt]]', 'Verweis.md'), note('api-link-0002', '# Alt', 'Alt.md')]);
      const res = await call('anna', '/sync/relink', 'POST', { noteId: 'api-link-0002', oldName: 'Alt', newName: 'Neu' });
      expect((await res.json()).changed).toBeGreaterThanOrEqual(1);
      const pulled = (await (await call('anna', '/sync?since=0')).json()) as PullResponse;
      expect(pulled.notes.find((n) => n.id === 'api-link-0001')!.content).toBe('Siehe [[Neu]]');
      expect((await call('anna', '/sync/relink', 'POST', { noteId: 'api-link-0002', oldName: 'Alt' })).status).toBe(400);
      expect((await call('anna', '/sync/relink', 'POST', { noteId: 'x', oldName: 'a'.repeat(401), newName: 'b' })).status).toBe(400);
    });

    it('answers the online routes with 404 in offline mode', async () => {
      for (const url of ['/online/search?q=x', '/online/semantic?q=x', '/online/backlinks/api-sync-0001', '/online/tasks', '/online/graph']) {
        expect((await call('anna', url)).status).toBe(404);
      }
      expect((await call('anna', '/online/query', 'POST', { src: 'task' })).status).toBe(404);
    });
  });

  describe('presence', () => {
    it('validates device ids and cursor positions', async () => {
      expect((await call('anna', '/presence', 'POST', { clientId: '', noteId: null })).status).toBe(400);
      expect((await call('anna', '/presence', 'POST', { clientId: 'geraet-0001-abcd', noteId: 'api-sync-0001' })).status).toBe(200);
      expect((await call('anna', '/presence/cursor', 'POST', { clientId: 'geraet-0001-abcd', noteId: 'api-sync-0001' })).status).toBe(400);
      expect((await call('anna', '/presence/cursor', 'POST', { clientId: '!', noteId: 'api-sync-0001', anchor: 0, head: 0 })).status).toBe(400);
    });

    it('opens an event stream that greets with the version', async () => {
      const controller = new AbortController();
      const res = await fetch(`${base}/api/events?client=geraet-0001-abcd`, { headers: { Cookie: cookie('anna') }, signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toMatch(/^event: hello\ndata: \{"version":/);
      expect(live.connections).toBeGreaterThan(0);
      controller.abort();
      await reader.cancel().catch(() => undefined);
    });
  });

  describe('trash', () => {
    it('restores a deleted note and purges for good', async () => {
      await push('anna', [note('api-trash-0001', 'Weg damit', 'Papierkorb/Eins.md'), note('api-trash-0002', 'Auch weg', 'Papierkorb/Zwei.md')]);
      await push('anna', [
        { ...note('api-trash-0001', '', 'Papierkorb/Eins.md', await versionOf('anna', 'api-trash-0001')), deleted: true },
        { ...note('api-trash-0002', '', 'Papierkorb/Zwei.md', await versionOf('anna', 'api-trash-0002')), deleted: true },
      ]);
      const list = (await (await call('anna', '/trash')).json()) as TrashList;
      expect(list.retentionDays).toBe(14);
      expect(list.entries.map((e) => e.path).sort()).toEqual(['Papierkorb/Eins.md', 'Papierkorb/Zwei.md']);
      // Ben sees none of it
      expect(((await (await call('ben', '/trash')).json()) as TrashList).entries).toEqual([]);
      expect((await call('ben', '/trash/api-trash-0001/restore', 'POST', {})).status).toBe(404);

      const restored = await call('anna', '/trash/api-trash-0001/restore', 'POST', {});
      expect((await restored.json()).restored).toEqual([{ id: 'api-trash-0001', path: 'Papierkorb/Eins.md' }]);
      expect((await call('anna', '/trash/api-trash-0001/restore', 'POST', {})).status).toBe(404);

      expect((await call('ben', '/trash/api-trash-0002', 'DELETE')).status).toBe(404);
      expect(await (await call('anna', '/trash/api-trash-0002', 'DELETE')).json()).toEqual({ purged: 1 });
      expect((await call('anna', '/trash/api-trash-0002', 'DELETE')).status).toBe(404);
    });

    it('answers 409 with a suggestion when the old path is taken again', async () => {
      await push('anna', [note('api-trash-0003', 'Alt', 'Konflikt.md')]);
      await push('anna', [{ ...note('api-trash-0003', '', 'Konflikt.md', await versionOf('anna', 'api-trash-0003')), deleted: true }]);
      await push('anna', [note('api-trash-0004', 'Neu', 'Konflikt.md')]);
      const res = await call('anna', '/trash/api-trash-0003/restore', 'POST', {});
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.conflict).toBe(true);
      expect(body.suggestion).toMatch(/Konflikt.*\.md$/);
      expect(body.suggestion).not.toBe('Konflikt.md');
      expect((await call('anna', '/trash/api-trash-0003/restore', 'POST', { path: '../..' })).status).toBe(400);
      const moved = await call('anna', '/trash/api-trash-0003/restore', 'POST', { path: body.suggestion });
      expect((await moved.json()).restored[0].path).toBe(body.suggestion);
    });

    it('empties the whole trash and knows no unknown batches', async () => {
      await push('anna', [note('api-trash-0005', 'x', 'Leeren.md')]);
      await push('anna', [{ ...note('api-trash-0005', '', 'Leeren.md', await versionOf('anna', 'api-trash-0005')), deleted: true }]);
      expect((await call('anna', '/trash/batch/gibt-es-nicht/restore', 'POST')).status).toBe(404);
      expect((await (await call('anna', '/trash', 'DELETE')).json()).purged).toBeGreaterThanOrEqual(1);
      expect(((await (await call('anna', '/trash')).json()) as TrashList).entries).toEqual([]);
    });
  });

  describe('history and releases', () => {
    it('keeps versions and releases to those who may see the note', async () => {
      await push('anna', [note('api-rel-0001', 'Erste Fassung', 'Release.md')]);
      expect((await call('anna', '/notes/api-rel-0001/versions')).status).toBe(200);
      expect((await call('ben', '/notes/api-rel-0001/versions')).status).toBe(404);
      expect((await call('anna', '/notes/api-rel-0001/versions/999')).status).toBe(404);

      expect((await call('anna', '/notes/api-rel-0001/releases', 'POST', { bump: 'riesig', baseVersion: 1 })).status).toBe(400);
      const off = await call('anna', '/notes/api-rel-0001/releases', 'POST', { bump: 'minor', baseVersion: await versionOf('anna', 'api-rel-0001') });
      expect(off.status).toBe(400);
      expect((await off.json()).error).toMatch(/Versionierung/);

      expect((await call('ben', '/notes/api-rel-0001/versioning', 'PUT', { enabled: true })).status).toBe(404);
      expect((await call('anna', '/notes/api-rel-0001/versioning', 'PUT', { enabled: true })).status).toBe(200);
      const stale = await call('anna', '/notes/api-rel-0001/releases', 'POST', { bump: 'minor', baseVersion: 0 });
      expect(stale.status).toBe(409);
      const made = await call('anna', '/notes/api-rel-0001/releases', 'POST', { bump: 'minor', baseVersion: await versionOf('anna', 'api-rel-0001'), note: 'Start' });
      const { release, releases } = await made.json();
      expect(releases).toHaveLength(1);
      expect((await call('anna', `/notes/api-rel-0001/releases/${release.version}`)).status).toBe(200);
      expect((await call('anna', '/notes/api-rel-0001/releases/9.9.9')).status).toBe(404);
      expect((await call('ben', '/notes/api-rel-0001/releases')).status).toBe(404);
    });
  });

  describe('sharing', () => {
    it('shares a note with a user and takes it back', async () => {
      await push('anna', [note('api-share-0001', 'Für Ben', 'Geteilt.md')]);
      expect((await call('anna', '/notes/api-share-0001/shares', 'PUT', { username: 'niemand' })).status).toBe(400);
      expect((await call('anna', '/notes/api-share-0001/shares', 'PUT', { username: 'anna' })).status).toBe(400);
      expect((await call('ben', '/notes/api-ben-0001/shares', 'PUT', { username: 'anna' })).status).toBe(200);
      expect((await call('anna', '/notes/api-ben-0001/shares', 'PUT', { username: 'ben' })).status).toBe(404);

      notified.length = 0;
      const shared = await call('anna', '/notes/api-share-0001/shares', 'PUT', { username: 'ben', canWrite: true });
      expect((await shared.json()).users.map((u: { username: string }) => u.username)).toEqual(['ben']);
      expect(notified.flat()).toContain(ben.id);
      expect(((await (await call('ben', '/sync?since=0')).json()) as PullResponse).notes.some((n) => n.id === 'api-share-0001')).toBe(true);

      const removed = await call('anna', '/notes/api-share-0001/shares/ben', 'DELETE');
      expect((await removed.json()).users).toEqual([]);
      // Unknown names are a no-op, foreign notes are not found
      expect((await call('anna', '/notes/api-share-0001/shares/niemand', 'DELETE')).status).toBe(200);
      expect((await call('anna', '/notes/nicht-da/shares/ben', 'DELETE')).status).toBe(404);
      expect((await call('ben', '/notes/api-share-0001/shares')).status).toBe(404);
    });

    it('shares folders, follows renames and drops shares of deleted folders', async () => {
      await push('anna', [note('api-folder-0001', 'Im Ordner', 'Projekt/Plan.md')]);
      expect((await call('anna', '/folders/shares')).status).toBe(400);
      expect((await call('anna', '/folders/shares', 'PUT', { folder: '  ', username: 'ben' })).status).toBe(400);
      expect((await call('anna', '/folders/shares', 'PUT', { folder: 'Projekt', username: 'niemand' })).status).toBe(400);
      const shared = await call('anna', '/folders/shares', 'PUT', { folder: 'Projekt', username: 'ben', canWrite: true });
      expect((await shared.json()).users[0]).toMatchObject({ username: 'ben', canWrite: true, canCreate: false });
      expect(((await (await call('ben', '/sync?since=0')).json()) as PullResponse).notes.some((n) => n.id === 'api-folder-0001')).toBe(true);

      expect((await call('anna', '/folders/renamed', 'POST', { from: 'Projekt' })).status).toBe(400);
      expect((await call('anna', '/folders/renamed', 'POST', { from: 'Projekt', to: 'Projekt-Neu' })).status).toBe(200);
      expect((await (await call('anna', `/folders/shares?folder=${encodeURIComponent('Projekt-Neu')}`)).json()).users).toHaveLength(1);

      expect((await call('anna', '/folders/shares', 'DELETE', { username: 'ben' })).status).toBe(400);
      const unshared = await call('anna', '/folders/shares', 'DELETE', { folder: 'Projekt-Neu', username: 'ben' });
      expect((await unshared.json()).users).toEqual([]);

      await call('anna', '/folders/shares', 'PUT', { folder: 'Projekt-Neu', username: 'ben' });
      expect((await call('anna', '/folders/deleted', 'POST', {})).status).toBe(400);
      expect((await call('anna', '/folders/deleted', 'POST', { folder: 'Projekt-Neu' })).status).toBe(200);
      expect((await (await call('anna', `/folders/shares?folder=${encodeURIComponent('Projekt-Neu')}`)).json()).users).toEqual([]);
    });

    it('publishes a note under a link and withdraws it', async () => {
      await push('anna', [note('api-public-0001', '# Öffentlich\nHallo', 'Öffentlich.md')]);
      expect((await call('ben', '/notes/api-public-0001/public', 'PUT', { enabled: true })).status).toBe(404);
      const on = await (await call('anna', '/notes/api-public-0001/public', 'PUT', { enabled: true })).json();
      expect(on.publicToken).toBeTruthy();
      const guest = await call(null, `/public/${on.publicToken}`);
      expect(guest.status).toBe(200);
      expect((await guest.json()).content).toContain('Hallo');
      await call('anna', '/notes/api-public-0001/public', 'PUT', { enabled: false });
      expect((await call(null, `/public/${on.publicToken}`)).status).toBe(404);
    });
  });
});
