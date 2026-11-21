import crypto from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import type { MergeRequestInfo, TicketEvent, TicketHookProvider } from '@kladde/shared';
import { sameSecret } from './TicketHookStore.js';

type GitEvent = Extract<TicketEvent, { mr: MergeRequestInfo }>;

const header = (h: IncomingHttpHeaders, name: string): string => {
  const v = h[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};
const text = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Whether the request comes from the provider that knows the secret: GitLab's token header, GitHub's HMAC signature */
export function verifyDelivery(provider: TicketHookProvider, headers: IncomingHttpHeaders, body: Buffer, secret: string): boolean {
  if (provider === 'gitlab') return sameSecret(header(headers, 'x-gitlab-token'), secret);
  const sig = header(headers, 'x-hub-signature-256');
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return sameSecret(sig, expected);
}

/** The merge request event of a delivery; null for other events (pushes, comments, pings, updates) */
export function gitEventOf(provider: TicketHookProvider, headers: IncomingHttpHeaders, payload: unknown): GitEvent | null {
  const body = obj(payload);
  if (provider === 'gitlab') {
    if (header(headers, 'x-gitlab-event') !== 'Merge Request Hook' && body.object_kind !== 'merge_request') return null;
    const a = obj(body.object_attributes);
    const action = text(a.action);
    const type = action === 'open' || action === 'reopen' ? 'mr_opened' : action === 'merge' ? 'mr_merged' : action === 'close' ? 'mr_closed' : null;
    if (!type) return null;
    const iid = Number(a.iid);
    return {
      type,
      mr: {
        provider,
        title: text(a.title, 500),
        url: text(a.url, 500),
        number: Number.isFinite(iid) ? iid : null,
        branch: text(a.source_branch, 300),
        author: text(obj(body.user).username, 100),
        description: text(a.description),
      },
    };
  }
  if (header(headers, 'x-github-event') !== 'pull_request') return null;
  const pr = obj(body.pull_request);
  const action = text(body.action);
  const type = action === 'opened' || action === 'reopened' ? 'mr_opened' : action === 'closed' ? (pr.merged === true ? 'mr_merged' : 'mr_closed') : null;
  if (!type) return null;
  const n = Number(pr.number);
  return {
    type,
    mr: {
      provider,
      title: text(pr.title, 500),
      url: text(pr.html_url, 500),
      number: Number.isFinite(n) ? n : null,
      branch: text(obj(pr.head).ref, 300),
      author: text(obj(pr.user).login, 100),
      description: text(pr.body),
    },
  };
}
