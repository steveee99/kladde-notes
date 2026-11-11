import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { openDatabase } from '../src/db';
import { UserStore } from '../src/UserStore';
import { AuditLog } from '../src/security/AuditLog';
import { authRouter } from '../src/auth';
import { gitlabConfigFromEnv, inAllowedGroups, type GitLabConfig } from '../src/gitlabAuth';

const GITLAB_URL = 'https://gitlab.example.org';

/** Fake GitLab: every code maps to a user; the token is the code itself */
const gitlabUsers: Record<string, { sub: number; preferred_username: string; groups: string[] }> = {
  'code-anna': { sub: 11, preferred_username: 'anna', groups: ['team'] },
  'code-new': { sub: 22, preferred_username: 'neu.ling', groups: ['team/sub'] },
  'code-outsider': { sub: 33, preferred_username: 'fremd', groups: ['other'] },
};
const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === `${GITLAB_URL}/oauth/token`) {
    const body = new URLSearchParams(String(init?.body));
    if (!body.get('code_verifier')) return new Response('{}', { status: 400 });
    return Response.json({ access_token: body.get('code') });
  }
  if (url === `${GITLAB_URL}/oauth/userinfo`) {
    const token = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
    const user = gitlabUsers[token];
    return user ? Response.json(user) : new Response('{}', { status: 401 });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const config: GitLabConfig = { url: GITLAB_URL, clientId: 'id', clientSecret: 'secret', label: 'GitLab', allowSignup: false, allowedGroups: ['team'] };

let server: Server;
let base: string;
let users: UserStore;

beforeAll(async () => {
  const db = openDatabase(':memory:');
  users = new UserStore(db);
  const app = express();
  app.use(
    '/api/auth',
    express.json(),
    authRouter({ users, audit: new AuditLog(db), publicUrl: null, secureCookies: false, devLogin: false, gitlab: config, gitlabFetch: fakeFetch })
  );
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

/** Runs start → (GitLab) → callback like a browser would; returns the final redirect and cookies */
async function signInWith(code: string, query: Record<string, string> = {}, cookie = '') {
  const start = await fetch(`${base}/api/auth/gitlab/start?${new URLSearchParams(query)}`, { redirect: 'manual', headers: { Cookie: cookie } });
  expect(start.status).toBe(303);
  const authorize = new URL(start.headers.get('location')!);
  if (authorize.origin !== GITLAB_URL) return { location: authorize.pathname + authorize.search, cookies: '' };
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${base}/api/auth/gitlab/callback`);
  const flowCookie = start.headers.get('set-cookie')!.split(';')[0];
  const state = authorize.searchParams.get('state')!;
  const cb = await fetch(`${base}/api/auth/gitlab/callback?code=${code}&state=${state}`, {
    redirect: 'manual',
    headers: { Cookie: [flowCookie, cookie].filter(Boolean).join('; ') },
  });
  expect(cb.status).toBe(303);
  const session = cb.headers.getSetCookie().find((c) => c.startsWith('kladde_session='));
  return { location: cb.headers.get('location')!, cookies: session ? session.split(';')[0] : '' };
}

describe('GitLab sign-in', () => {
  it('reads its configuration from the environment', () => {
    expect(gitlabConfigFromEnv({})).toBeNull();
    expect(gitlabConfigFromEnv({ GITLAB_CLIENT_ID: 'a', GITLAB_CLIENT_SECRET: 'b', GITLAB_ALLOWED_GROUPS: ' /Team/ , x ' })).toMatchObject({
      url: 'https://gitlab.com',
      allowSignup: false,
      allowedGroups: ['team', 'x'],
    });
    expect(inAllowedGroups(['team/sub'], ['team'])).toBe(true);
    expect(inAllowedGroups(['teamwork'], ['team'])).toBe(false);
    expect(inAllowedGroups([], [])).toBe(true);
  });

  it('reports the provider', async () => {
    const res = await fetch(`${base}/api/auth/providers`);
    expect(await res.json()).toEqual({ gitlab: { enabled: true, label: 'GitLab', signup: false } });
  });

  it('rejects unknown GitLab users without an invite', async () => {
    const { location, cookies } = await signInWith('code-anna');
    expect(location).toMatch(/^\/\?login_error=/);
    expect(cookies).toBe('');
  });

  it('rejects a callback without the matching flow cookie', async () => {
    const start = await fetch(`${base}/api/auth/gitlab/start`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cb = await fetch(`${base}/api/auth/gitlab/callback?code=code-anna&state=${state}`, { redirect: 'manual' });
    expect(cb.headers.get('location')).toMatch(/abgelaufen/);
  });

  it('links GitLab to a signed-in account and then signs in with it', async () => {
    const anna = users.createUser('anna');
    const session = `kladde_session=${users.createSession(anna.id)}`;
    const linked = await signInWith('code-anna', { intent: 'link' }, session);
    expect(linked.location).toBe('/settings?gitlab=linked');
    expect(users.externalLoginsOf(anna.id)).toMatchObject([{ provider: 'gitlab', username: 'anna' }]);

    const login = await signInWith('code-anna');
    expect(login.location).toBe('/');
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: login.cookies } });
    expect((await me.json()).username).toBe('anna');
  });

  it('creates an account from an invite and blocks users outside the allowed groups', async () => {
    const invite = users.createInvite('GitLab').code;
    const outsider = await signInWith('code-outsider', { invite });
    expect(new URLSearchParams(outsider.location.split('?')[1]).get('login_error')).toMatch(/freigegebenen Gruppe/);

    const created = await signInWith('code-new', { invite });
    expect(created.location).toBe('/');
    const user = users.findByUsername('neu.ling')!;
    expect(users.externalLoginsOf(user.id)).toHaveLength(1);
    expect(users.listInvites().find((i) => i.code === invite)?.usedBy).toBe('neu.ling');
  });

  it('keeps a way in when unlinking', async () => {
    const user = users.findByUsername('neu.ling')!;
    expect(() => users.unlinkExternal(user.id, 'gitlab')).toThrow(/Ohne Passkey/);
    await users.setPassword(user.id, 'geheim123');
    expect(users.unlinkExternal(user.id, 'gitlab')).toBe(true);
  });
});
