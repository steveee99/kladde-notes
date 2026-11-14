import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import type { PushDevice, PushSettings } from '@kladde/shared';
import { DataCipher, sha256 } from '../crypto.js';
import { AccountError } from '../UserStore.js';
import { generateVapidKeys, isAllowedEndpoint, isValidKeys, type PushTarget, type VapidKeys } from './webpush.js';

const MAX_DEVICES_PER_USER = 10;
const VAPID_AAD = 'vapid-private-key';

interface SubscriptionRow {
  id: string;
  user_id: string;
  target: Uint8Array;
  name: string;
  settings: string;
  created_at: number;
  last_sent_at: number | null;
}

export interface StoredSubscription {
  id: string;
  userId: string;
  target: PushTarget;
  settings: PushSettings;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || tz.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Settings from the client, cleaned up; wrong values fall back to "off" */
export function cleanPushSettings(raw: unknown): PushSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const time = (v: unknown) => (typeof v === 'string' && TIME.test(v) ? v : null);
  const quietStart = time(o.quietStart);
  const quietEnd = time(o.quietEnd);
  const quiet = quietStart && quietEnd && quietStart !== quietEnd;
  return {
    digestTime: time(o.digestTime),
    quietStart: quiet ? quietStart : null,
    quietEnd: quiet ? quietEnd : null,
    showText: o.showText === true,
    timeZone: validTimeZone(o.timeZone),
    lang: o.lang === 'en' ? 'en' : 'de',
  };
}

/**
 * VAPID keys (created on first start, private key encrypted) and the devices that receive reminders.
 * Endpoints and device keys are encrypted: they are capabilities to message the device.
 */
export class PushStore {
  private keys: VapidKeys | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher,
    private readonly allowedHosts: string[]
  ) {}

  vapidKeys(): VapidKeys {
    if (this.keys) return this.keys;
    const row = this.db.prepare('SELECT public_key, private_key FROM push_keys WHERE id = 1').get() as { public_key: string; private_key: Uint8Array } | undefined;
    if (row) {
      this.keys = { publicKey: row.public_key, privateKeyPem: this.cipher.decrypt(row.private_key, VAPID_AAD).toString('utf8') };
    } else {
      const keys = generateVapidKeys();
      this.db.prepare('INSERT INTO push_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)').run(keys.publicKey, this.cipher.encrypt(keys.privateKeyPem, VAPID_AAD), Date.now());
      this.keys = keys;
    }
    return this.keys;
  }

  private toDevice(r: SubscriptionRow): PushDevice {
    let settings: PushSettings;
    try {
      settings = cleanPushSettings(JSON.parse(r.settings));
    } catch {
      settings = cleanPushSettings({});
    }
    return { id: r.id, name: r.name, createdAt: r.created_at, lastSentAt: r.last_sent_at ?? null, settings };
  }

  /** Adds a device, or updates it when the browser hands out the same endpoint again */
  subscribe(userId: string, raw: unknown, name: unknown, settings: unknown, now = Date.now()): PushDevice {
    const sub = (raw && typeof raw === 'object' ? raw : {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (!isAllowedEndpoint(sub.endpoint, this.allowedHosts)) throw new AccountError('Dieser Push-Dienst wird nicht unterstützt.');
    if (!isValidKeys(sub.keys?.p256dh, sub.keys?.auth)) throw new AccountError('Ungültiges Push-Abonnement.');
    const target: PushTarget = { endpoint: sub.endpoint, p256dh: sub.keys!.p256dh as string, auth: sub.keys!.auth as string };
    const hash = sha256(target.endpoint);
    const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 60) || 'Gerät';
    const cleanSettings = JSON.stringify(cleanPushSettings(settings));
    const existing = this.db.prepare('SELECT id FROM push_subscriptions WHERE endpoint_hash = ?').get(hash) as { id: string } | undefined;
    // A browser endpoint belongs to one account: re-subscribing under another account moves it
    if (existing) this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(existing.id);
    else {
      const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number }).n);
      if (n >= MAX_DEVICES_PER_USER) throw new AccountError(`Höchstens ${MAX_DEVICES_PER_USER} Geräte – entferne zuerst ein altes.`, 409);
    }
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO push_subscriptions (id, user_id, endpoint_hash, target, name, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, hash, this.cipher.encrypt(JSON.stringify(target), id), cleanName, cleanSettings, now);
    return this.device(userId, id)!;
  }

  device(userId: string, id: string): PushDevice | null {
    const row = this.db.prepare('SELECT * FROM push_subscriptions WHERE id = ? AND user_id = ?').get(id, userId) as SubscriptionRow | undefined;
    return row ? this.toDevice(row) : null;
  }

  list(userId: string): PushDevice[] {
    return (this.db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC').all(userId) as unknown as SubscriptionRow[]).map((r) => this.toDevice(r));
  }

  updateSettings(userId: string, id: string, settings: unknown): PushDevice | null {
    const res = this.db.prepare('UPDATE push_subscriptions SET settings = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(cleanPushSettings(settings)), id, userId);
    return res.changes ? this.device(userId, id) : null;
  }

  remove(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  /** Called when the push service says the subscription is gone */
  drop(id: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  }

  /** Every device of every user, decrypted (for the reminder job) */
  all(): StoredSubscription[] {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions').all() as unknown as SubscriptionRow[];
    const out: StoredSubscription[] = [];
    for (const r of rows) {
      try {
        out.push({ id: r.id, userId: r.user_id, target: JSON.parse(this.cipher.decrypt(r.target, r.id).toString('utf8')), settings: this.toDevice(r).settings });
      } catch {
        // Unreadable (key changed): the device has to subscribe again
      }
    }
    return out;
  }

  target(userId: string, id: string): StoredSubscription | null {
    return this.all().find((s) => s.id === id && s.userId === userId) ?? null;
  }

  /** Records that `key` went to the device; false if it already had (each reminder goes out once) */
  claim(subscriptionId: string, key: string, now = Date.now()): boolean {
    const res = this.db.prepare('INSERT OR IGNORE INTO push_sent (subscription_id, key, sent_at) VALUES (?, ?, ?)').run(subscriptionId, sha256(key), now);
    if (res.changes) this.db.prepare('UPDATE push_subscriptions SET last_sent_at = ? WHERE id = ?').run(now, subscriptionId);
    return res.changes > 0;
  }

  pruneSent(before: number): void {
    this.db.prepare('DELETE FROM push_sent WHERE sent_at < ?').run(before);
  }
}
