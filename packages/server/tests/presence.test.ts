import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { openDatabase } from '../src/db';
import { DataCipher } from '../src/crypto';
import { UserStore } from '../src/UserStore';
import { NoteStore } from '../src/NoteStore';
import { Presence, PRESENCE_TTL_MS } from '../src/Presence';

function setup() {
  const db = openDatabase(':memory:');
  const users = new UserStore(db);
  const notes = new NoteStore(db, new DataCipher(crypto.randomBytes(32)), () => {});
  const anna = users.createUser('anna');
  const ben = users.createUser('ben');
  const carl = users.createUser('carl');
  const sent: { to: string[]; event: string; data: any }[] = [];
  let now = 1_000_000;
  const presence = new Presence(notes, (id) => users.getUser(id), { send: (to, event, data) => sent.push({ to: [...to], event, data }) }, () => now);
  const now_ = { advance: (ms: number) => (now += ms) };
  notes.push(anna.id, [{ id: 'note-0001', baseVersion: 0, path: 'Inbox/Test.md', content: 'x', deleted: false, createdAt: 1, updatedAt: 1 }]);
  notes.share(anna.id, 'note-0001', ben.id, true);
  return { presence, sent, anna, ben, carl, clock: now_ };
}

describe('Presence', () => {
  it('counts users and their devices on a note and tells everybody who may see it', () => {
    const { presence, sent, anna, ben } = setup();
    expect(presence.announce(anna.id, 'laptop-01', 'note-0001')?.viewers).toEqual([expect.objectContaining({ username: 'anna', clients: 1 })]);
    presence.announce(anna.id, 'phone-0001', 'note-0001');
    const update = presence.announce(ben.id, 'tablet-01', 'note-0001');
    expect(update?.viewers.map((v) => [v.username, v.clients])).toEqual([
      ['anna', 2],
      ['ben', 1],
    ]);
    const last = sent[sent.length - 1];
    expect(last.event).toBe('presence');
    expect(last.to.sort()).toEqual([anna.id, ben.id].sort());
  });

  it('ignores notes the user may not see', () => {
    const { presence, carl } = setup();
    expect(presence.announce(carl.id, 'desk-0001', 'note-0001')).toBeNull();
    expect(presence.viewers('note-0001')).toEqual([]);
  });

  it('drops clients that leave, switch notes or stop sending heartbeats', () => {
    const { presence, anna, ben, clock } = setup();
    presence.announce(anna.id, 'laptop-01', 'note-0001');
    presence.announce(ben.id, 'tablet-01', 'note-0001');
    presence.leave(ben.id, 'tablet-01');
    expect(presence.viewers('note-0001').map((v) => v.username)).toEqual(['anna']);
    presence.announce(anna.id, 'laptop-01', null);
    expect(presence.viewers('note-0001')).toEqual([]);
    presence.announce(anna.id, 'laptop-01', 'note-0001');
    clock.advance(PRESENCE_TTL_MS + 1);
    presence.sweep();
    expect(presence.viewers('note-0001')).toEqual([]);
  });

  it('passes cursors on to everybody on the note and remembers them for newcomers', () => {
    const { presence, sent, anna, ben, carl } = setup();
    presence.announce(anna.id, 'laptop-01', 'note-0001');
    expect(presence.cursor(anna.id, 'laptop-01', 'note-0001', { head: 3, anchor: 1, ctx: 'ab' })).toBe(true);
    const last = sent[sent.length - 1];
    expect(last.event).toBe('cursor');
    expect(last.data).toEqual({ noteId: 'note-0001', cursor: { clientId: 'laptop-01', userId: anna.id, head: 3, anchor: 1, ctx: 'ab' } });
    expect(last.to.sort()).toEqual([anna.id, ben.id].sort());
    // A heartbeat keeps it; a newcomer gets it with the presence update
    presence.announce(anna.id, 'laptop-01', 'note-0001');
    expect(presence.announce(ben.id, 'tablet-01', 'note-0001')?.cursors).toEqual([expect.objectContaining({ clientId: 'laptop-01', head: 3 })]);
    // Only for the note the client has open, only for users who may see it
    expect(presence.cursor(ben.id, 'tablet-01', 'note-0002', { head: 0, anchor: 0, ctx: '' })).toBe(false);
    expect(presence.cursor(carl.id, 'desk-0001', 'note-0001', { head: 0, anchor: 0, ctx: '' })).toBe(false);
    // Leaving takes the cursor away
    presence.leave(anna.id, 'laptop-01');
    expect(presence.cursors('note-0001')).toEqual([]);
  });

  it('rejects malformed cursors', () => {
    expect(Presence.validCursor({ head: 1, anchor: 0, ctx: 'x' })).toEqual({ head: 1, anchor: 0, ctx: 'x' });
    expect(Presence.validCursor({ head: -1, anchor: 0, ctx: '' })).toBeNull();
    expect(Presence.validCursor({ head: 1.5, anchor: 0, ctx: '' })).toBeNull();
    expect(Presence.validCursor({ head: 1, anchor: 0, ctx: 'x'.repeat(25) })).toBeNull();
  });

  it('rejects malformed client ids', () => {
    expect(Presence.validClient('ok-client-1')).toBe(true);
    expect(Presence.validClient('x')).toBe(false);
    expect(Presence.validClient('a:b-cdefgh')).toBe(false);
  });
});
