import { describe, expect, it } from 'vitest';
import { mindmapText, mindmapToMermaid, parseMindmap } from '../src/diagram';

describe('mindmap', () => {
  it('uses the first plain line as the center and nests list items', () => {
    const map = parseMindmap('Projekt X\n- Ziele\n  - Umsatz\n  - Reichweite\n- Team\n\t- Anna');
    expect(map.text).toBe('Projekt X');
    expect(map.children.map((c) => c.text)).toEqual(['Ziele', 'Team']);
    expect(map.children[0].children.map((c) => c.text)).toEqual(['Umsatz', 'Reichweite']);
    expect(map.children[1].children[0].text).toBe('Anna');
  });

  it('takes a single top-level item as the center, several get a generic one', () => {
    expect(parseMindmap('- Wurzel\n  - Ast').text).toBe('Wurzel');
    const many = parseMindmap('- A\n- B');
    expect(many.text).toBe('Mindmap');
    expect(many.children).toHaveLength(2);
  });

  it('nests headings and the lists below them', () => {
    const map = parseMindmap('# Buch\n## Kapitel 1\n- Idee\n  - Detail\n## Kapitel 2');
    expect(map.text).toBe('Buch');
    expect(map.children.map((c) => c.text)).toEqual(['Kapitel 1', 'Kapitel 2']);
    expect(map.children[0].children[0].children[0].text).toBe('Detail');
  });

  it('shows links and emphasis as plain text', () => {
    expect(mindmapText('[[Projekt X|das Projekt]] und **fett** mit [Link](https://x.de) und `code`')).toBe('das Projekt und fett mit Link und code');
    expect(mindmapText('- [ ] keine Aufgabe'.replace(/^- \[ \] /, ''))).toBe('keine Aufgabe');
  });

  it('emits safe Mermaid labels', () => {
    const src = mindmapToMermaid('Plan (v2)\n- Sag "hallo" [jetzt]\n  - ((Kreis))');
    expect(src).toBe('mindmap\n  root(("Plan (v2)"))\n    n1("Sag #quot;hallo#quot; [jetzt]")\n      n2("((Kreis))")');
  });
});
