import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_FOLDER,
  DEFAULT_DAILY_FORMAT,
  computeHeatmapData,
  extractDailyNoteDate,
  isValidDateString,
  normalizeFeatures,
  shiftDateString,
} from '../src/index.js';

describe('daily notes & heatmap helpers', () => {
  it('validates YYYY-MM-DD calendar dates strictly', () => {
    expect(isValidDateString('2026-11-10')).toBe(true);
    expect(isValidDateString('2024-02-29')).toBe(true);
    expect(isValidDateString('2025-02-29')).toBe(false);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('2026-13-01')).toBe(false);
    expect(isValidDateString('not-a-date')).toBe(false);
  });

  it('shifts dates across month and year boundaries', () => {
    expect(shiftDateString('2026-11-10', -1)).toBe('2026-11-09');
    expect(shiftDateString('2026-11-10', 1)).toBe('2026-11-11');
    expect(shiftDateString('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDateString('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('extracts daily note dates from default and custom folder/format combinations', () => {
    const def = { folder: DEFAULT_DAILY_FOLDER, format: DEFAULT_DAILY_FORMAT };
    expect(extractDailyNoteDate('0 Daily/2026/11/2026-11-10.md', def)).toBe('2026-11-10');
    expect(extractDailyNoteDate('0 Inbox/2026-11-10.md', def)).toBeNull();
    expect(extractDailyNoteDate('0 Daily/2026/11/Notiz.md', def)).toBeNull();
    expect(extractDailyNoteDate('0 Daily/2026/02/2026-02-30.md', def)).toBeNull();

    // Custom format with German month/weekday names and root folder
    const customRoot = { folder: '', format: 'YYYY/MMMM/ddd D. YYYY' };
    expect(extractDailyNoteDate('2026/November/Di 10. 2026.md', customRoot)).toBe('2026-11-10');
    // Wrong weekday name rejected by strict round-trip validation
    expect(extractDailyNoteDate('2026/November/Mo 10. 2026.md', customRoot)).toBeNull();

    // English format with ISO week & weekday
    const customEn = { folder: 'Journal', format: 'YYYY/KW-WW/Daily YYYY-MM-DD dddd.MD' };
    expect(extractDailyNoteDate('Journal/2026/KW-46/Daily 2026-11-10 Tuesday.md', customEn)).toBe('2026-11-10');
    expect(extractDailyNoteDate('Journal/2026/KW-01/Daily 2026-11-10 Tuesday.md', customEn)).toBeNull();
  });

  it('normalizes heatmap opt-in feature flag with default off', () => {
    expect(normalizeFeatures(undefined, []).heatmap).toEqual({ enabled: false });
    expect(normalizeFeatures({ heatmap: { enabled: true } }, []).heatmap).toEqual({ enabled: true });
    expect(normalizeFeatures({ heatmap: { enabled: 'yes' } }, []).heatmap).toEqual({ enabled: false });
  });

  it('computes Monday-aligned GitHub heatmap grid and activity levels in DE and EN', () => {
    const daily = { folder: DEFAULT_DAILY_FOLDER, format: DEFAULT_DAILY_FORMAT };
    const today = new Date(2026, 10, 10); // Tuesday 2026-11-10
    const tsNov10 = new Date(2026, 10, 10, 10, 0).getTime();
    const tsNov9 = new Date(2026, 10, 9, 12, 0).getTime();
    const notes = [
      { id: '1', path: '0 Daily/2026/11/2026-11-10.md', createdAt: tsNov10, updatedAt: tsNov10 },
      { id: '2', path: '0 Inbox/Idee.md', createdAt: tsNov10, updatedAt: tsNov10 },
      { id: '3', path: '1 Projekte/Plan.md', createdAt: tsNov9, updatedAt: tsNov10 },
    ];
    const dataDe = computeHeatmapData(notes, daily, { mode: 'rolling' }, today, 'de');
    expect(dataDe.weeks.length).toBeGreaterThanOrEqual(52);
    expect(dataDe.weeks.every((w) => w.length === 7)).toBe(true);
    const flat = dataDe.weeks.flat();
    const nov10 = flat.find((c) => c.date === '2026-11-10');
    const nov9 = flat.find((c) => c.date === '2026-11-09');
    expect(nov10).toMatchObject({ count: 3, level: 2, inRange: true, hasDaily: true });
    expect(nov9).toMatchObject({ count: 1, level: 1, inRange: true, hasDaily: false });
    expect(dataDe.activeDays).toBe(2);
    expect(dataDe.totalCount).toBe(4);
    expect(dataDe.monthLabels.some((m) => m.label === 'Okt' || m.label === 'Mär')).toBe(true);

    const dataEn = computeHeatmapData(notes, daily, { mode: 'rolling' }, today, 'en');
    expect(dataEn.monthLabels.some((m) => m.label === 'Oct' || m.label === 'Mar')).toBe(true);
  });
});
