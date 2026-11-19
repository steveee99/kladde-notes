import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';
import { runCli } from '../src/cliActions';

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Reads the stored entries of a ZIP archive (as our writer makes them) */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(local + 26);
    out.set(name, buf.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size));
    at += 46 + nameLen;
  }
  return out;
}

const dataDir = tempDir('kladde-account-export-');
const db = openDatabase(path.join(dataDir, 'kladde.sqlite'));
const ctx = createKladdeApp({ db, dataDir, env: { DATA_KEY: crypto.randomBytes(32).toString('base64') }, standalone: false, isProduction: false, publicUrl: null, trustProxy: false });
const anna = ctx.users.createUser('anna');
const ben = ctx.users.createUser('ben');
const cookie = `kladde_session=${ctx.users.createSession(anna.id)}`;
const benCookie = `kladde_session=${ctx.users.createSession(ben.id)}`;
let server: Server;
let base = '';

beforeAll(async () => {
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const img = ctx.files.save(anna.id, 'Foto 1.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const now = Date.now();
  ctx.notes.push(anna.id, [
    { id: 'export-note-1', baseVersion: 0, path: '1 Projekte/Umzug/Plan.md', content: `# Plan\n\n![Foto](/api/files/${img.id})\n`, deleted: false, createdAt: now, updatedAt: now },
    { id: 'export-note-2', baseVersion: 0, path: '0 Inbox/Idee.md', content: 'Erste Fassung', deleted: false, createdAt: now, updatedAt: now },
    {
      id: `syssettings-${anna.id}`,
      baseVersion: 0,
      path: '.kladde/settings.json',
      content: JSON.stringify({ templates: [{ id: 't1', label: 'Meeting', folder: '', content: '# {{title}}' }], theme: 'dark' }),
      deleted: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  ctx.notes.push(anna.id, [{ id: 'export-note-2', baseVersion: 1, path: '0 Inbox/Idee.md', content: 'Zweite Fassung', deleted: false, createdAt: now, updatedAt: now + 1 }]);
  ctx.notes.share(anna.id, 'export-note-2', ben.id, false);
  ctx.notes.setPublic(anna.id, 'export-note-1', true);
});

afterAll(() => {
  server.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const api = (p: string, init: RequestInit = {}, who = cookie) =>
  fetch(`${base}/api/account-export${p}`, { ...init, headers: { Cookie: who, 'Content-Type': 'application/json', Origin: base, ...(init.headers ?? {}) } });

async function waitReady(who = cookie) {
  for (let i = 0; i < 100; i++) {
    const { export: status } = (await (await api('', {}, who)).json()) as { export: { id: string; state: string } };
    if (status.state !== 'running') return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('export did not finish');
}

describe('account export (#93)', () => {
  it('builds the archive in the background and downloads it once', async () => {
    expect(((await (await api('')).json()) as { export: unknown }).export).toBeNull();
    const started = await api('', { method: 'POST', body: JSON.stringify({ history: true }) });
    expect(started.status).toBe(202);
    const status = await waitReady();
    expect(status).toMatchObject({ state: 'ready', notes: 2, files: 1, history: true });

    // the archive on disk is encrypted
    const stored = fs.readdirSync(path.join(dataDir, 'account-exports'));
    expect(stored).toHaveLength(1);
    expect(fs.readFileSync(path.join(dataDir, 'account-exports', stored[0])).includes(Buffer.from('Zweite Fassung'))).toBe(false);

    // someone else cannot fetch it
    expect((await api(`/${status.id}/download`, {}, benCookie)).status).toBe(404);

    const res = await api(`/${status.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const zip = unzip(Buffer.from(await res.arrayBuffer()));
    expect((await api(`/${status.id}/download`)).status).toBe(404);
    expect(fs.readdirSync(path.join(dataDir, 'account-exports'))).toHaveLength(0);

    const names = [...zip.keys()];
    const attachment = names.find((n) => n.startsWith('_attachments/'))!;
    expect(attachment).toMatch(/^_attachments\/[\w-]+-Foto 1\.png$/);
    expect(zip.get('1 Projekte/Umzug/Plan.md')!.toString()).toBe(`# Plan\n\n![Foto](../../_attachments/${encodeURIComponent(attachment.slice(13))})\n`);
    expect(zip.get('0 Inbox/Idee.md')!.toString()).toBe('Zweite Fassung');
    // recent saves are merged into one history entry
    expect(names.filter((n) => n.startsWith('.history/0 Inbox/Idee/')).length).toBeGreaterThan(0);
    expect(zip.get('.templates/Meeting.md')!.toString()).toBe('# {{title}}');
    expect(names.some((n) => n.startsWith('.kladde'))).toBe(false);

    const account = JSON.parse(zip.get('kladde-account.json')!.toString());
    expect(account).toMatchObject({
      format: 'kladde-account-export',
      account: { username: 'anna' },
      templates: [{ name: 'Meeting' }],
      settings: { 'settings.json': { theme: 'dark' } },
      shares: { notes: [{ path: '0 Inbox/Idee.md', with: 'ben', canWrite: false }], publicLinks: [{ path: '1 Projekte/Umzug/Plan.md' }] },
    });

    const events = ctx.audit.recent(50).map((e) => e.event);
    expect(events).toContain('account_export_requested');
    expect(events).toContain('account_exported');
  });

  it('can be imported again with the import', async () => {
    await api('', { method: 'POST', body: JSON.stringify({}) });
    const status = await waitReady();
    expect(status).toMatchObject({ history: false });
    const zip = unzip(Buffer.from(await (await api(`/${status.id}/download`)).arrayBuffer()));
    expect([...zip.keys()].some((n) => n.startsWith('.history/'))).toBe(false);

    const folder = tempDir('kladde-account-unzipped-');
    for (const [name, data] of zip) {
      fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
      fs.writeFileSync(path.join(folder, name), data);
    }
    const cara = ctx.users.createUser('cara');
    await runCli(['import', folder, '/', '--user', 'cara'], { db, users: ctx.users, notes: ctx.notes, files: ctx.files });
    const imported = ctx.notes.ownedNotes(cara.id);
    expect(imported.map((n) => n.path).sort()).toEqual(['0 Inbox/Idee.md', '1 Projekte/Umzug/Plan.md']);
    const plan = imported.find((n) => n.path === '1 Projekte/Umzug/Plan.md')!;
    expect(plan.content).toMatch(/^# Plan\n\n!\[Foto\]\(\/api\/files\/[\w-]{22}\)\n$/);
  });

  it('lets the user discard an export', async () => {
    await api('', { method: 'POST', body: JSON.stringify({}) });
    await waitReady();
    await api('', { method: 'DELETE' });
    expect(((await (await api('')).json()) as { export: unknown }).export).toBeNull();
  });
});
