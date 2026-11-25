/**
 * Remote notes on this device (shared/remoteNote.ts): the document is asked for from the server each time a note opens
 * and lives only in memory. Synced ones (`sync: true`) instead come with the copy the server keeps
 * (`LocalNote.remoteSnapshot`): shown and searched without asking, read again by the server every few hours or with
 * "Sync now".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  currentSnapshot,
  encodeRemotePath,
  prepareRemoteMarkdown,
  remoteNoteOf,
  remoteWebUrl,
  resolveRemoteSource,
  type RemoteHost,
  type RemoteNoteResponse,
  type RemoteProblem,
  type RemoteSnapshot,
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

const syncing = new Map<string, Promise<RemoteSnapshot | RemoteState>>();

/** "Sync now" of a synced remote note: the server reads the document and keeps the copy; every device gets it */
export function syncRemote(id: string): Promise<RemoteSnapshot | RemoteState> {
  if (DEMO) return Promise.resolve({ state: 'demo' });
  let job = syncing.get(id);
  if (!job) {
    job = api<RemoteSnapshot>(`/remote-notes/${encodeURIComponent(id)}/sync`, { method: 'POST' })
      .catch((err): RemoteState => {
        if (!(err instanceof ApiError)) return { state: 'offline' };
        return { state: err.status === 404 || err.status === 409 ? 'missing' : err.status === 429 ? 'busy' : 'unreachable' };
      })
      .finally(() => syncing.delete(id));
    syncing.set(id, job);
  }
  return job;
}

const isSnapshot = (r: RemoteSnapshot | RemoteState): r is RemoteSnapshot => !('state' in r);

/** A kept copy as what the note shows: its text, or why there is none */
export function snapshotState(snap: RemoteSnapshot): RemoteState {
  if (snap.fetchedAt && snap.base) return { state: 'ok', text: snap.text, base: snap.base, url: snap.url, commit: snap.commit, fetchedAt: snap.fetchedAt };
  return { state: snap.problem ?? 'loading' };
}

/** The document as it is now (exports, embeds): the kept copy of a synced note, otherwise asked for live */
export async function currentRemote(id: string): Promise<RemoteState> {
  const note = vault.get(id);
  const src = note && !note.partial ? remoteNoteOf(note.content) : null;
  if (!src?.sync) return fetchRemote(id);
  const snap = currentSnapshot(src, note!.remoteSnapshot);
  if (snap?.fetchedAt) return snapshotState(snap);
  const r = await syncRemote(id);
  return isSnapshot(r) ? snapshotState(r) : r;
}

let config: Promise<number> | null = null;

/** How often the server reads synced remote notes again, in hours; 0 while unknown */
export function useRemoteSyncHours(): number {
  const [hours, setHours] = useState(0);
  useEffect(() => {
    let live = true;
    config ??= DEMO
      ? Promise.resolve(0)
      : api<{ syncHours: number }>('/remote-notes/config').then(
          (c) => c.syncHours,
          () => {
            config = null;
            return 0;
          }
        );
    void config.then((h) => live && setHours(h));
    return () => {
      live = false;
    };
  }, []);
  return hours;
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
  const r = await currentRemote(id);
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
  /** Live: asks again. Synced: "Sync now" */
  reload: () => void;
  /** Only for a synced note: when the server last read it, and why that or the last "Sync now" failed */
  sync: { checkedAt: number; problem?: RemoteState['state'] } | null;
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
  // Synced: the copy that came with the note, or a newer one from "Sync now" until the note brings it too
  const sync = !!source?.sync;
  const stored = useMemo(() => (note && source ? currentSnapshot(source, note.remoteSnapshot) : null), [note, source]);
  const [synced, setSynced] = useState<{ key: string; snap: RemoteSnapshot } | null>(null);
  const hasStored = !!stored;
  // A newer copy from the server ends what a failed "Sync now" said
  const storedAt = stored?.checkedAt ?? 0;
  useEffect(() => {
    if (sync && storedAt) setAnswer(null);
  }, [sync, storedAt]);
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
    const refresh = forced.current;
    // A synced note shows its copy; the server is asked only for "Sync now", or when there is no copy yet
    if (sync && hasStored && !refresh) return;
    const mine = ++seq.current;
    forced.current = false;
    setLoading(true);
    if (sync) {
      void syncRemote(id).then((r) => {
        if (mine !== seq.current) return;
        if (isSnapshot(r)) {
          setSynced({ key, snap: r });
          setAnswer(null);
        } else setAnswer({ key, result: r });
        setLoading(false);
      });
    } else {
      void fetchRemote(id, refresh).then((result) => {
        if (mine !== seq.current) return;
        setAnswer({ key, result });
        setLoading(false);
      });
    }
    return () => {
      seq.current++;
      setLoading(false);
    };
  }, [ready, key, id, tick, sync, hasStored]);

  const reload = useCallback(() => {
    forced.current = true;
    setTick((n) => n + 1);
  }, []);

  const mine = synced?.key === key ? synced.snap : null;
  const snap = stored && mine ? (mine.checkedAt > stored.checkedAt ? mine : stored) : (stored ?? mine);
  const failed = answer?.key === key ? answer.result : null;
  const result: RemoteState = snap ? snapshotState(snap) : (failed ?? { state: 'loading' });
  const offline = result.state === 'offline';
  useEffect(() => {
    if (!offline) return;
    window.addEventListener('online', reload);
    return () => window.removeEventListener('online', reload);
  }, [offline, reload]);

  const text = useMemo(() => (result.state === 'ok' ? remoteDisplayText(id, result) : ''), [id, result]);
  const syncInfo = sync && snap ? { checkedAt: snap.checkedAt, problem: failed && failed.state !== 'ok' ? failed.state : snap.problem } : null;
  return source && resolved ? { source, resolved, result, text, loading: loading || result.state === 'loading', reload, sync: syncInfo } : null;
}
