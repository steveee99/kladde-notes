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

  it('finds conceptual matches and related notes among the visible notes (#84)', () => {
    const { notes, spaces, anna, cleo } = setup();
    notes.push(anna.id, [
      note('note-sem-01', 'Inbox/Umzug.md', '# Umzug\nNeue Wohnung, Miete und Kartons packen'),
      note('note-sem-02', 'Inbox/Mietvertrag.md', '# Mietvertrag\nDie Wohnung ab März, Miete zahlen'),
      note('note-sem-03', 'Inbox/Rezept.md', '# Kuchen\nMehl, Zucker und Eier'),
    ]);
    notes.push(cleo.id, [note('note-sem-04', 'Inbox/Fremd.md', 'Wohnung und Miete von Cleo')]);
    const hits = spaces.semantic(anna.id, 'neue Wohnung mieten')!.map((h) => h.id);
    expect(hits).toEqual(expect.arrayContaining(['note-sem-01', 'note-sem-02']));
    expect(hits).not.toContain('note-sem-04');
    expect(hits).not.toContain('note-sem-03');
    const related = spaces.semantic(anna.id, '', { relatedTo: 'note-sem-01' })!.map((h) => h.id);
    expect(related[0]).toBe('note-sem-02');
    expect(related).not.toContain('note-sem-01');
    expect(spaces.semantic(anna.id, '', { relatedTo: 'note-sem-04' })).toBeNull();
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

  it('sends the tasks of visible notes, then only what changed', () => {
    const { notes, groups, spaces, anna, ben, cleo } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'editor');
    notes.push(anna.id, [
      note('note-own-01', 'Inbox/A.md', '---\ntitle: Alpha\n---\n- [ ] eins due:2026-11-20\n  * [x] zwei ✅ 2026-11-19'),
      note('note-own-02', 'Inbox/B.md', 'ohne Aufgaben'),
      note('note-grp-01', 'Plan.md', '- [/] nicht\n- [o] im Team', 0, { group: g.id }),
    ]);
    notes.push(cleo.id, [note('note-clo-01', 'Inbox/C.md', '- [ ] fremd')]);

    const first = spaces.tasks(anna.id, 0, '');
    expect(first.reset).toBe(true);
    const own = first.notes.find((n) => n.id === 'note-own-01');
    expect(own).toEqual({ id: 'note-own-01', title: 'Alpha', tasks: [[3, 'open', 'eins', '2026-11-20'], [4, 'done', 'zwei', null, null, null, '2026-11-19', '  * ']] });
    expect(first.notes.map((n) => n.id).sort()).toEqual(['note-grp-01', 'note-own-01']);
    expect(spaces.tasks(ben.id, 0, '').notes.map((n) => n.id)).toEqual(['note-grp-01']);

    // Nothing changed: nothing comes; a removed task comes as a note without tasks
    expect(spaces.tasks(anna.id, first.cursor, first.sig).notes).toEqual([]);
    notes.push(anna.id, [note('note-own-01', 'Inbox/A.md', 'alles erledigt', 1)]);
    const next = spaces.tasks(anna.id, first.cursor, first.sig);
    expect(next.reset).toBe(false);
    expect(next.notes).toEqual([{ id: 'note-own-01', tasks: [] }]);

    // A note shared with anna changes the visible spaces: everything again
    notes.share(cleo.id, 'note-clo-01', anna.id, false);
    const shared = spaces.tasks(anna.id, next.cursor, next.sig);
    expect(shared.reset).toBe(true);
    expect(shared.notes.map((n) => n.id).sort()).toEqual(['note-clo-01', 'note-grp-01']);
  });

  it('builds the graph of visible notes, with links into other spaces', () => {
    const { notes, groups, spaces, anna, ben, cleo } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'editor');
    notes.push(anna.id, [
      note('note-own-01', 'Inbox/Alpha.md', 'Siehe [[Beta]] und [[Plan]] #garten'),
      note('note-own-02', 'Inbox/Beta.md', 'zurück zu [[Alpha]]'),
      note('note-own-03', 'Inbox/Allein.md', 'kein Link'),
    ]);
    notes.push(anna.id, [note('note-grp-01', 'Plan.md', 'Teamplan', 0, { group: g.id })]);
    notes.push(cleo.id, [note('note-clo-01', 'Inbox/Fremd.md', '[[Plan]]')]);

    const graph = spaces.graph(anna.id);
    const ids = graph.nodes!.map((n) => n[0]);
    expect(ids.sort()).toEqual(['note-grp-01', 'note-own-01', 'note-own-02', 'note-own-03']);
    const alpha = graph.nodes!.find((n) => n[0] === 'note-own-01')!;
    expect(alpha).toEqual(['note-own-01', 'Alpha', 0, ['garten']]);
    const edges: string[] = [];
    for (let i = 0; i < graph.edges!.length; i += 2) edges.push(`${graph.nodes![graph.edges![i]][0]}>${graph.nodes![graph.edges![i + 1]][0]}`);
    expect(edges.sort()).toEqual(['note-own-01>note-grp-01', 'note-own-01>note-own-02', 'note-own-02>note-own-01']);
    // Ben sees only the group's note
    expect(spaces.graph(ben.id).nodes!.map((n) => n[0])).toEqual(['note-grp-01']);

    // Unchanged: only the stamp; a change sends the graph again
    expect(spaces.graph(anna.id, graph.stamp)).toEqual({ stamp: graph.stamp, same: true });
    notes.push(anna.id, [note('note-own-03', 'Inbox/Allein.md', 'jetzt mit [[Beta]]', 1)]);
    const next = spaces.graph(anna.id, graph.stamp);
    expect(next.same).toBeUndefined();
    expect(next.edges!.length).toBe(8);
  });

  it('runs query blocks over every visible note', () => {
    const { notes, groups, spaces, anna, ben } = setup();
    const g = groups.create(anna.id, 'Team');
    groups.setMember(anna.id, g.id, ben.id, 'reader');
    notes.push(anna.id, [
      note('note-own-01', 'Projekte/A.md', '---\nstatus: aktiv\n---\n- [ ] eins'),
      note('note-own-02', 'Projekte/B.md', '---\nstatus: fertig\n---\n'),
      note('note-own-03', 'Journal/2026-11-20.md', '- [ ] im Tagebuch'),
    ]);
    notes.push(anna.id, [note('note-grp-01', 'Projekte/C.md', '---\nstatus: aktiv\n---\n', 0, { group: g.id })]);

    const res = spaces.query(anna.id, 'TABLE status FROM "Projekte" WHERE status = "aktiv"', null);
    const result = res.result as { rows: { noteId: string }[] };
    expect(result.rows.map((r) => r.noteId).sort()).toEqual(['note-grp-01', 'note-own-01']);
    expect(spaces.query(ben.id, 'LIST FROM "Projekte"', null).result).toMatchObject({ rows: [{ noteId: 'note-grp-01' }] });
    expect(spaces.query(anna.id, 'TABLE status FROM "Projekte" WHERE status = "aktiv"', null, res.stamp)).toEqual({ stamp: res.stamp, same: true });

    // Daily notes give their tasks the note's day
    const tasks = spaces.query(anna.id, 'TASKS FROM "Journal"', { enabled: true, folder: 'Journal', format: 'YYYY-MM-DD' }).result as { rows: { values: { due: string } }[] };
    expect(tasks.rows[0].values.due).toBe('2026-11-20');
    expect(spaces.query(anna.id, 'LIMIT x', null).result).toHaveProperty('error');
  });
});
