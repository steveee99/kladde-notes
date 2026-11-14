/**
 * Browser-only demo (#24, built with `npm run build:demo`, published on GitHub Pages): there is no
 * server, so requests to `/api/…` are answered here. The vault works as in the desktop app
 * (`standalone`): notes live in this browser's IndexedDB, sync accepts every change, and the trash is
 * kept in localStorage. Sharing, attachments, history and AI access need a server and say so.
 */
import type { Me, PullResponse, PushChange, PushResult, SyncedNote, TrashEntry, TrashList } from '@kladde/shared';
import { t } from '../lib/i18n';

/** True in the demo build (`VITE_DEMO=1`) */
export const DEMO = import.meta.env.VITE_DEMO === '1';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const TRASH_KEY = 'kladde_demo_trash';
const RESTORED_KEY = 'kladde_demo_restored';

const ME: Me = {
  id: 'demo',
  username: 'demo',
  createdAt: Date.UTC(2026, 0, 1),
  passkeys: [],
  hasPassword: false,
  isAdmin: false,
  avatarUrl: null,
  standalone: true,
};

interface DemoTrashEntry extends TrashEntry {
  content: string;
  version: number;
  createdAt: number;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: the demo just forgets
  }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const unavailable = () => json({ error: t('demo.unavailable') }, 400);

function push(changes: PushChange[]): PushResult[] {
  const trash = read<DemoTrashEntry[]>(TRASH_KEY, []);
  const results = changes.map((c): PushResult => {
    if (c.deleted && c.baseVersion > 0 && !c.path.startsWith('.kladde/')) {
      const rest = trash.filter((e) => e.id !== c.id);
      rest.unshift({
        id: c.id,
        path: c.path,
        content: c.content,
        deletedAt: Date.now(),
        deletedBy: null,
        batch: c.trashBatch ?? null,
        folder: c.trashBatch ? (c.trashFolder ?? null) : null,
        size: new TextEncoder().encode(c.content).length,
        version: c.baseVersion + 1,
        createdAt: c.createdAt,
      });
      trash.splice(0, trash.length, ...rest);
    }
    return { id: c.id, status: 'ok', version: c.baseVersion + 1 };
  });
  write(TRASH_KEY, trash);
  return results;
}

/** Restored notes reach the vault through the next pull, like from a server */
function restore(ids: string[]): { restored: { id: string; path: string }[] } {
  const trash = read<DemoTrashEntry[]>(TRASH_KEY, []);
  const pending = read<SyncedNote[]>(RESTORED_KEY, []);
  const restored: { id: string; path: string }[] = [];
  for (const e of trash.filter((x) => ids.includes(x.id))) {
    pending.push({ id: e.id, path: e.path, content: e.content, version: e.version + 1, createdAt: e.createdAt, updatedAt: Date.now(), deleted: false, access: 'owner' });
    restored.push({ id: e.id, path: e.path });
  }
  write(TRASH_KEY, trash.filter((x) => !ids.includes(x.id)));
  write(RESTORED_KEY, pending);
  return { restored };
}

function pull(): PullResponse {
  const notes = read<SyncedNote[]>(RESTORED_KEY, []);
  write(RESTORED_KEY, []);
  return { notes, revoked: [], cursor: Date.now(), sharedFolders: [] };
}

function handle(path: string, method: string, body: unknown): Response {
  const parts = path.split('/').filter(Boolean);
  if (path === '/auth/me' || path === '/auth/dev-login') return json(ME);
  if (path === '/auth/logout') return json({ ok: true });
  if (path === '/sync') return method === 'POST' ? json({ results: push(((body as { changes?: PushChange[] })?.changes ?? []).slice(0, 500)) }) : json(pull());
  if (path === '/presence' || path === '/presence/cursor') return json(null);
  if (path === '/files' && method === 'GET') return json([]);
  if (path === '/trash') {
    if (method === 'DELETE') {
      const n = read<DemoTrashEntry[]>(TRASH_KEY, []).length;
      write(TRASH_KEY, []);
      return json({ purged: n });
    }
    const entries = read<DemoTrashEntry[]>(TRASH_KEY, []).map(({ content: _c, version: _v, createdAt: _a, ...e }) => e);
    return json({ entries, retentionDays: 0 } satisfies TrashList);
  }
  if (parts[0] === 'trash' && parts[1] === 'batch' && parts[3] === 'restore') {
    const ids = read<DemoTrashEntry[]>(TRASH_KEY, [])
      .filter((e) => e.batch === decodeURIComponent(parts[2]))
      .map((e) => e.id);
    return json(restore(ids));
  }
  if (parts[0] === 'trash' && parts[2] === 'restore') return json(restore([decodeURIComponent(parts[1])]));
  if (parts[0] === 'trash' && parts.length === 2 && method === 'DELETE') {
    const id = decodeURIComponent(parts[1]);
    const trash = read<DemoTrashEntry[]>(TRASH_KEY, []);
    write(TRASH_KEY, trash.filter((e) => e.id !== id));
    return json({ purged: trash.length - read<DemoTrashEntry[]>(TRASH_KEY, []).length });
  }
  if (parts[0] === 'notes' && parts[2] === 'versions' && parts.length === 3) return json([]);
  if (path === '/mcp/connections' || path === '/import-tokens' || path === '/calendar-feeds' || path === '/push/devices') return method === 'GET' ? json([]) : unavailable();
  if (path === '/auth/providers') return json({});
  return unavailable();
}

/** Answers `/api/…` in the browser; call before anything talks to the API */
export function installDemoApi(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    let p = url.pathname;
    if (BASE && p.startsWith(`${BASE}/`)) p = p.slice(BASE.length);
    if (url.origin !== location.origin || !p.startsWith('/api/')) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }
    return handle(p.slice(4), method, body);
  };
  // No server to stream live changes from: the vault skips its event stream without EventSource
  (window as unknown as { EventSource?: unknown }).EventSource = undefined;
}
