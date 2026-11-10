import type { QueryResult } from '@kladde/shared';
import { t } from '../lib/i18n';

/** What the editor widgets need from the app (set once by the app, read at render time) */
export interface EditorHost {
  openWiki(title: string): void;
  wikiExists(title: string): boolean;
  openNote(id: string): void;
  runQuery(src: string): QueryResult | { error: string };
  toggleTask(noteId: string, line: number): void;
  /** Opens the note a task lives in, scrolled to the task's line */
  openTask(noteId: string, line: number): void;
  setFrontmatter(noteId: string, updates: Record<string, string | null>): void;
  noteTitles(): string[];
  autoLinkTargets(excludeId?: string): { name: string; target: string }[];
  upload(file: File): Promise<{ url: string; name: string; mime: string }>;
  registerFlush(fn: () => void): () => void;
  flush(): void;
  requestSave(): void;
}

const flushers = new Set<() => void>();

export const editorHost: EditorHost = {
  openWiki: () => {},
  wikiExists: () => true,
  openNote: () => {},
  runQuery: () => ({ error: t('editor.notAvailable') }),
  toggleTask: () => {},
  openTask: () => {},
  setFrontmatter: () => {},
  noteTitles: () => [],
  autoLinkTargets: () => [],
  upload: () => Promise.reject(new Error(t('editor.notAvailable'))),
  registerFlush: (fn) => {
    flushers.add(fn);
    return () => flushers.delete(fn);
  },
  flush: () => {
    flushers.forEach((fn) => fn());
  },
  requestSave: () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kladde:save'));
    }
  },
};
