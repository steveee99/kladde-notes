import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteStore, NoteChangeEvent } from '../src/NoteStore';

function setup() {
  const db = openDatabase(':memory:');
  const users = new UserStore(db);
  const events: NoteChangeEvent[] = [];
  const notes = new NoteStore(db, new DataCipher(crypto.randomBytes(32)), (e) => events.push(e));
  const anna = users.createUser('anna');
  const ben = users.createUser('ben');
  return { db, users, notes, anna, ben, events };
}

const change = (id: string, content: string, baseVersion = 0, path = 'Inbox/Test.md') => ({
  id,
  baseVersion,
  path,
  content,
  deleted: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('NoteStore', () => {
  it('stores notes encrypted and syncs them by cursor', () => {
    const { db, notes, anna } = setup();
    expect(notes.push(anna.id, [change('note-0001', 'geheimer Text')])).toEqual([{ id: 'note-0001', status: 'ok', version: 1 }]);
    const raw = db.prepare('SELECT payload FROM notes').get() as { payload: Uint8Array };
    expect(Buffer.from(raw.payload).toString('utf8')).not.toContain('geheim');
    const first = notes.pull(anna.id, 0);
    expect(first.notes.map((n) => n.content)).toEqual(['geheimer Text']);
    expect(notes.pull(anna.id, first.cursor).notes).toHaveLength(0);
  });

  it('reports conflicts on a stale base version', () => {
    const { notes, anna } = setup();
    notes.push(anna.id, [change('note-0001', 'v1')]);
    notes.push(anna.id, [change('note-0001', 'v2', 1)]);
    const [result] = notes.push(anna.id, [change('note-0001', 'v2b', 1)]);
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') expect(result.server.content).toBe('v2');
  });

  it('keeps spaces apart and honours shares', () => {
    const { notes, anna, ben } = setup();
    notes.push(anna.id, [change('note-0001', 'von Anna')]);
    expect(notes.pull(ben.id, 0).notes).toHaveLength(0);
    expect(notes.push(ben.id, [change('note-0001', 'Ben war hier', 1)])[0].status).toBe('forbidden');

    notes.share(anna.id, 'note-0001', ben.id, false);
    const shared = notes.pull(ben.id, 0);
    expect(shared.notes[0]).toMatchObject({ access: 'read', owner: 'anna' });
    expect(notes.push(ben.id, [change('note-0001', 'Ben war hier', 1)])[0].status).toBe('forbidden');

    notes.share(anna.id, 'note-0001', ben.id, true);
    expect(notes.push(ben.id, [change('note-0001', 'Ben war hier', 1, 'Ben/Umbenannt.md')])[0].status).toBe('ok');
    const annaView = notes.pull(anna.id, 0).notes[0];
    expect(annaView).toMatchObject({ content: 'Ben war hier', path: 'Inbox/Test.md' });

    const cursor = notes.pull(ben.id, 0).cursor;
    notes.unshare(anna.id, 'note-0001', ben.id);
    expect(notes.pull(ben.id, cursor).revoked).toEqual(['note-0001']);
  });

  it('public links are read-only and can be withdrawn', () => {
    const { notes, anna } = setup();
    notes.push(anna.id, [change('note-0001', 'öffentlich')]);
    const token = notes.setPublic(anna.id, 'note-0001', true)!;
    expect(notes.publicNote(token)).toMatchObject({ content: 'öffentlich', owner: 'anna' });
    notes.setPublic(anna.id, 'note-0001', false);
    expect(notes.publicNote(token)).toBeNull();
  });

  it('rejects path traversal', () => {
    const { notes, anna } = setup();
    notes.push(anna.id, [change('note-0001', 'x', 0, '../../etc/passwd')]);
    expect(notes.pull(anna.id, 0).notes[0].path).toBe('etc/passwd');
  });
});

describe('Folder shares', () => {
  const visible = (notes: NoteStore, userId: string) =>
    Object.fromEntries(notes.pull(userId, 0).notes.map((n) => [n.id, n.access]));

  it('shares existing and later notes in the folder and its subfolders', () => {
    const { db, notes, anna, ben, events } = setup();
    notes.push(anna.id, [
      change('rezept-01', 'Pasta', 0, 'Rezepte/Pasta.md'),
      change('rezept-02', 'Kuchen', 0, 'Rezepte/Backen/Kuchen.md'),
      change('privat-01', 'Tagebuch', 0, 'Privat/Tagebuch.md'),
      change('rezept-xx', 'Ähnlicher Name', 0, 'Rezepte alt/Suppe.md'),
    ]);
    expect(notes.shareFolder(anna.id, 'Rezepte', ben.id, {})).toEqual(expect.arrayContaining([anna.id, ben.id]));
    expect(visible(notes, ben.id)).toEqual({ 'rezept-01': 'read', 'rezept-02': 'read' });
    expect(notes.pull(ben.id, 0).notes[0].owner).toBe('anna');

    // The folder path is stored encrypted
    const raw = db.prepare('SELECT payload FROM folder_shares').get() as { payload: Uint8Array };
    expect(Buffer.from(raw.payload).toString('utf8')).not.toContain('Rezepte');

    const cursor = notes.pull(ben.id, 0).cursor;
    events.length = 0;
    notes.push(anna.id, [change('rezept-03', 'Neu', 0, 'Rezepte/Neu.md')]);
    expect(events[0].audience).toEqual([anna.id, ben.id]);
    expect(notes.pull(ben.id, cursor).notes.map((n) => n.id)).toEqual(['rezept-03']);

    notes.shareFolder(anna.id, 'Rezepte', ben.id, { canWrite: true });
    expect(visible(notes, ben.id)['rezept-01']).toBe('write');
    expect(notes.push(ben.id, [change('rezept-01', 'Pasta von Ben', 1, 'Ben/Pasta.md')])[0].status).toBe('ok');
    expect(notes.pull(anna.id, 0).notes.find((n) => n.id === 'rezept-01')).toMatchObject({ path: 'Rezepte/Pasta.md', content: 'Pasta von Ben' });
    expect(notes.folderShares(anna.id, 'Rezepte').users).toEqual([{ username: 'ben', canWrite: true, canCreate: false, canDelete: false }]);
    expect(notes.folderShares(anna.id, 'Rezepte/Backen').inherited).toEqual([{ username: 'ben', canWrite: true, canCreate: false, canDelete: false, viaFolder: 'Rezepte' }]);
    expect(notes.shares(anna.id, 'rezept-01').users).toEqual([{ username: 'ben', canWrite: true, viaFolder: 'Rezepte' }]);
  });

  it('moving a note out of the folder or unsharing the folder revokes access', () => {
    const { notes, anna, ben } = setup();
    notes.push(anna.id, [change('rezept-01', 'Pasta', 0, 'Rezepte/Pasta.md'), change('rezept-02', 'Kuchen', 0, 'Rezepte/Kuchen.md')]);
    notes.shareFolder(anna.id, 'Rezepte', ben.id, {});
    let cursor = notes.pull(ben.id, 0).cursor;
    notes.push(anna.id, [change('rezept-01', 'Pasta', 1, 'Privat/Pasta.md')]);
    expect(notes.pull(ben.id, cursor).revoked).toEqual(['rezept-01']);

    // A direct share outlives the folder share
    notes.share(anna.id, 'rezept-02', ben.id, false);
    notes.push(anna.id, [change('rezept-03', 'Suppe', 0, 'Rezepte/Suppe.md')]);
    cursor = notes.pull(ben.id, 0).cursor;
    notes.unshareFolder(anna.id, 'Rezepte', ben.id);
    expect(notes.pull(ben.id, cursor).revoked).toEqual(['rezept-03']);
    expect(visible(notes, ben.id)).toEqual({ 'rezept-02': 'read' });
    expect(notes.folderShares(anna.id, 'Rezepte').users).toEqual([]);
  });

  it('removing a direct share keeps access through the folder', () => {
    const { notes, anna, ben } = setup();
    notes.push(anna.id, [change('rezept-01', 'Pasta', 0, 'Rezepte/Pasta.md')]);
    notes.share(anna.id, 'rezept-01', ben.id, true);
    notes.shareFolder(anna.id, 'Rezepte', ben.id, {});
    expect(notes.shares(anna.id, 'rezept-01').users).toEqual([{ username: 'ben', canWrite: true }]);
    notes.unshare(anna.id, 'rezept-01', ben.id);
    expect(visible(notes, ben.id)).toEqual({ 'rezept-01': 'read' });
    // A share through the folder is not removed on the note
    notes.unshare(anna.id, 'rezept-01', ben.id);
    expect(visible(notes, ben.id)).toEqual({ 'rezept-01': 'read' });
  });

  it('shares follow a renamed folder and are dropped with a deleted one', () => {
    const { notes, anna, ben } = setup();
    notes.push(anna.id, [change('rezept-01', 'Pasta', 0, 'Rezepte/Pasta.md')]);
    notes.shareFolder(anna.id, 'Rezepte', ben.id, {});
    notes.push(anna.id, [change('rezept-01', 'Pasta', 1, 'Kochen/Pasta.md')]);
    notes.renameFolderShares(anna.id, 'Rezepte', 'Kochen');
    expect(visible(notes, ben.id)).toEqual({ 'rezept-01': 'read' });
    expect(notes.folderShares(anna.id, 'Kochen').users).toEqual([{ username: 'ben', canWrite: false, canCreate: false, canDelete: false }]);

    notes.dropFolderShares(anna.id, 'Kochen');
    expect(visible(notes, ben.id)).toEqual({});
    expect(notes.folderShares(anna.id, 'Kochen').users).toEqual([]);
  });

  it('lets the recipient create notes in the owner\'s space when allowed', () => {
    const { db, notes, anna, ben, events } = setup();
    notes.push(anna.id, [change('rezept-01', 'Pasta', 0, 'Rezepte/Pasta.md')]);
    notes.shareFolder(anna.id, 'Rezepte', ben.id, { canWrite: true });
    expect(notes.pull(ben.id, 0).sharedFolders).toEqual([{ owner: 'anna', folder: 'Rezepte', canWrite: true, canCreate: false, canDelete: false }]);

    // Without the create permission, outside the folder or for an unknown owner it is refused
    const own = (id: string, path: string, owner: string) => ({ ...change(id, 'Von Ben', 0, path), owner });
    expect(notes.push(ben.id, [own('rezept-ben', 'Rezepte/Curry.md', 'anna')])[0].status).toBe('forbidden');
    notes.shareFolder(anna.id, 'Rezepte', ben.id, { canCreate: true });
    expect(notes.pull(ben.id, 0).sharedFolders?.[0]).toMatchObject({ canWrite: true, canCreate: true });
    expect(notes.push(ben.id, [own('privat-ben', 'Privat/Curry.md', 'anna')])[0].status).toBe('forbidden');
    expect(notes.push(ben.id, [own('rezept-ben', 'Rezepte/Curry.md', 'niemand')])[0].status).toBe('forbidden');

    events.length = 0;
    expect(notes.push(ben.id, [own('rezept-ben', 'Rezepte/Backen/Curry.md', 'anna')])[0]).toEqual({ id: 'rezept-ben', status: 'ok', version: 1 });
    expect((db.prepare('SELECT owner_id FROM notes WHERE id = ?').get('rezept-ben') as { owner_id: string }).owner_id).toBe(anna.id);
    expect(events[0]).toMatchObject({ ownerId: anna.id, path: 'Rezepte/Backen/Curry.md' });
    expect(events[0].audience).toEqual(expect.arrayContaining([anna.id, ben.id]));
    expect(notes.pull(anna.id, 0).notes.find((n) => n.id === 'rezept-ben')).toMatchObject({ access: 'owner', content: 'Von Ben' });
    expect(notes.pull(ben.id, 0).notes.find((n) => n.id === 'rezept-ben')).toMatchObject({ access: 'write', owner: 'anna' });

    // Ben edits it like any shared note; after the share ends he sees nothing of it any more
    expect(notes.push(ben.id, [change('rezept-ben', 'Curry, scharf', 1, 'Rezepte/Backen/Curry.md')])[0].status).toBe('ok');
    notes.unshareFolder(anna.id, 'Rezepte', ben.id);
    expect(visible(notes, ben.id)).toEqual({});
    expect(notes.pull(ben.id, 0).sharedFolders).toEqual([]);
    expect(notes.pull(anna.id, 0).notes.find((n) => n.id === 'rezept-ben')?.content).toBe('Curry, scharf');
  });

  it('lets the recipient delete notes only with the delete permission', () => {
    const { notes, anna, ben } = setup();
    notes.push(anna.id, [change('rezept-01', 'Pasta', 0, 'Rezepte/Pasta.md'), change('rezept-02', 'Kuchen', 0, 'Rezepte/Kuchen.md')]);
    notes.shareFolder(anna.id, 'Rezepte', ben.id, { canWrite: true });
    expect(notes.pull(ben.id, 0).notes.every((n) => !n.canDelete)).toBe(true);
    const del = (id: string) => ({ ...change(id, '', 1, 'Rezepte/x.md'), deleted: true });
    expect(notes.push(ben.id, [del('rezept-01')])[0].status).toBe('forbidden');
    expect(notes.pull(anna.id, 0).notes.find((n) => n.id === 'rezept-01')).toMatchObject({ deleted: false, content: 'Pasta' });

    // Delete implies edit; a changed permission reaches the recipient with the next pull
    const cursor = notes.pull(ben.id, 0).cursor;
    notes.shareFolder(anna.id, 'Rezepte', ben.id, { canDelete: true });
    expect(notes.folderShares(anna.id, 'Rezepte').users[0]).toMatchObject({ canWrite: true, canDelete: true });
    expect(notes.pull(ben.id, cursor).notes.map((n) => [n.id, n.canDelete])).toEqual(
      expect.arrayContaining([
        ['rezept-01', true],
        ['rezept-02', true],
      ])
    );
    expect(notes.push(ben.id, [del('rezept-02')])[0].status).toBe('ok');
    expect(notes.pull(anna.id, 0).notes.find((n) => n.id === 'rezept-02')?.deleted).toBe(true);
    expect(visible(notes, ben.id)).toEqual({ 'rezept-01': 'write' });
  });

  it('cannot share a folder with oneself', () => {
    const { notes, anna } = setup();
    expect(() => notes.shareFolder(anna.id, 'Rezepte', anna.id, {})).toThrow();
  });
});

describe('UserStore', () => {
  it('invites work once', () => {
    const { users } = setup();
    const invite = users.createInvite('Test');
    const code = users.checkInvite(invite.code.toLowerCase());
    users.useInvite(code, users.createUser('carla').id);
    expect(() => users.checkInvite(invite.code)).toThrow();
  });

  it('device links expire and sessions resolve users', () => {
    const { users, anna } = setup();
    const link = users.createDeviceLink(anna.id, 0);
    expect(() => users.userForDeviceLink(link.code, 16 * 60 * 1000)).toThrow();
    const token = users.createSession(anna.id);
    expect(users.userForSession(token)?.username).toBe('anna');
    users.setBanned(anna.id, true);
    expect(users.userForSession(token)).toBeNull();
  });
});

describe('note history', () => {
  it('keeps encrypted versions, merges quick saves and drops them on delete', () => {
    const { db, notes, anna, ben } = setup();
    notes.push(anna.id, [change('note-hist1', 'eins')]);
    notes.push(anna.id, [change('note-hist1', 'zwei', 1)]);
    expect(notes.versions(anna.id, 'note-hist1')).toHaveLength(1);
    expect(notes.version(anna.id, 'note-hist1', notes.versions(anna.id, 'note-hist1')[0].id).content).toBe('zwei');
    // a pause starts a new version
    db.prepare('UPDATE note_versions SET created_at = created_at - 3600000, saved_at = saved_at - 3600000').run();
    notes.push(anna.id, [change('note-hist1', 'drei', 2)]);
    expect(notes.versions(anna.id, 'note-hist1').map((v) => v.size)).toEqual([4, 4]);
    const raw = db.prepare('SELECT payload FROM note_versions').get() as { payload: Uint8Array };
    expect(Buffer.from(raw.payload).toString('utf8')).not.toContain('zwei');
    expect(() => notes.versions(ben.id, 'note-hist1')).toThrow();
    notes.push(anna.id, [{ ...change('note-hist1', '', 3), deleted: true }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM note_versions').get()).toEqual({ n: 0 });
  });
});
