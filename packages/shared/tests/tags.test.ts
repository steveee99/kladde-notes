import { describe, expect, it } from 'vitest';
import { buildTagTree, calendarTasks, extractMeta, isValidTag, normalizeTag, renameTag, runQuery, tagBeforeCursor, tagMatches } from '../src/index.js';

const note = (id: string, content: string) => ({ id, path: `${id}.md`, content, createdAt: 0, updatedAt: 0 });

describe('tags', () => {
  it('normalizes and validates tag names', () => {
    expect(normalizeTag(' #Area/Health/ ')).toBe('area/health');
    expect(normalizeTag('two words')).toBe('two-words');
    expect(isValidTag('area/health')).toBe(true);
    expect(isValidTag('123')).toBe(false);
    expect(isValidTag('a b')).toBe(false);
    expect(isValidTag('a//b')).toBe(false);
  });

  it('matches nested tags under their parent', () => {
    expect(tagMatches('area/health', 'area')).toBe(true);
    expect(tagMatches('area', '#Area')).toBe(true);
    expect(tagMatches('areas', 'area')).toBe(false);
    expect(tagMatches('area', 'area/health')).toBe(false);
  });

  it('builds a tree with counts per tag and totals including children', () => {
    const tree = buildTagTree([
      note('1', '#area/health #arbeit'),
      note('2', '---\ntags: area/health, area/sport\n---\ntext'),
      note('3', 'only #area'),
      note('4', '`#code` is no tag'),
    ]);
    expect(tree.map((t) => [t.tag, t.count, t.total])).toEqual([
      ['arbeit', 1, 1],
      ['area', 1, 3],
    ]);
    expect(tree[1].children.map((t) => [t.name, t.count, t.total])).toEqual([
      ['health', 2, 2],
      ['sport', 1, 1],
    ]);
  });

  it('shows parents that are only used through their children', () => {
    const tree = buildTagTree([note('1', '#a/b/c')]);
    expect(tree[0]).toMatchObject({ tag: 'a', count: 0, total: 1 });
    expect(tree[0].children[0].children[0]).toMatchObject({ tag: 'a/b/c', count: 1, total: 1 });
  });

  it('renames a tag in the text, nested tags and the frontmatter, but not in code', () => {
    const src = '---\ntitle: X\ntags: [projekt, #other]\n---\nSee #Projekt and #projekt/alt, not #projekte.\n`#projekt` stays\n```\n#projekt\n```\n';
    const out = renameTag(src, 'projekt', 'project');
    expect(out).toBe('---\ntitle: X\ntags: [project, #other]\n---\nSee #project and #project/alt, not #projekte.\n`#projekt` stays\n```\n#projekt\n```\n');
    expect(extractMeta('x.md', out).tags.sort()).toEqual(['other', 'project', 'project/alt', 'projekte']);
  });

  it('merges into an existing tag without duplicates in the frontmatter', () => {
    expect(renameTag('---\ntags: projeckt, projekt\n---\n#projeckt', 'projeckt', 'projekt')).toBe('---\ntags: projekt\n---\n#projekt');
  });

  it('leaves content without the tag untouched', () => {
    const src = '---\ntags: a, b\n---\nurl http://x.org/#projekt and # heading';
    expect(renameTag(src, 'projekt', 'p')).toBe(src);
  });

  it('finds the tag before the cursor', () => {
    expect(tagBeforeCursor('text #are')).toEqual({ query: 'are', from: 5 });
    expect(tagBeforeCursor('#')).toEqual({ query: '', from: 0 });
    expect(tagBeforeCursor('a#b')).toBeNull();
    expect(tagBeforeCursor('# heading')).toBeNull();
  });

  it('includes nested tags in queries', () => {
    const notes = [note('1', '#area/health'), note('2', '#area'), note('3', '#other')];
    expect(runQuery('LIST WHERE tags contains "area"', notes).rows.map((r) => r.noteId).sort()).toEqual(['1', '2']);
    expect(runQuery('LIST FROM #area', notes).rows.map((r) => r.noteId).sort()).toEqual(['1', '2']);
    expect(runQuery('LIST FROM #area/health', notes).rows.map((r) => r.noteId)).toEqual(['1']);
  });

  it('includes nested tags in the calendar feed filter', () => {
    const notes = [{ id: '1', path: 'a.md', content: '#area/health\n- [ ] Run 📅 2026-01-02', updatedAt: 0 }];
    const opts = { name: 'K', baseUrl: 'https://notes.example.org/', includeDone: false, folder: '', showTitles: true, lang: 'de' as const, now: new Date('2026-01-01') };
    expect(calendarTasks(notes, { ...opts, tag: 'area' })).toHaveLength(1);
    expect(calendarTasks(notes, { ...opts, tag: 'are' })).toHaveLength(0);
    const tasks = calendarTasks([{ ...notes[0], content: '- [ ] Run #area/health 📅 2026-01-02' }], { ...opts, tag: '#area' });
    expect(tasks).toHaveLength(1);
  });
});
