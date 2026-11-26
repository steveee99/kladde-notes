/**
 * Development cockpit on the device (opt-in feature `cockpit`): dashboards are hidden notes `_dashboard-<uuid>.md` at
 * the top of the own space or a group's (they sync like any note), their data comes live from the server
 * (`POST /api/cockpit/query`) with the user's own connections. Results are kept in memory only, so a dashboard opened
 * again (or offline) shows the last answer with its time until a new one arrives; nothing of it is stored on disk.
 */
import { useSyncExternalStore } from 'react';
import {
  canWriteInGroup,
  dashboardFileName,
  defaultDashboard,
  isDashboardPath,
  NoteMemo,
  parseDashboardNote,
  parseFrontmatter,
  serializeDashboard,
  splitPath,
  widgetVariables,
  type CockpitConnections,
  type CockpitDashboard,
  type CockpitResult,
  type CockpitWidget,
} from '@kladde/shared';
import { api, ApiError } from '../lib/api';
import { newUuid } from '../lib/uuid';
import { vault } from './vault';
import type { LocalNote } from './db';

export interface DashboardRef {
  noteId: string;
  /** Group id for a team dashboard */
  group?: string;
  canEdit: boolean;
  dashboard: CockpitDashboard;
}

const memo = new NoteMemo<CockpitDashboard | null>((n) => parseDashboardNote(n.content));

/** Dashboard notes on the device: the own space first, then the groups' (each at the top of its space) */
function dashboardNotes(): LocalNote[] {
  return [...vault.notes.values()]
    .filter((n) => !n.deleted && isDashboardPath(n.path) && splitPath(n.path).folder === '' && (n.group ? true : n.access === 'owner'))
    .sort((a, b) => (!!a.group === !!b.group ? a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1) : a.group ? 1 : -1));
}

let cachedVersion = -1;
let cached: DashboardRef[] = [];

/** Every dashboard the user can open (partial notes in online mode only once loaded, see `loadDashboards`) */
export function dashboards(): DashboardRef[] {
  if (cachedVersion === vault.getVersion()) return cached;
  cachedVersion = vault.getVersion();
  cached = dashboardNotes().flatMap((n) => {
    if (n.partial) return [];
    const dashboard = memo.get(n);
    if (!dashboard) return [];
    const canEdit = n.group ? canWriteInGroup(vault.group(n.group)?.role) : true;
    return [{ noteId: n.id, ...(n.group ? { group: n.group } : {}), canEdit, dashboard }];
  });
  return cached;
}

export function useDashboards(): DashboardRef[] {
  return useSyncExternalStore(vault.subscribe, dashboards);
}

/** Online mode: the texts of the dashboard notes (hidden notes arrive without text in the catalog) */
export async function loadDashboards(): Promise<void> {
  await Promise.all(dashboardNotes().filter((n) => n.partial).map((n) => vault.ensureFull(n.id)));
}

/** Whether any dashboard note exists (loaded or not): a new account gets the first one made once */
export const hasDashboardNotes = (): boolean => dashboardNotes().some((n) => !n.group);

export async function createDashboard(d: CockpitDashboard, group?: string): Promise<string> {
  const title = dashboardFileName(newUuid()).replace(/\.md$/, '');
  const note = group ? await vault.createInGroup(group, '', title, serializeDashboard(d)) : await vault.create('', title, serializeDashboard(d));
  return note.id;
}

/** The first dashboard, made when the feature is switched on and there is none yet */
export async function ensureDefaultDashboard(lang: 'de' | 'en'): Promise<string | null> {
  await loadDashboards();
  if (hasDashboardNotes()) return null;
  return createDashboard(defaultDashboard(lang));
}

export async function saveDashboard(noteId: string, d: CockpitDashboard): Promise<void> {
  const note = await vault.ensureFull(noteId);
  if (!note) return;
  const content = serializeDashboard(d);
  if (content !== note.content) await vault.update(noteId, { content });
}

export async function deleteDashboard(noteId: string): Promise<void> {
  await vault.remove(noteId);
}

// ------------------------------------------------------------------ connections

let connections: CockpitConnections | null = null;
let connectionsError = '';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export async function refreshConnections(): Promise<CockpitConnections | null> {
  try {
    connections = await api<CockpitConnections>('/cockpit/connections');
    connectionsError = '';
  } catch (err) {
    connectionsError = (err as Error).message;
  }
  emit();
  return connections;
}

export function setConnections(next: CockpitConnections): void {
  connections = next;
  connectionsError = '';
  // A new token answers differently: every widget asks again
  results.clear();
  emit();
}

export function useConnections(): { connections: CockpitConnections | null; error: string } {
  const value = useSyncExternalStore(subscribe, () => connections);
  return { connections: value, error: connectionsError };
}

/** A connection request; the server answers a failed check with a problem code */
export async function saveConnection(provider: 'gitlab' | 'jira', body: Record<string, unknown>): Promise<CockpitConnections> {
  try {
    const next = await api<CockpitConnections>(`/cockpit/connections/${provider}`, { method: 'PUT', json: body });
    setConnections(next);
    return next;
  } catch (err) {
    if (err instanceof ApiError) {
      const data = err.data as { problem?: string; detail?: string };
      if (data.problem) throw new ConnectionProblem(data.problem, data.detail);
    }
    throw err;
  }
}

export async function removeConnection(provider: 'gitlab' | 'jira'): Promise<void> {
  setConnections(await api<CockpitConnections>(`/cockpit/connections/${provider}`, { method: 'DELETE' }));
}

export class ConnectionProblem extends Error {
  constructor(
    readonly problem: string,
    readonly detail?: string
  ) {
    super(problem);
  }
}

// ------------------------------------------------------------------ results

export interface WidgetState {
  result: CockpitResult | null;
  /** A request is running (the last result, if any, stays shown) */
  loading: boolean;
}

const results = new Map<string, { result: CockpitResult; at: number }>();
const running = new Map<string, Promise<CockpitResult>>();
const resultListeners = new Set<() => void>();
const emitResults = () => resultListeners.forEach((l) => l());

/** What a widget's answer depends on: the widget minus its look, and the variables it uses */
export function widgetKey(w: CockpitWidget, vars: Record<string, string>): string {
  const used = Object.fromEntries(widgetVariables(w).map((k) => [k, vars[k] ?? '']));
  return JSON.stringify([w.source, w.filters, w.sort ?? null, w.limit, used]);
}

/** The variables a widget block in a note sees: the note's variables and its properties as `this.<key>` */
export function noteVars(content: string, scope: { list(): { name: string; value: string }[] } | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of scope?.list() ?? []) out[v.name] = v.value;
  for (const [k, v] of Object.entries(parseFrontmatter(content).data)) out[`this.${k}`] = v;
  return out;
}

/** Runs a widget on the server (one request per widget and answer at a time) */
export function runWidget(w: CockpitWidget, vars: Record<string, string>, fresh = false): Promise<CockpitResult> {
  const key = widgetKey(w, vars);
  const busy = running.get(key);
  if (busy && !fresh) return busy;
  const ask = async (): Promise<CockpitResult> => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { problem: 'offline' };
    try {
      return await api<CockpitResult>('/cockpit/query', { method: 'POST', json: { widget: w, vars, ...(fresh ? { fresh: true } : {}) } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) return { problem: 'busy' };
      if (err instanceof ApiError && err.status > 0) return { problem: 'unreachable', detail: err.message };
      return { problem: 'offline' };
    }
  };
  const job = ask()
    .then((result) => {
      // Without a connection the time stays that of the last answer
      const before = results.get(key);
      results.set(key, { result, at: 'problem' in result && (result.problem === 'offline' || result.problem === 'busy') && before ? before.at : Date.now() });
      return result;
    })
    .finally(() => {
      running.delete(key);
      emitResults();
    });
  running.set(key, job);
  emitResults();
  return job;
}

/** The last result of a widget (rows stay shown when a later request fails) and whether one is running */
export function widgetState(w: CockpitWidget, vars: Record<string, string>): { result: CockpitResult | null; lastRows: CockpitResult | null; loading: boolean; at: number | null } {
  const key = widgetKey(w, vars);
  const hit = results.get(key);
  return { result: hit?.result ?? null, lastRows: hit && 'rows' in hit.result ? hit.result : (lastGood.get(key) ?? null), loading: running.has(key), at: hit?.at ?? null };
}

/** Rows of the last good answer, kept when a later one is a problem (offline: the last rows stay with their time) */
const lastGood = new Map<string, CockpitResult>();
resultListeners.add(() => {
  for (const [key, { result }] of results) if ('rows' in result) lastGood.set(key, result);
});

let resultVersion = 0;
resultListeners.add(() => resultVersion++);

export function useResults(): number {
  return useSyncExternalStore(
    (l) => {
      resultListeners.add(l);
      return () => resultListeners.delete(l);
    },
    () => resultVersion
  );
}
