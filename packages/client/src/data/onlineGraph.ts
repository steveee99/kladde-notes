import { useSyncExternalStore } from 'react';
import type { GraphEdge, GraphNode, OnlineGraph } from '@kladde/shared';
import { splitPath } from '@kladde/shared';
import { ApiError } from '../lib/api';
import { t } from '../lib/i18n';
import { vault } from './vault';

/**
 * Online mode: the knowledge graph from the server (`GET /api/online/graph`), because the device holds the links of
 * only the notes it loaded. Asked when the graph page opens and after every sync while it is open; the server answers
 * `same` while nothing changed, so an open page does not download the graph again.
 */

export interface OnlineGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Type (0 note, 1 PDF, 2 drawing) and tags by note id */
  info: Map<string, { kind: 0 | 1 | 2; tags: string[] }>;
}

export interface OnlineGraphState {
  /** idle: not asked yet; loading: waiting for the server or the download */
  phase: 'idle' | 'loading' | 'ready' | 'error';
  /** Bytes received so far while loading */
  received: number;
  data: OnlineGraphData | null;
  error: string | null;
}

class OnlineGraphStore {
  private state: OnlineGraphState = { phase: 'idle', received: 0, data: null, error: null };
  private stamp = '';
  private user = '';
  private askedFor: number | null | undefined = undefined;
  private running: AbortController | null = null;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  get = () => this.state;

  private set(next: Partial<OnlineGraphState>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((l) => l());
  }

  /** Asks for the graph once per sync of the vault (with the stamp of the graph the device has) */
  want(): void {
    if (!vault.online) return;
    const user = vault.localDb()?.userId ?? '';
    if (user !== this.user) {
      this.running?.abort();
      this.running = null;
      this.user = user;
      this.stamp = '';
      this.askedFor = undefined;
      this.state = { phase: 'idle', received: 0, data: null, error: null };
    }
    // The catalog from IndexedDB is enough (folders, dates): no need to wait for the first sync after a start
    if (!user || vault.lastSync === this.askedFor || this.running || (vault.lastSync === null && !vault.list().length)) return;
    this.askedFor = vault.lastSync;
    const ctrl = new AbortController();
    this.running = ctrl;
    if (!this.state.data) this.set({ phase: 'loading', received: 0, error: null });
    this.fetch(ctrl.signal)
      .then((res) => {
        if (user !== this.user) return;
        this.stamp = res.stamp;
        if (res.same && this.state.data) return this.set({ phase: 'ready' });
        this.set({ phase: 'ready', data: toData(res), error: null });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || user !== this.user) return;
        // Asked again with the next sync; a graph already shown stays
        this.askedFor = undefined;
        this.set({ phase: this.state.data ? 'ready' : 'error', error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        if (this.running === ctrl) this.running = null;
      });
  }

  /** The answer, read in pieces so the page can show how much came */
  private async fetch(signal: AbortSignal): Promise<OnlineGraph> {
    const res = await fetch(`/api/online/graph?have=${encodeURIComponent(this.stamp)}`, { credentials: 'same-origin', signal });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(data.error ?? t('common.errorStatus', { status: res.status }), res.status, data);
    }
    if (!res.body) return (await res.json()) as OnlineGraph;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let shownAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (received - shownAt > 256 * 1024) {
        shownAt = received;
        if (!this.state.data) this.set({ received });
      }
    }
    const all = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    return JSON.parse(new TextDecoder().decode(all)) as OnlineGraph;
  }
}

/** Nodes and edges for the graph view: folders from the catalog, the number of links from the edges */
function toData(res: OnlineGraph): OnlineGraphData {
  const tuples = res.nodes ?? [];
  const flat = res.edges ?? [];
  const degree = new Uint32Array(tuples.length);
  for (let i = 0; i + 1 < flat.length; i += 2) {
    degree[flat[i]]++;
    degree[flat[i + 1]]++;
  }
  const nodes: GraphNode[] = [];
  const info = new Map<string, { kind: 0 | 1 | 2; tags: string[] }>();
  const known: boolean[] = [];
  tuples.forEach(([id, title, kind, tags], i) => {
    const note = vault.get(id);
    known[i] = !!note && !note.deleted;
    if (!known[i]) return;
    nodes.push({ id, title, folder: splitPath(note!.path).folder, links: degree[i] });
    info.set(id, { kind, tags: tags ?? [] });
  });
  const edges: GraphEdge[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (known[flat[i]] && known[flat[i + 1]]) edges.push({ source: tuples[flat[i]][0], target: tuples[flat[i + 1]][0] });
  }
  return { nodes, edges, info };
}

export const onlineGraph = new OnlineGraphStore();

export function useOnlineGraph(): OnlineGraphState {
  return useSyncExternalStore(onlineGraph.subscribe, onlineGraph.get);
}
