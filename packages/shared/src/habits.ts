/**
 * Habit tracker (#134, opt-in feature `habits`). The habits of a space are defined in a hidden note
 * `_habits-<uuid>.md` (frontmatter `type: habits`) at the top of the space, one per line:
 *
 *   - 🏃 Sport | daily | sport
 *   - 📖 Lesen | 3/week | lesen
 *
 * icon (optional), name, target (`daily` or `<n>/week`) and the id the check-ins use. A check-in is a done task
 * with the tag `#habit/<id>` in that day's daily note (`- [x] 🏃 Sport #habit/sport`), so the history stays plain
 * Markdown in the notes. Streaks count days (daily habits) or weeks that reached the target (weekly habits).
 */
import { parseFrontmatter } from './markdown.js';
import { TASK_LINE, statusOfMarker, toDateString, parseDate } from './tasks.js';

export const HABITS_TYPE = 'habits';
const HABITS_NAME = /^_habits(?:-[0-9a-f][0-9a-f-]{7,})?\.md$/i;

/** File name for a new definition note; `id` is a random UUID */
export const habitsFileName = (id: string): string => `_habits-${id}.md`;

export function isHabitsPath(path: string): boolean {
  const at = path.lastIndexOf('/') + 1;
  return path[at] === '_' && HABITS_NAME.test(path.slice(at));
}

export type HabitTarget = { kind: 'daily' } | { kind: 'weekly'; times: number };

export interface Habit {
  /** What the check-ins are tagged with (`#habit/<id>`); stays when the habit is renamed */
  id: string;
  name: string;
  icon: string;
  target: HabitTarget;
}

/** "Morgens laufen!" → "morgens-laufen": letters and digits of any script, joined by hyphens */
export function habitSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'habit'
  );
}

function parseTarget(raw: string | undefined): HabitTarget {
  const s = (raw ?? '').trim().toLowerCase();
  const m = /^(\d{1,2})\s*(?:x\s*)?\/\s*(?:week|woche|w)$/.exec(s);
  if (m) {
    const times = Math.min(7, Math.max(1, Number(m[1])));
    return times === 7 ? { kind: 'daily' } : { kind: 'weekly', times };
  }
  return { kind: 'daily' };
}

const EMOJI = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u;

/** The habits of a definition note, in their order; ids are unique (a repeated one gets a number) */
export function parseHabits(content: string): Habit[] {
  const { body } = parseFrontmatter(content);
  const out: Habit[] = [];
  const seen = new Set<string>();
  for (const line of body.split('\n')) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (!m) continue;
    const [first, target, idRaw] = m[1].split('|').map((p) => p.trim());
    const icon = EMOJI.exec(first)?.[1] ?? '';
    const name = first.slice(icon ? EMOJI.exec(first)![0].length : 0).trim();
    if (!name) continue;
    let id = habitSlug(idRaw || name);
    for (let n = 2; seen.has(id); n++) id = `${habitSlug(idRaw || name)}-${n}`;
    seen.add(id);
    out.push({ id, name, icon, target: parseTarget(target) });
  }
  return out;
}

function targetText(t: HabitTarget): string {
  return t.kind === 'daily' ? 'daily' : `${t.times}/week`;
}

/** The definition note's text for `habits` */
export function serializeHabits(habits: readonly Habit[]): string {
  const lines = habits.map((h) => `- ${h.icon ? `${h.icon} ` : ''}${h.name.replace(/\|/g, '/')} | ${targetText(h.target)} | ${h.id}`);
  return `---\ntype: ${HABITS_TYPE}\n---\n${lines.join('\n')}\n`;
}

/** The tag of a habit's check-ins */
export const habitTag = (id: string): string => `#habit/${id}`;

const HABIT_TAG = /(?:^|\s)#habit\/([\p{L}\p{N}_-]+)(?![\p{L}\p{N}_/-])/gu;

/** Ids of the habits checked off in a note (done tasks with `#habit/<id>`), outside code blocks */
export function habitCheckins(content: string): string[] {
  const out = new Set<string>();
  let fence = false;
  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = TASK_LINE.exec(line);
    if (!m || statusOfMarker(m[2]) !== 'done') continue;
    for (const tag of m[3].matchAll(HABIT_TAG)) out.add(tag[1].toLowerCase());
  }
  return [...out];
}

/**
 * Checks a habit off in a daily note's text (`done`) or takes the check-in back. A check-in is added as a new task
 * at the end; taking it back removes the line, so no open task stays behind for the task list.
 */
export function setHabitCheckin(content: string, habit: Habit, done: boolean): string {
  const lines = content.split('\n');
  const tag = new RegExp(`(?:^|\\s)#habit/${habit.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_/-])`, 'iu');
  const at = lines.findIndex((l) => TASK_LINE.test(l) && tag.test(l));
  if (!done) {
    if (at < 0) return content;
    lines.splice(at, 1);
    return lines.join('\n');
  }
  if (at >= 0) {
    const m = TASK_LINE.exec(lines[at])!;
    if (statusOfMarker(m[2]) === 'done') return content;
    lines[at] = `${m[1]}[x] ${m[3]}`;
    return lines.join('\n');
  }
  const entry = `- [x] ${habit.icon ? `${habit.icon} ` : ''}${habit.name} ${habitTag(habit.id)}`;
  const body = content.replace(/\s+$/, '');
  if (!body) return `${entry}\n`;
  // Right below a task list it joins the list; after text it starts a new paragraph
  const lastLine = body.split('\n').pop() ?? '';
  return `${body}\n${TASK_LINE.test(lastLine) ? '' : '\n'}${entry}\n`;
}

const addDays = (date: string, n: number): string => {
  const d = parseDate(date);
  d.setDate(d.getDate() + n);
  return toDateString(d);
};

/** Monday of the ISO week containing `date` */
export function weekStart(date: string): string {
  const d = parseDate(date);
  return addDays(date, -((d.getDay() + 6) % 7));
}

export interface HabitStats {
  /** Days (daily) or weeks that reached the target (weekly) in a row up to now; today/this week may still come */
  current: number;
  longest: number;
  /** Share of the target reached in the last 30 days, 0…1 */
  rate30: number;
  doneToday: boolean;
  /** Check-ins in the current week (weekly habits) */
  thisWeek: number;
}

/** Streaks and rate of a habit from the dates it was checked off */
export function habitStats(habit: Habit, dates: ReadonlySet<string>, today: string): HabitStats {
  const sorted = [...dates].filter((d) => d <= today).sort();
  const doneToday = dates.has(today);
  const last30 = sorted.filter((d) => d > addDays(today, -30)).length;
  if (habit.target.kind === 'daily') {
    let longest = 0;
    let run = 0;
    let prev = '';
    for (const d of sorted) {
      run = prev && addDays(prev, 1) === d ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = d;
    }
    let current = 0;
    let day = doneToday ? today : addDays(today, -1);
    while (dates.has(day)) {
      current++;
      day = addDays(day, -1);
    }
    return { current, longest, rate30: Math.min(1, last30 / 30), doneToday, thisWeek: sorted.filter((d) => d >= weekStart(today)).length };
  }
  const times = habit.target.times;
  const perWeek = new Map<string, number>();
  for (const d of sorted) perWeek.set(weekStart(d), (perWeek.get(weekStart(d)) ?? 0) + 1);
  const met = (week: string) => (perWeek.get(week) ?? 0) >= times;
  let longest = 0;
  let run = 0;
  let prevWeek = '';
  for (const week of [...perWeek.keys()].sort()) {
    if (!met(week)) {
      run = 0;
      prevWeek = '';
      continue;
    }
    run = prevWeek && addDays(prevWeek, 7) === week ? run + 1 : 1;
    longest = Math.max(longest, run);
    prevWeek = week;
  }
  const thisWeek = perWeek.get(weekStart(today)) ?? 0;
  let current = 0;
  let week = met(weekStart(today)) ? weekStart(today) : addDays(weekStart(today), -7);
  while (met(week)) {
    current++;
    week = addDays(week, -7);
  }
  return { current, longest, rate30: Math.min(1, last30 / ((times * 30) / 7)), doneToday, thisWeek };
}
