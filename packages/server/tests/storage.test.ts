import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { AdminUser, MyStorage } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { adminRouter } from '../src/admin/adminRouter';
import { AuditLog } from '../src/security/AuditLog';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { GroupStore } from '../src/GroupStore';
import { NoteStore } from '../src/NoteStore';
import { StorageStore, defaultQuotaBytes } from '../src/StorageStore';
import { UserStore } from '../src/UserStore';

const MB = 1024 * 1024;
const PNG = Buffer.alloc(MB, 1);

let tmpDir = '';
let server: Server;
let base = '';
const db = openDatabase(':memory:');
const cipher = new DataCipher(crypto.randomBytes(32));
const users = new UserStore(db);
const notes = new NoteStore(db, cipher);
const storage = new StorageStore(db, null);
const root = users.createUser('root', true);
const ben = users.createUser('ben');
const rootCookie = `kladde_session=${users.createSession(root.id)}`;
const benCookie = `kladde_session=${users.createSession(ben.id)}`;

const upload = (cookie: string, data = PNG) =>
  fetch(`${base}/api/files`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/png', 'X-Filename': 'a.png' }, body: data });
const setQuota = (id: string, mb: number | null) =>
  fetch(`${base}/api/admin/storage/${id}/quota`, { method: 'PUT', headers: { Cookie: rootCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ mb }) });

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-storage-test-'));
  const files = new FileStore(db, cipher, tmpDir);
  files.guard = (owner, size) => storage.assertRoom(owner, size);
  const app = express();
  app.use('/api', (req, res, next) => (req.path === '/files' ? next() : express.json({ limit: '256kb' })(req, res, next)));
  app.use('/api/admin', adminRouter({ users, storage, audit: new AuditLog(db), status: () => ({ version: 't', startedAt: 0, users: 0, notes: 0, shares: 0, connections: 0 }) }));
  app.use('/api', apiRouter(users, notes, files, new LiveUpdates(), { storage, groups: new GroupStore(db) }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Storage quotas (#91)', () => {
  it('reads the default from STORAGE_QUOTA_MB', () => {
    expect(defaultQuotaBytes({ STORAGE_QUOTA_MB: '50' })).toBe(50 * MB);
    expect(defaultQuotaBytes({ STORAGE_QUOTA_MB: '0' })).toBeNull();
    expect(defaultQuotaBytes({ STORAGE_QUOTA_MB: 'x' })).toBeNull();
    expect(defaultQuotaBytes({})).toBeNull();
  });

  it('counts attachments in the usage and shows it to the admin and the user', async () => {
    expect((await upload(benCookie)).status).toBe(200);
    const mine = (await (await fetch(`${base}/api/storage`, { headers: { Cookie: benCookie } })).json()) as MyStorage;
    expect(mine.user.attachments).toBe(MB);
    expect(mine.user.quota).toBeNull();
    const list = (await (await fetch(`${base}/api/admin/users`, { headers: { Cookie: rootCookie } })).json()) as AdminUser[];
    expect(list.find((u) => u.username === 'ben')?.storage.total).toBeGreaterThanOrEqual(MB);
  });

  it('refuses uploads over the quota with 413, and unlimited or default lifts it', async () => {
    expect((await setQuota(ben.id, 2)).status).toBe(200);
    expect((await upload(benCookie)).status).toBe(200); // 2 MB used, exactly full
    const res = await upload(benCookie);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/Speicherplatz/);
    expect((await setQuota(ben.id, 0)).status).toBe(200);
    expect((await upload(benCookie)).status).toBe(200);
    expect((await setQuota(ben.id, null)).status).toBe(200);
  });

  it('is admin only and validates the limit', async () => {
    expect((await fetch(`${base}/api/admin/storage/${ben.id}/quota`, { method: 'PUT', headers: { Cookie: benCookie, 'Content-Type': 'application/json' }, body: '{"mb":1}' })).status).toBe(403);
    expect((await setQuota(ben.id, -1)).status).toBe(400);
    expect((await setQuota('nope', 1)).status).toBe(404);
  });

  it('lists groups with their storage and takes quotas for them', async () => {
    const group = new GroupStore(db).create(root.id, 'Team');
    const res = await setQuota(group.id, 5);
    expect(res.status).toBe(200);
    const groups = (await (await fetch(`${base}/api/admin/storage/groups`, { headers: { Cookie: rootCookie } })).json()) as { name: string; storage: { quota: number } }[];
    expect(groups.find((g) => g.name === 'Team')?.storage.quota).toBe(5 * MB);
  });
});
