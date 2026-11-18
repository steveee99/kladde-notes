import { describe, expect, it } from 'vitest';
import { LinkIndex, NoteMemo, TaskCache, parseTasks, runQuery, semanticSearch, type LinkNote } from '../src/index';

// Incremental work for large vaults (#64): every cache must give exactly what a fresh computation gives

const note = (id: string, path: string, content: string, updatedAt = 1): LinkNote & { createdAt: number; updatedAt: number } => ({ id, path, content, createdAt: 1, updatedAt });

function vault() {
  return [
    note('a', 'Projekte/Alpha.md', '# Alpha\n\nSiehe [[Beta]] und [[Gamma]].\n\n- [ ] Plan schreiben due:2026-11-20'),
    note('b', 'Projekte/Beta.md', '---\nid: 202611181200\ntags: [garten]\n---\n# Beta\n\nZurück zu [[Alpha]]. Gamma wird erwähnt.'),
    note('c', 'Ressourcen/Gamma.md', '# Gamma\n\nKeine Links, aber Alpha im Text.\n\n- [x] Erledigt'),
    note('d', 'Ressourcen/Delta.md', '# Delta\n\n[Pfadlink](/Projekte/Alpha) und [[202611181200]]'),
  ];
}

/** Everything observable about an index */
function snapshot(index: LinkIndex, ids: string[]) {
  return ids.map((id) => ({
    id,
    title: index.notes.get(id)?.title,
    content: index.notes.get(id)?.content,
    out: index.outgoing(id),
    back: index.backlinks(id).sort(),
    mentions: index.unlinkedMentions(id).sort(),
  }));
}

describe('NoteMemo', () => {
  it('computes again only when path, text or the extra key change, and forgets the oldest', () => {
    let calls = 0;
    const memo = new NoteMemo<string>((n) => {
      calls++;
      return n.content.toUpperCase();
    }, 2);
    const a = { id: 'a', path: 'a.md', content: 'eins' };
    expect(memo.get(a)).toBe('EINS');
    expect(memo.get({ ...a })).toBe('EINS');
    expect(calls).toBe(1);
    expect(memo.get({ ...a, content: 'zwei' })).toBe('ZWEI');
    expect(memo.get({ ...a, content: 'zwei', path: 'b.md' })).toBe('ZWEI');
    expect(memo.get({ ...a, content: 'zwei', path: 'b.md' }, 'morgen')).toBe('ZWEI');
    expect(calls).toBe(4);
    memo.get({ id: 'b', path: 'b.md', content: 'b' });
    memo.get({ id: 'c', path: 'c.md', content: 'c' });
    expect(memo.size).toBe(2);
  });
});

describe('LinkIndex built from the previous one', () => {
  it('matches a fresh index when only text changes (fast path)', () => {
    const notes = vault();
    const first = new LinkIndex(notes);
    const edited = notes.map((n) => (n.id === 'c' ? { ...n, content: `${n.content}\nMehr Text über Beta.` } : n));
    const reused = new LinkIndex(edited, undefined, first);
    const fresh = new LinkIndex(edited);
    const ids = notes.map((n) => n.id);
    expect(snapshot(reused, ids)).toEqual(snapshot(fresh, ids));
    expect(reused.unlinkedMentions('b')).toContain('c');
  });

  it('matches a fresh index when links, titles, ids or the set of notes change', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    let notes = vault();
    let index = new LinkIndex(notes);
    const steps: ((ns: ReturnType<typeof vault>) => ReturnType<typeof vault>)[] = [
      // a new link
      (ns) => ns.map((n) => (n.id === 'c' ? { ...n, content: `${n.content}\n[[Delta]]` } : n)),
      // a rename
      (ns) => ns.map((n) => (n.id === 'b' ? { ...n, path: 'Projekte/Beta neu.md' } : n)),
      // a new note that takes a title
      (ns) => [...ns, note('e', 'Inbox/Gamma.md', 'Doppelter Titel [[Alpha]]')],
      // the Zettel id goes away
      (ns) => ns.map((n) => (n.id === 'b' ? { ...n, content: n.content.replace('id: 202611181200\n', '') } : n)),
      // a note is deleted
      (ns) => ns.filter((n) => n.id !== 'a'),
    ];
    for (const step of steps) {
      notes = step(notes);
      index = new LinkIndex(notes, undefined, index);
      expect(snapshot(index, ids)).toEqual(snapshot(new LinkIndex(notes), ids));
    }
  });
});

describe('TaskCache', () => {
  it('gives the parsed tasks and parses again for another day or default due date', () => {
    const cache = new TaskCache();
    const n = { id: 't', path: 'T.md', content: '- [ ] Heute erledigen due:today\n- [ ] Ohne Datum' };
    const today = new Date(2026, 10, 18);
    expect(cache.tasksOf(n, today)).toEqual(parseTasks(n.content, today));
    expect(cache.tasksOf({ ...n }, today)).toBe(cache.tasksOf(n, today));
    const tomorrow = new Date(2026, 10, 19);
    expect(cache.tasksOf(n, tomorrow)).toEqual(parseTasks(n.content, tomorrow));
    expect(cache.tasksOf(n, today, '2026-12-01')).toEqual(parseTasks(n.content, today, '2026-12-01'));
  });
});

describe('cached queries and search', () => {
  it('run again with the same result as on fresh notes after a change', () => {
    const notes = vault();
    const today = new Date(2026, 10, 18);
    const q = 'TASKS WHERE done = false SORT due';
    expect(runQuery(q, notes, today).rows).toEqual(runQuery(q, notes.map((n) => ({ ...n })), today).rows);
    const changed = notes.map((n) => (n.id === 'a' ? { ...n, content: `${n.content}\n- [ ] Neue Aufgabe` } : n));
    expect(runQuery(q, changed, today).rows.map((r) => r.values.text)).toContain('Neue Aufgabe');
  });

  it('keeps the search corpus in step with changed, added and removed notes', () => {
    const notes = vault();
    const first = semanticSearch('Garten', notes, { corpusKey: 'memo-test' });
    expect(first[0]?.note.id).toBe('b');
    const changed = [...notes.filter((n) => n.id !== 'b'), note('x', 'Garten/Beete.md', '# Beete\n\nGarten und Gemüse im Garten.', 5)];
    const hits = semanticSearch('Garten', changed, { corpusKey: 'memo-test' });
    expect(hits.map((h) => h.note.id)).not.toContain('b');
    expect(hits[0].note.id).toBe('x');
    expect(hits).toEqual(semanticSearch('Garten', changed.map((n) => ({ ...n })), { corpusKey: 'memo-test-fresh' }));
    // Results carry the note object passed in, with its current fields
    expect(hits[0].note).toBe(changed.find((n) => n.id === 'x'));
  });
});
