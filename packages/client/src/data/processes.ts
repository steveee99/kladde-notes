/**
 * Guided processes on the device (part of the feature `cockpit`): models (`_process-<uuid>.md`) and runs
 * (`_process-run-<uuid>.md`) are hidden notes at the top of the own space or a group's and sync like any note.
 * What the steps check (Jira, merge requests, branches, pipelines) is read live through the cockpit's queries
 * (`runWidget`), so the run never holds a copy of it. The engine itself lives in `shared/process.ts`.
 */
import { useSyncExternalStore } from 'react';
import {
  canWriteInGroup,
  exampleProcesses,
  isProcessModelPath,
  isProcessRunPath,
  nextProcessVersion,
  NoteMemo,
  normalizeWidget,
  parseProcessNote,
  parseRunNote,
  processFileName,
  processRunFileName,
  serializeProcess,
  serializeRun,
  splitPath,
  type ProcessModel,
  type ProcessRun,
} from '@kladde/shared';
import { newUuid } from '../lib/uuid';
import { compareText } from '../lib/i18n';
import { vault } from './vault';
import type { LocalNote } from './db';
import { runWidget } from './cockpit';

export interface ModelRef {
  noteId: string;
  /** Group id when the model belongs to a group's space */
  group?: string;
  canEdit: boolean;
  model: ProcessModel;
}

export interface RunRef {
  noteId: string;
  group?: string;
  canEdit: boolean;
  run: ProcessRun;
  updatedAt: number;
}

const modelMemo = new NoteMemo<ProcessModel | null>((n) => parseProcessNote(n.content));
const runMemo = new NoteMemo<ProcessRun | null>((n) => parseRunNote(n.content));

/** Hidden process notes at the top of the own space and of the groups' */
function processNotes(test: (path: string) => boolean): LocalNote[] {
  return [...vault.notes.values()]
    .filter((n) => !n.deleted && test(n.path) && splitPath(n.path).folder === '' && (n.group ? true : n.access === 'owner'))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

const canEditNote = (n: LocalNote) => (n.group ? canWriteInGroup(vault.group(n.group)?.role) : true);

let cachedVersion = -1;
let cachedModels: ModelRef[] = [];
let cachedRuns: RunRef[] = [];

function refresh(): void {
  if (cachedVersion === vault.getVersion()) return;
  cachedVersion = vault.getVersion();
  cachedModels = processNotes(isProcessModelPath).flatMap((n) => {
    const model = n.partial ? null : modelMemo.get(n);
    return model ? [{ noteId: n.id, ...(n.group ? { group: n.group } : {}), canEdit: canEditNote(n), model }] : [];
  }).sort((a, b) => compareText(a.model.title, b.model.title));
  cachedRuns = processNotes(isProcessRunPath).flatMap((n) => {
    const run = n.partial ? null : runMemo.get(n);
    return run ? [{ noteId: n.id, ...(n.group ? { group: n.group } : {}), canEdit: canEditNote(n), run, updatedAt: n.updatedAt }] : [];
  });
}

export function processModels(): ModelRef[] {
  refresh();
  return cachedModels;
}

export function processRuns(): RunRef[] {
  refresh();
  return cachedRuns;
}

/** The models of one space by key (the oldest of a key wins), as the engine wants them */
export function modelsOfSpace(group: string | undefined): Map<string, ProcessModel> {
  const out = new Map<string, ProcessModel>();
  const oldest = [...processModels()].sort((a, b) => (vault.notes.get(a.noteId)?.createdAt ?? 0) - (vault.notes.get(b.noteId)?.createdAt ?? 0));
  for (const m of oldest) if ((m.group ?? '') === (group ?? '') && !out.has(m.model.key)) out.set(m.model.key, m.model);
  return out;
}

export function useProcesses(): { models: ModelRef[]; runs: RunRef[] } {
  const models = useSyncExternalStore(vault.subscribe, processModels);
  const runs = useSyncExternalStore(vault.subscribe, processRuns);
  return { models, runs };
}

/** Online mode: the texts of the hidden process notes (they come without text in the catalog) */
export async function loadProcesses(): Promise<void> {
  await Promise.all([...processNotes(isProcessModelPath), ...processNotes(isProcessRunPath)].filter((n) => n.partial).map((n) => vault.ensureFull(n.id)));
}

const EXAMPLES_SETTING = 'processExamples';

/** The two example models, made once per account (not again after the user deleted them) */
export async function ensureExampleProcesses(lang: 'de' | 'en'): Promise<void> {
  if (vault.setting<boolean>(EXAMPLES_SETTING)) return;
  await loadProcesses();
  const own = processNotes(isProcessModelPath).filter((n) => !n.group);
  if (!own.length) for (const m of exampleProcesses(lang)) await createModel(m);
  await vault.setSetting(EXAMPLES_SETTING, true);
}

export async function createModel(model: ProcessModel, group?: string): Promise<string> {
  const title = processFileName(newUuid()).replace(/\.md$/, '');
  const content = serializeProcess(nextProcessVersion(null, model));
  const note = group ? await vault.createInGroup(group, '', title, content) : await vault.create('', title, content);
  return note.id;
}

/** Saves an edited model: the version goes up and new steps get it as `since` */
export async function saveModel(noteId: string, edited: ProcessModel): Promise<ProcessModel> {
  const note = await vault.ensureFull(noteId);
  if (!note) throw new Error('not found');
  const before = parseProcessNote(note.content);
  const next = nextProcessVersion(before, edited);
  const content = serializeProcess(next);
  if (content !== note.content) await vault.update(noteId, { content });
  return next;
}

export async function createRun(run: ProcessRun, group?: string): Promise<string> {
  const title = processRunFileName(newUuid()).replace(/\.md$/, '');
  const note = group ? await vault.createInGroup(group, '', title, serializeRun(run)) : await vault.create('', title, serializeRun(run));
  return note.id;
}

export async function saveRun(noteId: string, run: ProcessRun): Promise<void> {
  const note = await vault.ensureFull(noteId);
  if (!note) throw new Error('not found');
  const content = serializeRun(run);
  if (content !== note.content) await vault.update(noteId, { content });
}

export async function deleteProcessNote(noteId: string): Promise<void> {
  await vault.remove(noteId);
}

// ------------------------------------------------------------------ live answers

/** A cockpit query as a widget (the cockpit endpoint takes widgets) */
export function queryWidget(source: ProcessModel['stages'][number]['steps'][number]['query'] & object, limit = 100) {
  return normalizeWidget({ title: 'process', source: { kind: source.source, params: source.params }, filters: source.filters, limit })!;
}

export { runWidget };
