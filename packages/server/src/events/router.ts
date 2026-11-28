import express from 'express';
import type { GitEventOwner } from '@kladde/plugin-api';
import type { EventDelivery, EventSource } from '@kladde/shared';
import type { GroupStore } from '../GroupStore.js';
import type { NoteStore } from '../NoteStore.js';
import type { UserRecord, UserStore } from '../UserStore.js';
import type { AuditLog } from '../security/AuditLog.js';
import { handle, rateLimit, requireUser } from '../http.js';
import { verifyDelivery } from '../hooks/gitEvents.js';
import type { EventBus } from './EventBus.js';
import { EventSourceStore } from './EventSourceStore.js';
import { deliveryIdOf, deliveryKindOf, matchesProjects, normalizeDelivery } from './normalize.js';

export interface EventRouterOptions {
  users: UserStore;
  notes: NoteStore;
  groups: GroupStore;
  sources: EventSourceStore;
  bus: EventBus;
  audit: AuditLog;
  publicUrl: string | null;
  standaloneUser?: UserRecord;
}

/** Largest delivery accepted (GitHub sends whole pull requests with their repository) */
const MAX_BODY = '2mb';

/** The owner of a webhook as events name it: an account or a group */
export function ownerOf(users: UserStore, groups: GroupStore, id: string): GitEventOwner | null {
  const user = users.getUser(id);
  if (user) return { kind: 'user', id, name: user.username };
  const group = groups.groupName(id);
  return group ? { kind: 'group', id, name: group } : null;
}

/**
 * Central webhooks (#149). `receiver` takes the deliveries of GitLab and GitHub at `/api/events/hooks/<id>` (no
 * cookies: the id finds the webhook, the secret proves the sender; unknown ids and wrong secrets get the same 404),
 * normalises them, drops repeats by delivery id and publishes them on the bus. It answers at once (202): the
 * subscribers run afterwards and their outcome lands in the delivery list. `accountRouter` lets people manage the
 * webhooks of their account and of the groups they own.
 */
export function eventRouters(opts: EventRouterOptions): { receiver: express.Router; accountRouter: express.Router } {
  const { users, notes, groups, sources, bus, audit } = opts;

  const receiver = express.Router();
  receiver.post('/:id', rateLimit(300, 60_000), express.raw({ type: () => true, limit: MAX_BODY }), (req, res) => {
    const notFound = () => res.status(404).json({ error: 'Not found' });
    const source = sources.resolve(req.params.id);
    if (!source) return notFound();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const id = deliveryIdOf(source.provider, req.headers, body);
    const kind = deliveryKindOf(source.provider, req.headers);
    const now = Date.now();
    const log = (status: EventDelivery['status'], detail: string, extra: Partial<EventDelivery> = {}) => sources.record(source.id, { id, at: now, kind, type: null, action: '', project: '', status, detail, ...extra });
    if (!verifyDelivery(source.provider, req.headers, body, source.secret)) {
      log('invalid', 'Falsches Secret');
      return notFound();
    }
    const owner = ownerOf(users, groups, source.ownerId);
    if (!owner) return notFound();
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      log('invalid', 'Kein JSON – bei GitHub „application/json“ als Content type wählen.');
      return res.status(400).json({ error: 'Expected JSON' });
    }
    const event = normalizeDelivery(source.provider, req.headers, payload, body, now);
    if (!event) {
      // Pings and events Kladde does not know: answered, nothing to do
      log('ignored', kind === 'ping' || kind === 'System Hook' ? 'Test' : 'Kein Ereignis, das Kladde kennt');
      return res.status(202).json({ ignored: true });
    }
    const facts = { type: event.type, action: event.action, project: event.project.path };
    if (!matchesProjects(event.project.path, source.projects)) {
      log('filtered', 'Projekt nicht in der Liste dieses Webhooks', facts);
      return res.status(202).json({ ignored: true });
    }
    if (!sources.claim(source.id, id, now)) {
      log('duplicate', 'Schon erhalten', facts);
      return res.status(200).json({ duplicate: true });
    }
    log('accepted', 'Empfangen', facts);
    void bus.publish({ event, owner, source: { id: source.id, createdBy: source.createdBy }, rawPayload: payload }).then((outcomes) => {
      const failed = outcomes.filter((o) => !o.ok);
      const summaries = outcomes.filter((o) => o.ok && o.summary).map((o) => `${o.name}: ${o.summary}`);
      const detail = failed.length
        ? failed.map((o) => `${o.name}: ${o.error ?? 'Fehler'}`).join('; ')
        : summaries.length
          ? summaries.join('; ')
          : outcomes.length
            ? `Zugestellt an ${outcomes.map((o) => o.name).join(', ')}`
            : 'Niemand hat dieses Ereignis abonniert';
      log(failed.length ? 'failed' : 'accepted', detail, facts);
    });
    res.status(202).json({ accepted: true, type: event.type, action: event.action });
  });

  const accountRouter = express.Router();
  accountRouter.use(requireUser(users, opts.standaloneUser), express.json({ limit: '16kb' }));
  const baseUrl = (req: express.Request) => {
    // Trailing slashes off without a regex (the host header comes from the client)
    let url = opts.publicUrl ?? `${req.protocol}://${req.get('host')}`;
    while (url.endsWith('/')) url = url.slice(0, -1);
    return url;
  };
  /** The account and the groups the user owns: whose webhooks they see and manage */
  const ownersFor = (user: UserRecord): GitEventOwner[] => [
    { kind: 'user', id: user.id, name: user.username },
    ...notes
      .groupsOf(user.id)
      .filter((g) => g.role === 'owner')
      .map((g): GitEventOwner => ({ kind: 'group', id: g.id, name: g.name })),
  ];
  const list = (req: express.Request): EventSource[] => {
    const owners = ownersFor(req.user!);
    return sources.list(
      owners.map((o) => o.id),
      (r) => ({ id: r.id, provider: r.provider, url: `${baseUrl(req)}/api/events/hooks/${r.id}`, owner: owners.find((o) => o.id === r.ownerId)!, createdBy: users.getUser(r.createdBy)?.username ?? '', createdAt: r.createdAt })
    );
  };
  /** The webhook when the user may manage it (own, or a group they own); otherwise a 404 */
  const managed = (req: express.Request, res: express.Response): string | null => {
    const id = String(req.params.id ?? '');
    const owner = sources.ownerOf(id);
    if (!owner || !ownersFor(req.user!).some((o) => o.id === owner)) {
      res.status(404).json({ error: 'Webhook nicht gefunden' });
      return null;
    }
    return id;
  };

  accountRouter.get('/', (req, res) => {
    res.json(list(req));
  });

  accountRouter.post(
    '/',
    handle((req, res) => {
      const user = req.user!;
      const group = typeof req.body?.group === 'string' && req.body.group ? req.body.group : null;
      if (group && groups.roleOf(group, user.id) !== 'owner') {
        res.status(403).json({ error: 'Nur Eigentümer der Gruppe legen ihre Webhooks an.' });
        return;
      }
      const { id, secret } = sources.create(group ?? user.id, user.id, { provider: req.body?.provider, name: req.body?.name, projects: req.body?.projects });
      audit.record('event_source_created', { userId: user.id, username: user.username, ip: req.ip, detail: String(req.body?.provider) });
      res.json({ source: list(req).find((s) => s.id === id)!, secret });
    })
  );

  accountRouter.patch(
    '/:id',
    handle((req, res) => {
      const id = managed(req, res);
      if (!id) return;
      sources.update(id, { name: req.body?.name, projects: req.body?.projects });
      res.json(list(req).find((s) => s.id === id));
    })
  );

  accountRouter.post('/:id/rotate', (req, res) => {
    const id = managed(req, res);
    if (!id) return;
    const secret = sources.rotate(id);
    audit.record('event_source_rotated', { userId: req.user!.id, username: req.user!.username, ip: req.ip });
    res.json({ secret });
  });

  accountRouter.delete('/:id', (req, res) => {
    const id = managed(req, res);
    if (!id) return;
    if (sources.remove(id)) audit.record('event_source_removed', { userId: req.user!.id, username: req.user!.username, ip: req.ip });
    res.json(list(req));
  });

  return { receiver, accountRouter };
}
