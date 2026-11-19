import type { DatabaseSync } from 'node:sqlite';
import { MAX_COMMENT_LENGTH, MAX_QUOTE_LENGTH, type CommentAnchor, type CommentThread } from '@kladde/shared';
import { DataCipher, randomToken } from './crypto.js';
import type { UserStore } from './UserStore.js';

/*
 * Comment threads on passages of notes (#68). A thread holds its anchor and its comments, encrypted as one payload
 * (`comment_thread:<id>` as AAD); only the note id and times are in the clear. Everybody who can see the note may
 * read and write comments; a comment is deleted by its author, a thread also by whoever manages the note.
 */

interface ThreadRow {
  id: string;
  note_id: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  payload: Uint8Array;
}

interface StoredComment {
  id: string;
  authorId: string;
  text: string;
  at: number;
  editedAt?: number;
}

interface ThreadPayload {
  anchor: CommentAnchor;
  resolvedBy?: string | null;
  comments: StoredComment[];
}

export class CommentError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

const MAX_THREADS_PER_NOTE = 500;
const MAX_COMMENTS_PER_THREAD = 200;

function cleanText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) throw new CommentError('Der Kommentar ist leer.');
  if (text.length > MAX_COMMENT_LENGTH) throw new CommentError('Der Kommentar ist zu lang.');
  return text;
}

function cleanAnchor(raw: unknown): CommentAnchor {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const quote = str(o.quote, MAX_QUOTE_LENGTH);
  if (!quote.trim()) throw new CommentError('Markiere zuerst den Text, den du kommentieren willst.');
  const pos = Number(o.pos);
  return { quote, prefix: str(o.prefix, 64), suffix: str(o.suffix, 64), pos: Number.isFinite(pos) && pos >= 0 ? Math.floor(pos) : 0 };
}

export class CommentStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher,
    private readonly users: UserStore
  ) {}

  private payload(r: ThreadRow): ThreadPayload {
    return this.cipher.decryptJson<ThreadPayload>(r.payload, `comment_thread:${r.id}`);
  }

  private write(id: string, p: ThreadPayload, now: number, resolved?: boolean): void {
    const blob = this.cipher.encryptJson(p, `comment_thread:${id}`);
    if (resolved === undefined) this.db.prepare('UPDATE comment_threads SET payload = ?, updated_at = ? WHERE id = ?').run(blob, now, id);
    else this.db.prepare('UPDATE comment_threads SET payload = ?, updated_at = ?, resolved_at = ? WHERE id = ?').run(blob, now, resolved ? now : null, id);
  }

  private row(noteId: string, threadId: string): ThreadRow {
    const r = this.db.prepare('SELECT * FROM comment_threads WHERE id = ? AND note_id = ?').get(threadId, noteId) as ThreadRow | undefined;
    if (!r) throw new CommentError('Diesen Kommentar gibt es nicht (mehr).', 404);
    return r;
  }

  private toThread(r: ThreadRow): CommentThread {
    const p = this.payload(r);
    const name = (id: string | null | undefined) => (id ? (this.users.getUser(id) ?? null) : null);
    const resolver = name(p.resolvedBy);
    return {
      id: r.id,
      noteId: r.note_id,
      anchor: p.anchor,
      resolved: r.resolved_at !== null,
      ...(r.resolved_at !== null ? { resolvedAt: r.resolved_at, resolvedBy: resolver?.username ?? null } : {}),
      createdAt: r.created_at,
      comments: p.comments.map((c) => {
        const u = name(c.authorId);
        return { id: c.id, author: u?.username ?? null, ...(u?.avatarUrl ? { authorAvatar: u.avatarUrl } : {}), text: c.text, at: c.at, ...(c.editedAt ? { editedAt: c.editedAt } : {}) };
      }),
    };
  }

  /** The threads of a note, oldest first */
  list(noteId: string): CommentThread[] {
    const rows = this.db.prepare('SELECT * FROM comment_threads WHERE note_id = ? ORDER BY created_at, rowid').all(noteId) as unknown as ThreadRow[];
    return rows.map((r) => this.toThread(r));
  }

  /** User ids that wrote in the thread */
  participants(noteId: string, threadId: string): string[] {
    return [...new Set(this.payload(this.row(noteId, threadId)).comments.map((c) => c.authorId))];
  }

  create(noteId: string, userId: string, anchor: unknown, text: unknown, now = Date.now()): CommentThread {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM comment_threads WHERE note_id = ?').get(noteId) as { n: number }).n;
    if (count >= MAX_THREADS_PER_NOTE) throw new CommentError('Diese Notiz hat zu viele Kommentare.');
    const id = randomToken(12);
    const payload: ThreadPayload = { anchor: cleanAnchor(anchor), comments: [{ id: randomToken(8), authorId: userId, text: cleanText(text), at: now }] };
    this.db
      .prepare('INSERT INTO comment_threads (id, note_id, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run(id, noteId, now, now, this.cipher.encryptJson(payload, `comment_thread:${id}`));
    return this.toThread(this.row(noteId, id));
  }

  reply(noteId: string, threadId: string, userId: string, text: unknown, now = Date.now()): CommentThread {
    const r = this.row(noteId, threadId);
    const p = this.payload(r);
    if (p.comments.length >= MAX_COMMENTS_PER_THREAD) throw new CommentError('Dieser Kommentar hat zu viele Antworten.');
    p.comments.push({ id: randomToken(8), authorId: userId, text: cleanText(text), at: now });
    // An answer opens a resolved thread again
    this.write(threadId, p, now, false);
    return this.toThread(this.row(noteId, threadId));
  }

  edit(noteId: string, threadId: string, commentId: string, userId: string, text: unknown, now = Date.now()): CommentThread {
    const r = this.row(noteId, threadId);
    const p = this.payload(r);
    const c = p.comments.find((x) => x.id === commentId);
    if (!c) throw new CommentError('Diesen Kommentar gibt es nicht (mehr).', 404);
    if (c.authorId !== userId) throw new CommentError('Nur wer den Kommentar geschrieben hat, kann ihn ändern.', 403);
    c.text = cleanText(text);
    c.editedAt = now;
    this.write(threadId, p, now);
    return this.toThread(this.row(noteId, threadId));
  }

  setResolved(noteId: string, threadId: string, userId: string, resolved: boolean, now = Date.now()): CommentThread {
    const p = this.payload(this.row(noteId, threadId));
    p.resolvedBy = resolved ? userId : null;
    this.write(threadId, p, now, resolved);
    return this.toThread(this.row(noteId, threadId));
  }

  /** Deletes a comment (its author) or, as `manager`, any; a thread without comments is gone. Null: thread deleted */
  deleteComment(noteId: string, threadId: string, commentId: string, userId: string, manager: boolean, now = Date.now()): CommentThread | null {
    const r = this.row(noteId, threadId);
    const p = this.payload(r);
    const c = p.comments.find((x) => x.id === commentId);
    if (!c) throw new CommentError('Diesen Kommentar gibt es nicht (mehr).', 404);
    if (c.authorId !== userId && !manager) throw new CommentError('Nur wer den Kommentar geschrieben hat, kann ihn löschen.', 403);
    p.comments = p.comments.filter((x) => x.id !== commentId);
    if (!p.comments.length) {
      this.db.prepare('DELETE FROM comment_threads WHERE id = ?').run(threadId);
      return null;
    }
    this.write(threadId, p, now);
    return this.toThread(this.row(noteId, threadId));
  }

  /** Deletes a whole thread (whoever manages the note, or the one who started it) */
  deleteThread(noteId: string, threadId: string, userId: string, manager: boolean): void {
    const p = this.payload(this.row(noteId, threadId));
    if (!manager && p.comments[0]?.authorId !== userId) throw new CommentError('Nur wer die Notiz verwaltet, kann diesen Kommentar löschen.', 403);
    this.db.prepare('DELETE FROM comment_threads WHERE id = ?').run(threadId);
  }
}
