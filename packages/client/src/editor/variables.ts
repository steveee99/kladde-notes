import { EditorState, Facet, Transaction, type TransactionSpec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { EditorView, WidgetType } from '@codemirror/view';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { SyntaxNode } from '@lezer/common';
import { BUILTIN_VARIABLES, findInlineVariables, hasInlineVariables, isFilled, isUrlValue, maskVariables, resolveVariables, safeUrl, splitMasked, variableKey, type ResolvedVariable, type VariableScope } from '@kladde/shared';
import { folderDisplayName, getLang, tl, type Lang } from '../lib/i18n';

/*
 * Variables in the editor: `{{var:name}}` shows its value, the text keeps the placeholder (raw while the cursor is in
 * it). Values come from other people's notes, so they only ever become text nodes, and URLs go through `safeUrl`.
 */

/** null: no variables here, the placeholders stay as they are written */
export const variablesFacet = Facet.define<VariableScope | null, VariableScope | null>({ combine: (v) => v.find((x) => x !== null) ?? null });

/** Tooltip: the name and the folder the value comes from, or why there is none */
function variableTitle(r: ResolvedVariable, lang: Lang): string {
  if (r.status === 'cycle') return tl(lang, 'vars.cycle', { name: r.name });
  if (r.status === 'limit') return tl(lang, 'vars.limit', { name: r.name });
  if (r.status === 'unknown') return tl(lang, 'vars.unknown', { name: r.name });
  if (!r.entry) return tl(lang, 'vars.fallback', { name: r.name });
  if (r.entry.builtin) return tl(lang, 'vars.builtinOrigin', { name: r.name });
  // Public links send no folders
  const folder = r.entry.folder ? folderDisplayName(r.entry.folder, lang) : tl(lang, 'common.topLevelPlain');
  return tl(lang, 'vars.origin', { name: r.name, folder });
}

/** A filled-in placeholder as an element (editor text and table cells) */
export function variableElement(r: ResolvedVariable, lang: Lang = getLang()): HTMLElement {
  const href = isFilled(r) && isUrlValue(r.text) ? safeUrl(r.text) : null;
  const el = document.createElement(href ? 'a' : 'span');
  el.className = `cm-variable${isFilled(r) ? '' : ' cm-variable-unknown'}${href ? ' cm-link' : ''}`;
  // An empty value keeps a place for the tooltip
  el.textContent = r.text || '​';
  el.title = variableTitle(r, lang);
  if (href) {
    const a = el as HTMLAnchorElement;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.addEventListener('mousedown', (e) => e.preventDefault());
  }
  return el;
}

export class VariableWidget extends WidgetType {
  constructor(
    readonly r: ResolvedVariable,
    readonly lang: Lang
  ) {
    super();
  }
  eq(o: VariableWidget) {
    return o.r.name === this.r.name && o.r.text === this.r.text && o.r.status === this.r.status && o.r.entry?.folder === this.r.entry?.folder && o.lang === this.lang;
  }
  toDOM() {
    return variableElement(this.r, this.lang);
  }
  // A click puts the cursor next to the value and shows the placeholder; links keep their click
  ignoreEvent(e: Event) {
    return (e.target as HTMLElement).tagName === 'A';
  }
}

/** Fills an element with inline Markdown (`render` escapes it) that contains placeholders */
export function setMaskedHtml(el: HTMLElement, text: string, scope: VariableScope, render: (text: string) => string): void {
  const masked = maskVariables(text, scope);
  el.innerHTML = render(masked.text);
  if (!masked.values.length) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const parts = splitMasked(node.data);
    if (parts.every((p) => typeof p === 'string')) continue;
    node.replaceWith(...parts.map((p) => (typeof p === 'number' ? (masked.values[p] ? variableElement(masked.values[p]) : '') : p)));
  }
}

/**
 * `!{{var:name}}` or `!{{name}}` typed, pasted or completed in a note turns into the value at once: no placeholder,
 * plain text (a date stays the day it was written). Templates keep it, so it is filled in when a note is made.
 */
export const inlineVariables = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('paste') || tr.isUserEvent('drop'))) return tr;
  const scope = tr.startState.facet(variablesFacet);
  if (!scope || tr.startState.facet(templateTokensFacet).length) return tr;
  const doc = tr.newDoc;
  const changes: { from: number; to: number; insert: string }[] = [];
  const seen = new Set<number>();
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    const first = doc.lineAt(fromB).number;
    const last = doc.lineAt(toB).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = doc.line(n);
      if (!hasInlineVariables(line.text)) continue;
      for (const p of findInlineVariables(line.text)) {
        const from = line.from + p.from;
        const to = line.from + p.to;
        // Only what this change touched: older `!{{…}}` without a value stay as they are
        if (to < fromB || from > toB) continue;
        const r = scope.resolve(p.name, p.fallback);
        if (isFilled(r)) changes.push({ from, to, insert: r.text });
      }
    }
  });
  if (!changes.length) return tr;
  return [tr, { changes, sequential: true, userEvent: tr.annotation(Transaction.userEvent) } as TransactionSpec];
});

const shorten = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

/** A variable to offer: its name and what it stands for now */
export interface VariableOption {
  name: string;
  value: string;
  builtin: boolean;
}

/**
 * The variables to offer in a folder: its own (and those of the folders above), then the built-in date variables in
 * the reader's language (one that a folder overrides is offered once, as the folder's).
 */
export function variableOptions(scope: VariableScope, lang: Lang = getLang()): VariableOption[] {
  const own = scope.list().map((e): VariableOption => ({ name: e.name, value: resolveVariables(e.value, scope), builtin: false }));
  const taken = new Set(own.map((o) => variableKey(o.name)));
  const now = new Date();
  const builtins = BUILTIN_VARIABLES.map((b) => (lang === 'de' ? b.alias : b.name))
    .filter((name) => !taken.has(variableKey(name)))
    .map((name): VariableOption => ({ name, value: BUILTIN_VARIABLES.find((b) => b.name === name || b.alias === name)!.value(now), builtin: true }));
  return [...own, ...builtins];
}

/** `{{` or `{{var:` opens the variables of the note's folder and the built-in date variables, like `[[` opens notes */
export function variableCompletion(ctx: CompletionContext): CompletionResult | null {
  const scope = ctx.state.facet(variablesFacet);
  if (!scope) return null;
  const m = ctx.matchBefore(/\{\{[\p{L}\p{N}\p{M}_.:-]{0,70}/u);
  if (!m) return null;
  const typed = m.text.slice(2);
  // `!{{` puts the value in at once and takes bare names too
  const inline = m.from > 0 && ctx.state.sliceDoc(m.from - 1, m.from) === '!';
  const named = typed.startsWith('var:') || (inline && !'var:'.startsWith(typed));
  if (!named && !'var:'.startsWith(typed)) return null;
  for (let n: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent) if (/Code/.test(n.name)) return null;
  const lang = getLang();
  const options = variableOptions(scope, lang).map(
    (o, i): Completion => ({
      label: named ? o.name : `var:${o.name}`,
      detail: shorten(o.value),
      info: o.builtin ? tl(lang, 'vars.builtinInfo') : undefined,
      section: o.builtin ? { name: tl(lang, 'vars.builtinSection'), rank: 1 } : { name: tl(lang, 'vars.folderSection'), rank: 0 },
      boost: o.builtin ? -i : 0,
      apply: (view: EditorView, _c, from, to) => {
        const closed = view.state.sliceDoc(to, to + 2) === '}}';
        const insert = `${named ? '' : 'var:'}${o.name}${closed ? '' : '}}'}`;
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (closed ? 2 : 0) }, userEvent: 'input.complete' });
      },
    })
  );
  if (!options.length) return null;
  const prefix = typed.startsWith('var:') ? 4 : 0;
  return { from: m.from + 2 + (named ? prefix : 0), options, validFor: named ? /^[\p{L}\p{N}\p{M}_.-]*$/u : /^v?a?r?$/ };
}

/** A placeholder a template knows besides variables (`{{title}}`, `{{date}}`, `{{week}}`, …), with what it stands for */
export interface TemplateToken {
  token: string;
  label: string;
}

/** The template placeholders of an editor (template editor only) */
export const templateTokensFacet = Facet.define<readonly TemplateToken[], readonly TemplateToken[]>({ combine: (v) => v.flat() });

/** `{{` in a template also offers its own placeholders */
export function templateTokenCompletion(ctx: CompletionContext): CompletionResult | null {
  const tokens = ctx.state.facet(templateTokensFacet);
  if (!tokens.length) return null;
  const m = ctx.matchBefore(/\{\{[\p{L}\p{N}_-]{0,40}/u);
  if (!m) return null;
  const lang = getLang();
  return {
    from: m.from + 2,
    options: tokens.map(
      (t): Completion => ({
        label: t.token.slice(2, -2),
        detail: t.label,
        section: { name: tl(lang, 'templates.placeholderSection'), rank: -1 },
        boost: 10,
        apply: (view: EditorView, _c, from, to) => {
          const closed = view.state.sliceDoc(to, to + 2) === '}}';
          const insert = `${t.token.slice(2, -2)}${closed ? '' : '}}'}`;
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (closed ? 2 : 0) }, userEvent: 'input.complete' });
        },
      })
    ),
    validFor: /^[\p{L}\p{N}_-]*$/u,
  };
}
