import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Extension } from '@codemirror/state';
import { EditorView, KeyBinding, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { livePreview, previewAll, refreshEffect } from './livePreview';
import { editorHost } from './host';
import { useReadOnly } from '../lib/readOnly';

/** Read-only notes show everything rendered and accept no input */
const readOnlyExtensions = (on: boolean): Extension => [previewAll.of(on), EditorState.readOnly.of(on), EditorView.editable.of(!on)];

/** CodeMirror's base theme sets a monospace font with high specificity; prose uses the UI font */
const proseTheme = EditorView.theme({
  '.cm-scroller': { fontFamily: 'Inter, system-ui, -apple-system, sans-serif', lineHeight: '1.7' },
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
function fileHandlers() {
  const insertFiles = (view: EditorView, files: File[], pos: number) => {
    for (const file of files) {
      const marker = `![Lade ${file.name} …]()`;
      view.dispatch({ changes: { from: pos, insert: marker } });
      editorHost
        .upload(file)
        .then((r) => replaceMarker(view, marker, `![${r.name}](${r.url})`))
        .catch((err) => replaceMarker(view, marker, `<!-- Upload fehlgeschlagen: ${err.message} -->`));
    }
  };
  return EditorView.domEventHandlers({
    paste(e, view) {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => /^(image\/|application\/pdf)/.test(f.type));
      if (!files.length) return false;
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
 * Formatting shortcuts. Mod is Strg, on macOS ⌘; on macOS Strg works as well (it replaces the Emacs-style
 * cursor keys there). Strg/⌘+K for search is global (Shell).
 */
const formatCommands: [string, (v: EditorView) => boolean][] = [
  ['b', (v) => toggleWrap(v, '**')],
  ['i', (v) => toggleWrap(v, '*')],
  ['Shift-m', (v) => toggleCode(v)],
  ['Shift-x', (v) => toggleWrap(v, '~~')],
  ['Shift-l', (v) => (wrapSelection(v, '[[', ']]'), true)],
];
const formatKeymap: KeyBinding[] = formatCommands.flatMap(([key, run]) => [
  { key: `Mod-${key}`, run, preventDefault: true },
  { mac: `Ctrl-${key}`, run, preventDefault: true },
]);

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
}

export function Editor({ docKey, value, readOnly = false, stamp = 0, onChange, onView, placeholder, autoFocus }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const lockedEverywhere = useReadOnly();
  const locked = readOnly || lockedEverywhere;
  const lockConf = useRef(new Compartment());
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (view.current) changeRef.current?.(view.current.state.doc.toString());
    };
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...formatKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(highlight),
          proseTheme,
          EditorView.lineWrapping,
          livePreview(),
          lockConf.current.of(readOnlyExtensions(lockedRef.current)),
          EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences' }),
          cmPlaceholder(placeholder ?? 'Schreib los …'),
          autocompletion({ override: [wikiCompletion], icons: false }),
          fileHandlers(),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(flush, 350);
          }),
          EditorView.domEventHandlers({ blur: () => flush() }),
        ],
      }),
    });
    view.current = v;
    onView?.(v);
    if (autoFocus) {
      v.focus();
      v.dispatch({ selection: { anchor: v.state.doc.length } });
    }
    return () => {
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

  // Changes from sync (another device) while the note is open
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === value) return;
    const head = Math.min(v.state.selection.main.head, value.length);
    v.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor: head } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: refreshEffect.of(stamp) });
  }, [stamp]);

  return <div ref={host} className="wz-editor" />;
}

// ------------------------------------------------------------------ toolbar actions (mobile bar)

export function insertAtLineStart(view: EditorView, prefix: string) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const existing = /^(\s*)(#{1,6}\s|[-*+]\s\[[ xX]\]\s|[-*+]\s|>\s|\d+\.\s)?/.exec(line.text)!;
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
