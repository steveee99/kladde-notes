import type { DatabaseSync } from 'node:sqlite';
import { isProcessRunPath, joinPath, parseRunNote, splitPath, type ProcessAction } from '@kladde/shared';
import type { DataCipher } from '../crypto.js';
import type { NoteChangeEvent, NoteStore } from '../NoteStore.js';
import type { NotificationStore } from '../NotificationStore.js';
import type { UserStore } from '../UserStore.js';
import { featuresOf, space, TOOLS, ToolError, type ToolContext } from '../mcp/tools.js';

/*
 * Actions of guided processes (shared/processScript.ts): stage scripts put notifications, new notes and log lines into
 * the run (`run.actions`). Whoever saves the run (the app, an assistant through MCP) only writes them down; this
 * class carries every new one out once, as the person who saved the change:
 * - `notify` reaches only people who can see the run (its audience); `all` leaves out the one who moved it;
 * - `note` creates the note in the run's space with that person's rights and templates, and leaves an existing one;
 * - `log` is only a record.
 * Which actions are done is kept per run note in `process_actions` (the outcome encrypted), so repeated saves, other
 * devices and restored runs do not repeat them. Actions older than `MAX_AGE_MS` are not carried out any more.
 */

/** Actions older than this (a device that was offline for weeks, a run restored from the trash) are left alone */
export const ACTION_MAX_AGE_MS = 14 * 86_400_000;
/** Outcomes are kept this long */
const KEEP_MS = 30 * 86_400_000;

export type ActionStatus = 'done' | 'skipped' | 'failed';

export interface ActionOutcome {
  id: string;
  status: ActionStatus;
  at: number;
  /** What happened, in words (the created note's path, who was notified, why it failed) */
  detail: string;
  /** note: the created (or existing) note */
  noteId?: string;
}

interface Payload {
  status: ActionStatus;
  detail: string;
  noteId?: string;
}

export interface ProcessActionsOptions {
  db: DatabaseSync;
  cipher: DataCipher;
  notes: NoteStore;
  users: UserStore;
  notifications: NotificationStore;
}

export class ProcessActions {
  private queue: NoteChangeEvent[] = [];
  private running: Promise<void> | null = null;

  constructor(private readonly opts: ProcessActionsOptions) {}

  /** Called for every note change: new actions of run notes are queued and carried out right after the save */
  onNoteChange(e: NoteChangeEvent): void {
    if (e.deleted || !e.actorId || e.action || !isProcessRunPath(e.path) || !e.content.includes('"actions"')) return;
    this.queue.push(e);
    if (!this.running) this.running = new Promise<void>((resolve) => setImmediate(() => (this.drain(), (this.running = null), resolve())));
  }

  /** Resolves when the queued changes are carried out (tests) */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private drain(): void {
    while (this.queue.length) {
      const e = this.queue.shift()!;
      try {
        this.handle(e);
      } catch (err) {
        console.error('Process actions failed:', err);
      }
    }
  }

  /** Carries out the new actions of one saved run */
  handle(e: NoteChangeEvent, now = Date.now()): void {
    const run = parseRunNote(e.content);
    if (!run?.actions.length || !e.actorId) return;
    const { db } = this.opts;
    for (const a of run.actions) {
      if (a.kind === 'log' || now - a.at > ACTION_MAX_AGE_MS || a.at > now + 86_400_000) continue;
      // Taken first, so a second save arriving meanwhile does not do it again
      const taken = db.prepare('INSERT OR IGNORE INTO process_actions (note_id, action_id, at, payload) VALUES (?, ?, ?, ?)').run(e.noteId, a.id, now, this.seal(e.noteId, a.id, { status: 'failed', detail: '…' }));
      if (!taken.changes) continue;
      let outcome: Payload;
      try {
        outcome = this.carryOut(e, run.owner, run.title, a);
      } catch (err) {
        outcome = { status: 'failed', detail: err instanceof ToolError ? err.message : 'Unerwarteter Fehler' };
        if (!(err instanceof ToolError)) console.error('Process action failed:', err);
      }
      db.prepare('UPDATE process_actions SET payload = ? WHERE note_id = ? AND action_id = ?').run(this.seal(e.noteId, a.id, outcome), e.noteId, a.id);
    }
    db.prepare('DELETE FROM process_actions WHERE at < ?').run(now - KEEP_MS);
  }

  private carryOut(e: NoteChangeEvent, owner: string, title: string, a: ProcessAction): Payload {
    const { notes, users } = this.opts;
    const actorId = e.actorId!;
    if (!featuresOf(notes, actorId).cockpit.enabled) return { status: 'skipped', detail: 'Prozesse sind ausgeschaltet.' };
    if (a.kind === 'notify') return this.notify(e, owner, title, a);
    // note: as the person who moved the run, in the run's space
    const ctx: ToolContext = { userId: actorId, canWrite: true, notes, agent: users.getUser(actorId)?.username };
    const group = e.ownerId === actorId ? undefined : notes.groupsOf(actorId).find((g) => g.id === e.ownerId);
    if (e.ownerId !== actorId && !group) return { status: 'skipped', detail: 'Der Lauf liegt nicht im eigenen Bereich oder einer Gruppe.' };
    const { folder, name } = splitPath(`${a.path}.md`);
    const target = joinPath(folder, name);
    const existing = space(ctx).find((n) => (group ? n.group === group.id : !n.group && n.access === 'owner') && (n.realPath ?? n.path) === target);
    if (existing) return { status: 'skipped', detail: `Gibt es schon: ${a.path}`, noteId: existing.id };
    const args: Record<string, unknown> = { title: name, folder, ...(group ? { group: group.name } : {}) };
    const tool = TOOLS.find((t) => t.name === (a.template ? 'create_from_template' : 'create_note'))!;
    const result = tool.run(a.template ? { ...args, template: a.template } : { ...args, content: '' }, ctx) as { id: string; path: string };
    return { status: 'done', detail: result.path.replace(/\.md$/, ''), noteId: result.id };
  }

  private notify(e: NoteChangeEvent, owner: string, title: string, a: ProcessAction): Payload {
    const { users, notifications } = this.opts;
    const audience = new Set(e.audience);
    const ids = new Set<string>();
    const unknown: string[] = [];
    for (const raw of (a.to ?? '').split(/[\s,;]+/).filter(Boolean).slice(0, 30)) {
      const word = raw.replace(/^@/, '');
      const lower = word.toLowerCase();
      // `all` means the others who see the run
      if (lower === 'all' || lower === 'alle') for (const id of audience) id !== e.actorId && ids.add(id);
      else if (lower === 'me' || lower === 'ich') ids.add(e.actorId!);
      else {
        const user = users.findByUsername(lower === 'owner' || lower === 'besitzer' ? owner : word);
        if (user && audience.has(user.id)) ids.add(user.id);
        else unknown.push(raw);
      }
    }
    const reached: string[] = [];
    for (const id of ids) {
      const user = users.getUser(id);
      if (!user || user.bannedAt) continue;
      notifications.add({ userId: id, kind: 'process', noteId: e.noteId, actorId: e.actorId!, path: title, text: a.text ?? '' });
      reached.push(user.username);
    }
    const missing = unknown.length ? ` Nicht erreicht: ${unknown.join(', ')} (unbekannt oder ohne Zugriff auf den Lauf).` : '';
    if (!reached.length) return { status: unknown.length ? 'failed' : 'skipped', detail: `Niemand benachrichtigt.${missing}` };
    return { status: 'done', detail: `Benachrichtigt: ${reached.join(', ')}.${missing}` };
  }

  /** What became of a run's actions (for whoever can open the run) */
  outcomes(noteId: string): ActionOutcome[] {
    const rows = this.opts.db.prepare('SELECT action_id, at, payload FROM process_actions WHERE note_id = ? ORDER BY at').all(noteId) as { action_id: string; at: number; payload: Uint8Array }[];
    return rows.map((r) => {
      const p = this.opts.cipher.decryptJson<Payload>(r.payload, `process-action:${noteId}:${r.action_id}`);
      return { id: r.action_id, at: r.at, status: p.status, detail: p.detail, ...(p.noteId ? { noteId: p.noteId } : {}) };
    });
  }

  private seal(noteId: string, actionId: string, p: Payload): Uint8Array {
    return this.opts.cipher.encryptJson(p, `process-action:${noteId}:${actionId}`);
  }
}
