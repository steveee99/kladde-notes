import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { writeVariables } from '@kladde/shared';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteStore } from '../src/NoteStore';

const change = (id: string, path: string, content: string, baseVersion = 0) => ({ id, baseVersion, path, content, deleted: false, createdAt: Date.now(), updatedAt: Date.now() });
const vars = (v: Record<string, string>) =>
  writeVariables(
    '',
    Object.entries(v).map(([name, value]) => ({ name, value }))
  );

describe('variables on public links', () => {
  function setup() {
    const db = openDatabase(':memory:');
    const users = new UserStore(db);
    const notes = new NoteStore(db, new DataCipher(crypto.randomBytes(32)), () => {});
    const anna = users.createUser('anna');
    const ben = users.createUser('ben');
    notes.push(anna.id, [
      change('vars-root-1', '_variables.md', vars({ customer: 'ACME', secret: 'hidden', repo: 'https://h/{{var:customer}}' })),
      change('vars-sub-01', 'A/_variables.md', vars({ customer: 'Beta' })),
      change('note-aaaa-1', 'A/B/Note.md', '{{var:customer}} {{var:repo}} `{{var:secret}}` {{var:gone}}'),
    ]);
    return { notes, anna, ben, token: notes.setPublic(anna.id, 'note-aaaa-1', true)! };
  }

  it('sends the resolved values the note uses and nothing else', () => {
    const { notes, token } = setup();
    const note = notes.publicNote(token)!;
    expect(note.content).toContain('{{var:customer}}');
    expect(note.variables).toEqual({ customer: 'Beta', repo: 'https://h/Beta' });
    expect(JSON.stringify(note)).not.toContain('hidden');
  });

  it('follows changed, moved and deleted definitions', () => {
    const { notes, anna, token } = setup();
    notes.publicNote(token);
    notes.push(anna.id, [change('vars-sub-01', 'A/_variables.md', vars({ customer: 'Gamma' }), 1)]);
    expect(notes.publicNote(token)!.variables!.customer).toBe('Gamma');
    notes.push(anna.id, [change('vars-sub-01', 'Z/_variables.md', vars({ customer: 'Gamma' }), 2)]);
    expect(notes.publicNote(token)!.variables!.customer).toBe('ACME');
    notes.push(anna.id, [{ ...change('vars-root-1', '_variables.md', '', 1), deleted: true }]);
    expect(notes.publicNote(token)!.variables).toBeUndefined();
  });

  it('keeps the spaces of two users apart', () => {
    const { notes, anna, ben } = setup();
    notes.push(ben.id, [change('note-bbbb-1', 'A/Own.md', '{{var:customer}}')]);
    expect(notes.publicNote(notes.setPublic(ben.id, 'note-bbbb-1', true)!)!.variables).toBeUndefined();
    expect(notes.variablesOf(anna.id, 'A').resolve('customer').text).toBe('Beta');
  });
});
