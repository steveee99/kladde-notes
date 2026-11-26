/**
 * Habit tracker on the device (#134): the habits of the own space (hidden `_habits-<uuid>.md` notes at its top),
 * their check-ins from the daily notes and writing check-ins back into the daily note of a day.
 */
import { NoteMemo, extractDailyNoteDate, habitCheckins, habitsFileName, isHabitsPath, parseHabits, serializeHabits, setHabitCheckin, splitPath, type Habit } from '@kladde/shared';
import { vault } from './vault';
import type { LocalNote } from './db';
import { newUuid } from '../lib/uuid';

/** The definition notes of the own space; several when two devices created one at the same time */
function definitionNotes(): LocalNote[] {
  return [...vault.notes.values()]
    .filter((n) => !n.deleted && n.access === 'owner' && !n.group && isHabitsPath(n.path) && splitPath(n.path).folder === '')
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The user's habits in their order (definitions of several notes joined, an id only once) */
export function habits(): Habit[] {
  const out: Habit[] = [];
  const seen = new Set<string>();
  for (const n of definitionNotes()) {
    for (const h of parseHabits(n.content)) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      out.push(h);
    }
  }
  return out;
}

/** Writes the habits into the first definition note (made when there is none); the others are folded into it */
export async function saveHabits(list: Habit[]): Promise<void> {
  const notes = definitionNotes();
  for (const n of notes) if (n.partial) await vault.ensureFull(n.id);
  const content = serializeHabits(list);
  if (!notes.length) {
    await vault.create('', habitsFileName(newUuid()).replace(/\.md$/, ''), content);
    return;
  }
  await vault.update(notes[0].id, { content });
  for (const extra of notes.slice(1)) await vault.remove(extra.id);
}

const checkinMemo = new NoteMemo<string[]>((n) => habitCheckins(n.content));

/** Daily notes of the own space by date */
function dailyNotes(): Map<string, LocalNote> {
  const daily = vault.features().daily;
  const out = new Map<string, LocalNote>();
  for (const n of vault.list()) {
    if (n.access !== 'owner' || n.group) continue;
    const date = extractDailyNoteDate(n.path, daily);
    if (date) out.set(date, n);
  }
  return out;
}

/** For each habit id the days it was checked off (from the daily notes whose text is on the device) */
export function habitHistory(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [date, n] of dailyNotes()) {
    if (n.partial) continue;
    for (const id of checkinMemo.get(n)) {
      let days = out.get(id);
      if (!days) out.set(id, (days = new Set()));
      days.add(date);
    }
  }
  return out;
}

/** Online mode: loads the texts of the daily notes of the last `days` days, so the history is complete */
export async function loadRecentDailyNotes(days = 120): Promise<void> {
  if (!vault.online) return;
  const since = new Date();
  since.setDate(since.getDate() - days);
  const from = since.toISOString().slice(0, 10);
  const wanted = [...dailyNotes()].filter(([date, n]) => date >= from && n.partial).map(([, n]) => n.id);
  await Promise.all(wanted.slice(0, 150).map((id) => vault.ensureFull(id)));
}

/** Checks `habit` off on `date` (or takes it back): in that day's daily note, which is made when needed */
export async function setCheckin(habit: Habit, date: string, done: boolean): Promise<void> {
  const existing = dailyNotes().get(date);
  const note = existing ?? (done ? await vault.openDailyNote(date) : undefined);
  if (!note) return;
  const full = await vault.ensureFull(note.id);
  if (!full) return;
  const next = setHabitCheckin(full.content, habit, done);
  if (next !== full.content) await vault.update(note.id, { content: next });
}
