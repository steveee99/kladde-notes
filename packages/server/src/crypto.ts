import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const FORMAT_V1 = 1;

/**
 * Encryption at rest: note contents, paths and attachments are stored with AES-256-GCM.
 * The key comes from DATA_KEY (base64, 32 bytes) or a key file generated next to the database.
 * With the key file on the same volume this protects copies of the database and backups
 * (e.g. on a NAS or in Git), not a fully compromised server.
 */
export class DataCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('The data key must be 32 bytes');
  }

  static fromEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env): DataCipher {
    const fromEnv = env.DATA_KEY?.trim();
    if (fromEnv) return new DataCipher(Buffer.from(fromEnv, 'base64'));
    const file = path.join(dataDir, 'secret.key');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
      console.log(`🔑 Neuer Datenschlüssel erzeugt: ${file} – sichere ihn, ohne ihn sind die Notizen nicht lesbar`);
    }
    return new DataCipher(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64'));
  }

  /** `aad` binds the ciphertext to its record (e.g. the note id), so blobs cannot be swapped between rows */
  encrypt(plain: Buffer | string, aad: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(typeof plain === 'string' ? Buffer.from(plain) : plain), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT_V1]), iv, cipher.getAuthTag(), body]);
  }

  decrypt(blob: Uint8Array, aad: string): Buffer {
    const buf = Buffer.from(blob);
    if (buf[0] !== FORMAT_V1) throw new Error('Unknown encryption format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(1, 13));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(buf.subarray(13, 29));
    return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]);
  }

  encryptJson(value: unknown, aad: string): Buffer {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(blob: Uint8Array, aad: string): T {
    return JSON.parse(this.decrypt(blob, aad).toString('utf8')) as T;
  }
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
