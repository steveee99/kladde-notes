import { escapeRegExp } from './util.js';
import { extractMeta, mapOutsideCode, splitPath } from './markdown.js';
import { ZETTEL_ID_PATTERN } from './para.js';

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

const WIKI = /\[\[([^\]|#\n]+)((?:#[^\]|\n]*)?)((?:\|[^\]\n]*)?)\]\]/g;

export class LinkIndex {
  private byTitle = new Map<string, string>();
  private byId = new Map<string, string>();
  readonly notes = new Map<string, LinkNote & { title: string; folder: string; links: string[]; zid: string | null }>();
  private outgoingCache = new Map<string, string[]>();
  private incoming = new Map<string, Set<string>>();

  constructor(notes: LinkNote[]) {
    for (const n of notes) {
      const meta = extractMeta(n.path, n.content);
      const name = splitPath(n.path).name;
      const zid = meta.frontmatter.id ?? ZETTEL_ID_PATTERN.exec(name)?.[1] ?? null;
      this.notes.set(n.id, { ...n, title: name, folder: meta.folder, links: meta.links, zid });
      if (!this.byTitle.has(name.toLowerCase())) this.byTitle.set(name.toLowerCase(), n.id);
      if (meta.frontmatter.title && !this.byTitle.has(meta.frontmatter.title.toLowerCase())) this.byTitle.set(meta.frontmatter.title.toLowerCase(), n.id);
      if (zid && !this.byId.has(zid)) this.byId.set(zid, n.id);
    }
    for (const [id, n] of this.notes) {
      const targets = [...new Set(n.links.map((l) => this.resolve(l)).filter((t): t is string => !!t && t !== id))];
      this.outgoingCache.set(id, targets);
      for (const t of targets) {
        if (!this.incoming.has(t)) this.incoming.set(t, new Set());
        this.incoming.get(t)!.add(id);
      }
    }
  }

  /** Note id for a link target, or null */
  resolve(link: string): string | null {
    const key = link.trim().toLowerCase();
    if (this.byTitle.has(key)) return this.byTitle.get(key)!;
    const zid = ZETTEL_ID_PATTERN.exec(key)?.[1];
    if (zid && this.byId.has(zid)) return this.byId.get(zid)!;
    return null;
  }

  outgoing(id: string): string[] {
    return this.outgoingCache.get(id) ?? [];
  }

  backlinks(id: string): string[] {
    return [...(this.incoming.get(id) ?? [])];
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
    const out: string[] = [];
    for (const [other, n] of this.notes) {
      if (other === id || linked.has(other)) continue;
      if (names.some((name) => hasPlainMention(n.content, name))) out.push(other);
    }
    return out;
  }

  graph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const edges: GraphEdge[] = [];
    for (const [id, targets] of this.outgoingCache) for (const t of targets) edges.push({ source: id, target: t });
    const nodes = [...this.notes.values()].map((n) => ({
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
      for (const n of frontier) for (const m of [...this.outgoing(n), ...this.backlinks(n)]) if (!keep.has(m)) keep.add(m), next.push(m);
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
      if (excludeId && id === excludeId) continue;
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
