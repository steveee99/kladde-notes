import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { PushDevice, PushPayload, PushSettings } from '@kladde/shared';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';
import { encryptPayload, generateVapidKeys, isAllowedEndpoint, vapidAuthorization } from '../src/push/webpush';
import { inQuietHours, localClock, plannedPushes, taskCheck } from '../src/push/reminders';

/** A browser's side of a push subscription: its key pair and auth secret */
function fakeDevice() {
  const ecdh = crypto.createECDH('prime256v1');
  const p256dh = ecdh.generateKeys().toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  return { ecdh, p256dh, auth };
}

/** Decrypts an aes128gcm push body like the browser does (RFC 8291) */
function decrypt(body: Buffer, device: ReturnType<typeof fakeDevice>): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const shared = device.ecdh.computeSecret(asPublic);
  const uaPublic = Buffer.from(device.p256dh, 'base64url');
  const hk = (ikm: Buffer, s: Buffer, info: Buffer, n: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
  const ikm = hk(shared, Buffer.from(device.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hk(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hk(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(0x02);
  return plain.subarray(0, -1).toString('utf8');
}

const settings = (extra: Partial<PushSettings> = {}): PushSettings => ({ digestTime: null, quietStart: null, quietEnd: null, showText: false, timeZone: 'Europe/Berlin', lang: 'de', ...extra });

describe('web push protocol', () => {
  it('encrypts payloads so only the device can read them', () => {
    const device = fakeDevice();
    const body = encryptPayload(Buffer.from('{"hallo":"welt"}'), device);
    expect(body.toString('latin1')).not.toContain('hallo');
    expect(decrypt(body, device)).toBe('{"hallo":"welt"}');
  });

  it('signs a VAPID token for the push service origin', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:ops@example.org', Date.UTC(2026, 10, 14));
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:ops@example.org' });
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(keys.publicKey, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(keys.publicKey, 'base64url').subarray(33).toString('base64url') }, format: 'jwk' });
    expect(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('only talks to known push services over https', () => {
    const hosts = ['fcm.googleapis.com', 'push.apple.com'];
    expect(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/x', hosts)).toBe(true);
    expect(isAllowedEndpoint('https://web.push.apple.com/abc', hosts)).toBe(true);
    expect(isAllowedEndpoint('http://fcm.googleapis.com/x', hosts)).toBe(false);
    expect(isAllowedEndpoint('https://fcm.googleapis.com.evil.example/x', hosts)).toBe(false);
    expect(isAllowedEndpoint('https://127.0.0.1/x', hosts)).toBe(false);
    expect(isAllowedEndpoint('https://fcm.googleapis.com:8443/x', hosts)).toBe(false);
  });
});

describe('reminder planning', () => {
  const notes = [
    { id: 'n1', path: 'Arbeit.md', content: '# Arbeit\n- [ ] Standup ⏰ 09:00 📅 2026-11-14\n- [ ] Bericht 📅 2026-11-14\n- [ ] Alt 📅 2026-11-10\n- [x] Fertig ⏰ 08:00 📅 2026-11-14' },
  ];

  it('reads the local clock in the device time zone', () => {
    expect(localClock(new Date(Date.UTC(2026, 10, 14, 23, 30)), 'Europe/Berlin')).toEqual({ date: '2026-11-15', minutes: 30 });
    expect(localClock(new Date(Date.UTC(2026, 10, 14, 23, 30)), 'UTC')).toEqual({ date: '2026-11-14', minutes: 23 * 60 + 30 });
  });

  it('handles quiet hours across midnight', () => {
    const q = { quietStart: '22:00', quietEnd: '07:00' };
    expect(inQuietHours(23 * 60, q)).toBe(true);
    expect(inQuietHours(6 * 60 + 59, q)).toBe(true);
    expect(inQuietHours(7 * 60, q)).toBe(false);
  });

  it('reminds of open tasks at their time, without task text unless asked', () => {
    expect(plannedPushes(notes, settings(), { date: '2026-11-14', minutes: 8 * 60 + 59 })).toEqual([]);
    const [p] = plannedPushes(notes, settings(), { date: '2026-11-14', minutes: 9 * 60 + 1 });
    expect(p.payload).toMatchObject({ title: 'Kladde', body: 'Aufgabe fällig um 09:00', url: '/n/n1?line=2', task: { noteId: 'n1', line: 1, check: taskCheck('Standup') } });
    expect(JSON.stringify(p.payload)).not.toContain('Standup');
    const [withText] = plannedPushes(notes, settings({ showText: true }), { date: '2026-11-14', minutes: 9 * 60 + 1 });
    expect(withText.payload).toMatchObject({ title: 'Standup', body: 'Arbeit · 09:00' });
    // Far too late (server was down): skipped
    expect(plannedPushes(notes, settings(), { date: '2026-11-14', minutes: 12 * 60 })).toEqual([]);
  });

  it('waits for the end of quiet hours and sends the digest', () => {
    const quiet = settings({ quietStart: '08:00', quietEnd: '10:00', digestTime: '08:30' });
    expect(plannedPushes(notes, quiet, { date: '2026-11-14', minutes: 9 * 60 + 1 })).toEqual([]);
    const after = plannedPushes(notes, quiet, { date: '2026-11-14', minutes: 10 * 60 });
    expect(after.map((p) => p.key)).toEqual(['task|n1|2026-11-14|09:00|Standup', 'digest|2026-11-14']);
    expect(after[1].payload?.body).toBe('2 Aufgaben heute fällig, 1 überfällig');
    expect(plannedPushes(notes, settings({ digestTime: '07:00', lang: 'en' }), { date: '2026-11-14', minutes: 7 * 60 })[0].payload?.body).toBe('2 tasks due today, 1 overdue');
  });
});

describe('push API and reminder job', () => {
  const db = openDatabase(':memory:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-push-'));
  const ctx = createKladdeApp({ db, dataDir, env: { DATA_KEY: crypto.randomBytes(32).toString('base64') }, standalone: false, isProduction: false, publicUrl: null, trustProxy: false });
  const anna = ctx.users.createUser('anna');
  const cookie = `kladde_session=${ctx.users.createSession(anna.id)}`;
  const device = fakeDevice();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/device-1';
  let server: Server;
  let base = '';
  const realFetch = globalThis.fetch;
  const call = (p: string, init: RequestInit = {}) =>
    realFetch(`${base}/api/push${p}`, { ...init, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', ...init.headers } });

  beforeAll(async () => {
    server = ctx.app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const now = Date.now();
    ctx.notes.push(anna.id, [{ id: 'anna-0001', baseVersion: 0, path: 'Arbeit.md', content: '- [ ] Standup ⏰ 09:00 📅 2026-11-14', deleted: false, createdAt: now, updatedAt: now }]);
  });

  afterAll(() => {
    server.close();
    vi.unstubAllGlobals();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('registers a device, refuses foreign endpoints and stores the endpoint encrypted', async () => {
    const key = (await (await call('/key')).json()) as { publicKey: string };
    expect(Buffer.from(key.publicKey, 'base64url')).toHaveLength(65);
    const bad = await call('/devices', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'https://10.0.0.5/push', keys: { p256dh: device.p256dh, auth: device.auth } } }) });
    expect(bad.status).toBe(400);
    const res = await call('/devices', {
      method: 'POST',
      body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, name: 'Pixel', settings: { timeZone: 'Europe/Berlin', digestTime: '25:00' } }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as PushDevice;
    expect(created.settings).toMatchObject({ timeZone: 'Europe/Berlin', digestTime: null, showText: false });
    expect(JSON.stringify(db.prepare('SELECT * FROM push_subscriptions').all())).not.toContain('device-1');
  });

  it('sends a due reminder once, encrypted for the device', async () => {
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: 201 });
    });
    const at = new Date(Date.UTC(2026, 10, 14, 8, 1)); // 09:01 in Berlin
    expect(await ctx.sendReminders!(at)).toBe(1);
    expect(await ctx.sendReminders!(at)).toBe(0);
    vi.stubGlobal('fetch', realFetch);
    expect(sent[0].url).toBe(endpoint);
    expect(sent[0].headers['Content-Encoding']).toBe('aes128gcm');
    expect(sent[0].headers.Authorization).toMatch(/^vapid t=/);
    const payload = JSON.parse(decrypt(sent[0].body, device)) as PushPayload;
    expect(payload).toMatchObject({ title: 'Kladde', body: 'Aufgabe fällig um 09:00', url: '/n/anna-0001?line=1' });
  });

  it('drops devices the push service reports as gone', async () => {
    const extra = fakeDevice();
    await call('/devices', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: `${endpoint}-old`, keys: { p256dh: extra.p256dh, auth: extra.auth } }, settings: { timeZone: 'UTC', digestTime: '00:00' } }) });
    const before = ((await (await call('/devices')).json()) as PushDevice[]).length;
    ctx.notes.push(anna.id, [{ id: 'anna-0002', baseVersion: 0, path: 'Heute.md', content: '- [ ] Etwas 📅 2026-11-15', deleted: false, createdAt: Date.now(), updatedAt: Date.now() }]);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 410 }));
    await ctx.sendReminders!(new Date(Date.UTC(2026, 10, 15, 0, 5)));
    vi.stubGlobal('fetch', realFetch);
    expect(((await (await call('/devices')).json()) as PushDevice[]).length).toBe(before - 1);
  });

  it('runs the "Tomorrow" and "Done" actions only on the unchanged task', async () => {
    const wrong = await call('/action', { method: 'POST', body: JSON.stringify({ noteId: 'anna-0001', line: 0, check: 'nope', action: 'done' }) });
    expect(wrong.status).toBe(409);
    const check = taskCheck('Standup');
    const later = await call('/action', { method: 'POST', body: JSON.stringify({ noteId: 'anna-0001', line: 0, check, action: 'tomorrow', date: '2026-11-15' }) });
    expect(later.status).toBe(200);
    expect(ctx.notes.ownedNotes(anna.id).find((n) => n.id === 'anna-0001')!.content).toBe('- [ ] Standup ⏰ 09:00 📅 2026-11-15');
    const done = await call('/action', { method: 'POST', body: JSON.stringify({ noteId: 'anna-0001', line: 0, check, action: 'done' }) });
    expect(done.status).toBe(200);
    expect(ctx.notes.ownedNotes(anna.id).find((n) => n.id === 'anna-0001')!.content).toMatch(/^- \[x\] Standup/);
  });
});
