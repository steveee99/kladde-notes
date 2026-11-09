import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

/** One schema step; `up` runs inside a transaction, `version` is stored in PRAGMA user_version afterwards */
export interface Migration {
  version: number;
  description: string;
  up(db: DatabaseSync): void;
}

/** Numbered schema steps, oldest first. Never change a step that was released: add a new one instead. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Accounts, passkeys, invites, notes, shares, files',
    up(db) {
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          username_lower TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          banned_at INTEGER
        );
        CREATE TABLE credentials (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          public_key BLOB NOT NULL,
          counter INTEGER NOT NULL,
          transports TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER
        );
        CREATE INDEX credentials_user ON credentials(user_id);
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL
        );
        CREATE TABLE invites (
          code TEXT PRIMARY KEY,
          note TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          used_by TEXT,
          used_at INTEGER
        );
        CREATE TABLE device_links (
          code TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT INTO counters (name, value) VALUES ('seq', 0);
        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0,
          payload BLOB NOT NULL
        );
        CREATE INDEX notes_owner_seq ON notes(owner_id, seq);
        CREATE TABLE shares (
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          can_write INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          PRIMARY KEY (note_id, user_id)
        );
        CREATE INDEX shares_user ON shares(user_id);
        CREATE TABLE share_revocations (
          note_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          seq INTEGER NOT NULL
        );
        CREATE INDEX share_revocations_user ON share_revocations(user_id, seq);
        CREATE TABLE public_links (
          token TEXT PRIMARY KEY,
          note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE files (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          mime TEXT NOT NULL,
          size INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          event TEXT NOT NULL,
          user_id TEXT,
          username TEXT,
          ip TEXT,
          detail TEXT
        );
      `);
    },
  },
  {
    version: 2,
    description: 'Optional passwords and admin accounts',
    up(db) {
      db.exec(`
        ALTER TABLE users ADD COLUMN password_hash TEXT;
        ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
        UPDATE users SET is_admin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at, username_lower LIMIT 1);
      `);
    },
  },
  {
    version: 3,
    description: 'MCP access: OAuth clients and access tokens',
    up(db) {
      db.exec(`
        CREATE TABLE oauth_clients (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          redirect_uris TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE mcp_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          client_id TEXT REFERENCES oauth_clients(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          can_write INTEGER NOT NULL,
          access_hash TEXT NOT NULL UNIQUE,
          access_expires_at INTEGER,
          refresh_hash TEXT UNIQUE,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER
        );
        CREATE INDEX mcp_tokens_user ON mcp_tokens(user_id);
      `);
    },
  },
  {
    version: 4,
    description: 'Folder shares (the folder path is encrypted)',
    up(db) {
      db.exec(`
        CREATE TABLE folder_shares (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          can_write INTEGER NOT NULL,
          payload BLOB NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX folder_shares_owner ON folder_shares(owner_id);
        ALTER TABLE shares ADD COLUMN folder_share_id TEXT REFERENCES folder_shares(id) ON DELETE CASCADE;
      `);
    },
  },
  {
    version: 5,
    description: 'Folder share permissions: create and delete notes in the shared folder',
    up(db) {
      db.exec(`
        ALTER TABLE folder_shares ADD COLUMN can_create INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE folder_shares ADD COLUMN can_delete INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 6,
    description: 'Note version history (path and content are encrypted)',
    up(db) {
      db.exec(`
        CREATE TABLE note_versions (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          saved_at INTEGER NOT NULL,
          payload BLOB NOT NULL
        );
        CREATE INDEX note_versions_note ON note_versions(note_id, saved_at);
      `);
    },
  },
];

export function migrate(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): number[] {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const applied: number[] = [];
  for (const step of migrations) {
    if (step.version <= current) continue;
    db.exec('BEGIN');
    try {
      step.up(db);
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Database migration ${step.version} (${step.description}) failed: ${(err as Error).message}`);
    }
    applied.push(step.version);
  }
  return applied;
}

function restrictFile(filePath: string) {
  for (const [file, mode] of [
    [path.dirname(filePath), 0o700],
    [filePath, 0o600],
    [`${filePath}-wal`, 0o600],
    [`${filePath}-shm`, 0o600],
  ] as const) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      // Not there yet (WAL files appear with the first write) or not ours to change
    }
  }
}

/** Consistent copy of the whole database while the server keeps running (VACUUM INTO); older backups beyond `keep` are deleted */
export function backupDatabase(db: DatabaseSync, dir: string, keep = 7, now = new Date()): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const target = path.join(dir, `kladde-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  fs.chmodSync(target, 0o600);
  const backups = fs
    .readdirSync(dir)
    .filter((name) => /^kladde-[\d-]+\.sqlite$/.test(name))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) fs.rmSync(path.join(dir, old));
  return target;
}

/** Opens the SQLite file (or ':memory:') shared by all stores and migrates it */
export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON;');
  if (filePath !== ':memory:') restrictFile(filePath);
  const applied = migrate(db);
  if (applied.length > 0 && filePath !== ':memory:') console.log(`Datenbank auf Schema ${applied[applied.length - 1]} gebracht (${filePath})`);
  return db;
}

/** Runs `fn` in one transaction */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
