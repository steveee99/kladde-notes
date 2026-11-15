import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { FEATURES_SETTING, toDateString, type ImportTokenCreated } from '@kladde/shared';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const db = openDatabase(':memory:');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-shortcuts-'));
const ctx = createKladdeApp({
  db,
  dataDir,
  env: { DATA_KEY: crypto.randomBytes(32).toString('base64') },
  standalone: false,
  isProduction: false,
  publicUrl: 'https://notes.example',
  trustProxy: false,
});
const { users, notes } = ctx;
const anna = users.createUser('anna');
const ben = users.createUser('ben');
const annaCookie = `kladde_session=${users.createSession(anna.id)}`;
const today = toDateString(new Date());
const yesterday = toDateString(new Date(Date.now() - 86_400_000));

let server: Server;
let base = '';
let secret = '';

beforeAll(async () => {
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const now = Date.now();
  notes.push(anna.id, [
    { id: 'anna-0001', baseVersion: 0, path: 'Projekte/Umzug.md', content: `# Umzug\n\n- [ ] Kartons 📅 ${yesterday}\n- [ ] Strom ummelden 📅 ${today} ⏰ 09:00\n- [x] Erledigt 📅 ${today}\n- [ ] Ohne Datum\n`, deleted: false, createdAt: now, updatedAt: now },
    { id: `syssettings-${anna.id}`, baseVersion: 0, path: '.kladde/settings.json', content: JSON.stringify({ [FEATURES_SETTING]: { daily: { enabled: true, folder: 'Journal', format: 'YYYY-MM-DD' } } }), deleted: false, createdAt: now, updatedAt: now },
  ]);
  notes.push(ben.id, [{ id: 'ben-00001', baseVersion: 0, path: 'Bens Tagebuch.md', content: '- [ ] Bens Aufgabe 📅 2020-01-01\n', deleted: false, createdAt: now, updatedAt: now }]);
  const res = await fetch(`${base}/api/shortcut-tokens`, { method: 'POST', headers: { Cookie: annaCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'iPhone' }) });
  expect(res.status).toBe(200);
  secret = ((await res.json()) as ImportTokenCreated).secret;
});

afterAll(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (route: string, body: unknown, token = secret) =>
  fetch(`${base}/api/shortcuts/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const annaNote = (pathName: string) => notes.ownedNotes(anna.id).find((n) => n.path === pathName);

describe('Apple Shortcuts API', () => {
  it('creates tokens that only work on the shortcut endpoints', async () => {
    expect(secret.startsWith('kls_')).toBe(true);
    const list = (await (await fetch(`${base}/api/shortcut-tokens`, { headers: { Cookie: annaCookie } })).json()) as { name: string; expiresAt: number }[];
    expect(list.map((t) => t.name)).toEqual(['iPhone']);
    // A year by default: the token lives on a phone
    expect(list[0].expiresAt - Date.now()).toBeGreaterThan(360 * 86_400_000);
    // Not an import token, and no cookie access
    const importRes = await fetch(`${base}/api/import/notes`, { headers: { Authorization: `Bearer ${secret}` } });
    expect(importRes.status).toBe(401);
    expect((await post('capture', { text: 'x' }, 'kls_wrong')).status).toBe(401);
    const cookieOnly = await fetch(`${base}/api/shortcuts/tasks`, { headers: { Cookie: annaCookie } });
    expect(cookieOnly.status).toBe(401);
  });

  it('captures text and links into the inbox and returns the web URL', async () => {
    const res = await post('capture', { text: 'Idee für den Garten\nmit Details', tags: 'garten, ideen' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; path: string; url: string };
    expect(body.path).toBe('0 Inbox/Idee für den Garten.md');
    expect(body.url).toBe(`https://notes.example/n/${body.id}`);
    expect(annaNote(body.path)!.content).toBe('Idee für den Garten\nmit Details\n\n#garten #ideen\n');

    const link = (await (await post('capture', { url: 'https://example.com/article', title: 'Ein [Artikel]' })).json()) as { path: string };
    expect(annaNote(link.path)!.content).toBe('[Ein Artikel](https://example.com/article)\n');
    expect((await post('capture', { url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await post('capture', {})).status).toBe(400);
    expect((await post('capture', { text: 'x', folder: '.kladde' })).status).toBe(400);
  });

  it('stores an uploaded photo encrypted and embeds it in a new note', async () => {
    const res = await fetch(`${base}/api/shortcuts/attachment?name=Whiteboard.png&text=Vom%20Meeting`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'image/png' },
      body: PNG,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; file: string };
    expect(body.path).toBe('0 Inbox/Whiteboard.md');
    expect(annaNote(body.path)!.content).toBe(`![Whiteboard.png](${body.file})\n\nVom Meeting\n`);
    const empty = await fetch(`${base}/api/shortcuts/attachment`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } });
    expect(empty.status).toBe(400);
  });

  it('appends to a note or to today\'s daily note (creating it)', async () => {
    const res = await post('append', { path: 'Projekte/Umzug', text: '- [ ] Schlüssel abgeben' });
    expect(res.status).toBe(200);
    expect(annaNote('Projekte/Umzug.md')!.content).toContain('- [ ] Ohne Datum\n- [ ] Schlüssel abgeben\n');

    const daily = (await (await post('append', { text: 'Gedanke von unterwegs' })).json()) as { path: string };
    expect(daily.path).toBe(`Journal/${today}.md`);
    expect(annaNote(daily.path)!.content).toBe(`# ${today}\n\nGedanke von unterwegs\n`);
    // The second time the same daily note is used
    await post('append', { text: 'Noch einer' });
    expect(annaNote(daily.path)!.content).toBe(`# ${today}\n\nGedanke von unterwegs\n\nNoch einer\n`);

    // Someone else's note is never found
    expect((await post('append', { id: 'ben-00001', text: 'nope' })).status).toBe(400);
  });

  it('adds tasks to the free tasks or to a note', async () => {
    const res = await post('task', { text: 'Milch kaufen', due: 'tomorrow', repeat: 'weekly', time: '8:30' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: string; url: string };
    const tomorrow = toDateString(new Date(Date.now() + 86_400_000));
    expect(body.task).toBe(`- [ ] Milch kaufen 📅 ${tomorrow} ⏰ 8:30 🔁 weekly`);
    expect(body.url).toBe('https://notes.example/tasks');
    expect(notes.ownedNotes(anna.id).find((n) => n.id === `sysfreetasks-${anna.id}`)!.content).toBe(`${body.task}\n`);
    await post('task', { text: 'Zweite', due: '2026-12-01T09:00:00+01:00' });
    expect(notes.ownedNotes(anna.id).find((n) => n.id === `sysfreetasks-${anna.id}`)!.content).toBe(`${body.task}\n- [ ] Zweite 📅 2026-12-01\n`);

    await post('task', { text: 'Umzugswagen buchen', path: 'Projekte/Umzug.md' });
    expect(annaNote('Projekte/Umzug.md')!.content).toContain('- [ ] Umzugswagen buchen\n');
    expect((await post('task', { text: 'x', due: 'irgendwann' })).status).toBe(400);
    expect((await post('task', { text: 'x', time: '25:00' })).status).toBe(400);
  });

  it('lists due tasks with counts and a summary', async () => {
    const res = await fetch(`${base}/api/shortcuts/tasks?days=1`, { headers: { Authorization: `Bearer ${secret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number>; summary: string; tasks: { text: string; bucket: string; url: string }[] };
    expect(body.counts).toEqual({ overdue: 1, today: 1, upcoming: 1 });
    expect(body.tasks.map((t) => t.text)).toEqual(['Kartons', 'Strom ummelden', 'Milch kaufen']);
    expect(body.summary).toBe('1 heute fällig, 1 überfällig');
    expect(body.tasks[0].url).toMatch(/^https:\/\/notes\.example\/n\/anna-0001\?line=3$/);
    // Ben's tasks never show up
    expect(JSON.stringify(body)).not.toContain('Bens Aufgabe');
    const en = (await (await fetch(`${base}/api/shortcuts/tasks?days=0&lang=en`, { headers: { Authorization: `Bearer ${secret}` } })).json()) as { summary: string };
    expect(en.summary).toBe('1 due today, 1 overdue');
  });

  it('stops working once revoked and records it in the audit log', async () => {
    const [token] = (await (await fetch(`${base}/api/shortcut-tokens`, { headers: { Cookie: annaCookie } })).json()) as { id: string }[];
    const del = await fetch(`${base}/api/shortcut-tokens/${token.id}`, { method: 'DELETE', headers: { Cookie: annaCookie } });
    expect(del.status).toBe(200);
    expect((await post('capture', { text: 'zu spät' })).status).toBe(401);
    const events = db.prepare('SELECT event FROM audit_log ORDER BY rowid').all() as { event: string }[];
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['shortcut_token_created', 'shortcut_token_revoked']));
  });
});
