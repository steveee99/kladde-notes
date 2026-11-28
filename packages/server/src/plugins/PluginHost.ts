import crypto from 'crypto';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { APP_VERSION, FEATURES_SETTING, normalizeFeatures, parseFrontmatter, SYSTEM_PREFIX, type SyncedNote } from '@kladde/shared';
import { isGitEventType, localize, PLUGIN_API_VERSION, PLUGIN_ID_PATTERN, PluginError, pluginTablePrefix, satisfies, type GitEvent, type GitEventType } from '@kladde/plugin-api';
import type { PluginMcpTool, PluginNote, PluginNoteFilter, PluginNotes, PluginNotification, PluginServerContext, PluginUser } from '@kladde/plugin-api/server';
import type { DataCipher } from '../crypto.js';
import { transaction } from '../db.js';
import type { NoteChangeEvent, NoteStore } from '../NoteStore.js';
import type { UserRecord, UserStore } from '../UserStore.js';
import { requireUser } from '../http.js';
import type { NotificationStore } from '../NotificationStore.js';
import type { EventBus } from '../events/EventBus.js';
import { migratePlugins, pendingPluginMigrations, pluginSchemaVersions } from './migrations.js';
import type { InstalledServerPlugin } from './types.js';

export interface PluginHostOptions {
  db: DatabaseSync;
  cipher: DataCipher;
  notes: NoteStore;
  users: UserStore;
  env: NodeJS.ProcessEnv;
  plugins: InstalledServerPlugin[];
  standaloneUser?: UserRecord;
  /** Taken once before the first pending plugin migration of an existing database */
  backup?: () => void;
  /** Where `ctx.notify` delivers (none in standalone mode) */
  notifications?: NotificationStore;
  /** Member ids of a group, for git events of group webhooks */
  groupMembers?: (groupId: string) => string[];
}

/** A plugin's MCP tool as the MCP endpoint offers it: its full name and a call that may return a promise */
export interface PluginToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write: boolean;
  run(args: Record<string, unknown>, call: { userId: string; agent: string; canWrite: boolean }): unknown;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** What a plugin may send: short headlines and texts, paths inside the plugin */
const TITLE_MAX = 120;
const TEXT_MAX = 500;

/** One plugin as the admin area and `/api/plugins` show it */
export interface PluginStatus {
  id: string;
  name: string;
  version: string;
  api: string;
  schema: number;
  /** Why the host left it out (plugin API out of range) */
  disabled?: string;
}

interface Loaded {
  installed: InstalledServerPlugin;
  ctx: PluginServerContext;
  /** Next run per job name */
  due: Map<string, number>;
  running: Set<string>;
}

const userOf = (u: UserRecord): PluginUser => ({ id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin });

const typeOf = (content: string): string | undefined => {
  const t = parseFrontmatter(content).data.type;
  return t ? t : undefined;
};

/**
 * Runs the plugins built into this image (scripts/plugins.mjs, docs/PLUGINS.md): checks their plugin API range,
 * migrates their tables, gives each a context (database, encryption, notes through the sync, settings), mounts
 * their routes under `/api/p/<id>`, forwards note changes and runs their background jobs. A plugin's errors are
 * logged and never stop Kladde's own work.
 */
export class PluginHost {
  private readonly loaded: Loaded[] = [];
  private readonly disabled: PluginStatus[] = [];

  constructor(private readonly opts: PluginHostOptions) {
    const seen = new Set<string>();
    for (const installed of opts.plugins) {
      const id = installed.plugin.id;
      if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(`Plugin ${installed.name}: invalid id "${id}"`);
      if (installed.id !== id) throw new Error(`Plugin ${installed.name}: kladde.id "${installed.id}" in package.json differs from the plugin's id "${id}"`);
      if (seen.has(id)) throw new Error(`Two plugins use the id "${id}"`);
      seen.add(id);
      const toolNames = new Set<string>();
      for (const tool of installed.plugin.mcpTools ?? []) {
        if (!TOOL_NAME.test(tool.name)) throw new Error(`Plugin ${installed.name}: invalid MCP tool name "${tool.name}" (a–z, 0–9 and _, starting with a letter)`);
        if (toolNames.has(tool.name)) throw new Error(`Plugin ${installed.name}: two MCP tools are called "${tool.name}"`);
        toolNames.add(tool.name);
      }
      for (const type of [...Object.keys(installed.plugin.events ?? {}), ...(installed.plugin.rawPayload ?? [])]) {
        if (!isGitEventType(type)) throw new Error(`Plugin ${installed.name}: unknown event type "${type}" (docs/EVENTS.md)`);
      }
      // The build checks this already; an image put together by hand still must not run a plugin against the wrong API
      if (!satisfies(PLUGIN_API_VERSION, installed.api)) {
        const why = `needs @kladde/plugin-api ${installed.api}, Kladde ${APP_VERSION} provides ${PLUGIN_API_VERSION}`;
        console.error(`🧩 Plugin ${id} (${installed.name} ${installed.version}) is left out: it ${why}`);
        this.disabled.push({ id, name: installed.name, version: installed.version, api: installed.api, schema: 0, disabled: why });
        continue;
      }
      this.loaded.push({ installed, ctx: this.contextFor(installed), due: new Map(), running: new Set() });
    }
    const schemas = this.loaded.map((l) => ({ id: l.installed.plugin.id, migrations: l.installed.plugin.migrations }));
    if (opts.backup && pendingPluginMigrations(opts.db, schemas) > 0 && opts.users.countUsers() > 0) {
      try {
        opts.backup();
      } catch (err) {
        console.error('Backup before the plugin migrations failed:', err);
      }
    }
    const applied = migratePlugins(opts.db, schemas, (pluginId, step) => {
      const l = this.loaded.find((x) => x.installed.plugin.id === pluginId)!;
      step.up?.(opts.db, l.ctx);
    });
    for (const [id, versions] of Object.entries(applied)) if (versions.length) console.log(`🧩 Plugin ${id}: Schema ${versions[versions.length - 1]}`);
    for (const l of this.loaded) {
      try {
        l.installed.plugin.start?.(l.ctx);
      } catch (err) {
        l.ctx.log.error('start failed', err);
      }
    }
  }

  get count(): number {
    return this.loaded.length;
  }

  /** Whether the user switched the plugin on (or it is on by default and they never switched it) */
  enabledFor(userId: string, id: string): boolean {
    const installed = this.loaded.find((l) => l.installed.plugin.id === id)?.installed;
    if (!installed) return false;
    const settings = this.opts.notes.fetchNotes(userId, [`syssettings-${userId}`])[0];
    let raw: unknown;
    try {
      raw = settings ? (JSON.parse(settings.content) as Record<string, unknown>)[FEATURES_SETTING] : undefined;
    } catch {
      raw = undefined;
    }
    return normalizeFeatures(raw).plugins[id] ?? installed.defaultEnabled;
  }

  status(): PluginStatus[] {
    const schema = pluginSchemaVersions(this.opts.db);
    return [
      ...this.loaded.map(({ installed: i }) => ({ id: i.plugin.id, name: i.name, version: i.version, api: i.api, schema: schema.get(i.plugin.id) ?? 0 })),
      ...this.disabled,
    ];
  }

  /** Mounts `/api/plugins` and every plugin's routes; call after the JSON body parser, before the `/api` 404 */
  mount(app: express.Express): void {
    const signedIn = requireUser(this.opts.users, this.opts.standaloneUser);
    app.get('/api/plugins', signedIn, (req, res) => {
      res.json(this.status().map((s) => ({ ...s, enabled: !s.disabled && this.enabledFor(req.user!.id, s.id) })));
    });
    for (const l of this.loaded) {
      const { plugin } = l.installed;
      const base = `/api/p/${plugin.id}`;
      if (plugin.publicRoutes) {
        const router = express.Router();
        plugin.publicRoutes(router, l.ctx);
        app.use(`${base}/public`, router);
      }
      if (plugin.routes) {
        const router = express.Router();
        plugin.routes(router, l.ctx);
        app.use(base, signedIn, (req, res, next) => {
          if (this.enabledFor(req.user!.id, plugin.id)) return next();
          // `code`: the client syncs its feature switch and asks again (the switch reaches the server with the next sync)
          res.status(403).json({ error: 'Dieses Plugin ist für dein Konto nicht aktiviert.', code: 'plugin_disabled' });
        }, router);
      }
      app.use(base, (_req, res) => res.status(404).json({ error: 'Nicht gefunden' }));
      app.use(base, (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (res.headersSent) return next(err);
        if (err instanceof PluginError || (err as { name?: string })?.name === 'PluginError') {
          const e = err as PluginError;
          res.status(e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: e.message });
          return;
        }
        l.ctx.log.error('request failed', err);
        res.status(500).json({ error: 'Serverfehler im Plugin' });
      });
    }
  }

  /** Forwards an accepted note change to every plugin (synchronously, errors only logged) */
  onNoteChange(event: NoteChangeEvent): void {
    if (!this.loaded.length || event.path.startsWith(SYSTEM_PREFIX)) return;
    const pluginEvent = {
      noteId: event.noteId,
      ownerId: event.ownerId,
      actorId: event.actorId,
      path: event.path,
      previousPath: event.previousPath,
      content: event.content,
      deleted: event.deleted,
      type: event.deleted ? undefined : typeOf(event.content),
    };
    for (const l of this.loaded) {
      if (!l.installed.plugin.onNoteChange) continue;
      try {
        l.installed.plugin.onNoteChange(pluginEvent, l.ctx);
      } catch (err) {
        l.ctx.log.error('onNoteChange failed', err);
      }
    }
  }

  /**
   * Subscribes every plugin with `events` to the bus (one subscriber per plugin, so a slow or failing plugin never
   * holds up another). A plugin gets an event only for the owner's accounts that switched it on, each plugin its
   * own copy, `raw` only for the types it lists in `rawPayload`.
   */
  subscribe(bus: EventBus): void {
    for (const l of this.loaded) {
      const { plugin } = l.installed;
      const handlers = plugin.events;
      const types = Object.keys(handlers ?? {}).filter(isGitEventType);
      if (!handlers || !types.length) continue;
      const raw = new Set<GitEventType>(plugin.rawPayload ?? []);
      bus.subscribe({
        name: `plugin:${plugin.id}`,
        types,
        handle: async ({ event, owner, rawPayload }) => {
          const candidates = owner.kind === 'user' ? [owner.id] : (this.opts.groupMembers?.(owner.id) ?? []);
          const people = candidates.filter((id) => {
            const u = this.opts.users.getUser(id);
            return !!u && !u.bannedAt && this.enabledFor(id, plugin.id);
          });
          if (!people.length) return 'für niemanden eingeschaltet';
          const copy = structuredClone({ ...event, owner, users: people, ...(raw.has(event.type) && rawPayload !== undefined ? { raw: rawPayload } : {}) }) as GitEvent;
          const handler = handlers[event.type] as ((e: GitEvent, ctx: PluginServerContext) => void | Promise<void>) | undefined;
          try {
            await handler?.(copy, l.ctx);
          } catch (err) {
            l.ctx.log.error(`event ${event.type} failed`, err);
            throw err;
          }
        },
      });
    }
  }

  /** Runs the jobs that are due (called every minute); a job never runs twice at the same time */
  async tick(now = Date.now()): Promise<void> {
    const runs: Promise<void>[] = [];
    for (const l of this.loaded) {
      for (const job of l.installed.plugin.jobs ?? []) {
        const next = l.due.get(job.name) ?? now;
        if (next > now || l.running.has(job.name)) continue;
        l.due.set(job.name, now + Math.max(1, job.everyMinutes) * 60_000);
        l.running.add(job.name);
        runs.push(
          Promise.resolve()
            .then(() => job.run(l.ctx))
            .catch((err) => l.ctx.log.error(`job ${job.name} failed`, err))
            .finally(() => l.running.delete(job.name))
        );
      }
    }
    await Promise.all(runs);
  }

  /**
   * MCP tools of the plugins the user switched on, named `<id>_<name>` (dashes as underscores). Errors other than
   * `PluginError` are logged and reach the assistant only as "internal error".
   */
  mcpTools(userId: string): PluginToolDef[] {
    const out: PluginToolDef[] = [];
    for (const l of this.loaded) {
      const tools = l.installed.plugin.mcpTools;
      if (!tools?.length || !this.enabledFor(userId, l.installed.plugin.id)) continue;
      const prefix = l.installed.plugin.id.replace(/-/g, '_');
      for (const tool of tools) out.push(this.toolDef(l, prefix, tool));
    }
    return out;
  }

  private toolDef(l: Loaded, prefix: string, tool: PluginMcpTool): PluginToolDef {
    return {
      name: `${prefix}_${tool.name}`,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
      write: !!tool.write,
      run: async (args, call) => {
        const user = l.ctx.user(call.userId);
        if (!user) throw new PluginError(401, 'Unknown account');
        try {
          return await tool.run(args, { user, agent: call.agent, canWrite: call.canWrite }, l.ctx);
        } catch (err) {
          if (err instanceof PluginError || (err as { name?: string })?.name === 'PluginError') throw err;
          l.ctx.log.error(`MCP tool ${tool.name} failed`, err);
          throw new Error('plugin tool failed', { cause: err });
        }
      },
    };
  }

  /** `ctx.notify`: only for existing people who switched the plugin on; a note only when they may open it */
  private notify(installed: InstalledServerPlugin, userId: string, n: PluginNotification): boolean {
    const store = this.opts.notifications;
    const id = installed.plugin.id;
    const user = this.opts.users.getUser(userId);
    if (!store || !user || user.bannedAt || !this.enabledFor(userId, id)) return false;
    const title = typeof n.title === 'string' ? n.title.slice(0, TITLE_MAX) : n.title && typeof n.title.de === 'string' ? { de: n.title.de.slice(0, TITLE_MAX), ...(n.title.en ? { en: String(n.title.en).slice(0, TITLE_MAX) } : {}) } : '';
    if (!localize(title, 'de').trim()) throw new Error(`Plugin ${id}: a notification needs a title`);
    let noteId = '';
    if (n.noteId) {
      const note = this.opts.notes.fetchNotes(userId, [n.noteId])[0];
      if (!note || note.deleted || note.path.startsWith(SYSTEM_PREFIX)) return false;
      noteId = note.id;
    }
    // Only paths inside the plugin: a notification cannot lead somewhere else in the app (or off it)
    const sub = typeof n.path === 'string' ? n.path.replace(/^\/+/, '') : '';
    if (sub && (!/^[\w\-./~%?=&]*$/.test(sub) || sub.split(/[/?]/).some((part) => part === '..'))) throw new Error(`Plugin ${id}: invalid notification path "${n.path}"`);
    const href = noteId && !sub ? `/n/${noteId}` : `/p/${id}${sub ? `/${sub}` : ''}`;
    const tag = typeof n.tag === 'string' && n.tag ? `${id}-${n.tag}`.replace(/[^\w-]/g, '').slice(0, 40) : id;
    store.add({ userId, kind: 'plugin', noteId, actorId: null, path: installed.name, text: (n.text ?? '').slice(0, TEXT_MAX), plugin: id, title, href, tag });
    return true;
  }

  /** The plugins' files for a user's account export */
  async exportFiles(userId: string): Promise<{ path: string; content: string | Uint8Array }[]> {
    const out: { path: string; content: string | Uint8Array }[] = [];
    for (const l of this.loaded) {
      if (!l.installed.plugin.exportAccount) continue;
      try {
        for (const f of await l.installed.plugin.exportAccount(userId, l.ctx)) {
          const name = f.name.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
          if (name) out.push({ path: `${l.installed.plugin.id}/${name}`, content: f.content });
        }
      } catch (err) {
        l.ctx.log.error('exportAccount failed', err);
      }
    }
    return out;
  }

  private contextFor(installed: InstalledServerPlugin): PluginServerContext {
    const { db, cipher, users, env } = this.opts;
    const id = installed.plugin.id;
    const prefix = pluginTablePrefix(id);
    const envPrefix = `PLUGIN_${id.toUpperCase().replace(/-/g, '_')}_`;
    const aad = (recordId: string) => `plugin:${id}:${recordId}`;
    const tag = `🧩 [${id}]`;
    return {
      id,
      hostVersion: APP_VERSION,
      apiVersion: PLUGIN_API_VERSION,
      db,
      table: (name) => {
        if (!/^[a-z0-9_]{1,48}$/.test(name)) throw new Error(`Invalid table name "${name}"`);
        return `${prefix}${name}`;
      },
      transaction: (fn) => transaction(db, fn),
      cipher: {
        seal: (recordId, value) => cipher.encrypt(value, aad(recordId)),
        open: (recordId, sealed) => cipher.decrypt(sealed, aad(recordId)).toString('utf8'),
        sealJson: (recordId, value) => cipher.encryptJson(value, aad(recordId)),
        openJson: <T>(recordId: string, sealed: Uint8Array) => cipher.decryptJson<T>(sealed, aad(recordId)),
      },
      notes: this.notesApi(),
      user: (userId) => {
        const u = users.getUser(userId);
        return u ? userOf(u) : null;
      },
      userOf: (req) => {
        if (!req.user) throw new PluginError(401, 'Nicht angemeldet');
        return userOf(req.user);
      },
      enabledFor: (userId) => this.enabledFor(userId, id),
      notify: (userId, n) => this.notify(installed, userId, n),
      env: (name) => env[`${envPrefix}${name}`],
      log: {
        info: (message) => console.log(`${tag} ${message}`),
        warn: (message) => console.warn(`${tag} ${message}`),
        error: (message, err) => console.error(`${tag} ${message}`, err ?? ''),
      },
    };
  }

  /** Notes through NoteStore: the same rights checks, encryption and sync as changes from the app */
  private notesApi(): PluginNotes {
    const { notes } = this.opts;
    const toPlugin = (n: SyncedNote): PluginNote => ({
      id: n.id,
      path: n.path,
      content: n.content,
      version: n.version,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      access: n.access === 'owner' && !n.group ? 'owner' : n.access === 'read' ? 'read' : 'write',
      ...(n.group ? { group: { id: n.group, name: n.owner ?? '' } } : {}),
      ...(typeOf(n.content) ? { type: typeOf(n.content) } : {}),
    });
    const visible = (n: SyncedNote) => !n.deleted && !n.path.startsWith(SYSTEM_PREFIX);
    const get = (userId: string, id: string): PluginNote | null => {
      const n = notes.fetchNotes(userId, [id])[0];
      return n && visible(n) ? toPlugin(n) : null;
    };
    const spaceOf = (userId: string, group?: string) => (group ? notes.groupNotes(userId).filter((n) => n.group === group) : notes.ownedNotes(userId)).filter(visible);
    const fail = (status: 'conflict' | 'forbidden') => new PluginError(status === 'conflict' ? 409 : 403, status === 'conflict' ? 'Die Notiz wurde inzwischen geändert.' : 'Keine Berechtigung für diese Notiz.');
    return {
      list: (userId, filter: PluginNoteFilter = {}) => {
        const folder = filter.folder?.replace(/^\/+|\/+$/g, '');
        const all = [...notes.ownedNotes(userId), ...(filter.groups ? notes.groupNotes(userId) : [])];
        return all
          .filter((n) => visible(n) && (!folder || n.path.startsWith(`${folder}/`)))
          .map(toPlugin)
          .filter((n) => !filter.type || n.type === filter.type);
      },
      get,
      create: (userId, note) => {
        if (spaceOf(userId, note.group).some((n) => n.path.toLowerCase() === note.path.toLowerCase())) throw new PluginError(409, `„${note.path}“ gibt es schon.`);
        const now = Date.now();
        const id = crypto.randomBytes(16).toString('hex');
        const [result] = notes.push(userId, [{ id, baseVersion: 0, path: note.path, content: note.content, deleted: false, createdAt: now, updatedAt: now, ...(note.group ? { group: note.group } : {}) }]);
        if (result.status !== 'ok') throw fail(result.status);
        return get(userId, id)!;
      },
      update: (userId, id, change) => {
        const current = get(userId, id);
        if (!current) throw new PluginError(404, 'Notiz nicht gefunden.');
        const [result] = notes.push(userId, [
          { id, baseVersion: change.baseVersion, path: change.path ?? current.path, content: change.content ?? current.content, deleted: false, createdAt: current.createdAt, updatedAt: Date.now() },
        ]);
        if (result.status !== 'ok') throw fail(result.status);
        return get(userId, id)!;
      },
      remove: (userId, id) => {
        const current = get(userId, id);
        if (!current) return;
        const [result] = notes.push(userId, [{ id, baseVersion: current.version, path: current.path, content: current.content, deleted: true, createdAt: current.createdAt, updatedAt: Date.now() }]);
        if (result.status !== 'ok') throw fail(result.status);
      },
    };
  }
}
