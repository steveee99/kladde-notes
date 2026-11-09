import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DEFAULT_GIT_MESSAGE, GitSyncSettings, SYSTEM_PREFIX } from '@kladde/shared';
import type { DataCipher } from './crypto.js';
import { AccountError } from './UserStore.js';

interface Payload {
  url: string;
  email: string;
  token: string;
  message: string;
}

interface Row {
  user_id: string;
  enabled: number;
  payload: Uint8Array;
  last_run_at: number | null;
  last_status: GitSyncSettings['lastStatus'];
  last_error: string | null;
}

export interface GitSyncInput {
  url?: unknown;
  email?: unknown;
  /** Omitted or empty keeps the stored token */
  token?: unknown;
  message?: unknown;
  enabled?: unknown;
}

const DEBOUNCE_MS = 2 * 60_000;
const GIT_TIMEOUT_MS = 120_000;

/** {date} → 2026-11-09, {time} → 14:05 (server time) */
export function commitMessage(template: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const time = `${p(now.getHours())}:${p(now.getMinutes())}`;
  return (template.trim() || DEFAULT_GIT_MESSAGE).replace(/\{date\}/g, date).replace(/\{time\}/g, time);
}

/**
 * Pushes the plain Markdown of a user's own notes to a Git repository (branch main), one commit per run.
 * Credentials are encrypted in the database and only handed to git through the process environment.
 */
export class GitSync {
  private readonly running = new Map<string, Promise<GitSyncSettings>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher,
    private readonly notesOf: (userId: string) => { path: string; content: string }[],
    private readonly usernameOf: (userId: string) => string | null,
    private readonly dataDir: string,
    private readonly protocols = 'https:http'
  ) {}

  private row(userId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM git_sync WHERE user_id = ?').get(userId) as Row | undefined;
  }

  private payload(row: Row): Payload {
    return this.cipher.decryptJson<Payload>(row.payload, `git_sync:${row.user_id}`);
  }

  private toSettings(row: Row): GitSyncSettings {
    const p = this.payload(row);
    return {
      url: p.url,
      email: p.email,
      hasToken: !!p.token,
      message: p.message,
      enabled: !!row.enabled,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      lastError: row.last_error,
    };
  }

  get(userId: string): GitSyncSettings | null {
    const row = this.row(userId);
    return row ? this.toSettings(row) : null;
  }

  private validUrl(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 500) throw new AccountError('Bitte eine Git-Adresse angeben.', 400);
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new AccountError('Das ist keine gültige Adresse.', 400);
    }
    const allowed = this.protocols.split(':').filter(Boolean).map((p) => `${p}:`);
    if (!allowed.includes(url.protocol) && !(this.protocols.includes('file') && url.protocol === 'file:')) {
      throw new AccountError('Nur https:// (oder http://) Adressen sind erlaubt.', 400);
    }
    if (url.username || url.password) throw new AccountError('Zugangsdaten bitte nicht in die Adresse, sondern in die Felder darunter eintragen.', 400);
    return url.toString();
  }

  save(userId: string, input: GitSyncInput): GitSyncSettings {
    const existing = this.row(userId);
    const old = existing ? this.payload(existing) : null;
    const url = this.validUrl(input.url);
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(email) || email.length > 200) throw new AccountError('Bitte eine gültige E-Mail-Adresse angeben.', 400);
    const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : (old?.token ?? '');
    if (!this.protocols.includes('file') && !token) throw new AccountError('Bitte ein Access-Token angeben.', 400);
    if (/[\r\n\0]/.test(token) || token.length > 500) throw new AccountError('Das Token ist ungültig.', 400);
    const message = typeof input.message === 'string' ? input.message.trim().slice(0, 200) : '';
    if (message.includes('\0')) throw new AccountError('Die Commit-Nachricht ist ungültig.', 400);
    const payload = this.cipher.encryptJson({ url, email, token, message: message || DEFAULT_GIT_MESSAGE } satisfies Payload, `git_sync:${userId}`);
    const enabled = input.enabled === false ? 0 : 1;
    this.db
      .prepare(
        `INSERT INTO git_sync (user_id, enabled, payload) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, payload = excluded.payload`
      )
      .run(userId, enabled, payload);
    return this.get(userId)!;
  }

  remove(userId: string): void {
    this.db.prepare('DELETE FROM git_sync WHERE user_id = ?').run(userId);
    const timer = this.timers.get(userId);
    if (timer) clearTimeout(timer);
    this.timers.delete(userId);
    fs.rmSync(this.workdir(userId), { recursive: true, force: true });
  }

  private workdir(userId: string): string {
    return path.join(this.dataDir, 'git', userId.replace(/[^\w-]/g, '_'));
  }

  /** A note of the user changed: sync a little later (changes in a row become one commit) */
  touch(userId: string): void {
    const row = this.row(userId);
    if (!row?.enabled || this.timers.has(userId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(userId);
      void this.run(userId).catch(() => {});
    }, DEBOUNCE_MS);
    timer.unref();
    this.timers.set(userId, timer);
  }

  /** Runs one sync now; concurrent calls share the running one */
  run(userId: string): Promise<GitSyncSettings> {
    const active = this.running.get(userId);
    if (active) return active;
    const job = this.execute(userId).finally(() => this.running.delete(userId));
    this.running.set(userId, job);
    return job;
  }

  private async execute(userId: string): Promise<GitSyncSettings> {
    const row = this.row(userId);
    if (!row) throw new AccountError('Git-Sync ist nicht eingerichtet.', 404);
    const cfg = this.payload(row);
    let status: GitSyncSettings['lastStatus'] = 'ok';
    let error: string | null = null;
    try {
      status = (await this.sync(userId, cfg)) ? 'ok' : 'unchanged';
    } catch (err) {
      status = 'error';
      error = redact((err as Error).message, cfg).slice(0, 500);
    }
    this.db.prepare('UPDATE git_sync SET last_run_at = ?, last_status = ?, last_error = ? WHERE user_id = ?').run(Date.now(), status, error, userId);
    return this.get(userId)!;
  }

  /** @returns true when a commit was pushed */
  private async sync(userId: string, cfg: Payload): Promise<boolean> {
    const dir = this.workdir(userId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const username = this.usernameOf(userId) ?? 'kladde';
    const authHeader = cfg.token ? `Authorization: Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}` : null;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: this.protocols,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: username,
      GIT_AUTHOR_EMAIL: cfg.email,
      GIT_COMMITTER_NAME: username,
      GIT_COMMITTER_EMAIL: cfg.email,
      ...(authHeader ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: authHeader } : {}),
    };
    const git = (...args: string[]) => run(dir, env, args);

    if (!fs.existsSync(path.join(dir, '.git'))) await git('init', '-q', '-b', 'main');
    await git('remote', 'remove', 'origin').catch(() => '');
    await git('remote', 'add', 'origin', cfg.url);
    // Build on what is already on the remote branch (an empty repository has no main yet)
    const heads = await git('ls-remote', '--heads', 'origin', 'main');
    if (heads.trim()) {
      await git('fetch', '-q', 'origin', 'main');
      await git('checkout', '-q', '-f', '-B', 'main', 'origin/main');
    }

    this.writeNotes(userId, dir);
    await git('add', '-A');
    if (!(await git('status', '--porcelain')).trim()) return false;
    await git('commit', '-q', '-m', commitMessage(cfg.message));
    await git('push', '-q', 'origin', 'HEAD:main');
    return true;
  }

  /** Makes the Markdown files in the working tree match the user's own notes (other files in the repository stay untouched) */
  private writeNotes(userId: string, dir: string): void {
    const wanted = new Map<string, string>();
    for (const n of this.notesOf(userId)) {
      if (n.path.startsWith(SYSTEM_PREFIX)) continue;
      const file = path.resolve(dir, n.path.endsWith('.md') ? n.path : `${n.path}.md`);
      if (file.startsWith(dir + path.sep) && !file.startsWith(path.join(dir, '.git') + path.sep)) wanted.set(file, n.content);
    }
    const sweep = (folder: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.name === '.git') continue;
        if (entry.isDirectory()) {
          sweep(full);
          if (!fs.readdirSync(full).length) fs.rmdirSync(full);
        } else if (entry.name.endsWith('.md') && !wanted.has(full)) fs.rmSync(full);
      }
    };
    sweep(dir);
    for (const [file, content] of wanted) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
}

function run(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim() || 'git ist fehlgeschlagen'));
      else resolve(stdout);
    });
  });
}

/** Keeps credentials out of error messages shown to the user */
function redact(message: string, cfg: Payload): string {
  let out = message;
  for (const secret of [cfg.token, Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')]) if (secret) out = out.split(secret).join('***');
  return out;
}
