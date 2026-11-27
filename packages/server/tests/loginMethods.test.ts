import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Me } from '@kladde/shared';
import { openDatabase } from '../src/db';
import { UserStore } from '../src/UserStore';
import { AuditLog } from '../src/security/AuditLog';
import { authRouter } from '../src/auth';
import { gitlabConfigFromEnv, loginMethodsFromEnv } from '../src/gitlabAuth';
import { appTitleFromEnv, brandIndexHtml, brandManifest } from '../src/branding';
import { createKladdeApp } from '../src/app';

const GITLAB = { GITLAB_CLIENT_ID: 'id', GITLAB_CLIENT_SECRET: 'secret', GITLAB_URL: 'https://gitlab.example.test' };

describe('LOGIN_METHODS', () => {
  it('parses the methods, all by default', () => {
    expect([...loginMethodsFromEnv({}, true)].sort()).toEqual(['gitlab', 'passkey', 'password']);
    expect([...loginMethodsFromEnv({}, false)].sort()).toEqual(['passkey', 'password']);
    expect([...loginMethodsFromEnv({ LOGIN_METHODS: ' GitLab ' }, true)]).toEqual(['gitlab']);
    expect([...loginMethodsFromEnv({ LOGIN_METHODS: 'passkey,gitlab' }, false)]).toEqual(['passkey']);
  });

  it('refuses a list that would lock everyone out', () => {
    expect(() => loginMethodsFromEnv({ LOGIN_METHODS: 'gitlab' }, false)).toThrow(/braucht die GitLab-Anmeldung/);
    expect(() => loginMethodsFromEnv({ LOGIN_METHODS: 'ldap' }, true)).toThrow(/unbekannte Anmeldeart/);
    expect(() => loginMethodsFromEnv({ LOGIN_METHODS: ',' }, true)).toThrow(/keine Anmeldeart/);
  });
});

describe('a server that signs in only with GitLab', () => {
  let server: Server;
  let base: string;
  let users: UserStore;
  let cookie: string;

  beforeAll(async () => {
    const db = openDatabase(':memory:');
    users = new UserStore(db);
    const anna = users.createUser('anna');
    users.linkExternal(anna.id, 'gitlab', '42', 'anna');
    cookie = `kladde_session=${users.createSession(anna.id)}`;
    const app = express();
    app.use(
      '/api/auth',
      express.json(),
      authRouter({ users, audit: new AuditLog(db), publicUrl: null, secureCookies: false, devLogin: false, gitlab: gitlabConfigFromEnv(GITLAB), loginMethods: loginMethodsFromEnv({ LOGIN_METHODS: 'gitlab' }, true) })
    );
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const post = (url: string, json: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/auth${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(json) });

  it('tells the sign-in page that only GitLab is there', async () => {
    const providers = await (await fetch(`${base}/api/auth/providers`)).json();
    expect(providers.methods).toEqual({ passkey: false, password: false, gitlab: true });
    expect(providers.gitlab.enabled).toBe(true);
    expect(providers.signup).toEqual({ passkey: false, password: false });
  });

  it.each([
    ['/password/login', { username: 'anna', password: 'irgendwas-langes' }],
    ['/password/register', { username: 'neu', password: 'irgendwas-langes' }],
    ['/login/options', {}],
    ['/register/options', { username: 'neu' }],
    ['/link/options', { code: 'X' }],
  ])('refuses %s', async (url, body) => {
    const res = await post(url, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'login_method_off' });
  });

  it('refuses new passwords, passkeys and device codes for signed-in users, and keeps the GitLab link', async () => {
    for (const url of ['/password', '/passkeys/options', '/device-link']) expect((await post(url, { newPassword: 'ein-langes-passwort' }, { Cookie: cookie })).status).toBe(403);
    const unlink = await fetch(`${base}/api/auth/gitlab`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } });
    expect(unlink.status).toBe(403);
    const me = (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json()) as Me;
    expect(me.loginMethods).toEqual(['gitlab']);
    expect(me.externalLogins).toHaveLength(1);
  });

  it('still starts the GitLab sign-in', async () => {
    const res = await fetch(`${base}/api/auth/gitlab/start`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^https:\/\/gitlab\.example\.test\/oauth\/authorize/);
  });
});

describe('APP_TITLE', () => {
  it('cleans the title', () => {
    expect(appTitleFromEnv({})).toBeNull();
    expect(appTitleFromEnv({ APP_TITLE: '  ' })).toBeNull();
    expect(appTitleFromEnv({ APP_TITLE: ' Team\nNotizen ' })).toBe('Team Notizen');
    expect(appTitleFromEnv({ APP_TITLE: 'x'.repeat(60) })).toHaveLength(40);
  });

  it('writes it into the page and the manifest, escaped', () => {
    const html = '<head><meta name="application-name" content="Kladde" />\n<meta name="apple-mobile-web-app-title" content="Kladde" />\n<title>Kladde</title></head>';
    const out = brandIndexHtml(html, 'A&B <Notes>');
    expect(out).toContain('<title>A&amp;B &lt;Notes&gt;</title>');
    expect(out).toContain('<meta name="application-name" content="A&amp;B &lt;Notes&gt;" />');
    expect(out).toContain('<meta name="apple-mobile-web-app-title" content="A&amp;B &lt;Notes&gt;" />');
    expect(JSON.parse(brandManifest('{"name":"Kladde","short_name":"Kladde","lang":"de"}', 'Team'))).toEqual({ name: 'Team', short_name: 'Team', lang: 'de' });
  });

  it('is served by the app', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-title-'));
    const clientDist = path.join(dataDir, 'dist');
    fs.mkdirSync(clientDist);
    fs.writeFileSync(path.join(clientDist, 'index.html'), '<html><head><meta name="application-name" content="Kladde" /><title>Kladde</title></head><body></body></html>');
    fs.writeFileSync(path.join(clientDist, 'manifest.webmanifest'), '{"name":"Kladde","short_name":"Kladde"}');
    const { app } = createKladdeApp({
      db: openDatabase(':memory:'),
      dataDir,
      clientDist,
      env: { DATA_KEY: crypto.randomBytes(32).toString('base64'), APP_TITLE: 'Teamheft' },
      standalone: false,
      isProduction: false,
      publicUrl: null,
      trustProxy: false,
      plugins: [],
    });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const p of ['/', '/index.html', '/notes/somewhere']) expect(await (await fetch(`${url}${p}`)).text()).toContain('<title>Teamheft</title>');
      expect(await (await fetch(`${url}/manifest.webmanifest`)).json()).toEqual({ name: 'Teamheft', short_name: 'Teamheft' });
    } finally {
      server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
