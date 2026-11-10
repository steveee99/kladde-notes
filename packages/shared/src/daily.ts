import {
  DEFAULT_DAILY_FOLDER,
  DEFAULT_DAILY_FORMAT,
  DailySettings,
  cleanDailyFolder,
  cleanDailyFormat,
  resolveDailyNote,
} from './para.js';
import { parseDate, toDateString } from './tasks.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True when `s` is a valid calendar date in YYYY-MM-DD format */
export function isValidDateString(s: string): boolean {
  if (!DATE_PATTERN.test(s)) return false;
  const d = parseDate(s);
  return !Number.isNaN(d.getTime()) && toDateString(d) === s;
}

/** Moves a YYYY-MM-DD string by `days` (positive or negative) */
export function shiftDateString(dateStr: string, days: number): string {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + days);
  return toDateString(d);
}

const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_SHORT_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MONTH_NAME_MAP = new Map<string, number>();
[MONTHS_DE, MONTHS_SHORT_DE, MONTHS_EN, MONTHS_SHORT_EN].forEach((arr) =>
  arr.forEach((name, idx) => MONTH_NAME_MAP.set(name.toLowerCase(), idx + 1))
);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isNonTokenLetter = (ch: string) => !!ch && /\p{L}/u.test(ch) && !/[YMDdW]/.test(ch);

type CaptureKind = 'year4' | 'year2' | 'monthNum' | 'monthName' | 'day';

/**
 * Compiles a matcher for `daily.folder` + `daily.format` that extracts `YYYY-MM-DD` from matching note paths.
 * Verified via `resolveDailyNote` so weekdays, ISO weeks, and literals must match strictly.
 */
export function createDailyDateExtractor(daily: Pick<DailySettings, 'folder' | 'format'>): (notePath: string) => string | null {
  const folderRoot = cleanDailyFolder(daily.folder, '');
  const rawFormat = cleanDailyFormat(daily.format, DEFAULT_DAILY_FORMAT);
  const hadMd = /\.md$/i.test(rawFormat);
  const rawStem = (hadMd ? rawFormat.slice(0, -3) : rawFormat)
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');

  if (!rawStem) return () => null;

  const monthLongAlt = [...new Set([...MONTHS_DE, ...MONTHS_EN])].map(escapeRegExp).join('|');
  const monthShortAlt = [...new Set([...MONTHS_SHORT_DE, ...MONTHS_SHORT_EN])].map(escapeRegExp).join('|');

  const captures: CaptureKind[] = [];
  let pattern = folderRoot ? `${escapeRegExp(folderRoot)}/` : '';
  let lastIndex = 0;

  const tokenRe = /\[([^\]]*)\]|(YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|WW|W)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(rawStem)) !== null) {
    if (m.index > lastIndex) pattern += escapeRegExp(rawStem.slice(lastIndex, m.index));
    lastIndex = m.index + m[0].length;

    const literal = m[1];
    const tok = m[2];
    if (literal !== undefined) {
      pattern += escapeRegExp(literal);
      continue;
    }
    if (!tok) {
      pattern += escapeRegExp(m[0]);
      continue;
    }
    const prev = m.index > 0 ? rawStem[m.index - 1] : '';
    const next = lastIndex < rawStem.length ? rawStem[lastIndex] : '';
    if (isNonTokenLetter(prev) || isNonTokenLetter(next)) {
      pattern += escapeRegExp(m[0]);
      continue;
    }

    switch (tok) {
      case 'YYYY':
        captures.push('year4');
        pattern += '(\\d{4})';
        break;
      case 'YY':
        captures.push('year2');
        pattern += '(\\d{2})';
        break;
      case 'MMMM':
        captures.push('monthName');
        pattern += `(${monthLongAlt})`;
        break;
      case 'MMM':
        captures.push('monthName');
        pattern += `(${monthShortAlt})`;
        break;
      case 'MM':
        captures.push('monthNum');
        pattern += '(\\d{2})';
        break;
      case 'M':
        captures.push('monthNum');
        pattern += '(\\d{1,2})';
        break;
      case 'DD':
        captures.push('day');
        pattern += '(\\d{2})';
        break;
      case 'D':
        captures.push('day');
        pattern += '(\\d{1,2})';
        break;
      case 'WW':
        pattern += '\\d{2}';
        break;
      case 'W':
        pattern += '\\d{1,2}';
        break;
      case 'dddd':
      case 'ddd':
        pattern += '[^/\\\\]+?';
        break;
    }
  }
  if (lastIndex < rawStem.length) pattern += escapeRegExp(rawStem.slice(lastIndex));

  const pathRe = new RegExp(`^${pattern}\\.md$`, 'i');
  const cleanSettings: Pick<DailySettings, 'folder' | 'format'> = {
    folder: cleanDailyFolder(daily.folder, DEFAULT_DAILY_FOLDER),
    format: rawFormat,
  };

  return (notePath: string): string | null => {
    const match = pathRe.exec(notePath);
    if (!match) return null;

    let year: number | null = null;
    let month: number | null = null;
    let day: number | null = null;

    for (let i = 0; i < captures.length; i++) {
      const val = match[i + 1];
      if (!val) continue;
      const kind = captures[i];
      if (kind === 'year4') {
        const y = Number(val);
        if (year !== null && year !== y) return null;
        year = y;
      } else if (kind === 'year2') {
        const y = 2000 + Number(val);
        if (year !== null && year !== y) return null;
        year = y;
      } else if (kind === 'monthNum') {
        const mn = Number(val);
        if (month !== null && month !== mn) return null;
        month = mn;
      } else if (kind === 'monthName') {
        const mn = MONTH_NAME_MAP.get(val.toLowerCase()) ?? null;
        if (!mn) return null;
        if (month !== null && month !== mn) return null;
        month = mn;
      } else if (kind === 'day') {
        const dy = Number(val);
        if (day !== null && day !== dy) return null;
        day = dy;
      }
    }

    if (!year || !month || !day) return null;
    const candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!isValidDateString(candidate)) return null;

    const d = parseDate(candidate);
    const lower = notePath.toLowerCase();
    if (
      resolveDailyNote(cleanSettings, d, 'de').path.toLowerCase() === lower ||
      resolveDailyNote(cleanSettings, d, 'en').path.toLowerCase() === lower
    ) {
      return candidate;
    }
    return null;
  };
}

/** Extracts `YYYY-MM-DD` when `notePath` matches the configured daily note folder + format */
export function extractDailyNoteDate(notePath: string, daily: Pick<DailySettings, 'folder' | 'format'>): string | null {
  return createDailyDateExtractor(daily)(notePath);
}

export interface HeatmapNote {
  id: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface HeatmapCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  inRange: boolean;
  hasDaily: boolean;
}

export interface HeatmapData {
  weeks: HeatmapCell[][];
  monthLabels: { weekIndex: number; label: string }[];
  totalCount: number;
  activeDays: number;
  availableYears: number[];
}

export type HeatmapRange = { mode: 'rolling' } | { mode: 'year'; year: number };

function levelOf(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 5) return 3;
  return 4;
}

/** Builds a Monday-first GitHub-style heatmap grid over notes (and daily notes) */
export function computeHeatmapData(
  notes: HeatmapNote[],
  daily: Pick<DailySettings, 'folder' | 'format'>,
  range: HeatmapRange,
  today = new Date(),
  lang: 'de' | 'en' = 'de'
): HeatmapData {
  const monthShort = lang === 'en' ? MONTHS_SHORT_EN : MONTHS_SHORT_DE;
  const extractDaily = createDailyDateExtractor(daily);
  const todayStr = toDateString(today);
  const byDay = new Map<string, Set<string>>();
  const dailyDays = new Set<string>();
  const years = new Set<number>([today.getFullYear()]);

  const mark = (day: string, noteId: string) => {
    let set = byDay.get(day);
    if (!set) byDay.set(day, (set = new Set()));
    set.add(noteId);
    const y = Number(day.slice(0, 4));
    if (Number.isFinite(y)) years.add(y);
  };

  for (const n of notes) {
    if (n.createdAt) mark(toDateString(new Date(n.createdAt)), n.id);
    if (n.updatedAt) mark(toDateString(new Date(n.updatedAt)), n.id);
    const dDate = extractDaily(n.path);
    if (dDate) {
      dailyDays.add(dDate);
      mark(dDate, n.id);
    }
  }

  let startDate: Date;
  let endDate: Date;
  if (range.mode === 'year') {
    startDate = new Date(range.year, 0, 1);
    endDate = new Date(range.year, 11, 31);
  } else {
    endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 364);
  }

  const startStr = toDateString(startDate);
  const endStr = toDateString(endDate);

  // Align grid start to Monday (Mon=0 .. Sun=6)
  const gridStart = new Date(startDate);
  const startMonIdx = (gridStart.getDay() + 6) % 7;
  gridStart.setDate(gridStart.getDate() - startMonIdx);

  // Align grid end to Sunday of the end week
  const gridEnd = new Date(endDate);
  const endMonIdx = (gridEnd.getDay() + 6) % 7;
  gridEnd.setDate(gridEnd.getDate() + (6 - endMonIdx));

  const weeks: HeatmapCell[][] = [];
  const monthLabels: { weekIndex: number; label: string }[] = [];
  let totalCount = 0;
  let activeDays = 0;
  let lastLabeledMonth = -1;

  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const weekIndex = weeks.length;
    const week: HeatmapCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const dateStr = toDateString(cursor);
      const inRange = dateStr >= startStr && dateStr <= endStr && (range.mode === 'year' || dateStr <= todayStr);
      const count = inRange ? (byDay.get(dateStr)?.size ?? 0) : 0;
      if (inRange && count > 0) {
        totalCount += count;
        activeDays++;
      }
      if (inRange && cursor.getMonth() !== lastLabeledMonth && (dateStr === startStr || (cursor.getDate() <= 7 && dow === 0))) {
        lastLabeledMonth = cursor.getMonth();
        monthLabels.push({ weekIndex, label: monthShort[cursor.getMonth()] });
      }
      week.push({
        date: dateStr,
        count,
        level: levelOf(count),
        inRange,
        hasDaily: dailyDays.has(dateStr),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  // Avoid colliding month labels when the first partial week is immediately followed by a new month
  const filteredLabels: { weekIndex: number; label: string }[] = [];
  for (const m of monthLabels) {
    const prev = filteredLabels[filteredLabels.length - 1];
    if (prev && m.weekIndex - prev.weekIndex < 3) {
      if (prev.weekIndex === 0) filteredLabels[filteredLabels.length - 1] = m;
      continue;
    }
    filteredLabels.push(m);
  }

  return {
    weeks,
    monthLabels: filteredLabels,
    totalCount,
    activeDays,
    availableYears: [...years].sort((a, b) => b - a),
  };
}
