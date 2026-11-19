import { describe, expect, it } from 'vitest';
import { findInlineMath, findMath, hasMath, parseExportInlines, parseMarkdownForExport } from '../src/index';

describe('math formulas (#85)', () => {
  it('finds inline formulas and leaves prices and code alone', () => {
    expect(findInlineMath('Energie $E = mc^2$ und $x$.').map((m) => m.tex)).toEqual(['E = mc^2', 'x']);
    expect(findInlineMath('Kostet $5 und $10 pro Stück')).toEqual([]);
    expect(findInlineMath('Ein \\$ Zeichen und $ a $ nicht')).toEqual([]);
    expect(findInlineMath('`$x$` ist Code, $y$ nicht').map((m) => m.tex)).toEqual(['y']);
    expect(findInlineMath('``a`$b$`` und $c$, offen ` $d$').map((m) => m.tex)).toEqual(['c', 'd']);
    expect(findInlineMath('Summe $$\\sum_i i$$ inline')).toEqual([{ from: 6, to: 18, tex: '\\sum_i i', display: true, block: false }]);
  });

  it('finds display blocks with offsets and skips fenced code', () => {
    const text = ['# Titel', '$$', 'a^2 + b^2 = c^2', '$$', 'Text $x$', '```', '$y$', '```', '$$ \\int_0^1 f $$'].join('\n');
    const math = findMath(text);
    expect(math.map((m) => [m.tex, m.block])).toEqual([
      ['a^2 + b^2 = c^2', true],
      ['x', false],
      ['\\int_0^1 f', true],
    ]);
    expect(text.slice(math[0].from, math[0].to)).toBe('$$\na^2 + b^2 = c^2\n$$');
    expect(text.slice(math[2].from, math[2].to)).toBe('$$ \\int_0^1 f $$');
    // unterminated or interrupted by a blank line: no formula
    expect(findMath('$$\na\n\nb\n$$').filter((m) => m.block)).toEqual([]);
    expect(hasMath('nur $5')).toBe(false);
  });

  it('exports formulas as inlines and blocks', () => {
    expect(parseExportInlines('Mit $a_1$ und **fett**')).toEqual([
      { type: 'text', text: 'Mit ' },
      { type: 'math', tex: 'a_1', display: false },
      { type: 'text', text: ' und ' },
      { type: 'strong', text: 'fett' },
    ]);
    const doc = parseMarkdownForExport('T', 'Vorher\n$$\n\\frac{1}{2}\n$$\nNachher');
    expect(doc.blocks).toEqual([
      { type: 'paragraph', inlines: [{ type: 'text', text: 'Vorher' }] },
      { type: 'math', tex: '\\frac{1}{2}' },
      { type: 'paragraph', inlines: [{ type: 'text', text: 'Nachher' }] },
    ]);
  });
});
