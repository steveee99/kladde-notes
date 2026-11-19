import { describe, expect, it } from 'vitest';
import { parseQuery, runQuery } from '../src/query';
import { extractMeta } from '../src/markdown';

const notes = [
  { id: '1', path: '1 Projekte/Haus.md', content: '---\nstatus: aktiv\nprio: 2\n---\n# Haus #bau\n- [ ] Dach 📅 2026-11-10', createdAt: 1, updatedAt: 3 },
  { id: '2', path: '1 Projekte/Garten.md', content: '---\nstatus: fertig\nprio: 10\n---\nText #bau [[Haus]]', createdAt: 2, updatedAt: 2 },
  { id: '3', path: '3 Ressourcen/Rezept.md', content: 'Lecker', createdAt: 3, updatedAt: 1 },
];

describe('query', () => {
  it('parses all clauses', () => {
    const q = parseQuery('TABLE title, status FROM "1 Projekte" WHERE status = aktiv OR prio > 5 SORT prio DESC LIMIT 5');
    expect(q).toMatchObject({ mode: 'table', fields: ['title', 'status'], from: '1 Projekte', limit: 5, sort: { field: 'prio', desc: true } });
    expect(q.where).toHaveLength(2);
  });

  it('filters, sorts numerically and limits', () => {
    const r = runQuery('TABLE title, prio FROM "1 Projekte" SORT prio ASC', notes);
    expect(r.rows.map((x) => x.values.title)).toEqual(['Haus', 'Garten']);
    expect(runQuery('LIST WHERE tags contains bau AND status != fertig', notes).rows.map((x) => x.noteId)).toEqual(['1']);
    expect(runQuery('LIST LIMIT 1', notes).rows[0].noteId).toBe('1');
  });

  it('lists tasks', () => {
    const r = runQuery('TASKS WHERE done = false', notes);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].values.text).toBe('Dach');
  });

  it('builds kanban lanes in the given order, case-insensitively', () => {
    const r = runQuery('KANBAN BY status VALUES "fertig", "Aktiv", "offen" FROM "1 Projekte"', notes);
    expect(r.lanes?.map((l) => [l.value, l.rows.map((x) => x.noteId)])).toEqual([
      ['fertig', ['2']],
      ['Aktiv', ['1']],
      ['offen', []],
    ]);
  });

  it('derives kanban lanes from the found values and needs a field', () => {
    const r = runQuery('KANBAN status', notes);
    expect(r.lanes?.map((l) => l.value)).toEqual(['', 'aktiv', 'fertig']);
    expect(() => parseQuery('KANBAN')).toThrow();
    expect(() => parseQuery('KANBAN FROM "x"')).toThrow();
  });

  it('aggregates a TABLE in a footer (#77)', () => {
    const r = runQuery('TABLE title, SUM(prio), AVG( prio ), MIN(prio), MAX (prio), COUNT FROM "1 Projekte"', notes);
    expect(r.columns).toEqual(['title', 'sum(prio)', 'avg(prio)', 'min(prio)', 'max(prio)', 'count']);
    expect(r.totals).toEqual({ 'sum(prio)': 12, 'avg(prio)': 6, 'min(prio)': '2', 'max(prio)': '10', count: 2 });
    // Rows show the aggregated field's value
    expect(r.rows.map((x) => x.values['sum(prio)'])).toEqual(['2', '10']);
    expect(r.groups).toBeUndefined();
    expect(runQuery('TABLE title, SUM(prio) FROM "3 Ressourcen"', notes).totals).toEqual({ 'sum(prio)': '' });
  });

  it('groups TABLE and LIST rows (#77)', () => {
    const list = runQuery('LIST GROUP BY status', notes);
    expect(list.groups?.map((g) => [g.key, g.rows.map((x) => x.noteId)])).toEqual([
      ['aktiv', ['1']],
      ['fertig', ['2']],
      ['', ['3']],
    ]);
    const summary = runQuery('TABLE status, COUNT, SUM(prio) GROUP BY status SORT status DESC', notes);
    expect(summary.summary).toBe(true);
    expect(summary.groups?.map((g) => [g.key, g.aggregates])).toEqual([
      ['fertig', { count: 1, 'sum(prio)': 10 }],
      ['aktiv', { count: 1, 'sum(prio)': 2 }],
      ['', { count: 1, 'sum(prio)': '' }],
    ]);
    expect(summary.totals).toEqual({ count: 3, 'sum(prio)': 12 });
    // A note is in the group of each of its tags; other columns keep the notes
    const tags = runQuery('TABLE title, COUNT GROUP BY tags', notes);
    expect(tags.summary).toBe(false);
    expect(tags.groups?.map((g) => [g.key, g.aggregates.count])).toEqual([['bau', 2], ['', 1]]);
    expect(runQuery('TABLE COUNT GROUP BY folder', notes).columns).toEqual(['folder', 'count']);
  });

  it('keeps `group` as a field name and rejects bad aggregates', () => {
    expect(parseQuery('TABLE group, title').fields).toEqual(['group', 'title']);
    expect(parseQuery('TABLE title GROUP BY status').groupBy).toBe('status');
    expect(() => parseQuery('TABLE SUM()')).toThrow();
    expect(() => parseQuery('TASKS GROUP BY due')).toThrow();
    expect(() => parseQuery('LIST GROUP BY')).toThrow();
  });

  it('extracts meta', () => {
    expect(extractMeta('a/b.md', 'x #Tag `#no` [[Link|Alias]]')).toMatchObject({ title: 'b', folder: 'a', tags: ['tag'], links: ['Link'] });
  });
});
