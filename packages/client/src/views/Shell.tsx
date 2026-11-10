import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Cloud, CloudOff, CalendarCheck, Images, Inbox as InboxIcon, Network, Folder, FolderOpen, FolderPlus, Pencil, Trash2, Home, ChefHat, Lightbulb, Loader2, Menu, Plus, Search, Settings, Share2, ShieldCheck, AlertTriangle, X, FileText, Lock, LockOpen } from 'lucide-react';
import { PARA, splitPath } from '@kladde/shared';
import { openDialog } from '../lib/dialogs';
import { Dialogs } from './Dialogs';
import { reviewDue } from './Review';
import { useVault, vault } from '../data/vault';
import { navigate, usePath } from '../lib/router';
import { QuickCapture } from './QuickCapture';
import { dragSource, useDropTarget } from '../lib/dnd';
import { isReadOnly, setReadOnly, useReadOnly } from '../lib/readOnly';
import { createPortal } from 'react-dom';
import { ShareDialog } from './ShareDialog';
import { MaterialShell } from './MaterialShell';
import { useResolvedTheme } from '../lib/theme';

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
  const pending = vault.pendingCount();
  const { state, message } = vault;
  const label =
    state === 'syncing' ? 'Synchronisiere …' : state === 'offline' ? `Offline${pending ? ` · ${pending} lokal` : ''}` : state === 'error' ? message || 'Fehler' : pending ? `${pending} ausstehend` : 'Synchron';
  const Icon = state === 'syncing' ? Loader2 : state === 'offline' ? CloudOff : state === 'error' ? AlertTriangle : Cloud;
  return (
    <button onClick={vault.kick} title={label} className={`chip transition-colors ${state === 'offline' ? 'text-warn' : state === 'error' ? 'text-danger' : ''}`}>
      <Icon size={13} className={state === 'syncing' ? 'animate-spin' : ''} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/** Switches the read-only mode for every page on this device */
export function ReadOnlyToggle() {
  const on = useReadOnly();
  const label = on ? 'Lesemodus an' : 'Lesemodus aus';
  return (
    <button
      onClick={() => setReadOnly(!on)}
      title={on ? 'Lesemodus beenden: wieder bearbeiten' : 'Lesemodus: nichts kann versehentlich geändert werden'}
      aria-pressed={on}
      aria-label={label}
      className={`chip transition-colors ${on ? 'bg-accent/15 text-accent' : 'hover:text-ink'}`}
    >
      {on ? <Lock size={13} /> : <LockOpen size={13} />}
      {on && <span>Lesen</span>}
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
  const [open, setOpen] = useState(decodeURIComponent(current).startsWith(`/f/${node.path}`));
  const [mode, setMode] = useState<'idle' | 'new' | 'rename'>('idle');
  const [sharing, setSharing] = useState(false);
  const drop = useDropTarget(node.path, () => setOpen(true));
  const active = current === `/f/${encodeURIComponent(node.path)}`;
  const empty = vault.isFolderEmpty(node.path);
  const locked = useReadOnly();
  const indent = { paddingLeft: depth * 14 };
  return (
    <li>
      {mode === 'rename' ? (
        <div style={indent} className="pl-6">
          <FolderNameInput
            initial={node.name}
            placeholder="Neuer Name"
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
          className={`drop-target group flex items-center rounded-lg pr-1 text-sm ${drop.over ? 'drop-over' : active ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-raised hover:text-ink'}`}
          style={indent}
        >
          <button className={`p-1.5 transition-transform duration-200 ${node.children.length ? '' : 'invisible'} ${open ? 'rotate-90' : ''}`} onClick={() => setOpen(!open)}>
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
            <span className="truncate">{node.name}</span>
          </div>
          <span className="edit-only flex items-center opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <button className="rounded p-1 hover:bg-surface hover:text-ink" title="Unterordner anlegen" onClick={() => (setOpen(true), setMode('new'))}>
              <FolderPlus size={13} />
            </button>
            <button className="rounded p-1 hover:bg-surface hover:text-ink" title="Umbenennen" onClick={() => setMode('rename')}>
              <Pencil size={13} />
            </button>
            <button className="rounded p-1 hover:bg-surface hover:text-ink" title="Ordner teilen" onClick={() => setSharing(true)}>
              <Share2 size={13} />
            </button>
            {empty && (
              <button className="rounded p-1 hover:bg-surface hover:text-danger" title="Leeren Ordner löschen" onClick={() => void vault.deleteFolder(node.path)}>
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
                placeholder="Name des Unterordners"
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

export function Sidebar({ onNavigate, isAdmin }: { onNavigate?: () => void; isAdmin?: boolean }) {
  useVault();
  const [newRoot, setNewRoot] = useState(false);
  const rootDrop = useDropTarget('');
  const path = usePath();
  const folders = vault.folders();
  const notes = vault.list();
  const counts = new Map<string, number>();
  for (const n of notes) if (n.access === 'owner') counts.set(splitPath(n.path).folder, (counts.get(splitPath(n.path).folder) ?? 0) + 1);
  const shared = notes.filter((n) => n.access !== 'owner').length;
  const inboxCount = notes.filter((n) => n.access === 'owner' && splitPath(n.path).folder === PARA.inbox).length;
  const nav = (to: string) => {
    navigate(to);
    onNavigate?.();
  };
  const item = (to: string, Icon: typeof Home, label: string, extra?: React.ReactNode) => (
    <button
      onClick={() => nav(to)}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${path === to ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-raised hover:text-ink'}`}
    >
      <Icon size={17} /> <span className="flex-1 text-left">{label}</span>
      {extra}
    </button>
  );
  return (
    <div className="flex h-full flex-col gap-1 p-3" onClick={(e) => (e.target as HTMLElement).closest('[data-close]') && onNavigate?.()}>
      <div className="mb-3 flex items-center gap-2 px-1.5">
        <img src="/icons/icon.svg" className="h-7 w-7" alt="" />
        <span className="font-semibold tracking-tight">Kladde</span>
        <div className="ml-auto flex items-center gap-1.5">
          <ReadOnlyToggle />
          <SyncBadge />
        </div>
      </div>
      {item('/', Home, 'Start')}
      {item('/notes', FileText, 'Alle Notizen', <span className="text-xs text-faint">{notes.filter((n) => n.access === 'owner').length}</span>)}
      {item('/inbox', InboxIcon, 'Inbox', inboxCount ? <span className="rounded-full bg-warn/15 px-1.5 text-xs text-warn">{inboxCount}</span> : null)}
      {item('/search', Search, 'Suche')}
      {item('/graph', Network, 'Wissensnetz')}
      {item('/files', Images, 'Anhänge')}
      {item('/review', CalendarCheck, 'Wochenrückblick', reviewDue() ? <span className="h-2 w-2 rounded-full bg-accent" /> : null)}
      {(shared > 0 || vault.sharedFolders.length > 0) && item('/shared', Share2, 'Mit mir geteilt', <span className="text-xs text-faint">{shared || ''}</span>)}
      <div className="mt-4 mb-1 flex items-center justify-between px-2.5 text-xs font-semibold uppercase tracking-wider text-faint">
        Ordner
        <button className="edit-only rounded p-1 hover:bg-raised hover:text-ink" title="Neuer Ordner" onClick={() => setNewRoot(true)}>
          <FolderPlus size={14} />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {newRoot && (
          <li className="px-1">
            <FolderNameInput
              placeholder="Name des Ordners"
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
        <li className="edit-only">
          <div {...rootDrop.props} className={`drop-target drop-zone-root rounded-lg border border-dashed border-line px-3 py-2 text-xs text-faint ${rootDrop.over ? 'drop-over' : ''}`}>
            Hierher ziehen: oberste Ebene
          </div>
        </li>
      </ul>
      <div className="edit-only mt-2 grid grid-cols-2 gap-2">
        <button className="btn-primary" onClick={() => (newNote(), onNavigate?.())}>
          <Plus size={16} /> Notiz
        </button>
        <button className="btn-ghost border border-line" onClick={() => (newZettel(), onNavigate?.())} title="Neuer Zettel (Zettelkasten)">
          <Lightbulb size={16} /> Zettel
        </button>
        <button className="btn-ghost col-span-2 border border-line" onClick={() => (importRecipe(), onNavigate?.())} title="Rezept über einen Link importieren">
          <ChefHat size={16} /> Rezept importieren
        </button>
      </div>
      {isAdmin && item('/admin', ShieldCheck, 'Verwaltung')}
      {item('/settings', Settings, 'Einstellungen')}
    </div>
  );
}

/** Strg/⌘+K opens the search from anywhere, also from inside the editor */
function useSearchShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      e.stopPropagation();
      navigate('/search');
      // Already on the search page: autoFocus does not run again
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-search-input]')?.select());
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

export function Shell({ children, isAdmin }: { children: React.ReactNode; isAdmin?: boolean }) {
  useSearchShortcut();
  // The Material theme brings its own layout (navigation rail, list pane, navigation bar)
  return useResolvedTheme() === 'material' ? <MaterialShell isAdmin={isAdmin}>{children}</MaterialShell> : <ClassicShell isAdmin={isAdmin}>{children}</ClassicShell>;
}

function ClassicShell({ children, isAdmin }: { children: React.ReactNode; isAdmin?: boolean }) {
  const [drawer, setDrawer] = useState(false);
  const [capture, setCapture] = useState(false);
  const path = usePath();
  const isNote = path.startsWith('/n/');
  return (
    <div className="flex h-full flex-col">
      {/*
        Tablet/desktop home-screen apps (iPad) get the same iOS 26/27 status bar blur as phones: there is no
        header from md up, so an opaque sticky strip at the top edge takes its place (only in standalone mode).
      */}
      <div className="sticky top-0 z-20 hidden shrink-0 bg-bg [--pad-top:0.375rem] safe-top [@media(display-mode:standalone)]:md:block" />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-line bg-surface/60 md:block lg:w-72">
          <Sidebar isAdmin={isAdmin} />
        </aside>
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/40 anim-fade-in" onClick={() => setDrawer(false)} />
            <aside className="absolute inset-y-0 left-0 w-[82%] max-w-xs bg-surface shadow-soft safe-top safe-bottom" style={{ animation: 'slide-in 260ms var(--ease) both' }}>
              <button className="btn-icon absolute right-2 top-[calc(0.5rem+env(safe-area-inset-top))]" onClick={() => setDrawer(false)}>
                <X size={18} />
              </button>
              <Sidebar isAdmin={isAdmin} onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Opaque and sticky at the top edge: iOS 26/27 home-screen apps only drop their status bar blur ("scroll pocket") over such a bar */}
          <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-bg pb-2 [--pad-top:0.5rem] [--pad-x:0.75rem] safe-top safe-x md:hidden">
            <button className="btn-icon" onClick={() => setDrawer(true)}>
              <Menu size={20} />
            </button>
            <span className="font-semibold">Kladde</span>
            <div className="ml-auto flex items-center gap-1.5">
              <ReadOnlyToggle />
              <SyncBadge />
            </div>
          </header>
          <main className="vt-main min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</main>
          <nav className="grid grid-cols-4 border-t border-line bg-surface/90 safe-bottom safe-x md:hidden">
            {[
              ['/', Home, 'Start'],
              ['/notes', FileText, 'Notizen'],
              ['/search', Search, 'Suche'],
              ['/settings', Settings, 'Mehr'],
            ].map(([to, Icon, label]) => {
              const I = Icon as typeof Home;
              return (
                <button key={to as string} onClick={() => navigate(to as string)} className={`flex flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${path === to ? 'text-accent' : 'text-muted'}`}>
                  <I size={20} />
                  {label as string}
                </button>
              );
            })}
          </nav>
        </div>
      </div>
      {!isNote && (
        <button
          className="edit-only fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-on-accent shadow-soft transition-transform duration-200 ease-spring hover:scale-105 active:scale-90 md:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] md:right-6"
          onClick={() => setCapture(true)}
          title="Schnell erfassen"
        >
          <Plus size={26} />
        </button>
      )}
      {capture && <QuickCapture onClose={() => setCapture(false)} />}
      <Dialogs />
    </div>
  );
}
