import fs from 'fs';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';

/** One file in a tar archive: its name inside the archive and where it is on disk */
export interface TarEntry {
  name: string;
  file: string;
  size: number;
  mtimeMs: number;
}

const BLOCK = 512;
/** ustar stores the size in 11 octal digits */
const MAX_SIZE = 8 ** 11 - 1;

const octal = (n: number, width: number) => `${Math.floor(n).toString(8).padStart(width - 1, '0')}\0`;

/** A ustar header block; names up to 100 bytes, or 255 with the prefix field */
export function tarHeader(name: string, size: number, mtimeMs: number): Buffer {
  if (size > MAX_SIZE) throw new Error(`File too large for tar: ${name}`);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`Path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const h = Buffer.alloc(BLOCK, 0);
  h.write(base, 0, 100, 'utf8');
  h.write(octal(0o600, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(mtimeMs / 1000, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

/** Bytes of the finished archive, so the download can announce its length */
export function tarSize(entries: TarEntry[]): number {
  return entries.reduce((sum, e) => sum + BLOCK + e.size + padding(e.size), 0) + 2 * BLOCK;
}

function write(out: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('Output closed'));
    if (out.write(chunk)) return resolve();
    const onDrain = () => {
      out.off('close', onClose);
      resolve();
    };
    const onClose = () => {
      out.off('drain', onDrain);
      reject(new Error('Output closed'));
    };
    out.once('drain', onDrain);
    out.once('close', onClose);
  });
}

/** Streams the entries as an uncompressed tar archive into `out` (which is not ended) */
export async function writeTar(entries: TarEntry[], out: Writable): Promise<void> {
  for (const entry of entries) {
    await write(out, tarHeader(entry.name, entry.size, entry.mtimeMs));
    // Exactly the announced size, even if the file changed in between, so the archive stays readable
    let sent = 0;
    if (entry.size > 0) {
      const source = fs.createReadStream(entry.file, { start: 0, end: entry.size - 1 });
      source.on('data', (chunk) => {
        sent += (chunk as Buffer).length;
      });
      await pipeline(source, out, { end: false });
    }
    if (sent < entry.size) await write(out, Buffer.alloc(entry.size - sent, 0));
    const pad = padding(entry.size);
    if (pad) await write(out, Buffer.alloc(pad, 0));
  }
  await write(out, Buffer.alloc(2 * BLOCK, 0));
}
