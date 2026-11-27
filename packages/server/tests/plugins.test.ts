import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { defineServerPlugin, type ServerPlugin } from '@kladde/plugin-api/server';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';
import { runCli } from '../src/cliActions';
import { migratePlugins, PluginMigrationError, pluginSchemaVersions, purgePluginData } from '../src/plugins/migrations';
import type { InstalledServerPlugin } from '../src/plugins/types';
import logbook from '../../../examples/kladde-plugin-logbook/src/server';

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-plugins-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const entry = (plugin: ServerPlugin, over: Partial<InstalledServerPlugin> = {}): InstalledServerPlugin => ({
  name: `kladde-plugin-${plugin.id}`,
  id: plugin.id,
  version: '1.0.0',
  api: '^1.0.0',
  defaultEnabled: false,
  plugin,
  ...over,
});

const noCode = () => {};

describe('plugin migrations', () => {
  const step1 = { version: 1, description: 'Items', sql: 'CREATE TABLE p_demo_items (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id) ON DELETE CASCADE)' };
  const step2 = { version: 2, description: 'Index', sql: 'CREATE INDEX p_demo_items_owner ON p_demo_items(owner_id)' };

  it('applies new steps once and records them', () => {
    const db = openDatabase(':memory:');
    expect(migratePlugins(db, [{ id: 'demo', migrations: [step1] }], noCode)).toEqual({ demo: [1] });
    expect(migratePlugins(db, [{ id: 'demo', migrations: [step1, step2] }], noCode)).toEqual({ demo: [2] });
    expect(migratePlugins(db, [{ id: 'demo', migrations: [step1, step2] }], noCode)).toEqual({ demo: [] });
    expect(pluginSchemaVersions(db).get('demo')).toBe(2);
  });

  it('refuses a released step that changed', () => {
    const db = openDatabase(':memory:');
    migratePlugins(db, [{ id: 'demo', migrations: [step1] }], noCode);
    expect(() => migratePlugins(db, [{ id: 'demo', migrations: [{ ...step1, sql: `${step1.sql};` }] }], noCode)).toThrow(/was changed after it ran/);
  });

  it('refuses a downgrade', () => {
    const db = openDatabase(':memory:');
    migratePlugins(db, [{ id: 'demo', migrations: [step1, step2] }], noCode);
    expect(() => migratePlugins(db, [{ id: 'demo', migrations: [step1] }], noCode)).toThrow(/downgrades are not supported/);
  });

  it('refuses steps out of order', () => {
    const db = openDatabase(':memory:');
    expect(() => migratePlugins(db, [{ id: 'demo', migrations: [step2] }], noCode)).toThrow(/numbered 1, 2, 3/);
  });

  it.each([
    ['a foreign table', 'CREATE TABLE notes_copy (id TEXT)'],
    ["Kladde's rows", 'DELETE FROM users'],
    ["Kladde's schema", 'ALTER TABLE users ADD COLUMN evil TEXT'],
    ['the schema version', 'PRAGMA user_version = 1'],
    ['transactions', 'COMMIT; CREATE TABLE p_demo_x (id TEXT)'],
  ])('keeps a plugin away from %s and rolls the step back', (_what, sql) => {
    const db = openDatabase(':memory:');
    const before = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    expect(() => migratePlugins(db, [{ id: 'demo', migrations: [{ version: 1, description: 'Bad', sql }] }], noCode)).toThrow(PluginMigrationError);
    expect(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'notes_copy'").get()).toBeUndefined();
    expect(pluginSchemaVersions(db).has('demo')).toBe(false);
  });

  it('runs code steps with the same guard', () => {
    const db = openDatabase(':memory:');
    const fine = { version: 1, description: 'Seed', sql: 'CREATE TABLE p_demo_kv (k TEXT PRIMARY KEY, v TEXT)', up: (d: typeof db) => void d.prepare('INSERT INTO p_demo_kv VALUES (?, ?)').run('a', 'b') };
    migratePlugins(db, [{ id: 'demo', migrations: [fine] }], (_id, step) => step.up?.(db, {} as never));
    expect(db.prepare('SELECT v FROM p_demo_kv').get()).toEqual({ v: 'b' });
    const evil = { version: 2, description: 'Evil', up: (d: typeof db) => void d.exec('DROP TABLE notes') };
    expect(() => migratePlugins(db, [{ id: 'demo', migrations: [fine, evil] }], (_id, step) => step.up?.(db, {} as never))).toThrow(/no table of the plugin/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'notes'").get()).toBeDefined();
  });
});

describe('the example plugin in a running Kladde', () => {
  const dataDir = tempDir();
  const db = openDatabase(path.join(dataDir, 'kladde.sqlite'));
  const ctx = createKladdeApp({
    db,
    dataDir,
    env: { DATA_KEY: crypto.randomBytes(32).toString('base64'), PLUGIN_LOGBOOK_KEEP_DAYS: '30' },
    standalone: false,
    isProduction: false,
    publicUrl: null,
    trustProxy: false,
    plugins: [entry(logbook, { name: 'kladde-plugin-logbook', version: '0.1.0' })],
  });
  const anna = ctx.users.createUser('anna');
  const ben = ctx.users.createUser('ben');
  const cookie = `kladde_session=${ctx.users.createSession(anna.id)}`;
  const benCookie = `kladde_session=${ctx.users.createSession(ben.id)}`;
  let server: Server;
  let base = '';

  const call = (method: string, url: string, body?: unknown, as = cookie) =>
    fetch(`${base}${url}`, { method, headers: { Cookie: as, Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

  const switchOn = (userId: string, on: boolean) => {
    const id = `syssettings-${userId}`;
    const current = ctx.notes.fetchNotes(userId, [id])[0];
    const now = Date.now();
    ctx.notes.push(userId, [{ id, baseVersion: current?.version ?? 0, path: '.kladde/settings.json', content: JSON.stringify({ features: { plugins: { logbook: on } } }), deleted: false, createdAt: now, updatedAt: now }]);
  };

  beforeAll(async () => {
    server = ctx.app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('migrated its tables', () => {
    expect(pluginSchemaVersions(db).get('logbook')).toBe(2);
    expect(ctx.plugins.status()).toEqual([{ id: 'logbook', name: 'kladde-plugin-logbook', version: '0.1.0', api: '^1.0.0', schema: 2 }]);
  });

  it('answers only signed-in users who switched it on', async () => {
    expect((await call('GET', '/api/p/logbook/entries', undefined, 'kladde_session=nope')).status).toBe(401);
    const off = await call('GET', '/api/p/logbook/entries');
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: 'plugin_disabled' });
    switchOn(anna.id, true);
    expect((await call('GET', '/api/p/logbook/entries')).status).toBe(200);
    expect((await call('GET', '/api/plugins')).status).toBe(200);
    expect(await (await call('GET', '/api/plugins')).json()).toEqual([expect.objectContaining({ id: 'logbook', enabled: true, schema: 2 })]);
  });

  it('stores entries encrypted and per account', async () => {
    const created = await call('POST', '/api/p/logbook/entries', { text: 'Geheimer Gedanke', mood: 'good' });
    expect(created.status).toBe(201);
    const e = (await created.json()) as { id: string; text: string; mood: string };
    expect(e).toMatchObject({ text: 'Geheimer Gedanke', mood: 'good' });
    const raw = db.prepare('SELECT payload FROM p_logbook_entries WHERE id = ?').get(e.id) as { payload: Uint8Array };
    expect(Buffer.from(raw.payload).toString('latin1')).not.toContain('Geheimer');
    expect(await (await call('GET', '/api/p/logbook/entries')).json()).toEqual([expect.objectContaining({ id: e.id, text: 'Geheimer Gedanke' })]);
    // Ben has his own (empty) logbook once he switches it on, and cannot delete Anna's entry
    switchOn(ben.id, true);
    expect(await (await call('GET', '/api/p/logbook/entries', undefined, benCookie)).json()).toEqual([]);
    expect((await call('DELETE', `/api/p/logbook/entries/${e.id}`, undefined, benCookie)).status).toBe(404);
  });

  it('maps PluginError to its status and unknown routes to 404', async () => {
    const bad = await call('POST', '/api/p/logbook/entries', { text: '   ' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Der Eintrag braucht 1 bis 2000 Zeichen.' });
    expect((await call('GET', '/api/p/logbook/nothing')).status).toBe(404);
    expect((await call('GET', '/api/p/unknown/entries')).status).toBe(404);
  });

  it('turns an entry into a note through the sync and counts note changes', async () => {
    const [e] = (await (await call('GET', '/api/p/logbook/entries')).json()) as { id: string }[];
    const before = (await (await call('GET', '/api/p/logbook/stats')).json()) as { notesChanged: number };
    const res = await call('POST', `/api/p/logbook/entries/${e.id}/note`, {});
    expect(res.status).toBe(201);
    const { noteId } = (await res.json()) as { noteId: string };
    const note = ctx.notes.fetchNotes(anna.id, [noteId])[0];
    expect(note.path).toMatch(/^Logbuch\/\d{4}-\d{2}-\d{2} 1\.md$/);
    expect(note.content).toContain('type: plugin:logbook:entry');
    expect(note.content).toContain('Geheimer Gedanke');
    const after = (await (await call('GET', '/api/p/logbook/stats')).json()) as { notesChanged: number; keepDays: number };
    expect(after.notesChanged).toBe(before.notesChanged + 1);
    expect(after.keepDays).toBe(30);
  });

  it('adds its data to the account export and runs its jobs', async () => {
    const files = await ctx.plugins.exportFiles(anna.id);
    expect(files.map((f) => f.path)).toEqual(['logbook/entries.json']);
    expect(String(files[0].content)).toContain('Geheimer Gedanke');
    const old = crypto.randomUUID();
    db.prepare('INSERT INTO p_logbook_entries (id, owner_id, at, payload) VALUES (?, ?, ?, ?)').run(old, anna.id, Date.now() - 40 * 86_400_000, Buffer.from('x'));
    await ctx.plugins.tick();
    expect(db.prepare('SELECT id FROM p_logbook_entries WHERE id = ?').get(old)).toBeUndefined();
  });

  it('keeps the data of a removed plugin until it is purged', async () => {
    const lines = (await runCli(['plugins'], { db, users: ctx.users, notes: ctx.notes, files: ctx.files, plugins: [] })).lines.join('\n');
    expect(lines).toContain('logbook  not installed');
    await expect(runCli(['plugins', 'purge', 'logbook', '--yes'], { db, users: ctx.users, notes: ctx.notes, files: ctx.files, plugins: [entry(logbook)] })).rejects.toThrow(/part of this build/);
    await expect(runCli(['plugins', 'purge', 'logbook'], { db, users: ctx.users, notes: ctx.notes, files: ctx.files, plugins: [] })).rejects.toThrow(/--yes/);
    // Purging drops exactly the plugin's tables, nothing with a similar name
    db.exec('CREATE TABLE p_logbookx_keep (id TEXT)');
    const purged = await runCli(['plugins', 'purge', 'logbook', '--yes'], { db, users: ctx.users, notes: ctx.notes, files: ctx.files, plugins: [] });
    expect((purged.data as { dropped: string[] }).dropped.sort()).toEqual(['p_logbook_entries', 'p_logbook_stats']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'p_logbookx_keep'").get()).toBeDefined();
    expect(pluginSchemaVersions(db).has('logbook')).toBe(false);
    expect(() => purgePluginData(db, 'x%\\')).toThrow(/Invalid plugin id/);
  });
});

describe('a plugin built for another plugin API', () => {
  it('is left out instead of starting', async () => {
    const dataDir = tempDir();
    const db = openDatabase(':memory:');
    const future = defineServerPlugin({ id: 'future', migrations: [{ version: 1, description: 'T', sql: 'CREATE TABLE p_future_t (id TEXT)' }], routes: (r) => r.get('/x', (_q, s) => s.json({})) });
    const ctx = createKladdeApp({ db, dataDir, env: { DATA_KEY: crypto.randomBytes(32).toString('base64') }, standalone: false, isProduction: false, publicUrl: null, trustProxy: false, plugins: [entry(future, { api: '^9.0.0' })] });
    expect(ctx.plugins.count).toBe(0);
    expect(ctx.plugins.status()[0]).toMatchObject({ id: 'future', disabled: expect.stringContaining('needs @kladde/plugin-api ^9.0.0') });
    expect(pluginSchemaVersions(db).has('future')).toBe(false);
  });

  it('stops the start when its id differs from its package', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      createKladdeApp({ db, dataDir: tempDir(), env: { DATA_KEY: crypto.randomBytes(32).toString('base64') }, standalone: false, isProduction: false, publicUrl: null, trustProxy: false, plugins: [entry(logbook, { id: 'other' })] })
    ).toThrow(/differs from the plugin's id/);
  });
});
