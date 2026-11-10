import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createKladdeApp } from '../src/app';
import { MIGRATIONS, migrate, openDatabase } from '../src/db';
import { findAppBrowser } from '../src/desktop';
import {
  mimeTypeFor,
  packClientAssets,
  resolveDataDir,
  resolveDbPath,
  resolveListenPort,
  STANDALONE_DEFAULT_PORT,
  unpackClientAssets,
} from '../src/standalone';

describe('Standalone data directory and port resolution', () => {
  it('stores data in LOCALAPPDATA\\Kladde on Windows by default', () => {
    const dir = resolveDataDir({
      standalone: true,
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\Max\\AppData\\Local' },
      argv: [],
      execPath: 'D:\\Tools\\kladde.exe',
      homeDir: 'C:\\Users\\Max',
      existsSync: () => false,
    });
    expect(dir).toBe('C:\\Users\\Max\\AppData\\Local\\Kladde');
  });

  it('activates portable sibling folder when kladde-data exists or --portable-data is passed', () => {
    const detected = resolveDataDir({
      standalone: true,
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\Max\\AppData\\Local' },
      argv: [],
      execPath: 'E:\\USB\\Kladde\\kladde.exe',
      homeDir: 'C:\\Users\\Max',
      existsSync: (p) => p === 'E:\\USB\\Kladde\\kladde-data',
    });
    expect(detected).toBe('E:\\USB\\Kladde\\kladde-data');

    const forced = resolveDataDir({
      standalone: true,
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\Max\\AppData\\Local' },
      argv: ['--portable-data'],
      execPath: 'E:\\USB\\Kladde\\kladde.exe',
      homeDir: 'C:\\Users\\Max',
      existsSync: () => false,
    });
    expect(forced).toBe('E:\\USB\\Kladde\\kladde-data');
  });

  it('respects OS conventions on macOS/Linux and honors explicit --data-dir / DB_PATH', () => {
    expect(
      resolveDataDir({
        standalone: true,
        platform: 'darwin',
        env: {},
        argv: [],
        execPath: '/Applications/kladde',
        homeDir: '/Users/max',
        existsSync: () => false,
      })
    ).toBe('/Users/max/Library/Application Support/Kladde');

    expect(
      resolveDataDir({
        standalone: true,
        platform: 'linux',
        env: { XDG_DATA_HOME: '/home/max/.xdg-data' },
        argv: [],
        execPath: '/usr/local/bin/kladde',
        homeDir: '/home/max',
        existsSync: () => false,
      })
    ).toBe('/home/max/.xdg-data/kladde');

    const explicit = resolveDataDir({
      standalone: true,
      platform: 'win32',
      env: {},
      argv: ['--data-dir=D:\\Notes\\KladdeData'],
      execPath: 'C:\\kladde.exe',
      existsSync: () => false,
    });
    expect(explicit).toBe('D:\\Notes\\KladdeData');
    expect(resolveDbPath(explicit, {}, [], 'win32')).toBe('D:\\Notes\\KladdeData\\kladde.sqlite');
  });

  it('uses fixed standalone port 34172 unless explicitly overridden', () => {
    expect(resolveListenPort({}, [], true)).toEqual({ port: STANDALONE_DEFAULT_PORT, explicit: false });
    expect(resolveListenPort({}, [], false)).toEqual({ port: 3002, explicit: false });
    expect(resolveListenPort({}, ['--port=41234'], true)).toEqual({ port: 41234, explicit: true });
    expect(resolveListenPort({ PORT: '4567' }, [], true)).toEqual({ port: 4567, explicit: true });
  });
});

describe('Embedded SEA asset packing and browser lookup', () => {
  it('round-trips frontend asset directories via the KLDA binary format', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-assets-test-'));
    try {
      fs.mkdirSync(path.join(tmp, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><html><body>Kladde</body></html>', 'utf8');
      fs.writeFileSync(path.join(tmp, 'assets', 'main-abc.js'), 'console.log("ok");', 'utf8');
      fs.writeFileSync(path.join(tmp, 'assets', 'app.css'), 'body{color:#fff}', 'utf8');
      fs.writeFileSync(path.join(tmp, 'icon.svg'), '<svg/>', 'utf8');

      const blob = packClientAssets(tmp);
      const unpacked = unpackClientAssets(blob);

      expect(unpacked.size).toBe(4);
      expect(unpacked.get('/index.html')?.mime).toBe('text/html; charset=utf-8');
      expect(unpacked.get('/index.html')?.data.toString('utf8')).toContain('Kladde');
      expect(unpacked.get('/assets/main-abc.js')?.mime).toBe('application/javascript; charset=utf-8');
      expect(unpacked.get('/assets/app.css')?.mime).toBe('text/css; charset=utf-8');
      expect(unpacked.get('/icon.svg')?.mime).toBe('image/svg+xml');
      expect(mimeTypeFor('font.woff2')).toBe('font/woff2');
      expect(() => unpackClientAssets(Buffer.from('NOPE'))).toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prefers Microsoft Edge and falls back to Chrome on Windows', () => {
    const edge = findAppBrowser({
      platform: 'win32',
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      existsSync: (p) => p === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    });
    expect(edge).toEqual({
      kind: 'edge',
      executable: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    });

    const chromeFallback = findAppBrowser({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      existsSync: (p) => p === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    expect(chromeFallback).toEqual({
      kind: 'chrome',
      executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });

    const none = findAppBrowser({ platform: 'win32', env: {}, existsSync: () => false });
    expect(none).toBeNull();
  });

  it('creates an automatic backup before applying SQLite schema migrations on an existing DB', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-mig-test-'));
    try {
      const dbPath = path.join(tmp, 'kladde.sqlite');
      const backupDir = path.join(tmp, 'backups');

      const seed = openDatabase(':memory:');
      seed.close();

      // Seed an older schema DB manually (v1 only)
      const legacy = new DatabaseSync(dbPath);
      migrate(legacy, MIGRATIONS.slice(0, 1));
      legacy.prepare("INSERT INTO users (id, username, username_lower, created_at) VALUES ('u1', 'lokal', 'lokal', 1)").run();
      legacy.close();

      const upgraded = openDatabase(dbPath, { backupDir });
      try {
        const version = Number((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
        expect(version).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
        const backups = fs.readdirSync(backupDir).filter((f) => f.endsWith('.sqlite'));
        expect(backups.length).toBe(1);
      } finally {
        upgraded.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Standalone HTTP app mode (no auth, local encrypted SQLite, security hardening)', () => {
  let tmpDir = '';
  let server: Server;
  let base = '';
  let ctx: ReturnType<typeof createKladdeApp>;
  let db: ReturnType<typeof openDatabase>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-standalone-app-'));
    db = openDatabase(path.join(tmpDir, 'kladde.sqlite'), { backupDir: path.join(tmpDir, 'backups') });

    const assetSrc = path.join(tmpDir, '_assets');
    fs.mkdirSync(path.join(assetSrc, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(assetSrc, 'index.html'), '<!doctype html><html><title>Kladde</title></html>', 'utf8');
    fs.writeFileSync(path.join(assetSrc, 'assets', 'index-test.js'), 'window.__KLADDE=1;', 'utf8');
    const seaAssets = unpackClientAssets(packClientAssets(assetSrc));

    ctx = createKladdeApp({
      db,
      dataDir: tmpDir,
      standalone: true,
      isProduction: true,
      publicUrl: null,
      trustProxy: false,
      seaAssets,
    });

    server = ctx.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
    db?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-provisions single local user and serves embedded frontend with Service Worker disabled', async () => {
    const health = (await (await fetch(`${base}/health`)).json()) as { ok: boolean; standalone: boolean };
    expect(health.ok).toBe(true);
    expect(health.standalone).toBe(true);

    const meRes = await fetch(`${base}/api/auth/me`);
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { username: string; standalone: boolean; isAdmin: boolean; dataDir: string };
    expect(me.username).toBe('lokal');
    expect(me.standalone).toBe(true);
    expect(me.isAdmin).toBe(false);
    expect(me.dataDir).toBe(tmpDir);

    const swRes = await fetch(`${base}/sw.js`);
    expect(swRes.status).toBe(404);

    const htmlRes = await fetch(`${base}/`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('cache-control')).toBe('no-store');
    expect(await htmlRes.text()).toContain('<title>Kladde</title>');

    const jsRes = await fetch(`${base}/assets/index-test.js`);
    expect(jsRes.status).toBe(200);
    expect(await jsRes.text()).toContain('__KLADDE=1');
  });

  it('blocks cross-origin / cross-site browser requests against the local /api', async () => {
    const evilOrigin = await fetch(`${base}/api/auth/me`, { headers: { Origin: 'https://evil.example' } });
    expect(evilOrigin.status).toBe(403);

    const crossSite = await fetch(`${base}/api/sync`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
  });

  it('disables multi-user, login, admin and sharing endpoints', async () => {
    const disabledCalls: [string, RequestInit?][] = [
      ['/api/auth/password/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
      ['/api/auth/logout', { method: 'POST' }],
      ['/api/admin/status'],
      ['/api/public/some-token'],
      ['/api/notes/n1/shares'],
      ['/api/notes/n1/public', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' }],
      ['/api/folders/shares?folder=Projekte'],
      ['/api/folders/renamed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"from":"A","to":"B"}' }],
      ['/api/folders/deleted', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"folder":"A"}' }],
    ];

    for (const [url, init] of disabledCalls) {
      const res = await fetch(`${base}${url}`, init);
      expect(res.status, `${url} should return 404`).toBe(404);
    }
  });

  it('syncs notes encrypted in SQLite, stores encrypted attachments, and serves local MCP tools', async () => {
    const now = Date.now();
    const pushRes = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        changes: [
          {
            id: 'local-note-1',
            baseVersion: 0,
            path: '0 Inbox/Lokaltest.md',
            content: '# Lokale Notiz\n\nGeheimes Stichwort: Bernsteinkammer',
            deleted: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });
    expect(pushRes.status).toBe(200);
    const pushBody = (await pushRes.json()) as { results: { id: string; status: string; version?: number }[] };
    expect(pushBody.results[0]).toMatchObject({ id: 'local-note-1', status: 'ok', version: 1 });

    // Confirm encrypted at rest in SQLite
    const rawRow = db.prepare('SELECT payload FROM notes WHERE id = ?').get('local-note-1') as { payload: Buffer };
    expect(rawRow.payload.toString('utf8')).not.toContain('Bernsteinkammer');

    const pullRes = await fetch(`${base}/api/sync?since=0`);
    expect(pullRes.status).toBe(200);
    const pullBody = (await pullRes.json()) as { notes: { id: string; path: string; content: string }[] };
    expect(pullBody.notes.some((n) => n.id === 'local-note-1' && n.content.includes('Bernsteinkammer'))).toBe(true);

    // File upload & download without session cookie
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploadRes = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'x-filename': encodeURIComponent('skizze.png'),
      },
      body: pngBytes,
    });
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as { id: string; url: string };
    const fetchFileRes = await fetch(`${base}${uploaded.url}`);
    expect(fetchFileRes.status).toBe(200);
    expect(Buffer.from(await fetchFileRes.arrayBuffer()).equals(pngBytes)).toBe(true);

    // Create MCP personal token without login cookie and query local notes
    const patRes = await fetch(`${base}/api/mcp/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Claude Desktop Lokal', canWrite: false }),
    });
    expect(patRes.status).toBe(200);
    const pat = (await patRes.json()) as { token: string };

    const mcpRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_notes', arguments: { query: 'Bernsteinkammer' } },
      }),
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as { result: { content: { text: string }[] } };
    expect(mcpBody.result.content[0].text).toContain('0 Inbox/Lokaltest.md');
  });
});
