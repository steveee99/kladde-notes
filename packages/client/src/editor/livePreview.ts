import { EditorState, Extension, Facet, Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
  CheckboxWidget,
  CodeHeaderWidget,
  DueWidget,
  GalleryWidget,
  ImageWidget,
  LinkWidget,
  PropertiesWidget,
  QueryWidget,
  SimpleWidget,
  TableWidget,
  WikiWidget,
} from './widgets';

/**
 * Obsidian-style live preview: Markdown syntax is hidden and rendered everywhere except in the
 * lines the cursor is in. Tables, ```query and ```gallery blocks become interactive widgets.
 * Block widgets must come from a StateField (not a view plugin), so all decorations are built here.
 */

/** true = render every line (read-only views) */
export const previewAll = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });
/** Re-render widgets that depend on other notes (queries, link targets) */
export const refreshEffect = StateEffect.define<number>();
const focusEffect = StateEffect.define<boolean>();

const focusField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(focusEffect) ? e.value : acc), v),
});

const stampField = StateField.define<number>({
  create: () => 0,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(refreshEffect) ? e.value : acc), v),
});

const hide = Decoration.replace({});
const mark = (cls: string) => Decoration.mark({ class: cls });
const line = (cls: string) => Decoration.line({ class: cls });

function build(state: EditorState): DecorationSet {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 300) ?? syntaxTree(state);
  const all = state.facet(previewAll) || !state.field(focusField);
  const stamp = state.field(stampField);
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

  const decos: Range<Decoration>[] = [];
  /** Replaced ranges: nothing else may be replaced inside them */
  const replaced: [number, number][] = [];
  const codeLines = new Set<number>();
  const free = (from: number, to: number) => !replaced.some(([a, b]) => from < b && to > a);
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
        else replace(0, fmEnd, Decoration.replace({ widget: new PropertiesWidget(doc.sliceString(doc.line(2).from, doc.line(l - 1).to)), block: true }));
        break;
      }
    }
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
          const marks = node.getChildren('LinkMark');
          const url = node.getChild('URL');
          if (marks.length < 2 || !url || doc.sliceString(node.from, node.from + 2) === '[[') return;
          if (isActive(node.from, node.to)) {
            decos.push(mark('cm-link').range(marks[0].to, marks[1].from));
            return;
          }
          replace(node.from, node.to, Decoration.replace({ widget: new LinkWidget(doc.sliceString(marks[0].to, marks[1].from), doc.sliceString(url.from, url.to)) }));
          return false;
        }
        case 'Image': {
          const url = node.getChild('URL');
          const marks = node.getChildren('LinkMark');
          if (!url || isActive(node.from, node.to)) return false;
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
          replace(node.from, node.to, Decoration.replace({ widget: new ImageWidget(doc.sliceString(url.from, url.to), alt) }));
          return false;
        }
        case 'Blockquote':
          lineClass(node.from, node.to, 'cm-quote');
          return;
        case 'QuoteMark':
          if (!isActive(node.from, node.to)) replace(node.from, node.to + (doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0));
          return;
        case 'HorizontalRule':
          if (!isActive(node.from, node.to)) replace(node.from, node.to, Decoration.replace({ widget: new SimpleWidget('hr') }));
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
          const checked = /x/i.test(text());
          const ln = doc.lineAt(node.from);
          if (checked) decos.push(mark('cm-task-done').range(node.to, ln.to));
          if (!isActive(node.from, node.to)) {
            replace(node.from, node.to + (doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0), Decoration.replace({ widget: new CheckboxWidget(checked, ln.number - 1) }));
          }
          return;
        }
        case 'Table':
          if (!isActive(node.from, node.to)) {
            blockWidget(node, Decoration.replace({ widget: new TableWidget(text()), block: true }));
            return false;
          }
          return;
        case 'FencedCode': {
          const info = node.getChild('CodeInfo');
          const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : '';
          const firstLine = doc.lineAt(node.from);
          const lastLine = doc.lineAt(node.to);
          const body = firstLine.number < lastLine.number ? doc.sliceString(firstLine.to + 1, lastLine.number > firstLine.number + 1 ? doc.line(lastLine.number - 1).to : firstLine.to + 1) : '';
          for (let l = firstLine.number; l <= lastLine.number; l++) codeLines.add(l);
          const editing = isActive(node.from, node.to);
          if (!editing && (lang === 'query' || lang === 'gallery')) {
            const widget = lang === 'query' ? new QueryWidget(body, stamp) : new GalleryWidget(body);
            blockWidget(node, Decoration.replace({ widget, block: true }));
            return false;
          }
          for (let l = firstLine.number; l <= lastLine.number; l++) {
            const cls = `cm-codeblock${l === firstLine.number ? ' cm-codeblock-first' : ''}${l === lastLine.number ? ' cm-codeblock-last' : ''}`;
            decos.push(line(cls).range(doc.line(l).from));
          }
          if (!editing) {
            replace(firstLine.from, firstLine.to, Decoration.replace({ widget: new CodeHeaderWidget(lang, body) }));
            const closing = /^\s*(```|~~~)\s*$/.test(lastLine.text) && lastLine.number > firstLine.number;
            if (closing) replace(lastLine.from, lastLine.to);
          }
          return false;
        }
      }
    },
  });

  // Things the Markdown parser does not know: [[wikilinks]], #tags, due dates and repeat rules
  for (let l = 1; l <= doc.lines; l++) {
    if (codeLines.has(l) || doc.line(l).to <= fmEnd) continue;
    const ln = doc.line(l);
    const lineActive = !all && active.has(l);
    for (const m of ln.text.matchAll(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g)) {
      const from = ln.from + m.index!;
      const to = from + m[0].length;
      if (lineActive) decos.push(mark('cm-wikilink').range(from, to));
      else replace(from, to, Decoration.replace({ widget: new WikiWidget(m[1].trim(), m[2]?.trim() ?? null) }));
    }
    for (const m of ln.text.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) {
      const from = ln.from + m.index! + m[1].length;
      if (free(from, from + m[2].length)) decos.push(mark('cm-tag').range(from, from + m[2].length));
    }
    if (!lineActive && /^\s*[-*+]\s+\[[ xX]\]/.test(ln.text)) {
      for (const m of ln.text.matchAll(/(?:📅\s*|\bdue:)(\d{4}-\d{2}-\d{2})/g)) {
        const from = ln.from + m.index!;
        replace(from, from + m[0].length, Decoration.replace({ widget: new DueWidget(m[1], 'due') }));
      }
      for (const m of ln.text.matchAll(/(?:🔁\s*|\bevery:)((?:\d+\s*)?[\p{L},]+)/gu)) {
        const from = ln.from + m.index!;
        replace(from, from + m[0].length, Decoration.replace({ widget: new DueWidget(m[1], 'repeat') }));
      }
      for (const m of ln.text.matchAll(/\s*✅\s*\d{4}-\d{2}-\d{2}/g)) {
        const from = ln.from + m.index!;
        replace(from, from + m[0].length);
      }
    }
  }

  return Decoration.set(decos, true);
}

const previewField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshEffect) || e.is(focusEffect)) || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return build(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function livePreview(): Extension {
  return [
    focusField,
    stampField,
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
