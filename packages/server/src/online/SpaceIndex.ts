import crypto from 'crypto';
import { LinkIndex, MAX_SEARCH_RESULTS, SYSTEM_PREFIX, isDatabasePath, parseFrontmatter, parseTasks, projectTitleOf, searchSnippet, searchTerms, splitPath, type LinkNote, type OnlineTaskNote, type OnlineTasks, type OnlineTaskTuple } from '@kladde/shared';
import type { NoteStore } from '../NoteStore.js';

/**
 * Online mode (KLADDE_MODE=online): devices hold only a catalog of the notes, so the server answers what needs every
 * text: search, backlinks and unlinked mentions. It keeps one index per space (a user's own notes, or a group's),
 * shared by everybody who sees the space: a group of 100,000 notes is held once, however many members work in it.
 *
 * A space is brought up to date before every question: the notes with a newer seq are decrypted again, and when the
 * number of notes no longer matches (a note moved to another space) the ids are compared. Spaces nobody asked about for
 * `IDLE_MS` are dropped. Links resolve inside a note's own space; a link from another visible space counts as a
 * backlink when that space has no note of the name itself. Tasks are parsed once per note version and sent to devices
 * as changes since their last question.
 */

interface IndexedNote extends LinkNote {
  updatedAt: number;
  seq: number;
  /** The note's tasks, parsed on the first question for them (without a default due date: the device adds it) */
  tasks?: OnlineTaskNote;
  tasksDay?: string;
  /** Title, path and text in lower case, as the search compares them; made on the first search */
  hay?: string;
}

/** A space nobody asked about for this long is dropped (and built again on the next question) */
const IDLE_MS = 12 * 60 * 60_000;
const MAX_MENTIONS = 100;

/** A note's tasks as compact tuples (see `OnlineTaskTuple`), with its frontmatter title */
function tasksOf(n: IndexedNote, day: string): OnlineTaskNote {
  // "due:heute" resolves to a date: parsed again on the next day
  if (n.tasks && n.tasksDay === day) return n.tasks;
  n.tasksDay = day;
  const tasks: OnlineTaskTuple[] = parseTasks(n.content).map((t) => {
    const tuple: OnlineTaskTuple = [t.line, t.status, t.text, t.due, t.repeat, t.time, t.doneDate, t.indent];
    // Trailing defaults are left out: most tasks have no time, done date or unusual indentation
    while (tuple.length > 3 && (tuple[tuple.length - 1] === null || (tuple.length === 8 && tuple[7] === '- '))) tuple.pop();
    return tuple;
  });
  const out: OnlineTaskNote = { id: n.id, tasks };
  if (tasks.length) {
    const title = parseFrontmatter(n.content).data.title;
    if (typeof title === 'string' && title) out.title = title;
  }
  return (n.tasks = out);
}

/** What the search compares: title, path and text in lower case, kept with the note */
function hayOf(n: IndexedNote): string {
  return (n.hay ??= `${projectTitleOf(n.path, n.content)}\n${n.path}\n${n.content}`.toLowerCase());
}

class Space {
  readonly notes = new Map<string, IndexedNote>();
  private seq = 0;
  private index: LinkIndex | null = null;
  private stale = true;
  usedAt = Date.now();

  constructor(
    private readonly store: NoteStore,
    readonly ownerId: string
  ) {}

  /** System notes of the space (settings, folders): counted, not indexed */
  private readonly system = new Set<string>();

  refresh(): void {
    this.usedAt = Date.now();
    const state = this.store.spaceState(this.ownerId);
    if (state.maxSeq > this.seq) {
      for (const n of this.store.spaceChanges(this.ownerId, this.seq)) {
        this.seq = Math.max(this.seq, n.seq);
        this.notes.delete(n.id);
        this.system.delete(n.id);
        if (n.deleted) continue;
        if (n.path.startsWith(SYSTEM_PREFIX)) this.system.add(n.id);
        else this.notes.set(n.id, { id: n.id, path: n.path, content: n.content, updatedAt: n.updatedAt, seq: n.seq });
      }
      this.stale = true;
    }
    // A note that moved to another space (a group) leaves this one without a new seq here
    if (state.count !== this.notes.size + this.system.size) {
      const live = new Set(this.store.spaceIds(this.ownerId));
      for (const id of [...this.notes.keys(), ...this.system]) {
        if (live.has(id)) continue;
        this.notes.delete(id);
        this.system.delete(id);
        this.stale = true;
      }
    }
  }

  /** Highest seq the space has taken in */
  get cursor(): number {
    return this.seq;
  }

  links(): LinkIndex {
    if (!this.index || this.stale) {
      // Built from the previous index: only changed notes are parsed again
      this.index = new LinkIndex([...this.notes.values()], undefined, this.index);
      this.stale = false;
    }
    return this.index;
  }
}

export interface OnlineSearchHit {
  id: string;
  snippet: string;
}

export class SpaceIndexes {
  private spaces = new Map<string, Space>();

  constructor(private readonly store: NoteStore) {}

  private space(ownerId: string): Space {
    let s = this.spaces.get(ownerId);
    if (!s) {
      s = new Space(this.store, ownerId);
      this.spaces.set(ownerId, s);
    }
    s.refresh();
    this.dropIdle();
    return s;
  }

  private dropIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.spaces) if (now - s.usedAt > IDLE_MS) this.spaces.delete(id);
  }

  /**
   * Builds the user's spaces, their link indexes and tasks ahead of the first question (after the device loaded its
   * catalog), so opening the first note and the task list do not wait for it
   */
  warm(userId: string): void {
    for (const { space } of this.visible(userId)) {
      space.links();
      const day = new Date().toDateString();
      for (const n of space.notes.values()) {
        hayOf(n);
        tasksOf(n, day);
      }
    }
  }

  /** The notes a user may see, space by space (shared notes only with their ids) */
  private *visible(userId: string): Generator<{ space: Space; only?: Set<string> }> {
    for (const v of this.store.visibleSpaces(userId)) yield { space: this.space(v.ownerId), only: v.only };
  }

  /**
   * The search overlay's search over every note the user may see. `skipFolder`: the user's AI memory folder, left out
   * of their own space unless asked for
   */
  search(userId: string, query: string, skipFolder?: string | null): OnlineSearchHit[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const pool: IndexedNote[] = [];
    // Every term must appear: the lower-cased text is kept per note, so a search does not lower-case 100,000 texts
    const matches = (n: IndexedNote) => {
      const hay = hayOf(n);
      return terms.every((term) => hay.includes(term));
    };
    for (const { space, only } of this.visible(userId)) {
      const own = !only && space === this.spaces.get(userId);
      for (const n of space.notes.values()) {
        if (only && !only.has(n.id)) continue;
        if (isDatabasePath(n.path) || !matches(n)) continue;
        if (own && skipFolder && (n.path.startsWith(`${skipFolder}/`) || splitPath(n.path).folder === skipFolder)) continue;
        pool.push(n);
      }
    }
    // Ranked like `searchNotes` (title matches first, then the most recently edited), from the kept lower-case text
    const ranked = pool.map((n) => {
      const hay = hayOf(n);
      const title = hay.slice(0, hay.indexOf('\n'));
      return { n, inTitle: terms.every((term) => title.includes(term)) };
    });
    ranked.sort((a, b) => (a.inTitle === b.inTitle ? b.n.updatedAt - a.n.updatedAt : a.inTitle ? -1 : 1));
    return ranked.slice(0, MAX_SEARCH_RESULTS).map(({ n }) => ({ id: n.id, snippet: searchSnippet(n.content, terms) }));
  }

  /** Notes linking to `noteId` and notes mentioning its title without a link, among the notes the user may see */
  backlinks(userId: string, noteId: string): { backlinks: string[]; mentions: string[] } | null {
    const home = this.store.spaceOf(userId, noteId);
    if (!home) return null;
    const visible = [...this.visible(userId)];
    const allowed = (only: Set<string> | undefined, id: string) => !only || only.has(id);
    const homeEntry = visible.find((v) => v.space === this.spaces.get(home)) ?? { space: this.space(home), only: new Set([noteId]) };
    const index = homeEntry.space.links();
    const backlinks = index.backlinks(noteId).filter((id) => allowed(homeEntry.only, id));
    const mentions = index
      .unlinkedMentions(noteId)
      .filter((id) => allowed(homeEntry.only, id))
      .slice(0, MAX_MENTIONS);
    // Links from other spaces: by the note's name or title, when that space has no note of that name itself
    const target = index.notes.get(noteId);
    if (target) {
      const names = new Set([splitPath(target.path).name.toLowerCase(), target.title.toLowerCase()]);
      for (const { space, only } of visible) {
        if (space === homeEntry.space) continue;
        const other = space.links();
        for (const n of other.notes.values()) {
          if (!allowed(only, n.id)) continue;
          if (n.links.some((l) => names.has(l.toLowerCase()) && !other.resolve(l))) backlinks.push(n.id);
        }
      }
    }
    return { backlinks: [...new Set(backlinks)], mentions };
  }

  /**
   * The tasks of every note the user may see, for the task page, home and the badge of a device that holds only a
   * catalog. `since` is the cursor of the device's previous answer: then only notes changed since come (also those
   * that have no tasks left), unless the visible spaces or the day changed (`sig`), which sends all again.
   */
  tasks(userId: string, since: number, sig: string): OnlineTasks {
    const visible = [...this.visible(userId)];
    const key = visible
      .map((v) => `${v.space.ownerId}:${v.only ? [...v.only].sort().join(',') : '*'}`)
      .sort()
      .join('|');
    // A new day sends everything again (tasks due "today" or "tomorrow" move)
    const day = new Date().toDateString();
    const current = crypto.createHash('sha256').update(`${day}|${key}`).digest('base64url').slice(0, 16);
    const reset = since <= 0 || sig !== current;
    const notes: OnlineTaskNote[] = [];
    let cursor = 0;
    for (const { space, only } of visible) {
      cursor = Math.max(cursor, space.cursor);
      for (const n of space.notes.values()) {
        if (only && !only.has(n.id)) continue;
        if (!reset && n.seq <= since) continue;
        const entry = tasksOf(n, day);
        if (entry.tasks.length || !reset) notes.push(entry);
      }
    }
    return { cursor, sig: current, reset, notes };
  }
}
