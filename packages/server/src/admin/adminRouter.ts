import express, { Request } from 'express';
import type { AdminAuditEntry, AdminStatus } from '@kladde/shared';
import { AccountError, UserStore } from '../UserStore.js';
import { AuditLog } from '../security/AuditLog.js';
import { handle, requireUser } from '../http.js';

export interface AdminRouterOptions {
  users: UserStore;
  audit: AuditLog;
  status: () => AdminStatus;
}

/** Admin area of the web app: accounts, invites, password resets and the audit log (admins only) */
export function adminRouter({ users, audit, status }: AdminRouterOptions): express.Router {
  const router = express.Router();
  const authed = requireUser(users);
  router.use(authed, (req, res, next) => {
    if (!req.user!.isAdmin) {
      res.status(403).json({ error: 'Nur für Admins' });
      return;
    }
    next();
  });

  const record = (req: Request, action: string) =>
    audit.record('admin_command', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: `web: ${action}` });

  /** The target account; admins cannot lock themselves out */
  const target = (req: Request, notSelf?: string) => {
    const user = users.getUser(String(req.params.id));
    if (!user) throw new AccountError('Dieses Konto gibt es nicht.', 404);
    if (notSelf && user.id === req.user!.id) throw new AccountError(notSelf, 409);
    return user;
  };

  router.get('/status', (_req, res) => res.json(status()));

  // ---------------------------------------------------------------- accounts

  router.get('/users', (_req, res) => res.json(users.listForAdmin()));

  router.post(
    '/users/:id/ban',
    handle((req, res) => {
      const banned = req.body?.banned === true;
      const user = target(req, banned ? 'Du kannst dich nicht selbst sperren.' : undefined);
      users.setBanned(user.id, banned);
      record(req, `${banned ? 'sperren' : 'entsperren'} ${user.username}`);
      res.json(users.listForAdmin());
    })
  );

  router.post(
    '/users/:id/admin',
    handle((req, res) => {
      const admin = req.body?.admin === true;
      const user = target(req);
      users.setAdmin(user.id, admin);
      record(req, `admin ${admin ? 'an' : 'aus'} ${user.username}`);
      res.json(users.listForAdmin());
    })
  );

  /** New random password, shown once to the admin; the account is signed out everywhere */
  router.post(
    '/users/:id/password-reset',
    handle(async (req, res) => {
      const user = target(req, 'Dein eigenes Passwort änderst du in den Einstellungen.');
      const password = await users.resetPassword(user.id);
      record(req, `passwort zurückgesetzt ${user.username}`);
      res.json({ username: user.username, password });
    })
  );

  /** One-time code with which the account adds a passkey on a new device (passkey-only accounts) */
  router.post(
    '/users/:id/device-link',
    handle((req, res) => {
      const user = target(req);
      if (user.bannedAt) throw new AccountError('Das Konto ist gesperrt.', 409);
      record(req, `gerätecode ${user.username}`);
      res.json({ username: user.username, ...users.createDeviceLink(user.id) });
    })
  );

  // ---------------------------------------------------------------- invites

  router.get('/invites', (_req, res) => res.json(users.listInvites()));

  router.post('/invites', (req, res) => {
    const invite = users.createInvite(typeof req.body?.note === 'string' ? req.body.note : '');
    record(req, `einladung ${invite.code}${invite.note ? ` (${invite.note})` : ''}`);
    res.json(invite);
  });

  router.delete('/invites/:code', (req, res) => {
    const ok = users.deleteInvite(String(req.params.code));
    if (ok) record(req, `einladung gelöscht ${req.params.code}`);
    res.status(ok ? 200 : 404).json(ok ? { ok } : { error: 'Diesen Code gibt es nicht.' });
  });

  // ---------------------------------------------------------------- audit log

  router.get('/audit', (_req, res) => {
    const entries: AdminAuditEntry[] = audit.recent(100).map((e) => ({ at: e.at, event: e.event, username: e.username, ip: e.ip, detail: e.detail }));
    res.json(entries);
  });

  return router;
}
