import { describe, expect, it } from 'vitest';
import { buildCalendar, calendarTasks, foldLine, icsText, rruleOf, type CalendarBuildOptions } from '../src/calendar';

const now = new Date(Date.UTC(2026, 10, 14, 8, 0, 0));
const opts = (extra: Partial<CalendarBuildOptions> = {}): CalendarBuildOptions => ({
  name: 'Kladde – Test',
  baseUrl: 'https://notes.example.org/',
  includeDone: false,
  folder: '',
  tag: '',
  showTitles: true,
  lang: 'de',
  now,
  ...extra,
});

const notes = [
  { id: 'n1', path: 'Projekte/Umzug.md', content: '# Umzug\n- [ ] Kartons, Tape; **holen** 📅 2026-11-20\n- [x] Mieter fragen 📅 2026-11-10 ✅ 2026-11-09\n- [ ] Ohne Datum' },
  { id: 'n2', path: 'Haushalt.md', content: '---\ntags: putzen\n---\n- [ ] Bad 📅 2026-11-15 🔁 2 wochen\n- [ ] Müll every:mo,do due:2026-11-16' },
  { id: 'n3', path: 'Journal/2026-11-18.md', content: '- [ ] Arzt anrufen #privat' },
];

describe('calendar feed', () => {
  it('maps repeat rules to RRULEs', () => {
    expect(rruleOf('weekly')).toBe('FREQ=WEEKLY');
    expect(rruleOf('2 wochen')).toBe('FREQ=WEEKLY;INTERVAL=2');
    expect(rruleOf('monatlich')).toBe('FREQ=MONTHLY');
    expect(rruleOf('3 tage')).toBe('FREQ=DAILY;INTERVAL=3');
    expect(rruleOf('mo,do')).toBe('FREQ=WEEKLY;BYDAY=MO,TH');
    expect(rruleOf('sometimes')).toBeNull();
  });

  it('escapes text and folds long lines at 75 octets', () => {
    expect(icsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const folded = foldLine(`SUMMARY:${'ä'.repeat(60)}`);
    for (const part of folded.split('\r\n')) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(`SUMMARY:${'ä'.repeat(60)}`);
  });

  it('lists open tasks with a due date as all-day events with a link back', () => {
    const ics = buildCalendar(notes, opts());
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(ics).toContain('SUMMARY:Kartons\\, Tape\\; holen');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261121');
    expect(ics).toContain('URL:https://notes.example.org/n/n1');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,TH');
    expect(ics).not.toContain('Mieter');
    expect(ics).not.toContain('Ohne Datum');
  });

  it('takes the due date from daily notes and can include done tasks', () => {
    const defaultDue = (p: string) => /^Journal\/(\d{4}-\d{2}-\d{2})\.md$/.exec(p)?.[1] ?? null;
    const ics = buildCalendar(notes, opts({ includeDone: true, defaultDue }));
    expect(ics).toContain('SUMMARY:✓ Mieter fragen');
    expect(ics).toContain('SUMMARY:Arzt anrufen #privat');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261118');
  });

  it('filters by folder and tag', () => {
    expect(calendarTasks(notes, opts({ folder: '/projekte/' })).map((t) => t.task.text)).toEqual(['Kartons, Tape; **holen**']);
    expect(calendarTasks(notes, opts({ tag: '#putzen' })).map((t) => t.task.text)).toEqual(['Bad', 'Müll']);
    const defaultDue = (p: string) => (p.startsWith('Journal/') ? '2026-11-18' : null);
    expect(calendarTasks(notes, opts({ tag: 'privat', defaultDue })).map((t) => t.task.text)).toEqual(['Arzt anrufen #privat']);
  });

  it('hides the task text when asked to', () => {
    const ics = buildCalendar(notes, opts({ showTitles: false, lang: 'en' }));
    expect(ics.match(/SUMMARY:Task\r\n/g)).toHaveLength(3);
    expect(ics).not.toContain('Kartons');
    expect(ics).not.toContain('Umzug');
  });
});
