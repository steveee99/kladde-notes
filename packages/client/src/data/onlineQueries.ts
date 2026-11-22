import type { QueryResult } from '@kladde/shared';
import { api } from '../lib/api';
import { vault } from './vault';

/**
 * Online mode: query blocks (```query```) run on the server (`POST /api/online/query`), over every note the user may
 * see, because the device holds the texts of only the notes it loaded. A block shows its last answer at once and is
 * asked again after every sync; the server answers `same` while nothing it sees changed.
 */

type Answer = QueryResult | { error: string };

interface Entry {
  answer: Answer | null;
  stamp: string;
  /** `vault.lastSync` of the last question */
  askedFor: number | null | undefined;
  running: boolean;
}

/** Blocks kept: the ones of the open notes, and some more for going back and forth */
const MAX_ENTRIES = 50;

class OnlineQueryStore {
  private entries = new Map<string, Entry>();
  private user = '';

  /** The block's answer, `loading` until the first one came; asks the server once per sync */
  get(src: string): Answer | { loading: true } {
    const user = vault.localDb()?.userId ?? '';
    if (user !== this.user) {
      this.entries.clear();
      this.user = user;
    }
    let entry = this.entries.get(src);
    if (!entry) {
      entry = { answer: null, stamp: '', askedFor: undefined, running: false };
      this.entries.set(src, entry);
      if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    }
    if (!entry.running && entry.askedFor !== vault.lastSync) this.ask(src, entry, user);
    return entry.answer ?? { loading: true };
  }

  private ask(src: string, entry: Entry, user: string): void {
    entry.askedFor = vault.lastSync;
    entry.running = true;
    const daily = vault.features().daily;
    api<{ stamp: string; same?: boolean; result?: Answer }>('/online/query', { method: 'POST', json: { src, daily: daily.enabled ? daily : null, have: entry.answer ? entry.stamp : '' } })
      .then((res) => {
        if (user !== this.user) return;
        entry.stamp = res.stamp;
        if (res.same && entry.answer) return;
        entry.answer = res.result ?? { error: 'Keine Antwort' };
        vault.refreshViews();
      })
      .catch((e: unknown) => {
        if (user !== this.user) return;
        // Asked again with the next sync; an answer already shown stays
        entry.askedFor = undefined;
        if (!entry.answer) {
          entry.answer = { error: e instanceof Error ? e.message : String(e) };
          vault.refreshViews();
        }
      })
      .finally(() => {
        entry.running = false;
      });
  }
}

export const onlineQueries = new OnlineQueryStore();
