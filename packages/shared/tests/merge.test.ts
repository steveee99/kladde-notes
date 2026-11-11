import { describe, expect, it } from 'vitest';
import { merge3, resolveCursor, textChanges } from '../src/merge';

const apply = (a: string, changes: { from: number; to: number; insert: string }[]) => {
  let out = a;
  for (const c of [...changes].sort((x, y) => y.from - x.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
};

describe('merge3', () => {
  it('takes the only changed side', () => {
    expect(merge3('a', 'a', 'b')).toEqual({ text: 'b', clean: true });
    expect(merge3('a', 'b', 'a')).toEqual({ text: 'b', clean: true });
  });

  it('merges changes in different lines', () => {
    const base = 'one\ntwo\nthree\nfour';
    const r = merge3(base, 'one!\ntwo\nthree\nfour', 'one\ntwo\nthree\nfour\nfive');
    expect(r).toEqual({ text: 'one!\ntwo\nthree\nfour\nfive', clean: true });
  });

  it('merges changes on neighbouring lines', () => {
    const r = merge3('a\nb\nc', 'A\nb\nc', 'a\nB\nc');
    expect(r).toEqual({ text: 'A\nB\nc', clean: true });
  });

  it('merges edits to different words of the same paragraph', () => {
    const base = '# T\n\nThe quick brown fox jumps.';
    const r = merge3(base, '# T\n\nThe very quick brown fox jumps.', '# T\n\nThe quick brown fox jumps high.');
    expect(r).toEqual({ text: '# T\n\nThe very quick brown fox jumps high.', clean: true });
  });

  it('merges a new line before a line the other side edited', () => {
    const r = merge3('x\nline', 'x\nnew\nline', 'x\nline edited');
    expect(r).toEqual({ text: 'x\nnew\nline edited', clean: true });
  });

  it('keeps both when the same words changed', () => {
    const r = merge3('Hello world', 'Hello there', 'Hello folks');
    expect(r.clean).toBe(false);
    expect(r.text).toContain('there');
    expect(r.text).toContain('folks');
  });

  it('keeps identical changes once', () => {
    expect(merge3('a\nb', 'a\nB\nc', 'a\nB\nc')).toEqual({ text: 'a\nB\nc', clean: true });
    expect(merge3('a\nb\nc', 'a\nX\nc\nd', 'a\nX\nc')).toEqual({ text: 'a\nX\nc\nd', clean: true });
  });

  it('merges three devices one after another (offline third device)', () => {
    const base = '- [ ] milk\n- [ ] bread\n- [ ] eggs';
    const a = '- [x] milk\n- [ ] bread\n- [ ] eggs';
    const b = '- [ ] milk\n- [ ] bread\n- [ ] eggs\n- [ ] butter';
    const server = merge3(base, a, b).text;
    const offline = '- [ ] milk\n- [x] bread\n- [ ] eggs';
    expect(merge3(base, offline, server)).toEqual({ text: '- [x] milk\n- [x] bread\n- [ ] eggs\n- [ ] butter', clean: true });
  });
});

describe('textChanges', () => {
  const cases: [string, string][] = [
    ['', 'abc'],
    ['abc', ''],
    ['a\nb\nc', 'a\nB\nc'],
    ['a\nb', 'a\nb\nc'],
    ['a\nb\nc', 'a\nb'],
    ['a\nb\nc', 'b\nc'],
    ['x', 'x\n'],
    ['x\n', 'x'],
    ['one two three\nfour', 'zero one two three\nfour five'],
    ['a\n\nb', 'a\nb'],
    ['a\nb\nc\nd', 'a\nc\nd\ne'],
  ];
  it.each(cases)('turns %j into %j', (a, b) => {
    expect(apply(a, textChanges(a, b))).toBe(b);
  });

  it('touches only the changed characters', () => {
    expect(textChanges('Hello world\nnext', 'Hello brave world\nnext')).toEqual([{ from: 6, to: 6, insert: 'brave ' }]);
  });
});

describe('resolveCursor', () => {
  it('keeps the offset when the text before it matches', () => {
    expect(resolveCursor('Hallo Welt', 5, 'Hallo')).toBe(5);
  });

  it('finds the spot again when text was inserted before it', () => {
    expect(resolveCursor('Neu: Hallo Welt', 5, 'Hallo')).toBe(10);
  });

  it('falls back to the end of the context when the receiver changed text inside it', () => {
    // The sender's context "Zeile\n\nalpha betXY" crosses the line start where the receiver typed "Hallo "
    expect(resolveCursor('Zeile\n\nHallo alpha betXYa', 18, 'Zeile\n\nalpha betXY')).toBe(24);
  });

  it('takes the occurrence nearest to the offset and clamps to the text', () => {
    expect(resolveCursor('ab ab ab', 7, 'ab')).toBe(8);
    expect(resolveCursor('ab ab ab', 1, 'ab')).toBe(2);
    expect(resolveCursor('kurz', 99, 'nirgends')).toBe(4);
  });
});
