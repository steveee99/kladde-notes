import http from 'http';
import path from 'path';
import type express from 'express';
import { APP_VERSION } from '@kladde/shared';
import { createKladdeApp } from './app.js';
import { metricsApp, metricsListenFromEnv } from './metrics.js';
import { openDatabase } from './db.js';
import { applyPendingRestore, type RestoreRequest } from './backup/BackupService.js';
import { purgeExpiredTrash, trashRetentionDays } from './trash.js';
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

  // A restore requested in the admin area (#65) replaces the database and attachments before anything opens them
  let restored: RestoreRequest | null = null;
  if (DB_PATH !== ':memory:') {
    try {
      restored = applyPendingRestore({ dataDir: DATA_DIR, dbPath: DB_PATH, backupDir: BACKUP_DIR });
      if (restored) console.log(`♻️  Sicherung ${restored.id} wiederhergestellt (angefordert von ${restored.username})`);
    } catch (err) {
      console.error('Restore failed, starting with the current data:', err);
    }
  }

  const db = openDatabase(DB_PATH, { backupDir: BACKUP_KEEP > 0 ? BACKUP_DIR : undefined });
  const PUBLIC_URL = standalone ? null : env.PUBLIC_URL?.trim() || null;
  const TRUST_PROXY = !standalone && (env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true');
  const clientDist = path.resolve(baseDir, '..', '..', 'client', 'dist');

  // Set below: ends the process so the container's restart policy starts it again (a restore applies at start)
  let restart = () => {};
  const { app, users, audit, live, notes, files, attachmentIndexer, confluence, remoteSync, cockpitWatch, sendReminders, backups, metrics, jobs, plugins } = createKladdeApp({
    db,
    dataDir: DATA_DIR,
    env,
    standalone,
    isProduction,
    publicUrl: PUBLIC_URL,
    trustProxy: TRUST_PROXY,
    clientDist,
    seaAssets: loadSeaClientAssets(),
    backup: DB_PATH !== ':memory:' ? { dir: BACKUP_DIR, defaultKeep: BACKUP_KEEP } : undefined,
    onRestart: () => restart(),
    dbPath: DB_PATH,
  });
  handler = app;

  // Prometheus metrics on an internal port (#92), without a token: do not publish this port
  const metricsListen = standalone ? null : metricsListenFromEnv(env);
  if (metricsListen) {
    const metricsServer = http.createServer(metricsApp(metrics));
    metricsServer.on('error', (err) => console.error('Metrics port failed:', err));
    metricsServer.listen(metricsListen.port, metricsListen.host, () => console.log(`📈 Metriken auf http://${metricsListen.host}:${metricsListen.port}/metrics`));
  }
  if (restored) audit.record('backup_restored', { username: restored.username, detail: restored.id });

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

  // Daily full backup (#65) as set in the admin area (default from BACKUP_KEEP): checked hourly, taken when the last one is a day old
  if (backups) {
    // Only backups that were taken (or failed) reach the dashboard's job list, not the hourly look
    const runBackup = () => {
      const at = Date.now();
      return backups.runSchedule().then(
        (b) => {
          if (!b) return;
          jobs.add({ kind: 'backup', at, durationMs: Date.now() - at, ok: true });
          console.log(`💾 Sicherung ${b.id} erstellt`);
        },
        (err) => {
          jobs.add({ kind: 'backup', at, durationMs: Date.now() - at, ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) });
          console.error('Backup failed:', err);
        }
      );
    };
    setTimeout(runBackup, 60_000).unref();
    setInterval(runBackup, 60 * 60 * 1000).unref();
  }
  const pruneAudit = () => audit.prune();
  setTimeout(pruneAudit, 60_000).unref();
  setInterval(pruneAudit, 24 * 60 * 60 * 1000).unref();

  // Deleted notes older than TRASH_RETENTION_DAYS leave the trash for good (shortly after start, then every 6 hours)
  const trashDays = trashRetentionDays(env);
  if (trashDays > 0) {
    const runPurge = () => {
      try {
        const at = Date.now();
        const n = purgeExpiredTrash(notes, files, trashDays);
        if (n) jobs.add({ kind: 'trash', at, durationMs: Date.now() - at, ok: true, count: n });
        if (n) console.log(`🗑️  ${n} Notiz(en) endgültig aus dem Papierkorb entfernt (älter als ${trashDays} Tage)`);
      } catch (err) {
        console.error('Trash purge failed:', err);
      }
    };
    setTimeout(runPurge, 30_000).unref();
    setInterval(runPurge, 6 * 60 * 60 * 1000).unref();
  }

  // Attachments uploaded before the full-text search (#37), or before OCR was turned on, are indexed once in the background
  setTimeout(() => {
    try {
      const n = attachmentIndexer.backfill();
      if (n) console.log(`🔎 ${n} Anhang/Anhänge werden für die Volltextsuche gelesen${attachmentIndexer.ocr ? ' (mit OCR)' : ''}`);
    } catch (err) {
      console.error('Attachment indexing failed:', err);
    }
  }, 20_000).unref();

  // Confluence (#48): push what changed while the server was down
  setTimeout(() => confluence.catchUp(), 60_000).unref();

  // Synced remote notes: the ones that are due are read a few at a time, checked every minute
  const runRemoteSync = () => void remoteSync.tick().catch((err) => console.error('Remote sync failed:', err));
  setTimeout(runRemoteSync, 45_000).unref();
  setInterval(runRemoteSync, 60_000).unref();

  // Development cockpit: notifying widgets of dashboards that are due, a few at a time, checked every minute
  const runCockpitWatch = () => void cockpitWatch.tick().catch((err) => console.error('Cockpit watch failed:', err));
  setTimeout(runCockpitWatch, 50_000).unref();
  setInterval(runCockpitWatch, 60_000).unref();

  // Build-time plugins: their background jobs, checked every minute
  if (plugins.count) {
    const runPluginJobs = () => void plugins.tick().catch((err) => console.error('Plugin jobs failed:', err));
    setTimeout(runPluginJobs, 40_000).unref();
    setInterval(runPluginJobs, 60_000).unref();
  }

  // Task reminders and daily digests via Web Push: checked every minute
  if (sendReminders) {
    let running = false;
    const runReminders = async () => {
      if (running) return;
      running = true;
      try {
        await sendReminders();
      } catch (err) {
        console.error('Reminders failed:', err);
      } finally {
        running = false;
      }
    };
    setInterval(() => void runReminders(), 60_000).unref();
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
      process.exit();
    });
    setTimeout(() => {
      try {
        db.close();
      } catch {
        // already closed
      }
      process.exit();
    }, 1500).unref();
  };
  // Exit code 75 (temporary failure): restart policies like "on-failure" restart it as well as "unless-stopped"
  restart = () => {
    process.exitCode = 75;
    console.log('🔁 Neustart für die Wiederherstellung');
    shutdown();
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
