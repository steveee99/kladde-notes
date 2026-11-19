import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';
import { metricsApp, metricsListenFromEnv, metricsTokenFromEnv, routeGroup } from '../src/metrics';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-metrics-'));
const dbPath = path.join(dataDir, 'kladde.sqlite');
const TOKEN = 'metrics-secret-0123456789';

function app(env: Record<string, string>) {
  return createKladdeApp({
    db: openDatabase(dbPath),
    dataDir,
    env: { DATA_KEY: crypto.randomBytes(32).toString('base64'), ...env },
    standalone: false,
    isProduction: false,
    publicUrl: null,
    trustProxy: false,
    dbPath,
  });
}

const ctx = app({ METRICS_TOKEN: TOKEN });
let server: Server;
let base = '';

beforeAll(async () => {
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Prometheus metrics (#92)', () => {
  it('is off without METRICS_TOKEN and refuses short tokens and bad ports', async () => {
    const plain = app({}).app.listen(0);
    await new Promise((r) => plain.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/metrics`);
    expect(res.headers.get('content-type')).not.toMatch(/version=0\.0\.4/);
    plain.close();
    expect(metricsTokenFromEnv({ METRICS_TOKEN: 'kurz' })).toBeNull();
    expect(metricsListenFromEnv({ METRICS_PORT: '99999' })).toBeNull();
    expect(metricsListenFromEnv({ METRICS_PORT: '9464' })).toEqual({ port: 9464, host: '127.0.0.1' });
  });

  it('needs the bearer token', async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect((await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer falsch' } })).status).toBe(401);
  });

  it('reports requests, sync, connections and sizes without user data in labels', async () => {
    const anna = ctx.users.createUser('anna-geheim');
    const cookie = `kladde_session=${ctx.users.createSession(anna.id)}`;
    const now = Date.now();
    await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ changes: [{ id: 'note-metrics-1', baseVersion: 0, path: 'Geheim/Tagebuch.md', content: 'x', deleted: false, createdAt: now, updatedAt: now }] }),
    });
    await fetch(`${base}/api/sync?since=0`, { headers: { Cookie: cookie } });
    await fetch(`${base}/api/does-not-exist-${'x'.repeat(10)}`);

    const res = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
    const text = await res.text();
    expect(text).toMatch(/^kladde_info\{version="[^"]+"\} 1$/m);
    expect(text).toMatch(/^kladde_sync_pushes_total 1$/m);
    expect(text).toMatch(/^kladde_sync_pulls_total 1$/m);
    expect(text).toMatch(/^kladde_sync_changes_total 1$/m);
    expect(text).toMatch(/^kladde_http_requests_total\{method="POST",route="api_sync",status="2xx"\} 1$/m);
    expect(text).toMatch(/route="api_other"/);
    expect(text).toMatch(/^kladde_http_request_duration_seconds_bucket\{route="api_sync",le="\+Inf"\} 2$/m);
    expect(text).toMatch(/^kladde_sse_connections 0$/m);
    expect(text).toMatch(/^kladde_users 1$/m);
    expect(text).toMatch(/^kladde_notes 1$/m);
    expect(text).toMatch(/^kladde_database_bytes [1-9]\d*$/m);
    expect(text).toMatch(/^kladde_push_notifications_total\{outcome="sent"\} \d+$/m);
    expect(text).not.toContain('anna');
    expect(text).not.toContain('Tagebuch');
    expect(text).not.toContain('does-not-exist');
  });

  it('serves the internal port without a token', async () => {
    const internal = metricsApp(ctx.metrics).listen(0);
    await new Promise((r) => internal.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(internal.address() as AddressInfo).port}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('kladde_uptime_seconds');
    internal.close();
  });

  it('groups routes into a fixed set', () => {
    expect(routeGroup('/api/sync')).toBe('api_sync');
    expect(routeGroup('/api/whatever')).toBe('api_other');
    expect(routeGroup('/mcp')).toBe('mcp');
    expect(routeGroup('/n/123')).toBe('static');
  });
});
