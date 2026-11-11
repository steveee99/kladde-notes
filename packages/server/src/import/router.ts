import express, { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { MAX_FILE_BYTES, MAX_NOTE_BYTES, PushChange, SYSTEM_PREFIX, cleanPath } from '@kladde/shared';
import { FileStore } from '../FileStore.js';
import { NoteStore } from '../NoteStore.js';
import { UserStore } from '../UserStore.js';
import { AuditLog } from '../security/AuditLog.js';
import { handle, rateLimit, requireUser } from '../http.js';
import { ImportTokenStore } from './ImportTokenStore.js';

/** Notes per POST /api/import/notes */
export const MAX_IMPORT_BATCH = 100;

export interface ImportOptions {
  users: UserStore;
  notes: NoteStore;
  files: FileStore;
  tokens: ImportTokenStore;
  audit: AuditLog;
}

export interface ImportNoteResult {
  path: string;
  status: 'created' | 'skipped' | 'invalid';
  error?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    importUserId?: string;
  }
}

/**
 * The import CLI's API: bearer import tokens only (no cookies), and only three things: list the paths of
 * the token owner's own notes, upload attachments, create new notes. Nothing is ever overwritten.
 */
export function importRouters(opts: ImportOptions): { bearerRouter: express.Router; accountRouter: express.Router } {
  const { users, notes, files, tokens, audit } = opts;

  // ---------------------------------------------------------------- bearer: the CLI

  const bearerRouter = express.Router();

  const requireImportToken = (req: Request, res: Response, next: NextFunction) => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const userId = tokens.userIdFor(token);
    const user = userId ? users.getUser(userId) : null;
    if (!user || user.bannedAt) {
      res.status(401).json({ error: 'Import-Token ungültig oder widerrufen' });
      return;
    }
    req.importUserId = user.id;
    next();
  };

  bearerRouter.use(rateLimit(300, 60_000), requireImportToken);

  bearerRouter.get('/notes', (req, res) => {
    const paths = notes
      .ownedNotes(req.importUserId!)
      .map((n) => n.path)
      .filter((p) => !p.startsWith(SYSTEM_PREFIX));
    res.json({ paths });
  });

  bearerRouter.post(
    '/files',
    express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
    handle((req, res) => {
      const mime = String(req.headers['content-type'] ?? '').split(';')[0];
      try {
        const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'datei'));
        const saved = files.save(req.importUserId!, name, mime, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
        res.json({ id: saved.id, url: `/api/files/${saved.id}`, name });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    })
  );

  bearerRouter.post(
    '/notes',
    express.json({ limit: '26mb' }),
    handle((req, res) => {
      const items = req.body?.notes;
      if (!Array.isArray(items) || items.length > MAX_IMPORT_BATCH) {
        res.status(400).json({ error: `Erwartet { notes: [...] } mit höchstens ${MAX_IMPORT_BATCH} Einträgen.` });
        return;
      }
      const ownerId = req.importUserId!;
      // Checked now, against the current database: a note created since the preview is skipped too
      const taken = new Set(notes.ownedNotes(ownerId).map((n) => n.path.toLowerCase()));
      const results: ImportNoteResult[] = [];
      const changes: { index: number; change: PushChange }[] = [];
      const now = Date.now();
      for (const item of items as unknown[]) {
        const raw = (item as { path?: unknown })?.path;
        const content = (item as { content?: unknown })?.content;
        let path: string;
        try {
          path = cleanPath(raw);
        } catch {
          results.push({ path: String(raw ?? ''), status: 'invalid', error: 'Ungültiger Pfad' });
          continue;
        }
        if (!path.toLowerCase().endsWith('.md') || path.toLowerCase().startsWith(SYSTEM_PREFIX)) {
          results.push({ path, status: 'invalid', error: 'Pfad muss auf .md enden und darf nicht unter .kladde/ liegen' });
          continue;
        }
        if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_NOTE_BYTES) {
          results.push({ path, status: 'invalid', error: typeof content === 'string' ? 'Notiz größer als 2 MB' : 'Inhalt fehlt' });
          continue;
        }
        if (taken.has(path.toLowerCase())) {
          results.push({ path, status: 'skipped' });
          continue;
        }
        taken.add(path.toLowerCase());
        const at = Math.min(Number((item as { updatedAt?: unknown }).updatedAt) || now, now);
        changes.push({
          index: results.length,
          change: { id: crypto.randomBytes(16).toString('hex'), baseVersion: 0, path, content, deleted: false, createdAt: at, updatedAt: at },
        });
        results.push({ path, status: 'created' });
      }
      if (changes.length) {
        const pushed = notes.push(ownerId, changes.map((c) => c.change));
        pushed.forEach((r, i) => {
          if (r.status !== 'ok') results[changes[i].index] = { path: changes[i].change.path, status: 'invalid', error: `Speichern abgelehnt (${r.status})` };
        });
      }
      res.json({ results });
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
      audit.record('import_token_created', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: created.token.name });
      res.json(created);
    })
  );

  accountRouter.delete('/:id', (req, res) => {
    const revoked = tokens.revoke(req.user!.id, req.params.id);
    if (revoked) audit.record('import_token_revoked', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: revoked.name });
    res.json(tokens.list(req.user!.id));
  });

  return { bearerRouter, accountRouter };
}
