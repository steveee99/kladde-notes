import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { parseNoteType, writeNoteType, type NoteType } from '@kladde/shared';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteStore } from '../src/NoteStore';

const change = (id: string, path: string, content: string, baseVersion = 0) => ({ id, baseVersion, path, content, deleted: false, createdAt: Date.now(), updatedAt: Date.now() });
const PATH = '_type-0b9f6c1e-3d52-4c0e-9a7e-5f1d2c3b4a69.md';
const type = (patch: Partial<NoteType> = {}): NoteType => ({
  name: 'Meeting',
  aliases: ['Former'],
  showFrontmatter: false,
  position: 'right',
  properties: [
    { name: 'Status', type: 'select', options: ['secret option'], default: 'secret default', position: '' },
    { name: 'Internal', type: 'text', options: [], default: '', position: 'hidden' },
  ],
  ...patch,
});

describe('custom note types on public links', () => {
  function setup() {
    const db = openDatabase(':memory:');
    const users = new UserStore(db);
    const notes = new NoteStore(db, new DataCipher(crypto.randomBytes(32)), () => {});
    const anna = users.createUser('anna');
    const ben = users.createUser('ben');
    notes.push(anna.id, [change('type-aaaa-1', PATH, writeNoteType('', type())), change('note-aaaa-1', 'A/Note.md', '---\ntype: custom:meeting\nStatus: done\n---\nText\n')]);
    return { notes, anna, ben, token: notes.setPublic(anna.id, 'note-aaaa-1', true)! };
  }

  it('sends how the note is shown and nothing else of the definition', () => {
    const { notes, token } = setup();
    const sent = notes.publicNote(token)!.noteType!;
    expect(parseNoteType(sent)).toEqual({ ...type(), aliases: [], properties: [{ name: 'Status', type: 'select', options: [], default: '', position: '' }] });
    expect(sent).not.toMatch(/secret|Former|Internal/);
  });

  it('follows changed and deleted definitions, and keeps users apart', () => {
    const { notes, anna, ben, token } = setup();
    notes.publicNote(token);
    notes.push(anna.id, [change('type-aaaa-1', PATH, writeNoteType('', type({ position: 'bottom' })), 1)]);
    expect(parseNoteType(notes.publicNote(token)!.noteType!)!.position).toBe('bottom');
    notes.push(anna.id, [{ ...change('type-aaaa-1', PATH, '', 2), deleted: true }]);
    expect(notes.publicNote(token)!.noteType).toBeUndefined();
    notes.push(anna.id, [change('type-aaaa-2', PATH, writeNoteType('', type()))]);
    expect(notes.publicNote(token)!.noteType).toBeDefined();
    notes.push(ben.id, [change('note-bbbb-1', 'Own.md', '---\ntype: custom:Meeting\n---\n')]);
    expect(notes.publicNote(notes.setPublic(ben.id, 'note-bbbb-1', true)!)!.noteType).toBeUndefined();
  });
});
