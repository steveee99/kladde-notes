import type { VariableScope } from './variables.js';
import { parseMarkdownForExport, type ExportBlock, type ExportInline, type ExportListItem } from './export.js';
import { extractMeta } from './markdown.js';
import { formatValue, type QueryResult } from './query.js';
import { safeUrl } from './util.js';

// ------------------------------------------------------------------ API types (#48)

export type ConfluenceKind = 'cloud' | 'datacenter';

/** The saved connection as the client sees it: the token never leaves the server again */
export interface ConfluenceConnectionInfo {
  url: string;
  kind: ConfluenceKind;
  /** Cloud: the Atlassian account e-mail that goes with the API token */
  email: string;
  accountName: string;
  updatedAt: number;
}

export interface ConfluenceConnectionInput {
  url: string;
  kind: ConfluenceKind;
  email?: string;
  /** Empty when only the other fields change: the saved token stays */
  token?: string;
}

export interface ConfluenceSpace {
  key: string;
  name: string;
}

export interface ConfluencePageRef {
  id: string;
  title: string;
  spaceKey: string;
  url: string;
}

/** What a pasted Confluence link points to: the space and, for a page link, the page */
export interface ConfluenceLinkTarget {
  space: ConfluenceSpace;
  page: ConfluencePageRef | null;
}

/** The parts of a Confluence address that identify a page or a space (see parseConfluenceLink) */
export interface ConfluenceLinkParts {
  host: string;
  pageId?: string;
  spaceKey?: string;
  /** Page title from a Data Center address like /display/KEY/Page+Title */
  title?: string;
}

const SPACE_KEY = /^~?[A-Za-z0-9_-]{1,255}$/;
const PAGE_ID = /^\d{1,20}$/;

/** Short links (/x/AbC) carry the page id as little-endian bytes in a URL-safe base64 variant */
function tinyLinkPageId(code: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,11}$/.test(code)) return undefined;
  let b64 = code.replace(/-/g, '/').replace(/_/g, '+');
  b64 = b64.padEnd(11, 'A') + '=';
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return undefined;
  }
  let id = 0n;
  for (let i = bin.length - 1; i >= 0; i--) id = (id << 8n) | BigInt(bin.charCodeAt(i));
  return id > 0n ? id.toString() : undefined;
}

/**
 * Reads the page id or space key from an address copied from the browser (Cloud and Data Center):
 * /spaces/KEY/pages/123/Title, /spaces/KEY/pages/edit-v2/123, viewpage.action?pageId=123,
 * /display/KEY/Page+Title, /spaces/KEY/overview, /display/KEY, viewspace.action?key=KEY, /x/AbC.
 * null when it is not an http(s) address or names neither.
 */
export function parseConfluenceLink(raw: string): ConfluenceLinkParts | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.host.toLowerCase();
  const pageId = url.searchParams.get('pageId');
  if (pageId && PAGE_ID.test(pageId)) return { host, pageId };
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    });
  const at = (name: string) => segments.indexOf(name);

  const spaces = at('spaces');
  if (spaces >= 0 && segments[spaces + 1] && SPACE_KEY.test(segments[spaces + 1])) {
    const spaceKey = segments[spaces + 1];
    const rest = segments.slice(spaces + 2);
    if (rest[0] === 'pages') {
      const id = rest.slice(1, 3).find((s) => PAGE_ID.test(s));
      if (id) return { host, spaceKey, pageId: id };
    }
    return { host, spaceKey };
  }
  const display = at('display');
  if (display >= 0 && segments[display + 1] && SPACE_KEY.test(segments[display + 1])) {
    const spaceKey = segments[display + 1];
    const title = segments[display + 2]?.trim();
    return title ? { host, spaceKey, title } : { host, spaceKey };
  }
  const x = at('x');
  if (x >= 0 && segments[x + 1]) {
    const id = tinyLinkPageId(url.pathname.split('/').filter(Boolean)[x + 1]);
    if (id) return { host, pageId: id };
  }
  const key = url.searchParams.get('spaceKey') ?? url.searchParams.get('key');
  if (key && SPACE_KEY.test(key)) return { host, spaceKey: key };
  return null;
}

export type ConfluenceNoteStatus = 'pending' | 'ok' | 'error' | 'conflict';

/** Sync state of one note (side panel, note dialog) */
export interface ConfluenceNoteState {
  noteId: string;
  syncId: string;
  pageId: string | null;
  pageUrl: string | null;
  status: ConfluenceNoteStatus;
  error: string | null;
  lastSyncAt: number | null;
}

export interface ConfluenceSyncInput {
  kind: 'note' | 'folder';
  noteId?: string;
  folder?: string;
  spaceKey: string;
  parentId?: string | null;
  parentTitle?: string | null;
  /** Deleting (or moving a note out of a synced folder) moves its page to the Confluence trash */
  trashOnDelete?: boolean;
}

export interface ConfluenceSyncInfo {
  id: string;
  kind: 'note' | 'folder';
  /** Note title or folder path */
  label: string;
  noteId: string | null;
  folder: string | null;
  spaceKey: string;
  parentId: string | null;
  parentTitle: string | null;
  trashOnDelete: boolean;
  createdAt: number;
  /** Folder page (folder sync) or the note's page */
  pageUrl: string | null;
  notes: number;
  errors: number;
  conflicts: number;
  lastSyncAt: number | null;
}

export interface ConfluenceOverview {
  connection: ConfluenceConnectionInfo | null;
  syncs: ConfluenceSyncInfo[];
  /** Note id → state, for the badge in the note view */
  notes: Record<string, ConfluenceNoteStatus>;
}

// ------------------------------------------------------------------ conversion

/** What the converter needs to know about the rest of the space */
export interface ConfluenceConvertContext {
  /** The page title a `[[link]]` target is synced as (null: not synced, the link becomes plain text) */
  linkTitle?: (target: string) => string | null;
  /** Attachment by URL (`/api/files/<id>`): the file name it gets on the page */
  attachment?: (url: string) => { fileId: string; filename: string; mime: string } | null;
  /** Current result of a `query` block (null: left out with a hint) */
  query?: (source: string) => QueryResult | null;
  spaceKey?: string;
  /** Fills `{{var:name}}` placeholders */
  variables?: VariableScope;
}

export interface ConfluencePage {
  title: string;
  /** XHTML in the Confluence storage format */
  body: string;
  labels: string[];
  /** Attachments the body references; they must be uploaded to the page */
  attachments: { fileId: string; filename: string; mime: string }[];
}

const KLADDE_ONLY: Record<string, string> = {
  mermaid: 'Mermaid-Diagramm',
  mindmap: 'Mindmap',
  excalidraw: 'Zeichnung',
  datatable: 'Datentabelle',
};

/** XML text escaping for the storage format (XHTML: no named entities besides the XML ones) */
export function xmlEscape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** CDATA cannot contain "]]>": split it across two sections */
export function cdata(text: string): string {
  return `<![CDATA[${text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** Removes a character from both ends without a regex (linear also for long runs of it) */
export function trimChar(text: string, ch: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === ch) start++;
  while (end > start && text[end - 1] === ch) end--;
  return text.slice(start, end);
}

/** Confluence labels: lowercase, no spaces or punctuation besides - and _ */
export function confluenceLabel(tag: string): string {
  const dashed = tag
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[\s/:;,.?&[\]()#^*@!<>"'|\\]+/g, '-');
  return trimChar(dashed, '-').slice(0, 255);
}

const CALLOUTS: Record<string, string> = {
  note: 'info',
  info: 'info',
  abstract: 'info',
  summary: 'info',
  todo: 'info',
  quote: 'info',
  example: 'info',
  tip: 'tip',
  hint: 'tip',
  important: 'tip',
  success: 'tip',
  check: 'tip',
  done: 'tip',
  question: 'note',
  help: 'note',
  faq: 'note',
  warning: 'note',
  caution: 'note',
  attention: 'note',
  danger: 'warning',
  error: 'warning',
  bug: 'warning',
  failure: 'warning',
  fail: 'warning',
};

const EMBED_LINE = /^\s*!\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]\s*$/;

/** Turns a note into a Confluence page (title, storage format body, labels and attachments to upload) */
export function markdownToConfluence(path: string, content: string, ctx: ConfluenceConvertContext = {}): ConfluencePage {
  const meta = extractMeta(path, content);
  const attachments = new Map<string, { fileId: string; filename: string; mime: string }>();
  const useAttachment = (url: string) => {
    const a = ctx.attachment?.(url) ?? null;
    if (a) attachments.set(a.fileId, a);
    return a;
  };

  // Embeds of other notes (![[Note]]) are Kladde-only: they become a link or a hint (marked before parsing)
  const embeds: string[] = [];
  const prepared = content
    .split('\n')
    .map((line) => {
      const m = EMBED_LINE.exec(line);
      if (!m) return line;
      embeds.push(m[1].split('#')[0].trim());
      return `KLADDEEMBED${embeds.length - 1}KLADDEEMBED`;
    })
    .join('\n');

  const doc = parseMarkdownForExport(meta.title, prepared, ctx.variables);
  let blocks = doc.blocks;
  // Confluence shows the title above the page: drop a leading H1 that repeats it
  if (doc.hasLeadingH1 && blocks[0].type === 'heading' && inlineText(blocks[0].inlines).trim() === meta.title.trim()) blocks = blocks.slice(1);

  const inline = (spans: ExportInline[]): string => spans.map(renderInline).join('');

  const renderInline = (span: ExportInline): string => {
    switch (span.type) {
      case 'text':
        return xmlEscape(span.text);
      case 'strong':
        return `<strong>${xmlEscape(span.text)}</strong>`;
      case 'em':
        return `<em>${xmlEscape(span.text)}</em>`;
      case 'strike':
        return `<s>${xmlEscape(span.text)}</s>`;
      case 'code':
        return `<code>${xmlEscape(span.text)}</code>`;
      case 'tag':
        return xmlEscape(span.text);
      case 'footnoteRef':
        return `<sup>[${xmlEscape(span.id)}]</sup>`;
      case 'math':
        // Confluence has no formulas of its own: the TeX source as code
        return `<code>${xmlEscape(span.display ? `$$${span.tex}$$` : `$${span.tex}$`)}</code>`;
      case 'wikilink': {
        const title = ctx.linkTitle?.(span.target) ?? null;
        if (!title) return xmlEscape(span.label);
        const space = ctx.spaceKey ? ` ri:space-key="${xmlEscape(ctx.spaceKey)}"` : '';
        return `<ac:link><ri:page ri:content-title="${xmlEscape(title)}"${space} /><ac:plain-text-link-body>${cdata(span.label)}</ac:plain-text-link-body></ac:link>`;
      }
      case 'link': {
        const file = useAttachment(span.url);
        if (file) {
          return `<ac:link><ri:attachment ri:filename="${xmlEscape(file.filename)}" /><ac:plain-text-link-body>${cdata(span.text.replace(/^\[|\]$/g, ''))}</ac:plain-text-link-body></ac:link>`;
        }
        const href = safeUrl(span.url);
        if (!href || !/^(https?:|mailto:)/i.test(href)) return xmlEscape(span.text);
        return `<a href="${xmlEscape(href)}">${xmlEscape(span.text)}</a>`;
      }
    }
  };

  const image = (alt: string, url: string): string => {
    const file = useAttachment(url);
    if (file) {
      if (file.mime === 'application/pdf') {
        return `<ac:structured-macro ac:name="view-file"><ac:parameter ac:name="name"><ri:attachment ri:filename="${xmlEscape(file.filename)}" /></ac:parameter><ac:parameter ac:name="height">600</ac:parameter></ac:structured-macro>`;
      }
      if (file.mime.startsWith('image/')) {
        return `<p><ac:image${alt ? ` ac:alt="${xmlEscape(alt)}"` : ''}><ri:attachment ri:filename="${xmlEscape(file.filename)}" /></ac:image></p>`;
      }
      return `<p><ac:link><ri:attachment ri:filename="${xmlEscape(file.filename)}" /></ac:link></p>`;
    }
    const href = safeUrl(url);
    if (href && /^https?:/i.test(href)) return `<p><ac:image${alt ? ` ac:alt="${xmlEscape(alt)}"` : ''}><ri:url ri:value="${xmlEscape(href)}" /></ac:image></p>`;
    return alt ? `<p>${xmlEscape(alt)}</p>` : '';
  };

  const hint = (text: string) => `<p><em>${xmlEscape(text)}</em></p>`;

  const renderQuery = (source: string): string => {
    let result: QueryResult | null;
    try {
      result = ctx.query?.(source) ?? null;
    } catch {
      result = null;
    }
    if (!result) return hint('(Kladde-Abfrage – in Confluence nicht verfügbar)');
    const titleOf = (row: QueryResult['rows'][number]) => String(row.values.title ?? row.path);
    const linked = (row: QueryResult['rows'][number]) => {
      const t = titleOf(row);
      return renderInline({ type: 'wikilink', target: t, label: t });
    };
    const mode = result.query.mode;
    if (!result.rows.length) return hint('(Keine Ergebnisse)');
    if (mode === 'tasks') {
      return `<ac:task-list>${result.rows
        .map((r) => `<ac:task><ac:task-status>${r.values.done ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body>${xmlEscape(String(r.values.text ?? ''))}</ac:task-body></ac:task>`)
        .join('')}</ac:task-list>`;
    }
    if (mode === 'table') {
      const res = result;
      const head = `<tr>${res.columns.map((c) => `<th>${xmlEscape(c)}</th>`).join('')}</tr>`;
      const rowsOf = (rows: QueryResult['rows']) =>
        rows.map((r) => `<tr>${res.columns.map((c) => `<td>${c === 'title' ? linked(r) : xmlEscape(formatValue(r.values[c]))}</td>`).join('')}</tr>`).join('');
      // Aggregates (#77): a bold row; the first cell names it unless it holds an aggregate itself
      const footer = (values: Record<string, unknown> | undefined, name: string) =>
        values ? `<tr>${res.columns.map((c, i) => `<td><strong>${xmlEscape(c in values ? formatValue(values[c]) : i === 0 ? name : '')}</strong></td>`).join('')}</tr>` : '';
      const groupBy = res.query.groupBy ?? '';
      if (res.groups && res.summary) {
        const rows = res.groups
          .map((g) => `<tr>${res.columns.map((c) => `<td>${xmlEscape(c === groupBy ? g.key || '–' : formatValue(g.aggregates[c]))}</td>`).join('')}</tr>`)
          .join('');
        return `<table><tbody>${head}${rows}${footer(res.totals, 'Gesamt')}</tbody></table>`;
      }
      if (res.groups) {
        return (
          res.groups
            .map((g) => `<h4>${xmlEscape(g.key || '–')} (${g.rows.length})</h4><table><tbody>${head}${rowsOf(g.rows)}${res.totals ? footer(g.aggregates, '') : ''}</tbody></table>`)
            .join('') + (res.totals ? `<table><tbody>${head}${footer(res.totals, 'Gesamt')}</tbody></table>` : '')
        );
      }
      return `<table><tbody>${head}${rowsOf(res.rows)}${footer(res.totals, 'Gesamt')}</tbody></table>`;
    }
    if (result.groups) {
      return result.groups.map((g) => `<h4>${xmlEscape(g.key || '–')} (${g.rows.length})</h4><ul>${g.rows.map((r) => `<li>${linked(r)}</li>`).join('')}</ul>`).join('');
    }
    if (result.lanes?.length) {
      return result.lanes.map((lane) => `<h4>${xmlEscape(lane.value || '–')}</h4><ul>${lane.rows.map((r) => `<li>${linked(r)}</li>`).join('')}</ul>`).join('');
    }
    return `<ul>${result.rows.map((r) => `<li>${linked(r)}</li>`).join('')}</ul>`;
  };

  const renderList = (items: ExportListItem[], ordered: boolean): string => {
    // Nested by indent; consecutive task items become a Confluence task list
    let i = 0;
    const level = (indent: number): string => {
      const groups: string[] = [];
      let plain: string[] = [];
      let tasks: string[] = [];
      const flush = () => {
        if (plain.length) groups.push(`<${ordered ? 'ol' : 'ul'}>${plain.join('')}</${ordered ? 'ol' : 'ul'}>`);
        if (tasks.length) groups.push(`<ac:task-list>${tasks.join('')}</ac:task-list>`);
        plain = [];
        tasks = [];
      };
      while (i < items.length && items[i].indent >= indent) {
        const item = items[i];
        if (item.indent > indent) {
          // Deeper item without a parent on this level
          const nested = level(item.indent);
          if (plain.length) plain[plain.length - 1] = plain[plain.length - 1].replace(/<\/li>$/, `${nested}</li>`);
          else groups.push(nested);
          continue;
        }
        i++;
        const children = i < items.length && items[i].indent > indent ? level(items[i].indent) : '';
        if (item.checked !== undefined) {
          if (plain.length) flush();
          tasks.push(`<ac:task><ac:task-status>${item.checked ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body>${inline(item.inlines)}${children}</ac:task-body></ac:task>`);
        } else {
          if (tasks.length) flush();
          plain.push(`<li>${inline(item.inlines)}${children}</li>`);
        }
      }
      flush();
      return groups.join('');
    };
    const out: string[] = [];
    while (i < items.length) out.push(level(items[i].indent));
    return out.join('');
  };

  const renderBlock = (block: ExportBlock): string => {
    switch (block.type) {
      case 'heading':
        return `<h${block.level}>${inline(block.inlines)}</h${block.level}>`;
      case 'paragraph': {
        const only = block.inlines.length === 1 && block.inlines[0].type === 'text' ? /^KLADDEEMBED(\d+)KLADDEEMBED$/.exec(block.inlines[0].text.trim()) : null;
        if (only) {
          const target = embeds[Number(only[1])] ?? '';
          const title = ctx.linkTitle?.(target) ?? null;
          return title
            ? `<p><em>Eingebettet: </em>${renderInline({ type: 'wikilink', target, label: title })}</p>`
            : hint(`(Eingebettete Kladde-Notiz „${target}“ – in Confluence nicht verfügbar)`);
        }
        return `<p>${inline(block.inlines)}</p>`;
      }
      case 'list':
        return renderList(block.items, block.ordered);
      case 'blockquote': {
        if (block.callout) {
          const macro = CALLOUTS[block.callout.type] ?? CALLOUTS[block.callout.kind] ?? 'info';
          const title = inlineText(block.callout.titleInlines).trim();
          const body = block.lines.map((l) => `<p>${inline(l)}</p>`).join('');
          return `<ac:structured-macro ac:name="${macro}">${title ? `<ac:parameter ac:name="title">${xmlEscape(title)}</ac:parameter>` : ''}<ac:rich-text-body>${body || '<p />'}</ac:rich-text-body></ac:structured-macro>`;
        }
        return `<blockquote>${block.lines.map((l) => `<p>${inline(l)}</p>`).join('')}</blockquote>`;
      }
      case 'code': {
        if (block.lang === 'query') return renderQuery(block.code);
        const only = KLADDE_ONLY[block.lang];
        if (only) return `${hint(`(${only} aus Kladde – hier als Quelltext)`)}${codeMacro('text', block.code)}`;
        return codeMacro(block.lang, block.code, block.title);
      }
      case 'table': {
        const head = `<tr>${block.headers.map((h) => `<th>${inline(h)}</th>`).join('')}</tr>`;
        const rows = block.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
        return `<table><tbody>${head}${rows}</tbody></table>`;
      }
      case 'image':
        return image(block.alt, block.url);
      case 'hr':
        return '<hr />';
      case 'toc':
        return '<ac:structured-macro ac:name="toc" />';
      case 'footnote':
        return `<p><sup>[${xmlEscape(block.id)}]</sup> ${inline(block.inlines)}</p>`;
      case 'math':
        return codeMacro('text', block.tex);
    }
  };

  const body = blocks.map(renderBlock).join('\n');
  const labels = [...new Set(meta.tags.map(confluenceLabel).filter(Boolean))];
  return { title: meta.title.trim() || 'Ohne Titel', body, labels, attachments: [...attachments.values()] };
}

/** Languages the Confluence code macro knows; others are shown as plain text */
const CODE_LANGS = new Set([
  'actionscript3', 'applescript', 'bash', 'c#', 'cpp', 'css', 'coldfusion', 'delphi', 'diff', 'erl', 'groovy', 'html', 'xml', 'java', 'javafx',
  'js', 'json', 'php', 'perl', 'powershell', 'py', 'python', 'ruby', 'sass', 'scala', 'sql', 'swift', 'text', 'vb', 'yaml', 'go', 'kotlin', 'typescript',
]);
const LANG_ALIASES: Record<string, string> = { sh: 'bash', shell: 'bash', zsh: 'bash', javascript: 'js', ts: 'typescript', csharp: 'c#', cs: 'c#', 'c++': 'cpp', c: 'cpp', yml: 'yaml', golang: 'go', kt: 'kotlin', rb: 'ruby', ps1: 'powershell', htm: 'html', md: 'text', markdown: 'text', '': 'text' };

function codeMacro(lang: string, code: string, title?: string): string {
  const l = LANG_ALIASES[lang] ?? lang;
  const language = CODE_LANGS.has(l) ? l : 'text';
  const titleParam = title ? `<ac:parameter ac:name="title">${xmlEscape(title)}</ac:parameter>` : '';
  return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${xmlEscape(language)}</ac:parameter>${titleParam}<ac:plain-text-body>${cdata(code)}</ac:plain-text-body></ac:structured-macro>`;
}

function inlineText(spans: ExportInline[]): string {
  return spans.map((s) => (s.type === 'wikilink' ? s.label : s.type === 'footnoteRef' ? `[${s.id}]` : s.type === 'math' ? s.tex : s.text)).join('');
}

/** Body of a folder page: a hint and Confluence's list of child pages */
export function confluenceFolderBody(): string {
  return '<p><em>Ordner aus Kladde</em></p><ac:structured-macro ac:name="children"><ac:parameter ac:name="all">true</ac:parameter></ac:structured-macro>';
}
