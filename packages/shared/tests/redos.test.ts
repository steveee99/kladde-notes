import { describe, expect, it } from 'vitest';
import { buildCalendar, nextDue, parseFrontmatter, parseTasks, rruleOf, setTaskMeta, setTaskStatus, stripBlockIds, extractHeadings, trimSlashes } from '../src/index';

/** Runs `fn` and fails if it takes longer than a linear scan should (the CodeQL polynomial-ReDoS inputs) */
function fast(fn: () => unknown, ms = 250) {
  const start = performance.now();
  fn();
  expect(performance.now() - start).toBeLessThan(ms);
}

const N = 50_000;

describe('regexes stay linear on hostile input', () => {
  it('tasks with long runs of whitespace', () => {
    fast(() => parseTasks(`* [ ] ${' '.repeat(N)}\r`));
    fast(() => parseTasks(`- [ ] x${' '.repeat(N)}y`));
    fast(() => setTaskMeta(`* [ ] x${' '.repeat(N)}✅`, 0, { due: '2026-11-20' }));
    fast(() => nextDue(`${' '.repeat(N)}x`, null));
    fast(() => rruleOf(`1${' '.repeat(N)}`));
    fast(() => rruleOf(`!${'00'.repeat(N)}`));
    fast(() => nextDue(`${'00'.repeat(N)}!`, null));
  });

  it('frontmatter, headings, block ids and slashes', () => {
    fast(() => parseFrontmatter(`---\n-:${' '.repeat(N)}\r\n---\n`));
    fast(() => extractHeadings(`# a${'  '.repeat(N)}\r`));
    fast(() => stripBlockIds(`x${'\t'.repeat(N)}y`));
    fast(() => trimSlashes(`${'/'.repeat(N)}x${'/'.repeat(N)}`));
    fast(() => buildCalendar([], { name: 'x', baseUrl: `https://a${'/'.repeat(N)}b`, includeDone: false, folder: `${'/'.repeat(N)}x`, tag: '', showTitles: true, lang: 'de' }));
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
