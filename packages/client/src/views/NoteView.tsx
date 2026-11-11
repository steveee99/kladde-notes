import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorView } from '@codemirror/view';
import {
  ArrowLeft,
  Bold,
  CalendarPlus,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  Download,
  FileCode,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderInput,
  Heading,
  History,
  Image as ImageIcon,
  Link2,
  List,
  ListTree,
  Loader2,
  Lock,
  MoreVertical,
  Network,
  PanelRight,
  PanelRightClose,
  Printer,
  Share2,
  Star,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { undo } from '@codemirror/commands';
import {
  excerpt,
  extractDailyNoteDate,
  extractHeadings,
  isFolderProjectHome,
  projectTitleOf,
  safeExportFilename,
  splitPath,
  stripFrontmatter,
  toDateString,
  type GraphEdge,
  type GraphNode,
  type NoteHeading,
} from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { Editor, insertAtLineStart, insertText, toggleCode, toggleWrap, wrapSelection } from '../editor/Editor';
import { editorHost } from '../editor/host';
import { ShareDialog } from './ShareDialog';
import { HistoryDialog } from './History';
import { ParaBar } from './ParaBar';
import { Graph, GraphLegend } from './Graph';
import { Sheet } from './Dialogs';
import { Avatar } from './Avatar';
import { PresenceBar, useAnnouncePresence } from './PresenceBar';
import { folderDisplayName, t, useLang, type Lang } from '../lib/i18n';
import { setNoteSplitOpen, setNoteSplitTab, setSourceMode, useNoteSplitOpen, useNoteSplitTab, useSourceMode, type NoteSplitTab } from '../lib/prefs';
import { isCoarsePointer } from '../lib/viewport';
import { useRightPaneHost } from './MaterialShell';
import { DailyNoteBar } from './DailyNoteBar';

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
      className="btn-icon shrink-0 rounded-full"
      onMouseDown={(e) => e.preventDefault()}
      onClick={fn}
    >
      <Icon size={18} />
    </button>
  );
  return (
    <div className="note-toolbar sticky bottom-0 z-20 flex gap-1 overflow-x-auto border-t border-line bg-surface/95 px-2 pt-1.5 backdrop-blur [--pad-bottom:0.375rem] max-md:pb-1.5 md:safe-bottom scrollbar-thin">
      {btn(CheckSquare, t('note.toolbarTask'), () => insertAtLineStart(view, '- [ ] '))}
      {btn(CalendarPlus, t('note.toolbarDueToday'), () => insertText(view, ` 📅 ${toDateString(new Date())}`))}
      {btn(Heading, t('note.toolbarHeading'), () => insertAtLineStart(view, '## '))}
      {btn(List, t('note.toolbarList'), () => insertAtLineStart(view, '- '))}
      {btn(ListTree, t('note.toolbarToc'), () => insertAtLineStart(view, '##TOC##\n'))}
      {btn(Bold, `${t('note.toolbarBold')} (${mod}+B)`, () => toggleWrap(view, '**'))}
      {btn(Link2, `${t('note.toolbarWiki')} (${mod}+Shift+L)`, () => wrapSelection(view, '[[', ']]'))}
      {btn(Code, `${t('note.toolbarCode')} (${mod}+Shift+M)`, () => toggleCode(view))}
      {btn(ImageIcon, t('note.toolbarUpload'), () => file.current?.click())}
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
function MobileBreadcrumbMenu({ folderSegments, lang }: { folderSegments: string[]; lang: Lang }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const items: { key: string; label: string; to: string; depth: number }[] = [
    { key: '__root__', label: t('note.breadcrumbRoot'), to: '/notes', depth: 0 },
    ...folderSegments.map((seg, i) => ({
      key: folderSegments.slice(0, i + 1).join('/'),
      label: i === 0 ? folderDisplayName(seg, lang) : seg,
      to: `/f/${encodeURIComponent(folderSegments.slice(0, i + 1).join('/'))}`,
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
          open ? 'bg-accent-container text-on-accent-container' : 'bg-raised/70 text-ink hover:bg-raised'
        }`}
      >
        <Folder size={14} className={`shrink-0 ${open ? 'text-on-accent-container' : 'text-accent'}`} />
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
            className="no-print fixed z-[90] max-h-[60vh] w-64 overflow-y-auto rounded-2xl border border-line/70 bg-raised p-1.5 shadow-soft anim-fade-in scrollbar-thin"
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
                    isCurrent ? 'bg-accent-container text-on-accent-container font-medium' : 'text-ink hover:bg-surface'
                  }`}
                >
                  <Folder size={14} className={isCurrent ? 'shrink-0' : 'shrink-0 text-accent'} />
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

/** Material 3 three-dot overflow menu: Share, History, Export (submenu), Move, Delete */
function NoteOverflowMenu({
  title,
  content,
  isOwner,
  canShare,
  mayDelete,
  onShare,
  onHistory,
  onMove,
  onDelete,
}: {
  title: string;
  content: string;
  isOwner: boolean;
  canShare: boolean;
  mayDelete: boolean;
  onShare: () => void;
  onHistory: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState<'word' | 'pdf' | null>(null);
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

  const exportMarkdown = () => {
    setOpen(false);
    const body = stripFrontmatter(content);
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

  const runAsync = async (kind: 'word' | 'pdf') => {
    setBusy(kind);
    setOpen(false);
    try {
      const mod = await import('../lib/noteExport');
      if (kind === 'word') await mod.exportNoteAsWord(title, content);
      else await mod.exportNoteAsPdf(title, content);
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
        className="btn-icon rounded-full"
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
            className="no-print fixed z-[90] w-60 rounded-2xl border border-line/70 bg-raised p-1.5 shadow-soft anim-fade-in"
          >
            {canShare && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-ink transition-colors hover:bg-surface"
                onClick={() => {
                  setOpen(false);
                  onShare();
                }}
              >
                <Share2 size={16} className="shrink-0 text-muted" />
                <span>{t('common.share')}</span>
              </button>
            )}

            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-ink transition-colors hover:bg-surface"
              onClick={() => {
                setOpen(false);
                onHistory();
              }}
            >
              <History size={16} className="shrink-0 text-muted" />
              <span>{t('common.history')}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              aria-expanded={exportOpen}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-ink transition-colors hover:bg-surface"
              onClick={() => setExportOpen((v) => !v)}
            >
              <Download size={16} className="shrink-0 text-muted" />
              <span className="flex-1">{t('common.export')}</span>
              <ChevronDown size={15} className={`shrink-0 text-faint transition-transform duration-150 ${exportOpen ? 'rotate-180' : ''}`} />
            </button>

            {exportOpen && (
              <div className="my-1 ml-3 space-y-0.5 border-l border-line/80 pl-2 anim-fade-in">
                <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-faint">{t('export.headerNoFrontmatter')}</div>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface"
                  onClick={exportMarkdown}
                >
                  <FileCode size={15} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-tight">{t('export.mdTitle')}</div>
                    <div className="text-[11px] text-faint">{t('export.mdDesc')}</div>
                  </div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface"
                  onClick={() => void runAsync('word')}
                >
                  <FileSpreadsheet size={15} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-tight">{t('export.wordTitle')}</div>
                    <div className="text-[11px] text-faint">{t('export.wordDesc')}</div>
                  </div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface"
                  onClick={() => void runAsync('pdf')}
                >
                  <FileText size={15} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-tight">{t('export.pdfTitle')}</div>
                    <div className="text-[11px] text-faint">{t('export.pdfDesc')}</div>
                  </div>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-muted transition-colors hover:bg-surface hover:text-ink"
                  onClick={() => {
                    setOpen(false);
                    requestAnimationFrame(() => window.print());
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
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-ink transition-colors hover:bg-surface"
                onClick={() => {
                  setOpen(false);
                  onMove();
                }}
              >
                <FolderInput size={16} className="shrink-0 text-muted" />
                <span>{t('common.move')}</span>
              </button>
            )}

            {mayDelete && (
              <>
                <div className="my-1 border-t border-line/80" />
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-danger transition-colors hover:bg-danger/10"
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
function MoveNoteSheet({ noteTitle, currentFolder, onMove, onClose }: { noteTitle: string; currentFolder: string; onMove: (folder: string) => void; onClose: () => void }) {
  const lang = useLang();
  const [filter, setFilter] = useState('');
  const allFolders = ['', ...vault.folders()];
  const q = filter.trim().toLowerCase();
  const visible = q
    ? allFolders.filter((f) => (f ? folderDisplayName(f, lang) : t('common.topLevelPlain')).toLowerCase().includes(q) || f.toLowerCase().includes(q))
    : allFolders;

  return (
    <Sheet title={t('note.moveTitle')} onClose={onClose}>
      <p className="mb-3 text-sm text-muted">{t('note.moveDesc', { name: noteTitle })}</p>
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
                className={`flex w-full items-center gap-3 rounded-full px-3.5 py-2.5 text-left text-sm transition-colors ${active ? 'bg-accent-container text-on-accent-container font-medium' : 'text-ink hover:bg-raised'}`}
              >
                <Folder size={16} className={active ? 'shrink-0' : 'shrink-0 text-accent'} />
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

/** Supporting split pane on the right of a note: TOC, Links (Backlinks + Mentions), and Local Graph */
function NoteInspectorPane({
  noteId,
  headings,
  backlinks,
  mentions,
  local,
  tab,
  setTab,
  onJump,
  onClose,
}: {
  noteId: string;
  headings: NoteHeading[];
  backlinks: LocalNote[];
  mentions: LocalNote[];
  local: { nodes: GraphNode[]; edges: GraphEdge[] };
  tab: NoteSplitTab;
  setTab: (tab: NoteSplitTab) => void;
  onJump: (pos: number) => void;
  onClose?: () => void;
}) {
  useLang();
  const rc = vault.roleConfig();
  const tabs: { id: NoteSplitTab; label: string; Icon: typeof ListTree; count?: number }[] = [
    { id: 'toc', label: t('note.tabToc'), Icon: ListTree, count: headings.length || undefined },
    { id: 'links', label: t('note.tabLinks'), Icon: Link2, count: backlinks.length + mentions.length || undefined },
    { id: 'graph', label: t('note.tabGraph'), Icon: Network, count: local.nodes.length > 1 ? local.nodes.length - 1 : undefined },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-faint">{t('note.paneTitle')}</span>
        {onClose && (
          <button type="button" onClick={onClose} className="btn-icon h-8 w-8 rounded-full" aria-label={t('common.close')}>
            <X size={16} />
          </button>
        )}
      </div>

      {/* M3 Segmented Button */}
      <div role="tablist" aria-label={t('note.paneTitle')} className="grid shrink-0 grid-cols-3 gap-1 rounded-full bg-raised p-1">
        {tabs.map(({ id, label, Icon, count }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(id)}
              className={`flex min-w-0 items-center justify-center gap-1 rounded-full px-1.5 py-1.5 text-xs font-medium transition-colors sm:gap-1.5 sm:px-2 ${active ? 'bg-accent-container text-on-accent-container shadow-soft' : 'text-muted hover:text-ink'}`}
            >
              <Icon size={13} className="shrink-0" />
              <span className="min-w-0 truncate">{label}</span>
              {count !== undefined && <span className="shrink-0 opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pr-0.5">
        {tab === 'toc' && (
          <div className="space-y-1">
            {headings.length === 0 ? (
              <p className="py-8 text-center text-sm text-faint">{t('note.tocEmpty')}</p>
            ) : (
              headings.map((h, i) => (
                <button
                  key={`${h.line}-${i}`}
                  type="button"
                  onClick={() => onJump(h.from)}
                  title={t('note.tocJumpHint', { text: h.text })}
                  style={{ paddingLeft: `${12 + (h.level - 1) * 12}px` }}
                  className={`block w-full truncate rounded-full py-1.5 pr-3 text-left transition-colors hover:bg-raised hover:text-accent ${h.level === 1 ? 'text-sm font-medium text-ink' : h.level === 2 ? 'text-sm text-ink/90' : 'text-xs text-muted'}`}
                >
                  {h.text}
                </button>
              ))
            )}
          </div>
        )}

        {tab === 'links' && (
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{t('note.backlinksTitle', { n: backlinks.length })}</h3>
              {backlinks.length === 0 ? (
                <p className="text-sm text-faint">{t('note.backlinksEmpty')}</p>
              ) : (
                <div className="space-y-2">
                  {backlinks.map((b) => (
                    <button key={b.id} className="w-full rounded-2xl border border-line/80 bg-bg/40 p-3 text-left text-sm transition hover:border-accent/40 hover:bg-raised/60" onClick={() => navigate(`/n/${b.id}`)}>
                      <div className="truncate font-medium">{projectTitleOf(b.path, b.content, rc)}</div>
                      {excerpt(b.content, 85) && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{excerpt(b.content, 85)}</div>}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <hr className="border-0 border-t border-line/70" />

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{t('note.mentionsTitle', { n: mentions.length })}</h3>
              {mentions.length === 0 ? (
                <p className="text-sm text-faint">{t('note.mentionsEmpty')}</p>
              ) : (
                <ul className="space-y-1.5">
                  {mentions.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 rounded-2xl border border-dashed border-line px-3 py-2 text-sm">
                      <button className="min-w-0 flex-1 truncate text-left hover:text-accent" onClick={() => navigate(`/n/${m.id}`)}>
                        {projectTitleOf(m.path, m.content, rc)}
                      </button>
                      <button className="edit-only chip shrink-0 cursor-pointer px-2.5 py-1 hover:bg-accent/15 hover:text-accent" onClick={() => void vault.linkMention(m.id, noteId)}>
                        <Link2 size={12} /> {t('note.linkMentionTitle')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        {tab === 'graph' && (
          <div>
            {local.nodes.length <= 1 ? (
              <p className="py-8 text-center text-sm text-faint">{t('note.localGraphEmpty')}</p>
            ) : (
              <div className="space-y-3">
                <Graph nodes={local.nodes} edges={local.edges} focusId={noteId} height={360} onOpen={(n) => n !== noteId && navigate(`/n/${n}`)} />
                <GraphLegend />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function NoteView({ id, isNew }: { id: string; isNew: boolean }) {
  const version = useVault();
  const lang = useLang();
  const note = vault.get(id);
  const rc = vault.roleConfig();
  const [view, setView] = useState<EditorView | null>(null);
  const locked = useReadOnly();
  const [sharing, setSharing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [moving, setMoving] = useState(false);
  const [showGraph, setShowGraph] = useState(true);
  const splitOpen = useNoteSplitOpen();
  const sourceMode = useSourceMode();
  const splitTab = useNoteSplitTab();
  const rightHost = useRightPaneHost();
  const [copiedMd, setCopiedMd] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [title, setTitle] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);
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
    };
  }, []);

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
    const n = Number(new URLSearchParams(location.search).get('line'));
    if (!view || !hasNote || !n) return;
    const ln = view.state.doc.line(Math.min(n, view.state.doc.lines));
    view.dispatch({ selection: { anchor: ln.from }, effects: EditorView.scrollIntoView(ln.from, { y: 'center' }) });
    history.replaceState(null, '', location.pathname);
  }, [view, hasNote]);

  if (!note) {
    return (
      <div className="p-10 text-center text-muted anim-fade-in">
        {vault.ready ? t('note.notFound') : t('common.loading')}
        <div>
          <button className="btn-ghost mt-4" onClick={() => navigate('/')}>
            {t('note.backToHome')}
          </button>
        </div>
      </div>
    );
  }

  const sharedReadOnly = note.access === 'read';
  // The read-only switch locks the note like a share with read access
  const readOnly = sharedReadOnly || locked;
  const isOwner = note.access === 'owner' && !locked;
  // Own notes, or shared ones whose folder share allows deleting
  const mayDelete = !locked && vault.canDelete(note);
  const { folder } = splitPath(note.path);
  const folderSegments = folder ? folder.split('/') : [];
  const features = vault.features();
  const dailyDate = features.daily.enabled && note.access === 'owner' ? extractDailyNoteDate(note.path, features.daily) : null;
  const index = vault.links();
  const backlinks = index.backlinks(id).map((b) => vault.get(b)!).filter(Boolean);
  const mentions = index.unlinkedMentions(id).map((m) => vault.get(m)!).filter((n) => n && n.access !== 'read');
  const local = index.localGraph(id, 2);
  const headings = extractHeadings(note.content);

  const copyMarkdown = async () => {
    const clean = stripFrontmatter(note.content);
    try {
      await navigator.clipboard.writeText(clean);
      setCopiedMd(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedMd(false), 1800);
    } catch {
      /* ignore */
    }
  };

  const jumpToPos = (pos: number, closeSheet = false) => {
    if (!view) return;
    const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
    view.dispatch({
      selection: { anchor: clamped },
      effects: EditorView.scrollIntoView(clamped, { y: 'start', yMargin: 72 }),
    });
    view.focus();
    if (closeSheet) setNoteSplitOpen(false);
  };

  const handleDelete = () => {
    if (confirm(t('note.deleteConfirm', { name: displayName }))) {
      void vault.remove(id);
      navigate(!isOwner ? '/shared' : folder ? `/f/${encodeURIComponent(folder)}` : '/notes', true);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col print:block print:h-auto print:overflow-visible">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto scrollbar-thin print:block print:h-auto print:overflow-visible">
        <div className="content-container mx-auto w-full flex-1 px-4 pt-4 sm:px-8 sm:pt-8">
          <div className="no-print mb-3 flex items-center gap-2 text-sm text-faint anim-fade-in">
            <button className="btn-icon -ml-2 shrink-0 rounded-full" onClick={() => history.back()} title={t('common.back')} aria-label={t('common.back')}>
              <ArrowLeft size={18} />
            </button>

            {/* Mobile: single last folder breadcrumb + dropdown to tap any ancestor */}
            <MobileBreadcrumbMenu folderSegments={folderSegments} lang={lang} />

            {/* Desktop: full folder path breadcrumbs */}
            <nav aria-label={t('note.breadcrumbAria')} className="hidden min-w-0 flex-1 flex-wrap items-center gap-1 md:flex">
              <button
                type="button"
                onClick={() => navigate('/notes')}
                className="truncate rounded-lg px-1.5 py-0.5 text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                {t('note.breadcrumbRoot')}
              </button>
              {folderSegments.map((seg, i) => {
                const segPath = folderSegments.slice(0, i + 1).join('/');
                const label = i === 0 ? folderDisplayName(seg, lang) : seg;
                return (
                  <Fragment key={segPath}>
                    <ChevronRight size={14} className="shrink-0 opacity-60" />
                    <button
                      type="button"
                      onClick={() => navigate(`/f/${encodeURIComponent(segPath)}`)}
                      className="truncate rounded-lg px-1.5 py-0.5 text-muted transition-colors hover:bg-raised hover:text-ink"
                    >
                      {label}
                    </button>
                  </Fragment>
                );
              })}
              <ChevronRight size={14} className="shrink-0 opacity-60" />
              <span className="truncate px-1 font-medium text-ink/85">{isProjectHome ? name : title || displayName}</span>
              {note.access !== 'owner' && (
                <span className="chip ml-1 shrink-0">
                  <Avatar name={note.owner ?? ''} avatarUrl={note.ownerAvatar} size="xs" /> {note.owner} ·{' '}
                  {sharedReadOnly ? t('note.sharedReadOnly') : note.canDelete ? t('note.sharedEditDelete') : t('note.sharedEditOnly')}
                </span>
              )}
            </nav>

            {/* Header actions: Lock, Copy Markdown (no frontmatter), Right Splitview toggle, 3-dot Menu */}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <PresenceBar noteId={id} />
              {readOnly && (
                <span title={sharedReadOnly ? t('note.readOnlyShared') : t('common.readOnly')}>
                  <Lock size={15} className="mr-1 text-muted" />
                </span>
              )}
              <button
                type="button"
                onClick={() => void copyMarkdown()}
                className={`btn-icon rounded-full transition-colors ${copiedMd ? 'bg-accent/15 text-accent' : ''}`}
                title={copiedMd ? t('note.copyMarkdownDone') : t('note.copyMarkdownTitle')}
                aria-label={t('note.copyMarkdownTitle')}
              >
                {copiedMd ? <Check size={18} /> : <Copy size={18} />}
              </button>
              {vault.features().favorites.enabled && (
                <button
                  type="button"
                  onClick={() => void vault.toggleFavorite(id).catch(() => undefined)}
                  aria-pressed={vault.isFavorite(id)}
                  data-favorite-toggle
                  className={`btn-icon rounded-full transition-colors ${vault.isFavorite(id) ? 'text-warn' : ''}`}
                  title={vault.isFavorite(id) ? t('favorites.remove') : t('favorites.add')}
                  aria-label={vault.isFavorite(id) ? t('favorites.remove') : t('favorites.add')}
                >
                  <Star size={18} fill={vault.isFavorite(id) ? 'currentColor' : 'none'} />
                </button>
              )}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => setSourceMode(!sourceMode)}
                  aria-pressed={sourceMode}
                  className={`btn-icon rounded-full transition-colors ${sourceMode ? 'bg-accent-container text-on-accent-container' : ''}`}
                  title={sourceMode ? t('note.sourceModeOff') : t('note.sourceModeOn')}
                  aria-label={t('note.sourceMode')}
                >
                  <FileCode size={18} />
                </button>
              )}
              <button
                type="button"
                onClick={() => setNoteSplitOpen(!splitOpen)}
                aria-pressed={splitOpen}
                className={`btn-icon rounded-full transition-colors ${splitOpen ? 'bg-accent-container text-on-accent-container' : ''}`}
                title={t('note.splitviewTitle')}
                aria-label={t('note.splitviewTitle')}
              >
                {splitOpen ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
              </button>
              <NoteOverflowMenu
                title={title || displayName}
                content={note.content}
                isOwner={isOwner}
                canShare={isOwner && !vault.standalone}
                mayDelete={mayDelete}
                onShare={() => setSharing(true)}
                onHistory={() => setShowHistory(true)}
                onMove={() => setMoving(true)}
                onDelete={handleDelete}
              />
            </div>
          </div>

          {note.access !== 'owner' && (
            <div className="no-print mb-2 inline-flex max-w-full items-center gap-1.5 chip md:hidden anim-fade-in">
              <Avatar name={note.owner ?? ''} avatarUrl={note.ownerAvatar} size="xs" />{' '}
              <span className="truncate">
                {note.owner} · {sharedReadOnly ? t('note.sharedReadOnly') : note.canDelete ? t('note.sharedEditDelete') : t('note.sharedEditOnly')}
              </span>
            </div>
          )}

          {dailyDate && (
            <div className="no-print">
              <DailyNoteBar date={dailyDate} />
            </div>
          )}

          <textarea
            ref={titleRef}
            rows={1}
            className="note-title mb-2 block w-full resize-none overflow-hidden break-words bg-transparent text-3xl font-bold tracking-tight leading-tight outline-none placeholder:text-faint sm:text-4xl print:hidden"
            value={title}
            readOnly={!isOwner}
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
          <h1 className="mb-3 hidden break-words text-3xl font-bold tracking-tight print:block">{title || displayName}</h1>
          {!locked && (
            <div className="no-print">
              <ParaBar note={note} />
            </div>
          )}
          <Editor
            docKey={id}
            value={note.content}
            readOnly={readOnly}
            source={sourceMode && !readOnly}
            stamp={version}
            presenceNote={id}
            onChange={(content) => void vault.update(id, { content })}
            onView={setView}
          />

          {/* Bottom links/graph overview remains visible when the right split pane is collapsed */}
          {!splitOpen && (backlinks.length > 0 || mentions.length > 0 || local.nodes.length > 1) && (
            <div className="no-print mb-10 space-y-6 border-t border-line pt-4">
              {backlinks.length > 0 && (
                <section className="anim-fade-in">
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{t('note.backlinksTitle', { n: backlinks.length })}</h2>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {backlinks.map((b) => (
                      <button key={b.id} className="w-full min-w-0 rounded-xl border border-line p-3 text-left text-sm transition hover:border-accent/40" onClick={() => navigate(`/n/${b.id}`)}>
                        <div className="truncate font-medium">{projectTitleOf(b.path, b.content, rc)}</div>
                        <div className="line-clamp-1 break-words text-muted">{excerpt(b.content, 90)}</div>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {mentions.length > 0 && (
                <section className="anim-fade-in">
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{t('note.mentionsTitle', { n: mentions.length })}</h2>
                  <ul className="space-y-1.5">
                    {mentions.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm">
                        <button className="min-w-0 flex-1 truncate text-left hover:text-accent" onClick={() => navigate(`/n/${m.id}`)}>
                          {projectTitleOf(m.path, m.content, rc)}
                        </button>
                        <button className="edit-only chip shrink-0 px-2.5 py-1 hover:bg-accent/15 hover:text-accent" onClick={() => void vault.linkMention(m.id, id)}>
                          <Link2 size={12} /> {t('note.linkMentionTitle')}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {local.nodes.length > 1 && (
                <section className="anim-fade-in">
                  <button className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-faint hover:text-ink" onClick={() => setShowGraph(!showGraph)}>
                    <ChevronRight size={14} className={`transition-transform duration-200 ${showGraph ? 'rotate-90' : ''}`} /> {t('note.localGraphTitle', { n: local.nodes.length - 1 })}
                  </button>
                  {showGraph && <Graph nodes={local.nodes} edges={local.edges} focusId={id} height={300} onOpen={(n) => n !== id && navigate(`/n/${n}`)} />}
                </section>
              )}
            </div>
          )}
        </div>
        {!readOnly && <Toolbar view={view} lang={lang} />}
      </div>

      {/* Desktop right Splitview Supporting Pane (lg+, detached card like the left sidebar) */}
      {splitOpen &&
        rightHost &&
        createPortal(
          <aside
            aria-label={t('note.paneTitle')}
            className="flex min-h-0 w-80 flex-col overflow-hidden rounded-[28px] bg-surface p-4 xl:w-96 anim-fade-in"
          >
            <NoteInspectorPane
              noteId={id}
              headings={headings}
              backlinks={backlinks}
              mentions={mentions}
              local={local}
              tab={splitTab}
              setTab={setNoteSplitTab}
              onJump={(pos) => jumpToPos(pos, false)}
              onClose={() => setNoteSplitOpen(false)}
            />
          </aside>,
          rightHost
        )}

      {/* Tablet / Mobile Splitview Slide-over Sheet (< lg) – portal escapes .vt-main stacking context */}
      {splitOpen &&
        createPortal(
          <div data-splitview-sheet="true" className="no-print fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0 bg-black/50 anim-fade-in" onClick={() => setNoteSplitOpen(false)} />
            <div className="absolute inset-y-0 right-0 flex w-[90%] max-w-sm flex-col rounded-l-3xl bg-surface p-4 shadow-soft safe-top safe-bottom">
              <NoteInspectorPane
                noteId={id}
                headings={headings}
                backlinks={backlinks}
                mentions={mentions}
                local={local}
                tab={splitTab}
                setTab={setNoteSplitTab}
                onJump={(pos) => jumpToPos(pos, true)}
                onClose={() => setNoteSplitOpen(false)}
              />
            </div>
          </div>,
          document.body
        )}

      {moving && (
        <MoveNoteSheet
          noteTitle={title || displayName}
          currentFolder={folder}
          onMove={(targetFolder) => {
            setMoving(false);
            void vault.update(id, { folder: targetFolder });
          }}
          onClose={() => setMoving(false)}
        />
      )}
      {showHistory && <HistoryDialog noteId={id} current={note.content} canRestore={!readOnly} onClose={() => setShowHistory(false)} />}
      {sharing && <ShareDialog target={{ note: id }} onClose={() => setSharing(false)} />}
    </div>
  );
}
