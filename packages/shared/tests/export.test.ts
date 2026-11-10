import { describe, expect, it } from 'vitest';
import { inlinesToPlainText, parseMarkdownForExport, safeExportFilename, stripFrontmatter } from '../src/export';

describe('note export parser', () => {
  it('strips YAML frontmatter cleanly while preserving horizontal rules in body', () => {
    const md = '---\ntitle: Projektplan\ntags: [arbeit, wichtig]\nstatus: aktiv\n---\n\n# Projektplan\n\nText danach.\n\n---\n\nWeiterer Abschnitt.';
    expect(stripFrontmatter(md)).toBe('# Projektplan\n\nText danach.\n\n---\n\nWeiterer Abschnitt.');
    expect(stripFrontmatter('Nur Text\nohne Frontmatter.')).toBe('Nur Text\nohne Frontmatter.');
    expect(stripFrontmatter('---\n---\nNach leerem Frontmatter')).toBe('Nach leerem Frontmatter');
  });

  it('sanitizes export filenames', () => {
    expect(safeExportFilename('Projekt: "A/B" * Plan?', 'docx')).toBe('Projekt- -A-B- - Plan-.docx');
    expect(safeExportFilename('', 'pdf')).toBe('Notiz.pdf');
  });

  it('parses headings, lists, tasks, quotes, code, tables, images, footnotes and inline styles without frontmatter', () => {
    const note = [
      '---',
      'id: 20261110',
      'status: entwurf',
      '---',
      '',
      'Einleitender **fetter** und *kursiver* Absatz mit `Code`, ~~alt~~, [[Zielnotiz|Linktext]] und [Web](https://example.com)[^1].',
      '',
      '## Aufgaben',
      '- [ ] Offen 📅 2026-11-10',
      '- [x] Erledigt',
      '',
      '> Zitatzeile',
      '',
      '| Spalte A | Spalte B |',
      '| :--- | ---: |',
      '| Links | Rechts |',
      '',
      '```mermaid',
      'graph TD; A-->B;',
      '```',
      '',
      '![Skizze](/api/files/abc123)',
      '',
      '---',
      '',
      '[^1]: Fußnote.',
    ].join('\n');

    const doc = parseMarkdownForExport('Testnotiz', note);
    expect(doc.hasLeadingH1).toBe(false);
    expect(doc.body.includes('status: entwurf')).toBe(false);

    const types = doc.blocks.map((b) => b.type);
    expect(types).toEqual(['paragraph', 'heading', 'list', 'blockquote', 'table', 'code', 'image', 'hr', 'footnote']);

    const p = doc.blocks[0];
    if (p.type === 'paragraph') {
      expect(inlinesToPlainText(p.inlines)).toBe(
        'Einleitender fetter und kursiver Absatz mit Code, alt, Linktext und Web[1].'
      );
    }

    const list = doc.blocks[2];
    if (list.type === 'list') {
      expect(list.items[0].checked).toBe(false);
      expect(list.items[1].checked).toBe(true);
    }

    const table = doc.blocks[4];
    if (table.type === 'table') {
      expect(table.align).toEqual(['left', 'right']);
      expect(inlinesToPlainText(table.rows[0][1])).toBe('Rechts');
    }

    const code = doc.blocks[5];
    if (code.type === 'code') {
      expect(code.lang).toBe('mermaid');
      expect(code.code).toBe('graph TD; A-->B;');
    }
  });

  it('extracts headings skipping frontmatter and code fences and emits toc blocks for ##TOC##', async () => {
    const { extractHeadings } = await import('../src/markdown');
    const note = [
      '---',
      'title: Architektur',
      '# not a heading: true',
      '---',
      '',
      'Einleitung direkt davor',
      '##TOC##',
      'Text direkt danach',
      '',
      '# Überblick',
      '```md',
      '# Ignoriert im Codeblock',
      '```',
      '## **Details** & [[Verlinkung|Link]] `code`',
      '### Unterpunkt',
    ].join('\n');

    const headings = extractHeadings(note);
    expect(headings.map((h) => ({ level: h.level, text: h.text, line: h.line }))).toEqual([
      { level: 1, text: 'Überblick', line: 10 },
      { level: 2, text: 'Details & Link code', line: 14 },
      { level: 3, text: 'Unterpunkt', line: 15 },
    ]);
    // Verify character offsets match start of heading lines in original string
    expect(note.slice(headings[0].from).startsWith('# Überblick')).toBe(true);
    expect(note.slice(headings[1].from).startsWith('## **Details**')).toBe(true);

    const doc = parseMarkdownForExport('Architektur', note);
    expect(doc.blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'toc',
      'paragraph',
      'heading',
      'code',
      'heading',
      'heading',
    ]);
    const tocBlock = doc.blocks[1];
    if (tocBlock.type === 'toc') {
      expect(tocBlock.items).toEqual([
        { level: 1, text: 'Überblick' },
        { level: 2, text: 'Details & Link code' },
        { level: 3, text: 'Unterpunkt' },
      ]);
    }
  });
});

