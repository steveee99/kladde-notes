import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { openDatabase } from '../src/db';
import { UserStore } from '../src/UserStore';
import { AuditLog } from '../src/security/AuditLog';
import { authRouter } from '../src/auth';
import { gitlabConfigFromEnv, openSignupFromEnv } from '../src/gitlabAuth';

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
    authRouter({ users, audit: new AuditLog(db), publicUrl: null, secureCookies: false, devLogin: false, openSignup: openSignupFromEnv({ SIGNUP_WITHOUT_INVITE: 'password' }) })
  );
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const post = (path: string, json: unknown) =>
  fetch(`${base}/api/auth${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(json) });

describe('sign-up without an invite (SIGNUP_WITHOUT_INVITE)', () => {
  it('parses the methods per sign-in system', () => {
    expect([...openSignupFromEnv({})]).toEqual([]);
    expect([...openSignupFromEnv({ SIGNUP_WITHOUT_INVITE: ' GitLab , password ' })].sort()).toEqual(['gitlab', 'password']);
    expect([...openSignupFromEnv({ SIGNUP_WITHOUT_INVITE: 'all' })].sort()).toEqual(['gitlab', 'passkey', 'password']);
    expect([...openSignupFromEnv({ GITLAB_ALLOW_SIGNUP: '1' })]).toEqual(['gitlab']);
    const gitlab = { GITLAB_CLIENT_ID: 'a', GITLAB_CLIENT_SECRET: 'b' };
    expect(gitlabConfigFromEnv({ ...gitlab, SIGNUP_WITHOUT_INVITE: 'gitlab' })?.allowSignup).toBe(true);
    expect(gitlabConfigFromEnv({ ...gitlab, SIGNUP_WITHOUT_INVITE: 'password' })?.allowSignup).toBe(false);
  });

  it('reports the open methods', async () => {
    const res = await fetch(`${base}/api/auth/providers`);
    expect((await res.json()).signup).toEqual({ passkey: false, password: true });
  });

  it('creates password accounts without an invite but still checks a given one', async () => {
    const ok = await post('/password/register', { username: 'offen', password: 'ein-langes-passwort' });
    expect(ok.status).toBe(200);
    expect(users.findByUsername('offen')).toBeTruthy();
    const bad = await post('/password/register', { inviteCode: 'FALSCH-00', username: 'offen2', password: 'ein-langes-passwort' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('keeps passkeys invite-only', async () => {
    const res = await post('/register/options', { username: 'passkeyfan' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
