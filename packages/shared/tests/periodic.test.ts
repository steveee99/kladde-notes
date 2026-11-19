import { describe, expect, it } from 'vitest';
import {
  createPeriodicExtractor,
  defaultPeriodicTemplate,
  fillPeriodicTemplate,
  normalizeFeatures,
  periodDays,
  periodEnd,
  periodStart,
  resolveDailyNote,
  resolvePeriodicNote,
  shiftPeriod,
  weekLabel,
} from '../src/index.js';

const weekly = { folder: '0 Weekly', format: 'GGGG/GGGG-[W]WW.md' };
const monthly = { folder: '0 Monthly', format: 'YYYY/YYYY-MM.md' };

describe('weekly and monthly notes (#73)', () => {
  it('finds the start, end and neighbours of a period', () => {
    expect(periodStart('week', '2026-11-19')).toBe('2026-11-16');
    expect(periodStart('week', '2026-11-16')).toBe('2026-11-16');
    expect(periodStart('week', '2026-11-22')).toBe('2026-11-16');
    expect(periodEnd('week', '2026-11-19')).toBe('2026-11-22');
    expect(periodStart('month', '2026-11-19')).toBe('2026-11-01');
    expect(periodEnd('month', '2024-02-10')).toBe('2024-02-29');
    expect(shiftPeriod('week', '2026-12-30', 1)).toBe('2027-01-04');
    expect(shiftPeriod('month', '2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftPeriod('month', '2026-01-15', -1)).toBe('2025-12-01');
    expect(periodDays('week', '2026-11-19')).toHaveLength(7);
    expect(periodDays('month', '2026-02-03')).toHaveLength(28);
  });

  it('names weeks by their ISO week and year', () => {
    expect(weekLabel('2026-11-19')).toBe('2026-W47');
    // 2024-12-30 belongs to week 1 of 2025, 2027-01-01 to week 53 of 2026
    expect(weekLabel('2024-12-30')).toBe('2025-W01');
    expect(weekLabel('2027-01-01')).toBe('2026-W53');
    expect(resolvePeriodicNote('week', weekly, '2024-12-31').path).toBe('0 Weekly/2025/2025-W01.md');
    expect(resolvePeriodicNote('week', weekly, '2026-11-19').path).toBe('0 Weekly/2026/2026-W47.md');
    expect(resolvePeriodicNote('month', monthly, '2026-11-19').path).toBe('0 Monthly/2026/2026-11.md');
    expect(resolvePeriodicNote('month', { folder: '', format: 'MMMM YYYY' }, '2026-03-09', 'de').name).toBe('März 2026');
  });

  it('reads the period back from a note path', () => {
    const week = createPeriodicExtractor('week', weekly);
    expect(week('0 Weekly/2026/2026-W47.md')).toBe('2026-11-16');
    expect(week('0 Weekly/2025/2025-W01.md')).toBe('2024-12-30');
    expect(week('0 Weekly/2026/2026-W54.md')).toBeNull();
    expect(week('0 Weekly/2026/2025-W47.md')).toBeNull();
    expect(week('0 Weekly/2026/Notiz.md')).toBeNull();
    // A calendar year instead of the ISO year works too
    const byYear = createPeriodicExtractor('week', { folder: 'W', format: 'YYYY-[KW]WW' });
    expect(byYear('W/2024-KW01.md')).toBe('2024-01-01');
    expect(byYear(resolvePeriodicNote('week', { folder: 'W', format: 'YYYY-[KW]WW' }, '2026-11-19').path)).toBe('2026-11-16');
    const month = createPeriodicExtractor('month', monthly);
    expect(month('0 Monthly/2026/2026-11.md')).toBe('2026-11-01');
    expect(month('0 Monthly/2026/2026-13.md')).toBeNull();
    expect(createPeriodicExtractor('month', { folder: '', format: 'MMMM YYYY' })('November 2026.md')).toBe('2026-11-01');
    // Patterns without the numbers of the period name no note
    expect(createPeriodicExtractor('week', { folder: '', format: 'YYYY' })('2026.md')).toBeNull();
  });

  it('stays linear on long paths', () => {
    const week = createPeriodicExtractor('week', { folder: '', format: 'dddd-W-D-M' });
    const start = performance.now();
    week(`${'1'.repeat(50_000)}.md`);
    week(`${'a'.repeat(50_000)}-1-1-1x.md`);
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('fills weekly and monthly templates with links to days and weeks', () => {
    const daily = { folder: '0 Daily', format: 'YYYY/MM/YYYY-MM-DD.md' };
    const filled = fillPeriodicTemplate('week', '# {{week}} ({{start}} – {{end}})\n{{days}}', '2026-11-19', {
      title: '2026-W47',
      dayName: (d) => resolveDailyNote(daily, new Date(`${d}T00:00`)).name,
      lang: 'en',
    });
    expect(filled.split('\n')[0]).toBe('# 2026-W47 (2026-11-16 – 2026-11-22)');
    expect(filled).toContain('- [[2026-11-16|Mon, Nov 16]]');
    expect(filled.split('\n')).toHaveLength(8);
    const month = fillPeriodicTemplate('month', '{{month}} {{title}}\n{{weeks}} {{unknown}}', '2026-11-05', { title: 'Nov', weekName: (w) => weekLabel(w) });
    expect(month).toContain('2026-11 Nov');
    // November 2026 starts on a Sunday: its weeks are 44 (from Oct 26) to 49
    expect(month).toContain('- [[2026-W44]]');
    expect(month).toContain('- [[2026-W49]]');
    expect(month).toContain('{{unknown}}');
    expect(defaultPeriodicTemplate('week', 'de')).toContain('{{days}}');
  });

  it('keeps weekly and monthly notes off unless turned on', () => {
    const f = normalizeFeatures({});
    expect(f.weekly).toEqual({ enabled: false, ...weekly });
    expect(f.monthly).toEqual({ enabled: false, ...monthly });
    expect(normalizeFeatures({ weekly: { enabled: true, folder: 'Wochen', format: '../x' } }).weekly).toEqual({ enabled: true, folder: 'Wochen', format: 'x' });
  });
});
