import { describe, expect, it } from 'vitest';
import { parseQuery, runQuery } from '../src/query';
import { addChecklist, cardLineUrl, createPeriodicExtractor, extractDailyNoteDate, resolveDailyNote, resolvePeriodicNote } from '../src/index';
import { findInlineMath, findMath, parseExportInlines, fillReleasePlaceholders, hasReleasePlaceholders, buildCalendar, filterGraph, pdfNoteOf, LinkIndex, normalizeTag, renameTag, tagBeforeCursor, nextDue, parseFrontmatter, parseTasks, rruleOf, setTaskMeta, setTaskStatus, stripBlockIds, extractHeadings, trimSlashes } from '../src/index';

/** Runs `fn` and fails if it takes longer than a linear scan should (the CodeQL polynomial-ReDoS inputs) */
function fast(fn: () => unknown, ms = 250) {
  const start = performance.now();
  fn();
  expect(performance.now() - start).toBeLessThan(ms);
}

const N = 50_000;

describe('regexes stay linear on hostile input', () => {
  it('ticket checklists and GitLab card lines', () => {
    fast(() => addChecklist(`* [ ] ${'  '.repeat(N)}x\n${' '.repeat(N)}`, ['Abnahme']));
    fast(() => addChecklist(`${'- [ ] '.repeat(N / 6)}\n`, ['a']));
    fast(() => cardLineUrl(`https://${'a'.repeat(N)}${' '.repeat(N)}x`));
  });

  it('formulas (#85)', () => {
    fast(() => findInlineMath(`$x$ ${'`'.repeat(N)}`));
    fast(() => findInlineMath(`$x$ ${'`a'.repeat(N / 2)}`));
    fast(() => findMath(`${'$'.repeat(N)}\n${'$a '.repeat(N / 3)}`));
    fast(() => parseExportInlines(`${'$ a'.repeat(N / 3)}`));
  });

  it('release placeholders (#53)', () => {
    const r = [{ version: '1.0.0', releasedAt: 0, releasedBy: 'a', note: '' }];
    fast(() => fillReleasePlaceholders('{{#versions}}'.repeat(N / 10), r));
    fast(() => fillReleasePlaceholders(`{{version}}\n${' '.repeat(N)}\n${'```\n'.repeat(N / 10)}`, r));
    fast(() => hasReleasePlaceholders(`${'\n '.repeat(N)}\`\`\`x`));
    fast(() => fillReleasePlaceholders(`{{version}}\n${'~~~~'.repeat(N / 10)}\n${' '.repeat(N)}~`, r));
  });

  it('tasks with long runs of whitespace', () => {
    fast(() => parseTasks(`* [ ] ${' '.repeat(N)}\r`));
    fast(() => parseTasks(`- [ ] x${' '.repeat(N)}y`));
    fast(() => setTaskMeta(`* [ ] x${' '.repeat(N)}✅`, 0, { due: '2026-11-20' }));
    fast(() => nextDue(`${' '.repeat(N)}x`, null));
    fast(() => rruleOf(`1${' '.repeat(N)}`));
    fast(() => rruleOf(`!${'00'.repeat(N)}`));
    fast(() => nextDue(`${'00'.repeat(N)}!`, null));
  });

  it('daily, weekly and monthly naming patterns with many brackets (#73)', () => {
    const format = `${'[\\'.repeat(N / 2)}x`;
    fast(() => resolveDailyNote({ folder: 'D', format }, new Date(2026, 10, 19)));
    fast(() => extractDailyNoteDate('D/x.md', { folder: 'D', format }));
    fast(() => createPeriodicExtractor('week', { folder: 'W', format })('W/x.md'));
    fast(() => resolvePeriodicNote('month', { folder: 'M', format: `${'['.repeat(N)}MM` }, '2026-11-19'));
    expect(resolveDailyNote({ folder: '', format: '[KW]WW' }, new Date(2026, 10, 19)).name).toBe('KW47');
  });

  it('query aggregates (#77)', () => {
    const attempt = (src: string) => () => {
      try {
        parseQuery(src);
      } catch {
        /* invalid, but fast */
      }
    };
    fast(attempt(`TABLE SUM(${' '.repeat(N)}`));
    fast(attempt(`TABLE ${'sum('.repeat(N / 10)}`));
    fast(attempt(`TABLE MAX(${'a '.repeat(N)}`));
    fast(() => runQuery(`TABLE COUNT GROUP BY ${'('.repeat(N)}`, []));
    expect(() => parseQuery(`TABLE SUM(${'('.repeat(N)})`)).toThrow();
  });

  it('frontmatter, headings, block ids and slashes', () => {
    fast(() => parseFrontmatter(`---\n-:${' '.repeat(N)}\r\n---\n`));
    fast(() => extractHeadings(`# a${'  '.repeat(N)}\r`));
    fast(() => stripBlockIds(`x${'\t'.repeat(N)}y`));
    fast(() => trimSlashes(`${'/'.repeat(N)}x${'/'.repeat(N)}`));
    fast(() => buildCalendar([], { name: 'x', baseUrl: `https://a${'/'.repeat(N)}b`, includeDone: false, folder: `${'/'.repeat(N)}x`, tag: '', showTitles: true, lang: 'de' }));
  });
});

describe('tags and graph filters stay linear', () => {
  it('slashes, list brackets and long tag lines', () => {
    fast(() => normalizeTag(`${'/'.repeat(N)}x${'/'.repeat(N)}`));
    fast(() => renameTag(`---\ntags: [${' '.repeat(N)}a${' '.repeat(N)}\n---\n#a`, 'a', 'b'));
    fast(() => renameTag(`---\ntags: ${'['.repeat(N)}\n---\n`, 'a', 'b'));
    fast(() => tagBeforeCursor(`${' #'.repeat(N)}${'a'.repeat(N)}`));
    fast(() => tagBeforeCursor(`${'a'.repeat(N)}!`));
    fast(() => filterGraph(new LinkIndex([]), [], { folder: `${'/'.repeat(N)}x${'/'.repeat(N)}` }));
    const feed = { name: 'x', baseUrl: 'https://a', includeDone: false, folder: '', showTitles: true, lang: 'de' as const };
    const notes = [{ id: '1', path: 'a.md', content: `- [ ] x${' #'.repeat(N)}a 📅 2026-01-01`, updatedAt: 0 }];
    fast(() => buildCalendar(notes, { ...feed, tag: `${' '.repeat(N)}#${'('.repeat(N)}` }));
    fast(() => buildCalendar(notes, { ...feed, tag: 'a'.repeat(N) }));
    const pdf = '---\ntype: pdf\n---\n';
    fast(() => pdfNoteOf(pdf + '!['.repeat(N)));
    fast(() => pdfNoteOf(pdf + '![](' .repeat(N)));
    fast(() => pdfNoteOf(pdf + '![a]('.repeat(N) + ' '));
  });

  it('keeps the results', () => {
    expect(normalizeTag('#//a//b//')).toBe('a/b');
    expect(renameTag('---\ntags:  [a, b]  \n---\n', 'a', 'c')).toBe('---\ntags: [c, b]\n---\n');
    expect(tagBeforeCursor('x #𝔞b')).toEqual({ query: '𝔞b', from: 2 });
    expect(tagBeforeCursor('x#ab')).toBeNull();
  });
});

describe('the rewritten regexes keep their results', () => {
  it('task lines and done dates', () => {
    const [t] = parseTasks('- [x]   Steuer 📅 2026-11-30   ✅ 2026-11-29 ');
    expect(t).toMatchObject({ text: 'Steuer', done: true, doneDate: '2026-11-29', due: '2026-11-30' });
    expect(parseTasks('- [ ]    ')).toEqual([]);
    expect(setTaskStatus('- [x] a ✅ 2026-11-01', 0, 'open')).toBe('- [ ] a');
    expect(setTaskMeta('- [x] a 📅 2026-11-01 ✅ 2026-11-02', 0, { due: '2026-11-05' })).toBe('- [x] a 📅 2026-11-05 ✅ 2026-11-02');
    expect(nextDue('2 wochen', '2026-11-01')).toBe('2026-11-15');
    expect(nextDue('3tage', '2026-11-01')).toBe('2026-11-04');
    expect(nextDue('1234', '2026-11-01')).toBeNull();
    expect(rruleOf('0 weeks')).toBeNull();
    expect(rruleOf('12 monate')).toBe('FREQ=MONTHLY;INTERVAL=12');
  });

  it('frontmatter values and headings with closing hashes', () => {
    expect(parseFrontmatter('---\ntitle:   "Mein Titel"  \ntags:a, b\n---\nText').data).toEqual({ title: 'Mein Titel', tags: 'a, b' });
    expect(extractHeadings('## Titel ##\n# C# lernen\n### ###\n#  Zwei  Leer \n#kein').map((h) => h.text)).toEqual(['Titel', 'C# lernen', '###', 'Zwei Leer']);
  });

  it('block ids', () => {
    expect(stripBlockIds('Absatz ^abc\n^tabelle\nkein^id\nText ^x  ')).toBe('Absatz\n\nkein^id\nText');
  });
});

describe('AI memory regexes stay linear (#94)', () => {
  it('yaml, memory and OKF links', async () => {
    const m = await import('../src/index');
    fast(() => m.parseYaml(`!:${'  '.repeat(N)}`));
    fast(() => m.setFrontmatterValues(`---\n!:${'  '.repeat(N)}x\n---\n`, { type: 'X' }));
    fast(() => m.memoryMeta(`---\ntype: X\n---\n${'[['.repeat(N)}`, `${'/'.repeat(N)}a`));
    fast(() => m.isMemoryPath('AI-Memory/x.md', `${'/'.repeat(N)}AI-Memory${'/'.repeat(N)}`));
    fast(() => m.actorId(`${'-'.repeat(N)}x${'-'.repeat(N)}`));
    fast(() => m.addMemoryLogEntry(`x${'\n'.repeat(N)}y${'\n'.repeat(N)}`, '2026-01-01', 'Update', 'z'));
    fast(() => m.syncMemoryIndex(`x${'\n'.repeat(N)}`, 'h', [], [], false));
    fast(() => m.toOkfBundle([{ id: 'a', path: 'M/a.md', content: `[[${'[["#|\\'.repeat(N / 5)}` }], 'M', () => null));
    fast(() => m.fromOkfBundle([{ path: 'a.md', content: `[${'[\\'.repeat(N)}](${'[](!'.repeat(N / 5)}` }], 'M'));
    fast(() => new m.LinkIndex([{ id: 'a', path: 'a.md', content: `[${'[]('.repeat(N / 5)}` }]));
  });
});
