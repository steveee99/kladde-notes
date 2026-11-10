import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DataCipher } from './crypto.js';

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ALLOWED_AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

function matchesImageMagic(mime: string, data: Buffer): boolean {
  if (mime === 'image/png') {
    return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === 'image/jpeg') {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (mime === 'image/gif') {
    if (data.length < 6) return false;
    const hdr = data.subarray(0, 6).toString('ascii');
    return hdr === 'GIF87a' || hdr === 'GIF89a';
  }
  if (mime === 'image/webp') {
    return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mime === 'image/avif') {
    return data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  return false;
}

/**
 * Profile pictures encrypted at rest below `<dataDir>/avatars` using DataCipher (AAD `avatar:${id}`).
 * Ids are random 128-bit base64url tokens rotated on every upload for clean immutable caching.
 */
export class AvatarStore {
  private readonly dir: string;

  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher,
    dataDir: string
  ) {
    this.dir = path.join(dataDir, 'avatars');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  save(userId: string, rawMime: string, data: Buffer): { id: string; url: string; mime: string } {
    const mime = rawMime.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_AVATAR_MIMES.has(mime)) {
      throw new Error('Nur PNG-, JPEG-, WebP-, GIF- oder AVIF-Bilder sind erlaubt.');
    }
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new Error('Bilddatei ist leer.');
    }
    if (data.length > MAX_AVATAR_BYTES) {
      throw new Error('Das Profilbild ist zu groß (max. 5 MB).');
    }
    if (!matchesImageMagic(mime, data)) {
      throw new Error('Ungültige oder beschädigte Bilddatei.');
    }

    const prev = this.db.prepare('SELECT avatar_id FROM users WHERE id = ?').get(userId) as { avatar_id: string | null } | undefined;
    const id = crypto.randomBytes(16).toString('base64url');
    fs.writeFileSync(path.join(this.dir, id), this.cipher.encrypt(data, `avatar:${id}`), { mode: 0o600 });
    this.db.prepare('UPDATE users SET avatar_id = ?, avatar_mime = ? WHERE id = ?').run(id, mime, userId);

    if (prev?.avatar_id && prev.avatar_id !== id) {
      fs.rmSync(path.join(this.dir, prev.avatar_id), { force: true });
    }
    return { id, url: `/api/avatars/${id}`, mime };
  }

  remove(userId: string): boolean {
    const prev = this.db.prepare('SELECT avatar_id FROM users WHERE id = ?').get(userId) as { avatar_id: string | null } | undefined;
    if (!prev?.avatar_id) return false;
    this.db.prepare('UPDATE users SET avatar_id = NULL, avatar_mime = NULL WHERE id = ?').run(userId);
    fs.rmSync(path.join(this.dir, prev.avatar_id), { force: true });
    return true;
  }

  load(id: string): { mime: string; data: Buffer } | null {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const row = this.db.prepare('SELECT avatar_mime FROM users WHERE avatar_id = ? AND banned_at IS NULL').get(id) as
      | { avatar_mime: string | null }
      | undefined;
    if (!row?.avatar_mime) return null;
    try {
      return { mime: row.avatar_mime, data: this.cipher.decrypt(fs.readFileSync(path.join(this.dir, id)), `avatar:${id}`) };
    } catch {
      return null;
    }
  }
}
