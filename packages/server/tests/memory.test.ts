import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { addVerification, memoryMeta, parseYaml } from '@kladde/shared';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteStore } from '../src/NoteStore';
import { AuditLog } from '../src/security/AuditLog';
import { McpTokenStore } from '../src/mcp/McpTokenStore';
import { mcpRouters } from '../src/mcp/router';

const db = openDatabase(':memory:');
const users = new UserStore(db);
const notes = new NoteStore(db, new DataCipher(crypto.randomBytes(32)));
const tokens = new McpTokenStore(db);
const anna = users.createUser('anna');
const ben = users.createUser('ben');

let server: Server;
let base = '';

function setFeatures(userId: string, features: unknown) {
  const id = `syssettings-${userId}`;
  const old = notes.ownedNotes(userId).find((n) => n.id === id);
  const now = Date.now();
  notes.push(userId, [{ id, baseVersion: old?.version ?? 0, path: '.kladde/settings.json', content: JSON.stringify({ features }), deleted: false, createdAt: now, updatedAt: now }]);
}

beforeAll(async () => {
  const app = express();
  const mcp = mcpRouters({ users, notes, tokens, audit: new AuditLog(db), publicUrl: null });
  app.use(mcp.publicRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setFeatures(anna.id, { memory: { enabled: true } });
  const now = Date.now();
  notes.push(anna.id, [
    {
      id: 'rule-0001',
      baseVersion: 0,
      path: 'AI-Memory/Regeln/Sprache.md',
      content: '---\ntype: Rule\ndescription: Sprache der Antworten\n---\nAntworte immer auf Deutsch.\n',
      deleted: false,
      createdAt: now,
      updatedAt: now,
    },
    { id: 'priv-0001', baseVersion: 0, path: '3 Ressourcen/Kaffee.md', content: '# Kaffee\n', deleted: false, createdAt: now, updatedAt: now },
  ]);
});

afterAll(() => server.close());

let rpcId = 0;
async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()) as any;
}
const call = async (token: string, name: string, args: Record<string, unknown> = {}) => (await rpc(token, 'tools/call', { name, arguments: args })).result;
const json = (result: any) => JSON.parse(result.content[0].text);
const note = (path: string) => notes.ownedNotes(anna.id).find((n) => n.path === path);

describe('AI memory over MCP (#94)', () => {
  const { token } = tokens.createPersonalToken(anna.id, 'Claude', true);

  it('tells every agent about the memory and delivers the rules', async () => {
    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18' });
    expect(init.result.instructions).toContain('AI memory: the folder "AI-Memory"');
    expect(init.result.instructions).toContain('## Sprache\nAntworte immer auf Deutsch.');
    const resources = await rpc(token, 'resources/list');
    expect(resources.result.resources.map((r: any) => r.uri)).toEqual(['kladde://memory/rules', 'kladde://memory/rule/rule-0001']);
    const read = await rpc(token, 'resources/read', { uri: 'kladde://memory/rules' });
    expect(read.result.contents[0].text).toContain('Antworte immer auf Deutsch.');
    const prompt = await rpc(token, 'prompts/get', { name: 'memory_rules' });
    expect(prompt.result.messages[0].content.text).toContain('Antworte immer auf Deutsch.');
  });

  it('says nothing about it for users who did not turn it on', async () => {
    const other = tokens.createPersonalToken(ben.id, 'Claude', true).token;
    const init = await rpc(other, 'initialize', {});
    expect(init.result.instructions).not.toContain('AI memory');
    expect((await rpc(other, 'resources/list')).result.resources).toEqual([]);
    expect((await call(other, 'memory_save', { title: 'x', type: 'Reference' })).isError).toBe(true);
  });

  it('saves knowledge with stamped provenance, index and log', async () => {
    const res = json(
      await call(token, 'memory_save', {
        title: 'Kaffeemaschine X1',
        type: 'Reference',
        description: 'Wartung der X1.',
        folder: 'Geräte',
        tags: ['küche'],
        content: 'Entkalken alle 4 Wochen.[^manual]',
        sources: [{ id: 'manual', resource: 'https://example.com/x1.pdf', title: 'Handbuch' }],
      })
    );
    expect(res).toMatchObject({ path: 'AI-Memory/Geräte/Kaffeemaschine X1.md', created: true });
    expect(res.warnings).toBeUndefined();
    const saved = note('AI-Memory/Geräte/Kaffeemaschine X1.md')!;
    const meta = memoryMeta(saved.content);
    expect(meta).toMatchObject({ type: 'Reference', description: 'Wartung der X1.', trust: 'unverified' });
    expect(meta.generated?.by).toBe('claude');
    expect(saved.content).toContain('Entkalken alle 4 Wochen.[^manual]');
    expect(note('AI-Memory/Geräte/index.md')!.content).toContain('- [[Kaffeemaschine X1]]: Wartung der X1.');
    expect(note('AI-Memory/index.md')!.content).toContain('okf_version: "0.2"');
    expect(note('AI-Memory/index.md')!.content).toContain('[[AI-Memory/Geräte/index|Geräte]]');
    expect(note('AI-Memory/log.md')!.content).toMatch(/\*\*Creation\*\* \[\[Kaffeemaschine X1\]\] \(claude\)/);
  });

  it('updates only with the current version and logs deprecation', async () => {
    const before = note('AI-Memory/Geräte/Kaffeemaschine X1.md')!;
    expect((await call(token, 'memory_save', { title: 'Kaffeemaschine X1', type: 'Reference', folder: 'Geräte' })).isError).toBe(true);
    const res = json(await call(token, 'memory_save', { title: 'Kaffeemaschine X1', type: 'Reference', folder: 'Geräte', status: 'deprecated', version: before.version }));
    expect(res.created).toBe(false);
    const after = note('AI-Memory/Geräte/Kaffeemaschine X1.md')!;
    expect(after.content).toContain('Entkalken alle 4 Wochen.');
    expect(memoryMeta(after.content).status).toBe('deprecated');
    expect(note('AI-Memory/log.md')!.content).toContain('**Deprecation** [[Kaffeemaschine X1]] (claude)');
    expect(note('AI-Memory/Geräte/index.md')!.content).toContain('_(veraltet)_');
  });

  it('refuses notes without type and human confirmations by an agent', async () => {
    const bad = await call(token, 'create_note', { title: 'Ohne Typ', folder: 'AI-Memory', content: 'Text' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('`type`');
    const forged = await call(token, 'create_note', { title: 'Gefälscht', folder: 'AI-Memory', content: addVerification('---\ntype: Reference\n---\nx', 'human:anna') });
    expect(forged.isError).toBe(true);
    expect(note('AI-Memory/Gefälscht.md')).toBeUndefined();
  });

  it('keeps human confirmations when an agent rewrites a note', async () => {
    const n = note('AI-Memory/Geräte/Kaffeemaschine X1.md')!;
    const now = Date.now();
    notes.push(anna.id, [{ id: n.id, baseVersion: n.version, path: n.path, content: addVerification(n.content, 'human:anna', '2026-01-01T00:00:00Z'), deleted: false, createdAt: n.createdAt, updatedAt: now }]);
    const v = note(n.path)!;
    const res = await call(token, 'update_note', { id: v.id, version: v.version, content: '---\ntype: Reference\ndescription: Neu.\n---\nNeu.' });
    expect(res.isError).toBeFalsy();
    const meta = memoryMeta(note(n.path)!.content);
    expect(meta.trust).toBe('human-reviewed');
    expect(meta.changedSinceVerified).toBe(true);
  });

  it('leaves notes outside the memory alone', async () => {
    const n = note('3 Ressourcen/Kaffee.md')!;
    await call(token, 'update_note', { id: n.id, version: n.version, content: '# Kaffee\n\nOhne Frontmatter.' });
    expect(note('3 Ressourcen/Kaffee.md')!.content).toBe('# Kaffee\n\nOhne Frontmatter.');
  });

  it('checks the whole memory', async () => {
    const now = Date.now();
    notes.push(anna.id, [{ id: 'bad-00001', baseVersion: 0, path: 'AI-Memory/Kaputt.md', content: 'kein frontmatter', deleted: false, createdAt: now, updatedAt: now }]);
    const res = json(await call(token, 'memory_check'));
    expect(res).toMatchObject({ folder: 'AI-Memory', errors: 1, rules: 1 });
    expect(res.notes.find((n: any) => n.path === 'AI-Memory/Kaputt.md').problems[0]).toMatch(/^Fehler: /);
    expect(parseYaml('a: b')).toEqual({ a: 'b' });
  });
});
