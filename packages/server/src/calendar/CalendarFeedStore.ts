import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import { CALENDAR_FEED_DAYS, type CalendarFeed, type CalendarFeedOptions } from '@kladde/shared';
import { DataCipher, randomToken, sha256 } from '../crypto.js';
import { AccountError } from '../UserStore.js';

const MAX_FEEDS_PER_USER = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Different from the MCP (`kld_`) and import (`kli_`) tokens, so no kind is mistaken for another */
const TOKEN_PREFIX = 'klc_';

interface FeedRow {
  id: string;
  user_id: string;
  name: string;
  options: Uint8Array;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
}

/** Options from the client, cleaned up; unknown or wrong values fall back to the defaults */
export function cleanFeedOptions(raw: unknown): CalendarFeedOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    includeDone: o.includeDone === true,
    folder: text(o.folder, 300).replace(/^\/+|\/+$/g, ''),
    tag: text(o.tag, 60).replace(/^#/, ''),
    showTitles: o.showTitles !== false,
    lang: o.lang === 'en' ? 'en' : 'de',
  };
}

/**
 * Secret calendar feed addresses, created by the user in the settings (expire after the chosen days,
 * revocable). Only SHA-256 hashes of the secrets are stored; the filter options (folder, tag) are encrypted.
 */
export class CalendarFeedStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher
  ) {}

  private toFeed(r: FeedRow): CalendarFeed {
    let options: CalendarFeedOptions;
    try {
      options = cleanFeedOptions(JSON.parse(this.cipher.decrypt(r.options, r.id).toString('utf8')));
    } catch {
      options = cleanFeedOptions({});
    }
    return { id: r.id, name: r.name, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at ?? null, options };
  }

  create(userId: string, name: unknown, rawOptions: unknown, days: unknown = CALENDAR_FEED_DAYS[0], now = Date.now()): { feed: CalendarFeed; secret: string } {
    if (!CALENDAR_FEED_DAYS.includes(days as (typeof CALENDAR_FEED_DAYS)[number])) {
      throw new AccountError(`Ungültige Gültigkeit – erlaubt sind ${[...CALENDAR_FEED_DAYS].sort((a, b) => a - b).join(', ')} Tage.`);
    }
    // Expired feeds no longer count against the limit
    this.db.prepare('DELETE FROM calendar_feeds WHERE user_id = ? AND expires_at <= ?').run(userId, now);
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM calendar_feeds WHERE user_id = ?').get(userId) as { n: number }).n);
    if (n >= MAX_FEEDS_PER_USER) throw new AccountError(`Höchstens ${MAX_FEEDS_PER_USER} Kalender-Feeds – widerrufe zuerst einen alten.`, 409);
    const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 60) || 'Kladde';
    const options = cleanFeedOptions(rawOptions);
    const id = crypto.randomUUID();
    const secret = `${TOKEN_PREFIX}${randomToken(32)}`;
    const expiresAt = now + (days as number) * DAY_MS;
    this.db
      .prepare('INSERT INTO calendar_feeds (id, user_id, name, token_hash, options, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, cleanName, sha256(secret), this.cipher.encrypt(JSON.stringify(options), id), now, expiresAt);
    return { feed: { id, name: cleanName, createdAt: now, expiresAt, lastUsedAt: null, options }, secret };
  }

  list(userId: string): CalendarFeed[] {
    return (this.db.prepare('SELECT * FROM calendar_feeds WHERE user_id = ? ORDER BY created_at DESC').all(userId) as unknown as FeedRow[]).map((r) => this.toFeed(r));
  }

  /** The revoked feed, null if it is unknown or someone else's */
  revoke(userId: string, id: string): CalendarFeed | null {
    const row = this.db.prepare('SELECT * FROM calendar_feeds WHERE id = ? AND user_id = ?').get(id, userId) as FeedRow | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM calendar_feeds WHERE id = ?').run(id);
    return this.toFeed(row);
  }

  /** Owner and feed of a secret, null if unknown or expired (bans are checked by the caller) */
  resolve(token: string | undefined, now = Date.now()): { userId: string; feed: CalendarFeed } | null {
    if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const row = this.db.prepare('SELECT * FROM calendar_feeds WHERE token_hash = ?').get(sha256(token)) as FeedRow | undefined;
    if (!row || row.expires_at <= now) return null;
    // Only write once a minute: calendar apps may poll often
    if ((row.last_used_at ?? 0) < now - 60_000) this.db.prepare('UPDATE calendar_feeds SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return { userId: row.user_id, feed: this.toFeed(row) };
  }
}
