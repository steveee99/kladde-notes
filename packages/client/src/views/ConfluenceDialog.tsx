import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConfluenceLinkTarget, ConfluenceNoteState, ConfluenceOverview, ConfluencePageRef, ConfluenceSpace, ConfluenceSyncInfo } from '@kladde/shared';
import { AlertTriangle, CheckCircle2, Cloud, ExternalLink, Loader2, RefreshCw, Search, Settings, X } from '../lib/icons';
import { api } from '../lib/api';
import { refreshConfluence, setConfluenceOverview, useConfluence } from '../lib/confluence';
import { folderLeafDisplayName, locale, tl, useLang, type I18nKey, type Lang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useVisualViewport } from '../lib/viewport';
import { Switch } from './Switch';

export type ConfluenceTarget = { note: string; title: string } | { folder: string };

function when(lang: Lang, ms: number | null): string {
  return ms ? new Date(ms).toLocaleString(locale(lang), { dateStyle: 'medium', timeStyle: 'short' }) : tl(lang, 'confluence.never');
}

/** Sync state line with icon and colour */
export function ConfluenceStatus({ status, error, lang }: { status: ConfluenceNoteState['status']; error: string | null; lang: Lang }) {
  const tone = status === 'ok' ? 'text-primary' : status === 'pending' ? 'text-on-surface-variant' : 'text-error';
  const Icon = status === 'ok' ? CheckCircle2 : status === 'pending' ? Loader2 : AlertTriangle;
  return (
    <div className={`flex items-start gap-2 text-sm ${tone}`}>
      <Icon size={16} className={`mt-0.5 shrink-0 ${status === 'pending' ? 'animate-spin' : ''}`} />
      <div className="min-w-0">
        <div className="font-medium">{tl(lang, `confluence.status.${status}` as I18nKey)}</div>
        {error && <div className="text-xs">{error}</div>}
      </div>
    </div>
  );
}

/** "Sync to Confluence…" for a note or a folder (#48): set up, state, sync now, conflicts, stop */
export function ConfluenceDialog({ target, onClose }: { target: ConfluenceTarget; onClose: () => void }) {
  const lang = useLang();
  const vp = useVisualViewport();
  const overview = useConfluence();
  const isNote = 'note' in target;
  const [noteState, setNoteState] = useState<ConfluenceNoteState | null | undefined>(isNote ? undefined : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const folderSync: ConfluenceSyncInfo | undefined = !isNote ? overview?.syncs.find((s) => s.kind === 'folder' && s.folder === target.folder) : undefined;

  const loadNote = async () => {
    if (!isNote) return;
    try {
      setNoteState((await api<{ state: ConfluenceNoteState | null }>(`/confluence/notes/${encodeURIComponent(target.note)}`)).state);
    } catch (err) {
      setError((err as Error).message);
      setNoteState(null);
    }
  };

  useEffect(() => {
    void refreshConfluence();
    void loadNote();
  }, []);

  // While the first sync runs in the background, look again every few seconds
  const pending = (isNote && noteState?.status === 'pending') || (!!folderSync && folderSync.lastSyncAt === null && folderSync.errors === 0);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      void refreshConfluence();
      void loadNote();
    }, 2500);
    return () => clearInterval(timer);
  }, [pending]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      void refreshConfluence();
      void loadNote();
    }
  };

  const syncNow = (force = false) =>
    run(async () => {
      if (isNote) setNoteState((await api<{ state: ConfluenceNoteState | null }>(`/confluence/notes/${encodeURIComponent(target.note)}/run`, { method: 'POST', json: { force } })).state);
      else if (folderSync) setConfluenceOverview(await api<ConfluenceOverview>(`/confluence/syncs/${folderSync.id}/run`, { method: 'POST', json: { force } }));
    });

  const stop = () => {
    if (!confirm(tl(lang, isNote ? 'confluence.stopNoteConfirm' : 'confluence.stopFolderConfirm'))) return;
    void run(async () => {
      if (isNote) setNoteState((await api<{ state: ConfluenceNoteState | null }>(`/confluence/notes/${encodeURIComponent(target.note)}/stop`, { method: 'POST', json: {} })).state);
      else if (folderSync) setConfluenceOverview(await api<ConfluenceOverview>(`/confluence/syncs/${folderSync.id}`, { method: 'DELETE' }));
    });
  };

  const title = isNote ? tl(lang, 'confluence.noteTitle', { name: target.title }) : tl(lang, 'confluence.folderTitle', { name: folderLeafDisplayName(target.folder, lang) });
  const synced = isNote ? noteState : folderSync;

  let body: React.ReactNode;
  if (!overview || (isNote && noteState === undefined)) {
    body = (
      <p className="flex items-center gap-2 text-sm text-on-surface-variant">
        <Loader2 size={16} className="animate-spin" /> {tl(lang, 'common.loading')}
      </p>
    );
  } else if (!overview.connection) {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-on-surface-variant">{tl(lang, 'confluence.notConnected')}</p>
        <button className="btn-tonal rounded-full px-4" onClick={() => (onClose(), navigate('/settings/confluence'))}>
          <Settings size={16} /> {tl(lang, 'confluence.openSettings')}
        </button>
      </div>
    );
  } else if (synced) {
    const status = isNote ? noteState!.status : folderSync!.conflicts ? 'conflict' : folderSync!.errors ? 'error' : folderSync!.lastSyncAt ? 'ok' : 'pending';
    const pageUrl = isNote ? noteState!.pageUrl : folderSync!.pageUrl;
    const errorText = isNote ? noteState!.error : folderSync!.errors || folderSync!.conflicts ? tl(lang, 'confluence.folderProblems', { errors: folderSync!.errors, conflicts: folderSync!.conflicts }) : null;
    body = (
      <div className="space-y-4">
        <ConfluenceStatus status={status} error={errorText} lang={lang} />
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-on-surface-variant">{tl(lang, 'confluence.lastSync')}</dt>
          <dd>{when(lang, isNote ? noteState!.lastSyncAt : folderSync!.lastSyncAt)}</dd>
          {!isNote && (
            <>
              <dt className="text-on-surface-variant">{tl(lang, 'confluence.space')}</dt>
              <dd>
                {folderSync!.spaceKey}
                {folderSync!.parentTitle ? ` › ${folderSync!.parentTitle}` : ''}
              </dd>
              <dt className="text-on-surface-variant">{tl(lang, 'confluence.pages')}</dt>
              <dd>{folderSync!.notes}</dd>
            </>
          )}
        </dl>
        {pageUrl && (
          <a className="btn-text -ml-3 inline-flex rounded-full px-3" href={pageUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={16} /> {tl(lang, 'confluence.openPage')}
          </a>
        )}
        <div className="flex flex-wrap gap-2">
          {status === 'conflict' ? (
            <button className="btn-primary rounded-full px-4" disabled={busy} onClick={() => void syncNow(true)}>
              {tl(lang, 'confluence.overwrite')}
            </button>
          ) : (
            <button className="btn-tonal rounded-full px-4" disabled={busy} onClick={() => void syncNow(status === 'error' && isNote)}>
              <RefreshCw size={16} className={busy ? 'animate-spin' : ''} /> {tl(lang, 'confluence.syncNow')}
            </button>
          )}
          <button className="btn-outlined rounded-full px-4 text-error" disabled={busy} onClick={stop}>
            {tl(lang, 'confluence.stop')}
          </button>
        </div>
        {status === 'conflict' && <p className="text-xs text-on-surface-variant">{tl(lang, 'confluence.conflictHint')}</p>}
      </div>
    );
  } else {
    body = (
      <SetupForm
        target={target}
        busy={busy}
        onSubmit={(input) =>
          run(async () => {
            setConfluenceOverview(await api<ConfluenceOverview>('/confluence/syncs', { method: 'POST', json: input }));
          })
        }
      />
    );
  }

  return createPortal(
    <div className="fixed inset-x-0 z-50 flex items-end justify-center sm:items-center" style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}>
      <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative max-h-[min(90vh,100%)] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface-container-high px-6 pt-6 shadow-elevation-3 anim-sheet [--pad-bottom:1.25rem] safe-bottom sm:rounded-3xl"
      >
        <div className="mb-4 flex items-center gap-2">
          <Cloud size={20} className="shrink-0 text-primary" />
          <h2 className="min-w-0 flex-1 truncate text-headline-s">{title}</h2>
          <button className="btn-icon ml-auto shrink-0" onClick={onClose} aria-label={tl(lang, 'common.close')}>
            <X size={18} />
          </button>
        </div>
        {body}
        {error && <p className="mt-3 text-sm text-error">{error}</p>}
      </div>
    </div>,
    document.body
  );
}

const looksLikeLink = (text: string) => /^https?:\/\//i.test(text.trim());

/**
 * Space field: type to search all spaces (the server searches, so large instances are not cut off),
 * or paste the link of a Confluence page or space; a page link also becomes the parent page.
 */
function SpaceField({ value, onPick, onClear }: { value: ConfluenceSpace | null; onPick: (space: ConfluenceSpace, page: ConfluencePageRef | null) => void; onClear: () => void }) {
  const lang = useLang();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfluenceSpace[] | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const first = useRef(true);

  useEffect(() => {
    if (value) return;
    let cancelled = false;
    setError('');
    setLoading(true);
    const link = looksLikeLink(text);
    const timer = setTimeout(
      () => {
        const done = () => !cancelled && setLoading(false);
        if (link) {
          api<ConfluenceLinkTarget>(`/confluence/resolve?url=${encodeURIComponent(text.trim())}`).then(
            (target) => {
              if (cancelled) return;
              done();
              setText('');
              onPick(target.space, target.page);
            },
            (err) => {
              done();
              if (!cancelled) setError((err as Error).message);
            }
          );
        } else {
          api<ConfluenceSpace[]>(`/confluence/spaces?q=${encodeURIComponent(text.trim())}`).then(
            (list) => {
              if (cancelled) return;
              done();
              setOptions(list);
              setActive(0);
              // With exactly one space there is nothing to choose
              if (first.current && !text.trim() && list.length === 1) onPick(list[0], null);
              first.current = false;
            },
            (err) => {
              done();
              if (!cancelled) setError((err as Error).message);
            }
          );
        }
      },
      text.trim() ? 300 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, value]);

  if (value) {
    return (
      <div className="flex h-10 items-center gap-2 rounded-full border border-outline-variant bg-surface-container pl-3.5 pr-1">
        <span className="min-w-0 flex-1 truncate text-sm">
          {value.name} <span className="text-on-surface-variant">({value.key})</span>
        </span>
        <button
          type="button"
          className="btn-icon h-8 w-8 shrink-0"
          aria-label={tl(lang, 'confluence.changeSpace')}
          title={tl(lang, 'confluence.changeSpace')}
          onClick={() => {
            onClear();
            setText('');
            setOpen(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  const link = looksLikeLink(text);
  const shown = open && !link ? (options ?? []) : [];
  const pick = (s: ConfluenceSpace) => {
    setText('');
    setOpen(false);
    onPick(s, null);
  };

  return (
    <div className="relative">
      <div className="flex h-10 items-center gap-2 rounded-full border border-outline-variant bg-surface-container px-3.5 focus-within:border-primary">
        {loading ? <Loader2 size={15} className="shrink-0 animate-spin text-on-surface-variant" /> : <Search size={15} className="shrink-0 text-on-surface-variant" />}
        <input
          ref={inputRef}
          id="confluence-space"
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown.length ? `${listId}-${active}` : undefined}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-on-surface-variant"
          placeholder={tl(lang, 'confluence.spacePlaceholder')}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              if (shown.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (shown[active]) pick(shown[active]);
            } else if (e.key === 'Escape' && open) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
      </div>
      {open && !link && options !== null && (
        <ul id={listId} role="listbox" aria-label={tl(lang, 'confluence.space')} className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-2xl bg-surface-container-highest py-1 shadow-elevation-2">
          {shown.length === 0 ? (
            <li className="px-4 py-2 text-sm text-on-surface-variant">{loading ? tl(lang, 'common.loading') : tl(lang, 'confluence.noSpaces')}</li>
          ) : (
            shown.map((s, i) => (
              <li
                key={s.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`cursor-pointer truncate px-4 py-2 text-sm ${i === active ? 'bg-secondary-container text-on-secondary-container' : ''}`}
                onMouseEnter={() => setActive(i)}
                // mousedown keeps the focus in the input, so blur does not close the list first
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
              >
                {s.name} <span className="text-on-surface-variant">({s.key})</span>
              </li>
            ))
          )}
        </ul>
      )}
      <p className={`mt-1 px-1 text-xs ${error ? 'text-error' : 'text-on-surface-variant'}`}>{error || tl(lang, link && loading ? 'confluence.resolving' : 'confluence.spaceHint')}</p>
    </div>
  );
}

function SetupForm({ target, busy, onSubmit }: { target: ConfluenceTarget; busy: boolean; onSubmit: (input: Record<string, unknown>) => void }) {
  const lang = useLang();
  const [space, setSpace] = useState<ConfluenceSpace | null>(null);
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<ConfluencePageRef[]>([]);
  const [parent, setParent] = useState<ConfluencePageRef | null>(null);
  const [trash, setTrash] = useState(false);
  const [error, setError] = useState('');

  const pickSpace = (next: ConfluenceSpace | null, page: ConfluencePageRef | null = null) => {
    setSpace(next);
    setParent(page);
    setQuery('');
    setError('');
  };

  useEffect(() => {
    if (!space) return setPages([]);
    let cancelled = false;
    const timer = setTimeout(() => {
      api<ConfluencePageRef[]>(`/confluence/pages?space=${encodeURIComponent(space.key)}&q=${encodeURIComponent(query.trim())}`).then(
        (list) => !cancelled && setPages(list),
        (err) => !cancelled && setError((err as Error).message)
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [space, query]);

  // A parent from a pasted link may not be among the search results
  const pageList = parent && !pages.some((p) => p.id === parent.id) ? [parent, ...pages] : pages;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!space) return;
        onSubmit({
          kind: 'note' in target ? 'note' : 'folder',
          ...('note' in target ? { noteId: target.note } : { folder: target.folder }),
          spaceKey: space.key,
          parentId: parent?.id ?? null,
          parentTitle: parent?.title ?? null,
          trashOnDelete: trash,
        });
      }}
    >
      <p className="text-sm text-on-surface-variant">{tl(lang, 'note' in target ? 'confluence.setupNoteHint' : 'confluence.setupFolderHint')}</p>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="confluence-space">
          {tl(lang, 'confluence.space')}
        </label>
        <SpaceField value={space} onPick={pickSpace} onClear={() => pickSpace(null)} />
      </div>
      {space && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="confluence-parent">
            {tl(lang, 'confluence.parent')}
          </label>
          <div className="flex h-10 items-center gap-2 rounded-full border border-outline-variant bg-surface-container px-3.5 focus-within:border-primary">
            <Search size={15} className="shrink-0 text-on-surface-variant" />
            <input
              id="confluence-parent"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-on-surface-variant"
              placeholder={tl(lang, 'confluence.parentSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto">
            <li>
              <button type="button" className={`w-full rounded-xl px-3 py-1.5 text-left text-sm ${parent === null ? 'bg-secondary-container text-on-secondary-container' : 'hover:bg-surface-container'}`} onClick={() => setParent(null)}>
                {tl(lang, 'confluence.parentTop')}
              </button>
            </li>
            {pageList.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`w-full truncate rounded-xl px-3 py-1.5 text-left text-sm ${parent?.id === p.id ? 'bg-secondary-container text-on-secondary-container' : 'hover:bg-surface-container'}`}
                  onClick={() => setParent(p)}
                >
                  {p.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">{tl(lang, 'note' in target ? 'confluence.trashNote' : 'confluence.trashFolder')}</span>
        <Switch checked={trash} onChange={setTrash} label={tl(lang, 'note' in target ? 'confluence.trashNote' : 'confluence.trashFolder')} />
      </div>
      {error && <p className="text-sm text-error">{error}</p>}
      <button className="btn-primary rounded-full px-5" disabled={busy || !space}>
        <Cloud size={16} /> {tl(lang, 'confluence.start')}
      </button>
    </form>
  );
}
