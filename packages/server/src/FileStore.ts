import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { MAX_FILE_BYTES } from '@kladde/shared';
import { DataCipher } from './crypto.js';

export { MAX_FILE_BYTES };
// Audio: voice notes (#33) – webm/ogg from Chrome and Firefox, mp4/aac from Safari
const ALLOWED = /^(image\/(png|jpeg|gif|webp|svg\+xml|avif)|application\/pdf|audio\/(webm|ogg|mp4|mpeg|aac|wav|x-wav|x-m4a))$/;

export interface StoredFileMeta {
  id: string;
  ownerId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

interface FileRow {
  id: string;
  owner_id: string;
  name: string;
  mime: string;
  size: number;
  created_at: number;
}

const toMeta = (r: FileRow): StoredFileMeta => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  mime: r.mime,
  size: r.size,
  createdAt: r.created_at,
});

/** Attachments (images, PDFs), encrypted on disk below <data>/files. Ids are random and act as the access key */
export class FileStore {
  private readonly dir: string;
  private readonly savedListeners: ((id: string, mime: string) => void)[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher,
    dataDir: string
  ) {
    this.dir = path.join(dataDir, 'files');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  save(ownerId: string, name: string, mime: string, data: Buffer): { id: string; mime: string } {
    // Values come from request headers, query and body: never trust their type
    if (typeof name !== 'string' || typeof mime !== 'string' || !Buffer.isBuffer(data)) throw new Error('Ungültige Datei.');
    // A parsed body could in theory be an array; CodeQL knows this guard, not Buffer.isBuffer
    if (Array.isArray(data)) throw new Error('Ungültige Datei.');
    if (!ALLOWED.test(mime)) throw new Error('Nur Bilder, PDF- und Audiodateien sind erlaubt.');
    if (data.length > MAX_FILE_BYTES) throw new Error('Die Datei ist zu groß (max. 25 MB).');
    const id = crypto.randomBytes(16).toString('base64url');
    fs.writeFileSync(path.join(this.dir, id), this.cipher.encrypt(data, `file:${id}`), { mode: 0o600 });
    this.db
      .prepare('INSERT INTO files (id, owner_id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, name.slice(0, 200), mime, data.length, Date.now());
    for (const fn of this.savedListeners) {
      try {
        fn(id, mime);
      } catch (err) {
        console.error('File listener failed:', err);
      }
    }
    return { id, mime };
  }

  /** Called after every new attachment (e.g. to extract its text for the search) */
  onSaved(fn: (id: string, mime: string) => void): void {
    this.savedListeners.push(fn);
  }

  exists(id: string): boolean {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return false;
    return !!this.db.prepare('SELECT 1 FROM files WHERE id = ?').get(id);
  }

  /** Metadata by id alone: the random id is the access key (like GET /api/files/:id) */
  meta(id: string): StoredFileMeta | null {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const row = this.db.prepare('SELECT id, owner_id, name, mime, size, created_at FROM files WHERE id = ?').get(id) as FileRow | undefined;
    return row ? toMeta(row) : null;
  }

  load(id: string): { mime: string; name: string; data: Buffer } | null {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const row = this.db.prepare('SELECT mime, name FROM files WHERE id = ?').get(id) as { mime: string; name: string } | undefined;
    if (!row) return null;
    try {
      return { ...row, data: this.cipher.decrypt(fs.readFileSync(path.join(this.dir, id)), `file:${id}`) };
    } catch {
      return null;
    }
  }

  listByOwner(ownerId: string): StoredFileMeta[] {
    const rows = this.db.prepare('SELECT id, owner_id, name, mime, size, created_at FROM files WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId) as unknown as FileRow[];
    return rows.map(toMeta);
  }

  getMeta(ownerId: string, id: string): StoredFileMeta | null {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const row = this.db.prepare('SELECT id, owner_id, name, mime, size, created_at FROM files WHERE id = ? AND owner_id = ?').get(id, ownerId) as FileRow | undefined;
    return row ? toMeta(row) : null;
  }

  delete(ownerId: string, id: string): boolean {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return false;
    const res = this.db.prepare('DELETE FROM files WHERE id = ? AND owner_id = ?').run(id, ownerId);
    if (Number(res.changes) === 0) return false;
    fs.rmSync(path.join(this.dir, id), { force: true });
    return true;
  }
}
