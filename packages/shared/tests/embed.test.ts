import { describe, expect, it } from 'vitest';
import { embedSection, embedsOf, parseEmbedLine, stripBlockIds } from '../src/embed';
import { LinkIndex, renameWikiLinks } from '../src/links';

const note = [
  '---',
  'title: Projekt',
  '---',
  '# Projekt',
  'Intro text.',
  '',
  '## Status',
  'Läuft gut.',
  '- [ ] Bericht schreiben',
  '### Details',
  'Mehr.',
  '## Nächstes',
  'Ein Absatz',
  'über zwei Zeilen ^absatz',
  '',
  '- Punkt eins ^p1',
  '  - Unterpunkt',
  '- Punkt zwei',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '^tabelle',
].join('\n');

describe('embeds', () => {
  it('parses embed lines with headings, blocks and aliases', () => {
    expect(parseEmbedLine('![[Projekt]]')).toEqual({ target: 'Projekt', heading: null, block: null, alias: null });
    expect(parseEmbedLine('  ![[Projekt#Status]] ')).toMatchObject({ target: 'Projekt', heading: 'Status' });
    expect(parseEmbedLine('![[Projekt#Status#Details|Mehr]]')).toMatchObject({ heading: 'Details', alias: 'Mehr' });
    expect(parseEmbedLine('![[Projekt.md#^p1]]')).toMatchObject({ target: 'Projekt', block: 'p1', heading: null });
    expect(parseEmbedLine('![[foto.png]]')).toBeNull();
    expect(parseEmbedLine('Text ![[Projekt]]')).toBeNull();
    expect(parseEmbedLine('[[Projekt]]')).toBeNull();
  });

  it('finds embed lines outside code', () => {
    expect(embedsOf('![[A]]\n```\n![[B]]\n```\n![[C#x]]').map((e) => e.target)).toEqual(['A', 'C']);
  });

  it('cuts out the whole note without frontmatter', () => {
    const s = embedSection(note, { heading: null, block: null })!;
    expect(s.startLine).toBe(3);
    expect(s.text.startsWith('# Projekt\nIntro text.')).toBe(true);
  });

  it('cuts out a section with its subsections and keeps the source line', () => {
    const s = embedSection(note, { heading: 'status', block: null })!;
    expect(s.text).toBe('## Status\nLäuft gut.\n- [ ] Bericht schreiben\n### Details\nMehr.');
    expect(s.startLine).toBe(6);
    expect(note.split('\n')[s.startLine + 2]).toBe('- [ ] Bericht schreiben');
    expect(embedSection(note, { heading: 'Gibt es nicht', block: null })).toBeNull();
  });

  it('cuts out blocks: paragraphs, list items with children, the block above a lone id', () => {
    expect(embedSection(note, { heading: null, block: 'absatz' })).toEqual({ text: 'Ein Absatz\nüber zwei Zeilen ^absatz', startLine: 12 });
    expect(embedSection(note, { heading: null, block: 'p1' })).toEqual({ text: '- Punkt eins ^p1\n  - Unterpunkt', startLine: 15 });
    expect(embedSection(note, { heading: null, block: 'tabelle' })!.text).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(embedSection(note, { heading: null, block: 'nope' })).toBeNull();
  });

  it('hides block ids without changing the line count', () => {
    const text = 'Ein Absatz\nüber zwei Zeilen ^absatz\n^tabelle';
    expect(stripBlockIds(text)).toBe('Ein Absatz\nüber zwei Zeilen\n');
  });

  it('counts embeds as links and rewrites them on rename', () => {
    const index = new LinkIndex([
      { id: 'a', path: 'Projekt.md', content: '# Projekt' },
      { id: 'b', path: 'Übersicht.md', content: '![[Projekt#Status]]\n![[Projekt#^p1|Punkt]]' },
    ]);
    expect(index.outgoing('b')).toEqual(['a']);
    expect(index.backlinks('a')).toEqual(['b']);
    expect(renameWikiLinks('![[Projekt#Status]]\n![[Projekt#^p1|Punkt]]', 'Projekt', 'Vorhaben')).toBe('![[Vorhaben#Status]]\n![[Vorhaben#^p1|Punkt]]');
  });
});
