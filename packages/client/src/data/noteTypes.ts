/** Custom note types on this device: which ones a note can have, and the actions that change their definitions (shared/noteTypes.ts) */
import {
  canWriteInGroup,
  customTypeOf,
  findNoteType,
  noteTypeFileName,
  noteTypeKey,
  readFrontmatterYaml,
  setFrontmatterValues,
  writeNoteType,
  type NoteType,
  type YamlValue,
} from '@kladde/shared';
import { isReadOnly } from '../lib/readOnly';
import { t } from '../lib/i18n';
import { newUuid } from '../lib/uuid';
import type { LocalNote } from './db';
import { spaceOf, vault } from './vault';

/** Spaces whose types the user may change: own notes and the groups they write in */
export function editableTypeSpaces(): { space: string; label: string }[] {
  return [{ space: 'own', label: t('types.ownSpace') }, ...vault.groups.filter((g) => canWriteInGroup(g.role)).map((g) => ({ space: `group:${g.id}`, label: g.name }))];
}

/** The types offered for a note: those of its space; in another space also the own ones it does not redefine */
export const noteTypeChoices = (note: LocalNote): NoteType[] => vault.noteTypes(spaceOf(note));

/** The type a note has, and whether it names one that is not modelled here */
export function typeOfNote(note: LocalNote): { type: NoteType | null; unknown: string | null } {
  const name = customTypeOf(note.content);
  if (name === null) return { type: null, unknown: null };
  const type = findNoteType(vault.noteTypes(spaceOf(note)), name);
  // Online mode: the definitions may still be on their way
  return { type, unknown: type || vault.noteTypesLoading() ? null : name };
}

/**
 * Saves a type (`note` null: a new one). A changed name leaves the old one as an alias; `renames` maps old property
 * names to new ones, whose values move in the notes of the type.
 */
export async function saveNoteType(space: string, note: LocalNote | null, type: NoteType, renames: Map<string, string>): Promise<void> {
  if (isReadOnly()) throw new Error(t('vault.readOnlyError'));
  if (!note) {
    const title = noteTypeFileName(newUuid()).replace(/\.md$/, '');
    const content = writeNoteType('', type);
    if (space.startsWith('group:')) await vault.createInGroup(space.slice('group:'.length), '', title, content);
    else await vault.create('', title, content);
    return;
  }
  const current = vault.get(note.id);
  if (!current) throw new Error(t('types.gone'));
  if (renames.size) {
    const names = new Set([type.name, ...type.aliases].map(noteTypeKey));
    for (const n of vault.list()) {
      if (n.partial || n.access === 'read' || spaceOf(n) !== space) continue;
      const name = customTypeOf(n.content);
      if (name === null || !names.has(noteTypeKey(name))) continue;
      const content = renameKeys(n.content, renames);
      if (content !== n.content) await vault.update(n.id, { content });
    }
  }
  await vault.update(note.id, { content: writeNoteType(current.content, type) });
}

/** Moves the values of renamed properties; one that would overwrite another key stays where it is */
function renameKeys(content: string, renames: Map<string, string>): string {
  const data = readFrontmatterYaml(content)?.data;
  if (!data) return content;
  const keys = Object.keys(data);
  const updates: Record<string, YamlValue | undefined> = {};
  for (const [from, to] of renames) {
    const key = keys.find((k) => k.toLowerCase() === from.toLowerCase());
    if (!key) continue;
    if (keys.some((k) => k !== key && k.toLowerCase() === to.toLowerCase())) continue;
    updates[key] = undefined;
    updates[to] = data[key];
  }
  return Object.keys(updates).length ? setFrontmatterValues(content, updates) : content;
}
