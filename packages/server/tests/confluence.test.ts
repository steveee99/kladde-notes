import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { ConfluenceLinkTarget, ConfluenceNoteState, ConfluenceOverview } from '@kladde/shared';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { NoteStore } from '../src/NoteStore';
import { UserStore } from '../src/UserStore';
import { AuditLog } from '../src/security/AuditLog';
import { ConfluenceStore } from '../src/confluence/ConfluenceStore';
import { ConfluenceSync } from '../src/confluence/ConfluenceSync';
import { confluenceRouter } from '../src/confluence/router';
import { normalizeConfluenceUrl, type HttpRequest, type HttpResponse } from '../src/confluence/ConfluenceClient';

interface FakePage {
  id: string;
  title: string;
  space: string;
  version: number;
  parent: string | null;
  body: string;
  status: 'current' | 'trashed';
  labels: string[];
  attachments: Record<string, number>;
}

/** Answers like the Confluence REST API v1 (only what the sync uses) */
class FakeConfluence {
  pages = new Map<string, FakePage>();
  requests: string[] = [];
  token = 'secret-token';
  spaces = [
    { key: 'DOC', name: 'Dokumentation' },
    { key: 'TEAM', name: 'Team' },
    { key: 'ARCH', name: 'Architektur und Betrieb' },
  ];
  private next = 1000;

  handle = async (req: HttpRequest): Promise<HttpResponse> => {
    const path = req.url.pathname.replace(/^\/wiki\/rest\/api/, '');
    this.requests.push(`${req.method} ${path}`);
    const json = (status: number, body: unknown): HttpResponse => ({ status, body: Buffer.from(JSON.stringify(body)) });
    if (req.headers.Authorization !== `Basic ${Buffer.from(`anna@example.org:${this.token}`).toString('base64')}`) return json(401, { message: 'Unauthorized' });
    const input = req.body && req.headers['Content-Type'] === 'application/json' ? JSON.parse(req.body.toString('utf8')) : null;
    const raw = (p: FakePage) => ({ id: p.id, title: p.title, status: p.status, version: { number: p.version }, space: { key: p.space }, ancestors: p.parent ? [{ id: p.parent }] : [] });
    const clash = (space: string, title: string, self?: string) => [...this.pages.values()].some((p) => p.status === 'current' && p.space === space && p.title === title && p.id !== self);

    if (path === '/user/current') return json(200, { displayName: 'Anna Atlassian', type: 'known' });
    if (path === '/space') {
      // Two pages of spaces, like a large instance
      const start = Number(req.url.searchParams.get('start') ?? 0);
      return json(200, start === 0 ? { results: this.spaces.slice(0, 2), _links: { next: '/rest/api/space?start=2' } } : { results: this.spaces.slice(2) });
    }
    const sm = /^\/space\/([^/]+)$/.exec(path);
    if (sm) {
      const space = this.spaces.find((s) => s.key === decodeURIComponent(sm![1]));
      return space ? json(200, space) : json(404, { message: 'No space with key' });
    }
    if (path === '/search') {
      const word = /title~"([^"*]+)\*"/.exec(req.url.searchParams.get('cql') ?? '')?.[1].toLowerCase() ?? '';
      const hits = this.spaces.filter((s) => s.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(word)));
      return json(200, { results: hits.map((s) => ({ title: s.name, space: s })) });
    }
    if (path === '/content' && req.method === 'GET') {
      const title = req.url.searchParams.get('title');
      const space = req.url.searchParams.get('spaceKey');
      return json(200, { results: [...this.pages.values()].filter((p) => p.status === 'current' && p.title === title && p.space === space).map(raw) });
    }
    if (path === '/content/search') return json(200, { results: [...this.pages.values()].filter((p) => p.status === 'current').map(raw) });
    let m = /^\/content\/(\d+)$/.exec(path);
    if (m) {
      const page = this.pages.get(m[1]);
      if (!page || (req.method !== 'GET' && page.status !== 'current')) return json(404, { message: 'No content found' });
      if (req.method === 'GET') return json(200, raw(page));
      if (req.method === 'DELETE') {
        page.status = 'trashed';
        return { status: 204, body: Buffer.alloc(0) };
      }
      if (input.version.number !== page.version + 1) return json(409, { message: 'Version must be incremented' });
      if (clash(page.space, input.title, page.id)) return json(400, { message: 'A page with this title already exists' });
      Object.assign(page, { title: input.title, version: input.version.number, body: input.body.storage.value, parent: input.ancestors?.[0]?.id ?? page.parent });
      return json(200, raw(page));
    }
    if (path === '/content' && req.method === 'POST') {
      if (clash(input.space.key, input.title)) return json(400, { message: 'A page with this title already exists' });
      const page: FakePage = { id: String(this.next++), title: input.title, space: input.space.key, version: 1, parent: input.ancestors?.[0]?.id ?? null, body: input.body.storage.value, status: 'current', labels: [], attachments: {} };
      this.pages.set(page.id, page);
      return json(200, raw(page));
    }
    m = /^\/content\/(\d+)\/label$/.exec(path);
    if (m) {
      this.pages.get(m[1])!.labels.push(...(input as { name: string }[]).map((l) => l.name));
      return json(200, {});
    }
    m = /^\/content\/(\d+)\/child\/attachment$/.exec(path);
    if (m) {
      const name = /filename="([^"]+)"/.exec(req.body!.toString('latin1'))![1];
      this.pages.get(m[1])!.attachments[name] = req.body!.length;
      return json(200, { results: [] });
    }
    return json(404, { message: `unknown ${req.method} ${path}` });
  };

  byTitle(title: string): FakePage | undefined {
    return [...this.pages.values()].find((p) => p.title === title && p.status === 'current');
  }
}

let tmpDir = '';
let server: Server;
let base = '';
const db = openDatabase(':memory:');
const cipher = new DataCipher(crypto.randomBytes(32));
const users = new UserStore(db);
const audit = new AuditLog(db);
const fake = new FakeConfluence();
let sync: ConfluenceSync;
let notes: NoteStore;
let files: FileStore;

const anna = users.createUser('anna');
const ben = users.createUser('ben');
const annaCookie = `kladde_session=${users.createSession(anna.id)}`;
const benCookie = `kladde_session=${users.createSession(ben.id)}`;

const versions = new Map<string, number>();
function put(userId: string, id: string, notePath: string, content: string, deleted = false) {
  const [r] = notes.push(userId, [{ id, baseVersion: versions.get(id) ?? 0, path: notePath, content, deleted, createdAt: 1, updatedAt: Date.now() }]);
  if (r.status !== 'ok') throw new Error(`push ${id}: ${r.status}`);
  versions.set(id, r.version!);
}

async function call<T>(method: string, url: string, body?: unknown, cookie = annaCookie): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}/api/confluence${url}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-confluence-test-'));
  notes = new NoteStore(db, cipher, (e) => sync?.onNoteChange(e));
  files = new FileStore(db, cipher, tmpDir);
  sync = new ConfluenceSync(new ConfluenceStore(db, cipher), notes, files, { transport: fake.handle, debounceMs: 10 });
  const app = express();
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api/confluence', confluenceRouter({ users, sync, audit, allowPrivate: false }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await sync.idle();
  server?.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Confluence URL check', () => {
  it('only allows https, adds /wiki for Atlassian Cloud and cuts browser paths', () => {
    expect(normalizeConfluenceUrl('https://firma.atlassian.net/wiki/spaces/DOC/overview', 'cloud', false)).toBe('https://firma.atlassian.net/wiki');
    expect(normalizeConfluenceUrl('https://firma.atlassian.net', 'cloud', false)).toBe('https://firma.atlassian.net/wiki');
    expect(normalizeConfluenceUrl('https://wiki.firma.de/confluence/display/DOC/Start', 'datacenter', false)).toBe('https://wiki.firma.de/confluence');
    expect(() => normalizeConfluenceUrl('http://wiki.firma.de', 'datacenter', false)).toThrow(/https/);
    expect(() => normalizeConfluenceUrl('https://192.168.1.10', 'datacenter', false)).toThrow(/Private/);
    expect(() => normalizeConfluenceUrl('https://confluence.local', 'datacenter', false)).toThrow(/Private/);
    expect(normalizeConfluenceUrl('https://192.168.1.10:8443/', 'datacenter', true)).toBe('https://192.168.1.10:8443');
  });
});

describe('Confluence connection (#48)', () => {
  it('tests and saves a connection per user, keeps the token encrypted and never sends it back', async () => {
    const wrong = await call<{ error: string }>('POST', '/connection/test', { url: 'https://firma.atlassian.net', kind: 'cloud', email: 'anna@example.org', token: 'falsch' });
    expect(wrong.status).toBe(502);
    expect(wrong.data.error).toMatch(/Token/);

    const test = await call<{ accountName: string }>('POST', '/connection/test', { url: 'https://firma.atlassian.net', kind: 'cloud', email: 'anna@example.org', token: fake.token });
    expect(test.data.accountName).toBe('Anna Atlassian');

    const saved = await call<ConfluenceOverview>('PUT', '/connection', { url: 'https://firma.atlassian.net/wiki/home', kind: 'cloud', email: 'anna@example.org', token: fake.token });
    expect(saved.status).toBe(200);
    expect(saved.data.connection).toMatchObject({ url: 'https://firma.atlassian.net/wiki', kind: 'cloud', email: 'anna@example.org', accountName: 'Anna Atlassian' });
    expect(JSON.stringify(saved.data)).not.toContain(fake.token);
    const row = db.prepare('SELECT data FROM confluence_accounts WHERE user_id = ?').get(anna.id) as { data: Uint8Array };
    expect(Buffer.from(row.data).toString('latin1')).not.toContain(fake.token);
    expect(audit.recent(5, 'confluence_connected')[0]).toMatchObject({ userId: anna.id });

    // Changing other fields keeps the saved token
    const again = await call<ConfluenceOverview>('PUT', '/connection', { url: 'https://firma.atlassian.net', kind: 'cloud', email: 'anna@example.org' });
    expect(again.status).toBe(200);
    // Other users see nothing of it
    expect((await call<ConfluenceOverview>('GET', '/', undefined, benCookie)).data.connection).toBeNull();
  });

  it('searches all spaces, not only the first page', async () => {
    expect((await call<{ key: string }[]>('GET', '/spaces?q=dok')).data.map((s) => s.key)).toEqual(['DOC']);
    // Only on the second page of /space, found by the title search
    expect((await call<{ key: string }[]>('GET', '/spaces?q=betrieb')).data.map((s) => s.key)).toEqual(['ARCH']);
    // By key
    expect((await call<{ key: string }[]>('GET', '/spaces?q=ARCH')).data.map((s) => s.key)).toEqual(['ARCH']);
    // In the middle of a word: goes through all pages of spaces
    expect((await call<{ key: string }[]>('GET', '/spaces?q=tektur')).data.map((s) => s.key)).toEqual(['ARCH']);
  });

  it('resolves a pasted link to its space and page, only for the connected instance', async () => {
    const page = { id: '555', title: 'Handbuch', space: 'ARCH', version: 1, parent: null, body: '', status: 'current' as const, labels: [], attachments: {} };
    fake.pages.set(page.id, page);
    try {
      const byId = await call<ConfluenceLinkTarget>('GET', `/resolve?url=${encodeURIComponent('https://firma.atlassian.net/wiki/spaces/ARCH/pages/555/Handbuch')}`);
      expect(byId.data).toEqual({ space: { key: 'ARCH', name: 'Architektur und Betrieb' }, page: { id: '555', title: 'Handbuch', spaceKey: 'ARCH', url: 'https://firma.atlassian.net/wiki/pages/viewpage.action?pageId=555' } });
      const byTitle = await call<ConfluenceLinkTarget>('GET', `/resolve?url=${encodeURIComponent('https://firma.atlassian.net/wiki/display/ARCH/Handbuch')}`);
      expect(byTitle.data.page?.id).toBe('555');
      const spaceOnly = await call<ConfluenceLinkTarget>('GET', `/resolve?url=${encodeURIComponent('https://firma.atlassian.net/wiki/spaces/TEAM/overview')}`);
      expect(spaceOnly.data).toEqual({ space: { key: 'TEAM', name: 'Team' }, page: null });
      const missing = await call<{ error: string }>('GET', `/resolve?url=${encodeURIComponent('https://firma.atlassian.net/wiki/spaces/ARCH/pages/999/Weg')}`);
      expect(missing.status).toBe(404);
      const other = await call<{ error: string }>('GET', `/resolve?url=${encodeURIComponent('https://andere.atlassian.net/wiki/spaces/ARCH/pages/555')}`);
      expect(other.status).toBe(400);
      expect(other.data.error).toMatch(/verbundenen/);
    } finally {
      fake.pages.delete(page.id);
    }
  });
});

describe('Note and folder sync', () => {
  let fileId = '';

  beforeEach(() => {
    fake.requests = [];
  });

  it('creates a page for a note with labels and attachments, and pushes edits debounced', async () => {
    fileId = files.save(anna.id, 'plan.png', 'image/png', Buffer.from('png-data')).id;
    put(anna.id, 'note-umzug-0001', 'Projekte/Umzug.md', `---\ntags: [projekt]\n---\n# Umzug\n\n- [ ] Kisten packen\n\n![Plan](/api/files/${fileId})\n`);
    const created = await call<ConfluenceOverview>('POST', '/syncs', { kind: 'note', noteId: 'note-umzug-0001', spaceKey: 'DOC', parentId: null });
    expect(created.status).toBe(200);
    await sync.idle();
    const page = fake.byTitle('Umzug')!;
    expect(page.space).toBe('DOC');
    expect(page.body).toContain('<ac:task-status>incomplete</ac:task-status>');
    expect(page.body).toContain('<ri:attachment ri:filename="plan.png" />');
    expect(page.attachments['plan.png']).toBeGreaterThan(0);
    expect(page.labels).toEqual(['projekt']);
    const state = (await call<{ state: ConfluenceNoteState }>('GET', '/notes/note-umzug-0001')).data.state;
    expect(state).toMatchObject({ status: 'ok', pageId: page.id, pageUrl: `https://firma.atlassian.net/wiki/pages/viewpage.action?pageId=${page.id}` });

    // An edit (also the title) is pushed automatically; the unchanged attachment is not uploaded again
    fake.requests = [];
    put(anna.id, 'note-umzug-0001', 'Projekte/Umzug 2027.md', `# Umzug 2027\n\n- [x] Kisten packen\n\n![Plan](/api/files/${fileId})\n`);
    await sync.idle();
    expect(page.title).toBe('Umzug 2027');
    expect(page.body).toContain('<ac:task-status>complete</ac:task-status>');
    expect(fake.requests.filter((r) => r.includes('/child/attachment'))).toHaveLength(0);
  });

  it('detects edits made in Confluence and asks before overwriting', async () => {
    const page = fake.byTitle('Umzug 2027')!;
    page.version += 1; // someone edited the page in Confluence
    put(anna.id, 'note-umzug-0001', 'Projekte/Umzug 2027.md', '# Umzug 2027\n\nNeuer Text');
    await sync.idle();
    expect(page.body).not.toContain('Neuer Text');
    let state = (await call<{ state: ConfluenceNoteState }>('GET', '/notes/note-umzug-0001')).data.state;
    expect(state.status).toBe('conflict');
    expect((await call<ConfluenceOverview>('GET', '/')).data.notes['note-umzug-0001']).toBe('conflict');

    state = (await call<{ state: ConfluenceNoteState }>('POST', '/notes/note-umzug-0001/run', { force: true })).data.state;
    expect(state.status).toBe('ok');
    expect(page.body).toContain('Neuer Text');
  });

  it('reports a page deleted in Confluence and recreates it on "Sync now"', async () => {
    fake.byTitle('Umzug 2027')!.status = 'trashed';
    put(anna.id, 'note-umzug-0001', 'Projekte/Umzug 2027.md', '# Umzug 2027\n\nNoch neuer');
    await sync.idle();
    let state = (await call<{ state: ConfluenceNoteState }>('GET', '/notes/note-umzug-0001')).data.state;
    expect(state).toMatchObject({ status: 'error' });
    expect(state.error).toMatch(/gelöscht/);
    state = (await call<{ state: ConfluenceNoteState }>('POST', '/notes/note-umzug-0001/run', { force: true })).data.state;
    expect(state.status).toBe('ok');
    expect(fake.byTitle('Umzug 2027')!.body).toContain('Noch neuer');
  });

  it('syncs a folder as a page tree, links synced notes and creates new notes as pages', async () => {
    put(anna.id, 'note-handbuch-01', 'Doku/Handbuch.md', '# Handbuch\n\nSiehe [[Installation]] und [[Umzug 2027]].');
    put(anna.id, 'note-install-001', 'Doku/Technik/Installation.md', '# Installation\n\n```bash\nnpm ci\n```');
    const res = await call<ConfluenceOverview>('POST', '/syncs', { kind: 'folder', folder: 'Doku', spaceKey: 'DOC', parentId: null, trashOnDelete: true });
    expect(res.status).toBe(200);
    const syncId = res.data.syncs.find((s) => s.kind === 'folder')!.id;
    await sync.idle();
    // Links resolve once the target is synced: a second run fills them in
    await call('POST', `/syncs/${syncId}/run`, { force: true });

    const root = fake.byTitle('Doku')!;
    const technik = fake.byTitle('Technik')!;
    const install = fake.byTitle('Installation')!;
    const handbuch = fake.byTitle('Handbuch')!;
    expect(root.body).toContain('ac:name="children"');
    expect(technik.parent).toBe(root.id);
    expect(install.parent).toBe(technik.id);
    expect(handbuch.parent).toBe(root.id);
    expect(install.body).toContain('<ac:parameter ac:name="language">bash</ac:parameter>');
    expect(handbuch.body).toContain('ri:content-title="Installation"');
    // The single-note sync from before is linked as well (same user, synced)
    expect(handbuch.body).toContain('ri:content-title="Umzug 2027"');

    put(anna.id, 'note-faq-000001', 'Doku/FAQ.md', '# FAQ');
    await sync.idle();
    expect(fake.byTitle('FAQ')?.parent).toBe(root.id);

    const overview = (await call<ConfluenceOverview>('GET', '/')).data;
    expect(overview.syncs.find((s) => s.id === syncId)).toMatchObject({ label: 'Doku', notes: 3, errors: 0 });
  });

  it('a title clash gets the folder name as a suffix', async () => {
    put(anna.id, 'note-umzug-doku1', 'Doku/Umzug 2027.md', '# Umzug 2027\n\nDoppelt');
    await sync.idle();
    expect(fake.byTitle('Umzug 2027 (Doku)')?.body).toContain('Doppelt');
  });

  it('moves the page to the trash when a note is deleted or moved out (option), and stops on request', async () => {
    const faq = fake.byTitle('FAQ')!;
    put(anna.id, 'note-faq-000001', 'Doku/FAQ.md', '', true);
    await sync.idle();
    expect(faq.status).toBe('trashed');

    const install = fake.byTitle('Installation')!;
    put(anna.id, 'note-install-001', 'Archiv/Installation.md', '# Installation');
    await sync.idle();
    expect(install.status).toBe('trashed');

    // Stop syncing one note of the folder: its page stays and later edits are not pushed
    const handbuch = fake.byTitle('Handbuch')!;
    expect((await call('POST', '/notes/note-handbuch-01/stop')).status).toBe(200);
    put(anna.id, 'note-handbuch-01', 'Doku/Handbuch.md', '# Handbuch\n\nNach dem Stopp');
    await sync.idle();
    expect(handbuch.status).toBe('current');
    expect(handbuch.body).not.toContain('Nach dem Stopp');
    expect((await call<{ state: unknown }>('GET', '/notes/note-handbuch-01')).data.state).toBeNull();
  });

  it('only owners set up a sync; shared notes are not synced on behalf of others', async () => {
    put(ben.id, 'note-ben-000001', 'Ben/Geheim.md', '# Geheim');
    await call('PUT', '/connection', { url: 'https://firma.atlassian.net', kind: 'cloud', email: 'anna@example.org', token: fake.token }, benCookie);
    notes.share(ben.id, 'note-ben-000001', anna.id, true);
    const res = await call<{ error: string }>('POST', '/syncs', { kind: 'note', noteId: 'note-ben-000001', spaceKey: 'DOC' });
    expect(res.status).toBe(404);
    expect(fake.byTitle('Geheim')).toBeUndefined();
  });

  it('removing the connection drops the syncs but leaves the pages', async () => {
    const before = fake.pages.size;
    const res = await call<ConfluenceOverview>('DELETE', '/connection');
    expect(res.data).toMatchObject({ connection: null, syncs: [] });
    expect(fake.pages.size).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM confluence_pages WHERE user_id = ?').get(anna.id)).toEqual({ n: 0 });
    expect(audit.recent(5, 'confluence_disconnected')[0]).toMatchObject({ userId: anna.id });
  });
});
