import { describe, expect, it } from 'vitest';
import { countWords, proseOf, writingStats } from '../src/writing';

describe('writing stats', () => {
  it('counts words, ignoring Markdown markers', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('# Überschrift\n\n- eins **zwei** drei\n> Zitat — Ende')).toBe(6);
    expect(countWords('| a | b |\n|---|---|')).toBe(2);
    expect(countWords('Version 2.1 ist da')).toBe(4);
  });

  it('leaves out frontmatter and fenced code blocks', () => {
    const note = '---\ntags: a b c\ntitle: Viele Wörter hier\n---\nHallo Welt\n\n```js\nconst x = 1;\n```\n\nNach dem Code\n~~~\nnoch mehr code\n~~~\n';
    expect(proseOf(note)).toBe('Hallo Welt\n\n\nNach dem Code\n');
    expect(writingStats(note)).toEqual({ words: 5, chars: 'Hallo WeltNach dem Code'.length, minutes: 1 });
  });

  it('treats an unclosed fence as code until the end', () => {
    expect(countWords(proseOf('eins\n```\nzwei drei'))).toBe(1);
    // A shorter or different fence does not close the block
    expect(countWords(proseOf('````\n```\ncode\n~~~\n````\nwort'))).toBe(1);
  });

  it('computes the reading time at 200 words per minute', () => {
    expect(writingStats('').minutes).toBe(0);
    expect(writingStats('ein Wort').minutes).toBe(1);
    expect(writingStats(Array(1000).fill('wort').join(' ')).minutes).toBe(5);
  });
});
