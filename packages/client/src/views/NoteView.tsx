import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ResizeHandle } from './SidebarResizeHandle';
import { sidePaneWidth, useWidth } from '../lib/sidebarWidth';
import { createPortal } from 'react-dom';
import { EditorView } from '@codemirror/view';
import {
  AlertTriangle,
  ArrowLeft,
  Bold,
  CalendarPlus,
  CenterFocus,
  Check,
  CheckCircle2,
  CheckSquare,
  Cloud,
  ChevronDown,
  ChevronRight,
  CloseFullscreen,
  Code,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  FileType2,
  Draw,
  Folder,
  FolderInput,
  Heading,
  History,
  Image as ImageIcon,
  Images,
  Link2,
  List,
  ListChecks,
  ListTree,
  Loader2,
  Lock,
  MoreVertical,
  NewReleases,
  Network,
  PanelRight,
  PanelRightClose,
  Printer,
  Share2,
  SlidersHorizontal,
  Star,
  Tags,
  Trash2,
  Undo2,
  X,
  FormatAlignCenter,
  FormatAlignJustify,
  FormatAlignLeft,
  FormatAlignRight,
  Users,
  Mood,
  Psychology,
  PictureAsPdf,
  Slideshow,
  MessageSquare,
  MessageSquarePlus,
} from '../lib/icons';
import { undo } from '@codemirror/commands';
import {
  makeAnchor,
  resolveAnchor,
  type CommentAnchor,
  excerpt,
  extractDailyNoteDate,
  createPeriodicExtractor,
  parseFrontmatter,
  fillReleasePlaceholders,
  fillVariables,
  resolveVariables,
  EMPTY_VARIABLE_SCOPE,
  type VariableScope,
  type NoteRelease,
  isFolderProjectHome,
  isProjectNote,
  isSingleProjectFile,
  excalidrawSceneOf,
  pdfNoteOf,
  propertiesAt,
  remoteNoteOf,
  projectTitleOf,
  setExcalidrawScene,
  safeExportFilename,
  splitPath,
  stripFrontmatter,
  toDateString,
  type NoteType,
  type PanelPosition,
  type GraphEdge,
  type GraphNode,
  type Task,
  noteIconOf,
  memoryMeta,
} from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { useOnlineBacklinks } from '../data/online';
import type { LocalNote } from '../data/db';
import { copyText } from '../lib/clipboard';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { Editor, insertAtLineStart, insertText, toggleCode, toggleWrap, wrapSelection } from '../editor/Editor';
import { attachmentMarkdown, editorHost } from '../editor/host';
import { useOutline, type Outline } from '../editor/outline';
import { OutlinePanel } from './OutlinePanel';
import { NoteTasksPanel, useNoteTasks } from './NoteTasksPanel';
import { applyFrontmatter } from '../editor/widgets';
import { ShareDialog } from './ShareDialog';
import { HistoryDialog } from './History';
import { ParaBar } from './ParaBar';
import { NoteTypePanel, NoteTypeSheet, UnknownNoteType } from './NoteTypePanel';
import { typeOfNote } from '../data/noteTypes';
import { MemoryPanel } from './MemoryPanel';
import { TicketBacklinks, TicketPanel } from './TicketPanel';
import { milestoneOfNote, ticketOfNote, ticketsDocumentedIn, type TicketInfo } from '../data/tickets';
import { Graph, GraphLegend } from './Graph';
import { Sheet } from './Dialogs';
import { Avatar } from './Avatar';
import { MoveToGroupSheet, groupPath, groupRoleLabel } from './Groups';
import { PresenceBar, useAnnouncePresence } from './PresenceBar';
import { folderDisplayName, t, useLang, type I18nKey, type Lang } from '../lib/i18n';
import { printNote, usePrintable } from '../lib/printing';
import { setLocalGraphDepth, setSourceMode, useLocalGraphDepth, useSourceMode, type NoteSplitTab } from '../lib/prefs';
import { activePane, usePane, usePanePanel } from '../lib/panes';
import { isCoarsePointer } from '../lib/viewport';
import { useModal } from '../lib/modal';
import { useRightPaneHost } from './WerkbankShell';
import { IconPickerDialog } from './IconPicker';
import { DailyCarryOver, DailyNoteBar } from './DailyNoteBar';
import { PeriodicNoteBar } from './PeriodicNoteBar';
import { NoteStats } from './NoteStats';
import { setFocusMode, useFocusMode } from '../lib/focus';
import { refreshConfluence, useConfluence } from '../lib/confluence';
import { ConfluenceDialog } from './ConfluenceDialog';
import { ReleaseDialog, releaseChipLabel } from './ReleaseDialog';
import { releaseRenderOptions } from '../editor/releases';
import { useVariables, variablesOfNote } from '../data/variables';
import { currentRemote, remoteDisplayText, remoteExportText, remoteProblemText, useRemoteNote } from '../data/remoteNotes';
import { RemoteNotePanel } from './RemoteNotePanel';
import { DEMO } from '../demo/demoApi';
import { useComments } from '../data/comments';
import { onCommentOpen, setCommentRanges } from '../editor/comments';
import { CommentsPanel, showPassage } from './CommentsPanel';
import { api } from '../lib/api';

const IS_APPLE = /Mac|iPhone|iPad/.test(navigator.platform);

function Toolbar({ view, lang }: { view: EditorView | null; lang: Lang }) {
  const file = useRef<HTMLInputElement>(null);
  if (!view) return null;
  const mod = IS_APPLE ? '⌘' : lang === 'en' ? 'Ctrl' : 'Strg';
  const btn = (Icon: typeof Bold, title: string, fn: () => void) => (
    <button
      key={title}
      title={title}
      aria-label={title}
      className="btn-icon shrink-0"
      onMouseDown={(e) => e.preventDefault()}
      onClick={fn}
    >
      <Icon size={18} />
    </button>
  );
  return (
    <div className="note-toolbar sticky bottom-0 z-20 flex gap-1 overflow-x-auto border-t border-outline-variant bg-surface-container-low/95 px-2 pt-1.5 backdrop-blur [--pad-bottom:0.375rem] pb-1.5 nav:safe-bottom scrollbar-thin">
      {btn(CheckSquare, t('note.toolbarTask'), () => insertAtLineStart(view, '- [ ] '))}
      {btn(CalendarPlus, t('note.toolbarDueToday'), () => insertText(view, ` 📅 ${toDateString(new Date())}`))}
      {btn(Heading, t('note.toolbarHeading'), () => insertAtLineStart(view, '## '))}
      {btn(List, t('note.toolbarList'), () => insertAtLineStart(view, '- '))}
      {btn(ListTree, t('note.toolbarToc'), () => insertAtLineStart(view, '##TOC##\n'))}
      {btn(Bold, `${t('note.toolbarBold')} (${mod}+B)`, () => toggleWrap(view, '**'))}
      {btn(Link2, `${t('note.toolbarWiki')} (${mod}+Shift+L)`, () => wrapSelection(view, '[[', ']]'))}
      {btn(Code, `${t('note.toolbarCode')} (${mod}+Shift+M)`, () => toggleCode(view))}
      {btn(ImageIcon, t('note.toolbarUpload'), () => file.current?.click())}
      {btn(Images, t('note.toolbarAttachment'), () => editorHost.pickAttachment((f) => insertText(view, `\n${attachmentMarkdown(f)}\n`)))}
      {btn(Undo2, t('note.toolbarUndo'), () => undo(view))}
      <input
        ref={file}
        type="file"
        accept="image/*,application/pdf"
        hidden
        multiple
        onChange={async (e) => {
          for (const f of [...(e.target.files ?? [])]) {
            try {
              const r = await editorHost.upload(f);
              insertText(view, `\n![${r.name}](${r.url})\n`);
            } catch (err) {
              alert(t('editor.uploadFailed', { error: (err as Error).message }));
            }
          }
          e.target.value = '';
        }}
      />
    </div>
  );
}

/** Mobile compact breadcrumb pill showing only the last folder breadcrumb; clicking reveals every clickable path level */
function MobileBreadcrumbMenu({ folderSegments, lang, group }: { folderSegments: string[]; lang: Lang; group?: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // A group note's path starts at its group (#58)
  const items: { key: string; label: string; to: string; depth: number }[] = [
    { key: '__root__', label: group ? group.name : t('note.breadcrumbRoot'), to: group ? groupPath(group.id) : '/notes', depth: 0 },
    ...folderSegments.map((seg, i) => ({
      key: folderSegments.slice(0, i + 1).join('/'),
      label: i === 0 && !group ? folderDisplayName(seg, lang) : seg,
      to: group ? groupPath(group.id, folderSegments.slice(0, i + 1).join('/')) : `/f/${encodeURIComponent(folderSegments.slice(0, i + 1).join('/'))}`,
      depth: i + 1,
    })),
  ];
  const last = items[items.length - 1];

  const updatePos = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuW = menuRef.current?.offsetWidth || 240;
    const menuH = menuRef.current?.offsetHeight || 220;
    const left = Math.max(8, Math.min(rect.left, vw - menuW - 8));
    const top = Math.max(8, Math.min(rect.bottom + gap, vh - menuH - 8));
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePos();
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r || r.bottom <= 0 || r.top >= window.innerHeight) setOpen(false);
      else updatePos();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, updatePos]);

  return (
    <div className="flex min-w-0 flex-1 items-center md:hidden">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('note.breadcrumbExpand', { name: last.label })}
        className={`inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium transition-colors ${
          open ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-container-high/70 text-on-surface hover:bg-surface-container-high'
        }`}
      >
        <Folder size={14} className={`shrink-0 ${open ? 'text-on-primary-container' : 'text-primary'}`} />
        <span className="min-w-0 truncate">{last.label}</span>
        <ChevronDown size={14} className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : 'opacity-70'}`} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={t('note.breadcrumbMenuAria')}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="no-print fixed z-[90] max-h-[60vh] w-64 overflow-y-auto rounded-2xl border border-outline-variant/70 bg-surface-container-high p-1.5 shadow-soft anim-fade-in scrollbar-thin"
          >
            {items.map((item, idx) => {
              const isCurrent = idx === items.length - 1;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  style={{ paddingLeft: `${12 + Math.min(item.depth, 4) * 10}px` }}
                  onClick={() => {
                    setOpen(false);
                    navigate(item.to);
                  }}
                  className={`flex w-full items-center gap-2 rounded-xl py-2 pr-3 text-left text-sm transition-colors ${
                    isCurrent ? 'bg-secondary-container text-on-secondary-container font-medium' : 'text-on-surface hover:bg-surface-container-low'
                  }`}
                >
                  <Folder size={14} className={isCurrent ? 'shrink-0' : 'shrink-0 text-primary'} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

/** One entry of the overflow menu */
function MenuItem({
  icon: Icon,
  label,
  onClick,
  active,
  iconClass = 'text-on-surface-variant',
  className = 'text-on-surface hover:bg-surface-container-low',
}: {
  icon: typeof Bold;
  label: string;
  onClick: () => void;
  active?: boolean;
  iconClass?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role={active === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={active}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${className}`}
      onClick={onClick}
    >
      <Icon size={16} className={`shrink-0 ${iconClass}`} fill={Icon === Star && active ? 'currentColor' : 'none'} />
      <span className="flex-1">{label}</span>
      {active && <Check size={15} className="shrink-0 text-primary" />}
    </button>
  );
}

/** Text alignment of a note, stored as frontmatter `align` (left is the default and drops the key) */
type NoteAlign = 'left' | 'center' | 'right' | 'justify';
const NOTE_ALIGNS: { value: NoteAlign; icon: typeof Bold; label: I18nKey }[] = [
  { value: 'left', icon: FormatAlignLeft, label: 'note.alignLeft' },
  { value: 'center', icon: FormatAlignCenter, label: 'note.alignCenter' },
  { value: 'right', icon: FormatAlignRight, label: 'note.alignRight' },
  { value: 'justify', icon: FormatAlignJustify, label: 'note.alignJustify' },
];
function noteAlignOf(content: string): NoteAlign {
  const raw = parseFrontmatter(content).data.align?.trim().toLowerCase();
  return NOTE_ALIGNS.some((a) => a.value === raw) ? (raw as NoteAlign) : 'left';
}

/** Material 3 three-dot overflow menu: copy, favorite, code view, project actions, Share, History, Export, Move, Delete */
function NoteOverflowMenu({
  title,
  content,
  isOwner,
  canShare,
  mayDelete,
  onShare,
  onHistory,
  onMove,
  onMoveToGroup,
  onDuplicate,
  onDelete,
  onCopy,
  favorite,
  onToggleFavorite,
  onIcon,
  sourceMode,
  onToggleSource,
  focusMode,
  onToggleFocus,
  onFinishProject,
  onConvertProject,
  onAddProperty,
  onNoteType,
  onConfluence,
  onVersioning,
  variables,
  exportContent,
  align,
  onAlign,
  onPresent,
}: {
  title: string;
  content: string;
  isOwner: boolean;
  canShare: boolean;
  mayDelete: boolean;
  onShare: () => void;
  onHistory: () => void;
  onMove: () => void;
  /** Own notes, when groups are available (#58) */
  onMoveToGroup?: () => void;
  /** Where the user may create a note next to this one */
  onDuplicate?: () => void;
  onDelete: () => void;
  onCopy: () => void;
  /** null: favorites are turned off */
  favorite: boolean | null;
  onToggleFavorite: () => void;
  /** Only with the icons feature on and an editable note */
  onIcon?: () => void;
  /** null: the note cannot be edited, so there is no code view */
  sourceMode: boolean | null;
  onToggleSource: () => void;
  /** null: focus mode is turned off in the settings */
  focusMode: boolean | null;
  onToggleFocus: () => void;
  /** Only for project notes the user owns */
  onFinishProject?: () => void;
  /** Only for single-file projects */
  onConvertProject?: () => void;
  /** Only for editable notes */
  onAddProperty?: () => void;
  /** Chooses the custom note type; only for editable text notes */
  onNoteType?: () => void;
  /** Only for own notes, when the server offers Confluence (#48) */
  onConfluence?: () => void;
  /** Release versioning (#53): own notes, and notes that have it turned on */
  onVersioning?: () => void;
  /** What exports contain (a versioned note: its latest release, placeholders filled); default `content` */
  exportContent?: (anywhere: boolean) => Promise<string>;
  align: NoteAlign;
  /** Only for editable notes */
  onAlign?: (align: NoteAlign) => void;
  /** Fills `{{var:name}}` in exports */
  variables: VariableScope;
  /** Presentation mode (#87) is on: "Start presentation" and the slide PDF among the exports */
  onPresent?: () => void;
}) {
  useLang();
  usePrintable(content);
  const [open, setOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState<'word' | 'pdf' | 'slides' | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updatePos = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuW = menuRef.current?.offsetWidth || 240;
    const menuH = menuRef.current?.offsetHeight || 280;
    const left = Math.max(8, Math.min(rect.right - menuW, vw - menuW - 8));
    const fitsBelow = rect.bottom + gap + menuH <= vh - 8;
    const top = fitsBelow || rect.top < menuH + gap + 8
      ? Math.max(8, Math.min(rect.bottom + gap, vh - menuH - 8))
      : rect.top - gap - menuH;
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      setExportOpen(false);
      return;
    }
    updatePos();
  }, [open, exportOpen, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r || r.bottom <= 0 || r.top >= window.innerHeight) setOpen(false);
      else updatePos();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, updatePos]);

  const exportMarkdown = async () => {
    setOpen(false);
    const body = stripFrontmatter(fillVariables(exportContent ? await exportContent(true) : content, variables));
    const finalText = body && !body.endsWith('\n') ? `${body}\n` : body;
    const url = URL.createObjectURL(new Blob([finalText], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = safeExportFilename(title, 'md', t('export.fallbackName'));
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const runAsync = async (kind: 'word' | 'pdf' | 'slides') => {
    setBusy(kind);
    setOpen(false);
    try {
      const mod = await import('../lib/noteExport');
      const text = exportContent ? await exportContent(false) : content;
      if (kind === 'word') await mod.exportNoteAsWord(title, text, variables);
      else if (kind === 'slides') await mod.exportNoteAsSlides(title, text, variables);
      else await mod.exportNoteAsPdf(title, text, variables);
    } catch (err) {
      alert(t('export.failed', { error: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative no-print">
      <button
        ref={triggerRef}
        type="button"
        className="btn-icon"
        title={t('note.moreActionsTitle')}
        aria-label={t('note.moreActionsTitle')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy !== null}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : <MoreVertical size={18} />}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="no-print fixed z-[90] w-60 rounded-2xl border border-outline-variant/70 bg-surface-container-high p-1.5 shadow-soft anim-fade-in"
          >
            <MenuItem
              icon={Copy}
              label={t('note.copyMarkdownMenu')}
              onClick={() => {
                setOpen(false);
                onCopy();
              }}
            />
            {favorite !== null && (
              <MenuItem
                icon={Star}
                label={t('favorites.menuLabel')}
                active={favorite}
                iconClass={favorite ? 'text-warn' : 'text-on-surface-variant'}
                onClick={() => {
                  setOpen(false);
                  onToggleFavorite();
                }}
              />
            )}
            {onIcon && (
              <MenuItem
                icon={Mood}
                label={t('icons.menuLabel')}
                onClick={() => {
                  setOpen(false);
                  onIcon();
                }}
              />
            )}
            {sourceMode !== null && (
              <MenuItem
                icon={FileCode}
                label={t('note.sourceModeMenu')}
                active={sourceMode}
                onClick={() => {
                  setOpen(false);
                  onToggleSource();
                }}
              />
            )}
            {focusMode !== null && (
              <MenuItem
                icon={CenterFocus}
                label={t('focus.menuLabel')}
                active={focusMode}
                onClick={() => {
                  setOpen(false);
                  onToggleFocus();
                }}
              />
            )}
            {onPresent && (
              <MenuItem
                icon={Slideshow}
                label={t('present.menu')}
                onClick={() => {
                  setOpen(false);
                  onPresent();
                }}
              />
            )}
            {onAddProperty && (
              <MenuItem
                icon={Tags}
                label={t('note.addProperty')}
                onClick={() => {
                  setOpen(false);
                  onAddProperty();
                }}
              />
            )}
            {onNoteType && (
              <MenuItem
                icon={SlidersHorizontal}
                label={t('types.menu')}
                onClick={() => {
                  setOpen(false);
                  onNoteType();
                }}
              />
            )}
            {onAlign && (
              <div className="flex items-center gap-3 px-3 py-1.5" role="group" aria-label={t('note.alignMenu')}>
                <span className="flex-1 text-sm text-on-surface">{t('note.alignMenu')}</span>
                <div className="flex gap-0.5 rounded-md border border-line2 p-0.5">
                  {NOTE_ALIGNS.map(({ value, icon: Icon, label }) => (
                    <button
                      key={value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={align === value}
                      title={t(label)}
                      aria-label={t(label)}
                      onClick={() => onAlign(value)}
                      className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
                        align === value ? 'bg-acc-bg text-acc-hi' : 'text-muted hover:bg-line hover:text-text'
                      }`}
                    >
                      <Icon size={16} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(onFinishProject || onConvertProject) && <div className="my-1 border-t border-outline-variant/80" />}
            {onConvertProject && (
              <MenuItem
                icon={FolderInput}
                label={t('para.convertFolderBtn')}
                onClick={() => {
                  setOpen(false);
                  onConvertProject();
                }}
              />
            )}
            {onFinishProject && (
              <MenuItem
                icon={CheckCircle2}
                label={t('para.finishMenu')}
                iconClass="text-ok"
                onClick={() => {
                  setOpen(false);
                  onFinishProject();
                }}
              />
            )}
            <div className="my-1 border-t border-outline-variant/80" />
            {canShare && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
                onClick={() => {
                  setOpen(false);
                  onShare();
                }}
              >
                <Share2 size={16} className="shrink-0 text-on-surface-variant" />
                <span>{t('common.share')}</span>
              </button>
            )}
            {onConfluence && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
                onClick={() => {
                  setOpen(false);
                  onConfluence();
                }}
              >
                <Cloud size={16} className="shrink-0 text-on-surface-variant" />
                <span>{t('confluence.menu')}</span>
              </button>
            )}

            {onVersioning && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
                onClick={() => {
                  setOpen(false);
                  onVersioning();
                }}
              >
                <NewReleases size={16} className="shrink-0 text-on-surface-variant" />
                <span>{t('release.menu')}</span>
              </button>
            )}

            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
              onClick={() => {
                setOpen(false);
                onHistory();
              }}
            >
              <History size={16} className="shrink-0 text-on-surface-variant" />
              <span>{t('common.history')}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              aria-expanded={exportOpen}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
              onClick={() => setExportOpen((v) => !v)}
            >
              <Download size={16} className="shrink-0 text-on-surface-variant" />
              <span className="flex-1">{t('common.export')}</span>
              <ChevronDown size={15} className={`shrink-0 text-on-surface-variant transition-transform duration-150 ${exportOpen ? 'rotate-180' : ''}`} />
            </button>

            {exportOpen && (
              <div className="my-1 ml-3 space-y-0.5 border-l border-outline-variant/80 pl-2 anim-fade-in">
                <div className="px-2 py-0.5 text-label-m text-on-surface-variant">{t('export.headerNoFrontmatter')}</div>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
                  onClick={() => void exportMarkdown()}
                >
                  <FileCode size={15} className="shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-tight">{t('export.mdTitle')}</div>
                    <div className="text-[11px] text-on-surface-variant">{t('export.mdDesc')}</div>
                  </div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
                  onClick={() => void runAsync('word')}
                >
                  <FileSpreadsheet size={15} className="shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-tight">{t('export.wordTitle')}</div>
                    <div className="text-[11px] text-on-surface-variant">{t('export.wordDesc')}</div>
                  </div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
                  onClick={() => void runAsync('pdf')}
                >
                  <FileText size={15} className="shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-tight">{t('export.pdfTitle')}</div>
                    <div className="text-[11px] text-on-surface-variant">{t('export.pdfDesc')}</div>
                  </div>
                </button>
                {onPresent && (
                  <button
                    type="button"
                    role="menuitem"
                    data-export-slides
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
                    onClick={() => void runAsync('slides')}
                  >
                    <PictureAsPdf size={15} className="shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium leading-tight">{t('present.pdfTitle')}</div>
                      <div className="text-[11px] text-on-surface-variant">{t('present.pdfDesc')}</div>
                    </div>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-on-surface-variant transition-colors hover:bg-surface-container-low hover:text-on-surface"
                  onClick={() => {
                    setOpen(false);
                    void printNote();
                  }}
                >
                  <Printer size={15} className="shrink-0" />
                  <span>{t('export.printAction')}</span>
                </button>
              </div>
            )}

            {isOwner && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
                onClick={() => {
                  setOpen(false);
                  onMove();
                }}
              >
                <FolderInput size={16} className="shrink-0 text-on-surface-variant" />
                <span>{t('common.move')}</span>
              </button>
            )}
            {onDuplicate && (
              <button
                type="button"
                role="menuitem"
                data-duplicate-note
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
                onClick={() => {
                  setOpen(false);
                  onDuplicate();
                }}
              >
                <FilePlus2 size={16} className="shrink-0 text-on-surface-variant" />
                <span>{t('note.duplicateMenu')}</span>
              </button>
            )}
            {onMoveToGroup && (
              <button
                type="button"
                role="menuitem"
                data-move-to-group
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-low"
                onClick={() => {
                  setOpen(false);
                  onMoveToGroup();
                }}
              >
                <Users size={16} className="shrink-0 text-on-surface-variant" />
                <span>{t('groups.moveTitle')}</span>
              </button>
            )}

            {mayDelete && (
              <>
                <div className="my-1 border-t border-outline-variant/80" />
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-error transition-colors hover:bg-error/10"
                  onClick={() => {
                    setOpen(false);
                    onDelete();
                  }}
                >
                  <Trash2 size={16} className="shrink-0" />
                  <span>{t('common.delete')}</span>
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

/** Material 3 modal sheet for picking a destination folder when moving a note */
function MoveNoteSheet({
  noteTitle,
  currentFolder,
  folders = vault.folders(),
  onMove,
  onClose,
}: {
  noteTitle: string;
  currentFolder: string;
  /** Folders to choose from: the own ones, or those of the note's group (#58) */
  folders?: string[];
  onMove: (folder: string) => void;
  onClose: () => void;
}) {
  const lang = useLang();
  const [filter, setFilter] = useState('');
  const allFolders = ['', ...folders];
  const q = filter.trim().toLowerCase();
  const visible = q
    ? allFolders.filter((f) => (f ? folderDisplayName(f, lang) : t('common.topLevelPlain')).toLowerCase().includes(q) || f.toLowerCase().includes(q))
    : allFolders;

  return (
    <Sheet title={t('note.moveTitle')} onClose={onClose}>
      <p className="mb-3 text-sm text-on-surface-variant">{t('note.moveDesc', { name: noteTitle })}</p>
      {allFolders.length > 7 && (
        <input
          className="input mb-3"
          placeholder={t('common.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus={!isCoarsePointer()}
        />
      )}
      <ul className="max-h-72 space-y-1 overflow-y-auto scrollbar-thin">
        {visible.map((f) => {
          const active = f === currentFolder;
          return (
            <li key={f || '__root__'}>
              <button
                type="button"
                onClick={() => onMove(f)}
                className={`flex w-full items-center gap-3 rounded-full px-3.5 py-2.5 text-left text-sm transition-colors ${active ? 'bg-secondary-container text-on-secondary-container font-medium' : 'text-on-surface hover:bg-surface-container-high'}`}
              >
                <Folder size={16} className={active ? 'shrink-0' : 'shrink-0 text-primary'} />
                <span className="min-w-0 flex-1 truncate">{f ? folderDisplayName(f, lang) : t('common.topLevelPlain')}</span>
                {active && <Check size={16} className="shrink-0" />}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/** Supporting split pane on the right of a note: Outline, Links (Backlinks + Mentions), and Local Graph */
function NoteInspectorPane({
  noteId,
  outline,
  variables,
  tasks,
  view,
  canEdit,
  backlinks,
  mentions,
  local,
  tab,
  setTab,
  onJump,
  onClose,
  comments: commentsTab,
  tickets = [],
}: {
  /** Tickets that document their work in this note */
  tickets?: TicketInfo[];
  noteId: string;
  outline: Outline;
  variables: VariableScope;
  tasks: Task[];
  view: EditorView | null;
  canEdit: boolean;
  backlinks: LocalNote[];
  mentions: LocalNote[];
  local: { nodes: GraphNode[]; edges: GraphEdge[] };
  tab: NoteSplitTab;
  setTab: (tab: NoteSplitTab) => void;
  onJump: (pos: number) => void;
  onClose?: () => void;
  /** Comments tab (#68): its content and the number of open threads; absent when comments are off */
  comments?: { panel: React.ReactNode; count: number };
}) {
  useLang();
  const rc = vault.roleConfig();
  const graphDepth = useLocalGraphDepth();
  const tabs: { id: NoteSplitTab; label: string; Icon: typeof ListTree; count?: number }[] = [
    { id: 'toc', label: t('note.tabToc'), Icon: ListTree, count: outline.headings.length || undefined },
    { id: 'tasks', label: t('note.tabTasks'), Icon: ListChecks, count: tasks.length ? tasks.filter((tk) => !tk.done).length || undefined : undefined },
    { id: 'links', label: t('note.tabLinks'), Icon: Link2, count: backlinks.length + mentions.length + tickets.length || undefined },
    { id: 'graph', label: t('note.tabGraph'), Icon: Network, count: local.nodes.length > 1 ? local.nodes.length - 1 : undefined },
    ...(commentsTab ? [{ id: 'comments' as const, label: t('comments.tab'), Icon: MessageSquare, count: commentsTab.count || undefined }] : []),
  ];
  // Without comments a remembered comments tab falls back to the outline
  const shown = tab === 'comments' && !commentsTab ? 'toc' : tab;

  /** M3 list item on the pane (one tone up from surface-container-low), headline + supporting text */
  const item = 'state-layer block w-full rounded-lg bg-surface-container px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary';

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* M3 side sheet header: Title Large, standard close icon button */}
      <div className="flex min-h-12 items-center justify-between gap-2 pl-2">
        <h2 className="min-w-0 truncate text-title-l text-on-surface">{t('note.paneTitle')}</h2>
        {onClose && (
          <button type="button" onClick={onClose} className="btn-icon -mr-1" aria-label={t('common.close')} title={t('common.close')}>
            <X size={24} />
          </button>
        )}
      </div>

      {/* M3 primary tabs: icon above the label, a 3 dp primary indicator under the active one, a divider below the row */}
      <div role="tablist" aria-label={t('note.paneTitle')} className={`grid shrink-0 border-b border-outline-variant ${tabs.length > 4 ? 'grid-cols-5' : 'grid-cols-4'}`}>
        {tabs.map(({ id, label, Icon, count }) => {
          const active = shown === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(id)}
              className={`state-layer relative flex h-16 min-w-0 flex-col items-center justify-center gap-0.5 px-1 text-title-s outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
                active ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <span className="flex items-center gap-1">
                <Icon size={24} filled={active} className="shrink-0" />
                {count !== undefined && <span className="text-label-s">{count}</span>}
              </span>
              <span className="max-w-full truncate">{label}</span>
              {active && <span aria-hidden className="absolute inset-x-4 bottom-0 h-[3px] rounded-t-full bg-primary" />}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pr-0.5 pt-2">
        {shown === 'comments' && commentsTab?.panel}
        {shown === 'toc' && <OutlinePanel outline={outline} variables={variables} view={view} canEdit={canEdit} onJump={onJump} />}
        {shown === 'tasks' && <NoteTasksPanel noteId={noteId} tasks={tasks} view={view} canEdit={canEdit} onJump={onJump} />}

        {shown === 'links' && (
          <div className="space-y-4">
            {tickets.length > 0 && (
              <>
                <TicketBacklinks tickets={tickets} item={`${item} !flex items-center`} />
                <hr className="border-0 border-t border-outline-variant" />
              </>
            )}
            <section>
              <h3 className="mb-2 px-2 text-title-s text-on-surface-variant">{t('note.backlinksTitle', { n: backlinks.length })}</h3>
              {backlinks.length === 0 ? (
                <p className="px-2 text-body-m text-on-surface-variant">{t('note.backlinksEmpty')}</p>
              ) : (
                <ul className="space-y-1">
                  {backlinks.map((b) => (
                    <li key={b.id}>
                      <button className={item} onClick={() => navigate(`/n/${b.id}`)}>
                        <div className="truncate text-body-l text-on-surface">{projectTitleOf(b.path, b.content, rc)}</div>
                        {excerpt(b.content, 85) && <div className="mt-0.5 line-clamp-2 text-body-m text-on-surface-variant">{resolveVariables(excerpt(b.content, 85), variablesOfNote(b))}</div>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <hr className="border-0 border-t border-outline-variant" />

            <section>
              <h3 className="mb-2 px-2 text-title-s text-on-surface-variant">{t('note.mentionsTitle', { n: mentions.length })}</h3>
              {mentions.length === 0 ? (
                <p className="px-2 text-body-m text-on-surface-variant">{t('note.mentionsEmpty')}</p>
              ) : (
                <ul className="space-y-1">
                  {mentions.map((m) => (
                    <li key={m.id} className="flex min-h-14 items-center gap-2 rounded-lg bg-surface-container py-1 pl-4 pr-2">
                      <button className="min-w-0 flex-1 truncate py-2 text-left text-body-l text-on-surface hover:underline" onClick={() => navigate(`/n/${m.id}`)}>
                        {projectTitleOf(m.path, m.content, rc)}
                      </button>
                      <button className="edit-only chip shrink-0" onClick={() => void vault.linkMention(m.id, noteId)}>
                        <Link2 size={18} /> {t('note.linkMentionTitle')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        {shown === 'graph' && (
          <div>
            {local.nodes.length <= 1 ? (
              <p className="py-8 text-center text-body-m text-on-surface-variant">{t('note.localGraphEmpty')}</p>
            ) : (
              <div className="space-y-3">
                <Graph nodes={local.nodes} edges={local.edges} focusId={noteId} height={360} onOpen={(n) => n !== noteId && navigate(`/n/${n}`)} />
                <GraphLegend />
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {/* Without a direct neighbour no depth adds anything */}
              <div className={`segmented h-8 ${local.nodes.length <= 1 ? 'hidden' : ''}`} role="group" aria-label={t('graph.depth')}>
                {[1, 2, 3].map((d) => (
                  <button key={d} type="button" aria-pressed={graphDepth === d} onClick={() => setLocalGraphDepth(d)} title={t('graph.depthTitle', { n: d })}>
                    {d}
                  </button>
                ))}
              </div>
              <button type="button" className="btn-text ml-auto" onClick={() => navigate(`/graph?focus=${encodeURIComponent(noteId)}`)}>
                <Network size={18} /> {t('graph.openInGraph')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Excalidraw is large: only drawing notes load it
const ExcalidrawPanel = lazy(() => import('./ExcalidrawPanel'));
const Presentation = lazy(() => import('./Presentation'));

/** A PDF note (`type: pdf`) as a full-size viewer; a HEAD check replaces the frame with a message when the file can't load */
function PdfPanel({ url, name, onEditText }: { url: string; name: string; onEditText: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(url, { method: 'HEAD' })
      .then((res) => !cancelled && !res.ok && setFailed(true))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="mb-4 flex min-h-[60vh] flex-1 flex-col gap-2 anim-fade-in">
      <div className="no-print flex flex-wrap items-center gap-2">
        <a className="btn-ghost" href={url} target="_blank" rel="noopener">
          <ExternalLink size={16} /> {t('note.pdfOpenTab')}
        </a>
        <button type="button" className="btn-ghost" onClick={onEditText}>
          <FileText size={16} /> {t('note.pdfEditText')}
        </button>
      </div>
      {failed ? (
        <div role="alert" className="flex flex-1 items-center justify-center rounded-xl border border-outline-variant bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
          {t('note.pdfLoadFailed')}
        </div>
      ) : (
        <iframe src={url} title={name} className="min-h-[60vh] w-full flex-1 rounded-xl border border-outline-variant bg-surface-container-low" />
      )}
    </div>
  );
}

/** The side pane as a sheet from the right on narrow screens: a modal dialog (Escape closes, focus stays inside) */
function SideSheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useModal(panel, onClose);
  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className="absolute inset-y-0 right-0 flex w-[90%] max-w-sm flex-col rounded-l-2xl bg-surface-container-low p-4 shadow-elevation-1 outline-none safe-top safe-bottom"
    >
      {children}
    </div>
  );
}

export function NoteView({ id, isNew }: { id: string; isNew: boolean }) {
  const version = useVault();
  // Two notes side by side (#88): each pane has its own side panel; only the main pane reads the address
  const pane = usePane();
  const panel = usePanePanel(pane);
  const search = pane === 'main' ? location.search : '';
  const lang = useLang();
  const note = vault.get(id);
  const rc = vault.roleConfig();
  const [view, setView] = useState<EditorView | null>(null);
  const locked = useReadOnly();
  const [sharing, setSharing] = useState(false);
  const [confluenceOpen, setConfluenceOpen] = useState(false);
  const confluence = useConfluence();
  const confluenceStatus = confluence?.connection ? confluence.notes[id] : undefined;
  // Background pushes change the state: look again when another note opens
  useEffect(() => {
    if (confluence?.connection) void refreshConfluence();
  }, [id]);
  // Activity (#70): an open note is not "new", and what others change while it is open is seen on leaving
  useEffect(() => {
    vault.viewing = id;
    vault.markSeen(id);
    // Mentions of the user in this note (#69) are read once it is open
    void vault.readNotifications({ noteId: id });
    return () => {
      if (vault.viewing === id) vault.viewing = null;
      vault.markSeen(id);
    };
  }, [id]);
  // Asked once the text is here: the text matters first, the server may still be building its index
  const onlineLinks = useOnlineBacklinks(id, vault.online && !!note && !note.partial && note.version > 0);
  // Online mode: the device has only the catalog entry; the text loads when the note opens
  const partial = !!note?.partial;
  const [fetchFailed, setFetchFailed] = useState(false);
  const [fetchTry, setFetchTry] = useState(0);
  useEffect(() => {
    if (!partial) return;
    setFetchFailed(false);
    let live = true;
    vault.ensureFull(id).catch(() => live && setFetchFailed(true));
    return () => {
      live = false;
    };
  }, [id, partial, fetchTry]);
  useEffect(() => {
    if (!fetchFailed) return;
    const retry = () => setFetchTry((n) => n + 1);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [fetchFailed]);
  // Comments (#68): threads on passages, kept on the server (only for notes it already has)
  const commentsOn = !!note && !vault.standalone && !DEMO && vault.features().comments.enabled && note.version > 0 && !remoteNoteOf(note.content);
  const threads = useComments(id, commentsOn);
  const [commentDraft, setCommentDraft] = useState<CommentAnchor | null>(null);
  // ?thread=<id> (from a notification) opens the comments tab on that thread
  const [focusedThread, setFocusedThread] = useState<string | null>(() => new URLSearchParams(search).get('thread'));
  useEffect(() => {
    if (!new URLSearchParams(search).get('thread')) return;
    panel.setTab('comments');
    panel.setOpen(true);
    if (pane === 'main') history.replaceState(null, '', location.pathname);
  }, [id]);
  useEffect(() => setCommentDraft(null), [id]);
  // A click on a highlighted passage opens its thread
  useEffect(() => {
    onCommentOpen((threadId) => {
      setFocusedThread(threadId);
      panel.setTab('comments');
      panel.setOpen(true);
    });
    return () => onCommentOpen(null);
  }, []);
  // The passages of open threads are highlighted in the note
  useEffect(() => {
    if (!view) return;
    const doc = view.state.doc.toString();
    const ranges = commentsOn
      ? threads
          .filter((th) => !th.resolved)
          .flatMap((th) => {
            const r = resolveAnchor(doc, th.anchor);
            return r ? [{ from: r.from, to: r.to, threadId: th.id, active: th.id === focusedThread }] : [];
          })
      : [];
    view.dispatch({ effects: setCommentRanges.of(ranges) });
  }, [view, threads, focusedThread, commentsOn, version]);
  /** Starts a comment on the selected text (button, Ctrl/⌘+Alt+C) */
  const startComment = () => {
    if (!view || !commentsOn || locked) return;
    let { from, to } = view.state.selection.main;
    // A read-only note (shared for reading) keeps the selection in the page, not in the editor
    const dom = window.getSelection();
    if (from === to && dom && !dom.isCollapsed && dom.rangeCount && view.contentDOM.contains(dom.anchorNode)) {
      const r = dom.getRangeAt(0);
      try {
        from = view.posAtDOM(r.startContainer, r.startOffset);
        to = view.posAtDOM(r.endContainer, r.endOffset);
      } catch {
        // outside the text
      }
    }
    if (from === to) {
      alert(t('comments.selectFirst'));
      return;
    }
    setCommentDraft(makeAnchor(view.state.doc.toString(), from, to));
    panel.setTab('comments');
    panel.setOpen(true);
  };
  const startCommentRef = useRef(startComment);
  startCommentRef.current = startComment;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey || e.code !== 'KeyC') return;
      if (activePane() !== pane) return;
      e.preventDefault();
      startCommentRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [showHistory, setShowHistory] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [movingToGroup, setMovingToGroup] = useState(false);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [pickingType, setPickingType] = useState(false);
  const [showGraph, setShowGraph] = useState(true);
  const splitOpen = panel.open;
  const sourceMode = useSourceMode();
  const splitTab = panel.tab;
  const graphDepth = useLocalGraphDepth();
  const focusMode = useFocusMode();
  // Bumped (debounced) on every edit or selection change in the editor, for the live word count
  const [statsTick, setStatsTick] = useState(0);
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rightHost = useRightPaneHost();
  const sidePaneW = useWidth(sidePaneWidth);
  const [copiedMd, setCopiedMd] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [title, setTitle] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);
  // PDF notes show the viewer until the user switches to the text (per visit, NoteView is keyed by id)
  const [pdfAsText, setPdfAsText] = useState(false);
  // Drawing notes likewise show the canvas until the user switches to the text
  const [drawingAsText, setDrawingAsText] = useState(false);
  const name = note ? splitPath(note.path).name : '';
  const isProjectHome = !!note && note.access === 'owner' && isFolderProjectHome(note.path, rc);
  const displayName = note ? projectTitleOf(note.path, note.content, rc) : '';
  const hasNote = !!note;
  useAnnouncePresence(hasNote ? id : null);

  useEffect(() => setTitle(displayName), [displayName]);
  useEffect(() => {
    if (isNew) titleRef.current?.select();
  }, [isNew, id]);
  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (statsTimer.current) clearTimeout(statsTimer.current);
    };
  }, []);
  // AI memory (#94): when the user leaves a memory note they edited, `generated` names them and index/log follow
  const memoryEdit = useRef<{ before: string; edited: boolean }>({ before: '', edited: false });
  useEffect(() => {
    memoryEdit.current = { before: vault.get(id)?.content ?? '', edited: false };
    return () => {
      if (memoryEdit.current.edited) void vault.finishMemoryEdit(id, memoryEdit.current.before);
    };
  }, [id]);

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title, id, hasNote]);

  useEffect(() => {
    const el = titleRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, hasNote]);

  // Keep synchronous ref so Ctrl+S flushes pending title edits immediately
  const commitTitle = () => {
    const next = title.trim();
    if (!next || next === displayName) {
      setTitle(displayName);
      return;
    }
    if (isProjectHome) void vault.renameProject(id, next);
    else void vault.update(id, { title: next });
  };
  const commitTitleRef = useRef(commitTitle);
  commitTitleRef.current = commitTitle;

  useEffect(() => {
    const onFlush = () => commitTitleRef.current();
    window.addEventListener('kladde:flush-note', onFlush);
    return () => window.removeEventListener('kladde:flush-note', onFlush);
  }, []);

  // ?line=N (from a double click on a task): scroll to that line once the editor exists
  useEffect(() => {
    const n = Number(new URLSearchParams(search).get('line'));
    if (!view || !hasNote || !n) return;
    const ln = view.state.doc.line(Math.min(n, view.state.doc.lines));
    view.dispatch({ selection: { anchor: ln.from }, effects: EditorView.scrollIntoView(ln.from, { y: 'center' }) });
    if (pane === 'main') history.replaceState(null, '', location.pathname);
  }, [view, hasNote]);

  // Variables of the note's folder (`{{var:name}}`): change with them and when the note moves
  const variables = useVariables(note);
  // A remote note shows a document from GitLab/GitHub: live, read-only, nothing of it in the note itself
  const remote = useRemoteNote(note, variables);
  // Headings for the outline, live from the editor while the side panel is open
  const outline = useOutline(splitOpen && !focusMode ? view : null, remote ? remote.text : (note?.content ?? ''));
  // Tasks of the note for the tasks tab, live from the editor as well
  const noteTasks = useNoteTasks(splitOpen && !focusMode ? view : null, remote ? remote.text : (note?.content ?? ''), note?.access === 'owner' && !remote ? vault.taskDueResolver()(note.path) : null);

  if (!note) {
    return (
      <div className="p-10 text-center text-on-surface-variant anim-fade-in">
        {vault.ready ? t('note.notFound') : t('common.loading')}
        <div>
          <button className="btn-ghost mt-4" onClick={() => navigate('/')}>
            {t('note.backToHome')}
          </button>
        </div>
      </div>
    );
  }

  if (note.partial) {
    return (
      <div className="p-10 text-center text-muted anim-fade-in" role="status">
        <div className="text-title-m text-strong">{splitPath(note.path).name}</div>
        <p className="mt-2 text-body-m">{fetchFailed ? t('online.unavailable') : t('online.loading')}</p>
        {fetchFailed && (
          <button className="btn-outlined mt-4" onClick={() => setFetchTry((n) => n + 1)}>
            {t('online.retry')}
          </button>
        )}
      </div>
    );
  }

  const sharedReadOnly = note.access === 'read';
  // The read-only switch locks the note like a share with read access
  const readOnly = sharedReadOnly || locked;
  const isOwner = note.access === 'owner' && !locked;
  // A group note (#58): owners and editors of the group rename, move and delete it
  const noteGroup = vault.group(note.group);
  const groupManager = !locked && vault.managesGroupNote(note);
  const canRename = isOwner || groupManager;
  const accessLabel = noteGroup
    ? groupRoleLabel(noteGroup.role)
    : sharedReadOnly
      ? t('note.sharedReadOnly')
      : note.canDelete
        ? t('note.sharedEditDelete')
        : t('note.sharedEditOnly');
  // Own notes, or shared ones whose folder share allows deleting
  const mayDelete = !locked && vault.canDelete(note);
  const { folder } = splitPath(note.path);
  const folderSegments = folder ? folder.split('/') : [];
  const features = vault.features();
  const isProject = isOwner && features.para.enabled && isProjectNote(note.path, rc);
  const isSingleProject = isProject && isSingleProjectFile(note.path, rc);
  const dailyDate = features.daily.enabled && note.access === 'owner' ? extractDailyNoteDate(note.path, features.daily) : null;
  // Weekly and monthly notes (#73) get the same kind of bar
  const weekDate = !dailyDate && features.weekly.enabled && note.access === 'owner' ? createPeriodicExtractor('week', features.weekly)(note.path) : null;
  const monthDate = !dailyDate && !weekDate && features.monthly.enabled && note.access === 'owner' ? createPeriodicExtractor('month', features.monthly)(note.path) : null;
  const focus = focusMode && features.focus.enabled;
  const onEditorActivity = () => {
    if (statsTimer.current) clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => setStatsTick((n) => n + 1), 150);
  };
  const index = vault.links();
  // Online mode: the device has only some texts, so the server knows who links here
  const allBacklinks = (onlineLinks ? onlineLinks.backlinks : index.backlinks(id)).map((b) => vault.get(b)!).filter(Boolean);
  // Links from the AI memory (#94) get their own section under the user's own notes
  const inMemory = vault.isMemoryNote(note);
  // Tickets that document their work here get their own section instead of plain backlinks
  const ticketLinks = ticketsDocumentedIn(id);
  // Tickets and milestones show their fields in the panel above the text, so the frontmatter row stays hidden
  const ticketFields = !focus && (!!ticketOfNote(id) || !!milestoneOfNote(id));
  // A custom note type (`type: custom:<name>`) models where the properties show and whether the frontmatter row does
  const { type: noteType, unknown: unknownType } = ticketFields ? { type: null, unknown: null } : typeOfNote(note);
  const hideProperties = ticketFields || (!!noteType && !noteType.showFrontmatter);
  const sideType = !focus && !!noteType && propertiesAt(noteType, 'right').length > 0;
  const beside = ticketFields || sideType;
  const ticketIds = new Set(ticketLinks.map((tk) => tk.note.id));
  const backlinks = (inMemory ? allBacklinks : allBacklinks.filter((b) => !vault.isMemoryNote(b))).filter((b) => !ticketIds.has(b.id));
  const memoryBacklinks = inMemory ? [] : allBacklinks.filter((b) => vault.isMemoryNote(b));
  const mentions = (onlineLinks ? onlineLinks.mentions : index.unlinkedMentions(id)).map((m) => vault.get(m)!).filter((n) => n && n.access !== 'read');
  const local = index.localGraph(id, graphDepth);
  /** Exports of a versioned note contain its latest release with the placeholders filled in (#53) */
  const exportContent = async (): Promise<string> => {
    const releases = note.releases ?? [];
    const latest = releases[0]?.version;
    let text = note.content;
    if (latest && note.access !== 'read') text = (await api<NoteRelease>(`/notes/${id}/releases/${encodeURIComponent(latest)}`)).content;
    return fillReleasePlaceholders(text, releases, releaseRenderOptions(lang));
  };

  /** A remote note's document as it is now, for exports (`anywhere`: images by their address on the host, not through this server) */
  const remoteText = async (anywhere: boolean): Promise<string> => {
    const r = await currentRemote(id);
    if (r.state === 'ok') return anywhere ? remoteExportText(r) : remoteDisplayText(id, r);
    return `*${t('remote.exportMissing', { problem: remoteProblemText(r.state) })}*\n`;
  };

  const pdf = pdfNoteOf(note.content);
  const align = noteAlignOf(note.content);
  const drawing = excalidrawSceneOf(note.content);
  // Full-size panels replace the editor: a PDF viewer or a drawing canvas
  const showPdf = (!!pdf && !pdfAsText) || (drawing !== null && !drawingAsText);
  const showDrawing = drawing !== null && !drawingAsText;

  const typePanel = (type: NoteType, where: PanelPosition) => (
    <NoteTypePanel type={type} where={where} content={note.content} noteId={id} canEdit={!readOnly} fill={(text) => resolveVariables(text, variables)} />
  );

  const copyMarkdown = async () => {
    const clean = remote ? (remote.result.state === 'ok' ? remoteExportText(remote.result) : '') : stripFrontmatter(note.content);
    if (remote && !clean) return;
    if (!(await copyText(clean))) return;
    setCopiedMd(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedMd(false), 1800);
  };

  const jumpToPos = (pos: number, closeSheet = false) => {
    if (!view) return;
    const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
    view.dispatch({
      selection: { anchor: clamped },
      effects: EditorView.scrollIntoView(clamped, { y: 'start', yMargin: 72 }),
    });
    view.focus();
    if (closeSheet) panel.setOpen(false);
  };

  // A copy lands next to the note: own notes, group notes the user writes, shared folders that allow new notes
  const mayDuplicate =
    !readOnly && (note.access === 'owner' || (noteGroup ? groupManager : !!vault.sharedFolderOf(note)?.canCreate));
  const duplicateNote = async () => {
    try {
      const copy = await vault.duplicate(id);
      navigate(`/n/${copy.id}`);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handleDelete = () => {
    if (confirm(t('note.deleteConfirm', { name: displayName }))) {
      void vault.remove(id);
      navigate(noteGroup ? groupPath(noteGroup.id, folder) : !isOwner ? '/shared' : folder ? `/f/${encodeURIComponent(folder)}` : '/notes', true);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col print:block print:h-auto print:overflow-visible">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto scrollbar-thin print:block print:h-auto print:overflow-visible">
        <div className={`content-container mx-auto w-full flex-1 px-4 pt-4 nav:px-7 nav:pt-5 ${showPdf ? 'flex flex-col' : ''} ${focus ? 'focus-container' : ''}`}>
          {focus && (
            <button
              type="button"
              className="focus-exit no-print btn-icon fixed right-4 top-[calc(env(safe-area-inset-top)+0.75rem)] z-30 bg-surface-container-high"
              onClick={() => setFocusMode(false)}
              title={t('focus.exit')}
              aria-label={t('focus.exit')}
            >
              <CloseFullscreen size={20} />
            </button>
          )}
          <div className={`no-print mb-3 items-center gap-2 text-sm text-on-surface-variant anim-fade-in ${focus ? 'hidden' : 'flex'}`}>
            {/* The second pane (#88) has its own back button in its header; this one would go back in the main pane */}
            {pane === 'main' && (
              <button className="btn-icon -ml-2 shrink-0" onClick={() => history.back()} title={t('common.back')} aria-label={t('common.back')}>
                <ArrowLeft size={18} />
              </button>
            )}

            {/* Mobile: single last folder breadcrumb + dropdown to tap any ancestor */}
            <MobileBreadcrumbMenu folderSegments={folderSegments} lang={lang} group={noteGroup} />

            {/* Desktop: full folder path breadcrumbs */}
            <nav aria-label={t('note.breadcrumbAria')} className="hidden min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono text-[11.5px] md:flex">
              <button
                type="button"
                onClick={() => navigate(noteGroup ? groupPath(noteGroup.id) : '/notes')}
                className="truncate rounded px-1 py-0.5 text-muted transition-colors hover:bg-raised hover:text-text"
              >
                {noteGroup ? noteGroup.name : t('note.breadcrumbRoot')}
              </button>
              {folderSegments.map((seg, i) => {
                const segPath = folderSegments.slice(0, i + 1).join('/');
                const label = i === 0 && !noteGroup ? folderDisplayName(seg, lang) : seg;
                return (
                  <Fragment key={segPath}>
                    <span aria-hidden className="text-faint">/</span>
                    <button
                      type="button"
                      onClick={() => navigate(noteGroup ? groupPath(noteGroup.id, segPath) : `/f/${encodeURIComponent(segPath)}`)}
                      className="truncate rounded px-1 py-0.5 text-muted transition-colors hover:bg-raised hover:text-text"
                    >
                      {label}
                    </button>
                  </Fragment>
                );
              })}
              <span aria-hidden className="text-faint">/</span>
              <span className="truncate px-1 text-acc-hi">{isProjectHome ? name : title || displayName}</span>
              {note.access !== 'owner' && (
                <span className="chip ml-1 shrink-0" data-note-owner-chip>
                  {noteGroup ? <Users size={14} /> : <Avatar name={note.owner ?? ''} avatarUrl={note.ownerAvatar} size="xs" />} {note.owner} · {accessLabel}
                </span>
              )}
            </nav>

            {/* Header actions: Lock, Copy Markdown (no frontmatter), Right Splitview toggle, 3-dot Menu */}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <PresenceBar noteId={id} />
              {confluenceStatus && (
                <button
                  type="button"
                  className={`chip shrink-0 ${confluenceStatus === 'error' || confluenceStatus === 'conflict' ? 'text-error' : ''}`}
                  onClick={() => setConfluenceOpen(true)}
                  title={t(`confluence.status.${confluenceStatus}` as I18nKey)}
                  data-confluence-status={confluenceStatus}
                >
                  {confluenceStatus === 'error' || confluenceStatus === 'conflict' ? <AlertTriangle size={13} /> : <Cloud size={13} />}
                  <span className="hidden sm:inline">Confluence</span>
                </button>
              )}
              {note.versioning && (
                <button type="button" className="chip shrink-0 tabular-nums" onClick={() => setReleaseOpen(true)} title={t('release.chipTitle')} data-release-chip>
                  <NewReleases size={13} />
                  <span>{releaseChipLabel(note)}</span>
                </button>
              )}
              {(readOnly || remote) && (
                <span title={remote ? t('remote.readOnly') : sharedReadOnly ? t('note.readOnlyShared') : t('common.readOnly')}>
                  <Lock size={15} className="mr-1 text-on-surface-variant" />
                </span>
              )}
              {copiedMd && (
                <span role="status" className="chip anim-fade-in text-primary">
                  <Check size={13} /> {t('note.copyMarkdownDone')}
                </span>
              )}
              {commentsOn && !locked && (
                <button
                  type="button"
                  className="btn-icon"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={startComment}
                  title={`${t('comments.add')} (${IS_APPLE ? '⌘' : lang === 'en' ? 'Ctrl' : 'Strg'}+Alt+C)`}
                  aria-label={t('comments.add')}
                  data-add-comment
                >
                  <MessageSquarePlus size={18} />
                </button>
              )}
              <button
                type="button"
                onClick={() => panel.setOpen(!splitOpen)}
                aria-pressed={splitOpen}
                className={`btn-icon transition-colors ${splitOpen ? 'bg-secondary-container text-on-secondary-container' : ''}`}
                title={t('note.splitviewTitle')}
                aria-label={t('note.splitviewTitle')}
              >
                {splitOpen ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
              </button>
              <NoteOverflowMenu
                title={title || displayName}
                content={remote ? remote.text : note.content}
                isOwner={canRename}
                canShare={isOwner && !vault.standalone}
                mayDelete={mayDelete}
                onShare={() => setSharing(true)}
                onConfluence={isOwner && confluence?.connection ? () => setConfluenceOpen(true) : undefined}
                onHistory={() => setShowHistory(true)}
                onVersioning={!DEMO && (note.access === 'owner' || groupManager || note.versioning) ? () => setReleaseOpen(true) : undefined}
                variables={remote ? EMPTY_VARIABLE_SCOPE : variables}
                exportContent={remote ? remoteText : note.versioning ? exportContent : undefined}
                onMove={() => setMoving(true)}
                onMoveToGroup={isOwner && !vault.standalone && !DEMO ? () => setMovingToGroup(true) : undefined}
                onDuplicate={mayDuplicate ? () => void duplicateNote() : undefined}
                onDelete={handleDelete}
                onCopy={() => void copyMarkdown()}
                favorite={features.favorites.enabled ? vault.isFavorite(id) : null}
                onToggleFavorite={() => void vault.toggleFavorite(id).catch(() => undefined)}
                onIcon={features.icons.enabled && !readOnly ? () => setPickingIcon(true) : undefined}
                sourceMode={readOnly || remote ? null : sourceMode}
                onToggleSource={() => setSourceMode(!sourceMode)}
                focusMode={features.focus.enabled && !showPdf ? focus : null}
                onToggleFocus={() => setFocusMode(!focus)}
                onFinishProject={isProject ? () => confirm(t('para.finishConfirm')) && void vault.archiveProject(id) : undefined}
                onAddProperty={
                  !readOnly && view && !remote
                    ? () => {
                        const key = prompt(t('note.addPropertyPrompt'))?.trim().replace(/:+$/, '');
                        if (key) applyFrontmatter(view, { [key]: '' }, key);
                      }
                    : undefined
                }
                onNoteType={!readOnly && !remote && !pdf && drawing === null && !inMemory && !ticketFields ? () => setPickingType(true) : undefined}
                onConvertProject={isSingleProject ? () => void vault.convertProjectToFolder(id) : undefined}
                align={align}
                onAlign={!readOnly && view && !showPdf && !remote ? (value) => applyFrontmatter(view, { align: value === 'left' ? null : value }) : undefined}
                onPresent={features.presentation.enabled && !showPdf && !remote ? () => setPresenting(true) : undefined}
              />
            </div>
          </div>

          {note.access !== 'owner' && (
            <div className="no-print mb-2 inline-flex max-w-full items-center gap-1.5 chip md:hidden anim-fade-in">
              {noteGroup ? <Users size={14} /> : <Avatar name={note.owner ?? ''} avatarUrl={note.ownerAvatar} size="xs" />}{' '}
              <span className="truncate">
                {note.owner} · {accessLabel}
              </span>
            </div>
          )}

          {dailyDate && !focus && (
            <div className="no-print">
              <DailyNoteBar date={dailyDate} />
              {!readOnly && <DailyCarryOver noteId={id} date={dailyDate} />}
            </div>
          )}
          {(weekDate || monthDate) && !focus && (
            <div className="no-print">
              <PeriodicNoteBar kind={weekDate ? 'week' : 'month'} date={(weekDate ?? monthDate)!} />
            </div>
          )}

          <textarea
            ref={titleRef}
            rows={1}
            className="note-title mb-2 block w-full resize-none overflow-hidden break-words bg-transparent text-[30px] leading-[38px] outline-none placeholder:text-on-surface-variant nav:text-[36px] nav:leading-[44px] print:hidden"
            value={title}
            readOnly={!canRename}
            placeholder={t('note.titlePlaceholder')}
            onChange={(e) => setTitle(e.target.value.replace(/[\r\n]+/g, ' '))}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTitle();
                view?.focus();
              }
            }}
          />
          <h1 className="font-display mb-3 hidden break-words text-headline-l print:block">{title || displayName}</h1>
          {/* Word count sits under the title instead of a bar over the content */}
          {!showPdf && !remote && features.writingStats.enabled && (
            <div className="no-print -mt-1 mb-2">
              <NoteStats content={note.content} view={view} tick={statsTick} lang={lang} />
            </div>
          )}
          {!locked && !focus && (
            <div className="no-print">
              <ParaBar note={note} />
            </div>
          )}
          {!focus && vault.isMemoryNote(note) && <MemoryPanel note={note} readOnly={readOnly} />}
          {/* Tickets and milestones: the fields beside the text when the note has the room (container query in index.css) */}
          {!focus && noteType && typePanel(noteType, 'top')}
          {!focus && unknownType !== null && <UnknownNoteType name={unknownType} />}
          <div className={beside ? 'ticket-layout' : 'contents'}>
          <div className={beside ? 'ticket-grid' : 'contents'}>
          {!focus && (
            <div className="ticket-side" data-ticket-side>
              <TicketPanel noteId={id} readOnly={readOnly} />
              {sideType && noteType && typePanel(noteType, 'right')}
            </div>
          )}
          {/* "Edit as text" and fullscreen live inside the canvas, so the drawing gets the room */}
          {showDrawing && (
            <Suspense fallback={<div className="flex min-h-[60vh] flex-1 items-center justify-center text-sm text-on-surface-variant">{t('common.loading')}</div>}>
              <ExcalidrawPanel
                scene={drawing}
                readOnly={readOnly}
                lang={lang}
                onSave={(json) => {
                  const current = vault.get(id);
                  if (current) void vault.update(id, { content: setExcalidrawScene(current.content, json) });
                }}
                onEditText={() => setDrawingAsText(true)}
              />
            </Suspense>
          )}
          {drawing !== null && !showDrawing && (
            <div className="no-print mb-2">
              <button type="button" className="btn-ghost" onClick={() => setDrawingAsText(false)}>
                <Draw size={16} /> {t('note.drawingShow')}
              </button>
            </div>
          )}
          {pdf && !pdfAsText && !showDrawing && <PdfPanel key={pdf.url} url={pdf.url} name={pdf.name} onEditText={() => setPdfAsText(true)} />}
          {pdf && pdfAsText && !showDrawing && (
            <div className="no-print mb-2">
              <button type="button" className="btn-ghost" onClick={() => setPdfAsText(false)}>
                <FileType2 size={16} /> {t('note.pdfShow')}
              </button>
            </div>
          )}
          {remote && <RemoteNotePanel note={note} view={remote} canEdit={!readOnly} stamp={version} callouts={features.callouts.enabled} onView={setView} />}
          {!showPdf && !remote && (
            // A line and room between the header (title, stats, PARA bar) and the text (not in focus mode, which hides
            // the header), and room below the text before the footer
            <div
              className={`pb-12 ${focus ? '' : 'note-sheet mt-4 border-t border-outline-variant pt-6 sm:mt-6 sm:pt-8 print:mt-0 print:border-0 print:pt-0'}`}
              data-note-align={align !== 'left' && !(sourceMode && !readOnly) ? align : undefined}>
            <Editor
              docKey={id}
              value={note.content}
              readOnly={readOnly}
              source={sourceMode && !readOnly}
              stamp={version}
              presenceNote={id}
              dim={focus && features.focus.dim}
              releases={note.versioning ? (note.releases ?? []) : null}
              variables={variables}
              onChange={(content) => {
                // Echoes of synced or programmatic changes equal the stored text; only real typing counts
                if (content !== vault.get(id)?.content) memoryEdit.current.edited = true;
                void vault.update(id, { content });
              }}
              onView={setView}
              onActivity={features.writingStats.enabled ? onEditorActivity : undefined}
              slideBreaks={features.presentation.enabled ? t('present.slideBreak') : ''}
              callouts={features.callouts.enabled}
              hideProperties={hideProperties}
            />
            </div>
          )}
          </div>
          </div>

          {!focus && noteType && typePanel(noteType, 'bottom')}
          {/* Bottom links/graph overview remains visible when the right split pane is collapsed */}
          {!showPdf && !splitOpen && !focus && (backlinks.length > 0 || memoryBacklinks.length > 0 || mentions.length > 0 || ticketLinks.length > 0 || local.nodes.length > 1) && (
            <div className="no-print mb-24 space-y-6 border-t border-outline-variant pt-8">
              {ticketLinks.length > 0 && (
                <div className="anim-fade-in">
                  <TicketBacklinks tickets={ticketLinks} />
                </div>
              )}
              {memoryBacklinks.length > 0 && (
                <section className="anim-fade-in" data-memory-backlinks>
                  <h2 className="mb-2 flex items-center gap-1.5 text-title-s text-on-surface-variant">
                    <Psychology size={16} /> {t('memory.backlinksTitle', { n: memoryBacklinks.length })}
                  </h2>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {memoryBacklinks.map((b) => (
                      <button key={b.id} className="w-full min-w-0 rounded-xl border border-dashed border-outline-variant p-3 text-left text-sm transition hover:border-primary/40" onClick={() => navigate(`/n/${b.id}`)}>
                        <div className="truncate font-medium">{memoryMeta(b.content, b.path).title}</div>
                        <div className="line-clamp-1 break-words text-on-surface-variant">{memoryMeta(b.content, b.path).description || resolveVariables(excerpt(b.content, 90), variablesOfNote(b))}</div>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {backlinks.length > 0 && (
                <section className="anim-fade-in">
                  <h2 className="mb-2 text-title-s text-on-surface-variant">{t('note.backlinksTitle', { n: backlinks.length })}</h2>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {backlinks.map((b) => (
                      <button key={b.id} className="w-full min-w-0 rounded-xl border border-outline-variant p-3 text-left text-sm transition hover:border-primary/40" onClick={() => navigate(`/n/${b.id}`)}>
                        <div className="truncate font-medium">{projectTitleOf(b.path, b.content, rc)}</div>
                        <div className="line-clamp-1 break-words text-on-surface-variant">{resolveVariables(excerpt(b.content, 90), variablesOfNote(b))}</div>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {mentions.length > 0 && (
                <section className="anim-fade-in">
                  <h2 className="mb-2 text-title-s text-on-surface-variant">{t('note.mentionsTitle', { n: mentions.length })}</h2>
                  <ul className="space-y-1.5">
                    {mentions.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 rounded-xl border border-dashed border-outline-variant px-3 py-2 text-sm">
                        <button className="min-w-0 flex-1 truncate text-left hover:text-primary" onClick={() => navigate(`/n/${m.id}`)}>
                          {projectTitleOf(m.path, m.content, rc)}
                        </button>
                        <button className="edit-only chip shrink-0" onClick={() => void vault.linkMention(m.id, id)}>
                          <Link2 size={12} /> {t('note.linkMentionTitle')}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {local.nodes.length > 1 && (
                <section className="anim-fade-in">
                  <button className="mb-2 flex items-center gap-1 text-title-s text-on-surface-variant hover:text-on-surface" onClick={() => setShowGraph(!showGraph)}>
                    <ChevronRight size={14} className={`transition-transform duration-200 ${showGraph ? 'rotate-90' : ''}`} /> {t('note.localGraphTitle', { n: local.nodes.length - 1 })}
                  </button>
                  {showGraph && <Graph nodes={local.nodes} edges={local.edges} focusId={id} height={300} onOpen={(n) => n !== id && navigate(`/n/${n}`)} />}
                </section>
              )}
            </div>
          )}
        </div>
        {!showPdf && !readOnly && !remote && (
          <div className={`no-print sticky bottom-0 z-20 ${focus ? 'nav:hidden' : ''}`}>
            <Toolbar view={view} lang={lang} />
          </div>
        )}
      </div>

      {/* Desktop right Splitview Supporting Pane (lg+, detached card like the left sidebar) */}
      {splitOpen &&
        !focus &&
        rightHost &&
        createPortal(
          <aside
            aria-label={t('note.paneTitle')}
            style={{ width: sidePaneW, maxWidth: '45vw' }}
            className="relative flex min-h-0 flex-col rounded-[28px] bg-surface-container-low anim-fade-in"
          >
            <ResizeHandle store={sidePaneWidth} edge="left" label={t('note.resizePane')} />
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
            <NoteInspectorPane
              noteId={id}
              outline={outline}
              variables={remote ? EMPTY_VARIABLE_SCOPE : variables}
              tasks={noteTasks}
              view={view}
              canEdit={!readOnly && !showPdf && !remote}
              backlinks={backlinks}
              mentions={mentions}
              tickets={ticketLinks}
              local={local}
              tab={splitTab}
              setTab={panel.setTab}
              onJump={(pos) => jumpToPos(pos, false)}
              onClose={() => panel.setOpen(false)}
              comments={
                commentsOn
                  ? {
                      count: threads.filter((th) => !th.resolved).length,
                      panel: (
                        <CommentsPanel
                          noteId={id}
                          threads={threads}
                          view={view}
                          content={note.content}
                          canComment={!locked}
                          draft={commentDraft}
                          onDraftDone={() => setCommentDraft(null)}
                          focused={focusedThread}
                          onFocus={(threadId, range) => {
                            setFocusedThread(threadId);
                            showPassage(view, range);
                          }}
                        />
                      ),
                    }
                  : undefined
              }
            />
            </div>
          </aside>,
          rightHost
        )}

      {/* Tablet / Mobile Splitview Slide-over Sheet (< lg) – portal escapes .vt-main stacking context */}
      {splitOpen &&
        !focus &&
        createPortal(
          <div data-splitview-sheet="true" className="no-print fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0 bg-scrim/[0.32] anim-fade-in" onClick={() => panel.setOpen(false)} />
            <SideSheet label={t('note.splitviewTitle')} onClose={() => panel.setOpen(false)}>
              <NoteInspectorPane
                noteId={id}
                outline={outline}
              variables={remote ? EMPTY_VARIABLE_SCOPE : variables}
                tasks={noteTasks}
              view={view}
              canEdit={!readOnly && !showPdf && !remote}
                backlinks={backlinks}
                mentions={mentions}
                local={local}
                tab={splitTab}
                setTab={panel.setTab}
                onJump={(pos) => jumpToPos(pos, true)}
                onClose={() => panel.setOpen(false)}
              comments={
                commentsOn
                  ? {
                      count: threads.filter((th) => !th.resolved).length,
                      panel: (
                        <CommentsPanel
                          noteId={id}
                          threads={threads}
                          view={view}
                          content={note.content}
                          canComment={!locked}
                          draft={commentDraft}
                          onDraftDone={() => setCommentDraft(null)}
                          focused={focusedThread}
                          onFocus={(threadId, range) => {
                            setFocusedThread(threadId);
                            showPassage(view, range);
                          }}
                        />
                      ),
                    }
                  : undefined
              }
              />
            </SideSheet>
          </div>,
          document.body
        )}

      {moving && (
        <MoveNoteSheet
          noteTitle={title || displayName}
          currentFolder={folder}
          folders={noteGroup ? vault.groupFolders(noteGroup.id) : undefined}
          onMove={(targetFolder) => {
            setMoving(false);
            void vault.update(id, { folder: targetFolder });
          }}
          onClose={() => setMoving(false)}
        />
      )}
      {movingToGroup && <MoveToGroupSheet noteIds={[id]} label={title || displayName} onClose={() => setMovingToGroup(false)} />}
      {presenting && (
        <Suspense fallback={null}>
          <Presentation
            docKey={id}
            title={title || displayName}
            content={note.content}
            releases={note.versioning ? (note.releases ?? []) : null}
            variables={variables}
            callouts={features.callouts.enabled}
            onFormat={!readOnly && view ? (format) => applyFrontmatter(view, { presentation: format }) : undefined}
            onClose={() => setPresenting(false)}
          />
        </Suspense>
      )}
      {releaseOpen && <ReleaseDialog note={note} locked={locked} onClose={() => setReleaseOpen(false)} />}
      {showHistory && <HistoryDialog noteId={id} variables={variables} current={note.content} canRestore={!readOnly} onClose={() => setShowHistory(false)} />}
      {pickingIcon && (
        <IconPickerDialog
          title={t('icons.noteTitle')}
          current={noteIconOf(note.content)}
          onPick={(next) => (view && !showPdf && !remote ? applyFrontmatter(view, { icon: next }) : void vault.setNoteIcon(id, next))}
          onClose={() => setPickingIcon(false)}
        />
      )}
      {pickingType && <NoteTypeSheet note={note} current={noteType} onClose={() => setPickingType(false)} />}
      {sharing && <ShareDialog target={{ note: id }} onClose={() => setSharing(false)} />}
      {confluenceOpen && <ConfluenceDialog target={{ note: id, title: title || displayName }} onClose={() => setConfluenceOpen(false)} />}
    </div>
  );
}
