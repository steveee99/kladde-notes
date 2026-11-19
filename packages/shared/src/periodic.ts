/*
 * Weekly and monthly notes (#73): like daily notes, each has a folder and a naming pattern (the daily note tokens
 * plus GGGG, the ISO week year). A week is dated by its Monday, a month by its first day; the same pattern
 * tokens fill the path from that date.
 */

import { cleanDailyFolder, cleanDailyFormat, isoWeek, isoWeekYear, resolveDailyNote, type DailySettings } from './para.js';
import { parseDate, toDateString } from './tasks.js';

export type PeriodKind = 'week' | 'month';

/** First day of the period that contains `date`: the Monday of its ISO week or the first of its month */
export function periodStart(kind: PeriodKind, date: Date | string): string {
  const d = typeof date === 'string' ? parseDate(date) : new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (kind === 'month') return toDateString(new Date(d.getFullYear(), d.getMonth(), 1));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateString(d);
}

/** Last day of the period that contains `date` */
export function periodEnd(kind: PeriodKind, date: Date | string): string {
  const d = parseDate(periodStart(kind, date));
  if (kind === 'month') return toDateString(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  d.setDate(d.getDate() + 6);
  return toDateString(d);
}

/** The start of the period `delta` periods before or after the one containing `date` */
export function shiftPeriod(kind: PeriodKind, date: Date | string, delta: number): string {
  const d = parseDate(periodStart(kind, date));
  if (kind === 'month') return toDateString(new Date(d.getFullYear(), d.getMonth() + delta, 1));
  d.setDate(d.getDate() + delta * 7);
  return toDateString(d);
}

/** ISO week label `2026-W47` */
export function weekLabel(date: Date | string): string {
  const d = typeof date === 'string' ? parseDate(date) : date;
  return `${isoWeekYear(d)}-W${String(isoWeek(d)).padStart(2, '0')}`;
}

/** Month label `2026-11` */
export function monthLabel(date: Date | string): string {
  return periodStart('month', date).slice(0, 7);
}

/** Path, folder and name of the note for the period containing `date` */
export function resolvePeriodicNote(kind: PeriodKind, settings: Pick<DailySettings, 'folder' | 'format'>, date: Date | string, lang: 'de' | 'en' = 'de') {
  return resolveDailyNote(settings, parseDate(periodStart(kind, date)), lang);
}

/** The days of a period, from its start to its end (YYYY-MM-DD) */
export function periodDays(kind: PeriodKind, date: Date | string): string[] {
  const out: string[] = [];
  const end = periodEnd(kind, date);
  const d = parseDate(periodStart(kind, date));
  for (let s = toDateString(d); s <= end; d.setDate(d.getDate() + 1), s = toDateString(d)) out.push(s);
  return out;
}

/** Month number of a German or English month name or its abbreviation (0 when unknown) */
function monthOfName(name: string): number {
  const n = name.toLowerCase().slice(0, 3);
  const i = ['jan', 'feb', 'mär', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'].indexOf(n);
  if (i >= 0) return i + 1;
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(n) + 1;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOKEN = /\[([^[\]]*)\]|(GGGG|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|WW|W)/g;
const MONTH_NAMES = 'Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|January|February|March|May|June|July|October|December|Jan|Feb|Mär|Mar|Apr|Jun|Jul|Aug|Sep|Okt|Oct|Nov|Dez|Dec';

/**
 * Matcher for the notes of a period kind: returns the period's start date for a path that the settings would
 * produce, null otherwise. The path is read through year/week/month numbers and checked by building it again,
 * so names, literals and the weekday tokens must match exactly. Every part of the pattern is a bounded digit run,
 * a fixed list of names or an escaped literal, so matching stays linear.
 */
export function createPeriodicExtractor(kind: PeriodKind, settings: Pick<DailySettings, 'folder' | 'format'>): (path: string) => string | null {
  const folder = cleanDailyFolder(settings.folder, '');
  const format = cleanDailyFormat(settings.format, kind === 'week' ? 'GGGG-[W]WW.md' : 'YYYY-MM.md');
  const stem = /\.md$/i.test(format) ? format.slice(0, -3) : format;
  const clean = { folder, format };
  const groups: ('year' | 'cyear' | 'week' | 'month' | 'mname')[] = [];
  let pattern = folder ? `${escapeRegExp(folder)}/` : '';
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(stem))) {
    pattern += escapeRegExp(stem.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      pattern += escapeRegExp(m[1]);
      continue;
    }
    const tok = m[2];
    if (tok === 'GGGG' || tok === 'YYYY') {
      // A week's calendar year (YYYY of its Monday) differs from its ISO year only around New Year
      groups.push(tok === 'GGGG' || kind === 'month' ? 'year' : 'cyear');
      pattern += '(\\d{4})';
    } else if (tok === 'YY') pattern += '\\d{2}';
    else if (tok === 'WW' || tok === 'W') {
      if (kind === 'week') groups.push('week');
      pattern += kind === 'week' ? (tok === 'WW' ? '(\\d{2})' : '(\\d{1,2})') : tok === 'WW' ? '\\d{2}' : '\\d{1,2}';
    } else if (tok === 'MM' || tok === 'M') {
      if (kind === 'month') groups.push('month');
      pattern += kind === 'month' ? (tok === 'MM' ? '(\\d{2})' : '(\\d{1,2})') : tok === 'MM' ? '\\d{2}' : '\\d{1,2}';
    } else if (tok === 'MMMM' || tok === 'MMM') {
      if (kind === 'month') groups.push('mname');
      pattern += kind === 'month' ? `(${MONTH_NAMES})` : `(?:${MONTH_NAMES})`;
    }
    else if (tok === 'DD' || tok === 'D') pattern += tok === 'DD' ? '\\d{2}' : '\\d{1,2}';
    else pattern += '\\p{L}{2,12}';
  }
  pattern += escapeRegExp(stem.slice(last));
  const re = new RegExp(`^${pattern}\\.md$`, 'iu');
  const hasYear = groups.includes('year') || groups.includes('cyear');
  if (!hasYear || !(kind === 'week' ? groups.includes('week') : groups.includes('month') || groups.includes('mname'))) {
    // Without year and week/month in the name the period cannot be read back; such a pattern names no note
    return () => null;
  }
  return (path) => {
    const hit = re.exec(path);
    if (!hit) return null;
    const v: Record<string, number> = {};
    groups.forEach((g, i) => (v[g === 'mname' ? 'month' : g] = g === 'mname' ? monthOfName(hit[i + 1]) : Number(hit[i + 1])));
    const year = v.year ?? v.cyear;
    const candidates: string[] = [];
    if (kind === 'month') {
      if (v.month < 1 || v.month > 12) return null;
      candidates.push(toDateString(new Date(year, v.month - 1, 1)));
    } else {
      if (v.week < 1 || v.week > 53) return null;
      // The Monday of ISO week 1 is the Monday of the week with January 4th
      for (const y of v.year ? [year] : [year, year + 1, year - 1]) candidates.push(shiftPeriod('week', new Date(y, 0, 4), v.week - 1));
    }
    const lower = path.toLowerCase();
    return candidates.find((start) => (['de', 'en'] as const).some((lang) => resolvePeriodicNote(kind, clean, start, lang).path.toLowerCase() === lower)) ?? null;
  };
}

export const WEEKLY_TEMPLATE_SETTING = 'weeklyTemplate';
export const MONTHLY_TEMPLATE_SETTING = 'monthlyTemplate';

/** Content of new weekly and monthly notes until the user edits their template */
export function defaultPeriodicTemplate(kind: PeriodKind, lang: 'de' | 'en'): string {
  if (kind === 'week') {
    return lang === 'en'
      ? '## Goals\n\n- \n\n## Days\n\n{{days}}\n\n## Review\n\n'
      : '## Ziele\n\n- \n\n## Tage\n\n{{days}}\n\n## Rückblick\n\n';
  }
  return lang === 'en' ? '## Focus\n\n- \n\n## Weeks\n\n{{weeks}}\n\n## Review\n\n' : '## Fokus\n\n- \n\n## Wochen\n\n{{weeks}}\n\n## Rückblick\n\n';
}

export const PERIODIC_PLACEHOLDERS: { token: string; kinds: PeriodKind[] }[] = [
  { token: '{{title}}', kinds: ['week', 'month'] },
  { token: '{{start}}', kinds: ['week', 'month'] },
  { token: '{{end}}', kinds: ['week', 'month'] },
  { token: '{{week}}', kinds: ['week'] },
  { token: '{{month}}', kinds: ['week', 'month'] },
  { token: '{{days}}', kinds: ['week', 'month'] },
  { token: '{{weeks}}', kinds: ['month'] },
];

export interface PeriodicTemplateContext {
  /** Name of the new note */
  title: string;
  /** Names of the notes to link: the daily note of a day, the weekly note of a week (null: plain dates) */
  dayName?: (date: string) => string | null;
  weekName?: (weekStart: string) => string | null;
  lang?: 'de' | 'en';
}

const link = (name: string | null | undefined, fallback: string, label?: string) =>
  name ? `[[${name}${label && label !== name ? `|${label}` : ''}]]` : fallback;

/**
 * Fills a weekly or monthly template: `{{title}}`, `{{start}}`/`{{end}}` (YYYY-MM-DD), `{{week}}` (2026-W47),
 * `{{month}}` (2026-11), `{{days}}` (a list with a link to each day's daily note) and `{{weeks}}` (a list with a
 * link to each week's weekly note that starts in the month; the first week too when the month starts mid-week).
 */
export function fillPeriodicTemplate(kind: PeriodKind, content: string, date: Date | string, ctx: PeriodicTemplateContext): string {
  const start = periodStart(kind, date);
  const lang = ctx.lang ?? 'de';
  const dayFmt = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
  const days = () =>
    periodDays(kind, start)
      .map((d) => `- ${link(ctx.dayName?.(d), dayFmt.format(parseDate(d)), dayFmt.format(parseDate(d)))}`)
      .join('\n');
  const weeks = () => {
    const out: string[] = [];
    const end = periodEnd(kind, start);
    for (let w = periodStart('week', start); w <= end; w = shiftPeriod('week', w, 1)) out.push(`- ${link(ctx.weekName?.(w), weekLabel(w), weekLabel(w))}`);
    return out.join('\n');
  };
  const vars: Record<string, () => string> = {
    title: () => ctx.title,
    start: () => start,
    end: () => periodEnd(kind, start),
    date: () => start,
    week: () => weekLabel(start),
    month: () => monthLabel(start),
    days,
    weeks,
  };
  return content.replace(/\{\{(\w+)\}\}/g, (all, name: string) => (Object.hasOwn(vars, name) ? vars[name]() : all));
}
