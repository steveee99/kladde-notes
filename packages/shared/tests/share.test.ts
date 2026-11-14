import { describe, expect, it } from 'vitest';
import { sharedToMarkdown } from '../src/share';

describe('sharedToMarkdown', () => {
  it('turns title and url into a Markdown link', () => {
    expect(sharedToMarkdown({ title: 'Ein Artikel', url: 'https://example.com/a' })).toEqual({
      title: 'Ein Artikel',
      body: '[Ein Artikel](https://example.com/a)',
    });
  });

  it('keeps shared text below the link', () => {
    expect(sharedToMarkdown({ title: 'Seite', text: 'Spannend:\nZeile zwei', url: 'https://example.com' }).body).toBe(
      '[Seite](https://example.com)\n\nSpannend:\nZeile zwei'
    );
  });

  it('finds the url inside the text (Android apps)', () => {
    expect(sharedToMarkdown({ text: 'https://example.com/x' })).toEqual({ title: 'example.com', body: '[example.com](https://example.com/x)' });
    expect(sharedToMarkdown({ text: 'Lesenswert https://www.example.com/x' })).toEqual({
      title: 'Lesenswert',
      body: '[Lesenswert](https://www.example.com/x)',
    });
    expect(sharedToMarkdown({ title: 'Titel', text: 'Lesenswert https://example.com/x' }).body).toBe('[Titel](https://example.com/x)\n\nLesenswert');
  });

  it('drops a text or title that only repeats the url or title', () => {
    expect(sharedToMarkdown({ title: 'T', text: 'T', url: 'https://e.com' }).body).toBe('[T](https://e.com)');
    expect(sharedToMarkdown({ title: 'https://e.com/', text: 'https://e.com', url: 'https://e.com' }).body).toBe('[e.com](https://e.com)');
  });

  it('removes characters that break the link text or the note title', () => {
    expect(sharedToMarkdown({ title: 'A [b] c: d/e', url: 'https://e.com' })).toEqual({ title: 'A b c d e', body: '[A b c: d/e](https://e.com)' });
  });

  it('keeps plain text as is and never links other schemes', () => {
    expect(sharedToMarkdown({ text: '  Nur ein Gedanke\n- mit Liste ' })).toEqual({ title: 'Nur ein Gedanke', body: 'Nur ein Gedanke\n- mit Liste' });
    expect(sharedToMarkdown({ title: 'X', url: 'javascript:alert(1)' }).body).toBe('javascript:alert(1)');
    expect(sharedToMarkdown({})).toEqual({ title: '', body: '' });
  });
});
