import crypto from 'node:crypto';
import { defineServerPlugin, handle, PluginError, type PluginServerContext } from '@kladde/plugin-api/server';

/** One logbook entry; stored encrypted, only id, owner and time stay readable for sorting */
export interface Entry {
  id: string;
  text: string;
  mood: 'good' | 'okay' | 'bad' | null;
  at: number;
}

interface Row {
  id: string;
  at: number;
  payload: Uint8Array;
}

const MOODS = ['good', 'okay', 'bad'] as const;

function entriesOf(ctx: PluginServerContext, userId: string, limit = 200): Entry[] {
  const rows = ctx.db.prepare(`SELECT id, at, payload FROM ${ctx.table('entries')} WHERE owner_id = ? ORDER BY at DESC LIMIT ?`).all(userId, limit) as unknown as Row[];
  return rows.map((r) => ({ id: r.id, at: r.at, ...ctx.cipher.openJson<{ text: string; mood: Entry['mood'] }>(r.id, r.payload) }));
}

const cleanText = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 2000) throw new PluginError(400, 'Der Eintrag braucht 1 bis 2000 Zeichen.');
  return text;
};

const cleanMood = (value: unknown): Entry['mood'] => (MOODS.includes(value as (typeof MOODS)[number]) ? (value as Entry['mood']) : null);

function addEntry(ctx: PluginServerContext, userId: string, text: string, mood: Entry['mood']): Entry {
  const entry: Entry = { id: crypto.randomUUID(), text, mood, at: Date.now() };
  ctx.db.prepare(`INSERT INTO ${ctx.table('entries')} (id, owner_id, at, payload) VALUES (?, ?, ?, ?)`).run(entry.id, userId, entry.at, ctx.cipher.sealJson(entry.id, { text, mood }));
  return entry;
}

/**
 * Server part of the example plugin: own tables (migrations), encrypted rows, routes under /api/p/logbook,
 * a note per entry on request, a counter fed by note changes, a cleanup job, the account export, two MCP tools
 * for AI assistants, a notification when an assistant wrote an entry and an entry for every merged merge request.
 */
export default defineServerPlugin({
  id: 'logbook',

  // Released steps never change; a new need gets a new step
  migrations: [
    {
      version: 1,
      description: 'Entries per account',
      sql: `
        CREATE TABLE p_logbook_entries (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          at INTEGER NOT NULL,
          payload BLOB NOT NULL
        );
        CREATE INDEX p_logbook_entries_owner ON p_logbook_entries(owner_id, at);
      `,
    },
    {
      version: 2,
      description: 'Notes changed per account while the logbook is on',
      sql: `
        CREATE TABLE p_logbook_stats (
          owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          notes_changed INTEGER NOT NULL DEFAULT 0
        );
      `,
    },
    {
      version: 3,
      description: 'Git events already written as entries',
      sql: `
        CREATE TABLE p_logbook_events (
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          PRIMARY KEY (owner_id, event_id)
        );
      `,
    },
  ],

  routes(router, ctx) {
    router.get('/entries', (req, res) => {
      res.json(entriesOf(ctx, ctx.userOf(req).id));
    });

    router.post('/entries', (req, res) => {
      const user = ctx.userOf(req);
      res.status(201).json(addEntry(ctx, user.id, cleanText(req.body?.text), cleanMood(req.body?.mood)));
    });

    // Edits from the table on the page and in note blocks: only the fields that came, each checked like a new entry
    router.patch('/entries/:id', (req, res) => {
      const userId = ctx.userOf(req).id;
      const row = ctx.db.prepare(`SELECT id, at, payload FROM ${ctx.table('entries')} WHERE id = ? AND owner_id = ?`).get(req.params.id, userId) as unknown as Row | undefined;
      if (!row) throw new PluginError(404, 'Eintrag nicht gefunden.');
      const current = ctx.cipher.openJson<{ text: string; mood: Entry['mood'] }>(row.id, row.payload);
      const body = (req.body ?? {}) as { text?: unknown; mood?: unknown };
      const text = 'text' in body ? cleanText(body.text) : current.text;
      let mood = current.mood;
      if ('mood' in body) {
        const value = typeof body.mood === 'string' ? body.mood.trim().toLowerCase() : body.mood;
        if (value !== null && value !== '' && !MOODS.includes(value as (typeof MOODS)[number])) throw new PluginError(400, 'Stimmung: good, okay, bad oder leer.');
        mood = cleanMood(value);
      }
      ctx.db.prepare(`UPDATE ${ctx.table('entries')} SET payload = ? WHERE id = ?`).run(ctx.cipher.sealJson(row.id, { text, mood }), row.id);
      res.json({ id: row.id, at: row.at, text, mood } satisfies Entry);
    });

    router.delete('/entries/:id', (req, res) => {
      const { changes } = ctx.db.prepare(`DELETE FROM ${ctx.table('entries')} WHERE id = ? AND owner_id = ?`).run(req.params.id, ctx.userOf(req).id);
      if (!changes) throw new PluginError(404, 'Eintrag nicht gefunden.');
      res.status(204).end();
    });

    // A note in the user's space: Kladde's sync, encryption and rights apply as for any note
    router.post(
      '/entries/:id/note',
      handle(async (req, res) => {
        const user = ctx.userOf(req);
        const entry = entriesOf(ctx, user.id, 10_000).find((e) => e.id === req.params.id);
        if (!entry) throw new PluginError(404, 'Eintrag nicht gefunden.');
        const day = new Date(entry.at).toISOString().slice(0, 10);
        const content = `---\ntype: plugin:logbook:entry\nmood: ${entry.mood ?? ''}\n---\n# Logbuch ${day}\n\n${entry.text}\n`;
        const existing = ctx.notes.list(user.id, { type: 'plugin:logbook:entry', folder: 'Logbuch' }).length;
        const note = ctx.notes.create(user.id, { path: `Logbuch/${day} ${existing + 1}.md`, content });
        res.status(201).json({ noteId: note.id });
      })
    );

    router.get('/stats', (req, res) => {
      const userId = ctx.userOf(req).id;
      const row = ctx.db.prepare(`SELECT notes_changed FROM ${ctx.table('stats')} WHERE owner_id = ?`).get(userId) as { notes_changed: number } | undefined;
      const count = ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${ctx.table('entries')} WHERE owner_id = ?`).get(userId) as { n: number };
      res.json({ entries: count.n, notesChanged: row?.notes_changed ?? 0, keepDays: keepDays(ctx) });
    });
  },

  // Runs after every accepted note change: keep it short, it is on the sync path
  onNoteChange(event, ctx) {
    const userId = event.actorId ?? event.ownerId;
    if (event.deleted || !ctx.user(userId) || !ctx.enabledFor(userId)) return;
    ctx.db
      .prepare(`INSERT INTO ${ctx.table('stats')} (owner_id, notes_changed) VALUES (?, 1) ON CONFLICT(owner_id) DO UPDATE SET notes_changed = notes_changed + 1`)
      .run(userId);
  },

  jobs: [
    {
      name: 'prune',
      everyMinutes: 60,
      run(ctx) {
        const cutoff = Date.now() - keepDays(ctx) * 86_400_000;
        const { changes } = ctx.db.prepare(`DELETE FROM ${ctx.table('entries')} WHERE at < ?`).run(cutoff);
        ctx.db.prepare(`DELETE FROM ${ctx.table('events')} WHERE at < ?`).run(Date.now() - 30 * 86_400_000);
        if (changes) ctx.log.info(`${changes} old entries removed`);
      },
    },
  ],

  // Assistants see these as logbook_list_entries and logbook_add_entry (only while the user has the logbook on)
  mcpTools: [
    {
      name: 'list_entries',
      title: 'List logbook entries',
      description: "Lists the user's logbook entries (short notes with a mood), newest first.",
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many (default 20)' } } },
      run(args, call, ctx) {
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 20;
        return { entries: entriesOf(ctx, call.user.id, limit).map((e) => ({ ...e, at: new Date(e.at).toISOString() })) };
      },
    },
    {
      name: 'add_entry',
      title: 'Add a logbook entry',
      description: "Adds a short entry to the user's logbook. The user gets a notification about it.",
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The entry, at most 2000 characters' }, mood: { type: 'string', enum: [...MOODS] } },
        required: ['text'],
      },
      write: true,
      run(args, call, ctx) {
        const entry = addEntry(ctx, call.user.id, cleanText(args.text), cleanMood(args.mood));
        // The user did not write it: tell them (bell, Web Push where they turned it on)
        ctx.notify(call.user.id, { title: { de: `${call.agent} hat ins Logbuch geschrieben`, en: `${call.agent} wrote in the logbook` }, text: entry.text, tag: 'assistant' });
        return { id: entry.id, at: new Date(entry.at).toISOString() };
      },
    },
  ],

  // Git events of Kladde's central webhooks (docs/EVENTS.md): a merged merge request becomes an entry for everyone
  // the event is for (the webhook's owner, or the group's members, who switched the logbook on)
  events: {
    'git.merge_request'(event, ctx) {
      if (event.action !== 'merged') return;
      const mr = event.mergeRequest;
      const text = `Gemergt in ${event.project.path}: !${mr.number} ${mr.title}`.slice(0, 2000);
      for (const userId of event.users) {
        // Idempotent by the delivery id: a repeated delivery adds no second entry
        const seen = ctx.db.prepare(`SELECT 1 FROM ${ctx.table('events')} WHERE owner_id = ? AND event_id = ?`).get(userId, event.id);
        if (seen) continue;
        ctx.transaction(() => {
          ctx.db.prepare(`INSERT INTO ${ctx.table('events')} (owner_id, event_id, at) VALUES (?, ?, ?)`).run(userId, event.id, Date.now());
          addEntry(ctx, userId, text, 'good');
        });
      }
    },
  },

  exportAccount(userId, ctx) {
    return [{ name: 'entries.json', content: `${JSON.stringify(entriesOf(ctx, userId, 100_000), null, 2)}\n` }];
  },
});

/** PLUGIN_LOGBOOK_KEEP_DAYS, default one year */
function keepDays(ctx: PluginServerContext): number {
  const days = Number(ctx.env('KEEP_DAYS') ?? 365);
  return Number.isFinite(days) && days > 0 ? days : 365;
}
