/**
 * Comments tab of a note's side panel (#68): a thread per commented passage, with replies, resolve/reopen and,
 * at the top, the comment being written on the selected text. Resolved threads are folded away below.
 */
import { useEffect, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { Check, ChevronRight, MessageSquare, Pencil, Trash2, Undo2, X } from '../lib/icons';
import { resolveAnchor, type CommentAnchor, type CommentThread, type NoteComment } from '@kladde/shared';
import { comments } from '../data/comments';
import { vault } from '../data/vault';
import { locale, t, useLang } from '../lib/i18n';
import { Avatar } from './Avatar';

const message = (err: unknown) => (err as Error).message || t('comments.failed');

function Composer({ placeholder, submitLabel, initial = '', autoFocus, onSubmit, onCancel }: { placeholder: string; submitLabel: string; initial?: string; autoFocus?: boolean; onSubmit: (text: string) => Promise<unknown>; onCancel?: () => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(text);
      setText('');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        className="input min-h-[4.5rem] w-full resize-y text-sm"
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          } else if (e.key === 'Escape' && onCancel) {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {error && <p className="text-sm text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" className="btn-text" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={!text.trim() || busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function CommentItem({ noteId, thread, c, manager }: { noteId: string; thread: CommentThread; c: NoteComment; manager: boolean }) {
  const lang = useLang();
  const [editing, setEditing] = useState(false);
  const mine = !!c.author && c.author === vault.actorName;
  const fmt = new Intl.DateTimeFormat(locale(lang), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <li className="group flex gap-2" data-comment={c.id}>
      <Avatar name={c.author ?? '?'} avatarUrl={c.authorAvatar} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{c.author ?? t('activity.someone')}</span>
          <time className="shrink-0 text-xs text-on-surface-variant" dateTime={new Date(c.at).toISOString()}>
            {fmt.format(new Date(c.at))}
            {c.editedAt ? ` · ${t('comments.edited')}` : ''}
          </time>
          {(mine || manager) && !editing && (
            <span className="ml-auto flex shrink-0 gap-0.5 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
              {mine && (
                <button type="button" className="btn-icon h-7 w-7" title={t('common.edit')} aria-label={t('common.edit')} onClick={() => setEditing(true)}>
                  <Pencil size={14} />
                </button>
              )}
              <button
                type="button"
                className="btn-icon h-7 w-7 hover:text-error"
                title={t('common.delete')}
                aria-label={t('common.delete')}
                onClick={() => confirm(t('comments.deleteConfirm')) && void comments.removeComment(noteId, thread.id, c.id).catch((err) => alert(message(err)))}
              >
                <Trash2 size={14} />
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <Composer
            placeholder={t('comments.editPlaceholder')}
            submitLabel={t('common.save')}
            initial={c.text}
            autoFocus
            onCancel={() => setEditing(false)}
            onSubmit={async (text) => {
              await comments.edit(noteId, thread.id, c.id, text);
              setEditing(false);
            }}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm">{c.text}</p>
        )}
      </div>
    </li>
  );
}

function ThreadCard({
  noteId,
  thread,
  located,
  active,
  canComment,
  manager,
  onFocus,
}: {
  noteId: string;
  thread: CommentThread;
  located: boolean;
  active: boolean;
  canComment: boolean;
  manager: boolean;
  onFocus: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);
  const quote = thread.anchor.quote.length > 160 ? `${thread.anchor.quote.slice(0, 160)}…` : thread.anchor.quote;
  return (
    <article
      ref={ref}
      data-thread={thread.id}
      aria-label={t('comments.threadLabel', { quote })}
      className={`rounded-xl border p-3 transition-colors ${active ? 'border-tertiary bg-tertiary-container/30' : 'border-outline-variant bg-surface-container'}`}
    >
      <div className="mb-2 flex items-start gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onFocus} title={located ? t('comments.showPassage') : undefined}>
          <span className={`line-clamp-2 border-l-2 pl-2 text-sm italic ${located ? 'border-tertiary text-on-surface-variant' : 'border-outline text-on-surface-variant line-through'}`}>{quote}</span>
          {!located && <span className="mt-1 block text-xs text-on-surface-variant">{t('comments.passageGone')}</span>}
        </button>
        {canComment && (
          <button
            type="button"
            className="btn-icon h-8 w-8 shrink-0"
            title={thread.resolved ? t('comments.reopen') : t('comments.resolve')}
            aria-label={thread.resolved ? t('comments.reopen') : t('comments.resolve')}
            onClick={() => void comments.resolve(noteId, thread.id, !thread.resolved).catch((err) => alert(message(err)))}
          >
            {thread.resolved ? <Undo2 size={16} /> : <Check size={18} />}
          </button>
        )}
      </div>
      <ul className="space-y-3">
        {thread.comments.map((c) => (
          <CommentItem key={c.id} noteId={noteId} thread={thread} c={c} manager={manager} />
        ))}
      </ul>
      {thread.resolved && thread.resolvedBy && <p className="mt-2 text-xs text-on-surface-variant">{t('comments.resolvedBy', { name: thread.resolvedBy })}</p>}
      {canComment && !thread.resolved && (
        <div className="mt-3">
          <Composer placeholder={t('comments.replyPlaceholder')} submitLabel={t('comments.reply')} onSubmit={(text) => comments.reply(noteId, thread.id, text)} />
        </div>
      )}
    </article>
  );
}

export function CommentsPanel({
  noteId,
  threads,
  view,
  content,
  canComment,
  draft,
  onDraftDone,
  focused,
  onFocus,
}: {
  noteId: string;
  threads: CommentThread[];
  view: EditorView | null;
  content: string;
  canComment: boolean;
  draft: CommentAnchor | null;
  onDraftDone: () => void;
  focused: string | null;
  onFocus: (threadId: string, range: { from: number; to: number } | null) => void;
}) {
  useLang();
  const [showResolved, setShowResolved] = useState(false);
  const doc = view?.state.doc.toString() ?? content;
  const placed = threads.map((th) => ({ thread: th, range: resolveAnchor(doc, th.anchor) }));
  const byPos = (a: (typeof placed)[number], b: (typeof placed)[number]) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity) || a.thread.createdAt - b.thread.createdAt;
  const open = placed.filter((p) => !p.thread.resolved).sort(byPos);
  const resolved = placed.filter((p) => p.thread.resolved).sort(byPos);
  const manager = vault.get(noteId)?.access === 'owner' || !!vault.get(noteId)?.canDelete;
  const card = (p: (typeof placed)[number]) => (
    <ThreadCard
      key={p.thread.id}
      noteId={noteId}
      thread={p.thread}
      located={!!p.range}
      active={focused === p.thread.id}
      canComment={canComment}
      manager={manager}
      onFocus={() => onFocus(p.thread.id, p.range)}
    />
  );
  return (
    <div className="space-y-3 px-1" data-comments-panel>
      {draft && (
        <section className="rounded-xl border border-primary bg-surface-container p-3" aria-label={t('comments.new')}>
          <div className="mb-2 flex items-start gap-2">
            <span className="line-clamp-3 min-w-0 flex-1 border-l-2 border-primary pl-2 text-sm italic text-on-surface-variant">{draft.quote}</span>
            <button type="button" className="btn-icon h-8 w-8 shrink-0" aria-label={t('common.cancel')} title={t('common.cancel')} onClick={onDraftDone}>
              <X size={16} />
            </button>
          </div>
          <Composer
            placeholder={t('comments.placeholder')}
            submitLabel={t('comments.submit')}
            autoFocus
            onCancel={onDraftDone}
            onSubmit={async (text) => {
              const thread = await comments.create(noteId, draft, text);
              onDraftDone();
              onFocus(thread.id, resolveAnchor(view?.state.doc.toString() ?? content, thread.anchor));
            }}
          />
        </section>
      )}
      {!open.length && !draft && (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-body-m text-on-surface-variant">
          <MessageSquare size={28} />
          {canComment ? t('comments.emptyHint') : t('comments.empty')}
        </div>
      )}
      {open.map(card)}
      {resolved.length > 0 && (
        <section>
          <button type="button" className="flex w-full items-center gap-1.5 px-1 py-2 text-left text-title-s text-on-surface-variant" aria-expanded={showResolved} onClick={() => setShowResolved(!showResolved)}>
            <ChevronRight size={16} className={`transition-transform ${showResolved ? 'rotate-90' : ''}`} /> {t('comments.resolvedCount', { n: resolved.length })}
          </button>
          {showResolved && <div className="space-y-3">{resolved.map(card)}</div>}
        </section>
      )}
    </div>
  );
}

/** Scrolls the editor to a thread's passage and selects it */
export function showPassage(view: EditorView | null, range: { from: number; to: number } | null) {
  if (!view || !range) return;
  view.dispatch({ selection: { anchor: range.from, head: range.to }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }) });
}
