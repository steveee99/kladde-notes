import { describe, expect, it } from 'vitest';
import { habitCheckins, habitSlug, habitStats, isHabitsPath, isHiddenPath, parseHabits, serializeHabits, setHabitCheckin, weekStart, type Habit } from '../src/index';

describe('habits (#134)', () => {
  it('parses and writes the definition note', () => {
    const habits = parseHabits('---\ntype: habits\n---\n- 🏃 Sport | daily | sport\n- 📖 Lesen | 3/week\n- Wasser trinken\n- Lesen | 7/woche\ntext\n');
    expect(habits).toEqual([
      { id: 'sport', name: 'Sport', icon: '🏃', target: { kind: 'daily' } },
      { id: 'lesen', name: 'Lesen', icon: '📖', target: { kind: 'weekly', times: 3 } },
      { id: 'wasser-trinken', name: 'Wasser trinken', icon: '', target: { kind: 'daily' } },
      { id: 'lesen-2', name: 'Lesen', icon: '', target: { kind: 'daily' } },
    ]);
    expect(parseHabits(serializeHabits(habits))).toEqual(habits);
    expect(habitSlug('Morgens laufen!')).toBe('morgens-laufen');
    expect(habitSlug('Übungen ✨')).toBe('übungen');
    expect(isHabitsPath('_habits-0a1b2c3d-1111.md')).toBe(true);
    expect(isHiddenPath('_habits-0a1b2c3d-1111.md')).toBe(true);
    expect(isHabitsPath('Ordner/Habits.md')).toBe(false);
  });

  it('checks habits off in a daily note and takes them back', () => {
    const sport: Habit = { id: 'sport', name: 'Sport', icon: '🏃', target: { kind: 'daily' } };
    const lesen: Habit = { id: 'lesen', name: 'Lesen', icon: '', target: { kind: 'daily' } };
    let note = '# Dienstag\n\nEin Text.';
    note = setHabitCheckin(note, sport, true);
    expect(note).toBe('# Dienstag\n\nEin Text.\n\n- [x] 🏃 Sport #habit/sport\n');
    note = setHabitCheckin(note, lesen, true);
    expect(note).toBe('# Dienstag\n\nEin Text.\n\n- [x] 🏃 Sport #habit/sport\n- [x] Lesen #habit/lesen\n');
    expect(setHabitCheckin(note, sport, true)).toBe(note);
    expect(habitCheckins(note).sort()).toEqual(['lesen', 'sport']);
    note = setHabitCheckin(note, sport, false);
    expect(habitCheckins(note)).toEqual(['lesen']);
    // An open task with the tag is no check-in until it is ticked
    const open = '- [ ] Sport #habit/sport\n';
    expect(habitCheckins(open)).toEqual([]);
    expect(setHabitCheckin(open, sport, true)).toBe('- [x] Sport #habit/sport\n');
    expect(habitCheckins('```\n- [x] x #habit/sport\n```')).toEqual([]);
    expect(habitCheckins('- [x] x #habit/sportlich')).toEqual(['sportlich']);
  });

  it('counts streaks and the rate of the last 30 days', () => {
    const daily: Habit = { id: 'a', name: 'A', icon: '', target: { kind: 'daily' } };
    const today = '2026-11-26';
    const days = new Set(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-24', '2026-11-25']);
    expect(habitStats(daily, days, today)).toMatchObject({ current: 2, longest: 3, doneToday: false });
    days.add(today);
    expect(habitStats(daily, days, today)).toMatchObject({ current: 3, longest: 3, doneToday: true, rate30: 6 / 30 });

    const weekly: Habit = { id: 'b', name: 'B', icon: '', target: { kind: 'weekly', times: 2 } };
    expect(weekStart('2026-11-26')).toBe('2026-11-23');
    // Weeks from Nov 9, 16 met; Nov 23 (this week) only once so far
    const w = new Set(['2026-11-09', '2026-11-12', '2026-11-16', '2026-11-18', '2026-11-24']);
    expect(habitStats(weekly, w, today)).toMatchObject({ current: 2, longest: 2, thisWeek: 1 });
    w.add('2026-11-25');
    expect(habitStats(weekly, w, today)).toMatchObject({ current: 3, longest: 3, thisWeek: 2 });
  });
});
