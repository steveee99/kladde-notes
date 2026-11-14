import { describe, expect, it } from 'vitest';
import { LinkIndex, hasPlainMention, linkFirstMention, renameWikiLinks, linkAllMentions } from '../src/links';
import { setFrontmatter, extractMeta, excerpt } from '../src/markdown';
import { buildReview, projectsOf } from '../src/review';
import {
  DEFAULT_DAILY_FOLDER,
  DEFAULT_DAILY_FORMAT,
  DEFAULT_PARA_FOLDERS,
  DEFAULT_RECIPE_FOLDER,
  DEFAULT_ZETTEL_FOLDER,
  STANDALONE_RECIPE_FOLDER,
  archiveTarget,
  isFolderProjectHome,
  isProjectNote,
  isSingleProjectFile,
  normalizeFeatures,
  projectTitleOf,
  resolveDailyNote,
  restoreTarget,
  roleOfFolder,
  roleOfPath,
} from '../src/para';

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

  it('finds Zettel by their title without id and links them by full title', () => {
    const idx = new LinkIndex([note('z', 'Zettelkasten/202611081530 Kleine Schritte.md', ''), note('t', 'x.md', 'Über kleine Schritte nachdenken')]);
    expect(idx.unlinkedMentions('z')).toEqual(['t']);
    expect(linkFirstMention('Über kleine Schritte nachdenken', 'Kleine Schritte', '202611081530 Kleine Schritte')).toBe('Über [[202611081530 Kleine Schritte|kleine Schritte]] nachdenken');
  });

  it('renames links with heading and alias, not in code', () => {
    const out = renameWikiLinks('[[Alt]] [[alt#Kap|A]] `[[Alt]]` [[Altbau]]', 'Alt', 'Neu');
    expect(out).toBe('[[Neu]] [[Neu#Kap|A]] `[[Alt]]` [[Altbau]]');
  });

  it('provides autoLinkTargets and links all mentions', () => {
    const targets = index.autoLinkTargets('c');
    expect(targets).toEqual([
      { name: '202611081530 gedanke', target: '202611081530 Gedanke' },
      { name: 'projekt x', target: 'Projekt X' },
      { name: 'gedanke', target: '202611081530 Gedanke' },
    ]);
    const input = 'Hier wird über das Projekt X gesprochen. Auch gedanke spielt eine Rolle. `Projekt X` im Code bleibt.';
    const result = linkAllMentions(input, targets);
    expect(result).toBe('Hier wird über das [[Projekt X]] gesprochen. Auch [[202611081530 Gedanke|gedanke]] spielt eine Rolle. `Projekt X` im Code bleibt.');
  });

  it('builds a local graph', () => {
    expect(index.localGraph('a', 1).nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(index.isOrphan('c')).toBe(true);
  });

  it('resolves folder-based project Home.md notes by their project folder name', () => {
    const idx = new LinkIndex([
      note('p', '1 Projekte/Hausbau/Home.md', '# Hausbau'),
      note('sub', '1 Projekte/Hausbau/Kosten.md', 'Gehört zu [[Hausbau]]'),
      note('plain', '0 Inbox/Notiz.md', 'Mein Home Office hat nichts mit Hausbau zu tun.'),
    ]);
    expect(idx.resolve('Hausbau')).toBe('p');
    expect(idx.resolve('Hausbau/Home')).toBe('p');
    expect(idx.resolve('Home')).toBeNull();
    expect(idx.backlinks('p')).toEqual(['sub']);
    expect(idx.unlinkedMentions('p')).toEqual(['plain']);
    expect(idx.notes.get('p')?.title).toBe('Hausbau');
  });
});

describe('frontmatter, PARA, templates, daily notes', () => {
  it('sets and removes frontmatter keys', () => {
    const a = setFrontmatter('# Hi', { status: 'aktiv' });
    expect(a).toBe('---\nstatus: aktiv\n---\n# Hi');
    const b = setFrontmatter(a, { status: 'fertig', abgeschlossen: '2026-11-08' });
    expect(extractMeta('x.md', b).frontmatter).toEqual({ status: 'fertig', abgeschlossen: '2026-11-08' });
    expect(setFrontmatter(b, { status: null, abgeschlossen: null })).toBe('# Hi');
  });

  it('keeps the table-of-contents marker and table markup out of excerpts', () => {
    expect(excerpt('## Welcome\n\n##TOC##\n\nEverything here')).toBe('Welcome Everything here');
    expect(excerpt('Intro\n[[toc]]\nMore')).toBe('Intro More');
    expect(excerpt('| Title | Status |\n| --- | :---: |\n| Book | done |')).toBe('Title Status Book done');
    expect(excerpt('See [[Note|alias]] and [[Other]]')).toBe('See alias and Other');
  });

  it('keeps list markup out of excerpts', () => {
    expect(excerpt('# T\n- [ ] Aufgabe 📅 2026-11-08 🔁 weekly\n- Punkt')).toBe('T Aufgabe Punkt');
  });

  it('maps archive paths both ways', () => {
    expect(archiveTarget('1 Projekte/Haus')).toBe('4 Archiv/1 Projekte/Haus');
    expect(archiveTarget('')).toBe('4 Archiv');
    expect(restoreTarget('4 Archiv/1 Projekte/Haus')).toBe('1 Projekte/Haus');
    expect(restoreTarget('1 Projekte')).toBeNull();
    expect(roleOfPath('1 Projekte/Haus/Plan.md')).toBe('projects');

    expect(archiveTarget('Work/Project A', 'Vault/Archive')).toBe('Vault/Archive/Work/Project A');
    expect(restoreTarget('Vault/Archive/Work/Project A', 'Vault/Archive')).toBe('Work/Project A');
  });

  it('resolves custom nested folders and disabled roles', () => {
    const cfg = {
      inbox: '0 Inbox',
      projects: 'Work/Projects',
      areas: 'Areas',
      resources: 'Resources',
      archive: 'Work/Projects/Archive',
      zettel: null,
    };
    expect(roleOfFolder('Work/Projects/Alpha', cfg)).toBe('projects');
    expect(roleOfFolder('Work/Projects/Archive/Old', cfg)).toBe('archive');
    expect(roleOfFolder('Zettelkasten', cfg)).toBeNull();
  });

  it('distinguishes single-file projects, folder Home.md projects, and non-project subnotes', () => {
    expect(isSingleProjectFile('1 Projekte/Alpha.md')).toBe(true);
    expect(isSingleProjectFile('1 Projekte/Alpha/Home.md')).toBe(false);
    expect(isFolderProjectHome('1 Projekte/Alpha/Home.md')).toBe(true);
    expect(isFolderProjectHome('1 Projekte/Alpha/home.md')).toBe(true);
    expect(isFolderProjectHome('1 Projekte/Alpha/Notizen.md')).toBe(false);
    expect(isFolderProjectHome('1 Projekte/Alpha/Unter/Home.md')).toBe(false);
    expect(isProjectNote('1 Projekte/Alpha.md')).toBe(true);
    expect(isProjectNote('1 Projekte/Alpha/Home.md')).toBe(true);
    expect(isProjectNote('1 Projekte/Alpha/Notizen.md')).toBe(false);
    expect(isProjectNote('1 Projekte/Alpha/Unter/Home.md')).toBe(false);
    expect(projectTitleOf('1 Projekte/Alpha/Home.md', '# Hello')).toBe('Alpha');
    expect(projectTitleOf('1 Projekte/Alpha/Home.md', '---\ntitle: Projekt Alpha\n---\n')).toBe('Projekt Alpha');
  });

  it('normalizes feature settings for new vs upgraded spaces', () => {
    const defaultDaily = { enabled: true, folder: DEFAULT_DAILY_FOLDER, format: DEFAULT_DAILY_FORMAT };
    const fresh = normalizeFeatures(undefined, ['0 Inbox']);
    expect(fresh).toEqual({
      para: { enabled: false, folders: DEFAULT_PARA_FOLDERS },
      zettel: { enabled: false, folder: DEFAULT_ZETTEL_FOLDER },
      recipe: { enabled: false, folder: STANDALONE_RECIPE_FOLDER },
      daily: defaultDaily,
      heatmap: { enabled: false },
      review: { enabled: false },
      favorites: { enabled: false },
      writingStats: { enabled: true },
      focus: { enabled: true, dim: false },
    });

    const upgraded = normalizeFeatures(undefined, ['0 Inbox', '1 Projekte', 'Zettelkasten', '3 Ressourcen/Rezepte']);
    expect(upgraded).toEqual({
      para: { enabled: true, folders: DEFAULT_PARA_FOLDERS },
      zettel: { enabled: true, folder: DEFAULT_ZETTEL_FOLDER },
      recipe: { enabled: true, folder: DEFAULT_RECIPE_FOLDER },
      daily: defaultDaily,
      heatmap: { enabled: false },
      review: { enabled: false },
      favorites: { enabled: false },
      writingStats: { enabled: true },
      focus: { enabled: true, dim: false },
    });

    const explicitDisabled = normalizeFeatures(
      {
        para: { enabled: false },
        zettel: { enabled: false, folder: 'Notes/Zettel' },
        recipe: { enabled: true, folder: 'Küche/Rezepte' },
        daily: { enabled: false, folder: '', format: 'YYYY-MM-DD' },
        heatmap: { enabled: true },
        review: { enabled: true },
        favorites: { enabled: 'yes' },
        writingStats: { enabled: false },
        focus: { enabled: 'no', dim: true },
      },
      ['1 Projekte', 'Zettelkasten']
    );
    expect(explicitDisabled.para.enabled).toBe(false);
    expect(explicitDisabled.zettel).toEqual({ enabled: false, folder: 'Notes/Zettel' });
    expect(explicitDisabled.recipe).toEqual({ enabled: true, folder: 'Küche/Rezepte' });
    expect(explicitDisabled.daily).toEqual({ enabled: false, folder: '', format: 'YYYY-MM-DD' });
    expect(explicitDisabled.heatmap).toEqual({ enabled: true });
    expect(explicitDisabled.review).toEqual({ enabled: true });
    expect(explicitDisabled.favorites).toEqual({ enabled: false });
    expect(explicitDisabled.writingStats).toEqual({ enabled: false });
    expect(explicitDisabled.focus).toEqual({ enabled: true, dim: true });

    const guarded = normalizeFeatures({ daily: { folder: '.kladde/hack', format: '../../.kladde/evil.md' } }, []);
    expect(guarded.daily).toEqual(defaultDaily);
  });

  it('resolves daily note paths from folder and format tokens', () => {
    const tue = new Date(2026, 10, 10); // 2026-11-10, Tuesday, ISO week 46
    expect(resolveDailyNote({ folder: DEFAULT_DAILY_FOLDER, format: DEFAULT_DAILY_FORMAT }, tue, 'de')).toEqual({
      path: '0 Daily/2026/11/2026-11-10.md',
      folder: '0 Daily/2026/11',
      name: '2026-11-10',
    });

    expect(resolveDailyNote({ folder: '', format: 'YYYY/MMMM/ddd D. YYYY' }, tue, 'de')).toEqual({
      path: '2026/November/Di 10. 2026.md',
      folder: '2026/November',
      name: 'Di 10. 2026',
    });

    expect(resolveDailyNote({ folder: 'Journal', format: 'YYYY/KW-WW/Daily YYYY-MM-DD dddd.MD' }, tue, 'en')).toEqual({
      path: 'Journal/2026/KW-46/Daily 2026-11-10 Tuesday.md',
      folder: 'Journal/2026/KW-46',
      name: 'Daily 2026-11-10 Tuesday',
    });
  });
});

describe('review', () => {
  it('collects only true project notes and what needs attention', () => {
    const now = new Date(2026, 10, 8).getTime();
    const day = 86_400_000;
    const notes = [
      note('p1', '1 Projekte/A.md', '- [ ] Schritt', now, now),
      note('p2', '1 Projekte/B/Home.md', 'nichts zu tun', now, now),
      note('p2sub', '1 Projekte/B/Recherchen.md', 'Unterdatei im Projekt', now, now),
      note('p2deep', '1 Projekte/B/Sub/Home.md', 'Verschachtelt', now, now),
      note('p3', '1 Projekte/C.md', '---\nstatus: fertig\n---\n', now, now),
      note('i1', '0 Inbox/X.md', '', now, now),
      note('ar', '2 Bereiche/Gesundheit/Sport.md', '', now - 40 * day, 0),
      note('z1', 'Zettelkasten/1 Z.md', '---\ntyp: flüchtig\n---\n', now, now - 10 * day),
    ];
    expect(projectsOf(notes, new Date(now)).map((p) => ({ id: p.id, title: p.title }))).toEqual([
      { id: 'p1', title: 'A' },
      { id: 'p2', title: 'B' },
    ]);
    const r = buildReview(notes, now);
    expect(r.projects.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(r.projectsWithoutNextStep.map((p) => p.id)).toEqual(['p2']);
    expect(r.inbox).toEqual(['i1']);
    expect(r.staleAreas.map((a) => a.name)).toEqual(['Gesundheit']);
    expect(r.orphanZettel).toEqual(['z1']);
    expect(r.oldFleeting).toEqual(['z1']);
  });

  it('respects disabled roles and custom target folders in review', () => {
    const now = new Date(2026, 10, 8).getTime();
    const day = 86_400_000;
    const notes = [
      note('p1', 'Work/Projects/A.md', '', now, now),
      note('p2', 'Work/Projects/Beta/Home.md', '', now, now),
      note('p2note', 'Work/Projects/Beta/Tasks.md', '', now, now),
      note('i1', '0 Inbox/X.md', '', now, now),
      note('ar', 'Life/Areas/Sport/Run.md', '', now - 40 * day, 0),
      note('z1', 'Zettelkasten/1 Z.md', '---\ntyp: flüchtig\n---\n', now, now - 10 * day),
    ];

    const custom = buildReview(notes, now, 30, {
      inbox: '0 Inbox',
      projects: 'Work/Projects',
      areas: 'Life/Areas',
      resources: 'Resources',
      archive: 'Archive',
      zettel: null,
    });
    expect(custom.inbox).toEqual(['i1']);
    expect(custom.projects.map((p) => ({ id: p.id, title: p.title }))).toEqual([
      { id: 'p1', title: 'A' },
      { id: 'p2', title: 'Beta' },
    ]);
    expect(custom.staleAreas.map((a) => a.name)).toEqual(['Sport']);
    expect(custom.orphanZettel).toEqual([]);
    expect(custom.oldFleeting).toEqual([]);
  });
});
