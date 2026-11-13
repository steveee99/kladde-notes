import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Extension, Prec, Transaction } from '@codemirror/state';
import { EditorView, KeyBinding, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand, markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { livePreview, noteIdFacet, previewAll, refreshEffect } from './livePreview';
import { statusTaskList } from './taskStatus';
import { useLigatures } from '../lib/prefs';
import { sourceHighlight } from './sourceHighlight';
import { editorHost } from './host';
import { merge3, textChanges } from '@kladde/shared';
import { slashCompletion } from './slash';
import { remoteCursors } from './remoteCursors';
import { useReadOnly } from '../lib/readOnly';
import { t as i18n, useLang } from '../lib/i18n';

/** Read-only notes show everything rendered and accept no input */
const readOnlyExtensions = (on: boolean): Extension => [previewAll.of(on), EditorState.readOnly.of(on), EditorView.editable.of(!on)];

/** Code view: raw Markdown in a monospace font with syntax highlighting instead of the live preview */
const sourceTheme = [
  EditorView.editorAttributes.of({ class: 'cm-source' }),
  EditorView.theme({
    // "&.cm-editor" beats the prose theme's ".cm-scroller" rule regardless of mount order
    '&.cm-editor .cm-scroller': {
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: '0.92em',
      lineHeight: '1.65',
    },
  }),
];

/** CodeMirror's base theme sets a monospace font with high specificity; prose uses Material's Roboto Flex sans variable */
const proseTheme = EditorView.theme({
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.7' },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: 'rgb(var(--accent))' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'rgb(var(--accent2))' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'rgb(var(--warn))' },
  { tag: [t.comment, t.meta], color: 'rgb(var(--faint))', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'rgb(var(--ok))' },
  { tag: [t.typeName, t.className, t.tagName], color: 'rgb(var(--danger))' },
  { tag: [t.propertyName, t.attributeName], color: 'rgb(var(--ink))' },
  { tag: t.processingInstruction, color: 'rgb(var(--faint))' },
  { tag: t.url, color: 'rgb(var(--muted))' },
]);

const sourceCodeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: 'rgb(var(--accent))' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'rgb(var(--accent2))' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'rgb(var(--warn))' },
  { tag: [t.comment, t.meta], color: 'rgb(var(--faint))', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'rgb(var(--ok))' },
  { tag: [t.typeName, t.className, t.tagName], color: 'rgb(var(--danger))' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'rgb(var(--on-accent-container))' },
  { tag: t.attributeName, color: 'rgb(var(--warn))' },
  { tag: t.attributeValue, color: 'rgb(var(--ok))' },
  { tag: [t.operator, t.punctuation], color: 'rgb(var(--muted))' },
  { tag: [t.escape, t.character], color: 'rgb(var(--warn))' },
  { tag: [t.angleBracket, t.processingInstruction], color: 'rgb(var(--faint))' },
  { tag: t.url, color: 'rgb(var(--accent2))' },
]);

const previewExtensions = (source: boolean): Extension =>
  source ? [sourceTheme, syntaxHighlighting(sourceCodeHighlight), sourceHighlight()] : [syntaxHighlighting(highlight), livePreview()];

/** [[ opens a list of note titles */
function wikiCompletion(ctx: CompletionContext) {
  const m = ctx.matchBefore(/\[\[[^\]\n]*/);
  if (!m) return null;
  return {
    from: m.from + 2,
    options: editorHost.noteTitles().map((title) => ({ label: title, apply: `${title}]]` })),
    validFor: /^[^\]\n]*$/,
  };
}

/** Pasted or dropped images and PDFs are uploaded and linked */
function insertFiles(view: EditorView, files: File[], pos: number) {
  for (const file of files) {
    const marker = `![${i18n('editor.uploading', { name: file.name })}]()`;
    view.dispatch({ changes: { from: pos, insert: marker } });
    editorHost
      .upload(file)
      .then((r) => replaceMarker(view, marker, `![${r.name}](${r.url})`))
      .catch((err) => replaceMarker(view, marker, `<!-- ${i18n('editor.uploadFailed', { error: err.message })} -->`));
  }
}

/**
 * The text the source attached to a copied link: browsers put `<a href="url">Page title</a>` next to the
 * plain URL (address bar "friendly links", "copy link" on a page). null when there is no such text.
 */
export function linkTitleFromHtml(html: string, url: string): string | null {
  if (!html) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = [...doc.querySelectorAll('a[href]')];
  if (anchors.length !== 1) return null;
  const href = anchors[0].getAttribute('href') ?? '';
  const same = (a: string, b: string) => a.replace(/\/$/, '') === b.replace(/\/$/, '');
  if (!same(href, url)) return null;
  const title = (anchors[0].textContent ?? '').replace(/\s+/g, ' ').trim();
  return title && !same(title, url) ? title : null;
}

const URL_ONLY = /^https?:\/\/[^\s<>]+$/i;

/** A pasted URL becomes [title](url): with the copied link text, or around the selected text */
function pasteLink(e: ClipboardEvent, view: EditorView): boolean {
  const url = e.clipboardData?.getData('text/plain').trim() ?? '';
  if (!URL_ONLY.test(url)) return false;
  const { from, to } = view.state.selection.main;
  // Code stays verbatim
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(from, -1); node; node = node.parent) {
    if (/Code|URL|Link|Image/.test(node.name)) return false;
  }
  const selected = view.state.sliceDoc(from, to);
  const raw = selected && !selected.includes('\n') && !URL_ONLY.test(selected.trim()) ? selected : linkTitleFromHtml(e.clipboardData?.getData('text/html') ?? '', url);
  // Characters that would break the link text are dropped, not escaped: "\[" would show up in other Markdown apps
  const label = raw?.replace(/[[\]\\]/g, '').replace(/\s+/g, ' ').trim();
  if (!label) return false;
  const insert = `[${label}](${url})`;
  e.preventDefault();
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.paste', scrollIntoView: true });
  return true;
}

function fileHandlers() {
  return EditorView.domEventHandlers({
    paste(e, view) {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => /^(image\/|application\/pdf)/.test(f.type));
      if (!files.length) return pasteLink(e, view);
      e.preventDefault();
      insertFiles(view, files, view.state.selection.main.head);
      return true;
    },
    drop(e, view) {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /^(image\/|application\/pdf)/.test(f.type));
      if (!files.length) return false;
      e.preventDefault();
      insertFiles(view, files, view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.doc.length);
      return true;
    },
  });
}

function replaceMarker(view: EditorView, marker: string, text: string) {
  const at = view.state.doc.toString().indexOf(marker);
  if (at >= 0) view.dispatch({ changes: { from: at, to: at + marker.length, insert: text } });
}

/**
 * Formatting & save shortcuts. Mod is Strg, on macOS ⌘; on macOS Strg works as well.
 * Ctrl/⌘+S flushes pending changes immediately and dispatches the global sync shortcut.
 */
const formatCommands: [string, (v: EditorView) => boolean][] = [
  ['b', (v) => toggleWrap(v, '**')],
  ['i', (v) => toggleWrap(v, '*')],
  ['Shift-m', (v) => toggleCode(v)],
  ['Shift-x', (v) => toggleWrap(v, '~~')],
  ['Shift-l', (v) => (wrapSelection(v, '[[', ']]'), true)],
];
const saveAction = () => {
  editorHost.flush();
  editorHost.requestSave();
  return true;
};
/**
 * Markdown's Enter/Backspace. Enter on an empty item ends the list; CodeMirror's default instead turns a
 * two-item list into a loose one there (empty line, then a new item), which looked like Enter adding a blank line.
 */
const markdownKeys = Prec.high(
  keymap.of([
    { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
    { key: 'Backspace', run: deleteMarkupBackward },
  ])
);

const formatKeymap: KeyBinding[] = [
  ...formatCommands.flatMap(([key, run]) => [
    { key: `Mod-${key}`, run, preventDefault: true },
    { mac: `Ctrl-${key}`, run, preventDefault: true },
  ]),
  { key: 'Mod-s', run: saveAction, preventDefault: true },
  { mac: 'Ctrl-s', run: saveAction, preventDefault: true },
];

export interface EditorProps {
  docKey: string;
  value: string;
  readOnly?: boolean;
  /** Changes when other notes change: queries and link targets are re-rendered */
  stamp?: number;
  onChange?: (value: string) => void;
  onView?: (view: EditorView | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Code view: raw Markdown without live preview */
  source?: boolean;
  /** Synced note: shows the cursors of the other devices/tabs on it and reports this one's */
  presenceNote?: string;
}

export function Editor({ docKey, value, readOnly = false, stamp = 0, onChange, onView, placeholder, autoFocus, source = false, presenceNote }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const lockedEverywhere = useReadOnly();
  const locked = readOnly || lockedEverywhere;
  const lang = useLang();
  const ligatures = useLigatures();
  const lockConf = useRef(new Compartment());
  const placeholderConf = useRef(new Compartment());
  const previewConf = useRef(new Compartment());
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const resolvedPlaceholder = placeholder ?? i18n('editor.placeholder');
  /** The text the vault last had (from `value` or our own flush): the base for merging in changes from elsewhere */
  const synced = useRef(value);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!view.current) return;
      const doc = view.current.state.doc.toString();
      synced.current = doc;
      changeRef.current?.(doc);
    };
    const unregisterFlush = editorHost.registerFlush(flush);
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...formatKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdownKeys,
          markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [statusTaskList], addKeymap: false }),
          proseTheme,
          EditorView.lineWrapping,
          noteIdFacet.of(docKey),
          previewConf.current.of(previewExtensions(sourceRef.current)),
          lockConf.current.of(readOnlyExtensions(lockedRef.current)),
          EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences' }),
          placeholderConf.current.of(cmPlaceholder(resolvedPlaceholder)),
          autocompletion({ override: [wikiCompletion, slashCompletion(insertFiles)], icons: false }),
          fileHandlers(),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(flush, 350);
          }),
          EditorView.domEventHandlers({ blur: () => flush() }),
          presenceNote ? remoteCursors(presenceNote) : [],
        ],
      }),
    });
    view.current = v;
    synced.current = value;
    onView?.(v);
    if (autoFocus) {
      v.focus();
      v.dispatch({ selection: { anchor: v.state.doc.length } });
    }
    return () => {
      unregisterFlush();
      flush();
      onView?.(null);
      v.destroy();
      view.current = null;
    };
    // A new editor per note; `value` updates are handled below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // The read-only switch changes without rebuilding the editor (undo history and scroll stay)
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.readOnly === locked) return;
    if (locked) v.contentDOM.blur();
    v.dispatch({ effects: lockConf.current.reconfigure(readOnlyExtensions(locked)) });
  }, [locked]);

  // Code view on/off without rebuilding the editor (undo history and cursor stay)
  useEffect(() => {
    view.current?.dispatch({ effects: previewConf.current.reconfigure(previewExtensions(source)) });
  }, [source]);

  // Reconfigure placeholder cleanly when language or custom placeholder changes
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: placeholderConf.current.reconfigure(cmPlaceholder(resolvedPlaceholder)) });
  }, [resolvedPlaceholder]);

  // Changes from sync (another device or person) while the note is open: merged with what was typed here
  // since the last flush, applied as small changes so the cursor, selection and undo history stay
  useEffect(() => {
    const v = view.current;
    const base = synced.current;
    synced.current = value;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === value) return;
    const next = current === base ? value : merge3(base, current, value).text;
    if (next === current) return;
    v.dispatch({
      changes: textChanges(current, next),
      annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: refreshEffect.of(stamp + (lang === 'en' ? 1_000_000 : 0) + (ligatures ? 0 : 2_000_000)) });
  }, [stamp, lang, ligatures]);

  return <div ref={host} className="wz-editor" />;
}

// ------------------------------------------------------------------ toolbar actions (mobile bar)

export function insertAtLineStart(view: EditorView, prefix: string) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const existing = /^(\s*)(#{1,6}\s|[-*+]\s\[[ xXoOhH]\]\s|[-*+]\s|>\s|\d+\.\s)?/.exec(line.text)!;
  const from = line.from + existing[1].length;
  const to = from + (existing[2]?.length ?? 0);
  const insert = existing[2] === prefix ? '' : prefix;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: line.to + insert.length - (to - from) } });
  view.focus();
}

export function wrapSelection(view: EditorView, before: string, after = before) {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: [
      { from, insert: before },
      { from: to, insert: after },
    ],
    selection: { anchor: from + before.length, head: to + before.length },
  });
  view.focus();
}

export function insertText(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view.focus();
}

/**
 * Wraps the selection in a marker, or removes it when the selection is already wrapped
 * (markers inside or right around the selection). An empty selection gets an empty pair.
 */
export function toggleWrap(view: EditorView, marker: string): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const n = marker.length;
  const text = doc.sliceString(from, to);
  const isWrapped = (s: string) => s.length >= 2 * n && s.startsWith(marker) && s.endsWith(marker) && (marker !== '*' || !s.startsWith('**') || s.startsWith('***'));
  if (isWrapped(text)) {
    view.dispatch({ changes: { from, to, insert: text.slice(n, -n) }, selection: { anchor: from, head: to - 2 * n } });
  } else if (from >= n && doc.sliceString(from - n, from) === marker && doc.sliceString(to, to + n) === marker && !(marker === '*' && doc.sliceString(from - 2, from) === '**' && doc.sliceString(to, to + 2) === '**' && doc.sliceString(from - 3, from) !== '***')) {
    view.dispatch({
      changes: [
        { from: from - n, to: from, insert: '' },
        { from: to, to: to + n, insert: '' },
      ],
      selection: { anchor: from - n, head: to - n },
    });
  } else {
    wrapSelection(view, marker);
    return true;
  }
  view.focus();
  return true;
}

/** Inline code for a selection within one line, a fenced block for several lines */
export function toggleCode(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  if (doc.lineAt(from).number === doc.lineAt(to).number) return toggleWrap(view, '`');
  const start = doc.lineAt(from).from;
  const end = doc.lineAt(to).to;
  const body = doc.sliceString(start, end);
  const fenced = /^```[^\n]*\n([\s\S]*)\n```$/.exec(body);
  const insert = fenced ? fenced[1] : `\`\`\`\n${body}\n\`\`\``;
  view.dispatch({ changes: { from: start, to: end, insert }, selection: { anchor: start, head: start + insert.length } });
  view.focus();
  return true;
}
