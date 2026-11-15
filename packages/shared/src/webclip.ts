import { setFrontmatter } from './markdown.js';
import { decodeEntities } from './recipe.js';

/**
 * Web clipper (#32): turns an article page into Markdown. A small, forgiving HTML parser (one linear
 * pass, no regex over the whole page), a Readability-like pick of the main content (`<article>`,
 * `<main>`, otherwise the block with the most paragraph text) and a Markdown writer for the usual
 * article elements. Pure string work, so it runs on the server and in tests.
 */

export interface WebClip {
  title: string;
  author?: string;
  /** Publication date as YYYY-MM-DD, when the page says it */
  published?: string;
  siteName?: string;
  excerpt?: string;
  markdown: string;
  /** Absolute http(s) URLs of the images in `markdown`, in order */
  images: string[];
  sourceUrl: string;
}

// ------------------------------------------------------------------ parser

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: El | null;
  depth: number;
}
type Node = El | string;

/** Nesting limit of the parsed tree (real pages stay far below it) */
const MAX_DEPTH = 200;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Content that is not text and is skipped up to its end tag */
const RAW = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'svg', 'math', 'iframe', 'object', 'canvas', 'select']);
/** Opening one of these closes an open <p> (HTML's implied end tags, the common cases) */
const CLOSES_P = new Set(['p', 'div', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'section', 'article', 'figure', 'hr', 'header', 'footer', 'aside', 'nav', 'form', 'dl']);

const isNameChar = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === ':' || c === '_';
const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/** Parses the attributes between `from` and the end of the tag; returns them and the index after `>` */
function readAttrs(html: string, from: number): { attrs: Record<string, string>; end: number; selfClosing: boolean } {
  const attrs: Record<string, string> = {};
  let i = from;
  let selfClosing = false;
  while (i < html.length) {
    const c = html[i];
    if (c === '>') return { attrs, end: i + 1, selfClosing };
    if (c === '/') {
      selfClosing = true;
      i++;
      continue;
    }
    if (isSpace(c)) {
      i++;
      continue;
    }
    selfClosing = false;
    let name = '';
    while (i < html.length && !isSpace(html[i]) && html[i] !== '=' && html[i] !== '>' && html[i] !== '/') name += html[i++];
    while (i < html.length && isSpace(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < html.length && isSpace(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        const stop = close < 0 ? html.length : close;
        value = html.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const start = i;
        while (i < html.length && !isSpace(html[i]) && html[i] !== '>') i++;
        value = html.slice(start, i);
      }
    }
    if (name) attrs[name.toLowerCase()] = decodeEntities(value);
  }
  return { attrs, end: html.length, selfClosing };
}

/** Builds a tree from HTML in one pass; unknown end tags are ignored, unclosed elements close at the end */
export function parseHtml(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [], parent: null, depth: 0 };
  let cur = root;
  let i = 0;
  const lower = html.toLowerCase();
  const close = (tag: string) => {
    for (let el: El | null = cur; el && el !== root; el = el.parent) {
      if (el.tag === tag) {
        cur = el.parent ?? root;
        return;
      }
    }
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      cur.children.push(html.slice(i));
      break;
    }
    if (lt > i) cur.children.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html[lt + 1] === '/') {
      let j = lt + 2;
      let name = '';
      while (j < html.length && isNameChar(html[j])) name += html[j++];
      const end = html.indexOf('>', j);
      i = end < 0 ? html.length : end + 1;
      if (name) close(name.toLowerCase());
      continue;
    }
    let j = lt + 1;
    let name = '';
    while (j < html.length && isNameChar(html[j])) name += html[j++];
    if (!name) {
      cur.children.push('<');
      i = lt + 1;
      continue;
    }
    const tag = name.toLowerCase();
    const { attrs, end, selfClosing } = readAttrs(html, j);
    i = end;
    if (RAW.has(tag)) {
      const stop = lower.indexOf(`</${tag}`, i);
      const after = stop < 0 ? html.length : html.indexOf('>', stop);
      i = after < 0 ? html.length : after + 1;
      continue;
    }
    if (CLOSES_P.has(tag) && cur.tag === 'p') cur = cur.parent ?? root;
    if (tag === 'li' || tag === 'dt' || tag === 'dd' || tag === 'tr' || tag === 'td' || tag === 'th' || tag === 'option') {
      const stopAt = tag === 'li' ? ['ul', 'ol'] : tag === 'tr' ? ['table', 'tbody', 'thead', 'tfoot'] : tag === 'td' || tag === 'th' ? ['tr', 'table'] : ['dl'];
      for (let el: El | null = cur; el && el !== root && !stopAt.includes(el.tag); el = el.parent) {
        if (el.tag === tag || ((tag === 'td' || tag === 'th') && (el.tag === 'td' || el.tag === 'th')) || ((tag === 'dt' || tag === 'dd') && (el.tag === 'dt' || el.tag === 'dd'))) {
          cur = el.parent ?? root;
          break;
        }
      }
    }
    const el: El = { tag, attrs, children: [], parent: cur, depth: cur.depth + 1 };
    cur.children.push(el);
    // Deeper elements stay siblings: keeps the walk short and the writer's recursion bounded
    if (!VOID.has(tag) && !selfClosing && el.depth < MAX_DEPTH) cur = el;
  }
  return root;
}

// ------------------------------------------------------------------ helpers

const isEl = (n: Node): n is El => typeof n !== 'string';

function* walk(el: El): Generator<El> {
  const stack: El[] = [el];
  while (stack.length) {
    const e = stack.pop()!;
    yield e;
    for (let k = e.children.length - 1; k >= 0; k--) {
      const c = e.children[k];
      if (isEl(c)) stack.push(c);
    }
  }
}

const textCache = new WeakMap<El, string>();

function textOf(el: El): string {
  const hit = textCache.get(el);
  if (hit !== undefined) return hit;
  let out = '';
  const stack: Node[] = [el];
  while (stack.length) {
    const n = stack.pop()!;
    if (typeof n === 'string') out += n;
    else for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]);
  }
  const text = decodeEntities(out).replace(/\s+/g, ' ').trim();
  textCache.set(el, text);
  return text;
}

const NOISE_TAGS = new Set(['nav', 'header', 'footer', 'aside', 'form', 'button', 'input', 'label', 'dialog', 'menu']);
const NOISE_WORDS = ['comment', 'share', 'social', 'related', 'sidebar', 'footer', 'navbar', 'menu', 'cookie', 'consent', 'banner', 'advert', 'promo', 'newsletter', 'subscribe', 'breadcrumb', 'popup', 'modal', 'skip-link', 'sponsor', 'paywall', 'outbrain', 'taboola'];

/** Navigation, comments, share buttons and the like (by tag, role, class or id) */
function isNoise(el: El): boolean {
  if (NOISE_TAGS.has(el.tag)) return true;
  const role = el.attrs.role ?? '';
  if (role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'complementary' || role === 'dialog') return true;
  if (el.attrs.hidden !== undefined || el.attrs['aria-hidden'] === 'true' || /display:\s*none/i.test((el.attrs.style ?? '').slice(0, 200))) return true;
  if (el.tag === 'article' || el.tag === 'main' || el.tag === 'body') return false;
  const names = `${el.attrs.class ?? ''} ${el.attrs.id ?? ''}`.slice(0, 300).toLowerCase();
  return !!names.trim() && NOISE_WORDS.some((w) => names.includes(w));
}

function meta(root: El): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of walk(root)) {
    if (el.tag === 'meta') {
      const key = (el.attrs.property ?? el.attrs.name ?? el.attrs.itemprop ?? '').toLowerCase();
      if (key && el.attrs.content && !(key in out)) out[key] = el.attrs.content.trim();
    } else if (el.tag === 'title' && !('#title' in out)) out['#title'] = textOf(el);
    else if (el.tag === 'base' && el.attrs.href && !('#base' in out)) out['#base'] = el.attrs.href;
    else if (el.tag === 'time' && el.attrs.datetime && !('#time' in out)) out['#time'] = el.attrs.datetime;
  }
  return out;
}

/** Paragraph text a block holds directly (Readability's main signal) */
function paragraphScore(el: El): number {
  let score = 0;
  for (const c of el.children) {
    if (!isEl(c)) continue;
    if (c.tag === 'p' || c.tag === 'pre' || c.tag === 'blockquote') {
      const len = textOf(c).length;
      if (len > 25) score += len + 100 * (textOf(c).split(/[,.;]/).length - 1 > 0 ? 1 : 0);
    }
  }
  return score;
}

function linkDensity(el: El): number {
  const total = textOf(el).length || 1;
  let links = 0;
  for (const e of walk(el)) if (e.tag === 'a') links += textOf(e).length;
  return links / total;
}

/** The element that holds the article */
function mainContent(root: El): El {
  const body = [...walk(root)].find((e) => e.tag === 'body') ?? root;
  const all = [...walk(body)].filter((e) => !isNoise(e));
  const longEnough = (e: El) => textOf(e).length > 300;
  const article = all.filter((e) => e.tag === 'article' && longEnough(e)).sort((a, b) => textOf(b).length - textOf(a).length)[0];
  if (article) return article;
  const main = all.find((e) => (e.tag === 'main' || e.attrs.role === 'main' || e.attrs.itemprop === 'articleBody') && longEnough(e));
  if (main) return main;
  let best: El = body;
  let bestScore = 0;
  for (const e of all) {
    const s = paragraphScore(e) * (1 - Math.min(0.9, linkDensity(e)));
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  return best;
}

function resolveUrl(raw: string | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : u.protocol === 'mailto:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The real image of lazy-loaded pictures (data-src, srcset) */
function imageSrc(el: El): string | undefined {
  const lazy = el.attrs['data-src'] ?? el.attrs['data-lazy-src'] ?? el.attrs['data-original'];
  const src = el.attrs.src;
  if (src && !src.startsWith('data:')) return src;
  if (lazy) return lazy;
  const set = el.attrs.srcset ?? el.attrs['data-srcset'];
  if (set) {
    // The last candidate is usually the largest
    const parts = set.split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
    return parts[parts.length - 1];
  }
  return undefined;
}

/** A URL as a Markdown link target: parentheses and whitespace would end it */
export const markdownUrl = (url: string) => url.replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : '%20'));

/** Characters with a meaning in Markdown text */
const escapeMd = (s: string) => s.replace(/[\\`*_[\]]/g, (c) => `\\${c}`);
const escapeAlt = (s: string) => s.replace(/[[\]\\]/g, '');

// ------------------------------------------------------------------ Markdown writer

interface Ctx {
  base: string;
  images: string[];
  /** Inside <pre> */
  pre: boolean;
  listDepth: number;
}

function inline(nodes: Node[], ctx: Ctx): string {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') {
      const text = decodeEntities(n);
      out += ctx.pre ? text : escapeMd(text.replace(/\s+/g, ' '));
      continue;
    }
    if (isNoise(n)) continue;
    // Code keeps its text as is: no Markdown inside a fence
    if (ctx.pre) {
      out += n.tag === 'br' ? '\n' : inline(n.children, ctx);
      continue;
    }
    switch (n.tag) {
      case 'br':
        out += '  \n';
        break;
      case 'strong':
      case 'b': {
        const t = inline(n.children, ctx).trim();
        if (t) out += `**${t}**`;
        break;
      }
      case 'em':
      case 'i': {
        const t = inline(n.children, ctx).trim();
        if (t) out += `*${t}*`;
        break;
      }
      case 'del':
      case 's':
      case 'strike': {
        const t = inline(n.children, ctx).trim();
        if (t) out += `~~${t}~~`;
        break;
      }
      case 'code':
      case 'kbd':
      case 'samp': {
        const t = textOf(n);
        if (t) out += t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``;
        break;
      }
      case 'a': {
        const t = inline(n.children, ctx).trim();
        const href = resolveUrl(n.attrs.href, ctx.base);
        if (!t) break;
        out += href && !href.startsWith(`${ctx.base.split('#')[0]}#`) ? `[${t}](${markdownUrl(href)})` : t;
        break;
      }
      case 'img': {
        const src = resolveUrl(imageSrc(n), ctx.base);
        if (src && !src.startsWith('mailto:')) {
          ctx.images.push(src);
          out += `![${escapeAlt(n.attrs.alt ?? '')}](${markdownUrl(src)})`;
        }
        break;
      }
      case 'sup':
      case 'sub':
      case 'span':
      case 'small':
      case 'mark':
      case 'abbr':
      case 'cite':
      case 'q':
      case 'time':
      case 'u':
      case 'font':
      case 'picture':
      case 'label':
        out += inline(n.children, ctx);
        break;
      default:
        // A block inside inline content (a <div> in a link, …): its text, on its own
        out += ` ${blocks(n.children, ctx).trim().replace(/\n+/g, ' ')} `;
    }
  }
  return out;
}

const INLINE_TAGS = new Set(['a', 'strong', 'b', 'em', 'i', 'code', 'kbd', 'samp', 'span', 'small', 'mark', 'abbr', 'cite', 'q', 'time', 'u', 'font', 'sup', 'sub', 'del', 's', 'strike', 'br', 'img', 'picture', 'label']);

/** Collapses whitespace inside a paragraph without touching hard line breaks */
const tidy = (s: string) =>
  s
    .split('  \n')
    .map((part) => part.replace(/ {2,}/g, ' ').trim())
    .join('  \n')
    .trim();

function blocks(nodes: Node[], ctx: Ctx): string {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const t = tidy(inline(run, ctx));
    if (t) out.push(t);
    run = [];
  };
  for (const n of nodes) {
    if (typeof n === 'string' || INLINE_TAGS.has(n.tag)) {
      run.push(n);
      continue;
    }
    flush();
    if (isNoise(n)) continue;
    const block = blockOf(n, ctx);
    if (block) out.push(block);
  }
  flush();
  return out.join('\n\n');
}

function listOf(el: El, ctx: Ctx): string {
  const ordered = el.tag === 'ol';
  let index = Number(el.attrs.start) || 1;
  const pad = '   '.repeat(ctx.listDepth);
  const lines: string[] = [];
  for (const c of el.children) {
    if (!isEl(c) || c.tag !== 'li') continue;
    const marker = ordered ? `${index++}. ` : '- ';
    const inner = blocks(c.children, { ...ctx, listDepth: ctx.listDepth + 1 });
    // A nested list follows its item's text directly, without a blank line
    const innerLines = inner.split('\n');
    const [first, ...rest] = innerLines.filter((l, k) => l !== '' || !/^\s*(?:[-*]|\d+\.) /.test(innerLines[k + 1] ?? ''));
    lines.push(`${pad}${marker}${first ?? ''}`);
    // Nested lists keep their own indentation; continuation paragraphs are indented under the item
    for (const line of rest) lines.push(line && !line.startsWith(pad + '   ') && !/^\s*([-*]|\d+\.) /.test(line) ? `${pad}   ${line}` : line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function tableOf(el: El, ctx: Ctx): string {
  const rows: string[][] = [];
  for (const e of walk(el)) {
    if (e.tag !== 'tr') continue;
    const cells = e.children.filter(isEl).filter((c) => c.tag === 'td' || c.tag === 'th');
    if (cells.length) rows.push(cells.map((c) => tidy(inline(c.children, ctx)).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')));
  }
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

function blockOf(el: El, ctx: Ctx): string {
  switch (el.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const t = tidy(inline(el.children, ctx)).replace(/\s*\n\s*/g, ' ');
      // The article's own title is the note title; headings start at level 2
      return t ? `${'#'.repeat(Math.min(6, Math.max(2, Number(el.tag[1]))))} ${t}` : '';
    }
    case 'p':
      return tidy(inline(el.children, ctx));
    case 'hr':
      return '---';
    case 'pre': {
      const body = inline(el.children, { ...ctx, pre: true }).replace(/^\n+|\s+$/g, '');
      const lang = /(?:lang(?:uage)?-)([\w+-]+)/.exec(`${el.attrs.class ?? ''} ${[...walk(el)].find((e) => e.tag === 'code')?.attrs.class ?? ''}`.slice(0, 200))?.[1] ?? '';
      const fence = body.includes('```') ? '~~~' : '```';
      return body ? `${fence}${lang}\n${body}\n${fence}` : '';
    }
    case 'blockquote': {
      const inner = blocks(el.children, ctx);
      return inner ? inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') : '';
    }
    case 'ul':
    case 'ol':
      return listOf(el, ctx);
    case 'table':
      return tableOf(el, ctx);
    case 'figure': {
      const caption = el.children.filter(isEl).find((c) => c.tag === 'figcaption');
      const rest = blocks(el.children.filter((c) => c !== caption), ctx);
      const cap = caption ? tidy(inline(caption.children, ctx)) : '';
      return [rest, cap ? `*${cap}*` : ''].filter(Boolean).join('\n\n');
    }
    case 'dl':
      return el.children
        .filter(isEl)
        .map((c) => (c.tag === 'dt' ? `**${tidy(inline(c.children, ctx))}**` : c.tag === 'dd' ? tidy(inline(c.children, ctx)) : ''))
        .filter(Boolean)
        .join('\n\n');
    default:
      return blocks(el.children, ctx);
  }
}

// ------------------------------------------------------------------ public

const dateOnly = (s: string | undefined) => /^\d{4}-\d{2}-\d{2}/.exec(s ?? '')?.[0];

/** The main content of a page as Markdown, with title, author, date and site name from its metadata */
export function extractWebClip(html: string, pageUrl: string): WebClip {
  const root = parseHtml(html);
  const m = meta(root);
  const base = resolveUrl(m['#base'], pageUrl) ?? pageUrl;
  const content = mainContent(root);
  const ctx: Ctx = { base, images: [], pre: false, listDepth: 0 };
  let markdown = blocks(content.children, ctx).replace(/\n{3,}/g, '\n\n').trim();
  const h1 = [...walk(content)].find((e) => e.tag === 'h1');
  const title = (m['og:title'] ?? m['twitter:title'] ?? (h1 ? textOf(h1) : '') ?? '').trim() || (m['#title'] ?? '').trim() || new URL(pageUrl).hostname;
  // The title is the note's name: drop a first heading that repeats it
  const firstLine = markdown.split('\n')[0];
  if (/^#{1,6} /.test(firstLine) && firstLine.replace(/^#+ /, '').replace(/\\/g, '').trim() === title) markdown = markdown.slice(firstLine.length).trim();
  const author = (m.author ?? m['article:author'] ?? m['twitter:creator'] ?? '').trim();
  return {
    title: decodeEntities(title).replace(/\s+/g, ' ').slice(0, 200),
    author: author && !/^https?:/i.test(author) ? author.slice(0, 120) : undefined,
    published: dateOnly(m['article:published_time'] ?? m.date ?? m.datepublished ?? m['#time']),
    siteName: m['og:site_name']?.slice(0, 120),
    excerpt: (m['og:description'] ?? m.description)?.slice(0, 500),
    markdown,
    images: [...new Set(ctx.images)],
    sourceUrl: pageUrl,
  };
}

/** A note title from the clip: no characters that break paths or links */
export function webClipTitle(clip: Pick<WebClip, 'title'>): string {
  return clip.title.replace(/[\\/:#[\]|*?"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Web-Clip';
}

/** The note: frontmatter with source, author and clip date, then the article */
export function webClipToMarkdown(clip: WebClip, clipped: string, selection?: string): string {
  const body = selection?.trim()
    ? selection
        .trim()
        .split('\n')
        .map((l) => (l.trim() ? `> ${l.trim()}` : '>'))
        .join('\n')
    : clip.markdown || clip.excerpt || '';
  const fm: Record<string, string | null> = {
    source: clip.sourceUrl,
    author: clip.author ? clip.author.replace(/\n/g, ' ') : null,
    published: clip.published ?? null,
    site: clip.siteName ? clip.siteName.replace(/\n/g, ' ') : null,
    clipped,
  };
  return setFrontmatter(`${body}\n`, fm);
}
