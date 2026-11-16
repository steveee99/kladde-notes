import express, { Response } from 'express';
import type { ConfluenceConnectionInfo, ConfluenceConnectionInput, ConfluenceKind, ConfluenceOverview, ConfluenceSyncInput } from '@kladde/shared';
import type { UserRecord, UserStore } from '../UserStore.js';
import type { AuditLog } from '../security/AuditLog.js';
import { handle, rateLimit, requireUser } from '../http.js';
import { ConfluenceClient, ConfluenceError, normalizeConfluenceUrl } from './ConfluenceClient.js';
import type { ConfluenceAccount } from './ConfluenceStore.js';
import type { ConfluenceSync } from './ConfluenceSync.js';

export interface ConfluenceRouterOptions {
  users: UserStore;
  sync: ConfluenceSync;
  audit: AuditLog;
  /** CONFLUENCE_ALLOW_PRIVATE: an on-premise Confluence in the intranet */
  allowPrivate: boolean;
  standaloneUser?: UserRecord;
}

const info = (a: ConfluenceAccount): ConfluenceConnectionInfo => ({ url: a.url, kind: a.kind, email: a.email, accountName: a.accountName, updatedAt: a.updatedAt });

function fail(res: Response, err: unknown): void {
  if (err instanceof ConfluenceError) {
    const status = err.status === 404 ? 404 : err.status === 409 ? 409 : err.status === 401 || err.status === 403 ? 502 : err.status >= 500 ? 502 : 400;
    res.status(status).json({ error: err.message });
  } else throw err;
}

/** Settings → Confluence and "Sync to Confluence…" (#48): every route works on the signed-in user's own data */
export function confluenceRouter(opts: ConfluenceRouterOptions): express.Router {
  const router = express.Router();
  const { sync, audit } = opts;
  const store = sync.store;
  router.use(requireUser(opts.users, opts.standaloneUser));
  // Each call may reach out to Confluence
  router.use(rateLimit(300, 10 * 60_000));

  const overview = (userId: string): ConfluenceOverview => {
    const account = store.account(userId);
    return { connection: account ? info(account) : null, ...(account ? sync.overview(userId) : { syncs: [], notes: {} }) };
  };

  const readInput = (body: unknown, userId: string): Omit<ConfluenceAccount, 'updatedAt' | 'accountName'> => {
    const input = (body ?? {}) as Partial<ConfluenceConnectionInput>;
    const kind: ConfluenceKind = input.kind === 'datacenter' ? 'datacenter' : 'cloud';
    const url = normalizeConfluenceUrl(String(input.url ?? ''), kind, opts.allowPrivate);
    const email = kind === 'cloud' ? String(input.email ?? '').trim().slice(0, 200) : '';
    if (kind === 'cloud' && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new ConfluenceError('Für Confluence Cloud braucht es die E-Mail-Adresse des Atlassian-Kontos.');
    const saved = store.account(userId);
    const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : saved?.token;
    if (!token) throw new ConfluenceError('Bitte einen API-Token eingeben.');
    if (token.length > 2000) throw new ConfluenceError('Der Token ist zu lang.');
    return { url, kind, email, token };
  };

  router.get('/', (req, res) => {
    res.json(overview(req.user!.id));
  });

  router.post(
    '/connection/test',
    handle(async (req, res) => {
      try {
        const account = readInput(req.body, req.user!.id);
        res.json({ accountName: await new ConfluenceClient(account, sync.transport).currentUser(), url: account.url });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  router.put(
    '/connection',
    handle(async (req, res) => {
      try {
        const account = readInput(req.body, req.user!.id);
        // Only a working connection is saved
        const accountName = await new ConfluenceClient(account, sync.transport).currentUser();
        const hadToken = store.hasAccount(req.user!.id);
        store.saveAccount(req.user!.id, { ...account, accountName });
        audit.record('confluence_connected', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: `${new URL(account.url).host}${hadToken ? ' (geändert)' : ''}` });
        res.json(overview(req.user!.id));
      } catch (err) {
        fail(res, err);
      }
    })
  );

  router.delete('/connection', (req, res) => {
    if (store.removeAccount(req.user!.id)) audit.record('confluence_disconnected', { userId: req.user!.id, username: req.user!.username, ip: req.ip });
    res.json(overview(req.user!.id));
  });

  const connected = (userId: string): ConfluenceClient => {
    const client = sync.client(userId);
    if (!client) throw new ConfluenceError('Keine Verbindung zu Confluence eingerichtet (Einstellungen → Confluence).');
    return client;
  };

  router.get(
    '/spaces',
    handle(async (req, res) => {
      try {
        res.json(await connected(req.user!.id).spaces(typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : ''));
      } catch (err) {
        fail(res, err);
      }
    })
  );

  router.get(
    '/resolve',
    handle(async (req, res) => {
      const url = typeof req.query.url === 'string' ? req.query.url.slice(0, 2000) : '';
      try {
        res.json(await connected(req.user!.id).resolveLink(url));
      } catch (err) {
        fail(res, err);
      }
    })
  );

  router.get(
    '/pages',
    handle(async (req, res) => {
      const space = typeof req.query.space === 'string' ? req.query.space : '';
      if (!/^[A-Za-z0-9~_-]{1,255}$/.test(space)) return void res.status(400).json({ error: 'Bitte einen Bereich (Space) wählen.' });
      try {
        res.json(await connected(req.user!.id).searchPages(space, typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : ''));
      } catch (err) {
        fail(res, err);
      }
    })
  );

  router.post(
    '/syncs',
    handle(async (req, res) => {
      try {
        connected(req.user!.id);
        const created = sync.createSync(req.user!.id, (req.body ?? {}) as ConfluenceSyncInput);
        // The first run happens in the background; the client polls the state
        void sync.runSync(req.user!.id, created.id).catch((err) => console.error('Confluence sync failed:', (err as Error).message));
        res.json(overview(req.user!.id));
      } catch (err) {
        fail(res, err);
      }
    })
  );

  router.post(
    '/syncs/:id/run',
    handle(async (req, res) => {
      try {
        await sync.runSync(req.user!.id, String(req.params.id), req.body?.force === true);
        res.json(overview(req.user!.id));
      } catch (err) {
        fail(res, err);
      }
    })
  );

  router.delete('/syncs/:id', (req, res) => {
    if (!sync.stopSync(req.user!.id, String(req.params.id))) return void res.status(404).json({ error: 'Synchronisierung nicht gefunden.' });
    res.json(overview(req.user!.id));
  });

  router.get('/notes/:id', (req, res) => {
    res.json({ state: sync.noteState(req.user!.id, String(req.params.id)) });
  });

  router.post(
    '/notes/:id/run',
    handle(async (req, res) => {
      try {
        connected(req.user!.id);
        await sync.runNote(req.user!.id, String(req.params.id), req.body?.force === true);
        res.json({ state: sync.noteState(req.user!.id, String(req.params.id)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  router.post('/notes/:id/stop', (req, res) => {
    if (!sync.stopNote(req.user!.id, String(req.params.id))) return void res.status(404).json({ error: 'Diese Notiz wird nicht synchronisiert.' });
    res.json({ state: sync.noteState(req.user!.id, String(req.params.id)) });
  });

  return router;
}
