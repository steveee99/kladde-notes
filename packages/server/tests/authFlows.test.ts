import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Me } from '@kladde/shared';
import { openDatabase } from '../src/db';
import { UserStore, type UserRecord } from '../src/UserStore';
import { AuditLog } from '../src/security/AuditLog';
import { authRouter, type AuthOptions } from '../src/auth';
import { SoftAuthenticator } from './support/softAuthenticator';

// The sign-in flows of auth.ts over HTTP: passkeys (with a software authenticator), passwords, device links

const ORIGIN = 'https://kladde.test';
const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function start(opts: Partial<AuthOptions> = {}) {
  const db = openDatabase(':memory:');
  const users = new UserStore(db);
  const audit = new AuditLog(db);
  const registered: { user: UserRecord; note: string }[] = [];
  const app = express();
  // Every request may name its client address (X-Forwarded-For), so the per-IP limits do not get in the way
  app.set('trust proxy', true);
  app.use(
    '/api/auth',
    express.json(),
    authRouter({ users, audit, publicUrl: null, secureCookies: false, devLogin: false, onRegistered: (user, note) => registered.push({ user, note }), ...opts })
  );
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
  let ip = 0;

  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; ip?: string } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        'X-Forwarded-For': init.ip ?? `203.0.113.${++ip % 250}`,
        ...(init.cookie ? { Cookie: init.cookie } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  /** The `kladde_session=…` pair of a response's Set-Cookie */
  const sessionOf = (res: Response) => /kladde_session=[^;]*/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';

  /** Registers a new account with a passkey and returns it with its session */
  const registerPasskey = async (username: string, inviteCode: string) => {
    const authenticator = new SoftAuthenticator(ORIGIN);
    const { flowId, options } = await (await call('/register/options', { body: { username, inviteCode } })).json();
    const res = await call('/register/verify', { body: { flowId, response: authenticator.create(options) } });
    return { res, authenticator, cookie: sessionOf(res) };
  };

  const login = async (authenticator: SoftAuthenticator, tamper = false) => {
    const { flowId, options } = await (await call('/login/options', { body: {} })).json();
    return call('/login/verify', { body: { flowId, response: authenticator.get(options, { tamper }) } });
  };

  return { users, audit, registered, call, sessionOf, registerPasskey, login };
}

describe('passkey sign-up and sign-in', () => {
  it('registers with an invite, signs in again and counts the use', async () => {
    const t = await start();
    const invite = t.users.createInvite('für Anna');
    const { res, authenticator, cookie } = await t.registerPasskey('anna', invite.code);
    expect(res.status).toBe(200);
    const me = (await res.json()) as Me;
    expect(me.username).toBe('anna');
    expect(me.passkeys).toHaveLength(1);
    expect(me.hasPassword).toBe(false);
    expect(cookie).toMatch(/^kladde_session=.+/);
    expect(t.registered.map((r) => [r.user.username, r.note])).toEqual([['anna', 'für Anna']]);
    expect(t.users.listInvites().find((i) => i.code === invite.code)?.usedBy).toBe('anna');
    // The invite is used up
    expect((await t.call('/register/options', { body: { username: 'zweite', inviteCode: invite.code } })).status).toBeGreaterThanOrEqual(400);

    const again = await t.login(authenticator);
    expect(again.status).toBe(200);
    expect(t.sessionOf(again)).toMatch(/^kladde_session=.+/);
    expect(t.users.getCredential(authenticator.credentialId)!.counter).toBe(1);
    expect(t.audit.recent(10, 'login').length).toBe(1);
  });

  it('refuses unknown, banned and forged passkeys', async () => {
    const t = await start();
    const { authenticator } = await t.registerPasskey('anna', t.users.createInvite('').code);

    const stranger = new SoftAuthenticator(ORIGIN);
    expect((await t.login(stranger)).status).toBe(401);

    const forged = await t.login(authenticator, true);
    expect(forged.status).toBe(401);
    expect((await forged.json()).error).toMatch(/fehlgeschlagen/);

    const anna = t.users.findByUsername('anna')!;
    t.users.setBanned(anna.id, true);
    expect((await t.login(authenticator)).status).toBe(403);
    expect(t.audit.recent(10, 'login_blocked')[0].username).toBe('anna');
    expect(t.audit.recent(10, 'login_failed').length).toBe(2);
  });

  it('rejects responses for another origin, a reused flow and a wrong kind of flow', async () => {
    const t = await start();
    const invite = t.users.createInvite('').code;
    const authenticator = new SoftAuthenticator(ORIGIN);
    const { flowId, options } = await (await t.call('/register/options', { body: { username: 'anna', inviteCode: invite } })).json();
    const phished = await t.call('/register/verify', { body: { flowId, response: authenticator.create(options, { origin: 'https://evil.test' }) } });
    expect(phished.status).toBe(400);
    expect((await phished.json()).error).toMatch(/nicht geprüft/);
    // The flow is gone after one try, even a failed one
    const replay = await t.call('/register/verify', { body: { flowId, response: authenticator.create(options) } });
    expect((await replay.json()).error).toMatch(/abgelaufen/);
    expect(t.users.findByUsername('anna')).toBeNull();

    const login = await (await t.call('/login/options', { body: {} })).json();
    expect((await t.call('/register/verify', { body: { flowId: login.flowId, response: authenticator.create(options) } })).status).toBe(400);
    expect((await t.call('/login/verify', { body: { flowId: 42 } })).status).toBe(400);
  });

  it('does not create the account when the name was taken during the ceremony', async () => {
    const t = await start();
    const authenticator = new SoftAuthenticator(ORIGIN);
    const { flowId, options } = await (await t.call('/register/options', { body: { username: 'anna', inviteCode: t.users.createInvite('').code } })).json();
    t.users.createUser('anna');
    const res = await t.call('/register/verify', { body: { flowId, response: authenticator.create(options) } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(t.users.getCredential(authenticator.credentialId)).toBeNull();
  });

  it('uses PUBLIC_URL as the passkey domain instead of the Origin header', async () => {
    const t = await start({ publicUrl: 'https://notes.example' });
    const { options } = await (await t.call('/login/options', { body: {} })).json();
    expect(options.rpId).toBe('notes.example');
  });
});

describe('signed-in passkey management', () => {
  it('adds a second passkey, deletes one and keeps the last', async () => {
    const t = await start();
    const { cookie } = await t.registerPasskey('anna', t.users.createInvite('').code);
    const second = new SoftAuthenticator(ORIGIN);
    const { flowId, options } = await (await t.call('/passkeys/options', { body: {}, cookie })).json();
    // The existing passkey is excluded, so the browser does not make a duplicate
    expect(options.excludeCredentials).toHaveLength(1);
    const added = await t.call('/passkeys/verify', { body: { flowId, response: second.create(options) }, cookie });
    expect(((await added.json()) as Me).passkeys).toHaveLength(2);
    expect((await t.login(second)).status).toBe(200);

    const removed = await t.call(`/passkeys/${encodeURIComponent(second.credentialId)}`, { method: 'DELETE', cookie });
    expect(((await removed.json()) as Me).passkeys).toHaveLength(1);
    const [last] = t.users.credentialsOf(t.users.findByUsername('anna')!.id);
    expect((await t.call(`/passkeys/${encodeURIComponent(last.id)}`, { method: 'DELETE', cookie })).status).toBeGreaterThanOrEqual(400);
  });

  it("refuses to finish another account's add-passkey flow", async () => {
    const t = await start();
    const anna = await t.registerPasskey('anna', t.users.createInvite('').code);
    const ben = await t.registerPasskey('ben', t.users.createInvite('').code);
    const { flowId, options } = await (await t.call('/passkeys/options', { body: {}, cookie: anna.cookie })).json();
    const res = await t.call('/passkeys/verify', { body: { flowId, response: new SoftAuthenticator(ORIGIN).create(options) }, cookie: ben.cookie });
    expect(res.status).toBe(403);
  });

  it('needs a session for everything that changes the account', async () => {
    const t = await start();
    expect((await t.call('/me')).status).toBe(401);
    expect((await t.call('/passkeys/options', { body: {} })).status).toBe(401);
    expect((await t.call('/device-link', { body: {} })).status).toBe(401);
    expect((await t.call('/password', { body: { newPassword: 'ein-langes-passwort' } })).status).toBe(401);
  });
});

describe('new device via one-time code', () => {
  it('adds a passkey for the account the code belongs to, once', async () => {
    const t = await start();
    const { cookie } = await t.registerPasskey('anna', t.users.createInvite('').code);
    const { code } = await (await t.call('/device-link', { body: {}, cookie })).json();

    const phone = new SoftAuthenticator(ORIGIN);
    const linkOptions = await (await t.call('/link/options', { body: { code } })).json();
    expect(linkOptions.username).toBe('anna');
    const linked = await t.call('/link/verify', { body: { flowId: linkOptions.flowId, response: phone.create(linkOptions.options) } });
    expect(linked.status).toBe(200);
    expect(((await linked.json()) as Me).passkeys).toHaveLength(2);
    expect(t.sessionOf(linked)).toMatch(/^kladde_session=.+/);
    expect((await t.login(phone)).status).toBe(200);
    // The code is used up
    expect((await t.call('/link/options', { body: { code } })).status).toBeGreaterThanOrEqual(400);
  });

  it('rejects unknown codes', async () => {
    const t = await start();
    expect((await t.call('/link/options', { body: { code: 'NICHT-DA' } })).status).toBeGreaterThanOrEqual(400);
    expect((await t.call('/link/options', { body: {} })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('passwords', () => {
  it('registers with an invite, signs in, changes and removes the password', async () => {
    const t = await start();
    const invite = t.users.createInvite('Passwort').code;
    const reg = await t.call('/password/register', { body: { username: 'anna', password: 'erstes-passwort', inviteCode: invite } });
    expect(reg.status).toBe(200);
    expect(((await reg.json()) as Me).hasPassword).toBe(true);
    expect(t.registered[0].note).toBe('Passwort');
    const first = t.sessionOf(reg);

    const second = t.sessionOf(await t.call('/password/login', { body: { username: ' ANNA ', password: 'erstes-passwort' } }));
    expect(second).toMatch(/^kladde_session=.+/);

    // Changing needs the current password and signs the other sessions out
    expect((await t.call('/password', { body: { currentPassword: 'falsch', newPassword: 'zweites-passwort' }, cookie: first })).status).toBe(403);
    expect((await t.call('/password', { body: { currentPassword: 'erstes-passwort', newPassword: 'zweites-passwort' }, cookie: first })).status).toBe(200);
    expect((await t.call('/me', { cookie: second })).status).toBe(401);
    expect((await t.call('/me', { cookie: first })).status).toBe(200);
    expect((await t.call('/password/login', { body: { username: 'anna', password: 'zweites-passwort' } })).status).toBe(200);
    expect(t.audit.recent(10, 'password_changed')).toHaveLength(1);

    // The password is the only way in: it stays until a passkey exists
    expect((await t.call('/password', { method: 'DELETE', cookie: first })).status).toBeGreaterThanOrEqual(400);
  });

  it('removes the password once a passkey exists', async () => {
    const t = await start();
    const { cookie } = await t.registerPasskey('anna', t.users.createInvite('').code);
    // Setting the first password needs no current one
    expect((await t.call('/password', { body: { newPassword: 'ein-langes-passwort' }, cookie })).status).toBe(200);
    const res = await t.call('/password', { method: 'DELETE', cookie });
    expect(((await res.json()) as Me).hasPassword).toBe(false);
    expect((await t.call('/password/login', { body: { username: 'anna', password: 'ein-langes-passwort' } })).status).toBe(401);
  });

  it('needs an invite unless password sign-up is open', async () => {
    const t = await start();
    expect((await t.call('/password/register', { body: { username: 'anna', password: 'ein-langes-passwort' } })).status).toBeGreaterThanOrEqual(400);
    expect((await t.call('/password/register', { body: { username: 'anna', password: 'kurz', inviteCode: t.users.createInvite('').code } })).status).toBe(400);
    expect(t.users.findByUsername('anna')).toBeNull();
  });

  it('locks an account after ten wrong passwords, from whatever address', async () => {
    const t = await start();
    const anna = t.users.createUser('anna');
    await t.users.setPassword(anna.id, 'richtiges-passwort');
    for (let i = 0; i < 10; i++) {
      expect((await t.call('/password/login', { body: { username: 'anna', password: `falsch-${i}` } })).status).toBe(401);
    }
    // Even the right password waits now
    const locked = await t.call('/password/login', { body: { username: 'Anna', password: 'richtiges-passwort' } });
    expect(locked.status).toBe(429);
    expect(t.audit.recent(1, 'login_blocked')[0].detail).toMatch(/too many/);
    // Other accounts are not affected
    const ben = t.users.createUser('ben');
    await t.users.setPassword(ben.id, 'richtiges-passwort');
    expect((await t.call('/password/login', { body: { username: 'ben', password: 'richtiges-passwort' } })).status).toBe(200);
  });

  it('a right password resets the count and banned accounts stay out', async () => {
    const t = await start();
    const anna = t.users.createUser('anna');
    await t.users.setPassword(anna.id, 'richtiges-passwort');
    for (let i = 0; i < 9; i++) await t.call('/password/login', { body: { username: 'anna', password: 'falsch' } });
    expect((await t.call('/password/login', { body: { username: 'anna', password: 'richtiges-passwort' } })).status).toBe(200);
    for (let i = 0; i < 9; i++) await t.call('/password/login', { body: { username: 'anna', password: 'falsch' } });
    expect((await t.call('/password/login', { body: { username: 'anna', password: 'richtiges-passwort' } })).status).toBe(200);

    t.users.setBanned(anna.id, true);
    expect((await t.call('/password/login', { body: { username: 'anna', password: 'richtiges-passwort' } })).status).toBe(403);
  });

  it('limits password attempts per address', async () => {
    const t = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await t.call('/password/login', { body: { username: `x${i}`, password: 'egal-egal' }, ip: '198.51.100.7' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('sessions', () => {
  it('logout ends the session and clears the cookie', async () => {
    const t = await start();
    const { cookie } = await t.registerPasskey('anna', t.users.createInvite('').code);
    const res = await t.call('/logout', { body: {}, cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/kladde_session=;/);
    expect((await t.call('/me', { cookie })).status).toBe(401);
    // Without a cookie it is a no-op
    expect((await t.call('/logout', { body: {} })).status).toBe(200);
  });

  it('marks cookies Secure only over HTTPS or for the public domain', async () => {
    const t = await start({ secureCookies: true, publicUrl: 'https://notes.example' });
    const anna = t.users.createUser('anna');
    await t.users.setPassword(anna.id, 'ein-langes-passwort');
    const plain = await t.call('/password/login', { body: { username: 'anna', password: 'ein-langes-passwort' } });
    expect(plain.headers.get('set-cookie')).not.toMatch(/Secure/);

    const t2 = await start({ secureCookies: true, publicUrl: 'https://127.0.0.1' });
    const ben = t2.users.createUser('ben');
    await t2.users.setPassword(ben.id, 'ein-langes-passwort');
    const secure = await t2.call('/password/login', { body: { username: 'ben', password: 'ein-langes-passwort' } });
    expect(secure.headers.get('set-cookie')).toMatch(/Secure/);
  });

  it('reports server features in /me', async () => {
    const t = await start({ transcription: true, online: true });
    const { cookie } = await t.registerPasskey('anna', t.users.createInvite('').code);
    const me = (await (await t.call('/me', { cookie })).json()) as Me;
    expect(me.transcription).toBe(true);
    expect(me.online).toBe(true);
    expect(me.isAdmin).toBe(true);
  });

  it('offers the dev login only when enabled', async () => {
    const off = await start();
    expect((await off.call('/dev-login', { body: {} })).status).toBe(404);
    const on = await start({ devLogin: true });
    const res = await on.call('/dev-login', { body: {} });
    expect(((await res.json()) as Me).username).toBe('dev');
    // A second call reuses the account
    await on.call('/dev-login', { body: {} });
    expect(on.users.countUsers()).toBe(1);
  });

  it('unlinking GitLab without a link is a no-op', async () => {
    const t = await start();
    const { cookie } = await t.registerPasskey('anna', t.users.createInvite('').code);
    const res = await t.call('/gitlab', { method: 'DELETE', cookie });
    expect(((await res.json()) as Me).externalLogins).toEqual([]);
    expect(t.audit.recent(10, 'external_unlinked')).toHaveLength(0);
  });
});
