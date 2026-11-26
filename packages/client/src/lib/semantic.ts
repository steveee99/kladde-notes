import { useEffect, useState } from 'react';
import { isHiddenPath, relatedNotes, semanticSearch } from '@kladde/shared';
import { vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { api } from './api';

/**
 * Conceptual search in the app (#84), the same as MCP's `semantic_search`: word stems, compounds, bilingual concept
 * clusters and links. On a device with every text it runs here (the index is kept per note between searches);
 * in online mode the server answers from its index of the space (`GET /api/online/semantic`).
 */

const DEBOUNCE_MS = 250;
const SIMILAR = 5;

function localPool(withMemory: boolean): LocalNote[] {
  return vault.list().filter((n) => !n.partial && !isHiddenPath(n.path) && (withMemory || !vault.isMemoryNote(n)));
}

/** Notes that match `query` by meaning, without the ones in `exclude` (the exact matches); empty while typing */
export function useSimilarNotes(query: string, exclude: ReadonlySet<string>, opts: { enabled: boolean; withMemory: boolean; version: number }): LocalNote[] {
  const [hits, setHits] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] });
  const q = query.trim();
  const key = `${q}|${opts.withMemory}`;
  useEffect(() => {
    if (!opts.enabled || q.length < 3) return;
    let live = true;
    const timer = setTimeout(() => {
      if (vault.online) {
        const memory = vault.memoryFolder();
        const skip = !opts.withMemory && memory ? `&skip=${encodeURIComponent(memory)}` : '';
        api<{ hits: { id: string }[] }>(`/online/semantic?q=${encodeURIComponent(q)}${skip}`)
          .then((r) => live && setHits({ key, ids: r.hits.map((h) => h.id) }))
          .catch(() => {});
      } else {
        const found = semanticSearch(q, localPool(opts.withMemory), { limit: SIMILAR + 10, minScore: 0.08, corpusKey: 'device' });
        if (live) setHits({ key, ids: found.map((h) => h.note.id) });
      }
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The vault version reruns it after edits
  }, [key, opts.enabled, opts.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!opts.enabled || hits.key !== key) return [];
  return hits.ids
    .filter((id) => !exclude.has(id))
    .map((id) => vault.get(id))
    .filter((n): n is LocalNote => !!n && !isHiddenPath(n.path))
    .slice(0, SIMILAR);
}

/** Notes related to the note `id` by their topics ("Related notes" in the side panel); null while loading */
export function useRelatedNotes(id: string, version: number): LocalNote[] | null {
  const [hits, setHits] = useState<{ id: string; ids: string[] } | null>(null);
  useEffect(() => {
    let live = true;
    // After the note has rendered: indexing a large vault the first time takes a moment
    const timer = setTimeout(() => {
      if (vault.online) {
        api<{ hits: { id: string }[] }>(`/online/semantic?related=${encodeURIComponent(id)}`)
          .then((r) => live && setHits({ id, ids: r.hits.map((h) => h.id) }))
          .catch(() => live && setHits({ id, ids: [] }));
        return;
      }
      const note = vault.get(id);
      if (!note) return setHits({ id, ids: [] });
      const found = relatedNotes(note, localPool(vault.isMemoryNote(note)), { corpusKey: 'device' });
      if (live) setHits({ id, ids: found.map((h) => h.note.id) });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, Math.floor(version / 20)]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!hits || hits.id !== id) return null;
  return hits.ids.map((x) => vault.get(x)).filter((n): n is LocalNote => !!n);
}
