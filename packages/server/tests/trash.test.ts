import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { FileStore } from '../src/FileStore';
import { UserStore } from '../src/UserStore';
import { NoteStore, NoteChangeEvent, TrashPathTaken } from '../src/NoteStore';
import { dropUnusedAttachments, purgeExpiredTrash, trashRetentionDays } from '../src/trash';

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup() {
  const db = openDatabase(':memory:');
  const cipher = new DataCipher(crypto.randomBytes(32));
  const users = new UserStore(db);
  const events: NoteChangeEvent[] = [];
  const notes = new NoteStore(db, cipher, (e) => events.push(e));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-trash-test-'));
  tmpDirs.push(dir);
  const files = new FileStore(db, cipher, dir);
  const anna = users.createUser('anna');
  const ben = users.createUser('ben');
  return { db, notes, files, anna, ben, events };
}

const note = (id: string, content: string, path = 'Inbox/Test.md', baseVersion = 0) => ({
  id,
  baseVersion,
  path,
  content,
  deleted: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
const del = (id: string, path: string, baseVersion: number, extra: object = {}) => ({ ...note(id, '', path, baseVersion), deleted: true, ...extra });

describe('trash', () => {
  it('keeps a deleted note encrypted and restores it with a new seq', () => {
    const { db, notes, anna, events } = setup();
    notes.push(anna.id, [note('note-trash1', 'geheimer Text', 'Projekte/Plan.md')]);
    notes.push(anna.id, [del('note-trash1', 'Projekte/Plan.md', 1)]);
    expect(notes.pull(anna.id, 0).notes.find((n) => n.id === 'note-trash1')?.deleted).toBe(true);
    const [entry] = notes.trash(anna.id);
    expect(entry).toMatchObject({ id: 'note-trash1', path: 'Projekte/Plan.md', deletedBy: null, batch: null, size: 13 });
    const raw = db.prepare('SELECT payload FROM trash').get() as { payload: Uint8Array };
    expect(Buffer.from(raw.payload).toString('utf8')).not.toContain('geheimer');

    const cursor = notes.currentSeq();
    expect(notes.restore(anna.id, ['note-trash1'])).toEqual([{ id: 'note-trash1', path: 'Projekte/Plan.md' }]);
    const back = notes.pull(anna.id, cursor).notes;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: 'note-trash1', deleted: false, content: 'geheimer Text', version: 3 });
    expect(notes.trash(anna.id)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ noteId: 'note-trash1', deleted: false, content: 'geheimer Text' });
    // the history survived the stay in the trash
    expect(notes.versions(anna.id, 'note-trash1').length).toBeGreaterThan(0);
  });

  it('asks for a new path when the old one is taken, or picks a free one for a folder', () => {
    const { notes, anna } = setup();
    notes.push(anna.id, [note('note-trash2', 'alt', 'A/X.md')]);
    notes.push(anna.id, [del('note-trash2', 'A/X.md', 1)]);
    notes.push(anna.id, [note('note-trash3', 'neu', 'A/X.md')]);
    let suggestion = '';
    try {
      notes.restore(anna.id, ['note-trash2']);
    } catch (err) {
      expect(err).toBeInstanceOf(TrashPathTaken);
      suggestion = (err as TrashPathTaken).suggestion;
    }
    expect(suggestion).toBe('A/X 2.md');
    expect(notes.restore(anna.id, ['note-trash2'], { path: 'B/X.md' })).toEqual([{ id: 'note-trash2', path: 'B/X.md' }]);
  });

  it('restores a deleted folder as one unit', () => {
    const { notes, anna } = setup();
    notes.push(anna.id, [note('note-fold1', 'eins', 'F/a.md'), note('note-fold2', 'zwei', 'F/Sub/b.md'), note('note-fold3', 'drei', 'G/c.md')]);
    notes.push(anna.id, [
      del('note-fold1', 'F/a.md', 1, { trashBatch: 'batch-12345678', trashFolder: 'F' }),
      del('note-fold2', 'F/Sub/b.md', 1, { trashBatch: 'batch-12345678', trashFolder: 'F' }),
      del('note-fold3', 'G/c.md', 1),
    ]);
    expect(notes.trash(anna.id).filter((e) => e.batch === 'batch-12345678').map((e) => e.folder)).toEqual(['F', 'F']);
    notes.push(anna.id, [note('note-fold4', 'neu', 'F/a.md')]);
    const restored = notes.restore(anna.id, notes.trashBatch(anna.id, 'batch-12345678'), { rename: true });
    expect(restored.map((r) => r.path).sort()).toEqual(['F/Sub/b.md', 'F/a 2.md']);
    expect(notes.trash(anna.id).map((e) => e.id)).toEqual(['note-fold3']);
  });

  it('belongs to the owner: a recipient who deleted shows up, but cannot restore or purge', () => {
    const { notes, anna, ben } = setup();
    notes.shareFolder(anna.id, 'Team', ben.id, { canDelete: true });
    notes.push(anna.id, [note('note-team1', 'gemeinsam', 'Team/Plan.md')]);
    notes.push(ben.id, [del('note-team1', 'Team/Plan.md', 1)]);
    expect(notes.trash(ben.id)).toEqual([]);
    expect(notes.trash(anna.id)[0]).toMatchObject({ id: 'note-team1', deletedBy: 'ben' });
    expect(() => notes.restore(ben.id, ['note-team1'])).toThrow();
    expect(notes.purge(ben.id, ['note-team1'])).toEqual([]);
    expect(notes.trash(anna.id)).toHaveLength(1);
  });

  it('purges for good with the history, and drops attachments nothing else uses', () => {
    const { db, notes, files, anna } = setup();
    const used = files.save(anna.id, 'a.png', 'image/png', Buffer.from('a'));
    const only = files.save(anna.id, 'b.png', 'image/png', Buffer.from('b'));
    notes.push(anna.id, [note('note-purge1', `![](/api/files/${used.id}) ![](/api/files/${only.id})`, 'P/x.md'), note('note-purge2', `![](/api/files/${used.id})`, 'P/y.md')]);
    notes.push(anna.id, [del('note-purge1', 'P/x.md', 1)]);
    const contents = notes.purge(anna.id, ['note-purge1']);
    expect(dropUnusedAttachments(notes, files, anna.id, contents)).toEqual([only.id]);
    expect(files.getMeta(anna.id, used.id)).not.toBeNull();
    expect(notes.trash(anna.id)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = 'note-purge1'").get()).toEqual({ n: 0 });
    expect(() => notes.restore(anna.id, ['note-purge1'])).toThrow();
  });

  it('purges notes older than the retention period automatically', () => {
    const { db, notes, files, anna } = setup();
    notes.push(anna.id, [note('note-old1', 'alt', 'O/a.md'), note('note-old2', 'neu', 'O/b.md')]);
    notes.push(anna.id, [del('note-old1', 'O/a.md', 1), del('note-old2', 'O/b.md', 1)]);
    db.prepare("UPDATE trash SET deleted_at = deleted_at - 31 * 86400000 WHERE note_id = 'note-old1'").run();
    expect(purgeExpiredTrash(notes, files, 30)).toBe(1);
    expect(notes.trash(anna.id).map((e) => e.id)).toEqual(['note-old2']);
    expect(purgeExpiredTrash(notes, files, 0)).toBe(0);
  });

  it('reads the retention period from the environment', () => {
    expect(trashRetentionDays({})).toBe(30);
    expect(trashRetentionDays({ TRASH_RETENTION_DAYS: '7' })).toBe(7);
    expect(trashRetentionDays({ TRASH_RETENTION_DAYS: '0' })).toBe(0);
    expect(trashRetentionDays({ TRASH_RETENTION_DAYS: 'abc' })).toBe(30);
  });
});
