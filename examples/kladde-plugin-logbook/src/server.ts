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

/**
 * Server part of the example plugin: own tables (migrations), encrypted rows, routes under /api/p/logbook,
 * a note per entry on request, a counter fed by note changes, a cleanup job and the account export.
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
  ],

  routes(router, ctx) {
    router.get('/entries', (req, res) => {
      res.json(entriesOf(ctx, ctx.userOf(req).id));
    });

    router.post('/entries', (req, res) => {
      const user = ctx.userOf(req);
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (!text || text.length > 2000) throw new PluginError(400, 'Der Eintrag braucht 1 bis 2000 Zeichen.');
      const mood = MOODS.includes(req.body?.mood) ? (req.body.mood as Entry['mood']) : null;
      const entry: Entry = { id: crypto.randomUUID(), text, mood, at: Date.now() };
      ctx.db
        .prepare(`INSERT INTO ${ctx.table('entries')} (id, owner_id, at, payload) VALUES (?, ?, ?, ?)`)
        .run(entry.id, user.id, entry.at, ctx.cipher.sealJson(entry.id, { text, mood }));
      res.status(201).json(entry);
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
        if (changes) ctx.log.info(`${changes} old entries removed`);
      },
    },
  ],

  exportAccount(userId, ctx) {
    return [{ name: 'entries.json', content: `${JSON.stringify(entriesOf(ctx, userId, 100_000), null, 2)}\n` }];
  },
});

/** PLUGIN_LOGBOOK_KEEP_DAYS, default one year */
function keepDays(ctx: PluginServerContext): number {
  const days = Number(ctx.env('KEEP_DAYS') ?? 365);
  return Number.isFinite(days) && days > 0 ? days : 365;
}
