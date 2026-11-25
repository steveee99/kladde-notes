import { describe, expect, it } from 'vitest';
import {
  applyTypeDefaults,
  customTypeOf,
  findNoteType,
  isHiddenPath,
  isNoteTypeName,
  isNoteTypePath,
  noteTypeFileName,
  noteTypesOf,
  parseNoteType,
  propertiesAt,
  setCustomType,
  typeValues,
  writeNoteType,
  type NoteType,
} from '../src/index.js';

const meeting: NoteType = {
  name: 'Team Meeting',
  aliases: ['Jour fixe'],
  showFrontmatter: false,
  position: 'right',
  properties: [
    { name: 'Date', type: 'date', options: [], default: '{{date}}', position: '' },
    { name: 'Status', type: 'select', options: ['planned', 'done: yes'], default: 'planned', position: 'top' },
    { name: 'People', type: 'multiselect', options: ['Anna', 'Ben'], default: 'Anna, Ben', position: '' },
    { name: 'Public', type: 'checkbox', options: [], default: '', position: 'hidden' },
  ],
};
const path = (n: number) => noteTypeFileName(`0b9f6c1e-3d52-4c0e-9a7e-5f1d2c3b4a6${n}`);

describe('custom note types', () => {
  it('hides definition notes', () => {
    expect(isNoteTypePath(path(1))).toBe(true);
    expect(isNoteTypePath(`A/${path(1)}`)).toBe(true);
    expect(isHiddenPath(path(1))).toBe(true);
    expect(isNoteTypePath('_type-notes.md')).toBe(false);
    expect(isNoteTypePath('my_type-0b9f6c1e-3d52.md')).toBe(false);
  });

  it('writes and reads a definition', () => {
    expect(parseNoteType(writeNoteType('', meeting))).toEqual(meeting);
    // Other frontmatter and the body stay
    expect(writeNoteType('---\nkeep: 1\n---\nText\n', meeting)).toMatch(/keep: 1[\s\S]*\nText\n$/);
  });

  it('reads broken definitions defensively', () => {
    expect(parseNoteType('no frontmatter')).toBeNull();
    expect(parseNoteType('---\ntype: note-type\n---\n')).toBeNull();
    expect(parseNoteType('---\ntype: note-type\nname: "a: b"\n---\n')).toBeNull();
    const t = parseNoteType('---\ntype: note-type\nname: X\nposition: left\nproperties:\n  - name: type\n  - name: A\n    type: odd\n    position: odd\n  - name: a\n---\n')!;
    expect(t).toEqual({ name: 'X', aliases: [], showFrontmatter: false, position: 'top', properties: [{ name: 'A', type: 'text', options: [], default: '', position: '' }] });
  });

  it('checks names', () => {
    for (const ok of ['Meeting', 'Team Meeting', 'Über-Blick_2', 'a']) expect(isNoteTypeName(ok)).toBe(true);
    for (const bad of ['', ' a', 'a ', 'a:b', 'a#b', 'a\nb', '-a', 'x'.repeat(65)]) expect(isNoteTypeName(bad)).toBe(false);
  });

  it('reads and sets the type of a note', () => {
    expect(customTypeOf('---\ntype: custom:Team Meeting\n---\n')).toBe('Team Meeting');
    expect(customTypeOf('---\nType: "custom: Meeting"\n---\n')).toBe('Meeting');
    expect(customTypeOf('---\ntype: pdf\n---\n')).toBeNull();
    expect(customTypeOf('---\ntype: "custom:"\n---\n')).toBeNull();
    expect(customTypeOf('type: custom:A')).toBeNull();
    expect(setCustomType('# A\n', 'Meeting')).toBe('---\ntype: custom:Meeting\n---\n# A\n');
    expect(setCustomType('---\ntype: custom:Meeting\n---\n# A\n', null)).toBe('# A\n');
    expect(setCustomType('---\ntype: pdf\n---\n', null)).toBe('---\ntype: pdf\n---\n');
  });

  it('finds types by name and former name, a current name first', () => {
    const other = { ...meeting, name: 'Jour fixe', aliases: [] };
    expect(findNoteType([meeting], 'TEAM meeting')).toBe(meeting);
    expect(findNoteType([meeting], 'jour fixe')).toBe(meeting);
    expect(findNoteType([meeting, other], 'jour fixe')).toBe(other);
    expect(findNoteType([meeting], 'x')).toBeNull();
    const types = noteTypesOf([
      { path: path(2), content: writeNoteType('', { ...meeting, name: 'team meeting', position: 'bottom' }) },
      { path: path(1), content: writeNoteType('', meeting) },
      { path: 'Note.md', content: writeNoteType('', other) },
    ]);
    expect(types).toEqual([meeting]);
  });

  it('places the properties', () => {
    expect(propertiesAt(meeting, 'right').map((p) => p.name)).toEqual(['Date', 'People']);
    expect(propertiesAt(meeting, 'top').map((p) => p.name)).toEqual(['Status']);
    expect(propertiesAt(meeting, 'bottom')).toEqual([]);
  });

  it('fills defaults in without touching what is there, and reads the values', () => {
    const note = applyTypeDefaults('---\ntype: custom:Team Meeting\nstatus: done\n---\n# A\n', meeting, { title: 'A', date: '2026-11-25' });
    expect(typeValues(meeting, note)).toEqual({ Date: '2026-11-25', Status: 'done', People: ['Anna', 'Ben'], Public: null });
    expect(note).toContain('status: done');
    expect(note).not.toContain('Public');
    expect(note.endsWith('# A\n')).toBe(true);
    expect(applyTypeDefaults(note, meeting, { title: 'B', date: '2030-01-01' })).toBe(note);
  });
});
