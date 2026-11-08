import type { QueryResult } from '@kladde/shared';

/** What the editor widgets need from the app (set once by the app, read at render time) */
export interface EditorHost {
  openWiki(title: string): void;
  wikiExists(title: string): boolean;
  openNote(id: string): void;
  runQuery(src: string): QueryResult | { error: string };
  toggleTask(noteId: string, line: number): void;
  noteTitles(): string[];
  upload(file: File): Promise<{ url: string; name: string; mime: string }>;
}

export const editorHost: EditorHost = {
  openWiki: () => {},
  wikiExists: () => true,
  openNote: () => {},
  runQuery: () => ({ error: 'nicht verfügbar' }),
  toggleTask: () => {},
  noteTitles: () => [],
  upload: () => Promise.reject(new Error('nicht verfügbar')),
};
