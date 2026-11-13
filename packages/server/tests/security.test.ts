import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { DatabaseSync } from 'node:sqlite';
import { createKladdeApp } from '../src/app';
import { MIGRATIONS, migrate, openDatabase } from '../src/db';
import { appCsp, inlineScriptHashes } from '../src/security/csp';

const THEME_SCRIPT = "document.documentElement.dataset.scheme = 'dark';";

describe('Content-Security-Policy', () => {
  it('hashes inline scripts and skips external ones', () => {
    const html = `<script>${THEME_SCRIPT}</script><script type="module" src="/assets/app.js"></script>`;
    const expected = `'sha256-${crypto.createHash('sha256').update(THEME_SCRIPT).digest('base64')}'`;
    expect(inlineScriptHashes(html)).toEqual([expected]);
  });

  it('never allows inline or eval scripts', () => {
    const csp = appCsp(["'sha256-abc'"]);
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'sha256-abc'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toMatch(/'unsafe-eval'/);
    expect(csp).toContain("object-src 'none'");
  });

  describe('served by the app', () => {
    let tmpDir = '';
    let server: Server;
    let base = '';

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-csp-'));
      const dist = path.join(tmpDir, 'dist');
      fs.mkdirSync(dist);
      fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><script>${THEME_SCRIPT}</script>`);
      // A working copy left behind by the removed Git sync
      fs.mkdirSync(path.join(tmpDir, 'git', 'u1'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'git', 'u1', 'note.md'), 'secret');
      const { app } = createKladdeApp({
        db: openDatabase(':memory:'),
        dataDir: tmpDir,
        standalone: false,
        isProduction: true,
        publicUrl: null,
        trustProxy: false,
        clientDist: dist,
      });
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(() => {
      server?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('sends the policy with the hash of the inline theme script', async () => {
      const res = await fetch(`${base}/some/page`);
      expect(res.status).toBe(200);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain(`'sha256-${crypto.createHash('sha256').update(THEME_SCRIPT).digest('base64')}'`);
      expect(csp).toContain("frame-ancestors 'self'");
    });

    it('removes the plain-text working copies of the old Git sync', () => {
      expect(fs.existsSync(path.join(tmpDir, 'git'))).toBe(false);
    });
  });
});

describe('Git sync removal', () => {
  it('drops the git_sync table with its stored access tokens', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain('git_sync');
  });

  it('drops it from databases that had Git sync set up', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 10));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'git_sync'").get()).toBeTruthy();
    migrate(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'git_sync'").get()).toBeUndefined();
  });
});
