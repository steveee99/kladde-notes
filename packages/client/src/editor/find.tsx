/**
 * Find and replace inside a note (#129). CodeMirror's search state (query, match highlighting, next/previous,
 * replace) with a panel of our own in the Werkbank style: Ctrl/⌘+F opens it, Ctrl/⌘+Alt+F (Ctrl+H outside macOS)
 * opens it with the replace row, F3/Ctrl/⌘+G and Shift+F3/Ctrl/⌘+Shift+G move between matches, Escape closes it.
 * Read-only notes get find without replace. `openFind` serves the command palette and the phone toolbar, which
 * reach the editor that had the focus last (`lastEditor`).
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorSelection, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, type Panel, type ViewUpdate } from '@codemirror/view';
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from '../lib/icons';
import { t } from '../lib/i18n';

/** More matches than this are shown as "1000+" */
const COUNT_LIMIT = 1000;

let lastEditor: EditorView | null = null;
/** Whether the next panel opens with the replace row */
let wantReplace = false;

/** The editor that had the focus last (or was created last), for commands from outside it */
export function lastFocusedEditor(): EditorView | null {
  return lastEditor && lastEditor.dom.isConnected ? lastEditor : null;
}

/** Opens the find bar in `view` (or the last focused editor); with `replace` also the replace row */
export function openFind(view: EditorView | null = lastFocusedEditor(), replace = false): boolean {
  if (!view) return false;
  wantReplace = replace && !view.state.readOnly;
  if (searchPanelOpen(view.state)) {
    // Already open: just show the replace row if asked and put the focus into the field
    view.dom.dispatchEvent(new CustomEvent('kladde-find-open', { detail: { replace: wantReplace } }));
    return true;
  }
  // The selection (one line, not too long) becomes the search term, like in other editors
  const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  if (sel && !sel.includes('\n') && sel.length <= 200) {
    const q = getSearchQuery(view.state);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: sel, caseSensitive: q.caseSensitive, regexp: false, wholeWord: q.wholeWord, replace: q.replace })) });
  }
  return openSearchPanel(view);
}

/** Number of matches and which one is selected (1-based, 0 when the selection is none of them) */
export function countMatches(state: EditorState, query: SearchQuery): { total: number; current: number; capped: boolean } {
  if (!query.valid || !query.search) return { total: 0, current: 0, capped: false };
  const sel = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    total++;
    if (r.value.from === sel.from && r.value.to === sel.to) current = total;
    if (total >= COUNT_LIMIT) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

function FindBar({ view, version }: { view: EditorView; version: number }) {
  const query = getSearchQuery(view.state);
  const readOnly = view.state.readOnly;
  const [replaceOpen, setReplaceOpen] = useState(() => wantReplace && !readOnly);
  const field = useRef<HTMLInputElement>(null);
  const replaceField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ replace: boolean }>).detail.replace) {
        setReplaceOpen(true);
        requestAnimationFrame(() => replaceField.current?.focus());
      } else {
        field.current?.focus();
        field.current?.select();
      }
    };
    view.dom.addEventListener('kladde-find-open', onOpen);
    return () => view.dom.removeEventListener('kladde-find-open', onOpen);
  }, [view]);

  useEffect(() => {
    if (readOnly) setReplaceOpen(false);
  }, [readOnly]);

  const set = (patch: Partial<{ search: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean; replace: string }>) => {
    const q = getSearchQuery(view.state);
    const next = new SearchQuery({ search: q.search, caseSensitive: q.caseSensitive, regexp: q.regexp, wholeWord: q.wholeWord, replace: q.replace, ...patch });
    view.dispatch({ effects: setSearchQuery.of(next) });
  };
  /** Selects the first match from the cursor on, so typing shows where the term is */
  const jumpFromCursor = () => {
    const q = getSearchQuery(view.state);
    if (!q.valid || !q.search) return;
    const from = view.state.selection.main.from;
    const cursor = q.getCursor(view.state, from);
    let r = cursor.next();
    if (r.done) r = q.getCursor(view.state).next();
    if (r.done) return;
    view.dispatch({ selection: EditorSelection.single(r.value.from, r.value.to), effects: EditorView.scrollIntoView(r.value.from, { y: 'center' }), userEvent: 'select.search' });
  };

  void version;
  const { total, current, capped } = countMatches(view.state, query);
  const invalid = !!query.search && !query.valid;
  const count = !query.search ? '' : invalid ? t('find.invalid') : total === 0 ? t('find.none') : `${current || '–'} / ${total}${capped ? '+' : ''}`;

  const onKey = (e: React.KeyboardEvent, inReplace: boolean) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (inReplace) {
        if (e.metaKey || e.ctrlKey) replaceAll(view);
        else replaceNext(view);
      } else if (e.shiftKey) findPrevious(view);
      else findNext(view);
    } else if ((e.key === 'g' || e.key === 'G') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey) findPrevious(view);
      else findNext(view);
    } else if (e.key === 'F3') {
      e.preventDefault();
      if (e.shiftKey) findPrevious(view);
      else findNext(view);
    }
  };

  const toggle = (label: string, text: string, on: boolean, flip: () => void) => (
    <button type="button" className="find-toggle" aria-pressed={on} title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={flip}>
      {text}
    </button>
  );
  const iconBtn = (label: string, Icon: typeof X, run: () => void, disabled = false) => (
    <button type="button" className="btn-icon h-8 w-8 shrink-0" title={label} aria-label={label} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      <Icon size={18} />
    </button>
  );

  return (
    <div className="find-bar" role="search" aria-label={t('find.label')}>
      <div className="flex flex-wrap items-center gap-1">
        {!readOnly
          ? iconBtn(replaceOpen ? t('find.hideReplace') : t('find.showReplace'), replaceOpen ? ChevronDown : ChevronRight, () => setReplaceOpen((v) => !v))
          : null}
        <div className="relative min-w-[9rem] flex-1">
          <input
            ref={field}
            className={`input h-8 w-full pr-20 text-body-m ${invalid ? 'border-red' : ''}`}
            type="text"
            role="searchbox"
            enterKeyHint="search"
            aria-label={t('find.searchLabel')}
            placeholder={t('find.placeholder')}
            value={query.search}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              set({ search: e.target.value });
              jumpFromCursor();
            }}
            onKeyDown={(e) => onKey(e, false)}
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-caption text-muted" aria-live="polite">
            {count}
          </span>
        </div>
        {/* On phones the options take their own line below the field */}
        <div className="flex shrink-0 items-center gap-0.5 phone:order-last phone:w-full phone:pl-9">
          {toggle(t('find.matchCase'), 'Aa', query.caseSensitive, () => set({ caseSensitive: !query.caseSensitive }))}
          {toggle(t('find.wholeWord'), 'W', query.wholeWord, () => set({ wholeWord: !query.wholeWord }))}
          {toggle(t('find.regexp'), '.*', query.regexp, () => set({ regexp: !query.regexp }))}
        </div>
        {iconBtn(t('find.previous'), ArrowUp, () => findPrevious(view), total === 0)}
        {iconBtn(t('find.next'), ArrowDown, () => findNext(view), total === 0)}
        {iconBtn(t('find.close'), X, () => {
          closeSearchPanel(view);
          view.focus();
        })}
      </div>
      {replaceOpen && !readOnly && (
        <div className="mt-1 flex items-center gap-1 pl-9">
          <input
            ref={replaceField}
            className="input h-8 min-w-0 flex-1 text-body-m"
            type="text"
            aria-label={t('find.replaceLabel')}
            placeholder={t('find.replacePlaceholder')}
            value={query.replace}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set({ replace: e.target.value })}
            onKeyDown={(e) => onKey(e, true)}
          />
          <button type="button" className="btn-outlined h-8 shrink-0 px-2.5 text-caption" disabled={total === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => replaceNext(view)}>
            {t('find.replace')}
          </button>
          <button type="button" className="btn-outlined h-8 shrink-0 px-2.5 text-caption" disabled={total === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => replaceAll(view)}>
            {t('find.replaceAll')}
          </button>
        </div>
      )}
    </div>
  );
}

function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-find-panel';
  let root: Root | null = createRoot(dom);
  let version = 0;
  const render = () => root?.render(<FindBar view={view} version={version} />);
  return {
    dom,
    top: true,
    mount: render,
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery))) || u.startState.readOnly !== u.state.readOnly) {
        version++;
        render();
      }
    },
    destroy() {
      const r = root;
      root = null;
      // Unmounting while CodeMirror updates its panels would warn about a synchronous unmount during render
      queueMicrotask(() => r?.unmount());
    },
  };
}

const next = (v: EditorView) => (searchPanelOpen(v.state) ? findNext(v) : false);
const previous = (v: EditorView) => (searchPanelOpen(v.state) ? findPrevious(v) : false);
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The editor extension: search state, our panel, the keys and the "last focused editor" bookkeeping */
export function findExtension(): Extension {
  return [
    search({ top: true, createPanel: createFindPanel, scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: 'center' }) }),
    keymap.of([
      { key: 'Mod-f', run: (v) => openFind(v, false), preventDefault: true },
      { key: 'Mod-Alt-f', run: (v) => openFind(v, true), preventDefault: true },
      ...(IS_MAC ? [] : [{ key: 'Ctrl-h', run: (v: EditorView) => openFind(v, true), preventDefault: true }]),
      { key: 'F3', run: next, shift: previous, preventDefault: true },
      { key: 'Mod-g', run: next, shift: previous, preventDefault: true },
      { key: 'Escape', run: (v) => (searchPanelOpen(v.state) ? closeSearchPanel(v) : false) },
    ]),
    EditorView.domEventHandlers({
      focus: (_e, v) => {
        lastEditor = v;
      },
    }),
    EditorView.updateListener.of((u) => {
      if (!lastEditor || !lastEditor.dom.isConnected) lastEditor = u.view;
    }),
  ];
}
