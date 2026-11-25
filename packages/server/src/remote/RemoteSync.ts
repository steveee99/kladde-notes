import type { DatabaseSync } from 'node:sqlite';
import { currentSnapshot, REMOTE_SYNC_HOURS, remoteNoteOf, resolveRemoteSource, type RemoteSnapshot } from '@kladde/shared';
import type { DataCipher } from '../crypto.js';
import type { NoteChangeEvent, NoteStore } from '../NoteStore.js';
import type { RemoteFetcher } from './RemoteFetcher.js';

/**
 * Synced remote notes (`sync: true`): the server reads their document every few hours and keeps a copy, encrypted
 * like the notes, so devices search it and show it without a connection. A row exists exactly while a note is a synced
 * remote note: note changes register and drop it (`onNoteChange`), the job reads the ones that are due a few at a time.
 * Only a changed document (or a manual sync) gives the note a new seq, so unchanged documents cause no sync traffic.
 */

/** Notes read per run of the job (one run a minute): bounds the requests to GitLab/GitHub */
const BATCH = 10;
/** A manual sync within this time of the last one answers with that one */
const MANUAL_COOLDOWN_MS = 15_000;

/** `REMOTE_SYNC_HOURS`: how often synced remote notes are read again; never below an hour */
export function remoteSyncHours(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.REMOTE_SYNC_HOURS?.trim() || REMOTE_SYNC_HOURS.default);
  if (!Number.isFinite(raw)) return REMOTE_SYNC_HOURS.default;
  return Math.min(REMOTE_SYNC_HOURS.max, Math.max(REMOTE_SYNC_HOURS.min, raw));
}

interface SnapshotRow {
  note_id: string;
  next_at: number;
  payload: Uint8Array | null;
}

export class RemoteSnapshotStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher
  ) {}

  private row(noteId: string): SnapshotRow | undefined {
    return this.db.prepare('SELECT * FROM remote_snapshots WHERE note_id = ?').get(noteId) as SnapshotRow | undefined;
  }

  private decrypt(row: SnapshotRow): RemoteSnapshot | null {
    return row.payload ? this.cipher.decryptJson<RemoteSnapshot>(row.payload, `remote_snapshot:${row.note_id}`) : null;
  }

  get(noteId: string): RemoteSnapshot | null {
    const row = this.row(noteId);
    return row ? this.decrypt(row) : null;
  }

  /** The copy to deliver with a note: only for a synced remote note, and only of its current source */
  current(noteId: string, content: string): RemoteSnapshot | null {
    const src = remoteNoteOf(content);
    if (!src?.sync) return null;
    return currentSnapshot(src, this.get(noteId) ?? undefined);
  }

  /** The note is a synced remote note: due at once when it is new or its source changed */
  register(noteId: string, source: string, ref: string, now = Date.now()): void {
    const row = this.row(noteId);
    if (!row) {
      this.db.prepare('INSERT INTO remote_snapshots (note_id, next_at, payload) VALUES (?, ?, NULL)').run(noteId, now);
      return;
    }
    const snap = this.decrypt(row);
    if ((!snap || snap.source !== source || snap.ref !== ref) && row.next_at > now) this.db.prepare('UPDATE remote_snapshots SET next_at = ? WHERE note_id = ?').run(now, noteId);
  }

  drop(noteId: string): void {
    this.db.prepare('DELETE FROM remote_snapshots WHERE note_id = ?').run(noteId);
  }

  save(noteId: string, snap: RemoteSnapshot, nextAt: number): void {
    this.db
      .prepare('INSERT INTO remote_snapshots (note_id, next_at, payload) VALUES (?, ?, ?) ON CONFLICT(note_id) DO UPDATE SET next_at = excluded.next_at, payload = excluded.payload')
      .run(noteId, nextAt, this.cipher.encryptJson(snap, `remote_snapshot:${noteId}`));
  }

  due(now: number, limit: number): string[] {
    return (this.db.prepare('SELECT note_id FROM remote_snapshots WHERE next_at <= ? ORDER BY next_at LIMIT ?').all(now, limit) as { note_id: string }[]).map((r) => r.note_id);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM remote_snapshots').get() as { n: number }).n;
  }
}

/** True when devices should hear about the new copy */
function differs(a: RemoteSnapshot | null, b: RemoteSnapshot): boolean {
  return !a || a.source !== b.source || a.ref !== b.ref || a.text !== b.text || a.commit?.id !== b.commit?.id || a.problem !== b.problem || a.base?.path !== b.base?.path || a.base?.ref !== b.base?.ref;
}

export class RemoteSync {
  private readonly running = new Map<string, Promise<RemoteSnapshot | null>>();
  private ticking = false;

  constructor(
    private readonly store: RemoteSnapshotStore,
    private readonly notes: NoteStore,
    private readonly fetcher: RemoteFetcher,
    readonly intervalMs: number
  ) {
    notes.remoteSnapshots = store;
  }

  /** Every accepted change: is the note (still) a synced remote note? */
  onNoteChange(event: NoteChangeEvent): void {
    try {
      const src = event.deleted ? null : remoteNoteOf(event.content);
      if (src?.sync) this.store.register(event.noteId, src.source, src.ref);
      else this.store.drop(event.noteId);
    } catch (err) {
      console.error('Remote sync bookkeeping failed:', err);
    }
  }

  /** One run of the job: reads the notes that are due, one after the other; returns how many */
  async tick(now = Date.now()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const ids = this.store.due(now, BATCH);
      for (const id of ids) await this.sync(id, false).catch((err) => console.error('Remote sync failed:', err));
      return ids.length;
    } finally {
      this.ticking = false;
    }
  }

  /** "Sync now": reads the document at once (unless that just happened) and tells every device */
  syncNow(noteId: string): Promise<RemoteSnapshot | null> {
    const last = this.store.get(noteId);
    if (last && Date.now() - last.checkedAt < MANUAL_COOLDOWN_MS && currentSnapshot(this.notes.storedRemoteSource(noteId)?.source ?? null, last)) return Promise.resolve(last);
    return this.sync(noteId, true);
  }

  private sync(noteId: string, manual: boolean): Promise<RemoteSnapshot | null> {
    let job = this.running.get(noteId);
    if (!job) {
      job = this.read(noteId, manual).finally(() => this.running.delete(noteId));
      this.running.set(noteId, job);
    }
    return job;
  }

  /** Spread over the interval, so notes made at once are not all read at once again */
  private nextAt(now: number): number {
    return now + Math.round(this.intervalMs * (0.9 + Math.random() * 0.2));
  }

  private async read(noteId: string, manual: boolean): Promise<RemoteSnapshot | null> {
    const found = this.notes.storedRemoteSource(noteId);
    if (!found?.source.sync) {
      this.store.drop(noteId);
      return null;
    }
    const { source } = found;
    const before = this.store.get(noteId);
    // A copy of another source is not carried over
    const kept = before && before.source === source.source && before.ref === source.ref ? before : null;
    const resolved = resolveRemoteSource(source, this.notes.variablesOf(found.ownerId, found.folder));
    const answer = resolved.complete ? await this.fetcher.text(resolved.url, resolved.ref, { freshMs: 0 }).catch(() => ({ state: 'unreachable' }) as const) : ({ state: 'unknown_variable' } as const);
    const now = Date.now();
    const snap: RemoteSnapshot =
      answer.state === 'ok'
        ? { source: source.source, ref: source.ref, text: answer.text, base: answer.base, url: answer.url, commit: answer.commit, fetchedAt: answer.fetchedAt, checkedAt: now }
        : { source: source.source, ref: source.ref, text: kept?.text ?? '', base: kept?.base ?? null, url: kept?.url ?? '', commit: kept?.commit ?? null, fetchedAt: kept?.fetchedAt ?? 0, checkedAt: now, problem: answer.state };
    // The note may have changed while the document was read
    const still = this.notes.storedRemoteSource(noteId)?.source;
    if (!still?.sync || still.source !== source.source || still.ref !== source.ref) return null;
    this.store.save(noteId, snap, this.nextAt(now));
    if (manual || differs(before, snap)) this.notes.touchNote(noteId);
    return snap;
  }
}
