import express from 'express';
import { SYSTEM_PREFIX, buildCalendar } from '@kladde/shared';
import { NoteStore } from '../NoteStore.js';
import { UserStore } from '../UserStore.js';
import { AuditLog } from '../security/AuditLog.js';
import { handle, rateLimit, requireUser } from '../http.js';
import { taskDueOf } from '../mcp/tools.js';
import { CalendarFeedStore } from './CalendarFeedStore.js';

export interface CalendarOptions {
  users: UserStore;
  notes: NoteStore;
  feeds: CalendarFeedStore;
  audit: AuditLog;
  publicUrl: string | null;
}

/**
 * `feedRouter` serves the feed itself: no cookies, the secret in the address is the only key, and it only ever
 * shows the feed owner's own tasks. `accountRouter` is the settings page (signed in).
 */
export function calendarRouters(opts: CalendarOptions): { feedRouter: express.Router; accountRouter: express.Router } {
  const { users, notes, feeds, audit } = opts;

  const feedRouter = express.Router();
  feedRouter.use(rateLimit(120, 60_000));

  feedRouter.get('/:file', (req, res) => {
    const token = /^(.+)\.ics$/.exec(req.params.file)?.[1];
    const found = feeds.resolve(token);
    const user = found ? users.getUser(found.userId) : null;
    if (!found || !user || user.bannedAt) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const own = notes.ownedNotes(user.id).filter((n) => !n.path.startsWith(SYSTEM_PREFIX));
    const baseUrl = opts.publicUrl ?? `${req.protocol}://${req.get('host')}`;
    const ics = buildCalendar(own, { ...found.feed.options, name: `Kladde – ${found.feed.name}`, baseUrl, defaultDue: taskDueOf(notes, user.id) });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="kladde.ics"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(ics);
  });

  const accountRouter = express.Router();
  accountRouter.use(requireUser(users), express.json({ limit: '16kb' }));

  accountRouter.get('/', (req, res) => res.json(feeds.list(req.user!.id)));

  accountRouter.post(
    '/',
    handle((req, res) => {
      const { feed, secret } = feeds.create(req.user!.id, req.body?.name, req.body?.options, req.body?.days ?? undefined);
      audit.record('calendar_feed_created', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: feed.name });
      res.json({ feed, path: `/api/calendar/${secret}.ics` });
    })
  );

  accountRouter.delete('/:id', (req, res) => {
    const revoked = feeds.revoke(req.user!.id, req.params.id);
    if (revoked) audit.record('calendar_feed_revoked', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: revoked.name });
    res.json(feeds.list(req.user!.id));
  });

  return { feedRouter, accountRouter };
}
