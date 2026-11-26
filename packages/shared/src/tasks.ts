/**
 * Tasks are ordinary Markdown checkboxes anywhere in a note:
 *
 *   - [ ] Steuer machen 📅 2026-11-30 🔁 monatlich
 *   - [ ] Müll rausbringen due:morgen every:week
 *
 * Due date: "📅 YYYY-MM-DD" or "due:YYYY-MM-DD", or a relative word turned into a date on save (`DUE_WORDS`):
 * due:heute/today, morgen/tomorrow, übermorgen, a weekday (freitag/friday/fri: the next one after today),
 * in-3-tagen/in-2-weeks/in-1-monat, nächste-woche/next-week (Monday), nächster-monat/next-month (the 1st),
 * ende-woche/end-of-week (Sunday), ende-monat/end-of-month (the last day).
 * Reminder time: "⏰ 09:00" or "remind:9:00" (on the due day; Web Push reminders, calendar feed).
 * Repeat: "🔁 <rule>" or "every:<rule>" with day|week|month|year, täglich|wöchentlich|monatlich|jährlich,
 * or "2 weeks", "3 tage", or weekdays like "mo,do".
 * Completing a repeating task ticks it and inserts the next open one with the following due date above.
 *
 * Status lives in the checkbox: [ ] open, [O] in progress, [H] blocked (on hold), [x] done.
 */

import { NoteMemo, type MemoNote } from './noteMemo.js';

export type TaskStatus = 'open' | 'doing' | 'blocked' | 'done';

export const TASK_STATUSES: TaskStatus[] = ['open', 'doing', 'blocked', 'done'];

const STATUS_CHAR: Record<TaskStatus, string> = { open: ' ', doing: 'O', blocked: 'H', done: 'x' };

/** Status of a checkbox character (case-insensitive) */
export function statusOfMarker(ch: string): TaskStatus {
  const c = ch.toLowerCase();
  return c === 'x' ? 'done' : c === 'o' ? 'doing' : c === 'h' ? 'blocked' : 'open';
}

export interface Task {
  /** 0-based line number inside the note */
  line: number;
  text: string;
  done: boolean;
  status: TaskStatus;
  /** Day the task was finished ("✅ YYYY-MM-DD"), if written */
  doneDate: string | null;
  due: string | null;
  repeat: string | null;
  /** Reminder time on the due day, "HH:MM" */
  time: string | null;
  /** Indentation + list marker, kept when rewriting */
  indent: string;
  /** The due date is not written in the task but comes from its note (a daily note's date) */
  dueFromNote?: boolean;
}

/** Matches a task line; group 2 is the status character */
// The text group starts with a non-space (or is empty), so the whitespace before it can only match one way
// (an overlapping `\s+(.*)` backtracks quadratically on long runs of spaces)
export const TASK_LINE = /^(\s*[-*+]\s+)\[([ xXoOhH])\]\s+(\S.*|)$/;
/** Relative due words (alternation, longest first); `resolveDue` turns each into a date */
export const DUE_WORDS =
  'übermorgen|uebermorgen|day-after-tomorrow|heute|today|morgen|tomorrow' +
  '|in-\\d{1,3}-(?:tagen|tage|tag|days|day|wochen|woche|weeks|week|monaten|monate|monat|months|month|jahren|jahre|jahr|years|year)' +
  '|nächste-woche|naechste-woche|next-week|nächsten-monat|nächster-monat|naechster-monat|naechsten-monat|next-month' +
  '|ende-woche|ende-der-woche|end-of-week|ende-monat|ende-des-monats|end-of-month' +
  '|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday' +
  '|mon|tue|wed|thu|fri|sat|sun';
const DUE_VALUE = `\\d{4}-\\d{2}-\\d{2}|(?:${DUE_WORDS})(?![\\p{L}\\d-])`;
/** A due date in a task line; group 1 is the date or the relative word */
export const DUE_PATTERN = `(?:📅\\s*|\\bdue:)(${DUE_VALUE})`;
const DUE = new RegExp(DUE_PATTERN, 'iu');
const DUE_WORD_ONLY = new RegExp(`^(?:${DUE_WORDS})$`, 'iu');
const REPEAT = /(?:🔁\s*|\bevery:)((?:\d+\s*)?[\p{L},]+)/iu;
// Starts at the ✅ (a leading `\s*` would rescan every run of spaces from each position)
const DONE_DATE = /✅\s*(\d{4}-\d{2}-\d{2})/;

/** Removes "✅ YYYY-MM-DD" together with the whitespace in front of it */
function withoutDoneDate(s: string): string {
  const m = DONE_DATE.exec(s);
  return m ? s.slice(0, m.index).trimEnd() + s.slice(m.index + m[0].length) : s;
}
/** "⏰ 9:00", "⏰ 09.30", "remind:18:15" */
export const TIME = /(?:⏰\s*|\bremind:)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/i;

/** "9:05" → "09:05"; null when there is no valid time */
export function parseTime(s: string | null | undefined): string | null {
  const m = /^\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*$/.exec(s ?? '');
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

export function toDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const DUE_WEEKDAYS: Record<string, number> = {
  sonntag: 0, sunday: 0, sun: 0,
  montag: 1, monday: 1, mon: 1,
  dienstag: 2, tuesday: 2, tue: 2,
  mittwoch: 3, wednesday: 3, wed: 3,
  donnerstag: 4, thursday: 4, thu: 4,
  freitag: 5, friday: 5, fri: 5,
  samstag: 6, saturday: 6, sat: 6,
};

/**
 * The date of a due value: a date stays as it is, a relative word (`DUE_WORDS`) is counted from `today`.
 * A weekday is the next such day after today (on a Friday, "freitag" is a week later).
 */
export function resolveDue(raw: string, today: Date = new Date()): string {
  const word = raw.toLowerCase();
  if (!DUE_WORD_ONLY.test(word)) return raw;
  if (word === 'heute' || word === 'today') return toDateString(today);
  if (word === 'morgen' || word === 'tomorrow') return toDateString(addDays(today, 1));
  if (word === 'übermorgen' || word === 'uebermorgen' || word === 'day-after-tomorrow') return toDateString(addDays(today, 2));
  const wd = DUE_WEEKDAYS[word];
  if (wd !== undefined) return toDateString(addDays(today, ((wd - today.getDay() + 6) % 7) + 1));
  const rel = /^in-(\d+)-(\p{L}+)$/u.exec(word);
  if (rel) {
    const n = Number(rel[1]);
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const unit = rel[2];
    if (unit.startsWith('tag') || unit.startsWith('day')) d.setDate(d.getDate() + n);
    else if (unit.startsWith('woche') || unit.startsWith('week')) d.setDate(d.getDate() + 7 * n);
    else if (unit.startsWith('monat') || unit.startsWith('month')) addMonths(d, n);
    else addMonths(d, 12 * n);
    return toDateString(d);
  }
  if (/woche|week/.test(word)) {
    // Monday is 1 … Sunday 7
    const iso = today.getDay() || 7;
    return toDateString(addDays(today, word.startsWith('ende') || word.startsWith('end') ? 7 - iso : 8 - iso));
  }
  if (word.startsWith('ende') || word.startsWith('end')) return toDateString(new Date(today.getFullYear(), today.getMonth() + 1, 0));
  return toDateString(new Date(today.getFullYear(), today.getMonth() + 1, 1));
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * `defaultDue` is the due date of tasks that name none themselves: tasks in a daily note belong to
 * that day (see `dailyDueResolver`).
 */
export function parseTasks(content: string, today = new Date(), defaultDue: string | null = null): Task[] {
  const tasks: Task[] = [];
  let inFence = false;
  content.split('\n').forEach((raw, line) => {
    if (/^\s*```/.test(raw)) inFence = !inFence;
    if (inFence) return;
    const m = TASK_LINE.exec(raw);
    if (!m) return;
    const rest = m[3];
    const due = DUE.exec(rest);
    const repeat = REPEAT.exec(rest);
    const time = TIME.exec(rest);
    const text = withoutDoneDate(rest).replace(DUE, '').replace(REPEAT, '').replace(TIME, '').replace(/\s+/g, ' ').trim();
    // An empty checkbox is a placeholder (e.g. from a template), not a task
    if (!text) return;
    tasks.push({
      line,
      text,
      done: statusOfMarker(m[2]) === 'done',
      status: statusOfMarker(m[2]),
      doneDate: DONE_DATE.exec(rest)?.[1] ?? null,
      due: due ? resolveDue(due[1], today) : defaultDue,
      repeat: repeat ? repeat[1].trim() : null,
      time: time ? `${time[1].padStart(2, '0')}:${time[2]}` : null,
      indent: m[1],
      ...(!due && defaultDue ? { dueFromNote: true } : {}),
    });
  });
  return tasks;
}

/** Month steps keep the day but stop at the month's end (31.01. → 28.02.) */
function addMonths(d: Date, n: number): void {
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
}

const WEEKDAYS: Record<string, number> = { so: 0, su: 0, mo: 1, di: 2, tu: 2, mi: 3, we: 3, do: 4, th: 4, fr: 5, sa: 6 };

/**
 * "2 wochen" → { n: 2, unit: "wochen" }, "weekly" → { n: 1, unit: "weekly" }; null without a unit.
 * Parsed by hand: a regex like `^(\d+)?\s*(\S.*)$` can split long digit runs in many ways (ReDoS).
 */
/**
 * The tasks of each note, parsed again only when the note, the day or its default due date changes (#64): collecting
 * the tasks of a large vault after every keystroke then parses one note instead of all. The arrays are shared between
 * calls, so callers must not change them.
 */
export class TaskCache {
  private memo = new NoteMemo<readonly Task[]>();

  tasksOf(note: MemoNote, today = new Date(), defaultDue: string | null = null): readonly Task[] {
    return this.memo.get(note, `${toDateString(today)}|${defaultDue ?? ''}`, (n) => parseTasks(n.content, today, defaultDue));
  }
}

export function splitRepeatRule(rule: string): { n: number; unit: string } | null {
  let i = 0;
  while (i < rule.length && rule[i] >= '0' && rule[i] <= '9') i++;
  const unit = rule.slice(i).trim();
  if (!unit) return null;
  return { n: i ? Number(rule.slice(0, i)) : 1, unit };
}

/** Next due date for a repeat rule, counted from the old due date (or today); null for unknown rules */
export function nextDue(rule: string, from: string | null, today = new Date()): string | null {
  const base = from ? parseDate(from) : today;
  const r = rule.toLowerCase().replace(/\s+/g, ' ').trim();
  const parts = r.split(',').map((d) => d.trim());
  const days = parts.filter((d) => d.length <= 3).map((d) => WEEKDAYS[d.slice(0, 2)]).filter((d) => d !== undefined);
  if (days.length && days.length === parts.length) {
    for (let i = 1; i <= 7; i++) {
      const cand = addDays(base, i);
      if (days.includes(cand.getDay())) return toDateString(cand);
    }
  }
  const step = splitRepeatRule(r);
  if (!step) return null;
  const { n, unit } = step;
  const d = new Date(base);
  if (/^(day|days|tag|tage|täglich|daily)$/.test(unit)) d.setDate(d.getDate() + n);
  else if (/^(week|weeks|woche|wochen|wöchentlich|weekly)$/.test(unit)) d.setDate(d.getDate() + 7 * n);
  else if (/^(month|months|monat|monate|monatlich|monthly)$/.test(unit)) addMonths(d, n);
  else if (/^(year|years|jahr|jahre|jährlich|yearly)$/.test(unit)) addMonths(d, 12 * n);
  else return null;
  return toDateString(d);
}

const DUE_WORD_GLOBAL = new RegExp(`(📅\\s*|\\bdue:)(${DUE_WORDS})(?![\\p{L}\\d-])`, 'giu');

/** Normalizes relative due words ("due:morgen") into dates, so the date does not move every day */
export function normalizeDueWords(content: string, today = new Date()): string {
  // Only in task lines and outside `inline code`, so examples in text stay as they are
  return content
    .split('\n')
    .map((line) =>
      TASK_LINE.test(line)
        ? line
            .split(/(`[^`]*`)/)
            .map((part, i) => (i % 2 ? part : part.replace(DUE_WORD_GLOBAL, (_, p, w) => `${p}${resolveDue(w, today)}`)))
            .join('')
        : line
    )
    .join('\n');
}

/** Ticks or unticks the task in `line` (an open, running or blocked task becomes done; a done one open again) */
export function toggleTask(content: string, line: number, today = new Date()): string {
  const m = TASK_LINE.exec(content.split('\n')[line] ?? '');
  if (!m) return content;
  return setTaskStatus(content, line, statusOfMarker(m[2]) === 'done' ? 'open' : 'done', today);
}

/**
 * Sets the status of the task in `line`. Finishing stamps the done date and gives a repeating task its
 * next occurrence (inserted above); leaving "done" removes the done date.
 */
export function setTaskStatus(content: string, line: number, status: TaskStatus, today = new Date()): string {
  const lines = content.split('\n');
  const raw = lines[line];
  const m = raw !== undefined ? TASK_LINE.exec(raw) : null;
  if (!m) return content;
  const was = statusOfMarker(m[2]);
  if (was === status) return content;
  if (status !== 'done') {
    lines[line] = `${m[1]}[${STATUS_CHAR[status]}] ${withoutDoneDate(m[3])}`;
    return lines.join('\n');
  }
  const [task] = parseTasks(raw, today);
  lines[line] = `${m[1]}[x] ${withoutDoneDate(m[3])} ✅ ${toDateString(today)}`;
  if (task?.repeat) {
    const next = nextDue(task.repeat, task.due, today);
    if (next) {
      const rest = DUE.test(m[3]) ? m[3].replace(DUE, (s, value: string) => s.slice(0, s.length - value.length) + next) : `${m[3]} 📅 ${next}`;
      lines.splice(line, 0, `${m[1]}[ ] ${rest}`);
    }
  }
  return lines.join('\n');
}

export type TaskBucket = 'overdue' | 'today' | 'upcoming' | 'someday';

/** Today as YYYY-MM-DD, kept for a second: lists of 100,000s of tasks ask for every task */
let todayCache = { at: 0, day: '' };
function todayString(): string {
  const now = Date.now();
  if (now - todayCache.at > 1000) todayCache = { at: now, day: toDateString(new Date(now)) };
  return todayCache.day;
}

export function bucketOf(task: Task, today?: Date): TaskBucket {
  if (!task.due) return 'someday';
  const t = today ? toDateString(today) : todayString();
  if (task.due < t) return 'overdue';
  if (task.due === t) return 'today';
  return 'upcoming';
}

export type DueShortcut = 'today' | 'tomorrow' | 'nextWeek';

/** Date for the quick buttons: today, tomorrow or next Monday */
export function shortcutDate(kind: DueShortcut, today = new Date()): string {
  if (kind === 'today') return toDateString(today);
  if (kind === 'tomorrow') return toDateString(addDays(today, 1));
  return toDateString(addDays(today, ((8 - today.getDay()) % 7) || 7));
}

/** Rewrites the open task in `line` with a new due date (null removes it), repeat rule or reminder time (undefined keeps, null removes) */
export function setTaskMeta(content: string, line: number, meta: { due?: string | null; repeat?: string | null; time?: string | null }): string {
  const lines = content.split('\n');
  const raw = lines[line];
  const m = raw !== undefined ? TASK_LINE.exec(raw) : null;
  if (!m) return content;
  let rest = m[3];
  const done = DONE_DATE.exec(rest);
  const doneDate = done ? ` ✅ ${done[1]}` : '';
  rest = withoutDoneDate(rest);
  if (meta.due !== undefined) {
    rest = rest.replace(DUE, '').replace(/\s+/g, ' ').trim();
    if (meta.due) rest = `${rest} 📅 ${meta.due}`;
  }
  if (meta.repeat !== undefined) {
    rest = rest.replace(REPEAT, '').replace(/\s+/g, ' ').trim();
    if (meta.repeat) rest = `${rest} 🔁 ${meta.repeat}`;
  }
  if (meta.time !== undefined) {
    rest = rest.replace(TIME, '').replace(/\s+/g, ' ').trim();
    const time = parseTime(meta.time);
    if (time) rest = `${rest} ⏰ ${time}`;
  }
  lines[line] = `${m[1]}[${m[2]}] ${rest.trim()}${doneDate}`;
  return lines.join('\n');
}

/**
 * Takes the task in `line` out of `content`, together with the lines below it that are indented
 * deeper (subtasks, notes). The block comes back with its common indentation removed.
 */
export function takeTaskBlock(content: string, line: number): { content: string; block: string[] } | null {
  const lines = content.split('\n');
  const raw = lines[line];
  const m = raw !== undefined ? TASK_LINE.exec(raw) : null;
  if (!m) return null;
  const depth = (s: string) => /^\s*/.exec(s)![0].replace(/\t/g, '    ').length;
  const base = depth(raw);
  let end = line + 1;
  while (end < lines.length && lines[end].trim() !== '' && depth(lines[end]) > base) end++;
  const block = lines.splice(line, end - line).map((l) => {
    const strip = Math.min(base, /^\s*/.exec(l)![0].length);
    return l.slice(strip);
  });
  return { content: lines.join('\n'), block };
}

/** Appends task lines at the end of `content` (directly below a list that ends the note) */
export function appendTaskLines(content: string, lines: string[]): string {
  if (!lines.length) return content;
  const body = content.replace(/\s+$/, '');
  if (!body) return `${lines.join('\n')}\n`;
  const last = body.slice(body.lastIndexOf('\n') + 1);
  const sep = /^\s*[-*+]\s/.test(last) ? '\n' : '\n\n';
  return `${body}${sep}${lines.join('\n')}\n`;
}
