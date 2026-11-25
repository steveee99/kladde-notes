import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { remoteNoteMarkdown, writeVariables, type AdminRemoteInstance, type RemoteNoteResponse, type RemoteTestResult } from '@kladde/shared';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteStore } from '../src/NoteStore';
import { GroupStore } from '../src/GroupStore';
import { StorageStore } from '../src/StorageStore';
import { ServerSettings } from '../src/ServerSettings';
import { AuditLog } from '../src/security/AuditLog';
import { adminRouter } from '../src/admin/adminRouter';
import { McpTokenStore } from '../src/mcp/McpTokenStore';
import { mcpRouters } from '../src/mcp/router';
import { RemoteInstances, remoteInstancesFromEnv } from '../src/remote/RemoteInstances';
import { RemoteFetcher, sniffImage } from '../src/remote/RemoteFetcher';
import { remoteRouter } from '../src/remote/router';
import { RemoteSnapshotStore, RemoteSync, remoteSyncHours } from '../src/remote/RemoteSync';
import { SpaceIndexes } from '../src/online/SpaceIndex';

const TOKEN = 'glpat-super-secret-1';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

interface Seen {
  url: string;
  token: string | undefined;
}

/** Answers like the GitLab (`/api/v4`) and GitHub Enterprise (`/api/v3`) APIs, as far as remote notes use them */
class FakeUpstream {
  seen: Seen[] = [];
  /** `project\nref\npath` → content */
  files = new Map<string, Buffer>();
  special: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null = null;
  server = http.createServer((req, res) => {
    const token = (req.headers['private-token'] as string | undefined) ?? req.headers.authorization;
    this.seen.push({ url: req.url!, token });
    if (this.special?.(req, res)) return;
    const url = new URL(req.url!, 'http://x');
    const gl = /^\/api\/v4\/projects\/([^/]+)\/repository\/files\/([^/]+)\/raw$/.exec(url.pathname);
    const gh = /^\/api\/v3\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname);
    if (url.pathname.endsWith('/user') || url.pathname.endsWith('/rate_limit')) {
      const ok = token === TOKEN || token === `Bearer ${TOKEN}`;
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'upstream body' }));
      return;
    }
    if (/\/commits$/.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([{ id: 'a'.repeat(40), sha: 'a'.repeat(40), committed_date: '2026-01-02T03:04:05Z', commit: { committer: { date: '2026-01-02T03:04:05Z' } } }]));
      return;
    }
    const m = gl ?? gh;
    const body = m && this.files.get([decodeURIComponent(m[1]), url.searchParams.get('ref') ?? 'HEAD', decodeURIComponent(m[2])].join('\n'));
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"404 upstream body"}');
      return;
    }
    const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) res.writeHead(304).end();
    else res.writeHead(200, { 'Content-Type': 'application/octet-stream', ETag: etag }).end(body);
  });
  base = '';

  async listen() {
    this.server.listen(0, '127.0.0.1');
    await new Promise((r) => this.server.once('listening', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  put(project: string, ref: string, file: string, body: string | Buffer) {
    this.files.set([project, ref, file].join('\n'), Buffer.from(body));
  }
}

const gitlab = new FakeUpstream();
const github = new FakeUpstream();
const other = new FakeUpstream();

const db = openDatabase(':memory:');
const cipher = new DataCipher(crypto.randomBytes(32));
const users = new UserStore(db);
// Synced remote notes hear about every change, as in the app
let sync: RemoteSync | undefined;
const notes = new NoteStore(db, cipher, (e) => sync?.onNoteChange(e));
const groups = new GroupStore(db);
const settings = new ServerSettings(db);
// The first account becomes admin
const anna = users.createUser('anna');
const ben = users.createUser('ben');
const cara = users.createUser('cara');
const cookies = Object.fromEntries([anna, ben, cara].map((u) => [u.username, `kladde_session=${users.createSession(u.id)}`]));

let server: http.Server;
let base = '';
let instances: RemoteInstances;
let mcpToken = '';

let n = 0;
const uid = () => `remote-${String(++n).padStart(6, '0')}`;
function push(userId: string, notePath: string, content: string, extra: { id?: string; baseVersion?: number; group?: string } = {}) {
  const id = extra.id ?? uid();
  const [r] = notes.push(userId, [{ id, baseVersion: extra.baseVersion ?? 0, path: notePath, content, deleted: false, createdAt: 1, updatedAt: 1, ...(extra.group ? { group: extra.group } : {}) }]);
  expect(r.status).toBe('ok');
  return id;
}
const remote = (source: string, ref = '', synced = false) => remoteNoteMarkdown({ source, ref, sync: synced });
const get = (id: string, user = 'anna', query = '?refresh=1') => fetch(`${base}/api/remote-notes/${id}${query}`, { headers: user ? { Cookie: cookies[user] } : {} });
async function load(source: string, ref = ''): Promise<RemoteNoteResponse> {
  return (await (await get(push(anna.id, `N/${uid()}.md`, remote(source, ref)))).json()) as RemoteNoteResponse;
}
const admin = (method: string, url: string, body?: unknown, user = 'anna') =>
  fetch(`${base}/api/admin/remote${url}`, { method, headers: { Cookie: cookies[user], 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  await Promise.all([gitlab.listen(), github.listen(), other.listen()]);
  instances = new RemoteInstances({ REMOTE_GITLAB_URL: gitlab.base, REMOTE_GITLAB_TOKEN: TOKEN }, settings, cipher);
  instances.put(null, { kind: 'github', url: github.base, token: TOKEN, allowedPaths: ['team/docs', 'open'] });
  const fetcher = new RemoteFetcher(instances, { timeoutMs: 500, maxText: 2000, maxImage: 3000 });
  const app = express();
  app.use(express.json());
  sync = new RemoteSync(new RemoteSnapshotStore(db, cipher), notes, fetcher, 6 * 3_600_000);
  app.use('/api/remote-notes', remoteRouter({ users, notes, instances, fetcher, sync }));
  app.use('/api/admin', adminRouter({ users, storage: new StorageStore(db, null), audit: new AuditLog(db), remote: { instances, fetcher }, status: () => ({ version: 't', startedAt: 0, users: 0, notes: 0, shares: 0, connections: 0 }) }));
  const tokens = new McpTokenStore(db);
  app.use(mcpRouters({ users, notes, tokens, audit: new AuditLog(db), publicUrl: null }).publicRouter);
  mcpToken = tokens.createPersonalToken(anna.id, 'test', true).token;
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  for (const u of [gitlab, github, other]) {
    u.special = null;
    u.seen = [];
  }
});

afterAll(() => {
  server.close();
  for (const u of [gitlab, github, other]) {
    u.server.closeAllConnections();
    u.server.close();
  }
  db.close();
});

describe('reading remote notes', () => {
  it('loads a GitLab file with the token, and the next open sees what changed', async () => {
    gitlab.put('g/sub/p', 'main', 'docs/a.md', '# One\n');
    const id = push(anna.id, 'A.md', remote(`${gitlab.base}/g/sub/p/-/blob/main/docs/a.md?x={{var:none|1}}`));
    const res = await get(id);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Extract<RemoteNoteResponse, { state: 'ok' }>;
    expect(body).toMatchObject({ state: 'ok', text: '# One\n', url: `${gitlab.base}/g/sub/p/-/blob/main/docs/a.md`, base: { project: 'g/sub/p', ref: 'main', path: 'docs/a.md' }, commit: { id: 'a'.repeat(40), at: Date.parse('2026-01-02T03:04:05Z') } });
    expect(gitlab.seen[0]).toEqual({ url: '/api/v4/projects/g%2Fsub%2Fp/repository/files/docs%2Fa.md/raw?ref=main', token: TOKEN });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    gitlab.put('g/sub/p', 'main', 'docs/a.md', '# Two\n');
    expect(await (await get(id)).json()).toMatchObject({ text: '# Two\n' });
    // Unchanged: revalidated with the ETag
    expect(await (await get(id)).json()).toMatchObject({ text: '# Two\n' });
    expect(gitlab.seen.at(-1)!.url).toContain('/raw?');
  });

  it('loads GitHub files, the README of a repository and branches with slashes', async () => {
    github.put('team/docs', 'HEAD', 'readme.md', 'hello');
    github.put('team/docs', 'feature/x', 'a.md', 'branch');
    expect(await load(`${github.base}/team/docs`)).toMatchObject({ state: 'ok', text: 'hello', base: { ref: 'HEAD', path: 'readme.md' } });
    expect(github.seen[0]).toEqual({ url: '/api/v3/repos/team/docs/contents/README.md', token: `Bearer ${TOKEN}` });
    expect(await load(`${github.base}/team/docs/blob/feature/x/a.md`)).toMatchObject({ text: 'branch', base: { ref: 'feature/x', path: 'a.md' } });
    expect(await load(`${github.base}/team/docs/blob/feature/x/a.md`, 'feature/x')).toMatchObject({ text: 'branch' });
  });

  it('only asks configured hosts, and only for allowed paths', async () => {
    other.put('g/p', 'main', 'a.md', 'leak');
    expect(await load(`${other.base}/g/p/-/blob/main/a.md`)).toEqual({ state: 'host_not_configured' });
    expect(await load('http://169.254.169.254/g/p/-/blob/main/a.md')).toEqual({ state: 'host_not_configured' });
    expect(await load(`${github.base}/team/docs-secret/blob/main/a.md`)).toEqual({ state: 'not_allowed' });
    expect(await load(`${github.base}/other/docs/blob/main/a.md`)).toEqual({ state: 'not_allowed' });
    for (const p of ['/g/p/-/blob/main/../../x.md', '/g/p/-/blob/main/%2e%2e%2fx.md', '/g/p/-/blob/main/a%2f..%2fb.md', '/g/p/-/blob/main/%252e%252e/x.md']) expect(await load(gitlab.base + p)).toEqual({ state: 'invalid_source' });
    expect(await load(gitlab.base.replace('http://', 'http://user:pw@') + '/g/p/-/blob/main/a.md')).toEqual({ state: 'invalid_source' });
    expect(await load(`${gitlab.base}/g/p/-/blob/main/secret.yml`)).toEqual({ state: 'unsupported' });
    expect([...gitlab.seen, ...github.seen, ...other.seen]).toEqual([]);
  });

  it('re-validates the address after filling in variables', async () => {
    push(anna.id, 'V/_variables.md', writeVariables('', [{ name: 'host', value: other.base }, { name: 'evil', value: `${gitlab.base}@evil.example.com` }, { name: 'up', value: '../../x' }]));
    const state = async (source: string) => ((await (await get(push(anna.id, `V/${uid()}.md`, remote(source)))).json()) as RemoteNoteResponse).state;
    expect(await state('{{var:host}}/g/p/-/blob/main/a.md')).toBe('host_not_configured');
    expect(await state('{{var:evil}}/g/p/-/blob/main/a.md')).toBe('invalid_source');
    expect(await state(`${gitlab.base}/g/p/-/blob/main/{{var:up}}/a.md`)).toBe('invalid_source');
    expect(await state(`${gitlab.base}/g/p/-/blob/main/{{var:unknown}}.md`)).toBe('unknown_variable');
    expect([...gitlab.seen, ...other.seen]).toEqual([]);
  });

  it('never follows a redirect to another origin, and the token goes nowhere else', async () => {
    gitlab.special = (_req, res) => (res.writeHead(302, { Location: `${other.base}/steal.md` }).end(), true);
    expect(await load(`${gitlab.base}/g/p/-/blob/main/r1.md`)).toEqual({ state: 'redirect' });
    gitlab.special = (_req, res) => (res.writeHead(301, { Location: `${gitlab.base}/-/outside-the-api` }).end(), true);
    expect(await load(`${gitlab.base}/g/p/-/blob/main/r2.md`)).toEqual({ state: 'redirect' });
    expect(gitlab.seen).toHaveLength(2);
    expect(other.seen).toEqual([]);
    // A renamed project: inside the API of the same instance
    gitlab.put('g/new', 'main', 'a.md', 'moved');
    gitlab.special = (req, res) => (req.url!.includes('g%2Fold/repository/files') ? (res.writeHead(301, { Location: '/api/v4/projects/g%2Fnew/repository/files/a.md/raw?ref=main' }).end(), true) : false);
    expect(await load(`${gitlab.base}/g/old/-/blob/main/a.md`)).toMatchObject({ state: 'ok', text: 'moved' });
    // With allowed paths it could lead out of them
    github.special = (_req, res) => (res.writeHead(301, { Location: '/api/v3/repos/other/x/contents/a.md' }).end(), true);
    expect(await load(`${github.base}/team/docs/blob/main/a.md`)).toEqual({ state: 'redirect' });
    expect(github.seen).toHaveLength(1);
  });

  it('reports problems without the upstream body', async () => {
    const state = async (status: number, headers: Record<string, string> = {}) => {
      gitlab.special = (_req, res) => (res.writeHead(status, headers).end(`upstream says ${TOKEN}`), true);
      const answer = await load(`${gitlab.base}/g/p/-/blob/main/${uid()}.md`, 'main');
      expect(JSON.stringify(answer)).not.toContain('upstream says');
      return answer.state;
    };
    expect(await state(401)).toBe('no_access');
    expect(await state(403)).toBe('no_access');
    expect(await state(403, { 'X-RateLimit-Remaining': '0' })).toBe('upstream_limit');
    expect(await state(404)).toBe('not_found');
    expect(await state(429)).toBe('upstream_limit');
    expect(await state(500)).toBe('unreachable');
    gitlab.special = () => true; // never answers
    expect(await load(`${gitlab.base}/g/p/-/blob/main/slow.md`, 'main')).toEqual({ state: 'unreachable' });
    gitlab.special = null;
    gitlab.put('g/p', 'main', 'big.md', 'x'.repeat(2001));
    expect(await load(`${gitlab.base}/g/p/-/blob/main/big.md`)).toEqual({ state: 'too_large' });
    gitlab.put('g/p', 'main', 'bin.md', Buffer.from([1, 0, 2]));
    expect(await load(`${gitlab.base}/g/p/-/blob/main/bin.md`)).toEqual({ state: 'unsupported' });
    // Endless and without a length
    gitlab.special = (req, res) => {
      if (!req.url!.includes('/raw')) return false;
      res.writeHead(200);
      const timer = setInterval(() => res.write('x'.repeat(500)), 5);
      res.on('close', () => clearInterval(timer));
      return true;
    };
    expect(await load(`${gitlab.base}/g/p/-/blob/main/endless.md`)).toEqual({ state: 'too_large' });
  });

  it('follows the access to the note', async () => {
    gitlab.put('g/p', 'main', 'acc.md', 'text');
    const source = `${gitlab.base}/g/p/-/blob/main/{{var:file}}.md`;
    push(anna.id, 'Acc/_variables.md', writeVariables('', [{ name: 'file', value: 'acc' }]));
    const id = push(anna.id, 'Acc/Note.md', remote(source));
    expect((await get(id, '')).status).toBe(401);
    expect((await get(id, 'ben')).status).toBe(404);
    expect((await get(`${id}/image`, 'ben', '?path=x.png')).status).toBe(404);
    expect((await get('nope-nope-nope')).status).toBe(404);
    expect((await get(push(anna.id, 'Plain.md', 'text'))).status).toBe(404);
    // Recipients see the same document: variables are the owner's
    notes.share(anna.id, id, ben.id, false);
    expect(await (await get(id, 'ben')).json()).toMatchObject({ state: 'ok', text: 'text' });
    notes.unshare(anna.id, id, ben.id);
    expect((await get(id, 'ben', '')).status).toBe(404);
    // Readers of a group
    const group = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, group.id, cara.id, 'reader');
    const gid = push(anna.id, 'Doc.md', remote(`${gitlab.base}/g/p/-/blob/main/acc.md`), { group: group.id });
    expect(await (await get(gid, 'cara')).json()).toMatchObject({ state: 'ok' });
    expect((await get(gid, 'ben')).status).toBe(404);
  });

  it('answers with no filled-in address of a document it could not read', async () => {
    push(anna.id, 'Sec/_variables.md', writeVariables('', [{ name: 'secret', value: 'hidden-value' }]));
    const id = push(anna.id, 'Sec/Note.md', remote(`${gitlab.base}/g/p/-/blob/main/{{var:secret}}.md`));
    notes.share(anna.id, id, ben.id, true);
    expect(await (await get(id, 'ben')).text()).not.toContain('hidden-value');
    gitlab.put('g/p', 'main', 'acc.md', 'text');
    const [r] = notes.push(ben.id, [{ id, baseVersion: 1, path: 'Sec/Note.md', content: remote(`${gitlab.base}/g/p/-/blob/main/acc.md?{{var:secret}}#{{var:secret}}`), deleted: false, createdAt: 1, updatedAt: 2 }]);
    expect(r.status).toBe('ok');
    const text = await (await get(id, 'ben')).text();
    expect(text).toContain('"ok"');
    expect(text).not.toContain('hidden-value');
  });

  it('gives public links a placeholder without the source', () => {
    const id = push(anna.id, 'Pub.md', remote(`${gitlab.base}/g/p/-/blob/main/{{var:x}}.md`));
    const outer = push(anna.id, 'Outer.md', 'See\n\n![[Pub]]\n');
    const pub = notes.publicNote(notes.setPublic(anna.id, id, true)!)!;
    const embedding = notes.publicNote(notes.setPublic(anna.id, outer, true)!)!;
    expect(embedding.embeds).toHaveLength(1);
    for (const note of [pub, embedding]) expect(JSON.stringify(note)).not.toContain('127.0.0.1');
    expect(gitlab.seen).toEqual([]);
  });

  it('limits how often an account may ask', async () => {
    const id = push(cara.id, 'Own.md', remote('https://nowhere.example.com/a/b'));
    const codes = new Set<number>();
    for (let i = 0; i < 125; i++) codes.add((await get(id, 'cara')).status);
    expect(codes).toEqual(new Set([200, 429]));
    expect((await get(push(ben.id, 'Own.md', remote('https://nowhere.example.com/a/b')), 'ben')).status).toBe(200);
  });
});

describe('synced remote notes', () => {
  const later = () => Date.now() + 7 * 3_600_000;
  const pulled = (userId: string, id: string) => notes.pull(userId, 0).notes.find((x) => x.id === id)!;
  const seqOf = (id: string) => (db.prepare('SELECT seq FROM notes WHERE id = ?').get(id) as { seq: number }).seq;
  const syncNow = (id: string, user = 'anna') => fetch(`${base}/api/remote-notes/${id}/sync`, { method: 'POST', headers: { Cookie: cookies[user] } });

  it('reads the interval from the environment, never below an hour', () => {
    expect(remoteSyncHours({})).toBe(6);
    expect(remoteSyncHours({ REMOTE_SYNC_HOURS: '24' })).toBe(24);
    expect(remoteSyncHours({ REMOTE_SYNC_HOURS: '0.1' })).toBe(1);
    expect(remoteSyncHours({ REMOTE_SYNC_HOURS: '9999' })).toBe(168);
    expect(remoteSyncHours({ REMOTE_SYNC_HOURS: 'often' })).toBe(6);
  });

  it('keeps a copy that travels with the note, and only a changed document gives it a new seq', async () => {
    gitlab.put('s/p', 'main', 'a.md', '# Handbuch\n\nZebrafisch\n');
    const id = push(anna.id, 'Synced.md', remote(`${gitlab.base}/s/p/-/blob/main/a.md`, '', true));
    expect(pulled(anna.id, id).remoteSnapshot).toBeUndefined();
    // A new synced note is due at once
    await sync!.tick();
    const first = pulled(anna.id, id).remoteSnapshot!;
    expect(first).toMatchObject({ text: '# Handbuch\n\nZebrafisch\n', base: { project: 's/p', path: 'a.md' }, source: `${gitlab.base}/s/p/-/blob/main/a.md` });
    expect(first.problem).toBeUndefined();
    // Not due again before the interval
    gitlab.seen = [];
    await sync!.tick();
    expect(gitlab.seen).toEqual([]);
    // Due later: unchanged, so no new seq
    const seq = seqOf(id);
    await sync!.tick(later());
    expect(gitlab.seen.length).toBeGreaterThan(0);
    expect(seqOf(id)).toBe(seq);
    // Changed: new seq, new copy
    gitlab.put('s/p', 'main', 'a.md', '# Handbuch\n\nSeepferdchen\n');
    await sync!.tick(later());
    expect(seqOf(id)).toBeGreaterThan(seq);
    expect(pulled(anna.id, id).remoteSnapshot!.text).toContain('Seepferdchen');
  });

  it('keeps the last copy when reading fails, and says why', async () => {
    gitlab.put('s/p', 'main', 'gone.md', 'Erster Stand\n');
    const id = push(anna.id, 'Gone.md', remote(`${gitlab.base}/s/p/-/blob/main/gone.md`, '', true));
    await sync!.tick();
    gitlab.files.delete(['s/p', 'main', 'gone.md'].join('\n'));
    await sync!.tick(later());
    expect(pulled(anna.id, id).remoteSnapshot).toMatchObject({ text: 'Erster Stand\n', problem: 'not_found' });
  });

  it('drops the copy when sync is turned off, and never puts it into catalogs or public links', async () => {
    gitlab.put('s/p', 'main', 'b.md', 'Geheimer Inhalt\n');
    const source = `${gitlab.base}/s/p/-/blob/main/b.md`;
    const id = push(anna.id, 'Off.md', remote(source, '', true));
    await sync!.tick();
    expect(pulled(anna.id, id).remoteSnapshot?.text).toBe('Geheimer Inhalt\n');
    expect(JSON.stringify(notes.pull(anna.id, 0, { light: true }))).not.toContain('Geheimer Inhalt');
    expect(JSON.stringify(notes.publicNote(notes.setPublic(anna.id, id, true)!))).not.toContain('Geheimer Inhalt');
    push(anna.id, 'Off.md', remote(source), { id, baseVersion: pulled(anna.id, id).version });
    expect(pulled(anna.id, id).remoteSnapshot).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM remote_snapshots WHERE note_id = ?').get(id)).toEqual({ n: 0 });
  });

  it('shows no copy of an older source', async () => {
    gitlab.put('s/p', 'main', 'c.md', 'Alt\n');
    gitlab.put('s/p', 'main', 'd.md', 'Neu\n');
    const id = push(anna.id, 'Moved.md', remote(`${gitlab.base}/s/p/-/blob/main/c.md`, '', true));
    await sync!.tick();
    push(anna.id, 'Moved.md', remote(`${gitlab.base}/s/p/-/blob/main/d.md`, '', true), { id, baseVersion: pulled(anna.id, id).version });
    expect(pulled(anna.id, id).remoteSnapshot).toBeUndefined();
    // Due at once again
    await sync!.tick();
    expect(pulled(anna.id, id).remoteSnapshot?.text).toBe('Neu\n');
  });

  it('syncs on request for everybody who sees the note', async () => {
    gitlab.put('s/p', 'main', 'e.md', 'Eins\n');
    const id = push(anna.id, 'Manual.md', remote(`${gitlab.base}/s/p/-/blob/main/e.md`, '', true));
    const res = await syncNow(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: 'Eins\n', source: `${gitlab.base}/s/p/-/blob/main/e.md` });
    expect(pulled(anna.id, id).remoteSnapshot?.text).toBe('Eins\n');
    expect((await syncNow(id, 'ben')).status).toBe(404);
    notes.share(anna.id, id, ben.id, false);
    expect((await syncNow(id, 'ben')).status).toBe(200);
    expect(pulled(ben.id, id).remoteSnapshot?.text).toBe('Eins\n');
    // A live note is not synced
    expect((await syncNow(push(anna.id, 'Live.md', remote(`${gitlab.base}/s/p/-/blob/main/e.md`)))).status).toBe(409);
  });

  it('is found by the search of online mode', async () => {
    gitlab.put('s/p', 'main', 'f.md', 'Das Wort Quokkasprung steht nur hier.\n');
    const id = push(anna.id, 'Search.md', remote(`${gitlab.base}/s/p/-/blob/main/f.md`, '', true));
    const live = push(anna.id, 'SearchLive.md', remote(`${gitlab.base}/s/p/-/blob/main/f.md`));
    await sync!.tick();
    const hits = new SpaceIndexes(notes).search(anna.id, 'quokkasprung');
    expect(hits.map((h) => h.id)).toEqual([id]);
    expect(hits[0].snippet).toContain('Quokkasprung');
    expect(hits.map((h) => h.id)).not.toContain(live);
  });
});

describe('images of remote notes', () => {
  const image = (id: string, p: string, headers: Record<string, string> = {}) => fetch(`${base}/api/remote-notes/${id}/image?path=${encodeURIComponent(p)}`, { headers: { Cookie: cookies.anna, ...headers } });

  it('come from the same repository and version, by their content', async () => {
    gitlab.put('g/img', 'main', 'a.md', 'text');
    gitlab.put('g/img', 'main', 'pics/a.png', PNG);
    gitlab.put('g/img', 'main', 'b.svg', SVG);
    gitlab.put('g/img', 'main', 'fake.png', '<html><script>alert(1)</script>');
    gitlab.put('g/img', 'main', 'big.png', Buffer.concat([PNG, Buffer.alloc(4000)]));
    gitlab.put('g/img', 'main', 'secret.txt', 'x');
    const id = push(anna.id, 'Img.md', remote(`${gitlab.base}/g/img/-/blob/main/a.md`));
    const png = await image(id, 'pics/a.png');
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');
    expect(png.headers.get('cache-control')).toBe('private, no-cache');
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
    expect(gitlab.seen.filter((s) => s.url.includes('pics'))).toEqual([{ url: '/api/v4/projects/g%2Fimg/repository/files/pics%2Fa.png/raw?ref=main', token: TOKEN }]);
    expect((await image(id, 'pics/a.png', { 'If-None-Match': png.headers.get('etag')! })).status).toBe(304);
    const svg = await image(id, 'b.svg');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');
    expect(svg.headers.get('content-disposition')).toContain('attachment');
    expect((await image(id, 'fake.png')).status).toBe(415);
    expect((await image(id, 'secret.txt')).status).toBe(415);
    expect((await image(id, 'a.md')).status).toBe(415);
    expect((await image(id, 'big.png')).status).toBe(413);
    expect((await image(id, 'gone.png')).status).toBe(404);
    for (const p of ['../x.png', 'a/../../x.png', '/a.png', '%2e%2e/x.png', 'a%2f..%2fx.png', 'a\\..\\x.png', 'a\0.png']) expect((await image(id, p)).status).toBe(415);
    expect(gitlab.seen.every((s) => s.url.startsWith('/api/v4/projects/g%2Fimg/'))).toBe(true);
  });

  it('sniffs types', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0]), 'a.jpg')).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a…'), 'a.gif')).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF0000WEBPVP8'), 'a.webp')).toBe('image/webp');
    expect(sniffImage(Buffer.from('0000ftypavif'), 'a.avif')).toBe('image/avif');
    expect(sniffImage(Buffer.from('<?xml version="1.0"?>\n<!-- x -->\n<svg>'), 'a.svg')).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><html/>'), 'a.svg')).toBeNull();
    expect(sniffImage(SVG, 'a.png')).toBeNull();
    expect(sniffImage(Buffer.alloc(0), 'a.png')).toBeNull();
  });
});

describe('access configuration', () => {
  it('reads the environment', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-remote-'));
    fs.writeFileSync(path.join(dir, 't'), 'from-file\n');
    const kinds = (env: NodeJS.ProcessEnv) => remoteInstancesFromEnv(env).map((i) => `${i.kind} ${i.url} ${i.apiBase} ${i.token} ${i.anonymous}`);
    expect(kinds({})).toEqual([]);
    expect(kinds({ REMOTE_GITLAB_URL: 'https://gl.example.com' })).toEqual([]);
    expect(kinds({ REMOTE_GITLAB_TOKEN: 't' })).toEqual(['gitlab https://gitlab.com https://gitlab.com/api/v4 t false']);
    expect(kinds({ REMOTE_GITLAB_URL: 'https://gl.example.com/', REMOTE_GITLAB_INTERNAL_URL: 'http://gitlab', REMOTE_GITLAB_TOKEN_FILE: path.join(dir, 't') })).toEqual(['gitlab https://gl.example.com http://gitlab/api/v4 from-file false']);
    expect(kinds({ REMOTE_GITHUB_PUBLIC: '1' })).toEqual(['github https://github.com https://api.github.com  true']);
    expect(kinds({ REMOTE_GITHUB_URL: 'https://ghe.example.com', REMOTE_GITHUB_TOKEN: 't' })).toEqual(['github https://ghe.example.com https://ghe.example.com/api/v3 t false']);
    expect(kinds({ REMOTE_GITHUB_URL: 'ftp://x', REMOTE_GITHUB_TOKEN: 't' })).toEqual([]);
    expect(kinds({ REMOTE_GITHUB_TOKEN: 'a b' })).toEqual([]);
    expect(remoteInstancesFromEnv({ REMOTE_GITHUB_TOKEN: 't', REMOTE_ALLOWED_PATHS: ' team, gitlab:x ,' })[0].allowedPaths).toEqual(['team', 'gitlab:x']);
    expect(error.mock.calls.flat().join(' ')).not.toContain('a b');
    error.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is for admins, and never gives a token back', async () => {
    for (const [method, url] of [['GET', ''], ['POST', ''], ['PUT', '/x'], ['DELETE', '/x'], ['POST', '/x/test']] as const) expect((await admin(method, url, method === 'GET' ? undefined : {}, 'ben')).status).toBe(403);
    const hosts = await (await fetch(`${base}/api/remote-notes/hosts`, { headers: { Cookie: cookies.ben } })).text();
    expect(JSON.parse(hosts)).toEqual([{ kind: 'gitlab', url: gitlab.base }, { kind: 'github', url: github.base }]);

    const res = await admin('POST', '', { kind: 'gitlab', url: `${other.base}/`, token: 'other-token', allowedPaths: ['a/b'] });
    const text = await res.text();
    expect(res.status).toBe(200);
    const list = JSON.parse(text) as AdminRemoteInstance[];
    const mine = list.find((i) => i.url === other.base)!;
    expect(mine).toMatchObject({ hasToken: true, fromEnv: false, anonymous: false, allowedPaths: ['a/b'] });
    for (const answer of [text, await (await admin('GET', '')).text(), hosts]) for (const secret of [TOKEN, 'other-token']) expect(answer).not.toContain(secret);
    // Encrypted at rest, and not in the audit log
    const row = db.prepare("SELECT value FROM server_settings WHERE key = 'remote_instances'").get() as { value: string };
    expect(row.value).not.toContain('other-token');
    expect(row.value).not.toContain('127.0.0.1');
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain('other-token');

    // An empty token keeps the stored one; another address does not get it
    expect((await admin('PUT', `/${mine.id}`, { kind: 'gitlab', url: other.base, token: '', allowedPaths: [] })).status).toBe(200);
    expect(instances.get(mine.id)!.token).toBe('other-token');
    expect((await admin('PUT', `/${mine.id}`, { kind: 'gitlab', url: 'https://evil.example.com', token: '' })).status).toBe(400);
    expect((await admin('PUT', `/${mine.id}`, { kind: 'github', url: other.base, token: '' })).status).toBe(400);
    expect((await admin('PUT', `/${mine.id}`, { kind: 'gitlab', url: 'https://evil.example.com', anonymous: true })).status).toBe(200);
    expect(instances.get(mine.id)).toMatchObject({ token: '', anonymous: true });
    for (const bad of [{}, { kind: 'x', url: other.base, token: 't' }, { kind: 'gitlab', url: 'nope', token: 't' }, { kind: 'gitlab', url: other.base }, { kind: 'gitlab', url: other.base, token: 'a\nb' }, { kind: 'gitlab', url: other.base, token: 't', allowedPaths: ['a b'] }]) expect((await admin('POST', '', bad)).status).toBe(400);
    expect((await admin('POST', '', { kind: 'gitlab', url: gitlab.base, token: 't' })).status).toBe(409);
    expect((await admin('DELETE', `/${mine.id}`)).status).toBe(200);
    expect((await admin('DELETE', `/${mine.id}`)).status).toBe(404);
    // What the environment sets cannot be changed here
    const env = ((await (await admin('GET', '')).json()) as AdminRemoteInstance[]).find((i) => i.fromEnv)!;
    expect((await admin('PUT', `/${env.id}`, { kind: 'gitlab', url: other.base, token: 't' })).status).toBe(404);
    expect((await admin('DELETE', `/${env.id}`)).status).toBe(404);
  });

  it('lets the environment win', () => {
    const own = new RemoteInstances({ REMOTE_GITHUB_URL: github.base, REMOTE_GITHUB_TOKEN: 'env-token' }, settings, cipher);
    expect(own.active().filter((i) => i.url === github.base)).toMatchObject([{ token: 'env-token', fromEnv: true }]);
    expect(own.list()).toMatchObject([{ fromEnv: true }, { url: github.base, overridden: true }]);
    // Another data key: the stored entries are unreadable, the server still runs
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(new RemoteInstances({}, settings, new DataCipher(crypto.randomBytes(32))).active()).toEqual([]);
    error.mockRestore();
  });

  it('tests the access', async () => {
    const env = instances.list().find((i) => i.fromEnv)!;
    const own = instances.list().find((i) => !i.fromEnv)!;
    const test = async (id: string) => ((await (await admin('POST', `/${id}/test`)).json()) as RemoteTestResult).state;
    expect(await test(env.id)).toBe('ok');
    expect(await test(own.id)).toBe('ok');
    gitlab.special = (_req, res) => (res.writeHead(403).end(), true);
    expect(await test(env.id)).toBe('limited');
    gitlab.special = (_req, res) => (res.writeHead(401).end(), true);
    expect(await test(env.id)).toBe('no_access');
    gitlab.special = (_req, res) => (res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>'), true);
    expect(await test(env.id)).toBe('unreachable');
    expect((await admin('POST', '/nope/test')).status).toBe(404);
  });
});

describe('remote notes over MCP', () => {
  async function call(name: string, args: Record<string, unknown>) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const result = ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    return { error: !!result.isError, text: result.content[0].text };
  }

  it('says what they are and refuses to write their text', async () => {
    const content = remote(`${gitlab.base}/g/p/-/blob/main/mcp.md`);
    const id = push(anna.id, 'Mcp.md', content);
    const read = await call('read_note', { id });
    expect(read.text).toContain('read-only');
    expect(read.text).toContain('/g/p/-/blob/main/mcp.md');
    expect(gitlab.seen).toEqual([]);
    expect((await call('append_to_note', { id, text: 'more' })).error).toBe(true);
    expect((await call('update_note', { id, version: 1, content: `${content}body` })).error).toBe(true);
    expect((await call('update_note', { id, version: 1, content: 'plain' })).error).toBe(true);
    expect((await call('update_note', { id, version: 1, content: remote(`${gitlab.base}/g/p/-/blob/main/new.md`) })).error).toBe(false);
    expect(notes.fetchNotes(anna.id, [id])[0].content).toContain('new.md');
    expect((await call('create_note', { title: 'R1', content: `${content}body` })).error).toBe(true);
    expect((await call('create_note', { title: 'R2', content })).error).toBe(false);
  });
});
