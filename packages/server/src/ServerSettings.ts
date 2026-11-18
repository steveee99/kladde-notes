import { DatabaseSync } from 'node:sqlite';

/** Server-wide settings changed in the admin area (not secret, stored as JSON per key) */
export class ServerSettings {
  constructor(private readonly db: DatabaseSync) {}

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
}
