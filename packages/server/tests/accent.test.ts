import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Me } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { NoteStore } from '../src/NoteStore';
import { UserStore } from '../src/UserStore';

// Accent color of the Werkbank design: one preset per account, default blue
let server: Server;
let base = '';
let tmpDir = '';
const db = openDatabase(':memory:');
const cipher = new DataCipher(crypto.randomBytes(32));
const users = new UserStore(db);
const notes = new NoteStore(db, cipher);
const anna = users.createUser('anna');
const cookie = `kladde_session=${users.createSession(anna.id)}`;

const putAccent = (accent: unknown) =>
  fetch(`${base}/api/me/accent`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ accent }) });

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-accent-test-'));
  const app = express();
  app.use('/api', apiRouter(users, notes, new FileStore(db, cipher, tmpDir), new LiveUpdates(), {}));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('accent color', () => {
  it('is blue until the user picks another one', () => {
    expect(users.getUser(anna.id)?.accent).toBe('blue');
  });

  it('stores a preset with the account and returns the updated account', async () => {
    const res = await putAccent('green');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Me).accent).toBe('green');
    expect(users.getUser(anna.id)?.accent).toBe('green');
  });

  it('refuses unknown values and keeps the previous one', async () => {
    for (const bad of ['#ff0000', 'red', '', null, 42]) expect((await putAccent(bad)).status).toBe(400);
    expect(users.getUser(anna.id)?.accent).toBe('green');
  });

  it('needs a session', async () => {
    const res = await fetch(`${base}/api/me/accent`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accent: 'teal' }) });
    expect(res.status).toBe(401);
  });
});

describe('display name', () => {
  const putName = (displayName: unknown, withCookie = true) =>
    fetch(`${base}/api/me/display-name`, { method: 'PUT', headers: { ...(withCookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }) });

  it('is empty until the user sets one', () => {
    expect(users.getUser(anna.id)?.displayName).toBeNull();
  });

  it('stores one line, trimmed and bounded', async () => {
    const res = await putName('  Anna \n Adler\u0000 ');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Me).displayName).toBe('Anna Adler');
    await putName('x'.repeat(200));
    expect(users.getUser(anna.id)?.displayName).toHaveLength(80);
  });

  it('removes it with an empty value or null', async () => {
    await putName('');
    expect(users.getUser(anna.id)?.displayName).toBeNull();
    await putName('Anna');
    await putName(null);
    expect(users.getUser(anna.id)?.displayName).toBeNull();
  });

  it('refuses other types and needs a session', async () => {
    expect((await putName(42)).status).toBe(400);
    expect((await putName('Anna', false)).status).toBe(401);
  });
});
