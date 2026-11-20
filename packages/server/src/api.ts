import express, { Response } from 'express';
import { extractMentions, isReleaseBump, trimSlashes, type CommentThreadList } from '@kladde/shared';
import type { ActivityList, NotePerson, MyStorage, AttachmentInfo, AttachmentSearchResponse, CursorAnnounce, DeleteFilesResponse, Me, PresenceAnnounce, PushChange, TrashConflict, TrashList } from '@kladde/shared';
import { Presence } from './Presence.js';
import { FILE_URL_RE, attachmentUsageMap } from './cliActions.js';
import { GroupError, GroupStore } from './GroupStore.js';
import type { ActivityStore } from './ActivityStore.js';
import type { NotificationStore } from './NotificationStore.js';
import { CommentError, type CommentStore } from './CommentStore.js';
import { AvatarStore, MAX_AVATAR_BYTES } from './AvatarStore.js';
import { NoteStore, ReleaseConflict, TrashPathTaken, VersioningOff } from './NoteStore.js';
import { DEFAULT_TRASH_DAYS, dropUnusedAttachments } from './trash.js';
import { FileStore, MAX_FILE_BYTES } from './FileStore.js';
import { AccountError, UserRecord, UserStore } from './UserStore.js';
import type { StorageStore } from './StorageStore.js';
import { handle, rateLimit, requireUser } from './http.js';
import { ImportError, importRecipe } from './RecipeImport.js';
import { clipPage } from './WebClip.js';
import type { Transcriber } from './transcribe.js';
import type { AttachmentTextStore } from './attachments/AttachmentTextStore.js';
import { searchAttachments } from './attachments/search.js';

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
  /** Speech-to-text for voice notes, when TRANSCRIBE_URL is set */
  transcriber?: Transcriber | null;
  /** Full-text search in attachments (#37) */
  /** Storage usage and quotas (#91) */
  storage?: StorageStore;
  attachmentSearch?: { files: FileStore; texts: AttachmentTextStore; ocr: boolean };
  /** Groups (#58); not in standalone mode */
  groups?: GroupStore;
  /** Activity of groups and shared folders (#70) */
  activity?: ActivityStore;
  /** Mentions and comments (#69, #68) */
  notifications?: NotificationStore;
  /** Comment threads on passages (#68) */
  comments?: CommentStore;
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
    res.setHeader('Accept-Ranges', 'bytes');
    // Safari only plays audio (voice notes) when it can ask for byte ranges
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      const size = file.data.length;
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.status(416).end();
        return;
      }
      start = Math.max(0, start);
      end = Math.max(start, end);
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.send(file.data.subarray(start, end + 1));
      return;
    }
    res.send(file.data);
  });

  // Voice notes (#33): text from the speech-to-text server the admin configured (TRANSCRIBE_URL)
  if (opts.transcriber) {
    const transcribe = opts.transcriber;
    router.post(
      '/files/:id/transcribe',
      authed,
      rateLimit(20, 10 * 60_000),
      handle(async (req, res) => {
        const meta = files.getMeta(req.user!.id, String(req.params.id ?? ''));
        const file = meta && meta.mime.startsWith('audio/') ? files.load(meta.id) : null;
        if (!file) {
          res.status(404).json({ error: 'Aufnahme nicht gefunden.' });
          return;
        }
        try {
          const lang = typeof req.body?.lang === 'string' ? req.body.lang : undefined;
          res.json({ text: await transcribe({ data: file.data, mime: file.mime, name: file.name }, lang) });
        } catch (err) {
          res.status(502).json({ error: (err as Error).message });
        }
      })
    );
  }

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
    const entries = notes.purgeEntries(userId, ids);
    // A group's trash (#58) holds the group's notes: their attachments are looked up for the group
    for (const owner of new Set(entries.map((e) => e.ownerId))) {
      dropUnusedAttachments(
        notes,
        files,
        owner,
        entries.filter((e) => e.ownerId === owner).map((e) => e.content)
      );
    }
    return entries.length;
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

  // ---------------------------------------------------------------- release versioning (#53)

  router.get('/notes/:id/releases', (req, res) => {
    try {
      res.json(notes.releases(req.user!.id, req.params.id));
    } catch {
      notFound(res);
    }
  });

  router.get('/notes/:id/releases/:version', (req, res) => {
    try {
      res.json(notes.releaseOf(req.user!.id, req.params.id, req.params.version));
    } catch {
      res.status(404).json({ error: 'Diese Version gibt es nicht.' });
    }
  });

  // Only the owner turns versioning on or off and releases; released versions are never changed (no route, and a trigger)
  router.put('/notes/:id/versioning', (req, res) => {
    try {
      res.json(notes.setVersioning(req.user!.id, req.params.id, !!req.body?.enabled));
    } catch {
      notFound(res);
    }
  });

  router.post('/notes/:id/releases', (req, res) => {
    const bump = req.body?.bump;
    const baseVersion = Number(req.body?.baseVersion);
    if (!isReleaseBump(bump) || !Number.isInteger(baseVersion)) return void res.status(400).json({ error: 'Ungültige Version.' });
    try {
      const release = notes.release(req.user!.id, req.params.id, { bump, note: req.body?.note, baseVersion });
      res.json({ release, releases: notes.releases(req.user!.id, req.params.id) });
    } catch (err) {
      if (err instanceof ReleaseConflict) res.status(409).json({ error: 'Die Notiz wurde inzwischen geändert. Bitte erneut versuchen.', conflict: true });
      else if (err instanceof VersioningOff) res.status(400).json({ error: 'Die Versionierung ist für diese Notiz aus.' });
      else notFound(res);
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
      const already = notes.folderShares(req.user!.id, folder).users.some((u) => u.username === target.username);
      live.notify(notes.shareFolder(req.user!.id, folder, target.id, { canWrite: !!canWrite, canCreate: !!canCreate, canDelete: !!canDelete }));
      if (!already) opts.activity?.folderShare(req.user!.id, req.user!.id, 'folder_shared', folder, target.username);
      res.json(notes.folderShares(req.user!.id, folder));
    });

    router.delete('/folders/shares', (req, res) => {
      const folder = folderOf(req.body?.folder);
      if (!folder) return void badFolder(res);
      const target = typeof req.body?.username === 'string' ? users.findByUsername(req.body.username) : null;
      if (target) {
        const had = notes.folderShares(req.user!.id, folder).users.some((u) => u.username === target.username);
        live.notify(notes.unshareFolder(req.user!.id, folder, target.id));
        if (had) opts.activity?.folderShare(req.user!.id, req.user!.id, 'folder_unshared', folder, target.username);
      }
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

  // ---------------------------------------------------------------- groups (#58)

  if (!standalone && opts.groups) {
    const groups = opts.groups;
    const groupError = (res: Response, err: unknown) => {
      if (err instanceof GroupError) return void res.status(err.status).json({ error: err.message });
      const message = (err as Error).message;
      if (message === 'forbidden') res.status(403).json({ error: 'In dieser Gruppe darfst du keine Notizen anlegen.' });
      else if (message === 'invalid' || message === 'invalid path') res.status(400).json({ error: 'Ungültige Angaben.' });
      else if (message === 'not found') res.status(404).json({ error: 'Notiz nicht gefunden (oder nicht deine).' });
      else throw err;
    };
    const groupFiles = (groupId: string): Set<string> => {
      const ids = new Set(files.listByOwner(groupId).map((f) => f.id));
      for (const content of [...notes.allOf(groupId).map((n) => n.content), ...notes.trashedContents(groupId)]) {
        for (const m of content.matchAll(FILE_URL_RE)) if (files.exists(m[1])) ids.add(m[1]);
      }
      return ids;
    };
    const memberTarget = (value: unknown) => {
      const target = typeof value === 'string' ? users.findByUsername(value) : null;
      if (!target || target.bannedAt) throw new GroupError('Diesen Benutzer gibt es nicht.');
      return target;
    };

    router.get('/groups', (req, res) => {
      res.json(notes.groupsOf(req.user!.id));
    });

    router.post('/groups', rateLimit(30, 10 * 60_000), (req, res) => {
      try {
        const group = groups.create(req.user!.id, req.body?.name);
        live.notify([req.user!.id]);
        res.json(group);
      } catch (err) {
        groupError(res, err);
      }
    });

    router.get('/groups/:id', (req, res) => {
      try {
        const details = groups.details(req.user!.id, req.params.id);
        res.json({ ...details, attachments: groupFiles(details.id).size });
      } catch (err) {
        groupError(res, err);
      }
    });

    router.patch('/groups/:id', (req, res) => {
      try {
        res.json(groups.rename(req.user!.id, req.params.id, req.body?.name));
        live.notify(groups.memberIds(req.params.id));
      } catch (err) {
        groupError(res, err);
      }
    });

    // Features the owners switch on for every member (tickets and milestones)
    router.put('/groups/:id/features', (req, res) => {
      try {
        groups.setFeatures(req.user!.id, req.params.id, req.body);
        live.notify(groups.memberIds(req.params.id));
        res.json(groups.details(req.user!.id, req.params.id));
      } catch (err) {
        groupError(res, err);
      }
    });

    router.put('/groups/:id/members', (req, res) => {
      try {
        const target = memberTarget(req.body?.username);
        const before = groups.roleOf(req.params.id, target.id);
        groups.setMember(req.user!.id, req.params.id, target.id, req.body?.role);
        const after = groups.roleOf(req.params.id, target.id);
        if (after && after !== before) opts.activity?.member(req.params.id, req.user!.id, before ? 'member_role' : 'member_added', target.username, after);
        live.notify(groups.memberIds(req.params.id));
        res.json(groups.details(req.user!.id, req.params.id));
      } catch (err) {
        groupError(res, err);
      }
    });

    // Removing someone else needs the owner role; removing oneself is leaving the group
    router.delete('/groups/:id/members/:username', (req, res) => {
      try {
        const target = users.findByUsername(req.params.username);
        if (!target) throw new GroupError('Diese Person ist nicht in der Gruppe.', 404);
        const before = groups.memberIds(req.params.id);
        groups.removeMember(req.user!.id, req.params.id, target.id);
        opts.activity?.member(req.params.id, req.user!.id, 'member_removed', target.username, null);
        live.notify(before);
        res.json(target.id === req.user!.id ? { left: true } : groups.details(req.user!.id, req.params.id));
      } catch (err) {
        groupError(res, err);
      }
    });

    router.post('/groups/:id/leave', (req, res) => {
      try {
        const before = groups.memberIds(req.params.id);
        groups.removeMember(req.user!.id, req.params.id, req.user!.id);
        opts.activity?.member(req.params.id, req.user!.id, 'member_removed', req.user!.username, null);
        live.notify(before);
        res.json({ left: true });
      } catch (err) {
        groupError(res, err);
      }
    });

    // Deleting a group needs its name as confirmation; every note and attachment of the group goes with it
    router.delete(
      '/groups/:id',
      handle((req, res) => {
        const userId = req.user!.id;
        const groupId = String(req.params.id);
        try {
          groups.checkDelete(userId, groupId, req.body?.confirm);
          const contents = [...notes.allOf(groupId).map((n) => n.content), ...notes.trashedContents(groupId)];
          const used = groupFiles(groupId);
          for (const f of files.listByOwner(groupId)) files.delete(groupId, f.id);
          const members = notes.deleteGroup(userId, groupId);
          // Attachments members uploaded into group notes: gone too, unless their uploader still uses them elsewhere
          const owners = new Set([...used].map((id) => files.meta(id)?.ownerId).filter((o): o is string => !!o));
          for (const owner of owners) dropUnusedAttachments(notes, files, owner, contents);
          live.notify(members);
          res.json({ ok: true });
        } catch (err) {
          groupError(res, err);
        }
      })
    );

    // Own notes (a single note or a whole folder) move into the group: shares end, links between them keep working
    router.post('/groups/:id/move', (req, res) => {
      try {
        const result = notes.moveToGroup(req.user!.id, req.params.id, req.body ?? {});
        res.json({ moved: result.moved });
      } catch (err) {
        groupError(res, err);
      }
    });
  }

  // ---------------------------------------------------------------- activity (#70)

  if (!standalone && opts.activity) {
    const activity = opts.activity;
    // ?group=<id> for a group's space, ?owner=<username>&folder=<path> for a shared folder (its owner or a recipient)
    router.get('/activity', (req, res) => {
      const userId = req.user!.id;
      const before = Number(req.query.before) || undefined;
      if (typeof req.query.group === 'string') {
        if (!notes.groupRole(req.query.group, userId)) return void res.status(404).json({ error: 'Gruppe nicht gefunden.' });
        return void res.json({ entries: activity.ofOwner(req.query.group, { before }) } satisfies ActivityList);
      }
      // Trimmed by hand: `/\/+$/` backtracks polynomially on long runs of slashes (CodeQL js/polynomial-redos)
      const folder = typeof req.query.folder === 'string' ? trimSlashes(req.query.folder.slice(0, 1000)) : '';
      const owner = typeof req.query.owner === 'string' ? users.findByUsername(req.query.owner) : null;
      if (!folder || !owner) return void res.status(400).json({ error: 'Ungültiger Ordner.' });
      const allowed =
        owner.id === userId
          ? (({ users: u, inherited }) => u.length + inherited.length > 0)(notes.folderShares(userId, folder))
          : notes.sharedWith(userId).some((f) => f.owner === owner.username && (folder === f.folder || folder.startsWith(`${f.folder}/`)));
      if (!allowed) return void res.status(404).json({ error: 'Ordner nicht gefunden.' });
      res.json({ entries: activity.ofFolder(owner.id, folder, { before }) } satisfies ActivityList);
    });

    // Notes changed by others since the user last opened them
    router.get('/activity/news', (req, res) => {
      const userId = req.user!.id;
      res.json(activity.news(userId, (noteId) => !!notes.audienceOf(noteId)?.includes(userId)));
    });

    router.post('/activity/seen', (req, res) => {
      const noteId = typeof req.body?.noteId === 'string' ? req.body.noteId : '';
      // Only notes somebody else sees can become new again
      const audience = notes.audienceOf(noteId);
      if (audience?.includes(req.user!.id) && new Set(audience).size > 1) activity.seen(req.user!.id, noteId);
      res.json({ ok: true });
    });
  }

  // ---------------------------------------------------------------- mentions and notifications (#69)

  if (!standalone) {
    // Who can see a note: the people a mention reaches (autocomplete, chips)
    router.get('/notes/:id/people', (req, res) => {
      const audience = notes.audienceOf(req.params.id);
      if (!audience?.includes(req.user!.id)) return void notFound(res);
      const people: NotePerson[] = [];
      for (const id of new Set(audience)) {
        const u = users.getUser(id);
        if (u && !u.bannedAt) people.push({ username: u.username, avatarUrl: u.avatarUrl ?? null });
      }
      res.json(people.sort((a, b) => a.username.localeCompare(b.username)));
    });
  }

  if (!standalone && opts.notifications) {
    const notifications = opts.notifications;
    router.get('/notifications', (req, res) => {
      res.json(notifications.list(req.user!.id));
    });
    // { ids } marks those, { noteId } the ones of a note, {} all
    router.post('/notifications/read', (req, res) => {
      const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : null;
      const noteId = typeof req.body?.noteId === 'string' ? req.body.noteId : undefined;
      notifications.markRead(req.user!.id, { ids, noteId });
      res.json({ unread: notifications.unread(req.user!.id) });
    });
  }

  // ---------------------------------------------------------------- comments (#68)

  if (!standalone && opts.comments) {
    const comments = opts.comments;
    const notify = opts.notifications;
    /** Everybody who sees the note, or a 404 for the caller */
    const audienceFor = (userId: string, noteId: string): string[] => {
      const audience = notes.audienceOf(noteId);
      if (!audience?.includes(userId)) throw new CommentError('Notiz nicht gefunden (oder nicht deine).', 404);
      return [...new Set(audience)];
    };
    const commentError = (res: Response, err: unknown) => {
      if (err instanceof CommentError) res.status(err.status).json({ error: err.message });
      else throw err;
    };
    /** Open apps load the threads again; the people concerned get a notification */
    const after = (noteId: string, audience: string[], actorId: string, text: string, threadId: string, recipients: string[], kind: 'comment' | 'reply') => {
      live.send(audience, 'comments', { noteId });
      if (!notify) return;
      const path = notes.pathOf(noteId) ?? '';
      const mentioned = new Set(
        extractMentions(text)
          .map((name) => users.findByUsername(name)?.id)
          .filter((id): id is string => !!id && id !== actorId && audience.includes(id))
      );
      for (const id of mentioned) notify.add({ userId: id, kind: 'mention', noteId, actorId, path, text, threadId });
      for (const id of new Set(recipients)) {
        if (id === actorId || mentioned.has(id) || !audience.includes(id)) continue;
        notify.add({ userId: id, kind, noteId, actorId, path, text, threadId });
      }
    };

    router.get('/notes/:id/comments', (req, res) => {
      try {
        audienceFor(req.user!.id, req.params.id);
        res.json({ threads: comments.list(req.params.id) } satisfies CommentThreadList);
      } catch (err) {
        commentError(res, err);
      }
    });

    // A new thread on a passage: { anchor, text }
    router.post('/notes/:id/comments', rateLimit(120, 60_000), (req, res) => {
      try {
        const noteId = String(req.params.id);
        const audience = audienceFor(req.user!.id, noteId);
        const thread = comments.create(noteId, req.user!.id, req.body?.anchor, req.body?.text);
        after(noteId, audience, req.user!.id, thread.comments[0].text, thread.id, notes.keepersOf(noteId), 'comment');
        res.json(thread);
      } catch (err) {
        commentError(res, err);
      }
    });

    router.post('/notes/:id/comments/:thread/replies', rateLimit(120, 60_000), (req, res) => {
      try {
        const noteId = String(req.params.id);
        const audience = audienceFor(req.user!.id, noteId);
        const before = comments.participants(noteId, String(req.params.thread));
        const thread = comments.reply(noteId, String(req.params.thread), req.user!.id, req.body?.text);
        after(noteId, audience, req.user!.id, thread.comments[thread.comments.length - 1].text, thread.id, before, 'reply');
        res.json(thread);
      } catch (err) {
        commentError(res, err);
      }
    });

    // { resolved: boolean }
    router.patch('/notes/:id/comments/:thread', (req, res) => {
      try {
        const noteId = String(req.params.id);
        const audience = audienceFor(req.user!.id, noteId);
        const thread = comments.setResolved(noteId, String(req.params.thread), req.user!.id, !!req.body?.resolved);
        live.send(audience, 'comments', { noteId });
        res.json(thread);
      } catch (err) {
        commentError(res, err);
      }
    });

    router.put('/notes/:id/comments/:thread/replies/:comment', (req, res) => {
      try {
        const noteId = String(req.params.id);
        const audience = audienceFor(req.user!.id, noteId);
        const thread = comments.edit(noteId, String(req.params.thread), String(req.params.comment), req.user!.id, req.body?.text);
        live.send(audience, 'comments', { noteId });
        res.json(thread);
      } catch (err) {
        commentError(res, err);
      }
    });

    router.delete('/notes/:id/comments/:thread/replies/:comment', (req, res) => {
      try {
        const noteId = String(req.params.id);
        const audience = audienceFor(req.user!.id, noteId);
        const thread = comments.deleteComment(noteId, String(req.params.thread), String(req.params.comment), req.user!.id, notes.manages(req.user!.id, noteId));
        live.send(audience, 'comments', { noteId });
        res.json({ thread });
      } catch (err) {
        commentError(res, err);
      }
    });

    router.delete('/notes/:id/comments/:thread', (req, res) => {
      try {
        const noteId = String(req.params.id);
        const audience = audienceFor(req.user!.id, noteId);
        comments.deleteThread(noteId, String(req.params.thread), req.user!.id, notes.manages(req.user!.id, noteId));
        live.send(audience, 'comments', { noteId });
        res.json({ ok: true });
      } catch (err) {
        commentError(res, err);
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

  // Web clipper (#32): article as Markdown, optionally with its images stored as attachments
  router.post(
    '/clip',
    rateLimit(30, 10 * 60_000),
    handle(async (req, res) => {
      const url = typeof req.body?.url === 'string' ? req.body.url.slice(0, 2000) : '';
      const userId = req.user!.id;
      try {
        res.json(await clipPage(url, { images: req.body?.images === true, save: (name, mime, data) => `/api/files/${files.save(userId, name, mime, data).id}` }));
      } catch (err) {
        if (err instanceof ImportError) res.status(422).json({ error: err.message });
        else throw err;
      }
    })
  );

  // Full-text search in the text of PDFs and images (#37): only attachments embedded in notes the user can read
  if (opts.attachmentSearch) {
    const deps = opts.attachmentSearch;
    router.get(
      '/attachments/search',
      rateLimit(240, 60_000),
      handle((req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
        const visible = notes.pull(req.user!.id, 0).notes.filter((n) => !n.deleted);
        const result: AttachmentSearchResponse = searchAttachments(deps, visible, q, 50);
        res.json(result);
      })
    );
  }

  router.get('/storage', (req, res) => {
    if (!opts.storage) return void res.status(404).json({ error: 'Nicht verfügbar.' });
    const storage = opts.storage;
    const mine: MyStorage = {
      user: storage.usage(req.user!.id),
      groups: notes.groupsOf(req.user!.id).map((g) => ({ id: g.id, name: g.name, storage: storage.usage(g.id) })),
    };
    res.json(mine);
  });

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
        res.status(err instanceof AccountError ? err.status : 400).json({ error: (err as Error).message });
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
