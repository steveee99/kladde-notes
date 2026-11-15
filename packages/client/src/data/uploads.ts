/**
 * Attachments added while offline (#28). The file is kept in IndexedDB with a temporary id, and the note
 * links it as `kladde-pending:<id>`; the editor shows it from the local copy. Once the device is online the
 * file is uploaded and every link is replaced by the real attachment URL as a normal synced edit (so the
 * three-way merge handles concurrent changes). Other people see a placeholder until then.
 */
import { useSyncExternalStore } from 'react';
import { MAX_FILE_BYTES } from '@kladde/shared';
import { ApiError, uploadFile } from '../lib/api';
import { t } from '../lib/i18n';
import type { LocalDb, PendingUpload } from './db';
import { vault } from './vault';

export const PENDING_SCHEME = 'kladde-pending:';

/** The temporary id in a `kladde-pending:<id>` link, or null */
export function pendingId(url: string): string | null {
  return url.startsWith(PENDING_SCHEME) ? url.slice(PENDING_SCHEME.length).replace(/[^\w-]/g, '') || null : null;
}

type Uploaded = { url: string; name: string; mime: string };

class UploadQueue {
  private db: LocalDb | null = null;
  private userId = '';
  private items = new Map<string, PendingUpload>();
  private objectUrls = new Map<string, string>();
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  version = 0;

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => this.process());
    // Opens with the vault's account, and tries again when links to pending files show up (the editor saves with a delay)
    vault.subscribe(() => {
      const local = vault.localDb();
      if (local && local.userId !== this.userId) void this.open(local.db, local.userId);
      else if (!local && this.userId) this.close();
      else if (this.items.size) this.soon();
    });
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  private async open(db: LocalDb, userId: string) {
    this.close();
    this.db = db;
    this.userId = userId;
    for (const item of await db.getAll('uploads')) {
      if (this.userId !== userId) return;
      this.items.set(item.id, item);
    }
    this.emit();
    this.process();
  }

  private close() {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.items.clear();
    this.db = null;
    this.userId = '';
    this.emit();
  }

  list(): PendingUpload[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** A blob: URL for a pending file on this device, null when it is not here (another device or person) */
  objectUrl(id: string): string | null {
    const item = this.items.get(id);
    if (!item) return null;
    let url = this.objectUrls.get(id);
    if (!url) this.objectUrls.set(id, (url = URL.createObjectURL(item.blob)));
    return url;
  }

  /** Keeps a file for later; the returned link goes into the note like a normal attachment link */
  async enqueue(file: File): Promise<Uploaded> {
    if (file.size > MAX_FILE_BYTES) throw new Error(t('uploads.tooLarge', { mb: Math.round(MAX_FILE_BYTES / 1024 / 1024) }));
    if (!this.db) throw new Error(t('note.uploadOnlineOnly'));
    const id = crypto.randomUUID().replace(/-/g, '');
    const item: PendingUpload = { id, name: file.name || 'Datei', mime: file.type || 'application/octet-stream', size: file.size, blob: file, createdAt: Date.now() };
    await this.db.put('uploads', item);
    this.items.set(id, item);
    this.emit();
    this.soon();
    return { url: `${PENDING_SCHEME}${id}`, name: item.name, mime: item.mime };
  }

  /** Uploads right away when online; on a network error the file waits in the queue */
  async upload(file: File): Promise<Uploaded> {
    if (!navigator.onLine) return this.enqueue(file);
    try {
      return await uploadFile(file);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      return this.enqueue(file);
    }
  }

  async discard(id: string): Promise<void> {
    await this.db?.delete('uploads', id);
    this.items.delete(id);
    const url = this.objectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.objectUrls.delete(id);
    this.emit();
  }

  async retry(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    delete item.error;
    await this.db?.put('uploads', item);
    this.emit();
    this.process();
  }

  private soon() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.process(), 1500);
  }

  process(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.process();
      }
    });
  }

  private async run() {
    for (const item of this.list()) {
      if (!this.db || !navigator.onLine || item.error) continue;
      const link = `${PENDING_SCHEME}${item.id}`;
      // Not in any note (yet): the editor may not have saved it; it waits, and the list offers to discard it
      if (!vault.mentions(link)) continue;
      let result: Uploaded;
      try {
        result = await uploadFile(new File([item.blob], item.name, { type: item.mime }));
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
          item.error = err.message;
          await this.db?.put('uploads', item);
          this.emit();
          continue;
        }
        // Offline again, server unavailable or signed out: try later
        return;
      }
      await vault.replaceEverywhere(link, result.url);
      await this.discard(item.id);
    }
  }
}

export const uploads = new UploadQueue();

export function usePendingUploads(): PendingUpload[] {
  useSyncExternalStore(uploads.subscribe, () => uploads.version);
  return uploads.list();
}
