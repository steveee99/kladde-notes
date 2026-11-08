import { describe, expect, it } from 'vitest';
import { LinkIndex, hasPlainMention, linkFirstMention, renameWikiLinks } from '../src/links';
import { setFrontmatter, extractMeta } from '../src/markdown';
import { buildReview } from '../src/review';
import { archiveTarget, restoreTarget, roleOfPath } from '../src/para';
import { fillTemplate, BUILTIN_TEMPLATES } from '../src/templates';

const note = (id: string, path: string, content: string, updatedAt = 0, createdAt = 0) => ({ id, path, content, updatedAt, createdAt });

describe('links', () => {
  const notes = [
    note('a', 'Zettelkasten/202611081530 Gedanke.md', '---\nid: 202611081530\n---\nVerweis auf [[Projekt X]]'),
    note('b', '1 Projekte/Projekt X.md', 'Siehe [[202611081530]] und [[202611081530 Alter Titel|alias]]'),
    note('c', '0 Inbox/Idee.md', 'Das Projekt X ist toll. `Projekt X` im Code zählt nicht.'),
  ];
  const index = new LinkIndex(notes);

  it('resolves titles and Zettel ids, even after a rename', () => {
    expect(index.resolve('Projekt X')).toBe('b');
    expect(index.resolve('202611081530')).toBe('a');
    expect(index.resolve('202611081530 Alter Titel')).toBe('a');
    expect(index.backlinks('a')).toEqual(['b']);
    expect(index.outgoing('a')).toEqual(['b']);
  });

  it('finds unlinked mentions and links them', () => {
    expect(index.unlinkedMentions('b')).toEqual(['c']);
    expect(linkFirstMention(notes[2].content, 'Projekt X')).toBe('Das [[Projekt X]] ist toll. `Projekt X` im Code zählt nicht.');
    expect(linkFirstMention('das projekt x', 'Projekt X')).toBe('das [[Projekt X|projekt x]]');
    expect(hasPlainMention('[[Projekt X]] nur verlinkt', 'Projekt X')).toBe(false);
    expect(hasPlainMention('Projekt Xyz', 'Projekt X')).toBe(false);
  });

  it('renames links with heading and alias, not in code', () => {
    const out = renameWikiLinks('[[Alt]] [[alt#Kap|A]] `[[Alt]]` [[Altbau]]', 'Alt', 'Neu');
    expect(out).toBe('[[Neu]] [[Neu#Kap|A]] `[[Alt]]` [[Altbau]]');
  });

  it('builds a local graph', () => {
    expect(index.localGraph('a', 1).nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(index.isOrphan('c')).toBe(true);
  });
});

describe('frontmatter, PARA, templates', () => {
  it('sets and removes frontmatter keys', () => {
    const a = setFrontmatter('# Hi', { status: 'aktiv' });
    expect(a).toBe('---\nstatus: aktiv\n---\n# Hi');
    const b = setFrontmatter(a, { status: 'fertig', abgeschlossen: '2026-11-08' });
    expect(extractMeta('x.md', b).frontmatter).toEqual({ status: 'fertig', abgeschlossen: '2026-11-08' });
    expect(setFrontmatter(b, { status: null, abgeschlossen: null })).toBe('# Hi');
  });

  it('maps archive paths both ways', () => {
    expect(archiveTarget('1 Projekte/Haus')).toBe('4 Archiv/1 Projekte/Haus');
    expect(restoreTarget('4 Archiv/1 Projekte/Haus')).toBe('1 Projekte/Haus');
    expect(restoreTarget('1 Projekte')).toBeNull();
    expect(roleOfPath('1 Projekte/Haus/Plan.md')).toBe('projects');
  });

  it('fills templates', () => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === 'literatur')!;
    expect(fillTemplate(t.content, { title: 'Buch', zid: '202611081530', date: '2026-11-08' })).toContain('id: 202611081530');
  });
});

describe('review', () => {
  it('collects what needs attention', () => {
    const now = new Date(2026, 10, 8).getTime();
    const day = 86_400_000;
    const r = buildReview(
      [
        note('p1', '1 Projekte/A.md', '- [ ] Schritt', now, now),
        note('p2', '1 Projekte/B.md', 'nichts zu tun', now, now),
        note('p3', '1 Projekte/C.md', '---\nstatus: fertig\n---\n', now, now),
        note('i1', '0 Inbox/X.md', '', now, now),
        note('ar', '2 Bereiche/Gesundheit/Sport.md', '', now - 40 * day, 0),
        note('z1', 'Zettelkasten/1 Z.md', '---\ntyp: flüchtig\n---\n', now, now - 10 * day),
      ],
      now
    );
    expect(r.projects.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(r.projectsWithoutNextStep.map((p) => p.id)).toEqual(['p2']);
    expect(r.inbox).toEqual(['i1']);
    expect(r.staleAreas.map((a) => a.name)).toEqual(['Gesundheit']);
    expect(r.orphanZettel).toEqual(['z1']);
    expect(r.oldFleeting).toEqual(['z1']);
  });
});
