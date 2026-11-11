import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { ImportToken, ImportTokenCreated } from '@kladde/shared';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';
import { McpTokenStore } from '../src/mcp/McpTokenStore';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const db = openDatabase(':memory:');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-import-api-'));
const ctx = createKladdeApp({
  db,
  dataDir,
  env: { DATA_KEY: crypto.randomBytes(32).toString('base64') },
  standalone: false,
  isProduction: false,
  publicUrl: null,
  trustProxy: false,
});
const { users, notes } = ctx;
const anna = users.createUser('anna');
const ben = users.createUser('ben');
const annaCookie = `kladde_session=${users.createSession(anna.id)}`;

let server: Server;
let base = '';

beforeAll(async () => {
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const now = Date.now();
  notes.push(anna.id, [
    { id: 'anna-0001', baseVersion: 0, path: 'Projekte/Umzug.md', content: 'Kartons', deleted: false, createdAt: now, updatedAt: now },
    { id: 'anna-0002', baseVersion: 0, path: '.kladde/settings.json', content: '{}', deleted: false, createdAt: now, updatedAt: now },
  ]);
  notes.push(ben.id, [{ id: 'ben-00001', baseVersion: 0, path: 'Bens Tagebuch.md', content: 'Nur für Ben', deleted: false, createdAt: now, updatedAt: now }]);
  notes.share(ben.id, 'ben-00001', anna.id, true);
});

afterAll(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const bearer = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

async function createToken(cookie = annaCookie, name = 'Laptop'): Promise<ImportTokenCreated> {
  const res = await fetch(`${base}/api/import-tokens`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ImportTokenCreated;
}

async function postNotes(token: string, items: unknown[]) {
  const res = await fetch(`${base}/api/import/notes`, {
    method: 'POST',
    headers: bearer(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ notes: items }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('import tokens (account router)', () => {
  it('creates, lists and revokes tokens; only hashes are stored', async () => {
    const created = await createToken(annaCookie, '  Mein Laptop  ');
    expect(created.secret).toMatch(/^kli_/);
    expect(created.token.name).toBe('Mein Laptop');
    expect(created.token.lastUsedAt).toBeNull();

    const list = (await (await fetch(`${base}/api/import-tokens`, { headers: { Cookie: annaCookie } })).json()) as ImportToken[];
    expect(list.map((t) => t.id)).toContain(created.token.id);

    const dump = JSON.stringify(db.prepare('SELECT * FROM import_tokens').all());
    expect(dump).not.toContain(created.secret);
    expect(dump).toContain(crypto.createHash('sha256').update(created.secret).digest('hex'));

    expect((await fetch(`${base}/api/import/notes`, { headers: bearer(created.secret) })).status).toBe(200);
    const used = (await (await fetch(`${base}/api/import-tokens`, { headers: { Cookie: annaCookie } })).json()) as ImportToken[];
    expect(used.find((t) => t.id === created.token.id)?.lastUsedAt).toBeGreaterThan(0);

    // Someone else cannot revoke it
    const benCookie = `kladde_session=${users.createSession(ben.id)}`;
    await fetch(`${base}/api/import-tokens/${created.token.id}`, { method: 'DELETE', headers: { Cookie: benCookie } });
    expect((await fetch(`${base}/api/import/notes`, { headers: bearer(created.secret) })).status).toBe(200);

    const after = (await (await fetch(`${base}/api/import-tokens/${created.token.id}`, { method: 'DELETE', headers: { Cookie: annaCookie } })).json()) as ImportToken[];
    expect(after.map((t) => t.id)).not.toContain(created.token.id);
    const revoked = await fetch(`${base}/api/import/notes`, { headers: bearer(created.secret) });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: 'Import-Token ungültig oder widerrufen' });

    const events = ctx.audit.recent(10).map((e) => `${e.event}:${e.detail}`);
    expect(events).toContain('import_token_created:Mein Laptop');
    expect(events).toContain('import_token_revoked:Mein Laptop');
  });

  it('needs a session cookie', async () => {
    expect((await fetch(`${base}/api/import-tokens`)).status).toBe(401);
  });
});

describe('import API authentication', () => {
  it('rejects a banned user\'s token', async () => {
    const carl = users.createUser('carl');
    const { secret } = await createToken(`kladde_session=${users.createSession(carl.id)}`);
    expect((await fetch(`${base}/api/import/notes`, { headers: bearer(secret) })).status).toBe(200);
    users.setBanned(carl.id, true);
    expect((await fetch(`${base}/api/import/notes`, { headers: bearer(secret) })).status).toBe(401);
  });

  it('rejects MCP tokens and session cookies, and import tokens work nowhere else', async () => {
    const { token: mcpToken } = new McpTokenStore(db).createPersonalToken(anna.id, 'MCP', true);
    expect((await fetch(`${base}/api/import/notes`, { headers: bearer(mcpToken) })).status).toBe(401);
    expect((await fetch(`${base}/api/import/notes`, { headers: { Cookie: annaCookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/import/notes`)).status).toBe(401);

    const { secret } = await createToken();
    expect((await fetch(`${base}/api/sync`, { headers: bearer(secret) })).status).toBe(401);
    expect((await fetch(`${base}/api/files`, { headers: bearer(secret) })).status).toBe(401);
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: bearer(secret, { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(401);

    const res = await fetch(`${base}/api/import/notes`, { headers: bearer(secret, { Origin: 'https://evil.example' }) });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('import API', () => {
  let secret = '';
  beforeAll(async () => {
    secret = (await createToken()).secret;
  });

  it('lists only own, non-system paths', async () => {
    const res = await fetch(`${base}/api/import/notes`, { headers: bearer(secret) });
    expect(await res.json()).toEqual({ paths: ['Projekte/Umzug.md'] });
  });

  it('creates new notes that sync like any change', async () => {
    const before = notes.currentSeq();
    const { status, body } = await postNotes(secret, [
      { path: 'Import/Neu.md', content: '# Neu', updatedAt: 1_700_000_000_000 },
      { path: 'Import/Zukunft.md', content: 'x', updatedAt: Date.now() + 10_000_000 },
    ]);
    expect(status).toBe(200);
    expect(body.results).toEqual([
      { path: 'Import/Neu.md', status: 'created' },
      { path: 'Import/Zukunft.md', status: 'created' },
    ]);
    const pulled = notes.pull(anna.id, before).notes;
    const neu = pulled.find((n) => n.path === 'Import/Neu.md')!;
    expect(neu.content).toBe('# Neu');
    expect(neu.createdAt).toBe(1_700_000_000_000);
    expect(pulled.find((n) => n.path === 'Import/Zukunft.md')!.updatedAt).toBeLessThanOrEqual(Date.now());
  });

  it('skips existing paths (case-insensitive) and duplicates without touching the existing note', async () => {
    const existing = notes.ownedNotes(anna.id).find((n) => n.path === 'Projekte/Umzug.md')!;
    const { body } = await postNotes(secret, [
      { path: 'projekte/UMZUG.md', content: 'Überschrieben?' },
      { path: 'Import/Doppelt.md', content: 'eins' },
      { path: 'import/doppelt.md', content: 'zwei' },
    ]);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['skipped', 'created', 'skipped']);
    const after = notes.ownedNotes(anna.id).find((n) => n.id === existing.id)!;
    expect(after.content).toBe('Kartons');
    expect(after.version).toBe(existing.version);
    expect(notes.ownedNotes(anna.id).find((n) => n.path === 'Import/Doppelt.md')!.content).toBe('eins');
  });

  it('rejects system and non-.md paths, and oversized batches', async () => {
    const { body } = await postNotes(secret, [
      { path: '.kladde/settings.md', content: 'x' },
      { path: 'Import/Text.txt', content: 'x' },
      { path: '../..', content: 'x' },
      { path: 'Import/Gross.md', content: 'x'.repeat(2 * 1024 * 1024 + 1) },
    ]);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
    expect(notes.ownedNotes(anna.id).some((n) => n.path === '.kladde/settings.md' || n.path.endsWith('.txt'))).toBe(false);

    const tooMany = Array.from({ length: 101 }, (_, i) => ({ path: `Import/n${i}.md`, content: 'x' }));
    expect((await postNotes(secret, tooMany)).status).toBe(400);
    expect(notes.ownedNotes(anna.id).some((n) => n.path === 'Import/n0.md')).toBe(false);
  });

  it('stores allowed attachments and rejects other types', async () => {
    const ok = await fetch(`${base}/api/import/files`, {
      method: 'POST',
      headers: bearer(secret, { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('bild ä.png') }),
      body: PNG,
    });
    expect(ok.status).toBe(200);
    const saved = (await ok.json()) as { id: string; url: string; name: string };
    expect(saved.url).toBe(`/api/files/${saved.id}`);
    expect(saved.name).toBe('bild ä.png');
    expect(ctx.files.getMeta(anna.id, saved.id)?.mime).toBe('image/png');

    const bad = await fetch(`${base}/api/import/files`, {
      method: 'POST',
      headers: bearer(secret, { 'Content-Type': 'application/zip', 'X-Filename': 'x.zip' }),
      body: Buffer.from('PK'),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBeTruthy();
  });
});

describe('standalone mode', () => {
  it('has no import endpoints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-import-standalone-'));
    const alone = createKladdeApp({
      db: openDatabase(':memory:'),
      dataDir: dir,
      env: { DATA_KEY: crypto.randomBytes(32).toString('base64') },
      standalone: true,
      isProduction: false,
      publicUrl: null,
      trustProxy: false,
    });
    const s = alone.app.listen(0);
    await new Promise((r) => s.once('listening', r));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${url}/api/import/notes`)).status).toBe(404);
      expect((await fetch(`${url}/api/import-tokens`)).status).toBe(404);
    } finally {
      s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
