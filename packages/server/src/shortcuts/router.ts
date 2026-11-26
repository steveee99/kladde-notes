import express, { NextFunction, Request, Response } from 'express';
import {
  INBOX_FOLDER,
  MAX_FILE_BYTES,
  SHORTCUT_TOKEN_DAYS,
  SYSTEM_PREFIX,
  bucketOf,
  extractDailyNoteDate,
  extractMeta,
  normalizeDueWords,
  resolveDue,
  parseTasks,
  resolveDailyNote,
  shiftDateString,
  splitPath,
  toDateString,
  type SyncedNote,
} from '@kladde/shared';
import { DatabaseSync } from 'node:sqlite';
import { FileStore } from '../FileStore.js';
import { MAX_NOTE_BYTES, NoteStore } from '../NoteStore.js';
import { UserStore } from '../UserStore.js';
import { AuditLog } from '../security/AuditLog.js';
import { BearerTokenStore } from '../security/BearerTokenStore.js';
import { handle, rateLimit, requireUser } from '../http.js';
import { TOOLS, ToolError, featuresOf, taskDueOf, type ToolContext } from '../mcp/tools.js';

/** Tokens for Apple Shortcuts (`kls_…`): they only work on `/api/shortcuts` */
export class ShortcutTokenStore extends BearerTokenStore {
  constructor(db: DatabaseSync) {
    super(db, { table: 'shortcut_tokens', prefix: 'kls_', days: SHORTCUT_TOKEN_DAYS, defaultName: 'Kurzbefehle', label: 'Kurzbefehl-Token' });
  }
}

export interface ShortcutsOptions {
  users: UserStore;
  notes: NoteStore;
  files: FileStore;
  tokens: ShortcutTokenStore;
  audit: AuditLog;
  publicUrl: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    shortcutUserId?: string;
  }
}

/** A refused request: answered as `{ error }` with this status */
class ShortcutError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

const text = (body: Record<string, unknown>, key: string, max = 100_000): string => {
  const v = body[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') throw new ShortcutError(`"${key}" muss Text sein.`);
  const s = String(v);
  if (s.length > max) throw new ShortcutError(`"${key}" ist zu lang.`);
  return s;
};

/** Shortcuts send lists as arrays or as one comma/space separated text */
const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[\s,]+/) : [])
    .map((s) => s.trim().replace(/^#/, ''))
    .filter((s) => /^[\p{L}\p{N}_/-]+$/u.test(s))
    .slice(0, 20);

/** Title from the first line, like Quick Capture; characters that break paths or links become spaces */
const titleOf = (s: string, fallback: string) =>
  s.split('\n')[0].replace(/[\\/:#[\]|*?"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;

/** Markdown link text without the characters that would end it */
const linkText = (s: string) => s.replace(/[[\]\\]/g, '').trim();

/**
 * Apple Shortcuts (#46): a small JSON API for the iOS share sheet, Siri, the Action Button and personal
 * automations, which do what the PWA cannot on iOS (share target, reliable reminders). Bearer shortcut
 * tokens only (no cookies); everything goes through the normal sync path, so open devices update live.
 */
export function shortcutsRouters(opts: ShortcutsOptions): { bearerRouter: express.Router; accountRouter: express.Router } {
  const { users, notes, files, tokens, audit } = opts;

  const bearerRouter = express.Router();

  const requireShortcutToken = (req: Request, res: Response, next: NextFunction) => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const userId = tokens.userIdFor(token);
    const user = userId ? users.getUser(userId) : null;
    if (!user || user.bannedAt) {
      res.status(401).json({ error: 'Kurzbefehl-Token ungültig oder widerrufen' });
      return;
    }
    req.shortcutUserId = user.id;
    next();
  };

  bearerRouter.use(rateLimit(120, 60_000), requireShortcutToken);

  const baseUrl = (req: Request) => (opts.publicUrl ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const noteUrl = (req: Request, id: string) => `${baseUrl(req)}/n/${encodeURIComponent(id)}`;
  const ctxOf = (req: Request): ToolContext => ({ userId: req.shortcutUserId!, canWrite: true, notes });
  const own = (req: Request) => notes.ownedNotes(req.shortcutUserId!);

  /** A note of the user (without the hidden settings notes) by id, path or title, through the MCP tool logic */
  const run = (req: Request, tool: string, args: Record<string, unknown>) => {
    const def = TOOLS.find((t) => t.name === tool)!;
    return def.run(args, ctxOf(req)) as { id: string; path: string; version: number };
  };

  const createNote = (req: Request, folder: string, title: string, content: string): SyncedNote => {
    if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new ShortcutError('Die Notiz wäre größer als 2 MB.', 413);
    const r = run(req, 'create_note', { title, folder, content });
    return own(req).find((n) => n.id === r.id)!;
  };

  /** Folder from the request: inbox by default, never the settings folder */
  const folderOf = (body: Record<string, unknown>) => {
    const raw = text(body, 'folder', 300).trim();
    return raw || INBOX_FOLDER;
  };

  /** Today's daily note, created like the app does when it is missing */
  const dailyNote = (req: Request, lang: 'de' | 'en'): SyncedNote => {
    const { daily } = featuresOf(notes, req.shortcutUserId!);
    if (!daily.enabled) throw new ShortcutError('Tagesnotizen sind in den Einstellungen ausgeschaltet.');
    const today = toDateString(new Date());
    const existing = own(req).find((n) => !n.path.startsWith(SYSTEM_PREFIX) && extractDailyNoteDate(n.path, daily) === today);
    if (existing) return existing;
    const resolved = resolveDailyNote(daily, new Date(), lang);
    const heading = /^\d{1,2}$/.test(resolved.name) ? today : resolved.name;
    return createNote(req, resolved.folder, resolved.name, `# ${heading}\n\n`);
  };

  const respond = (req: Request, res: Response, note: { id: string; path: string }, extra: Record<string, unknown> = {}) =>
    res.json({ ok: true, id: note.id, path: note.path, title: splitPath(note.path).name, url: noteUrl(req, note.id), ...extra });

  /** Runs a handler; refusals become `{ error }` with a status a shortcut can show */
  const route = (fn: (req: Request, res: Response) => void) =>
    handle((req, res) => {
      try {
        fn(req, res);
      } catch (err) {
        if (err instanceof ShortcutError) res.status(err.status).json({ error: err.message });
        else if (err instanceof ToolError) res.status(400).json({ error: err.message });
        else throw err;
      }
    });

  const json = express.json({ limit: '1mb' });
  const form = express.urlencoded({ extended: false, limit: '1mb' });

  // Text, a link or Markdown into the inbox (like Quick Capture)
  bearerRouter.post(
    '/capture',
    json,
    form,
    route((req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const content = text(body, 'text').trim();
      const url = text(body, 'url', 4000).trim();
      if (url && !/^https?:\/\//i.test(url)) throw new ShortcutError('"url" muss mit http:// oder https:// beginnen.');
      if (!content && !url) throw new ShortcutError('Gib "text" oder "url" an.');
      const title = text(body, 'title', 200).trim();
      const tags = list(body.tags);
      const parts = [url ? `[${linkText(title || url)}](${url})` : '', content, tags.length ? tags.map((t) => `#${t}`).join(' ') : ''].filter(Boolean);
      const note = createNote(req, folderOf(body), title || titleOf(content || url.replace(/^https?:\/\//i, ''), 'Notiz'), `${parts.join('\n\n')}\n`);
      respond(req, res, note);
    })
  );

  // A photo or file as the raw request body ("Request Body: File"), in a new inbox note that embeds it
  bearerRouter.post(
    '/attachment',
    express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
    route((req, res) => {
      const body: unknown = req.body;
      const data = Buffer.isBuffer(body) && !Array.isArray(body) ? body : Buffer.alloc(0);
      if (!data.length) throw new ShortcutError('Die Anfrage enthält keine Datei.');
      // Query values may be arrays (?name=a&name=b): only plain strings count
      const q = Object.fromEntries(Object.entries(req.query).filter((e): e is [string, string] => typeof e[1] === 'string'));
      let name = text(q, 'name', 200).trim() || String(req.headers['x-filename'] ?? '');
      try {
        name = decodeURIComponent(name);
      } catch {
        /* keep as is */
      }
      const mime = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
      name = name.replace(/[\\/]/g, ' ').trim() || `Datei.${mime.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin'}`;
      let saved: { id: string };
      try {
        saved = files.save(req.shortcutUserId!, name, mime, data);
      } catch (err) {
        throw new ShortcutError((err as Error).message);
      }
      const caption = text(q, 'text').trim();
      const title = text(q, 'title', 200).trim() || titleOf(name.replace(/\.[^.]+$/, ''), 'Anhang');
      const content = [`![${linkText(name)}](/api/files/${saved.id})`, caption].filter(Boolean).join('\n\n');
      const note = createNote(req, folderOf(q), title, `${content}\n`);
      respond(req, res, note, { file: `/api/files/${saved.id}` });
    })
  );

  // Text at the end of a note (by id, path or title) or of today's daily note
  bearerRouter.post(
    '/append',
    json,
    form,
    route((req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const add = text(body, 'text').trim();
      if (!add) throw new ShortcutError('Gib "text" an.');
      const lang = body.lang === 'en' ? 'en' : 'de';
      const ref = { id: text(body, 'id', 200) || undefined, path: text(body, 'path', 500) || undefined, title: text(body, 'title', 200) || undefined };
      const target = ref.id || ref.path || ref.title ? ref : { id: dailyNote(req, lang).id };
      const r = run(req, 'append_to_note', { ...target, text: add });
      respond(req, res, r);
    })
  );

  // A task in the free tasks (home page), in a note, or in today's daily note
  bearerRouter.post(
    '/task',
    json,
    form,
    route((req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const taskText = text(body, 'text', 2000).replace(/\s+/g, ' ').trim();
      if (!taskText) throw new ShortcutError('Gib "text" an.');
      const due = text(body, 'due', 40).trim().toLowerCase();
      // Shortcuts' date format "2026-11-30T09:00:00+01:00" also works: only the day counts
      const dueDay = /^\d{4}-\d{2}-\d{2}/.exec(due)?.[0] ?? (resolveDue(due) !== due ? due : '');
      if (due && !dueDay) throw new ShortcutError('"due" braucht YYYY-MM-DD, today, tomorrow, einen Wochentag oder z. B. in-3-tagen.');
      const repeat = text(body, 'repeat', 40).trim();
      if (repeat && !/^(?:\d+\s*)?[\p{L},]+$/u.test(repeat)) throw new ShortcutError('"repeat" ist ungültig (z. B. weekly, 2 weeks, monatlich).');
      const time = text(body, 'time', 10).trim();
      if (time && !/^([01]?\d|2[0-3])[:.][0-5]\d$/.test(time)) throw new ShortcutError('"time" braucht HH:MM.');
      const line = normalizeDueWords(
        `- [ ] ${taskText}${dueDay ? ` 📅 ${dueDay}` : ''}${time ? ` ⏰ ${time.replace('.', ':')}` : ''}${repeat ? ` 🔁 ${repeat}` : ''}`
      );
      const ref = { id: text(body, 'id', 200) || undefined, path: text(body, 'path', 500) || undefined, title: text(body, 'title', 200) || undefined };
      if (ref.id || ref.path || ref.title) return respond(req, res, run(req, 'append_to_note', { ...ref, text: line }), { task: line });
      if (body.daily === true || body.daily === 'true') return respond(req, res, run(req, 'append_to_note', { id: dailyNote(req, body.lang === 'en' ? 'en' : 'de').id, text: line }), { task: line });
      // Free tasks: the hidden note behind "New task" on the home page
      const userId = req.shortcutUserId!;
      const id = `sysfreetasks-${userId}`;
      const current = own(req).find((n) => n.id === id);
      const content = current ? `${current.content.replace(/\n*$/, '')}\n${line}\n` : `${line}\n`;
      if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new ShortcutError('Die Aufgabenliste wäre größer als 2 MB.', 413);
      const now = Date.now();
      const [result] = notes.push(userId, [
        { id, baseVersion: current?.version ?? 0, path: `${SYSTEM_PREFIX}tasks.md`, content, deleted: false, createdAt: current?.createdAt ?? now, updatedAt: now },
      ]);
      if (result.status !== 'ok') throw new ShortcutError('Die Aufgabe konnte nicht gespeichert werden – bitte noch einmal versuchen.', 409);
      res.json({ ok: true, id, path: null, title: null, url: `${baseUrl(req)}/tasks`, task: line });
    })
  );

  // Open tasks that are overdue, due today or within `days` (default 7), for lists and local notifications
  bearerRouter.get(
    '/tasks',
    route((req, res) => {
      // Query values may be arrays (?name=a&name=b): only plain strings count
      const q = Object.fromEntries(Object.entries(req.query).filter((e): e is [string, string] => typeof e[1] === 'string'));
      const days = Math.max(0, Math.min(Number(q.days ?? 7) || 0, 60));
      const lang = q.lang === 'en' ? 'en' : 'de';
      const now = new Date();
      const today = toDateString(now);
      const until = shiftDateString(today, days);
      const userId = req.shortcutUserId!;
      const features = featuresOf(notes, userId);
      const archive = features.para.enabled ? `${features.para.folders.archive}/`.toLowerCase() : null;
      const dueOf = taskDueOf(notes, userId);
      const freeId = `sysfreetasks-${userId}`;
      const tasks = own(req)
        .filter((n) => (n.id === freeId || !n.path.startsWith(SYSTEM_PREFIX)) && !(archive && n.path.toLowerCase().startsWith(archive)))
        .flatMap((n) => {
          const free = n.id === freeId;
          return parseTasks(n.content, now, free ? null : dueOf(n.path))
            .filter((t) => !t.done && t.due !== null && t.due <= until)
            .map((t) => ({
              text: t.text,
              due: t.due,
              time: t.time,
              repeat: t.repeat,
              status: t.status,
              bucket: bucketOf(t, now),
              note: free ? null : extractMeta(n.path, n.content).title,
              path: free ? null : n.path,
              url: free ? `${baseUrl(req)}/tasks` : `${noteUrl(req, n.id)}?line=${t.line + 1}`,
            }));
        })
        .sort((a, b) => a.due!.localeCompare(b.due!) || (a.time ?? '99').localeCompare(b.time ?? '99'));
      const count = (b: string) => tasks.filter((t) => t.bucket === b).length;
      const counts = { overdue: count('overdue'), today: count('today'), upcoming: count('upcoming') };
      const parts =
        lang === 'en'
          ? [counts.today && `${counts.today} due today`, counts.overdue && `${counts.overdue} overdue`]
          : [counts.today && `${counts.today} heute fällig`, counts.overdue && `${counts.overdue} überfällig`];
      const summary = parts.filter(Boolean).join(', ') || (lang === 'en' ? 'Nothing due today' : 'Heute ist nichts fällig');
      res.json({ today, counts, summary, lines: tasks.map((t) => `${t.bucket === 'overdue' ? '⚠️ ' : ''}${t.text}${t.time ? ` (${t.time})` : ''}`), tasks });
    })
  );

  // Body parser errors (too large, malformed) as JSON instead of the generic server error
  bearerRouter.use((err: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err.type === 'entity.too.large') res.status(413).json({ error: 'Anfrage zu groß' });
    else if (err.type === 'entity.parse.failed') res.status(400).json({ error: 'Ungültiges JSON' });
    else next(err);
  });

  // ---------------------------------------------------------------- signed in (Kladde session): settings

  const accountRouter = express.Router();
  accountRouter.use(requireUser(users), express.json({ limit: '16kb' }));

  accountRouter.get('/', (req, res) => res.json(tokens.list(req.user!.id)));

  accountRouter.post(
    '/',
    handle((req, res) => {
      const created = tokens.create(req.user!.id, req.body?.name, req.body?.days ?? undefined);
      audit.record('shortcut_token_created', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: created.token.name });
      res.json(created);
    })
  );

  accountRouter.delete('/:id', (req, res) => {
    const revoked = tokens.revoke(req.user!.id, req.params.id);
    if (revoked) audit.record('shortcut_token_revoked', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: revoked.name });
    res.json(tokens.list(req.user!.id));
  });

  return { bearerRouter, accountRouter };
}

