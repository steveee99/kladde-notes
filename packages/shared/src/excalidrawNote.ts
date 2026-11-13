/**
 * Drawing notes (Excalidraw): an ordinary Markdown note with `type: excalidraw` in its frontmatter
 * and the scene as Excalidraw JSON (the `.excalidraw` file format) in a fenced code block. The note
 * view shows such a note as a full-size Excalidraw canvas. Because the scene is part of the note
 * text it syncs, merges, is encrypted and shows up in the history like any other note.
 *
 * ---
 * type: excalidraw
 * ---
 * ```excalidraw
 * {"type":"excalidraw","version":2,"elements":[],…}
 * ```
 */
import { parseFrontmatter, setFrontmatter } from './markdown.js';

const LANG = 'excalidraw';
/** An opening fence of three or more backticks with the `excalidraw` info string */
const BLOCK = /^(`{3,})excalidraw[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/m;

/** The fence for `json`: longer than any run of backticks inside it (text elements may contain ```) */
function fenceFor(json: string): string {
  const longest = Math.max(0, ...[...json.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function block(json: string): string {
  const fence = fenceFor(json);
  return `${fence}${LANG}\n${json.replace(/\n*$/, '')}\n${fence}`;
}

/** Markdown of a new drawing note, optionally with a scene (Excalidraw JSON) */
export function excalidrawNoteMarkdown(sceneJson = ''): string {
  return setFrontmatter(`${block(sceneJson)}\n`, { type: LANG });
}

/** Whether the note is marked `type: excalidraw` */
export function isExcalidrawNote(content: string): boolean {
  return parseFrontmatter(content).data.type?.toLowerCase() === LANG;
}

/**
 * The scene JSON of a note marked `type: excalidraw` ('' for a note without a drawing yet),
 * or null for any other note
 */
export function excalidrawSceneOf(content: string): string | null {
  if (!isExcalidrawNote(content)) return null;
  const m = BLOCK.exec(parseFrontmatter(content).body);
  return m ? m[2].replace(/\r?\n$/, '') : '';
}

/** `content` with its drawing replaced by `sceneJson`; text around the block stays untouched */
export function setExcalidrawScene(content: string, sceneJson: string): string {
  const next = block(sceneJson);
  if (BLOCK.test(content)) return content.replace(BLOCK, () => next);
  return `${content.replace(/\n*$/, '')}${content.trim() ? '\n\n' : ''}${next}\n`;
}

/** Minimal shape of an Excalidraw element as far as merging needs it */
export interface ExcalidrawElementLike {
  id: string;
  version: number;
  versionNonce?: number;
  isDeleted?: boolean;
}

/**
 * Merges the elements of a scene that arrived from elsewhere into the local ones: per id the
 * higher `version` wins (ties go to the remote copy, so all clients converge). Elements only the
 * local side has are kept while `keepLocalOnly` (unsaved local edits), otherwise they were deleted
 * remotely. The remote order is kept; local-only elements go on top.
 */
export function mergeExcalidrawElements<T extends ExcalidrawElementLike>(local: readonly T[], remote: readonly T[], keepLocalOnly: boolean): T[] {
  const localById = new Map(local.map((e) => [e.id, e]));
  const remoteIds = new Set(remote.map((e) => e.id));
  const merged = remote.map((r) => {
    const l = localById.get(r.id);
    return l && l.version > r.version ? l : r;
  });
  if (keepLocalOnly) for (const l of local) if (!remoteIds.has(l.id)) merged.push(l);
  return merged;
}
