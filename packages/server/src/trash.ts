/**
 * Trash housekeeping (#25): how long deleted notes stay restorable, the automatic purge, and dropping
 * attachments that only purged notes used.
 */
import { attachmentUsageMap, FILE_URL_RE } from './cliActions.js';
import type { FileStore } from './FileStore.js';
import type { NoteStore } from './NoteStore.js';

export const DEFAULT_TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `TRASH_RETENTION_DAYS` (default 30; `0` keeps deleted notes until they are purged by hand) */
export function trashRetentionDays(env: NodeJS.ProcessEnv): number {
  const raw = env.TRASH_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_TRASH_DAYS;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_TRASH_DAYS;
}

/** Deletes the owner's attachments that `purged` note contents referenced and no other note (or trashed note) uses */
export function dropUnusedAttachments(notes: NoteStore, files: FileStore, ownerId: string, purged: string[]): string[] {
  const candidates = new Set<string>();
  for (const content of purged) for (const m of content.matchAll(FILE_URL_RE)) candidates.add(m[1]);
  if (!candidates.size) return [];
  const usage = attachmentUsageMap(notes, ownerId);
  const trashed = notes.trashedContents(ownerId).join('\n');
  const dropped: string[] = [];
  for (const id of candidates) {
    if (usage.has(id) || trashed.includes(`/api/files/${id}`)) continue;
    if (files.delete(ownerId, id)) dropped.push(id);
  }
  return dropped;
}

/** Purges notes trashed more than `days` ago (and attachments only they used); returns how many */
export function purgeExpiredTrash(notes: NoteStore, files: FileStore, days: number, now = Date.now()): number {
  if (days <= 0) return 0;
  let count = 0;
  for (const [ownerId, contents] of notes.purgeOlderThan(now - days * DAY_MS)) {
    count += contents.length;
    dropUnusedAttachments(notes, files, ownerId, contents);
  }
  return count;
}
