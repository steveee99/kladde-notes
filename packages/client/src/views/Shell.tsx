import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CalendarCheck,
  CalendarMonth,
  Globe,
  RemoteDoc,
  ListChecks,
  Kanban,
  CalendarDays,
  CheckCircle2,
  ChefHat,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudOff,
  Draw,
  FilePlus2,
  FileText,
  FileType2,
  Folder,
  FolderOpen,
  FolderPlus,
  VerticalSplit,
  Home,
  Inbox as InboxIcon,
  Lightbulb,
  Loader2,
  LocateFixed,
  Lock,
  LockOpen,
  Mood,
  Network,
  Pencil,
  Plus,
  Search,
  Share2,
  Star,
  Tags,
  Trash2,
  Users,
  Variables,
} from '../lib/icons';
import {
  isExcalidrawNote,
  INBOX_FOLDER,
  isHiddenPath,
  Me,
  pdfNoteOf,
  remoteNoteOf,
  projectTitleOf,
  splitPath,
  toDateString,
} from '@kladde/shared';
import { createPortal } from 'react-dom';
import { openDialog } from '../lib/dialogs';
import { reviewDue } from './Review';
import { urgentTaskCount } from './TaskParts';
import { usePendingUploads } from '../data/uploads';
import { useVault, vault } from '../data/vault';
import { ticketsAnywhere } from '../data/tickets';
import { openThisPeriod } from './PeriodicNoteBar';
import { NewMark } from './ActivityView';
import type { LocalNote } from '../data/db';
import { currentPath, navigate, usePath } from '../lib/router';
import { dragSource, useDropTarget } from '../lib/dnd';
import { isReadOnly, setReadOnly, useReadOnly } from '../lib/readOnly';
import { ShareDialog } from './ShareDialog';
import { WerkbankShell } from './WerkbankShell';
import { Avatar } from './Avatar';
import { AppLogo } from './AppLogo';
import { NavBadge } from './NavBadge';
import { openSearch } from './SearchDialog';
import { IconPickerDialog, ItemIcon } from './IconPicker';
import { ConfluenceDialog } from './ConfluenceDialog';
import { useConfluenceConnected } from '../lib/confluence';
import { getFocusMode, setFocusMode, toggleFocusMode } from '../lib/focus';
import { editorHost } from '../editor/host';
import { compareText, folderDisplayName, locale, t, useLang, type Lang } from '../lib/i18n';
import { useInboxZero } from '../lib/prefs';
import { createDrawingNote, createPdfNote } from '../lib/newNote';
import { DEMO } from '../demo/demoApi';
import { groupPath } from './Groups';
import { useItemMenu, type MenuAction } from './ContextMenu';
import { openInSide, useSplitAvailable } from '../lib/panes';

/** The own folder a route shows (`/f/<folder>`) or that holds the open own note; null elsewhere */
export function folderOfRoute(path: string): string | null {
  if (path.startsWith('/f/')) return decodeURIComponent(path.slice(3));
  const note = path.startsWith('/n/') ? vault.get(decodeURIComponent(path.slice(3))) : undefined;
  return note && note.access === 'owner' && !note.group ? splitPath(note.path).folder : null;
}

export function newNote(folder?: string) {
  openDialog({ kind: 'note', folder });
}

export function importRecipe(url?: string) {
  openDialog({ kind: 'recipe', url });
}

export function newZettel() {
  openDialog({ kind: 'zettel' });
}

/**
 * "+ New note" as a Material 3 split button: the main part creates a note, the chevron opens a menu
 * with the other ways to start one (Zettel and recipe from a URL when those features are on, drawing, PDF).
 */
function NewNoteButton({
  zettel,
  recipe,
  folder,
  onNavigate,
}: {
  zettel: boolean;
  recipe: boolean;
  /** The folder that is open (or holds the open note): new notes start there (null: the Inbox) */
  folder: string | null;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, top: r.bottom + 6, width: r.width });
    };
    place();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !wrapRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('resize', place);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
    onNavigate?.();
  };
  const menuItem = (Icon: typeof Plus, label: string, action: () => void, title?: string) => (
    <button type="button" role="menuitem" className="m3-menu-item w-full text-left" title={title} onClick={() => run(action)}>
      <Icon size={18} className="shrink-0 text-on-surface-variant" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );

  return (
    <div ref={wrapRef} className="edit-only flex shrink-0 gap-0.5">
      <button className="btn-tonal min-w-0 flex-1 !rounded-r-md" onClick={() => run(() => newNote(folder ?? undefined))}>
        <Plus size={16} /> <span className="truncate">{t('nav.newNote')}</span>
      </button>
      <button
        type="button"
        className="btn-tonal !rounded-l-md !px-2.5"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('nav.newNoteMore')}
        title={t('nav.newNoteMore')}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={18} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      <input
        ref={pdfInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void createPdfNote(file, folder ?? INBOX_FOLDER).then((note) => note && onNavigate?.());
        }}
      />
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={t('nav.newNoteMore')}
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, minWidth: pos?.width ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="m3-menu anim-m3-menu fixed z-[90]"
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              e.preventDefault();
              const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
              const i = items.indexOf(document.activeElement as HTMLButtonElement);
              items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
            }}
          >
            {menuItem(FileText, t('nav.newNoteShort'), () => newNote(folder ?? undefined))}
            {zettel && menuItem(Lightbulb, 'Zettel', newZettel, t('nav.zettelTitle'))}
            {menuItem(RemoteDoc, t('remote.kind'), () => openDialog({ kind: 'remote', folder: folder ?? undefined }), t('remote.kindHint'))}
            {menuItem(Globe, t('clip.kind'), () => openDialog({ kind: 'clip' }), t('clip.title'))}
            {recipe && menuItem(ChefHat, t('nav.recipe'), () => importRecipe(), t('quick.recipeTitle'))}
            {menuItem(Draw, t('nav.drawingNote'), () => void createDrawingNote(folder ?? INBOX_FOLDER), t('nav.drawingNoteTitle'))}
            {/* Not run(): onNavigate may close the mobile drawer, which would drop the file input */}
            <button
              type="button"
              role="menuitem"
              className="m3-menu-item w-full text-left"
              title={t('nav.pdfNoteTitle')}
              onClick={() => {
                setOpen(false);
                pdfInput.current?.click();
              }}
            >
              <FileType2 size={18} className="shrink-0 text-on-surface-variant" />
              <span className="min-w-0 flex-1 truncate">{t('nav.pdfNote')}</span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
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

export function SyncBadge({ compact, status }: { compact?: boolean; status?: boolean } = {}) {
  useVault();
  useLang();
  const pending = vault.pendingCount();
  // Attachments added offline (#28): the badge says so and leads to the list
  const files = usePendingUploads().length;
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
  const fullLabel = files ? `${label} · ${t('uploads.badge', { n: files })}` : label;
  // Online mode: without a connection only the notes opened before are on the device
  const hint = vault.online && state === 'offline' ? t('online.offline') : t('common.syncAction');
  const Icon = state === 'syncing' ? Loader2 : state === 'offline' ? CloudOff : state === 'error' ? AlertTriangle : Cloud;
  // Status bar (desktop): a small mono line with a colored dot
  if (status) {
    const tone = DEMO ? 'text-violet' : state === 'offline' ? 'text-amber' : state === 'error' ? 'text-red' : state === 'syncing' || pending || files ? 'text-amber' : 'text-green';
    const text = DEMO ? t('demo.badge') : fullLabel;
    return (
      <button
        type="button"
        onClick={() => (DEMO ? undefined : files && !navigator.onLine ? navigate('/files') : vault.kick())}
        title={DEMO ? t('demo.badgeTitle') : `${fullLabel} — ${hint}`}
        className={`flex min-w-0 items-center gap-1.5 rounded px-1 outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-acc ${tone}`}
      >
        {/* The dot sends out a ring while syncing and once more when the state changes (key) */}
        <span key={state} aria-hidden className="sync-dot h-1.5 w-1.5 shrink-0 rounded-full bg-current" data-state={state} />
        <span className="truncate">{text}</span>
      </button>
    );
  }
  // The demo has no server: say where the notes are instead of a sync state
  if (DEMO)
    return (
      <span title={t('demo.badgeTitle')} className={compact ? 'flex h-10 w-10 shrink-0 items-center justify-center text-tertiary' : 'chip text-tertiary'}>
        <CloudOff size={compact ? 20 : 18} />
        {!compact && <span className="hidden sm:inline">{t('demo.badge')}</span>}
      </span>
    );
  return (
    <button
      onClick={() => (files && !navigator.onLine ? navigate('/files') : vault.kick())}
      title={`${fullLabel} — ${hint}`}
      aria-label={fullLabel}
      className={`${compact ? 'btn-icon relative' : 'chip'} ${state === 'offline' ? 'text-warn' : state === 'error' ? 'text-error' : ''}`}
    >
      <Icon size={compact ? 20 : 18} className={state === 'syncing' ? 'animate-spin' : ''} />
      {compact ? (
        (pending > 0 || files > 0) && <span aria-hidden className="absolute right-2 top-2 h-2 w-2 rounded-full bg-warn" />
      ) : (
        <span className="hidden sm:inline">{label}</span>
      )}
    </button>
  );
}

/** Switches the read-only mode for every page on this device */
export function ReadOnlyToggle({ compact }: { compact?: boolean } = {}) {
  const on = useReadOnly();
  useLang();
  const label = on ? t('nav.readOnlyOn') : t('nav.readOnlyOff');
  return (
    <button
      onClick={() => setReadOnly(!on)}
      title={on ? t('nav.readOnlyDisableTitle') : t('nav.readOnlyEnableTitle')}
      aria-pressed={on}
      aria-label={label}
      className={compact ? `btn-icon ${on ? '!bg-line !text-acc' : ''}` : 'chip'}
    >
      {on ? <Lock size={compact ? 20 : 18} /> : <LockOpen size={compact ? 20 : 18} />}
      {on && !compact && <span>{t('nav.readOnlyBadge')}</span>}
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
  label,
  active,
  highlighted,
  depth,
  onNavigate,
}: {
  note: LocalNote;
  /** Shown instead of the file name (favorites show the title) */
  label?: string;
  active: boolean;
  highlighted?: boolean;
  depth: number;
  onNavigate?: () => void;
}) {
  const name = label ?? splitPath(note.path).name;
  const Icon = remoteNoteOf(note.content) ? RemoteDoc : pdfNoteOf(note.content) ? FileType2 : isExcalidrawNote(note.content) ? Draw : FileText;
  const icon = vault.noteIcon(note);
  const openNote = () => {
    navigate(`/n/${note.id}`);
    onNavigate?.();
  };
  // Two notes side by side (#88): "Open to the side" in the menu, or Ctrl/⌘+click
  const split = useSplitAvailable();
  const openSide = () => {
    openInSide(note.id);
    onNavigate?.();
  };
  const locked = useReadOnly();
  // Duplicate (a copy next to the note): own notes and group notes the user writes
  const mayDuplicate = !locked && (note.access === 'owner' || vault.managesGroupNote(note));
  const duplicate = () => {
    vault.duplicate(note.id).then(
      (copy) => {
        navigate(`/n/${copy.id}`);
        onNavigate?.();
      },
      (err: Error) => alert(err.message)
    );
  };
  const menu = useItemMenu(
    [
      ...(split
        ? [
            { icon: FileText, label: t('split.open'), onSelect: openNote },
            { icon: VerticalSplit, label: t('split.openSide'), onSelect: openSide },
          ]
        : []),
      ...(mayDuplicate ? [{ icon: FilePlus2, label: t('note.duplicateMenu'), onSelect: duplicate }] : []),
    ],
    t('nav.noteActions', { name })
  );
  return (
    <li style={{ paddingLeft: depth * 14 }} className="group/note relative">
      {/* Not a <button>: browsers do not start a drag on buttons */}
      <div
        role="button"
        tabIndex={0}
        data-tree-note-id={note.id}
        aria-current={active ? 'page' : undefined}
        title={name}
        {...dragSource({ kind: 'note', id: note.id })}
        onContextMenu={menu.rowProps.onContextMenu}
        onClick={(e) => (split && (e.ctrlKey || e.metaKey) ? openSide() : openNote())}
        onKeyDown={(e) => {
          menu.rowProps.onKeyDown?.(e);
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (split && (e.ctrlKey || e.metaKey)) openSide();
            else openNote();
          }
        }}
        className={`group flex min-w-0 cursor-pointer items-center gap-2 rounded-md py-1.5 pl-[26px] pr-3 text-left text-sm transition-colors ${
          highlighted
            ? 'bg-secondary-container text-on-secondary-container font-medium ring-2 ring-inset ring-primary'
            : active
              ? 'bg-secondary-container text-on-secondary-container font-medium'
              : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
        }`}
      >
        {icon ? (
          <ItemIcon icon={icon} size={14} />
        ) : (
          <Icon
            size={14}
            className={`shrink-0 ${highlighted ? 'text-primary' : active ? 'text-on-secondary-container' : 'text-on-surface-variant'}`}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <NewMark noteId={note.id} />
      </div>
      {menu.button && (
        <span className={`absolute right-1.5 top-1/2 -translate-y-1/2 ${menu.open ? 'flex' : 'hidden group-hover/note:flex group-focus-within/note:flex'}`}>{menu.button}</span>
      )}
      {menu.menu}
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
  const [confluenceOpen, setConfluenceOpen] = useState(false);
  const confluenceConnected = useConfluenceConnected();
  const [pickingIcon, setPickingIcon] = useState(false);
  const iconsEnabled = vault.features().icons.enabled;
  const icon = vault.folderIcon(node.path);
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

  const actions: MenuAction[] = locked
    ? []
    : [
        { icon: Plus, label: t('nav.newNoteHere'), onSelect: () => newNote(node.path) },
        { icon: FolderPlus, label: t('list.subfolderAdd'), onSelect: () => (setOpen(true), setMode('new')) },
        { icon: Pencil, label: t('nav.renameFolder'), onSelect: () => setMode('rename') },
        ...(iconsEnabled ? [{ icon: Mood, label: t('icons.setFolder'), onSelect: () => setPickingIcon(true) }] : []),
        ...(!vault.standalone ? [{ icon: Share2, label: t('nav.shareFolder'), onSelect: () => setSharing(true) }] : []),
        { icon: Variables, label: t('vars.menu'), onSelect: () => openDialog({ kind: 'variables', space: 'own', folder: node.path }) },
        ...(confluenceConnected && !empty ? [{ icon: Cloud, label: t('confluence.menu'), onSelect: () => setConfluenceOpen(true) }] : []),
        ...(empty ? [{ icon: Trash2, label: t('nav.deleteEmptyFolder'), danger: true, onSelect: () => void vault.deleteFolder(node.path) }] : []),
      ];
  const folderMenu = useItemMenu(actions, t('nav.folderActions', { name: displayName }));

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
          {...folderMenu.rowProps}
          className={`drop-target group flex min-w-0 items-center rounded-md pr-1.5 text-sm transition-colors ${drop.over ? 'drop-over' : active ? 'bg-secondary-container text-on-secondary-container font-medium' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'}`}
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
            {icon ? <ItemIcon icon={icon} /> : open && hasChildren ? <FolderOpen size={15} className="shrink-0" /> : <Folder size={15} className="shrink-0" />}
            <span className="truncate">{displayName}</span>
          </div>
          <span className={`flex shrink-0 ${folderMenu.button && !folderMenu.open ? 'group-hover:hidden group-focus-within:hidden [@media(hover:none)]:hidden' : ''} ${folderMenu.open ? 'hidden' : ''}`}>
            <NavBadge tone="plain" count={folderNotes.length} />
          </span>
          {folderMenu.button && <span className={`flex shrink-0 ${folderMenu.open ? '' : 'hidden group-hover:flex group-focus-within:flex [@media(hover:none)]:flex'}`}>{folderMenu.button}</span>}
          {folderMenu.menu}
        </div>
      )}
      {/* Portal: the sidebar may be transformed (mobile drawer), which would trap a fixed overlay */}
      {sharing && createPortal(<ShareDialog target={{ folder: node.path }} onClose={() => setSharing(false)} />, document.body)}
      {confluenceOpen && <ConfluenceDialog target={{ folder: node.path }} onClose={() => setConfluenceOpen(false)} />}
      {pickingIcon && (
        <IconPickerDialog
          title={t('icons.folderTitle', { name: displayName })}
          current={icon}
          onPick={(next) => void vault.setFolderIcon(node.path, next).catch(() => undefined)}
          onClose={() => setPickingIcon(false)}
        />
      )}
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

/** Star button of a group folder (#58): adds it to the favorites or removes it */
function GroupFolderStar({ groupId, folder }: { groupId: string; folder: string }) {
  const fav = vault.isFavoriteGroupFolder(groupId, folder);
  return (
    <button
      type="button"
      className={`rounded-full p-1 hover:bg-surface-container-low hover:text-on-surface ${fav ? 'text-primary' : ''}`}
      title={fav ? t('groups.unfavorite') : t('groups.favorite')}
      aria-label={fav ? t('groups.unfavorite') : t('groups.favorite')}
      aria-pressed={fav}
      onClick={(e) => {
        e.stopPropagation();
        void vault.toggleFavoriteGroupFolder(groupId, folder).catch(() => undefined);
      }}
    >
      <Star size={13} filled={fav} />
    </button>
  );
}

/**
 * A group (#58) in the folder tree: the group is the top folder (with the group symbol), its folders and notes below,
 * so a group folder reads as "Group/Folder". Folders and the group itself can be favorites.
 */
function GroupTreeItem({ groupId, current, activeNoteId, onNavigate }: { groupId: string; current: string; activeNoteId: string | null; onNavigate?: () => void }) {
  const group = vault.group(groupId)!;
  const all = vault.groupNotes(groupId);
  // Like in the own folder tree: database notes are settings of their folder
  const notes = all.filter((n) => !isHiddenPath(n.path));
  const folders = vault.groupFolders(groupId);
  const expandable = notes.length > 0 || folders.length > 0;
  const activeNote = activeNoteId ? all.find((n) => n.id === activeNoteId) : undefined;
  const lang = useLang();
  const byFolder = new Map<string, LocalNote[]>();
  for (const n of notes) {
    if (isHiddenPath(n.path)) continue;
    const f = splitPath(n.path).folder;
    const list = byFolder.get(f);
    if (list) list.push(n);
    else byFolder.set(f, [n]);
  }
  for (const list of byFolder.values()) list.sort((a, b) => compareText(splitPath(a.path).name, splitPath(b.path).name, lang));
  const rootPath = groupPath(groupId);
  const inGroup = current === rootPath || current.startsWith(`${rootPath}/`) || !!activeNote;
  const [open, setOpen] = useState(inGroup);
  useEffect(() => {
    if (inGroup) setOpen(true);
  }, [inGroup]);
  const favorites = vault.features().favorites.enabled;
  const active = current === rootPath;
  const rootNotes = byFolder.get('') ?? [];

  const folderNode = (node: TreeNode, depth: number): React.ReactNode => (
    <GroupFolderNode key={node.path} groupId={groupId} node={node} depth={depth} byFolder={byFolder} current={current} activeNote={activeNote} activeNoteId={activeNoteId} favorites={favorites} onNavigate={onNavigate} render={folderNode} />
  );
  return (
    <li data-tree-group={groupId}>
      <div className={`group flex min-w-0 items-center rounded-md pr-1.5 text-sm transition-colors ${active ? 'bg-secondary-container text-on-secondary-container font-medium' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'}`}>
        <button
          type="button"
          className={`shrink-0 p-1.5 transition-transform duration-200 ${expandable ? '' : 'invisible'} ${open ? 'rotate-90' : ''}`}
          onClick={() => setOpen(!open)}
          aria-label={`${group.name}: ${open ? t('nav.collapseFolder') : t('nav.expandFolder')}`}
          aria-expanded={expandable ? open : undefined}
        >
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          title={t('groups.treeTitle', { name: group.name })}
          onClick={() => {
            setOpen(true);
            navigate(rootPath);
            onNavigate?.();
          }}
        >
          <Users size={15} filled={active} className="shrink-0" />
          <span className="truncate">{group.name}</span>
        </button>
        {favorites && (
          <span className={`shrink-0 ${vault.isFavoriteGroupFolder(groupId, '') ? '' : 'opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100'}`}>
            <GroupFolderStar groupId={groupId} folder="" />
          </span>
        )}
        <NavBadge tone="plain" count={notes.length} />
      </div>
      {open && expandable && (
        <ul className="anim-fade-in">
          {buildTree(folders).map((n) => folderNode(n, 1))}
          {rootNotes.map((n) => (
            <SidebarNoteRow key={n.id} note={n} active={activeNoteId === n.id} depth={1} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </li>
  );
}

function GroupFolderNode({
  groupId,
  node,
  depth,
  byFolder,
  current,
  activeNote,
  activeNoteId,
  favorites,
  onNavigate,
  render,
}: {
  groupId: string;
  node: TreeNode;
  depth: number;
  byFolder: Map<string, LocalNote[]>;
  current: string;
  activeNote?: LocalNote;
  activeNoteId: string | null;
  favorites: boolean;
  onNavigate?: () => void;
  render: (node: TreeNode, depth: number) => React.ReactNode;
}) {
  const to = groupPath(groupId, node.path);
  const activeFolder = activeNote ? splitPath(activeNote.path).folder : null;
  const contains = current === to || current.startsWith(`${to}%2F`) || (activeFolder !== null && (activeFolder === node.path || activeFolder.startsWith(`${node.path}/`)));
  const [open, setOpen] = useState(contains);
  useEffect(() => {
    if (contains) setOpen(true);
  }, [contains]);
  const notes = byFolder.get(node.path) ?? [];
  const hasChildren = node.children.length > 0 || notes.length > 0;
  const active = current === to;
  const fav = vault.isFavoriteGroupFolder(groupId, node.path);
  const iconsEnabled = vault.features().icons.enabled;
  const icon = vault.folderIcon(node.path, groupId);
  const [pickingIcon, setPickingIcon] = useState(false);
  const locked = useReadOnly();
  const actions: MenuAction[] = [
    ...(favorites ? [{ icon: Star, label: fav ? t('groups.unfavorite') : t('groups.favorite'), onSelect: () => void vault.toggleFavoriteGroupFolder(groupId, node.path).catch(() => undefined) }] : []),
    ...(iconsEnabled && !locked ? [{ icon: Mood, label: t('icons.setFolder'), onSelect: () => setPickingIcon(true) }] : []),
    { icon: Variables, label: t('vars.menu'), onSelect: () => openDialog({ kind: 'variables', space: `group:${groupId}`, folder: node.path }) },
  ];
  const menu = useItemMenu(actions, t('nav.folderActions', { name: node.name }));
  return (
    <li>
      <div
        {...menu.rowProps}
        className={`group flex min-w-0 items-center rounded-md pr-1.5 text-sm transition-colors ${active ? 'bg-secondary-container text-on-secondary-container font-medium' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'}`}
        style={{ paddingLeft: depth * 14 }}
      >
        <button
          type="button"
          className={`shrink-0 p-1.5 transition-transform duration-200 ${hasChildren ? '' : 'invisible'} ${open ? 'rotate-90' : ''}`}
          onClick={() => setOpen(!open)}
          aria-label={`${node.name}: ${open ? t('nav.collapseFolder') : t('nav.expandFolder')}`}
          aria-expanded={hasChildren ? open : undefined}
        >
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={() => {
            setOpen(true);
            navigate(to);
            onNavigate?.();
          }}
        >
          {icon ? <ItemIcon icon={icon} /> : open && hasChildren ? <FolderOpen size={15} className="shrink-0" /> : <Folder size={15} className="shrink-0" />}
          <span className="truncate">{node.name}</span>
        </button>
        {pickingIcon && (
          <IconPickerDialog
            title={t('icons.folderTitle', { name: node.name })}
            current={icon}
            onPick={(next) => void vault.setFolderIcon(node.path, next, groupId).catch(() => undefined)}
            onClose={() => setPickingIcon(false)}
          />
        )}
        {favorites && fav && (
          <span className="shrink-0">
            <GroupFolderStar groupId={groupId} folder={node.path} />
          </span>
        )}
        <span className={`flex shrink-0 ${menu.button && !menu.open ? 'group-hover:hidden group-focus-within:hidden [@media(hover:none)]:hidden' : ''} ${menu.open ? 'hidden' : ''}`}>
          <NavBadge tone="plain" count={notes.length} />
        </span>
        {menu.button && <span className={`flex shrink-0 ${menu.open ? '' : 'hidden group-hover:flex group-focus-within:flex [@media(hover:none)]:flex'}`}>{menu.button}</span>}
        {menu.menu}
      </div>
      {open && hasChildren && (
        <ul className="anim-fade-in">
          {node.children.map((c) => render(c, depth + 1))}
          {notes.map((n) => (
            <SidebarNoteRow key={n.id} note={n} active={activeNoteId === n.id} depth={depth + 1} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </li>
  );
}

const SECTION_KEY = 'kladde_sidebar_sections';

function readSections(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(SECTION_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Open/closed state of a sidebar section, remembered per device; `fallback` decides before the first toggle */
function useSectionOpen(key: string, fallback: () => boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => readSections()[key] ?? fallback());
  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      try {
        localStorage.setItem(SECTION_KEY, JSON.stringify({ ...readSections(), [key]: next }));
      } catch {
        // storage blocked: only for this session
      }
    },
    [key]
  );
  return [open, set];
}

/** Collapsible section heading of the sidebar (Favorites, Folders); extra buttons go in `children` */
function SectionHeader({
  icon: Icon,
  label,
  open,
  onToggle,
  count,
  badge,
  children,
}: {
  icon?: typeof Star;
  label: string;
  open: boolean;
  onToggle: () => void;
  count?: number;
  /** Shown instead of `count` while the section is closed (e.g. urgent counts of the navigation) */
  badge?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="group/section mt-3 flex shrink-0 items-center gap-0.5 pr-1 text-label-s text-faint first:mt-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md pl-2.5 pr-0 text-left outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-acc"
      >
        {Icon && <Icon size={12} className="shrink-0" />}
        <span className="min-w-0 truncate">{label}</span>
        {open ? (
          <ChevronDown size={12} className="shrink-0 opacity-0 transition-opacity group-hover/section:opacity-100" />
        ) : (
          <ChevronRight size={12} className="shrink-0" />
        )}
        <span className="flex-1" />
        {!open && badge}
        {!open && !badge && count ? <NavBadge tone="plain" count={count} /> : null}
      </button>
      {children}
    </div>
  );
}

/**
 * Folder tree with favorites and the new-note button. `panel` is the desktop side panel next to the rail
 * (Werkbank): no brand, search, destinations or settings there, the top bar, rail and status bar have them.
 * Without `panel` it is the full navigation of the phone drawer.
 */
/** The sort order per folder from the last render: a folder whose notes and names stayed is not sorted again (#64) */
const folderOrder = new Map<string, { lang: string; ids: string[]; names: string[]; order: number[] }>();

/** The grouping by the last path change: a change of a text only takes the notes' current objects (#64) */
let grouped: { stamp: number; lang: string; ids: Map<string, string[]> } | null = null;

/** Own notes by folder (database notes left out), each list sorted by name */
function groupByFolder(notes: LocalNote[], lang: Lang): Map<string, LocalNote[]> {
  const stamp = vault.getPathStamp();
  if (grouped && grouped.stamp === stamp && grouped.lang === lang) {
    const out = new Map<string, LocalNote[]>();
    for (const [folder, ids] of grouped.ids) {
      const list: LocalNote[] = [];
      for (const id of ids) {
        const n = vault.get(id);
        if (n) list.push(n);
      }
      out.set(folder, list);
    }
    return out;
  }
  const map = sortedByFolder(notes, lang);
  grouped = { stamp, lang, ids: new Map([...map].map(([folder, list]) => [folder, list.map((n) => n.id)])) };
  return map;
}

function sortedByFolder(notes: LocalNote[], lang: Lang): Map<string, LocalNote[]> {
  const map = new Map<string, LocalNote[]>();
  const names = new Map<LocalNote, string>();
  for (const n of notes) {
    if (n.access !== 'owner' || isHiddenPath(n.path)) continue;
    const { folder, name } = splitPath(n.path);
    names.set(n, name);
    const list = map.get(folder);
    if (list) list.push(n);
    else map.set(folder, [n]);
  }
  for (const [folder, list] of map) {
    // The notes keep their order in the vault between changes, so ids and names in that order say whether it changed
    const ids = list.map((n) => n.id);
    const listNames = list.map((n) => names.get(n)!);
    const known = folderOrder.get(folder);
    const same = !!known && known.lang === lang && known.ids.length === ids.length && ids.every((id, i) => known.ids[i] === id && known.names[i] === listNames[i]);
    let order: number[];
    if (same) order = known.order;
    else {
      order = ids.map((_, i) => i).sort((a, b) => compareText(listNames[a], listNames[b], lang));
      folderOrder.set(folder, { lang, ids, names: listNames, order });
    }
    map.set(
      folder,
      order.map((i) => list[i])
    );
  }
  for (const folder of folderOrder.keys()) if (!map.has(folder)) folderOrder.delete(folder);
  return map;
}

export function Sidebar({ me, onNavigate, isAdmin, headerAction, panel }: { me: Me; onNavigate?: () => void; isAdmin?: boolean; headerAction?: React.ReactNode; panel?: boolean }) {
  const version = useVault();
  const lang = useLang();
  const loc = locale(lang);
  const inboxZero = useInboxZero();
  const locked = useReadOnly();
  const [newRoot, setNewRoot] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useSectionOpen('favorites', () => window.innerHeight >= 700);
  const [foldersOpen, setFoldersOpen] = useSectionOpen('folders', () => true);
  const [groupsOpen, setGroupsOpen] = useSectionOpen('groups', () => true);
  const [navOpen, setNavOpen] = useSectionOpen('nav', () => true);
  const [revealRequest, setRevealRequest] = useState<RevealRequest | null>(null);
  const [flashNoteId, setFlashNoteId] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const rootDrop = useDropTarget('');
  const path = usePath();
  const folders = vault.folders();
  const notes = vault.list().filter((n) => !isHiddenPath(n.path));
  const features = vault.features();
  const roleConfig = vault.roleConfig();
  const activeNoteId = path.startsWith('/n/') ? decodeURIComponent(path.slice(3)) : null;
  const activeNote = activeNoteId ? vault.get(activeNoteId) : undefined;
  const dailyNote = features.daily.enabled ? vault.findDailyNote() : undefined;
  const dailyRouteActive = path === '/daily' || path.startsWith('/daily/') || (!!dailyNote && activeNoteId === dailyNote.id);
  const settingsActive = path === '/settings' || path.startsWith('/settings/');
  const activeFolder = folderOfRoute(path);

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
    if (activeNote.access !== 'owner') {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          // A group note (#58) sits in its group's folder tree, which opens around the open note
          const target = activeNote.group
            ? sidebarRef.current?.querySelector<HTMLElement>(`[data-tree-note-id="${CSS.escape(activeNote.id)}"]`) ??
              sidebarRef.current?.querySelector<HTMLElement>(`[data-tree-group="${CSS.escape(activeNote.group)}"]`)
            : sidebarRef.current?.querySelector<HTMLElement>('[data-tree-shared="true"]');
          target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          target?.focus({ preventScroll: true });
        })
      );
      return;
    }
    const folder = splitPath(activeNote.path).folder;
    setFoldersOpen(true);
    setRevealRequest({ folder, noteId: activeNote.id, nonce: Date.now() });
    setFlashNoteId(activeNote.id);
  };

  const notesByFolder = useMemo(
    () => groupByFolder(notes, lang),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, loc]
  );
  const rootNotes = notesByFolder.get('') ?? [];

  // Group notes (#58) have their own place: the groups
  const shared = notes.filter((n) => n.access !== 'owner' && !n.group).length;
  const inboxCount = (notesByFolder.get(INBOX_FOLDER) ?? []).length;

  const favoriteNotes = features.favorites.enabled
    ? vault
        .favoriteIds()
        .map((id) => vault.get(id))
        .filter((n): n is LocalNote => !!n && !isHiddenPath(n.path))
    : [];
  // Group folders (#58) as favorites: "Group/Folder"
  const favoriteGroupFolders = features.favorites.enabled ? vault.favoriteGroupFolders() : [];
  const favoriteCount = favoriteNotes.length + favoriteGroupFolders.length;

  const nav = (to: string) => {
    navigate(to);
    onNavigate?.();
  };
  /** One navigation destination as a list row: icon, label, then a trailing count or badge */
  const navRow = (
    key: string,
    Icon: typeof Home,
    label: string,
    opts: { to?: string; onClick?: () => void; active?: boolean; badge?: React.ReactNode; trailing?: number; title?: string; dataAttrs?: Record<string, string> } = {}
  ) => {
    const active = opts.active ?? (opts.to ? path === opts.to : false);
    return (
      <button
        key={key}
        type="button"
        {...opts.dataAttrs}
        onClick={opts.onClick ?? (() => opts.to && nav(opts.to))}
        aria-current={active ? 'page' : undefined}
        title={opts.title}
        className={`flex h-10 w-full shrink-0 items-center gap-3 rounded-md pl-3.5 pr-1.5 text-left text-sm font-medium transition-colors ${
          active ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
        }`}
      >
        <Icon size={20} filled={active} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {typeof opts.trailing === 'number' && <NavBadge tone="plain" count={opts.trailing} />}
        {opts.badge}
      </button>
    );
  };
  const ownNotes = notes.filter((n) => n.access === 'owner').length;
  const urgentTasks = urgentTaskCount(version);

  return (
    <div
      ref={sidebarRef}
      className={`flex h-full flex-col gap-1 overflow-hidden ${panel ? 'px-2 pb-2 pt-1.5' : 'p-3'}`}
      onClick={(e) => (e.target as HTMLElement).closest('[data-close]') && onNavigate?.()}
    >
      {panel ? (
        <div className="flex min-w-0 shrink-0 items-center gap-2 pl-2">
          <span className="section-label min-w-0 flex-1 truncate">{t('nav.notes')}</span>
          <span className="font-mono text-[11px] text-muted">{ownNotes.toLocaleString(loc)}</span>
          {headerAction}
        </div>
      ) : (
      <div className="flex min-w-0 shrink-0 items-center gap-2.5">
        {headerAction}
        <AppLogo size={28} />
        <span className="font-display min-w-0 flex-1 truncate text-[22px] leading-7">Kladde</span>
        <button
          type="button"
          onClick={() => nav('/')}
          aria-current={path === '/' ? 'page' : undefined}
          title={t('nav.home')}
          aria-label={t('nav.home')}
          className={`btn-icon shrink-0 ${path === '/' ? '!bg-secondary-container !text-on-secondary-container' : ''}`}
        >
          <Home size={24} filled={path === '/'} />
        </button>
      </div>
      )}
      <div className={`shrink-0 ${panel ? 'mb-1 mt-1' : 'mb-1.5 mt-2'}`}>
        <NewNoteButton zettel={features.zettel.enabled} recipe={features.recipe.enabled} folder={activeFolder} onNavigate={onNavigate} />
      </div>

      {/* Looks like a search field, opens the search overlay (Ctrl/⌘+K); on the desktop the top bar has it */}
      {!panel && (
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          openSearch();
        }}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        className="mb-2 flex h-10 w-full shrink-0 items-center gap-2 rounded-md border border-outline-variant/60 bg-surface-container-high px-3.5 text-left text-sm text-on-surface-variant transition-colors hover:border-outline focus-visible:border-primary focus-visible:outline-none"
      >
        <Search size={16} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t('search.sidebarPlaceholder')}</span>
      </button>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto scrollbar-thin">
          {!panel && (
          <SectionHeader
            label={t('nav.navigationLabel')}
            open={navOpen}
            onToggle={() => setNavOpen(!navOpen)}
            badge={<NavBadge tone="warn" count={urgentTasks + (inboxZero ? inboxCount : 0)} />}
          />
          )}
          {navOpen && !panel && (
            <nav aria-label={t('nav.main')} className="flex shrink-0 flex-col gap-0.5 pb-1 pl-4">
              {features.daily.enabled &&
                (!locked || !!dailyNote) &&
                navRow('daily', CalendarDays, t('daily.navShort'), {
                  active: dailyRouteActive,
                  title: t('daily.todayBtn'),
                  onClick: () => void openTodayDailyNote().then(() => onNavigate?.()),
                })}
              {navRow('tasks', ListChecks, t('nav.tasks'), { to: '/tasks', badge: <NavBadge tone="warn" count={urgentTasks} /> })}
              {ticketsAnywhere() && navRow('projects', Kanban, t('nav.projects'), { to: '/projects' })}
              {features.calendarView.enabled && navRow('calendar', CalendarMonth, t('nav.calendar'), { to: '/calendar' })}
              {!vault.standalone &&
                !DEMO &&
                navRow('notifications', Bell, t('notices.title'), { to: '/notifications', badge: <NavBadge count={vault.unreadNotifications} /> })}
              {navRow('inbox', InboxIcon, t('nav.inbox'), {
                to: '/inbox',
                badge: inboxZero ? <NavBadge tone="warn" count={inboxCount} /> : null,
                trailing: inboxZero || !inboxCount ? undefined : inboxCount,
              })}
              {navRow('notes', FileText, t('nav.allNotes'), { to: '/notes', trailing: ownNotes || undefined })}
              {navRow('graph', Network, t('nav.graph'), { to: '/graph' })}
              {navRow('tags', Tags, t('nav.tags'), { to: '/tags', active: path === '/tags' || path.startsWith('/tags/') })}
              {features.review.enabled &&
                navRow('review', CalendarCheck, t('nav.review'), {
                  to: '/review',
                  title: reviewDue() ? t('home.reviewDueChip') : undefined,
                  badge: reviewDue() ? <NavBadge dot className="mr-1.5" /> : null,
                })}
              {(shared > 0 || vault.sharedFolders.length > 0) &&
                !vault.standalone &&
                navRow('shared', Share2, t('nav.sharedWithMe'), { to: '/shared', badge: <NavBadge count={shared} />, dataAttrs: { 'data-tree-shared': 'true' } })}
              {!vault.standalone &&
                !DEMO &&
                navRow('groups', Users, t('nav.groups'), {
                  to: '/groups',
                  active: path === '/groups' || path.startsWith('/groups/') || path.startsWith('/g/'),
                  trailing: vault.groups.length || undefined,
                  dataAttrs: { 'data-nav-groups': 'true' },
                })}
            </nav>
          )}
          {favoriteCount > 0 && (
            <>
              <SectionHeader label={t('nav.favorites')} open={favoritesOpen} onToggle={() => setFavoritesOpen(!favoritesOpen)} count={favoriteCount} />
              {favoritesOpen && (
                <ul data-favorites-list className="shrink-0 space-y-px">
                  {favoriteGroupFolders.map(({ group, folder }) => {
                    const to = groupPath(group.id, folder);
                    const active = path === to;
                    const FavIcon = folder ? Folder : Users;
                    const favIcon = folder ? vault.folderIcon(folder, group.id) : null;
                    return (
                      <li key={`${group.id}/${folder}`}>
                        <button
                          type="button"
                          data-favorite-group-folder
                          onClick={() => nav(to)}
                          aria-current={active ? 'page' : undefined}
                          className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-md pl-2.5 pr-3 text-left text-body-m transition-colors ${
                            active ? 'bg-line text-strong' : 'text-soft hover:bg-raised hover:text-text'
                          }`}
                          title={folder ? `${group.name}/${folder}` : group.name}
                        >
                          {favIcon ? <ItemIcon icon={favIcon} size={14} /> : <FavIcon size={14} className="shrink-0" />}
                          <span className="min-w-0 flex-1 truncate">{folder ? `${group.name}/${folder}` : group.name}</span>
                        </button>
                      </li>
                    );
                  })}
                  {favoriteNotes.map((n) => (
                    <SidebarNoteRow key={n.id} note={n} label={projectTitleOf(n.path, n.content, roleConfig)} active={activeNoteId === n.id} depth={0} onNavigate={onNavigate} />
                  ))}
                </ul>
              )}
            </>
          )}
          <SectionHeader label={t('nav.folders')} open={foldersOpen} onToggle={() => setFoldersOpen(!foldersOpen)}>
            <button
              type="button"
              data-focus-open-note="true"
              className="rounded p-1 text-muted transition-colors hover:bg-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              title={activeNote ? t('nav.focusOpenNote') : t('nav.focusOpenNoteEmpty')}
              aria-label={t('nav.focusOpenNote')}
              disabled={!activeNote}
              onClick={focusOpenNote}
            >
              <LocateFixed size={14} />
            </button>
            <button
              className="edit-only rounded p-1 text-muted hover:bg-raised hover:text-text"
              title={t('nav.newFolder')}
              aria-label={t('nav.newFolder')}
              onClick={() => {
                setFoldersOpen(true);
                setNewRoot(true);
              }}
            >
              <FolderPlus size={14} />
            </button>
          </SectionHeader>
          <ul className={`shrink-0 ${foldersOpen ? '' : 'hidden'}`}>
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
            <li className="edit-only">
              <div {...rootDrop.props} className={`drop-target drop-zone-root rounded-md border border-dashed border-line2 px-3 py-1.5 text-xs text-muted ${rootDrop.over ? 'drop-over' : ''}`}>
                {t('nav.dropTopLevel')}
              </div>
            </li>
          </ul>
          {/* Groups (#58): each group with its own folders and notes, in a section of its own */}
          {!vault.standalone && vault.groups.length > 0 && (
            <>
              <SectionHeader label={t('nav.groups')} open={groupsOpen} onToggle={() => setGroupsOpen(!groupsOpen)} count={vault.groups.length}>
                <button type="button" className="rounded p-1 text-muted hover:bg-raised hover:text-text" title={t('groups.title')} aria-label={t('groups.title')} onClick={() => nav('/groups')}>
                  <Users size={14} />
                </button>
              </SectionHeader>
              {groupsOpen && (
                <ul className="shrink-0" data-groups-tree>
                  {vault.groups.map((g) => (
                    <GroupTreeItem key={g.id} groupId={g.id} current={path} activeNoteId={activeNoteId} onNavigate={onNavigate} />
                  ))}
                </ul>
              )}
            </>
          )}
          <div className="flex-1" aria-hidden />
          {/* Settings with the device status (read-only, sync) next to it; the desktop has them in the rail and status bar */}
          {!panel && (
          <div className="m3-status mt-1 flex shrink-0 items-center gap-1 border-t border-outline-variant/60 pt-1.5">
            <button
              type="button"
              onClick={() => nav('/settings')}
              aria-current={settingsActive ? 'page' : undefined}
              title={me.username}
              className={`flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                settingsActive ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              <Avatar name={me.username} avatarUrl={me.avatarUrl} size="xs" active={settingsActive} />
              <span className="min-w-0 flex-1 truncate text-left">{t('nav.settings')}</span>
            </button>
            <ReadOnlyToggle compact />
            <SyncBadge compact />
          </div>
          )}
        </div>
    </div>
  );
}

/** Strg/⌘+K opens the search overlay from anywhere (the sidebar stays as it is) */
function useSearchShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      e.stopPropagation();
      openSearch();
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

/** Strg/⌘+Alt+W and Strg/⌘+Alt+M open this week's and this month's note (#73), while they are turned on */
function usePeriodShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      const kind = e.code === 'KeyW' ? 'week' : e.code === 'KeyM' ? 'month' : null;
      if (!kind || !vault.periodSettings(kind).enabled) return;
      e.preventDefault();
      e.stopPropagation();
      void openThisPeriod(kind);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/** Strg/⌘+Shift+F turns focus mode on/off for the open note; Escape leaves it */
function useFocusShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'f' && e.code !== 'KeyF') return;
      if (!vault.features().focus.enabled) return;
      const id = openNoteId();
      if (!id || !vault.get(id)) return;
      e.preventDefault();
      e.stopPropagation();
      toggleFocusMode();
    };
    // Bubble phase: an Escape that closed an autocomplete popup or a menu was already handled there
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !getFocusMode()) return;
      setFocusMode(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onEscape);
    };
  }, []);
}

/** The note open in the current route (`/n/<id>`), if any */
function openNoteId(): string | null {
  const p = currentPath();
  return p.startsWith('/n/') ? decodeURIComponent(p.slice(3)) : null;
}

/** Adds or removes a note from the favorites and confirms it with a snackbar */
export async function toggleFavorite(id: string, showToast?: (text: string, tone?: 'ok' | 'warn' | 'danger') => void) {
  const note = vault.get(id);
  if (!note) return;
  const title = projectTitleOf(note.path, note.content, vault.roleConfig());
  try {
    const fav = await vault.toggleFavorite(id);
    showToast?.(t(fav ? 'favorites.addedToast' : 'favorites.removedToast', { title }), 'ok');
  } catch (err) {
    showToast?.((err as Error).message, 'warn');
  }
}

/** Strg/⌘+D adds the open note to the favorites or removes it (only with the favorites feature enabled) */
function useFavoriteShortcut(showToast: (text: string, tone?: 'ok' | 'warn' | 'danger') => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'd' && e.code !== 'KeyD') return;
      if (!vault.features().favorites.enabled) return;
      const id = openNoteId();
      if (!id || !vault.get(id)) return;
      e.preventDefault();
      e.stopPropagation();
      void toggleFavorite(id, showToast);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showToast]);
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
  usePeriodShortcuts();
  useFavoriteShortcut(showToast);
  useFocusShortcut();

  return (
    <>
      <WerkbankShell me={me} isAdmin={isAdmin}>{children}</WerkbankShell>
      {toast &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className="m3-snackbar no-print pointer-events-none fixed bottom-24 left-1/2 z-[80] flex min-h-12 max-w-[min(calc(100vw-2rem),42rem)] -translate-x-1/2 items-center gap-3 px-4 py-3 text-body-m anim-fade-up nav:bottom-6"
          >
            {toast.tone === 'ok' && <CheckCircle2 size={20} className="shrink-0 text-inverse-primary" />}
            {toast.tone === 'warn' && <CloudOff size={20} className="shrink-0" />}
            {toast.tone === 'danger' && <AlertTriangle size={20} className="shrink-0" />}
            <span className="truncate">{toast.text}</span>
          </div>,
          document.body
        )}
    </>
  );
}
