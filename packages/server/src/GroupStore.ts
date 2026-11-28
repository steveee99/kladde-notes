import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import { GroupDetails, GroupFeatures, GroupInfo, GroupMember, GroupRole, cleanGroupName, isGroupRole, keepsAnOwner, parseGroupFeatures } from '@kladde/shared';
import { transaction } from './db.js';

/** A refused group operation with its HTTP status */
export class GroupError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/** At most this many groups per user, against runaway scripts */
export const MAX_GROUPS_PER_USER = 100;
/** At most this many members per group */
export const MAX_GROUP_MEMBERS = 500;

/**
 * Groups (#58). A group is stored as an account-like row in `users` (`is_group = 1`, never able to sign in), so
 * it can own notes, trash and attachments exactly like a user; `group_members` gives every member a role.
 * Membership changes take the next global `seq`: members pull the group's notes again, removed members get
 * revocations for them.
 */
export class GroupStore {
  constructor(private readonly db: DatabaseSync) {}

  private nextSeq(): number {
    return (this.db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value").get() as { value: number }).value;
  }

  roleOf(groupId: string, userId: string): GroupRole | null {
    const row = this.db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId) as { role: GroupRole } | undefined;
    return row?.role ?? null;
  }

  private members(groupId: string): { userId: string; role: GroupRole }[] {
    return (this.db.prepare('SELECT user_id, role FROM group_members WHERE group_id = ?').all(groupId) as { user_id: string; role: GroupRole }[]).map((m) => ({
      userId: m.user_id,
      role: m.role,
    }));
  }

  /** User ids of all members (to notify them) */
  memberIds(groupId: string): string[] {
    return this.members(groupId).map((m) => m.userId);
  }

  private requireRole(groupId: string, userId: string, owner: boolean): GroupRole {
    const role = typeof groupId === 'string' ? this.roleOf(groupId, userId) : null;
    if (!role) throw new GroupError('Diese Gruppe gibt es nicht.', 404);
    if (owner && role !== 'owner') throw new GroupError('Nur Eigentümer der Gruppe dürfen das.', 403);
    return role;
  }

  /** The group's name, or null when the id is no group */
  groupName(groupId: string): string | null {
    const row = this.db.prepare('SELECT username FROM users WHERE id = ? AND is_group = 1').get(groupId) as { username: string } | undefined;
    return row?.username ?? null;
  }

  private nameOf(groupId: string): string {
    return (this.db.prepare('SELECT username FROM users WHERE id = ? AND is_group = 1').get(groupId) as { username: string }).username;
  }

  /** Creates a group; its creator is its first owner */
  create(userId: string, name: unknown, now = Date.now()): GroupInfo {
    const clean = cleanGroupName(name);
    if (!clean) throw new GroupError('Bitte einen Namen für die Gruppe angeben.');
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE user_id = ? AND role = 'owner'").get(userId) as { n: number }).n;
    if (count >= MAX_GROUPS_PER_USER) throw new GroupError('Zu viele Gruppen.', 409);
    const id = crypto.randomUUID();
    transaction(this.db, () => {
      // `group:` cannot be part of a username, so the row never collides with an account or a sign-in
      this.db.prepare('INSERT INTO users (id, username, username_lower, created_at, is_group) VALUES (?, ?, ?, ?, 1)').run(id, clean, `group:${id}`, now);
      this.db.prepare("INSERT INTO group_members (group_id, user_id, role, seq, created_at) VALUES (?, ?, 'owner', ?, ?)").run(id, userId, this.nextSeq(), now);
    });
    return { id, name: clean, role: 'owner' };
  }

  /** The group with its members and what deleting it would remove (members only) */
  details(userId: string, groupId: string): GroupDetails {
    const role = this.requireRole(groupId, userId, false);
    const group = this.db.prepare('SELECT username, created_at, group_features FROM users WHERE id = ? AND is_group = 1').get(groupId) as { username: string; created_at: number; group_features: string | null };
    const members = this.db
      .prepare(
        `SELECT users.username, users.avatar_id, group_members.role FROM group_members JOIN users ON users.id = group_members.user_id
         WHERE group_members.group_id = ? ORDER BY users.username_lower`
      )
      .all(groupId) as { username: string; avatar_id: string | null; role: GroupRole }[];
    const order: Record<GroupRole, number> = { owner: 0, editor: 1, reader: 2 };
    const count = (sql: string) => (this.db.prepare(sql).get(groupId) as { n: number }).n;
    return {
      id: groupId,
      name: group.username,
      role,
      features: parseGroupFeatures(group.group_features),
      createdAt: group.created_at,
      members: members
        .map((m): GroupMember => ({ username: m.username, ...(m.avatar_id ? { avatarUrl: `/api/avatars/${m.avatar_id}` } : {}), role: m.role }))
        .sort((a, b) => order[a.role] - order[b.role]),
      notes: count('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ? AND deleted = 0'),
      attachments: count('SELECT COUNT(*) AS n FROM files WHERE owner_id = ?'),
    };
  }

  /** Renames the group (owners); members pull the notes again to see the new name */
  rename(userId: string, groupId: string, name: unknown): GroupInfo {
    this.requireRole(groupId, userId, true);
    const clean = cleanGroupName(name);
    if (!clean) throw new GroupError('Bitte einen Namen für die Gruppe angeben.');
    transaction(this.db, () => {
      this.db.prepare('UPDATE users SET username = ? WHERE id = ? AND is_group = 1').run(clean, groupId);
      this.db.prepare('UPDATE group_members SET seq = ? WHERE group_id = ?').run(this.nextSeq(), groupId);
    });
    return { id: groupId, name: clean, role: 'owner' };
  }

  /**
   * Switches features on or off for every member of the group (owners). Members pull again and see the
   * group's notes with the features of the group, whatever their own settings say.
   */
  setFeatures(userId: string, groupId: string, patch: unknown): GroupFeatures {
    this.requireRole(groupId, userId, true);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new GroupError('Ungültige Einstellungen.');
    const row = this.db.prepare('SELECT group_features FROM users WHERE id = ? AND is_group = 1').get(groupId) as { group_features: string | null };
    const next: GroupFeatures = { ...parseGroupFeatures(row.group_features) };
    const p = patch as Record<string, unknown>;
    if ('tickets' in p) {
      if (typeof p.tickets !== 'boolean') throw new GroupError('Ungültige Einstellungen.');
      next.tickets = p.tickets;
    }
    transaction(this.db, () => {
      this.db.prepare('UPDATE users SET group_features = ? WHERE id = ? AND is_group = 1').run(JSON.stringify(next), groupId);
      this.db.prepare('UPDATE group_members SET seq = ? WHERE group_id = ?').run(this.nextSeq(), groupId);
    });
    return next;
  }

  /** Adds a member or changes their role (owners). The last owner keeps the role until another member is owner. */
  setMember(userId: string, groupId: string, targetUserId: string, role: unknown, now = Date.now()): void {
    this.requireRole(groupId, userId, true);
    if (!isGroupRole(role)) throw new GroupError('Unbekannte Rolle.');
    transaction(this.db, () => {
      const members = this.members(groupId);
      const current = members.find((m) => m.userId === targetUserId);
      if (!current && members.length >= MAX_GROUP_MEMBERS) throw new GroupError('Die Gruppe hat zu viele Mitglieder.', 409);
      if (current && !keepsAnOwner(members, targetUserId, role)) {
        throw new GroupError('Die Gruppe braucht einen Eigentümer: Mache zuerst ein anderes Mitglied zum Eigentümer.', 409);
      }
      if (current?.role === role) return;
      const seq = this.nextSeq();
      this.db
        .prepare(
          'INSERT INTO group_members (group_id, user_id, role, seq, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role, seq = excluded.seq'
        )
        .run(groupId, targetUserId, role, seq, now);
    });
  }

  /**
   * Removes a member (owners), or the user leaves (anyone). The last owner can do neither: another member
   * has to become owner first. The removed member loses the group's notes on every device.
   */
  removeMember(userId: string, groupId: string, targetUserId: string): void {
    this.requireRole(groupId, userId, targetUserId !== userId);
    transaction(this.db, () => {
      const members = this.members(groupId);
      if (!members.some((m) => m.userId === targetUserId)) throw new GroupError('Diese Person ist nicht in der Gruppe.', 404);
      if (!keepsAnOwner(members, targetUserId, null)) {
        throw new GroupError('Der letzte Eigentümer kann die Gruppe nicht verlassen: Mache zuerst ein anderes Mitglied zum Eigentümer.', 409);
      }
      const seq = this.nextSeq();
      const live = this.db.prepare('SELECT id FROM notes WHERE owner_id = ? AND deleted = 0').all(groupId) as { id: string }[];
      const revoke = this.db.prepare('INSERT INTO share_revocations (note_id, user_id, seq) VALUES (?, ?, ?)');
      for (const n of live) revoke.run(n.id, targetUserId, seq);
      this.db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, targetUserId);
    });
  }

  /** Owners only; the caller deletes the notes and files (NoteStore.deleteGroup, FileStore) */
  checkDelete(userId: string, groupId: string, confirmName: unknown): void {
    this.requireRole(groupId, userId, true);
    if (typeof confirmName !== 'string' || confirmName.trim() !== this.nameOf(groupId)) {
      throw new GroupError('Zum Löschen bitte den Namen der Gruppe genau eingeben.');
    }
  }
}
