import { escapeRegExp } from './util.js';
import { extractMeta, mapOutsideCode, splitPath } from './markdown.js';
import { PARA, RoleFolderMap, ZETTEL_ID_PATTERN, isFolderProjectHome } from './para.js';
import { okfLinkTarget } from './memory.js';
import { isHiddenPath } from './database.js';

/**
 * Link resolution. A [[link]] matches, in this order: a note title, a frontmatter `id`
 * (Zettel ids stay valid when the title changes) or the id at the start of a Zettel title.
 */

export interface LinkNote {
  id: string;
  path: string;
  content: string;
  updatedAt?: number;
}

export interface GraphNode {
  id: string;
  title: string;
  folder: string;
  links: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

/** Targets of Markdown links `[text](target)` that are no URL (OKF bundle links), outside code and images */
function markdownPathLinks(content: string): string[] {
  if (!content.includes('](')) return [];
  const prose = content.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]*`/g, '');
  const out: string[] = [];
  for (const m of prose.matchAll(/\[[^[\]\n]*\]\(([^()\s]+)\)/g)) {
    const image = m.index! > 0 && prose[m.index! - 1] === '!';
    if (!image && !/^[a-z][a-z0-9+.-]*:|^#|^\/\/|^\/api\//i.test(m[1])) out.push(m[1]);
  }
  return out;
}

const WIKI = /\[\[([^\]|#\n]+)((?:#[^\]|\n]*)?)((?:\|[^\]\n]*)?)\]\]/g;

/** What the index reads from one note; kept between rebuilds while the note does not change (#64) */
interface ParsedNote {
  path: string;
  content: string;
  title: string;
  folder: string;
  links: string[];
  zid: string | null;
  name: string;
  isProjectHome: boolean;
  folderLeaf: string;
  frontmatterTitle: string | undefined;
  pathLinks: string[];
}

function parseNote(n: LinkNote, config: RoleFolderMap): ParsedNote {
  const meta = extractMeta(n.path, n.content);
  const name = splitPath(n.path).name;
  const isProjectHome = isFolderProjectHome(n.path, config);
  const folderLeaf = meta.folder ? meta.folder.split('/').pop()! : '';
  const title = isProjectHome ? meta.frontmatter.title || folderLeaf : name;
  const zid = meta.frontmatter.id ?? ZETTEL_ID_PATTERN.exec(name)?.[1] ?? null;
  return {
    path: n.path,
    content: n.content,
    title,
    folder: meta.folder,
    links: meta.links,
    zid,
    name,
    isProjectHome,
    folderLeaf,
    frontmatterTitle: meta.frontmatter.title,
    pathLinks: markdownPathLinks(n.content),
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Everything about a note that decides what links resolve to and where its own links go */
function sameLinkShape(a: ParsedNote, b: ParsedNote): boolean {
  return (
    a.title === b.title &&
    a.folder === b.folder &&
    a.zid === b.zid &&
    a.isProjectHome === b.isProjectHome &&
    a.frontmatterTitle === b.frontmatterTitle &&
    sameList(a.links, b.links) &&
    sameList(a.pathLinks, b.pathLinks)
  );
}

export class LinkIndex {
  private byTitle = new Map<string, string>();
  private byId = new Map<string, string>();
  /** Path suffixes ("Produkte/index", "AI-Memory/Produkte/index"): [[folder/name]] links and OKF path links (#94) */
  private byPath = new Map<string, string>();
  readonly notes = new Map<string, LinkNote & { title: string; folder: string; links: string[]; zid: string | null }>();
  private outgoingCache = new Map<string, string[]>();
  private incoming = new Map<string, Set<string>>();
  private parsed = new Map<string, ParsedNote>();
  private readonly configKey: string;
  /**
   * Asked when no note of the index has the link's title, id or path (online mode: the notes the device has only as
   * catalog entries); set after construction, so the index's own link lists never use it
   */
  fallback: ((link: string) => string | null) | null = null;

  /**
   * With `previous` (the index before a change) notes whose path and text are unchanged are not parsed again;
   * only resolving the links runs over all notes, which is cheap.
   */
  constructor(notes: LinkNote[], config: RoleFolderMap = PARA, previous?: LinkIndex | null) {
    this.configKey = config === PARA ? 'PARA' : JSON.stringify(config);
    const reuse = previous && previous.configKey === this.configKey ? previous.parsed : null;
    if (reuse && previous && this.adoptUnchangedLinks(notes, config, previous)) return;
    for (const n of notes) {
      const old = reuse?.get(n.id);
      const p = old && old.content === n.content && old.path === n.path ? old : parseNote(n, config);
      this.parsed.set(n.id, p);
      const { title: displayTitle, name, folderLeaf, zid } = p;
      this.notes.set(n.id, { ...n, title: displayTitle, folder: p.folder, links: p.links, zid });
      if (p.isProjectHome) {
        if (displayTitle && !this.byTitle.has(displayTitle.toLowerCase())) this.byTitle.set(displayTitle.toLowerCase(), n.id);
        if (folderLeaf && !this.byTitle.has(folderLeaf.toLowerCase())) this.byTitle.set(folderLeaf.toLowerCase(), n.id);
        if (folderLeaf && !this.byTitle.has(`${folderLeaf}/${name}`.toLowerCase())) this.byTitle.set(`${folderLeaf}/${name}`.toLowerCase(), n.id);
      } else {
        if (!this.byTitle.has(name.toLowerCase())) this.byTitle.set(name.toLowerCase(), n.id);
      }
      if (p.frontmatterTitle && !this.byTitle.has(p.frontmatterTitle.toLowerCase())) this.byTitle.set(p.frontmatterTitle.toLowerCase(), n.id);
      if (zid && !this.byId.has(zid)) this.byId.set(zid, n.id);
      const segments = n.path.replace(/\.md$/i, '').split('/');
      // The full path wins over a shorter suffix of another note
      this.byPath.set(segments.join('/').toLowerCase(), n.id);
    }
    for (const n of this.notes.values()) {
      const segments = n.path.replace(/\.md$/i, '').split('/');
      for (let i = segments.length - 2; i >= 1; i--) {
        const key = segments.slice(i).join('/').toLowerCase();
        if (!this.byPath.has(key)) this.byPath.set(key, n.id);
      }
    }
    for (const [id, n] of this.notes) {
      const pathLinks = this.parsed.get(id)!.pathLinks.map((url) => okfLinkTarget(url, n.folder));
      const targets = [
        ...new Set([...n.links.map((l) => this.resolve(l)), ...pathLinks.map((p) => (p ? this.resolvePath(p) : null))].filter((t): t is string => !!t && t !== id)),
      ];
      this.outgoingCache.set(id, targets);
      for (const t of targets) {
        if (!this.incoming.has(t)) this.incoming.set(t, new Set());
        this.incoming.get(t)!.add(id);
      }
    }
  }

  /**
   * Typing usually changes text but no title, path or link: then the lookup tables and link lists of `previous` stay
   * valid and only the changed notes are parsed again. Returns false (and changes nothing) when anything that links
   * depend on changed.
   */
  private adoptUnchangedLinks(notes: LinkNote[], config: RoleFolderMap, previous: LinkIndex): boolean {
    if (notes.length !== previous.parsed.size) return false;
    const parsed = new Map<string, ParsedNote>();
    for (const n of notes) {
      const old = previous.parsed.get(n.id);
      if (!old || old.path !== n.path) return false;
      if (old.content === n.content) {
        parsed.set(n.id, old);
        continue;
      }
      const p = parseNote(n, config);
      if (!sameLinkShape(old, p)) return false;
      parsed.set(n.id, p);
    }
    this.parsed = parsed;
    this.byTitle = previous.byTitle;
    this.byId = previous.byId;
    this.byPath = previous.byPath;
    this.outgoingCache = previous.outgoingCache;
    this.incoming = previous.incoming;
    for (const n of notes) {
      const p = parsed.get(n.id)!;
      this.notes.set(n.id, { ...n, title: p.title, folder: p.folder, links: p.links, zid: p.zid });
    }
    return true;
  }

  /** Note id for a link target, or null */
  resolve(link: string): string | null {
    const key = link.trim().toLowerCase();
    if (this.byTitle.has(key)) return this.byTitle.get(key)!;
    const zid = ZETTEL_ID_PATTERN.exec(key)?.[1];
    if (zid && this.byId.has(zid)) return this.byId.get(zid)!;
    if (key.includes('/')) {
      const byPath = this.resolvePath(key);
      if (byPath) return byPath;
    }
    return this.fallback?.(link) ?? null;
  }

  /** Note id for a path or path suffix ("Produkte/Foo", "/Produkte/Foo.md"), or null */
  resolvePath(path: string): string | null {
    const key = path
      .trim()
      .toLowerCase()
      .replace(/^\.?\/+/, '')
      .replace(/\.md$/, '');
    return this.byPath.get(key) ?? null;
  }

  outgoing(id: string): string[] {
    return this.outgoingCache.get(id) ?? [];
  }

  backlinks(id: string): string[] {
    // A folder's settings (database notes) are no note somebody wrote a link in
    return [...(this.incoming.get(id) ?? [])].filter((from) => !isHiddenPath(this.notes.get(from)?.path ?? ''));
  }

  /** Names a note may be mentioned by: its title and, for Zettel, the title without the id in front */
  mentionNames(id: string): string[] {
    const n = this.notes.get(id);
    if (!n) return [];
    const bare = n.title.replace(ZETTEL_ID_PATTERN, '').trim();
    return [...new Set([n.title, bare])].filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  }

  /** Notes that mention the title in plain text without linking to the note */
  unlinkedMentions(id: string): string[] {
    const names = this.mentionNames(id);
    if (!names.length) return [];
    const linked = new Set(this.backlinks(id));
    // Most notes do not contain the name at all: a plain test on the raw text skips them before the exact check (#64)
    const quick = names.map(mentionPattern);
    const out: string[] = [];
    for (const [other, n] of this.notes) {
      if (other === id || linked.has(other) || isHiddenPath(n.path)) continue;
      if (!quick.some((re) => re.test(n.content))) continue;
      if (names.some((name) => hasPlainMention(n.content, name))) out.push(other);
    }
    return out;
  }

  graph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    // Database and variables notes (`_database-<uuid>.md`, `_variables-<uuid>.md`) hold a folder's settings; they are no notes of their own in the graph
    const hidden = new Set<string>();
    for (const n of this.notes.values()) if (isHiddenPath(n.path)) hidden.add(n.id);
    const edges: GraphEdge[] = [];
    for (const [id, targets] of this.outgoingCache) {
      if (hidden.has(id)) continue;
      for (const t of targets) if (!hidden.has(t)) edges.push({ source: id, target: t });
    }
    const nodes = [...this.notes.values()].filter((n) => !hidden.has(n.id)).map((n) => ({
      id: n.id,
      title: n.title,
      folder: n.folder,
      links: this.outgoing(n.id).length + this.backlinks(n.id).length,
    }));
    return { nodes, edges };
  }

  /** Neighbourhood of a note up to `depth` hops (both directions) */
  localGraph(id: string, depth = 2): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const keep = new Set([id]);
    let frontier = [id];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const m of [...this.outgoing(n), ...this.backlinks(n)]) {
          if (keep.has(m)) continue;
          keep.add(m);
          next.push(m);
        }
      }
      frontier = next;
    }
    const all = this.graph();
    return { nodes: all.nodes.filter((n) => keep.has(n.id)), edges: all.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
  }

  /** Notes without any link in or out */
  isOrphan(id: string): boolean {
    return this.outgoing(id).length === 0 && this.backlinks(id).length === 0;
  }

  /**
   * Returns all valid mention targets across all notes (excluding `excludeId`),
   * sorted with the longest names first so that multi-word titles take precedence.
   */
  autoLinkTargets(excludeId?: string): { name: string; target: string }[] {
    const map = new Map<string, string>();
    for (const [id, note] of this.notes) {
      if ((excludeId && id === excludeId) || isHiddenPath(note.path)) continue;
      const target = note.title;
      for (const name of this.mentionNames(id)) {
        const key = name.toLowerCase();
        if (!map.has(key)) map.set(key, target);
      }
    }
    return [...map.entries()]
      .map(([name, target]) => ({ name, target }))
      .sort((a, b) => b.name.length - a.name.length);
  }
}

/** Plain-text occurrence of `title` (whole words, outside code and outside existing links) */
function mentionPattern(title: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}\\[])${escapeRegExp(title)}(?![\\p{L}\\p{N}\\]])`, 'iu');
}

function stripLinks(text: string): string {
  return text.replace(/\[\[[^\]\n]*\]\]/g, (m) => ' '.repeat(m.length)).replace(/\[[^\]\n]*\]\([^)\n]*\)/g, (m) => ' '.repeat(m.length));
}

export function hasPlainMention(content: string, title: string): boolean {
  let found = false;
  const re = mentionPattern(title);
  mapOutsideCode(content, (text) => {
    if (!found && re.test(stripLinks(text).replace(/^---\n[\s\S]*?\n---\n?/, ''))) found = true;
    return text;
  });
  return found;
}

/**
 * Turns the first plain mention of `title` into a link to `target` (default: the title itself);
 * the original spelling stays visible as alias if it differs
 */
export function linkFirstMention(content: string, title: string, target = title): string {
  let done = false;
  const re = mentionPattern(title);
  return mapOutsideCode(content, (text) => {
    if (done) return text;
    const masked = stripLinks(text);
    const m = re.exec(masked);
    if (!m) return text;
    done = true;
    const original = text.slice(m.index, m.index + m[0].length);
    const link = original === target ? `[[${target}]]` : `[[${target}|${original}]]`;
    return text.slice(0, m.index) + link + text.slice(m.index + m[0].length);
  });
}

/** Rewrites [[Old]], [[Old#Heading]] and [[Old|Alias]] to the new title (outside code) */
export function renameWikiLinks(content: string, oldTitle: string, newTitle: string): string {
  const old = oldTitle.trim().toLowerCase();
  return mapOutsideCode(content, (text) =>
    text.replace(WIKI, (all, target: string, heading: string, alias: string) => (target.trim().toLowerCase() === old ? `[[${newTitle}${heading}${alias}]]` : all))
  );
}

/**
 * Turns all plain mentions of known targets into wikilinks outside code, frontmatter, and existing links.
 * Longer target names are prioritized.
 */
export function linkAllMentions(content: string, targets: { name: string; target: string }[]): string {
  if (!targets.length) return content;
  const targetMap = new Map<string, string>();
  for (const t of targets) {
    const k = t.name.toLowerCase();
    if (!targetMap.has(k)) targetMap.set(k, t.target);
  }
  const escaped = targets.map((t) => escapeRegExp(t.name));
  const re = new RegExp(`(?<![\\p{L}\\p{N}\\[#@/])(?:${escaped.join('|')})(?![\\p{L}\\p{N}\\]])`, 'giu');

  return mapOutsideCode(content, (text) => {
    let prefix = '';
    let body = text;
    const fm = /^---\n[\s\S]*?\n---\n?/.exec(text);
    if (fm) {
      prefix = fm[0];
      body = text.slice(prefix.length);
    }
    const masked = stripLinks(body);
    let result = '';
    let lastIndex = 0;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      result += body.slice(lastIndex, m.index);
      const original = body.slice(m.index, m.index + m[0].length);
      const target = targetMap.get(original.toLowerCase()) ?? original;
      const link = original === target ? `[[${target}]]` : `[[${target}|${original}]]`;
      result += link;
      lastIndex = m.index + m[0].length;
    }
    result += body.slice(lastIndex);
    return prefix + result;
  });
}
