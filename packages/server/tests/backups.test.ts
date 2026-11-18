import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import type { AddressInfo } from 'net';
import type { AdminBackupOverview } from '@kladde/shared';
import { createKladdeApp } from '../src/app';
import { BackupService, RESTORE_MARKER, applyPendingRestore } from '../src/backup/BackupService';
import { writeTar, tarSize } from '../src/backup/tar';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { FileStore } from '../src/FileStore';
import { NoteStore } from '../src/NoteStore';
import { ServerSettings } from '../src/ServerSettings';
import { UserStore } from '../src/UserStore';

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function setup(defaultKeep = 7) {
  const dataDir = tempDir('kladde-backup-data-');
  const dbPath = path.join(dataDir, 'kladde.sqlite');
  const backupDir = path.join(dataDir, 'backups');
  const db = openDatabase(dbPath);
  const cipher = new DataCipher(crypto.randomBytes(32));
  const users = new UserStore(db);
  const notes = new NoteStore(db, cipher);
  const files = new FileStore(db, cipher, dataDir);
  let clock = Date.UTC(2026, 10, 18, 8, 0, 0);
  const service = new BackupService({ db, dataDir, backupDir, settings: new ServerSettings(db), defaultKeep, now: () => clock });
  const anna = users.createUser('anna');
  const push = (id: string, p: string, content: string) =>
    notes.push(anna.id, [{ id, baseVersion: 0, path: p, content, deleted: false, createdAt: clock, updatedAt: clock }]);
  return {
    cipher,
    dataDir,
    dbPath,
    backupDir,
    db,
    users,
    notes,
    files,
    service,
    anna,
    push,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

/** Reads a ustar archive into name → content */
function untar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    expect(parseInt(field(148, 8), 8)).toBe(sum);
    out.set(name, buf.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function tarOf(service: BackupService, id: string): Promise<Buffer> {
  const dl = service.download(id);
  if (dl?.kind !== 'tar') throw new Error('no tar');
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c) => chunks.push(c));
  await writeTar(dl.entries, sink);
  const buf = Buffer.concat(chunks);
  expect(buf.length).toBe(tarSize(dl.entries));
  return buf;
}

describe('BackupService', () => {
  it('takes a full backup with the database and hard-linked, still encrypted attachments', async () => {
    const { service, push, files, anna, dataDir, backupDir } = setup();
    push('note-backup1', 'Projekte/Plan.md', 'geheimer Plan');
    const file = files.save(anna.id, 'bild.png', 'image/png', Buffer.from('PNGDATA'));

    const backup = await service.create('manual');
    expect(backup).toMatchObject({ kind: 'full', trigger: 'manual', files: 1, restorable: true, id: 'kladde-2026-11-18-08-00-00' });
    expect(backup.size).toBeGreaterThan(0);
    const copy = path.join(backupDir, backup.id, 'files', file.id);
    expect(fs.statSync(copy).ino).toBe(fs.statSync(path.join(dataDir, 'files', file.id)).ino);
    expect(fs.readFileSync(copy).includes(Buffer.from('PNGDATA'))).toBe(false);
    // The key is never part of a backup, and nothing is in plain text
    expect(fs.readdirSync(path.join(backupDir, backup.id)).sort()).toEqual(['avatars', 'backup.json', 'files', 'kladde.sqlite']);
    expect(fs.readFileSync(path.join(backupDir, backup.id, 'kladde.sqlite')).includes(Buffer.from('geheimer Plan'))).toBe(false);

    const second = await service.create('manual');
    expect(second.id).toBe('kladde-2026-11-18-08-00-00-2');
    expect(service.list().map((b) => b.id)).toEqual([second.id, backup.id]);
  });

  it('lists older database-only backups and refuses unknown ids', async () => {
    const { service, backupDir } = setup();
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'kladde-2026-11-01-03-00-00.sqlite'), 'x');
    fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'x');
    expect(service.list()).toEqual([
      expect.objectContaining({ id: 'kladde-2026-11-01-03-00-00.sqlite', kind: 'database', restorable: false, createdAt: Date.UTC(2026, 10, 1, 3) }),
    ]);
    expect(service.download('kladde-2026-11-01-03-00-00.sqlite')).toMatchObject({ kind: 'file' });
    expect(service.download('../kladde.sqlite')).toBeNull();
    expect(service.remove('notes.txt')).toBe(false);
    await expect(service.requestRestore('kladde-2026-11-01-03-00-00.sqlite', 'anna')).rejects.toThrow(/vollständige/);
  });

  it('streams a full backup as a tar archive', async () => {
    const { service, files, anna } = setup();
    const file = files.save(anna.id, 'doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4 hallo'));
    const backup = await service.create();
    const entries = untar(await tarOf(service, backup.id));
    expect([...entries.keys()].sort()).toEqual(
      [`${backup.id}/backup.json`, `${backup.id}/files/${file.id}`, `${backup.id}/kladde.sqlite`].sort()
    );
    expect(JSON.parse(entries.get(`${backup.id}/backup.json`)!.toString())).toMatchObject({ trigger: 'manual', files: 1 });
    expect(entries.get(`${backup.id}/kladde.sqlite`)!.subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('runs the daily schedule and keeps only the newest scheduled backups', async () => {
    const { service, tick } = setup(2);
    expect(service.schedule()).toEqual({ enabled: true, keep: 2 });
    const manual = await service.create('manual');
    expect(await service.runSchedule()).not.toBeNull();
    tick(60 * 60 * 1000);
    expect(await service.runSchedule()).toBeNull();
    for (let i = 0; i < 3; i++) {
      tick(24 * 60 * 60 * 1000);
      expect(await service.runSchedule()).not.toBeNull();
    }
    const list = service.list();
    expect(list.filter((b) => b.trigger === 'scheduled')).toHaveLength(2);
    expect(list.some((b) => b.id === manual.id)).toBe(true);

    expect(() => service.setSchedule({ keep: 0 })).toThrow();
    expect(service.setSchedule({ enabled: false, keep: 5 })).toEqual({ enabled: false, keep: 5 });
    tick(48 * 60 * 60 * 1000);
    expect(await service.runSchedule()).toBeNull();
  });

  it('is off by default when BACKUP_KEEP is 0', () => {
    expect(setup(0).service.schedule()).toEqual({ enabled: false, keep: 7 });
  });

  it('restores database and attachments at the next start, after a safety backup', async () => {
    const env = setup();
    const { service, push, files, anna, db, dataDir, dbPath, backupDir } = env;
    push('note-keep001', 'Alt.md', 'vorher');
    const kept = files.save(anna.id, 'alt.png', 'image/png', Buffer.from('ALT'));
    const backup = await service.create();

    env.tick(1000);
    push('note-later01', 'Neu.md', 'nachher');
    const later = files.save(anna.id, 'neu.png', 'image/png', Buffer.from('NEU'));
    files.delete(anna.id, kept.id);

    const { safetyBackup } = await service.requestRestore(backup.id, 'anna');
    expect(safetyBackup.trigger).toBe('pre-restore');
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, RESTORE_MARKER), 'utf8'))).toMatchObject({ id: backup.id, username: 'anna' });
    db.close();

    const restored = applyPendingRestore({ dataDir, dbPath, backupDir });
    expect(restored).toMatchObject({ id: backup.id, username: 'anna' });
    expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER))).toBe(false);
    expect(applyPendingRestore({ dataDir, dbPath, backupDir })).toBeNull();

    const reopened = openDatabase(dbPath);
    const { cipher } = env;
    const notes = new NoteStore(reopened, cipher);
    expect(notes.ownedNotes(anna.id).map((n) => n.path)).toEqual(['Alt.md']);
    expect(fs.readdirSync(path.join(dataDir, 'files'))).toEqual([kept.id]);
    expect(new FileStore(reopened, cipher, dataDir).load(kept.id)?.data.toString()).toBe('ALT');
    expect(fs.existsSync(path.join(dataDir, 'files', later.id))).toBe(false);
    // The state before the restore is still there
    expect(fs.existsSync(path.join(backupDir, safetyBackup.id, 'files', later.id))).toBe(true);
    reopened.close();
  });
});

describe('admin backup API', () => {
  const dataDir = tempDir('kladde-backup-api-');
  const db = openDatabase(path.join(dataDir, 'kladde.sqlite'));
  let restarts = 0;
  const ctx = createKladdeApp({
    db,
    dataDir,
    env: { DATA_KEY: crypto.randomBytes(32).toString('base64') },
    standalone: false,
    isProduction: false,
    publicUrl: null,
    trustProxy: false,
    backup: { dir: path.join(dataDir, 'backups'), defaultKeep: 7 },
    onRestart: () => {
      restarts++;
    },
  });
  const admin = ctx.users.createUser('anna');
  const ben = ctx.users.createUser('ben');
  const adminCookie = `kladde_session=${ctx.users.createSession(admin.id)}`;
  const benCookie = `kladde_session=${ctx.users.createSession(ben.id)}`;

  it('lets admins create, download, configure, delete and restore backups', async () => {
    const server = ctx.app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/backups`;
    const call = (url: string, init: RequestInit = {}, cookie = adminCookie) =>
      fetch(url, { ...init, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } });
    try {
      expect((await call(base, {}, benCookie)).status).toBe(403);

      let overview = (await (await call(base)).json()) as AdminBackupOverview;
      expect(overview).toMatchObject({ backups: [], schedule: { enabled: true, keep: 7 }, busy: false });

      overview = (await (await call(base, { method: 'POST' })).json()) as AdminBackupOverview;
      expect(overview.backups).toHaveLength(1);
      const id = overview.backups[0].id;

      const dl = await call(`${base}/${id}/download`);
      expect(dl.headers.get('content-type')).toBe('application/x-tar');
      expect(dl.headers.get('content-disposition')).toContain(`${id}.tar`);
      expect(untar(Buffer.from(await dl.arrayBuffer())).has(`${id}/kladde.sqlite`)).toBe(true);

      expect((await call(`${base}/schedule`, { method: 'PUT', body: JSON.stringify({ enabled: false, keep: 500 }) })).status).toBe(400);
      overview = (await (await call(`${base}/schedule`, { method: 'PUT', body: JSON.stringify({ enabled: false, keep: 3 }) })).json()) as AdminBackupOverview;
      expect(overview.schedule).toEqual({ enabled: false, keep: 3 });

      expect((await call(`${base}/kladde-2020-01-01-00-00-00`, { method: 'DELETE' })).status).toBe(404);
      expect((await call(`${base}/${id}/restore`, { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
      const restore = await call(`${base}/${id}/restore`, { method: 'POST', body: JSON.stringify({ confirm: id }) });
      expect(restore.status).toBe(200);
      expect(await restore.json()).toMatchObject({ restarting: true });
      await new Promise((r) => setTimeout(r, 400));
      expect(restarts).toBe(1);
      expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER))).toBe(true);
      expect(ctx.audit.recent(5).map((e) => e.event)).toContain('backup_restore_requested');
      // Until the restart nothing else gets through
      expect((await call(base)).status).toBe(503);
    } finally {
      server.close();
    }
  });
});
