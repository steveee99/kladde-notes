import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { GroupStore } from '../src/GroupStore';
import { NoteStore } from '../src/NoteStore';
import { SpaceIndexes } from '../src/online/SpaceIndex';

// Online mode: the server's indexes per space answer search and backlinks for devices that hold only a catalog

function setup() {
  const db = openDatabase(':memory:');
  const users = new UserStore(db);
  const notes = new NoteStore(db, new DataCipher(crypto.randomBytes(32)), () => {});
  const groups = new GroupStore(db);
  return { notes, groups, spaces: new SpaceIndexes(notes), anna: users.createUser('anna'), ben: users.createUser('ben'), cleo: users.createUser('cleo') };
}

const note = (id: string, path: string, content: string, baseVersion = 0, extra: { group?: string; deleted?: boolean } = {}) => ({
  id,
  baseVersion,
  path,
  content,
  deleted: !!extra.deleted,
  createdAt: 1,
  updatedAt: Date.now(),
  ...(extra.group ? { group: extra.group } : {}),
});

describe('SpaceIndexes', () => {
  it('searches every note the user may see and nothing else', () => {
    const { notes, groups, spaces, anna, ben, cleo } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'reader');
    notes.push(anna.id, [note('note-own-01', 'Inbox/Garten.md', 'Budget für den Garten'), note('note-grp-01', 'Plan.md', 'Garten im Team, Budget offen', 0, { group: g.id })]);
    notes.push(cleo.id, [note('note-clo-01', 'Inbox/Fremd.md', 'Garten Budget von Cleo'), note('note-clo-02', 'Inbox/Geteilt.md', 'Geteilter Garten Budget')]);
    notes.share(cleo.id, 'note-clo-02', ben.id, false);
    expect(spaces.search(anna.id, 'garten budget').map((h) => h.id)).toEqual(expect.arrayContaining(['note-own-01', 'note-grp-01']));
    expect(spaces.search(anna.id, 'garten budget')).toHaveLength(2);
    // Ben: the group and the one note Cleo shares, not Cleo's other notes
    expect(spaces.search(ben.id, 'garten budget').map((h) => h.id).sort()).toEqual(['note-clo-02', 'note-grp-01']);
    expect(spaces.search(anna.id, 'garten')[0].snippet).toContain('Garten');
  });

  it('follows edits, deletions and notes moved to a group', () => {
    const { notes, groups, spaces, anna } = setup();
    notes.push(anna.id, [note('note-own-01', 'Inbox/A.md', 'alter Text')]);
    expect(spaces.search(anna.id, 'alter')).toHaveLength(1);
    notes.push(anna.id, [note('note-own-01', 'Inbox/A.md', 'neuer Text', 1)]);
    expect(spaces.search(anna.id, 'alter')).toHaveLength(0);
    expect(spaces.search(anna.id, 'neuer')).toHaveLength(1);
    const g = groups.create(anna.id, 'Team');
    notes.moveToGroup(anna.id, g.id, { noteIds: ['note-own-01'], target: '' });
    expect(spaces.search(anna.id, 'neuer').map((h) => h.id)).toEqual(['note-own-01']);
    expect(notes.push(anna.id, [note('note-own-01', 'A.md', '', 3, { deleted: true })])[0].status).toBe('ok');
    expect(spaces.search(anna.id, 'neuer')).toHaveLength(0);
  });

  it('finds backlinks and unlinked mentions, also from another space by name', () => {
    const { notes, groups, spaces, anna, ben } = setup();
    const g = groups.create(anna.id, 'Team');
    notes.push(anna.id, [
      note('note-tgt-01', 'Projekte/Sync.md', 'Ziel'),
      note('note-lnk-01', 'Inbox/A.md', 'Siehe [[Sync]].'),
      note('note-men-01', 'Inbox/B.md', 'Der Sync ist langsam.'),
      note('note-grp-01', 'Doku.md', 'Aus dem Team: [[Sync]]', 0, { group: g.id }),
    ]);
    const r = spaces.backlinks(anna.id, 'note-tgt-01');
    expect(r?.backlinks.sort()).toEqual(['note-grp-01', 'note-lnk-01']);
    expect(r?.mentions).toEqual(['note-men-01']);
    expect(spaces.backlinks(ben.id, 'note-tgt-01')).toBeNull();
  });
});
