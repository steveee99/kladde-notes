/**
 * Per-note memo for work that only depends on a note's path and text (#64). Large vaults run the same parsing over
 * thousands of notes again after every change; with a memo only the changed notes are parsed again.
 * Comparing the text is cheap: an unchanged note keeps the same string, so the check is usually a pointer compare.
 * The memo holds at most `max` notes and forgets the least recently used ones.
 */
export interface MemoNote {
  id: string;
  path: string;
  content: string;
}

export class NoteMemo<T, N extends MemoNote = MemoNote> {
  private entries = new Map<string, { path: string; content: string; extra: string; value: T }>();

  constructor(
    private readonly compute: ((note: N) => T) | null = null,
    private readonly max = 20_000
  ) {}

  /**
   * The value for the note, computed again when its path or text changed. `extra` is part of the key for inputs
   * besides the note (the day, a default due date); `compute` replaces the one given to the constructor.
   */
  get(note: N, extra = '', compute: ((note: N) => T) | null = this.compute): T {
    const hit = this.entries.get(note.id);
    if (hit && hit.content === note.content && hit.path === note.path && hit.extra === extra) {
      // Most recently used goes last
      this.entries.delete(note.id);
      this.entries.set(note.id, hit);
      return hit.value;
    }
    if (!compute) throw new Error('NoteMemo: nothing to compute');
    const value = compute(note);
    this.entries.delete(note.id);
    this.entries.set(note.id, { path: note.path, content: note.content, extra, value });
    if (this.entries.size > this.max) {
      for (const key of this.entries.keys()) {
        this.entries.delete(key);
        if (this.entries.size <= this.max) break;
      }
    }
    return value;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
