import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Writable } from 'stream';
import { APP_VERSION, SYSTEM_PREFIX, TEMPLATES_SETTING, crc32, normalizeTemplates, splitPath, type AccountExportStatus } from '@kladde/shared';
import type { NoteStore } from '../NoteStore.js';
import type { FileStore } from '../FileStore.js';
import { FILE_URL_RE } from '../cliActions.js';
import { safeFileSegment } from '../importScan.js';

/**
 * Export of a whole account as a ZIP archive (#93). The archive is written in the background to a file
 * that is encrypted with a key only this process holds in memory (notes never lie on disk in plain text,
 * and a restart makes leftovers useless; they are deleted at start). It can be downloaded once and
 * expires after `EXPORT_TTL_MS`.
 *
 * Layout, readable by the import CLI (`npm run import`): the notes as Markdown in their folders, the
 * attachments in `_attachments/` (links point there relatively), `kladde-account.json` with settings,
 * templates, groups and shares; hidden folders (skipped by the import): `.templates/` and, optionally, `.history/`.
 */

export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const ZIP_LIMIT = 0xffffffff;
const ENTRY_LIMIT = 0xffff;

interface Job extends AccountExportStatus {
  userId: string;
  file: string;
  key: Buffer;
  iv: Buffer;
  tag?: Buffer;
}

/** DOS date/time of a JS date */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A streaming ZIP writer (stored entries, UTF-8 names), awaiting backpressure of the target stream */
export class ZipStream {
  private offset = 0;
  private readonly centrals: Buffer[] = [];
  private readonly names = new Set<string>();

  constructor(private readonly out: Writable) {}

  get entries(): number {
    return this.centrals.length;
  }

  private async write(chunk: Buffer): Promise<void> {
    if (!this.out.write(chunk)) await new Promise<void>((resolve) => this.out.once('drain', resolve));
  }

  /** Adds a file; a name already used gets " (2)", " (3)", … before its extension */
  async add(name: string, content: string | Buffer, when = new Date()): Promise<string> {
    let unique = name.replace(/^\/+/, '');
    if (this.names.has(unique.toLowerCase())) {
      const ext = path.posix.extname(unique);
      const base = unique.slice(0, unique.length - ext.length);
      for (let i = 2; this.names.has(unique.toLowerCase()); i++) unique = `${base} (${i})${ext}`;
    }
    this.names.add(unique.toLowerCase());
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const nameBytes = Buffer.from(unique, 'utf8');
    if (this.centrals.length + 1 >= ENTRY_LIMIT || this.offset + 30 + nameBytes.length + data.length > ZIP_LIMIT) {
      throw new Error('Das Konto ist für ein ZIP-Archiv zu groß (über 4 GB oder 65.000 Dateien).');
    }
    const crc = crc32(data);
    const { time, date } = dosTime(when);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(this.offset, 42);
    this.centrals.push(Buffer.concat([central, nameBytes]));
    await this.write(Buffer.concat([local, nameBytes]));
    await this.write(data);
    this.offset += 30 + nameBytes.length + data.length;
    return unique;
  }

  async finish(): Promise<void> {
    const dir = Buffer.concat(this.centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.centrals.length, 8);
    end.writeUInt16LE(this.centrals.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(this.offset, 16);
    await this.write(dir);
    await this.write(end);
  }
}

/** A relative link from a note's folder to a path from the archive root */
function relativeFrom(noteFolder: string, target: string): string {
  const rel = noteFolder ? path.posix.relative(noteFolder, target) : target;
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Spaces and brackets would end a Markdown link target: encode them */
const linkTarget = (p: string) => p.split('/').map((s) => encodeURIComponent(s).replace(/%2E/gi, '.')).join('/');

/** Contents of one account, written into a ZIP stream */
export async function writeAccountZip(
  zip: ZipStream,
  deps: { notes: NoteStore; files: FileStore },
  user: { id: string; username: string },
  opts: { history: boolean; now?: Date; yieldEvery?: number }
): Promise<{ notes: number; files: number }> {
  const now = opts.now ?? new Date();
  const all = deps.notes.ownedNotes(user.id);
  const own = all.filter((n) => !n.path.startsWith(SYSTEM_PREFIX)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const tick = async (i: number) => {
    if (i % (opts.yieldEvery ?? 25) === 0) await new Promise((r) => setImmediate(r));
  };

  // Attachments first: notes link to the names they get here
  const attachmentPath = new Map<string, string>();
  let fileCount = 0;
  const metas = deps.files.listByOwner(user.id);
  for (const [i, meta] of metas.entries()) {
    const loaded = deps.files.load(meta.id);
    if (!loaded) continue;
    const stored = await zip.add(`_attachments/${meta.id}-${safeFileSegment(meta.name)}`, loaded.data, new Date(meta.createdAt));
    attachmentPath.set(meta.id, stored);
    fileCount++;
    await tick(i + 1);
  }

  for (const [i, n] of own.entries()) {
    const folder = splitPath(n.path).folder;
    const content = n.content.replace(FILE_URL_RE, (full, id: string) => {
      const target = attachmentPath.get(id);
      return target ? linkTarget(relativeFrom(folder, target)) : full;
    });
    await zip.add(n.path, content, new Date(n.updatedAt));
    if (opts.history) {
      const base = n.path.replace(/\.md$/i, '');
      for (const v of deps.notes.historyOf(user.id, n.id)) {
        const stamp = new Date(v.savedAt).toISOString().replace(/[:.]/g, '-');
        await zip.add(`.history/${base}/${stamp}.md`, v.content, new Date(v.savedAt));
      }
    }
    await tick(i + 1);
  }

  // Settings of the apps (features, templates, favorites, …) live in system notes as JSON
  const settings: Record<string, unknown> = {};
  for (const n of all.filter((x) => x.path.startsWith(SYSTEM_PREFIX))) {
    try {
      settings[n.path.slice(SYSTEM_PREFIX.length)] = JSON.parse(n.content);
    } catch {
      settings[n.path.slice(SYSTEM_PREFIX.length)] = n.content;
    }
  }
  const settingsNote = all.find((n) => n.id === `syssettings-${user.id}`);
  let templates = normalizeTemplates(undefined);
  try {
    templates = normalizeTemplates(settingsNote ? (JSON.parse(settingsNote.content) as Record<string, unknown>)[TEMPLATES_SETTING] : undefined);
  } catch {
    // broken settings: no templates
  }
  for (const t of templates) await zip.add(`.templates/${safeFileSegment(t.label)}.md`, t.content);

  const shares = deps.notes.shareOverview(user.id);
  const account = {
    format: 'kladde-account-export',
    formatVersion: 1,
    app: { name: 'Kladde', version: APP_VERSION },
    exportedAt: now.toISOString(),
    account: { username: user.username },
    contents: {
      notes: own.length,
      attachments: fileCount,
      history: opts.history,
      layout: 'Notes as Markdown in their folders; attachments in _attachments/; templates in .templates/; note history in .history/ (if exported).',
      import: 'npm run import -- <unzipped folder> --url <Kladde URL> (with an import token from the settings)',
    },
    notes: own.map((n) => ({ id: n.id, path: n.path, createdAt: new Date(n.createdAt).toISOString(), updatedAt: new Date(n.updatedAt).toISOString() })),
    templates: templates.map((t) => ({ id: t.id, name: t.label, folder: t.folder, content: t.content })),
    settings,
    groups: deps.notes.groupsOf(user.id).map((g) => ({ name: g.name, role: g.role })),
    shares: {
      notes: shares.notes.map(({ path: p, username, canWrite }) => ({ path: p, with: username, canWrite })),
      folders: shares.folders.map(({ folder, username, canWrite, canCreate, canDelete }) => ({ folder, with: username, canWrite, canCreate, canDelete })),
      publicLinks: shares.publicLinks.map(({ path: p }) => ({ path: p })),
    },
  };
  await zip.add('kladde-account.json', `${JSON.stringify(account, null, 2)}\n`, now);
  return { notes: own.length, files: fileCount };
}

/** Background exports, one at a time per account */
export class AccountExportService {
  private readonly jobs = new Map<string, Job>();
  private readonly dir: string;

  constructor(
    private readonly deps: { notes: NoteStore; files: FileStore; dataDir: string; onReady?: (userId: string, status: AccountExportStatus) => void }
  ) {
    this.dir = path.join(deps.dataDir, 'account-exports');
    // Leftovers of an earlier process cannot be decrypted any more (the keys were only in memory)
    fs.rmSync(this.dir, { recursive: true, force: true });
    const sweep = setInterval(() => this.expire(), 10 * 60 * 1000);
    sweep.unref();
  }

  private publicOf(job: Job): AccountExportStatus {
    const { id, state, createdAt, finishedAt, expiresAt, size, notes, files, history, error } = job;
    return { id, state, createdAt, finishedAt, expiresAt, size, notes, files, history, error };
  }

  status(userId: string): AccountExportStatus | null {
    this.expire();
    const job = this.jobs.get(userId);
    return job ? this.publicOf(job) : null;
  }

  /** Starts an export; a running one is returned instead of starting a second */
  start(user: { id: string; username: string }, opts: { history: boolean }): AccountExportStatus {
    const running = this.jobs.get(user.id);
    if (running?.state === 'running') return this.publicOf(running);
    if (running) this.discard(user.id);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const id = crypto.randomBytes(12).toString('base64url');
    const job: Job = {
      id,
      userId: user.id,
      state: 'running',
      createdAt: Date.now(),
      finishedAt: null,
      expiresAt: null,
      size: 0,
      notes: 0,
      files: 0,
      history: opts.history,
      error: null,
      file: path.join(this.dir, `${id}.bin`),
      key: crypto.randomBytes(32),
      iv: crypto.randomBytes(12),
    };
    this.jobs.set(user.id, job);
    void this.run(job, user, opts).catch(() => undefined);
    return this.publicOf(job);
  }

  private async run(job: Job, user: { id: string; username: string }, opts: { history: boolean }): Promise<void> {
    const cipher = crypto.createCipheriv('aes-256-gcm', job.key, job.iv);
    const out = fs.createWriteStream(job.file, { mode: 0o600 });
    const closed = new Promise<void>((resolve, reject) => {
      out.once('close', resolve);
      out.once('error', reject);
      cipher.once('error', reject);
    });
    cipher.pipe(out);
    try {
      const zip = new ZipStream(cipher);
      const counts = await writeAccountZip(zip, this.deps, user, { history: opts.history });
      await zip.finish();
      cipher.end();
      await closed;
      if (this.jobs.get(user.id) !== job) return fs.rmSync(job.file, { force: true });
      job.tag = cipher.getAuthTag();
      job.size = fs.statSync(job.file).size;
      job.notes = counts.notes;
      job.files = counts.files;
      job.state = 'ready';
      job.finishedAt = Date.now();
      job.expiresAt = job.finishedAt + EXPORT_TTL_MS;
      this.deps.onReady?.(user.id, this.publicOf(job));
    } catch (err) {
      cipher.destroy();
      out.destroy();
      fs.rmSync(job.file, { force: true });
      job.state = 'failed';
      job.finishedAt = Date.now();
      job.error = (err as Error).message || 'Export fehlgeschlagen';
    }
  }

  /**
   * Streams a ready export (decrypted) into `res` and deletes it afterwards: downloadable once.
   * Returns false when there is nothing to download under this id.
   */
  download(userId: string, id: string, target: Writable & { on: Writable['on'] }, onStart: () => void): boolean {
    this.expire();
    const job = this.jobs.get(userId);
    if (!job || job.id !== id || job.state !== 'ready' || !job.tag) return false;
    this.jobs.delete(userId);
    onStart();
    const decipher = crypto.createDecipheriv('aes-256-gcm', job.key, job.iv);
    decipher.setAuthTag(job.tag);
    const input = fs.createReadStream(job.file);
    const cleanup = () => fs.rmSync(job.file, { force: true });
    input.once('error', () => target.destroy());
    decipher.once('error', () => target.destroy());
    target.once('close', cleanup);
    input.pipe(decipher).pipe(target);
    return true;
  }

  /** Deletes the user's export (also a running one: it is dropped when it finishes) */
  discard(userId: string): void {
    const job = this.jobs.get(userId);
    if (!job) return;
    this.jobs.delete(userId);
    if (job.state !== 'running') fs.rmSync(job.file, { force: true });
  }

  private expire(now = Date.now()): void {
    for (const [userId, job] of this.jobs) {
      const ended = job.finishedAt ?? 0;
      if ((job.expiresAt !== null && job.expiresAt <= now) || (job.state === 'failed' && ended + EXPORT_TTL_MS <= now)) this.discard(userId);
    }
  }
}
