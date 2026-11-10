import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck,
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
  Lock,
  LockOpen,
  Network,
  Pencil,
  Plus,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { excerpt, PARA, splitPath } from '@kladde/shared';
import { createPortal } from 'react-dom';
import { openDialog } from '../lib/dialogs';
import { Dialogs } from './Dialogs';
import { reviewDue } from './Review';
import { useVault, vault } from '../data/vault';
import { navigate, usePath } from '../lib/router';
import { dragSource, useDropTarget } from '../lib/dnd';
import { isReadOnly, setReadOnly, useReadOnly } from '../lib/readOnly';
import { ShareDialog } from './ShareDialog';
import { MaterialShell } from './MaterialShell';
import { editorHost } from '../editor/host';
import { folderDisplayName, t, useLang } from '../lib/i18n';
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

function FolderItem({ node, current, counts, depth, onNavigate }: { node: TreeNode; current: string; counts: Map<string, number>; depth: number; onNavigate?: () => void }) {
  const lang = useLang();
  const [open, setOpen] = useState(decodeURIComponent(current).startsWith(`/f/${node.path}`));
  const [mode, setMode] = useState<'idle' | 'new' | 'rename'>('idle');
  const [sharing, setSharing] = useState(false);
  const drop = useDropTarget(node.path, () => setOpen(true));
  const active = current === `/f/${encodeURIComponent(node.path)}`;
  const empty = vault.isFolderEmpty(node.path);
  const locked = useReadOnly();
  const indent = { paddingLeft: depth * 14 };
  const displayName = depth === 0 ? folderDisplayName(node.name, lang) : node.name;
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
          className={`drop-target group flex items-center rounded-full pr-1.5 text-sm transition-colors ${drop.over ? 'drop-over' : active ? 'bg-accent-container text-on-accent-container font-medium' : 'text-muted hover:bg-raised hover:text-ink'}`}
          style={indent}
        >
          <button className={`p-1.5 transition-transform duration-200 ${node.children.length ? '' : 'invisible'} ${open ? 'rotate-90' : ''}`} onClick={() => setOpen(!open)} aria-label={displayName}>
            <ChevronRight size={14} />
          </button>
          {/* Not a <button>: browsers do not start a drag on buttons */}
          <div
            role="button"
            tabIndex={0}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 text-left"
            onClick={() => {
              navigate(`/f/${encodeURIComponent(node.path)}`);
              onNavigate?.();
            }}
            onKeyDown={(e) => e.key === 'Enter' && navigate(`/f/${encodeURIComponent(node.path)}`)}
            onDoubleClick={() => !isReadOnly() && setMode('rename')}
          >
            {open && node.children.length ? <FolderOpen size={15} className="shrink-0" /> : <Folder size={15} className="shrink-0" />}
            <span className="truncate">{displayName}</span>
          </div>
          <span className="edit-only flex items-center opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <button className="rounded-full p-1 hover:bg-surface hover:text-ink" title={t('list.subfolderAdd')} onClick={() => (setOpen(true), setMode('new'))}>
              <FolderPlus size={13} />
            </button>
            <button className="rounded-full p-1 hover:bg-surface hover:text-ink" title={t('nav.renameFolder')} onClick={() => setMode('rename')}>
              <Pencil size={13} />
            </button>
            <button className="rounded-full p-1 hover:bg-surface hover:text-ink" title={t('nav.shareFolder')} onClick={() => setSharing(true)}>
              <Share2 size={13} />
            </button>
            {empty && (
              <button className="rounded-full p-1 hover:bg-surface hover:text-danger" title={t('nav.deleteEmptyFolder')} onClick={() => void vault.deleteFolder(node.path)}>
                <Trash2 size={13} />
              </button>
            )}
          </span>
          <span className={`w-5 text-right text-xs text-faint ${locked ? '' : 'group-hover:hidden [@media(hover:none)]:hidden'}`}>{counts.get(node.path) || ''}</span>
        </div>
      )}
      {/* Portal: the sidebar may be transformed (mobile drawer), which would trap a fixed overlay */}
      {sharing && createPortal(<ShareDialog target={{ folder: node.path }} onClose={() => setSharing(false)} />, document.body)}
      {open && (node.children.length > 0 || mode === 'new') && (
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
            <FolderItem key={c.path} node={c} current={current} counts={counts} depth={depth + 1} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({ onNavigate, isAdmin, headerAction }: { onNavigate?: () => void; isAdmin?: boolean; headerAction?: React.ReactNode }) {
  const version = useVault();
  const lang = useLang();
  const inboxZero = useInboxZero();
  const [newRoot, setNewRoot] = useState(false);
  const [query, setQuery] = useState('');
  const rootDrop = useDropTarget('');
  const path = usePath();
  const folders = vault.folders();
  const notes = vault.list();
  const counts = new Map<string, number>();
  for (const n of notes) if (n.access === 'owner') counts.set(splitPath(n.path).folder, (counts.get(splitPath(n.path).folder) ?? 0) + 1);
  const shared = notes.filter((n) => n.access !== 'owner').length;
  const inboxCount = notes.filter((n) => n.access === 'owner' && splitPath(n.path).folder === PARA.inbox).length;

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const searchResults = useMemo(() => {
    if (!terms.length) return [];
    const list = vault
      .list()
      .filter((n) => {
        const hay = `${n.path}\n${n.content}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      })
      .sort((a, b) => {
        const nameA = splitPath(a.path).name.toLowerCase();
        const nameB = splitPath(b.path).name.toLowerCase();
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
  const item = (to: string, Icon: typeof Home, label: string, extra?: React.ReactNode) => {
    const active = path === to;
    return (
      <button
        onClick={() => nav(to)}
        aria-current={active ? 'page' : undefined}
        className={`flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-colors ${active ? 'bg-accent-container text-on-accent-container' : 'text-muted hover:bg-raised hover:text-ink'}`}
      >
        <Icon size={18} /> <span className="flex-1 truncate text-left">{label}</span>
        {extra}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col gap-1 p-3" onClick={(e) => (e.target as HTMLElement).closest('[data-close]') && onNavigate?.()}>
      <div className="mb-2 flex items-center gap-1.5 px-1">
        {headerAction}
        <img src="/icons/icon.svg" className="h-7 w-7 shrink-0" alt="" />
        <span className="font-semibold tracking-tight">Kladde</span>
        <div className="ml-auto flex items-center gap-1">
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
          <div className="mb-1.5 px-2 text-xs font-medium text-faint">{t('search.resultsCount', { n: searchResults.length })}</div>
          {searchResults.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted">{t('search.noResults')}</p>
          ) : (
            <ul className="space-y-1">
              {searchResults.map((n) => {
                const { folder, name } = splitPath(n.path);
                const active = path === `/n/${n.id}`;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => nav(`/n/${n.id}`)}
                      aria-current={active ? 'page' : undefined}
                      className={`w-full rounded-2xl px-3 py-2 text-left transition-colors ${active ? 'bg-accent-container text-on-accent-container' : 'hover:bg-raised'}`}
                    >
                      <div className="truncate text-sm font-medium">{name}</div>
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
        <>
          {item('/', Home, t('nav.home'))}
          {item('/notes', FileText, t('nav.allNotes'), <span className="text-xs opacity-75">{notes.filter((n) => n.access === 'owner').length}</span>)}
          {item('/inbox', InboxIcon, t('nav.inbox'), inboxZero && inboxCount > 0 ? <span className="rounded-full bg-warn/15 px-1.5 py-0.5 text-xs font-semibold text-warn">{inboxCount}</span> : null)}
          {item('/graph', Network, t('nav.graph'))}
          {item('/files', Images, t('nav.files'))}
          {item('/review', CalendarCheck, t('nav.review'), reviewDue() ? <span className="h-2 w-2 rounded-full bg-accent" /> : null)}
          {(shared > 0 || vault.sharedFolders.length > 0) && item('/shared', Share2, t('nav.sharedWithMe'), <span className="text-xs opacity-75">{shared || ''}</span>)}
          <div className="mt-3 mb-1 flex items-center justify-between px-3 text-xs font-semibold uppercase tracking-wider text-faint">
            {t('nav.folders')}
            <button className="edit-only rounded-full p-1 hover:bg-raised hover:text-ink" title={t('nav.newFolder')} onClick={() => setNewRoot(true)}>
              <FolderPlus size={14} />
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
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
              <FolderItem key={n.path} node={n} current={path} counts={counts} depth={0} onNavigate={onNavigate} />
            ))}
            <li className="edit-only mt-1">
              <div {...rootDrop.props} className={`drop-target drop-zone-root rounded-xl border border-dashed border-line px-3 py-2 text-xs text-faint ${rootDrop.over ? 'drop-over' : ''}`}>
                {t('nav.dropTopLevel')}
              </div>
            </li>
          </ul>
          <div className="edit-only mt-2 grid grid-cols-2 gap-2">
            <button className="btn-primary" onClick={() => (newNote(), onNavigate?.())}>
              <Plus size={16} /> {t('nav.newNoteShort')}
            </button>
            <button className="btn-ghost border border-line" onClick={() => (newZettel(), onNavigate?.())} title={t('nav.zettelTitle')}>
              <Lightbulb size={16} /> Zettel
            </button>
            <button className="btn-ghost col-span-2 border border-line" onClick={() => (importRecipe(), onNavigate?.())} title={t('quick.recipeTitle')}>
              <ChefHat size={16} /> {t('nav.recipe')}
            </button>
          </div>
          {isAdmin && item('/admin', ShieldCheck, t('nav.admin'))}
          {item('/settings', Settings, t('nav.settings'))}
        </>
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

export function Shell({ children, isAdmin }: { children: React.ReactNode; isAdmin?: boolean }) {
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

  return (
    <>
      <MaterialShell isAdmin={isAdmin}>{children}</MaterialShell>
      {toast &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className="no-print pointer-events-none fixed bottom-20 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-line/60 bg-raised px-4 py-2.5 text-sm font-medium text-ink shadow-soft anim-fade-up md:bottom-6"
          >
            {toast.tone === 'ok' && <CheckCircle2 size={16} className="shrink-0 text-ok" />}
            {toast.tone === 'warn' && <CloudOff size={16} className="shrink-0 text-warn" />}
            {toast.tone === 'danger' && <AlertTriangle size={16} className="shrink-0 text-danger" />}
            <span>{toast.text}</span>
          </div>,
          document.body
        )}
    </>
  );
}
