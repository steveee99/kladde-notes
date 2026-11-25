import express, { Request } from 'express';
import type { AdminUser, AdminAuditEntry, AdminOverview, AdminStatus } from '@kladde/shared';
import { AccountError, UserStore } from '../UserStore.js';
import { AuditLog } from '../security/AuditLog.js';
import { handle, requireUser } from '../http.js';
import type { BackupService } from '../backup/BackupService.js';
import type { StorageStore } from '../StorageStore.js';
import type { RemoteInstances } from '../remote/RemoteInstances.js';
import type { RemoteFetcher } from '../remote/RemoteFetcher.js';
import { tarSize, writeTar } from '../backup/tar.js';

export interface AdminRouterOptions {
  users: UserStore;
  /** Storage usage and quotas (#91) */
  storage: StorageStore;
  audit: AuditLog;
  status: () => AdminStatus;
  /** The dashboard (counts, machine, online users, recent jobs) */
  overview?: () => AdminOverview;
  /** Access to GitLab and GitHub for remote notes */
  remote?: { instances: RemoteInstances; fetcher: RemoteFetcher };
  /** Backups (#65); missing for an in-memory database */
  backups?: BackupService;
  /** Called after a restore was prepared and answered: the server has to restart to apply it */
  onRestore?: () => void;
  /** Turns away every other API request while the restore is pending */
  enterMaintenance?: () => void;
}

/** Admin area of the web app: accounts, invites, password resets and the audit log (admins only) */
export function adminRouter({ users, storage, audit, status, overview, remote, backups, onRestore, enterMaintenance }: AdminRouterOptions): express.Router {
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
  router.get('/overview', (_req, res) => (overview ? res.json(overview()) : res.status(404).json({ error: 'Nicht verfügbar' })));

  // ---------------------------------------------------------------- accounts

  const userList = (): AdminUser[] => users.listForAdmin().map((u) => ({ ...u, storage: storage.usage(u.id) }));

  router.get('/users', (_req, res) => res.json(userList()));

  router.post(
    '/users/:id/ban',
    handle((req, res) => {
      const banned = req.body?.banned === true;
      const user = target(req, banned ? 'Du kannst dich nicht selbst sperren.' : undefined);
      users.setBanned(user.id, banned);
      record(req, `${banned ? 'sperren' : 'entsperren'} ${user.username}`);
      res.json(userList());
    })
  );

  router.post(
    '/users/:id/admin',
    handle((req, res) => {
      const admin = req.body?.admin === true;
      const user = target(req);
      users.setAdmin(user.id, admin);
      record(req, `admin ${admin ? 'an' : 'aus'} ${user.username}`);
      res.json(userList());
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

  // ---------------------------------------------------------------- storage (#91)

  router.get('/storage/groups', (_req, res) => res.json(storage.groups()));

  /** `{ mb: number }` sets a limit, `{ mb: 0 }` means unlimited, `{ mb: null }` falls back to the server default; works for accounts and groups */
  router.put(
    '/storage/:id/quota',
    handle((req, res) => {
      const id = String(req.params.id);
      const owner = storage.ownerName(id);
      if (!owner) throw new AccountError('Dieses Konto gibt es nicht.', 404);
      const mb = req.body?.mb;
      if (mb !== null && (typeof mb !== 'number' || !Number.isFinite(mb) || mb < 0)) throw new AccountError('Ungültiges Limit.', 400);
      storage.setQuota(id, mb === null ? null : mb === 0 ? 'unlimited' : mb * 1024 * 1024);
      record(req, `speicherlimit ${owner}: ${mb === null ? 'standard' : mb === 0 ? 'unbegrenzt' : `${mb} MB`}`);
      res.json({ storage: storage.usage(id) });
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

  // ---------------------------------------------------------------- backups (#65)

  const backupService = () => {
    if (!backups) throw new AccountError('Sicherungen sind ohne Datenbankdatei nicht verfügbar.', 404);
    return backups;
  };

  router.get(
    '/backups',
    handle((_req, res) => res.json(backupService().overview()))
  );

  router.post(
    '/backups',
    handle(async (req, res) => {
      const backup = await backupService().create('manual');
      record(req, `sicherung erstellt ${backup.id}`);
      res.json(backupService().overview());
    })
  );

  router.put(
    '/backups/schedule',
    handle((req, res) => {
      const schedule = backupService().setSchedule({ enabled: req.body?.enabled, keep: req.body?.keep });
      record(req, `tägliche sicherung ${schedule.enabled ? `an (${schedule.keep} behalten)` : 'aus'}`);
      res.json(backupService().overview());
    })
  );

  router.delete(
    '/backups/:id',
    handle((req, res) => {
      const id = String(req.params.id);
      if (!backupService().remove(id)) throw new AccountError('Diese Sicherung gibt es nicht.', 404);
      record(req, `sicherung gelöscht ${id}`);
      res.json(backupService().overview());
    })
  );

  router.get(
    '/backups/:id/download',
    handle(async (req, res) => {
      const id = String(req.params.id);
      const download = backupService().download(id);
      if (!download) throw new AccountError('Diese Sicherung gibt es nicht.', 404);
      record(req, `sicherung heruntergeladen ${id}`);
      res.setHeader('Cache-Control', 'no-store');
      if (download.kind === 'file') {
        res.download(download.file, download.filename);
        return;
      }
      res.setHeader('Content-Type', 'application/x-tar');
      res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
      res.setHeader('Content-Length', String(tarSize(download.entries)));
      try {
        await writeTar(download.entries, res);
        res.end();
      } catch (err) {
        // The download was cancelled or a file vanished: the archive is incomplete either way
        console.error('Backup download failed:', err);
        res.destroy();
      }
    })
  );

  /** Restores a full backup: safety backup, marker, then a restart that applies it before the database opens */
  router.post(
    '/backups/:id/restore',
    handle(async (req, res) => {
      const id = String(req.params.id);
      const service = backupService();
      if (req.body?.confirm !== id) throw new AccountError('Bitte die Wiederherstellung bestätigen.', 400);
      if (!onRestore) throw new AccountError('Wiederherstellen ist hier nicht möglich.', 409);
      const { safetyBackup } = await service.requestRestore(id, req.user!.username);
      audit.record('backup_restore_requested', {
        userId: req.user!.id,
        username: req.user!.username,
        ip: req.ip,
        detail: `${id} (vorher gesichert: ${safetyBackup.id})`,
      });
      enterMaintenance?.();
      res.on('finish', () => setTimeout(onRestore, 250));
      res.json({ restarting: true, safetyBackup: safetyBackup.id });
    })
  );

  // ---------------------------------------------------------------- GitLab and GitHub access for remote notes

  if (remote) {
    const { instances, fetcher } = remote;
    const urlOf = (id: string) => instances.list().find((i) => i.id === id)?.url ?? '';
    // Tokens go in, never out: every answer is the list without them
    router.get('/remote', (_req, res) => res.json(instances.list()));

    router.post(
      '/remote',
      handle((req, res) => {
        const id = instances.put(null, req.body);
        record(req, `gitlab/github-zugang angelegt ${urlOf(id)}`);
        res.json(instances.list());
      })
    );

    router.put(
      '/remote/:id',
      handle((req, res) => {
        const id = instances.put(String(req.params.id), req.body);
        record(req, `gitlab/github-zugang geändert ${urlOf(id)}`);
        res.json(instances.list());
      })
    );

    router.delete(
      '/remote/:id',
      handle((req, res) => {
        const url = instances.remove(String(req.params.id));
        if (!url) throw new AccountError('Diesen Zugang gibt es nicht.', 404);
        record(req, `gitlab/github-zugang gelöscht ${url}`);
        res.json(instances.list());
      })
    );

    router.post(
      '/remote/:id/test',
      handle(async (req, res) => {
        const instance = instances.get(String(req.params.id));
        if (!instance) throw new AccountError('Diesen Zugang gibt es nicht.', 404);
        res.json(await fetcher.test(instance));
      })
    );
  }

  // ---------------------------------------------------------------- audit log

  router.get('/audit', (_req, res) => {
    const entries: AdminAuditEntry[] = audit.recent(100).map((e) => ({ at: e.at, event: e.event, username: e.username, ip: e.ip, detail: e.detail }));
    res.json(entries);
  });

  return router;
}
