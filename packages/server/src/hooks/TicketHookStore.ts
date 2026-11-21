import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import type { TicketHook, TicketHookProvider } from '@kladde/shared';
import { DataCipher, randomToken } from '../crypto.js';
import { AccountError } from '../UserStore.js';

/** At most this many webhooks per project */
const MAX_HOOKS_PER_PROJECT = 10;

interface HookRow {
  id: string;
  note_id: string;
  created_by: string;
  provider: string;
  created_at: number;
  last_at: number | null;
  payload: Uint8Array;
}

interface HookPayload {
  name: string;
  secret: string;
  last?: { at: number; ok: boolean; summary: string };
}

export interface ResolvedHook {
  id: string;
  noteId: string;
  createdBy: string;
  provider: TicketHookProvider;
  secret: string;
}

const isProvider = (v: unknown): v is TicketHookProvider => v === 'gitlab' || v === 'github';

/**
 * Webhooks of ticket projects. The id in the address finds the hook, the secret (encrypted, GitHub signs with it)
 * proves the sender; name and the last delivery are encrypted too, since they can name tickets.
 */
export class TicketHookStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher
  ) {}

  private payloadOf(r: HookRow): HookPayload {
    return this.cipher.decryptJson<HookPayload>(r.payload, `ticket_hook:${r.id}`);
  }

  private toHook(r: HookRow, username: (id: string) => string | null, baseUrl: string): TicketHook {
    const p = this.payloadOf(r);
    return { id: r.id, provider: r.provider as TicketHookProvider, name: p.name, createdBy: username(r.created_by) ?? '', createdAt: r.created_at, url: `${baseUrl}/api/hooks/${r.id}`, last: p.last ?? null };
  }

  list(noteId: string, username: (id: string) => string | null, baseUrl: string): TicketHook[] {
    const rows = this.db.prepare('SELECT * FROM ticket_hooks WHERE note_id = ? ORDER BY created_at').all(noteId) as unknown as HookRow[];
    return rows.map((r) => this.toHook(r, username, baseUrl));
  }

  create(noteId: string, userId: string, provider: unknown, name: unknown, now = Date.now()): { id: string; secret: string } {
    if (!isProvider(provider)) throw new AccountError('Unbekannter Anbieter – erlaubt sind GitLab und GitHub.');
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM ticket_hooks WHERE note_id = ?').get(noteId) as { n: number }).n;
    if (count >= MAX_HOOKS_PER_PROJECT) throw new AccountError(`Ein Projekt kann höchstens ${MAX_HOOKS_PER_PROJECT} Webhooks haben.`);
    const id = randomToken(18);
    const secret = randomToken(24);
    const label = (typeof name === 'string' ? name.trim().slice(0, 80) : '') || (provider === 'gitlab' ? 'GitLab' : 'GitHub');
    this.db
      .prepare('INSERT INTO ticket_hooks (id, note_id, created_by, provider, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, noteId, userId, provider, now, this.cipher.encryptJson({ name: label, secret } satisfies HookPayload, `ticket_hook:${id}`));
    return { id, secret };
  }

  /** Removes a hook of the project; false when it is not one of its hooks */
  remove(noteId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM ticket_hooks WHERE id = ? AND note_id = ?').run(id, noteId).changes) > 0;
  }

  resolve(id: unknown): ResolvedHook | null {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
    const r = this.db.prepare('SELECT * FROM ticket_hooks WHERE id = ?').get(id) as HookRow | undefined;
    if (!r || !isProvider(r.provider)) return null;
    return { id: r.id, noteId: r.note_id, createdBy: r.created_by, provider: r.provider, secret: this.payloadOf(r).secret };
  }

  recordDelivery(id: string, ok: boolean, summary: string, now = Date.now()): void {
    const r = this.db.prepare('SELECT * FROM ticket_hooks WHERE id = ?').get(id) as HookRow | undefined;
    if (!r) return;
    const p = this.payloadOf(r);
    p.last = { at: now, ok, summary: summary.slice(0, 300) };
    this.db.prepare('UPDATE ticket_hooks SET last_at = ?, payload = ? WHERE id = ?').run(now, this.cipher.encryptJson(p, `ticket_hook:${id}`), id);
  }
}

/** Compares secrets in constant time */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
