/**
 * The calendar feed (ICS, RFC 5545): the user's own tasks with a due date as events, so a calendar app can
 * show them next to the appointments. Read-only; the feed is reached through a secret URL.
 */
import { extractMeta } from './markdown.js';
import { parseTasks, type Task } from './tasks.js';
import type { CalendarFeedOptions } from './types.js';

export interface CalendarNote {
  id: string;
  path: string;
  content: string;
}

export interface CalendarBuildOptions extends CalendarFeedOptions {
  /** Name shown by the calendar app */
  name: string;
  /** Origin of the app, for the link back to the note (e.g. "https://notes.example.org") */
  baseUrl: string;
  /** Due date of tasks that name none (tasks in a daily note belong to its day) */
  defaultDue?: (path: string) => string | null;
  now?: Date;
}

const WEEKDAY_CODES: Record<string, string> = { so: 'SU', su: 'SU', mo: 'MO', di: 'TU', tu: 'TU', mi: 'WE', we: 'WE', do: 'TH', th: 'TH', fr: 'FR', sa: 'SA' };

/** RRULE for a repeat rule of a task ("weekly", "2 wochen", "mo,do"); null if the rule is unknown */
export function rruleOf(rule: string): string | null {
  const r = rule.toLowerCase().replace(/\s+/g, ' ').trim();
  const parts = r.split(',').map((d) => d.trim());
  const days = parts.filter((d) => d.length <= 3).map((d) => WEEKDAY_CODES[d.slice(0, 2)]).filter(Boolean);
  if (days.length && days.length === parts.length) return `FREQ=WEEKLY;BYDAY=${[...new Set(days)].join(',')}`;
  const m = /^(\d+)?\s*(.+)$/.exec(r);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  if (n < 1) return null;
  const unit = m[2];
  const freq = /^(day|days|tag|tage|täglich|daily)$/.test(unit)
    ? 'DAILY'
    : /^(week|weeks|woche|wochen|wöchentlich|weekly)$/.test(unit)
      ? 'WEEKLY'
      : /^(month|months|monat|monate|monatlich|monthly)$/.test(unit)
        ? 'MONTHLY'
        : /^(year|years|jahr|jahre|jährlich|yearly)$/.test(unit)
          ? 'YEARLY'
          : null;
  if (!freq) return null;
  return n > 1 ? `FREQ=${freq};INTERVAL=${n}` : `FREQ=${freq}`;
}

/** Escapes a TEXT value (RFC 5545 3.3.11) */
export function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds a content line at 75 octets without splitting a UTF-8 character (RFC 5545 3.1) */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    // Continuation lines start with a space, which counts against their 75 octets
    const limit = out.length ? 74 : 75;
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

const icsDate = (iso: string) => iso.replace(/-/g, '');

function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Task text without Markdown noise: [[links]], [labels](urls), emphasis */
function plainTaskText(text: string): string {
  return text
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
}

function matchesTag(task: Task, noteTags: string[], tag: string): boolean {
  const wanted = tag.replace(/^#/, '').toLowerCase();
  if (noteTags.includes(wanted)) return true;
  return new RegExp(`(^|\\s)#${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s.,;:!?])`, 'iu').test(task.text);
}

/** Tasks that belong into the feed, in a stable order */
export function calendarTasks(notes: CalendarNote[], opts: CalendarBuildOptions): { note: CalendarNote; title: string; task: Task }[] {
  const now = opts.now ?? new Date();
  const folder = opts.folder.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  const tag = opts.tag.trim();
  const out: { note: CalendarNote; title: string; task: Task }[] = [];
  for (const note of notes) {
    if (folder && !note.path.toLowerCase().startsWith(`${folder}/`)) continue;
    const meta = extractMeta(note.path, note.content);
    for (const task of parseTasks(note.content, now, opts.defaultDue?.(note.path) ?? null)) {
      if (!task.due) continue;
      if (task.done && !opts.includeDone) continue;
      if (tag && !matchesTag(task, meta.tags, tag)) continue;
      out.push({ note, title: meta.title, task });
    }
  }
  return out.sort((a, b) => a.task.due!.localeCompare(b.task.due!) || a.note.path.localeCompare(b.note.path) || a.task.line - b.task.line);
}

/** The whole feed as an iCalendar document (CRLF line endings, folded lines) */
export function buildCalendar(notes: CalendarNote[], opts: CalendarBuildOptions): string {
  const now = opts.now ?? new Date();
  const stamp = icsStamp(now);
  const base = opts.baseUrl.replace(/\/+$/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kladde//Calendar feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(opts.name)}`];
  // Calendar apps poll at most this often (Apple, Outlook, Google read one of the two)
  lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H');
  const hiddenTitle = opts.lang === 'de' ? 'Aufgabe' : 'Task';
  for (const { note, title, task } of calendarTasks(notes, opts)) {
    const url = `${base}/n/${encodeURIComponent(note.id)}`;
    const text = plainTaskText(task.text);
    const summary = opts.showTitles ? (task.done ? `✓ ${text}` : text) : task.done ? `✓ ${hiddenTitle}` : hiddenTitle;
    lines.push('BEGIN:VEVENT', `UID:${note.id}-${task.line}@kladde`, `DTSTAMP:${stamp}`);
    // With a reminder time: a 30-minute event in "floating" local time (the calendar's own time zone)
    if (task.time) lines.push(`DTSTART:${icsDate(task.due!)}T${task.time.replace(':', '')}00`, 'DURATION:PT30M');
    else lines.push(`DTSTART;VALUE=DATE:${icsDate(task.due!)}`, `DTEND;VALUE=DATE:${icsDate(nextDay(task.due!))}`);
    lines.push(`SUMMARY:${icsText(summary)}`, 'TRANSP:TRANSPARENT', `URL:${url}`);
    lines.push(`DESCRIPTION:${icsText(opts.showTitles ? `${title}\n${url}` : url)}`);
    const rrule = !task.done && task.repeat ? rruleOf(task.repeat) : null;
    if (rrule) lines.push(`RRULE:${rrule}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
