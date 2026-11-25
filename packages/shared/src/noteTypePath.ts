/** The definition of a custom note type is a hidden note `_type-<uuid>.md` at the top of a space, so two devices can create one at the same time */
const TYPE_NAME = /^_type-[0-9a-f][0-9a-f-]{7,}\.md$/i;

/** File name for a new definition note; `id` is a random UUID */
export const noteTypeFileName = (id: string): string => `_type-${id}.md`;

export function isNoteTypePath(path: string): boolean {
  const at = path.lastIndexOf('/') + 1;
  return path[at] === '_' && TYPE_NAME.test(path.slice(at));
}
