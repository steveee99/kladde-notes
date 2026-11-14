import express from 'express';
import { parseTasks, setTaskMeta, toggleTask, type PushPayload } from '@kladde/shared';
import { NoteStore } from '../NoteStore.js';
import { UserStore } from '../UserStore.js';
import { handle, rateLimit, requireUser } from '../http.js';
import { PushStore } from './PushStore.js';
import { taskCheck } from './reminders.js';
import { sendPush } from './webpush.js';

export interface PushRouterOptions {
  users: UserStore;
  notes: NoteStore;
  store: PushStore;
  subject: string;
}

/** Settings → Notifications (devices) and the "Done" / "Tomorrow" actions of a reminder */
export function pushRouter({ users, notes, store, subject }: PushRouterOptions): express.Router {
  const router = express.Router();
  router.use(requireUser(users), express.json({ limit: '16kb' }), rateLimit(120, 60_000));

  router.get('/key', (_req, res) => res.json({ publicKey: store.vapidKeys().publicKey }));

  router.get('/devices', (req, res) => res.json(store.list(req.user!.id)));

  router.post(
    '/devices',
    handle((req, res) => {
      res.json(store.subscribe(req.user!.id, req.body?.subscription, req.body?.name, req.body?.settings));
    })
  );

  router.put('/devices/:id', (req, res) => {
    const device = store.updateSettings(req.user!.id, req.params.id, req.body?.settings);
    if (!device) res.status(404).json({ error: 'Gerät nicht gefunden' });
    else res.json(device);
  });

  router.delete('/devices/:id', (req, res) => {
    store.remove(req.user!.id, req.params.id);
    res.json(store.list(req.user!.id));
  });

  router.post(
    '/devices/:id/test',
    handle(async (req, res) => {
      const sub = store.target(req.user!.id, String(req.params.id));
      if (!sub) {
        res.status(404).json({ error: 'Gerät nicht gefunden' });
        return;
      }
      const en = sub.settings.lang === 'en';
      const payload: PushPayload = { title: 'Kladde', body: en ? 'Notifications work on this device.' : 'Benachrichtigungen funktionieren auf diesem Gerät.', tag: 'test', url: '/settings/notifications' };
      const outcome = await sendPush(sub.target, payload, store.vapidKeys(), subject, { urgency: 'high', ttl: 300 });
      if (outcome === 'gone') store.drop(sub.id);
      if (outcome !== 'sent') res.status(502).json({ error: en ? 'The push service did not accept the message.' : 'Der Push-Dienst hat die Nachricht nicht angenommen.' });
      else res.json({ ok: true });
    })
  );

  /** From the service worker: "Done" ticks the task, "Tomorrow" moves its due date to the date the device sends */
  router.post('/action', (req, res) => {
    const { noteId, line, check, action, date } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof noteId !== 'string' || !Number.isInteger(line) || typeof check !== 'string' || (action !== 'done' && action !== 'tomorrow')) {
      res.status(400).json({ error: 'Ungültige Aktion' });
      return;
    }
    if (action === 'tomorrow' && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
      res.status(400).json({ error: 'Ungültiges Datum' });
      return;
    }
    // Reminders only come from the user's own notes, so actions only touch those
    const note = notes.ownedNotes(req.user!.id).find((n) => n.id === noteId);
    const task = note ? parseTasks(note.content).find((t) => t.line === line) : undefined;
    if (!note || !task || taskCheck(task.text) !== check) {
      res.status(409).json({ error: 'Die Aufgabe hat sich inzwischen geändert.' });
      return;
    }
    if (action === 'done' && task.done) {
      res.json({ ok: true });
      return;
    }
    const content = action === 'done' ? toggleTask(note.content, line as number) : setTaskMeta(note.content, line as number, { due: date as string });
    const [result] = notes.push(req.user!.id, [
      { id: note.id, baseVersion: note.version, path: note.path, content, deleted: false, createdAt: note.createdAt, updatedAt: Date.now() },
    ]);
    if (result.status !== 'ok') res.status(409).json({ error: 'Die Notiz wurde gerade geändert.' });
    else res.json({ ok: true });
  });

  return router;
}
