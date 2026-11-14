import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CalendarFeed, CalendarFeedCreated } from '@kladde/shared';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';

const db = openDatabase(':memory:');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-calendar-'));
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
    { id: 'anna-0001', baseVersion: 0, path: 'Arbeit/Bericht.md', content: '- [ ] Bericht abgeben 📅 2026-12-01', deleted: false, createdAt: now, updatedAt: now },
    { id: 'anna-0002', baseVersion: 0, path: 'Privat.md', content: '- [ ] Geschenk kaufen 📅 2026-12-20 🔁 jährlich', deleted: false, createdAt: now, updatedAt: now },
  ]);
  notes.push(ben.id, [{ id: 'ben-00001', baseVersion: 0, path: 'Ben.md', content: '- [ ] Bens Geheimnis 📅 2026-12-02', deleted: false, createdAt: now, updatedAt: now }]);
  notes.share(ben.id, 'ben-00001', anna.id, true);
});

afterAll(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function createFeed(body: Record<string, unknown>, cookie = annaCookie): Promise<CalendarFeedCreated> {
  const res = await fetch(`${base}/api/calendar-feeds`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as CalendarFeedCreated;
}

describe('calendar feed', () => {
  it('serves the own due tasks through the secret address, without shared notes', async () => {
    const created = await createFeed({ name: 'Alles' });
    expect(created.path).toMatch(/^\/api\/calendar\/klc_[\w-]+\.ics$/);
    const res = await fetch(`${base}${created.path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const ics = await res.text();
    expect(ics).toContain('SUMMARY:Bericht abgeben');
    expect(ics).toContain('RRULE:FREQ=YEARLY');
    expect(ics).toContain(`URL:${base}/n/anna-0001`);
    expect(ics).not.toContain('Geheimnis');
  });

  it('applies the options and keeps the folder filter out of the database in plain text', async () => {
    const created = await createFeed({ name: 'Arbeit', options: { folder: 'Arbeit', showTitles: false, lang: 'en' } });
    const ics = await (await fetch(`${base}${created.path}`)).text();
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain('SUMMARY:Task');
    expect(ics).not.toContain('Bericht');
    const row = db.prepare('SELECT * FROM calendar_feeds WHERE id = ?').get(created.feed.id) as Record<string, unknown>;
    expect(Buffer.from(row.options as Uint8Array).toString('latin1')).not.toContain('Arbeit/');
    expect(JSON.stringify(row)).not.toContain(created.path.slice('/api/calendar/'.length, -4));
  });

  it('lists feeds, refuses unknown secrets and stops serving revoked feeds', async () => {
    const created = await createFeed({ name: 'Weg damit', days: 30 });
    const list = (await (await fetch(`${base}/api/calendar-feeds`, { headers: { Cookie: annaCookie } })).json()) as CalendarFeed[];
    expect(list.map((f) => f.name)).toContain('Weg damit');
    expect((await fetch(`${base}/api/calendar/klc_unknown.ics`)).status).toBe(404);
    await fetch(`${base}/api/calendar-feeds/${created.feed.id}`, { method: 'DELETE', headers: { Cookie: annaCookie, Origin: base } });
    expect((await fetch(`${base}${created.path}`)).status).toBe(404);
  });

  it('needs a session to manage feeds and rejects invalid lifetimes', async () => {
    expect((await fetch(`${base}/api/calendar-feeds`)).status).toBe(401);
    const res = await fetch(`${base}/api/calendar-feeds`, {
      method: 'POST',
      headers: { Cookie: annaCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', days: 3 }),
    });
    expect(res.status).toBe(400);
  });
});
