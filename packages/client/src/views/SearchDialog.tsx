import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isDatabasePath, isExcalidrawNote, pdfNoteOf, projectTitleOf, searchNotes, searchSnippet, searchTerms, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { api } from '../lib/api';
import type { LocalNote } from '../data/db';
import { CheckSquare, Draw, FileText, FileType2, Psychology, Search as SearchIcon, Users, X } from '../lib/icons';
import { openInSide, splitAvailable } from '../lib/panes';
import { formatDue } from '../editor/widgets';
import { collectTasks, type TaskRow } from './TaskParts';
import type { Command } from './commands';
import { folderDisplayName, t, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useVisualViewport } from '../lib/viewport';
import { AttachmentHitList, useAttachmentSearch } from './AttachmentHits';
import { ItemIcon } from './IconPicker';

/*
 * Search and command palette as an overlay (Ctrl/⌘+K, the search field in the top bar, the search button on
 * mobile): a field on top, notes, open tasks and commands below, picked with the arrow keys and run with Enter
 * (Ctrl/⌘+Enter opens a note to the side). A query starting with `>` lists only commands. Without a query it
 * lists the recently edited notes, so it also works as a quick switcher.
 */

const OPEN_EVENT = 'kladde:open-search';

/** Opens the search overlay (or puts the focus back into its field when it is open already) */
export function openSearch(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/** Mounted once in the shell: shows the overlay on `openSearch()` */
export function SearchDialogHost({ commands }: { commands?: () => Command[] } = {}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-search-dialog-input]')?.select());
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  return open ? <SearchDialog onClose={() => setOpen(false)} commands={commands} /> : null;
}

const MEMORY_PREF = 'kladde_search_memory';
const RECENT = 8;

export { searchNotes, searchTerms } from '@kladde/shared';

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

/** Commands whose label or keywords contain every term */
function matchCommands(commands: Command[], terms: string[]): Command[] {
  if (!terms.length) return commands;
  return commands.filter((c) => {
    const hay = `${c.label} ${c.keywords ?? ''}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

type Item =
  | { kind: 'note'; note: LocalNote }
  | { kind: 'task'; task: TaskRow }
  | { kind: 'command'; command: Command };

const MAX_TASKS = 5;
const MAX_COMMANDS = 6;

function SearchDialog({ onClose, commands }: { onClose: () => void; commands?: () => Command[] }) {
  const version = useVault();
  const lang = useLang();
  const vp = useVisualViewport();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const commandMode = query.trimStart().startsWith('>');
  const text = commandMode ? query.trimStart().slice(1) : query;
  const terms = useMemo(() => searchTerms(text), [text]);
  const attachmentHits = useAttachmentSearch(commandMode ? '' : query);
  const roleConfig = vault.roleConfig();
  const allCommands = useMemo(() => commands?.() ?? [], [commands]);

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

  // Online mode: the device has only the texts it opened, so the server searches (the notes stay in the catalog)
  const [remote, setRemote] = useState<{ key: string; hits: { id: string; snippet: string }[] } | null>(null);
  const remoteKey = `${terms.join(' ')}|${withMemory}`;
  useEffect(() => {
    if (!vault.online || commandMode || !terms.length) return;
    let live = true;
    const memory = vault.memoryFolder();
    const timer = setTimeout(() => {
      const skip = !withMemory && memory ? `&skip=${encodeURIComponent(memory)}` : '';
      api<{ hits: { id: string; snippet: string }[] }>(`/online/search?q=${encodeURIComponent(terms.join(' '))}${skip}`)
        .then((r) => live && setRemote({ key: remoteKey, hits: r.hits }))
        .catch(() => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteKey, commandMode]);
  const remoteHits = vault.online && remote?.key === remoteKey ? remote.hits : null;
  const snippets = useMemo(() => new Map((remoteHits ?? []).map((h) => [h.id, h.snippet])), [remoteHits]);

  const notes = useMemo(() => {
    if (commandMode) return [];
    const list = vault.list().filter((n) => !isDatabasePath(n.path) && (withMemory || !vault.isMemoryNote(n)));
    const titleOf = (n: LocalNote) => projectTitleOf(n.path, n.content, roleConfig);
    let ranked: LocalNote[];
    if (vault.online && terms.length) {
      // The server's hits, then notes only this device has (not pushed yet) or whose text it holds
      const allowed = new Set(list);
      const fromServer = (remoteHits ?? []).map((h) => vault.get(h.id)).filter((n): n is LocalNote => !!n && allowed.has(n));
      const seen = new Set(fromServer.map((n) => n.id));
      ranked = [...fromServer, ...searchNotes(list.filter((n) => !n.partial && !seen.has(n.id)), terms, titleOf)];
    } else ranked = terms.length ? searchNotes(list, terms, titleOf) : [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    const ordered = memoryOn ? [...ranked.filter((n) => !vault.isMemoryNote(n)), ...ranked.filter((n) => vault.isMemoryNote(n))] : ranked;
    return terms.length ? ordered : ordered.slice(0, RECENT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms, version, withMemory, memoryOn, commandMode, remoteHits]);

  const tasks = useMemo(() => {
    if (commandMode || !terms.length) return [];
    return collectTasks(version)
      .filter((tk) => !tk.done && terms.every((term) => tk.text.toLowerCase().includes(term)))
      .slice(0, MAX_TASKS);
  }, [terms, version, commandMode]);

  const matchedCommands = useMemo(() => {
    if (commandMode) return matchCommands(allCommands, terms);
    return terms.length ? matchCommands(allCommands, terms).slice(0, MAX_COMMANDS) : [];
  }, [allCommands, terms, commandMode]);

  const sections: { key: string; label: string; items: Item[] }[] = [
    { key: 'notes', label: terms.length ? t('palette.notes') : t('search.recent'), items: notes.map((note) => ({ kind: 'note' as const, note })) },
    { key: 'tasks', label: t('palette.tasks'), items: tasks.map((task) => ({ kind: 'task' as const, task })) },
    { key: 'commands', label: t('palette.commands'), items: matchedCommands.map((command) => ({ kind: 'command' as const, command })) },
  ].filter((sec) => sec.items.length);
  const items = sections.flatMap((sec) => sec.items);

  // A new query starts again at the top
  useEffect(() => setActive(0), [query]);
  const selected = Math.min(active, Math.max(items.length - 1, 0));
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-search-result="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, items.length]);

  const close = (restoreFocus = true) => {
    onClose();
    if (restoreFocus) requestAnimationFrame(() => returnFocus.current?.isConnected && returnFocus.current.focus({ preventScroll: true }));
  };
  const open = (id: string) => {
    close(false);
    navigate(`/n/${id}`);
  };
  const run = (item: Item, side = false) => {
    if (item.kind === 'note') {
      // The side pane sits next to an open note; without one the note opens normally
      if (side && splitAvailable() && location.pathname.includes('/n/')) {
        close(false);
        openInSide(item.note.id);
      } else open(item.note.id);
    } else if (item.kind === 'task') {
      close(false);
      navigate(`/n/${item.task.noteId}?line=${item.task.line + 1}`);
    } else {
      close(false);
      item.command.run();
    }
  };
  const setScope = (commandsOnly: boolean) => {
    setQuery(commandsOnly ? `>${commandMode ? text : query}` : text.trimStart());
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      setActive((selected + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      setActive((selected - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && items[selected]) {
      e.preventDefault();
      run(items[selected], e.metaKey || e.ctrlKey);
    }
  };

  const groupName = (n: LocalNote) => (n.group ? vault.group(n.group)?.name ?? '' : '');
  const rowClass = (isSelected: boolean) =>
    `flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-left ${isSelected ? 'bg-line text-text' : 'text-text'}`;
  let index = -1;

  return createPortal(
    <div
      className="fixed inset-x-0 z-[70] flex justify-center sm:items-start sm:px-4 sm:pt-[min(12vh,7rem)]"
      style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}
      role="presentation"
    >
      <div className="fixed inset-0 bg-scrim/60 anim-fade-in" onClick={() => close()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('common.search')}
        onKeyDown={onKeyDown}
        data-command-palette
        className="relative flex h-full w-full flex-col overflow-hidden bg-bar shadow-elevation-3 anim-fade-up safe-top sm:h-auto sm:max-h-[min(36rem,calc(100%-2rem))] sm:max-w-[640px] sm:rounded-2xl sm:border sm:border-line2 sm:!pt-0"
      >
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line pl-4 pr-2">
          <SearchIcon size={20} className="shrink-0 text-acc" />
          <input
            ref={inputRef}
            autoFocus
            data-search-dialog-input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-expanded
            aria-controls="search-dialog-results"
            aria-activedescendant={items.length ? `search-dialog-result-${selected}` : undefined}
            aria-autocomplete="list"
            placeholder={t('palette.placeholder')}
            aria-label={t('common.search')}
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-body-l text-strong outline-none placeholder:text-muted"
          />
          {query && (
            <button type="button" className="btn-icon shrink-0" onClick={() => setQuery('')} aria-label={t('search.clear')} title={t('search.clear')}>
              <X size={18} />
            </button>
          )}
          <div role="group" aria-label={t('palette.commands')} className="hidden shrink-0 gap-1.5 sm:flex">
            <button type="button" className="chip" aria-pressed={!commandMode} onClick={() => setScope(false)}>
              {t('palette.all')}
            </button>
            <button type="button" className="chip" aria-pressed={commandMode} onClick={() => setScope(true)} data-palette-commands>
              &gt; {t('palette.commands')}
            </button>
          </div>
          <button type="button" className="btn-text shrink-0 !px-3 sm:hidden" onClick={() => close()}>
            {t('common.cancel')}
          </button>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 scrollbar-thin">
          {!commandMode && (
            <div className="flex items-center gap-2 px-3 pb-1 pt-1.5">
              <p className="min-w-0 flex-1 text-label-m text-muted">{terms.length ? t('search.resultsCount', { n: notes.length }) : ''}</p>
              {memoryOn && (
                <button type="button" className="chip shrink-0" aria-pressed={withMemory} onClick={toggleMemory} data-search-memory>
                  <Psychology size={14} /> {t('memory.searchToggle')}
                </button>
              )}
            </div>
          )}
          {items.length === 0 && (terms.length > 0 || commandMode) && !attachmentHits.length && (
            <p className="px-3 py-8 text-center text-body-m text-muted">{commandMode ? t('palette.noCommands') : t('search.noResults')}</p>
          )}
          <div id="search-dialog-results" role="listbox" aria-label={t('common.search')}>
            {sections.map((sec) => (
              <ul key={sec.key} role="group" aria-label={sec.label} className="pb-1">
                <li role="presentation" className="section-label px-3 pb-1 pt-2.5">
                  {sec.label}
                </li>
                {sec.items.map((item) => {
                  index += 1;
                  const i = index;
                  const isSelected = i === selected;
                  const common = {
                    'data-search-result': i,
                    onClick: () => run(item),
                    onMouseMove: () => isSelected || setActive(i),
                    className: rowClass(isSelected),
                  };
                  if (item.kind === 'command') {
                    const c = item.command;
                    return (
                      <li key={`c-${c.id}`} id={`search-dialog-result-${i}`} role="option" aria-selected={isSelected} data-command={c.id}>
                        <div {...common}>
                          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center ${isSelected ? 'text-acc' : 'text-muted'}`}>{c.icon}</span>
                          <span className="min-w-0 flex-1 truncate text-body-m">
                            <Highlight text={c.label} terms={terms} />
                          </span>
                          {c.hint && <kbd className="kbd shrink-0">{c.hint}</kbd>}
                        </div>
                      </li>
                    );
                  }
                  if (item.kind === 'task') {
                    const tk = item.task;
                    return (
                      <li key={`t-${tk.noteId}-${tk.line}`} id={`search-dialog-result-${i}`} role="option" aria-selected={isSelected}>
                        <div {...common}>
                          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center ${isSelected ? 'text-acc' : 'text-muted'}`}>
                            <CheckSquare size={16} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body-m">
                              <Highlight text={tk.text} terms={terms} />
                            </span>
                            <span className="block truncate text-body-s text-muted">{[tk.due ? formatDue(tk.due) : '', tk.noteTitle].filter(Boolean).join(' · ')}</span>
                          </span>
                        </div>
                      </li>
                    );
                  }
                  const n = item.note;
                  const { folder } = splitPath(n.path);
                  const title = projectTitleOf(n.path, n.content, roleConfig);
                  const icon = vault.noteIcon(n);
                  const TypeIcon = vault.isMemoryNote(n) ? Psychology : pdfNoteOf(n.content) ? FileType2 : isExcalidrawNote(n.content) ? Draw : FileText;
                  const group = groupName(n);
                  const where = [group, folder ? folderDisplayName(folder, lang) : ''].filter(Boolean).join(' / ');
                  const snippet = snippets.get(n.id) ?? searchSnippet(n.content, terms);
                  return (
                    // The option itself is clickable: a button inside an option would be a control in a control (#63);
                    // the keyboard works through the combobox (arrows, Enter)
                    <li key={n.id} id={`search-dialog-result-${i}`} role="option" aria-selected={isSelected}>
                      <div {...common}>
                        <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center ${isSelected ? 'text-acc' : 'text-muted'}`}>
                          {icon ? <ItemIcon icon={icon} size={18} /> : <TypeIcon size={18} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-body-m font-medium">
                              <Highlight text={title} terms={terms} />
                            </span>
                            {where && (
                              <span className="flex max-w-[45%] shrink-0 items-center gap-1 truncate text-label-s text-muted">
                                {group && <Users size={12} className="shrink-0" />}
                                <span className="truncate">{where}</span>
                              </span>
                            )}
                          </span>
                          {snippet && (
                            <span className="block truncate text-body-s text-muted">
                              <Highlight text={snippet} terms={terms} />
                            </span>
                          )}
                        </span>
                        {isSelected && <kbd className="kbd mt-0.5 shrink-0">↵</kbd>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ))}
          </div>
          {!commandMode && <AttachmentHitList compact hits={attachmentHits} onOpen={open} />}
        </div>

        <div className="hidden shrink-0 items-center gap-4 border-t border-line px-4 py-2 font-mono text-[11px] text-muted [@media(hover:hover)]:sm:flex">
          <span>↑↓ {t('search.hintSelect')}</span>
          <span>↵ {t('search.hintOpen')}</span>
          {splitAvailable() && <span>⌘↵ {t('palette.hintSide')}</span>}
          <span>&gt; {t('palette.hintCommands')}</span>
          <span className="ml-auto">Esc {t('search.hintClose')}</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
