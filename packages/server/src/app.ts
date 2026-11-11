import express from 'express';
import fs from 'fs';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { APP_VERSION, type AdminStatus, type Me } from '@kladde/shared';
import { DataCipher } from './crypto.js';
import { AvatarStore } from './AvatarStore.js';
import { UserRecord, UserStore } from './UserStore.js';
import { NoteStore } from './NoteStore.js';
import { FileStore } from './FileStore.js';
import { GitSync } from './GitSync.js';
import { ExportMirror } from './ExportMirror.js';
import { AuditLog } from './security/AuditLog.js';
import { configuredOrigins, isAllowedOrigin } from './security/origin.js';
import { authRouter } from './auth.js';
import { gitlabConfigFromEnv } from './gitlabAuth.js';
import { apiRouter, LiveUpdates } from './api.js';
import { adminRouter } from './admin/adminRouter.js';
import { McpTokenStore } from './mcp/McpTokenStore.js';
import { mcpRouters } from './mcp/router.js';
import { EmbeddedAsset, ensureStandaloneUser } from './standalone.js';

export interface KladdeAppOptions {
  db: DatabaseSync;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  standalone: boolean;
  isProduction: boolean;
  publicUrl: string | null;
  trustProxy: boolean;
  startedAt?: number;
  clientDist?: string;
  seaAssets?: Map<string, EmbeddedAsset> | null;
  onRegistered?: (user: UserRecord, inviteNote: string) => void;
}

export interface KladdeAppContext {
  app: express.Express;
  users: UserStore;
  notes: NoteStore;
  files: FileStore;
  avatars: AvatarStore;
  audit: AuditLog;
  live: LiveUpdates;
  standaloneUser?: UserRecord;
}

/** Builds the Express app and stores for either multi-user server mode or single-user desktop standalone mode */
export function createKladdeApp(opts: KladdeAppOptions): KladdeAppContext {
  const env = opts.env ?? process.env;
  const startedAt = opts.startedAt ?? Date.now();
  const cipher = DataCipher.fromEnv(opts.dataDir, env);
  const users = new UserStore(opts.db);
  const audit = new AuditLog(opts.db);
  const live = new LiveUpdates();
  const mirror = ExportMirror.fromEnv((id) => users.getUser(id)?.username ?? null, env);
  let gitSync: GitSync | undefined;
  const notes = new NoteStore(opts.db, cipher, (event) => {
    live.notify(event.audience);
    mirror?.apply(event);
    gitSync?.touch(event.ownerId);
  });
  gitSync = new GitSync(opts.db, cipher, (id) => notes.allOf(id), (id) => users.getUser(id)?.username ?? null, opts.dataDir);
  const files = new FileStore(opts.db, cipher, opts.dataDir);
  const avatars = new AvatarStore(opts.db, cipher, opts.dataDir);
  const standaloneUser = opts.standalone ? ensureStandaloneUser(users) : undefined;
  const mcp = mcpRouters({
    users,
    notes,
    tokens: new McpTokenStore(opts.db),
    audit,
    publicUrl: opts.publicUrl,
    standaloneUser,
  });

  if (mirror) for (const u of users.listUsers()) mirror.writeAll(u.id, notes.allOf(u.id));

  const status = (): AdminStatus => ({
    version: APP_VERSION,
    startedAt,
    users: users.countUsers(),
    ...notes.counts(),
    connections: live.connections,
  });

  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy) app.set('trust proxy', 1);
  const allowedOrigins = configuredOrigins(env);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true, version: APP_VERSION, standalone: opts.standalone }));
  // MCP for AI assistants (bearer tokens, so outside the /api origin check)
  app.use(mcp.publicRouter);

  app.use('/api', (req, res, next) => {
    if (opts.standalone) {
      // Standalone runs without cookies on 127.0.0.1: block cross-site browser requests from foreign tabs
      const secFetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
      if (secFetchSite === 'cross-site' || !isAllowedOrigin(req, allowedOrigins, false)) {
        res.status(403).json({ error: 'Fremde Herkunft' });
        return;
      }
    } else if (req.method !== 'GET' && !isAllowedOrigin(req, allowedOrigins, opts.trustProxy)) {
      res.status(403).json({ error: 'Fremde Herkunft' });
      return;
    }
    next();
  });

  const meFor = (record: UserRecord): Me => {
    const user = users.getUser(record.id) ?? record;
    if (standaloneUser) {
      return {
        id: user.id,
        username: user.username,
        createdAt: user.createdAt,
        passkeys: [],
        hasPassword: false,
        isAdmin: false,
        avatarUrl: user.avatarUrl,
        standalone: true,
        dataDir: opts.dataDir,
      };
    }
    return {
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
      passkeys: users.credentialsOf(user.id).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
      hasPassword: user.hasPassword,
      isAdmin: user.isAdmin,
      avatarUrl: user.avatarUrl,
      externalLogins: users.externalLoginsOf(user.id),
    };
  };

  if (standaloneUser) {
    const standaloneAuth = express.Router();
    standaloneAuth.get('/me', (_req, res) => {
      res.json(meFor(standaloneUser));
    });
    standaloneAuth.use((_req, res) => {
      res.status(404).json({ error: 'Im Standalone-Modus nicht verfügbar.' });
    });
    app.use('/api/auth', standaloneAuth);
  } else {
    app.use(
      '/api/auth',
      express.json({ limit: '64kb' }),
      authRouter({
        users,
        audit,
        publicUrl: opts.publicUrl,
        secureCookies: opts.isProduction && (opts.publicUrl?.startsWith('https://') ?? false),
        devLogin: !opts.isProduction && env.DEV_LOGIN === '1',
        gitlab: gitlabConfigFromEnv(env),
        onRegistered: opts.onRegistered,
      })
    );
  }

  app.use('/api', (req, res, next) =>
    req.path === '/sync' || req.path === '/files' || req.path === '/me/avatar' ? next() : express.json({ limit: '256kb' })(req, res, next)
  );
  app.use('/api/mcp', mcp.accountRouter);
  if (!opts.standalone) {
    app.use('/api/admin', adminRouter({ users, audit, status }));
  }
  app.use('/api', apiRouter(users, notes, files, live, gitSync, { standaloneUser, avatars, meFor }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Nicht gefunden' }));

  if (opts.seaAssets && opts.seaAssets.size > 0) {
    const assets = opts.seaAssets;
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (opts.standalone && req.path === '/sw.js') {
        res.status(404).end();
        return;
      }
      const key = req.path === '/' ? '/index.html' : req.path;
      const hit = assets.get(key);
      if (!hit) return next();
      res.setHeader('Content-Type', hit.mime);
      if (key.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', opts.standalone ? 'no-store' : 'no-cache');
      if (req.method === 'HEAD') res.status(200).end();
      else res.status(200).send(hit.data);
    });
    const indexHtml = assets.get('/index.html');
    if (indexHtml) {
      app.get(/^\/(?!api\/).*/, (_req, res) => {
        res.setHeader('Content-Type', indexHtml.mime);
        res.setHeader('Cache-Control', opts.standalone ? 'no-store' : 'no-cache');
        res.status(200).send(indexHtml.data);
      });
    }
  } else if (opts.clientDist && fs.existsSync(opts.clientDist)) {
    if (opts.standalone) {
      app.get('/sw.js', (_req, res) => res.status(404).end());
    }
    const clientDist = opts.clientDist;
    app.use(
      express.static(clientDist, {
        index: false,
        setHeaders: (res, file) => {
          if (/[\\/]assets[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', opts.standalone ? 'no-store' : 'no-cache');
        },
      })
    );
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', opts.standalone ? 'no-store' : 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  });

  return { app, users, notes, files, avatars, audit, live, standaloneUser };
}
