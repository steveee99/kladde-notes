import { applyWidget, isDashboardPath, parseDashboardNote, type CockpitRow, type CockpitWidget, type FeatureSettings } from '@kladde/shared';
import type { NoteChangeEvent } from '../NoteStore.js';
import type { NotificationStore } from '../NotificationStore.js';
import type { CockpitService } from './CockpitService.js';

/** How often a dashboard with notifying widgets is read */
export const WATCH_INTERVAL_MS = 5 * 60_000;
/** Dashboards read per run of the job (one run a minute) */
const BATCH = 10;
const QUIET_RETRY_MS = 30 * 60_000;

export interface CockpitWatchOptions {
  service: CockpitService;
  notifications: NotificationStore;
  /** The owner is a person (not a group): only own dashboards notify, and only their owner */
  isPerson: (userId: string) => boolean;
  features: (userId: string) => FeatureSettings;
}

/** One line per new row: what a notification shows */
function describe(w: CockpitWidget, rows: CockpitRow[]): string {
  const title = (r: CockpitRow) => {
    const v = r.values;
    const main = String(v.name ?? v.title ?? v.key ?? v.iid ?? r.id);
    const where = v.project ? ` · ${String(v.project)}` : '';
    const ref = v.ref ? ` (${String(v.ref)})` : '';
    return `${main}${where}${ref}`;
  };
  const lines = rows.slice(0, 3).map(title);
  if (rows.length > 3) lines.push(`+${rows.length - 3}`);
  return lines.join('\n');
}

/**
 * Notifications of the cockpit: widgets with `notify` on a person's own dashboard are read every few minutes with
 * that person's connections; rows that were not there at the last read become one notification per widget (in the
 * app and as Web Push). The first read only remembers what is there.
 */
export class CockpitWatch {
  private ticking = false;

  constructor(private readonly opts: CockpitWatchOptions) {}

  /** Keeps the list of notifying dashboards in step with the notes */
  onNoteChange(e: NoteChangeEvent): void {
    try {
      const store = this.opts.service.store;
      if (!isDashboardPath(e.path) && !(e.previousPath && isDashboardPath(e.previousPath))) return;
      const dashboard = e.deleted || !isDashboardPath(e.path) ? null : parseDashboardNote(e.content);
      const notifying = dashboard?.widgets.filter((w) => w.notify) ?? [];
      if (!dashboard || !notifying.length || !this.opts.isPerson(e.ownerId)) store.dropWatch(e.noteId);
      else store.setWatch(e.noteId, e.ownerId, dashboard.vars, notifying);
    } catch (err) {
      console.error('Cockpit watch bookkeeping failed:', err);
    }
  }

  /** One run of the job; returns how many dashboards were read */
  async tick(now = Date.now()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const ids = this.opts.service.store.due(now, BATCH);
      for (const id of ids) await this.check(id, now).catch((err) => console.error('Cockpit watch failed:', err));
      return ids.length;
    } finally {
      this.ticking = false;
    }
  }

  async check(noteId: string, now = Date.now()): Promise<void> {
    const { service, notifications } = this.opts;
    const store = service.store;
    const watch = store.watch(noteId);
    if (!watch) return;
    if (!this.opts.features(watch.userId).cockpit.enabled) return void store.postpone(noteId, now + QUIET_RETRY_MS);
    const seen = { ...watch.payload.seen };
    for (const w of watch.payload.widgets) {
      let rows: CockpitRow[];
      try {
        const got = await service.rows(watch.userId, w, watch.payload.vars, true);
        if ('missing' in got) continue;
        rows = applyWidget(got.rows, { ...w, limit: 500 }, now).rows;
      } catch {
        // Not connected, no access, unreachable: tried again at the next run
        continue;
      }
      const before = seen[w.id];
      const fresh = before ? rows.filter((r) => !before.includes(r.id)) : [];
      seen[w.id] = rows.map((r) => r.id);
      if (fresh.length) {
        notifications.add({ userId: watch.userId, kind: 'cockpit', noteId, actorId: watch.userId, path: w.title, text: describe(w, fresh) }, now);
      }
    }
    store.saveSeen(noteId, seen, now + WATCH_INTERVAL_MS);
  }
}
