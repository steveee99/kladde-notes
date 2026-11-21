import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { newProjectContent, newTicketContent, parseProject, presetTransitions, setTicketFields, ticketMeta, writeProject, type Automation, type TicketHook } from '@kladde/shared';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';
import { TOOLS } from '../src/mcp/tools';

const db = openDatabase(':memory:');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-workflow-'));
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
const benCookie = `kladde_session=${users.createSession(ben.id)}`;

let server: Server;
let base = '';
let n = 0;

const rule = (a: Partial<Automation>): Automation => ({ id: `r${++n}`, name: 'Regel', enabled: true, trigger: 'mr_merged', from: [], to: [], ifStatus: [], ifLabels: [], force: false, actions: [], ...a });

function project(folder: string, change: (c: ReturnType<typeof parseProject> & object) => object) {
  const content = newProjectContent('KLD');
  const config = parseProject(content)!;
  const id = `db-${String(++n).padStart(6, "0")}`;
  const now = Date.now();
  notes.push(anna.id, [{ id, baseVersion: 0, path: `${folder}/_database-${crypto.randomUUID()}.md`, content: writeProject(content, { ...config, ...change(config) }), deleted: false, createdAt: now, updatedAt: now }]);
  return id;
}

function ticket(folder: string, status: string) {
  const id = `tk-${String(++n).padStart(6, "0")}`;
  const now = Date.now();
  const [r] = notes.push(anna.id, [{ id, baseVersion: 0, path: `${folder}/Ticket ${n}.md`, content: newTicketContent({ key: 'KLD', status }), deleted: false, createdAt: now, updatedAt: now }]);
  return { id, path: `${folder}/Ticket ${n}.md`, version: r.status === 'ok' ? r.version : 0, content: r.status === 'ok' ? (r.content ?? '') : '' };
}

const current = (id: string) => notes.ownedNotes(anna.id).find((x) => x.id === id)!;
const setStatus = (id: string, status: string, opts = {}) => {
  const note = current(id);
  return notes.push(anna.id, [{ id, baseVersion: note.version, path: note.path, content: setTicketFields(note.content, { status }), deleted: false, createdAt: note.createdAt, updatedAt: Date.now() }], opts)[0];
};

beforeAll(async () => {
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('transitions on push', () => {
  it('undoes a status change the workflow does not allow and keeps the rest of the text', () => {
    project('Linear', (c) => ({ transitions: presetTransitions('linear', c.workflow) }));
    const tk = ticket('Linear', 'Offen');
    expect(setStatus(tk.id, 'In Arbeit')).toMatchObject({ status: 'ok' });
    const note = current(tk.id);
    const [r] = notes.push(anna.id, [{ ...note, baseVersion: note.version, content: `${setTicketFields(note.content, { status: 'Erledigt' })}\nNeuer Text\n` }]);
    expect(r).toMatchObject({ status: 'ok', rejectedStatus: 'Erledigt' });
    const stored = current(tk.id).content;
    expect(ticketMeta(stored).status).toBe('In Arbeit');
    expect(stored).toContain('Neuer Text');
    // Allowed steps go through; automations (trusted) may skip
    expect(setStatus(tk.id, 'Review')).not.toHaveProperty('rejectedStatus');
    expect(setStatus(tk.id, 'Offen', { trusted: true })).not.toHaveProperty('rejectedStatus');
  });

  it('checks a status typed by hand against the last workflow status', () => {
    project('Typed', (c) => ({ transitions: presetTransitions('forward', c.workflow) }));
    const tk = ticket('Typed', 'Offen');
    // Half-typed values are left alone, the finished one is checked against "Offen"
    expect(setStatus(tk.id, 'Erl')).not.toHaveProperty('rejectedStatus');
    const r = setStatus(tk.id, 'Erledigt');
    expect(r).toMatchObject({ rejectedStatus: 'Erledigt' });
    expect(ticketMeta(current(tk.id).content).status).toBe('Offen');
  });

  it('leaves projects without transitions and notes outside projects alone', () => {
    project('Frei', () => ({}));
    const tk = ticket('Frei', 'Offen');
    expect(setStatus(tk.id, 'Erledigt')).not.toHaveProperty('rejectedStatus');
    const loose = ticket('Irgendwo', 'Offen');
    expect(setStatus(loose.id, 'Erledigt')).not.toHaveProperty('rejectedStatus');
  });

  it('follows changes of the project settings', () => {
    const dbId = project('Wechsel', () => ({}));
    const tk = ticket('Wechsel', 'Offen');
    const dbNote = current(dbId);
    const config = parseProject(dbNote.content)!;
    notes.push(anna.id, [{ ...dbNote, baseVersion: dbNote.version, content: writeProject(dbNote.content, { ...config, transitions: presetTransitions('forward', config.workflow) }) }]);
    expect(setStatus(tk.id, 'Erledigt')).toMatchObject({ rejectedStatus: 'Erledigt' });
  });
});

describe('automations on push', () => {
  it('runs on creation, status change and finished sub-tasks', () => {
    project('Auto', () => ({
      automations: [
        rule({ trigger: 'ticket_created', actions: [{ type: 'add_label', value: 'neu' }] }),
        rule({ name: 'Start', trigger: 'status_changed', to: ['In Arbeit'], actions: [{ type: 'set_assignee', value: '{{actor}}' }, { type: 'remove_label', value: 'neu' }] }),
        rule({ name: 'Fertig', trigger: 'subtasks_done', actions: [{ type: 'set_status', value: 'Review' }] }),
      ],
    }));
    const tk = ticket('Auto', 'Offen');
    expect(ticketMeta(tk.content)).toMatchObject({ id: expect.stringMatching(/^KLD-\d+$/), labels: ["neu"] });
    const r = setStatus(tk.id, 'In Arbeit');
    expect(r).toMatchObject({ status: 'ok', automations: ['Start'] });
    expect(ticketMeta(current(tk.id).content)).toMatchObject({ assignee: 'anna', labels: [] });
    const note = current(tk.id);
    notes.push(anna.id, [{ ...note, baseVersion: note.version, content: `${note.content}\n- [x] Eins\n` }]);
    expect(ticketMeta(current(tk.id).content).status).toBe('Review');
  });
});

async function hookFor(projectId: string, provider: 'gitlab' | 'github', cookie = annaCookie) {
  const res = await fetch(`${base}/api/ticket-hooks/${projectId}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, name: 'Repo' }) });
  return { status: res.status, body: (await res.json()) as { hook: TicketHook; secret: string } };
}

describe('webhooks', () => {
  it('moves a ticket to the status of the rule when GitLab reports a merge', async () => {
    const projectId = project('Git', (c) => ({
      workflow: [...c.workflow.slice(0, 3), 'Implementiert', 'Erledigt'],
      transitions: presetTransitions('forward', [...c.workflow.slice(0, 3), 'Implementiert', 'Erledigt']),
      automations: [
        rule({ name: 'Merge', ifStatus: ['In Arbeit', 'Review'], force: true, actions: [{ type: 'set_status', value: 'Implementiert' }, { type: 'comment', value: 'Gemergt: {{mr.url}}' }] }),
        rule({ name: 'Notiz', trigger: 'status_changed', to: ['Implementiert'], actions: [{ type: 'add_label', value: 'deploy' }] }),
      ],
    }));
    const tk = ticket('Git', 'Offen');
    setStatus(tk.id, 'In Arbeit');
    const ticketId = ticketMeta(tk.content).id!;
    const { status, body } = await hookFor(projectId, 'gitlab');
    expect(status).toBe(200);
    expect(body.hook.url).toBe(`${base}/api/hooks/${body.hook.id}`);
    // The secret and name are not stored in plain text
    const row = db.prepare('SELECT * FROM ticket_hooks WHERE id = ?').get(body.hook.id) as Record<string, unknown>;
    expect(Buffer.from(row.payload as Uint8Array).toString('latin1')).not.toContain(body.secret);

    const delivery = { object_kind: 'merge_request', user: { username: 'dev' }, object_attributes: { action: 'merge', iid: 4, title: 'Login', source_branch: `feature/${ticketId.toLowerCase()}-login`, url: 'https://git.example/mr/4', description: '' } };
    const send = (token: string) => fetch(body.hook.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Token': token }, body: JSON.stringify(delivery) });
    expect((await send('falsch')).status).toBe(401);
    const res = await send(body.secret);
    expect(res.status).toBe(200);
    const stored = current(tk.id).content;
    expect(ticketMeta(stored)).toMatchObject({ status: 'Implementiert', labels: ['deploy'] });
    expect(stored).toContain('Gemergt: https://git.example/mr/4');
    const [listed] = (await (await fetch(`${base}/api/ticket-hooks/${projectId}`, { headers: { Cookie: annaCookie } })).json()) as TicketHook[];
    expect(listed.last).toMatchObject({ ok: true, summary: expect.stringContaining(`${ticketId}: Merge, Notiz`) });
  });

  it('checks the GitHub signature and tells merged from closed pull requests', async () => {
    const projectId = project('Hub', () => ({
      automations: [rule({ name: 'Merge', actions: [{ type: 'set_status', value: 'Erledigt' }] }), rule({ name: 'Zu', trigger: 'mr_closed', actions: [{ type: 'add_label', value: 'verworfen' }] })],
    }));
    const tk = ticket('Hub', 'Review');
    const ticketId = ticketMeta(tk.content).id!;
    const { body } = await hookFor(projectId, 'github');
    const send = (payload: object, secret = body.secret) => {
      const raw = JSON.stringify(payload);
      const sig = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
      return fetch(body.hook.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sig }, body: raw });
    };
    const pr = (merged: boolean) => ({ action: 'closed', pull_request: { merged, number: 9, title: `${ticketId} Login`, html_url: 'https://github.example/pr/9', head: { ref: 'x' }, user: { login: 'dev' }, body: '' } });
    expect((await send(pr(false), 'anders')).status).toBe(401);
    expect((await send(pr(false))).status).toBe(200);
    expect(ticketMeta(current(tk.id).content)).toMatchObject({ status: 'Review', labels: ['verworfen'] });
    expect((await send(pr(true))).status).toBe(200);
    expect(ticketMeta(current(tk.id).content).status).toBe('Erledigt');
    // Other events are answered and ignored
    const ping = await fetch(body.hook.url, { method: 'POST', headers: { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', body.secret).update('{}').digest('hex')}` }, body: '{}' });
    expect(ping.status).toBe(202);
  });

  it('only project managers manage hooks; removed hooks stop working', async () => {
    const projectId = project('Privat', () => ({}));
    expect((await hookFor(projectId, 'gitlab', benCookie)).status).toBe(404);
    expect((await fetch(`${base}/api/ticket-hooks/${projectId}`, { headers: { Cookie: benCookie } })).status).toBe(404);
    const { body } = await hookFor(projectId, 'gitlab');
    const left = (await (await fetch(`${base}/api/ticket-hooks/${projectId}/${body.hook.id}`, { method: 'DELETE', headers: { Cookie: annaCookie } })).json()) as TicketHook[];
    expect(left).toEqual([]);
    const res = await fetch(body.hook.url, { method: 'POST', headers: { 'X-Gitlab-Token': body.secret, 'X-Gitlab-Event': 'Merge Request Hook' }, body: '{}' });
    expect(res.status).toBe(404);
    expect((await hookFor(projectId, 'bitbucket' as 'gitlab')).status).toBe(400);
  });
});

describe('MCP', () => {
  it('ticket_update refuses a change the workflow does not allow and names the allowed ones', () => {
    project('Mcp', (c) => ({ transitions: presetTransitions('forward', c.workflow) }));
    notes.push(anna.id, [
      { id: `syssettings-${anna.id}`, baseVersion: 0, path: '.kladde/settings.json', content: JSON.stringify({ features: { tickets: { enabled: true } } }), deleted: false, createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    const tk = ticket('Mcp', 'Offen');
    const tool = TOOLS.find((t) => t.name === 'ticket_update')!;
    const toolCtx = { userId: anna.id, canWrite: true, notes };
    expect(() => tool.run({ ticket: ticketMeta(tk.content).id!, status: 'Erledigt' }, toolCtx as never)).toThrow(/nur nach: In Arbeit/);
    expect(tool.run({ ticket: ticketMeta(tk.content).id!, status: 'In Arbeit' }, toolCtx as never)).toMatchObject({ status: 'In Arbeit' });
  });
});
