import { describe, expect, it } from 'vitest';
import { buildReview, edgeNeighbourhood, filterGraph, filterGraphData, graphNoteKind, LinkIndex, neighbourhood } from '../src/index.js';

const DAY = 86_400_000;
const note = (id: string, path: string, content = '', createdAt = 0, updatedAt = createdAt) => ({ id, path, content, createdAt, updatedAt });

// a ↔ b → c → d, e alone; f in the archive links to a
const notes = [
  note('a', '1 Projekte/A.md', '[[B]] #area/health', 10 * DAY),
  note('b', '2 Bereiche/B.md', '[[A]] [[C]]', 20 * DAY),
  note('c', '3 Ressourcen/C.md', '[[202601010000]] #area', 30 * DAY),
  note('d', 'Zettelkasten/202601010000 D.md', 'text', 40 * DAY),
  note('e', 'Lose/E.md', '---\ntype: pdf\n---\n![x](/api/files/x.pdf)', 50 * DAY),
  note('f', '4 Archiv/F.md', '[[A]]', 60 * DAY),
  note('g', 'Lose/G.md', '```excalidraw\n{}\n```', 70 * DAY),
];
const index = new LinkIndex(notes);
const ids = (r: { nodes: { id: string }[] }) => r.nodes.map((n) => n.id).sort();

describe('graph filters', () => {
  it('detects note kinds', () => {
    expect(graphNoteKind(notes[3].path, notes[3].content)).toBe('zettel');
    expect(graphNoteKind(notes[4].path, notes[4].content)).toBe('pdf');
    expect(graphNoteKind(notes[0].path, notes[0].content)).toBe('note');
  });

  it('marks orphans on the whole graph and counts them', () => {
    const r = filterGraph(index, notes);
    expect(r.nodes.filter((n) => n.orphan).map((n) => n.id).sort()).toEqual(['e', 'g']);
    expect(r.orphans).toBe(2);
    // Hiding a neighbour does not turn d into an orphan
    const only = filterGraph(index, notes, { roles: ['zettel'] });
    expect(only.nodes).toMatchObject([{ id: 'd', orphan: false }]);
    expect(only.edges).toEqual([]);
  });

  it('filters by role, archive, folder, tag, kind and orphans', () => {
    expect(ids(filterGraph(index, notes, { hideArchive: true }))).toEqual(['a', 'b', 'c', 'd', 'e', 'g']);
    expect(ids(filterGraph(index, notes, { roles: ['projects', 'archive'], hideArchive: true }))).toEqual(['a', 'f']);
    expect(ids(filterGraph(index, notes, { roles: ['none'] }))).toEqual(['e', 'g']);
    expect(ids(filterGraph(index, notes, { folder: 'Lose/' }))).toEqual(['e', 'g']);
    expect(ids(filterGraph(index, notes, { tag: '#area' }))).toEqual(['a', 'c']);
    expect(ids(filterGraph(index, notes, { kinds: ['pdf', 'zettel'] }))).toEqual(['d', 'e']);
    expect(ids(filterGraph(index, notes, { onlyOrphans: true }))).toEqual(['e', 'g']);
    expect(ids(filterGraph(index, notes, { onlyLinked: true }))).toEqual(['a', 'b', 'c', 'd', 'f']);
  });

  it('filters by a time range', () => {
    expect(ids(filterGraph(index, notes, { range: { field: 'created', from: 20 * DAY, to: 40 * DAY } }))).toEqual(['b', 'c', 'd']);
  });

  it('focuses on a note with 1 to 3 hops', () => {
    expect([...neighbourhood(index, 'a', 1)].sort()).toEqual(['a', 'b', 'f']);
    expect(ids(filterGraph(index, notes, { focus: { id: 'a', depth: 1 } }))).toEqual(['a', 'b', 'f']);
    expect(ids(filterGraph(index, notes, { focus: { id: 'a', depth: 2 } }))).toEqual(['a', 'b', 'c', 'f']);
    expect(ids(filterGraph(index, notes, { focus: { id: 'a', depth: 9 } }))).toEqual(['a', 'b', 'c', 'd', 'f']);
    // The focused note stays even when a filter would hide it
    expect(ids(filterGraph(index, notes, { focus: { id: 'f', depth: 1 }, hideArchive: true }))).toEqual(['a', 'f']);
  });
});

describe('review orphans', () => {
  it('lists orphaned notes outside Zettel, inbox, archive and excluded folders', () => {
    const r = buildReview(
      [
        note('x', 'Lose/X.md', '', 0, 2),
        note('y', 'Lose/Y.md', '', 0, 1),
        note('l1', 'Lose/L1.md', '[[L2]]'),
        note('l2', 'Lose/L2.md'),
        note('i', '0 Inbox/I.md'),
        note('z', 'Zettelkasten/Z.md'),
        note('ar', '4 Archiv/A.md'),
        note('daily', '0 Daily/2026/11/2026-11-15.md'),
      ],
      DAY,
      30,
      undefined,
      { orphanExcludeFolders: ['0 Daily'] }
    );
    expect(r.orphanNotes).toEqual(['x', 'y']);
    expect(r.orphanZettel).toEqual(['z']);
  });
});

describe('filterGraphData', () => {
  it('filters a graph built elsewhere (online mode) like filterGraph', () => {
    const index = new LinkIndex(notes);
    const byId = new Map(notes.map((n) => [n.id, n]));
    const info = (id: string) => {
      const n = byId.get(id);
      return n ? { kind: graphNoteKind(n.path, n.content), tags: () => (n.content.match(/#[\w/]+/g) ?? []).map((t) => t.slice(1)), createdAt: n.createdAt, updatedAt: n.updatedAt } : undefined;
    };
    for (const filter of [{}, { tag: 'area' }, { onlyOrphans: true }, { focus: { id: 'b', depth: 1 } }, { kinds: ['zettel' as const] }]) {
      const local = filterGraph(index, notes, filter);
      const remote = filterGraphData(index.graph(), info, filter);
      expect(remote.nodes.map((n) => n.id).sort()).toEqual(local.nodes.map((n) => n.id).sort());
      expect(remote.edges.length).toBe(local.edges.length);
    }
    expect([...edgeNeighbourhood(index.graph().edges, 'c', 1)].sort()).toEqual(['b', 'c', 'd']);
  });
});
