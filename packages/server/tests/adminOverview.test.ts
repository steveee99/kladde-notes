import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { AdminOverview, PushChange } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { adminRouter } from '../src/admin/adminRouter';
import { JobLog } from '../src/admin/JobLog';
import { overviewBuilder } from '../src/admin/overview';
import { AuditLog } from '../src/security/AuditLog';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { GroupStore } from '../src/GroupStore';
import { NoteStore } from '../src/NoteStore';
import { StorageStore } from '../src/StorageStore';
import { UserStore } from '../src/UserStore';

let tmpDir = '';
let server: Server;
let base = '';
const db = openDatabase(':memory:');
const cipher = new DataCipher(crypto.randomBytes(32));
const users = new UserStore(db);
const notes = new NoteStore(db, cipher);
const groups = new GroupStore(db);
const jobs = new JobLog();
const live = new LiveUpdates();
// The first account becomes admin on its own
const root = users.createUser('root');
const ben = users.createUser('ben');
const rootCookie = `kladde_session=${users.createSession(root.id)}`;
const benCookie = `kladde_session=${users.createSession(ben.id)}`;

const ids = { n1: crypto.randomUUID(), n2: crypto.randomUUID(), db1: crypto.randomUUID() };
const change = (id: string, p: string, content = '# x'): PushChange => ({ id, baseVersion: 0, path: p, content, deleted: false, createdAt: 1, updatedAt: 1 });
const get = (cookie: string) => fetch(`${base}/api/admin/overview`, { headers: { Cookie: cookie } });

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-overview-test-'));
  const files = new FileStore(db, cipher, tmpDir);
  const overview = overviewBuilder({
    db,
    dbPath: null,
    dataDir: tmpDir,
    startedAt: Date.now() - 1000,
    jobs,
    online: () => live.online(),
    connections: () => live.connections,
    databases: () => notes.countDatabases(),
    lastBackupAt: () => null,
  });
  const app = express();
  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api/admin', adminRouter({ users, storage: new StorageStore(db), audit: new AuditLog(db), status: () => ({ version: 't', startedAt: 0, users: 0, notes: 0, shares: 0, connections: 0 }), overview }));
  app.use('/api', apiRouter(users, notes, files, live, { groups, jobs }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin dashboard', () => {
  it('is for admins only', async () => {
    expect((await get(benCookie)).status).toBe(403);
  });

  it('counts notes once, databases and groups, and lists device syncs as jobs', async () => {
    groups.create(root.id, 'Team');
    const res = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { Cookie: rootCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: [change(ids.n1, 'A.md'), change(ids.n2, 'Books/B.md'), change(ids.db1, 'Books/_database.md', '---\ntype: database\n---\n')] }),
    });
    expect(res.status).toBe(200);
    // A share does not make a note count twice
    notes.share(root.id, ids.n1, ben.id, false);

    const o = (await (await get(rootCookie)).json()) as AdminOverview;
    expect(o.counts).toMatchObject({ users: 2, groups: 1, notes: 3, databases: 1, shares: 1 });
    expect(o.jobs[0]).toMatchObject({ kind: 'sync', user: 'root', count: 3, ok: true });
    expect(o.system.memory.total).toBeGreaterThan(0);
    expect(o.system.cpu.cores).toBeGreaterThan(0);
    expect(o.system.disk?.total).toBeGreaterThan(0);
    expect(o.online).toEqual({ connections: 0, users: [] });
  });

  it('keeps the latest jobs only', () => {
    const log = new JobLog();
    for (let i = 0; i < 80; i++) log.add({ kind: 'sync', at: i, durationMs: 1, ok: true });
    expect(log.list(100)).toHaveLength(50);
    expect(log.list(1)[0].at).toBe(79);
  });
});
