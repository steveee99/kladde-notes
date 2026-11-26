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
import { commentHighlights } from './comments';
import { calloutsFacet, hidePropertiesFacet, livePreview, noteIdFacet, previewAll, refreshEffect, slideBreakLabel } from './livePreview';
import { configureEmbeds } from './embed';
import { embedResolverFacet, foreignFacet, type EmbedResolver } from './embedContext';
import { statusTaskList } from './taskStatus';
import { useCodeBlockPrefs, useLigatures } from '../lib/prefs';
import { sourceHighlight } from './sourceHighlight';
import { editorHost } from './host';
import { merge3, tagBeforeCursor, textChanges } from '@kladde/shared';
import { slashCompletion } from './slash';
import { remoteCursors } from './remoteCursors';
import { focusDim } from './focusDim';
import { releaseFacet } from './releases';
import { inlineVariables, templateTokenCompletion, templateTokensFacet, variableCompletion, variablesFacet, type TemplateToken } from './variables';
import type { NoteReleaseInfo, VariableScope } from '@kladde/shared';
import { outlineSupport } from './outline';
import { findExtension } from './find';
import { useReadOnly } from '../lib/readOnly';
import { t as i18n, useLang } from '../lib/i18n';

/** The placeholder and the name screen readers announce for the text field (follows the language) */
const placeholderAndLabel = (text: string): Extension => [cmPlaceholder(text), EditorView.contentAttributes.of({ 'aria-label': i18n('editor.ariaLabel') })];

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

/*
 * Syntax colors of fenced code: the --syn-* tokens in index.css, set per code theme (lib/codeTheme.ts). The source
 * view adds Markdown punctuation and URLs on top.
 */
const syntaxRules = [
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'rgb(var(--syn-keyword))' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'rgb(var(--syn-string))' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'rgb(var(--syn-number))' },
  { tag: [t.comment, t.meta], color: 'rgb(var(--syn-comment))', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: 'rgb(var(--syn-function))' },
  { tag: [t.typeName, t.className, t.namespace], color: 'rgb(var(--syn-type))' },
  { tag: t.tagName, color: 'rgb(var(--syn-tag))' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'rgb(var(--syn-property))' },
  { tag: t.attributeName, color: 'rgb(var(--syn-attr))' },
  { tag: t.attributeValue, color: 'rgb(var(--syn-string))' },
  { tag: [t.operator, t.derefOperator], color: 'rgb(var(--syn-operator))' },
  { tag: [t.escape, t.character], color: 'rgb(var(--syn-escape))' },
];

const highlight = HighlightStyle.define([
  ...syntaxRules,
  { tag: t.punctuation, color: 'rgb(var(--syn-punct))' },
  // Markdown marks in prose stay in the interface colors
  { tag: t.processingInstruction, color: 'rgb(var(--outline))' },
  { tag: t.url, color: 'rgb(var(--on-surface-variant))' },
]);

const sourceCodeHighlight = HighlightStyle.define([
  ...syntaxRules,
  { tag: t.punctuation, color: 'rgb(var(--on-surface-variant))' },
  { tag: [t.angleBracket, t.processingInstruction], color: 'rgb(var(--outline))' },
  { tag: t.url, color: 'rgb(var(--syn-link))' },
]);

const previewExtensions = (source: boolean): Extension =>
  source ? [sourceTheme, syntaxHighlighting(sourceCodeHighlight), sourceHighlight()] : [syntaxHighlighting(highlight), livePreview()];

// The read-only editor inside an embed renders like a read-only note
configureEmbeds((noteId) => [
  markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [statusTaskList], addKeymap: false }),
  proseTheme,
  EditorView.lineWrapping,
  syntaxHighlighting(highlight),
  livePreview(),
  noteIdFacet.of(noteId),
  readOnlyExtensions(true),
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

/** `#` followed by a letter opens a list of known tags (most used first); nested tags complete as a whole */
function tagCompletion(ctx: CompletionContext) {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const typed = tagBeforeCursor(line.text.slice(0, ctx.pos - line.from));
  // A lone `#` starts a heading as often as a tag: only an explicit request (Ctrl+Space) lists all tags then
  if (!typed || (!typed.query && !ctx.explicit)) return null;
  const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
  for (let n: SyntaxNode | null = node; n; n = n.parent) if (/Code|URL|Link|Comment/.test(n.name)) return null;
  const options = editorHost
    .tags()
    .filter((x) => x.tag !== typed.query)
    .map((x) => ({ label: x.tag, detail: String(x.count), apply: x.tag }));
  if (!options.length) return null;
  return { from: line.from + typed.from + 1, options, validFor: /^[\p{L}\p{N}_/-]*$/u };
}

/** `@` opens the people who can see the note (#69) */
function mentionCompletion(ctx: CompletionContext) {
  const m = ctx.matchBefore(/(?<![\p{L}\p{N}_@./\\-])@[A-Za-z0-9_.-]{0,20}/u);
  if (!m) return null;
  const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
  for (let n: SyntaxNode | null = node; n; n = n.parent) if (/Code|URL|Link|Comment/.test(n.name)) return null;
  const people = editorHost.people(ctx.state.facet(noteIdFacet));
  if (!people.length) return null;
  return {
    from: m.from + 1,
    options: people.map((p) => ({ label: p.username, apply: `${p.username} `, type: 'mention' })),
    validFor: /^[A-Za-z0-9_.-]*$/,
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
      if (view.state.readOnly) return false;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => /^(image\/|application\/pdf)/.test(f.type));
      if (!files.length) return pasteLink(e, view);
      e.preventDefault();
      insertFiles(view, files, view.state.selection.main.head);
      return true;
    },
    drop(e, view) {
      if (view.state.readOnly) {
        // Nothing is inserted, and the browser must not open the file instead of the note
        e.preventDefault();
        return true;
      }
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /^(image\/|application\/pdf|audio\/)/.test(f.type));
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
  /** Resolves `![[embeds]]` instead of the app's notes (public links) */
  resolveEmbed?: EmbedResolver;
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
  /** Focus mode: fade every paragraph but the one with the cursor */
  dim?: boolean;
  /** Called after the text or the selection changed (e.g. for the word count) */
  onActivity?: (view: EditorView) => void;
  /** Release versioning (#53) is on: the releases fill the placeholders ({{version}}, ```versions, …); null/undefined: off */
  releases?: NoteReleaseInfo[] | null;
  /** The variables of the note's folder (`{{var:name}}`); without them the placeholders show as written */
  variables?: VariableScope | null;
  /** Presentation mode (#87) is on: rules show as slide breaks with this label (`{n}`: slide number) */
  slideBreaks?: string;
  /** Callouts (#86): `> [!type]` quotes as callouts (default) or, with the feature off, as plain quotes */
  callouts?: boolean;
  /** Hide the frontmatter row in the live preview (the note shows its fields above the text, e.g. tickets) */
  hideProperties?: boolean;
  /** The text comes from outside the vault (remote notes): nothing in it is looked up in the reader's notes */
  foreign?: boolean;
  /** Template editor: placeholders besides variables that `{{` offers (read when the editor is created) */
  templateTokens?: readonly TemplateToken[];
}

export function Editor({ docKey, value, readOnly = false, stamp = 0, onChange, onView, placeholder, autoFocus, source = false, presenceNote, dim = false, onActivity, resolveEmbed, releases = null, variables = null, slideBreaks = '', callouts = true, hideProperties = false, foreign = false, templateTokens }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;
  const lockedEverywhere = useReadOnly();
  const locked = readOnly || lockedEverywhere;
  const lang = useLang();
  const ligatures = useLigatures();
  // Line numbers and folding of code blocks are part of the decorations; copy button and language work through CSS
  const codePrefs = useCodeBlockPrefs();
  const codeStamp = codePrefs.collapseAfter * 10_000_000 + (codePrefs.lineNumbers ? 500_000_000 : 0);
  const lockConf = useRef(new Compartment());
  const placeholderConf = useRef(new Compartment());
  const previewConf = useRef(new Compartment());
  const dimConf = useRef(new Compartment());
  const releaseConf = useRef(new Compartment());
  const slideConf = useRef(new Compartment());
  const slideRef = useRef(slideBreaks);
  slideRef.current = slideBreaks;
  const calloutConf = useRef(new Compartment());
  const calloutRef = useRef(callouts);
  calloutRef.current = callouts;
  const hidePropsConf = useRef(new Compartment());
  const hidePropsRef = useRef(hideProperties);
  hidePropsRef.current = hideProperties;
  const releasesRef = useRef(releases);
  releasesRef.current = releases;
  const variableConf = useRef(new Compartment());
  const variablesRef = useRef(variables);
  variablesRef.current = variables;
  const releaseKey = releases ? JSON.stringify(releases) : '';
  const dimRef = useRef(dim);
  dimRef.current = dim;
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
          placeholderConf.current.of(placeholderAndLabel(resolvedPlaceholder)),
          autocompletion({ override: [wikiCompletion, templateTokenCompletion, variableCompletion, tagCompletion, mentionCompletion, slashCompletion(insertFiles)], icons: false }),
          fileHandlers(),
          dimConf.current.of(dimRef.current ? focusDim : []),
          releaseConf.current.of(releaseFacet.of(releasesRef.current ? { releases: releasesRef.current } : null)),
          variableConf.current.of(variablesFacet.of(variablesRef.current)),
          inlineVariables,
          outlineSupport,
          findExtension(),
          slideConf.current.of(slideBreakLabel.of(slideRef.current)),
          calloutConf.current.of(calloutsFacet.of(calloutRef.current)),
          hidePropsConf.current.of(hidePropertiesFacet.of(hidePropsRef.current)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged || u.selectionSet) activityRef.current?.(u.view);
            if (!u.docChanged) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(flush, 350);
          }),
          EditorView.domEventHandlers({ blur: () => flush() }),
          presenceNote ? remoteCursors(presenceNote) : [],
          commentHighlights,
          resolveEmbed ? embedResolverFacet.of(resolveEmbed) : [],
          foreign ? foreignFacet.of(true) : [],
          templateTokens?.length ? templateTokensFacet.of(templateTokens) : [],
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

  // Slide breaks on/off (presentation feature) without rebuilding the editor
  const firstSlides = useRef(true);
  useEffect(() => {
    if (firstSlides.current) {
      firstSlides.current = false;
      return;
    }
    view.current?.dispatch({ effects: [slideConf.current.reconfigure(slideBreakLabel.of(slideBreaks)), refreshEffect.of(Date.now())] });
  }, [slideBreaks]);

  // Callouts on/off (feature) without rebuilding the editor
  const firstCallouts = useRef(true);
  useEffect(() => {
    if (firstCallouts.current) {
      firstCallouts.current = false;
      return;
    }
    view.current?.dispatch({ effects: [calloutConf.current.reconfigure(calloutsFacet.of(callouts)), refreshEffect.of(Date.now())] });
  }, [callouts]);

  // Frontmatter row hidden or shown (a note became a ticket) without rebuilding the editor
  const firstHideProps = useRef(true);
  useEffect(() => {
    if (firstHideProps.current) {
      firstHideProps.current = false;
      return;
    }
    view.current?.dispatch({ effects: [hidePropsConf.current.reconfigure(hidePropertiesFacet.of(hideProperties)), refreshEffect.of(Date.now())] });
  }, [hideProperties]);

  // Dimming on/off without rebuilding the editor
  useEffect(() => {
    view.current?.dispatch({ effects: dimConf.current.reconfigure(dim ? focusDim : []) });
  }, [dim]);

  // New releases (or versioning turned on/off): the placeholders are drawn again
  const firstRelease = useRef(true);
  useEffect(() => {
    if (firstRelease.current) {
      firstRelease.current = false;
      return;
    }
    view.current?.dispatch({
      effects: [releaseConf.current.reconfigure(releaseFacet.of(releasesRef.current ? { releases: releasesRef.current } : null)), refreshEffect.of(Date.now())],
    });
  }, [releaseKey]);

  // A variable changed or the note moved: the values are drawn again
  const firstVariables = useRef(true);
  useEffect(() => {
    if (firstVariables.current) {
      firstVariables.current = false;
      return;
    }
    view.current?.dispatch({ effects: [variableConf.current.reconfigure(variablesFacet.of(variables)), refreshEffect.of(Date.now())] });
  }, [variables]);

  // Reconfigure placeholder cleanly when language or custom placeholder changes
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: placeholderConf.current.reconfigure(placeholderAndLabel(resolvedPlaceholder)) });
  }, [resolvedPlaceholder, lang]);

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
    view.current?.dispatch({ effects: refreshEffect.of(stamp + (lang === 'en' ? 1_000_000 : 0) + (ligatures ? 0 : 2_000_000) + codeStamp) });
  }, [stamp, lang, ligatures, codeStamp]);

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
