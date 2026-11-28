import type { GitEventCore, GitEventOwner, GitEventType } from '@kladde/plugin-api';

/** Where an event came from: the central webhook (never handed to plugins) */
export interface EventSourceRef {
  id: string;
  /** Who created the webhook; Kladde's own subscribers act as this person */
  createdBy: string;
}

/** What travels on the bus: the normalised event, its owner and its source */
export interface BusMessage {
  event: GitEventCore;
  owner: GitEventOwner;
  source: EventSourceRef;
  /** The provider's JSON, for plugins that ask for it (`rawPayload`) */
  rawPayload?: unknown;
}

export interface Subscriber {
  /** For logs and the admin dashboard, e.g. `tickets` or `plugin:logbook` */
  name: string;
  /** Only these types (all when left out) */
  types?: readonly GitEventType[];
  /** May return a short summary for the delivery list (e.g. which tickets changed) */
  handle(message: BusMessage): void | string | Promise<void | string>;
}

export interface SubscriberOutcome {
  name: string;
  ok: boolean;
  summary?: string;
  error?: string;
}

/**
 * The server's in-process event bus (#149): every event goes to every subscriber of its type. Each subscriber gets
 * its events one after another in the order they came (a queue per subscriber), and its errors only reach
 * `onError` — they never stop or slow down the others. Events live in memory only: what is still queued at a
 * restart is gone (the delivery list shows it as received).
 */
export class EventBus {
  private readonly subscribers: { sub: Subscriber; queue: Promise<void> }[] = [];

  constructor(private readonly onError: (subscriber: string, message: BusMessage, err: unknown) => void = () => {}) {}

  subscribe(sub: Subscriber): () => void {
    const entry = { sub, queue: Promise.resolve() };
    this.subscribers.push(entry);
    return () => {
      const i = this.subscribers.indexOf(entry);
      if (i >= 0) this.subscribers.splice(i, 1);
    };
  }

  get size(): number {
    return this.subscribers.length;
  }

  /** Queues the event at every subscriber of its type; resolves once all of them handled it */
  publish(message: BusMessage): Promise<SubscriberOutcome[]> {
    const runs = this.subscribers
      .filter(({ sub }) => !sub.types || sub.types.includes(message.event.type))
      .map((entry) => {
        const run = entry.queue.then(async (): Promise<SubscriberOutcome> => {
          try {
            const summary = await entry.sub.handle(message);
            return { name: entry.sub.name, ok: true, ...(typeof summary === 'string' && summary ? { summary: summary.slice(0, 200) } : {}) };
          } catch (err) {
            try {
              this.onError(entry.sub.name, message, err);
            } catch {
              // A failing error handler must not break the queue either
            }
            return { name: entry.sub.name, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'error' };
          }
        });
        entry.queue = run.then(() => undefined);
        return run;
      });
    return Promise.all(runs);
  }
}
