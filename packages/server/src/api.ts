import express, { Response } from 'express';
import type { AttachmentInfo, DeleteFilesResponse, Me, PushChange } from '@kladde/shared';
import { attachmentUsageMap } from './cliActions.js';
import { AvatarStore, MAX_AVATAR_BYTES } from './AvatarStore.js';
import { NoteStore } from './NoteStore.js';
import { FileStore, MAX_FILE_BYTES } from './FileStore.js';
import { UserRecord, UserStore } from './UserStore.js';
import type { GitSync } from './GitSync.js';
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
    for (const id of new Set(userIds)) for (const res of this.clients.get(id) ?? []) res.write('event: changed\ndata: {}\n\n');
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
}

export function apiRouter(users: UserStore, notes: NoteStore, files: FileStore, live: LiveUpdates, gitSync?: GitSync, opts: ApiRouterOptions = {}): express.Router {
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

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('event: hello\ndata: {}\n\n');
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => clearInterval(keepAlive));
    live.add(req.user!.id, res);
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

  // ---------------------------------------------------------------- git sync of the own notes

  if (gitSync) {
    router.get('/git', authed, handle((req, res) => res.json(gitSync.get(req.user!.id))));
    router.put('/git', authed, handle((req, res) => res.json(gitSync.save(req.user!.id, req.body ?? {}))));
    router.delete('/git', authed, handle((req, res) => {
      gitSync.remove(req.user!.id);
      res.json(null);
    }));
    router.post('/git/sync', authed, rateLimit(20, 10 * 60_000), handle(async (req, res) => res.json(await gitSync.run(req.user!.id))));
  }

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
