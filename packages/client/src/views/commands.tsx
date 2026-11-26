import type { ReactNode } from 'react';
import { vault } from '../data/vault';
import {
  CalendarDays,
  CalendarMonth,
  CenterFocus,
  FileText,
  Home,
  Inbox as InboxIcon,
  ListChecks,
  Lock,
  LockOpen,
  Network,
  PanelLeftClose,
  Pencil,
  RefreshCw,
  Settings,
  SunMoon,
  Tags,
  Trash2,
  Users,
  VerticalSplit,
  X,
  Kanban,
  RemoteDoc,
  Search,
  FindReplace,
} from '../lib/icons';
import { t } from '../lib/i18n';
import { navigate } from '../lib/router';
import { toggleMaterialSidebarMode } from '../lib/sidebarMode';
import { setColorSchemeChoice, getColorSchemeChoice } from '../lib/theme';
import { isReadOnly, setReadOnly } from '../lib/readOnly';
import { toggleFocusMode } from '../lib/focus';
import { lastFocusedEditor, openFind } from '../editor/find';
import { closeSide, openInSide, sideNoteId, splitAvailable } from '../lib/panes';
import { closeOtherTabs, neighborTab, tabIds } from '../lib/tabs';
import { DEMO } from '../demo/demoApi';
import { ticketsAnywhere } from '../data/tickets';
import { closeNoteTab, openNoteOfPath } from './NoteTabs';
import { openDialog } from '../lib/dialogs';
import { folderOfRoute, newNote, openTodayDailyNote } from './Shell';

/** One entry of the command palette (Ctrl/⌘+K, then `>`) */
export interface Command {
  id: string;
  label: string;
  icon: ReactNode;
  /** Shown on the right, e.g. a keyboard shortcut */
  hint?: string;
  /** Extra words the filter matches (not shown) */
  keywords?: string;
  run: () => void;
}

/** The commands that make sense right now (the route decides about note and tab commands) */
export function buildCommands(path: string): Command[] {
  const features = vault.features();
  const noteId = openNoteOfPath(path);
  const locked = isReadOnly();
  const scheme = getColorSchemeChoice();
  const i = (node: ReactNode) => node;
  const list: (Command | false)[] = [
    !locked && { id: 'new-note', label: t('cmd.newNote'), icon: i(<Pencil size={16} />), keywords: 'create neu anlegen', run: () => newNote(folderOfRoute(path) ?? undefined) },
    !locked && { id: 'new-remote', label: t('cmd.newRemote'), icon: i(<RemoteDoc size={16} />), keywords: 'gitlab github remote readme repository', run: () => openDialog({ kind: 'remote', folder: folderOfRoute(path) ?? undefined }) },
    features.daily.enabled && { id: 'daily', label: t('cmd.dailyNote'), icon: i(<CalendarDays size={16} />), hint: 'Ctrl/⌘+Shift+D', keywords: 'today heute journal', run: () => void openTodayDailyNote() },
    { id: 'go-home', label: t('cmd.goHome'), icon: i(<Home size={16} />), run: () => navigate('/') },
    { id: 'go-tasks', label: t('cmd.goTasks'), icon: i(<ListChecks size={16} />), keywords: 'todo', run: () => navigate('/tasks') },
    ticketsAnywhere() && { id: 'go-projects', label: t('cmd.goProjects'), icon: i(<Kanban size={16} />), keywords: 'tickets milestones', run: () => navigate('/projects') },
    features.calendarView.enabled && { id: 'go-calendar', label: t('cmd.goCalendar'), icon: i(<CalendarMonth size={16} />), run: () => navigate('/calendar') },
    { id: 'go-inbox', label: t('cmd.goInbox'), icon: i(<InboxIcon size={16} />), keywords: 'eingang', run: () => navigate('/inbox') },
    { id: 'go-notes', label: t('cmd.goNotes'), icon: i(<FileText size={16} />), run: () => navigate('/notes') },
    { id: 'go-graph', label: t('cmd.goGraph'), icon: i(<Network size={16} />), keywords: 'wissensnetz links', run: () => navigate('/graph') },
    { id: 'go-tags', label: t('cmd.goTags'), icon: i(<Tags size={16} />), run: () => navigate('/tags') },
    !vault.standalone && !DEMO && { id: 'go-groups', label: t('cmd.goGroups'), icon: i(<Users size={16} />), run: () => navigate('/groups') },
    { id: 'go-trash', label: t('cmd.goTrash'), icon: i(<Trash2 size={16} />), keywords: 'papierkorb deleted', run: () => navigate('/trash') },
    { id: 'go-settings', label: t('cmd.goSettings'), icon: i(<Settings size={16} />), keywords: 'options optionen', run: () => navigate('/settings') },
    { id: 'side-panel', label: t('cmd.toggleSidePanel'), icon: i(<PanelLeftClose size={16} />), hint: 'Ctrl/⌘+\\', keywords: 'sidebar ordner folder', run: toggleMaterialSidebarMode },
    scheme !== 'dark' && { id: 'scheme-dark', label: t('cmd.schemeDark'), icon: i(<SunMoon size={16} />), keywords: 'theme dark mode', run: () => setColorSchemeChoice('dark') },
    scheme !== 'light' && { id: 'scheme-light', label: t('cmd.schemeLight'), icon: i(<SunMoon size={16} />), keywords: 'theme light mode', run: () => setColorSchemeChoice('light') },
    scheme !== 'mocha' && { id: 'scheme-mocha', label: t('cmd.schemeMocha'), icon: i(<SunMoon size={16} />), keywords: 'theme catppuccin dark', run: () => setColorSchemeChoice('mocha') },
    scheme !== 'system' && { id: 'scheme-system', label: t('cmd.schemeSystem'), icon: i(<SunMoon size={16} />), keywords: 'theme auto', run: () => setColorSchemeChoice('system') },
    {
      id: 'read-only',
      label: locked ? t('cmd.readOnlyOff') : t('cmd.readOnlyOn'),
      icon: i(locked ? <LockOpen size={16} /> : <Lock size={16} />),
      keywords: 'lock sperren',
      run: () => setReadOnly(!locked),
    },
    !DEMO && { id: 'sync', label: t('cmd.syncNow'), icon: i(<RefreshCw size={16} />), hint: 'Ctrl/⌘+S', keywords: 'sync', run: () => vault.kick() },
    // After the palette closed and gave the focus back, so the find field keeps it
    !!noteId && { id: 'find', label: t('cmd.findInNote'), icon: i(<Search size={16} />), hint: 'Ctrl/⌘+F', keywords: 'find suchen', run: () => setTimeout(() => openFind(), 60) },
    !!noteId && !locked && !lastFocusedEditor()?.state.readOnly && { id: 'replace', label: t('cmd.replaceInNote'), icon: i(<FindReplace size={16} />), hint: 'Ctrl/⌘+Alt+F', keywords: 'replace ersetzen', run: () => setTimeout(() => openFind(undefined, true), 60) },
    !!noteId && features.focus.enabled && { id: 'focus', label: t('cmd.focusMode'), icon: i(<CenterFocus size={16} />), hint: 'Ctrl/⌘+Shift+F', keywords: 'zen', run: toggleFocusMode },
    !!noteId && splitAvailable() && { id: 'open-side', label: t('cmd.openSide'), icon: i(<VerticalSplit size={16} />), keywords: 'split daneben', run: () => openInSide(noteId) },
    !!sideNoteId() && { id: 'close-side', label: t('cmd.closeSide'), icon: i(<X size={16} />), run: closeSide },
    !!noteId && tabIds().includes(noteId) && { id: 'close-tab', label: t('cmd.closeTab'), icon: i(<X size={16} />), run: () => closeNoteTab(noteId, noteId) },
    !!noteId && tabIds().length > 1 && { id: 'close-other-tabs', label: t('cmd.closeOtherTabs'), icon: i(<X size={16} />), run: () => closeOtherTabs(noteId) },
    tabIds().length > 1 && {
      id: 'next-tab',
      label: t('cmd.nextTab'),
      icon: i(<FileText size={16} />),
      hint: 'Ctrl/⌘+Alt+PgDn',
      run: () => {
        const next = neighborTab(noteId, 1);
        if (next) navigate(`/n/${next}`);
      },
    },
    tabIds().length > 1 && {
      id: 'prev-tab',
      label: t('cmd.prevTab'),
      icon: i(<FileText size={16} />),
      hint: 'Ctrl/⌘+Alt+PgUp',
      run: () => {
        const prev = neighborTab(noteId, -1);
        if (prev) navigate(`/n/${prev}`);
      },
    },
  ];
  return list.filter((c): c is Command => !!c);
}
