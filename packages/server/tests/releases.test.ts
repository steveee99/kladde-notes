import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { contentHash, type NoteRelease, type NoteReleaseInfo, type PublicNote, type SyncedNote } from '@kladde/shared';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteChangeEvent, NoteStore, ReleaseConflict, VersioningOff } from '../src/NoteStore';
import { createKladdeApp } from '../src/app';

function setup() {
  const db = openDatabase(':memory:');
  const users = new UserStore(db);
  const events: NoteChangeEvent[] = [];
  const notes = new NoteStore(db, new DataCipher(crypto.randomBytes(32)), (e) => events.push(e));
  const anna = users.createUser('anna');
  const ben = users.createUser('ben');
  const cara = users.createUser('cara');
  return { db, users, notes, anna, ben, cara, events };
}

const change = (id: string, content: string, baseVersion = 0, path = 'Specs/Spec.md') => ({
  id,
  baseVersion,
  path,
  content,
  deleted: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const ID = 'spec-0001';
const pulled = (notes: NoteStore, userId: string) => notes.pull(userId, 0).notes.find((n) => n.id === ID)!;

describe('release versioning (#53)', () => {
  it('is off by default and only the owner turns it on', () => {
    const { notes, anna, ben } = setup();
    notes.push(anna.id, [change(ID, '# Spec\nv1')]);
    expect(pulled(notes, anna.id).versioning).toBeUndefined();
    notes.share(anna.id, ID, ben.id, true);
    expect(() => notes.setVersioning(ben.id, ID, true)).toThrow('not found');
    const on = notes.setVersioning(anna.id, ID, true);
    expect(on).toMatchObject({ versioning: true, releases: [] });
    expect(pulled(notes, anna.id).versioning).toBe(true);
  });

  it('releases SemVer versions with date, author and note, stored encrypted', () => {
    const { db, notes, anna } = setup();
    notes.push(anna.id, [change(ID, 'geheime Spezifikation')]);
    expect(() => notes.release(anna.id, ID, { bump: 'major', baseVersion: 1 })).toThrow(VersioningOff);
    notes.setVersioning(anna.id, ID, true);
    const first = notes.release(anna.id, ID, { bump: 'major', note: ' Erste\nFreigabe ', baseVersion: 1 });
    expect(first).toMatchObject({ version: '1.0.0', releasedBy: 'anna', note: 'Erste Freigabe' });
    notes.push(anna.id, [change(ID, 'geheime Spezifikation, Entwurf', 1)]);
    expect(notes.release(anna.id, ID, { bump: 'minor', baseVersion: 2 }).version).toBe('1.1.0');
    expect(notes.release(anna.id, ID, { bump: 'patch', baseVersion: 2 }).version).toBe('1.1.1');
    expect(notes.releases(anna.id, ID).map((r) => r.version)).toEqual(['1.1.1', '1.1.0', '1.0.0']);
    expect(notes.releaseOf(anna.id, ID, '1.0.0')).toMatchObject({ content: 'geheime Spezifikation', path: 'Specs/Spec.md' });
    for (const row of db.prepare('SELECT payload FROM note_releases').all() as { payload: Uint8Array }[]) {
      expect(Buffer.from(row.payload).toString('utf8')).not.toContain('geheim');
      expect(Buffer.from(row.payload).toString('utf8')).not.toContain('Freigabe');
    }
  });

  it('never releases a text the author has not seen', () => {
    const { notes, anna } = setup();
    notes.push(anna.id, [change(ID, 'a')]);
    notes.setVersioning(anna.id, ID, true);
    notes.push(anna.id, [change(ID, 'b', 1)]);
    expect(() => notes.release(anna.id, ID, { bump: 'major', baseVersion: 1 })).toThrow(ReleaseConflict);
  });

  it('keeps released versions immutable, also in the database', () => {
    const { db, notes, anna, ben } = setup();
    notes.push(anna.id, [change(ID, 'v1')]);
    notes.setVersioning(anna.id, ID, true);
    notes.share(anna.id, ID, ben.id, true);
    notes.release(anna.id, ID, { bump: 'major', baseVersion: 1 });
    expect(() => notes.release(ben.id, ID, { bump: 'major', baseVersion: 1 })).toThrow('not found');
    expect(() => db.prepare('UPDATE note_releases SET released_at = 0').run()).toThrow(/immutable/);
    // Editing the note only changes the draft
    notes.push(ben.id, [change(ID, 'v2 draft', 1)]);
    expect(notes.releaseOf(anna.id, ID, '1.0.0').content).toBe('v1');
  });

  it('shows the latest release to readers and public links, the draft to owner and editors', () => {
    const { notes, anna, ben, cara } = setup();
    notes.push(anna.id, [change(ID, 'Version {{version}}: released')]);
    notes.share(anna.id, ID, ben.id, false);
    notes.share(anna.id, ID, cara.id, true);
    notes.setVersioning(anna.id, ID, true);
    // Nothing released yet: readers see the draft
    expect(pulled(notes, ben.id).content).toBe('Version {{version}}: released');
    notes.release(anna.id, ID, { bump: 'major', baseVersion: 1 });
    notes.push(anna.id, [change(ID, 'Version {{version}}: draft', 1)]);

    const reader = pulled(notes, ben.id);
    expect(reader).toMatchObject({ access: 'read', content: 'Version {{version}}: released', showsRelease: '1.0.0' });
    expect(pulled(notes, cara.id)).toMatchObject({ access: 'write', content: 'Version {{version}}: draft' });
    const owner = pulled(notes, anna.id);
    expect(owner.content).toBe('Version {{version}}: draft');
    expect(owner.releaseHash).toBe(contentHash('Version {{version}}: released'));
    expect(owner.showsRelease).toBeUndefined();

    const token = notes.setPublic(anna.id, ID, true)!;
    expect(notes.publicNote(token)).toMatchObject({ content: 'Version {{version}}: released', versioning: true, showsRelease: '1.0.0' });

    // Turning versioning off shows the draft again and keeps the releases
    notes.setVersioning(anna.id, ID, false);
    expect(pulled(notes, ben.id).content).toBe('Version {{version}}: draft');
    notes.setVersioning(anna.id, ID, true);
    expect(notes.releases(anna.id, ID).map((r) => r.version)).toEqual(['1.0.0']);
  });

  it('lets every device pull the new release state and hands exports the filled release', () => {
    const { notes, anna, ben, events } = setup();
    notes.push(anna.id, [change(ID, '# Spec\nVersion {{version}}\n\n```versions\n```')]);
    notes.share(anna.id, ID, ben.id, false);
    notes.setVersioning(anna.id, ID, true);
    const cursor = notes.pull(ben.id, 0).cursor;
    events.length = 0;
    notes.release(anna.id, ID, { bump: 'major', note: 'Freigabe', baseVersion: 1 });
    expect(notes.pull(ben.id, cursor).notes.map((n) => n.showsRelease)).toEqual(['1.0.0']);
    expect(events).toHaveLength(1);
    expect(events[0].audience).toEqual(expect.arrayContaining([anna.id, ben.id]));
    expect(events[0].content).toContain('Version 1.0.0');
    expect(events[0].content).toContain('| 1.0.0 |');
    expect(events[0].content).toContain('Freigabe');

    // A later draft edit still exports the release, not the draft
    events.length = 0;
    notes.push(anna.id, [change(ID, '# Spec\nunreleased draft', 1)]);
    expect(events[0].content).toContain('Version 1.0.0');
    expect(events[0].content).not.toContain('unreleased draft');
    expect(notes.allOf(anna.id)[0].content).toContain('Version 1.0.0');
    expect(notes.publishedNotes(anna.id)[0].content).not.toContain('unreleased');
    // Notes without versioning are exported as they are
    notes.push(anna.id, [change('plain-0001', 'Version {{version}}', 0, 'Plain.md')]);
    expect(notes.allOf(anna.id).find((n) => n.path === 'Plain.md')!.content).toBe('Version {{version}}');
  });

  it('forgets releases when the note is purged from the trash', () => {
    const { db, notes, anna } = setup();
    notes.push(anna.id, [change(ID, 'x')]);
    notes.setVersioning(anna.id, ID, true);
    notes.release(anna.id, ID, { bump: 'major', baseVersion: 1 });
    notes.push(anna.id, [{ ...change(ID, 'x', 1), deleted: true }]);
    notes.purge(anna.id, [ID]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM note_releases').get() as { n: number }).n).toBe(0);
  });
});

// ------------------------------------------------------------------ HTTP

const db = openDatabase(':memory:');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-releases-'));
const exportDir = path.join(dataDir, 'export');
let ctx: ReturnType<typeof createKladdeApp>;
let server: Server;
let base = '';
let anna = '';
let ben = '';

beforeAll(async () => {
  ctx = createKladdeApp({
    db,
    dataDir,
    env: { DATA_KEY: crypto.randomBytes(32).toString('base64'), EXPORT_DIR: exportDir },
    standalone: false,
    isProduction: false,
    publicUrl: null,
    trustProxy: false,
  });
  const a = ctx.users.createUser('anna');
  const b = ctx.users.createUser('ben');
  anna = `kladde_session=${ctx.users.createSession(a.id)}`;
  ben = `kladde_session=${ctx.users.createSession(b.id)}`;
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = (cookie: string, url: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${url}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe('release API', () => {
  it('turns versioning on, releases, lists and reads releases; the export mirror gets the release', async () => {
    const push = await call(anna, '/sync', 'POST', { changes: [change(ID, 'Stand {{version}}')] });
    expect(push.status).toBe(200);
    expect((await call(ben, `/notes/${ID}/versioning`, 'PUT', { enabled: true })).status).toBe(404);
    const on = (await (await call(anna, `/notes/${ID}/versioning`, 'PUT', { enabled: true })).json()) as SyncedNote;
    expect(on.versioning).toBe(true);

    expect((await call(anna, `/notes/${ID}/releases`, 'POST', { bump: 'huge', baseVersion: 1 })).status).toBe(400);
    expect((await call(anna, `/notes/${ID}/releases`, 'POST', { bump: 'major', baseVersion: 7 })).status).toBe(409);
    const res = await call(anna, `/notes/${ID}/releases`, 'POST', { bump: 'major', note: 'Go', baseVersion: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { release: NoteReleaseInfo; releases: NoteReleaseInfo[] };
    expect(body.release).toMatchObject({ version: '1.0.0', releasedBy: 'anna', note: 'Go' });
    expect(body.releases).toHaveLength(1);

    const one = (await (await call(anna, `/notes/${ID}/releases/1.0.0`)).json()) as NoteRelease;
    expect(one.content).toBe('Stand {{version}}');
    expect((await call(anna, `/notes/${ID}/releases/9.9.9`)).status).toBe(404);
    expect((await call(ben, `/notes/${ID}/releases`)).status).toBe(404);
    expect(fs.readFileSync(path.join(exportDir, 'anna', 'Specs/Spec.md'), 'utf8')).toBe('Stand 1.0.0');

    const token = ctx.notes.setPublic(ctx.users.findByUsername('anna')!.id, ID, true)!;
    const pub = (await (await fetch(`${base}/api/public/${token}`)).json()) as PublicNote;
    expect(pub).toMatchObject({ content: 'Stand {{version}}', versioning: true, showsRelease: '1.0.0' });
    expect(pub.releases?.map((r) => r.version)).toEqual(['1.0.0']);
  });
});
