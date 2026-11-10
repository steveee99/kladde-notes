import { extractHeadings, parseFrontmatter, TOC_ANCHOR_RE } from './markdown.js';

export type TableAlign = 'left' | 'center' | 'right' | null;

export type ExportInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'strike'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'wikilink'; target: string; label: string }
  | { type: 'tag'; text: string }
  | { type: 'footnoteRef'; id: string };

export interface ExportListItem {
  indent: number;
  checked?: boolean;
  inlines: ExportInline[];
}

export type ExportBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: ExportInline[] }
  | { type: 'paragraph'; inlines: ExportInline[] }
  | { type: 'list'; ordered: boolean; items: ExportListItem[] }
  | { type: 'blockquote'; lines: ExportInline[][] }
  | { type: 'code'; lang: string; code: string }
  | { type: 'table'; headers: ExportInline[][]; align: TableAlign[]; rows: ExportInline[][][] }
  | { type: 'image'; alt: string; url: string }
  | { type: 'hr' }
  | { type: 'toc'; items: { level: 1 | 2 | 3 | 4 | 5 | 6; text: string }[] }
  | { type: 'footnote'; id: string; inlines: ExportInline[] };

export interface ExportDocument {
  title: string;
  body: string;
  hasLeadingH1: boolean;
  blocks: ExportBlock[];
}

/** Removes YAML frontmatter from a Markdown note (including leading empty frontmatter) */
export function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (/^---\n---\n?/.test(normalized)) {
    return normalized.replace(/^---\n---\n?/, '').replace(/^\n+/, '');
  }
  const { body } = parseFrontmatter(normalized);
  return body.replace(/^\n+/, '');
}

/** Sanitizes a note title for use as a downloadable file name */
export function safeExportFilename(title: string, ext: string, fallback = 'Notiz'): string {
  const base = (title || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  const cleanExt = ext.replace(/^\./, '');
  return `${base || fallback}.${cleanExt}`;
}

/** Parses inline Markdown formatting (code, bold, italic, strike, links, wikilinks, footnote refs) */
export function parseExportInlines(text: string): ExportInline[] {
  const out: ExportInline[] = [];
  let rest = text;

  const pushText = (s: string) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text') prev.text += s;
    else out.push({ type: 'text', text: s });
  };

  // Match highest-precedence inline tokens from left to right
  const pattern =
    /(`[^`\n]+`|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|(?<!\w)_([^_\n]+)_(?!\w)|\[\^([A-Za-z0-9_-]+)\]|(https?:\/\/[^\s<>)"]+))/;

  while (rest.length > 0) {
    const m = pattern.exec(rest);
    if (!m) {
      pushText(rest);
      break;
    }
    if (m.index > 0) pushText(rest.slice(0, m.index));

    if (m[1].startsWith('`')) {
      out.push({ type: 'code', text: m[1].slice(1, -1) });
    } else if (m[2] !== undefined && m[3] !== undefined) {
      // Inline image fallback as link/label when nested inside a paragraph or list item
      const label = m[2].trim() || 'Bild';
      out.push({ type: 'link', text: `[${label}]`, url: m[3] });
    } else if (m[4] !== undefined && m[5] !== undefined) {
      out.push({ type: 'link', text: m[4], url: m[5] });
    } else if (m[6] !== undefined) {
      const target = m[6].split('#')[0].trim();
      const label = (m[7] ?? m[6].replace(/#/, ' › ')).trim();
      out.push({ type: 'wikilink', target, label });
    } else if (m[8] !== undefined) {
      out.push({ type: 'strong', text: m[8] });
    } else if (m[9] !== undefined) {
      out.push({ type: 'strong', text: m[9] });
    } else if (m[10] !== undefined) {
      out.push({ type: 'strike', text: m[10] });
    } else if (m[11] !== undefined) {
      out.push({ type: 'em', text: m[11] });
    } else if (m[12] !== undefined) {
      out.push({ type: 'em', text: m[12] });
    } else if (m[13] !== undefined) {
      out.push({ type: 'footnoteRef', id: m[13] });
    } else if (m[14] !== undefined) {
      out.push({ type: 'link', text: m[14], url: m[14] });
    }

    rest = rest.slice(m.index + m[0].length);
  }

  return out.length ? out : [{ type: 'text', text: '' }];
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (trimmed[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += trimmed[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseTableAlignRow(line: string): TableAlign[] | null {
  const cells = splitTableCells(line);
  if (!cells.length) return null;
  const aligns: TableAlign[] = [];
  for (const c of cells) {
    if (!/^:?-{2,}:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
    else if (c.endsWith(':')) aligns.push('right');
    else if (c.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

/** Parses Markdown without frontmatter into structured blocks for Word/PDF export */
export function parseMarkdownForExport(title: string, content: string): ExportDocument {
  const body = stripFrontmatter(content);
  const headings = extractHeadings(body).map((h) => ({ level: h.level, text: h.text }));
  const lines = body.split('\n');
  const blocks: ExportBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block (including mermaid, mindmap, gallery, carousel, query)
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const len = fence[1].length;
      const lang = fence[2].trim().toLowerCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        if (new RegExp(`^\\s*${marker}{${len},}\\s*$`).test(lines[i])) {
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      const code = codeLines.join('\n');
      if (lang === 'gallery' || lang === 'carousel') {
        for (const gLine of codeLines) {
          const mdImg = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(gLine);
          const bareUrl = /^\s*(https?:\/\/\S+|\/api\/files\/\S+)\s*$/.exec(gLine);
          if (mdImg) blocks.push({ type: 'image', alt: mdImg[1], url: mdImg[2] });
          else if (bareUrl) blocks.push({ type: 'image', alt: '', url: bareUrl[1] });
        }
      } else {
        blocks.push({ type: 'code', lang, code });
      }
      continue;
    }

    // Table of contents anchor (##TOC## / [[TOC]])
    if (TOC_ANCHOR_RE.test(line)) {
      blocks.push({ type: 'toc', items: headings });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // ATX Heading
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        inlines: parseExportInlines(heading[2].trim()),
      });
      i++;
      continue;
    }

    // Standalone image block ![alt](url)
    const imgMatch = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (imgMatch) {
      blocks.push({ type: 'image', alt: imgMatch[1], url: imgMatch[2] });
      i++;
      continue;
    }

    // Footnote definition [^id]: text
    const fnMatch = /^\s*\[\^([A-Za-z0-9_-]+)\]:\s*(.+)$/.exec(line);
    if (fnMatch) {
      blocks.push({ type: 'footnote', id: fnMatch[1], inlines: parseExportInlines(fnMatch[2].trim()) });
      i++;
      continue;
    }

    // GFM pipe table
    if (line.includes('|') && i + 1 < lines.length) {
      const align = parseTableAlignRow(lines[i + 1]);
      if (align) {
        const rawHeaders = splitTableCells(line);
        const colCount = Math.max(rawHeaders.length, align.length);
        const headers = Array.from({ length: colCount }, (_, c) => parseExportInlines(rawHeaders[c] ?? ''));
        const rows: ExportInline[][][] = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const cells = splitTableCells(lines[i]);
          rows.push(Array.from({ length: colCount }, (_, c) => parseExportInlines(cells[c] ?? '')));
          i++;
        }
        blocks.push({ type: 'table', headers, align, rows });
        continue;
      }
    }

    // Blockquote
    if (/^\s{0,3}>\s?/.test(line)) {
      const qLines: ExportInline[][] = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        qLines.push(parseExportInlines(lines[i].replace(/^\s{0,3}>\s?/, '')));
        i++;
      }
      blocks.push({ type: 'blockquote', lines: qLines });
      continue;
    }

    // Ordered or unordered / task list
    const listStart = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (listStart) {
      const ordered = !!listStart[3];
      const items: ExportListItem[] = [];
      while (i < lines.length) {
        const m = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(lines[i]);
        if (!m) break;
        const itemOrdered = !!m[3];
        if (items.length > 0 && m[1].length === 0 && itemOrdered !== ordered) break;
        const indent = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
        const checked = m[4] !== undefined ? m[4].toLowerCase() === 'x' : undefined;
        items.push({ indent, checked, inlines: parseExportInlines(m[5]) });
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph (coalesce contiguous plain text lines until next structural block)
    const paraLines: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (
        !next.trim() ||
        /^\s*(`{3,}|~{3,})/.test(next) ||
        TOC_ANCHOR_RE.test(next) ||
        /^\s{0,3}#{1,6}\s+/.test(next) ||
        /^\s*(?:[-*_]\s*){3,}$/.test(next) ||
        /^\s{0,3}>\s?/.test(next) ||
        /^\s*(?:[-*+]|\d+[.)])\s+/.test(next) ||
        /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.test(next) ||
        /^\s*\[\^([A-Za-z0-9_-]+)\]:/.test(next) ||
        (next.includes('|') && i + 1 < lines.length && parseTableAlignRow(lines[i + 1]) !== null)
      ) {
        break;
      }
      paraLines.push(next.trim());
      i++;
    }
    blocks.push({ type: 'paragraph', inlines: parseExportInlines(paraLines.join(' ')) });
  }

  const first = blocks[0];
  const hasLeadingH1 = first?.type === 'heading' && first.level === 1;
  return { title, body, hasLeadingH1, blocks };
}

export function inlinesToPlainText(inlines: ExportInline[]): string {
  return inlines
    .map((span) => {
      switch (span.type) {
        case 'text':
        case 'strong':
        case 'em':
        case 'strike':
        case 'code':
        case 'tag':
          return span.text;
        case 'link':
          return span.text;
        case 'wikilink':
          return span.label;
        case 'footnoteRef':
          return `[${span.id}]`;
      }
    })
    .join('');
}
