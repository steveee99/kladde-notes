/**
 * Remote notes on this device (shared/remoteNote.ts): the document is asked for from the server each time a note opens
 * and lives only in memory. Nothing of it is stored, indexed or synced.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  encodeRemotePath,
  prepareRemoteMarkdown,
  remoteNoteOf,
  remoteWebUrl,
  resolveRemoteSource,
  type RemoteHost,
  type RemoteNoteResponse,
  type RemoteProblem,
  type RemoteSource,
  type VariableScope,
} from '@kladde/shared';
import { DEMO } from '../demo/demoApi';
import { api, ApiError } from '../lib/api';
import { t, type I18nKey } from '../lib/i18n';
import type { LocalNote } from './db';
import { useVault, vault } from './vault';

export type RemoteOk = Extract<RemoteNoteResponse, { state: 'ok' }>;
export type RemoteState = RemoteOk | { state: RemoteProblem | 'loading' | 'offline' | 'busy' | 'missing' | 'demo' };

/** Longest wait for local changes (a new note, an edited variable) to reach the server before asking for the document */
const SYNC_WAIT_MS = 5000;

const running = new Map<string, Promise<RemoteState>>();

/** Asks the server for a note's document; requests at the same time (several embeds) share one answer */
export function fetchRemote(id: string, refresh = false): Promise<RemoteState> {
  if (DEMO) return Promise.resolve({ state: 'demo' });
  const key = `${id}\n${refresh}`;
  let job = running.get(key);
  if (!job) {
    job = api<RemoteNoteResponse>(`/remote-notes/${encodeURIComponent(id)}${refresh ? '?refresh=1' : ''}`)
      .catch((err): RemoteState => {
        if (!(err instanceof ApiError)) return { state: 'offline' };
        return { state: err.status === 404 ? 'missing' : err.status === 429 ? 'busy' : 'unreachable' };
      })
      .finally(() => running.delete(key));
    running.set(key, job);
  }
  return job;
}

/** What to show instead of the document */
export const remoteProblemText = (state: RemoteState['state']): string => t(`remote.state.${state}` as I18nKey);

/** The document as Markdown to show: links lead to its host, images go through the server */
export const remoteDisplayText = (id: string, r: RemoteOk): string =>
  prepareRemoteMarkdown(r.text, r.base, (path) => `/api/remote-notes/${encodeURIComponent(id)}/image?path=${encodeRemotePath(path)}${r.commit ? `&v=${r.commit.id.slice(0, 8)}` : ''}`);

/** The document as Markdown that works anywhere (copy, Markdown export): images by their address on the host */
export const remoteExportText = (r: RemoteOk): string => prepareRemoteMarkdown(r.text, r.base, (path) => remoteWebUrl({ ...r.base, path }, 'raw'));

/** For embeds */
export async function loadRemoteEmbed(id: string): Promise<{ text: string } | { problem: string }> {
  // Just made here: the server has to get it first
  for (let waited = 0; !DEMO && vault.get(id)?.dirty && waited < SYNC_WAIT_MS; waited += 200) await new Promise((r) => setTimeout(r, 200));
  const r = await fetchRemote(id);
  return r.state === 'ok' ? { text: remoteDisplayText(id, r) } : { problem: remoteProblemText(r.state) };
}

let hosts: Promise<RemoteHost[] | null> | null = null;

/** The instances an admin configured; null when they cannot be asked for right now */
export function useRemoteHosts(): RemoteHost[] | null {
  const [list, setList] = useState<RemoteHost[] | null>(null);
  useEffect(() => {
    let live = true;
    hosts ??= DEMO ? Promise.resolve(null) : api<RemoteHost[]>('/remote-notes/hosts').catch(() => null);
    void hosts.then((l) => live && setList(l));
    return () => {
      live = false;
      // Asked again the next time: an admin may have changed them
      hosts = null;
    };
  }, []);
  return list;
}

export interface RemoteNoteView {
  source: RemoteSource;
  /** The source with the variables this reader has; `complete` false when some are missing */
  resolved: { url: string; ref: string; complete: boolean };
  result: RemoteState;
  /** The document to show, '' without one */
  text: string;
  /** Asking (again); `result` still is the last answer */
  loading: boolean;
  reload: () => void;
}

/** The document of a remote note, loaded when the note opens and whenever its source changes; null for other notes */
export function useRemoteNote(note: LocalNote | undefined, variables: VariableScope): RemoteNoteView | null {
  useVault();
  const source = useMemo(() => (note && !note.partial ? remoteNoteOf(note.content) : null), [note]);
  const resolved = useMemo(() => source && resolveRemoteSource(source, variables), [source, variables]);
  const id = note?.id ?? '';
  // The version too: recipients do not see the variables of the folder, but a moved or changed note
  const key = resolved ? [id, source!.source, source!.ref, resolved.url, resolved.ref, note!.version].join('\n') : '';
  const [answer, setAnswer] = useState<{ key: string; result: RemoteState } | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const forced = useRef(false);
  const seq = useRef(0);

  // The server reads the stored note and variables: what changed here has to get there first
  const unsynced = !!note && !DEMO && (note.version === 0 || vault.pendingCount() > 0);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!key || !unsynced) {
      setWaited(false);
      return;
    }
    vault.kick();
    const timer = setTimeout(() => setWaited(true), SYNC_WAIT_MS);
    return () => clearTimeout(timer);
  }, [key, unsynced]);

  const ready = !!key && (!unsynced || waited);
  useEffect(() => {
    if (!ready) return;
    const mine = ++seq.current;
    const refresh = forced.current;
    forced.current = false;
    setLoading(true);
    void fetchRemote(id, refresh).then((result) => {
      if (mine !== seq.current) return;
      setAnswer({ key, result });
      setLoading(false);
    });
    return () => {
      seq.current++;
    };
  }, [ready, key, id, tick]);

  const reload = useCallback(() => {
    forced.current = true;
    setTick((n) => n + 1);
  }, []);

  const result: RemoteState = answer?.key === key ? answer.result : { state: 'loading' };
  const offline = result.state === 'offline';
  useEffect(() => {
    if (!offline) return;
    window.addEventListener('online', reload);
    return () => window.removeEventListener('online', reload);
  }, [offline, reload]);

  const text = useMemo(() => (result.state === 'ok' ? remoteDisplayText(id, result) : ''), [id, result]);
  return source && resolved ? { source, resolved, result, text, loading: loading || result.state === 'loading', reload } : null;
}
