import crypto from 'crypto';
import { constants, type DatabaseSync } from 'node:sqlite';
import { pluginTablePrefix } from '@kladde/plugin-api';
import type { PluginMigration } from '@kladde/plugin-api/server';

/** A plugin's schema cannot be brought to this build (changed step, downgrade, foreign table, failing SQL) */
export class PluginMigrationError extends Error {
  constructor(
    readonly pluginId: string,
    message: string
  ) {
    super(`Plugin "${pluginId}": ${message}`);
    this.name = 'PluginMigrationError';
  }
}

/** Fingerprint of a step: SQL steps by their text, code steps by version and description */
export function migrationChecksum(step: PluginMigration): string {
  return crypto.createHash('sha256').update(`${step.version}\n${step.description}\n${step.sql ?? ''}`).digest('hex');
}

interface AppliedRow {
  version: number;
  checksum: string;
}

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

const schemaOf = (db: DatabaseSync): Map<string, SchemaObject> =>
  new Map((db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as unknown as SchemaObject[]).map((o) => [`${o.type}:${o.name}`, o]));

// Authorizer action codes that change something, with the argument that names the table
const WRITES: Record<number, 'arg1' | 'arg2'> = {
  [constants.SQLITE_CREATE_TABLE]: 'arg1',
  [constants.SQLITE_CREATE_INDEX]: 'arg2',
  [constants.SQLITE_CREATE_TRIGGER]: 'arg2',
  [constants.SQLITE_CREATE_VIEW]: 'arg1',
  [constants.SQLITE_DROP_TABLE]: 'arg1',
  [constants.SQLITE_DROP_INDEX]: 'arg2',
  [constants.SQLITE_DROP_TRIGGER]: 'arg2',
  [constants.SQLITE_DROP_VIEW]: 'arg1',
  [constants.SQLITE_INSERT]: 'arg1',
  [constants.SQLITE_UPDATE]: 'arg1',
  [constants.SQLITE_DELETE]: 'arg1',
  [constants.SQLITE_ALTER_TABLE]: 'arg2',
};
// Never inside a plugin step: the host owns transactions, attached files and settings like user_version
const DENIED = new Set<number>([constants.SQLITE_TRANSACTION, constants.SQLITE_SAVEPOINT, constants.SQLITE_ATTACH, constants.SQLITE_DETACH]);

type Authorizer = (action: number, arg1: string | null, arg2: string | null, dbName: string | null, trigger: string | null) => number;
type AuthorizingDb = DatabaseSync & { setAuthorizer?: (fn: Authorizer | null) => void };

/**
 * Runs one step with SQLite's authorizer: writes (rows and schema) only to tables named `p_<id>_…` (and SQLite's
 * own bookkeeping), no transactions, no ATTACH, no PRAGMA that sets something. Reading other tables is allowed.
 */
function guarded(db: DatabaseSync, prefix: string, run: () => void): string | null {
  const authorizing = db as AuthorizingDb;
  let denied: string | null = null;
  const own = (table: string | null) => !table || table.startsWith(prefix) || table.startsWith('sqlite_');
  authorizing.setAuthorizer?.((action, arg1, arg2) => {
    if (DENIED.has(action)) {
      denied ??= 'transactions, savepoints and ATTACH are not allowed in a step';
      return constants.SQLITE_DENY;
    }
    if (action === constants.SQLITE_PRAGMA && arg2 !== null) {
      denied ??= `PRAGMA ${arg1} = … is not allowed in a step`;
      return constants.SQLITE_DENY;
    }
    const which = WRITES[action];
    const table = which === 'arg1' ? arg1 : which === 'arg2' ? arg2 : null;
    if (which && !own(table)) {
      denied ??= `writes to "${table}", which is no table of the plugin (they start with ${prefix})`;
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
  try {
    run();
  } catch (err) {
    if (denied) return denied;
    throw err;
  } finally {
    authorizing.setAuthorizer?.(null);
  }
  return denied;
}

export interface PluginSchema {
  id: string;
  migrations?: PluginMigration[];
}

/** Steps that would run now, per plugin (to decide about a backup first) */
export function pendingPluginMigrations(db: DatabaseSync, plugins: PluginSchema[]): number {
  let pending = 0;
  for (const p of plugins) {
    const applied = new Set((db.prepare('SELECT version FROM plugin_migrations WHERE plugin_id = ?').all(p.id) as unknown as AppliedRow[]).map((r) => r.version));
    pending += (p.migrations ?? []).filter((m) => !applied.has(m.version)).length;
  }
  return pending;
}

/**
 * Brings every plugin's tables to the steps this build knows. Per plugin: steps must be numbered 1, 2, 3, …;
 * applied steps must be unchanged (checksum); a database ahead of the build (downgrade) stops the start; each new
 * step runs in its own transaction, may only touch the plugin's own tables and is recorded in `plugin_migrations`.
 * `runCode` runs a step's `up` (the host passes the plugin's context). Returns the applied versions per plugin.
 */
export function migratePlugins(db: DatabaseSync, plugins: PluginSchema[], runCode: (pluginId: string, step: PluginMigration) => void, now = Date.now()): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const plugin of plugins) {
    const steps = plugin.migrations ?? [];
    steps.forEach((step, i) => {
      if (step.version !== i + 1) throw new PluginMigrationError(plugin.id, `migrations must be numbered 1, 2, 3, … in order (found ${step.version} at position ${i + 1})`);
      if (!step.sql && !step.up) throw new PluginMigrationError(plugin.id, `migration ${step.version} has neither "sql" nor "up"`);
    });
    const applied = db.prepare('SELECT version, checksum FROM plugin_migrations WHERE plugin_id = ? ORDER BY version').all(plugin.id) as unknown as AppliedRow[];
    const latestApplied = applied.length ? applied[applied.length - 1].version : 0;
    if (latestApplied > steps.length) {
      throw new PluginMigrationError(plugin.id, `the database is at schema ${latestApplied}, this build knows only ${steps.length}: downgrades are not supported, deploy the newer plugin version again or restore a backup`);
    }
    for (const row of applied) {
      const step = steps[row.version - 1];
      if (step && migrationChecksum(step) !== row.checksum) {
        throw new PluginMigrationError(plugin.id, `migration ${row.version} (${step.description}) was changed after it ran; released migrations must never change, add a new one instead`);
      }
    }
    const prefix = pluginTablePrefix(plugin.id);
    const done = new Set(applied.map((r) => r.version));
    result[plugin.id] = [];
    for (const step of steps) {
      if (done.has(step.version)) continue;
      const before = schemaOf(db);
      db.exec('BEGIN');
      try {
        const denied = guarded(db, prefix, () => {
          if (step.sql) db.exec(step.sql);
          if (step.up) runCode(plugin.id, step);
        });
        if (denied) throw new Error(denied);
        // Also without an authorizer (older Node): every new, changed or removed schema object must be the plugin's
        const after = schemaOf(db);
        for (const [key, o] of after) {
          const old = before.get(key);
          if ((!old || old.sql !== o.sql) && !o.tbl_name.startsWith(prefix)) throw new Error(`changes "${o.name}", which is no table of the plugin (they start with ${prefix})`);
        }
        for (const [key, o] of before) if (!after.has(key) && !o.tbl_name.startsWith(prefix)) throw new Error(`removes "${o.name}", which is no table of the plugin`);
        db.prepare('INSERT INTO plugin_migrations (plugin_id, version, description, checksum, applied_at) VALUES (?, ?, ?, ?, ?)').run(plugin.id, step.version, step.description, migrationChecksum(step), now);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw new PluginMigrationError(plugin.id, `migration ${step.version} (${step.description}) failed: ${(err as Error).message}`);
      }
      result[plugin.id].push(step.version);
    }
  }
  return result;
}

/** Schema state per plugin id, for the admin overview and `cli plugins` */
export function pluginSchemaVersions(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare('SELECT plugin_id, MAX(version) AS version FROM plugin_migrations GROUP BY plugin_id').all() as unknown as { plugin_id: string; version: number }[];
  return new Map(rows.map((r) => [r.plugin_id, r.version]));
}

/**
 * Removes a plugin's data for good: its tables, indexes, triggers and views (`p_<id>_…`) and its migration rows.
 * Only for plugins that are no longer part of the build (`npm run cli -- plugins purge <id>`).
 */
export function purgePluginData(db: DatabaseSync, pluginId: string): string[] {
  const prefix = pluginTablePrefix(pluginId);
  const objects = (db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE ? ESCAPE '\\' AND type IN ('table', 'view')").all(`${prefix.replace(/_/g, '\\_')}%`) as unknown as { type: string; name: string }[]);
  db.exec('BEGIN');
  try {
    for (const o of objects) db.exec(`DROP ${o.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${o.name.replace(/"/g, '""')}"`);
    db.prepare('DELETE FROM plugin_migrations WHERE plugin_id = ?').run(pluginId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return objects.map((o) => o.name);
}
