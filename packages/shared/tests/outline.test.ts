import { describe, expect, it } from 'vitest';
import { activeHeadingIndex, applyTextChanges, extractHeadings, moveSectionChanges, sectionEnd } from '../src/index';

const doc = ['# A', 'a', '## A1', 'a1', '# B', 'b', '## B1', 'b1', '# C', 'c', ''].join('\n');

function move(content: string, index: number, before: number | null): string | null {
  const changes = moveSectionChanges(content, extractHeadings(content), index, before);
  return changes ? applyTextChanges(content, changes) : null;
}

describe('outline', () => {
  it('finds the section a position is in', () => {
    const h = extractHeadings(doc);
    expect(activeHeadingIndex(h, 0)).toBe(0);
    expect(activeHeadingIndex(h, doc.indexOf('a1'))).toBe(1);
    expect(activeHeadingIndex(h, doc.indexOf('b1'))).toBe(3);
    expect(activeHeadingIndex(extractHeadings('intro\n# A\n'), 0)).toBe(-1);
  });

  it('ends a section at the next heading of the same or a higher level', () => {
    const h = extractHeadings(doc);
    expect(sectionEnd(h, 0, doc.length)).toBe(doc.indexOf('# B'));
    expect(sectionEnd(h, 1, doc.length)).toBe(doc.indexOf('# B'));
    expect(sectionEnd(h, 4, doc.length)).toBe(doc.length);
  });

  it('moves a section with its subsections in front of another heading', () => {
    expect(move(doc, 2, 0)).toBe(['# B', 'b', '## B1', 'b1', '# A', 'a', '## A1', 'a1', '# C', 'c', ''].join('\n'));
    expect(move(doc, 0, 4)).toBe(['# B', 'b', '## B1', 'b1', '# A', 'a', '## A1', 'a1', '# C', 'c', ''].join('\n'));
  });

  it('moves a section to the end', () => {
    expect(move(doc, 0, null)).toBe(['# B', 'b', '## B1', 'b1', '# C', 'c', '# A', 'a', '## A1', 'a1', ''].join('\n'));
    expect(move('# A\na\n# B\nb', 0, null)).toBe('# B\nb\n# A\na');
  });

  it('moves the last section, which has no line break at the end', () => {
    expect(move('# A\na\n# B\nb', 1, 0)).toBe('# B\nb\n# A\na');
  });

  it('refuses moves into itself or to where the section already is', () => {
    expect(move(doc, 0, 1)).toBeNull();
    expect(move(doc, 0, 2)).toBeNull();
    expect(move(doc, 0, 0)).toBeNull();
    expect(move(doc, 4, null)).toBeNull();
  });
});
