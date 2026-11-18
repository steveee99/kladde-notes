import { describe, expect, it } from 'vitest';
import {
  applyView,
  boardLanes,
  databaseFileName,
  databaseRows,
  findDatabaseNote,
  inferPropertyKeys,
  isDatabasePath,
  newDatabaseContent,
  newDatabaseNoteContent,
  parseDatabase,
  setCell,
  writeDatabase,
  type Database,
} from '../src/index.js';

const db: Database = {
  properties: [
    { name: 'Status', type: 'select', options: ['todo', 'doing', 'done'], default: 'todo' },
    { name: 'Pages', type: 'number', options: [], default: '' },
    { name: 'Read', type: 'checkbox', options: [], default: '' },
    { name: 'Genres', type: 'multiselect', options: ['sf', 'crime'], default: '' },
    { name: 'Due', type: 'date', options: [], default: '' },
    { name: 'Author', type: 'link', options: [], default: '' },
  ],
  subfolders: false,
  views: [
    { name: 'Open', type: 'table', columns: ['Status', 'Pages'], group: '', filter: [{ property: 'Status', op: 'ne', value: 'done' }], sort: 'Pages', desc: true },
    { name: 'Board', type: 'board', columns: [], group: 'Status', filter: [], sort: '', desc: false },
  ],
};

describe('database schema', () => {
  it('round-trips through the note frontmatter', () => {
    expect(parseDatabase(writeDatabase('', db))).toEqual(db);
  });

  it('keeps the body and other keys when writing', () => {
    const out = writeDatabase('---\nicon: book\n---\nNotes here\n', db);
    expect(out).toContain('icon: book');
    expect(out).toContain('Notes here');
    expect(parseDatabase(out)?.properties).toHaveLength(6);
  });

  it('is only a database with type: database', () => {
    expect(parseDatabase('---\ntitle: x\n---\n')).toBeNull();
    expect(parseDatabase('plain')).toBeNull();
    expect(parseDatabase(newDatabaseContent(['Author']))?.properties[0].name).toBe('Author');
  });

  it('survives unknown types and duplicate names', () => {
    const c = '---\ntype: database\nproperties:\n  - name: A\n    type: weird\n  - name: a\n    type: number\n---\n';
    const parsed = parseDatabase(c)!;
    expect(parsed.properties).toEqual([{ name: 'A', type: 'text', options: [], default: '' }]);
    expect(parsed.views).toHaveLength(1);
  });

  it('finds the database note of a folder', () => {
    const notes = [
      { path: 'Books/_database.md', content: newDatabaseContent() },
      { path: 'Other/_database.md', content: 'x' },
    ];
    expect(findDatabaseNote('Books', notes)).toBe(notes[0]);
    expect(findDatabaseNote('Other', notes)).toBeNull();
    expect(isDatabasePath('Books/_database.md')).toBe(true);
    expect(isDatabasePath('Books/my_database.md')).toBe(false);
    expect(isDatabasePath('Books/_database-0b9f6c1e-3d52-4c0e-9a7e-5f1d2c3b4a69.md')).toBe(true);
    expect(isDatabasePath('Books/_database-notes.md')).toBe(false);
    expect(isDatabasePath('Books/_database.md.md')).toBe(false);
    expect(databaseFileName('0b9f6c1e-3d52')).toBe('_database-0b9f6c1e-3d52.md');
    expect(isDatabasePath(databaseFileName('0b9f6c1e-3d52-4c0e'))).toBe(true);
  });

  it('infers property keys from the notes of the folder', () => {
    const notes = [
      { path: 'B/a.md', content: '---\nauthor: X\ntitle: T\nrating: 4\n---\n' },
      { path: 'B/sub/b.md', content: '---\nhidden: 1\n---\n' },
    ];
    expect(inferPropertyKeys('B', notes)).toEqual(['author', 'rating']);
  });
});

const note = (name: string, fm: string, body = 'x') => ({ id: name, path: `B/${name}.md`, content: `---\n${fm}\n---\n${body}` });

describe('rows and views', () => {
  const notes = [
    note('One', 'status: todo\npages: 300\nread: true\ngenres: [sf, crime]\nauthor: "[[Lem]]"'),
    note('Two', 'Status: done\npages: 120', '![c](/api/files/1/c.png)'),
    note('Three', 'status: doing\npages: abc'),
    note('Four', 'title: Zed'),
    { id: 'db', path: 'B/_database.md', content: writeDatabase('', db) },
    { id: 's', path: 'B/sub/Deep.md', content: 'x' },
  ];
  const rows = databaseRows(db, 'B', notes);

  it('reads typed values, case-insensitively, skipping schema and subfolders', () => {
    expect(rows.map((r) => r.title).sort()).toEqual(['One', 'Three', 'Two', 'Zed']);
    const one = rows.find((r) => r.noteId === 'One')!;
    expect(one.values).toMatchObject({ Status: 'todo', Pages: 300, Read: true, Genres: ['sf', 'crime'], Author: '[[Lem]]' });
    expect(rows.find((r) => r.noteId === 'Two')!.values.Status).toBe('done');
    expect(rows.find((r) => r.noteId === 'Three')!.values.Pages).toBeNull();
    expect(rows.find((r) => r.noteId === 'Two')!.cover).toBe('/api/files/1/c.png');
  });

  it('filters and sorts with empty values last', () => {
    expect(applyView(db, db.views[0], rows).map((r) => r.title)).toEqual(['One', 'Three', 'Zed']);
    const asc = applyView(db, { ...db.views[0], filter: [], desc: false }, rows);
    expect(asc.map((r) => r.title)).toEqual(['Two', 'One', 'Three', 'Zed']);
  });

  it('includes notes of subfolders with their relative folder when the database asks for it', () => {
    expect(databaseRows(db, 'B', notes).some((r) => r.noteId === 's')).toBe(false);
    const deep = databaseRows({ ...db, subfolders: true }, 'B', notes);
    expect(deep.find((r) => r.noteId === 's')?.folder).toBe('sub');
    expect(deep.find((r) => r.noteId === 'One')?.folder).toBe('');
    expect(deep.some((r) => r.noteId === 'db')).toBe(false);
    const view = { ...db.views[0], filter: [], sort: 'path', desc: false };
    expect(applyView({ ...db, subfolders: true }, view, deep)[0].folder).toBe('sub');
    const byPath = { ...view, filter: [{ property: 'path', op: 'contains' as const, value: 'su' }] };
    expect(applyView({ ...db, subfolders: true }, byPath, deep).map((r) => r.noteId)).toEqual(['s']);
    expect(parseDatabase(writeDatabase('', { ...db, subfolders: true }))?.subfolders).toBe(true);
  });

  it('groups a board by the select options, then none', () => {
    const lanes = boardLanes(db, db.views[1], rows);
    expect(lanes.map((l) => [l.value, l.rows.length])).toEqual([['todo', 1], ['doing', 1], ['done', 1], ['', 1]]);
  });
});

describe('writing cells', () => {
  it('writes values as typed plain YAML and keeps the key as written', () => {
    const [status, pages, read, genres, , author] = db.properties;
    let c = '---\nStatus: todo\n---\nbody';
    c = setCell(c, status, 'done');
    expect(c).toContain('Status: done');
    c = setCell(c, pages, 12.5);
    expect(c).toContain('Pages: 12.5');
    c = setCell(c, read, true);
    expect(c).toContain('Read: true');
    c = setCell(c, genres, ['sf', 'crime']);
    expect(c).toContain('Genres: [sf, crime]');
    c = setCell(c, author, 'Lem');
    expect(c).toContain('[[Lem]]');
    c = setCell(c, status, null);
    expect(c).not.toContain('Status');
    expect(c.endsWith('body')).toBe(true);
  });

  it('drops the key for a bad date', () => {
    expect(setCell('---\nDue: 2026-01-01\n---\n', db.properties[4], 'tomorrow')).not.toContain('Due');
  });

  it('prefills new notes with every property and the defaults', () => {
    const c = newDatabaseNoteContent(db, 'New');
    expect(c).toContain('Status: todo');
    expect(c).toContain('Read: false');
    expect(c).toContain('# New');
    expect(databaseRows(db, 'B', [{ id: 'n', path: 'B/New.md', content: c }])[0].values.Status).toBe('todo');
  });
});
