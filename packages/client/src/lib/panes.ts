import { createContext, useContext, useSyncExternalStore } from 'react';
import { navigate } from './router';
import { setNoteSplitOpen, setNoteSplitTab, useNoteSplitOpen, useNoteSplitTab, type NoteSplitTab } from './prefs';
import { createWidthStore } from './sidebarWidth';

/**
 * Two notes side by side (#88): the main pane follows the address, the side pane keeps its own history here
 * (per device). Only on wide screens with a pointer; phones keep the single note.
 */

export type Pane = 'main' | 'side';

/** Which pane a NoteView belongs to */
export const PaneContext = createContext<Pane>('main');
export const usePane = () => useContext(PaneContext);

const KEY = 'kladde_side_pane';
const SPLIT_QUERY = '(min-width: 1024px) and (hover: hover) and (pointer: fine)';

interface SideState {
  stack: string[];
  index: number;
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function load(): SideState | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SideState;
    if (!Array.isArray(s.stack) || !s.stack.length || !s.stack.every((x) => typeof x === 'string')) return null;
    return { stack: s.stack.slice(-50), index: Math.max(0, Math.min(Number(s.index) || 0, s.stack.length - 1)) };
  } catch {
    return null;
  }
}

let side: SideState | null = load();

function save(next: SideState | null): void {
  side = next;
  try {
    if (typeof localStorage !== 'undefined') {
      if (next) localStorage.setItem(KEY, JSON.stringify(next));
      else localStorage.removeItem(KEY);
    }
  } catch {
    // private mode: only for this session
  }
  emit();
}

let wide = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(SPLIT_QUERY).matches : false;
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window.matchMedia(SPLIT_QUERY).addEventListener('change', (e) => {
    wide = e.matches;
    emit();
  });
}

/** The screen is wide enough (and has a pointer) for two panes */
export const splitAvailable = () => wide;
export const useSplitAvailable = () => useSyncExternalStore(subscribe, () => wide);

/** The note in the side pane, null when it is closed */
export const sideNoteId = () => (side ? side.stack[side.index] : null);
export function useSideNote(): { id: string; canBack: boolean; canForward: boolean } | null {
  const id = useSyncExternalStore(subscribe, () => (side ? `${side.index}:${side.stack.length}:${side.stack[side.index]}` : ''));
  if (!id || !side) return null;
  return { id: side.stack[side.index], canBack: side.index > 0, canForward: side.index < side.stack.length - 1 };
}

/** Opens a note in the side pane (a new entry in its history) */
export function openInSide(id: string): void {
  if (side && side.stack[side.index] === id) return;
  const stack = side ? [...side.stack.slice(0, side.index + 1), id].slice(-50) : [id];
  save({ stack, index: stack.length - 1 });
}

export function closeSide(): void {
  save(null);
}

export function sideBack(): void {
  if (side && side.index > 0) save({ ...side, index: side.index - 1 });
}

export function sideForward(): void {
  if (side && side.index < side.stack.length - 1) save({ ...side, index: side.index + 1 });
}

/** Swaps the notes of the two panes: the main pane navigates, the side pane gets the former main note */
export function swapPanes(mainId: string): void {
  const sideId = sideNoteId();
  if (!sideId || !side) return;
  const stack = [...side.stack];
  stack[side.index] = mainId;
  save({ ...side, stack });
  navigate(`/n/${sideId}`);
}

// ------------------------------------------------------------------ where a link opens

let active: Pane = 'main';
/** Ctrl/⌘ was held at the last pointer press (Ctrl/⌘+click: open to the side) */
let modifier = false;

if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      modifier = e.ctrlKey || e.metaKey;
      const el = e.target instanceof Element ? e.target.closest('[data-pane]') : null;
      active = el?.getAttribute('data-pane') === 'side' ? 'side' : 'main';
    },
    true
  );
  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest('[data-pane]') : null;
      if (el) active = el.getAttribute('data-pane') === 'side' ? 'side' : 'main';
    },
    true
  );
  document.addEventListener('keydown', () => (modifier = false), true);
}

/** The pane the user last worked in */
export const activePane = (): Pane => active;

/**
 * Opens a note from a link: in the pane the click came from; with Ctrl/⌘ in the other pane
 * (from the main pane: to the side). Without room for two panes always in the main pane.
 */
export function openNoteLink(id: string, suffix = ''): void {
  const sideOpen = !!sideNoteId();
  const toSide = wide && (modifier ? active === 'main' : active === 'side' && sideOpen);
  modifier = false;
  if (toSide) openInSide(id);
  else navigate(`/n/${id}${suffix}`);
}

// ------------------------------------------------------------------ side panel per pane

const sidePanelKey = 'kladde_side_pane_panel';
let sidePanel: { open: boolean; tab: NoteSplitTab } = (() => {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(sidePanelKey);
    const v = raw ? (JSON.parse(raw) as { open?: unknown; tab?: unknown }) : {};
    return { open: v.open === true, tab: (typeof v.tab === 'string' ? v.tab : 'outline') as NoteSplitTab };
  } catch {
    return { open: false, tab: 'outline' as NoteSplitTab };
  }
})();

function setSidePanel(next: Partial<typeof sidePanel>): void {
  sidePanel = { ...sidePanel, ...next };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(sidePanelKey, JSON.stringify(sidePanel));
  } catch {
    // ignore
  }
  emit();
}

/** The note's side panel (outline, tasks, backlinks, comments): kept apart for each pane */
export function usePanePanel(pane: Pane) {
  const mainOpen = useNoteSplitOpen();
  const mainTab = useNoteSplitTab();
  const sideOpen = useSyncExternalStore(subscribe, () => sidePanel.open);
  const sideTab = useSyncExternalStore(subscribe, () => sidePanel.tab);
  return pane === 'side'
    ? { open: sideOpen, tab: sideTab, setOpen: (open: boolean) => setSidePanel({ open }), setTab: (tab: NoteSplitTab) => setSidePanel({ tab }) }
    : { open: mainOpen, tab: mainTab, setOpen: setNoteSplitOpen, setTab: setNoteSplitTab };
}

/** Width of the side pane next to the main note */
export const splitPaneWidth = createWidthStore('kladde_split_pane_width', 560, 340, 1100);
