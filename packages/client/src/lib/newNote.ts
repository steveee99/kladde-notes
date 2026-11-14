/**
 * The kinds of notes every "new" button can start (see `views/Dialogs.tsx` → NewNoteDialog and the
 * split button in `views/Shell.tsx`): Markdown (optionally from a template), drawing and PDF; Zettel
 * and recipe have their own dialogs.
 */
import { excalidrawNoteMarkdown, pdfNoteMarkdown, pdfNoteTitle, type SharedFolder } from '@kladde/shared';
import { vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { editorHost } from '../editor/host';
import { t } from './i18n';
import { navigate } from './router';

export type NewNoteKind = 'note' | 'drawing' | 'pdf';

/** True for a file the PDF note accepts */
export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/** Creates an empty drawing note (`type: excalidraw`, see `shared/excalidrawNote.ts`) and opens it */
export async function createDrawingNote(folder: string, title?: string, shared?: SharedFolder): Promise<LocalNote | null> {
  const name = title?.trim() || t('nav.drawingDefaultTitle');
  try {
    const note = shared ? await vault.createShared(shared, name, excalidrawNoteMarkdown()) : await vault.create(folder, name, excalidrawNoteMarkdown());
    navigate(`/n/${note.id}`);
    return note;
  } catch (err) {
    alert((err as Error).message);
    return null;
  }
}

/** Uploads a PDF and creates a PDF note for it (`type: pdf`, see `shared/pdfNote.ts`), then opens it */
export async function createPdfNote(file: File, folder: string, title?: string): Promise<LocalNote | null> {
  if (!isPdfFile(file)) {
    alert(t('nav.pdfOnly'));
    return null;
  }
  let result: { url: string; name: string };
  try {
    result = await editorHost.upload(file);
  } catch (err) {
    alert(t('editor.uploadFailed', { error: (err as Error).message }));
    return null;
  }
  try {
    const note = await vault.create(folder, title?.trim() || pdfNoteTitle(file.name), pdfNoteMarkdown(result.name, result.url));
    navigate(`/n/${note.id}`);
    return note;
  } catch (err) {
    alert((err as Error).message);
    return null;
  }
}
