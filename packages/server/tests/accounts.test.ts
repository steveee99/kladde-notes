import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrate, openDatabase } from '../src/db';
import { UserStore, randomPassword } from '../src/UserStore';

function setup() {
  const db = openDatabase(':memory:');
  const users = new UserStore(db);
  return { db, users, anna: users.createUser('anna'), ben: users.createUser('ben') };
}

describe('UserStore passwords', () => {
  it('stores only a hash and checks logins case-insensitively', async () => {
    const { db, users, anna } = setup();
    await users.setPassword(anna.id, 'geheim123');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(anna.id) as { password_hash: string };
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain('geheim123');
    expect((await users.checkLogin('ANNA', 'geheim123'))?.id).toBe(anna.id);
    expect(await users.checkLogin('anna', 'falsch123')).toBeNull();
    expect(await users.checkLogin('niemand', 'geheim123')).toBeNull();
  });

  it('rejects short passwords and accounts without one', async () => {
    const { users, anna, ben } = setup();
    await expect(users.setPassword(anna.id, 'kurz')).rejects.toThrow(/mindestens/);
    expect(await users.checkLogin('ben', '')).toBeNull();
    expect(users.getUser(ben.id)!.hasPassword).toBe(false);
  });

  it('reset gives a new password and ends every session', async () => {
    const { users, anna } = setup();
    await users.setPassword(anna.id, 'geheim123');
    const token = users.createSession(anna.id);
    const password = await users.resetPassword(anna.id);
    expect(password).toHaveLength(12);
    expect(users.userForSession(token)).toBeNull();
    expect(await users.checkLogin('anna', 'geheim123')).toBeNull();
    expect((await users.checkLogin('anna', password))?.id).toBe(anna.id);
  });

  it('keeps one way in: last passkey needs a password, the password needs a passkey', async () => {
    const { users, anna } = setup();
    users.addCredential({ id: 'cred-1', userId: anna.id, publicKey: new Uint8Array([1]), counter: 0, transports: [], name: 'Mac', createdAt: 1 });
    expect(() => users.deleteCredential(anna.id, 'cred-1')).toThrow(/letzte Passkey/);
    await users.setPassword(anna.id, 'geheim123');
    expect(users.deleteCredential(anna.id, 'cred-1')).toBe(true);
    expect(() => users.removePassword(anna.id)).toThrow(/Ohne Passkey/);
  });

  it('can sign out other sessions only', () => {
    const { users, anna } = setup();
    const keep = users.createSession(anna.id);
    const other = users.createSession(anna.id);
    users.deleteSessionsOf(anna.id, keep);
    expect(users.userForSession(keep)?.id).toBe(anna.id);
    expect(users.userForSession(other)).toBeNull();
  });

  it('random passwords avoid look-alike characters', () => {
    for (let i = 0; i < 20; i++) expect(randomPassword()).toMatch(/^[a-km-np-zA-HJ-NP-Z2-9]{12}$/);
  });
});

describe('UserStore admins', () => {
  it('makes the first account admin and protects the last admin', () => {
    const { users, anna, ben } = setup();
    expect(anna.isAdmin).toBe(true);
    expect(ben.isAdmin).toBe(false);
    expect(() => users.setAdmin(anna.id, false)).toThrow(/letzte Admin/);
    users.setAdmin(ben.id, true);
    users.setAdmin(anna.id, false);
    expect(users.getUser(anna.id)!.isAdmin).toBe(false);
  });

  it('lists accounts with passkeys, notes and last activity', () => {
    const { users, anna } = setup();
    users.createSession(anna.id, 5000);
    const list = users.listForAdmin();
    expect(list.map((u) => u.username)).toEqual(['anna', 'ben']);
    expect(list[0]).toMatchObject({ isAdmin: true, passkeys: 0, notes: 0, lastSeenAt: 5000 });
    expect(list[1].lastSeenAt).toBeNull();
  });
});

describe('migration 2', () => {
  it('turns the oldest existing account into the admin', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.slice(0, 1));
    const insert = db.prepare('INSERT INTO users (id, username, username_lower, created_at) VALUES (?, ?, ?, ?)');
    insert.run('u2', 'zweite', 'zweite', 2);
    insert.run('u1', 'erste', 'erste', 1);
    expect(migrate(db, MIGRATIONS.slice(0, 2))).toEqual([2]);
    const users = new UserStore(db);
    expect(users.getUser('u1')).toMatchObject({ isAdmin: true, hasPassword: false });
    expect(users.getUser('u2')!.isAdmin).toBe(false);
  });
});
