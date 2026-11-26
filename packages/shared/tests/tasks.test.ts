import { describe, expect, it } from 'vitest';
import { completeParents, nextDue, normalizeDueWords, resolveDue, withDependencies, parseTasks, toggleTask, setTaskStatus, bucketOf, setTaskMeta, shortcutDate, takeTaskBlock, appendTaskLines } from '../src/tasks';

const today = new Date(2026, 10, 8); // 2026-11-08, a Sunday

describe('tasks', () => {
  it('parses due dates and repeat rules in both notations', () => {
    const tasks = parseTasks('- [ ] Steuer 📅 2026-11-30 🔁 monatlich\n* [x] Müll due:morgen every:week\ntext', today);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ text: 'Steuer', due: '2026-11-30', repeat: 'monatlich', done: false });
    expect(tasks[1]).toMatchObject({ text: 'Müll', due: '2026-11-09', repeat: 'week', done: true });
  });

  it('parses reminder times in both notations and keeps them out of the text', () => {
    const [a, b, c] = parseTasks('- [ ] Zahnarzt 📅 2026-11-20 ⏰ 9:30\n- [ ] Anrufen due:heute remind:18.05\n- [ ] Ohne ⏰ 25:00', today);
    expect(a).toMatchObject({ text: 'Zahnarzt', due: '2026-11-20', time: '09:30' });
    expect(b).toMatchObject({ text: 'Anrufen', due: '2026-11-08', time: '18:05' });
    expect(c.time).toBeNull();
    expect(setTaskMeta('- [ ] Zahnarzt ⏰ 9:30', 0, { time: '7:15' })).toBe('- [ ] Zahnarzt ⏰ 07:15');
    expect(setTaskMeta('- [ ] Zahnarzt ⏰ 9:30', 0, { time: null })).toBe('- [ ] Zahnarzt');
  });

  it('keeps the reminder time on the next occurrence of a repeating task', () => {
    const next = setTaskStatus('- [ ] Gießen 📅 2026-11-08 🔁 täglich ⏰ 08:00', 0, 'done', today).split('\n')[0];
    expect(parseTasks(next, today)[0]).toMatchObject({ due: '2026-11-09', time: '08:00', done: false });
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

  it('links subtasks and dependencies (#75)', () => {
    const tasks = parseTasks(
      [
        '- [ ] Umzug 🆔 umzug',
        '  - [x] Kartons kaufen ^kartons',
        '  - [ ] Packen ⛔ kartons',
        '    - [ ] Küche',
        '  - [ ] Wagen mieten after:^packen',
        '- [ ] Party ⛔ umzug,kartons',
        '- [x] Fertig ^done ✅ 2026-11-01',
        '- [ ] Danach after:^done',
      ].join('\n'),
      today
    );
    const [umzug, kartons, packen, kueche, wagen, party, fertig, danach] = tasks;
    expect(umzug).toMatchObject({ text: 'Umzug', id: 'umzug', subtasks: { done: 1, total: 3 } });
    expect(umzug.parent).toBeUndefined();
    expect(kartons).toMatchObject({ text: 'Kartons kaufen', id: 'kartons', parent: 0 });
    expect(packen).toMatchObject({ text: 'Packen', after: ['kartons'], waiting: false, parent: 0, subtasks: { done: 0, total: 1 } });
    expect(kueche.parent).toBe(2);
    // An unknown id does not hold a task back
    expect(wagen).toMatchObject({ text: 'Wagen mieten', after: ['packen'], waiting: false });
    expect(party).toMatchObject({ text: 'Party', after: ['umzug', 'kartons'], waiting: true });
    expect(fertig).toMatchObject({ text: 'Fertig', id: 'done', doneDate: '2026-11-01' });
    expect(danach.waiting).toBe(false);
  });

  it('resolves dependencies across notes and completes parents (#75)', () => {
    const a = parseTasks('- [ ] Angebot 🆔 angebot', today);
    const b = parseTasks('- [ ] Bestellen ⛔ angebot', today);
    expect(b[0].waiting).toBe(false);
    const all = withDependencies([...a, ...b]);
    expect(all[1].waiting).toBe(true);
    // The cached task itself is not changed
    expect(b[0].waiting).toBe(false);
    const doneA = parseTasks('- [x] Angebot 🆔 angebot', today);
    expect(withDependencies([...doneA, ...b])[1].waiting).toBe(false);

    const note = '- [ ] Projekt\n  - [x] Eins\n  - [ ] Zwei\n- [ ] Anderes';
    const ticked = toggleTask(note, 2, today);
    expect(completeParents(ticked, 2, today).split('\n')[0]).toBe('- [x] Projekt ✅ 2026-11-08');
    // Not all done yet: the parent stays open
    const untouched = toggleTask(note.replace('[x] Eins', '[ ] Eins'), 2, today);
    expect(completeParents(untouched, 2, today).split('\n')[0]).toBe('- [ ] Projekt');
  });

  it('resolves natural-language due words (#133)', () => {
    // today is Sunday 2026-11-08
    expect(resolveDue('übermorgen', today)).toBe('2026-11-10');
    expect(resolveDue('Freitag', today)).toBe('2026-11-13');
    expect(resolveDue('sunday', today)).toBe('2026-11-15');
    expect(resolveDue('mon', today)).toBe('2026-11-09');
    expect(resolveDue('in-3-tagen', today)).toBe('2026-11-11');
    expect(resolveDue('in-2-weeks', today)).toBe('2026-11-22');
    expect(resolveDue('in-1-monat', today)).toBe('2026-12-08');
    expect(resolveDue('nächste-woche', today)).toBe('2026-11-09');
    expect(resolveDue('next-month', today)).toBe('2026-12-01');
    expect(resolveDue('ende-woche', today)).toBe('2026-11-08');
    expect(resolveDue('end-of-month', today)).toBe('2026-11-30');
    expect(resolveDue('2026-01-02', today)).toBe('2026-01-02');
    expect(resolveDue('irgendwann', today)).toBe('irgendwann');
    const [t] = parseTasks('- [ ] Bericht due:freitag', today);
    expect(t).toMatchObject({ text: 'Bericht', due: '2026-11-13' });
    // Unknown words and words that only start like one stay text
    expect(parseTasks('- [ ] a due:irgendwann', today)[0]).toMatchObject({ text: 'a due:irgendwann', due: null });
    expect(parseTasks('- [ ] a due:montagabend', today)[0].due).toBeNull();
    expect(normalizeDueWords('- [ ] a due:in-2-tagen 📅 freitag', today)).toBe('- [ ] a due:2026-11-10 📅 2026-11-13');
  });

  it('normalizes relative due words and buckets', () => {
    expect(normalizeDueWords('- [ ] a due:heute', today)).toBe('- [ ] a due:2026-11-08');
    expect(normalizeDueWords('Text `due:morgen`\n- [ ] b `due:heute`', today)).toBe('Text `due:morgen`\n- [ ] b `due:heute`');
    const [t] = parseTasks('- [ ] a 📅 2026-11-01', today);
    expect(bucketOf(t, today)).toBe('overdue');
  });
});

describe('task status', () => {
  it('reads [ ], [O], [H] and [x] as open, doing, blocked and done', () => {
    const tasks = parseTasks('- [ ] a\n- [O] b\n- [h] c\n- [X] d', today);
    expect(tasks.map((t) => t.status)).toEqual(['open', 'doing', 'blocked', 'done']);
    expect(tasks.map((t) => t.done)).toEqual([false, false, false, true]);
  });

  it('moves a task between statuses and stamps the done date only when finished', () => {
    expect(setTaskStatus('- [ ] a', 0, 'doing', today)).toBe('- [O] a');
    expect(setTaskStatus('- [O] a', 0, 'blocked', today)).toBe('- [H] a');
    expect(setTaskStatus('- [H] a', 0, 'done', today)).toBe('- [x] a ✅ 2026-11-08');
    expect(setTaskStatus('- [x] a ✅ 2026-11-08', 0, 'doing', today)).toBe('- [O] a');
    expect(toggleTask('  - [O] a', 0, today)).toBe('  - [x] a ✅ 2026-11-08');
  });

  it('finishing a repeating task from any status adds the next open one', () => {
    expect(setTaskStatus('- [O] Gießen 📅 2026-11-08 🔁 wöchentlich', 0, 'done', today).split('\n')).toEqual([
      '- [ ] Gießen 📅 2026-11-15 🔁 wöchentlich',
      '- [x] Gießen 📅 2026-11-08 🔁 wöchentlich ✅ 2026-11-08',
    ]);
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

describe('daily note tasks', () => {
  it('uses the default due date only for tasks without one', () => {
    const tasks = parseTasks('- [ ] a\n- [ ] b 📅 2026-12-01', new Date(2026, 10, 11), '2026-11-10');
    expect(tasks[0]).toMatchObject({ due: '2026-11-10', dueFromNote: true });
    expect(tasks[1].due).toBe('2026-12-01');
    expect(tasks[1].dueFromNote).toBeUndefined();
  });

  it('takes a task with its subtasks out of a note', () => {
    const r = takeTaskBlock('# Tag\n- [ ] a\n  - [ ] a1\n- [ ] b\n', 1)!;
    expect(r.block).toEqual(['- [ ] a', '  - [ ] a1']);
    expect(r.content).toBe('# Tag\n- [ ] b\n');
    expect(takeTaskBlock('text', 0)).toBeNull();
  });

  it('removes the common indentation of a nested task', () => {
    const r = takeTaskBlock('- [ ] a\n  - [ ] a1\n    - [ ] a2\n', 1)!;
    expect(r.block).toEqual(['- [ ] a1', '  - [ ] a2']);
  });

  it('appends tasks below a closing list or after a blank line', () => {
    expect(appendTaskLines('# Heute\n- [ ] x\n', ['- [ ] y'])).toBe('# Heute\n- [ ] x\n- [ ] y\n');
    expect(appendTaskLines('# Heute\n\nText', ['- [ ] y'])).toBe('# Heute\n\nText\n\n- [ ] y\n');
    expect(appendTaskLines('', ['- [ ] y'])).toBe('- [ ] y\n');
  });
});
