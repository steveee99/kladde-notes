import express from 'express';
import { isTicketContent, runAutomations, splitPath, ticketIdsInMergeRequest, ticketMeta, type MergeRequestInfo, type TicketEvent } from '@kladde/shared';
import { NoteStore } from '../NoteStore.js';
import { UserStore, type UserRecord } from '../UserStore.js';
import { AuditLog } from '../security/AuditLog.js';
import { handle, rateLimit, requireUser } from '../http.js';
import { TicketHookStore, type ResolvedHook } from './TicketHookStore.js';
import { gitEventOf, verifyDelivery } from './gitEvents.js';

export interface TicketHookOptions {
  users: UserStore;
  notes: NoteStore;
  hooks: TicketHookStore;
  audit: AuditLog;
  publicUrl: string | null;
  standaloneUser?: UserRecord;
}

/** Largest delivery accepted (GitHub sends the whole pull request with its repository) */
const MAX_BODY = '2mb';

export interface DeliveryResult {
  ok: boolean;
  status: number;
  summary: string;
  tickets: { ticket: string; automations: string[]; skipped: string[] }[];
}

/**
 * Runs the project's automations for a merge request event on every ticket it names. Changes go through
 * `NoteStore.push` as the hook's creator, who must still manage the project; the automations already checked the
 * transitions (or may skip them), so the push trusts them, and its own automations (status changed) follow.
 */
export function applyGitEvent(notes: NoteStore, users: UserStore, hook: Pick<ResolvedHook, 'noteId' | 'createdBy'>, event: Extract<TicketEvent, { mr: MergeRequestInfo }>): DeliveryResult {
  const project = notes.projectOf(hook.noteId);
  if (!project) return { ok: false, status: 410, summary: 'Das Projekt gibt es nicht mehr.', tickets: [] };
  const creator = users.getUser(hook.createdBy);
  if (!creator || creator.bannedAt || !notes.manages(hook.createdBy, hook.noteId)) return { ok: false, status: 403, summary: 'Wer den Webhook angelegt hat, darf das Projekt nicht mehr ändern.', tickets: [] };
  const ids = ticketIdsInMergeRequest(event.mr, project.config.key);
  if (!ids.length) return { ok: true, status: 200, summary: `Kein Ticket von ${project.config.key} genannt.`, tickets: [] };
  const tickets = notes.ownedNotes(project.ownerId).filter((n) => splitPath(n.path).folder === project.folder && isTicketContent(n.content));
  const out: DeliveryResult['tickets'] = [];
  for (const id of ids) {
    const note = tickets.find((n) => ticketMeta(n.content).id?.toUpperCase() === id);
    if (!note) continue;
    const run = runAutomations(project.config, note.content, [event], { actor: creator.username });
    const entry = { ticket: id, automations: run.applied.map((a) => a.name || a.id), skipped: run.skipped.map((s) => `${s.name || s.id}: ${s.reason}`) };
    if (run.content !== note.content) {
      const [result] = notes.push(hook.createdBy, [{ id: note.id, baseVersion: note.version, path: note.path, content: run.content, deleted: false, createdAt: note.createdAt, updatedAt: Date.now() }], { trusted: true });
      if (result.status === 'ok' && result.automations) entry.automations.push(...result.automations);
      if (result.status !== 'ok') entry.skipped.push(`push: ${result.status}`);
    }
    out.push(entry);
  }
  const changed = out.filter((t) => t.automations.length);
  const summary = !out.length
    ? `Genannte Tickets nicht gefunden: ${ids.join(', ')}.`
    : changed.length
      ? changed.map((t) => `${t.ticket}: ${t.automations.join(', ')}`).join('; ')
      : `Keine Automatisierung passte (${out.map((t) => t.ticket).join(', ')}).`;
  return { ok: true, status: 200, summary, tickets: out };
}

/**
 * `receiver` takes the deliveries of GitLab and GitHub (no cookies: the hook id finds the hook, the secret proves
 * the sender); `accountRouter` lets project managers list, create and remove the webhooks of a project.
 */
export function ticketHookRouters(opts: TicketHookOptions): { receiver: express.Router; accountRouter: express.Router } {
  const { users, notes, hooks, audit } = opts;

  const receiver = express.Router();
  receiver.use(rateLimit(120, 60_000));
  receiver.post('/:id', express.raw({ type: () => true, limit: MAX_BODY }), (req, res) => {
    const hook = hooks.resolve(req.params.id);
    if (!hook) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyDelivery(hook.provider, req.headers, body, hook.secret)) {
      res.status(401).json({ error: 'Invalid secret' });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      hooks.recordDelivery(hook.id, false, 'Kein JSON – bei GitHub „application/json“ als Content type wählen.');
      res.status(400).json({ error: 'Expected JSON' });
      return;
    }
    const event = gitEventOf(hook.provider, req.headers, payload);
    if (!event) {
      // Pings and other events: answered, nothing to do
      res.status(202).json({ ignored: true });
      return;
    }
    const result = applyGitEvent(notes, users, hook, event);
    hooks.recordDelivery(hook.id, result.ok, `${event.type}: ${result.summary}`);
    res.status(result.status).json({ ok: result.ok, summary: result.summary, tickets: result.tickets });
  });

  const accountRouter = express.Router();
  accountRouter.use(requireUser(users, opts.standaloneUser), express.json({ limit: '16kb' }));
  const baseUrl = (req: express.Request) => (opts.publicUrl ?? `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const managed = (req: express.Request, res: express.Response): string | null => {
    const noteId = String(req.params.project ?? '');
    if (!notes.manages(req.user!.id, noteId) || !notes.projectOf(noteId)) {
      res.status(404).json({ error: 'Projekt nicht gefunden' });
      return null;
    }
    return noteId;
  };

  accountRouter.get('/:project', (req, res) => {
    const noteId = managed(req, res);
    if (noteId) res.json(hooks.list(noteId, (id) => users.getUser(id)?.username ?? null, baseUrl(req)));
  });

  accountRouter.post(
    '/:project',
    handle((req, res) => {
      const noteId = managed(req, res);
      if (!noteId) return;
      const { id, secret } = hooks.create(noteId, req.user!.id, req.body?.provider, req.body?.name);
      audit.record('ticket_hook_created', { userId: req.user!.id, username: req.user!.username, ip: req.ip, detail: String(req.body?.provider) });
      const hook = hooks.list(noteId, (uid) => users.getUser(uid)?.username ?? null, baseUrl(req)).find((h) => h.id === id)!;
      res.json({ hook, secret });
    })
  );

  accountRouter.delete('/:project/:id', (req, res) => {
    const noteId = managed(req, res);
    if (!noteId) return;
    if (hooks.remove(noteId, req.params.id)) audit.record('ticket_hook_removed', { userId: req.user!.id, username: req.user!.username, ip: req.ip });
    res.json(hooks.list(noteId, (id) => users.getUser(id)?.username ?? null, baseUrl(req)));
  });

  return { receiver, accountRouter };
}
