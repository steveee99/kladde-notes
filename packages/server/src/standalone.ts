import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { UserRecord, UserStore } from './UserStore.js';

export const STANDALONE_DEFAULT_PORT = 34172;
export const STANDALONE_PORT_SPAN = 10;
export const CLIENT_ASSETS_KEY = 'client-assets.bin';
const CLIENT_ASSETS_MAGIC = Buffer.from('KLDA', 'ascii');
const LOG_MAX_BYTES = 1024 * 1024;

declare const __dirname: string | undefined;

interface SeaModule {
  isSea?: () => boolean;
  getRawAsset?: (key: string) => ArrayBuffer | ArrayBufferView;
}

function getSeaModule(): SeaModule | null {
  try {
    const getBuiltin = (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
    if (typeof getBuiltin !== 'function') return null;
    return (getBuiltin('node:sea') as SeaModule) ?? null;
  } catch {
    return null;
  }
}

/** True when running inside a Node.js Single Executable Application (SEA) */
export function isSeaRuntime(): boolean {
  try {
    return !!getSeaModule()?.isSea?.();
  } catch {
    return false;
  }
}

/** Resolves the current module directory safely in both ESM (`import.meta.url`) and CJS (`__dirname`) bundles */
export function moduleDir(metaUrl?: string): string {
  if (typeof __dirname === 'string' && __dirname) return __dirname;
  if (metaUrl) return path.dirname(fileURLToPath(metaUrl));
  return path.dirname(process.execPath);
}

const isTruthy = (value: string | undefined) => value === '1' || value?.toLowerCase() === 'true';

/** Reads a `--flag=value` or `--flag value` CLI argument */
export function readCliArg(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    if (arg === flag && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  }
  return undefined;
}

/**
 * Standalone single-user desktop mode is active inside SEA binaries, when `KLADDE_STANDALONE=1`,
 * or when `--standalone` is passed. Multi-user auth, invites, admin UI and sharing are disabled.
 */
export function isStandaloneMode(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  sea: boolean = isSeaRuntime()
): boolean {
  if (argv.includes('--no-standalone') || env.KLADDE_STANDALONE === '0') return false;
  return sea || isTruthy(env.KLADDE_STANDALONE) || argv.includes('--standalone');
}

export interface DataDirOptions {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  platform?: NodeJS.Platform;
  execPath?: string;
  homeDir?: string;
  existsSync?: (target: string) => boolean;
  standalone?: boolean;
  defaultDir?: string;
}

/**
 * Resolves the writable directory for `kladde.sqlite`, `secret.key`, `files/` and `backups/`.
 * Keeping this outside the `.exe` allows updates simply by replacing the executable.
 * Optional portable mode: place a `kladde-data` folder next to `kladde.exe` or pass `--portable-data`.
 */
export function resolveDataDir(opts: DataDirOptions = {}): string {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv.slice(2);
  const platform = opts.platform ?? process.platform;
  const pathMod = platform === 'win32' ? path.win32 : path;
  const execPath = opts.execPath ?? process.execPath;
  const homeDir = opts.homeDir ?? os.homedir();
  const existsSync = opts.existsSync ?? fs.existsSync;
  const standalone = opts.standalone ?? isStandaloneMode(env, argv);

  const dbPath = env.DB_PATH?.trim() || readCliArg(argv, '--db-path')?.trim();
  if (dbPath && dbPath !== ':memory:') return pathMod.dirname(pathMod.resolve(dbPath));

  const explicitDir = readCliArg(argv, '--data-dir')?.trim() || env.KLADDE_DATA_DIR?.trim();
  if (explicitDir) return pathMod.resolve(explicitDir);

  if (!standalone) return pathMod.resolve(opts.defaultDir ?? pathMod.join(process.cwd(), 'data'));

  const portableDir = pathMod.join(pathMod.dirname(pathMod.resolve(execPath)), 'kladde-data');
  if (argv.includes('--portable-data') || isTruthy(env.KLADDE_PORTABLE_DATA) || existsSync(portableDir)) {
    return portableDir;
  }

  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || pathMod.join(homeDir, 'AppData', 'Local');
    return pathMod.join(base, 'Kladde');
  }
  if (platform === 'darwin') {
    return pathMod.join(homeDir, 'Library', 'Application Support', 'Kladde');
  }
  const base = env.XDG_DATA_HOME?.trim() || pathMod.join(homeDir, '.local', 'share');
  return pathMod.join(base, 'kladde');
}

export function resolveDbPath(dataDir: string, env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2), platform: NodeJS.Platform = process.platform): string {
  const pathMod = platform === 'win32' ? path.win32 : path;
  const raw = env.DB_PATH?.trim() || readCliArg(argv, '--db-path')?.trim();
  if (raw === ':memory:') return ':memory:';
  if (raw) return pathMod.resolve(raw);
  return pathMod.join(dataDir, 'kladde.sqlite');
}

/** Resolves the HTTP port; standalone defaults to fixed localhost port 34172 so browser IndexedDB/localStorage stay stable */
export function resolveListenPort(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2), standalone = isStandaloneMode(env, argv)): { port: number; explicit: boolean } {
  const cliPort = readCliArg(argv, '--port');
  const raw = cliPort ?? env.PORT;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
      return { port: parsed, explicit: true };
    }
  }
  return { port: standalone ? STANDALONE_DEFAULT_PORT : 3002, explicit: false };
}

/** Finds the single local user in standalone mode, or creates one automatically on first launch */
export function ensureStandaloneUser(users: UserStore): UserRecord {
  return users.firstUser() ?? users.createUser('lokal');
}

export interface EmbeddedAsset {
  data: Buffer;
  mime: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Packs a built client `dist/` directory into a single binary blob suitable for Node SEA `assets` */
export function packClientAssets(rootDir: string): Buffer {
  const entries: { key: string; data: Buffer }[] = [];
  const walk = (dir: string, relBase: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, item.name);
      const rel = relBase ? `${relBase}/${item.name}` : `/${item.name}`;
      if (item.isDirectory()) walk(full, rel);
      else if (item.isFile()) entries.push({ key: rel, data: fs.readFileSync(full) });
    }
  };
  walk(rootDir, '');

  const header = Buffer.alloc(8);
  CLIENT_ASSETS_MAGIC.copy(header, 0);
  header.writeUInt32LE(entries.length, 4);

  const chunks: Buffer[] = [header];
  for (const entry of entries) {
    const keyBuf = Buffer.from(entry.key, 'utf8');
    const meta = Buffer.alloc(8);
    meta.writeUInt32LE(keyBuf.length, 0);
    meta.writeUInt32LE(entry.data.length, 4);
    chunks.push(meta, keyBuf, entry.data);
  }
  return Buffer.concat(chunks);
}

/** Unpacks a `client-assets.bin` archive packed by `packClientAssets` */
export function unpackClientAssets(buf: Buffer): Map<string, EmbeddedAsset> {
  if (buf.length < 8 || !buf.subarray(0, 4).equals(CLIENT_ASSETS_MAGIC)) {
    throw new Error('Invalid embedded client asset archive');
  }
  const count = buf.readUInt32LE(4);
  const map = new Map<string, EmbeddedAsset>();
  let offset = 8;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > buf.length) throw new Error('Truncated embedded client asset header');
    const pathLen = buf.readUInt32LE(offset);
    const dataLen = buf.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + pathLen + dataLen > buf.length) throw new Error('Truncated embedded client asset body');
    const key = buf.subarray(offset, offset + pathLen).toString('utf8');
    offset += pathLen;
    const data = Buffer.from(buf.subarray(offset, offset + dataLen));
    offset += dataLen;
    map.set(key, { data, mime: mimeTypeFor(key) });
  }
  return map;
}

/** Loads embedded client assets when running inside Node.js SEA; returns null in regular Node */
export function loadSeaClientAssets(): Map<string, EmbeddedAsset> | null {
  const sea = getSeaModule();
  if (!sea?.isSea?.() || typeof sea.getRawAsset !== 'function') return null;
  try {
    const raw = sea.getRawAsset(CLIENT_ASSETS_KEY);
    const buf = raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    return unpackClientAssets(buf);
  } catch {
    return null;
  }
}

/**
 * In Windows GUI builds (`WINDOWS_GUI`), stdout/stderr have no console handle and can emit `EPIPE`/`EINVAL`.
 * This guards both streams against errors and mirrors `console.*` output to `DATA_DIR/kladde.log`.
 */
export function setupDesktopLogging(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(dataDir, 'kladde.log');
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // non-fatal log rotation failure
  }

  process.stdout?.on?.('error', () => {});
  process.stderr?.on?.('error', () => {});

  const append = (level: string, args: unknown[]) => {
    const msg = args
      .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${msg}\n`, { mode: 0o600 });
    } catch {
      // ignore disk errors during logging
    }
  };

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    append('INFO', args);
    try {
      origLog(...args);
    } catch {
      // ignore broken stdout handle under WINDOWS_GUI
    }
  };
  console.warn = (...args: unknown[]) => {
    append('WARN', args);
    try {
      origWarn(...args);
    } catch {
      // ignore broken stderr handle under WINDOWS_GUI
    }
  };
  console.error = (...args: unknown[]) => {
    append('ERROR', args);
    try {
      origError(...args);
    } catch {
      // ignore broken stderr handle under WINDOWS_GUI
    }
  };
}
