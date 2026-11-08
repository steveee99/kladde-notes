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

  it('extracts meta', () => {
    expect(extractMeta('a/b.md', 'x #Tag `#no` [[Link|Alias]]')).toMatchObject({ title: 'b', folder: 'a', tags: ['tag'], links: ['Link'] });
  });
});
