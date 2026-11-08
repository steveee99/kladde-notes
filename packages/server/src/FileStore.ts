import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DataCipher } from './crypto.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpeg|gif|webp|svg\+xml|avif)|application\/pdf)$/;

/** Attachments (images, PDFs), encrypted on disk below <data>/files. Ids are random and act as the access key */
export class FileStore {
  private readonly dir: string;

  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher,
    dataDir: string
  ) {
    this.dir = path.join(dataDir, 'files');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  save(ownerId: string, name: string, mime: string, data: Buffer): { id: string; mime: string } {
    if (!ALLOWED.test(mime)) throw new Error('Nur Bilder und PDF-Dateien sind erlaubt.');
    if (data.length > MAX_FILE_BYTES) throw new Error('Die Datei ist zu groß (max. 25 MB).');
    const id = crypto.randomBytes(16).toString('base64url');
    fs.writeFileSync(path.join(this.dir, id), this.cipher.encrypt(data, `file:${id}`), { mode: 0o600 });
    this.db
      .prepare('INSERT INTO files (id, owner_id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, name.slice(0, 200), mime, data.length, Date.now());
    return { id, mime };
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
}
