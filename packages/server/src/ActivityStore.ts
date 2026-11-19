import type { DatabaseSync } from 'node:sqlite';
import { SYSTEM_PREFIX, type ActivityEntry, type ActivityKind, type ActivityNews } from '@kladde/shared';
import { DataCipher, randomToken } from './crypto.js';
import type { NoteChangeEvent } from './NoteStore.js';

/*
 * Activity of groups and shared notes (#70). Every accepted change to a note somebody else can see is recorded
 * with who made it; paths and names are encrypted like the notes (`activity:<id>` as AAD), the server only keeps
 * ids, kinds and times in the clear. Edits of one person to one note are counted in one entry per hour.
 */

const HOUR = 3_600_000;
/** Entries older than this are dropped */
export const ACTIVITY_RETENTION_DAYS = 180;
/** "New since your last visit" looks back this far for notes never opened */
const NEWS_WINDOW = 14 * 24 * HOUR;
const NOTE_KINDS: ActivityKind[] = ['created', 'edited', 'moved', 'restored', 'released'];

interface ActivityRow {
  id: string;
  owner_id: string;
  note_id: string | null;
  actor_id: string | null;
  kind: ActivityKind;
  at: number;
  hour: number;
  count: number;
  payload: Uint8Array;
  actor_name?: string | null;
}

interface ActivityPayload {
  path?: string;
  previousPath?: string;
  version?: string;
  member?: string;
  role?: string;
  folder?: string;
}

export class ActivityStore {
  private writes = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher
  ) {}

  private insert(ownerId: string, noteId: string | null, actorId: string | null, kind: ActivityKind, payload: ActivityPayload, now: number): void {
    const id = randomToken(12);
    this.db
      .prepare('INSERT INTO activity (id, owner_id, note_id, actor_id, kind, at, hour, count, payload) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, ownerId, noteId, actorId, kind, now, Math.floor(now / HOUR), this.cipher.encryptJson(payload, `activity:${id}`));
    if (++this.writes % 500 === 0) this.prune(now);
  }

  /** Records a note change; private notes nobody else sees and system notes are left out */
  record(e: NoteChangeEvent, now = Date.now()): void {
    if (!e.actorId || e.path.startsWith(SYSTEM_PREFIX) || new Set(e.audience).size < 2) return;
    const kind: ActivityKind =
      e.action ?? (e.previousPath === null ? 'created' : e.deleted ? 'deleted' : e.path !== e.previousPath ? 'moved' : 'edited');
    if (kind === 'edited') {
      const hour = Math.floor(now / HOUR);
      // A note created in the same hour by the same person: its first edits belong to "created"
      const recent = this.db
        .prepare("SELECT id, kind FROM activity WHERE note_id = ? AND actor_id = ? AND hour = ? AND kind IN ('edited', 'created') ORDER BY at DESC LIMIT 1")
        .get(e.noteId, e.actorId, hour) as { id: string; kind: ActivityKind } | undefined;
      if (recent?.kind === 'created') return;
      if (recent) {
        this.db
          .prepare('UPDATE activity SET count = count + 1, at = ?, payload = ? WHERE id = ?')
          .run(now, this.cipher.encryptJson({ path: e.path } satisfies ActivityPayload, `activity:${recent.id}`), recent.id);
        return;
      }
    }
    const payload: ActivityPayload = { path: e.path };
    if (kind === 'moved' && e.previousPath) payload.previousPath = e.previousPath;
    if (kind === 'released' && e.version) payload.version = e.version;
    this.insert(e.ownerId, e.noteId, e.actorId, kind, payload, now);
  }

  /** A membership change in a group */
  member(groupId: string, actorId: string, kind: 'member_added' | 'member_removed' | 'member_role', member: string, role: string | null, now = Date.now()): void {
    this.insert(groupId, null, actorId, kind, { member, ...(role ? { role } : {}) }, now);
  }

  /** A folder shared with someone, or no longer */
  folderShare(ownerId: string, actorId: string, kind: 'folder_shared' | 'folder_unshared', folder: string, member: string, now = Date.now()): void {
    this.insert(ownerId, null, actorId, kind, { folder, member }, now);
  }

  private toEntry(r: ActivityRow): ActivityEntry {
    const p = this.cipher.decryptJson<ActivityPayload>(r.payload, `activity:${r.id}`);
    return { id: r.id, kind: r.kind, at: r.at, count: r.count, actor: r.actor_name ?? null, noteId: r.note_id, ...p };
  }

  private rows(ownerId: string, before: number, limit: number): ActivityRow[] {
    return this.db
      .prepare(
        `SELECT activity.*, users.username AS actor_name FROM activity LEFT JOIN users ON users.id = activity.actor_id
         WHERE activity.owner_id = ? AND activity.at < ? ORDER BY activity.at DESC, activity.rowid DESC LIMIT ?`
      )
      .all(ownerId, before, limit) as unknown as ActivityRow[];
  }

  /** Activity of a group's space (the caller checks the membership) */
  ofOwner(ownerId: string, opts: { before?: number; limit?: number } = {}): ActivityEntry[] {
    return this.rows(ownerId, opts.before ?? Number.MAX_SAFE_INTEGER, Math.min(opts.limit ?? 200, 500)).map((r) => this.toEntry(r));
  }

  /** Activity inside one shared folder of `ownerId` (and the sharing of that folder) */
  ofFolder(ownerId: string, folder: string, opts: { before?: number; limit?: number } = {}): ActivityEntry[] {
    const limit = Math.min(opts.limit ?? 200, 500);
    const inside = (p?: string) => !!p && (p.startsWith(`${folder}/`) || p === folder);
    const out: ActivityEntry[] = [];
    let before = opts.before ?? Number.MAX_SAFE_INTEGER;
    // Entries of the owner's whole space are read in pages and filtered after decryption
    for (let page = 0; page < 20 && out.length < limit; page++) {
      const rows = this.rows(ownerId, before, 500);
      for (const r of rows) {
        const e = this.toEntry(r);
        if (inside(e.path) || inside(e.previousPath) || e.folder === folder) out.push(e);
        if (out.length >= limit) break;
      }
      if (rows.length < 500) break;
      before = rows[rows.length - 1].at;
    }
    return out;
  }

  /** The user opened the note: it is no longer new to them */
  seen(userId: string, noteId: string, now = Date.now()): void {
    this.db
      .prepare('INSERT INTO activity_seen (user_id, note_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(user_id, note_id) DO UPDATE SET seen_at = excluded.seen_at')
      .run(userId, noteId, now);
  }

  /**
   * Notes someone else created or changed after the user last opened them (never opened: in the last two weeks);
   * `canSee` keeps only notes the user still has access to
   */
  news(userId: string, canSee: (noteId: string) => boolean, now = Date.now()): ActivityNews {
    const rows = this.db
      .prepare(
        `SELECT a.note_id AS id, a.at AS at, u.username AS by FROM activity a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN activity_seen s ON s.user_id = ? AND s.note_id = a.note_id
         WHERE a.note_id IS NOT NULL AND a.actor_id IS NOT ? AND a.at > ? AND a.kind IN (${NOTE_KINDS.map(() => '?').join(', ')})
           AND (s.seen_at IS NULL OR a.at > s.seen_at)
         ORDER BY a.at DESC LIMIT 5000`
      )
      .all(userId, userId, now - NEWS_WINDOW, ...NOTE_KINDS) as { id: string; at: number; by: string | null }[];
    // The newest change per note
    const latest = new Map<string, { id: string; at: number; by: string | null }>();
    for (const r of rows) if (!latest.has(r.id)) latest.set(r.id, r);
    return { notes: [...latest.values()].filter((r) => canSee(r.id)).slice(0, 500) };
  }

  /** Drops entries past the retention time and marks of notes long since opened */
  prune(now = Date.now()): void {
    const before = now - ACTIVITY_RETENTION_DAYS * 24 * HOUR;
    this.db.prepare('DELETE FROM activity WHERE at < ?').run(before);
    this.db.prepare('DELETE FROM activity_seen WHERE seen_at < ?').run(before);
  }
}
