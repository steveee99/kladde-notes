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
});
