/*
 * Calendar view (#72): which days a month, week or agenda shows, and what is on each day: tasks by due date
 * (with their reminder time), daily notes and notes with a date property (`date:`, `deadline:`).
 */

import { isValidDateString, shiftDateString } from './daily.js';
import { parseFrontmatter } from './markdown.js';
import { periodDays, periodStart } from './periodic.js';
import { tagMatches } from './tags.js';
import type { TaskStatus } from './tasks.js';

export type CalendarMode = 'month' | 'week' | 'agenda';

/** Days the agenda shows from its first day on */
export const AGENDA_DAYS = 14;

/** The days of the view around `anchor`: six full weeks for a month, Monday to Sunday for a week, two weeks for the agenda */
export function calendarDays(mode: CalendarMode, anchor: string): string[] {
  if (mode === 'week') return periodDays('week', anchor);
  if (mode === 'agenda') return Array.from({ length: AGENDA_DAYS }, (_, i) => shiftDateString(anchor, i));
  const first = periodStart('week', periodStart('month', anchor));
  return Array.from({ length: 42 }, (_, i) => shiftDateString(first, i));
}

/** The anchor of the previous or next page: a month, a week or the next two weeks */
export function shiftCalendar(mode: CalendarMode, anchor: string, delta: number): string {
  if (mode === 'month') {
    const [y, m] = periodStart('month', anchor).split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }
  return shiftDateString(mode === 'week' ? periodStart('week', anchor) : anchor, delta * (mode === 'week' ? 7 : AGENDA_DAYS));
}

export interface CalendarTask {
  noteId: string;
  line: number;
  text: string;
  done: boolean;
  status: TaskStatus;
  due: string | null;
  time: string | null;
  /** The due date comes from the daily note the task is in */
  dueFromNote?: boolean;
  /** Folder of the note ('' for the top level and free tasks) */
  folder: string;
  noteTitle: string;
}

export interface PlannerNote {
  id: string;
  path: string;
  content: string;
  title: string;
}

export type CalendarEntry =
  | { kind: 'task'; date: string; time: string | null; task: CalendarTask }
  | { kind: 'daily'; date: string; noteId: string; title: string }
  | { kind: 'note'; date: string; noteId: string; title: string; field: string };

export interface CalendarFilter {
  status?: 'all' | 'open' | 'doing' | 'blocked';
  /** Folder of the note, with its subfolders; undefined for all */
  folder?: string;
  /** Tag of the task's text or its note; undefined for all */
  tag?: string;
  showDone?: boolean;
  /** Notes with a date property (`date`, `deadline` by default) */
  dateFields?: string[];
}

export const DATE_FIELDS = ['date', 'deadline'];

// One tag at a time, from a `#`; the character class has no overlap with the `#`, so matching stays linear
const TAG = /#([\p{L}\p{N}_/-]+)/gu;

/** Tags written in a task's text */
export function taskTags(text: string): string[] {
  return [...text.matchAll(TAG)].map((m) => m[1].toLowerCase());
}

const inFolder = (folder: string, filter: string) => folder === filter || folder.startsWith(`${filter}/`);

/** A YYYY-MM-DD at the start of a property value (`2026-11-20`, `2026-11-20 14:00`) */
function dateOf(value: string | undefined): string | null {
  const d = value?.trim().slice(0, 10) ?? '';
  return isValidDateString(d) ? d : null;
}

/**
 * Everything on the days `[from, to]` by day, in the order: daily note, tasks with a time (by time), other tasks,
 * notes with a date. `dailyDate` reads a daily note's day from its path; `noteTags` gives the tags of a note.
 */
export function calendarEntries(
  tasks: CalendarTask[],
  notes: PlannerNote[],
  from: string,
  to: string,
  opts: { dailyDate?: (path: string) => string | null; noteTags?: (noteId: string) => string[]; filter?: CalendarFilter } = {}
): Map<string, CalendarEntry[]> {
  const f = opts.filter ?? {};
  const out = new Map<string, CalendarEntry[]>();
  const add = (e: CalendarEntry) => {
    if (e.date < from || e.date > to) return;
    const list = out.get(e.date);
    if (list) list.push(e);
    else out.set(e.date, [e]);
  };
  const tagOk = (noteId: string, text: string) =>
    !f.tag || taskTags(text).some((t) => tagMatches(t, f.tag!)) || (opts.noteTags?.(noteId) ?? []).some((t) => tagMatches(t, f.tag!));
  for (const task of tasks) {
    if (!task.due) continue;
    if (task.done ? !f.showDone : f.status && f.status !== 'all' && task.status !== f.status) continue;
    if (f.folder !== undefined && !inFolder(task.folder, f.folder)) continue;
    if (!tagOk(task.noteId, task.text)) continue;
    add({ kind: 'task', date: task.due, time: task.time, task });
  }
  const fields = f.dateFields ?? [];
  for (const n of notes) {
    const folder = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
    if (f.folder !== undefined && !inFolder(folder, f.folder)) continue;
    if (f.tag && !(opts.noteTags?.(n.id) ?? []).some((t) => tagMatches(t, f.tag!))) continue;
    const daily = opts.dailyDate?.(n.path);
    if (daily) {
      add({ kind: 'daily', date: daily, noteId: n.id, title: n.title });
      continue;
    }
    if (!fields.length || !n.content.startsWith('---')) continue;
    const { data } = parseFrontmatter(n.content);
    for (const field of fields) {
      const date = dateOf(data[field]);
      if (date) add({ kind: 'note', date, noteId: n.id, title: n.title, field });
    }
  }
  const rank = (e: CalendarEntry) => (e.kind === 'daily' ? 0 : e.kind === 'task' ? (e.time ? 1 : 2) : 3);
  for (const list of out.values()) {
    list.sort((a, b) => rank(a) - rank(b) || (a.kind === 'task' && b.kind === 'task' ? (a.time ?? '').localeCompare(b.time ?? '') || Number(a.task.done) - Number(b.task.done) : 0));
  }
  return out;
}
