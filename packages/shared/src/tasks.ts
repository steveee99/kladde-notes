/**
 * Tasks are ordinary Markdown checkboxes anywhere in a note:
 *
 *   - [ ] Steuer machen 📅 2026-11-30 🔁 monatlich
 *   - [ ] Müll rausbringen due:morgen every:week
 *
 * Due date: "📅 YYYY-MM-DD" or "due:YYYY-MM-DD" (also due:heute / due:morgen, turned into a date on save).
 * Repeat: "🔁 <rule>" or "every:<rule>" with day|week|month|year, täglich|wöchentlich|monatlich|jährlich,
 * or "2 weeks", "3 tage", or weekdays like "mo,do".
 * Completing a repeating task ticks it and inserts the next open one with the following due date above.
 *
 * Status lives in the checkbox: [ ] open, [O] in progress, [H] blocked (on hold), [x] done.
 */

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
  /** Indentation + list marker, kept when rewriting */
  indent: string;
  /** The due date is not written in the task but comes from its note (a daily note's date) */
  dueFromNote?: boolean;
}

/** Matches a task line; group 2 is the status character */
export const TASK_LINE = /^(\s*[-*+]\s+)\[([ xXoOhH])\]\s+(.*)$/;
const DUE = /(?:📅\s*|\bdue:)(\d{4}-\d{2}-\d{2}|heute|morgen|today|tomorrow)/i;
const REPEAT = /(?:🔁\s*|\bevery:)((?:\d+\s*)?[\p{L},]+)/iu;
const DONE_DATE = /\s*✅\s*(\d{4}-\d{2}-\d{2})/;

export function toDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function resolveDue(raw: string, today: Date): string {
  const word = raw.toLowerCase();
  if (word === 'heute' || word === 'today') return toDateString(today);
  if (word === 'morgen' || word === 'tomorrow') return toDateString(addDays(today, 1));
  return raw;
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
    const text = rest.replace(DUE, '').replace(REPEAT, '').replace(DONE_DATE, '').replace(/\s+/g, ' ').trim();
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
  const m = /^(\d+)?\s*(.+)$/.exec(r);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  const unit = m[2];
  const d = new Date(base);
  if (/^(day|days|tag|tage|täglich|daily)$/.test(unit)) d.setDate(d.getDate() + n);
  else if (/^(week|weeks|woche|wochen|wöchentlich|weekly)$/.test(unit)) d.setDate(d.getDate() + 7 * n);
  else if (/^(month|months|monat|monate|monatlich|monthly)$/.test(unit)) addMonths(d, n);
  else if (/^(year|years|jahr|jahre|jährlich|yearly)$/.test(unit)) addMonths(d, 12 * n);
  else return null;
  return toDateString(d);
}

/** Normalizes relative due words ("due:morgen") into dates, so the date does not move every day */
export function normalizeDueWords(content: string, today = new Date()): string {
  // Only in task lines and outside `inline code`, so examples in text stay as they are
  return content
    .split('\n')
    .map((line) =>
      TASK_LINE.test(line)
        ? line
            .split(/(`[^`]*`)/)
            .map((part, i) => (i % 2 ? part : part.replace(/(📅\s*|\bdue:)(heute|morgen|today|tomorrow)\b/gi, (_, p, w) => `${p}${resolveDue(w, today)}`)))
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
    lines[line] = `${m[1]}[${STATUS_CHAR[status]}] ${m[3].replace(DONE_DATE, '')}`;
    return lines.join('\n');
  }
  const [task] = parseTasks(raw, today);
  lines[line] = `${m[1]}[x] ${m[3].replace(DONE_DATE, '')} ✅ ${toDateString(today)}`;
  if (task?.repeat) {
    const next = nextDue(task.repeat, task.due, today);
    if (next) {
      const rest = DUE.test(m[3]) ? m[3].replace(DUE, (s) => s.replace(/(\d{4}-\d{2}-\d{2}|heute|morgen|today|tomorrow)$/i, next)) : `${m[3]} 📅 ${next}`;
      lines.splice(line, 0, `${m[1]}[ ] ${rest}`);
    }
  }
  return lines.join('\n');
}

export type TaskBucket = 'overdue' | 'today' | 'upcoming' | 'someday';

export function bucketOf(task: Task, today = new Date()): TaskBucket {
  if (!task.due) return 'someday';
  const t = toDateString(today);
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

/** Rewrites the open task in `line` with a new due date (null removes it) and/or repeat rule (undefined keeps, null removes) */
export function setTaskMeta(content: string, line: number, meta: { due?: string | null; repeat?: string | null }): string {
  const lines = content.split('\n');
  const raw = lines[line];
  const m = raw !== undefined ? TASK_LINE.exec(raw) : null;
  if (!m) return content;
  let rest = m[3];
  const doneDate = DONE_DATE.exec(rest)?.[0] ?? '';
  rest = rest.replace(DONE_DATE, '');
  if (meta.due !== undefined) {
    rest = rest.replace(DUE, '').replace(/\s+/g, ' ').trim();
    if (meta.due) rest = `${rest} 📅 ${meta.due}`;
  }
  if (meta.repeat !== undefined) {
    rest = rest.replace(REPEAT, '').replace(/\s+/g, ' ').trim();
    if (meta.repeat) rest = `${rest} 🔁 ${meta.repeat}`;
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
