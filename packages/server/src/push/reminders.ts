import crypto from 'crypto';
import { SYSTEM_PREFIX, extractMeta, parseDate, parseTasks, type PushPayload, type PushSettings } from '@kladde/shared';
import type { NoteStore } from '../NoteStore.js';
import { taskDueOf } from '../mcp/tools.js';
import type { PushStore } from './PushStore.js';
import { sendPush } from './webpush.js';

/** A reminder that comes later than this (server was down, device subscribed late) is skipped */
const LATE_MINUTES = 120;

export interface LocalClock {
  /** Local date "YYYY-MM-DD" */
  date: string;
  /** Minutes since local midnight */
  minutes: number;
}

/** Date and time of `now` in the device's time zone */
export function localClock(now: Date, timeZone: string): LocalClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is `minutes` inside the quiet hours (which may wrap midnight, e.g. 22:00–07:00)? */
export function inQuietHours(minutes: number, settings: Pick<PushSettings, 'quietStart' | 'quietEnd'>): boolean {
  if (!settings.quietStart || !settings.quietEnd) return false;
  const start = toMinutes(settings.quietStart);
  const end = toMinutes(settings.quietEnd);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * When a notification planned for `at` may go out: at once, or when the quiet hours end (same day only;
 * a reminder silenced until the next morning is left to the digest)
 */
function effectiveTime(at: number, settings: PushSettings): number | null {
  if (!inQuietHours(at, settings)) return at;
  const end = toMinutes(settings.quietEnd!);
  return end > at ? end : null;
}

/** Short check of a task's text, so an action from an old notification does not hit a line that changed meanwhile */
export const taskCheck = (text: string) => crypto.createHash('sha256').update(text).digest('base64url').slice(0, 12);

const TEXT = {
  de: {
    due: (time: string) => `Aufgabe fällig um ${time}`,
    digest: (today: number, overdue: number) =>
      [today ? `${today} ${today === 1 ? 'Aufgabe' : 'Aufgaben'} heute fällig` : '', overdue ? `${overdue} überfällig` : ''].filter(Boolean).join(', '),
  },
  en: {
    due: (time: string) => `Task due at ${time}`,
    digest: (today: number, overdue: number) =>
      [today ? `${today} ${today === 1 ? 'task' : 'tasks'} due today` : '', overdue ? `${overdue} overdue` : ''].filter(Boolean).join(', '),
  },
};

export interface PlannedPush {
  /** Each key goes to a device once */
  key: string;
  /** null: only mark the key as handled (e.g. an empty digest) */
  payload: PushPayload | null;
}

/** The notifications a device should get now */
export function plannedPushes(
  notes: { id: string; path: string; content: string }[],
  settings: PushSettings,
  clock: LocalClock,
  defaultDue: (path: string) => string | null = () => null
): PlannedPush[] {
  if (inQuietHours(clock.minutes, settings)) return [];
  const t = TEXT[settings.lang];
  const today = parseDate(clock.date);
  const out: PlannedPush[] = [];
  let dueToday = 0;
  let overdue = 0;
  for (const note of notes) {
    let title: string | null = null;
    for (const task of parseTasks(note.content, today, defaultDue(note.path))) {
      if (task.done || !task.due) continue;
      if (task.due < clock.date) overdue++;
      if (task.due !== clock.date) continue;
      dueToday++;
      if (!task.time) continue;
      const at = effectiveTime(toMinutes(task.time), settings);
      if (at === null || clock.minutes < at || clock.minutes - at > LATE_MINUTES) continue;
      title ??= extractMeta(note.path, note.content).title;
      out.push({
        key: `task|${note.id}|${task.due}|${task.time}|${task.text}`,
        payload: {
          title: settings.showText ? task.text.slice(0, 120) : 'Kladde',
          body: settings.showText ? `${title} · ${task.time}` : t.due(task.time),
          tag: `task-${taskCheck(`${note.id}|${task.line}|${task.text}`)}`,
          url: `/n/${note.id}?line=${task.line + 1}`,
          task: { noteId: note.id, line: task.line, check: taskCheck(task.text) },
          lang: settings.lang,
        },
      });
    }
  }
  if (settings.digestTime) {
    const at = effectiveTime(toMinutes(settings.digestTime), settings);
    if (at !== null && clock.minutes >= at && clock.minutes - at <= LATE_MINUTES) {
      out.push({
        key: `digest|${clock.date}`,
        payload: dueToday || overdue ? { title: 'Kladde', body: t.digest(dueToday, overdue), tag: 'digest', url: '/' } : null,
      });
    }
  }
  return out;
}

/** Subject of the VAPID token: who runs this server (push services may contact it) */
export function vapidSubject(env: NodeJS.ProcessEnv, publicUrl: string | null): string {
  const configured = env.VAPID_SUBJECT?.trim();
  if (configured && /^(mailto:|https:\/\/)/.test(configured)) return configured;
  if (publicUrl?.startsWith('https://')) return publicUrl;
  return 'https://github.com/steveee99/kladde-notes';
}

/** One run of the reminder job: plans and sends what is due on every device */
export async function runReminders(store: PushStore, notes: NoteStore, subject: string, now = new Date()): Promise<number> {
  const subs = store.all();
  if (!subs.length) return 0;
  const byUser = new Map<string, { notes: { id: string; path: string; content: string }[]; dueOf: (p: string) => string | null }>();
  const sends: Promise<void>[] = [];
  for (const sub of subs) {
    let space = byUser.get(sub.userId);
    if (!space) {
      space = { notes: notes.ownedNotes(sub.userId).filter((n) => !n.path.startsWith(SYSTEM_PREFIX)), dueOf: taskDueOf(notes, sub.userId) };
      byUser.set(sub.userId, space);
    }
    for (const planned of plannedPushes(space.notes, sub.settings, localClock(now, sub.settings.timeZone), space.dueOf)) {
      // Claimed before sending: a slow push service never leads to a second notification
      if (!store.claim(sub.id, planned.key, now.getTime()) || !planned.payload) continue;
      const payload = planned.payload;
      sends.push(
        sendPush(sub.target, payload, store.vapidKeys(), subject, { urgency: 'high', topic: payload.tag.replace(/[^\w-]/g, '').slice(0, 32) }).then((outcome) => {
          if (outcome === 'gone') store.drop(sub.id);
        })
      );
    }
  }
  await Promise.all(sends);
  store.pruneSent(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  return sends.length;
}
