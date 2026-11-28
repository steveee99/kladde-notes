import type { MergeRequestInfo, TicketEvent } from '@kladde/shared';
import type { NoteStore } from '../NoteStore.js';
import type { UserStore } from '../UserStore.js';
import { applyGitEvent } from '../hooks/router.js';
import type { Subscriber } from './EventBus.js';

const TICKET_EVENT = { opened: 'mr_opened', reopened: 'mr_opened', merged: 'mr_merged', closed: 'mr_closed' } as const;

/**
 * Kladde's ticket automations as the bus's first subscriber: a merge request event of a central webhook runs the
 * automations of every ticket project of the webhook's owner whose tickets the merge request names (key in title,
 * branch or description), as the person who created the webhook — the same rules as a project's own webhook.
 */
export function ticketSubscriber(notes: NoteStore, users: UserStore): Subscriber {
  return {
    name: 'tickets',
    types: ['git.merge_request'],
    handle({ event, owner, source }) {
      if (event.type !== 'git.merge_request') return;
      const type = TICKET_EVENT[event.action as keyof typeof TICKET_EVENT];
      if (!type) return;
      const m = event.mergeRequest;
      const mr: MergeRequestInfo = { provider: event.provider, title: m.title, url: m.url, number: m.number || null, branch: m.sourceBranch, author: m.author, description: m.description };
      const ticketEvent = { type, mr } as Extract<TicketEvent, { mr: MergeRequestInfo }>;
      const done: string[] = [];
      const refused: string[] = [];
      for (const noteId of notes.projectIdsOf(owner.id)) {
        const result = applyGitEvent(notes, users, { noteId, createdBy: source.createdBy }, ticketEvent);
        if (!result.ok) refused.push(result.summary);
        else if (result.tickets.some((t) => t.automations.length)) done.push(result.summary);
      }
      if (refused.length) throw new Error(refused[0]);
      return done.join('; ');
    },
  };
}
