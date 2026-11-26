import { useSyncExternalStore } from 'react';

export type NoteSplitTab = 'toc' | 'tasks' | 'links' | 'graph' | 'comments';

const INBOX_ZERO_KEY = 'kladde_inbox_zero';
const SPLIT_OPEN_KEY = 'kladde_note_split_open';
const SPLIT_TAB_KEY = 'kladde_note_split_tab';
const SOURCE_MODE_KEY = 'kladde_source_mode';
const LIGATURES_KEY = 'kladde_ligatures';
const EDITOR_FONT_KEY = 'kladde_editor_font_size';

const listeners = new Set<() => void>();

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
  } catch {
    // ignore storage errors
  }
  return fallback;
}

function readSplitTab(): NoteSplitTab {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SPLIT_TAB_KEY) : null;
    if (raw === 'toc' || raw === 'tasks' || raw === 'links' || raw === 'graph' || raw === 'comments') return raw;
  } catch {
    // ignore
  }
  return 'toc';
}

let inboxZero = readBool(INBOX_ZERO_KEY, false);
let splitOpen = readBool(SPLIT_OPEN_KEY, false);
let splitTab: NoteSplitTab = readSplitTab();
let sourceMode = readBool(SOURCE_MODE_KEY, false);
let ligatures = readBool(LIGATURES_KEY, true);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    let changed = false;
    if (e.key === INBOX_ZERO_KEY) {
      inboxZero = readBool(INBOX_ZERO_KEY, false);
      changed = true;
    } else if (e.key === SPLIT_OPEN_KEY) {
      splitOpen = readBool(SPLIT_OPEN_KEY, false);
      changed = true;
    } else if (e.key === SPLIT_TAB_KEY) {
      splitTab = readSplitTab();
      changed = true;
    } else if (e.key === LIGATURES_KEY) {
      ligatures = readBool(LIGATURES_KEY, true);
      changed = true;
    } else if (e.key === SOURCE_MODE_KEY) {
      sourceMode = readBool(SOURCE_MODE_KEY, false);
      changed = true;
    }
    if (changed) listeners.forEach((l) => l());
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getInboxZero(): boolean {
  return inboxZero;
}

export function setInboxZero(on: boolean): void {
  if (inboxZero === on) return;
  inboxZero = on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(INBOX_ZERO_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useInboxZero(): boolean {
  return useSyncExternalStore(subscribe, () => inboxZero);
}

export function getNoteSplitOpen(): boolean {
  return splitOpen;
}

export function setNoteSplitOpen(on: boolean): void {
  if (splitOpen === on) return;
  splitOpen = on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SPLIT_OPEN_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useNoteSplitOpen(): boolean {
  return useSyncExternalStore(subscribe, () => splitOpen);
}

export function getNoteSplitTab(): NoteSplitTab {
  return splitTab;
}

export function setNoteSplitTab(tab: NoteSplitTab): void {
  if (splitTab === tab) return;
  splitTab = tab;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SPLIT_TAB_KEY, tab);
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useNoteSplitTab(): NoteSplitTab {
  return useSyncExternalStore(subscribe, () => splitTab);
}

/** Code view: notes are edited as plain Markdown without live preview (per device) */
export function setSourceMode(on: boolean): void {
  if (sourceMode === on) return;
  sourceMode = on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SOURCE_MODE_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useSourceMode(): boolean {
  return useSyncExternalStore(subscribe, () => sourceMode);
}

/** Show -> as → and similar in the editor (display only) */
export function getLigatures(): boolean {
  return ligatures;
}

export function setLigatures(on: boolean): void {
  if (ligatures === on) return;
  ligatures = on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LIGATURES_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useLigatures(): boolean {
  return useSyncExternalStore(subscribe, () => ligatures);
}

const GRAPH_DEPTH_KEY = 'kladde_local_graph_depth';

function readGraphDepth(): number {
  try {
    const n = Number(typeof localStorage !== 'undefined' ? localStorage.getItem(GRAPH_DEPTH_KEY) : null);
    if (n === 1 || n === 2 || n === 3) return n;
  } catch {
    // ignore
  }
  return 2;
}

let graphDepth = readGraphDepth();

/** Hops shown in a note's local graph, 1–3 (per device) */
export function setLocalGraphDepth(depth: number): void {
  const next = Math.max(1, Math.min(3, Math.round(depth)));
  if (graphDepth === next) return;
  graphDepth = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(GRAPH_DEPTH_KEY, String(next));
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useLocalGraphDepth(): number {
  return useSyncExternalStore(subscribe, () => graphDepth);
}

/** Font sizes the editor offers (px); 16 is the default */
export const EDITOR_FONT_SIZES = [14, 16, 18, 20, 22] as const;
export const DEFAULT_EDITOR_FONT_SIZE = 16;

function readEditorFontSize(): number {
  try {
    const n = Number(typeof localStorage !== 'undefined' ? localStorage.getItem(EDITOR_FONT_KEY) : null);
    return Number.isInteger(n) && n >= 12 && n <= 28 ? n : DEFAULT_EDITOR_FONT_SIZE;
  } catch {
    return DEFAULT_EDITOR_FONT_SIZE;
  }
}

let editorFontSize = readEditorFontSize();

/** Sets --editor-font-size on <html> (the inline script in index.html does the same before first paint) */
export function applyEditorFontSize(): void {
  if (typeof document !== 'undefined') document.documentElement.style.setProperty('--editor-font-size', `${editorFontSize}px`);
}

export function getEditorFontSize(): number {
  return editorFontSize;
}

/** Font size of the note editor in px, per device */
export function setEditorFontSize(px: number): void {
  const next = Math.min(28, Math.max(12, Math.round(px)));
  if (editorFontSize === next) return;
  editorFontSize = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(EDITOR_FONT_KEY, String(next));
  } catch {
    // ignore
  }
  applyEditorFontSize();
  listeners.forEach((l) => l());
}

export function useEditorFontSize(): number {
  return useSyncExternalStore(subscribe, () => editorFontSize);
}

/**
 * Largest width of a note (Settings → Editor), per device: `data-note-width` on <html> (CSS in index.css; the
 * inline script in index.html sets it before first paint). Focus mode keeps its own line length.
 */
export const NOTE_WIDTHS = ['narrow', 'normal', 'wide', 'fluid'] as const;
export type NoteWidth = (typeof NOTE_WIDTHS)[number];
export const DEFAULT_NOTE_WIDTH: NoteWidth = 'normal';
const NOTE_WIDTH_KEY = 'kladde_note_width';

function readNoteWidth(): NoteWidth {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(NOTE_WIDTH_KEY) : null;
    return (NOTE_WIDTHS as readonly string[]).includes(v ?? '') ? (v as NoteWidth) : DEFAULT_NOTE_WIDTH;
  } catch {
    return DEFAULT_NOTE_WIDTH;
  }
}

let noteWidth = readNoteWidth();

export function applyNoteWidth(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.noteWidth = noteWidth;
}

export function setNoteWidth(width: NoteWidth): void {
  if (noteWidth === width || !NOTE_WIDTHS.includes(width)) return;
  noteWidth = width;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(NOTE_WIDTH_KEY, width);
  } catch {
    // ignore
  }
  applyNoteWidth();
  listeners.forEach((l) => l());
}

export function useNoteWidth(): NoteWidth {
  return useSyncExternalStore(subscribe, () => noteWidth);
}

/*
 * Code blocks (Settings → Editor → Code blocks), per device. The copy button and the language label are switched by
 * attributes on <html> (`data-code-copy`, `data-code-lang`, CSS in index.css); line numbers and folding are part of
 * the editor's decorations (Editor.tsx refreshes on a change). A block can override line numbers and folding in its info string (shared/codeInfo.ts).
 */
export interface CodeBlockPrefs {
  lineNumbers: boolean;
  copy: boolean;
  language: boolean;
  /** Fold blocks longer than this many lines down to it; 0 = never */
  collapseAfter: number;
}

export const CODE_COLLAPSE_OPTIONS = [0, 10, 20, 40] as const;
/** Lines left visible when a block asks for `collapse` while the setting is off */
export const CODE_COLLAPSE_FALLBACK = 20;
const CODE_BLOCKS_KEY = 'kladde_code_blocks';
const CODE_BLOCK_DEFAULTS: CodeBlockPrefs = { lineNumbers: false, copy: true, language: true, collapseAfter: 0 };

function readCodeBlocks(): CodeBlockPrefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CODE_BLOCKS_KEY) : null;
    if (!raw) return CODE_BLOCK_DEFAULTS;
    const v = JSON.parse(raw) as Partial<Record<keyof CodeBlockPrefs, unknown>>;
    return {
      lineNumbers: typeof v.lineNumbers === 'boolean' ? v.lineNumbers : CODE_BLOCK_DEFAULTS.lineNumbers,
      copy: typeof v.copy === 'boolean' ? v.copy : CODE_BLOCK_DEFAULTS.copy,
      language: typeof v.language === 'boolean' ? v.language : CODE_BLOCK_DEFAULTS.language,
      collapseAfter: (CODE_COLLAPSE_OPTIONS as readonly unknown[]).includes(v.collapseAfter) ? (v.collapseAfter as number) : CODE_BLOCK_DEFAULTS.collapseAfter,
    };
  } catch {
    return CODE_BLOCK_DEFAULTS;
  }
}

let codeBlocks = readCodeBlocks();

function applyCodeBlocks(): void {
  if (typeof document === 'undefined') return;
  const ds = document.documentElement.dataset;
  ds.codeCopy = codeBlocks.copy ? 'on' : 'off';
  ds.codeLang = codeBlocks.language ? 'on' : 'off';
}
applyCodeBlocks();

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== CODE_BLOCKS_KEY) return;
    codeBlocks = readCodeBlocks();
    applyCodeBlocks();
    listeners.forEach((l) => l());
  });
}

export function getCodeBlockPrefs(): CodeBlockPrefs {
  return codeBlocks;
}

export function setCodeBlockPrefs(patch: Partial<CodeBlockPrefs>): void {
  const next = { ...codeBlocks, ...patch };
  if ((Object.keys(next) as (keyof CodeBlockPrefs)[]).every((k) => next[k] === codeBlocks[k])) return;
  codeBlocks = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CODE_BLOCKS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  applyCodeBlocks();
  listeners.forEach((l) => l());
}

export function useCodeBlockPrefs(): CodeBlockPrefs {
  return useSyncExternalStore(subscribe, () => codeBlocks);
}

/**
 * Pinch zoom of the whole app, per device (Settings → Editor). Off by default: a pinch scaled the page and
 * pushed the top and bottom bars out of view. `data-pinch-zoom="off"` on <html> sets `touch-action: pan-x pan-y`
 * (index.css), and WebKit's `gesturestart` is cancelled as well, since older iOS versions ignore touch-action
 * for pinches. Views with their own pinch handling (graph) use `touch-action: none` and keep working.
 * The editor font size stays the way to make text larger.
 */
const PINCH_ZOOM_KEY = 'kladde_pinch_zoom';
let pinchZoom = readBool(PINCH_ZOOM_KEY, false);

function blockGesture(e: Event): void {
  e.preventDefault();
}

export function applyPinchZoom(): void {
  if (typeof document === 'undefined') return;
  if (pinchZoom) {
    delete document.documentElement.dataset.pinchZoom;
    document.removeEventListener('gesturestart', blockGesture);
  } else {
    document.documentElement.dataset.pinchZoom = 'off';
    document.addEventListener('gesturestart', blockGesture, { passive: false });
  }
}

export function setPinchZoom(on: boolean): void {
  if (pinchZoom === on) return;
  pinchZoom = on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PINCH_ZOOM_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  applyPinchZoom();
  listeners.forEach((l) => l());
}

export function usePinchZoom(): boolean {
  return useSyncExternalStore(subscribe, () => pinchZoom);
}

/**
 * Finishing the last open subtask ticks off the task above it too (#75), per device (Settings → Work). Applied by
 * `withParents` wherever a task is ticked: the editor, the task page and the note's tasks panel.
 */
const COMPLETE_PARENTS_KEY = 'kladde_complete_parents';
let completeParentTasks = readBool(COMPLETE_PARENTS_KEY, false);

export function getCompleteParents(): boolean {
  return completeParentTasks;
}

export function setCompleteParents(on: boolean): void {
  if (completeParentTasks === on) return;
  completeParentTasks = on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(COMPLETE_PARENTS_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useCompleteParents(): boolean {
  return useSyncExternalStore(subscribe, () => completeParentTasks);
}
