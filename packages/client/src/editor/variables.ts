import { Facet } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { EditorView, WidgetType } from '@codemirror/view';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { SyntaxNode } from '@lezer/common';
import { isFilled, isUrlValue, maskVariables, resolveVariables, safeUrl, splitMasked, type ResolvedVariable, type VariableScope } from '@kladde/shared';
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

const shorten = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

/** `{{` or `{{var:` opens the variables of the note's folder */
export function variableCompletion(ctx: CompletionContext): CompletionResult | null {
  const scope = ctx.state.facet(variablesFacet);
  if (!scope) return null;
  const m = ctx.matchBefore(/\{\{[\p{L}\p{N}\p{M}_.:-]{0,70}/u);
  if (!m) return null;
  const typed = m.text.slice(2);
  const named = typed.startsWith('var:');
  if (!named && !'var:'.startsWith(typed)) return null;
  for (let n: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent) if (/Code/.test(n.name)) return null;
  const options = scope.list().map(
    (e): Completion => ({
      label: named ? e.name : `var:${e.name}`,
      detail: shorten(resolveVariables(e.value, scope)),
      apply: (view: EditorView, _c, from, to) => {
        const closed = view.state.sliceDoc(to, to + 2) === '}}';
        const insert = `${named ? '' : 'var:'}${e.name}${closed ? '' : '}}'}`;
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (closed ? 2 : 0) }, userEvent: 'input.complete' });
      },
    })
  );
  if (!options.length) return null;
  return { from: m.from + 2 + (named ? 4 : 0), options, validFor: named ? /^[\p{L}\p{N}\p{M}_.-]*$/u : /^v?a?r?$/ };
}
