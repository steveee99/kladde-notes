import { extractMeta, splitPath } from './markdown.js';
import { isExcalidrawNote } from './excalidrawNote.js';
import { pdfNoteOf } from './pdfNote.js';
import { LinkIndex, type GraphEdge, type GraphNode } from './links.js';
import { PARA, roleOfFolder, type ParaRole, type RoleFolderMap } from './para.js';
import { tagMatches } from './tags.js';
import { trimSlashes } from './util.js';

/**
 * Filters for the knowledge graph (#38): PARA role, folder, tag, note type, a time range, and a focus
 * on one note with its neighbourhood. Orphans (no link in or out) are found on the whole graph, so a
 * note does not count as orphaned just because a filter hides its neighbours.
 */

export type GraphNoteKind = 'note' | 'zettel' | 'pdf' | 'drawing';
export const GRAPH_NOTE_KINDS: GraphNoteKind[] = ['note', 'zettel', 'pdf', 'drawing'];

export interface GraphFilterNote {
  id: string;
  path: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface GraphFilter {
  /** PARA roles to show; `none` = notes outside every role folder. Empty or missing = all */
  roles?: (ParaRole | 'none')[];
  /** Only this folder and its subfolders */
  folder?: string;
  /** Only notes with this tag or one nested below it */
  tag?: string;
  /** Note types to show. Empty or missing = all */
  kinds?: GraphNoteKind[];
  /** Hide the archive role (default in the view); ignored when `roles` names it */
  hideArchive?: boolean;
  /** Only notes created (or changed) within [from, to] (epoch ms, both inclusive) */
  range?: { field: 'created' | 'updated'; from: number; to: number };
  /** Only notes with at least one link (on the whole graph) */
  onlyLinked?: boolean;
  /** Only orphaned notes */
  onlyOrphans?: boolean;
  /** Only this note and its neighbours up to `depth` hops; the other filters still apply to the neighbours */
  focus?: { id: string; depth: number };
}

export interface FilteredGraphNode extends GraphNode {
  /** No link in or out on the whole graph */
  orphan: boolean;
  kind: GraphNoteKind;
}

/** Type of a note for the graph filter: drawing, PDF, Zettel (by folder) or a plain note */
export function graphNoteKind(path: string, content: string, config: RoleFolderMap = PARA): GraphNoteKind {
  if (isExcalidrawNote(content)) return 'drawing';
  if (pdfNoteOf(content)) return 'pdf';
  if (roleOfFolder(splitPath(path).folder, config) === 'zettel') return 'zettel';
  return 'note';
}

/** Neighbourhood of `id` up to `depth` hops, both link directions */
export function neighbourhood(index: LinkIndex, id: string, depth: number): Set<string> {
  const keep = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of [...index.outgoing(n), ...index.backlinks(n)]) {
        if (keep.has(m)) continue;
        keep.add(m);
        next.push(m);
      }
    }
    frontier = next;
  }
  return keep;
}

export function filterGraph(
  index: LinkIndex,
  notes: GraphFilterNote[],
  filter: GraphFilter = {},
  config: RoleFolderMap = PARA
): { nodes: FilteredGraphNode[]; edges: GraphEdge[]; orphans: number } {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const near = filter.focus ? neighbourhood(index, filter.focus.id, Math.max(1, Math.min(3, filter.focus.depth))) : null;
  return filterGraphData(
    index.graph(),
    (id) => {
      const note = byId.get(id);
      if (!note) return undefined;
      return { kind: graphNoteKind(note.path, note.content, config), tags: () => extractMeta(note.path, note.content).tags, createdAt: note.createdAt, updatedAt: note.updatedAt };
    },
    filter,
    config,
    near
  );
}

/** What the graph filter needs of a note besides its node; `tags` is read only when a tag filter is set */
export interface GraphNodeInfo {
  kind: GraphNoteKind;
  tags: () => string[];
  createdAt: number;
  updatedAt: number;
}

/** Neighbourhood of `id` up to `depth` hops over the graph's edges (both directions) */
export function edgeNeighbourhood(edges: GraphEdge[], id: string, depth: number): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
  }
  const keep = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        if (keep.has(m)) continue;
        keep.add(m);
        next.push(m);
      }
    }
    frontier = next;
  }
  return keep;
}

/**
 * The filter over a graph that is already built (online mode: nodes and edges from the server). `info` gives type,
 * tags and dates of a node (undefined: left out); `near` the focus neighbourhood, found over the edges when missing.
 */
export function filterGraphData(
  all: { nodes: GraphNode[]; edges: GraphEdge[] },
  info: (id: string) => GraphNodeInfo | undefined,
  filter: GraphFilter = {},
  config: RoleFolderMap = PARA,
  near: Set<string> | null = filter.focus ? edgeNeighbourhood(all.edges, filter.focus.id, Math.max(1, Math.min(3, filter.focus.depth))) : null
): { nodes: FilteredGraphNode[]; edges: GraphEdge[]; orphans: number } {
  const roles = filter.roles?.length ? new Set(filter.roles) : null;
  const kinds = filter.kinds?.length ? new Set(filter.kinds) : null;
  const folder = trimSlashes(filter.folder ?? '');
  let orphans = 0;
  const nodes: FilteredGraphNode[] = [];
  for (const node of all.nodes) {
    const note = info(node.id);
    if (!note) continue;
    const orphan = node.links === 0;
    const kind = note.kind;
    const isFocus = filter.focus?.id === node.id;
    if (!isFocus) {
      if (near && !near.has(node.id)) continue;
      const role = roleOfFolder(node.folder, config);
      if (roles ? !roles.has(role ?? 'none') : filter.hideArchive && role === 'archive') continue;
      if (folder && node.folder !== folder && !node.folder.startsWith(`${folder}/`)) continue;
      if (kinds && !kinds.has(kind)) continue;
      if (filter.tag && !note.tags().some((t) => tagMatches(t, filter.tag!))) continue;
      if (filter.range) {
        const at = filter.range.field === 'created' ? note.createdAt : note.updatedAt;
        if (at < filter.range.from || at > filter.range.to) continue;
      }
      if (filter.onlyLinked && orphan) continue;
      if (filter.onlyOrphans && !orphan) continue;
    }
    if (orphan) orphans++;
    nodes.push({ ...node, orphan, kind });
  }
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: all.edges.filter((e) => ids.has(e.source) && ids.has(e.target)), orphans };
}
