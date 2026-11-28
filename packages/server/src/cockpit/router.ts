import express from 'express';
import { normalizeWidget, type CockpitProvider } from '@kladde/shared';
import type { UserRecord, UserStore } from '../UserStore.js';
import type { AuditLog } from '../security/AuditLog.js';
import { handle, rateLimit, requireUser } from '../http.js';
import type { CockpitService } from './CockpitService.js';
import { CockpitError } from './sources.js';

export interface CockpitRouterOptions {
  users: UserStore;
  service: CockpitService;
  audit: AuditLog;
  standaloneUser?: UserRecord;
}

const PROVIDERS: CockpitProvider[] = ['gitlab', 'jira'];

function vars(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 100)) {
    if (typeof v === 'string' && /^[\p{L}\p{N}_.-]{1,80}$/u.test(k)) out[k] = v.slice(0, 500);
  }
  return out;
}

/**
 * The development cockpit (`/api/cockpit`): the signed-in user's own GitLab and Jira connections and the widget
 * queries that use them. Tokens never leave the server; answers hold only the rows of the user's own access.
 */
export function cockpitRouter(opts: CockpitRouterOptions): express.Router {
  const router = express.Router();
  const { service, audit } = opts;
  router.use(requireUser(opts.users, opts.standaloneUser));

  router.get('/connections', (req, res) => {
    res.json(service.connections(req.user!.id));
  });

  const connectFail = (res: express.Response, err: unknown) => {
    if (!(err instanceof CockpitError)) throw err;
    res.status(err.problem === 'invalid' || err.problem === 'not_found' ? 400 : 502).json({ problem: err.problem, detail: err.message === err.problem ? undefined : err.message });
  };

  // Saving checks the token against the provider: bounded, like a password attempt
  router.put(
    '/connections/gitlab',
    rateLimit(30, 10 * 60_000),
    handle(async (req, res) => {
      try {
        const conn = await service.connectGitlab(req.user!.id, String(req.body?.instanceId ?? ''), typeof req.body?.token === 'string' ? req.body.token : '');
        audit.record('cockpit_connected', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: `gitlab ${conn.username}` });
        res.json(service.connections(req.user!.id));
      } catch (err) {
        connectFail(res, err);
      }
    })
  );

  router.put(
    '/connections/jira',
    rateLimit(30, 10 * 60_000),
    handle(async (req, res) => {
      try {
        const conn = await service.connectJira(req.user!.id, req.body ?? {});
        audit.record('cockpit_connected', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: `jira ${new URL(conn.url).host}` });
        res.json(service.connections(req.user!.id));
      } catch (err) {
        connectFail(res, err);
      }
    })
  );

  router.delete('/connections/:provider', (req, res) => {
    const provider = req.params.provider as CockpitProvider;
    if (!PROVIDERS.includes(provider)) return void res.status(404).json({ error: 'Nicht gefunden' });
    if (service.disconnect(req.user!.id, provider)) audit.record('cockpit_disconnected', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: provider });
    res.json(service.connections(req.user!.id));
  });

  // A dashboard asks once per widget every few minutes; a refresh of all of them stays well below this
  router.post(
    '/query',
    rateLimit(600, 10 * 60_000),
    handle(async (req, res) => {
      const widget = normalizeWidget(req.body?.widget);
      if (!widget) return void res.status(400).json({ problem: 'invalid' });
      res.json(await service.run(req.user!.id, widget, vars(req.body?.vars), req.body?.fresh === true));
    })
  );

  return router;
}
