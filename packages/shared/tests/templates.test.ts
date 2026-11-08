import { describe, expect, it } from 'vitest';
import { fillTemplate, normalizeTemplates, templateUsesZettelId } from '../src/templates';

describe('normalizeTemplates', () => {
  it('starts empty and ignores anything that is not a list', () => {
    expect(normalizeTemplates(undefined)).toEqual([]);
    expect(normalizeTemplates({ id: 'x' })).toEqual([]);
  });

  it('drops broken entries and duplicate ids, fills missing fields', () => {
    const list = normalizeTemplates([
      { id: 'a', label: ' Projekt ', folder: '1 Projekte', content: '# {{title}}' },
      { id: 'a', label: 'Doppelt' },
      { label: 'ohne id' },
      null,
      { id: 'b', label: '', folder: 3, content: null },
    ]);
    expect(list).toEqual([
      { id: 'a', label: 'Projekt', folder: '1 Projekte', content: '# {{title}}' },
      { id: 'b', label: 'Ohne Namen', folder: '', content: '' },
    ]);
  });
});

describe('fillTemplate', () => {
  it('replaces all placeholders', () => {
    expect(fillTemplate('# {{title}}\n{{date}} {{zid}} {{title}}', { title: 'X', date: '2026-11-08', zid: '202611081200' })).toBe(
      '# X\n2026-11-08 202611081200 X'
    );
    expect(templateUsesZettelId('id: {{zid}}')).toBe(true);
    expect(templateUsesZettelId('# {{title}}')).toBe(false);
  });
});
