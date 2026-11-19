import express from 'express';
import type { UserRecord, UserStore } from '../UserStore.js';
import type { AuditLog } from '../security/AuditLog.js';
import { requireUser } from '../http.js';
import type { AccountExportService } from './AccountExport.js';

/** `/api/account-export` (#93): start, poll, download once, discard */
export function accountExportRouter(deps: { users: UserStore; exports: AccountExportService; audit: AuditLog; standaloneUser?: UserRecord }): express.Router {
  const router = express.Router();
  router.use(requireUser(deps.users, deps.standaloneUser));
  const who = (req: express.Request) => ({ userId: req.user!.id, username: req.user!.username, ip: req.ip ?? null });

  router.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ export: deps.exports.status(req.user!.id) });
  });

  router.post('/', express.json({ limit: '4kb' }), (req, res) => {
    const history = req.body?.history === true;
    const before = deps.exports.status(req.user!.id);
    const status = deps.exports.start(req.user!, { history });
    if (before?.id !== status.id) deps.audit.record('account_export_requested', { ...who(req), detail: history ? 'with history' : undefined });
    res.status(202).json({ export: status });
  });

  router.get('/:id/download', (req, res) => {
    const date = new Date().toISOString().slice(0, 10);
    const ok = deps.exports.download(req.user!.id, req.params.id, res, () => {
      deps.audit.record('account_exported', who(req));
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="kladde-${date}.zip"`);
      res.setHeader('Cache-Control', 'no-store');
    });
    if (!ok) res.status(404).json({ error: 'Kein Export zum Herunterladen (abgelaufen oder schon heruntergeladen).' });
  });

  router.delete('/', (req, res) => {
    deps.exports.discard(req.user!.id);
    res.json({ ok: true });
  });

  return router;
}
