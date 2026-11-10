/** Lightweight metadata extraction, used for the note list, search, backlinks and queries */

export interface NoteMeta {
  title: string;
  folder: string;
  tags: string[];
  links: string[];
  frontmatter: Record<string, string>;
}

export function splitPath(path: string): { folder: string; name: string } {
  const i = path.lastIndexOf('/');
  const file = i === -1 ? path : path.slice(i + 1);
  return { folder: i === -1 ? '' : path.slice(0, i), name: file.replace(/\.md$/i, '') };
}

export function joinPath(folder: string, name: string): string {
  const clean = name.replace(/[\\/]/g, '-').trim() || 'Unbenannt';
  return `${folder ? `${folder}/` : ''}${clean}.md`;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const m = FRONTMATTER.exec(content);
  if (!m) return { data: {}, body: content };
  const data: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { data, body: content.slice(m[0].length) };
}

/** Strips fenced code so tags and links inside code are not counted */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]*`/g, '');
}

export function extractMeta(path: string, content: string): NoteMeta {
  const { folder, name } = splitPath(path);
  const { data, body } = parseFrontmatter(content);
  const prose = withoutCode(body);
  const tags = new Set<string>();
  for (const m of prose.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
    if (!/^\d+$/.test(m[2])) tags.add(m[2].toLowerCase());
  }
  for (const t of (data.tags ?? '').replace(/[[\]]/g, '').split(',')) {
    if (t.trim()) tags.add(t.trim().replace(/^#/, '').toLowerCase());
  }
  const links = new Set<string>();
  for (const m of prose.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) links.add(m[1].trim());
  return { title: data.title || name, folder, tags: [...tags], links: [...links], frontmatter: data };
}

/** First lines of text without markup, for list previews */
export function excerpt(content: string, length = 140): string {
  const { body } = parseFrontmatter(content);
  return body
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/(?:📅\s*|\bdue:)\d{4}-\d{2}-\d{2}|(?:🔁\s*|\bevery:)\S+|✅\s*\d{4}-\d{2}-\d{2}/g, '')
    .replace(/[*_`>~]|!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)(\|([^\]]*))?\]\]/g, (_, a, __, b) => b || a)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, length);
}

/**
 * Sets (or with null removes) frontmatter keys, creating the block if needed.
 * Values are written as plain `key: value` lines, other lines stay untouched.
 */
export function setFrontmatter(content: string, updates: Record<string, string | null>): string {
  const m = FRONTMATTER.exec(content);
  const lines = m ? m[1].split('\n') : [];
  const body = m ? content.slice(m[0].length) : content;
  for (const [key, value] of Object.entries(updates)) {
    const i = lines.findIndex((l) => new RegExp(`^${key}:`, 'i').test(l));
    if (value === null) {
      if (i >= 0) lines.splice(i, 1);
    } else if (i >= 0) lines[i] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  }
  if (!lines.length) return body;
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** Runs `fn` on every piece of text outside fenced and inline code, keeping the code as it is */
export function mapOutsideCode(content: string, fn: (text: string) => string): string {
  return content
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('');
}

export interface NoteHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  /** 1-based line number */
  line: number;
  /** 0-based character offset of the line start in `content` */
  from: number;
}

/** Standalone anchor line (`##TOC##` or `[[TOC]]`) that inserts an automatic table of contents */
export const TOC_ANCHOR_RE = /^\s*(?:##TOC##|\[\[TOC\]\])\s*$/i;

export function cleanHeadingText(raw: string): string {
  return raw
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, target: string, alias?: string) => (alias ?? target).trim())
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|\*|_)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extracts ATX headings (# .. ######) outside frontmatter and fenced code blocks */
export function extractHeadings(content: string): NoteHeading[] {
  const lines = content.split('\n');
  let i = 0;
  let offset = 0;

  if (lines.length > 1 && lines[0].replace(/\r$/, '') === '---') {
    let fmOffset = lines[0].length + 1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].replace(/\r$/, '') === '---') {
        offset = fmOffset + lines[j].length + 1;
        i = j + 1;
        break;
      }
      fmOffset += lines[j].length + 1;
    }
  }

  const out: NoteHeading[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const lineText = raw.replace(/\r$/, '');
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(lineText);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLen = len;
      } else if (ch === fenceChar && len >= fenceLen && /^\s*(`{3,}|~{3,})\s*$/.test(lineText)) {
        inFence = false;
      }
      offset += raw.length + 1;
      continue;
    }

    if (!inFence) {
      const m = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(lineText);
      if (m) {
        const text = cleanHeadingText(m[2]);
        if (text) {
          out.push({
            level: m[1].length as 1 | 2 | 3 | 4 | 5 | 6,
            text,
            line: i + 1,
            from: offset,
          });
        }
      }
    }
    offset += raw.length + 1;
  }

  return out;
}

