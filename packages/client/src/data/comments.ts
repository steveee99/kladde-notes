import { useEffect, useSyncExternalStore } from 'react';
import type { CommentAnchor, CommentThread, CommentThreadList } from '@kladde/shared';
import { api } from '../lib/api';
import { vault } from './vault';

/*
 * Comment threads of notes (#68), loaded from the server when a note opens and again when someone changes them
 * (live event). They need a connection: comments are kept on the server, not in the offline store.
 */

const threads = new Map<string, CommentThread[]>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((fn) => fn());
};

export async function loadComments(noteId: string): Promise<void> {
  try {
    const list = await api<CommentThreadList>(`/notes/${encodeURIComponent(noteId)}/comments`);
    threads.set(noteId, list.threads);
    emit();
  } catch {
    // offline, a note not on the server yet, or no access: keep what is there
  }
}

vault.commentListeners.add((noteId) => {
  if (threads.has(noteId)) void loadComments(noteId);
});

const put = (thread: CommentThread) => {
  const list = threads.get(thread.noteId) ?? [];
  const i = list.findIndex((t) => t.id === thread.id);
  threads.set(thread.noteId, i >= 0 ? list.map((t) => (t.id === thread.id ? thread : t)) : [...list, thread]);
  emit();
  return thread;
};

const base = (noteId: string) => `/notes/${encodeURIComponent(noteId)}/comments`;

export const comments = {
  of: (noteId: string): CommentThread[] => threads.get(noteId) ?? [],
  create: async (noteId: string, anchor: CommentAnchor, text: string) => put(await api<CommentThread>(base(noteId), { method: 'POST', json: { anchor, text } })),
  reply: async (noteId: string, threadId: string, text: string) => put(await api<CommentThread>(`${base(noteId)}/${threadId}/replies`, { method: 'POST', json: { text } })),
  edit: async (noteId: string, threadId: string, commentId: string, text: string) =>
    put(await api<CommentThread>(`${base(noteId)}/${threadId}/replies/${commentId}`, { method: 'PUT', json: { text } })),
  resolve: async (noteId: string, threadId: string, resolved: boolean) => put(await api<CommentThread>(`${base(noteId)}/${threadId}`, { method: 'PATCH', json: { resolved } })),
  removeComment: async (noteId: string, threadId: string, commentId: string) => {
    const { thread } = await api<{ thread: CommentThread | null }>(`${base(noteId)}/${threadId}/replies/${commentId}`, { method: 'DELETE' });
    if (thread) put(thread);
    else {
      threads.set(noteId, comments.of(noteId).filter((t) => t.id !== threadId));
      emit();
    }
  },
  removeThread: async (noteId: string, threadId: string) => {
    await api(`${base(noteId)}/${threadId}`, { method: 'DELETE' });
    threads.set(noteId, comments.of(noteId).filter((t) => t.id !== threadId));
    emit();
  },
};

/** The threads of a note, loaded when it opens (only for notes on a server with comments turned on) */
export function useComments(noteId: string, enabled: boolean): CommentThread[] {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version
  );
  useEffect(() => {
    if (enabled) void loadComments(noteId);
  }, [noteId, enabled]);
  return enabled ? comments.of(noteId) : [];
}
