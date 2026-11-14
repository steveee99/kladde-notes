import express, { Response } from 'express';
import type { AttachmentInfo, CursorAnnounce, DeleteFilesResponse, Me, PresenceAnnounce, PushChange, TrashConflict, TrashList } from '@kladde/shared';
import { Presence } from './Presence.js';
import { attachmentUsageMap } from './cliActions.js';
import { AvatarStore, MAX_AVATAR_BYTES } from './AvatarStore.js';
import { NoteStore, TrashPathTaken } from './NoteStore.js';
import { DEFAULT_TRASH_DAYS, dropUnusedAttachments } from './trash.js';
import { FileStore, MAX_FILE_BYTES } from './FileStore.js';
import { UserRecord, UserStore } from './UserStore.js';
import { handle, rateLimit, requireUser } from './http.js';
import { ImportError, importRecipe } from './RecipeImport.js';

/** Open event streams per user: a ping makes every device pull right away */
export class LiveUpdates {
  private readonly clients = new Map<string, Set<Response>>();
  private readonly onConnectionChange: (() => void)[] = [];

  onChange(fn: () => void): void {
    this.onConnectionChange.push(fn);
  }

  add(userId: string, res: Response): void {
    let set = this.clients.get(userId);
    if (!set) this.clients.set(userId, (set = new Set()));
    set.add(res);
    this.onConnectionChange.forEach((fn) => fn());
    res.on('close', () => {
      set!.delete(res);
      this.onConnectionChange.forEach((fn) => fn());
    });
  }

  notify(userIds: Iterable<string>): void {
    this.send(userIds, 'changed', {});
  }

  /** Any live event to all open streams of these users */
  send(userIds: Iterable<string>, event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const id of new Set(userIds)) for (const res of this.clients.get(id) ?? []) res.write(frame);
  }

  get connections(): number {
    let n = 0;
    for (const s of this.clients.values()) n += s.size;
    return n;
  }
}

export interface ApiRouterOptions {
  standaloneUser?: UserRecord;
  avatars?: AvatarStore;
  meFor?: (user: UserRecord) => Me;
  /** Days a deleted note stays in the trash (0: until purged by hand) */
  trashDays?: number;
}

export function apiRouter(users: UserStore, notes: NoteStore, files: FileStore, live: LiveUpdates, opts: ApiRouterOptions = {}): express.Router {
  const router = express.Router();
  const standalone = !!opts.standaloneUser;
  const authed = requireUser(users, opts.standaloneUser);

  // ---------------------------------------------------------------- public (guests)

  if (!standalone) {
    router.get('/public/:token', (req, res) => {
      const note = notes.publicNote(req.params.token);
      if (!note) res.status(404).json({ error: 'Dieser Link ist ungültig oder wurde zurückgezogen.' });
      else res.json(note);
    });
  }

  // Files are addressed by a random id (also used from public notes), so no session is needed to read them
  router.get('/files/:id', (req, res) => {
    const file = files.load(req.params.id);
    if (!file) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    // SVGs may carry scripts: never run them in our origin
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.send(file.data);
  });

  if (opts.avatars) {
    const avatars = opts.avatars;
    // Profile pictures use random unguessable ids (also embedded on public links and shares)
    router.get('/avatars/:id', (req, res) => {
      const avatar = avatars.load(req.params.id);
      if (!avatar) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', avatar.mime);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.send(avatar.data);
    });
  }

  // ---------------------------------------------------------------- signed in

  router.use(authed);

  const presence = new Presence(notes, (id) => users.getUser(id), live);

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('event: hello\ndata: {}\n\n');
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    const clientId = typeof req.query.client === 'string' ? req.query.client : '';
    res.on('close', () => {
      clearInterval(keepAlive);
      // The device/tab is gone: it no longer has a note open
      if (clientId) presence.leave(req.user!.id, clientId);
    });
    live.add(req.user!.id, res);
  });

  // Which note a device/tab has open (heartbeat); everybody who may see the note learns who is there
  router.post('/presence', (req, res) => {
    const body = (req.body ?? {}) as Partial<PresenceAnnounce>;
    const clientId = typeof body.clientId === 'string' ? body.clientId : '';
    const noteId = typeof body.noteId === 'string' ? body.noteId : null;
    if (!Presence.validClient(clientId)) {
      res.status(400).json({ error: 'Ungültige Geräte-Kennung.' });
      return;
    }
    res.json(presence.announce(req.user!.id, clientId, noteId));
  });

  // Where a device/tab's cursor is; everybody on the note sees it
  router.post('/presence/cursor', (req, res) => {
    const body = (req.body ?? {}) as Partial<CursorAnnounce>;
    const clientId = typeof body.clientId === 'string' ? body.clientId : '';
    const pos = Presence.validCursor(body);
    if (!Presence.validClient(clientId) || typeof body.noteId !== 'string' || !pos) {
      res.status(400).json({ error: 'Ungültige Cursor-Position.' });
      return;
    }
    res.json({ ok: presence.cursor(req.user!.id, clientId, body.noteId, pos) });
  });

  router.get('/sync', (req, res) => {
    res.json(notes.pull(req.user!.id, Math.max(0, Number(req.query.since) || 0)));
  });

  router.post(
    '/sync',
    express.json({ limit: '20mb' }),
    handle((req, res) => {
      const changes = Array.isArray(req.body?.changes) ? (req.body.changes as PushChange[]).slice(0, 500) : [];
      res.json({ results: notes.push(req.user!.id, changes) });
    })
  );

  const notFound = (res: Response) => res.status(404).json({ error: 'Notiz nicht gefunden (oder nicht deine).' });

  // ---------------------------------------------------------------- trash (only the owner's own deleted notes)

  router.get('/trash', (req, res) => {
    const list: TrashList = { entries: notes.trash(req.user!.id), retentionDays: opts.trashDays ?? DEFAULT_TRASH_DAYS };
    res.json(list);
  });

  const restore = (res: Response, run: () => { id: string; path: string }[]) => {
    try {
      res.json({ restored: run() });
    } catch (err) {
      if (err instanceof TrashPathTaken) {
        const body: TrashConflict = { error: 'Unter diesem Pfad liegt inzwischen eine andere Notiz.', conflict: true, suggestion: err.suggestion };
        res.status(409).json(body);
      } else if ((err as Error).message === 'invalid path') res.status(400).json({ error: 'Ungültiger Pfad.' });
      else res.status(404).json({ error: 'Nicht im Papierkorb.' });
    }
  };

  router.post('/trash/batch/:batch/restore', (req, res) => {
    const ids = notes.trashBatch(req.user!.id, req.params.batch);
    if (!ids.length) return void res.status(404).json({ error: 'Nicht im Papierkorb.' });
    restore(res, () => notes.restore(req.user!.id, ids, { rename: true }));
  });

  router.post('/trash/:id/restore', express.json({ limit: '16kb' }), (req, res) => {
    restore(res, () => notes.restore(req.user!.id, [req.params.id], { path: req.body?.path ?? undefined }));
  });

  const purge = (userId: string, ids: string[] | null) => {
    const contents = notes.purge(userId, ids);
    dropUnusedAttachments(notes, files, userId, contents);
    return contents.length;
  };

  router.delete('/trash/:id', (req, res) => {
    const n = purge(req.user!.id, [req.params.id]);
    if (!n) return void res.status(404).json({ error: 'Nicht im Papierkorb.' });
    res.json({ purged: n });
  });

  router.delete('/trash', (req, res) => {
    res.json({ purged: purge(req.user!.id, null) });
  });

  router.get('/notes/:id/versions', (req, res) => {
    try {
      res.json(notes.versions(req.user!.id, req.params.id));
    } catch {
      notFound(res);
    }
  });

  router.get('/notes/:id/versions/:version', (req, res) => {
    try {
      res.json(notes.version(req.user!.id, req.params.id, req.params.version));
    } catch {
      notFound(res);
    }
  });

  if (!standalone) {
    router.get('/notes/:id/shares', (req, res) => {
      try {
        res.json(notes.shares(req.user!.id, req.params.id));
      } catch {
        notFound(res);
      }
    });

    router.put('/notes/:id/shares', (req, res) => {
      const target = typeof req.body?.username === 'string' ? users.findByUsername(req.body.username) : null;
      if (!target || target.id === req.user!.id) {
        res.status(400).json({ error: 'Diesen Benutzer gibt es nicht.' });
        return;
      }
      try {
        live.notify(notes.share(req.user!.id, req.params.id, target.id, !!req.body.canWrite));
        res.json(notes.shares(req.user!.id, req.params.id));
      } catch {
        notFound(res);
      }
    });

    router.delete('/notes/:id/shares/:username', (req, res) => {
      const target = users.findByUsername(req.params.username);
      try {
        if (target) {
          notes.unshare(req.user!.id, req.params.id, target.id);
          live.notify([target.id]);
        }
        res.json(notes.shares(req.user!.id, req.params.id));
      } catch {
        notFound(res);
      }
    });

    // Folder paths contain slashes, so they travel in the query string or body
    const folderOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
    const badFolder = (res: Response) => res.status(400).json({ error: 'Ungültiger Ordner.' });

    router.get('/folders/shares', (req, res) => {
      const folder = folderOf(req.query.folder);
      if (!folder) return void badFolder(res);
      res.json(notes.folderShares(req.user!.id, folder));
    });

    router.put('/folders/shares', (req, res) => {
      const folder = folderOf(req.body?.folder);
      if (!folder) return void badFolder(res);
      const target = typeof req.body?.username === 'string' ? users.findByUsername(req.body.username) : null;
      if (!target || target.id === req.user!.id) {
        res.status(400).json({ error: 'Diesen Benutzer gibt es nicht.' });
        return;
      }
      const { canWrite, canCreate, canDelete } = req.body;
      live.notify(notes.shareFolder(req.user!.id, folder, target.id, { canWrite: !!canWrite, canCreate: !!canCreate, canDelete: !!canDelete }));
      res.json(notes.folderShares(req.user!.id, folder));
    });

    router.delete('/folders/shares', (req, res) => {
      const folder = folderOf(req.body?.folder);
      if (!folder) return void badFolder(res);
      const target = typeof req.body?.username === 'string' ? users.findByUsername(req.body.username) : null;
      if (target) live.notify(notes.unshareFolder(req.user!.id, folder, target.id));
      res.json(notes.folderShares(req.user!.id, folder));
    });

    // The client renamed/moved or deleted a folder: shares follow (sent along with the note changes)
    router.post('/folders/renamed', (req, res) => {
      const from = folderOf(req.body?.from);
      const to = folderOf(req.body?.to);
      if (!from || !to) return void badFolder(res);
      live.notify(notes.renameFolderShares(req.user!.id, from, to));
      res.json({ ok: true });
    });

    router.post('/folders/deleted', (req, res) => {
      const folder = folderOf(req.body?.folder);
      if (!folder) return void badFolder(res);
      live.notify(notes.dropFolderShares(req.user!.id, folder));
      res.json({ ok: true });
    });

    router.put('/notes/:id/public', (req, res) => {
      try {
        notes.setPublic(req.user!.id, req.params.id, !!req.body?.enabled);
        res.json(notes.shares(req.user!.id, req.params.id));
      } catch {
        notFound(res);
      }
    });
  }

  // The server fetches the page (the browser cannot read other sites); the client turns it into a note
  router.post(
    '/import/recipe',
    rateLimit(30, 10 * 60_000),
    handle(async (req, res) => {
      const url = typeof req.body?.url === 'string' ? req.body.url.slice(0, 2000) : '';
      try {
        res.json(await importRecipe(url));
      } catch (err) {
        if (err instanceof ImportError) res.status(422).json({ error: err.message });
        else throw err;
      }
    })
  );

  router.get(
    '/files',
    handle((req, res) => {
      const usage = attachmentUsageMap(notes, req.user!.id);
      const list: AttachmentInfo[] = files.listByOwner(req.user!.id).map((f) => ({
        id: f.id,
        name: f.name,
        mime: f.mime,
        size: f.size,
        createdAt: f.createdAt,
        url: `/api/files/${f.id}`,
        usedIn: usage.get(f.id) ?? [],
      }));
      res.json(list);
    })
  );

  router.post(
    '/files',
    express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
    handle((req, res) => {
      const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'datei'));
      const mime = String(req.headers['content-type'] ?? '').split(';')[0];
      try {
        const saved = files.save(req.user!.id, name, mime, req.body as Buffer);
        res.json({ ...saved, url: `/api/files/${saved.id}`, name });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    })
  );

  router.delete(
    '/files/:id',
    handle((req, res) => {
      const id = String(req.params.id ?? '');
      const meta = files.getMeta(req.user!.id, id);
      if (!meta) {
        res.status(404).json({ error: 'Anhang nicht gefunden.' });
        return;
      }
      const usedIn = attachmentUsageMap(notes, req.user!.id).get(id) ?? [];
      if (usedIn.length > 0) {
        res.status(409).json({ error: 'Anhang wird noch in Notizen verwendet und kann nicht gelöscht werden.', usedIn });
        return;
      }
      files.delete(req.user!.id, id);
      res.json({ ok: true, id });
    })
  );

  router.post(
    '/files/delete',
    express.json({ limit: '64kb' }),
    handle((req, res) => {
      const rawIds: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const ids: string[] = [...new Set(rawIds.filter((v): v is string => typeof v === 'string'))].slice(0, 500);
      const usage = attachmentUsageMap(notes, req.user!.id);
      const result: DeleteFilesResponse = { deleted: [], skippedUsed: [], notFound: [] };
      for (const id of ids) {
        const meta = files.getMeta(req.user!.id, id);
        if (!meta) {
          result.notFound.push(id);
          continue;
        }
        if ((usage.get(id)?.length ?? 0) > 0) {
          result.skippedUsed.push(id);
          continue;
        }
        if (files.delete(req.user!.id, id)) result.deleted.push(id);
        else result.notFound.push(id);
      }
      res.json(result);
    })
  );

  if (opts.avatars) {
    const avatars = opts.avatars;
    const toMe = (u: UserRecord): Me =>
      opts.meFor
        ? opts.meFor(u)
        : {
            id: u.id,
            username: u.username,
            createdAt: u.createdAt,
            passkeys: users.credentialsOf(u.id).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
            hasPassword: u.hasPassword,
            isAdmin: u.isAdmin,
            avatarUrl: u.avatarUrl,
            ...(standalone ? { standalone: true } : {}),
          };

    router.post(
      '/me/avatar',
      express.raw({ type: () => true, limit: MAX_AVATAR_BYTES + 1024 }),
      handle((req, res) => {
        const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        try {
          avatars.save(req.user!.id, mime, req.body as Buffer);
          if (!standalone) live.notify(notes.refreshSharedAvatar(req.user!.id));
          res.json(toMe(users.getUser(req.user!.id) ?? req.user!));
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      })
    );

    router.delete(
      '/me/avatar',
      handle((req, res) => {
        avatars.remove(req.user!.id);
        if (!standalone) live.notify(notes.refreshSharedAvatar(req.user!.id));
        res.json(toMe(users.getUser(req.user!.id) ?? req.user!));
      })
    );
  }

  return router;
}
