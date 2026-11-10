import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { AdminUser, FolderShares, Me, NoteShares, PublicNote, PullResponse } from '@kladde/shared';
import { createKladdeApp } from '../src/app';
import { AvatarStore, MAX_AVATAR_BYTES } from '../src/AvatarStore';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { UserStore } from '../src/UserStore';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP_MAGIC = Buffer.from('RIFF\x12\x00\x00\x00WEBPVP8 ', 'latin1');

describe('AvatarStore (encryption at rest, validation, rotation)', () => {
  it('stores encrypted avatars on disk, validates magic bytes, rotates on replace and clears on remove or ban', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-avatar-unit-'));
    const db = openDatabase(':memory:');
    try {
      const users = new UserStore(db);
      const cipher = new DataCipher(crypto.randomBytes(32));
      const store = new AvatarStore(db, cipher, tmp);
      const anna = users.createUser('anna');

      expect(() => store.save(anna.id, 'image/svg+xml', Buffer.from('<svg/>'))).toThrow();
      expect(() => store.save(anna.id, 'image/png', Buffer.alloc(0))).toThrow();
      expect(() => store.save(anna.id, 'image/png', Buffer.from('not-a-png-at-all'))).toThrow();
      expect(() => store.save(anna.id, 'image/png', Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_AVATAR_BYTES)]))).toThrow();

      const first = store.save(anna.id, 'image/png', PNG_MAGIC);
      expect(first.url).toBe(`/api/avatars/${first.id}`);
      const firstDisk = path.join(tmp, 'avatars', first.id);
      expect(fs.existsSync(firstDisk)).toBe(true);
      const encrypted = fs.readFileSync(firstDisk);
      expect(encrypted.subarray(0, 8).equals(PNG_MAGIC.subarray(0, 8))).toBe(false);

      const loaded = store.load(first.id);
      expect(loaded?.mime).toBe('image/png');
      expect(loaded?.data.equals(PNG_MAGIC)).toBe(true);

      const second = store.save(anna.id, 'image/jpeg', JPEG_MAGIC);
      expect(second.id).not.toBe(first.id);
      expect(fs.existsSync(firstDisk)).toBe(false);
      expect(store.load(first.id)).toBeNull();
      expect(store.load(second.id)?.data.equals(JPEG_MAGIC)).toBe(true);

      users.setBanned(anna.id, true);
      expect(store.load(second.id)).toBeNull();
      users.setBanned(anna.id, false);
      expect(store.load(second.id)?.mime).toBe('image/jpeg');

      expect(store.remove(anna.id)).toBe(true);
      expect(store.load(second.id)).toBeNull();
      expect(fs.existsSync(path.join(tmp, 'avatars', second.id))).toBe(false);
      expect(users.getUser(anna.id)?.avatarUrl).toBeNull();
    } finally {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Avatar HTTP API & propagation in multi-user mode', () => {
  let tmpDir = '';
  let db: ReturnType<typeof openDatabase>;
  let ctx: ReturnType<typeof createKladdeApp>;
  let server: Server;
  let base = '';
  let annaId = '';
  let benId = '';
  let annaCookie = '';
  let benCookie = '';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-avatar-http-'));
    db = openDatabase(path.join(tmpDir, 'kladde.sqlite'));
    ctx = createKladdeApp({
      db,
      dataDir: tmpDir,
      standalone: false,
      isProduction: false,
      publicUrl: null,
      trustProxy: false,
    });
    const anna = ctx.users.createUser('anna');
    const ben = ctx.users.createUser('ben');
    annaId = anna.id;
    benId = ben.id;
    annaCookie = `kladde_session=${ctx.users.createSession(anna.id)}`;
    benCookie = `kladde_session=${ctx.users.createSession(ben.id)}`;

    server = ctx.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
    db?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uploads, serves, propagates to shares/admin/public notes, and deletes avatars', async () => {
    const unauth = await fetch(`${base}/api/me/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: PNG_MAGIC,
    });
    expect(unauth.status).toBe(401);

    const tooBig = await fetch(`${base}/api/me/avatar`, {
      method: 'POST',
      headers: { Cookie: annaCookie, 'Content-Type': 'image/png' },
      body: Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_AVATAR_BYTES)]),
    });
    expect(tooBig.status).toBe(400);

    const now = Date.now();
    ctx.notes.push(annaId, [
      { id: 'av-note-1', baseVersion: 0, path: 'Rezepte/Pasta.md', content: '# Pasta', deleted: false, createdAt: now, updatedAt: now },
    ]);
    ctx.notes.shareFolder(annaId, 'Rezepte', benId, { canWrite: true });
    const publicToken = ctx.notes.setPublic(annaId, 'av-note-1', true)!;
    const beforeCursor = ctx.notes.pull(benId, 0).cursor;

    const uploadAnna = await fetch(`${base}/api/me/avatar`, {
      method: 'POST',
      headers: { Cookie: annaCookie, 'Content-Type': 'image/png' },
      body: PNG_MAGIC,
    });
    expect(uploadAnna.status).toBe(200);
    const annaMe = (await uploadAnna.json()) as Me;
    expect(annaMe.avatarUrl).toMatch(/^\/api\/avatars\/[A-Za-z0-9_-]{22}$/);

    const uploadBen = await fetch(`${base}/api/me/avatar`, {
      method: 'POST',
      headers: { Cookie: benCookie, 'Content-Type': 'image/webp' },
      body: WEBP_MAGIC,
    });
    expect(uploadBen.status).toBe(200);
    const benMe = (await uploadBen.json()) as Me;
    expect(benMe.avatarUrl).toMatch(/^\/api\/avatars\/[A-Za-z0-9_-]{22}$/);

    // Public avatar delivery (no session required) with strict headers
    const imgRes = await fetch(`${base}${annaMe.avatarUrl}`);
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get('content-type')).toBe('image/png');
    expect(imgRes.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await imgRes.arrayBuffer()).equals(PNG_MAGIC)).toBe(true);

    // Me endpoint reflects avatar
    const meCheck = (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: annaCookie } })).json()) as Me;
    expect(meCheck.avatarUrl).toBe(annaMe.avatarUrl);

    // Admin list reflects avatars
    const adminUsers = (await (await fetch(`${base}/api/admin/users`, { headers: { Cookie: annaCookie } })).json()) as AdminUser[];
    expect(adminUsers.find((u) => u.username === 'anna')?.avatarUrl).toBe(annaMe.avatarUrl);
    expect(adminUsers.find((u) => u.username === 'ben')?.avatarUrl).toBe(benMe.avatarUrl);

    // Share lists reflect recipient avatar
    const noteShares = (await (
      await fetch(`${base}/api/notes/av-note-1/shares`, { headers: { Cookie: annaCookie } })
    ).json()) as NoteShares;
    expect(noteShares.users[0].avatarUrl).toBe(benMe.avatarUrl);

    const folderShares = (await (
      await fetch(`${base}/api/folders/shares?folder=Rezepte`, { headers: { Cookie: annaCookie } })
    ).json()) as FolderShares;
    expect(folderShares.users[0].avatarUrl).toBe(benMe.avatarUrl);

    // Public note exposes ownerAvatar
    const pub = (await (await fetch(`${base}/api/public/${publicToken}`)).json()) as PublicNote;
    expect(pub.ownerAvatar).toBe(annaMe.avatarUrl);

    // Incremental pull delivers Anna's new ownerAvatar on notes & sharedFolders
    const pullBen = (await (
      await fetch(`${base}/api/sync?since=${beforeCursor}`, { headers: { Cookie: benCookie } })
    ).json()) as PullResponse;
    expect(pullBen.notes[0]?.ownerAvatar).toBe(annaMe.avatarUrl);
    expect(pullBen.sharedFolders?.[0]?.ownerAvatar).toBe(annaMe.avatarUrl);

    // Deleting Anna's avatar revokes the image URL and clears ownerAvatar everywhere
    const delCursor = pullBen.cursor;
    const delRes = await fetch(`${base}/api/me/avatar`, { method: 'DELETE', headers: { Cookie: annaCookie } });
    expect(delRes.status).toBe(200);
    const delMe = (await delRes.json()) as Me;
    expect(delMe.avatarUrl).toBeNull();

    const goneImg = await fetch(`${base}${annaMe.avatarUrl}`);
    expect(goneImg.status).toBe(404);

    const pubAfter = (await (await fetch(`${base}/api/public/${publicToken}`)).json()) as PublicNote;
    expect(pubAfter.ownerAvatar).toBeUndefined();

    const pullAfterDel = (await (
      await fetch(`${base}/api/sync?since=${delCursor}`, { headers: { Cookie: benCookie } })
    ).json()) as PullResponse;
    expect(pullAfterDel.notes[0]?.ownerAvatar).toBeUndefined();
    expect(pullAfterDel.sharedFolders?.[0]?.ownerAvatar).toBeUndefined();
  });
});

describe('Avatar HTTP API in standalone mode', () => {
  let tmpDir = '';
  let db: ReturnType<typeof openDatabase>;
  let ctx: ReturnType<typeof createKladdeApp>;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-avatar-standalone-'));
    db = openDatabase(path.join(tmpDir, 'kladde.sqlite'));
    ctx = createKladdeApp({
      db,
      dataDir: tmpDir,
      standalone: true,
      isProduction: true,
      publicUrl: null,
      trustProxy: false,
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

  it('supports uploading and removing the local user profile picture', async () => {
    const up = await fetch(`${base}/api/me/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: JPEG_MAGIC,
    });
    expect(up.status).toBe(200);
    const me = (await up.json()) as Me;
    expect(me.standalone).toBe(true);
    expect(me.avatarUrl).toMatch(/^\/api\/avatars\/[A-Za-z0-9_-]{22}$/);

    const meAgain = (await (await fetch(`${base}/api/auth/me`)).json()) as Me;
    expect(meAgain.avatarUrl).toBe(me.avatarUrl);

    const img = await fetch(`${base}${me.avatarUrl}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');

    const del = await fetch(`${base}/api/me/avatar`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as Me).avatarUrl).toBeNull();
  });
});
