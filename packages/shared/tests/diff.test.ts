import { describe, expect, it } from 'vitest';
import { diffLines, diffStats } from '../src/diff';

describe('diffLines', () => {
  it('marks added and removed lines with line numbers', () => {
    const d = diffLines('a\nb\nc', 'a\nx\nc\nd');
    expect(d.map((l) => `${l.kind}:${l.text}`)).toEqual(['same:a', 'del:b', 'add:x', 'same:c', 'add:d']);
    expect(d[1].oldLine).toBe(2);
    expect(d[2].newLine).toBe(2);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });
  it('handles empty texts', () => {
    expect(diffLines('', 'a\nb').map((l) => l.kind)).toEqual(['add', 'add']);
    expect(diffLines('a', '')).toEqual([{ kind: 'del', text: 'a', oldLine: 1 }]);
    expect(diffLines('same', 'same').every((l) => l.kind === 'same')).toBe(true);
  });
});
