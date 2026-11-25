/**
 * GitLab preview cards on this device (shared/gitlabCard.ts): which instances the server reads, and the cards
 * themselves, asked for from the server and kept a minute in memory (several editors and embeds share one answer).
 */
import type { GitlabCardResponse, RemoteHost } from '@kladde/shared';
import { DEMO } from '../demo/demoApi';
import { api, ApiError } from '../lib/api';
import type { GitlabCardState } from '../editor/host';

/** How long a card is shown without asking again */
const FRESH_MS = 60_000;
/** Instances are asked for again after this long (an admin may have changed them) */
const HOSTS_MS = 10 * 60_000;
const MAX_CARDS = 200;

let hosts: RemoteHost[] = [];
let hostsAt = 0;
let hostsJob: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** The configured instances, empty until known; the first call (and one after a while) asks the server */
export function remoteHosts(): readonly RemoteHost[] {
  if (!DEMO && !hostsJob && Date.now() - hostsAt > HOSTS_MS) {
    hostsJob = api<RemoteHost[]>('/remote-notes/hosts')
      .then(
        (list) => {
          const changed = JSON.stringify(list) !== JSON.stringify(hosts);
          hosts = Array.isArray(list) ? list : [];
          if (changed) listeners.forEach((fn) => fn());
        },
        () => undefined
      )
      .finally(() => {
        hostsAt = Date.now();
        hostsJob = null;
      });
  }
  return hosts;
}

export function onRemoteHosts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const cards = new Map<string, { at: number; job: Promise<GitlabCardState> }>();

/** The card of an address; `refresh` asks GitLab again instead of using what the server or this device keep */
export function loadGitlabCard(url: string, refresh = false): Promise<GitlabCardState> {
  if (DEMO) return Promise.resolve({ state: 'demo' });
  const kept = cards.get(url);
  if (kept && !refresh && Date.now() - kept.at < FRESH_MS) return kept.job;
  const job = api<GitlabCardResponse>(`/remote-notes/card?url=${encodeURIComponent(url)}${refresh ? '&refresh=1' : ''}`).catch((err): GitlabCardState => {
    cards.delete(url);
    if (!(err instanceof ApiError)) return { state: 'offline' };
    return { state: err.status === 429 ? 'busy' : 'unreachable' };
  });
  cards.delete(url);
  cards.set(url, { at: Date.now(), job });
  if (cards.size > MAX_CARDS) cards.delete(cards.keys().next().value!);
  return job;
}
