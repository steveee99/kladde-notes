import express, { type NextFunction, type Request, type Response } from 'express';
import { resolveRemoteSource, type RemoteHost, type RemoteNoteResponse, type RemoteProblem } from '@kladde/shared';
import { handle, requireUser } from '../http.js';
import type { NoteStore } from '../NoteStore.js';
import type { UserRecord, UserStore } from '../UserStore.js';
import { RemoteError, type RemoteFetcher } from './RemoteFetcher.js';
import type { RemoteInstances } from './RemoteInstances.js';

/** Fixed window per account (all its devices share it) */
function userLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.user!.id;
    const entry = hits.get(key);
    if (!entry || entry.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
    else if (++entry.count > limit) {
      res.status(429).json({ error: 'Zu viele Abrufe – bitte kurz warten.' });
      return;
    }
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

export interface RemoteRouterOptions {
  users: UserStore;
  notes: NoteStore;
  instances: RemoteInstances;
  fetcher: RemoteFetcher;
  standaloneUser?: UserRecord;
}

/**
 * Text and images of remote notes. The source always comes from the stored note after the access check, never from the
 * request; its variables are those of the note's owner, so everyone who sees the note sees the same document. Answers
 * never contain the filled-in address of a document that could not be read: whoever may write a shared note could
 * otherwise read the variables of its folder that way.
 */
export function remoteRouter({ users, notes, instances, fetcher, standaloneUser }: RemoteRouterOptions): express.Router {
  const router = express.Router();
  router.use(requireUser(users, standaloneUser));
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /** The note's resolved source, or why there is none; undefined = not this user's note, or no remote note */
  const sourceOf = (req: Request): { url: string; ref: string } | RemoteProblem | undefined => {
    const found = notes.remoteSource(req.user!.id, String(req.params.id));
    if (!found) return undefined;
    const r = resolveRemoteSource(found.source, notes.variablesOf(found.ownerId, found.folder));
    return r.complete ? { url: r.url, ref: r.ref } : 'unknown_variable';
  };

  /** The hosts an address may point to (for the dialog); tokens and allowed paths stay on the server */
  router.get('/hosts', (_req, res) => {
    res.json(instances.active().map(({ kind, url }): RemoteHost => ({ kind, url })));
  });

  router.get(
    '/:id',
    userLimit(120, 60_000),
    handle(async (req, res) => {
      const src = sourceOf(req);
      if (src === undefined) {
        res.status(404).json({ error: 'Notiz nicht gefunden.' });
        return;
      }
      const answer: RemoteNoteResponse = typeof src === 'string' ? { state: src } : await fetcher.text(src.url, src.ref, req.query.refresh === '1' ? { freshMs: 0 } : {});
      res.json(answer);
    })
  );

  router.get(
    '/:id/image',
    userLimit(600, 60_000),
    handle(async (req, res) => {
      const src = sourceOf(req);
      const path = req.query.path;
      if (src === undefined || typeof src === 'string' || typeof path !== 'string') {
        res.status(404).end();
        return;
      }
      try {
        const image = await fetcher.image(src.url, src.ref, path);
        // Kept by the browser, but asked for every time: access may have ended
        res.setHeader('Cache-Control', 'private, no-cache');
        res.setHeader('ETag', image.etag);
        res.setHeader('Content-Type', image.mime);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        // SVGs may carry scripts: shown in <img> they never run, opened on their own they are sandboxed and downloaded
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
        res.setHeader('Content-Disposition', image.mime === 'image/svg+xml' ? 'attachment; filename="image.svg"' : 'inline');
        if (req.headers['if-none-match'] === image.etag) res.status(304).end();
        else res.end(image.data);
      } catch (err) {
        if (!(err instanceof RemoteError)) throw err;
        res.status(err.problem === 'too_large' ? 413 : err.problem === 'unsupported' ? 415 : 404).end();
      }
    })
  );

  return router;
}
