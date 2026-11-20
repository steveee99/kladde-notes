import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { GroupDetails, GroupInfo } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { GroupError, GroupStore } from '../src/GroupStore';
import { NoteChangeEvent, NoteStore } from '../src/NoteStore';
import { UserStore } from '../src/UserStore';

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup() {
  const db = openDatabase(':memory:');
  const cipher = new DataCipher(crypto.randomBytes(32));
  const users = new UserStore(db);
  const events: NoteChangeEvent[] = [];
  const notes = new NoteStore(db, cipher, (e) => events.push(e));
  const groups = new GroupStore(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-groups-test-'));
  tmpDirs.push(dir);
  const files = new FileStore(db, cipher, dir);
  const anna = users.createUser('anna');
  const ben = users.createUser('ben');
  const cleo = users.createUser('cleo');
  return { db, users, notes, groups, files, anna, ben, cleo, events };
}

const note = (id: string, content: string, path = 'Inbox/Test.md', baseVersion = 0, extra: object = {}) => ({
  id,
  baseVersion,
  path,
  content,
  deleted: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...extra,
});

const lastOwner = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    return err instanceof GroupError ? err.status : -1;
  }
  return 0;
};

describe('groups (#58)', () => {
  it('a group is no account: it cannot be found, listed or counted as a user', () => {
    const { users, groups, anna } = setup();
    const g = groups.create(anna.id, '  Familie  ');
    expect(g).toMatchObject({ name: 'Familie', role: 'owner' });
    expect(users.getUser(g.id)).toBeNull();
    expect(users.findByUsername('Familie')).toBeNull();
    expect(users.findByUsername(`group:${g.id}`)).toBeNull();
    expect(users.listUsers().map((u) => u.username)).toEqual(['anna', 'ben', 'cleo']);
    expect(users.countUsers()).toBe(3);
    expect(users.listForAdmin()).toHaveLength(3);
    // a user may take the same name
    expect(users.checkNewUsername('Familie')).toBe('Familie');
    expect(() => groups.create(anna.id, '   ')).toThrow(GroupError);
  });

  it('members see group notes according to their role; the group owns them', () => {
    const { notes, groups, anna, ben, cleo } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'editor');
    groups.setMember(anna.id, g.id, cleo.id, 'reader');
    expect(notes.push(anna.id, [note('group-note-1', 'Hallo Team', 'Plan.md', 0, { group: g.id })])[0]).toMatchObject({ status: 'ok' });
    // readers may not create notes in the group, strangers neither
    expect(notes.push(cleo.id, [note('group-note-2', 'x', 'X.md', 0, { group: g.id })])[0].status).toBe('forbidden');
    const stranger = setup();
    expect(notes.groupRole(g.id, stranger.anna.id)).toBeNull();

    const forBen = notes.pull(ben.id, 0);
    expect(forBen.groups).toEqual([{ id: g.id, name: 'Team', role: 'editor', features: { tickets: false } }]);
    expect(forBen.notes.find((n) => n.id === 'group-note-1')).toMatchObject({ access: 'write', group: g.id, owner: 'Team', canDelete: true, path: 'Plan.md' });
    const forCleo = notes.pull(cleo.id, 0).notes.find((n) => n.id === 'group-note-1');
    expect(forCleo).toMatchObject({ access: 'read', group: g.id });
    expect(forCleo?.canDelete).toBeUndefined();
    // the note is nobody's own note
    expect(notes.ownedNotes(anna.id)).toEqual([]);

    // editors rename and move group notes; readers cannot write
    expect(notes.push(ben.id, [note('group-note-1', 'Hallo Team!', 'Projekte/Plan neu.md', 1)])[0]).toMatchObject({ status: 'ok', version: 2 });
    expect(notes.pull(anna.id, 0).notes.find((n) => n.id === 'group-note-1')).toMatchObject({ path: 'Projekte/Plan neu.md', access: 'write' });
    expect(notes.push(cleo.id, [note('group-note-1', 'nein', 'Plan.md', 2)])[0].status).toBe('forbidden');

    // editors delete into the group's trash, which writing members manage
    expect(notes.push(ben.id, [{ ...note('group-note-1', '', 'Projekte/Plan neu.md', 2), deleted: true }])[0].status).toBe('ok');
    expect(notes.trash(anna.id)).toEqual([expect.objectContaining({ id: 'group-note-1', group: 'Team', deletedBy: 'ben' })]);
    expect(notes.trash(cleo.id)).toEqual([]);
    expect(notes.restore(ben.id, ['group-note-1'])).toEqual([{ id: 'group-note-1', path: 'Projekte/Plan neu.md' }]);
    expect(notes.pull(cleo.id, 0).notes.find((n) => n.id === 'group-note-1')?.deleted).toBe(false);
  });

  it('role changes and removals reach the members, the last owner stays', () => {
    const { notes, groups, anna, ben } = setup();
    const g = groups.create(anna.id, 'Verein');
    // the only owner can neither leave nor lose the role
    expect(lastOwner(() => groups.removeMember(anna.id, g.id, anna.id))).toBe(409);
    expect(lastOwner(() => groups.setMember(anna.id, g.id, anna.id, 'editor'))).toBe(409);

    groups.setMember(anna.id, g.id, ben.id, 'reader');
    notes.push(anna.id, [note('club-note-1', 'Satzung', 'Satzung.md', 0, { group: g.id })]);
    const cursor = notes.currentSeq();
    // only owners manage members
    expect(lastOwner(() => groups.setMember(ben.id, g.id, ben.id, 'owner'))).toBe(403);

    groups.setMember(anna.id, g.id, ben.id, 'owner');
    const after = notes.pull(ben.id, cursor);
    expect(after.notes.find((n) => n.id === 'club-note-1')).toMatchObject({ access: 'write' });
    expect(after.groups?.[0].role).toBe('owner');

    // with a second owner, anna may step down and leave
    groups.setMember(anna.id, g.id, anna.id, 'editor');
    expect(groups.roleOf(g.id, anna.id)).toBe('editor');
    expect(lastOwner(() => groups.removeMember(ben.id, g.id, ben.id))).toBe(409);
    const before = notes.currentSeq();
    groups.removeMember(anna.id, g.id, anna.id);
    const gone = notes.pull(anna.id, before);
    expect(gone.revoked).toEqual(['club-note-1']);
    expect(gone.groups).toEqual([]);
    expect(groups.details(ben.id, g.id).members).toEqual([{ username: 'ben', role: 'owner' }]);
    expect(lastOwner(() => groups.details(anna.id, g.id))).toBe(404);
  });

  it('moving a folder into a group keeps its structure, ends shares and keeps notes encrypted', () => {
    const { db, notes, groups, anna, ben, cleo, events } = setup();
    const g = groups.create(anna.id, 'Projekt');
    groups.setMember(anna.id, g.id, ben.id, 'reader');
    notes.push(anna.id, [
      note('move-note-1', 'Siehe [[Teil B]] und [[Privat]]', 'Arbeit/Kunde/Teil A.md'),
      note('move-note-2', 'B', 'Arbeit/Kunde/Unter/Teil B.md'),
      note('move-note-3', 'privat', 'Arbeit/Privat.md'),
    ]);
    notes.share(anna.id, 'move-note-1', cleo.id, true);
    notes.setPublic(anna.id, 'move-note-1', true);
    // only notes of the moved folder, and only own ones
    expect(() => notes.moveToGroup(anna.id, g.id, { noteIds: ['move-note-3'], folder: 'Arbeit/Kunde', target: '' })).toThrow('not found');
    expect(() => notes.moveToGroup(ben.id, g.id, { noteIds: ['move-note-1'], target: '' })).toThrow('forbidden');

    const cursor = notes.currentSeq();
    events.length = 0;
    const result = notes.moveToGroup(anna.id, g.id, { noteIds: ['move-note-1', 'move-note-2'], folder: 'Arbeit/Kunde', target: 'Kunden' });
    expect(result.moved).toEqual([
      { id: 'move-note-1', path: 'Kunden/Kunde/Teil A.md' },
      { id: 'move-note-2', path: 'Kunden/Kunde/Unter/Teil B.md' },
    ]);
    // the content (and its links) stays as it was
    const forBen = notes.pull(ben.id, cursor).notes;
    expect(forBen.map((n) => n.id).sort()).toEqual(['move-note-1', 'move-note-2']);
    expect(forBen.find((n) => n.id === 'move-note-1')).toMatchObject({ content: 'Siehe [[Teil B]] und [[Privat]]', group: g.id, access: 'read' });
    // the mover keeps editing it, as a member
    expect(notes.pull(anna.id, cursor).notes.find((n) => n.id === 'move-note-1')).toMatchObject({ access: 'write', group: g.id, owner: 'Projekt' });
    // the single share ended, and the public link with it
    expect(notes.pull(cleo.id, cursor).revoked).toEqual(['move-note-1']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM public_links').get()).toEqual({ n: 0 });
    // the export mirror drops the old file of the owner
    expect(events.find((e) => e.ownerId === anna.id && e.deleted)).toMatchObject({ previousPath: 'Arbeit/Kunde/Teil A.md' });
    expect(notes.ownedNotes(anna.id).map((n) => n.id)).toEqual(['move-note-3']);
    const raw = db.prepare('SELECT payload FROM notes WHERE id = ?').get('move-note-1') as { payload: Uint8Array };
    expect(Buffer.from(raw.payload).toString('utf8')).not.toContain('Teil B');

    // a single note lands directly in the target; a taken name gets a free one
    notes.push(anna.id, [note('move-note-4', 'zweites', 'Woanders/Teil A.md')]);
    expect(notes.moveToGroup(anna.id, g.id, { noteIds: ['move-note-4'], target: 'Kunden/Kunde' }).moved).toEqual([{ id: 'move-note-4', path: 'Kunden/Kunde/Teil A 2.md' }]);
  });

  it('deleting a group removes its notes for every member', () => {
    const { db, notes, groups, anna, ben } = setup();
    const g = groups.create(anna.id, 'Weg');
    groups.setMember(anna.id, g.id, ben.id, 'owner');
    notes.push(anna.id, [note('del-note-1', 'a', 'A.md', 0, { group: g.id }), note('del-note-2', 'b', 'B.md', 0, { group: g.id })]);
    notes.push(anna.id, [{ ...note('del-note-2', '', 'B.md', 1), deleted: true }]);
    expect(() => groups.checkDelete(anna.id, g.id, 'weg')).toThrow(GroupError);
    groups.checkDelete(anna.id, g.id, 'Weg');
    const cursor = notes.currentSeq();
    expect(notes.deleteGroup(anna.id, g.id).sort()).toEqual([anna.id, ben.id].sort());
    expect(notes.pull(ben.id, cursor)).toMatchObject({ revoked: ['del-note-1'], groups: [] });
    for (const table of ['notes', 'trash', 'note_versions', 'group_members']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
});

describe('groups API (#58)', () => {
  const ctx = setup();
  const { users, notes, files, anna, ben } = ctx;
  const annaCookie = `kladde_session=${users.createSession(anna.id)}`;
  const benCookie = `kladde_session=${users.createSession(ben.id)}`;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use('/api', (req, res, next) => (req.path === '/sync' || req.path === '/files' ? next() : express.json({ limit: '256kb' })(req, res, next)));
    app.use('/api', apiRouter(users, notes, files, new LiveUpdates(), { groups: ctx.groups }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  const call = (cookie: string, url: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${url}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  it('creates a group, manages members, moves notes in and deletes it with its attachments', async () => {
    const group = (await (await call(annaCookie, '/groups', 'POST', { name: 'Reise' })).json()) as GroupInfo;
    expect(group).toMatchObject({ name: 'Reise', role: 'owner' });
    expect((await call(annaCookie, `/groups/${group.id}/members`, 'PUT', { username: 'nobody', role: 'editor' })).status).toBe(400);
    expect((await call(annaCookie, `/groups/${group.id}/members`, 'PUT', { username: 'ben', role: 'boss' })).status).toBe(400);
    const details = (await (await call(annaCookie, `/groups/${group.id}/members`, 'PUT', { username: 'ben', role: 'editor' })).json()) as GroupDetails;
    expect(details.members.map((m) => [m.username, m.role])).toEqual([
      ['anna', 'owner'],
      ['ben', 'editor'],
    ]);
    expect((await call(benCookie, `/groups/${group.id}`, 'PATCH', { name: 'X' })).status).toBe(403);
    expect((await call(annaCookie, `/groups/${group.id}/members/anna`, 'DELETE')).status).toBe(409);

    const photo = files.save(anna.id, 'foto.png', 'image/png', Buffer.from([1, 2, 3]));
    const kept = files.save(anna.id, 'auch-privat.png', 'image/png', Buffer.from([4, 5]));
    notes.push(anna.id, [
      note('api-move-1', `![](/api/files/${photo.id}) ![](/api/files/${kept.id})`, 'Urlaub/Tag 1.md'),
      note('api-move-2', `![](/api/files/${kept.id})`, 'Privat.md'),
    ]);
    const moved = await call(annaCookie, `/groups/${group.id}/move`, 'POST', { noteIds: ['api-move-1'], folder: 'Urlaub', target: '' });
    expect(await moved.json()).toEqual({ moved: [{ id: 'api-move-1', path: 'Urlaub/Tag 1.md' }] });
    const info = (await (await call(benCookie, `/groups/${group.id}`)).json()) as GroupDetails;
    expect(info).toMatchObject({ notes: 1, attachments: 2, role: 'editor' });

    expect((await call(benCookie, `/groups/${group.id}`, 'DELETE', { confirm: 'Reise' })).status).toBe(403);
    expect((await call(annaCookie, `/groups/${group.id}`, 'DELETE', { confirm: 'reise' })).status).toBe(400);
    expect((await call(annaCookie, `/groups/${group.id}`, 'DELETE', { confirm: 'Reise' })).status).toBe(200);
    // the photo only the group used is gone; the one still used privately stays
    expect(files.exists(photo.id)).toBe(false);
    expect(files.exists(kept.id)).toBe(true);
    expect(await (await call(benCookie, '/groups')).json()).toEqual([]);
    expect((await call(benCookie, `/groups/${group.id}`)).status).toBe(404);
  });
});
