import http from 'http';
import path from 'path';
import type express from 'express';
import { APP_VERSION } from '@kladde/shared';
import { createKladdeApp } from './app.js';
import { backupDatabase, openDatabase } from './db.js';
import { launchDesktopWindow, probeRunningKladde, startDesktopLifecycle } from './desktop.js';
import {
  isSeaRuntime,
  isStandaloneMode,
  loadSeaClientAssets,
  moduleDir,
  resolveDataDir,
  resolveDbPath,
  resolveListenPort,
  setupDesktopLogging,
  STANDALONE_PORT_SPAN,
} from './standalone.js';

function tryListen(server: http.Server, port: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    if (host) server.listen(port, host);
    else server.listen(port);
  });
}

async function bindServer(
  server: http.Server,
  requestedPort: number,
  opts: { host?: string; standalone: boolean; explicitPort: boolean; serverOnly: boolean; dataDir: string }
): Promise<{ port: number; alreadyRunning: boolean }> {
  const maxAttempts = opts.standalone && !opts.explicitPort ? STANDALONE_PORT_SPAN + 1 : 1;
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = requestedPort === 0 ? 0 : requestedPort + offset;
    try {
      const boundPort = await tryListen(server, candidate, opts.host);
      return { port: boundPort, alreadyRunning: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (opts.standalone && code === 'EADDRINUSE' && candidate > 0) {
        const running = await probeRunningKladde(candidate);
        if (running?.standalone) {
          if (!opts.serverOnly) {
            launchDesktopWindow(`http://127.0.0.1:${candidate}/`, opts.dataDir, { detached: true });
          }
          return { port: candidate, alreadyRunning: true };
        }
        if (offset + 1 < maxAttempts) continue;
      }
      throw err;
    }
  }
  throw new Error(`Kein freier Port ab ${requestedPort} gefunden.`);
}

async function main(): Promise<void> {
  const env = process.env;
  const argv = process.argv.slice(2);
  const sea = isSeaRuntime();
  const standalone = isStandaloneMode(env, argv, sea);
  const serverOnly = argv.includes('--server-only') || argv.includes('--no-open') || env.KLADDE_NO_OPEN === '1' || env.KLADDE_NO_OPEN === 'true';
  const isProduction = sea || standalone || env.NODE_ENV === 'production';

  const baseDir = moduleDir(import.meta.url);
  const DATA_DIR = resolveDataDir({ env, argv, standalone, defaultDir: path.join(baseDir, '..', 'data') });
  const DB_PATH = resolveDbPath(DATA_DIR, env, argv);
  const BACKUP_KEEP = Number(env.BACKUP_KEEP ?? 7);
  const BACKUP_DIR = path.resolve(env.BACKUP_DIR ?? path.join(DATA_DIR, 'backups'));

  if ((sea || standalone) && DB_PATH !== ':memory:') {
    setupDesktopLogging(DATA_DIR);
    process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
    process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
  }

  const { port: requestedPort, explicit: explicitPort } = resolveListenPort(env, argv, standalone);
  const host = standalone ? (env.HOST?.trim() || '127.0.0.1') : env.HOST?.trim() || undefined;

  let handler: express.Express | null = null;
  const server = http.createServer((req, res) => {
    if (handler) handler(req, res);
    else {
      res.statusCode = 503;
      res.end('Starting...');
    }
  });

  // Acquire the port before opening SQLite so a second click attaches to the existing instance without racing the DB
  const { port, alreadyRunning } = await bindServer(server, requestedPort, {
    host,
    standalone,
    explicitPort,
    serverOnly,
    dataDir: DATA_DIR,
  });
  if (alreadyRunning) {
    console.log(`📝 Kladde läuft bereits auf http://127.0.0.1:${port}`);
    return;
  }

  const db = openDatabase(DB_PATH, { backupDir: BACKUP_KEEP > 0 ? BACKUP_DIR : undefined });
  const PUBLIC_URL = standalone ? null : env.PUBLIC_URL?.trim() || null;
  const TRUST_PROXY = !standalone && (env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true');
  const clientDist = path.resolve(baseDir, '..', '..', 'client', 'dist');

  const { app, users, audit, live } = createKladdeApp({
    db,
    dataDir: DATA_DIR,
    env,
    standalone,
    isProduction,
    publicUrl: PUBLIC_URL,
    trustProxy: TRUST_PROXY,
    clientDist,
    seaAssets: loadSeaClientAssets(),
  });
  handler = app;

  if (!standalone) {
    const inviteUrl = (code: string) => `${(PUBLIC_URL ?? `http://localhost:${isProduction ? port : 5174}`).replace(/\/$/, '')}/invite/${code}`;
    // Without users there is no other way in: print a first invite
    if (users.countUsers() === 0 && !users.hasOpenInvite()) {
      const invite = users.createInvite('Erstes Konto');
      console.log(`\n✉️  Erste Einladung (14 Tage gültig): ${inviteUrl(invite.code)}\n`);
    }
  }

  const localUrl = `http://${host ?? 'localhost'}:${port}`;
  console.log(`📝 Kladde ${APP_VERSION} läuft auf ${localUrl}${standalone ? ` (Standalone · Daten: ${DATA_DIR})` : ''}`);

  if (BACKUP_KEEP > 0 && DB_PATH !== ':memory:') {
    const runBackup = () => {
      try {
        backupDatabase(db, BACKUP_DIR, BACKUP_KEEP);
        audit.prune();
      } catch (err) {
        console.error('Backup failed:', err);
      }
    };
    setTimeout(runBackup, 60_000).unref();
    setInterval(runBackup, 24 * 60 * 60 * 1000).unref();
  }

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.closeAllConnections?.();
    server.close(() => {
      try {
        db.close();
      } catch {
        // already closed
      }
      process.exit(0);
    });
    setTimeout(() => {
      try {
        db.close();
      } catch {
        // already closed
      }
      process.exit(0);
    }, 1500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', shutdown);
  process.on('SIGBREAK', shutdown);

  if (standalone && !serverOnly) {
    startDesktopLifecycle({
      url: `http://127.0.0.1:${port}/`,
      dataDir: DATA_DIR,
      live,
      onShutdown: shutdown,
    });
  }
}

void main().catch((err) => {
  console.error('Start fehlgeschlagen:', err);
  process.exit(1);
});
