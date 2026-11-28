import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EventDelivery, EventSource, TicketHookProvider } from '@kladde/shared';
import { DataCipher, randomToken } from '../crypto.js';
import { AccountError } from '../UserStore.js';

/** At most this many central webhooks per account or group */
export const MAX_SOURCES_PER_OWNER = 20;
/** Deliveries kept per webhook for the settings */
const KEEP_DELIVERIES = 20;
/** Delivery ids remembered against repeats (GitLab and GitHub retry within hours, not days) */
const DEDUP_MS = 3 * 86_400_000;
const MAX_PROJECTS = 20;

interface SourceRow {
  id: string;
  owner_id: string;
  created_by: string;
  provider: string;
  created_at: number;
  last_at: number | null;
  payload: Uint8Array;
}

interface SourcePayload {
  name: string;
  secret: string;
  projects: string[];
  deliveries: EventDelivery[];
}

export interface ResolvedSource {
  id: string;
  ownerId: string;
  createdBy: string;
  provider: TicketHookProvider;
  secret: string;
  projects: string[];
}

const isProvider = (v: unknown): v is TicketHookProvider => v === 'gitlab' || v === 'github';
const ID = /^[A-Za-z0-9_-]{16,64}$/;

/** Repository paths a webhook takes: `group/project` or a group path, without slashes at the ends */
export function cleanProjects(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!p) continue;
    if (p.length > 300 || !/^[\w.-]+(\/[\w.-]+)*$/.test(p)) throw new AccountError(`„${p.slice(0, 60)}“ ist kein Projekt- oder Gruppenpfad (z. B. gruppe/projekt).`);
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  if (out.length > MAX_PROJECTS) throw new AccountError(`Höchstens ${MAX_PROJECTS} Pfade pro Webhook.`);
  return out;
}

/**
 * Central webhooks (#149): one per GitLab/GitHub project or group, owned by an account or a group. The id in the
 * address finds it, the secret (encrypted, GitHub signs with it) proves the sender; name, project paths and the
 * delivery list are encrypted too. Delivery ids are kept as hashes for a few days, so a repeated delivery is
 * published only once.
 */
export class EventSourceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher
  ) {}

  private aad(id: string) {
    return `event_source:${id}`;
  }

  private payloadOf(r: SourceRow): SourcePayload {
    const p = this.cipher.decryptJson<Partial<SourcePayload>>(r.payload, this.aad(r.id));
    return { name: p.name ?? '', secret: p.secret ?? '', projects: p.projects ?? [], deliveries: p.deliveries ?? [] };
  }

  private row(id: unknown): SourceRow | undefined {
    if (typeof id !== 'string' || !ID.test(id)) return undefined;
    return this.db.prepare('SELECT * FROM event_sources WHERE id = ?').get(id) as SourceRow | undefined;
  }

  private write(id: string, p: SourcePayload, lastAt?: number): void {
    if (lastAt === undefined) this.db.prepare('UPDATE event_sources SET payload = ? WHERE id = ?').run(this.cipher.encryptJson(p, this.aad(id)), id);
    else this.db.prepare('UPDATE event_sources SET payload = ?, last_at = ? WHERE id = ?').run(this.cipher.encryptJson(p, this.aad(id)), lastAt, id);
  }

  /** The webhooks of these owners (an account and the groups it manages), oldest first */
  list(ownerIds: string[], describe: (r: { id: string; ownerId: string; createdBy: string; provider: TicketHookProvider; createdAt: number }) => Omit<EventSource, 'name' | 'projects' | 'deliveries'>): EventSource[] {
    if (!ownerIds.length) return [];
    const rows = this.db.prepare(`SELECT * FROM event_sources WHERE owner_id IN (${ownerIds.map(() => '?').join(', ')}) ORDER BY created_at, id`).all(...ownerIds) as unknown as SourceRow[];
    return rows
      .filter((r) => isProvider(r.provider))
      .map((r) => {
        const p = this.payloadOf(r);
        return { ...describe({ id: r.id, ownerId: r.owner_id, createdBy: r.created_by, provider: r.provider as TicketHookProvider, createdAt: r.created_at }), name: p.name, projects: p.projects, deliveries: p.deliveries };
      });
  }

  ownerOf(id: unknown): string | null {
    return this.row(id)?.owner_id ?? null;
  }

  create(ownerId: string, userId: string, input: { provider: unknown; name: unknown; projects: unknown }, now = Date.now()): { id: string; secret: string } {
    if (!isProvider(input.provider)) throw new AccountError('Unbekannter Anbieter – erlaubt sind GitLab und GitHub.');
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM event_sources WHERE owner_id = ?').get(ownerId) as { n: number }).n;
    if (count >= MAX_SOURCES_PER_OWNER) throw new AccountError(`Höchstens ${MAX_SOURCES_PER_OWNER} Webhooks pro Konto oder Gruppe.`);
    const projects = cleanProjects(input.projects);
    const id = randomToken(18);
    const secret = randomToken(24);
    const name = (typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '') || projects[0] || (input.provider === 'gitlab' ? 'GitLab' : 'GitHub');
    this.db
      .prepare('INSERT INTO event_sources (id, owner_id, created_by, provider, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, userId, input.provider, now, this.cipher.encryptJson({ name, secret, projects, deliveries: [] } satisfies SourcePayload, this.aad(id)));
    return { id, secret };
  }

  /** Name and project paths; the rest stays */
  update(id: string, change: { name?: unknown; projects?: unknown }): void {
    const r = this.row(id);
    if (!r) return;
    const p = this.payloadOf(r);
    if (typeof change.name === 'string' && change.name.trim()) p.name = change.name.trim().slice(0, 80);
    if (change.projects !== undefined) p.projects = cleanProjects(change.projects);
    this.write(id, p);
  }

  /** A new secret (the old one stops working at once); null when the webhook is gone */
  rotate(id: string): string | null {
    const r = this.row(id);
    if (!r) return null;
    const p = this.payloadOf(r);
    p.secret = randomToken(24);
    this.write(id, p);
    return p.secret;
  }

  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM event_sources WHERE id = ?').run(id).changes) > 0;
  }

  resolve(id: unknown): ResolvedSource | null {
    const r = this.row(id);
    if (!r || !isProvider(r.provider)) return null;
    const p = this.payloadOf(r);
    return { id: r.id, ownerId: r.owner_id, createdBy: r.created_by, provider: r.provider, secret: p.secret, projects: p.projects };
  }

  /** True the first time a delivery id arrives at this webhook; repeats within a few days are false */
  claim(sourceId: string, deliveryId: string, now = Date.now()): boolean {
    const key = crypto.createHash('sha256').update(deliveryId).digest('hex').slice(0, 40);
    this.db.prepare('DELETE FROM event_deliveries WHERE at < ?').run(now - DEDUP_MS);
    return Number(this.db.prepare('INSERT OR IGNORE INTO event_deliveries (source_id, delivery, at) VALUES (?, ?, ?)').run(sourceId, key, now).changes) > 0;
  }

  /** Adds a delivery to the list (or updates the one with the same id) */
  record(sourceId: string, delivery: EventDelivery): void {
    const r = this.row(sourceId);
    if (!r) return;
    const p = this.payloadOf(r);
    const entry = { ...delivery, detail: delivery.detail.slice(0, 300), project: delivery.project.slice(0, 300) };
    const i = p.deliveries.findIndex((d) => d.id === delivery.id && d.status !== 'duplicate' && delivery.status !== 'duplicate');
    if (i >= 0) p.deliveries[i] = entry;
    else p.deliveries.unshift(entry);
    p.deliveries.length = Math.min(p.deliveries.length, KEEP_DELIVERIES);
    this.write(sourceId, p, delivery.at);
  }
}
