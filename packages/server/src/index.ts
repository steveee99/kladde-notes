import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { APP_VERSION } from '@kladde/shared';
import { backupDatabase, openDatabase } from './db.js';
import { DataCipher } from './crypto.js';
import { UserStore } from './UserStore.js';
import { NoteStore } from './NoteStore.js';
import { FileStore } from './FileStore.js';
import { ExportMirror } from './ExportMirror.js';
import { AuditLog } from './security/AuditLog.js';
import { configuredOrigins, isAllowedOrigin } from './security/origin.js';
import { authRouter } from './auth.js';
import { apiRouter, LiveUpdates } from './api.js';
import { TelegramAdminBot } from './admin/TelegramBot.js';
import { AdminActions, escapeHtml } from './admin/AdminCommands.js';
import { adminRouter } from './admin/adminRouter.js';

const env = process.env;
const PORT = Number(env.PORT ?? 3002);
const isProduction = env.NODE_ENV === 'production';
const DB_PATH = path.resolve(env.DB_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'kladde.sqlite'));
const DATA_DIR = path.dirname(DB_PATH);
const PUBLIC_URL = env.PUBLIC_URL?.trim() || null;
const TRUST_PROXY = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true';
const startedAt = Date.now();

const db = openDatabase(DB_PATH);
const cipher = DataCipher.fromEnv(DATA_DIR);
const users = new UserStore(db);
const audit = new AuditLog(db);
const live = new LiveUpdates();
const mirror = ExportMirror.fromEnv((id) => users.getUser(id)?.username ?? null);
const notes = new NoteStore(db, cipher, (event) => {
  live.notify(event.audience);
  mirror?.apply(event);
});
const files = new FileStore(db, cipher, DATA_DIR);

if (mirror) for (const u of users.listUsers()) mirror.writeAll(u.id, notes.allOf(u.id));

// ---------------------------------------------------------------- admin

const actions: AdminActions = {
  createInvite: (note) => users.createInvite(note),
  listInvites: () => users.listInvites(),
  deleteInvite: (code) => users.deleteInvite(code),
  listUsers: () => users.listUsers(),
  setBanned: (username, banned) => {
    const u = users.findByUsername(username);
    return !!u && users.setBanned(u.id, banned);
  },
  resetPassword: async (username) => {
    const u = users.findByUsername(username);
    return u ? users.resetPassword(u.id) : null;
  },
  setAdmin: (username, admin) => {
    const u = users.findByUsername(username);
    return !!u && users.setAdmin(u.id, admin);
  },
  auditLog: () => audit.recent(25),
  status: () => ({ version: APP_VERSION, startedAt, users: users.countUsers(), ...notes.counts(), connections: live.connections }),
};
const bot = TelegramAdminBot.fromEnv(actions, env, (cmd) =>
  audit.record('admin_command', { detail: `telegram ${cmd.chatId}: ${cmd.text}` })
);
bot?.start();

const inviteUrl = (code: string) => `${(PUBLIC_URL ?? `http://localhost:${isProduction ? PORT : 5174}`).replace(/\/$/, '')}/invite/${code}`;
// Without users and without a bot there is no other way in: print a first invite
if (users.countUsers() === 0 && !users.hasOpenInvite()) {
  const invite = users.createInvite('Erstes Konto');
  console.log(`\n✉️  Erste Einladung (14 Tage gültig): ${inviteUrl(invite.code)}\n`);
}

// ---------------------------------------------------------------- http

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);
const allowedOrigins = configuredOrigins(env);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, version: APP_VERSION }));

app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !isAllowedOrigin(req, allowedOrigins, TRUST_PROXY)) {
    res.status(403).json({ error: 'Fremde Herkunft' });
    return;
  }
  next();
});
app.use('/api/auth', express.json({ limit: '64kb' }), authRouter({
  users,
  audit,
  publicUrl: PUBLIC_URL,
  secureCookies: isProduction && (PUBLIC_URL?.startsWith('https://') ?? false),
  devLogin: !isProduction && env.DEV_LOGIN === '1',
  onRegistered: (user, note) => void bot?.notify(`🆕 Neues Konto: <b>${escapeHtml(user.username)}</b>${note ? ` (Einladung: ${escapeHtml(note)})` : ''}`),
}));
app.use('/api', (req, res, next) => (req.path === '/sync' || req.path === '/files' ? next() : express.json({ limit: '256kb' })(req, res, next)));
app.use('/api/admin', adminRouter({ users, audit, status: actions.status }));
app.use('/api', apiRouter(users, notes, files, live));

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(
    express.static(clientDist, {
      index: false,
      setHeaders: (res, file) => {
        if (/[\\/]assets[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );
  // Single-page app: every other route gets index.html
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Serverfehler' });
});

const server = app.listen(PORT, () => console.log(`📝 Kladde ${APP_VERSION} läuft auf http://localhost:${PORT}`));

// ---------------------------------------------------------------- backups & shutdown

const BACKUP_KEEP = Number(env.BACKUP_KEEP ?? 7);
const BACKUP_DIR = path.resolve(env.BACKUP_DIR ?? path.join(DATA_DIR, 'backups'));
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

const shutdown = () => {
  bot?.stop();
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
