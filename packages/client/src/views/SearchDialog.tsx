import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { excerpt, isExcalidrawNote, pdfNoteOf, projectTitleOf, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { Draw, FileText, FileType2, Psychology, Search as SearchIcon, Users, X } from '../lib/icons';
import { folderDisplayName, t, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useVisualViewport } from '../lib/viewport';
import { AttachmentHitList, useAttachmentSearch } from './AttachmentHits';
import { ItemIcon } from './IconPicker';

/*
 * Search as an overlay (Ctrl/⌘+K, the search field in the sidebar, the search button on mobile): a
 * field on top, compact results (two lines at most) below, picked with the arrow keys and opened with
 * Enter. Without a query it lists the recently edited notes, so it also works as a quick switcher.
 */

const OPEN_EVENT = 'kladde:open-search';

/** Opens the search overlay (or puts the focus back into its field when it is open already) */
export function openSearch(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/** Mounted once in the shell: shows the overlay on `openSearch()` */
export function SearchDialogHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-search-dialog-input]')?.select());
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  return open ? <SearchDialog onClose={() => setOpen(false)} /> : null;
}

const MAX_RESULTS = 60;
const MEMORY_PREF = 'kladde_search_memory';
const RECENT = 8;

/** Lower-cased words of the query */
export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Notes whose title, path or text contain every term; title matches first, then the most recently edited */
export function searchNotes(notes: LocalNote[], terms: string[], titleOf: (n: LocalNote) => string): LocalNote[] {
  if (!terms.length) return [];
  const hits: { note: LocalNote; inTitle: boolean }[] = [];
  for (const note of notes) {
    const title = titleOf(note).toLowerCase();
    const hay = `${title}\n${note.path.toLowerCase()}\n${note.content.toLowerCase()}`;
    if (terms.every((term) => hay.includes(term))) hits.push({ note, inTitle: terms.every((term) => title.includes(term)) });
  }
  hits.sort((a, b) => (a.inTitle === b.inTitle ? b.note.updatedAt - a.note.updatedAt : a.inTitle ? -1 : 1));
  return hits.slice(0, MAX_RESULTS).map((h) => h.note);
}

/** The text around the first match (plain text without markup), or the start of the note */
function snippetOf(content: string, terms: string[]): string {
  const plain = excerpt(content, 4000);
  const lower = plain.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at <= 40) return plain.slice(0, 160);
  const start = plain.lastIndexOf(' ', at - 30);
  return `… ${plain.slice(start < 0 ? at - 30 : start + 1, at + 130)}`;
}

/** `text` with every term of two or more letters marked (case-insensitive); React escapes the parts */
function Highlight({ text, terms: all }: { text: string; terms: string[] }) {
  // Single letters would mark half the text
  const terms = all.filter((term) => term.length > 1);
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-[3px] bg-tertiary-container px-px text-on-tertiary-container">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const version = useVault();
  const lang = useLang();
  const vp = useVisualViewport();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const terms = useMemo(() => searchTerms(query), [query]);
  const attachmentHits = useAttachmentSearch(query);
  const roleConfig = vault.roleConfig();

  // The AI memory (#94) can be left out; its hits come after the user's own notes
  const memoryOn = !!vault.memoryFolder();
  const [withMemory, setWithMemory] = useState(() => {
    try {
      return localStorage.getItem(MEMORY_PREF) !== 'off';
    } catch {
      return true;
    }
  });
  const toggleMemory = () => {
    setWithMemory(!withMemory);
    try {
      localStorage.setItem(MEMORY_PREF, withMemory ? 'off' : 'on');
    } catch {
      // per-device convenience only
    }
  };

  const results = useMemo(() => {
    const notes = vault.list().filter((n) => withMemory || !vault.isMemoryNote(n));
    const titleOf = (n: LocalNote) => projectTitleOf(n.path, n.content, roleConfig);
    const ranked = terms.length ? searchNotes(notes, terms, titleOf) : [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
    const ordered = memoryOn ? [...ranked.filter((n) => !vault.isMemoryNote(n)), ...ranked.filter((n) => vault.isMemoryNote(n))] : ranked;
    return terms.length ? ordered : ordered.slice(0, RECENT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms, version, withMemory, memoryOn]);

  // A new query starts again at the top
  useEffect(() => setActive(0), [query]);
  const selected = Math.min(active, Math.max(results.length - 1, 0));
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-search-result="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, results]);

  const close = (restoreFocus = true) => {
    onClose();
    if (restoreFocus) requestAnimationFrame(() => returnFocus.current?.isConnected && returnFocus.current.focus({ preventScroll: true }));
  };
  const open = (id: string) => {
    close(false);
    navigate(`/n/${id}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      setActive((selected + 1) % results.length);
    } else if (e.key === 'ArrowUp' && results.length) {
      e.preventDefault();
      setActive((selected - 1 + results.length) % results.length);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && results[selected]) {
      e.preventDefault();
      open(results[selected].id);
    }
  };

  const groupName = (n: LocalNote) => (n.group ? vault.group(n.group)?.name ?? '' : '');

  return createPortal(
    <div
      className="fixed inset-x-0 z-[70] flex justify-center sm:items-start sm:px-4 sm:pt-[min(12vh,7rem)]"
      style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}
      role="presentation"
    >
      <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" onClick={() => close()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('common.search')}
        onKeyDown={onKeyDown}
        className="relative flex h-full w-full flex-col overflow-hidden bg-surface-container-high shadow-elevation-3 anim-fade-up safe-top sm:h-auto sm:max-h-[min(36rem,calc(100%-2rem))] sm:max-w-2xl sm:rounded-[28px] sm:!pt-0"
      >
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-outline-variant/60 pl-4 pr-2">
          <SearchIcon size={20} className="shrink-0 text-on-surface-variant" />
          <input
            autoFocus
            data-search-dialog-input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-expanded
            aria-controls="search-dialog-results"
            aria-activedescendant={results.length ? `search-dialog-result-${selected}` : undefined}
            aria-autocomplete="list"
            placeholder={t('search.sidebarPlaceholder')}
            aria-label={t('common.search')}
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-body-l text-on-surface outline-none placeholder:text-on-surface-variant"
          />
          {query && (
            <button type="button" className="btn-icon shrink-0" onClick={() => setQuery('')} aria-label={t('search.clear')} title={t('search.clear')}>
              <X size={18} />
            </button>
          )}
          <button type="button" className="btn-text shrink-0 !px-3 sm:hidden" onClick={() => close()}>
            {t('common.cancel')}
          </button>
          <kbd className="mr-2 hidden shrink-0 rounded-md border border-outline-variant px-1.5 py-0.5 font-sans text-label-s text-on-surface-variant sm:inline">Esc</kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 scrollbar-thin">
          <div className="flex items-center gap-2 px-3 pb-1 pt-1.5">
            <p className="min-w-0 flex-1 text-label-m text-on-surface-variant">
              {terms.length ? t('search.resultsCount', { n: results.length }) : results.length ? t('search.recent') : ''}
            </p>
            {memoryOn && (
              <button
                type="button"
                className={`chip shrink-0 ${withMemory ? 'bg-secondary-container text-on-secondary-container' : ''}`}
                aria-pressed={withMemory}
                onClick={toggleMemory}
                data-search-memory
              >
                <Psychology size={14} /> {t('memory.searchToggle')}
              </button>
            )}
          </div>
          {terms.length > 0 && results.length === 0 && !attachmentHits.length && (
            <p className="px-3 py-8 text-center text-body-m text-on-surface-variant">{t('search.noResults')}</p>
          )}
          <ul ref={listRef} id="search-dialog-results" role="listbox" aria-label={t('common.search')}>
            {results.map((n, i) => {
              const { folder } = splitPath(n.path);
              const title = projectTitleOf(n.path, n.content, roleConfig);
              const icon = vault.noteIcon(n);
              const TypeIcon = vault.isMemoryNote(n) ? Psychology : pdfNoteOf(n.content) ? FileType2 : isExcalidrawNote(n.content) ? Draw : FileText;
              const group = groupName(n);
              const where = [group, folder ? folderDisplayName(folder, lang) : ''].filter(Boolean).join(' / ');
              const snippet = snippetOf(n.content, terms);
              const isSelected = i === selected;
              return (
                <li key={n.id} id={`search-dialog-result-${i}`} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    tabIndex={-1}
                    data-search-result={i}
                    onClick={() => open(n.id)}
                    onMouseMove={() => isSelected || setActive(i)}
                    className={`flex w-full min-w-0 items-start gap-3 rounded-2xl px-3 py-2 text-left transition-colors ${
                      isSelected ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface'
                    }`}
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                      {icon ? <ItemIcon icon={icon} size={18} /> : <TypeIcon size={18} className={isSelected ? '' : 'text-on-surface-variant'} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-title-s">
                          <Highlight text={title} terms={terms} />
                        </span>
                        {where && (
                          <span className={`flex max-w-[45%] shrink-0 items-center gap-1 truncate text-label-s ${isSelected ? '' : 'text-on-surface-variant'}`}>
                            {group && <Users size={12} className="shrink-0" />}
                            <span className="truncate">{where}</span>
                          </span>
                        )}
                      </span>
                      {snippet && (
                        <span className={`block truncate text-body-s ${isSelected ? '' : 'text-on-surface-variant'}`}>
                          <Highlight text={snippet} terms={terms} />
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <AttachmentHitList compact hits={attachmentHits} onOpen={open} />
        </div>

        <div className="hidden shrink-0 items-center gap-4 border-t border-outline-variant/60 px-4 py-2 text-label-s text-on-surface-variant [@media(hover:hover)]:sm:flex">
          <span>
            <kbd className="font-sans">↑</kbd> <kbd className="font-sans">↓</kbd> {t('search.hintSelect')}
          </span>
          <span>
            <kbd className="font-sans">Enter</kbd> {t('search.hintOpen')}
          </span>
          <span>
            <kbd className="font-sans">Esc</kbd> {t('search.hintClose')}
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
