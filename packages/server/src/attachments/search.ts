import { extractMeta, SYSTEM_PREFIX, type AttachmentNoteRef, type AttachmentSearchHit, type AttachmentSearchResponse, type LinkNote } from '@kladde/shared';
import type { FileStore } from '../FileStore.js';
import { FILE_URL_RE } from '../cliActions.js';
import { AttachmentTextStore, indexable } from './AttachmentTextStore.js';

/** One page of an attachment that a note embeds */
export interface AttachmentPage {
  fileId: string;
  name: string;
  mime: string;
  page: number;
  text: string;
  ocr: boolean;
  notes: AttachmentNoteRef[];
}

interface Deps {
  files: FileStore;
  texts: AttachmentTextStore;
  /** OCR is on: images count as indexable */
  ocr: boolean;
}

/** Attachment id → the given notes that embed it (system notes left out) */
export function embeddingNotes(notes: LinkNote[]): Map<string, AttachmentNoteRef[]> {
  const map = new Map<string, AttachmentNoteRef[]>();
  for (const n of notes) {
    if (n.path.startsWith(SYSTEM_PREFIX)) continue;
    const ids = new Set<string>();
    for (const m of n.content.matchAll(FILE_URL_RE)) ids.add(m[1]);
    if (!ids.size) continue;
    const title = extractMeta(n.path, n.content).title;
    for (const id of ids) {
      let list = map.get(id);
      if (!list) map.set(id, (list = []));
      list.push({ id: n.id, path: n.path, title });
    }
  }
  return map;
}

/**
 * Every indexed page of the attachments these notes embed. Access follows the notes: whoever may read
 * a note may read the attachments in it (the same rule as for GET /api/files/:id).
 */
export function attachmentPages(deps: Deps, notes: LinkNote[]): { pages: AttachmentPage[]; pending: number } {
  const pages: AttachmentPage[] = [];
  let pending = 0;
  for (const [fileId, refs] of embeddingNotes(notes)) {
    const meta = deps.files.meta(fileId);
    if (!meta || !indexable(meta.mime, deps.ocr)) continue;
    const text = deps.texts.get(fileId);
    if (!text) {
      pending++;
      continue;
    }
    text.pages.forEach((t, i) => {
      if (t.trim()) pages.push({ fileId, name: meta.name, mime: meta.mime, page: i + 1, text: t, ocr: text.ocrUsed, notes: refs });
    });
  }
  return { pages, pending };
}

export function snippetAround(text: string, word: string, before = 60, after = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = Math.max(0, flat.toLowerCase().indexOf(word.toLowerCase()));
  const start = Math.max(0, at - before);
  const end = Math.min(flat.length, at + after);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/** Full-text search: all words must occur on one page; one hit per attachment (its best page) */
export function searchAttachments(deps: Deps, notes: LinkNote[], query: string, limit = 50): AttachmentSearchResponse {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 20);
  const { pages, pending } = attachmentPages(deps, notes);
  if (!words.length) return { hits: [], pending };
  const best = new Map<string, { page: AttachmentPage; score: number }>();
  for (const page of pages) {
    const hay = page.text.replace(/\s+/g, ' ').toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const score = words.reduce((s, w) => s + Math.min(20, hay.split(w).length - 1), 0) + (words.every((w) => page.name.toLowerCase().includes(w)) ? 50 : 0);
    const prev = best.get(page.fileId);
    if (!prev || score > prev.score) best.set(page.fileId, { page, score });
  }
  const hits: AttachmentSearchHit[] = [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ page }) => ({
      fileId: page.fileId,
      name: page.name,
      mime: page.mime,
      url: `/api/files/${page.fileId}`,
      page: page.page,
      snippet: snippetAround(page.text, words[0]),
      ocr: page.ocr,
      notes: page.notes,
    }));
  return { hits, pending };
}
