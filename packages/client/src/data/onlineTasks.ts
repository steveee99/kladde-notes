import type { OnlineTaskNote, OnlineTasks, OnlineTaskTuple, Task } from '@kladde/shared';
import { api } from '../lib/api';
import { vault } from './vault';

/**
 * Online mode: the tasks of the notes whose text is not on the device, from the server's index
 * (`GET /api/online/tasks`). Asked once per sync of the vault; after the first answer only notes changed since come.
 */
class OnlineTaskStore {
  /** Tasks by note id (notes without tasks are not kept) */
  readonly notes = new Map<string, OnlineTaskNote>();
  /** Changes with every answer that changed `notes` */
  stamp = 0;
  private cursor = 0;
  private sig = '';
  private user = '';
  /** `vault.lastSync` of the last question (undefined: ask on the next call) */
  private askedFor: number | null | undefined = undefined;
  private running = false;
  private again = false;

  /** Asks the server for the tasks changed since the last answer, once per sync; the views update when they come */
  want(): void {
    if (!vault.online) return;
    const user = vault.localDb()?.userId ?? '';
    if (user !== this.user) {
      this.notes.clear();
      this.stamp++;
      this.cursor = 0;
      this.sig = '';
      this.user = user;
      this.askedFor = undefined;
    }
    // After the first sync: the catalog (paths) comes first, the tasks need it
    if (!user || vault.lastSync === null || vault.lastSync === this.askedFor) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.askedFor = vault.lastSync;
    this.running = true;
    api<OnlineTasks>(`/online/tasks?since=${this.cursor}&sig=${encodeURIComponent(this.sig)}`)
      .then((res) => {
        if (user !== this.user) return;
        if (res.reset) this.notes.clear();
        for (const n of res.notes) {
          if (n.tasks.length) this.notes.set(n.id, n);
          else this.notes.delete(n.id);
        }
        this.cursor = res.cursor;
        this.sig = res.sig;
        if (res.reset || res.notes.length) {
          this.stamp++;
          vault.refreshViews();
        }
      })
      .catch(() => {
        // Not reachable: asked again with the next sync
      })
      .finally(() => {
        this.running = false;
        if (this.again) {
          this.again = false;
          this.want();
        }
      });
  }
}

export const onlineTasks = new OnlineTaskStore();

/** A task from the server's tuple; `defaultDue` as `parseTasks` applies it (a daily note's date) */
export function taskOfTuple(tuple: OnlineTaskTuple, defaultDue: string | null): Task {
  const [line, status, text, due = null, repeat = null, time = null, doneDate = null, indent = '- ', id = null, after = null] = tuple;
  return {
    line,
    text,
    done: status === 'done',
    status,
    doneDate,
    due: due ?? defaultDue,
    repeat,
    time,
    indent,
    ...(!due && defaultDue ? { dueFromNote: true } : {}),
    ...(id ? { id } : {}),
    ...(after ? { after: after.split(',') } : {}),
  };
}
