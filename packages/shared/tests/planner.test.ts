import { describe, expect, it } from 'vitest';
import { calendarDays, calendarEntries, shiftCalendar, taskTags, type CalendarTask } from '../src/index.js';

const task = (over: Partial<CalendarTask>): CalendarTask => ({
  noteId: 'n1',
  line: 0,
  text: 'Task',
  done: false,
  status: 'open',
  due: '2026-11-20',
  time: null,
  folder: '1 Projekte',
  noteTitle: 'Haus',
  ...over,
});

describe('calendar view (#72)', () => {
  it('lays out months, weeks and the agenda', () => {
    const month = calendarDays('month', '2026-11-19');
    expect(month).toHaveLength(42);
    // November 2026 starts on a Sunday: the grid starts on Monday, October 26
    expect(month[0]).toBe('2026-10-26');
    expect(month[6]).toBe('2026-11-01');
    expect(calendarDays('week', '2026-11-19')).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
    expect(calendarDays('agenda', '2026-11-19')[13]).toBe('2026-12-02');
    expect(shiftCalendar('month', '2026-11-19', 1)).toBe('2026-12-01');
    expect(shiftCalendar('month', '2026-01-31', -1)).toBe('2025-12-01');
    expect(shiftCalendar('week', '2026-11-19', -1)).toBe('2026-11-09');
    expect(shiftCalendar('agenda', '2026-11-19', 1)).toBe('2026-12-03');
  });

  it('puts tasks, daily notes and dated notes on their days', () => {
    const tasks = [
      task({ line: 1, text: 'Ohne Zeit' }),
      task({ line: 2, text: 'Mit Zeit', time: '09:30' }),
      task({ line: 3, text: 'Früher', time: '08:00' }),
      task({ line: 4, text: 'Erledigt', done: true, status: 'done' }),
      task({ line: 5, text: 'Ohne Datum', due: null }),
      task({ line: 6, text: 'Außerhalb', due: '2027-01-01' }),
    ];
    const notes = [
      { id: 'd', path: '0 Daily/2026-11-20.md', content: '', title: '2026-11-20' },
      { id: 'm', path: 'Termine/Zahnarzt.md', content: '---\ndate: 2026-11-20 14:00\ndeadline: 2026-11-21\n---\n', title: 'Zahnarzt' },
      { id: 'x', path: 'x.md', content: '---\ndate: kaputt\n---\n', title: 'x' },
    ];
    const days = calendarEntries(tasks, notes, '2026-11-16', '2026-11-22', {
      dailyDate: (p) => (p.startsWith('0 Daily/') ? p.slice(8, 18) : null),
      filter: { dateFields: ['date', 'deadline'] },
    });
    const on20 = days.get('2026-11-20')!.map((e) => (e.kind === 'task' ? e.task.text : `${e.kind}:${e.kind === 'note' ? e.field : e.title}`));
    expect(on20).toEqual(['daily:2026-11-20', 'Früher', 'Mit Zeit', 'Ohne Zeit', 'note:date']);
    expect(days.get('2026-11-21')!.map((e) => e.kind)).toEqual(['note']);
    expect(days.has('2027-01-01')).toBe(false);
  });

  it('filters by status, folder, tag and done like the task page', () => {
    const tasks = [
      task({ line: 1, text: 'A #arbeit/kunde', status: 'doing' }),
      task({ line: 2, text: 'B', folder: '2 Bereiche' }),
      task({ line: 3, text: 'C', noteId: 'tagged' }),
      task({ line: 4, text: 'D', done: true, status: 'done' }),
    ];
    const run = (filter: Parameters<typeof calendarEntries>[4] extends infer O ? (O extends { filter?: infer F } ? F : never) : never) =>
      (calendarEntries(tasks, [], '2026-11-20', '2026-11-20', { filter, noteTags: (id) => (id === 'tagged' ? ['arbeit'] : []) }).get('2026-11-20') ?? []).map((e) =>
        e.kind === 'task' ? e.task.text : ''
      );
    expect(run({})).toEqual(['A #arbeit/kunde', 'B', 'C']);
    expect(run({ status: 'doing' })).toEqual(['A #arbeit/kunde']);
    expect(run({ folder: '1 Projekte' })).toEqual(['A #arbeit/kunde', 'C']);
    expect(run({ tag: 'arbeit' })).toEqual(['A #arbeit/kunde', 'C']);
    expect(run({ showDone: true })).toHaveLength(4);
  });

  it('reads tags from task text in linear time', () => {
    expect(taskTags('Anruf #Arbeit und #privat/familie')).toEqual(['arbeit', 'privat/familie']);
    const start = performance.now();
    taskTags(`${'#'.repeat(50_000)}${'a'.repeat(50_000)}`);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
