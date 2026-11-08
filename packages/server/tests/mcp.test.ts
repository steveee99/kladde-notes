import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteStore } from '../src/NoteStore';
import { AuditLog } from '../src/security/AuditLog';
import { McpTokenStore, isAllowedRedirectUri } from '../src/mcp/McpTokenStore';
import { mcpRouters } from '../src/mcp/router';

const db = openDatabase(':memory:');
const users = new UserStore(db);
const notes = new NoteStore(db, new DataCipher(crypto.randomBytes(32)));
const tokens = new McpTokenStore(db);
const anna = users.createUser('anna');
const ben = users.createUser('ben');
const annaCookie = `kladde_session=${users.createSession(anna.id)}`;

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  const mcp = mcpRouters({ users, notes, tokens, audit: new AuditLog(db), publicUrl: null });
  app.use(mcp.publicRouter);
  app.use('/api/mcp', express.json(), mcp.accountRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const now = Date.now();
  notes.push(anna.id, [
    { id: 'anna-0001', baseVersion: 0, path: '1 Projekte/Umzug.md', content: '# Umzug\n\n- [ ] Kartons kaufen 📅 2026-11-10\n- [ ] Strom ummelden', deleted: false, createdAt: now, updatedAt: now },
    { id: 'anna-0002', baseVersion: 0, path: '.kladde/settings.json', content: '{"geheim":true}', deleted: false, createdAt: now, updatedAt: now },
  ]);
  notes.push(ben.id, [{ id: 'ben-00001', baseVersion: 0, path: '0 Inbox/Bens Tagebuch.md', content: 'Nur für Ben', deleted: false, createdAt: now, updatedAt: now }]);
  // Shared with anna in the app, but MCP only sees her own space
  notes.share(ben.id, 'ben-00001', anna.id, true);
});

afterAll(() => server.close());

let rpcId = 0;
async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const call = async (token: string, name: string, args: Record<string, unknown> = {}) => (await rpc(token, 'tools/call', { name, arguments: args })).body.result;

async function oauthLogin(allowWrite: boolean) {
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = crypto.randomBytes(32).toString('base64url');
  const params = {
    response_type: 'code',
    client_id,
    redirect_uri: redirect,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'notes:read notes:write',
    resource: `${base}/mcp`,
  };
  const info = await fetch(`${base}/api/mcp/authorize?${new URLSearchParams(params)}`, { headers: { Cookie: annaCookie } });
  expect(await info.json()).toEqual({ clientName: 'Claude', redirectHost: 'claude.ai', wantsWrite: true });
  const consent = await fetch(`${base}/api/mcp/authorize`, {
    method: 'POST',
    headers: { Cookie: annaCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ params, approve: true, allowWrite }),
  });
  const back = new URL(((await consent.json()) as { redirect: string }).redirect);
  expect(back.origin + back.pathname).toBe(redirect);
  expect(back.searchParams.get('state')).toBe('xyz');
  const code = back.searchParams.get('code')!;
  const exchange = (v: string) =>
    fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id, code_verifier: v }),
    });
  return { client_id, code, verifier, exchange };
}

describe('MCP authentication', () => {
  it('asks for a token and points to the OAuth metadata', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as { authorization_servers: string[] };
    const as = (await (await fetch(`${meta.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect((await rpc('kld_falsch', 'ping')).status).toBe(401);
  });

  it('runs the OAuth flow with PKCE, single-use codes and rotating refresh tokens', async () => {
    const flow = await oauthLogin(true);
    expect((await flow.exchange(crypto.randomBytes(32).toString('base64url'))).status).toBe(400);
    // The failed attempt used up the code
    expect((await flow.exchange(flow.verifier)).status).toBe(400);

    const flow2 = await oauthLogin(true);
    const tokenRes = (await (await flow2.exchange(flow2.verifier)).json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokenRes.scope).toBe('notes:read notes:write');
    expect((await flow2.exchange(flow2.verifier)).status).toBe(400);
    const init = await rpc(tokenRes.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.body.result.serverInfo.name).toBe('kladde');

    const refresh = (t: string) =>
      fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t, client_id: flow2.client_id }),
      });
    const renewed = (await (await refresh(tokenRes.refresh_token)).json()) as { access_token: string };
    expect(renewed.access_token).not.toBe(tokenRes.access_token);
    expect((await refresh(tokenRes.refresh_token)).status).toBe(400);
    expect((await rpc(tokenRes.access_token, 'ping')).status).toBe(401);
    expect((await rpc(renewed.access_token, 'ping')).status).toBe(200);
  });

  it('only issues read access when the user does not allow writing', async () => {
    const flow = await oauthLogin(false);
    const { access_token } = (await (await flow.exchange(flow.verifier)).json()) as { access_token: string };
    const list = await rpc(access_token, 'tools/list');
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).not.toContain('create_note');
    expect((await call(access_token, 'create_note', { title: 'X' })).isError).toBe(true);
  });

  it('rejects unknown redirect targets and missing PKCE', async () => {
    expect(isAllowedRedirectUri('https://claude.ai/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:3333/cb')).toBe(true);
    expect(isAllowedRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://evil.example/cb')).toBe(false);
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
    const client = tokens.registerClient('App', ['https://app.example/cb']);
    const ask = (q: Record<string, string>) => fetch(`${base}/api/mcp/authorize?${new URLSearchParams(q)}`, { headers: { Cookie: annaCookie } });
    const good = { response_type: 'code', client_id: client.id, redirect_uri: 'https://app.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' };
    expect((await ask(good)).status).toBe(200);
    expect((await ask({ ...good, redirect_uri: 'https://evil.example/cb' })).status).toBe(400);
    expect((await ask({ ...good, code_challenge_method: 'plain' })).status).toBe(400);
    expect((await ask({ ...good, resource: 'https://other.example/mcp' })).status).toBe(400);
    expect((await fetch(`${base}/api/mcp/authorize?${new URLSearchParams(good)}`)).status).toBe(401);
  });

  it('stops working for banned accounts and revoked tokens', async () => {
    const carl = users.createUser('carl');
    const { token, connection } = tokens.createPersonalToken(carl.id, 'Test', false);
    expect((await rpc(token, 'ping')).status).toBe(200);
    users.setBanned(carl.id, true);
    expect((await rpc(token, 'ping')).status).toBe(401);
    users.setBanned(carl.id, false);
    expect(tokens.revoke(anna.id, connection.id)).toBe(false);
    expect(tokens.revoke(carl.id, connection.id)).toBe(true);
    expect((await rpc(token, 'ping')).status).toBe(401);
  });

  it('stores only hashes of the secrets', () => {
    const { token } = tokens.createPersonalToken(anna.id, 'Hash', false);
    const dump = JSON.stringify(db.prepare('SELECT * FROM mcp_tokens').all());
    expect(dump).not.toContain(token);
  });
});

describe('MCP tools', () => {
  const { token } = tokens.createPersonalToken(anna.id, 'Werkzeuge', true);

  it('sees only the own space, without settings notes or shared notes', async () => {
    const list = (await call(token, 'list_notes')).structuredContent;
    expect(list.notes.map((n: { path: string }) => n.path)).toEqual(['1 Projekte/Umzug.md']);
    expect((await call(token, 'read_note', { id: 'ben-00001' })).isError).toBe(true);
    expect((await call(token, 'read_note', { id: 'anna-0002' })).isError).toBe(true);
    expect((await call(token, 'search_notes', { query: 'Ben' })).structuredContent.total).toBe(0);
    expect((await call(token, 'query_notes', { query: 'LIST' })).structuredContent.total).toBe(1);
  });

  it('cannot change notes of other users', async () => {
    expect((await call(token, 'append_to_note', { id: 'ben-00001', text: 'hallo' })).isError).toBe(true);
    expect((await call(token, 'update_note', { id: 'ben-00001', content: 'weg', version: 1 })).isError).toBe(true);
    expect(notes.ownedNotes(ben.id)[0].content).toBe('Nur für Ben');
  });

  it('searches, reads, creates and edits notes with version checks', async () => {
    const hit = (await call(token, 'search_notes', { query: 'kartons' })).structuredContent;
    expect(hit.results[0].id).toBe('anna-0001');
    const note = (await call(token, 'read_note', { title: 'umzug' })).structuredContent;
    expect(note.content).toContain('Kartons');

    const created = (await call(token, 'create_note', { title: 'Einkauf', content: 'Siehe [[Umzug]]' })).structuredContent;
    expect(created.path).toBe('0 Inbox/Einkauf.md');
    expect((await call(token, 'create_note', { title: 'Einkauf' })).structuredContent.path).toBe('0 Inbox/Einkauf 2.md');
    expect((await call(token, 'create_note', { title: 'x', folder: '.kladde' })).isError).toBe(true);
    expect((await call(token, 'read_note', { id: 'anna-0001' })).structuredContent.backlinks).toEqual(['Einkauf']);

    const stale = await call(token, 'update_note', { id: created.id, content: 'neu', version: 99 });
    expect(stale.isError).toBe(true);
    expect((await call(token, 'update_note', { id: created.id, content: 'neu', version: created.version })).structuredContent.version).toBe(2);
    await call(token, 'append_to_note', { id: created.id, text: '- [ ] Milch' });
    expect(notes.ownedNotes(anna.id).find((n) => n.id === created.id)!.content).toBe('neu\n\n- [ ] Milch\n');
    await call(token, 'append_to_note', { id: created.id, text: '- [ ] Brot' });
    expect(notes.ownedNotes(anna.id).find((n) => n.id === created.id)!.content).toBe('neu\n\n- [ ] Milch\n- [ ] Brot\n');
  });

  it('lists and ticks off tasks', async () => {
    const tasks = (await call(token, 'list_tasks', { due_until: '2026-12-31' })).structuredContent.tasks;
    expect(tasks).toEqual([expect.objectContaining({ note_id: 'anna-0001', line: 2, text: expect.stringContaining('Kartons'), due: '2026-11-10' })]);
    const done = (await call(token, 'toggle_task', { id: 'anna-0001', line: 2 })).structuredContent;
    expect(done.done).toBe(true);
    expect(notes.ownedNotes(anna.id).find((n) => n.id === 'anna-0001')!.content).toMatch(/- \[x\] Kartons kaufen/);
    expect((await call(token, 'toggle_task', { id: 'anna-0001', line: 0 })).isError).toBe(true);
  });

  it('answers protocol details: notifications, batches and unknown methods', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
    expect((await rpc(token, 'nope')).body.error.code).toBe(-32601);
    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{' });
    expect(((await bad.json()) as any).error.code).toBe(-32700);
  });
});
