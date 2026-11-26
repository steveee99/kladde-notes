import { describe, expect, it } from 'vitest';
import { siteNoteHref } from '@kladde/shared';
import { ancestorsOf, buildSiteTree, findSiteNote, homeOf, searchSite } from '../src/lib/siteTree';

// Folder websites: the tree, the addresses and the search of a published folder

const n = (id: string, path: string, content = '') => ({ id, path, content, updatedAt: 1 });

const notes = [
  n('a', 'Zeta.md', '# Zeta\nletzte Notiz'),
  n('b', 'Anleitungen/Setup.md', '# Setup\nInstallation mit Docker'),
  n('c', 'Anleitungen/Tiefer/Backup.md', '# Backup\nDocker Volumes sichern'),
  n('d', 'Alpha.md', '# Alpha\nerste Notiz'),
];

describe('site tree', () => {
  it('lists subfolders first, then notes, both by name', () => {
    const tree = buildSiteTree(notes);
    expect(tree.folders.map((f) => f.name)).toEqual(['Anleitungen']);
    expect(tree.notes.map((x) => x.title)).toEqual(['Alpha', 'Zeta']);
    expect(tree.folders[0].folders[0]).toMatchObject({ name: 'Tiefer', path: 'Anleitungen/Tiefer' });
    expect(tree.folders[0].folders[0].notes.map((x) => x.id)).toEqual(['c']);
  });

  it('names the folders above a note', () => {
    expect(ancestorsOf('Anleitungen/Tiefer/Backup.md')).toEqual(['Anleitungen', 'Anleitungen/Tiefer']);
    expect(ancestorsOf('Alpha.md')).toEqual([]);
  });
});

describe('site addresses', () => {
  it('round-trips a note path through its address', () => {
    const href = siteNoteHref('team-docs', 'Anleitungen/Tiefer/Backup.md');
    expect(href).toBe('/p/team-docs/Anleitungen/Tiefer/Backup');
    expect(findSiteNote(notes, 'anleitungen/tiefer/backup')?.id).toBe('c');
    expect(findSiteNote(notes, 'Gibt/Es/Nicht')).toBeUndefined();
    expect(findSiteNote(notes, '')).toBeUndefined();
    expect(siteNoteHref('x-y', 'Fragen & Antworten.md')).toBe('/p/x-y/Fragen%20%26%20Antworten');
  });

  it('starts on a top-level note named like a start page or like the folder', () => {
    expect(homeOf(notes, 'Docs')).toBeUndefined();
    expect(homeOf([...notes, n('e', 'README.md')], 'Docs')?.id).toBe('e');
    expect(homeOf([...notes, n('f', 'Docs.md'), n('g', 'Unter/Index.md')], 'Docs')?.id).toBe('f');
  });
});

describe('site search', () => {
  it('finds notes with every word, title hits first', () => {
    expect(searchSite(notes, 'docker').map((x) => x.id)).toEqual(['c', 'b']);
    expect(searchSite(notes, 'backup docker').map((x) => x.id)).toEqual(['c']);
    expect(searchSite(notes, '  ')).toEqual([]);
  });
});
