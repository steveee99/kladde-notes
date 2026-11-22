import type { QueryResult } from '@kladde/shared';
import type { EmbedNote } from './embedContext';
import { t } from '../lib/i18n';

/** An attachment as the editor links it */
export type UploadedFile = { url: string; name: string; mime: string };

/** Markdown for an attachment: images, PDFs, audio and video are embedded, other files become a plain link */
export function attachmentMarkdown(file: UploadedFile): string {
  const embed = /^(image|audio|video)\//.test(file.mime) || file.mime === 'application/pdf' || file.url.startsWith('kladde-pending:');
  const name = file.name.replace(/[[\]\n]/g, ' ');
  return `${embed ? '!' : ''}[${name}](${file.url})`;
}

/** What a ticket chip shows */
export interface TicketChip {
  noteId: string;
  title: string;
  status: string;
  category: 'open' | 'active' | 'done';
  blocked: boolean;
}

/** What the editor widgets need from the app (set once by the app, read at render time) */
export interface EditorHost {
  openWiki(title: string): void;
  wikiExists(title: string): boolean;
  openNote(id: string): void;
  /** The note an embed `![[target]]` shows (resolved like links), null if the reader has none by that name */
  resolveEmbed(target: string): EmbedNote | null;
  runQuery(src: string): QueryResult | { error: string } | { loading: true };
  toggleTask(noteId: string, line: number): void;
  /** Opens the note a task lives in, scrolled to the task's line */
  openTask(noteId: string, line: number): void;
  setFrontmatter(noteId: string, updates: Record<string, string | null>): void;
  noteTitles(): string[];
  /** Known tags with their note counts, most used first */
  tags(): { tag: string; count: number }[];
  /** People who can see the note, for @mentions (#69); empty when mentions are off */
  people(noteId: string): { username: string; avatarUrl?: string | null }[];
  autoLinkTargets(excludeId?: string): { name: string; target: string }[];
  /** Project keys where tickets are on; ticket ids of these keys become status chips */
  ticketKeys(): string[];
  /** A ticket by its id (`KLD-118`), null when unknown */
  ticket(id: string): TicketChip | null;
  upload(file: File): Promise<UploadedFile>;
  /** Opens the list of the user's attachments; `onPick` gets the chosen (or newly uploaded) one */
  pickAttachment(onPick: (file: UploadedFile) => void): void;
  /** Local blob: URL of an attachment still waiting to be uploaded (`kladde-pending:<id>`), null when not on this device */
  pendingUrl(id: string): string | null;
  /** Records a voice note (#33); null when cancelled */
  recordVoice(): Promise<File | null>;
  /** Text of a voice note from the server's speech-to-text, null when the server has none */
  transcribe: ((url: string) => Promise<string>) | null;
  registerFlush(fn: () => void): () => void;
  flush(): void;
  requestSave(): void;
}

const flushers = new Set<() => void>();

export const editorHost: EditorHost = {
  openWiki: () => {},
  wikiExists: () => true,
  openNote: () => {},
  resolveEmbed: () => null,
  runQuery: () => ({ error: t('editor.notAvailable') }),
  toggleTask: () => {},
  openTask: () => {},
  setFrontmatter: () => {},
  noteTitles: () => [],
  tags: () => [],
  people: () => [],
  autoLinkTargets: () => [],
  ticketKeys: () => [],
  ticket: () => null,
  upload: () => Promise.reject(new Error(t('editor.notAvailable'))),
  pickAttachment: () => {},
  pendingUrl: () => null,
  recordVoice: () => Promise.resolve(null),
  transcribe: null,
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
