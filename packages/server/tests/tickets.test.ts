import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { newMilestoneContent, newProjectContent, newTicketContent, parseProject, ticketMeta, writeProject } from '@kladde/shared';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { GroupError, GroupStore } from '../src/GroupStore';
import { NoteStore } from '../src/NoteStore';
import { UserStore } from '../src/UserStore';
import { TOOLS } from '../src/mcp/tools';

function setup() {
  const db = openDatabase(':memory:');
  const cipher = new DataCipher(crypto.randomBytes(32));
  const users = new UserStore(db);
  const notes = new NoteStore(db, cipher);
  const groups = new GroupStore(db);
  return { db, cipher, users, notes, groups, anna: users.createUser('anna'), ben: users.createUser('ben') };
}

let counter = 0;
const change = (content: string, extra: object = {}) => ({
  id: `ticket-note-${++counter}`,
  baseVersion: 0,
  path: `Projekte/Kladde/T${counter}.md`,
  content,
  deleted: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...extra,
});
const ticket = (key = 'KLD') => newTicketContent({ key, status: 'Offen' });

describe('ticket numbers', () => {
  it('numbers provisional tickets per owner and key, and returns the new text', () => {
    const { notes, anna, ben } = setup();
    const [a, b] = notes.push(anna.id, [change(ticket()), change(ticket())]);
    expect(a).toMatchObject({ status: 'ok', version: 1 });
    expect(a.status === 'ok' && ticketMeta(a.content!).id).toBe('KLD-1');
    expect(b.status === 'ok' && ticketMeta(b.content!).id).toBe('KLD-2');
    // The stored note has the number too
    expect(notes.ownedNotes(anna.id).map((n) => ticketMeta(n.content).id).sort()).toEqual(['KLD-1', 'KLD-2']);
    // Another key and another user count on their own
    const [c] = notes.push(anna.id, [change(ticket('ABC'))]);
    expect(c.status === 'ok' && ticketMeta(c.content!).id).toBe('ABC-1');
    const [d] = notes.push(ben.id, [change(ticket())]);
    expect(d.status === 'ok' && ticketMeta(d.content!).id).toBe('KLD-1');
  });

  it('leaves other notes and numbered tickets alone', () => {
    const { notes, anna } = setup();
    const [plain] = notes.push(anna.id, [change('---\nid: KLD-?\n---\nkein Ticket')]);
    expect(plain).toEqual({ id: expect.any(String), status: 'ok', version: 1 });
    const [numbered] = notes.push(anna.id, [change(ticket().replace('KLD-?', 'KLD-41'))]);
    expect(numbered.status === 'ok' && numbered.content).toBeUndefined();
    // A hand-written number moves the counter up
    const [next] = notes.push(anna.id, [change(ticket())]);
    expect(next.status === 'ok' && ticketMeta(next.content!).id).toBe('KLD-42');
  });

  it('continues after the highest number already in the notes or the trash', () => {
    const { db, notes, anna } = setup();
    const old = change(ticket().replace('KLD-?', 'KLD-7'));
    notes.push(anna.id, [old, change(ticket().replace('KLD-?', 'KLD-3'))]);
    // Forget the counter, as if the tickets came from before the counter existed; then trash the highest one
    db.exec('DELETE FROM ticket_counters');
    notes.push(anna.id, [{ ...old, baseVersion: 1, deleted: true }]);
    const [next] = notes.push(anna.id, [change(ticket())]);
    expect(next.status === 'ok' && ticketMeta(next.content!).id).toBe('KLD-8');
  });

  it('numbers a provisional ticket also when it changes later', () => {
    const { notes, anna } = setup();
    const first = change('# Entwurf');
    notes.push(anna.id, [first]);
    const [r] = notes.push(anna.id, [{ ...first, baseVersion: 1, content: ticket() }]);
    expect(r).toMatchObject({ status: 'ok', version: 2 });
    expect(r.status === 'ok' && ticketMeta(r.content!).id).toBe('KLD-1');
  });

  it('counts group tickets in the group, whoever creates them', () => {
    const { notes, groups, anna, ben } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'editor');
    const [a] = notes.push(anna.id, [change(ticket(), { group: g.id })]);
    const [b] = notes.push(ben.id, [change(ticket(), { group: g.id })]);
    expect([a, b].map((r) => r.status === 'ok' && ticketMeta(r.content!).id)).toEqual(['KLD-1', 'KLD-2']);
  });

  it('stores no project key in plain text', () => {
    const { db, notes, anna } = setup();
    notes.push(anna.id, [change(ticket('SECRET'))]);
    const rows = db.prepare('SELECT * FROM ticket_counters').all() as { key_mac: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });
});

describe('group features', () => {
  it('owners switch tickets on for every member; members see it in their groups', () => {
    const { notes, groups, anna, ben } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'editor');
    expect(notes.groupsOf(ben.id)[0].features).toEqual({ tickets: false });
    const seqBefore = notes.pull(ben.id, 0).cursor;
    expect(groups.setFeatures(anna.id, g.id, { tickets: true })).toEqual({ tickets: true });
    expect(notes.groupsOf(ben.id)[0].features).toEqual({ tickets: true });
    expect(groups.details(ben.id, g.id).features).toEqual({ tickets: true });
    // Members pull again
    expect(notes.pull(ben.id, seqBefore).groups?.[0].features?.tickets).toBe(true);
    // Only owners, and only booleans
    expect(() => groups.setFeatures(ben.id, g.id, { tickets: false })).toThrow(GroupError);
    expect(() => groups.setFeatures(anna.id, g.id, { tickets: 'yes' })).toThrow(GroupError);
    expect(groups.setFeatures(anna.id, g.id, { unknown: true })).toEqual({ tickets: true });
  });
});

describe('MCP ticket tools', () => {
  const run = (name: string, args: Record<string, unknown>, ctx: Parameters<(typeof TOOLS)[number]['run']>[1]) => TOOLS.find((t) => t.name === name)!.run(args, ctx) as never;
  const now = Date.now();
  const push = (notes: NoteStore, userId: string, id: string, path: string, content: string, extra: object = {}) =>
    notes.push(userId, [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now, ...extra }]);

  function world() {
    const s = setup();
    push(s.notes, s.anna.id, `syssettings-${s.anna.id}`, '.kladde/settings.json', JSON.stringify({ features: { tickets: { enabled: true } } }));
    push(s.notes, s.anna.id, 'project-db-01', 'Projekte/Kladde/_database-0a1b2c3d.md', newProjectContent('KLD'));
    push(s.notes, s.anna.id, 'milestone-01', 'Projekte/Kladde/Meilensteine/v2.14 Tickets.md', newMilestoneContent({ id: 'v2.14', start: '2026-11-23', due: '2026-12-18' }));
    const g = s.groups.create(s.anna.id, 'Team');
    s.groups.setMember(s.anna.id, g.id, s.ben.id, 'reader');
    push(s.notes, s.anna.id, 'group-db-001', 'Plan/_database-0a1b2c3e.md', newProjectContent('TEAM'), { group: g.id });
    return { ...s, g, ctx: { userId: s.anna.id, canWrite: true, notes: s.notes, today: new Date(2026, 10, 25) } };
  }

  it('creates, lists and changes tickets in own projects', () => {
    const { ctx } = world();
    const created = run('ticket_create', { project: 'kld', title: 'Nummern offline', status: 'in arbeit', assignee: '@anna', milestone: 'v2.14', labels: ['sync'], estimate: 3 }, ctx) as { ticket: string; path: string };
    expect(created).toMatchObject({ ticket: 'KLD-1', path: 'Projekte/Kladde/Nummern offline.md' });
    run('ticket_create', { project: 'Projekte/Kladde', title: 'Chips' }, ctx);
    expect(() => run('ticket_create', { project: 'KLD', title: 'x', status: 'Gibts nicht' }, ctx)).toThrow(/Unbekannter Status/);
    const mine = run('list_tickets', { assignee: 'me' }, ctx) as { ticket: string; status: string; category: string; project: string }[];
    expect(mine).toEqual([expect.objectContaining({ ticket: 'KLD-1', status: 'In Arbeit', category: 'active', project: 'KLD' })]);
    const updated = run('ticket_update', { ticket: 'kld-1', status: 'Erledigt', docs: ['Sync-Protokoll'], comment: 'Fertig.' }, ctx) as { status: string; docs: string[]; category: string };
    expect(updated).toMatchObject({ status: 'Erledigt', category: 'done', docs: ['Sync-Protokoll'] });
    expect(run('list_tickets', { open_only: true }, ctx)).toHaveLength(1);
    const status = run('milestone_status', { milestone: 'v2.14' }, ctx) as { total: number; done: number; points: number };
    expect(status).toMatchObject({ total: 1, done: 1, points: 3 });
    const projects = run('list_projects', {}, ctx) as { key: string }[];
    // The group has not switched tickets on: only the own project
    expect(projects.map((p) => p.key)).toEqual(['KLD']);
  });

  it('starts new tickets with the checklist template of their type', () => {
    const s = setup();
    push(s.notes, s.anna.id, `syssettings-${s.anna.id}`, '.kladde/settings.json', JSON.stringify({ features: { tickets: { enabled: true } } }));
    const db = newProjectContent('KLD');
    push(s.notes, s.anna.id, 'project-db-01', 'Projekte/Kladde/_database-0a1b2c3d.md', writeProject(db, { ...parseProject(db)!, checklists: { bug: ['Abnahme', 'Regressionstest'] } }));
    const ctx = { userId: s.anna.id, canWrite: true, notes: s.notes, today: new Date(2026, 10, 25) };
    const bug = run('ticket_create', { project: 'KLD', title: 'Absturz', kind: 'bug', description: 'Beim Speichern.' }, ctx) as { id: string };
    const task = run('ticket_create', { project: 'KLD', title: 'Aufräumen' }, ctx) as { id: string };
    const content = (id: string) => s.notes.ownedNotes(s.anna.id).find((n) => n.id === id)!.content;
    expect(content(bug.id)).toMatch(/Beim Speichern\.\n\n- \[ \] Abnahme\n- \[ \] Regressionstest\n$/);
    expect(content(task.id)).not.toContain('- [ ]');
  });

  it('builds the hierarchy epic > feature > task > subtask with checked parents', () => {
    const { ctx } = world();
    const epic = run('ticket_create', { project: 'KLD', title: 'Offline', kind: 'epic' }, ctx) as { ticket: string };
    const feature = run('ticket_create', { project: 'KLD', title: 'Sync-Status', kind: 'feature', parent: epic.ticket }, ctx) as { ticket: string };
    const task = run('ticket_create', { project: 'KLD', title: 'Badge', parent: feature.ticket }, ctx) as { ticket: string };
    expect(() => run('ticket_create', { project: 'KLD', title: 'x', kind: 'epic', parent: feature.ticket }, ctx)).toThrow(/kein übergeordnetes/);
    expect(() => run('ticket_create', { project: 'KLD', title: 'x', kind: 'feature', parent: task.ticket }, ctx)).toThrow(/Erlaubt: epic/);
    run('ticket_create', { project: 'KLD', title: 'Icon', kind: 'subtask', parent: task.ticket }, ctx);
    const below = run('list_tickets', { parent: task.ticket }, ctx) as { title: string; kind: string }[];
    expect(below).toEqual([expect.objectContaining({ title: 'Icon', kind: 'subtask' })]);
    expect(run('list_tickets', { kind: 'task' }, ctx)).toEqual([expect.objectContaining({ ticket: task.ticket, kind: 'task', parent: feature.ticket })]);
    // Turning the task into an epic drops its parent
    expect(run('ticket_update', { ticket: task.ticket, kind: 'epic' }, ctx)).toMatchObject({ kind: 'epic', parent: null });
  });

  it('group projects follow the group switch, readers cannot write', () => {
    const { ctx, groups, g, ben, notes } = world();
    groups.setFeatures(ctx.userId, g.id, { tickets: true });
    expect((run('list_projects', {}, ctx) as { key: string }[]).map((p) => p.key).sort()).toEqual(['KLD', 'TEAM']);
    const created = run('ticket_create', { project: 'TEAM', title: 'Gemeinsam' }, ctx) as { ticket: string; group: string };
    expect(created).toMatchObject({ ticket: 'TEAM-1', group: 'Team' });
    // Ben has tickets off himself, but the group has them on
    const benCtx = { userId: ben.id, canWrite: true, notes };
    expect((run('list_projects', {}, benCtx) as { key: string; read_only: boolean }[])).toEqual([expect.objectContaining({ key: 'TEAM', read_only: true })]);
    expect(() => run('ticket_create', { project: 'TEAM', title: 'x' }, benCtx)).toThrow(/nur lesen/);
  });

  it('without the feature there are no projects', () => {
    const { ctx, notes, anna } = world();
    notes.push(anna.id, [{ id: `syssettings-${anna.id}`, baseVersion: 1, path: '.kladde/settings.json', content: '{}', deleted: false, createdAt: now, updatedAt: now }]);
    expect(run('list_projects', {}, ctx)).toEqual([]);
    expect(() => run('ticket_create', { project: 'KLD', title: 'x' }, ctx)).toThrow(/keine Projekte/);
  });
});
