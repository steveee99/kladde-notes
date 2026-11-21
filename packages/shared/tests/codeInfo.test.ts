import { describe, expect, it } from 'vitest';
import { isHighlightedLine, parseCodeInfo } from '../src/codeInfo';

describe('parseCodeInfo', () => {
  it('reads a plain language', () => {
    expect(parseCodeInfo('TS')).toEqual({ lang: 'ts', title: '', highlight: [], lineNumbers: null, lineStart: 1, collapse: null });
    expect(parseCodeInfo('').lang).toBe('');
  });

  it('reads title, highlighted lines and line numbers', () => {
    const info = parseCodeInfo('ts title="src/vault file.ts" {3-4, 7} showLineNumbers');
    expect(info.lang).toBe('ts');
    expect(info.title).toBe('src/vault file.ts');
    expect(info.highlight).toEqual([
      [3, 4],
      [7, 7],
    ]);
    expect(info.lineNumbers).toBe(true);
    expect(isHighlightedLine(info, 4)).toBe(true);
    expect(isHighlightedLine(info, 5)).toBe(false);
  });

  it('accepts unquoted and single-quoted values and other keys', () => {
    expect(parseCodeInfo('py filename=main.py').title).toBe('main.py');
    expect(parseCodeInfo("sh file='run it.sh'").title).toBe('run it.sh');
    expect(parseCodeInfo('js showLineNumbers=10')).toMatchObject({ lineNumbers: true, lineStart: 10 });
    expect(parseCodeInfo('js noLineNumbers collapse').lineNumbers).toBe(false);
    expect(parseCodeInfo('js collapse').collapse).toBe(true);
    expect(parseCodeInfo('js noCollapse').collapse).toBe(false);
  });

  it('has no language when the info starts with an option', () => {
    expect(parseCodeInfo('title="a.txt"').lang).toBe('');
    expect(parseCodeInfo('{1}').lang).toBe('');
    expect(parseCodeInfo('ts{2}').highlight).toEqual([[2, 2]]);
    expect(parseCodeInfo('ts{2}').lang).toBe('ts');
  });

  it('ignores broken input and stays bounded', () => {
    expect(parseCodeInfo('ts {a-b, 5-2, 0, 3}').highlight).toEqual([[3, 3]]);
    expect(parseCodeInfo('ts title="unclosed').title).toBe('unclosed');
    expect(parseCodeInfo(`ts {${Array.from({ length: 500 }, (_, i) => i + 1).join(',')}}`).highlight).toHaveLength(64);
    expect(parseCodeInfo(`ts title="${'x'.repeat(5000)}"`).title.length).toBeLessThanOrEqual(200);
    expect(parseCodeInfo('ts {1-99999999}').highlight).toEqual([[1, 1_000_000]]);
  });
});
