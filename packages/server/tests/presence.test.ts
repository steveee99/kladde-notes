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

  it('rejects malformed client ids', () => {
    expect(Presence.validClient('ok-client-1')).toBe(true);
    expect(Presence.validClient('x')).toBe(false);
    expect(Presence.validClient('a:b-cdefgh')).toBe(false);
  });
});
