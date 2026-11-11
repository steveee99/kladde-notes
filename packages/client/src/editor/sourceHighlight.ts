import { EditorState, Extension, Range, Text } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { TOC_ANCHOR_RE, toDateString } from '@kladde/shared';
import { editorHost } from './host';
import { refreshEffect } from './livePreview';

/**
 * Syntax color highlighting for Kladde's Markdown source / code view (`Editor` with `source={true}`).
 *
 * Highlights Markdown structure via the Lezer AST, handles YAML frontmatter explicitly (because the
 * Markdown parser reads closing `---` as a setext heading underline), and adds Kladde-specific syntax
 * (`[[wikilinks]]`, `#tags`, `##TOC##`, footnotes, task dates/repeats, and `query`/`mermaid`/`mindmap`/
 * `gallery`/`carousel` fenced blocks). Fenced code blocks in standard languages use `syntaxHighlighting`.
 */

const markCache = new Map<string, Decoration>();
const lineCache = new Map<string, Decoration>();

function markCls(cls: string): Decoration {
  let d = markCache.get(cls);
  if (!d) {
    d = Decoration.mark({ class: cls });
    markCache.set(cls, d);
  }
  return d;
}

function lineCls(cls: string): Decoration {
  let d = lineCache.get(cls);
  if (!d) {
    d = Decoration.line({ class: cls });
    lineCache.set(cls, d);
  }
  return d;
}

type AddMark = (from: number, to: number, cls: string) => void;

function mergeLineRanges(doc: Text, ranges: readonly { from: number; to: number }[]): [number, number][] {
  if (!ranges.length) return [[1, Math.min(1, doc.lines)]];
  const raw = ranges
    .map((r) => [doc.lineAt(r.from).number, doc.lineAt(r.to).number] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const prev = out[out.length - 1];
    if (raw[i][0] <= prev[1] + 1) prev[1] = Math.max(prev[1], raw[i][1]);
    else out.push(raw[i]);
  }
  return out;
}

function overlaps(ranges: [number, number][], from: number, to: number): boolean {
  return ranges.some(([a, b]) => from < b && to > a);
}

/** Finds closing `---` for YAML frontmatter starting on line 1, matching `livePreview.ts` */
function findFrontmatter(doc: Text): { endLine: number; endPos: number } | null {
  if (doc.lines < 2 || doc.line(1).text !== '---') return null;
  for (let l = 2; l <= doc.lines; l++) {
    if (doc.line(l).text === '---') return { endLine: l, endPos: doc.line(l).to };
  }
  return null;
}

/** Finds the index of an unquoted `# comment` in a YAML line, or -1 */
function yamlCommentIndex(text: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') i++;
      else if (quote === "'" && ch === "'" && text[i + 1] === "'") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return i;
  }
  return -1;
}

const YAML_NUM_BOOL_DATE = /^(?:true|false|yes|no|null|~|-?\d+(?:\.\d+)?|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)$/i;
const YAML_URL = /^https?:\/\/\S+$/i;

function highlightYamlScalar(raw: string, base: number, addMark: AddMark) {
  const lead = raw.length - raw.trimStart().length;
  const trimmed = raw.trim();
  if (!trimmed) return;
  const from = base + lead;
  const to = from + trimmed.length;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
    addMark(from, to, 'cm-src-fm-str');
  } else if (YAML_URL.test(trimmed)) {
    addMark(from, to, 'cm-src-url');
  } else if (YAML_NUM_BOOL_DATE.test(trimmed)) {
    addMark(from, to, 'cm-src-fm-num');
  } else {
    addMark(from, to, 'cm-src-fm-val');
  }
}

function highlightYamlFlow(raw: string, base: number, addMark: AddMark) {
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/^https?:\/\//i.test(raw.slice(i))) {
      const start = i;
      while (i < raw.length && !/[\[\]{},\s]/.test(raw[i])) i++;
      addMark(base + start, base + i, 'cm-src-url');
      continue;
    }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === ',' || ch === ':') {
      addMark(base + i, base + i + 1, 'cm-src-fm-punct');
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < raw.length) {
        if (ch === '"' && raw[i] === '\\') i += 2;
        else if (ch === "'" && raw[i] === "'" && raw[i + 1] === "'") i += 2;
        else if (raw[i] === ch) {
          i++;
          break;
        } else i++;
      }
      addMark(base + start, base + i, 'cm-src-fm-str');
      continue;
    }
    const start = i;
    while (i < raw.length && !/[\[\]{},:\s]/.test(raw[i])) i++;
    const tok = raw.slice(start, i);
    if (YAML_NUM_BOOL_DATE.test(tok)) addMark(base + start, base + i, 'cm-src-fm-num');
    else addMark(base + start, base + i, 'cm-src-fm-val');
  }
}

function highlightYamlValue(raw: string, base: number, addMark: AddMark) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) highlightYamlFlow(raw, base, addMark);
  else if (/^[|>][+-]?\d*$/.test(trimmed)) addMark(base + (raw.length - raw.trimStart().length), base + raw.trimEnd().length, 'cm-src-fm-punct');
  else highlightYamlScalar(raw, base, addMark);
}

function highlightFrontmatterLine(text: string, lineFrom: number, addMark: AddMark) {
  const cmtIdx = yamlCommentIndex(text);
  const body = cmtIdx >= 0 ? text.slice(0, cmtIdx) : text;
  if (cmtIdx >= 0) addMark(lineFrom + cmtIdx, lineFrom + text.length, 'cm-src-comment');

  if (!body.trim()) return;

  const list = /^(\s*)(-)(\s+)(.*)$/.exec(body);
  if (list) {
    const dashFrom = lineFrom + list[1].length;
    addMark(dashFrom, dashFrom + 1, 'cm-src-fm-punct');
    const restOffset = list[1].length + 1 + list[3].length;
    const inlineKv = /^([A-Za-z0-9_.-]+)(\s*:)(.*)$/.exec(list[4]);
    if (inlineKv) {
      addMark(lineFrom + restOffset, lineFrom + restOffset + inlineKv[1].length, 'cm-src-fm-key');
      const colonFrom = lineFrom + restOffset + inlineKv[1].length + (inlineKv[2].length - 1);
      addMark(colonFrom, colonFrom + 1, 'cm-src-fm-punct');
      highlightYamlValue(inlineKv[3], lineFrom + restOffset + inlineKv[1].length + inlineKv[2].length, addMark);
    } else {
      highlightYamlValue(list[4], lineFrom + restOffset, addMark);
    }
    return;
  }

  const kv = /^(\s*)([A-Za-z0-9_.-]+)(\s*:)(.*)$/.exec(body);
  if (kv) {
    const keyFrom = lineFrom + kv[1].length;
    const keyTo = keyFrom + kv[2].length;
    addMark(keyFrom, keyTo, 'cm-src-fm-key');
    const colonFrom = keyTo + (kv[3].length - 1);
    addMark(colonFrom, colonFrom + 1, 'cm-src-fm-punct');
    highlightYamlValue(kv[4], keyTo + kv[3].length, addMark);
    return;
  }

  highlightYamlScalar(body, lineFrom, addMark);
}

function highlightHtml(text: string, base: number, addMark: AddMark) {
  const commentSpans: [number, number][] = [];
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
    const from = base + m.index!;
    const to = from + m[0].length;
    commentSpans.push([from, to]);
    addMark(from, to, 'cm-src-comment');
  }

  for (const m of text.matchAll(/<\/?[A-Za-z][\w:-]*(?:\s+[^>]*?)?\/?>/g)) {
    const from = base + m.index!;
    const to = from + m[0].length;
    if (overlaps(commentSpans, from, to)) continue;
    const raw = m[0];
    const openMatch = /^(<\/?)([A-Za-z][\w:-]*)/.exec(raw);
    if (!openMatch) continue;
    addMark(from, from + openMatch[1].length, 'cm-src-html-punct');
    const nameFrom = from + openMatch[1].length;
    const nameTo = nameFrom + openMatch[2].length;
    addMark(nameFrom, nameTo, 'cm-src-html-tag');

    const closeMatch = /(\/?>)$/.exec(raw);
    const closeLen = closeMatch ? closeMatch[1].length : 0;
    if (closeLen) addMark(to - closeLen, to, 'cm-src-html-punct');

    const attrPart = raw.slice(openMatch[0].length, raw.length - closeLen);
    const attrBase = from + openMatch[0].length;
    for (const am of attrPart.matchAll(/([A-Za-z_:][\w:.-]*)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)) {
      const aFrom = attrBase + am.index!;
      addMark(aFrom, aFrom + am[1].length, 'cm-src-html-attr');
      if (am[2] && am[3]) {
        const eqPos = attrBase + am.index! + am[1].length + am[2].indexOf('=');
        addMark(eqPos, eqPos + 1, 'cm-src-html-punct');
        const valFrom = attrBase + am.index! + am[1].length + am[2].length;
        addMark(valFrom, valFrom + am[3].length, 'cm-src-string');
      }
    }
  }
}

const QUERY_KEYWORDS = new Set(['table', 'list', 'tasks', 'kanban', 'by', 'values', 'from', 'where', 'sort', 'limit', 'asc', 'desc', 'and', 'or', 'not', 'contains']);
const QUERY_FIELDS = new Set(['title', 'path', 'folder', 'created', 'updated', 'tags', 'links', 'due', 'done', 'text', 'status']);

function highlightQueryLine(text: string, lineFrom: number, addMark: AddMark) {
  for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|!=|<=|>=|[=<>~,]|[^\s,=<>!~"']+/g)) {
    const tok = m[0];
    const from = lineFrom + m.index!;
    const to = from + tok.length;
    if (/^["']/.test(tok)) {
      addMark(from, to, 'cm-src-string');
    } else if (/^(?:!=|<=|>=|[=<>~,])$/.test(tok)) {
      addMark(from, to, 'cm-src-code-op');
    } else {
      const lower = tok.toLowerCase();
      if (QUERY_KEYWORDS.has(lower)) addMark(from, to, 'cm-src-code-kw');
      else if (QUERY_FIELDS.has(lower)) addMark(from, to, 'cm-src-code-field');
      else if (/^(?:\d{4}-\d{2}-\d{2}|today|tomorrow|true|false|-?\d+(?:\.\d+)?)$/i.test(tok)) addMark(from, to, 'cm-src-code-num');
    }
  }
}

const MERMAID_KEYWORDS =
  /\b(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|gitGraph|journey|mindmap|timeline|quadrantChart|xychart-beta|subgraph|end|participant|actor|Note|loop|alt|else|opt|par|and|rect|style|classDef|class|linkStyle|click|direction|over|TD|TB|BT|RL|LR)\b/g;

function highlightMermaidLine(text: string, lineFrom: number, addMark: AddMark) {
  const cmt = text.indexOf('%%');
  const code = cmt >= 0 ? text.slice(0, cmt) : text;
  if (cmt >= 0) addMark(lineFrom + cmt, lineFrom + text.length, 'cm-src-comment');

  const protectedSpans: [number, number][] = [];
  for (const m of code.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    const from = lineFrom + m.index!;
    const to = from + m[0].length;
    protectedSpans.push([from, to]);
    addMark(from, to, 'cm-src-string');
  }
  for (const m of code.matchAll(/<--+>?|--+>?|==+>?|-\.-+>?|<==+|--[xo]|<<?-->>?|--\|>|\.\.\|>/g)) {
    const from = lineFrom + m.index!;
    const to = from + m[0].length;
    if (!overlaps(protectedSpans, from, to)) addMark(from, to, 'cm-src-code-op');
  }
  MERMAID_KEYWORDS.lastIndex = 0;
  for (const m of code.matchAll(MERMAID_KEYWORDS)) {
    const from = lineFrom + m.index!;
    const to = from + m[0].length;
    if (!overlaps(protectedSpans, from, to)) addMark(from, to, 'cm-src-code-kw');
  }
  for (const m of code.matchAll(/[\[\](){}:;]/g)) {
    const from = lineFrom + m.index!;
    if (!overlaps(protectedSpans, from, from + 1)) addMark(from, from + 1, 'cm-src-md-mark');
  }
}

function highlightGalleryLine(text: string, lineFrom: number, addMark: AddMark) {
  const img = /^(\s*)(!\[)([^\]]*)(\]\()([^)\s]+)(\)\s*)$/.exec(text);
  if (img) {
    let p = lineFrom + img[1].length;
    addMark(p, p + 2, 'cm-src-img-mark');
    p += 2;
    addMark(p, p + img[3].length, 'cm-src-img-alt');
    p += img[3].length;
    addMark(p, p + 2, 'cm-src-md-mark');
    p += 2;
    addMark(p, p + img[5].length, 'cm-src-url');
    p += img[5].length;
    addMark(p, p + 1, 'cm-src-md-mark');
    return;
  }
  const url = /^(\s*)(https?:\/\/\S+|\/api\/files\/\S+)(\s*)$/.exec(text);
  if (url) {
    const from = lineFrom + url[1].length;
    addMark(from, from + url[2].length, 'cm-src-url');
  }
}

function highlightMindmapLine(text: string, lineFrom: number, isRoot: boolean, addMark: AddMark) {
  const heading = /^(#{1,6})(\s+)(.*)$/.exec(text);
  if (heading) {
    addMark(lineFrom, lineFrom + heading[1].length, 'cm-src-h-mark');
    addMark(lineFrom + heading[1].length + heading[2].length, lineFrom + text.length, 'cm-src-code-kw');
  } else {
    const bullet = /^(\s*)([-*+]|\d+[.)])(\s+)(?:\[([ xXoOhH])\](\s+))?(.*)$/.exec(text);
    if (bullet) {
      const markFrom = lineFrom + bullet[1].length;
      addMark(markFrom, markFrom + bullet[2].length, 'cm-src-list-mark');
      if (bullet[4] !== undefined) {
        const boxFrom = markFrom + bullet[2].length + bullet[3].length;
        addMark(boxFrom, boxFrom + 3, /x/i.test(bullet[4]) ? 'cm-src-task-done-mark' : 'cm-src-task-open');
      }
    } else if (isRoot && text.trim()) {
      const lead = text.length - text.trimStart().length;
      addMark(lineFrom + lead, lineFrom + text.trimEnd().length, 'cm-src-code-kw');
    }
  }
  for (const m of text.matchAll(/`[^`\n]+`/g)) {
    addMark(lineFrom + m.index!, lineFrom + m.index! + m[0].length, 'cm-src-inline-code');
  }
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const from = lineFrom + m.index!;
    addMark(from, from + 1, 'cm-src-md-mark');
    addMark(from + 1, from + 1 + m[1].length, 'cm-src-link-text');
    addMark(from + 1 + m[1].length, from + 1 + m[1].length + 2, 'cm-src-md-mark');
    addMark(from + 3 + m[1].length, from + 3 + m[1].length + m[2].length, 'cm-src-url');
    addMark(from + m[0].length - 1, from + m[0].length, 'cm-src-md-mark');
  }
  for (const m of text.matchAll(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g)) {
    const from = lineFrom + m.index!;
    addMark(from, from + 2, 'cm-src-wiki-mark');
    addMark(from + 2, from + 2 + m[1].length, editorHost.wikiExists(m[1].split('#')[0].trim()) ? 'cm-src-wiki-target' : 'cm-src-wiki-missing');
    if (m[2] !== undefined) {
      const pipe = from + 2 + m[1].length;
      addMark(pipe, pipe + 1, 'cm-src-wiki-mark');
      addMark(pipe + 1, pipe + 1 + m[2].length, 'cm-src-wiki-alias');
    }
    addMark(from + m[0].length - 2, from + m[0].length, 'cm-src-wiki-mark');
  }
}

function resolveTaskDue(raw: string, todayStr: string, tomorrowStr: string): string {
  const word = raw.toLowerCase();
  if (word === 'heute' || word === 'today') return todayStr;
  if (word === 'morgen' || word === 'tomorrow') return tomorrowStr;
  return raw;
}

export function buildSourceDecorations(state: EditorState, visibleRanges: readonly { from: number; to: number }[]): DecorationSet {
  const doc = state.doc;
  const lineRanges = mergeLineRanges(doc, visibleRanges);
  const visMaxPos = doc.line(lineRanges[lineRanges.length - 1][1]).to;

  const tree = ensureSyntaxTree(state, visMaxPos, 150) ?? syntaxTree(state);

  const decos: Range<Decoration>[] = [];
  const lineSet = new Set<string>();
  const seenNodes = new Set<string>();
  const protectedRanges: [number, number][] = [];
  const codeLines = new Set<number>();

  const addMark: AddMark = (from, to, cls) => {
    if (from < to) decos.push(markCls(cls).range(from, to));
  };
  const addLine = (lineNum: number, cls: string) => {
    const key = `${lineNum}:${cls}`;
    if (lineSet.has(key)) return;
    lineSet.add(key);
    decos.push(lineCls(cls).range(doc.line(lineNum).from));
  };
  const markOnce = (from: number, to: number, cls: string) => {
    const key = `${cls}:${from}:${to}`;
    if (seenNodes.has(key)) return;
    seenNodes.add(key);
    addMark(from, to, cls);
  };

  const fm = findFrontmatter(doc);
  const fmEnd = fm?.endPos ?? 0;

  if (fm) {
    for (const [startL, endL] of lineRanges) {
      const fromL = Math.max(1, startL);
      const toL = Math.min(fm.endLine, endL);
      for (let l = fromL; l <= toL; l++) {
        const cls = `cm-src-fm${l === 1 ? ' cm-src-fm-first' : ''}${l === fm.endLine ? ' cm-src-fm-last' : ''}`;
        addLine(l, cls);
        const ln = doc.line(l);
        if (l === 1 || l === fm.endLine) addMark(ln.from, ln.to, 'cm-src-fm-delim');
        else highlightFrontmatterLine(ln.text, ln.from, addMark);
      }
    }
  }

  for (const [startL, endL] of lineRanges) {
    const iterFrom = Math.max(fmEnd, doc.line(startL).from);
    const iterTo = doc.line(endL).to;
    if (iterFrom >= iterTo && doc.length > 0) continue;

    tree.iterate({
      from: iterFrom,
      to: iterTo,
      enter: (ref) => {
        const node = ref.node;
        if (node.from < fmEnd) return node.to <= fmEnd ? false : undefined;

        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name) ?? /^SetextHeading(\d)$/.exec(name);
        if (heading) {
          const fromL = Math.max(startL, doc.lineAt(node.from).number);
          const toL = Math.min(endL, doc.lineAt(node.to).number);
          for (let l = fromL; l <= toL; l++) addLine(l, `cm-src-h${heading[1]}`);
          return;
        }

        switch (name) {
          case 'HeaderMark':
            markOnce(node.from, node.to, 'cm-src-h-mark');
            return;
          case 'Emphasis':
            markOnce(node.from, node.to, 'cm-src-em');
            return;
          case 'StrongEmphasis':
            markOnce(node.from, node.to, 'cm-src-strong');
            return;
          case 'Strikethrough':
            markOnce(node.from, node.to, 'cm-src-strike');
            return;
          case 'EmphasisMark':
          case 'StrikethroughMark':
            markOnce(node.from, node.to, 'cm-src-md-mark');
            return;
          case 'InlineCode':
            protectedRanges.push([node.from, node.to]);
            markOnce(node.from, node.to, 'cm-src-inline-code');
            return;
          case 'CodeMark':
            if (node.parent?.name === 'InlineCode') markOnce(node.from, node.to, 'cm-src-md-mark');
            return;
          case 'Link': {
            const marks = node.getChildren('LinkMark');
            const url = node.getChild('URL');
            const label = node.getChild('LinkLabel');
            if (!url && !label) {
              // Skip inner emphasis/brackets for Kladde's [[wikilinks]] and [^footnotes], leave [plain] prose untouched
              if (
                doc.sliceString(node.from, node.from + 2) === '[^' ||
                (node.from > 0 && doc.sliceString(node.from - 1, node.from + 1) === '[[' && doc.sliceString(node.to, node.to + 1) === ']')
              ) {
                return false;
              }
              return;
            }
            protectedRanges.push([node.from, node.to]);
            for (const m of marks) markOnce(m.from, m.to, 'cm-src-md-mark');
            if (marks.length >= 2) markOnce(marks[0].to, marks[1].from, 'cm-src-link-text');
            return;
          }
          case 'Image': {
            protectedRanges.push([node.from, node.to]);
            const marks = node.getChildren('LinkMark');
            if (marks.length >= 1) markOnce(marks[0].from, marks[0].to, 'cm-src-img-mark');
            for (let i = 1; i < marks.length; i++) markOnce(marks[i].from, marks[i].to, 'cm-src-md-mark');
            if (marks.length >= 2) markOnce(marks[0].to, marks[1].from, 'cm-src-img-alt');
            return;
          }
          case 'Autolink':
            protectedRanges.push([node.from, node.to]);
            for (const m of node.getChildren('LinkMark')) markOnce(m.from, m.to, 'cm-src-md-mark');
            return;
          case 'LinkReference':
            protectedRanges.push([node.from, node.to]);
            for (const m of node.getChildren('LinkMark')) markOnce(m.from, m.to, 'cm-src-md-mark');
            return;
          case 'LinkLabel':
            markOnce(node.from, node.to, 'cm-src-link-label');
            return;
          case 'URL':
            if (!node.parent || !/^(Link|Image|Autolink|LinkReference)$/.test(node.parent.name)) {
              protectedRanges.push([node.from, node.to]);
            }
            markOnce(node.from, node.to, 'cm-src-url');
            return;
          case 'LinkTitle':
            markOnce(node.from, node.to, 'cm-src-string');
            return;
          case 'Blockquote': {
            const fromL = Math.max(startL, doc.lineAt(node.from).number);
            const toL = Math.min(endL, doc.lineAt(node.to).number);
            for (let l = fromL; l <= toL; l++) addLine(l, 'cm-src-quote');
            return;
          }
          case 'QuoteMark':
            markOnce(node.from, node.to, 'cm-src-quote-mark');
            return;
          case 'HorizontalRule':
            markOnce(node.from, node.to, 'cm-src-hr');
            return;
          case 'ListMark':
            markOnce(node.from, node.to, 'cm-src-list-mark');
            return;
          case 'TaskMarker': {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            if (checked) {
              markOnce(node.from, node.to, 'cm-src-task-done-mark');
              const ln = doc.lineAt(node.to);
              markOnce(node.to, ln.to, 'cm-src-task-done');
            } else {
              markOnce(node.from, node.to, 'cm-src-task-open');
            }
            return;
          }
          case 'TableHeader': {
            const fromL = Math.max(startL, doc.lineAt(node.from).number);
            const toL = Math.min(endL, doc.lineAt(node.to).number);
            for (let l = fromL; l <= toL; l++) addLine(l, 'cm-src-table-head');
            return;
          }
          case 'TableDelimiter':
            markOnce(node.from, node.to, 'cm-src-table-delim');
            return;
          case 'Escape':
          case 'Entity':
            markOnce(node.from, node.to, 'cm-src-escape');
            return;
          case 'Comment':
          case 'CommentBlock':
            protectedRanges.push([node.from, node.to]);
            markOnce(node.from, node.to, 'cm-src-comment');
            return false;
          case 'HTMLTag':
          case 'HTMLBlock': {
            protectedRanges.push([node.from, node.to]);
            const key = `html:${node.from}:${node.to}`;
            if (!seenNodes.has(key)) {
              seenNodes.add(key);
              highlightHtml(doc.sliceString(node.from, node.to), node.from, addMark);
            }
            return false;
          }
          case 'CodeBlock': {
            const firstL = doc.lineAt(node.from).number;
            const lastL = doc.lineAt(node.to).number;
            const fromL = Math.max(startL, firstL);
            const toL = Math.min(endL, lastL);
            for (let l = fromL; l <= toL; l++) {
              codeLines.add(l);
              addLine(l, `cm-codeblock${l === firstL ? ' cm-codeblock-first' : ''}${l === lastL ? ' cm-codeblock-last' : ''}`);
            }
            return false;
          }
          case 'FencedCode': {
            const firstLine = doc.lineAt(node.from);
            const lastLine = doc.lineAt(node.to);
            const fromL = Math.max(startL, firstLine.number);
            const toL = Math.min(endL, lastLine.number);
            for (let l = fromL; l <= toL; l++) {
              codeLines.add(l);
              addLine(l, `cm-codeblock${l === firstLine.number ? ' cm-codeblock-first' : ''}${l === lastLine.number ? ' cm-codeblock-last' : ''}`);
            }

            for (const m of node.getChildren('CodeMark')) markOnce(m.from, m.to, 'cm-src-fence-mark');
            const info = node.getChild('CodeInfo');
            const langInfo = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : '';
            if (info) markOnce(info.from, info.to, 'cm-src-code-info');

            if (langInfo === 'query' || langInfo === 'mermaid' || langInfo === 'mindmap' || langInfo === 'gallery' || langInfo === 'carousel') {
              const hasClosing = lastLine.number > firstLine.number && /^\s*(?:```|~~~)/.test(lastLine.text);
              const bodyStart = firstLine.number + 1;
              const bodyEnd = hasClosing ? lastLine.number - 1 : lastLine.number;
              let rootFound = false;
              if (langInfo === 'mindmap') {
                for (let rl = bodyStart; rl < fromL && rl <= bodyEnd; rl++) {
                  if (doc.line(rl).text.trim()) {
                    rootFound = true;
                    break;
                  }
                }
              }
              for (let l = Math.max(fromL, bodyStart); l <= Math.min(toL, bodyEnd); l++) {
                const bodyKey = `fence-line:${l}`;
                if (seenNodes.has(bodyKey)) continue;
                seenNodes.add(bodyKey);
                const ln = doc.line(l);
                if (langInfo === 'query') highlightQueryLine(ln.text, ln.from, addMark);
                else if (langInfo === 'mermaid') highlightMermaidLine(ln.text, ln.from, addMark);
                else if (langInfo === 'gallery' || langInfo === 'carousel') highlightGalleryLine(ln.text, ln.from, addMark);
                else if (langInfo === 'mindmap') {
                  const isRoot = !rootFound && !!ln.text.trim();
                  if (isRoot) rootFound = true;
                  highlightMindmapLine(ln.text, ln.from, isRoot, addMark);
                }
              }
            }
            return false;
          }
        }
      },
    });
  }

  const now = new Date();
  const todayStr = toDateString(now);
  const tomorrowStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const fmEndLine = fm?.endLine ?? 0;

  for (const [startL, endL] of lineRanges) {
    for (let l = startL; l <= endL; l++) {
      if (l <= fmEndLine || codeLines.has(l)) continue;
      const ln = doc.line(l);

      if (TOC_ANCHOR_RE.test(ln.text)) {
        const lead = ln.text.length - ln.text.trimStart().length;
        addMark(ln.from + lead, ln.from + ln.text.trimEnd().length, 'cm-src-toc');
        continue;
      }

      // [[wikilinks]] and [[target|alias]]
      for (const m of ln.text.matchAll(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g)) {
        const from = ln.from + m.index!;
        const to = from + m[0].length;
        if (overlaps(protectedRanges, from, to)) continue;
        protectedRanges.push([from, to]);
        addMark(from, from + 2, 'cm-src-wiki-mark');
        const target = m[1];
        const exists = editorHost.wikiExists(target.split('#')[0].trim());
        addMark(from + 2, from + 2 + target.length, exists ? 'cm-src-wiki-target' : 'cm-src-wiki-missing');
        if (m[2] !== undefined) {
          const pipe = from + 2 + target.length;
          addMark(pipe, pipe + 1, 'cm-src-wiki-mark');
          addMark(pipe + 1, pipe + 1 + m[2].length, 'cm-src-wiki-alias');
        }
        addMark(to - 2, to, 'cm-src-wiki-mark');
      }

      // Footnote definition [^id]:
      const fnDef = /^(\s*)(\[\^)([^\]\s]+)(\]:)/.exec(ln.text);
      if (fnDef) {
        const from = ln.from + fnDef[1].length;
        const to = from + fnDef[2].length + fnDef[3].length + fnDef[4].length;
        if (!overlaps(protectedRanges, from, to)) {
          protectedRanges.push([from, to]);
          addMark(from, from + 2, 'cm-src-md-mark');
          addMark(from + 2, from + 2 + fnDef[3].length, 'cm-src-footnote');
          addMark(to - 2, to, 'cm-src-md-mark');
        }
      }

      // Footnote references [^id]
      for (const m of ln.text.matchAll(/(\[\^)([^\]\s]+)(\])(?!:)/g)) {
        const from = ln.from + m.index!;
        const to = from + m[0].length;
        if (overlaps(protectedRanges, from, to)) continue;
        protectedRanges.push([from, to]);
        addMark(from, from + 2, 'cm-src-md-mark');
        addMark(from + 2, from + 2 + m[2].length, 'cm-src-footnote');
        addMark(to - 1, to, 'cm-src-md-mark');
      }

      // #tags
      for (const m of ln.text.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) {
        const from = ln.from + m.index! + m[1].length;
        const to = from + m[2].length;
        if (overlaps(protectedRanges, from, to)) continue;
        protectedRanges.push([from, to]);
        addMark(from, to, 'cm-src-tag');
      }

      // Task due dates, repeat rules, and completion stamps
      if (/^\s*(?:>\s*)*[-*+]\s+\[[ xXoOhH]\]/.test(ln.text)) {
        for (const m of ln.text.matchAll(/(?:📅\s*|\bdue:)(\d{4}-\d{2}-\d{2}|heute|morgen|today|tomorrow)/gi)) {
          const from = ln.from + m.index!;
          const to = from + m[0].length;
          if (overlaps(protectedRanges, from, to)) continue;
          const dateStr = resolveTaskDue(m[1], todayStr, tomorrowStr);
          const cls = dateStr < todayStr ? 'cm-src-due-overdue' : dateStr === todayStr ? 'cm-src-due-today' : 'cm-src-due';
          addMark(from, to, cls);
        }
        for (const m of ln.text.matchAll(/(?:🔁\s*|\bevery:)((?:\d+\s*)?[\p{L},]+)/giu)) {
          const from = ln.from + m.index!;
          const to = from + m[0].length;
          if (!overlaps(protectedRanges, from, to)) addMark(from, to, 'cm-src-repeat');
        }
        for (const m of ln.text.matchAll(/✅\s*\d{4}-\d{2}-\d{2}/g)) {
          const from = ln.from + m.index!;
          const to = from + m[0].length;
          if (!overlaps(protectedRanges, from, to)) addMark(from, to, 'cm-src-done-date');
        }
      }
    }
  }

  return Decoration.set(decos, true);
}

const sourceHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildSourceDecorations(view.state, view.visibleRanges);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect)))
      ) {
        this.decorations = buildSourceDecorations(update.view.state, update.view.visibleRanges);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

export function sourceHighlight(): Extension {
  return sourceHighlightPlugin;
}
