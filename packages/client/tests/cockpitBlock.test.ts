import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { fencedBlockAt } from '../src/editor/cockpit';

describe('cockpit blocks in the editor', () => {
  const doc = Text.of(['# Note', '', '```cockpit', '{ "title": "a" }', '```', '', '````cockpit', '```', '````', 'after']);

  it('finds the block from its opening fence to the end of the closing one', () => {
    const r = fencedBlockAt(doc, doc.line(3).from)!;
    expect(doc.sliceString(r.from, r.to)).toBe('```cockpit\n{ "title": "a" }\n```');
  });

  it('needs a closing fence at least as long as the opening one', () => {
    const r = fencedBlockAt(doc, doc.line(7).from)!;
    expect(doc.sliceString(r.from, r.to)).toBe('````cockpit\n```\n````');
  });

  it('is null away from a fence and runs to the end without a closing one', () => {
    expect(fencedBlockAt(doc, 0)).toBeNull();
    const open = Text.of(['```cockpit', 'source: gitlab.mrs']);
    expect(fencedBlockAt(open, 0)).toEqual({ from: 0, to: open.length });
  });
});
