import { describe, expect, it } from 'vitest';
import { pdfNoteMarkdown, pdfNoteOf, pdfNoteTitle } from '../src/index.js';

describe('PDF notes', () => {
  it('builds the note markdown and reads it back', () => {
    const md = pdfNoteMarkdown('Bericht.pdf', '/api/files/abc');
    expect(md).toBe('---\ntype: pdf\n---\n![Bericht.pdf](/api/files/abc)\n');
    expect(pdfNoteOf(md)).toEqual({ url: '/api/files/abc', name: 'Bericht.pdf' });
  });

  it('keeps the embed valid for names with brackets or newlines', () => {
    const md = pdfNoteMarkdown('a [b]\nc.pdf', '/api/files/x');
    expect(pdfNoteOf(md)).toEqual({ url: '/api/files/x', name: 'a (b) c.pdf' });
  });

  it('returns null without the type marker', () => {
    expect(pdfNoteOf('![Bericht.pdf](/api/files/abc)\n')).toBeNull();
    expect(pdfNoteOf('---\ntags: x\n---\n![Bericht.pdf](/api/files/abc)\n')).toBeNull();
  });

  it('returns null with the marker but no embed', () => {
    expect(pdfNoteOf('---\ntype: pdf\n---\nNur Text\n')).toBeNull();
    expect(pdfNoteOf('---\ntype: pdf\n---\n![Bild](https://example.com/a.png)\n')).toBeNull();
  });

  it('accepts the marker case-insensitively', () => {
    expect(pdfNoteOf('---\nType: PDF\n---\n![x](/files/a.pdf)\n')).toEqual({ url: '/files/a.pdf', name: 'x' });
  });

  it('ignores body text after the embed', () => {
    const md = `${pdfNoteMarkdown('Bericht.pdf', '/api/files/abc')}\nNotizen dazu\n![Bild](/img.png)\n`;
    expect(pdfNoteOf(md)).toEqual({ url: '/api/files/abc', name: 'Bericht.pdf' });
  });

  it('derives the title from the file name', () => {
    expect(pdfNoteTitle('Bericht.PDF')).toBe('Bericht');
    expect(pdfNoteTitle('a.b.pdf')).toBe('a.b');
    expect(pdfNoteTitle('.pdf')).toBe('PDF');
  });
});
