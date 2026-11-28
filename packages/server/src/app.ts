import express from 'express';
import fs from 'fs';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { APP_VERSION, type AdminStatus, type Me } from '@kladde/shared';
import { rateLimit } from './http.js';
import { DataCipher } from './crypto.js';
import { AvatarStore } from './AvatarStore.js';
import { UserRecord, UserStore } from './UserStore.js';
import { GroupStore } from './GroupStore.js';
import { NoteStore } from './NoteStore.js';
import { FileStore } from './FileStore.js';
import { ExportMirror } from './ExportMirror.js';
import { ActivityStore } from './ActivityStore.js';
import { CommentStore } from './CommentStore.js';
import { SiteStore } from './sites/SiteStore.js';
import { NotificationStore, notificationPush, type Delivery } from './NotificationStore.js';
import { AuditLog } from './security/AuditLog.js';
import { configuredOrigins, isAllowedOrigin } from './security/origin.js';
import { appCsp, inlineScriptHashes } from './security/csp.js';
import { authRouter } from './auth.js';
import { gitlabConfigFromEnv, loginMethodsFromEnv, openSignupFromEnv } from './gitlabAuth.js';
import { apiRouter, LiveUpdates } from './api.js';
import { StorageStore, defaultQuotaBytes } from './StorageStore.js';
import { adminRouter } from './admin/adminRouter.js';
import { McpTokenStore } from './mcp/McpTokenStore.js';
import { mcpRouters } from './mcp/router.js';
import { ImportTokenStore } from './import/ImportTokenStore.js';
import { importRouters } from './import/router.js';
import { ShortcutTokenStore, shortcutsRouters } from './shortcuts/router.js';
import { CalendarFeedStore } from './calendar/CalendarFeedStore.js';
import { calendarRouters } from './calendar/router.js';
import { ticketHookRouters } from './hooks/router.js';
import { TicketHookStore } from './hooks/TicketHookStore.js';
import { EventBus } from './events/EventBus.js';
import { EventSourceStore } from './events/EventSourceStore.js';
import { eventRouters } from './events/router.js';
import { ticketSubscriber } from './events/tickets.js';
import { PushStore } from './push/PushStore.js';
import { pushRouter } from './push/router.js';
import { inQuietHours, localClock, runReminders, vapidSubject } from './push/reminders.js';
import { allowedPushHosts, sendPush } from './push/webpush.js';
import { EmbeddedAsset, ensureStandaloneUser } from './standalone.js';
import { SpaceIndexes } from './online/SpaceIndex.js';
import { trashRetentionDays } from './trash.js';
import { transcriberFromEnv } from './transcribe.js';
import { AttachmentTextStore } from './attachments/AttachmentTextStore.js';
import { AttachmentIndexer } from './attachments/AttachmentIndexer.js';
import { ocrFromEnv } from './attachments/ocr.js';
import { ConfluenceStore } from './confluence/ConfluenceStore.js';
import { ConfluenceSync } from './confluence/ConfluenceSync.js';
import { httpsTransport, type HttpTransport } from './confluence/ConfluenceClient.js';
import { RemoteInstances } from './remote/RemoteInstances.js';
import { RemoteFetcher } from './remote/RemoteFetcher.js';
import { remoteRouter } from './remote/router.js';
import { GitlabCards } from './remote/GitlabCards.js';
import { RemoteSnapshotStore, RemoteSync, remoteSyncHours } from './remote/RemoteSync.js';
import { confluenceRouter } from './confluence/router.js';
import { CockpitStore } from './cockpit/CockpitStore.js';
import { CockpitService, cockpitHosts } from './cockpit/CockpitService.js';
import { CockpitWatch } from './cockpit/CockpitWatch.js';
import { cockpitRouter } from './cockpit/router.js';
import { featuresOf } from './mcp/tools.js';
import { BackupService } from './backup/BackupService.js';
import { ServerSettings } from './ServerSettings.js';
import { AccountExportService } from './export/AccountExport.js';
import { accountExportRouter } from './export/router.js';
import { Metrics, metricsHandler, metricsTokenFromEnv, type MetricsSources } from './metrics.js';
import { JobLog } from './admin/JobLog.js';
import { overviewBuilder } from './admin/overview.js';
import { backupDatabase } from './db.js';
import { PluginHost } from './plugins/PluginHost.js';
import { appTitleFromEnv, brandIndexHtml, brandManifest } from './branding.js';
import { installedPlugins } from './plugins/installed.js';
import type { InstalledServerPlugin } from './plugins/types.js';

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
  /** Requests to Confluence (#48); tests answer them without a network */
  confluenceTransport?: HttpTransport;
  /** Requests to Jira (development cockpit); tests answer them without a network */
  jiraTransport?: HttpTransport;
  onRegistered?: (user: UserRecord, inviteNote: string) => void;
  /** Backups in the admin area (#65): where they go and how many daily ones `BACKUP_KEEP` keeps; missing = no backups */
  backup?: { dir: string; defaultKeep: number };
  /** Restarts the server (a restore is applied at start); without it the admin area cannot restore */
  onRestart?: () => void;
  /** Path of the database file, for its size in the metrics (#92) */
  dbPath?: string;
  /** Build-time plugins (docs/PLUGINS.md); default: the ones `npm run plugins` built into this image */
  plugins?: InstalledServerPlugin[];
}

export interface KladdeAppContext {
  app: express.Express;
  users: UserStore;
  notes: NoteStore;
  files: FileStore;
  avatars: AvatarStore;
  /** Text extraction of PDF/image attachments for the search (#37) */
  attachmentIndexer: AttachmentIndexer;
  /** One-way sync of notes and folders to Confluence (#48) */
  confluence: ConfluenceSync;
  /** Synced remote notes: `tick()` reads the ones that are due */
  remoteSync: RemoteSync;
  /** Notifying widgets of the development cockpit, read every few minutes */
  cockpitWatch: CockpitWatch;
  audit: AuditLog;
  live: LiveUpdates;
  standaloneUser?: UserRecord;
  /** One run of the Web Push reminder job (not in standalone mode); returns the number of messages sent */
  sendReminders?: (now?: Date) => Promise<number>;
  /** Backups of database and attachments (#65), when the app has a backup directory */
  backups?: BackupService;
  /** What the Prometheus metrics (#92) read; served on `/metrics` with `METRICS_TOKEN` or on `METRICS_PORT` */
  metrics: MetricsSources;
  /** Recent jobs for the admin dashboard */
  jobs: JobLog;
  /** Event bus of the central webhooks (#149) */
  events: EventBus;
  /** Build-time plugins: their routes, note events, jobs (`tick()` every minute) */
  plugins: PluginHost;
  /** Mentions, comments, plugin notifications */
  notifications: NotificationStore;
}

/**
 * `KLADDE_MODE=online`: for teams that are always online with large vaults. Devices keep only a catalog of the notes
 * (paths, versions) and load a note's text when it opens, instead of a full offline copy. Default: `offline`.
 */
export function onlineModeFromEnv(env: NodeJS.ProcessEnv): boolean {
  const mode = env.KLADDE_MODE?.trim().toLowerCase();
  if (mode && mode !== 'online' && mode !== 'offline') console.warn(`KLADDE_MODE="${mode}" is unknown – using offline.`);
  return mode === 'online';
}

/** Builds the Express app and stores for either multi-user server mode or single-user desktop standalone mode */
export function createKladdeApp(opts: KladdeAppOptions): KladdeAppContext {
  const env = opts.env ?? process.env;
  const startedAt = opts.startedAt ?? Date.now();
  const cipher = DataCipher.fromEnv(opts.dataDir, env);
  const online = onlineModeFromEnv(env) && !opts.standalone;
  const users = new UserStore(opts.db);
  const audit = new AuditLog(opts.db);
  const live = new LiveUpdates();
  const mirror = ExportMirror.fromEnv((id) => users.getUser(id)?.username ?? null, env);
  // Created below (it needs the file store); note changes reach it from the first push on
  let confluence: ConfluenceSync | undefined;
  // Synced remote notes; created with the fetcher below
  let remoteSync: RemoteSync | undefined;
  // Notifying cockpit widgets; created with the fetcher below
  let cockpitWatch: CockpitWatch | undefined;
  // Build-time plugins; created once the stores exist, note changes reach them from then on
  let plugins: PluginHost | undefined;
  // Activity of groups and shared notes (#70)
  const activity = new ActivityStore(opts.db, cipher);
  // Mentions and comments (#69, #68): kept per user, a live event to open apps, Web Push to the devices
  let deliverPush: ((userId: string, d: Delivery, noteId: string) => void) | undefined;
  const notifications = new NotificationStore(opts.db, cipher, users, (userId, d) => {
    live.send([userId], 'notification', {});
    // The note (or group) gives the push its tag, so a newer one replaces it on the device
    const noteId = /^\/(?:n|groups|cockpit)\/([^?]+)/.exec(d.url)?.[1] ?? '';
    deliverPush?.(userId, d, noteId);
  });
  const notes = new NoteStore(opts.db, cipher, (event) => {
    live.notify(event.audience);
    activity.record(event);
    notifications.mentions(event);
    mirror?.apply(event);
    confluence?.onNoteChange(event);
    remoteSync?.onNoteChange(event);
    cockpitWatch?.onNoteChange(event);
    plugins?.onNoteChange(event);
  });
  // Git sync was removed: its working copies (plain Markdown of the notes) must not stay on disk
  fs.rmSync(path.join(opts.dataDir, 'git'), { recursive: true, force: true });
  const files = new FileStore(opts.db, cipher, opts.dataDir);
  // Quotas (#91): STORAGE_QUOTA_MB is the default for every account and group, admins set own limits
  const storage = new StorageStore(opts.db, defaultQuotaBytes(env));
  files.guard = (ownerId, size) => storage.assertRoom(ownerId, size);
  const metrics = new Metrics();
  const plainTranscriber = transcriberFromEnv(env);
  // Counted for the metrics (#92): how many run and how they end
  const transcriber: typeof plainTranscriber = plainTranscriber
    ? async (audio, lang) => {
        metrics.transcriptionsRunning++;
        try {
          const text = await plainTranscriber(audio, lang);
          metrics.transcriptions.ok++;
          return text;
        } catch (err) {
          metrics.transcriptions.failed++;
          throw err;
        } finally {
          metrics.transcriptionsRunning--;
        }
      }
    : null;
  // Full-text search in attachments (#37): every new PDF (and image, with OCR) is indexed in the background
  const attachmentTexts = new AttachmentTextStore(opts.db, cipher);
  const attachmentIndexer = new AttachmentIndexer(files, attachmentTexts, ocrFromEnv(env, opts.dataDir));
  files.onSaved((id, mime) => attachmentIndexer.enqueue(id, mime));
  const attachmentSearch = { files, texts: attachmentTexts, ocr: !!attachmentIndexer.ocr };
  // Confluence (#48): https only; private addresses (an intranet Confluence) only when the admin allows them
  const confluenceAllowPrivate = ['1', 'true'].includes(env.CONFLUENCE_ALLOW_PRIVATE?.trim().toLowerCase() ?? '');
  confluence = new ConfluenceSync(new ConfluenceStore(opts.db, cipher), notes, files, {
    transport: opts.confluenceTransport ?? httpsTransport({ allowPrivate: confluenceAllowPrivate }),
  });
  const avatars = new AvatarStore(opts.db, cipher, opts.dataDir);
  const standaloneUser = opts.standalone ? ensureStandaloneUser(users) : undefined;
  const groupStore = new GroupStore(opts.db);
  // Plugins migrate their own tables here (a backup first when a step is pending), before the first request
  const backupDir = opts.backup?.dir;
  plugins = new PluginHost({
    db: opts.db,
    cipher,
    notes,
    users,
    env,
    plugins: opts.plugins ?? installedPlugins,
    standaloneUser,
    backup: backupDir ? () => void backupDatabase(opts.db, backupDir) : undefined,
    notifications,
    groupMembers: (groupId) => groupStore.memberIds(groupId),
  });
  const push = opts.standalone ? undefined : new PushStore(opts.db, cipher, allowedPushHosts(env));
  const pushSubject = vapidSubject(env, opts.publicUrl);
  if (push) {
    // Outside the device's quiet hours; the note's name only travels when the device shows texts
    deliverPush = (userId, d, noteId) => {
      for (const sub of push.all()) {
        if (sub.userId !== userId) continue;
        if (inQuietHours(localClock(new Date(), sub.settings.timeZone).minutes, sub.settings)) continue;
        const payload = notificationPush(sub.settings.showText ? d : { ...d, name: '', text: '' }, sub.settings.lang, noteId);
        void sendPush(sub.target, payload, push.vapidKeys(), pushSubject, { urgency: 'normal', topic: payload.tag.replace(/[^\w-]/g, '').slice(0, 32) })
          .then((outcome) => outcome === 'gone' && push.drop(sub.id))
          .catch(() => {});
      }
    };
  }
  const mcp = mcpRouters({
    users,
    notes,
    files,
    attachmentTexts: { texts: attachmentTexts, ocr: attachmentSearch.ocr },
    tokens: new McpTokenStore(opts.db),
    audit,
    publicUrl: opts.publicUrl,
    standaloneUser,
    pluginTools: plugins.count ? (userId) => plugins!.mcpTools(userId) : undefined,
  });

  if (mirror) for (const u of users.listUsers()) mirror.writeAll(u.id, notes.allOf(u.id));

  const backups =
    opts.backup && !opts.standalone
      ? new BackupService({ db: opts.db, dataDir: opts.dataDir, backupDir: opts.backup.dir, settings: new ServerSettings(opts.db), defaultKeep: opts.backup.defaultKeep })
      : undefined;
  // While a restore waits for the restart nothing may change the database any more
  let maintenance = false;

  const status = (): AdminStatus => ({
    version: APP_VERSION,
    startedAt,
    users: users.countUsers(),
    ...notes.counts(),
    connections: live.connections,
  });

  const metricsSources: MetricsSources = {
    metrics,
    db: opts.db,
    dbPath: opts.dbPath && opts.dbPath !== ':memory:' ? opts.dbPath : null,
    startedAt,
    sseConnections: () => live.connections,
    attachmentQueue: () => attachmentIndexer.pending,
    ocr: !!attachmentIndexer.ocr,
    transcription: !!transcriber,
    lastBackupAt: () => (backups ? (backups.list()[0]?.createdAt ?? null) : null),
  };

  // The admin dashboard: counts, the machine, who is online and the recent jobs
  const jobs = new JobLog();
  // Event bus (#149): central webhooks publish git events; ticket automations and plugins subscribe
  const events = new EventBus((subscriber, message, err) => {
    console.error(`Event ${message.event.type} at ${subscriber} failed:`, err);
    jobs.add({ kind: 'event', at: Date.now(), durationMs: 0, ok: false, error: `${subscriber}: ${message.event.type}` });
  });
  events.subscribe(ticketSubscriber(notes, users));
  plugins.subscribe(events);
  const overview = overviewBuilder({
    db: opts.db,
    dbPath: metricsSources.dbPath,
    dataDir: opts.dataDir,
    startedAt,
    jobs,
    online: () => live.online(),
    connections: () => live.connections,
    databases: () => notes.countDatabases(),
    lastBackupAt: metricsSources.lastBackupAt,
  });

  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy) app.set('trust proxy', 1);
  app.use(metrics.middleware());
  const allowedOrigins = configuredOrigins(env);

  // The served index.html decides which inline scripts the CSP allows (hashes, no 'unsafe-inline')
  const indexSource = opts.seaAssets?.get('/index.html')?.data.toString('utf8') ?? (opts.clientDist && fs.existsSync(path.join(opts.clientDist, 'index.html')) ? fs.readFileSync(path.join(opts.clientDist, 'index.html'), 'utf8') : '');
  const csp = appCsp(inlineScriptHashes(indexSource));
  const appTitle = appTitleFromEnv(env);

  app.use((_req, res, next) => {
    // Routes with their own policy (attachments, avatars) replace it
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // The microphone only for the app itself (voice notes, #33), never for embedded pages
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    next();
  });

  // Prometheus metrics (#92): only with METRICS_TOKEN, as a bearer token; never in the desktop app
  const metricsToken = opts.standalone ? null : metricsTokenFromEnv(env);
  if (metricsToken) app.get('/metrics', metricsHandler(metricsSources, metricsToken));

  app.get('/health', (_req, res) => res.json({ ok: true, version: APP_VERSION, standalone: opts.standalone, ...(maintenance ? { maintenance } : {}) }));
  app.use(['/api', '/mcp'], (_req, res, next) => {
    if (!maintenance) return next();
    res.setHeader('Retry-After', '10');
    res.status(503).json({ error: 'Kladde wird gerade wiederhergestellt und startet neu.' });
  });
  // PWA share target: the service worker normally answers this POST (client/public/share-target.js). Without it
  // (not installed yet, cleared site data) the shared content cannot be read here, so the app shows a hint instead.
  app.post('/share', (_req, res) => res.redirect(303, '/share?error=1'));
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
      displayName: user.displayName,
        accent: user.accent,
        standalone: true,
        dataDir: opts.dataDir,
        transcription: !!transcriber,
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
      displayName: user.displayName,
        accent: user.accent,
      externalLogins: users.externalLoginsOf(user.id),
      transcription: !!transcriber,
      ...(online ? { online: true } : {}),
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
    const gitlabConfig = gitlabConfigFromEnv(env);
    app.use(
      '/api/auth',
      express.json({ limit: '64kb' }),
      authRouter({
        users,
        audit,
        transcription: !!transcriber,
        online,
        publicUrl: opts.publicUrl,
        secureCookies: opts.isProduction && (opts.publicUrl?.startsWith('https://') ?? false),
        devLogin: !opts.isProduction && env.DEV_LOGIN === '1',
        appName: appTitle ?? undefined,
        gitlab: gitlabConfig,
        openSignup: openSignupFromEnv(env),
        loginMethods: loginMethodsFromEnv(env, !!gitlabConfig),
        onRegistered: opts.onRegistered,
      })
    );
  }

  if (!opts.standalone) {
    // Bearer import tokens for the import CLI; before the global JSON parser so the routes set their own limits
    const imports = importRouters({ users, notes, files, tokens: new ImportTokenStore(opts.db), audit });
    app.use('/api/import', imports.bearerRouter);
    app.use('/api/import-tokens', imports.accountRouter);
    // Apple Shortcuts (#46): bearer shortcut tokens, their own body limits like the import
    const shortcuts = shortcutsRouters({ users, notes, files, tokens: new ShortcutTokenStore(opts.db), audit, publicUrl: opts.publicUrl });
    app.use('/api/shortcuts', shortcuts.bearerRouter);
    app.use('/api/shortcut-tokens', shortcuts.accountRouter);
    // Calendar feeds: the feed is read by calendar apps through its secret address (no cookies)
    const ticketHooks = ticketHookRouters({ users, notes, hooks: new TicketHookStore(opts.db, cipher), audit, publicUrl: opts.publicUrl });
    const calendar = calendarRouters({ users, notes, feeds: new CalendarFeedStore(opts.db, cipher), audit, publicUrl: opts.publicUrl });
    app.use('/api/calendar', calendar.feedRouter);
    app.use('/api/calendar-feeds', calendar.accountRouter);
    // Ticket workflows: GitLab/GitHub deliver merge request events through the hook's secret address (no cookies)
    app.use('/api/hooks', ticketHooks.receiver);
    app.use('/api/ticket-hooks', ticketHooks.accountRouter);
    // Central webhooks: one per GitLab/GitHub project or group, its events go onto the bus
    const eventHooks = eventRouters({ users, notes, groups: groupStore, sources: new EventSourceStore(opts.db, cipher), bus: events, audit, publicUrl: opts.publicUrl });
    app.use('/api/events/hooks', eventHooks.receiver);
    app.use('/api/event-sources', eventHooks.accountRouter);
    // Web Push reminders (the standalone desktop app has no service worker)
    app.use('/api/push', pushRouter({ users, notes, store: push!, subject: pushSubject }));
  }

  app.use('/api', (req, res, next) =>
    req.path === '/sync' || req.path === '/files' || req.path === '/me/avatar' ? next() : express.json({ limit: '256kb' })(req, res, next)
  );
  app.use('/api/mcp', mcp.accountRouter);
  // Account export as ZIP (#93): built in the background, the settings poll until it is ready
  const accountExports = new AccountExportService({ notes, files, dataDir: opts.dataDir, pluginFiles: plugins.count ? (userId) => plugins!.exportFiles(userId) : undefined });
  app.use('/api/account-export', accountExportRouter({ users, exports: accountExports, audit, standaloneUser }));
  app.use('/api/confluence', confluenceRouter({ users, sync: confluence, audit, allowPrivate: confluenceAllowPrivate, standaloneUser }));
  // Remote notes: Markdown from GitLab/GitHub, read live with the access configured for everyone
  const remoteInstances = new RemoteInstances(env, new ServerSettings(opts.db), cipher);
  const remoteFetcher = new RemoteFetcher(remoteInstances);
  // Synced ones (`sync: true`) are read every REMOTE_SYNC_HOURS and kept as an encrypted copy (search, offline)
  remoteSync = new RemoteSync(new RemoteSnapshotStore(opts.db, cipher), notes, remoteFetcher, remoteSyncHours(env) * 3_600_000);
  // Development cockpit: GitLab/Jira widgets with each user's own tokens; GitLab only on the configured instances
  const cockpit = new CockpitService(new CockpitStore(opts.db, cipher), {
    gitlabHosts: cockpitHosts(() => remoteInstances.gitlabHosts(), env, gitlabConfigFromEnv(env)),
    fetcher: remoteFetcher,
    jiraTransport: opts.jiraTransport ?? httpsTransport({ allowPrivate: ['1', 'true'].includes(env.JIRA_ALLOW_PRIVATE?.trim().toLowerCase() ?? '') }),
    jiraAllowPrivate: ['1', 'true'].includes(env.JIRA_ALLOW_PRIVATE?.trim().toLowerCase() ?? ''),
  });
  cockpitWatch = new CockpitWatch({ service: cockpit, notifications, isPerson: (id) => !!users.getUser(id), features: (id) => featuresOf(notes, id) });
  app.use('/api/cockpit', cockpitRouter({ users, service: cockpit, audit, standaloneUser }));
  app.use('/api/remote-notes', remoteRouter({ users, notes, instances: remoteInstances, fetcher: remoteFetcher, sync: remoteSync, cards: new GitlabCards(remoteInstances, remoteFetcher), standaloneUser }));
  if (!opts.standalone) {
    app.use(
      '/api/admin',
      adminRouter({
        users,
        storage,
        audit,
        status,
        overview,
        remote: { instances: remoteInstances, fetcher: remoteFetcher },
        backups,
        onRestore: opts.onRestart,
        enterMaintenance: () => {
          maintenance = true;
        },
      })
    );
  }
  // Build-time plugins: `/api/plugins` and their routes under `/api/p/<id>`
  plugins.mount(app);
  app.use('/api', apiRouter(users, notes, files, live, { standaloneUser, avatars, storage, meFor, trashDays: trashRetentionDays(env), transcriber, attachmentSearch, groups: opts.standalone ? undefined : groupStore, spaces: online ? new SpaceIndexes(notes) : undefined, activity, notifications, jobs, comments: opts.standalone ? undefined : new CommentStore(opts.db, cipher, users), sites: opts.standalone ? undefined : new SiteStore(opts.db, cipher, notes) }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Nicht gefunden' }));

  // APP_TITLE: the served index.html and manifest carry the app's name (the client reads it from the page)
  const brandedIndex = appTitle && indexSource ? brandIndexHtml(indexSource, appTitle) : null;
  if (appTitle && brandedIndex) {
    const manifestSource =
      opts.seaAssets?.get('/manifest.webmanifest')?.data.toString('utf8') ??
      (opts.clientDist && fs.existsSync(path.join(opts.clientDist, 'manifest.webmanifest')) ? fs.readFileSync(path.join(opts.clientDist, 'manifest.webmanifest'), 'utf8') : null);
    const brandedManifest = manifestSource ? brandManifest(manifestSource, appTitle) : null;
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path === '/' || req.path === '/index.html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', opts.standalone ? 'no-store' : 'no-cache');
        res.status(200).send(req.method === 'HEAD' ? undefined : brandedIndex);
        return;
      }
      if (brandedManifest && req.path === '/manifest.webmanifest') {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.setHeader('Cache-Control', 'no-cache');
        res.status(200).send(req.method === 'HEAD' ? undefined : brandedManifest);
        return;
      }
      next();
    });
  }

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
        res.status(200).send(brandedIndex ?? indexHtml.data);
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
    // Generous: every page load of the app comes through here (behind a proxy without TRUST_PROXY all share one IP)
    app.get(/^\/(?!api\/).*/, rateLimit(1200, 60_000), (_req, res) => {
      res.setHeader('Cache-Control', opts.standalone ? 'no-store' : 'no-cache');
      if (brandedIndex) res.type('html').send(brandedIndex);
      else res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  });

  const sendReminders = push ? (now?: Date) => runReminders(push, notes, pushSubject, now) : undefined;
  return { app, users, notes, files, avatars, attachmentIndexer, confluence, remoteSync, cockpitWatch, audit, live, standaloneUser, sendReminders, backups, metrics: metricsSources, jobs, events, plugins, notifications };
}
