import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import {
  APP_VERSION,
  type AdminBackup,
  type AdminBackupOverview,
  type AdminBackupSchedule,
  type AdminBackupTrigger,
} from '@kladde/shared';
import { LATEST_SCHEMA_VERSION } from '../db.js';
import type { ServerSettings } from '../ServerSettings.js';
import { AccountError } from '../UserStore.js';
import type { TarEntry } from './tar.js';

/**
 * Backups in the admin area (#65). A full backup is a folder `kladde-<UTC stamp>` in the backup directory with
 * - `kladde.sqlite`: a consistent copy of the database (VACUUM INTO, the notes stay encrypted),
 * - `files/` and `avatars/`: the attachments and profile pictures, still encrypted, hard-linked where possible
 *   (they are written once and never changed, so a link costs no space) and copied otherwise,
 * - `backup.json`: version, schema, trigger and size.
 * The encryption key (`DATA_KEY` or `data/secret.key`) is never part of a backup.
 * Older single-file backups (`kladde-<stamp>.sqlite`, from before migrations and the CLI) are listed as database-only.
 */

const FULL_RE = /^kladde-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(?:-\d{1,3})?$/;
const DB_RE = /^kladde-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.sqlite$/;
const META_FILE = 'backup.json';
const DB_FILE = 'kladde.sqlite';
/** Folders below the data directory that a full backup carries */
export const BACKUP_FILE_DIRS = ['files', 'avatars'] as const;
/** Written into the data directory by a restore request, applied by the next start */
export const RESTORE_MARKER = 'restore-pending.json';
const SCHEDULE_KEY = 'backup.schedule';
/** A scheduled backup is due when the last one is older than this (a little under a day, so the hourly check does not drift) */
const SCHEDULE_INTERVAL_MS = 23 * 60 * 60 * 1000;
export const MAX_KEEP = 90;

interface BackupMeta {
  version: string;
  schema: number;
  createdAt: number;
  trigger: AdminBackupTrigger;
  files: number;
  size: number;
}

export interface RestoreRequest {
  id: string;
  username: string;
  requestedAt: number;
}

/** Errors the admin sees (an AccountError, so the routes map it to its status) */
export class BackupError extends AccountError {}

export interface BackupServiceOptions {
  db: DatabaseSync;
  dataDir: string;
  backupDir: string;
  settings: ServerSettings;
  /** `BACKUP_KEEP` from the environment: the default schedule until an admin changes it (0 = off) */
  defaultKeep: number;
  now?: () => number;
}

const stampOf = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace(/[:T]/g, '-');

function timeOfStamp(name: string): number | null {
  const m = /^kladde-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/** Hard link, or a copy where links are impossible (another file system, no permission); a vanished source is skipped */
async function linkOrCopy(src: string, dst: string): Promise<number> {
  try {
    await fsp.link(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    if (!['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP', 'EACCES', 'EOPNOTSUPP'].includes(code ?? '')) throw err;
    await fsp.copyFile(src, dst);
  }
  return (await fsp.stat(dst)).size;
}

function linkOrCopySync(src: string, dst: string): void {
  try {
    fs.linkSync(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP', 'EACCES', 'EOPNOTSUPP'].includes(code ?? '')) throw err;
    fs.copyFileSync(src, dst);
  }
}

const plainFiles = (dir: string) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
};

export class BackupService {
  private running = false;
  private readonly now: () => number;

  constructor(private readonly opts: BackupServiceOptions) {
    this.now = opts.now ?? Date.now;
    // Leftovers of a backup that was interrupted (crash, restart)
    for (const name of this.dirEntries()) {
      if (name.startsWith('.partial-')) fs.rmSync(path.join(opts.backupDir, name), { recursive: true, force: true });
    }
  }

  get dir(): string {
    return this.opts.backupDir;
  }

  get busy(): boolean {
    return this.running;
  }

  private dirEntries(): string[] {
    try {
      return fs.readdirSync(this.opts.backupDir);
    } catch {
      return [];
    }
  }

  /** The path of a listed backup; anything else (other names, `..`) is refused */
  private pathOf(id: string): { full: boolean; path: string } | null {
    const full = FULL_RE.test(id);
    if (!full && !DB_RE.test(id)) return null;
    const p = path.join(this.opts.backupDir, id);
    if (!fs.existsSync(p)) return null;
    const isDir = fs.statSync(p).isDirectory();
    if (full !== isDir) return null;
    return { full, path: p };
  }

  private readMeta(dir: string): BackupMeta | null {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')) as BackupMeta;
      return typeof meta.createdAt === 'number' && typeof meta.schema === 'number' ? meta : null;
    } catch {
      return null;
    }
  }

  private info(id: string): AdminBackup | null {
    const found = this.pathOf(id);
    if (!found) return null;
    if (!found.full) {
      const stat = fs.statSync(found.path);
      return {
        id,
        createdAt: timeOfStamp(id) ?? stat.mtimeMs,
        size: stat.size,
        kind: 'database',
        trigger: 'unknown',
        files: 0,
        version: null,
        restorable: false,
      };
    }
    const meta = this.readMeta(found.path);
    if (!meta || !fs.existsSync(path.join(found.path, DB_FILE))) return null;
    return {
      id,
      createdAt: meta.createdAt,
      size: meta.size,
      kind: 'full',
      trigger: meta.trigger,
      files: meta.files,
      version: meta.version,
      restorable: meta.schema <= LATEST_SCHEMA_VERSION,
    };
  }

  /** Newest first */
  list(): AdminBackup[] {
    return this.dirEntries()
      .map((name) => this.info(name))
      .filter((b): b is AdminBackup => !!b)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  schedule(): AdminBackupSchedule {
    const stored = this.opts.settings.get<AdminBackupSchedule>(SCHEDULE_KEY);
    if (stored && typeof stored.enabled === 'boolean' && Number.isInteger(stored.keep)) return stored;
    const keep = this.opts.defaultKeep;
    return { enabled: keep > 0, keep: keep > 0 ? Math.min(keep, MAX_KEEP) : 7 };
  }

  setSchedule(input: { enabled?: unknown; keep?: unknown }): AdminBackupSchedule {
    const current = this.schedule();
    const keep = input.keep === undefined ? current.keep : Number(input.keep);
    if (!Number.isInteger(keep) || keep < 1 || keep > MAX_KEEP) throw new BackupError(`Aufzubewahrende Sicherungen: 1 bis ${MAX_KEEP}.`);
    const next = { enabled: input.enabled === undefined ? current.enabled : input.enabled === true, keep };
    this.opts.settings.set(SCHEDULE_KEY, next);
    if (next.enabled) this.prune(next.keep);
    return next;
  }

  overview(): AdminBackupOverview {
    return { backups: this.list(), schedule: this.schedule(), dir: this.opts.backupDir, busy: this.running };
  }

  /** A full backup: database copy first, then links to every attachment and profile picture on disk */
  async create(trigger: AdminBackupTrigger = 'manual'): Promise<AdminBackup> {
    if (this.running) throw new BackupError('Es läuft bereits eine Sicherung.', 409);
    this.running = true;
    const createdAt = this.now();
    let id = `kladde-${stampOf(createdAt)}`;
    for (let n = 2; fs.existsSync(path.join(this.opts.backupDir, id)); n++) id = `kladde-${stampOf(createdAt)}-${n}`;
    const tmp = path.join(this.opts.backupDir, `.partial-${id}`);
    try {
      fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
      const dbCopy = path.join(tmp, DB_FILE);
      this.opts.db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
      fs.chmodSync(dbCopy, 0o600);
      let size = fs.statSync(dbCopy).size;
      let files = 0;
      // An attachment saved after the copy is harmless (not referenced); one deleted in between is missing, as in the app
      for (const sub of BACKUP_FILE_DIRS) {
        const from = path.join(this.opts.dataDir, sub);
        const to = path.join(tmp, sub);
        fs.mkdirSync(to, { mode: 0o700 });
        for (const name of plainFiles(from)) {
          const bytes = await linkOrCopy(path.join(from, name), path.join(to, name));
          if (bytes || fs.existsSync(path.join(to, name))) {
            size += bytes;
            files++;
          }
        }
      }
      const meta: BackupMeta = { version: APP_VERSION, schema: LATEST_SCHEMA_VERSION, createdAt, trigger, files, size };
      fs.writeFileSync(path.join(tmp, META_FILE), JSON.stringify(meta, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, path.join(this.opts.backupDir, id));
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    } finally {
      this.running = false;
    }
    return this.info(id)!;
  }

  remove(id: string): boolean {
    const found = this.pathOf(id);
    if (!found) return false;
    fs.rmSync(found.path, { recursive: true, force: true });
    return true;
  }

  /** Deletes the oldest scheduled backups beyond `keep`; manual ones and those taken before a restore stay */
  prune(keep = this.schedule().keep): string[] {
    const scheduled = this.list().filter((b) => b.kind === 'full' && b.trigger === 'scheduled');
    const removed = scheduled.slice(keep).map((b) => b.id);
    for (const id of removed) this.remove(id);
    return removed;
  }

  /** Runs the daily backup when it is due; returns it, or null when nothing was due */
  async runSchedule(): Promise<AdminBackup | null> {
    const schedule = this.schedule();
    if (!schedule.enabled || this.running) return null;
    const last = this.list().find((b) => b.kind === 'full' && b.trigger === 'scheduled');
    if (last && this.now() - last.createdAt < SCHEDULE_INTERVAL_MS) return null;
    const backup = await this.create('scheduled');
    this.prune(schedule.keep);
    return backup;
  }

  /** The files of a backup for the download: a full backup as a tar archive, a database-only one as the file itself */
  download(id: string): { kind: 'tar'; filename: string; entries: TarEntry[] } | { kind: 'file'; filename: string; file: string } | null {
    const found = this.pathOf(id);
    if (!found) return null;
    if (!found.full) return { kind: 'file', filename: id, file: found.path };
    const entries: TarEntry[] = [];
    const add = (rel: string) => {
      const file = path.join(found.path, rel);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) entries.push({ name: `${id}/${rel}`, file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // deleted meanwhile
      }
    };
    add(META_FILE);
    add(DB_FILE);
    for (const sub of BACKUP_FILE_DIRS) for (const name of plainFiles(path.join(found.path, sub))) add(`${sub}/${name}`);
    return { kind: 'tar', filename: `${id}.tar`, entries };
  }

  /**
   * Prepares a restore: takes a full backup of the current state first (so the restore can be undone), then leaves
   * a marker that the next start applies before it opens the database. The caller restarts the server.
   */
  async requestRestore(id: string, username: string): Promise<{ safetyBackup: AdminBackup }> {
    const target = this.info(id);
    if (!target) throw new BackupError('Diese Sicherung gibt es nicht.', 404);
    if (target.kind !== 'full') throw new BackupError('Nur vollständige Sicherungen (mit Anhängen) lassen sich wiederherstellen.', 409);
    if (!target.restorable) throw new BackupError('Diese Sicherung stammt aus einer neueren Kladde-Version.', 409);
    const safetyBackup = await this.create('pre-restore');
    const request: RestoreRequest = { id, username, requestedAt: this.now() };
    fs.writeFileSync(path.join(this.opts.dataDir, RESTORE_MARKER), JSON.stringify(request), { mode: 0o600 });
    return { safetyBackup };
  }
}

/**
 * Applies a restore requested in the admin area. Runs at start, before the database is opened: replaces the database
 * file (dropping its WAL files) and the attachment folders with the backup's. The marker is removed first, so a failing
 * restore never loops; the backup taken right before the request still holds the previous state.
 */
export function applyPendingRestore(opts: { dataDir: string; dbPath: string; backupDir: string }): RestoreRequest | null {
  const marker = path.join(opts.dataDir, RESTORE_MARKER);
  if (!fs.existsSync(marker)) return null;
  let request: RestoreRequest;
  try {
    request = JSON.parse(fs.readFileSync(marker, 'utf8')) as RestoreRequest;
  } finally {
    fs.rmSync(marker, { force: true });
  }
  if (opts.dbPath === ':memory:' || typeof request?.id !== 'string' || !FULL_RE.test(request.id)) {
    throw new Error('Restore marker is invalid');
  }
  const src = path.join(opts.backupDir, request.id);
  const srcDb = path.join(src, DB_FILE);
  if (!fs.existsSync(srcDb)) throw new Error(`Backup ${request.id} not found in ${opts.backupDir}`);

  const tmpDb = `${opts.dbPath}.restoring`;
  fs.copyFileSync(srcDb, tmpDb);
  fs.chmodSync(tmpDb, 0o600);
  // A WAL left next to the old file would be replayed onto the restored one
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${opts.dbPath}${suffix}`, { force: true });
  fs.renameSync(tmpDb, opts.dbPath);

  for (const sub of BACKUP_FILE_DIRS) {
    const live = path.join(opts.dataDir, sub);
    const old = `${live}.before-restore`;
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(live)) fs.renameSync(live, old);
    fs.mkdirSync(live, { recursive: true, mode: 0o700 });
    for (const name of plainFiles(path.join(src, sub))) linkOrCopySync(path.join(src, sub, name), path.join(live, name));
    fs.rmSync(old, { recursive: true, force: true });
  }
  return request;
}
