import { describe, expect, it } from 'vitest';
import { nextDue, normalizeDueWords, parseTasks, toggleTask, bucketOf, setTaskMeta, shortcutDate } from '../src/tasks';

const today = new Date(2026, 10, 8); // 2026-11-08, a Sunday

describe('tasks', () => {
  it('parses due dates and repeat rules in both notations', () => {
    const tasks = parseTasks('- [ ] Steuer 📅 2026-11-30 🔁 monatlich\n* [x] Müll due:morgen every:week\ntext', today);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ text: 'Steuer', due: '2026-11-30', repeat: 'monatlich', done: false });
    expect(tasks[1]).toMatchObject({ text: 'Müll', due: '2026-11-09', repeat: 'week', done: true });
  });

  it('ignores checkboxes inside code fences and empty placeholders', () => {
    expect(parseTasks('```\n- [ ] no\n```\n- [ ] yes\n- [ ] \n- [ ]  📅 2026-11-08')).toHaveLength(1);
  });

  it('computes the next due date', () => {
    expect(nextDue('weekly', '2026-11-08')).toBe('2026-11-15');
    expect(nextDue('2 wochen', '2026-11-08')).toBe('2026-11-22');
    expect(nextDue('monatlich', '2026-01-31')).toBe('2026-02-28');
    expect(nextDue('mo,do', '2026-11-08')).toBe('2026-11-09');
    expect(nextDue('quatsch', '2026-11-08')).toBeNull();
  });

  it('completing a repeating task adds the next one', () => {
    const out = toggleTask('- [ ] Gießen 📅 2026-11-08 🔁 wöchentlich', 0, today);
    expect(out.split('\n')).toEqual(['- [ ] Gießen 📅 2026-11-15 🔁 wöchentlich', '- [x] Gießen 📅 2026-11-08 🔁 wöchentlich ✅ 2026-11-08']);
    expect(toggleTask(out, 1, today).split('\n')[1]).toBe('- [ ] Gießen 📅 2026-11-08 🔁 wöchentlich');
  });

  it('normalizes relative due words and buckets', () => {
    expect(normalizeDueWords('- [ ] a due:heute', today)).toBe('- [ ] a due:2026-11-08');
    expect(normalizeDueWords('Text `due:morgen`\n- [ ] b `due:heute`', today)).toBe('Text `due:morgen`\n- [ ] b `due:heute`');
    const [t] = parseTasks('- [ ] a 📅 2026-11-01', today);
    expect(bucketOf(t, today)).toBe('overdue');
  });
});

describe('setTaskMeta / shortcutDate', () => {
  const today = new Date(2026, 10, 9); // Monday
  it('sets, replaces and removes due and repeat', () => {
    let c = setTaskMeta('- [ ] Müll', 0, { due: '2026-11-10', repeat: 'wöchentlich' });
    expect(c).toBe('- [ ] Müll 📅 2026-11-10 🔁 wöchentlich');
    c = setTaskMeta(c, 0, { due: '2026-11-12' });
    expect(c).toBe('- [ ] Müll 🔁 wöchentlich 📅 2026-11-12');
    c = setTaskMeta(c, 0, { due: null, repeat: null });
    expect(c).toBe('- [ ] Müll');
  });
  it('computes shortcuts', () => {
    expect(shortcutDate('today', today)).toBe('2026-11-09');
    expect(shortcutDate('tomorrow', today)).toBe('2026-11-10');
    expect(shortcutDate('nextWeek', today)).toBe('2026-11-16');
  });
});
