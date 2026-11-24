/**
 * Variables on this device (shared/variables.ts): the definitions of every space the user sees and the scope of a
 * folder. Looked up on every render, so nothing is parsed again unless a definition note changed (#64): the list of
 * definition notes depends on the paths, their texts are compared by identity, scopes are kept per folder.
 */
import { useSyncExternalStore } from 'react';
import {
  EMPTY_VARIABLE_SCOPE,
  canWriteInGroup,
  isVariableName,
  isVariablesPath,
  parseVariables,
  readFrontmatterYaml,
  setVariable,
  splitPath,
  variableDefinitions,
  variableKey,
  variableScope,
  variablesFileName,
  writeVariables,
  type VariableDefinitions,
  type VariableScope,
} from '@kladde/shared';
import { isReadOnly } from '../lib/readOnly';
import { t } from '../lib/i18n';
import type { LocalNote } from './db';
import { spaceOf, vault } from './vault';

/** `own`, `group:<id>` or `user:<name>` (notes shared by someone), like `spaceOf` */
export type VariableSpace = string;

let seenVersion = -1;
let seenPaths = -1;
let ids: string[] = [];
/** What each space's definitions were built from */
const sources = new Map<VariableSpace, { key: LocalNote[]; definitions: VariableDefinitions }>();
const scopes = new Map<string, VariableScope>();

function refresh(): void {
  const version = vault.getVersion();
  if (version === seenVersion) return;
  seenVersion = version;
  if (seenPaths !== vault.getPathStamp()) {
    seenPaths = vault.getPathStamp();
    ids = [...vault.notes.values()].filter((n) => isVariablesPath(n.path)).map((n) => n.id);
  }
  const bySpace = new Map<VariableSpace, LocalNote[]>();
  for (const id of ids) {
    const n = vault.get(id);
    if (!n) continue;
    const space = spaceOf(n);
    const list = bySpace.get(space);
    if (list) list.push(n);
    else bySpace.set(space, [n]);
  }
  for (const space of new Set([...bySpace.keys(), ...sources.keys()])) {
    const next = bySpace.get(space) ?? [];
    const before = sources.get(space)?.key ?? [];
    if (next.length === before.length && next.every((n, i) => n.id === before[i].id && n.path === before[i].path && n.content === before[i].content)) continue;
    if (next.length) sources.set(space, { key: next, definitions: variableDefinitions(next) });
    else sources.delete(space);
    for (const k of scopes.keys()) if (k.startsWith(`${space}\n`)) scopes.delete(k);
  }
}

/** The variables a folder of a space sees; the same object until one of them changes */
export function variablesOfFolder(space: VariableSpace, folder: string): VariableScope {
  refresh();
  const source = sources.get(space);
  const key = `${space}\n${folder}`;
  let scope = scopes.get(key);
  if (!scope) scopes.set(key, (scope = variableScope(folder, source?.definitions ?? new Map())));
  return scope;
}

export function variablesOfNote(note: LocalNote): VariableScope {
  return variablesOfFolder(spaceOf(note), splitPath(note.path).folder);
}

/** The variables a note or folder sees, following every change; nothing to look at gives an empty scope */
export function useVariables(target: LocalNote | { space: VariableSpace; folder: string } | null | undefined): VariableScope {
  return useSyncExternalStore(vault.subscribe, () => (!target ? EMPTY_VARIABLE_SCOPE : 'space' in target ? variablesOfFolder(target.space, target.folder) : variablesOfNote(target)));
}

export function canEditVariables(space: VariableSpace): boolean {
  if (isReadOnly()) return false;
  if (space === 'own') return true;
  return space.startsWith('group:') && canWriteInGroup(vault.group(space.slice('group:'.length))?.role);
}

/** Nothing but the (now empty) variables in it: the note goes */
function isEmptyDefinition(content: string): boolean {
  const fm = readFrontmatterYaml(content);
  return !!fm && !fm.body.trim() && Object.keys(fm.data).every((k) => k === 'type' || k === 'variables') && !parseVariables(content)?.length;
}

/** Sets a folder's own variable, or removes it (`value` null) */
export async function saveVariable(space: VariableSpace, folder: string, name: string, value: string | null): Promise<void> {
  if (!canEditVariables(space)) throw new Error(t('vars.noWrite'));
  if (value !== null && !isVariableName(name)) throw new Error(t('vars.badName'));
  const notes = () =>
    [...vault.notes.values()]
      .filter((n) => !n.deleted && isVariablesPath(n.path) && spaceOf(n) === space && splitPath(n.path).folder === folder)
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const n of notes()) if (n.partial) await vault.ensureFull(n.id);
  const here = notes().filter((n) => !n.partial && parseVariables(n.content));
  const holders = here.filter((n) => parseVariables(n.content)!.some((d) => variableKey(d.name) === variableKey(name)));
  if (value === null) {
    for (const n of holders) {
      const content = writeVariables(n.content, setVariable(parseVariables(n.content)!, name, null));
      if (isEmptyDefinition(content)) await vault.remove(n.id);
      else await vault.update(n.id, { content });
    }
    return;
  }
  const target = holders[0] ?? here[0];
  if (target) {
    await vault.update(target.id, { content: writeVariables(target.content, setVariable(parseVariables(target.content)!, name, value)) });
    return;
  }
  const title = variablesFileName(crypto.randomUUID()).replace(/\.md$/, '');
  const content = writeVariables('', setVariable([], name, value));
  if (space.startsWith('group:')) await vault.createInGroup(space.slice('group:'.length), folder, title, content);
  else await vault.create(folder, title, content);
}
