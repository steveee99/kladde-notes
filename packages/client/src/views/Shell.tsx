import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChefHat,
  ChevronRight,
  Cloud,
  CloudOff,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Images,
  Inbox as InboxIcon,
  Lightbulb,
  Loader2,
  LocateFixed,
  Lock,
  LockOpen,
  Network,
  Pencil,
  Plus,
  Search,
  Share2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { excerpt, INBOX_FOLDER, Me, projectTitleOf, splitPath, toDateString } from '@kladde/shared';
import { createPortal } from 'react-dom';
import { openDialog } from '../lib/dialogs';
import { reviewDue } from './Review';
import { useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { navigate, usePath } from '../lib/router';
import { dragSource, useDropTarget } from '../lib/dnd';
import { isReadOnly, setReadOnly, useReadOnly } from '../lib/readOnly';
import { ShareDialog } from './ShareDialog';
import { MaterialShell } from './MaterialShell';
import { Avatar } from './Avatar';
import { editorHost } from '../editor/host';
import { folderDisplayName, locale, t, useLang } from '../lib/i18n';
import { useInboxZero } from '../lib/prefs';
import { setMaterialSidebarMode } from '../lib/sidebarMode';

export function newNote(folder?: string) {
  openDialog({ kind: 'note', folder });
}

export function importRecipe(url?: string) {
  openDialog({ kind: 'recipe', url });
}

export function newZettel() {
  openDialog({ kind: 'zettel' });
}

/** Opens today's daily note (or navigates to `/daily` if Daily Notes are turned off) */
export async function openTodayDailyNote(): Promise<void> {
  const { daily } = vault.features();
  if (!daily.enabled) {
    navigate('/daily');
    return;
  }
  const todayStr = toDateString(new Date());
  if (isReadOnly()) {
    const existing = vault.findDailyNote(todayStr);
    navigate(existing ? `/n/${existing.id}` : `/daily/${todayStr}`);
    return;
  }
  const note = await vault.openDailyNote(todayStr);
  navigate(`/n/${note.id}`);
}

export function SyncBadge() {
  useVault();
  useLang();
  const pending = vault.pendingCount();
  const { state, message } = vault;
  const label =
    state === 'syncing'
      ? t('common.syncing')
      : state === 'offline'
        ? `${t('common.offline')}${pending ? ` · ${t('nav.offlineLocal', { n: pending })}` : ''}`
        : state === 'error'
          ? message || t('common.syncError')
          : pending
            ? t('common.syncPending', { n: pending })
            : t('common.idle');
  const Icon = state === 'syncing' ? Loader2 : state === 'offline' ? CloudOff : state === 'error' ? AlertTriangle : Cloud;
  return (
    <button onClick={vault.kick} title={`${label} — ${t('common.syncAction')}`} aria-label={label} className={`chip transition-colors ${state === 'offline' ? 'text-warn' : state === 'error' ? 'text-danger' : ''}`}>
      <Icon size={14} className={state === 'syncing' ? 'animate-spin' : ''} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/** Switches the read-only mode for every page on this device */
export function ReadOnlyToggle() {
  const on = useReadOnly();
  useLang();
  const label = on ? t('nav.readOnlyOn') : t('nav.readOnlyOff');
  return (
    <button
      onClick={() => setReadOnly(!on)}
      title={on ? t('nav.readOnlyDisableTitle') : t('nav.readOnlyEnableTitle')}
      aria-pressed={on}
      aria-label={label}
      className={`chip transition-colors ${on ? 'bg-accent/15 text-accent' : 'hover:text-ink'}`}
    >
      {on ? <Lock size={14} /> : <LockOpen size={14} />}
      {on && <span>{t('nav.readOnlyBadge')}</span>}
    </button>
  );
}

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
}

function buildTree(folders: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const f of folders) {
    let level = root;
    const parts = f.split('/');
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let node = level.find((n) => n.name === name);
      if (!node) level.push((node = { name, path, children: [] }));
      level = node.children;
    });
  }
  return root;
}

/** Inline text field for new and renamed folders: Enter saves, Escape cancels */
export function FolderNameInput({ initial = '', placeholder, onDone }: { initial?: string; placeholder: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name?.trim() ? name.trim() : null);
  };
  return (
    <input
      autoFocus
      className="input anim-fade-in my-0.5 py-1 text-sm"
      placeholder={placeholder}
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value);
        if (e.key === 'Escape') finish(null);
      }}
    />
  );
}

interface RevealRequest {
  folder: string;
  noteId: string;
  nonce: number;
}

function SidebarNoteRow({
  note,
  active,
  highlighted,
  depth,
  onNavigate,
}: {
  note: LocalNote;
  active: boolean;
  highlighted?: boolean;
  depth: number;
  onNavigate?: () => void;
}) {
  const name = splitPath(note.path).name;
  const openNote = () => {
    navigate(`/n/${note.id}`);
    onNavigate?.();
  };
  return (
    <li style={{ paddingLeft: depth * 14 }}>
      {/* Not a <button>: browsers do not start a drag on buttons */}
      <div
        role="button"
        tabIndex={0}
        data-tree-note-id={note.id}
        aria-current={active ? 'page' : undefined}
        title={name}
        {...dragSource({ kind: 'note', id: note.id })}
        onClick={openNote}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openNote();
          }
        }}
        className={`group flex min-w-0 cursor-pointer items-center gap-2 rounded-full py-1.5 pl-[26px] pr-3 text-left text-sm transition-colors ${
          highlighted
            ? 'bg-accent/20 text-accent font-medium ring-2 ring-inset ring-accent/70'
            : active
              ? 'bg-accent-container text-on-accent-container font-medium'
              : 'text-muted hover:bg-raised hover:text-ink'
        }`}
      >
        <FileText
          size={14}
          className={`shrink-0 ${highlighted ? 'text-accent' : active ? 'text-on-accent-container' : 'text-faint group-hover:text-muted'}`}
        />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </div>
    </li>
  );
}

function FolderItem({
  node,
  current,
  activeFolder,
  activeNoteId,
  highlightedNoteId,
  revealRequest,
  notesByFolder,
  depth,
  onNavigate,
}: {
  node: TreeNode;
  current: string;
  activeFolder: string | null;
  activeNoteId: string | null;
  highlightedNoteId: string | null;
  revealRequest: RevealRequest | null;
  notesByFolder: Map<string, LocalNote[]>;
  depth: number;
  onNavigate?: () => void;
}) {
  const lang = useLang();
  const folderNotes = notesByFolder.get(node.path) ?? [];
  const hasChildren = node.children.length > 0 || folderNotes.length > 0;
  const containsActive = activeFolder !== null && (activeFolder === node.path || activeFolder.startsWith(`${node.path}/`));
  const [open, setOpen] = useState(containsActive);
  const [mode, setMode] = useState<'idle' | 'new' | 'rename'>('idle');
  const [sharing, setSharing] = useState(false);
  const drop = useDropTarget(node.path, () => setOpen(true));
  const active = current === `/f/${encodeURIComponent(node.path)}`;
  const empty = vault.isFolderEmpty(node.path);
  const locked = useReadOnly();
  const indent = { paddingLeft: depth * 14 };
  const displayName = folderDisplayName(node.name, lang);

  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [current, containsActive]);

  useEffect(() => {
    if (!revealRequest) return;
    if (revealRequest.folder === node.path || revealRequest.folder.startsWith(`${node.path}/`)) {
      setOpen(true);
    }
  }, [revealRequest?.nonce, revealRequest?.folder, node.path]);

  const openFolder = () => {
    setOpen(true);
    navigate(`/f/${encodeURIComponent(node.path)}`);
    onNavigate?.();
  };

  return (
    <li>
      {mode === 'rename' ? (
        <div style={indent} className="pl-6">
          <FolderNameInput
            initial={node.name}
            placeholder={t('nav.newFolderNamePlaceholder')}
            onDone={(name) => {
              setMode('idle');
              if (!name || name === node.name) return;
              const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
              const target = parent ? `${parent}/${name.replace(/\//g, '-')}` : name.replace(/\//g, '-');
              void vault.renameFolder(node.path, target).then(() => active && navigate(`/f/${encodeURIComponent(target)}`, true));
            }}
          />
        </div>
      ) : (
        <div
          {...dragSource({ kind: 'folder', path: node.path })}
          {...drop.props}
          className={`drop-target group flex min-w-0 items-center rounded-full pr-1.5 text-sm transition-colors ${drop.over ? 'drop-over' : active ? 'bg-accent-container text-on-accent-container font-medium' : 'text-muted hover:bg-raised hover:text-ink'}`}
          style={indent}
        >
          <button
            type="button"
            className={`shrink-0 p-1.5 transition-transform duration-200 ${hasChildren ? '' : 'invisible'} ${open ? 'rotate-90' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            aria-label={`${displayName}: ${open ? t('nav.collapseFolder') : t('nav.expandFolder')}`}
            aria-expanded={hasChildren ? open : undefined}
          >
            <ChevronRight size={14} />
          </button>
          {/* Not a <button>: browsers do not start a drag on buttons */}
          <div
            role="button"
            tabIndex={0}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 text-left"
            onClick={openFolder}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openFolder();
              }
            }}
            onDoubleClick={() => !isReadOnly() && setMode('rename')}
          >
            {open && hasChildren ? <FolderOpen size={15} className="shrink-0" /> : <Folder size={15} className="shrink-0" />}
            <span className="truncate">{displayName}</span>
          </div>
          <span className="edit-only flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <button className="rounded-full p-1 hover:bg-surface hover:text-ink" title={t('list.subfolderAdd')} onClick={() => (setOpen(true), setMode('new'))}>
              <FolderPlus size={13} />
            </button>
            <button className="rounded-full p-1 hover:bg-surface hover:text-ink" title={t('nav.renameFolder')} onClick={() => setMode('rename')}>
              <Pencil size={13} />
            </button>
            {!vault.standalone && (
              <button className="rounded-full p-1 hover:bg-surface hover:text-ink" title={t('nav.shareFolder')} onClick={() => setSharing(true)}>
                <Share2 size={13} />
              </button>
            )}
            {empty && (
              <button className="rounded-full p-1 hover:bg-surface hover:text-danger" title={t('nav.deleteEmptyFolder')} onClick={() => void vault.deleteFolder(node.path)}>
                <Trash2 size={13} />
              </button>
            )}
          </span>
          <span className={`w-5 shrink-0 text-right text-xs text-faint ${locked ? '' : 'group-hover:hidden [@media(hover:none)]:hidden'}`}>{folderNotes.length || ''}</span>
        </div>
      )}
      {/* Portal: the sidebar may be transformed (mobile drawer), which would trap a fixed overlay */}
      {sharing && createPortal(<ShareDialog target={{ folder: node.path }} onClose={() => setSharing(false)} />, document.body)}
      {open && (hasChildren || mode === 'new') && (
        <ul className="anim-fade-in">
          {mode === 'new' && (
            <li style={{ paddingLeft: (depth + 1) * 14 }} className="pl-6">
              <FolderNameInput
                placeholder={t('list.subfolderPlaceholder')}
                onDone={(name) => {
                  setMode('idle');
                  if (name) void vault.addFolder(`${node.path}/${name.replace(/\//g, '-')}`);
                }}
              />
            </li>
          )}
          {node.children.map((c) => (
            <FolderItem
              key={c.path}
              node={c}
              current={current}
              activeFolder={activeFolder}
              activeNoteId={activeNoteId}
              highlightedNoteId={highlightedNoteId}
              revealRequest={revealRequest}
              notesByFolder={notesByFolder}
              depth={depth + 1}
              onNavigate={onNavigate}
            />
          ))}
          {folderNotes.map((n) => (
            <SidebarNoteRow
              key={n.id}
              note={n}
              active={activeNoteId === n.id}
              highlighted={highlightedNoteId === n.id}
              depth={depth + 1}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({ me, onNavigate, isAdmin, headerAction }: { me: Me; onNavigate?: () => void; isAdmin?: boolean; headerAction?: React.ReactNode }) {
  const version = useVault();
  const lang = useLang();
  const loc = locale(lang);
  const inboxZero = useInboxZero();
  const locked = useReadOnly();
  const [newRoot, setNewRoot] = useState(false);
  const [query, setQuery] = useState('');
  const [revealRequest, setRevealRequest] = useState<RevealRequest | null>(null);
  const [flashNoteId, setFlashNoteId] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const rootDrop = useDropTarget('');
  const path = usePath();
  const folders = vault.folders();
  const notes = vault.list();
  const features = vault.features();
  const roleConfig = vault.roleConfig();
  const activeNoteId = path.startsWith('/n/') ? decodeURIComponent(path.slice(3)) : null;
  const activeNote = activeNoteId ? vault.get(activeNoteId) : undefined;
  const dailyNote = features.daily.enabled ? vault.findDailyNote() : undefined;
  const dailyRouteActive = path === '/daily' || path.startsWith('/daily/') || (!!dailyNote && activeNoteId === dailyNote.id);
  const settingsActive = path === '/settings' || path.startsWith('/settings/');
  const activeFolder = path.startsWith('/f/')
    ? decodeURIComponent(path.slice(3))
    : activeNote && activeNote.access === 'owner'
      ? splitPath(activeNote.path).folder
      : null;

  useEffect(() => {
    if (!revealRequest) return;
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        const container = sidebarRef.current;
        if (!container) return;
        for (const el of container.querySelectorAll<HTMLElement>('[data-tree-note-id]')) {
          if (el.dataset.treeNoteId === revealRequest.noteId) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.focus({ preventScroll: true });
            break;
          }
        }
      });
    });
    const timer = setTimeout(() => {
      setFlashNoteId((cur) => (cur === revealRequest.noteId ? null : cur));
    }, 1800);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [revealRequest]);

  const focusOpenNote = () => {
    if (!activeNote) return;
    if (query) setQuery('');
    if (activeNote.access !== 'owner') {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const target = sidebarRef.current?.querySelector<HTMLElement>('[data-tree-shared="true"]');
          target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          target?.focus({ preventScroll: true });
        })
      );
      return;
    }
    const folder = splitPath(activeNote.path).folder;
    setRevealRequest({ folder, noteId: activeNote.id, nonce: Date.now() });
    setFlashNoteId(activeNote.id);
  };

  const notesByFolder = useMemo(() => {
    const map = new Map<string, LocalNote[]>();
    for (const n of notes) {
      if (n.access !== 'owner') continue;
      const f = splitPath(n.path).folder;
      const list = map.get(f);
      if (list) list.push(n);
      else map.set(f, [n]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => splitPath(a.path).name.localeCompare(splitPath(b.path).name, loc, { numeric: true }));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, loc]);
  const rootNotes = notesByFolder.get('') ?? [];

  const shared = notes.filter((n) => n.access !== 'owner').length;
  const inboxCount = (notesByFolder.get(INBOX_FOLDER) ?? []).length;

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const searchResults = useMemo(() => {
    if (!terms.length) return [];
    const rc = vault.roleConfig();
    const list = vault
      .list()
      .filter((n) => {
        const hay = `${projectTitleOf(n.path, n.content, rc)}\n${n.path}\n${n.content}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      })
      .sort((a, b) => {
        const nameA = projectTitleOf(a.path, a.content, rc).toLowerCase();
        const nameB = projectTitleOf(b.path, b.content, rc).toLowerCase();
        const hitA = terms.every((term) => nameA.includes(term)) ? 1 : 0;
        const hitB = terms.every((term) => nameB.includes(term)) ? 1 : 0;
        if (hitA !== hitB) return hitB - hitA;
        return b.updatedAt - a.updatedAt;
      });
    return list.slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms, version]);

  const nav = (to: string) => {
    navigate(to);
    onNavigate?.();
  };
  const item = (to: string, Icon: typeof Home, label: string, extra?: React.ReactNode, dataAttrs?: Record<string, string>) => {
    const active = path === to;
    return (
      <button
        {...dataAttrs}
        onClick={() => nav(to)}
        aria-current={active ? 'page' : undefined}
        className={`flex w-full shrink-0 items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-colors ${active ? 'bg-accent-container text-on-accent-container' : 'text-muted hover:bg-raised hover:text-ink'}`}
      >
        <Icon size={18} className="shrink-0" /> <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {extra}
      </button>
    );
  };

  return (
    <div
      ref={sidebarRef}
      className="flex h-full flex-col gap-1 overflow-hidden p-3"
      onClick={(e) => (e.target as HTMLElement).closest('[data-close]') && onNavigate?.()}
    >
      <div className="mb-2 flex min-w-0 shrink-0 items-center gap-1.5 px-1">
        {headerAction}
        <img src="/icons/icon.svg" className="h-7 w-7 shrink-0" alt="" />
        <span className="min-w-0 truncate font-semibold tracking-tight">Kladde</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ReadOnlyToggle />
          <SyncBadge />
        </div>
      </div>

      {/* Inline Material 3 search bar in the sidebar */}
      <div className="mb-2 flex h-10 shrink-0 items-center gap-2 rounded-full border border-line/60 bg-raised px-3.5 transition-colors focus-within:border-accent">
        <Search size={16} className="shrink-0 text-muted" />
        <input
          data-search-input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              e.currentTarget.blur();
            } else if (e.key === 'Enter' && searchResults[0]) {
              nav(`/n/${searchResults[0].id}`);
            }
          }}
          placeholder={t('search.sidebarPlaceholder')}
          aria-label={t('common.search')}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-faint outline-none"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label={t('search.clear')} title={t('search.clear')} className="rounded-full p-0.5 text-muted transition-colors hover:bg-surface hover:text-ink">
            <X size={14} />
          </button>
        )}
      </div>

      {terms.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pr-0.5">
          <div className="mb-1.5 flex items-center gap-1 px-2 text-xs font-medium text-faint">
            <span className="min-w-0 flex-1 truncate">{t('search.resultsCount', { n: searchResults.length })}</span>
            {activeNote && (
              <button
                type="button"
                data-focus-open-note="true"
                className="rounded-full p-1 transition-colors hover:bg-raised hover:text-ink"
                title={t('nav.focusOpenNote')}
                aria-label={t('nav.focusOpenNote')}
                onClick={focusOpenNote}
              >
                <LocateFixed size={14} />
              </button>
            )}
          </div>
          {searchResults.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted">{t('search.noResults')}</p>
          ) : (
            <ul className="space-y-1">
              {searchResults.map((n) => {
                const { folder } = splitPath(n.path);
                const title = projectTitleOf(n.path, n.content, roleConfig);
                const active = path === `/n/${n.id}`;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => nav(`/n/${n.id}`)}
                      aria-current={active ? 'page' : undefined}
                      className={`w-full rounded-2xl px-3 py-2 text-left transition-colors ${active ? 'bg-accent-container text-on-accent-container' : 'hover:bg-raised'}`}
                    >
                      <div className="truncate text-sm font-medium">{title}</div>
                      <div className="truncate text-[11px] text-muted">{folderDisplayName(folder, lang)}</div>
                      {excerpt(n.content, 65) && <div className="mt-0.5 truncate text-xs text-faint">{excerpt(n.content, 65)}</div>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto scrollbar-thin">
          {item('/', Home, t('nav.home'))}
          {features.daily.enabled && (!locked || !!dailyNote) && (
            <button
              type="button"
              onClick={() => void openTodayDailyNote().then(() => onNavigate?.())}
              aria-current={dailyRouteActive ? 'page' : undefined}
              title={t('daily.todayBtn')}
              className={`flex w-full shrink-0 items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-colors ${
                dailyRouteActive ? 'bg-accent-container text-on-accent-container' : 'text-muted hover:bg-raised hover:text-ink'
              }`}
            >
              <CalendarDays size={18} className="shrink-0" /> <span className="min-w-0 flex-1 truncate text-left">{t('daily.navLabel')}</span>
            </button>
          )}
          {features.heatmap.enabled && item('/calendar', CalendarRange, t('nav.calendar'))}
          {item('/notes', FileText, t('nav.allNotes'), <span className="text-xs opacity-75">{notes.filter((n) => n.access === 'owner').length}</span>)}
          {item('/inbox', InboxIcon, t('nav.inbox'), inboxZero && inboxCount > 0 ? <span className="rounded-full bg-warn/15 px-1.5 py-0.5 text-xs font-semibold text-warn">{inboxCount}</span> : null)}
          {item('/graph', Network, t('nav.graph'))}
          {item('/files', Images, t('nav.files'))}
          {item('/review', CalendarCheck, t('nav.review'), reviewDue() ? <span className="h-2 w-2 rounded-full bg-accent" /> : null)}
          {(shared > 0 || vault.sharedFolders.length > 0) &&
            !vault.standalone &&
            item('/shared', Share2, t('nav.sharedWithMe'), <span className="text-xs opacity-75">{shared || ''}</span>, { 'data-tree-shared': 'true' })}
          <div className="mt-3 mb-1 flex items-center gap-1 px-3 text-xs font-semibold uppercase tracking-wider text-faint">
            <span className="min-w-0 flex-1 truncate">{t('nav.folders')}</span>
            <button
              type="button"
              data-focus-open-note="true"
              className="rounded-full p-1 transition-colors hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              title={activeNote ? t('nav.focusOpenNote') : t('nav.focusOpenNoteEmpty')}
              aria-label={t('nav.focusOpenNote')}
              disabled={!activeNote}
              onClick={focusOpenNote}
            >
              <LocateFixed size={14} />
            </button>
            <button className="edit-only rounded-full p-1 hover:bg-raised hover:text-ink" title={t('nav.newFolder')} aria-label={t('nav.newFolder')} onClick={() => setNewRoot(true)}>
              <FolderPlus size={14} />
            </button>
          </div>
          <ul className="min-h-[8rem] flex-1 overflow-y-auto scrollbar-thin">
            {newRoot && (
              <li className="px-1">
                <FolderNameInput
                  placeholder={t('nav.folderPlaceholder')}
                  onDone={(name) => {
                    setNewRoot(false);
                    if (name) void vault.addFolder(name);
                  }}
                />
              </li>
            )}
            {buildTree(folders).map((n) => (
              <FolderItem
                key={n.path}
                node={n}
                current={path}
                activeFolder={activeFolder}
                activeNoteId={activeNoteId}
                highlightedNoteId={flashNoteId}
                revealRequest={revealRequest}
                notesByFolder={notesByFolder}
                depth={0}
                onNavigate={onNavigate}
              />
            ))}
            {rootNotes.map((n) => (
              <SidebarNoteRow
                key={n.id}
                note={n}
                active={activeNoteId === n.id}
                highlighted={flashNoteId === n.id}
                depth={0}
                onNavigate={onNavigate}
              />
            ))}
            <li className="edit-only mt-1">
              <div {...rootDrop.props} className={`drop-target drop-zone-root rounded-xl border border-dashed border-line px-3 py-2 text-xs text-faint ${rootDrop.over ? 'drop-over' : ''}`}>
                {t('nav.dropTopLevel')}
              </div>
            </li>
          </ul>
          <div className="edit-only mt-2 grid shrink-0 grid-cols-2 gap-2">
            <button
              className={`btn-primary ${features.zettel.enabled ? '' : 'col-span-2'}`}
              onClick={() => (newNote(), onNavigate?.())}
            >
              <Plus size={16} /> {features.zettel.enabled ? t('nav.newNoteShort') : t('nav.newNote')}
            </button>
            {features.zettel.enabled && (
              <button className="btn-ghost border border-line" onClick={() => (newZettel(), onNavigate?.())} title={t('nav.zettelTitle')}>
                <Lightbulb size={16} /> Zettel
              </button>
            )}
            {features.recipe.enabled && (
              <button className="btn-ghost col-span-2 border border-line" onClick={() => (importRecipe(), onNavigate?.())} title={t('quick.recipeTitle')}>
                <ChefHat size={16} /> {t('nav.recipe')}
              </button>
            )}
          </div>
          {isAdmin && item('/admin', ShieldCheck, t('nav.admin'))}
          <button
            type="button"
            onClick={() => nav('/settings')}
            aria-current={settingsActive ? 'page' : undefined}
            className={`flex w-full shrink-0 items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-colors ${
              settingsActive ? 'bg-accent-container text-on-accent-container' : 'text-muted hover:bg-raised hover:text-ink'
            }`}
          >
            <Avatar name={me.username} avatarUrl={me.avatarUrl} size="xs" active={settingsActive} />
            <span className="flex-1 truncate text-left">{t('nav.settings')}</span>
            <span className="truncate text-xs opacity-70">{me.username}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Strg/⌘+K opens/focuses the search bar in the sidebar from anywhere */
function useSearchShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      e.stopPropagation();
      if (window.innerWidth >= 768) {
        setMaterialSidebarMode('sticky');
      } else {
        window.dispatchEvent(new CustomEvent('kladde:open-search'));
      }
      requestAnimationFrame(() =>
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-search-input]')?.select())
      );
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/** Strg/⌘+S flushes pending edits and triggers an immediate sync with Material 3 snackbar feedback */
function useSaveShortcut(showToast: (text: string, tone?: 'ok' | 'warn' | 'danger') => void) {
  const running = useRef(false);
  const triggerSave = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      window.dispatchEvent(new CustomEvent('kladde:flush-note'));
      editorHost.flush();
      await vault.sync();
      if (vault.state === 'offline') showToast(t('common.syncSavedLocalToast'), 'warn');
      else if (vault.state === 'error') showToast(vault.message || t('common.syncError'), 'danger');
      else showToast(t('common.syncSavedToast'), 'ok');
    } finally {
      running.current = false;
    }
  }, [showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      e.stopPropagation();
      void triggerSave();
    };
    const onSaveEvent = () => void triggerSave();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('kladde:save', onSaveEvent);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('kladde:save', onSaveEvent);
    };
  }, [triggerSave]);
}

/** Strg/⌘+Shift+D opens today's Daily Note from anywhere (works inside CodeMirror too) */
function useDailyShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'd' && e.code !== 'KeyD') return;
      e.preventDefault();
      e.stopPropagation();
      void openTodayDailyNote();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

export function Shell({ me, children, isAdmin }: { me: Me; children: React.ReactNode; isAdmin?: boolean }) {
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' | 'danger' } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((text: string, tone: 'ok' | 'warn' | 'danger' = 'ok') => {
    setToast({ text, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useSearchShortcut();
  useSaveShortcut(showToast);
  useDailyShortcut();

  return (
    <>
      <MaterialShell me={me} isAdmin={isAdmin}>{children}</MaterialShell>
      {toast &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className="no-print pointer-events-none fixed bottom-20 left-1/2 z-[80] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-2xl border border-line/60 bg-raised px-4 py-2.5 text-sm font-medium text-ink shadow-soft anim-fade-up md:bottom-6"
          >
            {toast.tone === 'ok' && <CheckCircle2 size={16} className="shrink-0 text-ok" />}
            {toast.tone === 'warn' && <CloudOff size={16} className="shrink-0 text-warn" />}
            {toast.tone === 'danger' && <AlertTriangle size={16} className="shrink-0 text-danger" />}
            <span className="truncate">{toast.text}</span>
          </div>,
          document.body
        )}
    </>
  );
}
