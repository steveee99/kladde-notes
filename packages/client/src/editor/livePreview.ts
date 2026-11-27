import { EditorState, Extension, Facet, Range, StateEffect, StateField, type Text } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { findMath, isHighlightedLine, parseCodeInfo, ticketIdPattern, type MathSpan, MENTION_RE, mentionName, CALLOUT_TONES, calloutTypeTitle, escapeRegExp, isKnownCalloutType, parseCalloutLine, extractHeadings, fillReleasePlaceholders, hasReleasePlaceholders, parseEmbedLine, cardLineUrl, parseGitlabUrl, RELEASE_FIELD_RE, releaseFieldValue, releaseHistoryTable, TOC_ANCHOR_RE, VERSION_HISTORY_LINE_RE, findPlaceholders, hasVariables, maskVariables, resolveVariables, resolveVariableUrl, parseTasks, type Task, type NoteHeading, type ReleaseField } from '@kladde/shared';
import { getLang, tl } from '../lib/i18n';
import {
  AutoLinkWidget,
  MagicLinkMarkerWidget,
  CalloutHeadWidget,
  toggleCalloutEffect,
  toggleCodeFoldEffect,
  CodeFoldWidget,
  CodeLineNumberWidget,
  CarouselWidget,
  CheckboxWidget,
  CodeHeaderWidget,
  DiagramWidget,
  DueWidget,
  FootnoteDefWidget,
  FootnoteRefWidget,
  GalleryWidget,
  ImageWidget,
  LigatureWidget,
  LinkWidget,
  MentionWidget,
  TicketWidget,
  PropertiesWidget,
  QueryWidget,
  SimpleWidget,
  SlideBreakWidget,
  TableWidget,
  TocWidget,
  WikiWidget,
} from './widgets';
import { editorHost } from './host';
import { embedContext, foreignFacet } from './embedContext';
import { embedWidgetFor } from './embed';
import { markerStatus } from './taskStatus';
import { CODE_COLLAPSE_FALLBACK, getCodeBlockPrefs, getLigatures } from '../lib/prefs';
import { releaseFacet, ReleaseFieldWidget, releaseRenderOptions } from './releases';
import { VariableWidget, variablesFacet } from './variables';
import { GitlabCardWidget } from './gitlabCard';
import { CockpitBlockWidget } from './cockpit';
import { MathWidget } from './math';
import { stripInline } from './datatable';

/**
 * Obsidian-style live preview: Markdown syntax is hidden and rendered everywhere except in the
 * lines the cursor is in. Tables, ##TOC##, ```query, ```gallery, ```carousel, ```mermaid and ```mindmap blocks become interactive widgets.
 * Block widgets must come from a StateField (not a view plugin), so all decorations are built here.
 */

/** true = render every line (read-only views) */
export const previewAll = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });
/** Presentation mode (#87) is on: horizontal rules are slide breaks, labelled with this text (`{n}`: the next slide's number) */
export const slideBreakLabel = Facet.define<string, string>({ combine: (v) => v[0] ?? '' });
/** Callouts (#86) are on: `> [!type] Title` quotes are drawn as callouts, otherwise as plain quotes */
export const calloutsFacet = Facet.define<boolean, boolean>({ combine: (v) => (v.length ? v[0] : true) });
/** The note shows its fields elsewhere (tickets, milestones): the frontmatter row is hidden until the cursor enters it */
export const hidePropertiesFacet = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

/** Takes the place of hidden frontmatter: no room, nothing to click */
class HiddenPropertiesWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'wz-props-hidden';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
/** Current note id so notes don't autolink to themselves */
export const noteIdFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? '' });
/** Re-render widgets that depend on other notes (queries, link targets, language) */
export const refreshEffect = StateEffect.define<number>();
const focusEffect = StateEffect.define<boolean>();

/**
 * Collapsible callouts the reader opened or closed, by the start of their head line: they show the opposite of their
 * default (`-` collapsed, `+` open). Only in the view, the note text stays as it is.
 */
const calloutFoldField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size) next = new Set([...value].map((p) => tr.changes.mapPos(p, 1)));
    for (const e of tr.effects) {
      if (!e.is(toggleCalloutEffect)) continue;
      if (next === value) next = new Set(value);
      if (next.has(e.value)) next.delete(e.value);
      else next.add(e.value);
    }
    return next;
  },
});

/** Long code blocks the reader unfolded, by the start of their opening fence (only in the view) */
const codeFoldField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size) next = new Set([...value].map((p) => tr.changes.mapPos(p, 1)));
    for (const e of tr.effects) {
      if (!e.is(toggleCodeFoldEffect)) continue;
      if (next === value) next = new Set(value);
      if (next.has(e.value)) next.delete(e.value);
      else next.add(e.value);
    }
    return next;
  },
});

interface AutoLinkMatcher {
  stamp: number;
  noteId: string;
  regex: RegExp | null;
  map: Map<string, string>;
}
let cachedMatcher: AutoLinkMatcher | null = null;

function getAutoLinkMatcher(noteId: string, stamp: number): { regex: RegExp | null; map: Map<string, string> } {
  if (cachedMatcher && cachedMatcher.noteId === noteId && cachedMatcher.stamp === stamp) {
    return cachedMatcher;
  }
  const targets = editorHost.autoLinkTargets(noteId);
  if (!targets.length) {
    cachedMatcher = { stamp, noteId, regex: null, map: new Map() };
    return cachedMatcher;
  }
  const map = new Map<string, string>();
  const escaped: string[] = [];
  for (const t of targets) {
    const key = t.name.trim().toLowerCase();
    if (!key || map.has(key)) continue;
    map.set(key, t.target);
    escaped.push(escapeRegExp(t.name.trim()));
  }
  const regex = escaped.length ? new RegExp(`(?<![\\p{L}\\p{N}\\[#@/])(?:${escaped.join('|')})(?![\\p{L}\\p{N}\\]])`, 'giu') : null;
  cachedMatcher = { stamp, noteId, regex, map };
  return cachedMatcher;
}

const focusField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(focusEffect) ? e.value : acc), v),
});

let ticketReCache: { keys: string; re: RegExp | null } | null = null;
/** The regex for ticket ids of the current project keys, rebuilt only when the keys change */
function ticketPattern(keys: string[]): RegExp | null {
  const joined = keys.join(',');
  if (!ticketReCache || ticketReCache.keys !== joined) ticketReCache = { keys: joined, re: ticketIdPattern(keys) };
  return ticketReCache.re;
}

const stampField = StateField.define<number>({
  create: () => 0,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(refreshEffect) ? e.value : acc), v),
});

const hide = Decoration.replace({});

/** Formulas (#85) per document: the decorations are rebuilt on every cursor move, the text stays the same */
const mathCache = new WeakMap<EditorState['doc'], MathSpan[]>();
function mathOf(doc: EditorState['doc']): MathSpan[] {
  let spans = mathCache.get(doc);
  if (!spans) {
    spans = findMath(doc.toString());
    mathCache.set(doc, spans);
  }
  return spans;
}

/** Character pairs shown as one sign. Longer ones first; neighbors like "-->" or "<==" stay as they are. */
const LIGATURES: Record<string, string> = { '<->': '↔', '<=>': '⇔', '->': '→', '<-': '←', '=>': '⇒', '<=': '≤', '>=': '≥', '!=': '≠', '...': '…' };
const LIGATURE_RE = /(?<![<>=!-])(?:<->|<=>|->|<-|=>|<=|>=|!=)(?![<>=-])|(?<!\.)\.\.\.(?!\.)/g;
const mark = (cls: string) => Decoration.mark({ class: cls });
const line = (cls: string) => Decoration.line({ class: cls });
const noSpellcheck = Decoration.line({ attributes: { spellcheck: 'false' } });

function build(state: EditorState): DecorationSet {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 300) ?? syntaxTree(state);
  const all = state.facet(previewAll) || !state.field(focusField);
  const stamp = state.field(stampField);
  const lang = getLang();
  const ligatures = getLigatures();
  const codeBlocks = getCodeBlockPrefs();
  const codeFolds = state.field(codeFoldField);
  // Inside an embed the editor is read-only, but its tasks may still be ticked (written to the source note)
  const embedSource = state.facet(embedContext).source;
  const tasksLocked = state.readOnly && !embedSource?.canWrite;
  // Release versioning (#53): placeholders are shown filled in
  const release = state.facet(releaseFacet);
  const releaseOpts = release ? releaseRenderOptions(lang) : null;
  // Variables ({{var:name}}): shown as their values
  const variables = state.facet(variablesFacet);
  /** Text with the values in it, as plain text (titles, link texts) */
  const filled = (text: string) => (variables && hasVariables(text) ? resolveVariables(text, variables) : text);
  /** A link; its URL is complete before it is checked by `safeUrl` */
  const linkWidget = (text: string, rawUrl: string) => {
    if (!variables || !hasVariables(text + rawUrl)) return new LinkWidget(text, rawUrl, true, null, foreign);
    const { url, complete } = resolveVariableUrl(rawUrl, variables);
    const masked = maskVariables(text, variables);
    return new LinkWidget(text, url, complete, text ? masked.fill(stripInline(masked.text)) : null);
  };
  const slideLabel = state.facet(slideBreakLabel);
  const callouts = state.facet(calloutsFacet);
  const hideProps = state.facet(hidePropertiesFacet);
  const toggled = state.field(calloutFoldField);
  let slideNo = 1;
  const active = new Set<number>();
  if (!all) {
    for (const r of state.selection.ranges) {
      for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
    }
  }
  const isActive = (from: number, to: number) => {
    if (all) return false;
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) if (active.has(l)) return true;
    return false;
  };

  /** The selection touches [from, to] (finer than isActive, which works per line) */
  const touches = (from: number, to: number) => !all && state.selection.ranges.some((r) => r.from <= to && r.to >= from);

  const decos: Range<Decoration>[] = [];
  // Text from outside the vault: nothing in it is looked up in the reader's notes
  const foreign = state.facet(foreignFacet);
  const people = foreign ? [] : editorHost.people(state.facet(noteIdFacet));
  const ticketRe = foreign ? null : ticketPattern(editorHost.ticketKeys());
  /** Replaced ranges: nothing else may be replaced inside them */
  const replaced: [number, number][] = [];
  const protectedRanges: [number, number][] = [];
  const codeLines = new Set<number>();
  /** `inline code`: nothing in it is filled in */
  const codeRanges: [number, number][] = [];
  const inRanges = (ranges: [number, number][], from: number, to: number) => ranges.some(([a, b]) => from < b && to > a);
  const free = (from: number, to: number) => !replaced.some(([a, b]) => from < b && to > a);
  /** GitLab preview cards: the address of a line that is only a GitLab link (variables filled in), else null */
  const cardUrlOf = (lineText: string): string | null => {
    if (foreign) return null;
    const raw = cardLineUrl(lineText);
    if (!raw) return null;
    const url = variables && hasVariables(raw) ? resolveVariableUrl(raw, variables) : { url: raw, complete: true };
    return url.complete && parseGitlabUrl(url.url, editorHost.remoteHosts()) ? url.url : null;
  };
  const isCardLine = (pos: number) => {
    const ln = doc.lineAt(pos);
    return (all || !active.has(ln.number)) && cardUrlOf(ln.text) !== null;
  };
  const isProtected = (from: number, to: number) => !free(from, to) || protectedRanges.some(([a, b]) => from < b && to > a);
  const replace = (from: number, to: number, deco: Decoration = hide) => {
    if (from >= to || !free(from, to)) return;
    replaced.push([from, to]);
    decos.push(deco.range(from, to));
  };
  const lineClass = (from: number, to: number, cls: string) => {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) decos.push(line(cls).range(doc.line(l).from));
  };
  const blockWidget = (node: SyntaxNode, widget: Decoration) => {
    const from = doc.lineAt(node.from).from;
    const to = doc.lineAt(node.to).to;
    replace(from, to, widget);
  };

  // Frontmatter: the Markdown parser would read its closing "---" as a heading underline
  let fmEnd = 0;
  if (doc.lines > 1 && doc.line(1).text === '---') {
    for (let l = 2; l <= doc.lines; l++) {
      if (doc.line(l).text === '---') {
        fmEnd = doc.line(l).to;
        if (isActive(0, fmEnd)) lineClass(0, fmEnd, 'cm-frontmatter');
        else if (hideProps) replace(0, fmEnd, Decoration.replace({ widget: new HiddenPropertiesWidget(), block: true }));
        else replace(0, fmEnd, Decoration.replace({ widget: new PropertiesWidget(l > 2 ? doc.sliceString(doc.line(2).from, doc.line(l - 1).to) : '', lang, !state.readOnly, variables), block: true }));
        break;
      }
    }
  }

  // Formulas (#85) before the Markdown nodes: `*` and `_` inside TeX are no emphasis. On the cursor's line the source shows
  for (const m of mathOf(doc)) {
    if (m.from < fmEnd) continue;
    protectedRanges.push([m.from, m.to]);
    if (isActive(m.from, m.to)) {
      decos.push(mark('cm-math-src').range(m.from, m.to));
      continue;
    }
    replace(m.from, m.to, Decoration.replace({ widget: new MathWidget(m.tex, m.display, m.block), block: m.block }));
  }

  tree.iterate({
    from: fmEnd,
    enter: (ref) => {
      const node = ref.node;
      if (node.from < fmEnd) return node.to <= fmEnd ? false : undefined;
      const name = node.name;
      const text = () => doc.sliceString(node.from, node.to);

      const heading = /^ATXHeading(\d)$/.exec(name) ?? /^SetextHeading(\d)$/.exec(name);
      if (heading) {
        lineClass(node.from, node.to, `cm-h${heading[1]}`);
        return;
      }

      switch (name) {
        case 'HeaderMark':
          if (node.parent?.name.startsWith('ATXHeading') && !isActive(node.from, node.to)) {
            const after = doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0;
            replace(node.from, node.to + after);
          }
          return;
        case 'Emphasis':
          decos.push(mark('cm-em').range(node.from, node.to));
          return;
        case 'StrongEmphasis':
          decos.push(mark('cm-strong').range(node.from, node.to));
          return;
        case 'Strikethrough':
          decos.push(mark('cm-strike').range(node.from, node.to));
          return;
        case 'InlineCode':
          protectedRanges.push([node.from, node.to]);
          codeRanges.push([node.from, node.to]);
          decos.push(mark('cm-inline-code').range(node.from, node.to));
          return;
        case 'EmphasisMark':
        case 'StrikethroughMark':
          if (isActive(node.from, node.to)) decos.push(mark('cm-md-mark').range(node.from, node.to));
          else replace(node.from, node.to);
          return;
        case 'CodeMark':
          if (node.parent?.name === 'InlineCode') {
            if (isActive(node.from, node.to)) decos.push(mark('cm-md-mark').range(node.from, node.to));
            else replace(node.from, node.to);
          }
          return;
        case 'Link': {
          protectedRanges.push([node.from, node.to]);
          const marks = node.getChildren('LinkMark');
          const url = node.getChild('URL');
          if (marks.length < 2 || !url || doc.sliceString(node.from, node.from + 2) === '[[') return;
          if (isActive(node.from, node.to)) {
            // "[](url)" (e.g. fresh from /link) has no text: an empty mark decoration would throw
            if (marks[1].from > marks[0].to) decos.push(mark('cm-link').range(marks[0].to, marks[1].from));
            return;
          }
          replace(node.from, node.to, Decoration.replace({ widget: linkWidget(doc.sliceString(marks[0].to, marks[1].from), doc.sliceString(url.from, url.to)) }));
          return false;
        }
        case 'Autolink': {
          // <https://…>
          protectedRanges.push([node.from, node.to]);
          const url = node.getChild('URL');
          if (!url || isActive(node.from, node.to) || isCardLine(node.from)) return false;
          replace(node.from, node.to, Decoration.replace({ widget: linkWidget('', doc.sliceString(url.from, url.to)) }));
          return false;
        }
        case 'URL': {
          // Bare URLs (GFM autolink); URLs inside [text](url) and images are handled by their parent
          if (node.parent && /^(Link|Image|Autolink|LinkReference)$/.test(node.parent.name)) return;
          protectedRanges.push([node.from, node.to]);
          const url = text();
          if (!/^https?:\/\//i.test(url) || isActive(node.from, node.to) || isCardLine(node.from)) return;
          replace(node.from, node.to, Decoration.replace({ widget: linkWidget('', url) }));
          return;
        }
        case 'Image': {
          protectedRanges.push([node.from, node.to]);
          const url = node.getChild('URL');
          const marks = node.getChildren('LinkMark');
          if (!url) return false;
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
          const src = variables ? resolveVariableUrl(doc.sliceString(url.from, url.to), variables) : { url: doc.sliceString(url.from, url.to), complete: true };
          const widget = src.complete ? new ImageWidget(src.url, filled(alt), lang) : new LinkWidget(alt, src.url, false, filled(alt));
          // The image stays visible: its Markdown only shows (above it) while the cursor is inside the
          // image syntax itself, not anywhere on the line, so the layout does not jump while editing nearby
          if (touches(node.from, node.to)) decos.push(Decoration.widget({ widget, side: 1 }).range(node.to));
          else replace(node.from, node.to, Decoration.replace({ widget }));
          return false;
        }
        case 'Blockquote': {
          const head = callouts ? doc.lineAt(node.from) : null;
          const callout = head ? parseCalloutLine(head.text) : null;
          if (!head || !callout) {
            lineClass(node.from, node.to, 'cm-quote');
            return;
          }
          // Callout (#86): a box in the color role of its type, the head line becomes icon + title (+ fold button)
          const last = doc.lineAt(node.to);
          const foldable = callout.fold !== '';
          const collapsed = foldable && (callout.fold === '-') !== toggled.has(head.from) && !isActive(node.from, node.to);
          const tone = `cm-callout cm-callout-${CALLOUT_TONES[callout.kind]}`;
          const end = collapsed ? head.number : last.number;
          for (let l = head.number; l <= end; l++) {
            decos.push(line(`${tone}${l === head.number ? ' cm-callout-first' : ''}${l === end ? ' cm-callout-last' : ''}`).range(doc.line(l).from));
          }
          if (!isActive(head.from, head.to)) {
            // Without a title of its own: the type's name (in the app language for the known types)
            const title = filled(callout.title) || (isKnownCalloutType(callout.type) ? tl(lang, `callout.${callout.kind}`) : calloutTypeTitle(callout.type));
            const widget = new CalloutHeadWidget(callout.kind, title, foldable, collapsed, head.from, state.readOnly, lang);
            replace(head.from, collapsed ? last.to : head.to, Decoration.replace({ widget }));
          }
          return;
        }
        case 'QuoteMark':
          if (!isActive(node.from, node.to)) replace(node.from, node.to + (doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0));
          return;
        case 'HorizontalRule':
          slideNo++;
          if (!isActive(node.from, node.to))
            replace(node.from, node.to, Decoration.replace({ widget: slideLabel ? new SlideBreakWidget(slideLabel.replace('{n}', String(slideNo))) : new SimpleWidget('hr') }));
          return;
        case 'ListMark': {
          if (isActive(node.from, node.to)) return;
          const task = node.parent?.getChild('Task');
          if (task) {
            const marker = task.getChild('TaskMarker');
            if (marker) replace(node.from, marker.from);
          } else if (/^[-*+]$/.test(text())) {
            replace(node.from, node.to, Decoration.replace({ widget: new SimpleWidget('bullet') }));
          }
          return;
        }
        case 'TaskMarker': {
          const status = markerStatus(text());
          const ln = doc.lineAt(node.from);
          if (status === 'done') decos.push(mark('cm-task-done').range(node.to, ln.to));
          if (!isActive(node.from, node.to)) {
            replace(node.from, node.to + (doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0), Decoration.replace({ widget: new CheckboxWidget(status, ln.number - 1, tasksLocked, lang) }));
          }
          return;
        }
        case 'Table': {
          let src = text();
          let end = node.to;
          if (release && hasReleasePlaceholders(src)) {
            // A row template whose closing tag sits on the line after the table belongs to it
            const next = doc.lineAt(node.to).number < doc.lines ? doc.line(doc.lineAt(node.to).number + 1) : null;
            if (src.includes('{{#versions}}') && !src.includes('{{/versions}}') && next && next.text.trim() === '{{/versions}}') {
              end = next.to;
              src = doc.sliceString(node.from, end);
            }
            if (isActive(node.from, end)) return;
            replace(doc.lineAt(node.from).from, doc.lineAt(end).to, Decoration.replace({ widget: new TableWidget(fillReleasePlaceholders(src, release.releases, releaseOpts!), lang, false, variables), block: true }));
            return false;
          }
          if (!isActive(node.from, node.to)) {
            blockWidget(node, Decoration.replace({ widget: new TableWidget(text(), lang, !state.readOnly, hasVariables(text()) ? variables : null, foreign), block: true }));
            return false;
          }
          return;
        }
        case 'FencedCode': {
          const info = node.getChild('CodeInfo');
          const codeInfo = parseCodeInfo(info ? doc.sliceString(info.from, info.to) : '');
          const langInfo = codeInfo.lang;
          const firstLine = doc.lineAt(node.from);
          const lastLine = doc.lineAt(node.to);
          const body = firstLine.number < lastLine.number ? doc.sliceString(firstLine.to + 1, lastLine.number > firstLine.number + 1 ? doc.line(lastLine.number - 1).to : firstLine.to + 1) : '';
          for (let l = firstLine.number; l <= lastLine.number; l++) codeLines.add(l);
          const editing = isActive(node.from, node.to);
          if (!editing && release && langInfo === 'versions') {
            blockWidget(node, Decoration.replace({ widget: new TableWidget(releaseHistoryTable(release.releases, releaseOpts!), lang, false), block: true }));
            return false;
          }
          if (!editing && !foreign && (langInfo === 'query' || langInfo === 'gallery' || langInfo === 'carousel')) {
            const widget =
              langInfo === 'query' ? new QueryWidget(body, stamp, state.readOnly, lang) : langInfo === 'carousel' ? new CarouselWidget(body, lang) : new GalleryWidget(body, lang);
            blockWidget(node, Decoration.replace({ widget, block: true }));
            return false;
          }
          if (!editing && !foreign && langInfo === 'cockpit') {
            blockWidget(node, Decoration.replace({ widget: new CockpitBlockWidget(body, lang), block: true }));
            return false;
          }
          if (!editing && (langInfo === 'mermaid' || langInfo === 'mindmap')) {
            blockWidget(node, Decoration.replace({ widget: new DiagramWidget(langInfo, body, lang), block: true }));
            return false;
          }
          // Rendered (cursor outside): the opening fence becomes a slim header, a closing fence a thin bottom edge
          const closing = /^\s*(```|~~~)\s*$/.test(lastLine.text) && lastLine.number > firstLine.number;
          const bodyFirst = firstLine.number + 1;
          const bodyLast = closing ? lastLine.number - 1 : lastLine.number;
          const bodyCount = Math.max(0, bodyLast - bodyFirst + 1);
          // Folding long blocks: the setting, or `collapse`/`noCollapse` in the info string
          const foldAt = codeInfo.collapse === false ? 0 : codeBlocks.collapseAfter || (codeInfo.collapse ? CODE_COLLAPSE_FALLBACK : 0);
          const foldable = !editing && foldAt > 0 && bodyCount > foldAt + 1;
          const folded = foldable && !codeFolds.has(firstLine.from);
          const visibleLast = folded ? bodyFirst + foldAt - 1 : lastLine.number;
          const numbered = codeInfo.lineNumbers ?? codeBlocks.lineNumbers;
          // Code is not prose: no spell checking (Chrome also paints its markers over the line numbers)
          for (let l = firstLine.number; l <= lastLine.number; l++) {
            if (l > visibleLast && l <= bodyLast) continue;
            decos.push(noSpellcheck.range(doc.line(l).from));
            let cls = 'cm-codeblock';
            if (l === firstLine.number) cls += editing ? ' cm-codeblock-first' : ' cm-codeblock-first cm-codeblock-head';
            if (l === lastLine.number) cls += closing && !editing ? ' cm-codeblock-last cm-codeblock-foot' : ' cm-codeblock-last';
            const n = l - bodyFirst + 1;
            if (l >= bodyFirst && l <= bodyLast) {
              if (isHighlightedLine(codeInfo, n)) cls += ' cm-code-hl';
              if (numbered) cls += ' cm-code-numbered';
              decos.push(line(cls).range(doc.line(l).from));
              if (numbered) decos.push(Decoration.widget({ widget: new CodeLineNumberWidget(codeInfo.lineStart + n - 1), side: -1 }).range(doc.line(l).from));
            } else decos.push(line(cls).range(doc.line(l).from));
          }
          if (!editing) {
            replace(firstLine.from, firstLine.to, Decoration.replace({ widget: new CodeHeaderWidget(langInfo, body, lang, codeInfo.title, foldable ? folded : null, firstLine.from) }));
            if (folded) {
              const from = doc.line(visibleLast + 1).from;
              const to = doc.line(bodyLast).to;
              replace(from, to, Decoration.replace({ widget: new CodeFoldWidget(bodyLast - visibleLast, firstLine.from, lang), block: true }));
            }
            if (closing) replace(lastLine.from, lastLine.to);
          }
          return false;
        }
      }
    },
  });

  // Footnotes: definitions "[^id]: text" and references "[^id]", numbered by first reference
  const defs = new Map<string, { text: string; pos: number }>();
  const order: string[] = [];
  for (let l = 1; l <= doc.lines; l++) {
    if (codeLines.has(l) || doc.line(l).to <= fmEnd) continue;
    const ln = doc.line(l);
    const d = /^\[\^([^\]\s]+)\]:\s?(.*)$/.exec(ln.text);
    if (d && !defs.has(d[1])) defs.set(d[1], { text: d[2], pos: ln.from });
    for (const m of ln.text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) if (!order.includes(m[1])) order.push(m[1]);
  }
  for (const label of defs.keys()) if (!order.includes(label)) order.push(label);
  const numberOf = (label: string) => order.indexOf(label) + 1;

  // Lazy TOC extraction only when a ##TOC## / [[TOC]] anchor exists on a non-code line
  let tocHeadings: NoteHeading[] | null = null;

  // Things the Markdown parser does not know: ##TOC##, [[wikilinks]], #tags, due dates and repeat rules
  for (let l = 1; l <= doc.lines; l++) {
    if (codeLines.has(l) || doc.line(l).to <= fmEnd) continue;
    const ln = doc.line(l);
    const lineActive = !all && active.has(l);

    // ![[Note]], ![[Note#Heading]], ![[Note#^block]] on their own line: the referenced text, read-only
    const embed = lineActive || foreign ? null : parseEmbedLine(ln.text);
    if (embed && free(ln.from, ln.to)) {
      replace(ln.from, ln.to, Decoration.replace({ widget: embedWidgetFor(state, embed, state.facet(noteIdFacet), lang), block: true }));
      continue;
    }

    // A GitLab merge request, issue, project, group … alone on its line: a preview card
    const cardUrl = lineActive ? null : cardUrlOf(ln.text);
    if (cardUrl && free(ln.from, ln.to)) {
      replace(ln.from, ln.to, Decoration.replace({ widget: new GitlabCardWidget(cardUrl, lang), block: true }));
      continue;
    }

    if (release && !lineActive && VERSION_HISTORY_LINE_RE.test(ln.text) && free(ln.from, ln.to)) {
      replace(ln.from, ln.to, Decoration.replace({ widget: new TableWidget(releaseHistoryTable(release.releases, releaseOpts!), lang, false), block: true }));
      continue;
    }
    if (release && !lineActive && ln.text.includes('{{#versions}}') && ln.text.includes('{{/versions}}') && free(ln.from, ln.to)) {
      // A one-line row template ("{{#versions}}v{{version}} {{/versions}}"): the whole line, filled in
      replace(ln.from, ln.to, Decoration.replace({ widget: new ReleaseFieldWidget(fillReleasePlaceholders(ln.text, release.releases, releaseOpts!)) }));
      continue;
    }
    if (release && ln.text.includes('{{')) {
      for (const m of ln.text.matchAll(RELEASE_FIELD_RE)) {
        const from = ln.from + m.index!;
        const to = from + m[0].length;
        protectedRanges.push([from, to]);
        if (lineActive) decos.push(mark('cm-release-placeholder').range(from, to));
        else replace(from, to, Decoration.replace({ widget: new ReleaseFieldWidget(releaseFieldValue(release.releases[0], m[1] as ReleaseField, releaseOpts!)) }));
      }
    }

    if (!lineActive && TOC_ANCHOR_RE.test(ln.text)) {
      tocHeadings ??= extractHeadings(doc.toString()).map((h) => ({ ...h, text: filled(h.text) }));
      replace(ln.from, ln.to, Decoration.replace({ widget: new TocWidget(ln.text, tocHeadings, lang), block: true }));
      continue;
    }

    for (const m of foreign ? [] : ln.text.matchAll(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g)) {
      const from = ln.from + m.index!;
      const to = from + m[0].length;
      protectedRanges.push([from, to]);
      if (lineActive) decos.push(mark('cm-wikilink').range(from, to));
      else replace(from, to, Decoration.replace({ widget: new WikiWidget(m[1].trim(), m[2]?.trim() ?? null) }));
    }
    // Variables: the value, or the placeholder while the cursor is in it
    if (variables && hasVariables(ln.text)) {
      const math = mathOf(doc);
      for (const p of findPlaceholders(ln.text)) {
        const from = ln.from + p.from;
        const to = ln.from + p.to;
        if (inRanges(codeRanges, from, to) || math.some((s) => from < s.to && to > s.from) || /\[\[[^[\]]*$/.test(ln.text.slice(Math.max(0, p.from - 600), p.from))) continue;
        protectedRanges.push([from, to]);
        // The source of a link on the cursor's line stays in one piece
        const inUrl = tree.resolveInner(from, 1).name === 'URL';
        if (inUrl || touches(from, to)) decos.push(mark('cm-variable-src').range(from, to));
        else replace(from, to, Decoration.replace({ widget: new VariableWidget(variables.resolve(p.name, p.fallback), lang) }));
      }
    }
    const def = /^\[\^([^\]\s]+)\]:\s?/.exec(ln.text);
    if (def) {
      decos.push(line('cm-footnote-def').range(ln.from));
      if (!lineActive && free(ln.from, ln.from + def[0].length)) replace(ln.from, ln.from + def[0].length, Decoration.replace({ widget: new FootnoteDefWidget(numberOf(def[1])) }));
    }
    for (const m of ln.text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
      const from = ln.from + m.index!;
      const to = from + m[0].length;
      protectedRanges.push([from, to]);
      if (lineActive) decos.push(mark('cm-wikilink').range(from, to));
      else replace(from, to, Decoration.replace({ widget: new FootnoteRefWidget(m[1], numberOf(m[1]), defs.get(m[1])?.text ?? '', defs.get(m[1])?.pos ?? null, lang) }));
    }
    for (const m of ln.text.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) {
      const from = ln.from + m.index! + m[1].length;
      protectedRanges.push([from, from + m[2].length]);
      if (free(from, from + m[2].length)) decos.push(mark('cm-tag').range(from, from + m[2].length));
    }
    // @mentions (#69): people who can see the note show as a chip with their avatar
    if (people.length && ln.text.includes('@')) {
      for (const m of ln.text.matchAll(MENTION_RE)) {
        const name = mentionName(m[1]);
        const person = people.find((p) => p.username.toLowerCase() === name.toLowerCase());
        if (!person) continue;
        const from = ln.from + m.index!;
        const to = from + 1 + name.length;
        if (/Code|URL|Link/.test(tree.resolveInner(from, 1).name)) continue;
        protectedRanges.push([from, to]);
        if (lineActive || touches(from, to)) decos.push(mark('cm-mention').range(from, to));
        else replace(from, to, Decoration.replace({ widget: new MentionWidget(person.username, person.avatarUrl ?? null) }));
      }
    }
    // Ticket ids: `KLD-118` of a project where tickets are on shows as a chip with its status
    if (ticketRe && (fmEnd === 0 || ln.from > fmEnd) && /\d/.test(ln.text)) {
      ticketRe.lastIndex = 0;
      for (const m of ln.text.matchAll(ticketRe)) {
        const from = ln.from + m.index!;
        const to = from + m[0].length;
        if (isProtected(from, to) || /Code|URL|Link/.test(tree.resolveInner(from, 1).name)) continue;
        const chip = editorHost.ticket(m[0]);
        if (!chip) continue;
        protectedRanges.push([from, to]);
        if (lineActive || touches(from, to)) decos.push(mark('cm-ticket-ref').range(from, to));
        else replace(from, to, Decoration.replace({ widget: new TicketWidget(m[0], chip) }));
      }
    }
    if (!lineActive && /^\s*[-*+]\s+\[[ xXoOhH]\]/.test(ln.text)) {
      for (const m of ln.text.matchAll(/(?:📅\s*|\bdue:)(\d{4}-\d{2}-\d{2})/g)) {
        const from = ln.from + m.index!;
        replace(from, from + m[0].length, Decoration.replace({ widget: new DueWidget(m[1], 'due', lang) }));
      }
      for (const m of ln.text.matchAll(/(?:🔁\s*|\bevery:)((?:\d+\s*)?[\p{L},]+)/gu)) {
        const from = ln.from + m.index!;
        replace(from, from + m[0].length, Decoration.replace({ widget: new DueWidget(m[1], 'repeat', lang) }));
      }
      for (const m of ln.text.matchAll(/(?:⏰\s*|\bremind:)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/gi)) {
        const from = ln.from + m.index!;
        replace(from, from + m[0].length, Decoration.replace({ widget: new DueWidget(`${m[1].padStart(2, '0')}:${m[2]}`, 'time', lang) }));
      }
      // Dependencies and ids (#75): "⛔ a,b" / "after:^a" and "🆔 id" / a trailing "^id" become chips
      const linked = tasksOfDoc(doc).get(l - 1);
      for (const m of ln.text.matchAll(/(?:⛔\s*|\bafter:)(\^?[\w-]+(?:,\^?[\w-]+)*)/gu)) {
        const from = ln.from + m.index!;
        const ids = m[1].replace(/\^/g, '');
        replace(from, from + m[0].length, Decoration.replace({ widget: new DueWidget(ids, linked?.waiting ? 'waiting' : 'after', lang) }));
      }
      for (const m of ln.text.matchAll(/🆔\s*([\w-]+)|(?:^|\s)\^([\w-]+)(?=\s*(?:✅\s*\d{4}-\d{2}-\d{2}\s*)?$)/gu)) {
        const id = m[1] ?? m[2];
        const from = ln.from + m.index! + (m[1] ? 0 : m[0].indexOf('^'));
        replace(from, ln.from + m.index! + m[0].length, Decoration.replace({ widget: new DueWidget(id, 'id', lang) }));
      }
      if (linked?.subtasks) {
        const { done, total } = linked.subtasks;
        decos.push(Decoration.widget({ widget: new DueWidget(`${done}/${total}`, done === total ? 'progress-done' : 'progress', lang), side: 1 }).range(ln.to));
      }
      for (const m of ln.text.matchAll(/✅\s*\d{4}-\d{2}-\d{2}/g)) {
        // Hide the space in front too (found by hand: a leading `\s*` in the regex backtracks quadratically)
        let start = m.index!;
        while (start > 0 && /\s/.test(ln.text[start - 1])) start--;
        replace(ln.from + start, ln.from + m.index! + m[0].length);
      }
    }
    const matcher = foreign ? null : getAutoLinkMatcher(state.facet(noteIdFacet), stamp);
    if (matcher?.regex) {
      matcher.regex.lastIndex = 0;
      for (const m of ln.text.matchAll(matcher.regex)) {
        const from = ln.from + m.index!;
        const to = from + m[0].length;
        if (isProtected(from, to)) continue;
        const original = m[0];
        const target = matcher.map.get(original.toLowerCase());
        if (!target) continue;

        if (lineActive) {
          decos.push(mark('cm-autolink').range(from, to));
          decos.push(Decoration.widget({ widget: new MagicLinkMarkerWidget(target, original, to, lang), side: 1 }).range(to));
        } else {
          replace(from, to, Decoration.replace({ widget: new AutoLinkWidget(target, original, from, to, lang) }));
        }
      }
    }
    if (ligatures && !lineActive) {
      for (const m of ln.text.matchAll(LIGATURE_RE)) {
        const from = ln.from + m.index!;
        const to = from + m[0].length;
        if (!isProtected(from, to)) replace(from, to, Decoration.replace({ widget: new LigatureWidget(LIGATURES[m[0]]) }));
      }
    }
  }

  return Decoration.set(decos, true);
}

const previewField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshEffect) || e.is(focusEffect) || e.is(toggleCalloutEffect) || e.is(toggleCodeFoldEffect)) || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.state.readOnly !== tr.startState.readOnly) {
      return build(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Draws again when the GitLab instances become known (preview cards need them to recognise addresses) */
const remoteHostsWatcher = ViewPlugin.define((view) => {
  const off = editorHost.onRemoteHosts(() => view.dispatch({ effects: refreshEffect.of(Date.now()) }));
  return { destroy: off };
});

/** The tasks of a document by line (0-based), for subtask progress and waiting chips (#75); cached per document */
const docTasks = new WeakMap<Text, Map<number, Task>>();
function tasksOfDoc(doc: Text): Map<number, Task> {
  let hit = docTasks.get(doc);
  if (!hit) {
    hit = new Map(parseTasks(doc.toString()).map((t) => [t.line, t]));
    docTasks.set(doc, hit);
  }
  return hit;
}

export function livePreview(): Extension {
  return [
    remoteHostsWatcher,
    focusField,
    stampField,
    calloutFoldField,
    codeFoldField,
    previewField,
    EditorView.domEventHandlers({
      focus: (_e, view) => {
        // After the focus event the selection is final: show the cursor's line as source
        setTimeout(() => view.dispatch({ effects: focusEffect.of(true) }));
      },
      blur: (_e, view) => {
        setTimeout(() => {
          if (!view.hasFocus) view.dispatch({ effects: focusEffect.of(false) });
        }, 120);
      },
    }),
  ];
}
