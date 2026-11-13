import { describe, expect, it } from 'vitest';
import { pdfNoteOf, safeUrl } from '../src/index.js';

describe('safeUrl', () => {
  it('keeps http(s), relative and mail links', () => {
    expect(safeUrl('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeUrl('http://example.org')).toBe('http://example.org');
    expect(safeUrl('/api/files/abc')).toBe('/api/files/abc');
    expect(safeUrl('notes/x.md')).toBe('notes/x.md');
    expect(safeUrl('#heading')).toBe('#heading');
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeUrl('mailto:a@b.c', 'media')).toBeNull();
  });

  it('drops script and other dangerous schemes, also when obfuscated', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:x', '\u0001javascript:x', 'vbscript:x', 'data:text/html,<script>x</script>', 'blob:https://x/1', 'file:///etc/passwd', '\\evil\share']) {
      expect(safeUrl(bad), bad).toBeNull();
      expect(safeUrl(bad, 'media', true), bad).toBeNull();
    }
    expect(safeUrl(undefined)).toBeNull();
    expect(safeUrl('')).toBeNull();
  });

  it('allows data images only for media when asked', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(safeUrl(png, 'media', true)).toBe(png);
    expect(safeUrl(png, 'media')).toBeNull();
    expect(safeUrl(png)).toBeNull();
  });

  it('never hands a script URL to the PDF viewer', () => {
    expect(pdfNoteOf('---\ntype: pdf\n---\n![x.pdf](javascript:alert(1))\n')).toBeNull();
  });
});
